/**
 * `fork_worker` delivery-action handler.
 *
 * Clones an existing worker into a new agent group with its own Discord
 * channel, while inheriting the source's workspace files, prior message
 * history, container.json (backend/model), and CLAUDE.local.md memory. The
 * fork starts a FRESH SDK conversation — the inherited inbound/outbound
 * history gives it human-visible context, but the Anthropic-side session
 * id from the source is dropped so source and fork can run independently
 * without corrupting each other's server-side conversation.
 *
 * What's cloned:
 *   - groups/<source>/   →  groups/<fork>/         (workspace, CLAUDE.local.md,
 *                                                   container.json, profile)
 *   - data/v2-sessions/<src-ag>/.claude-shared/  →  fork's .claude-shared
 *   - For each source session:
 *       inbound.db / outbound.db (sqlite online-backup, consistent across
 *         a live writer — no need to stop the source container)
 *       turns.jsonl, inbox/, conversations/, etc.
 *
 * What's NOT cloned:
 *   - Discord channel — fork gets a new one (otherwise messages route
 *     ambiguously between source and fork)
 *   - SDK session id — explicitly cleared from fork's outbound.db so the
 *     fork's first turn boots a fresh server-side conversation
 *
 * Caller must be the master agent (fleet_role='master').
 *
 * Reuses lifecycle helpers from create-worker.ts where possible.
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { DATA_DIR, GROUPS_DIR } from '../../config.js';
import { createAgentGroup, getAgentGroup, getAgentGroupByFolder } from '../../db/agent-groups.js';
import { createSession, getSessionsByAgentGroup } from '../../db/sessions.js';
import { initGroupFilesystem } from '../../group-init.js';
import { sessionDir } from '../../session-manager.js';
import { log } from '../../log.js';
import type { AgentGroup, Session } from '../../types.js';
import {
  createDestination,
  getDestinationByName,
  normalizeName as normalizeDestName,
} from '../agent-to-agent/db/agent-destinations.js';
import { writeDestinations } from '../agent-to-agent/write-destinations.js';
import { logWorkerEvent } from './events.js';
import { generateId, normalizeName, notifyAgent, setFleetBackend } from './lib.js';
import { provisionDiscordChannel } from './provision.js';

function isSafeFolderName(folder: string): boolean {
  const r = path.resolve(path.join(GROUPS_DIR, folder));
  const root = path.resolve(GROUPS_DIR);
  return r.startsWith(root + path.sep);
}

/**
 * SQLite online-backup of source → dest. Safe to call while the source DB
 * has an open writer (the agent container's poll loop). The backup API
 * holds a brief shared lock and produces a consistent snapshot — no need
 * to stop the source container or drain in-flight writes.
 *
 * better-sqlite3's `db.backup()` is async (returns a Promise resolving
 * once the backup is complete). Earlier versions of this code called it
 * without `await` and ended up with empty 0-byte DBs because the
 * function returned before the copy finished and the source DB was
 * closed too early — caught during fork e2e.
 */
async function backupSqlite(sourcePath: string, destPath: string): Promise<void> {
  if (!fs.existsSync(sourcePath)) return;
  const src = new Database(sourcePath, { readonly: true });
  try {
    await src.backup(destPath);
  } finally {
    src.close();
  }
}

function clearSdkSessionId(outboundDbPath: string): void {
  if (!fs.existsSync(outboundDbPath)) return;
  const db = new Database(outboundDbPath);
  try {
    db.prepare("DELETE FROM session_state WHERE key = 'sdk_session_id'").run();
  } catch {
    // session_state table may be absent on a brand-new outbound.db; ignore.
  } finally {
    db.close();
  }
}

/**
 * Use lstat-based existence so broken symlinks (e.g. `.claude-shared.md`
 * which targets `/app/CLAUDE.md` only valid inside a container) count as
 * existing. fs.existsSync follows symlinks and would mis-report a broken
 * link as "doesn't exist," causing us to try to overwrite it.
 */
function lExistsSync(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Deep copy that preserves symlinks as symlinks (without following the
 * target) and skips broken links + uncopyable entries with a warning.
 * Built for `.claude-shared` which mixes real files + container-only
 * symlinks; cpSync's recursive mode trips on the broken-link entries.
 */
function copyOverlayDeep(srcDir: string, dstDir: string): void {
  if (!lExistsSync(srcDir)) return;
  for (const entry of fs.readdirSync(srcDir)) {
    const srcEntry = path.join(srcDir, entry);
    const dstEntry = path.join(dstDir, entry);
    let st;
    try {
      st = fs.lstatSync(srcEntry);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      try {
        const target = fs.readlinkSync(srcEntry);
        if (!lExistsSync(dstEntry)) fs.symlinkSync(target, dstEntry);
      } catch (err) {
        log.warn('fork_worker: skipping uncopyable symlink', { srcEntry, err: String(err) });
      }
      continue;
    }
    if (st.isDirectory()) {
      fs.mkdirSync(dstEntry, { recursive: true });
      copyOverlayDeep(srcEntry, dstEntry);
      continue;
    }
    if (st.isFile()) {
      try {
        if (!lExistsSync(dstEntry)) fs.copyFileSync(srcEntry, dstEntry);
      } catch (err) {
        log.warn('fork_worker: skipping uncopyable file', { srcEntry, err: String(err) });
      }
      continue;
    }
    // Sockets, fifos, devices — skip silently.
  }
}

function copyOverlay(srcDir: string, dstDir: string, skip: ReadonlySet<string>): void {
  if (!lExistsSync(srcDir)) return;
  for (const entry of fs.readdirSync(srcDir)) {
    if (skip.has(entry)) continue;
    const srcEntry = path.join(srcDir, entry);
    const dstEntry = path.join(dstDir, entry);
    if (lExistsSync(dstEntry)) continue;
    // Skip broken symlinks at the source. The composer scaffold (e.g.
    // `.claude-shared.md` → `/app/CLAUDE.md`, `skills/<name>` → packaged
    // skill paths) only resolves inside the container. The fork's
    // initGroupFilesystem + composeGroupClaudeMd recreate them at spawn,
    // so we don't need to copy them; trying to would break cpSync on
    // host (it follows the link to validate and the target is missing).
    try {
      const st = fs.lstatSync(srcEntry);
      if (st.isSymbolicLink()) {
        // Always re-link rather than copy the link's target. If the link
        // is broken on host, just skip — composer will recreate.
        if (!fs.existsSync(srcEntry)) continue;
        const linkTarget = fs.readlinkSync(srcEntry);
        fs.symlinkSync(linkTarget, dstEntry);
        continue;
      }
    } catch {
      continue;
    }
    try {
      fs.cpSync(srcEntry, dstEntry, { recursive: true, dereference: false });
    } catch (err) {
      log.warn('fork_worker: skipping uncopyable entry', { srcEntry, err: String(err) });
    }
  }
}

function wireBidirectionalDestinations(
  master: AgentGroup,
  forkId: string,
  forkLocalName: string,
  nowIso: string,
): void {
  createDestination({
    agent_group_id: master.id,
    local_name: forkLocalName,
    target_type: 'agent',
    target_id: forkId,
    created_at: nowIso,
  });
  let parentName = normalizeDestName(master.folder);
  let suffix = 2;
  while (getDestinationByName(forkId, parentName)) {
    parentName = `${normalizeDestName(master.folder)}-${suffix}`;
    suffix++;
  }
  createDestination({
    agent_group_id: forkId,
    local_name: parentName,
    target_type: 'agent',
    target_id: master.id,
    created_at: nowIso,
  });
}

export async function handleForkWorker(content: Record<string, unknown>, session: Session): Promise<void> {
  const sourceName = (content.source as string | undefined) ?? '';
  const forkName = (content.name as string | undefined) ?? '';

  if (!sourceName || !forkName) {
    notifyAgent(session, `fork_worker failed: source and name are required.`);
    return;
  }

  const callerGroup = getAgentGroup(session.agent_group_id);
  if (!callerGroup) {
    notifyAgent(session, `fork_worker failed: caller agent group not found.`);
    return;
  }
  if (callerGroup.fleet_role !== 'master') {
    notifyAgent(session, `fork_worker failed: only the master can fork workers.`);
    return;
  }

  const forkLocalName = normalizeName(forkName);
  if (!forkLocalName || forkLocalName === 'unnamed') {
    notifyAgent(session, `fork_worker failed: "${forkName}" is not a usable worker name.`);
    return;
  }
  if (!isSafeFolderName(forkLocalName)) {
    notifyAgent(session, `fork_worker failed: invalid fork folder name.`);
    log.error('fork_worker path traversal attempt', { folder: forkLocalName });
    return;
  }

  // Resolve source. 'self' / caller's name are aliases for "fork the master itself".
  let source: AgentGroup | undefined;
  const sourceFolder = normalizeName(sourceName);
  if (sourceName === 'self' || sourceFolder === callerGroup.folder) {
    source = callerGroup;
  } else {
    source = getAgentGroupByFolder(sourceFolder);
  }
  if (!source) {
    notifyAgent(session, `fork_worker failed: source worker "${sourceName}" not found.`);
    return;
  }
  if (source.status === 'archived') {
    notifyAgent(session, `fork_worker failed: source worker "${source.folder}" is archived. Resume it first.`);
    return;
  }
  if (source.folder === forkLocalName) {
    notifyAgent(session, `fork_worker failed: source and fork must have different names.`);
    return;
  }

  const existing = getAgentGroupByFolder(forkLocalName);
  if (existing) {
    notifyAgent(
      session,
      `fork_worker failed: a worker named "${forkLocalName}" already exists (status=${existing.status}). Choose a different fork name.`,
    );
    return;
  }

  const forkId = generateId('ag');
  const now = new Date().toISOString();

  const forkGroup: AgentGroup = {
    id: forkId,
    name: forkName,
    folder: forkLocalName,
    agent_provider: source.agent_provider ?? null,
    created_at: now,
    status: 'active',
    fleet_backend: source.fleet_backend ?? null,
    fleet_model: source.fleet_model ?? null,
    fleet_role: 'worker',
  };
  createAgentGroup(forkGroup);

  // Initialize standard scaffolding (composed CLAUDE.md, .claude-fragments,
  // .claude-shared symlinks). Then overlay source's workspace on top — but
  // skip composer outputs that re-generate on every spawn anyway.
  initGroupFilesystem(forkGroup);

  const sourceGroupDir = path.resolve(GROUPS_DIR, source.folder);
  const forkGroupDir = path.resolve(GROUPS_DIR, forkLocalName);
  copyOverlay(sourceGroupDir, forkGroupDir, new Set(['CLAUDE.md', '.claude-fragments']));

  // Sync container.json (backend, model, profile, MCP servers) into the
  // fork's slot AND populate the shim's worker-backends.json so the first
  // request from the fork's container routes correctly.
  setFleetBackend(forkLocalName, source.fleet_backend ?? 'claude', source.fleet_model ?? undefined);

  // Provision a fresh Discord channel for the fork. The source keeps its
  // own channel; routing only stays sane if the two never share one.
  const provision = await provisionDiscordChannel(forkId, forkLocalName, forkName, now);

  // Clone every source session into the fork's agent group. Each clone
  // gets a new session id and the fork's messaging_group_id, so the fork
  // routes inbound through its OWN channel instead of the source's.
  const sourceSessions = getSessionsByAgentGroup(source.id);
  let clonedSessions = 0;

  // Clone .claude-shared once for the fork agent group. Keyed at the
  // agent-group level so this only fires once even with multiple sessions.
  // The directory contains a mix of:
  //   - real files (settings.json, project session jsonl files, shell-snapshots)
  //   - symlinks pointing INTO the container ($/app/skills/...,
  //     /workspace/extra/host-skills/...) that don't exist on host
  // We use copyOverlay's walker, which preserves real files + replicates
  // symlinks as-is (without trying to follow). Skill symlinks are
  // re-synced at spawn time by syncSkillSymlinks regardless.
  const srcClaudeShared = path.join(DATA_DIR, 'v2-sessions', source.id, '.claude-shared');
  const dstClaudeShared = path.join(DATA_DIR, 'v2-sessions', forkId, '.claude-shared');
  if (lExistsSync(srcClaudeShared) && !lExistsSync(dstClaudeShared)) {
    fs.mkdirSync(dstClaudeShared, { recursive: true });
    copyOverlayDeep(srcClaudeShared, dstClaudeShared);
  }

  for (const srcSess of sourceSessions) {
    const forkSessionId = generateId('sess');
    const newSession: Session = {
      id: forkSessionId,
      agent_group_id: forkId,
      messaging_group_id: provision.messagingGroupId,
      thread_id: srcSess.thread_id,
      agent_provider: srcSess.agent_provider,
      status: 'active',
      container_status: 'idle',
      last_active: now,
      created_at: now,
    };
    createSession(newSession);

    const srcDir = sessionDir(source.id, srcSess.id);
    const dstDir = sessionDir(forkId, forkSessionId);
    fs.mkdirSync(dstDir, { recursive: true });

    // Online-backup the SQLite DBs so a concurrent writer in the source
    // container can't tear the snapshot.
    await backupSqlite(path.join(srcDir, 'inbound.db'), path.join(dstDir, 'inbound.db'));
    await backupSqlite(path.join(srcDir, 'outbound.db'), path.join(dstDir, 'outbound.db'));

    // Copy non-DB session artifacts (turns.jsonl, inbox/, conversations/,
    // .heartbeat). Skip SQLite sidecars — those are bound to the source's
    // open writer and would cause the cloned DB to refuse to open.
    if (fs.existsSync(srcDir)) {
      for (const entry of fs.readdirSync(srcDir)) {
        if (entry === 'inbound.db' || entry === 'outbound.db') continue;
        if (entry.endsWith('-journal') || entry.endsWith('-wal') || entry.endsWith('-shm')) continue;
        const s = path.join(srcDir, entry);
        const d = path.join(dstDir, entry);
        if (fs.existsSync(d)) continue;
        fs.cpSync(s, d, { recursive: true, dereference: false });
      }
    }

    // Drop the inherited SDK session id so the fork starts a fresh
    // server-side conversation. Local inbound/outbound history survives
    // for the agent to read; the SDK's own server memory of those turns
    // does not.
    clearSdkSessionId(path.join(dstDir, 'outbound.db'));

    clonedSessions++;
  }

  wireBidirectionalDestinations(callerGroup, forkId, forkLocalName, now);
  writeDestinations(session.agent_group_id, session.id);

  notifyAgent(
    session,
    `Worker "${forkLocalName}" forked from "${source.folder}" on ${source.fleet_backend ?? 'claude'}${source.fleet_model ? ` (${source.fleet_model})` : ''}. ${provision.statusText}. ${clonedSessions} session(s) cloned. Fork starts a fresh SDK conversation but inherits workspace files and prior message history. Message it with <message to="${forkLocalName}">...</message>.`,
  );
  log.info('Worker forked', {
    forkId,
    forkLocalName,
    source: source.folder,
    sourceAgentGroupId: source.id,
    backend: source.fleet_backend,
    model: source.fleet_model,
    clonedSessions,
  });
  logWorkerEvent({
    timestamp: new Date().toISOString(),
    event: 'forked',
    worker: forkLocalName,
    folder: forkLocalName,
    details: {
      agentGroupId: forkId,
      source: source.folder,
      sourceAgentGroupId: source.id,
      backend: source.fleet_backend ?? null,
      model: source.fleet_model ?? null,
      clonedSessions,
    },
  });
}
