/**
 * Startup notice — posts a one-shot "host restarted" chat message to the
 * master agent's channel after the host comes up, so the user sees a
 * sign of life and the master agent has restart context for its next
 * turn.
 *
 * Ported from v1 fleet (commit 8292a9f, reverted as collateral damage in
 * b815cf7 — never intentionally removed). Same delivery path as the
 * resource-monitor alerts: write a `kind=chat` row to the master
 * session's outbound DB, let the normal delivery loop pick it up. That
 * way the message lands through whatever channel adapter the master is
 * wired to (Discord today; Slack/Telegram later) without this module
 * needing to know about adapters.
 *
 * No-op when:
 *   - There's no active master agent group (fresh install, first run)
 *   - The master has no session yet (never been messaged)
 *   - The master has no messaging group (orphaned agent_group)
 *   - The outbound DB write fails (logged warn, not thrown)
 *
 * In all of those cases the host still finishes booting cleanly — the
 * notice is best-effort, not load-bearing.
 */
import { TIMEZONE } from '../../config.js';
import { getActiveAgentGroups } from '../../db/agent-groups.js';
import { getMessagingGroupsByAgentGroup } from '../../db/messaging-groups.js';
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import { log } from '../../log.js';
import { openOutboundDb } from '../../session-manager.js';

interface MasterTarget {
  agentGroupId: string;
  sessionId: string;
  channelType: string;
  platformId: string;
  backend: string;
  model: string | null;
}

function resolveMasterTarget(): MasterTarget | null {
  const master = getActiveAgentGroups().find((g) => g.fleet_role === 'master');
  if (!master) return null;
  const sessions = getSessionsByAgentGroup(master.id);
  if (sessions.length === 0) return null;
  const session = [...sessions].sort((a, b) => (b.last_active ?? '').localeCompare(a.last_active ?? ''))[0];
  const mgs = getMessagingGroupsByAgentGroup(master.id);
  const mg = mgs[0];
  if (!mg) return null;
  return {
    agentGroupId: master.id,
    sessionId: session.id,
    channelType: mg.channel_type,
    platformId: mg.platform_id,
    // Display-only label: prefer the explicit fleet_backend, fall back to
    // agent_provider (the v2 generic field), then 'unknown' so we don't
    // pretend it's claude when the row is genuinely missing both.
    backend: master.fleet_backend ?? master.agent_provider ?? 'unknown',
    model: master.fleet_model ?? null,
  };
}

export function formatStartupMessage(target: Pick<MasterTarget, 'backend' | 'model'>, now: Date = new Date()): string {
  const timestamp = now.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: TIMEZONE,
  });
  const modelSuffix = target.model ? ` (${target.model})` : '';
  return `🚀 NanoClaw host restarted.\nBackend: ${target.backend}${modelSuffix}\nTime: ${timestamp}`;
}

function writeNoticeToOutbound(target: MasterTarget, text: string): void {
  try {
    const db = openOutboundDb(target.agentGroupId, target.sessionId);
    try {
      const maxSeq = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_out').get() as { m: number }).m;
      const nextSeq = maxSeq + 1;
      const id = `startup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      db.prepare(
        `INSERT INTO messages_out (id, seq, timestamp, kind, platform_id, channel_type, content)
         VALUES (?, ?, datetime('now'), 'chat', ?, ?, ?)`,
      ).run(id, nextSeq, target.platformId, target.channelType, JSON.stringify({ text }));
    } finally {
      db.close();
    }
  } catch (err) {
    log.warn('Startup notice write failed', { err: String(err) });
  }
}

/**
 * Best-effort: post a "host restarted" chat to the master's channel.
 * Exported so src/index.ts can call it after delivery polls + sweep are
 * up. Safe to call when there is no master — logs and returns.
 */
export function postHostStartupNotice(): void {
  const target = resolveMasterTarget();
  if (!target) {
    log.info('Startup notice skipped (no master target)');
    return;
  }
  const text = formatStartupMessage(target);
  writeNoticeToOutbound(target, text);
  log.info('Startup notice posted to master', {
    channelType: target.channelType,
    backend: target.backend,
    model: target.model,
  });
}
