/**
 * Status pin: maintains a pinned Discord message in the master channel
 * that shows live worker status. Updates on a configurable interval by
 * running the nc-status.sh script and editing the pinned message in place.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';

import { getRouterState, setRouterState } from './db.js';
import { logger } from './logger.js';
import { TIMEZONE } from './config.js';
import { formatCurrentTime } from './timezone.js';

const execFileAsync = promisify(execFile);

const STATE_KEY = 'pinned_status_message_id';
const NC_STATUS_SCRIPT = path.resolve(process.cwd(), 'tools/nc-status.sh');
const STATUS_ENV = { ...process.env, NANOCLAW_ROOT: process.cwd() };

export interface StatusPinDeps {
  sendMessage: (jid: string, text: string) => Promise<string | undefined>;
  editMessage: (jid: string, messageId: string, text: string) => Promise<void>;
  pinMessage: (jid: string, messageId: string) => Promise<void>;
}

function formatTimestamp(): string {
  return formatCurrentTime(TIMEZONE);
}

async function getStatusOutput(): Promise<string> {
  const { stdout } = await execFileAsync('bash', [NC_STATUS_SCRIPT], {
    timeout: 15_000,
    env: STATUS_ENV,
  });
  return stdout.trim();
}

async function updateStatusPin(
  mainJid: string,
  deps: StatusPinDeps,
): Promise<void> {
  const statusText = await getStatusOutput();
  if (!statusText) {
    logger.warn('nc-status.sh returned empty output');
    return;
  }

  const fullText = `${statusText}\n\n_Updated ${formatTimestamp()}_`;

  const existingMessageId = getRouterState(STATE_KEY);

  if (existingMessageId) {
    try {
      await deps.editMessage(mainJid, existingMessageId, fullText);
      return;
    } catch (err) {
      // Message was deleted, permissions changed, or network error
      logger.info(
        { err },
        'Pinned status message gone or inaccessible, creating new one',
      );
    }
  }

  // Create new message and pin it
  const newMessageId = await deps.sendMessage(mainJid, fullText);
  if (newMessageId) {
    setRouterState(STATE_KEY, newMessageId);
    try {
      await deps.pinMessage(mainJid, newMessageId);
    } catch (err) {
      logger.warn(
        { err },
        'Failed to pin status message (missing permissions?)',
      );
    }
    logger.info(
      { messageId: newMessageId },
      'Created and pinned status message',
    );
  }
}

/**
 * Start the status pin update loop. Returns a cleanup function to stop it.
 */
export function startStatusPin(
  mainJid: string,
  intervalMs: number,
  deps: StatusPinDeps,
): () => void {
  if (intervalMs <= 0) {
    logger.info('Status pin disabled (interval <= 0)');
    return () => {};
  }

  const poll = () => {
    updateStatusPin(mainJid, deps).catch((err) => {
      logger.error({ err }, 'Status pin update failed');
    });
  };

  // First update after 10s (let startup finish)
  const initialTimeout = setTimeout(poll, 10_000);
  const interval = setInterval(poll, intervalMs);
  logger.info({ intervalMs }, 'Status pin loop started');

  return () => {
    clearTimeout(initialTimeout);
    clearInterval(interval);
  };
}

/**
 * Best-effort update of the pinned message to show offline status.
 * Call during shutdown — returns quickly if it fails.
 */
export async function markStatusOffline(
  mainJid: string,
  deps: Pick<StatusPinDeps, 'editMessage'>,
): Promise<void> {
  const messageId = getRouterState(STATE_KEY);
  if (!messageId) return;

  const offlineText = `**NanoClaw offline** — _${formatTimestamp()}_`;
  await Promise.race([
    deps.editMessage(mainJid, messageId, offlineText),
    new Promise((r) => setTimeout(r, 3000)),
  ]).catch(() => {
    /* best effort */
  });
}
