/**
 * Channel + wiring provisioning shared between create_worker and resume.
 *
 * Encapsulates the "make a Discord channel and wire it to this worker agent
 * group" flow so the create and resume paths don't duplicate it. Returns a
 * status string suitable for user-facing notification text, plus the new
 * messaging_group_id (or null when no channel was provisioned).
 */
import { createMessagingGroup, createMessagingGroupAgent } from '../../db/messaging-groups.js';
import { log } from '../../log.js';
import type { MessagingGroup, MessagingGroupAgent } from '../../types.js';
import { createDiscordChannel, loadDiscordFleetConfig } from './discord-channel.js';
import { generateId } from './lib.js';

export interface ProvisionResult {
  messagingGroupId: string | null;
  statusText: string;
}

/**
 * Provision a Discord channel for a worker (when Discord fleet config is
 * present) and insert the messaging_group + wiring rows. Swallows Discord
 * errors — failure leaves the worker usable as an agent-to-agent target,
 * the status text explains what happened. Callers don't need to catch.
 */
export async function provisionDiscordChannel(
  workerAgentGroupId: string,
  workerFolder: string,
  workerDisplayName: string,
  nowIso: string,
): Promise<ProvisionResult> {
  const discordCfg = loadDiscordFleetConfig();
  if (!discordCfg) {
    log.info('Fleet: no Discord config, skipping channel provisioning', { workerAgentGroupId });
    return { messagingGroupId: null, statusText: 'no channel (Discord not configured)' };
  }

  try {
    const channel = await createDiscordChannel(
      discordCfg,
      `worker-${workerFolder}`,
      `Fleet worker: ${workerDisplayName}`,
    );
    const mg: MessagingGroup = {
      id: generateId('mg'),
      channel_type: 'discord',
      platform_id: channel.id,
      name: channel.name,
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: nowIso,
    };
    createMessagingGroup(mg);
    const mga: MessagingGroupAgent = {
      id: generateId('mga'),
      messaging_group_id: mg.id,
      agent_group_id: workerAgentGroupId,
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'known',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: nowIso,
    };
    createMessagingGroupAgent(mga);
    return { messagingGroupId: mg.id, statusText: 'Discord channel created' };
  } catch (err) {
    log.error('Fleet: Discord channel provisioning failed', { workerAgentGroupId, err });
    return { messagingGroupId: null, statusText: `Discord provisioning failed: ${String(err)}` };
  }
}
