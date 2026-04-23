/**
 * Fleet module shared helpers.
 *
 * Used by create-worker, destroy-worker, switch-backend, list-workers.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { getSession } from '../../db/sessions.js';
import { wakeContainer } from '../../container-runner.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';

export function normalizeName(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'unnamed'
  );
}

export function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Deliver a system-chat message back to the creator agent's session so it
 * sees the result of the fleet action. Mirrors agent-to-agent's notifyAgent.
 */
export function notifyAgent(session: Session, text: string): void {
  writeSessionMessage(session.agent_group_id, session.id, {
    id: generateId('sys'),
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
  });
  const fresh = getSession(session.id);
  if (fresh) {
    wakeContainer(fresh).catch((err) => log.error('Failed to wake container after fleet notify', { err }));
  }
}

/**
 * Read container.json for an agent group. Returns {} if file is missing or
 * invalid so callers can treat it as "no overrides."
 */
export function readContainerConfig(folder: string): Record<string, unknown> {
  const p = path.join(GROUPS_DIR, folder, 'container.json');
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (err) {
    log.warn('container.json parse failed', { folder, err: String(err) });
    return {};
  }
}

export function writeContainerConfig(folder: string, config: Record<string, unknown>): void {
  const p = path.join(GROUPS_DIR, folder, 'container.json');
  fs.writeFileSync(p, JSON.stringify(config, null, 2) + '\n');
}

/**
 * Set the active backend + model on an agent group's container.json.
 *
 * v2's container-runner reads the top-level `provider` field to pick the
 * provider module. Fleet also keeps a `providers` map keyed by provider
 * name so per-backend settings (model, base_url, etc.) survive across
 * switches — `switch_backend` just flips `provider` and the previous
 * provider's settings stay cached in the map for a later switch back.
 */
export function setFleetBackend(folder: string, backend: string, model?: string): void {
  const cfg = readContainerConfig(folder);
  const providers = (cfg.providers ?? {}) as Record<string, Record<string, unknown>>;
  const slot = providers[backend] ?? {};
  if (model) slot.model = model;
  providers[backend] = slot;
  cfg.providers = providers;
  cfg.provider = backend;
  writeContainerConfig(folder, cfg);
}
