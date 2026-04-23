/**
 * list_workers — read-only query of the fleet, called from the MCP tool.
 *
 * Unlike create/destroy/switch, this does NOT flow through
 * registerDeliveryAction; the MCP tool invokes it synchronously and returns
 * JSON in the tool result. No messages_out emission.
 */
import { getAllAgentGroups } from '../../db/agent-groups.js';
import { getMessagingGroupsByAgentGroup } from '../../db/messaging-groups.js';
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import type { Session } from '../../types.js';
import { notifyAgent } from './lib.js';

export interface WorkerSummary {
  name: string;
  folder: string;
  status: string;
  backend: string | null;
  model: string | null;
  channels: string[];
  container_status: string;
  last_active: string | null;
}

function formatWorkerSummary(workers: WorkerSummary[]): string {
  if (workers.length === 0) return 'No fleet workers. Use create_worker to make one.';
  const lines = ['Fleet workers:', ''];
  for (const w of workers) {
    const marker = w.status === 'archived' ? '[archived]' : w.container_status === 'running' ? '[running]' : w.container_status === 'idle' ? '[idle]' : '[stopped]';
    const backendStr = w.backend ? `${w.backend}${w.model ? ` (${w.model})` : ''}` : '—';
    const channelStr = w.channels.length > 0 ? w.channels.join(', ') : 'no channel';
    lines.push(`- ${marker} ${w.name} · ${backendStr} · ${channelStr}`);
  }
  return lines.join('\n');
}

export async function handleListWorkersRequest(_content: Record<string, unknown>, session: Session): Promise<void> {
  const summary = listWorkers();
  notifyAgent(session, formatWorkerSummary(summary));
}

export function listWorkers(): WorkerSummary[] {
  const all = getAllAgentGroups();
  const workers = all.filter((g) => g.fleet_role === 'worker');

  return workers.map((g) => {
    const sessions = getSessionsByAgentGroup(g.id);
    // Pick the "most alive" session — running > idle > stopped — for display.
    const byAliveness = (s: { container_status: string }): number =>
      s.container_status === 'running' ? 2 : s.container_status === 'idle' ? 1 : 0;
    sessions.sort((a, b) => byAliveness(b) - byAliveness(a));
    const primary = sessions[0];
    const mgs = getMessagingGroupsByAgentGroup(g.id);
    return {
      name: g.name,
      folder: g.folder,
      status: g.status ?? 'active',
      backend: g.fleet_backend ?? g.agent_provider ?? null,
      model: g.fleet_model ?? null,
      channels: mgs.map((m) => `${m.channel_type}:${m.platform_id}`),
      container_status: primary?.container_status ?? 'none',
      last_active: primary?.last_active ?? null,
    };
  });
}
