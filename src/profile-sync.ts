/**
 * Sync worker profiles: re-read the current profile and update SQLite
 * container_config for all existing non-main workers. This ensures that
 * profile changes (new mounts, tools, etc.) propagate to existing workers
 * on their next container restart — no need to destroy and recreate.
 */

import fs from 'fs';
import path from 'path';

import { getAllRegisteredGroups, setRegisteredGroup } from './db.js';
import { DATA_DIR } from './config.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface WorkerProfile {
  repos?: { url: string }[];
  tools?: string[];
  mounts?: {
    hostPath: string;
    containerPath: string;
    readonly: boolean;
  }[];
  claude_md?: string;
  skills_repo?: string;
}

export function loadWorkerProfile(profileName = 'default'): {
  profile: WorkerProfile;
  profilePath: string;
} {
  const userProfilePath = path.join(
    process.env.HOME || '/root',
    '.config',
    'nanoclaw',
    'worker-profiles',
    `${profileName}.json`,
  );
  const repoProfilePath = path.join(
    process.cwd(),
    'worker-profiles',
    `${profileName}.json`,
  );
  const profilePath = fs.existsSync(userProfilePath)
    ? userProfilePath
    : repoProfilePath;

  if (!fs.existsSync(profilePath)) {
    return { profile: {}, profilePath };
  }

  return {
    profile: JSON.parse(fs.readFileSync(profilePath, 'utf-8')),
    profilePath,
  };
}

/**
 * Sync all non-main workers' container_config with the current profile.
 * Also updates the worker.env file and CLAUDE.md if the profile specifies them.
 * Returns the number of workers updated.
 */
export function syncWorkerProfiles(): number {
  const groups = getAllRegisteredGroups();
  // TODO: if we support multiple profiles, store the profile name per worker
  // in SQLite and load the correct one here instead of always 'default'.
  const { profile, profilePath } = loadWorkerProfile('default');
  let updated = 0;

  for (const [jid, group] of Object.entries(groups)) {
    if (group.isMain) continue;

    // Update container_config with current profile mounts
    const newConfig = {
      ...group.containerConfig,
      additionalMounts: profile.mounts || [],
      disableIdleTimeout: true,
    };

    const oldConfigStr = JSON.stringify(group.containerConfig || {});
    const newConfigStr = JSON.stringify(newConfig);

    if (oldConfigStr !== newConfigStr) {
      const updatedGroup: RegisteredGroup = {
        ...group,
        containerConfig: newConfig,
      };
      setRegisteredGroup(jid, updatedGroup);

      logger.info(
        { worker: group.name, folder: group.folder },
        'Synced worker profile (container_config updated)',
      );
      updated++;
    }

    // Update worker.env (repos, tools, skills).
    // Preserve per-worker settings (e.g., NANOCLAW_BACKEND) that aren't from the profile.
    const envDir = path.join(DATA_DIR, 'sessions', group.folder);
    fs.mkdirSync(envDir, { recursive: true });
    const envPath = path.join(envDir, 'worker.env');

    // Read existing per-worker settings to preserve
    const existingEnv: Record<string, string> = {};
    if (fs.existsSync(envPath)) {
      for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
        const [key, ...rest] = line.split('=');
        if (key?.trim()) existingEnv[key.trim()] = rest.join('=');
      }
    }

    const workerEnv: Record<string, string> = {};
    if (profile.repos?.length) {
      workerEnv.WORKER_REPOS = profile.repos.map((r) => r.url).join('|');
    }
    if (profile.tools?.length) {
      workerEnv.WORKER_TOOLS = profile.tools.join('|');
    }
    if (profile.skills_repo) {
      workerEnv.WORKER_SKILLS_REPO = profile.skills_repo;
    }
    // Preserve per-worker settings not managed by the profile
    if (existingEnv.NANOCLAW_BACKEND) {
      workerEnv.NANOCLAW_BACKEND = existingEnv.NANOCLAW_BACKEND;
    }
    fs.writeFileSync(
      envPath,
      Object.entries(workerEnv)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n'),
    );

    // Update CLAUDE.md if profile specifies one — but only if the profile
    // source is newer than the worker's copy (preserves worker-side edits).
    if (profile.claude_md) {
      const profileDir = path.dirname(profilePath);
      const claudeMdSrc = path.join(profileDir, profile.claude_md);
      const groupDir = path.join(process.cwd(), 'groups', group.folder);
      const claudeMdDst = path.join(groupDir, 'CLAUDE.md');
      if (fs.existsSync(claudeMdSrc) && fs.existsSync(groupDir)) {
        const srcMtime = fs.statSync(claudeMdSrc).mtimeMs;
        const dstMtime = fs.existsSync(claudeMdDst)
          ? fs.statSync(claudeMdDst).mtimeMs
          : 0;
        if (srcMtime > dstMtime) {
          fs.copyFileSync(claudeMdSrc, claudeMdDst);
          logger.info(
            { worker: group.name },
            'Updated worker CLAUDE.md from profile',
          );
        }
      }
    }
  }

  if (updated > 0) {
    logger.info({ count: updated }, 'Worker profiles synced');
  }
  return updated;
}

/**
 * Sync master CLAUDE.md from ~/.config/nanoclaw/master-profile/CLAUDE.md
 * to the master group's workspace. Only overwrites if the source is newer.
 */
export function syncMasterProfile(): void {
  const groups = getAllRegisteredGroups();
  const mainEntry = Object.values(groups).find((g) => g.isMain);
  if (!mainEntry) return;

  const src = path.join(
    process.env.HOME || '/root',
    '.config',
    'nanoclaw',
    'master-profile',
    'CLAUDE.md',
  );
  if (!fs.existsSync(src)) return;

  const groupDir = path.join(process.cwd(), 'groups', mainEntry.folder);
  fs.mkdirSync(groupDir, { recursive: true });
  const dst = path.join(groupDir, 'CLAUDE.md');

  const srcMtime = fs.statSync(src).mtimeMs;
  const dstMtime = fs.existsSync(dst) ? fs.statSync(dst).mtimeMs : 0;

  if (srcMtime > dstMtime) {
    fs.copyFileSync(src, dst);
    logger.info(
      { folder: mainEntry.folder },
      'Synced master CLAUDE.md from ~/.config/nanoclaw/master-profile/',
    );
  }
}
