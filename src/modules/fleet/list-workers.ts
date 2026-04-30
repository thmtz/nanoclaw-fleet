/**
 * list_workers — read-only query of the fleet, called from the MCP tool.
 *
 * Unlike create/destroy/switch, this does NOT flow through
 * registerDeliveryAction; the MCP tool invokes it synchronously and returns
 * JSON in the tool result. No messages_out emission.
 *
 * The Discord-formatted summary mirrors v1 fleet's `nc-status.sh` output:
 *
 *   **Master** · `claude-opus-4-7` · up 2h 5m
 *
 *   ## 🤖 Workers
 *   - 🟢 worker-name · `model` · up 1h 23m
 *   - ⚫ another · `model` · stopped
 */
import { execSync } from 'child_process';

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
  /** Docker's `Up 2 hours`-style uptime when running, else null. */
  container_uptime: string | null;
}

export interface MasterSummary {
  name: string;
  backend: string | null;
  model: string | null;
  container_uptime: string | null;
  container_status: string;
}

export interface FleetSummary {
  master: MasterSummary | null;
  workers: WorkerSummary[];
}

/**
 * Read all running `nanoclaw-v2-*` containers and build a folder→uptime map
 * in one shot. Single docker call for the whole fleet — caller doesn't
 * loop over `docker inspect`. Container name format is
 * `nanoclaw-v2-<folder>-<13-digit-timestamp>` (matches container-runner +
 * cleanup-workers regex). Status format is Docker's "Up 2 hours" / "Up 5
 * minutes" — we keep it as-is and strip the "Up " prefix in the formatter.
 */
const NAME_RE = /^nanoclaw-v2-(.+)-(\d{13})$/;

function readRunningUptimes(): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const out = execSync(`docker ps --filter name=nanoclaw-v2- --format '{{.Names}}|{{.Status}}'`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (!out) return map;
    for (const line of out.split('\n')) {
      const [name, status] = line.split('|');
      const m = name?.match(NAME_RE);
      if (!m) continue;
      const folder = m[1];
      // Status is e.g. "Up 2 hours" or "Up 5 minutes". Strip the "Up "
      // prefix; an "(unhealthy)" suffix from container healthchecks
      // could in principle land here, so we keep whatever's after "Up ".
      const uptime = status?.replace(/^Up\s+/, '');
      if (uptime) map.set(folder, uptime);
    }
  } catch {
    /* docker not available — uptime stays null */
  }
  return map;
}

export function getFleetSummary(): FleetSummary {
  const all = getAllAgentGroups();
  const uptimes = readRunningUptimes();

  // "Most alive" session selection — running > idle > stopped — used for
  // both master and workers so the dashboard reports the running session
  // when one exists rather than whichever the DB happens to return first.
  const byAliveness = (s: { container_status: string }): number =>
    s.container_status === 'running' ? 2 : s.container_status === 'idle' ? 1 : 0;
  const pickPrimarySession = (
    agentGroupId: string,
  ): { container_status: string; last_active?: string | null } | undefined => {
    const sessions = [...getSessionsByAgentGroup(agentGroupId)];
    sessions.sort((a, b) => byAliveness(b) - byAliveness(a));
    return sessions[0];
  };

  const masterAg = all.find((g) => g.fleet_role === 'master' && (g.status ?? 'active') === 'active');
  let master: MasterSummary | null = null;
  if (masterAg) {
    const primary = pickPrimarySession(masterAg.id);
    master = {
      name: masterAg.name,
      backend: masterAg.fleet_backend ?? masterAg.agent_provider ?? null,
      model: masterAg.fleet_model ?? null,
      container_status: primary?.container_status ?? 'none',
      container_uptime: uptimes.get(masterAg.folder) ?? null,
    };
  }

  const workers: WorkerSummary[] = all
    .filter((g) => g.fleet_role === 'worker')
    .map((g) => {
      const primary = pickPrimarySession(g.id);
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
        container_uptime: uptimes.get(g.folder) ?? null,
      };
    });

  return { master, workers };
}

/**
 * Backwards-compatible alias. New code should use `getFleetSummary()` for
 * the master-aware result.
 */
export function listWorkers(): WorkerSummary[] {
  return getFleetSummary().workers;
}

/**
 * Discord-formatted dashboard. Master state on top, workers below as a
 * bullet list with status emoji + uptime. Closes with a one-line summary.
 * Mirrors v1 nc-status.sh output (FORK-SPEC §13.2).
 */
export function formatFleetSummary(s: FleetSummary): string {
  const lines: string[] = [];

  if (s.master) {
    const modelStr = s.master.model ? `\`${s.master.model}\`` : `\`${s.master.backend ?? 'claude'}\``;
    const uptimeStr = s.master.container_uptime ? `up ${s.master.container_uptime}` : s.master.container_status;
    lines.push(`**Master** · ${modelStr} · ${uptimeStr}`);
    lines.push('');
  }

  if (s.workers.length === 0) {
    lines.push('## 🤖 Workers');
    lines.push('_No fleet workers. Use `create_worker` to make one._');
    return lines.join('\n');
  }

  lines.push('## 🤖 Workers');
  for (const w of s.workers) {
    const icon = w.status === 'archived' ? '🗄️' : w.container_status === 'running' ? '🟢' : '⚫';
    const modelStr = w.model ? `\`${w.model}\`` : `\`${w.backend ?? '—'}\``;
    const stateStr =
      w.status === 'archived'
        ? 'archived'
        : w.container_uptime
          ? `up ${w.container_uptime}`
          : w.container_status === 'idle'
            ? 'idle'
            : 'stopped';
    lines.push(`- ${icon} **${w.name}** · ${modelStr} · ${stateStr}`);
  }

  // Summary footer.
  const active = s.workers.filter((w) => w.status !== 'archived');
  const running = active.filter((w) => w.container_status === 'running').length;
  const archived = s.workers.length - active.length;
  lines.push('');
  lines.push(`_${running}/${active.length} running${archived ? ` · ${archived} archived` : ''}_`);

  return lines.join('\n');
}

export async function handleListWorkersRequest(_content: Record<string, unknown>, session: Session): Promise<void> {
  notifyAgent(session, formatFleetSummary(getFleetSummary()));
}
