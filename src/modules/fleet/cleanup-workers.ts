/**
 * `cleanup_workers` delivery-action handler.
 *
 * Reconciles three reality views and surfaces drift:
 *   1. agent_groups (DB)        — what we think exists
 *   2. messaging_groups (DB)    — channels we think we own
 *   3. Discord guild channels   — channels that actually exist
 *   4. Running docker containers — workers that are actually consuming RAM
 *
 * Three drift categories:
 *   • Orphan channels   — Discord channel exists in our category prefix
 *                         space but no messaging_groups row points at it.
 *                         Auto-deleted (matches v1 cleanup_workers + v2's
 *                         existing `ncf reap-orphans`).
 *   • Orphan workers    — agent_groups row is active + fleet_role='worker'
 *                         but its messaging_group's platform_id is missing
 *                         from the live Discord channel set.
 *                         REPORTED ONLY — the master decides whether to
 *                         recreate the channel or archive the worker.
 *   • Orphan containers — docker shows a `nanoclaw-v2-<folder>-<ts>` whose
 *                         folder doesn't match any active agent_group.
 *                         Auto-killed (matches v1).
 *
 * Master-only. Same fire-and-forget pattern as create/destroy/switch.
 */
import { execSync } from 'child_process';

import { getActiveAgentGroups, getAgentGroup } from '../../db/agent-groups.js';
import { getAllMessagingGroups, getMessagingGroupsByAgentGroup } from '../../db/messaging-groups.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { deleteDiscordChannel, listDiscordChannels, loadDiscordFleetConfig } from './discord-channel.js';
import { logWorkerEvent } from './events.js';
import { notifyAgent } from './lib.js';

interface CleanupReport {
  orphanChannels: Array<{ id: string; name: string }>;
  orphanWorkers: Array<{ name: string; folder: string; reason: string }>;
  orphanContainers: string[];
  errors: string[];
}

interface CleanupOptions {
  dryRun: boolean;
}

/**
 * Container-name parser: `nanoclaw-v2-<folder>-<Date.now()>`. Folder may
 * contain hyphens AND digits (e.g. `model-dev-2024`), so we anchor on a
 * 13-digit ms-epoch timestamp suffix rather than `\d+`. A loose `\d+`
 * would eat the trailing `-2024` as the timestamp and mis-identify the
 * folder as `model-dev`, potentially marking an active container as
 * orphan (or vice-versa). Matches `src/container-runner.ts:176`.
 */
const CONTAINER_NAME_RE = /^nanoclaw-v2-(.+)-(\d{13})$/;

export async function handleCleanupWorkers(content: Record<string, unknown>, session: Session): Promise<void> {
  const sourceGroup = getAgentGroup(session.agent_group_id);
  if (!sourceGroup || sourceGroup.fleet_role !== 'master') {
    notifyAgent(session, `cleanup_workers failed: only the master agent can run cleanup.`);
    return;
  }

  const dryRun = content.dry_run === true;
  const report = await runCleanup({ dryRun });

  notifyAgent(session, formatReport(report, dryRun));
  logWorkerEvent({
    timestamp: new Date().toISOString(),
    event: dryRun ? 'cleanup_dry_run' : 'cleanup_executed',
    worker: 'master',
    folder: sourceGroup.folder,
    details: {
      orphanChannelCount: report.orphanChannels.length,
      orphanWorkerCount: report.orphanWorkers.length,
      orphanContainerCount: report.orphanContainers.length,
      errorCount: report.errors.length,
    },
  });
}

export async function runCleanup(opts: CleanupOptions): Promise<CleanupReport> {
  const report: CleanupReport = {
    orphanChannels: [],
    orphanWorkers: [],
    orphanContainers: [],
    errors: [],
  };

  // 1. Reconcile Discord channels ↔ messaging_groups.
  const discordCfg = loadDiscordFleetConfig();
  if (discordCfg) {
    try {
      const liveChannels = await listDiscordChannels(discordCfg);
      const liveChannelIds = new Set(liveChannels.filter((c) => c.type === 0).map((c) => c.id));

      const ourChannelIds = new Set<string>();
      for (const mg of getAllMessagingGroups()) {
        if (mg.channel_type !== 'discord') continue;
        const parts = mg.platform_id.split(':');
        const chanId = parts[parts.length - 1];
        if (chanId) ourChannelIds.add(chanId);
      }

      // Orphan channels: live but not ours. Restrict to fleet-prefix names so
      // we never touch user-created channels we don't manage.
      for (const chan of liveChannels) {
        if (chan.type !== 0) continue;
        if (!chan.name.startsWith('worker-') && !chan.name.startsWith('lc-')) continue;
        if (ourChannelIds.has(chan.id)) continue;
        report.orphanChannels.push({ id: chan.id, name: chan.name });
      }

      // Orphan workers: ours but not live. Skip workers whose messaging_group
      // is non-Discord (those are valid; we can't verify them via this API).
      for (const ag of getActiveAgentGroups()) {
        if (ag.fleet_role !== 'worker') continue;
        const mgs = getMessagingGroupsByAgentGroup(ag.id);
        const discordMgs = mgs.filter((mg) => mg.channel_type === 'discord');
        if (discordMgs.length === 0) {
          // Active worker with no channel of any kind — likely stuck mid-create.
          report.orphanWorkers.push({ name: ag.name, folder: ag.folder, reason: 'no messaging_group' });
          continue;
        }
        for (const mg of discordMgs) {
          const chanId = mg.platform_id.split(':').pop() ?? '';
          if (!liveChannelIds.has(chanId)) {
            report.orphanWorkers.push({
              name: ag.name,
              folder: ag.folder,
              reason: `Discord channel ${chanId} missing`,
            });
          }
        }
      }

      // Auto-delete orphan channels (skip on dry run).
      if (!opts.dryRun) {
        for (const o of report.orphanChannels) {
          try {
            await deleteDiscordChannel(discordCfg, o.id);
            await new Promise((r) => setTimeout(r, 700)); // courtesy rate-limit
          } catch (err) {
            const msg = `delete channel ${o.id} (${o.name}) failed: ${err instanceof Error ? err.message : String(err)}`;
            report.errors.push(msg);
            log.warn('cleanup_workers: ' + msg);
          }
        }
      }
    } catch (err) {
      const msg = `Discord reconciliation failed: ${err instanceof Error ? err.message : String(err)}`;
      report.errors.push(msg);
      log.warn('cleanup_workers: ' + msg);
    }
  } else {
    report.errors.push('Discord not configured (DISCORD_BOT_TOKEN/GUILD_ID missing); skipped channel reconciliation.');
  }

  // 2. Reconcile running containers ↔ active agent_groups.
  const activeFolders = new Set(getActiveAgentGroups().map((g) => g.folder));
  try {
    const out = execSync(`docker ps --filter name=nanoclaw-v2- --format '{{.Names}}'`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const runningNames = out ? out.split('\n') : [];
    for (const name of runningNames) {
      const m = name.match(CONTAINER_NAME_RE);
      if (!m) continue;
      const folder = m[1];
      if (activeFolders.has(folder)) continue;
      report.orphanContainers.push(name);
    }

    if (!opts.dryRun) {
      for (const name of report.orphanContainers) {
        try {
          execSync(`docker rm -f ${name}`, { stdio: ['pipe', 'pipe', 'pipe'] });
        } catch (err) {
          const msg = `kill container ${name} failed: ${err instanceof Error ? err.message : String(err)}`;
          report.errors.push(msg);
          log.warn('cleanup_workers: ' + msg);
        }
      }
    }
  } catch (err) {
    report.errors.push(`docker ps failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return report;
}

function formatReport(report: CleanupReport, dryRun: boolean): string {
  const lines: string[] = [];
  lines.push(dryRun ? '🔍 cleanup_workers (dry-run)' : '🧹 cleanup_workers');

  if (report.orphanChannels.length === 0) {
    lines.push('• Orphan channels: none');
  } else {
    lines.push(`• Orphan channels (${report.orphanChannels.length})${dryRun ? ' — would delete:' : ' — deleted:'}`);
    for (const o of report.orphanChannels) lines.push(`    ${o.id} ${o.name}`);
  }

  if (report.orphanContainers.length === 0) {
    lines.push('• Orphan containers: none');
  } else {
    lines.push(`• Orphan containers (${report.orphanContainers.length})${dryRun ? ' — would kill:' : ' — killed:'}`);
    for (const n of report.orphanContainers) lines.push(`    ${n}`);
  }

  if (report.orphanWorkers.length === 0) {
    lines.push('• Orphan workers: none');
  } else {
    lines.push(
      `• Orphan workers (${report.orphanWorkers.length}) — needs your decision (recreate channel, or destroy_worker to archive):`,
    );
    for (const w of report.orphanWorkers) lines.push(`    ${w.name} (${w.folder}) — ${w.reason}`);
  }

  if (report.errors.length > 0) {
    lines.push(`• Errors (${report.errors.length}):`);
    for (const e of report.errors) lines.push(`    ${e}`);
  }

  return lines.join('\n');
}
