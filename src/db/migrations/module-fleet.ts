import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

/**
 * Fleet: worker lifecycle tracking on agent_groups.
 *
 * status: 'active' | 'archived'. Archived groups keep their folder and
 * sessions on disk so a future create_worker with the same name can
 * resume. Fleet workers that get destroyed end up here.
 *
 * fleet_backend / fleet_model cache the currently-selected provider so
 * list_workers and ncf status don't have to open container.json per row.
 * Kept in sync by create_worker / switch_backend handlers.
 *
 * fleet_role: 'master' | 'worker' | null. Master containers get the
 * fleet MCP tools (create_worker, destroy_worker, switch_backend,
 * list_workers); workers and plain v2 agents don't. null keeps the
 * row v2-native (no fleet semantics).
 */
export const moduleFleet: Migration = {
  version: 100,
  name: 'fleet',
  up(db: Database.Database) {
    db.exec(`
      ALTER TABLE agent_groups ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
      ALTER TABLE agent_groups ADD COLUMN fleet_backend TEXT;
      ALTER TABLE agent_groups ADD COLUMN fleet_model TEXT;
      ALTER TABLE agent_groups ADD COLUMN fleet_role TEXT;
      CREATE INDEX idx_agent_groups_status ON agent_groups(status);
      CREATE INDEX idx_agent_groups_fleet_role ON agent_groups(fleet_role) WHERE fleet_role IS NOT NULL;
    `);
  },
};
