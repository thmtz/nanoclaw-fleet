/**
 * `destroy_worker` delivery-action handler.
 *
 * Stops any running container, archives the agent_group (status='archived'),
 * drops bidirectional destinations, and optionally deletes the Discord
 * channel. Filesystem (`groups/<folder>/`) and session data
 * (`data/v2-sessions/<agent_group_id>/`) are preserved — create_worker with
 * the same name resumes from archive.
 */
import { getAgentGroup, getAgentGroupByFolder, updateAgentGroup } from '../../db/agent-groups.js';
import {
  deleteMessagingGroup,
  deleteMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupsByAgentGroup,
} from '../../db/messaging-groups.js';
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import { killContainer } from '../../container-runner.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { deleteDestination, getDestinationByTarget } from '../agent-to-agent/db/agent-destinations.js';
import { deleteDiscordChannel, loadDiscordFleetConfig } from './discord-channel.js';
import { logWorkerEvent } from './events.js';
import { normalizeName, notifyAgent } from './lib.js';

export async function handleDestroyWorker(content: Record<string, unknown>, session: Session): Promise<void> {
  const name = content.name as string;
  const deleteChannel = content.delete_channel !== false; // default true

  const sourceGroup = getAgentGroup(session.agent_group_id);
  if (!sourceGroup) {
    notifyAgent(session, `destroy_worker failed: source agent group not found.`);
    return;
  }
  if (sourceGroup.fleet_role !== 'master') {
    notifyAgent(session, `destroy_worker failed: only the master agent can destroy workers.`);
    return;
  }

  const localName = normalizeName(name);
  const target = getAgentGroupByFolder(localName);
  if (!target) {
    notifyAgent(session, `destroy_worker: no worker named "${localName}" found.`);
    return;
  }
  if (target.fleet_role !== 'worker') {
    notifyAgent(
      session,
      `destroy_worker: "${localName}" is not a fleet worker (fleet_role=${target.fleet_role ?? 'null'}).`,
    );
    return;
  }
  if (target.status === 'archived') {
    notifyAgent(session, `destroy_worker: "${localName}" is already archived.`);
    return;
  }

  // Stop every running container that belongs to this worker.
  for (const s of getSessionsByAgentGroup(target.id)) {
    killContainer(s.id, 'fleet destroy_worker');
  }

  // Delete Discord channel(s) wired to this worker.
  let channelStatus = 'channel left in place';
  if (deleteChannel) {
    const mgs = getMessagingGroupsByAgentGroup(target.id);
    const discordCfg = loadDiscordFleetConfig();
    for (const mg of mgs) {
      // Drop the wiring first so the router stops routing inbound.
      const mga = getMessagingGroupAgentByPair(mg.id, target.id);
      if (mga) deleteMessagingGroupAgent(mga.id);
      if (discordCfg && mg.channel_type === 'discord') {
        // platform_id is stored as `discord:<guild>:<channel>` (Chat SDK
        // format); Discord REST expects the raw channel id.
        const rawChannelId = mg.platform_id.startsWith('discord:') ? mg.platform_id.split(':').pop()! : mg.platform_id;
        try {
          await deleteDiscordChannel(discordCfg, rawChannelId);
        } catch (err) {
          log.warn('destroy_worker: Discord channel delete failed', { mgId: mg.id, err: String(err) });
        }
      }
      deleteMessagingGroup(mg.id);
    }
    channelStatus = mgs.length > 0 ? `${mgs.length} channel(s) deleted` : 'no channels were wired';
  }

  // Drop bidirectional destinations so master stops seeing the worker as a
  // target (and vice versa). Parent dest is deleted via target lookup; child
  // dest uses getDestinationByTarget by pointing at source.
  const masterDest = getDestinationByTarget(sourceGroup.id, 'agent', target.id);
  if (masterDest) deleteDestination(masterDest.agent_group_id, masterDest.local_name);
  const workerDest = getDestinationByTarget(target.id, 'agent', sourceGroup.id);
  if (workerDest) deleteDestination(workerDest.agent_group_id, workerDest.local_name);

  updateAgentGroup(target.id, { status: 'archived' });

  notifyAgent(
    session,
    `Worker "${localName}" destroyed. ${channelStatus}. Workspace and session history preserved; create_worker with the same name resumes.`,
  );
  log.info('Worker destroyed', { agentGroupId: target.id, localName, channelStatus });
  logWorkerEvent({
    timestamp: new Date().toISOString(),
    event: 'destroyed',
    worker: localName,
    folder: target.folder,
    details: { agentGroupId: target.id, channelStatus, deleteChannel },
  });
}
