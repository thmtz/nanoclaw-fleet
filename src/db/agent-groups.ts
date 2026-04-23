import type { AgentGroup } from '../types.js';
import { getDb } from './connection.js';

export function createAgentGroup(group: AgentGroup): void {
  // Fleet module columns (status, fleet_backend, fleet_model, fleet_role) are
  // optional at insert time. `status` has a DB default of 'active'; the rest
  // default to NULL. If the caller passed fleet fields on the input object, we
  // include them in the INSERT so a single call persists the full shape and
  // the caller doesn't have to follow up with updateAgentGroup.
  const row = {
    id: group.id,
    name: group.name,
    folder: group.folder,
    agent_provider: group.agent_provider,
    created_at: group.created_at,
    status: group.status ?? null,
    fleet_backend: group.fleet_backend ?? null,
    fleet_model: group.fleet_model ?? null,
    fleet_role: group.fleet_role ?? null,
  };
  getDb()
    .prepare(
      `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at, status, fleet_backend, fleet_model, fleet_role)
       VALUES (@id, @name, @folder, @agent_provider, @created_at,
               COALESCE(@status, 'active'), @fleet_backend, @fleet_model, @fleet_role)`,
    )
    .run(row);
}

export function getAgentGroup(id: string): AgentGroup | undefined {
  return getDb().prepare('SELECT * FROM agent_groups WHERE id = ?').get(id) as AgentGroup | undefined;
}

export function getAgentGroupByFolder(folder: string): AgentGroup | undefined {
  return getDb().prepare('SELECT * FROM agent_groups WHERE folder = ?').get(folder) as AgentGroup | undefined;
}

export function getAllAgentGroups(): AgentGroup[] {
  return getDb().prepare('SELECT * FROM agent_groups ORDER BY name').all() as AgentGroup[];
}

export function getActiveAgentGroups(): AgentGroup[] {
  return getDb()
    .prepare(`SELECT * FROM agent_groups WHERE status IS NULL OR status = 'active' ORDER BY name`)
    .all() as AgentGroup[];
}

export function updateAgentGroup(
  id: string,
  updates: Partial<
    Pick<AgentGroup, 'name' | 'agent_provider' | 'status' | 'fleet_backend' | 'fleet_model' | 'fleet_role'>
  >,
): void {
  const fields: string[] = [];
  const values: Record<string, unknown> = { id };

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = @${key}`);
      values[key] = value;
    }
  }
  if (fields.length === 0) return;

  getDb()
    .prepare(`UPDATE agent_groups SET ${fields.join(', ')} WHERE id = @id`)
    .run(values);
}

export function deleteAgentGroup(id: string): void {
  getDb().prepare('DELETE FROM agent_groups WHERE id = ?').run(id);
}
