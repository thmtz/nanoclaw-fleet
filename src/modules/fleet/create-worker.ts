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
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from '../../config.js';
import {
  createAgentGroup,
  deleteAgentGroup,
  getAgentGroup,
  getAgentGroupByFolder,
  updateAgentGroup,
} from '../../db/agent-groups.js';
import {
  deleteMessagingGroup,
  deleteMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupsByAgentGroup,
} from '../../db/messaging-groups.js';
import { deleteSession, getSessionsByAgentGroup } from '../../db/sessions.js';
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
import { ModelResolutionError, resolveModelForBackend } from './model-resolver.js';
import { provisionDiscordChannel } from './provision.js';
import { applyProfileToContainerConfig, loadWorkerProfile } from './worker-profile.js';
import { createDestination as _ensureCreateDestImported } from '../agent-to-agent/db/agent-destinations.js';
import { getDb } from '../../db/connection.js';

void _ensureCreateDestImported;

const DEFAULT_BACKEND = 'claude';

function isSafeFolderName(folder: string): boolean {
  const resolvedPath = path.resolve(path.join(GROUPS_DIR, folder));
  const resolvedGroupsDir = path.resolve(GROUPS_DIR);
  return resolvedPath.startsWith(resolvedGroupsDir + path.sep);
}

/**
 * Hard-delete an archived worker so a subsequent create_worker with the
 * same name starts truly fresh. Removes:
 *
 *   - groups/<folder>/                    (workspace, CLAUDE.local.md, container.json, profile)
 *   - data/v2-sessions/<agent_group_id>/  (inbound.db, outbound.db, .claude-shared, turns.jsonl, inbox/)
 *   - sessions rows
 *   - any leftover messaging_group_agents + exclusive messaging_groups
 *   - agent_destinations referencing this group (both directions)
 *   - the agent_groups row itself
 *
 * SAFETY: only operates on `archived` groups. Active workers must be
 * destroyed first. Folder path traversal is rejected.
 */
function purgeArchivedWorker(existing: AgentGroup): void {
  if (existing.status !== 'archived') {
    throw new Error(`purgeArchivedWorker refused — group ${existing.id} is not archived (status=${existing.status})`);
  }
  if (!isSafeFolderName(existing.folder)) {
    throw new Error(`purgeArchivedWorker refused — unsafe folder ${existing.folder}`);
  }

  // Sessions + their disk dirs.
  for (const sess of getSessionsByAgentGroup(existing.id)) {
    deleteSession(sess.id);
  }
  const agentDataDir = path.join(DATA_DIR, 'v2-sessions', existing.id);
  if (fs.existsSync(agentDataDir)) {
    fs.rmSync(agentDataDir, { recursive: true, force: true });
  }

  // messaging_group_agents + any messaging_group with no remaining agents.
  // destroy_worker normally cleans these up; this is defense-in-depth for
  // workers that were destroyed pre-cleanup-fix or imported from elsewhere.
  for (const mg of getMessagingGroupsByAgentGroup(existing.id)) {
    const mga = getMessagingGroupAgentByPair(mg.id, existing.id);
    if (mga) deleteMessagingGroupAgent(mga.id);
    const remainingAgents = getDb()
      .prepare('SELECT COUNT(*) as n FROM messaging_group_agents WHERE messaging_group_id = ?')
      .get(mg.id) as { n: number };
    if (remainingAgents.n === 0) {
      deleteMessagingGroup(mg.id);
    }
  }

  // Drop both directions of agent_destinations referencing this worker.
  // Using direct SQL because the public delete API needs (agent_group_id,
  // local_name) pairs and we want to clear by target_id too.
  getDb()
    .prepare('DELETE FROM agent_destinations WHERE agent_group_id = ? OR target_id = ?')
    .run(existing.id, existing.id);

  // Workspace dir.
  const workspaceDir = path.resolve(GROUPS_DIR, existing.folder);
  if (fs.existsSync(workspaceDir)) {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }

  // Finally drop the agent_groups row.
  deleteAgentGroup(existing.id);

  log.warn('Worker purged', {
    agentGroupId: existing.id,
    folder: existing.folder,
    deletedWorkspace: workspaceDir,
    deletedSessionData: agentDataDir,
  });
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
  const fresh = content.fresh === true;

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
    if (fresh) {
      // Caller asked for a clean slate on a name that already has archived
      // history. Master is expected to confirm with the human user before
      // setting fresh=true (the tool description spells this out) — the
      // workspace + conversation history disappear here.
      try {
        purgeArchivedWorker(existing);
      } catch (err) {
        notifyAgent(session, `create_worker fresh failed: ${err instanceof Error ? err.message : String(err)}`);
        log.error('purgeArchivedWorker failed', { err: String(err), folder: localName });
        return;
      }
      logWorkerEvent({
        timestamp: new Date().toISOString(),
        event: 'destroyed',
        worker: localName,
        folder: localName,
        details: { agentGroupId: existing.id, reason: 'purged for fresh create' },
      });
      // Fall through to fresh create below.
    } else {
      await resumeWorker(existing, sourceGroup, session, { backend, model });
      return;
    }
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

  let resolvedModel: string | undefined;
  try {
    resolvedModel = await resolveModelForBackend(backend, model);
  } catch (err) {
    if (err instanceof ModelResolutionError) {
      notifyAgent(session, `create_worker rejected: ${err.message} (no worker created.)`);
      log.warn('create_worker model resolution failed', { localName, backend, model, err: err.message });
      return;
    }
    throw err;
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
    fleet_model: resolvedModel ?? null,
    fleet_role: 'worker',
  };
  createAgentGroup(newGroup);
  initGroupFilesystem(newGroup, { instructions: instructions ?? undefined });
  setFleetBackend(localName, backend, resolvedModel);

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
    `Worker "${localName}" created on ${backend}${resolvedModel ? ` (${resolvedModel})` : ''}. ${provision.statusText}. Message it with <message to="${localName}">...</message>.`,
  );
  log.info('Worker created', {
    agentGroupId,
    localName,
    backend,
    model: resolvedModel,
    messagingGroupId: provision.messagingGroupId,
    parent: sourceGroup.id,
  });
  logWorkerEvent({
    timestamp: new Date().toISOString(),
    event: 'created',
    worker: localName,
    folder: localName,
    details: { agentGroupId, backend, model: resolvedModel ?? null, parent: sourceGroup.folder },
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

  let resolvedModel: string | undefined;
  try {
    resolvedModel = await resolveModelForBackend(backend, model);
  } catch (err) {
    if (err instanceof ModelResolutionError) {
      notifyAgent(session, `create_worker (resume) rejected: ${err.message} ("${existing.folder}" stays archived.)`);
      log.warn('resumeWorker model resolution failed', {
        folder: existing.folder,
        backend,
        model,
        err: err.message,
      });
      return;
    }
    throw err;
  }

  updateAgentGroup(existing.id, {
    status: 'active',
    agent_provider: backend,
    fleet_backend: backend,
    fleet_model: resolvedModel ?? null,
    fleet_role: 'worker',
  });
  setFleetBackend(existing.folder, backend, resolvedModel);

  // Re-apply the current worker profile on resume. The archived worker's
  // container.json was captured before the user may have edited their
  // profile (and indeed before the v2 profile system even existed), so
  // resumed workers would boot with an empty workspace. Refresh every
  // resume so the profile changes take effect on the next container
  // spawn without requiring destroy-fresh-create.
  const profileOnResume = loadWorkerProfile();
  const hasProfileContent =
    (profileOnResume.repos && profileOnResume.repos.length > 0) ||
    (profileOnResume.tools && profileOnResume.tools.length > 0) ||
    (profileOnResume.mounts && profileOnResume.mounts.length > 0);
  if (hasProfileContent) {
    const cfg = readContainerConfig(existing.folder);
    const withProfile = applyProfileToContainerConfig(cfg, profileOnResume);
    writeContainerConfig(existing.folder, withProfile);
    log.info('Worker profile applied on resume', {
      folder: existing.folder,
      repos: profileOnResume.repos?.length ?? 0,
      tools: profileOnResume.tools?.length ?? 0,
      mounts: profileOnResume.mounts?.length ?? 0,
    });
  }

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
    `Worker "${localName}" resumed from archive on ${backend}${resolvedModel ? ` (${resolvedModel})` : ''}. ${channelStatus}. Prior sessions and workspace preserved.`,
  );
  log.info('Worker resumed', { agentGroupId: existing.id, localName, backend, model: resolvedModel });
  logWorkerEvent({
    timestamp: new Date().toISOString(),
    event: 'resumed',
    worker: localName,
    folder: existing.folder,
    details: { agentGroupId: existing.id, backend, model: resolvedModel ?? null },
  });
}
