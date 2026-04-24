/**
 * `create_worker` delivery-action handler.
 *
 * Creates a new agent_group flagged as a fleet worker, provisions a Discord
 * channel (when configured), wires bidirectional agent-to-agent destinations
 * with the calling master, and seeds container.json with the requested
 * backend/model. Archived groups with the same folder are unarchived
 * (resume path) so prior sessions and workspace survive a destroy→recreate
 * cycle.
 *
 * Security: the MCP tool is only loaded in master-role containers
 * (NANOCLAW_FLEET_ROLE=master). This handler re-checks fleet_role on the
 * calling session's agent_group as defense-in-depth.
 */
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { createAgentGroup, getAgentGroup, getAgentGroupByFolder, updateAgentGroup } from '../../db/agent-groups.js';
import { getMessagingGroupsByAgentGroup } from '../../db/messaging-groups.js';
import { initGroupFilesystem } from '../../group-init.js';
import { log } from '../../log.js';
import type { AgentGroup, Session } from '../../types.js';
import {
  createDestination,
  getDestinationByName,
  normalizeName as normalizeDestName,
} from '../agent-to-agent/db/agent-destinations.js';
import { writeDestinations } from '../agent-to-agent/write-destinations.js';
import { readContainerConfig, writeContainerConfig } from '../../container-config.js';
import { logWorkerEvent } from './events.js';
import { generateId, normalizeName, notifyAgent, setFleetBackend } from './lib.js';
import { provisionDiscordChannel } from './provision.js';
import { applyProfileToContainerConfig, loadWorkerProfile } from './worker-profile.js';

const DEFAULT_BACKEND = 'claude';

function isSafeFolderName(folder: string): boolean {
  const resolvedPath = path.resolve(path.join(GROUPS_DIR, folder));
  const resolvedGroupsDir = path.resolve(GROUPS_DIR);
  return resolvedPath.startsWith(resolvedGroupsDir + path.sep);
}

/**
 * Create the parent→child and child→parent agent_destinations rows. The
 * child's local name for the master uses the master's own folder so users
 * with multiple masters (future) don't collide, with a numeric suffix
 * fallback within the child's namespace.
 */
function wireBidirectionalDestinations(
  master: AgentGroup,
  workerId: string,
  workerLocalName: string,
  nowIso: string,
): void {
  createDestination({
    agent_group_id: master.id,
    local_name: workerLocalName,
    target_type: 'agent',
    target_id: workerId,
    created_at: nowIso,
  });
  let parentName = normalizeDestName(master.folder);
  let suffix = 2;
  while (getDestinationByName(workerId, parentName)) {
    parentName = `${normalizeDestName(master.folder)}-${suffix}`;
    suffix++;
  }
  createDestination({
    agent_group_id: workerId,
    local_name: parentName,
    target_type: 'agent',
    target_id: master.id,
    created_at: nowIso,
  });
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

  if (getDestinationByName(sourceGroup.id, localName)) {
    notifyAgent(session, `Cannot create worker "${name}": destination name collision in master.`);
    return;
  }
  if (!isSafeFolderName(localName)) {
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
  initGroupFilesystem(newGroup, { instructions: instructions ?? undefined });
  setFleetBackend(localName, backend, model);

  // Apply the user's worker profile (repos / tools / mounts / skills) to
  // the new worker's container.json so the next container boot runs
  // worker-init.sh with the right payload. When no profile is configured
  // this is a no-op; the worker simply boots with an empty workspace.
  const profile = loadWorkerProfile();
  const hasProfileContent =
    (profile.repos && profile.repos.length > 0) ||
    (profile.tools && profile.tools.length > 0) ||
    (profile.mounts && profile.mounts.length > 0);
  if (hasProfileContent) {
    const cfg = readContainerConfig(localName);
    const withProfile = applyProfileToContainerConfig(cfg, profile);
    writeContainerConfig(localName, withProfile);
    log.info('Worker profile applied', {
      localName,
      repos: profile.repos?.length ?? 0,
      tools: profile.tools?.length ?? 0,
      mounts: profile.mounts?.length ?? 0,
    });
  }

  const provision = await provisionDiscordChannel(agentGroupId, localName, name, now);
  wireBidirectionalDestinations(sourceGroup, agentGroupId, localName, now);

  // Project new destination into master's running session so the agent can
  // address the worker immediately without waiting for a container wake.
  writeDestinations(session.agent_group_id, session.id);

  notifyAgent(
    session,
    `Worker "${localName}" created on ${backend}${model ? ` (${model})` : ''}. ${provision.statusText}. Message it with <message to="${localName}">...</message>.`,
  );
  log.info('Worker created', {
    agentGroupId,
    localName,
    backend,
    model,
    messagingGroupId: provision.messagingGroupId,
    parent: sourceGroup.id,
  });
  logWorkerEvent({
    timestamp: new Date().toISOString(),
    event: 'created',
    worker: localName,
    folder: localName,
    details: { agentGroupId, backend, model: model ?? null, parent: sourceGroup.folder },
  });
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

  // Reprovision a channel only if none is wired — destroy with --keep-channel
  // would leave the prior wiring in place, and we shouldn't create a second.
  const existingMgs = getMessagingGroupsByAgentGroup(existing.id);
  const channelStatus =
    existingMgs.length > 0
      ? 'kept existing channel'
      : (await provisionDiscordChannel(existing.id, existing.folder, existing.name, now)).statusText;

  // Re-create bidirectional destinations if destroy dropped them.
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
  const parentName = normalizeDestName(sourceGroup.folder);
  if (!getDestinationByName(existing.id, parentName)) {
    createDestination({
      agent_group_id: existing.id,
      local_name: parentName,
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
  logWorkerEvent({
    timestamp: new Date().toISOString(),
    event: 'resumed',
    worker: localName,
    folder: existing.folder,
    details: { agentGroupId: existing.id, backend, model: model ?? null },
  });
}
