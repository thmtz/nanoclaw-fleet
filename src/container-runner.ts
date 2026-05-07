/**
 * Container Runner v2
 * Spawns agent containers with session folder + agent group folder mounts.
 * The container runs the v2 agent-runner which polls the session DB.
 */
import { ChildProcess, execSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import {
  CONTAINER_IMAGE,
  CONTAINER_IMAGE_BASE,
  CONTAINER_INSTALL_LABEL,
  DATA_DIR,
  GROUPS_DIR,
  ONECLI_API_KEY,
  ONECLI_URL,
  TIMEZONE,
} from './config.js';
import { resolveCompactWindow } from './compact-window.js';
import { readContainerConfig, writeContainerConfig } from './container-config.js';
import { readEnvFile } from './env.js';
import { CONTAINER_RUNTIME_BIN, hostGatewayArgs, readonlyMountArgs, stopContainer } from './container-runtime.js';
import { composeGroupClaudeMd } from './claude-md-compose.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getDb, hasTable } from './db/connection.js';
import { initGroupFilesystem } from './group-init.js';
import { stopTypingRefresh } from './modules/typing/index.js';
import { log } from './log.js';
import { validateAdditionalMounts } from './modules/mount-security/index.js';
// Provider host-side config barrel — each provider that needs host-side
// container setup self-registers on import.
import './providers/index.js';
import {
  getProviderContainerConfig,
  type ProviderContainerContribution,
  type VolumeMount,
} from './providers/provider-container-registry.js';
import {
  heartbeatPath,
  markContainerRunning,
  markContainerStopped,
  sessionDir,
  writeSessionRouting,
} from './session-manager.js';
import type { AgentGroup, Session } from './types.js';

const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });

/**
 * Read a live OAuth access token from `~/.claude/.credentials.json`. That
 * file is maintained by Claude Code itself — it handles the refreshToken
 * rotation, so reading on each container spawn always gives us a valid
 * token without a manual .env update every hour. Returns `undefined` when
 * the file is absent or malformed so callers can fall through to .env.
 */
function readLiveClaudeOauthToken(): string | undefined {
  const p = path.join(os.homedir(), '.claude', '.credentials.json');
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf-8')) as {
      claudeAiOauth?: { accessToken?: string; expiresAt?: number };
    };
    const t = data.claudeAiOauth?.accessToken;
    const exp = data.claudeAiOauth?.expiresAt;
    if (!t) return undefined;
    // Skip if already expired — caller falls back to .env (or we log and
    // let the SDK return a clearer auth error). 60s safety window so we
    // don't hand out a token about to die mid-request.
    if (exp && exp < Date.now() + 60_000) return undefined;
    return t;
  } catch {
    return undefined;
  }
}

/**
 * Pick which OAuth token to bake into the container env, with v1 parity:
 * `.env.CLAUDE_CODE_OAUTH_TOKEN` (long-lived `claude setup-token`, valid for
 * months) wins over `~/.claude/.credentials.json` (Claude Code's
 * auto-rotating session token, ~1hr lifetime). The container env is frozen
 * at spawn time — never refreshed — so freezing in the rotating token
 * guarantees a 401 on the next rotation. v1 didn't hit this because v1
 * ran a credential proxy that read `.env` per request; in v2 OneCLI is
 * meant to fill that role, but when OneCLI isn't applied this fallback
 * freezes the token, so we must pick the long-lived source.
 *
 * Exported so the precedence is locked down by a unit test
 * (`container-runner.test.ts`). Bare-`undefined` inputs return
 * `{ token: undefined, source: 'none' }` so callers can `if (token)` cleanly.
 */
export function pickOauthToken(input: { envToken: string | undefined; liveToken: string | undefined }): {
  token: string | undefined;
  source: '.env' | 'credentials.json' | 'none';
} {
  if (input.envToken) return { token: input.envToken, source: '.env' };
  if (input.liveToken) return { token: input.liveToken, source: 'credentials.json' };
  return { token: undefined, source: 'none' };
}

/**
 * Read the user's `container_credentials` list from
 * `~/.config/nanoclaw/config.json`. Each entry maps a file path to an env
 * var name that gets injected into every spawned container.
 *
 * Returns `[]` when the config file is missing, malformed, or the field
 * is absent — credential injection is opt-in. Bad entries (missing
 * fields) are skipped with a warning rather than throwing.
 *
 * Exported only for tests — read at every spawn so rotations + new
 * entries take effect without a host restart.
 */
export function readContainerCredentials(): Array<{ env: string; path: string }> {
  const cfgPath = path.join(os.homedir(), '.config', 'nanoclaw', 'config.json');
  if (!fs.existsSync(cfgPath)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as {
      container_credentials?: Array<{ env?: string; path?: string }>;
    };
    const list = raw.container_credentials ?? [];
    const out: Array<{ env: string; path: string }> = [];
    for (const entry of list) {
      if (!entry?.env || !entry?.path) {
        log.warn('container_credentials entry missing env or path — skipping', { entry });
        continue;
      }
      out.push({ env: entry.env, path: entry.path });
    }
    return out;
  } catch (err) {
    log.warn('container_credentials parse failed', { cfgPath, err: String(err) });
    return [];
  }
}

/** Active containers tracked by session ID. */
const activeContainers = new Map<string, { process: ChildProcess; containerName: string }>();

/**
 * Timestamp (ms since epoch) of the last container exit per session. Used
 * by wakeContainer to throttle spawns when a container exits quickly
 * (crash loop). Without this, a container that dies on an internal error
 * (e.g. UNIQUE seq race on its own writes) plus a host-sweep that keeps
 * seeing due messages will spawn a fresh container on every tick —
 * enough of them in a few seconds to OOM the host.
 */
const lastExitMs = new Map<string, number>();
const MIN_RESPAWN_INTERVAL_MS = 5000;

/**
 * In-flight wake promises, keyed by session id. Deduplicates concurrent
 * `wakeContainer` calls while the first spawn is still mid-setup (async
 * buildContainerArgs, OneCLI gateway apply, etc.) — otherwise a second
 * wake in that window passes the `activeContainers.has` check and spawns
 * a duplicate container against the same session directory, producing
 * racy double-replies.
 */
const wakePromises = new Map<string, Promise<void>>();

export function getActiveContainerCount(): number {
  return activeContainers.size;
}

export function isContainerRunning(sessionId: string): boolean {
  return activeContainers.has(sessionId);
}

/**
 * Wake up a container for a session. If already running or mid-spawn, no-op
 * (the in-flight wake promise is reused).
 *
 * The container runs the v2 agent-runner which polls the session DB.
 */
export function wakeContainer(session: Session): Promise<void> {
  if (activeContainers.has(session.id)) {
    log.debug('Container already running', { sessionId: session.id });
    return Promise.resolve();
  }
  const existing = wakePromises.get(session.id);
  if (existing) {
    log.debug('Container wake already in-flight — joining existing promise', { sessionId: session.id });
    return existing;
  }
  // Crash-loop guard: refuse to respawn within MIN_RESPAWN_INTERVAL_MS of
  // the last exit. host-sweep checks dueCount every tick and would
  // otherwise spin up containers faster than they can fail; if a container
  // is dying on a deterministic error, a rapid loop accomplishes nothing
  // and can eat all system memory in seconds.
  const lastExit = lastExitMs.get(session.id);
  if (lastExit && Date.now() - lastExit < MIN_RESPAWN_INTERVAL_MS) {
    log.debug('Container exited recently, deferring wake', {
      sessionId: session.id,
      msSinceExit: Date.now() - lastExit,
    });
    return Promise.resolve();
  }
  const promise = spawnContainer(session).finally(() => {
    wakePromises.delete(session.id);
  });
  wakePromises.set(session.id, promise);
  return promise;
}

async function spawnContainer(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    log.error('Agent group not found', { agentGroupId: session.agent_group_id });
    return;
  }

  // Refresh the destination map and default reply routing so any admin
  // changes take effect on wake. Destinations come from the agent-to-agent
  // module — skip when the module isn't installed (table absent).
  if (hasTable(getDb(), 'agent_destinations')) {
    const { writeDestinations } = await import('./modules/agent-to-agent/write-destinations.js');
    writeDestinations(agentGroup.id, session.id);
  }
  writeSessionRouting(agentGroup.id, session.id);

  // Read container config once — threaded through provider resolution,
  // buildMounts, and buildContainerArgs so we don't re-read the file.
  const containerConfig = readContainerConfig(agentGroup.folder);

  // Ensure container.json has the agent group identity fields the runner needs.
  // Written at spawn time so the runner can read them from the RO mount.
  ensureRuntimeFields(containerConfig, agentGroup);

  // Resolve the effective provider + any host-side contribution it declares
  // (extra mounts, env passthrough). Computed once and threaded through both
  // buildMounts and buildContainerArgs so side effects (mkdir, etc.) fire once.
  const { provider, contribution } = resolveProviderContribution(session, agentGroup, containerConfig);

  const mounts = buildMounts(agentGroup, session, containerConfig, contribution);
  const containerName = `nanoclaw-v2-${agentGroup.folder}-${Date.now()}`;
  // OneCLI agent identifier is always the agent group id — stable across
  // sessions and reversible via getAgentGroup() for approval routing.
  const agentIdentifier = agentGroup.id;
  const args = await buildContainerArgs(
    mounts,
    containerName,
    agentGroup,
    containerConfig,
    provider,
    contribution,
    session.id,
    agentIdentifier,
  );

  log.info('Spawning container', { sessionId: session.id, agentGroup: agentGroup.name, containerName });

  // Clear any orphan heartbeat from a previous container instance — the
  // sweep's ceiling check treats a missing file as "fresh spawn, give grace"
  // (host-sweep.ts line 87). Without this, the stale mtime can trigger an
  // immediate kill before the new container touches the file itself.
  fs.rmSync(heartbeatPath(agentGroup.id, session.id), { force: true });

  const container = spawn(CONTAINER_RUNTIME_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  activeContainers.set(session.id, { process: container, containerName });
  markContainerRunning(session.id);

  // Log stderr
  container.stderr?.on('data', (data) => {
    for (const line of data.toString().trim().split('\n')) {
      if (line) log.debug(line, { container: agentGroup.folder });
    }
  });

  // stdout is unused in v2 (all IO is via session DB)
  container.stdout?.on('data', () => {});

  // No host-side idle timeout. Stale/stuck detection is driven by the host
  // sweep reading heartbeat mtime + processing_ack claim age + container_state
  // (see src/host-sweep.ts). This avoids killing long-running legitimate work
  // on a wall-clock timer.

  container.on('close', (code) => {
    activeContainers.delete(session.id);
    lastExitMs.set(session.id, Date.now());
    markContainerStopped(session.id);
    stopTypingRefresh(session.id);
    log.info('Container exited', { sessionId: session.id, code, containerName });
  });

  container.on('error', (err) => {
    activeContainers.delete(session.id);
    lastExitMs.set(session.id, Date.now());
    markContainerStopped(session.id);
    stopTypingRefresh(session.id);
    log.error('Container spawn error', { sessionId: session.id, err });
  });
}

/** Kill a container for a session. */
export function killContainer(sessionId: string, reason: string): void {
  const entry = activeContainers.get(sessionId);
  if (!entry) return;

  log.info('Killing container', { sessionId, reason, containerName: entry.containerName });
  try {
    stopContainer(entry.containerName);
  } catch {
    entry.process.kill('SIGKILL');
  }
}

function resolveProviderContribution(
  session: Session,
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
): { provider: string; contribution: ProviderContainerContribution } {
  const provider = (containerConfig.provider || 'claude').toLowerCase();
  const fn = getProviderContainerConfig(provider);
  const contribution = fn
    ? fn({
        sessionDir: sessionDir(agentGroup.id, session.id),
        agentGroupId: agentGroup.id,
        agentGroupFolder: agentGroup.folder,
        hostEnv: process.env,
      })
    : {};
  return { provider, contribution };
}

function buildMounts(
  agentGroup: AgentGroup,
  session: Session,
  containerConfig: import('./container-config.js').ContainerConfig,
  providerContribution: ProviderContainerContribution,
): VolumeMount[] {
  const projectRoot = process.cwd();

  // Per-group filesystem state lives forever after first creation. Init is
  // idempotent: it only writes paths that don't already exist, so this call
  // is a no-op for groups that have spawned before.
  initGroupFilesystem(agentGroup);

  // Sync skill symlinks based on container.json selection before mounting.
  const claudeDir = path.join(DATA_DIR, 'v2-sessions', agentGroup.id, '.claude-shared');
  syncSkillSymlinks(claudeDir, containerConfig);

  // Compose CLAUDE.md fresh every spawn from the shared base, enabled skill
  // fragments, and MCP server instructions. See `claude-md-compose.ts`.
  composeGroupClaudeMd(agentGroup);

  const mounts: VolumeMount[] = [];
  const sessDir = sessionDir(agentGroup.id, session.id);
  const groupDir = path.resolve(GROUPS_DIR, agentGroup.folder);

  // Session folder at /workspace (contains inbound.db, outbound.db, outbox/, .claude/)
  mounts.push({ hostPath: sessDir, containerPath: '/workspace', readonly: false });

  // Agent group folder at /workspace/agent (RW for working files + CLAUDE.local.md)
  mounts.push({ hostPath: groupDir, containerPath: '/workspace/agent', readonly: false });

  // container.json — nested RO mount on top of RW group dir so the agent
  // can read its config but cannot modify it.
  const containerJsonPath = path.join(groupDir, 'container.json');
  if (fs.existsSync(containerJsonPath)) {
    mounts.push({ hostPath: containerJsonPath, containerPath: '/workspace/agent/container.json', readonly: true });
  }

  // Composer-managed CLAUDE.md artifacts — nested RO mounts. These are
  // regenerated from the shared base + fragments on every spawn; any
  // agent-side writes would be clobbered, so enforce read-only. Only
  // CLAUDE.local.md (per-group memory) remains RW via the group-dir mount.
  // `.claude-shared.md` is a symlink whose target (`/app/CLAUDE.md`) is
  // already RO-mounted, so writes through it fail regardless — no need for
  // a nested mount there.
  const composedClaudeMd = path.join(groupDir, 'CLAUDE.md');
  if (fs.existsSync(composedClaudeMd)) {
    mounts.push({ hostPath: composedClaudeMd, containerPath: '/workspace/agent/CLAUDE.md', readonly: true });
  }
  const fragmentsDir = path.join(groupDir, '.claude-fragments');
  if (fs.existsSync(fragmentsDir)) {
    mounts.push({ hostPath: fragmentsDir, containerPath: '/workspace/agent/.claude-fragments', readonly: true });
  }

  // Global memory directory — always read-only.
  const globalDir = path.join(GROUPS_DIR, 'global');
  if (fs.existsSync(globalDir)) {
    mounts.push({ hostPath: globalDir, containerPath: '/workspace/global', readonly: true });
  }

  // Shared CLAUDE.md — read-only, imported by the composed entry point via
  // the `.claude-shared.md` symlink inside the group dir.
  const sharedClaudeMd = path.join(process.cwd(), 'container', 'CLAUDE.md');
  if (fs.existsSync(sharedClaudeMd)) {
    mounts.push({ hostPath: sharedClaudeMd, containerPath: '/app/CLAUDE.md', readonly: true });
  }

  // Per-group .claude-shared at /home/node/.claude (Claude state, settings,
  // skill symlinks)
  mounts.push({ hostPath: claudeDir, containerPath: '/home/node/.claude', readonly: false });

  // Shared agent-runner source — read-only, same code for all groups.
  const agentRunnerSrc = path.join(projectRoot, 'container', 'agent-runner', 'src');
  mounts.push({ hostPath: agentRunnerSrc, containerPath: '/app/src', readonly: true });

  // Worker init script — clones profile repos + runs tool installs before
  // agent-runner starts. Master has no fleetProfile so it's a no-op there,
  // but mounting uniformly keeps the base image honest.
  const workerInitSrc = path.join(projectRoot, 'container', 'worker-init.sh');
  if (fs.existsSync(workerInitSrc)) {
    mounts.push({ hostPath: workerInitSrc, containerPath: '/app/worker-init.sh', readonly: true });
  }

  // Shared skills — read-only, symlinks in .claude-shared/skills/ point here.
  const skillsSrc = path.join(projectRoot, 'container', 'skills');
  if (fs.existsSync(skillsSrc)) {
    mounts.push({ hostPath: skillsSrc, containerPath: '/app/skills', readonly: true });
  }

  // Additional mounts from container config
  if (containerConfig.additionalMounts && containerConfig.additionalMounts.length > 0) {
    const validated = validateAdditionalMounts(containerConfig.additionalMounts, agentGroup.name);
    mounts.push(...validated);
  }

  // Provider-contributed mounts (e.g. opencode-xdg)
  if (providerContribution.mounts) {
    mounts.push(...providerContribution.mounts);
  }

  // Tailscale socket — lets containers run `tailscale ssh` and other CLI ops
  // through the host's tailscaled. The container's tailscale binary (installed
  // by container/Dockerfile) talks to this socket directly. Optional — if
  // tailscaled isn't running on the host, the mount is skipped and workers
  // simply lack Tailscale access.
  const tailscaleSock = '/var/run/tailscale/tailscaled.sock';
  if (fs.existsSync(tailscaleSock)) {
    mounts.push({ hostPath: tailscaleSock, containerPath: tailscaleSock, readonly: false });
  }

  // Pre-create host-side mount-point dirs for any mount nested under
  // /workspace/. Without this, Docker's runc creates them as root when
  // setting up the bind mounts (the daemon runs in the host namespace), and
  // a later `purgeArchivedWorker` (`create_worker --fresh` on a recreated
  // name) hits EACCES trying to rmdir them. Pre-creating as the host user
  // means Docker reuses our dirs and ownership stays correct.
  precreateNestedMountTargets(mounts, sessDir);

  return mounts;
}

export function precreateNestedMountTargets(mounts: VolumeMount[], sessDir: string): void {
  const prefix = '/workspace/';
  for (const mount of mounts) {
    if (!mount.containerPath.startsWith(prefix) || mount.containerPath === '/workspace') continue;
    let hostStat: fs.Stats;
    try {
      hostStat = fs.statSync(mount.hostPath);
    } catch {
      continue;
    }
    if (!hostStat.isDirectory()) continue;
    const rel = mount.containerPath.slice(prefix.length);
    const target = path.join(sessDir, rel);
    fs.mkdirSync(target, { recursive: true });
  }
}

/**
 * Sync skill symlinks in .claude-shared/skills/ to match the container.json
 * selection. Each symlink points to a container path (/app/skills/<name>)
 * so it's dangling on the host but valid inside the container.
 */
function syncSkillSymlinks(claudeDir: string, containerConfig: import('./container-config.js').ContainerConfig): void {
  const skillsDir = path.join(claudeDir, 'skills');
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
  }

  // Determine desired skill set
  const projectRoot = process.cwd();
  const sharedSkillsDir = path.join(projectRoot, 'container', 'skills');
  let desired: string[];
  if (containerConfig.skills === 'all') {
    // Recompute from shared dir — newly-added upstream skills appear automatically
    desired = fs.existsSync(sharedSkillsDir)
      ? fs.readdirSync(sharedSkillsDir).filter((e) => {
          try {
            return fs.statSync(path.join(sharedSkillsDir, e)).isDirectory();
          } catch {
            return false;
          }
        })
      : [];
  } else {
    desired = containerConfig.skills;
  }

  const desiredSet = new Set(desired);

  // Remove symlinks not in the desired set
  for (const entry of fs.readdirSync(skillsDir)) {
    const entryPath = path.join(skillsDir, entry);
    let isSymlink = false;
    try {
      isSymlink = fs.lstatSync(entryPath).isSymbolicLink();
    } catch {
      continue;
    }
    if (isSymlink && !desiredSet.has(entry)) {
      fs.unlinkSync(entryPath);
    }
  }

  // Create symlinks for desired skills (container path targets)
  for (const skill of desired) {
    const linkPath = path.join(skillsDir, skill);
    let exists = false;
    try {
      fs.lstatSync(linkPath);
      exists = true;
    } catch {
      /* missing */
    }
    if (!exists) {
      fs.symlinkSync(`/app/skills/${skill}`, linkPath);
    }
  }
}

/**
 * Ensure container.json has the runtime identity fields the runner needs.
 * Written at spawn time so they're always current even if the DB values
 * change (e.g. group rename). Only writes if values differ to avoid
 * unnecessary file churn.
 */
function ensureRuntimeFields(
  containerConfig: import('./container-config.js').ContainerConfig,
  agentGroup: AgentGroup,
): void {
  let dirty = false;
  if (containerConfig.agentGroupId !== agentGroup.id) {
    containerConfig.agentGroupId = agentGroup.id;
    dirty = true;
  }
  if (containerConfig.groupName !== agentGroup.name) {
    containerConfig.groupName = agentGroup.name;
    dirty = true;
  }
  if (containerConfig.assistantName !== agentGroup.name) {
    containerConfig.assistantName = agentGroup.name;
    dirty = true;
  }
  if (dirty) {
    writeContainerConfig(agentGroup.folder, containerConfig);
  }
}

async function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
  provider: string,
  providerContribution: ProviderContainerContribution,
  sessionId: string,
  agentIdentifier?: string,
): Promise<string[]> {
  const args: string[] = ['run', '--rm', '--name', containerName, '--label', CONTAINER_INSTALL_LABEL];

  // Tailscale DNS — when the host runs tailscaled, MagicDNS lets the
  // container resolve hosts like `prod-db-01` via 100.100.100.100. The
  // public fallback (1.1.1.1) keeps github/pypi/etc working. Without
  // these, `tailscale ssh ops@host` resolves the wrong way and fails.
  if (fs.existsSync('/var/run/tailscale/tailscaled.sock')) {
    args.push('--dns', '100.100.100.100', '--dns', '1.1.1.1');
  }

  // Environment — only vars read by code we don't own.
  // Everything NanoClaw-specific is in container.json (read by runner at startup).
  args.push('-e', `TZ=${TIMEZONE}`);

  // Fleet module: when the agent group is flagged as master, expose the
  // fleet MCP tools (create_worker, destroy_worker, etc.) inside the
  // container. Worker / plain-v2 groups don't load those tools.
  if (agentGroup.fleet_role) {
    args.push('-e', `NANOCLAW_FLEET_ROLE=${agentGroup.fleet_role}`);
  }

  // Outbound-wake URL: container fires a best-effort POST to this after
  // writing a messages_out row, so the host delivers immediately instead
  // of waiting for the next 1s poll tick. Session-scoped URL lets the
  // server skip an extra lookup.
  const wakePort = parseInt(process.env.OUTBOUND_WAKE_PORT || '3100', 10);
  args.push('-e', `NANOCLAW_WAKE_URL=http://host.docker.internal:${wakePort}/wake/${sessionId}`);

  // Expose the resolved provider name to the container so the turn audit
  // log can stamp each entry's `backend` field. The SDK itself uses
  // ANTHROPIC_BASE_URL / ANTHROPIC_MODEL already; this is purely for
  // logging attribution.
  args.push('-e', `NANOCLAW_PROVIDER=${provider}`);

  // Personal `container_credentials`: file→env injection for tokens the
  // user wants every container to have. Lets users add tokens (GH_TOKEN,
  // BETTERSTACK_API_TOKEN, FIREWORKS_API_KEY, …) by editing their
  // `~/.config/nanoclaw/config.json` instead of adding code here.
  //
  // GitHub auth note: the canonical config for `gh` and friends is
  //   { "env": "GH_TOKEN", "path": "~/.config/github/pat" },
  //   { "env": "GITHUB_TOKEN", "path": "~/.config/github/pat" }
  // worker-init.sh uses these for HTTPS clone rewrites too; no separate
  // NanoClaw-specific env var. Earlier installs had NANOCLAW_GITHUB_TOKEN_PATH
  // in .env wired to a dedicated code path here — removed; the generic
  // mechanism covers it.
  //
  // Schema:
  //   { "container_credentials": [ { "env": "NAME", "path": "~/.config/.../api_key" }, ... ] }
  //
  // Each entry is read at spawn time so rotated values take effect on
  // next container restart. Missing files skip silently. Empty file
  // contents (whitespace-only) skip too — avoids injecting a blank
  // env var that the consuming tool would treat as "set."
  for (const cred of readContainerCredentials()) {
    const resolved = cred.path.startsWith('~/') ? path.join(process.env.HOME ?? '', cred.path.slice(2)) : cred.path;
    if (!fs.existsSync(resolved)) continue;
    try {
      const value = fs.readFileSync(resolved, 'utf-8').trim();
      if (value) args.push('-e', `${cred.env}=${value}`);
    } catch (err) {
      log.warn('container_credentials read failed', { env: cred.env, path: resolved, err: String(err) });
    }
  }

  // Provider-contributed env vars (e.g. XDG_DATA_HOME, OPENCODE_*, NO_PROXY).
  if (providerContribution.env) {
    for (const [key, value] of Object.entries(providerContribution.env)) {
      args.push('-e', `${key}=${value}`);
    }
  }

  // Auto-compact window — resolve from the worker's model so 1M-context
  // Claude / shorter-context Neuralwatt models compact at sensible
  // thresholds instead of a one-size-fits-all 165k. See compact-window.ts.
  const modelForCompact = providerContribution.env?.ANTHROPIC_MODEL;
  const compactWindow = resolveCompactWindow(modelForCompact);
  args.push('-e', `CLAUDE_CODE_AUTO_COMPACT_WINDOW=${compactWindow}`);
  log.info('Resolved auto-compact window', { containerName, model: modelForCompact, window: compactWindow });

  // OneCLI gateway — injects HTTPS_PROXY + certs so container API calls
  // are routed through the agent vault for credential injection.
  let onecliApplied = false;
  try {
    if (agentIdentifier) {
      await onecli.ensureAgent({ name: agentGroup.name, identifier: agentIdentifier });
    }
    onecliApplied = await onecli.applyContainerConfig(args, { addHostMapping: false, agent: agentIdentifier });
    if (onecliApplied) {
      log.info('OneCLI gateway applied', { containerName });
    } else {
      log.warn('OneCLI gateway not applied — will try env credential fallback', { containerName });
    }
  } catch (err) {
    log.warn('OneCLI gateway error — will try env credential fallback', { containerName, err });
  }

  // Fallback: when OneCLI is unavailable, pass Anthropic creds straight through
  // from .env. Intended for prototype / local use. Production installs should
  // rely on OneCLI (key rotation, per-agent policy). Reads on every spawn so
  // token changes in .env take effect without a service restart.
  //
  // Precedence: .env wins over host shell. Shell ANTHROPIC_API_KEY leaking
  // from the operator's profile has bitten us — an exhausted key from another
  // project silently took over. When .env sets CLAUDE_CODE_OAUTH_TOKEN, we
  // skip injecting ANTHROPIC_API_KEY entirely, since Claude SDK prefers the
  // API key when both are present and that would defeat a Max subscription.
  if (!onecliApplied) {
    const fallbackEnv = readEnvFile([
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
    ]);
    const liveOauth = readLiveClaudeOauthToken();
    const { token: oauth, source: oauthSource } = pickOauthToken({
      envToken: fallbackEnv.CLAUDE_CODE_OAUTH_TOKEN,
      liveToken: liveOauth,
    });
    const preferOauth = !!oauth;
    for (const key of [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
    ] as const) {
      if (preferOauth && key === 'ANTHROPIC_API_KEY') continue;
      if (key === 'CLAUDE_CODE_OAUTH_TOKEN') {
        if (oauth) args.push('-e', `CLAUDE_CODE_OAUTH_TOKEN=${oauth}`);
        continue;
      }
      const val = fallbackEnv[key] ?? process.env[key];
      if (val) args.push('-e', `${key}=${val}`);
    }
    log.info('Env credential fallback applied', {
      containerName,
      preferOauth,
      oauthSource,
    });
  }

  // Host gateway
  args.push(...hostGatewayArgs());

  // User mapping
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  // Volume mounts
  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  // Override entrypoint: run v2 entry point directly via Bun (no tsc, no stdin).
  args.push('--entrypoint', 'bash');

  // Use per-agent-group image if one has been built, otherwise base image
  const imageTag = containerConfig.imageTag || CONTAINER_IMAGE;
  args.push(imageTag);

  // Worker-init runs on fleet workers only — the master container has no
  // fleetProfile (it orchestrates, doesn't clone repos). worker-init.sh
  // is mounted read-only into /app from container/agent-runner — see
  // the RO mount for /app/src, which already covers the parent. Added
  // explicitly here as a sibling RO mount so a base-image refresh
  // doesn't require rebuild cycles.
  const isWorker = agentGroup.fleet_role === 'worker';
  if (isWorker) {
    args.push('-c', 'bash /app/worker-init.sh; exec bun run /app/src/index.ts');
  } else {
    args.push('-c', 'exec bun run /app/src/index.ts');
  }

  return args;
}

/** Build a per-agent-group Docker image with custom packages. */
export async function buildAgentGroupImage(agentGroupId: string): Promise<void> {
  const agentGroup = getAgentGroup(agentGroupId);
  if (!agentGroup) throw new Error('Agent group not found');

  const containerConfig = readContainerConfig(agentGroup.folder);
  const aptPackages = containerConfig.packages.apt;
  const npmPackages = containerConfig.packages.npm;

  if (aptPackages.length === 0 && npmPackages.length === 0) {
    throw new Error('No packages to install. Use install_packages first.');
  }

  let dockerfile = `FROM ${CONTAINER_IMAGE}\nUSER root\n`;
  if (aptPackages.length > 0) {
    dockerfile += `RUN apt-get update && apt-get install -y ${aptPackages.join(' ')} && rm -rf /var/lib/apt/lists/*\n`;
  }
  if (npmPackages.length > 0) {
    // pnpm skips build scripts unless packages are allowlisted. Append each
    // to /root/.npmrc (base image sets it up for agent-browser) so packages
    // with postinstall — e.g. playwright, puppeteer, native addons — don't
    // install silently broken.
    const allowlist = npmPackages.map((p) => `echo 'only-built-dependencies[]=${p}' >> /root/.npmrc`).join(' && ');
    dockerfile += `RUN ${allowlist} && pnpm install -g ${npmPackages.join(' ')}\n`;
  }
  dockerfile += 'USER node\n';

  const imageTag = `${CONTAINER_IMAGE_BASE}:${agentGroupId}`;

  log.info('Building per-agent-group image', { agentGroupId, imageTag, apt: aptPackages, npm: npmPackages });

  // Write Dockerfile to temp file and build
  const tmpDockerfile = path.join(DATA_DIR, `Dockerfile.${agentGroupId}`);
  fs.writeFileSync(tmpDockerfile, dockerfile);
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} build -t ${imageTag} -f ${tmpDockerfile} .`, {
      cwd: DATA_DIR,
      stdio: 'pipe',
      timeout: 300_000,
    });
  } finally {
    fs.unlinkSync(tmpDockerfile);
  }

  // Store the image tag in groups/<folder>/container.json
  containerConfig.imageTag = imageTag;
  writeContainerConfig(agentGroup.folder, containerConfig);

  log.info('Per-agent-group image built', { agentGroupId, imageTag });
}
