/**
 * Resource monitor — periodically polls system metrics and posts an alert
 * to #master when thresholds are crossed (memory / disk / container count).
 *
 * Ported from v1 fleet's `src/resource-monitor.ts`. Same hysteresis-driven
 * "alert on crossing, clear when dropped below" semantics — alerts fire
 * once per crossing, never spammed while a metric stays in the alert band.
 *
 * Sends the alert directly to the master agent's Discord channel by
 * writing a `kind=chat` row to the master session's outbound DB. The
 * delivery loop picks it up and routes through the normal channel
 * adapter, same path as a worker reply. Going direct (vs. waking the
 * master agent with a system message) means alerts land even when the
 * master is dormant or offline.
 *
 * The monitor is started from `src/index.ts` after the master is
 * identified. `MAX_CONCURRENT_CONTAINERS` (env, default 5) drives the
 * "containers used" percentage.
 */
import { execSync } from 'child_process';
import os from 'os';

import { MAX_CONCURRENT_CONTAINERS } from '../../config.js';
import { getActiveAgentGroups } from '../../db/agent-groups.js';
import { getMessagingGroupsByAgentGroup } from '../../db/messaging-groups.js';
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import { log } from '../../log.js';
import { openOutboundDb } from '../../session-manager.js';

const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;
const STARTUP_DELAY_MS = 30_000;

/**
 * Hysteresis: alert when value >= alert, clear when value < clear.
 * Container threshold's clear band is wider (60 vs 70 for memory/disk)
 * because container count fluctuates more — a single demand-spawn from
 * 4/5 → 5/5 → 4/5 within minutes is normal and shouldn't double-fire.
 */
const THRESHOLDS = {
  memoryPercent: { alert: 80, clear: 70 },
  diskPercent: { alert: 80, clear: 70 },
  containerPercent: { alert: 80, clear: 60 },
} as const;

type ThresholdName = keyof typeof THRESHOLDS;

interface SystemMetrics {
  memoryPercent: number;
  memoryUsedGB: number;
  memoryTotalGB: number;
  diskPercent: number;
  diskUsedGB: number;
  diskTotalGB: number;
  containerCount: number;
  containerMax: number;
  containerPercent: number;
}

export function getMetrics(getActiveContainers: () => number): SystemMetrics {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  let diskPercent = 0;
  let diskUsedGB = 0;
  let diskTotalGB = 0;
  try {
    const df = execSync('df / --output=pcent,used,size | tail -1', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const parts = df.split(/\s+/);
    diskPercent = parseInt(parts[0], 10) || 0;
    diskUsedGB = (parseInt(parts[1], 10) || 0) / (1024 * 1024);
    diskTotalGB = (parseInt(parts[2], 10) || 0) / (1024 * 1024);
  } catch {
    /* df failure (unsupported flags on BSD/mac, etc.) — treat as 0 */
  }

  const containerCount = getActiveContainers();
  const containerMax = MAX_CONCURRENT_CONTAINERS;

  return {
    memoryPercent: Math.round((usedMem / totalMem) * 100),
    memoryUsedGB: +(usedMem / 1024 ** 3).toFixed(1),
    memoryTotalGB: +(totalMem / 1024 ** 3).toFixed(1),
    diskPercent,
    diskUsedGB: +diskUsedGB.toFixed(1),
    diskTotalGB: +diskTotalGB.toFixed(1),
    containerCount,
    containerMax,
    containerPercent: Math.round((containerCount / Math.max(1, containerMax)) * 100),
  };
}

/**
 * State for `evaluateThresholds` — the set of currently-active alert
 * names. Pure function: takes current state + metrics, returns next
 * state + the alert/clear messages that crossed this tick. No side
 * effects, so it's directly testable.
 */
export interface MonitorState {
  active: Set<ThresholdName>;
}

export function evaluateThresholds(
  state: MonitorState,
  m: SystemMetrics,
): { nextActive: Set<ThresholdName>; messages: string[] } {
  const next = new Set(state.active);
  const messages: string[] = [];

  const cases: Array<{ name: ThresholdName; value: number; alertMsg: string; clearMsg: string }> = [
    {
      name: 'memoryPercent',
      value: m.memoryPercent,
      alertMsg: `⚠️ Memory at ${m.memoryPercent}% (${m.memoryUsedGB}/${m.memoryTotalGB} GB). Consider destroying idle workers.`,
      clearMsg: `✅ Memory back to ${m.memoryPercent}%.`,
    },
    {
      name: 'diskPercent',
      value: m.diskPercent,
      alertMsg: `⚠️ Disk at ${m.diskPercent}% (${m.diskUsedGB}/${m.diskTotalGB} GB).`,
      clearMsg: `✅ Disk back to ${m.diskPercent}%.`,
    },
    {
      name: 'containerPercent',
      value: m.containerPercent,
      alertMsg: `⚠️ Containers at ${m.containerCount}/${m.containerMax} (${m.containerPercent}%).`,
      clearMsg: `✅ Containers back to ${m.containerCount}/${m.containerMax}.`,
    },
  ];

  for (const c of cases) {
    const t = THRESHOLDS[c.name];
    if (c.value >= t.alert && !next.has(c.name)) {
      next.add(c.name);
      messages.push(c.alertMsg);
    } else if (c.value < t.clear && next.has(c.name)) {
      next.delete(c.name);
      messages.push(c.clearMsg);
    }
  }

  return { nextActive: next, messages };
}

/**
 * Resolve the master's primary outbound target (channel_type + platform_id)
 * by walking agent_groups → messaging_groups for the active master.
 * Returns null when there's no master (or it has no messaging group),
 * which makes the monitor a no-op — alerts go to logs only.
 */
function resolveMasterTarget(): {
  agentGroupId: string;
  sessionId: string;
  channelType: string;
  platformId: string;
} | null {
  const master = getActiveAgentGroups().find((g) => g.fleet_role === 'master');
  if (!master) return null;
  const sessions = getSessionsByAgentGroup(master.id);
  if (sessions.length === 0) return null;
  // Pick the most-recently-active session.
  const session = [...sessions].sort((a, b) => (b.last_active ?? '').localeCompare(a.last_active ?? ''))[0];
  const mgs = getMessagingGroupsByAgentGroup(master.id);
  const mg = mgs[0];
  if (!mg) return null;
  return { agentGroupId: master.id, sessionId: session.id, channelType: mg.channel_type, platformId: mg.platform_id };
}

function writeAlertToOutbound(target: ReturnType<typeof resolveMasterTarget>, text: string): void {
  if (!target) {
    log.info('Resource alert (no master target — log only)', { text });
    return;
  }
  try {
    const db = openOutboundDb(target.agentGroupId, target.sessionId);
    try {
      // Pick next odd seq (host writes even, container writes odd; this
      // monitor is host-side but masquerading as a container reply, so
      // we use even — match the host-sweep's convention by picking the
      // next available number above the current max).
      const maxSeq = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_out').get() as { m: number }).m;
      const nextSeq = maxSeq + 1;
      const id = `resmon-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      db.prepare(
        `INSERT INTO messages_out (id, seq, timestamp, kind, platform_id, channel_type, content)
         VALUES (?, ?, datetime('now'), 'chat', ?, ?, ?)`,
      ).run(id, nextSeq, target.platformId, target.channelType, JSON.stringify({ text }));
    } finally {
      db.close();
    }
  } catch (err) {
    log.warn('Resource monitor failed to write alert', { err: String(err) });
  }
}

let timer: NodeJS.Timeout | undefined;
const state: MonitorState = { active: new Set() };

/**
 * Start the monitor loop. Idempotent — calling twice cancels the prior
 * timer and starts fresh. Stops itself when `stopResourceMonitor` is
 * called (used by tests / shutdown).
 */
export function startResourceMonitor(
  opts: { getActiveContainers: () => number; intervalMs?: number } = { getActiveContainers: () => 0 },
): void {
  if (timer) clearInterval(timer);
  const interval = opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const tick = (): void => {
    try {
      const target = resolveMasterTarget();
      const metrics = getMetrics(opts.getActiveContainers);
      const { nextActive, messages } = evaluateThresholds(state, metrics);
      state.active = nextActive;
      for (const m of messages) writeAlertToOutbound(target, m);
    } catch (err) {
      log.warn('Resource monitor tick failed', { err: String(err) });
    }
  };

  // First check after STARTUP_DELAY_MS so the host finishes booting.
  setTimeout(tick, STARTUP_DELAY_MS);
  timer = setInterval(tick, interval);
  log.info('Resource monitor started', { intervalMs: interval });
}

export function stopResourceMonitor(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
  state.active.clear();
}
