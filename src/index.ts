/**
 * NanoClaw — main entry point.
 *
 * Thin orchestrator: init DB, run migrations, start channel adapters,
 * start delivery polls, start sweep, handle shutdown.
 */
import path from 'path';

import { DATA_DIR } from './config.js';
import { migrateGroupsToClaudeLocal } from './claude-md-compose.js';
import { initDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { ensureContainerRuntimeRunning, cleanupOrphans } from './container-runtime.js';
import { startActiveDeliveryPoll, startSweepDeliveryPoll, setDeliveryAdapter, stopDeliveryPolls } from './delivery.js';
import { startHostSweep, stopHostSweep } from './host-sweep.js';
import { startOutboundWakeServer, stopOutboundWakeServer } from './outbound-wake.js';
import { startStatusPin, stopStatusPin } from './modules/status-pin/index.js';
import { startResourceMonitor, stopResourceMonitor } from './modules/resource-monitor/index.js';
import { getActiveContainerCount } from './container-runner.js';
import { routeInbound } from './router.js';
import { log } from './log.js';

// Response + shutdown registries live in response-registry.ts to break the
// circular import cycle: src/index.ts imports src/modules/index.js for side
// effects, and the modules call registerResponseHandler/onShutdown at top
// level — which would hit a TDZ error if the arrays lived here. Re-exported
// here so existing callers see the same surface.
import {
  registerResponseHandler,
  getResponseHandlers,
  onShutdown,
  getShutdownCallbacks,
  type ResponsePayload,
  type ResponseHandler,
} from './response-registry.js';
export { registerResponseHandler, onShutdown };
export type { ResponsePayload, ResponseHandler };

async function dispatchResponse(payload: ResponsePayload): Promise<void> {
  for (const handler of getResponseHandlers()) {
    try {
      const claimed = await handler(payload);
      if (claimed) return;
    } catch (err) {
      log.error('Response handler threw', { questionId: payload.questionId, err });
    }
  }
  log.warn('Unclaimed response', { questionId: payload.questionId, value: payload.value });
}

// Channel barrel — each enabled channel self-registers on import.
// Channel skills uncomment lines in channels/index.ts to enable them.
import './channels/index.js';

// Modules barrel — default modules (typing, mount-security) ship here; skills
// append registry-based modules. Imported for side effects (registrations).
import './modules/index.js';

import type { ChannelAdapter, ChannelSetup } from './channels/adapter.js';
import { initChannelAdapters, teardownChannelAdapters, getChannelAdapter } from './channels/channel-registry.js';

async function main(): Promise<void> {
  log.info('NanoClaw starting');

  // 1. Init central DB
  const dbPath = path.join(DATA_DIR, 'v2.db');
  const db = initDb(dbPath);
  runMigrations(db);
  log.info('Central DB ready', { path: dbPath });

  // 1b. One-time filesystem cutover — idempotent, no-op after first run.
  migrateGroupsToClaudeLocal();

  // 1c. Re-apply the user's worker profile to every active worker's
  // container.json. Lets profile edits in
  // ~/.config/nanoclaw/worker-profiles/default.json (added repos, bumped
  // tools, tightened mounts) propagate to existing workers on the next
  // host restart, without needing to destroy + recreate each worker.
  // No-op if no profile is defined. Mirrors v1 fleet's syncWorkerProfiles
  // (FORK-SPEC §7.4).
  const { syncWorkerProfiles } = await import('./modules/fleet/profile-sync.js');
  const profileSyncResult = syncWorkerProfiles();
  if (profileSyncResult.errors.length > 0) {
    log.warn('Profile sync had errors at startup', {
      errors: profileSyncResult.errors,
      updated: profileSyncResult.updated.length,
    });
  }

  // 2. Container runtime
  ensureContainerRuntimeRunning();
  cleanupOrphans();

  // 3. Channel adapters
  await initChannelAdapters((adapter: ChannelAdapter): ChannelSetup => {
    return {
      onInbound(platformId, threadId, message) {
        routeInbound({
          channelType: adapter.channelType,
          platformId,
          threadId,
          message: {
            id: message.id,
            kind: message.kind,
            content: JSON.stringify(message.content),
            timestamp: message.timestamp,
            isMention: message.isMention,
            isGroup: message.isGroup,
          },
        }).catch((err) => {
          log.error('Failed to route inbound message', { channelType: adapter.channelType, err });
        });
      },
      onInboundEvent(event) {
        routeInbound(event).catch((err) => {
          log.error('Failed to route inbound event', {
            sourceAdapter: adapter.channelType,
            targetChannelType: event.channelType,
            err,
          });
        });
      },
      onMetadata(platformId, name, isGroup) {
        log.info('Channel metadata discovered', {
          channelType: adapter.channelType,
          platformId,
          name,
          isGroup,
        });
      },
      onAction(questionId, selectedOption, userId) {
        dispatchResponse({
          questionId,
          value: selectedOption,
          userId,
          channelType: adapter.channelType,
          // platformId/threadId aren't surfaced by the current onAction
          // signature — registered handlers look them up from the
          // pending_question / pending_approval row.
          platformId: '',
          threadId: null,
        }).catch((err) => {
          log.error('Failed to handle question response', { questionId, err });
        });
      },
    };
  });

  // 4. Delivery adapter bridge — dispatches to channel adapters
  const deliveryAdapter = {
    async deliver(
      channelType: string,
      platformId: string,
      threadId: string | null,
      kind: string,
      content: string,
      files?: import('./channels/adapter.js').OutboundFile[],
    ): Promise<string | undefined> {
      const adapter = getChannelAdapter(channelType);
      if (!adapter) {
        log.warn('No adapter for channel type', { channelType });
        return;
      }
      return adapter.deliver(platformId, threadId, { kind, content: JSON.parse(content), files });
    },
    async setTyping(channelType: string, platformId: string, threadId: string | null): Promise<void> {
      const adapter = getChannelAdapter(channelType);
      await adapter?.setTyping?.(platformId, threadId);
    },
    async addReaction(
      channelType: string,
      platformId: string,
      threadId: string | null,
      messageId: string,
      emoji: string,
    ): Promise<void> {
      const adapter = getChannelAdapter(channelType);
      await adapter?.addReaction?.(platformId, threadId, messageId, emoji);
    },
    async removeReaction(
      channelType: string,
      platformId: string,
      threadId: string | null,
      messageId: string,
      emoji: string,
    ): Promise<void> {
      const adapter = getChannelAdapter(channelType);
      await adapter?.removeReaction?.(platformId, threadId, messageId, emoji);
    },
    async pinMessage(
      channelType: string,
      platformId: string,
      threadId: string | null,
      messageId: string,
    ): Promise<void> {
      const adapter = getChannelAdapter(channelType);
      await adapter?.pinMessage?.(platformId, threadId, messageId);
    },
    async unpinMessage(
      channelType: string,
      platformId: string,
      threadId: string | null,
      messageId: string,
    ): Promise<void> {
      const adapter = getChannelAdapter(channelType);
      await adapter?.unpinMessage?.(platformId, threadId, messageId);
    },
    async editMessage(
      channelType: string,
      platformId: string,
      threadId: string | null,
      messageId: string,
      text: string,
    ): Promise<void> {
      const adapter = getChannelAdapter(channelType);
      await adapter?.editMessage?.(platformId, threadId, messageId, text);
    },
  };
  setDeliveryAdapter(deliveryAdapter);

  // 5. Start delivery polls
  startActiveDeliveryPoll();
  startSweepDeliveryPoll();
  log.info('Delivery polls started');

  // 5b. Start outbound-wake server so containers can notify the host
  // immediately on outbound write instead of waiting for the next poll tick.
  // Polling stays on as a fallback for missed wakes.
  startOutboundWakeServer();

  // 5c. Pinned status messages (master + per-worker). Subscribes to the
  // delivery adapter so it can post/edit through Discord.
  startStatusPin();

  // 5d. Resource monitor — polls memory/disk/container-count and posts
  // hysteresis-driven alerts to #master when thresholds are crossed.
  // Self-skips when no master is registered (alerts go to logs only).
  startResourceMonitor({ getActiveContainers: getActiveContainerCount });

  // 6. Start host sweep
  startHostSweep();
  log.info('Host sweep started');

  log.info('NanoClaw running');
}

/** Graceful shutdown. */
async function shutdown(signal: string): Promise<void> {
  log.info('Shutdown signal received', { signal });
  for (const cb of getShutdownCallbacks()) {
    try {
      await cb();
    } catch (err) {
      log.error('Shutdown callback threw', { err });
    }
  }
  stopDeliveryPolls();
  stopHostSweep();
  stopStatusPin();
  stopResourceMonitor();
  await stopOutboundWakeServer();
  await teardownChannelAdapters();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((err) => {
  log.fatal('Startup failed', { err });
  process.exit(1);
});
