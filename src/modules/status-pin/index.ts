/**
 * Pinned status messages — per-install fleet dashboard in Discord.
 *
 * Maintains a single pinned message in the master channel summarising
 * master + workers, and a per-worker pinned message in each worker's
 * channel with its own status. On a fixed interval, the host re-renders
 * the text and calls adapter.editMessage to update in place (no new
 * messages — avoids notifying users on each tick).
 *
 * Ported from nanoclaw-fleet (v1 fork) src/status-pin.ts + worker-status-pin.ts.
 * Original used ncf subprocess + worker-usage.json; v2 reads the central DB
 * directly. Token/request counters are TODO until v2 grows a usage store.
 *
 * Pinned message IDs persist in chat_sdk_kv under:
 *   fleet:status-pin:master
 *   fleet:status-pin:worker:<folder>
 */
import { execSync } from 'child_process';

import { getDb } from '../../db/connection.js';
import { getDeliveryAdapter, onDeliveryAdapterReady, type ChannelDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';

const MASTER_KEY = 'fleet:status-pin:master';
const WORKER_KEY_PREFIX = 'fleet:status-pin:worker:';

const DEFAULT_INTERVAL_MS = 30_000;
/** Environment override: `FLEET_STATUS_PIN_INTERVAL_MS=0` disables. */
const INTERVAL_MS = (() => {
  const raw = process.env.FLEET_STATUS_PIN_INTERVAL_MS;
  if (!raw) return DEFAULT_INTERVAL_MS;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : DEFAULT_INTERVAL_MS;
})();

const DISCORD_UNKNOWN_MESSAGE = 10008;

interface MasterRow {
  id: string;
  name: string;
  folder: string;
  status: string;
  fleet_backend: string | null;
  fleet_model: string | null;
  channel_type: string | null;
  platform_id: string | null;
  thread_id: string | null;
}

interface WorkerRow extends MasterRow {
  sessionCount: number;
}

function getPin(key: string): string | null {
  const db = getDb();
  const row = db.prepare('SELECT value FROM chat_sdk_kv WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function setPin(key: string, messageId: string): void {
  const db = getDb();
  db.prepare('INSERT OR REPLACE INTO chat_sdk_kv (key, value, expires_at) VALUES (?, ?, NULL)').run(key, messageId);
}

function clearPin(key: string): void {
  const db = getDb();
  db.prepare('DELETE FROM chat_sdk_kv WHERE key = ?').run(key);
}

// Only post pins in channel_types the Discord adapter handles — cli /
// local admin transport has no concept of pinned messages and would swallow
// the deliver call. Expand this set if other adapters grow reaction + pin
// support.
const PINNABLE_CHANNELS = new Set(['discord']);

function loadMaster(): MasterRow | null {
  const db = getDb();
  // Master may be wired to multiple messaging_groups (cli admin + Discord).
  // Filter to Discord so we don't try to pin into the CLI transport.
  const row = db
    .prepare(
      `SELECT ag.id, ag.name, ag.folder, ag.status, ag.fleet_backend, ag.fleet_model,
              mg.channel_type, mg.platform_id
         FROM agent_groups ag
         LEFT JOIN messaging_group_agents mga ON mga.agent_group_id = ag.id
         LEFT JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
         WHERE ag.fleet_role = 'master'
           AND ag.status = 'active'
           AND (mg.channel_type IN ('discord') OR mg.channel_type IS NULL)
         ORDER BY CASE mg.channel_type WHEN 'discord' THEN 0 ELSE 1 END
         LIMIT 1`,
    )
    .get() as MasterRow | undefined;
  return row ?? null;
}

function loadWorkers(): WorkerRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT ag.id, ag.name, ag.folder, ag.status, ag.fleet_backend, ag.fleet_model,
              mg.channel_type, mg.platform_id,
              (SELECT COUNT(*) FROM sessions s WHERE s.agent_group_id = ag.id) as sessionCount
         FROM agent_groups ag
         LEFT JOIN messaging_group_agents mga ON mga.agent_group_id = ag.id
         LEFT JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
         WHERE ag.fleet_role = 'worker'
           AND (mg.channel_type IN ('discord') OR mg.channel_type IS NULL)
         ORDER BY ag.status, ag.name`,
    )
    .all() as WorkerRow[];
  return rows;
}

function findContainer(folder: string): { name: string; startedMs: number } | null {
  try {
    const name = execSync(`docker ps --filter "name=nanoclaw-v2-${folder}-" --format "{{.Names}}"`, {
      encoding: 'utf-8',
      timeout: 3_000,
    }).trim();
    if (!name) return null;
    const started = execSync(`docker inspect --format "{{.State.StartedAt}}" "${name}"`, {
      encoding: 'utf-8',
      timeout: 3_000,
    }).trim();
    const startedMs = new Date(started).getTime();
    return { name, startedMs: Number.isFinite(startedMs) ? startedMs : 0 };
  } catch {
    return null;
  }
}

function formatUptime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

function buildMasterText(master: MasterRow, workers: WorkerRow[]): string {
  const c = findContainer(master.folder);
  const masterLine = c
    ? `🟢 **${master.name}** · ${backend(master)} · ${formatUptime(Date.now() - c.startedMs)} uptime`
    : `⚫ **${master.name}** · ${backend(master)} · stopped`;

  const active = workers.filter((w) => w.status === 'active');
  const archived = workers.filter((w) => w.status !== 'active');

  const lines: string[] = [masterLine, '', `**Workers**: ${active.length} active, ${archived.length} archived`];
  for (const w of active) {
    const wc = findContainer(w.folder);
    const marker = wc ? '🟢' : '⚫';
    const state = wc ? `${formatUptime(Date.now() - wc.startedMs)} uptime` : 'stopped';
    lines.push(`${marker} \`${w.folder}\` · ${backend(w)} · ${state}`);
  }
  lines.push('', `_Updated <t:${Math.floor(Date.now() / 1000)}:R>_`);
  return lines.join('\n');
}

function buildWorkerText(worker: WorkerRow): string {
  const c = findContainer(worker.folder);
  const marker = c ? '🟢' : '⚫';
  const state = c ? `running · ${formatUptime(Date.now() - c.startedMs)} uptime` : 'stopped';
  const lines: string[] = [
    `${marker} **${worker.name}** · ${backend(worker)} · ${state}`,
    '',
    worker.status === 'archived' ? '_archived — not accepting messages_' : '',
    `_Updated <t:${Math.floor(Date.now() / 1000)}:R>_`,
  ].filter(Boolean);
  return lines.join('\n');
}

function backend(row: MasterRow): string {
  if (!row.fleet_backend) return '—';
  return row.fleet_model ? `${row.fleet_backend} (${row.fleet_model})` : row.fleet_backend;
}

async function updateOne(
  adapter: ChannelDeliveryAdapter,
  key: string,
  channelType: string,
  platformId: string,
  threadId: string | null,
  text: string,
): Promise<void> {
  const existingId = getPin(key);
  if (existingId) {
    try {
      await adapter.editMessage?.(channelType, platformId, threadId, existingId, text);
      return;
    } catch (err: unknown) {
      const code = err && typeof err === 'object' && 'code' in err ? (err as { code: number }).code : undefined;
      if (code === DISCORD_UNKNOWN_MESSAGE) {
        log.info('Pinned status message missing, creating new', { key });
        clearPin(key);
      } else {
        log.warn('Pinned status message edit failed (transient)', { key, err });
        return;
      }
    }
  }

  // About to post a new pin. First unpin any stale bot-authored pin that
  // matches this key's content pattern — prevents accumulation across
  // host restarts where the old message got deleted (10008 path).
  await unpinStalePins(adapter, channelType, platformId, threadId, key);

  // Post a fresh message + pin it.
  try {
    const newId = await adapter.deliver(channelType, platformId, threadId, 'chat', JSON.stringify({ text }));
    if (!newId) {
      log.warn('Pinned status deliver returned no id', { key, channelType, platformId });
      return;
    }
    setPin(key, newId);
    try {
      await adapter.pinMessage?.(channelType, platformId, threadId, newId);
    } catch (err) {
      log.warn('Pinned status pin failed (missing perms?)', { key, err });
    }
  } catch (err) {
    log.warn('Pinned status deliver failed', { key, err });
  }
}

/**
 * Unpin any pinned messages in the channel whose content looks like a
 * previous fleet status pin. Discord's pin list is bot-agnostic (we see
 * everyone's pins), so we content-match to our own markers rather than
 * indiscriminately unpinning. Best-effort — failures are logged and
 * swallowed so a pin attempt never blocks a turn.
 */
async function unpinStalePins(
  adapter: ChannelDeliveryAdapter,
  channelType: string,
  platformId: string,
  threadId: string | null,
  key: string,
): Promise<void> {
  if (channelType !== 'discord') return;
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) return;
  // platform_id for Discord is "discord:<guild>:<channel>" — extract channel.
  const channelId = platformId.split(':').pop();
  if (!channelId) return;
  const isMasterKey = key === MASTER_KEY;
  try {
    const resp = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/pins`, {
      headers: { Authorization: `Bot ${token}` },
    });
    if (!resp.ok) return;
    const data = (await resp.json()) as { items?: Array<{ message: { id: string; content: string; author?: { id?: string } } }> };
    const items = data.items ?? [];
    const myId = await currentBotId(token);
    const currentPin = getPin(key);
    for (const item of items) {
      const msg = item.message;
      if (msg.id === currentPin) continue;
      if (myId && msg.author?.id !== myId) continue;
      // Match our own status-pin format: either a master summary or a
      // single-worker line. The "_Updated <t:...:R>_" footer is the
      // cheapest reliable signature.
      if (!/_Updated <t:\d+:R>_/.test(msg.content)) continue;
      // Extra safety: master pins contain "Workers:" line; worker pins
      // don't. Don't cross-delete.
      const looksLikeMaster = /\*\*Workers\*\*:/m.test(msg.content);
      if (isMasterKey !== looksLikeMaster) continue;
      try {
        await adapter.unpinMessage?.(channelType, platformId, threadId, msg.id);
        log.info('Pinned status: unpinned stale pin', { channelId, staleId: msg.id });
      } catch (err) {
        log.debug('Pinned status: unpin stale failed', { staleId: msg.id, err });
      }
    }
  } catch (err) {
    log.debug('Pinned status: stale-pin scan failed', { err });
  }
}

let cachedBotId: string | null = null;
async function currentBotId(token: string): Promise<string | null> {
  if (cachedBotId) return cachedBotId;
  try {
    const resp = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bot ${token}` },
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { id?: string };
    cachedBotId = data.id ?? null;
    return cachedBotId;
  } catch {
    return null;
  }
}

let intervalHandle: NodeJS.Timeout | null = null;

async function tick(): Promise<void> {
  const adapter = getDeliveryAdapter();
  if (!adapter) return;

  const master = loadMaster();
  const workers = loadWorkers();

  if (master?.channel_type && master.platform_id && PINNABLE_CHANNELS.has(master.channel_type)) {
    const text = buildMasterText(master, workers);
    await updateOne(adapter, MASTER_KEY, master.channel_type, master.platform_id, master.platform_id, text);
  }

  for (const w of workers) {
    if (!w.channel_type || !w.platform_id) continue;
    if (!PINNABLE_CHANNELS.has(w.channel_type)) continue;
    const key = WORKER_KEY_PREFIX + w.folder;
    const text = buildWorkerText(w);
    await updateOne(adapter, key, w.channel_type, w.platform_id, w.platform_id, text);
  }
}

export function startStatusPin(): void {
  if (INTERVAL_MS <= 0) {
    log.info('Pinned status disabled', { interval: INTERVAL_MS });
    return;
  }
  onDeliveryAdapterReady(() => {
    // Delay first update so adapter handshakes and channel provisioning
    // from the boot path settle before we start posting.
    setTimeout(() => {
      void tick().catch((err) => log.warn('Pinned status first tick error', { err }));
      intervalHandle = setInterval(() => {
        void tick().catch((err) => log.warn('Pinned status tick error', { err }));
      }, INTERVAL_MS);
      intervalHandle.unref?.();
      log.info('Pinned status loop started', { intervalMs: INTERVAL_MS });
    }, 10_000);
  });
}

export function stopStatusPin(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
