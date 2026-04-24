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
  ncf inject <name> <msg> [--wait] [--timeout <sec>]
  ncf restart <name> [--fresh]
  ncf debug
  ncf reap-orphans [--dry-run]
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

function inboundDbPath(agentGroupId: string, sessionId: string): string {
  return path.join(DATA_DIR, 'v2-sessions', agentGroupId, sessionId, 'inbound.db');
}

/**
 * Inject a message directly into a worker's inbound.db, bypassing Discord.
 * With --wait, polls the outbound.db delivered table for a response.
 *
 * Message kind is "chat" (same as Discord text) so the agent treats it as
 * a regular user message. Platform/channel fields are stamped with the
 * worker's bound messaging_group so any reply still lands in the right
 * Discord channel (important for dual observability — see the reply in
 * Discord AND in the --wait output).
 */
function cmdInject(args: string[]): void {
  const name = args[0];
  const msg = args[1];
  if (!name || !msg) {
    console.error('usage: ncf inject <name> <msg> [--wait] [--timeout <sec>]');
    process.exit(1);
  }
  const wait = args.includes('--wait');
  let timeoutSec = 60;
  const tIdx = args.indexOf('--timeout');
  if (tIdx >= 0 && args[tIdx + 1]) timeoutSec = parseInt(args[tIdx + 1], 10);

  const worker = findAgentByName(name);
  if (!worker) {
    console.error(`unknown worker: ${name}`);
    process.exit(1);
  }
  const sessions = listSessions(worker.id);
  if (sessions.length === 0) {
    console.error(`no session for ${worker.folder} — send at least one Discord message first to seed the session`);
    process.exit(1);
  }
  const sess = sessions[0];
  const inPath = inboundDbPath(sess.agent_group_id, sess.id);
  if (!fs.existsSync(inPath)) {
    console.error(`inbound.db missing at ${inPath}`);
    process.exit(1);
  }

  // Pick a routing target — the worker's first wired messaging_group so
  // replies go to that channel (normally the Discord worker channel).
  const mgs = listMessagingGroups(worker.id);
  const routing = mgs[0] ?? { channel_type: null, platform_id: null };

  const messageId = `inject-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const db = new Database(inPath);
  try {
    const maxSeq = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_in').get() as { m: number }).m;
    const nextEvenSeq = maxSeq < 2 ? 2 : maxSeq + 2 - (maxSeq % 2);
    db.prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, platform_id, channel_type, thread_id, content, trigger, series_id)
       VALUES (@id, @seq, 'chat', datetime('now'), 'pending', @platformId, @channelType, @threadId, @content, 1, @id)`,
    ).run({
      id: messageId,
      seq: nextEvenSeq,
      platformId: routing.platform_id,
      channelType: routing.channel_type,
      threadId: routing.platform_id,
      content: JSON.stringify({ text: msg, sender: 'cli', senderName: 'cli' }),
    });
    console.log(`injected: msgId=${messageId} session=${sess.id}`);
  } finally {
    db.close();
  }

  const wakePort = parseInt(process.env.OUTBOUND_WAKE_PORT ?? '3100', 10);

  if (!wait) {
    // Fire-and-forget the wake and let the shell return.
    void fetch(`http://127.0.0.1:${wakePort}/wake-inbound/${sess.id}`, { method: 'POST' }).catch(() => {});
    return;
  }

  void (async () => {
    // Kick the host's wake-inbound endpoint so the container gets spawned
    // (or woken up if already running). Bypassing the router means the
    // normal engage path doesn't fire — this is the equivalent nudge.
    // Awaited here so the container has definitively started spawning
    // before we begin polling.
    try {
      await fetch(`http://127.0.0.1:${wakePort}/wake-inbound/${sess.id}`, { method: 'POST' });
    } catch {
      // Best effort — container's own active poll (500ms) will pick it up
      // eventually even if the wake POST fails.
    }

    const deadline = Date.now() + timeoutSec * 1000;
    const outPath = outboundDbPath(sess.agent_group_id, sess.id);
    // Outbound rows use SQLite's `datetime('now')` format — "YYYY-MM-DD HH:MM:SS"
    // (no T, no Z). Emit the inject timestamp in that format so lexicographic
    // `>=` comparisons work against stored rows.
    const injectTs = new Date().toISOString().slice(0, 19).replace('T', ' ');
    console.log(`waiting for reply (timeout ${timeoutSec}s)...`);
    while (Date.now() < deadline) {
      try {
        // First try: match by in_reply_to (cold spawns — agent creates new
        // query, formatter sets inReplyTo = injected msg id).
        // Fallback: any non-system outbound row newer than the inject
        // timestamp (warm spawns — agent pushes follow-up into existing
        // query, inReplyTo stays on the original batch's first message).
        const out = new Database(outPath, { readonly: true });
        try {
          const byReply = out
            .prepare(
              "SELECT timestamp, content FROM messages_out WHERE in_reply_to = ? AND kind != 'system' ORDER BY timestamp DESC LIMIT 1",
            )
            .get(messageId) as { timestamp: string; content: string } | undefined;
          if (byReply) {
            const c = JSON.parse(byReply.content);
            console.log(`\n[${byReply.timestamp}] ${c.text ?? c.markdown ?? byReply.content}`);
            return;
          }
          const byTs = out
            .prepare(
              "SELECT timestamp, content FROM messages_out WHERE kind != 'system' AND timestamp >= ? ORDER BY timestamp ASC LIMIT 1",
            )
            .get(injectTs) as { timestamp: string; content: string } | undefined;
          if (byTs) {
            const c = JSON.parse(byTs.content);
            console.log(`\n[${byTs.timestamp}] ${c.text ?? c.markdown ?? byTs.content}`);
            return;
          }
        } finally {
          out.close();
        }
      } catch {
        // outbound.db not created yet — keep polling
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    console.error(`timeout: no reply within ${timeoutSec}s`);
    process.exit(2);
  })();
}

function cmdRestart(args: string[]): void {
  const name = args[0];
  if (!name) {
    console.error('usage: ncf restart <name> [--fresh]');
    process.exit(1);
  }
  const worker = findAgentByName(name);
  if (!worker) {
    console.error(`unknown worker: ${name}`);
    process.exit(1);
  }
  const container = findRunningContainer(worker.folder);
  if (container) {
    spawnSync('docker', ['rm', '-f', container], { stdio: 'inherit' });
  }
  if (args.includes('--fresh')) {
    for (const s of listSessions(worker.id)) {
      const outPath = outboundDbPath(s.agent_group_id, s.id);
      const inPath = outPath.replace(/outbound\.db$/, 'inbound.db');
      for (const p of [outPath, inPath]) {
        if (!fs.existsSync(p)) continue;
        const db = new Database(p);
        try {
          db.prepare(
            "DELETE FROM session_state WHERE key = 'stored_session_id'",
          ).run();
        } catch {
          /* table might not exist on inbound side */
        } finally {
          db.close();
        }
      }
    }
    console.log(`restarted ${worker.folder} (fresh session)`);
  } else {
    console.log(`restarted ${worker.folder} (resumes session on next message)`);
  }
}

function cmdDebug(): void {
  console.log('=== paths ===');
  console.log(`DATA_DIR:   ${DATA_DIR}`);
  console.log(`GROUPS_DIR: ${GROUPS_DIR}`);
  console.log(`v2.db:      ${centralDbPath()}`);
  console.log();
  console.log('=== agent groups ===');
  const db = openCentral();
  try {
    const rows = db
      .prepare(`SELECT name, folder, fleet_role, status, fleet_backend, fleet_model FROM agent_groups ORDER BY fleet_role, name`)
      .all();
    for (const r of rows as Array<Record<string, unknown>>) {
      console.log(`  ${r.fleet_role ?? '—'}\t${r.status}\t${r.folder}\t${r.fleet_backend ?? '—'}${r.fleet_model ? ` (${r.fleet_model})` : ''}`);
    }
  } finally {
    db.close();
  }
  console.log();
  console.log('=== running containers ===');
  const ps = spawnSync('docker', ['ps', '--filter', 'name=nanoclaw-v2', '--format', '{{.Names}}\t{{.Status}}'], {
    encoding: 'utf-8',
  });
  process.stdout.write(ps.stdout || '  (none)\n');
  console.log();
  console.log('=== host ports ===');
  const ss = spawnSync('ss', ['-ltn'], { encoding: 'utf-8' });
  for (const line of (ss.stdout || '').split('\n')) {
    if (/:(3003|3100|3001|44[0-9]{3})\b/.test(line)) {
      console.log(`  ${line.trim()}`);
    }
  }
  console.log();
  console.log('=== shim upstream ===');
  const curl = spawnSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}\n', 'http://localhost:3003/models'], {
    encoding: 'utf-8',
  });
  console.log(`  GET /models → ${(curl.stdout || '').trim()}`);
  console.log();
  console.log('=== outbound-wake ===');
  const wake = spawnSync(
    'curl',
    ['-s', '-o', '/dev/null', '-w', '%{http_code}\n', '-X', 'POST', 'http://localhost:3100/wake/ping'],
    { encoding: 'utf-8' },
  );
  console.log(`  POST /wake/ping → ${(wake.stdout || '').trim()}`);
}

/**
 * Discord reap — delete channels named worker-* or lc-* in the configured
 * guild whose id isn't in messaging_groups. Useful after aborted test runs.
 */
function cmdReapOrphans(args: string[]): void {
  const dryRun = args.includes('--dry-run');
  const envTxt = fs.existsSync(path.resolve('.env')) ? fs.readFileSync(path.resolve('.env'), 'utf-8') : '';
  const token = /^DISCORD_BOT_TOKEN=(.+)$/m.exec(envTxt)?.[1];
  const guild = /^DISCORD_GUILD_ID=(.+)$/m.exec(envTxt)?.[1];
  if (!token || !guild) {
    console.error('DISCORD_BOT_TOKEN + DISCORD_GUILD_ID required in .env');
    process.exit(1);
  }
  const validIds = new Set<string>();
  const db = openCentral();
  try {
    const rows = db.prepare("SELECT platform_id FROM messaging_groups WHERE channel_type = 'discord'").all() as Array<{
      platform_id: string;
    }>;
    for (const r of rows) {
      const parts = r.platform_id.split(':');
      const chanId = parts[parts.length - 1];
      if (chanId) validIds.add(chanId);
    }
  } finally {
    db.close();
  }

  (async () => {
    const listResp = await fetch(`https://discord.com/api/v10/guilds/${guild}/channels`, {
      headers: { Authorization: `Bot ${token}` },
    });
    if (!listResp.ok) {
      console.error(`list channels failed: ${listResp.status}`);
      process.exit(1);
    }
    const chans = (await listResp.json()) as Array<{ id: string; name: string; type: number }>;
    const orphans = chans.filter(
      (c) => c.type === 0 && (c.name.startsWith('worker-') || c.name.startsWith('lc-')) && !validIds.has(c.id),
    );
    console.log(`${orphans.length} orphan channels`);
    if (orphans.length === 0) return;
    if (dryRun) {
      for (const o of orphans) console.log(`  ${o.id} ${o.name}`);
      return;
    }
    let ok = 0;
    for (const o of orphans) {
      const r = await fetch(`https://discord.com/api/v10/channels/${o.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bot ${token}` },
      });
      if (r.ok) ok++;
      else console.error(`FAIL ${o.id} ${o.name} -> ${r.status}`);
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    console.log(`reaped ${ok}/${orphans.length}`);
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
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
    case 'inject':
      return cmdInject(rest);
    case 'restart':
      return cmdRestart(rest);
    case 'debug':
      return cmdDebug();
    case 'reap-orphans':
      return cmdReapOrphans(rest);
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
