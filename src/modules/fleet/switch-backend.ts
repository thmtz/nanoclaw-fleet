/**
 * `switch_backend` delivery-action handler.
 *
 * Updates agent_groups.agent_provider + fleet_backend/fleet_model, rewrites
 * container.json to point active_provider at the new backend, and kills any
 * running container so the next wake picks up the new provider.
 *
 * Session state (.claude/) is preserved across switches. The Claude Agent
 * SDK discovers its own session in .claude/ regardless of provider, so
 * conversation continuity holds as long as both providers speak the
 * Anthropic Messages wire format (ANTHROPIC_BASE_URL shims qualify).
 */
import { getAgentGroup, getAgentGroupByFolder, updateAgentGroup } from '../../db/agent-groups.js';
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import { killContainer } from '../../container-runner.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { logWorkerEvent } from './events.js';
import { normalizeName, notifyAgent, setFleetBackend } from './lib.js';

export async function handleSwitchBackend(content: Record<string, unknown>, session: Session): Promise<void> {
  const name = content.name as string;
  const backend = content.backend as string;
  const model = content.model as string | undefined;

  const sourceGroup = getAgentGroup(session.agent_group_id);
  if (!sourceGroup || sourceGroup.fleet_role !== 'master') {
    notifyAgent(session, `switch_backend failed: only the master agent can switch worker backends.`);
    return;
  }

  const localName = normalizeName(name);
  // Accept "master", "self", and the master's folder as aliases for the
  // master agent group. The master is allowed to switch its own backend
  // (e.g. run itself on a cheaper/faster model), not just workers.
  const selfAliases = new Set(['master', 'self', sourceGroup.folder]);
  const target = selfAliases.has(localName) ? sourceGroup : getAgentGroupByFolder(localName);
  if (!target) {
    notifyAgent(session, `switch_backend: no fleet agent named "${localName}".`);
    return;
  }
  if (target.status !== 'active') {
    notifyAgent(session, `switch_backend: "${localName}" is not active.`);
    return;
  }
  if (target.fleet_role !== 'worker' && target.fleet_role !== 'master') {
    notifyAgent(session, `switch_backend: "${localName}" has no fleet role (not a master or worker).`);
    return;
  }

  updateAgentGroup(target.id, { agent_provider: backend, fleet_backend: backend, fleet_model: model ?? null });
  setFleetBackend(target.folder, backend, model);

  // Kill running container so next wake uses new provider env/mounts.
  for (const s of getSessionsByAgentGroup(target.id)) {
    killContainer(s.id, 'fleet switch_backend');
  }

  notifyAgent(
    session,
    `Worker "${localName}" switched to ${backend}${model ? ` (${model})` : ''}. Container will use the new provider on next message.`,
  );
  log.info('Worker backend switched', { agentGroupId: target.id, localName, backend, model });
  logWorkerEvent({
    timestamp: new Date().toISOString(),
    event: 'backend_switched',
    worker: localName,
    folder: target.folder,
    details: { agentGroupId: target.id, backend, model: model ?? null, fleet_role: target.fleet_role },
  });
}
