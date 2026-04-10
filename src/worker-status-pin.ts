/**
 * Worker status pins: maintains pinned Discord messages in each worker channel
 * showing live status (container state, tokens, last activity).
 */
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { getRouterState, setRouterState } from './db.js';
import { logger } from './logger.js';
import { formatCurrentTime } from './timezone.js';
import { TIMEZONE } from './config.js';

const STATE_KEY_PREFIX = 'worker_status_pin_';
const DISCORD_ERROR_UNKNOWN_MESSAGE = 10008;

export interface WorkerStatusPinDeps {
  editMessage: (jid: string, messageId: string, text: string) => Promise<void>;
  sendMessage: (jid: string, text: string) => Promise<string | undefined>;
  pinMessage: (jid: string, messageId: string) => Promise<void>;
  unpinMessage?: (jid: string, messageId: string) => Promise<void>;
}

interface WorkerStatus {
  folder: string;
  name: string;
  jid: string;
  backend: string;
  model: string;
  container: string | null;
  requests: number;
  totalTokens: number;
  lastActivity: string | null;
}

function getContainerName(folder: string): string | null {
  try {
    // Docker container names use hyphens, not underscores
    const pattern = `nanoclaw-${folder.replace(/_/g, '-')}-`;
    const result = execSync(
      `docker ps --filter "name=${pattern}" --format "{{.Names}}"`,
      { encoding: 'utf-8', timeout: 5000 },
    ).trim();
    return result || null;
  } catch {
    return null;
  }
}

function getContainerUptime(containerName: string): number | null {
  try {
    const started = execSync(
      `docker inspect --format "{{.State.StartedAt}}" "${containerName}"`,
      { encoding: 'utf-8', timeout: 5000 },
    ).trim();
    if (!started || started === '0001-01-01T00:00:00Z') return null;
    const startMs = new Date(started).getTime();
    if (isNaN(startMs)) return null;
    return Date.now() - startMs;
  } catch {
    return null;
  }
}

function formatUptime(ms: number): string {
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remainMins = mins % 60;
  if (hours < 24)
    return remainMins > 0 ? `${hours}h ${remainMins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainHours = hours % 24;
  return remainHours > 0 ? `${days}d ${remainHours}h` : `${days}d`;
}

function formatLastActivity(timestamp: string | null): string {
  if (!timestamp) return 'never';
  const ms = Date.now() - new Date(timestamp).getTime();
  if (isNaN(ms) || ms < 0) return '?';
  if (ms < 60000) return 'just now';
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
  if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ago`;
  return `${Math.floor(ms / 86400000)}d ago`;
}

function formatTokens(tokens: number): string {
  if (tokens < 1) return `${tokens}`;
  if (tokens < 1000) return `${Math.round(tokens)}`;
  if (tokens < 1000000) return `${(tokens / 1000).toFixed(1)}k`;
  if (tokens < 1000000000) return `${(tokens / 1000000).toFixed(1)}M`;
  return `${(tokens / 1000000000).toFixed(1)}B`;
}

function readJsonSafe(p: string): Record<string, unknown> | null {
  try {
    const content = readFileSync(p, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function getWorkerStatuses(): WorkerStatus[] {
  const backends =
    readJsonSafe(path.join(DATA_DIR, 'worker-backends.json')) || {};
  const usage = readJsonSafe(path.join(DATA_DIR, 'worker-usage.json')) || {};
  const groupsData = readJsonSafe(
    path.join(DATA_DIR, 'ipc/discord_main/available_groups.json'),
  );
  const groups = (groupsData?.groups || []) as Array<{
    jid: string;
    name: string;
    folder: string;
    isRegistered: boolean;
  }>;

  const statuses: WorkerStatus[] = [];

  for (const g of groups) {
    if (!g.isRegistered || !g.folder || g.folder === 'discord_main') continue;

    const b = (backends[g.folder] || {}) as Record<string, unknown>;
    const u = (usage[g.folder] || {}) as Record<string, unknown>;
    const container = getContainerName(g.folder);

    statuses.push({
      folder: g.folder,
      name: g.name.replace(/^devbox server /, ''),
      jid: g.jid,
      backend: (b.backend as string) || 'anthropic',
      model: (b.model as string) || 'unknown',
      container,
      requests: (u.requests as number) || 0,
      totalTokens: (u.total_tokens as number) || 0,
      lastActivity: (u.last_updated as string) || null,
    });
  }

  return statuses;
}

function buildStatusText(status: WorkerStatus): string {
  const emoji = status.container ? '🟢' : '🔴';
  const state = status.container ? 'running' : 'stopped';
  const modelShort =
    status.model.length > 25 ? status.model.slice(0, 22) + '...' : status.model;

  let text = `${emoji} **${status.name}** · ${modelShort} · ${state}`;

  if (status.container) {
    const uptime = getContainerUptime(status.container);
    if (uptime !== null) {
      text += ` · ${formatUptime(uptime)} uptime`;
    }
  }

  text += '\n\n';

  if (status.requests > 0) {
    text += `${status.requests} requests · ${formatTokens(status.totalTokens)} tokens`;
  } else {
    text += 'No requests yet';
  }

  text += ` · last activity ${formatLastActivity(status.lastActivity)}`;

  text += `\n\n_Updated ${formatCurrentTime(TIMEZONE)}_`;

  return text;
}

async function updateWorkerPin(
  status: WorkerStatus,
  deps: WorkerStatusPinDeps,
): Promise<void> {
  const stateKey = STATE_KEY_PREFIX + status.folder;
  const text = buildStatusText(status);
  const existingId = getRouterState(stateKey);

  if (existingId) {
    try {
      await deps.editMessage(status.jid, existingId, text);
      return;
    } catch (err: unknown) {
      const code =
        err && typeof err === 'object' && 'code' in err
          ? (err as { code: number }).code
          : undefined;
      if (code === DISCORD_ERROR_UNKNOWN_MESSAGE) {
        logger.info(
          { folder: status.folder },
          'Worker status pin deleted, creating new',
        );
      } else {
        logger.warn(
          { err, folder: status.folder },
          'Error editing worker status pin',
        );
        return;
      }
    }
  }

  const newId = await deps.sendMessage(status.jid, text);
  if (newId) {
    setRouterState(stateKey, newId);
    try {
      await deps.pinMessage(status.jid, newId);
    } catch (err) {
      logger.debug(
        { err, folder: status.folder },
        'Could not pin worker status',
      );
    }
    logger.info(
      { folder: status.folder, messageId: newId },
      'Created worker status pin',
    );
  }
}

export async function updateAllWorkerPins(
  deps: WorkerStatusPinDeps,
): Promise<void> {
  const statuses = getWorkerStatuses();

  const results = await Promise.allSettled(
    statuses.map((s) => updateWorkerPin(s, deps)),
  );

  let updated = 0;
  let failed = 0;
  for (const r of results) {
    if (r.status === 'fulfilled') updated++;
    else failed++;
  }

  logger.info(
    { updated, failed, total: statuses.length },
    'Worker pins updated',
  );
}

export function startWorkerStatusPins(
  intervalMs: number,
  deps: WorkerStatusPinDeps,
): () => void {
  if (!intervalMs || intervalMs <= 0) {
    logger.info('Worker status pins disabled');
    return () => {};
  }

  const poll = () => {
    updateAllWorkerPins(deps).catch((err) => {
      logger.error({ err }, 'Worker status pin update failed');
    });
  };

  const initialTimeout = setTimeout(poll, 15_000);
  const interval = setInterval(poll, intervalMs);
  logger.info({ intervalMs }, 'Worker status pin loop started');

  return () => {
    clearTimeout(initialTimeout);
    clearInterval(interval);
  };
}

export async function clearWorkerPin(
  folder: string,
  jid: string,
  deps: Pick<WorkerStatusPinDeps, 'unpinMessage'>,
): Promise<void> {
  const stateKey = STATE_KEY_PREFIX + folder;
  const messageId = getRouterState(stateKey);
  if (!messageId) return;

  if (deps.unpinMessage) {
    try {
      await deps.unpinMessage(jid, messageId);
    } catch {
      // Best effort
    }
  }

  setRouterState(stateKey, '');
}
