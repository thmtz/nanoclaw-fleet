/**
 * `create_worker` delivery-action handler.
 *
 * Fleet's superset of `create_agent`: creates a new agent_group with fleet
 * metadata, provisions a Discord channel, wires it via messaging_group_agents,
 * seeds container.json with the requested backend/model, and notifies the
 * creator. Archived agent_groups with the same folder are resumed instead of
 * recreated, preserving prior sessions and workspace.
 *
 * Security: only called from master containers (fleet_role='master' on the
 * calling session's agent_group). The MCP tool is only loaded there.
 * Defense-in-depth: this handler re-checks fleet_role before acting.
 */
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { createAgentGroup, getAgentGroup, getAgentGroupByFolder, updateAgentGroup } from '../../db/agent-groups.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupsByAgentGroup,
} from '../../db/messaging-groups.js';
import { initGroupFilesystem } from '../../group-init.js';
import { log } from '../../log.js';
import type { AgentGroup, MessagingGroup, MessagingGroupAgent, Session } from '../../types.js';
import {
  createDestination,
  getDestinationByName,
  normalizeName as normalizeDestName,
} from '../agent-to-agent/db/agent-destinations.js';
import { writeDestinations } from '../agent-to-agent/write-destinations.js';
import { createDiscordChannel, loadDiscordFleetConfig } from './discord-channel.js';
import { generateId, normalizeName, notifyAgent, setFleetBackend } from './lib.js';

const DEFAULT_BACKEND = 'claude';

function safeFolderPath(folder: string): string | null {
  const groupPath = path.join(GROUPS_DIR, folder);
  const resolvedPath = path.resolve(groupPath);
  const resolvedGroupsDir = path.resolve(GROUPS_DIR);
  if (!resolvedPath.startsWith(resolvedGroupsDir + path.sep)) return null;
  return resolvedPath;
}

export async function handleCreateWorker(content: Record<string, unknown>, session: Session): Promise<void> {
  const name = content.name as string;
  const backend = (content.backend as string | undefined) ?? DEFAULT_BACKEND;
  const model = content.model as string | undefined;
  const instructions = content.instructions as string | null | undefined;

  const sourceGroup = getAgentGroup(session.agent_group_id);
  if (!sourceGroup) {
    notifyAgent(session, `create_worker failed: source agent group not found.`);
    log.warn('create_worker: missing source group', { sessionAgentGroup: session.agent_group_id, name });
    return;
  }

  if (sourceGroup.fleet_role !== 'master') {
    notifyAgent(session, `create_worker failed: only the master agent can create workers.`);
    log.warn('create_worker rejected: non-master caller', {
      sourceGroup: sourceGroup.id,
      fleet_role: sourceGroup.fleet_role,
    });
    return;
  }

  const localName = normalizeName(name);
  if (!localName || localName === 'unnamed') {
    notifyAgent(session, `create_worker failed: "${name}" is not a usable worker name.`);
    return;
  }

  // Resume path: if a worker with this folder was previously archived, unarchive
  // instead of creating a new one. Session state under data/v2-sessions/<id>/
  // stays intact, so conversation + .claude/ history survive.
  const existing = getAgentGroupByFolder(localName);
  if (existing && existing.status === 'archived') {
    await resumeWorker(existing, sourceGroup, session, { backend, model });
    return;
  }
  if (existing && existing.status !== 'archived') {
    notifyAgent(
      session,
      `Cannot create worker "${localName}": an active worker with that name already exists. Use destroy first.`,
    );
    return;
  }

  // Fresh create path.
  if (getDestinationByName(sourceGroup.id, localName)) {
    notifyAgent(session, `Cannot create worker "${name}": destination name collision in master.`);
    return;
  }
  if (!safeFolderPath(localName)) {
    notifyAgent(session, `Cannot create worker "${name}": invalid folder path.`);
    log.error('create_worker path traversal attempt', { folder: localName });
    return;
  }

  const agentGroupId = generateId('ag');
  const now = new Date().toISOString();

  const newGroup: AgentGroup = {
    id: agentGroupId,
    name,
    folder: localName,
    agent_provider: backend,
    created_at: now,
    status: 'active',
    fleet_backend: backend,
    fleet_model: model ?? null,
    fleet_role: 'worker',
  };
  createAgentGroup(newGroup);
  // createAgentGroup (v2 default insert) only writes the base cols. Fleet
  // cols get set via updateAgentGroup below.
  updateAgentGroup(agentGroupId, {
    status: 'active',
    fleet_backend: backend,
    fleet_model: model ?? null,
    fleet_role: 'worker',
  });
  initGroupFilesystem(newGroup, { instructions: instructions ?? undefined });
  setFleetBackend(localName, backend, model);

  // Discord channel provisioning (fleet currently Discord-only).
  const discordCfg = loadDiscordFleetConfig();
  let messagingGroupId: string | null = null;
  if (discordCfg) {
    try {
      const channel = await createDiscordChannel(discordCfg, `worker-${localName}`, `Fleet worker: ${name}`);
      const mg: MessagingGroup = {
        id: generateId('mg'),
        channel_type: 'discord',
        platform_id: channel.id,
        name: channel.name,
        is_group: 1,
        unknown_sender_policy: 'strict',
        created_at: now,
      };
      createMessagingGroup(mg);
      messagingGroupId = mg.id;

      const mga: MessagingGroupAgent = {
        id: generateId('mga'),
        messaging_group_id: mg.id,
        agent_group_id: agentGroupId,
        engage_mode: 'pattern',
        engage_pattern: '.',
        sender_scope: 'known',
        ignored_message_policy: 'drop',
        session_mode: 'shared',
        priority: 0,
        created_at: now,
      };
      createMessagingGroupAgent(mga);
    } catch (err) {
      notifyAgent(
        session,
        `Worker "${localName}" created (agent group ${agentGroupId}) but Discord channel provisioning failed: ${String(err)}`,
      );
      log.error('create_worker: Discord provisioning failed', { err });
    }
  } else {
    log.info('create_worker: no Discord fleet config, skipping channel', { agentGroupId });
  }

  // Bidirectional destinations so master can address worker by name and
  // vice versa.
  createDestination({
    agent_group_id: sourceGroup.id,
    local_name: localName,
    target_type: 'agent',
    target_id: agentGroupId,
    created_at: now,
  });
  let parentName = 'master';
  let parentSuffix = 2;
  while (getDestinationByName(agentGroupId, parentName)) {
    parentName = `master-${parentSuffix}`;
    parentSuffix++;
  }
  createDestination({
    agent_group_id: agentGroupId,
    local_name: parentName,
    target_type: 'agent',
    target_id: sourceGroup.id,
    created_at: now,
  });

  // Project the new destination into the master's running session so it
  // can send to the worker without waiting for a container wake.
  writeDestinations(session.agent_group_id, session.id);

  const where = messagingGroupId ? 'discord channel created' : 'no channel (Discord not configured)';
  notifyAgent(
    session,
    `Worker "${localName}" created on ${backend}${model ? ` (${model})` : ''}. ${where}. Message it with <message to="${localName}">...</message>.`,
  );
  log.info('Worker created', { agentGroupId, localName, backend, model, messagingGroupId, parent: sourceGroup.id });
}

async function resumeWorker(
  existing: AgentGroup,
  sourceGroup: AgentGroup,
  session: Session,
  opts: { backend: string; model?: string },
): Promise<void> {
  const { backend, model } = opts;
  const now = new Date().toISOString();

  updateAgentGroup(existing.id, {
    status: 'active',
    agent_provider: backend,
    fleet_backend: backend,
    fleet_model: model ?? null,
    fleet_role: 'worker',
  });
  setFleetBackend(existing.folder, backend, model);

  // If the archived worker previously had a Discord channel but it was
  // deleted on destroy, provision a fresh one. If it's still wired
  // (destroy --keep-channel), skip.
  const existingMgs = getMessagingGroupsByAgentGroup(existing.id);
  let channelStatus = 'kept existing channel';
  if (existingMgs.length === 0) {
    const discordCfg = loadDiscordFleetConfig();
    if (discordCfg) {
      try {
        const channel = await createDiscordChannel(
          discordCfg,
          `worker-${existing.folder}`,
          `Fleet worker: ${existing.name}`,
        );
        const mg: MessagingGroup = {
          id: generateId('mg'),
          channel_type: 'discord',
          platform_id: channel.id,
          name: channel.name,
          is_group: 1,
          unknown_sender_policy: 'strict',
          created_at: now,
        };
        createMessagingGroup(mg);
        const mga: MessagingGroupAgent = {
          id: generateId('mga'),
          messaging_group_id: mg.id,
          agent_group_id: existing.id,
          engage_mode: 'pattern',
          engage_pattern: '.',
          sender_scope: 'known',
          ignored_message_policy: 'drop',
          session_mode: 'shared',
          priority: 0,
          created_at: now,
        };
        createMessagingGroupAgent(mga);
        channelStatus = 'new Discord channel created';
      } catch (err) {
        channelStatus = `Discord reprovisioning failed: ${String(err)}`;
        log.error('resume_worker: Discord reprovisioning failed', { err });
      }
    }
  }

  // Ensure bidirectional destinations still exist (destroy may have dropped them).
  const localName = normalizeDestName(existing.folder);
  if (!getDestinationByName(sourceGroup.id, localName)) {
    createDestination({
      agent_group_id: sourceGroup.id,
      local_name: localName,
      target_type: 'agent',
      target_id: existing.id,
      created_at: now,
    });
  }
  if (!getDestinationByName(existing.id, 'master')) {
    createDestination({
      agent_group_id: existing.id,
      local_name: 'master',
      target_type: 'agent',
      target_id: sourceGroup.id,
      created_at: now,
    });
  }

  writeDestinations(session.agent_group_id, session.id);

  notifyAgent(
    session,
    `Worker "${localName}" resumed from archive on ${backend}${model ? ` (${model})` : ''}. ${channelStatus}. Prior sessions and workspace preserved.`,
  );
  log.info('Worker resumed', { agentGroupId: existing.id, localName, backend, model });
}
