/**
 * ncf — NanoClaw Fleet CLI.
 *
 * Thin admin wrapper over the fleet module. Read-only commands hit the
 * central DB directly; mutating commands (create, destroy, switch) write
 * a `kind: 'system'` action row into the master session's outbound.db so
 * the running host picks it up via the normal delivery loop. This avoids
 * duplicating handler logic between MCP tool and CLI.
 *
 * Requires the NanoClaw host to be running. Mutations fail fast if it
 * isn't — we detect that by looking for the master session's outbound.db.
 *
 * Usage:
 *   ncf                          — usage
 *   ncf status [--json]
 *   ncf list [--json]
 *   ncf create <name> [--backend <b>] [--model <m>] [--instructions <text>]
 *   ncf destroy <name> [--keep-channel]
 *   ncf switch <name> <backend> [model]
 *   ncf logs <name> [--follow]   — docker logs for the worker's container
 *   ncf session <name>           — dump recent outbox for the worker
 */
import Database from 'better-sqlite3';
import { spawnSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from '../src/config.js';

const SCRIPT_USAGE = `ncf — NanoClaw Fleet CLI

Usage:
  ncf status [--json]
  ncf list [--json]
  ncf create <name> [--backend <b>] [--model <m>] [--instructions <text>]
  ncf destroy <name> [--keep-channel]
  ncf switch <name> <backend> [model]
  ncf logs <name> [--follow]
  ncf session <name>
`;

function centralDbPath(): string {
  return path.join(DATA_DIR, 'v2.db');
}

function openCentral(readonly = true): Database.Database {
  return new Database(centralDbPath(), { readonly });
}

interface AgentRow {
  id: string;
  name: string;
  folder: string;
  status: string;
  fleet_role: string | null;
  fleet_backend: string | null;
  fleet_model: string | null;
}

interface SessionRow {
  id: string;
  agent_group_id: string;
  container_status: string;
  last_active: string | null;
}

function getMaster(): AgentRow {
  const db = openCentral();
  try {
    const row = db.prepare("SELECT * FROM agent_groups WHERE fleet_role = 'master' LIMIT 1").get() as AgentRow | undefined;
    if (!row) {
      console.error("No fleet master found. Seed one with 'pnpm exec tsx scripts/init-fleet-master.ts' first.");
      process.exit(2);
    }
    return row;
  } finally {
    db.close();
  }
}

function getMasterSession(masterAgentGroupId: string): SessionRow {
  const db = openCentral();
  try {
    const row = db
      .prepare('SELECT * FROM sessions WHERE agent_group_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(masterAgentGroupId) as SessionRow | undefined;
    if (!row) {
      console.error('Master has no session yet — send one message to the master first.');
      process.exit(2);
    }
    return row;
  } finally {
    db.close();
  }
}

function outboundDbPath(agentGroupId: string, sessionId: string): string {
  return path.join(DATA_DIR, 'v2-sessions', agentGroupId, sessionId, 'outbound.db');
}

function genId(): string {
  return `ncf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Write a `kind: 'system'` action row into the master session's outbound.db,
 * mirroring the container-side MCP tool. The host delivery loop will pick it
 * up, route to the registered handler, and (for mutations) notify the master
 * via inbound.db.
 */
function writeSystemAction(action: string, payload: Record<string, unknown>): void {
  const master = getMaster();
  const session = getMasterSession(master.id);
  const dbPath = outboundDbPath(session.agent_group_id, session.id);
  if (!fs.existsSync(dbPath)) {
    console.error(`Master outbound.db missing: ${dbPath}\nIs the host running and has the master ever processed a message?`);
    process.exit(2);
  }
  const db = new Database(dbPath);
  try {
    const id = genId();
    db.prepare(
      `INSERT OR IGNORE INTO messages_out (id, seq, timestamp, kind, platform_id, channel_type, thread_id, content)
       VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 2 FROM messages_out), datetime('now'), 'system', NULL, NULL, NULL, ?)`,
    ).run(id, JSON.stringify({ action, requestId: id, ...payload }));
    console.log(`queued: ${action} (id=${id}) — check host logs or master chat for result`);
  } finally {
    db.close();
  }
}

function listWorkers(): AgentRow[] {
  const db = openCentral();
  try {
    return db
      .prepare(`SELECT * FROM agent_groups WHERE fleet_role = 'worker' ORDER BY name`)
      .all() as AgentRow[];
  } finally {
    db.close();
  }
}

function listSessions(agentGroupId: string): SessionRow[] {
  const db = openCentral();
  try {
    return db.prepare('SELECT * FROM sessions WHERE agent_group_id = ?').all(agentGroupId) as SessionRow[];
  } finally {
    db.close();
  }
}

function listMessagingGroups(agentGroupId: string): Array<{ channel_type: string; platform_id: string }> {
  const db = openCentral();
  try {
    return db
      .prepare(
        `SELECT mg.channel_type, mg.platform_id
           FROM messaging_groups mg
           JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id
          WHERE mga.agent_group_id = ?`,
      )
      .all(agentGroupId) as Array<{ channel_type: string; platform_id: string }>;
  } finally {
    db.close();
  }
}

function findAgentByName(name: string): AgentRow | undefined {
  const db = openCentral();
  try {
    const folder = name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return db.prepare('SELECT * FROM agent_groups WHERE folder = ? OR name = ?').get(folder, name) as AgentRow | undefined;
  } finally {
    db.close();
  }
}

function findRunningContainer(folder: string): string | undefined {
  const out = spawnSync('docker', ['ps', '--filter', `name=nanoclaw-v2-${folder}-`, '--format', '{{.Names}}'], {
    encoding: 'utf-8',
  });
  if (out.status !== 0) return undefined;
  const names = out.stdout.trim().split('\n').filter(Boolean);
  return names[0];
}

// ── Commands ──────────────────────────────────────────────────────────────

function cmdStatus(args: string[]): void {
  const json = args.includes('--json');
  const master = getMaster();
  const workers = listWorkers();

  const data = {
    master: {
      id: master.id,
      name: master.name,
      folder: master.folder,
      status: master.status,
      sessions: listSessions(master.id).length,
    },
    workers: workers.map((w) => ({
      name: w.name,
      folder: w.folder,
      status: w.status,
      backend: w.fleet_backend,
      model: w.fleet_model,
      container: findRunningContainer(w.folder) ? 'running' : 'stopped',
      sessions: listSessions(w.id).length,
      channels: listMessagingGroups(w.id).map((m) => `${m.channel_type}:${m.platform_id}`),
    })),
  };

  if (json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  console.log(`Master: ${data.master.name} [${data.master.folder}] — ${data.master.status}`);
  console.log(`Workers: ${data.workers.length}`);
  for (const w of data.workers) {
    const marker = w.status === 'archived' ? '[archived]' : `[${w.container}]`;
    const backend = w.backend ? `${w.backend}${w.model ? ` (${w.model})` : ''}` : '—';
    console.log(`  ${marker} ${w.name} · ${backend}${w.channels.length ? ' · ' + w.channels.join(', ') : ''}`);
  }
}

function cmdList(args: string[]): void {
  cmdStatus(args);
}

function cmdCreate(args: string[]): void {
  const name = args[0];
  if (!name || name.startsWith('--')) {
    console.error('usage: ncf create <name> [--backend <b>] [--model <m>] [--instructions <text>]');
    process.exit(1);
  }
  let backend: string | undefined;
  let model: string | undefined;
  let instructions: string | undefined;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--backend') backend = args[++i];
    else if (args[i] === '--model') model = args[++i];
    else if (args[i] === '--instructions') instructions = args[++i];
  }
  writeSystemAction('create_worker', {
    name,
    backend: backend ?? null,
    model: model ?? null,
    instructions: instructions ?? null,
  });
}

function cmdDestroy(args: string[]): void {
  const name = args[0];
  if (!name || name.startsWith('--')) {
    console.error('usage: ncf destroy <name> [--keep-channel]');
    process.exit(1);
  }
  const deleteChannel = !args.includes('--keep-channel');
  writeSystemAction('destroy_worker', { name, delete_channel: deleteChannel });
}

function cmdSwitch(args: string[]): void {
  const [name, backend, model] = args;
  if (!name || !backend) {
    console.error('usage: ncf switch <name> <backend> [model]');
    process.exit(1);
  }
  writeSystemAction('switch_backend', { name, backend, model: model ?? null });
}

function cmdLogs(args: string[]): void {
  const name = args[0];
  if (!name) {
    console.error('usage: ncf logs <name> [--follow]');
    process.exit(1);
  }
  const follow = args.includes('--follow');
  const worker = findAgentByName(name);
  if (!worker) {
    console.error(`unknown worker: ${name}`);
    process.exit(1);
  }
  const container = findRunningContainer(worker.folder);
  if (!container) {
    console.error(`no running container for ${worker.folder}`);
    process.exit(1);
  }
  const cmd = follow ? ['logs', '-f', container] : ['logs', '--tail', '200', container];
  const child = spawn('docker', cmd, { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
}

function cmdSession(args: string[]): void {
  const name = args[0];
  if (!name) {
    console.error('usage: ncf session <name>');
    process.exit(1);
  }
  const worker = findAgentByName(name);
  if (!worker) {
    console.error(`unknown worker: ${name}`);
    process.exit(1);
  }
  const sessions = listSessions(worker.id);
  if (sessions.length === 0) {
    console.error(`no sessions for ${worker.folder}`);
    process.exit(1);
  }
  const sess = sessions[0];
  const outPath = outboundDbPath(sess.agent_group_id, sess.id);
  const inPath = outPath.replace(/outbound\.db$/, 'inbound.db');
  if (!fs.existsSync(outPath)) {
    console.error(`no outbound.db at ${outPath}`);
    process.exit(1);
  }
  const out = new Database(outPath, { readonly: true });
  const inDb = new Database(inPath, { readonly: true });
  try {
    console.log(`== ${worker.folder} / ${sess.id} ==\n`);
    const ins = inDb
      .prepare('SELECT timestamp, kind, substr(content, 1, 200) AS content FROM messages_in ORDER BY timestamp DESC LIMIT 10')
      .all() as Array<{ timestamp: string; kind: string; content: string }>;
    console.log('-- inbound --');
    for (const r of ins.reverse()) console.log(`  [${r.timestamp}] ${r.kind}: ${r.content}`);
    const outs = out
      .prepare('SELECT timestamp, kind, substr(content, 1, 200) AS content FROM messages_out ORDER BY timestamp DESC LIMIT 10')
      .all() as Array<{ timestamp: string; kind: string; content: string }>;
    console.log('\n-- outbound --');
    for (const r of outs.reverse()) console.log(`  [${r.timestamp}] ${r.kind}: ${r.content}`);
  } finally {
    out.close();
    inDb.close();
  }
}

// ── Entry ────────────────────────────────────────────────────────────────

function main(): void {
  const [sub, ...rest] = process.argv.slice(2);
  if (!sub) {
    console.log(SCRIPT_USAGE);
    return;
  }
  // Ensure GROUPS_DIR is a string reference (keeps the import alive).
  void GROUPS_DIR;
  switch (sub) {
    case 'status':
      return cmdStatus(rest);
    case 'list':
      return cmdList(rest);
    case 'create':
      return cmdCreate(rest);
    case 'destroy':
      return cmdDestroy(rest);
    case 'switch':
      return cmdSwitch(rest);
    case 'logs':
      return cmdLogs(rest);
    case 'session':
      return cmdSession(rest);
    case '-h':
    case '--help':
    case 'help':
      console.log(SCRIPT_USAGE);
      return;
    default:
      console.error(`unknown command: ${sub}\n`);
      console.log(SCRIPT_USAGE);
      process.exit(1);
  }
}

main();
