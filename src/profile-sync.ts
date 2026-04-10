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
import { RegisteredGroup, PersonalConfig } from './types.js';

export interface WorkerProfile {
  repos?: { url: string; postClone?: string }[];
  tools?: string[];
  mounts?: {
    hostPath: string;
    containerPath: string;
    readonly: boolean;
  }[];
  ports?: string[];
  claude_md?: string;
  skills_repo?: string;
}

export function loadPersonalConfig(): PersonalConfig {
  const configPath = path.join(
    process.env.HOME || '/root',
    '.config',
    'nanoclaw',
    'config.json',
  );
  if (!fs.existsSync(configPath)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
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

    // Update container_config with current profile mounts and ports
    const newConfig = {
      ...group.containerConfig,
      additionalMounts: profile.mounts || [],
      ports: profile.ports || [],
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
      const postClones = profile.repos
        .filter((r) => r.postClone)
        .map((r) => `${path.basename(r.url, '.git')}:${r.postClone}`);
      if (postClones.length > 0) {
        workerEnv.WORKER_REPO_POST_CLONE = postClones.join('|');
      }
    }
    if (profile.tools?.length) {
      workerEnv.WORKER_TOOLS = profile.tools.join('|');
    }
    if (profile.skills_repo) {
      workerEnv.WORKER_SKILLS_REPO = profile.skills_repo;
    }
    // Preserve per-worker custom env vars that aren't managed by the profile.
    // NANOCLAW_BACKEND/MODEL are injected by container-runner from
    // worker-backends.json — don't persist them here.
    const profileKeys = new Set(Object.keys(workerEnv));
    const skipKeys = new Set(['NANOCLAW_BACKEND', 'NANOCLAW_MODEL']);
    for (const [k, v] of Object.entries(existingEnv)) {
      if (!profileKeys.has(k) && !skipKeys.has(k)) {
        workerEnv[k] = v;
      }
    }
    fs.writeFileSync(
      envPath,
      Object.entries(workerEnv)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n'),
    );

    // Assemble CLAUDE.md from instruction fragments (repo + personal).
    const groupDir = path.join(process.cwd(), 'groups', group.folder);
    if (fs.existsSync(groupDir)) {
      assembleInstructions('worker', groupDir, group.name);
    }
  }

  if (updated > 0) {
    logger.info({ count: updated }, 'Worker profiles synced');
  }
  return updated;
}

/**
 * Sync master CLAUDE.md by assembling from instruction fragments.
 */
export function syncMasterProfile(): void {
  const groups = getAllRegisteredGroups();
  const mainEntry = Object.values(groups).find((g) => g.isMain);
  if (!mainEntry) return;

  const groupDir = path.join(process.cwd(), 'groups', mainEntry.folder);
  fs.mkdirSync(groupDir, { recursive: true });
  assembleInstructions('master', groupDir, mainEntry.name);
}

/**
 * Assemble CLAUDE.md from layered instruction fragments.
 *
 * Concatenates in order:
 *   1. Repo instructions/global.md
 *   2. Repo instructions/{role}.md
 *   3. Personal ~/.config/nanoclaw/instructions/global.md
 *   4. Personal ~/.config/nanoclaw/instructions/{role}.md
 *
 * Only writes if the assembled content differs from the existing file.
 */
export function assembleWorkerInstructions(
  groupDir: string,
  groupName: string,
): void {
  assembleInstructions('worker', groupDir, groupName);
}

function assembleInstructions(
  role: 'master' | 'worker',
  groupDir: string,
  groupName: string,
): void {
  const repoDir = path.join(process.cwd(), 'instructions');
  const personalDir = path.join(
    process.env.HOME || '/root',
    '.config',
    'nanoclaw',
    'instructions',
  );

  const fragments: { label: string; path: string }[] = [
    { label: 'repo/global', path: path.join(repoDir, 'global.md') },
    { label: `repo/${role}`, path: path.join(repoDir, `${role}.md`) },
    { label: 'personal/global', path: path.join(personalDir, 'global.md') },
    { label: `personal/${role}`, path: path.join(personalDir, `${role}.md`) },
  ];

  const sections: string[] = [];
  const included: string[] = [];
  for (const frag of fragments) {
    if (fs.existsSync(frag.path)) {
      sections.push(fs.readFileSync(frag.path, 'utf-8').trimEnd());
      included.push(frag.label);
    }
  }

  if (sections.length === 0) return;

  const assembled = sections.join('\n\n---\n\n') + '\n';
  const dst = path.join(groupDir, 'CLAUDE.md');

  // Only write if content changed (avoids unnecessary mtime updates)
  if (fs.existsSync(dst)) {
    const existing = fs.readFileSync(dst, 'utf-8');
    if (existing === assembled) return;
  }

  fs.writeFileSync(dst, assembled);
  logger.info(
    { group: groupName, role, fragments: included },
    'Assembled CLAUDE.md from instruction fragments',
  );
}
