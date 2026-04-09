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

/** Prevent overlapping updateStatusPin calls (e.g. if nc-status.sh is slow). */
let updateInProgress = false;

export interface StatusPinDeps {
  sendMessage: (jid: string, text: string) => Promise<string | undefined>;
  editMessage: (jid: string, messageId: string, text: string) => Promise<void>;
  pinMessage: (jid: string, messageId: string) => Promise<void>;
}

async function getStatusOutput(): Promise<string> {
  const { stdout } = await execFileAsync('bash', [NC_STATUS_SCRIPT], {
    timeout: 15_000,
    env: { ...process.env, NANOCLAW_ROOT: process.cwd() },
  });
  return stdout.trim();
}

async function updateStatusPin(
  mainJid: string,
  deps: StatusPinDeps,
): Promise<void> {
  if (updateInProgress) {
    logger.debug('Skipping status pin update — previous update still running');
    return;
  }
  updateInProgress = true;
  try {
    await doUpdateStatusPin(mainJid, deps);
  } finally {
    updateInProgress = false;
  }
}

async function doUpdateStatusPin(
  mainJid: string,
  deps: StatusPinDeps,
): Promise<void> {
  const statusText = await getStatusOutput();
  if (!statusText) {
    logger.warn('nc-status.sh returned empty output');
    return;
  }

  const fullText = `${statusText}\n\n_Updated ${formatCurrentTime(TIMEZONE)}_`;

  const existingMessageId = getRouterState(STATE_KEY);

  if (existingMessageId) {
    try {
      await deps.editMessage(mainJid, existingMessageId, fullText);
      return;
    } catch (err: unknown) {
      // Only create a new message for permanent failures (message deleted/not found).
      // Transient errors (rate limits, network, 500s) should skip this cycle.
      const code =
        err && typeof err === 'object' && 'code' in err
          ? (err as { code: number }).code
          : undefined;
      if (code === 10008) {
        // Discord API 10008 = Unknown Message (deleted)
        logger.info('Pinned status message was deleted, creating new one');
      } else {
        logger.warn(
          { err },
          'Transient error editing status pin, skipping this cycle',
        );
        return;
      }
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
  } else {
    logger.warn('Failed to create status message (sendMessage returned empty)');
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
  if (!intervalMs || intervalMs <= 0 || !Number.isFinite(intervalMs)) {
    logger.info('Status pin disabled (interval <= 0 or invalid)');
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

  const offlineText = `**NanoClaw offline** — _${formatCurrentTime(TIMEZONE)}_`;
  await Promise.race([
    deps.editMessage(mainJid, messageId, offlineText),
    new Promise((r) => setTimeout(r, 3000)),
  ]).catch(() => {
    /* best effort */
  });
}
