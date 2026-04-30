/**
 * Profile sync at host startup — re-applies the current worker profile
 * to every active worker's `groups/<folder>/container.json`. Mirrors v1
 * fleet's `syncWorkerProfiles()` (FORK-SPEC §7.4).
 *
 * Why: in v2, the profile is only applied at create-worker / resume-worker
 * time. If the user edits `~/.config/nanoclaw/worker-profiles/default.json`
 * (e.g. adds a repo, bumps a tool version, tightens a mount), existing
 * workers stay on their old config until destroyed and recreated. This
 * loop runs at host start so an edit-then-restart cycle propagates the
 * change to every active worker.
 *
 * Sync rule: clobber `additionalMounts` and `fleetProfile` from the
 * current profile. Other container.json fields (provider, providers,
 * skills, agentProvider) are preserved — those are owned by other
 * subsystems (switch_backend, OneCLI, etc.). The profile owns repos /
 * tools / mounts / env only.
 *
 * Takes effect on the next container spawn for each worker. Does not
 * disturb running containers; they'll see the new config on respawn.
 */
import { getActiveAgentGroups } from '../../db/agent-groups.js';
import { readContainerConfig, writeContainerConfig } from '../../container-config.js';
import { log } from '../../log.js';
import { applyProfileToContainerConfig, loadWorkerProfile } from './worker-profile.js';

export interface ProfileSyncResult {
  updated: string[];
  unchanged: string[];
  errors: Array<{ folder: string; err: string }>;
}

export function syncWorkerProfiles(): ProfileSyncResult {
  const result: ProfileSyncResult = { updated: [], unchanged: [], errors: [] };
  const profile = loadWorkerProfile();

  // No-op when there's no user profile — leaves workers on their
  // create-time config rather than wiping anything. `skills_repo` counts
  // as content too: a profile that only points at a skills repo is still
  // meaningful and should trigger a sync (otherwise edits to which repo
  // skills come from would silently never propagate to existing workers).
  if (
    !profile.repos?.length &&
    !profile.tools?.length &&
    !profile.mounts?.length &&
    !profile.env &&
    !profile.skills_repo
  ) {
    log.info('Profile sync: no profile defined (or empty), skipping');
    return result;
  }

  const workers = getActiveAgentGroups().filter((g) => g.fleet_role === 'worker');

  for (const w of workers) {
    try {
      const cfg = readContainerConfig(w.folder);
      const next = applyProfileToContainerConfig(cfg, profile);

      // Cheap content compare — both sides are JSON-shaped.
      const before = JSON.stringify({
        additionalMounts: cfg.additionalMounts,
        fleetProfile: (cfg as { fleetProfile?: unknown }).fleetProfile,
      });
      const after = JSON.stringify({ additionalMounts: next.additionalMounts, fleetProfile: next.fleetProfile });
      if (before === after) {
        result.unchanged.push(w.folder);
        continue;
      }
      writeContainerConfig(w.folder, next);
      result.updated.push(w.folder);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn('Profile sync failed for worker', { folder: w.folder, err: msg });
      result.errors.push({ folder: w.folder, err: msg });
    }
  }

  log.info('Profile sync complete', {
    updated: result.updated.length,
    unchanged: result.unchanged.length,
    errors: result.errors.length,
  });
  return result;
}
