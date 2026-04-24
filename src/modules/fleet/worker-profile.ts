/**
 * Worker profile loader.
 *
 * Reads the user's personal worker profile from
 *   $NANOCLAW_WORKER_PROFILE_PATH (override), or
 *   ~/.config/nanoclaw/worker-profiles/default.json (default).
 *
 * The profile mirrors the v1 nanoclaw-fleet `worker-profiles/` concept — a
 * small JSON declaring the repos to clone, tools to install, mounts, and
 * skills-repo name that every worker should boot with. Without a profile,
 * v2 workers spawn with an empty workspace.
 *
 * Loader returns an empty profile when the file is missing so fleet still
 * functions on hosts that haven't configured one. `applyProfileToContainerConfig`
 * merges profile fields into a worker's container.json at create_worker time.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { AdditionalMountConfig, ContainerConfig } from '../../container-config.js';
import { log } from '../../log.js';

export interface WorkerProfileRepo {
  /** Git URL (SSH or HTTPS). SSH is rewritten by init.sh if a GitHub token is configured. */
  url: string;
  /** Shell command to run after a successful clone. Runs inside the container. */
  postClone?: string;
}

export interface WorkerProfileMount {
  hostPath: string;
  containerPath: string;
  readonly?: boolean;
}

export interface WorkerProfile {
  name?: string;
  description?: string;
  env?: Record<string, string>;
  repos?: WorkerProfileRepo[];
  tools?: string[];
  mounts?: WorkerProfileMount[];
  ports?: string[];
  /** Name of a cloned repo (from `repos[]`) whose `.claude/skills/` should be symlinked into the worker. */
  skills_repo?: string;
  /** Optional alternative init script name (relative to the profile dir). Defaults to `init.sh`. */
  init_script?: string;
  /** Optional alternative CLAUDE.md template filename (relative to the profile dir). */
  claude_md?: string;
}

export function defaultProfilePath(): string {
  return (
    process.env.NANOCLAW_WORKER_PROFILE_PATH ??
    path.join(os.homedir(), '.config', 'nanoclaw', 'worker-profiles', 'default.json')
  );
}

/**
 * Load the worker profile. Never throws — a missing or malformed file
 * resolves to an empty profile so fleet still works on hosts without
 * a user config.
 */
export function loadWorkerProfile(): WorkerProfile {
  const p = defaultProfilePath();
  if (!fs.existsSync(p)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
    // Drop comment keys (profile examples use `_comment_*` fields).
    for (const k of Object.keys(raw)) {
      if (k.startsWith('_comment')) delete raw[k];
    }
    return raw as WorkerProfile;
  } catch (err) {
    log.warn('worker profile parse failed; using empty profile', { path: p, err: String(err) });
    return {};
  }
}

/**
 * Expand a host path of the form `~/...` to an absolute path. Other
 * paths are passed through untouched. Relative paths are not expanded
 * — profiles are expected to use either absolute or `~`-prefixed paths.
 */
function expandHome(p: string): string {
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  if (p === '~') return os.homedir();
  return p;
}

/**
 * Merge profile fields into a fresh worker's container.json:
 *   - `mounts[]` → `additionalMounts` with host-path expansion.
 *   - `env` → merged into container env block via the runner (not here).
 *   - `skills_repo` / `repos` / `tools` / `init_script` — carried inline
 *     under a top-level `fleetProfile` key so container-side init.sh can
 *     read them from the mounted container.json.
 *
 * Returns the updated config object; does not write to disk.
 */
export function applyProfileToContainerConfig(
  cfg: ContainerConfig,
  profile: WorkerProfile,
): ContainerConfig & { fleetProfile?: WorkerProfile } {
  const mounts: AdditionalMountConfig[] = [...(cfg.additionalMounts ?? [])];
  for (const m of profile.mounts ?? []) {
    mounts.push({
      hostPath: expandHome(m.hostPath),
      containerPath: m.containerPath,
      readonly: m.readonly ?? false,
    });
  }
  // Inline the profile under a reserved key so the container-side init
  // script can pull repos / tools / env without a second config format.
  // This is distinct from additionalMounts because the init steps (clone,
  // tool install) are runtime behaviour, not file mounts.
  return {
    ...cfg,
    additionalMounts: mounts,
    fleetProfile: profile,
  };
}
