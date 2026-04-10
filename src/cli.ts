#!/usr/bin/env npx tsx
/**
 * ncf — NanoClaw Fleet CLI
 *
 * Unified command-line tool for managing NanoClaw workers and containers.
 * Works from both host machine and inside containers.
 *
 * Usage:
 *   ncf status                    Show all workers and containers
 *   ncf logs <worker>             Show worker audit logs
 *   ncf inject <channel> <msg>    Inject message to channel
 *   ncf switch <worker> <bk> [m]  Switch backend/model for worker
 *   ncf restart <worker> [--fresh] Restart worker container
 *   ncf create <name> [opts]      Create new worker
 *   ncf destroy <name>            Destroy worker
 *   ncf session <worker>          Show session transcript
 *   ncf help                      Show this help
 */

import { execSync } from 'child_process';
import {
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  rmSync,
} from 'fs';
import { renameSync } from 'fs';
import path from 'path';

const PROJECT_DIR = path.resolve(import.meta.dirname!, '..');
const DB_PATH = path.join(PROJECT_DIR, 'store/messages.db');
const DATA_DIR = path.join(PROJECT_DIR, 'data');
const LOGS_DIR = path.join(PROJECT_DIR, 'logs/workers');

const IN_CONTAINER = existsSync('/workspace/project');
const HOST_PREFIX = IN_CONTAINER ? 'host.docker.internal' : 'localhost';

const TIMEOUTS = {
  DEFAULT: 30_000,
  REBUILD: 120_000,
  FOLLOW: 600_000,
  RESPONSE_WAIT: 120 * 1000,
  POLL_INTERVAL: 2000,
} as const;

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const NC = '\x1b[0m';
const BOLD = '\x1b[1m';

function sh(
  cmd: string,
  opts?: { ignoreError?: boolean; timeout?: number },
): string {
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      timeout: opts?.timeout ?? TIMEOUTS.DEFAULT,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (e: any) {
    if (opts?.ignoreError) return e.stdout?.trim?.() ?? '';
    throw e;
  }
}

function escapeSql(str: string): string {
  return str.replace(/'/g, "''");
}

function normalizeWorker(input: string): string {
  return input.startsWith('discord_') ? input : `discord_${input}`;
}

function sqlite(query: string): string {
  return sh(`sqlite3 "${DB_PATH}" "${query}"`, { ignoreError: true });
}

function jsonRead(file: string): any {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

function ipc(payload: Record<string, unknown>): void {
  const tasksDir = path.join(DATA_DIR, 'ipc/discord_main/tasks');
  mkdirSync(tasksDir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const tmpFile = path.join(tasksDir, filename + '.tmp');
  const destFile = path.join(tasksDir, filename);
  writeFileSync(tmpFile, JSON.stringify(payload));
  renameSync(tmpFile, destFile);
}

function resolveWorker(
  input: string,
): { jid: string; folder: string; name: string } | null {
  if (input.startsWith('dc:')) {
    const safeJid = escapeSql(input);
    const row = sqlite(
      `SELECT folder, name FROM registered_groups WHERE jid='${safeJid}';`,
    );
    if (!row) return null;
    const [folder, name] = row.split('|');
    return { jid: input, folder, name };
  }

  const folder = normalizeWorker(input);
  const safeInput = escapeSql(input);
  const safeFolder = escapeSql(folder);
  const row = sqlite(
    `SELECT jid, name FROM registered_groups WHERE folder='${safeFolder}' OR name='${safeInput}';`,
  );
  if (!row) return null;
  const [jid, name] = row.split('|');
  return { jid, folder, name };
}

function formatTokens(tokens: number): string {
  if (tokens < 1) return `${tokens}`;
  if (tokens < 1000) return `${Math.round(tokens)}`;
  if (tokens < 1000000) return `${(tokens / 1000).toFixed(1)}k`;
  if (tokens < 1000000000) return `${(tokens / 1000000).toFixed(1)}M`;
  return `${(tokens / 1000000000).toFixed(1)}B`;
}

function getContainerName(folder: string): string | null {
  const pattern = `nanoclaw-${folder.replace(/_/g, '-')}`;
  const containers = sh(
    `docker ps --filter "name=${pattern}" --format "{{.Names}}"`,
    { ignoreError: true },
  );
  return containers.split('\n')[0] || null;
}

// ── Commands ─────────────────────────────────────────────────────

function cmdStatus(json: boolean, noColor: boolean) {
  const GREEN = noColor ? '' : '\x1b[32m';
  const RED = noColor ? '' : '\x1b[31m';
  const YELLOW = noColor ? '' : '\x1b[33m';
  const CYAN = noColor ? '' : '\x1b[36m';
  const NC = noColor ? '' : '\x1b[0m';
  const BOLD = noColor ? '' : '\x1b[1m';
  const STATUS_UP = noColor ? '🟢' : `${GREEN}●${NC}`;
  const STATUS_DOWN = noColor ? '🔴' : `${RED}○${NC}`;
  const STATUS_STOPPED = noColor ? '🟡' : `${YELLOW}○${NC}`;
  const MASTER_EMOJI = noColor ? '⬛ ' : '';
  const WORKERS_EMOJI = noColor ? '🤖 ' : '';
  const backends = jsonRead(path.join(DATA_DIR, 'worker-backends.json')) || {};
  const usage = jsonRead(path.join(DATA_DIR, 'worker-usage.json')) || {};
  const groups =
    jsonRead(path.join(DATA_DIR, 'ipc/discord_main/available_groups.json'))
      ?.groups || [];

  interface WorkerInfo {
    folder: string;
    name: string;
    jid: string;
    backend: string;
    model: string;
    container: string | null;
    requests: number;
    tokens: number;
    energyWh: number;
  }

  const workers: WorkerInfo[] = [];
  let master: WorkerInfo | null = null;

  for (const g of groups) {
    if (!g.isRegistered || !g.folder) continue;

    const b = backends[g.folder] || {};
    const u = usage[g.folder] || {};
    const container = getContainerName(g.folder);

    const info: WorkerInfo = {
      folder: g.folder,
      name: g.name,
      jid: g.jid,
      backend: b.backend || 'anthropic',
      model: b.model || 'unknown',
      container,
      requests: u.requests || 0,
      tokens: u.total_tokens || 0,
      energyWh: (u.energy_kwh || 0) * 1000,
    };

    const isMain = g.folder === 'discord_main';
    if (isMain) {
      master = info;
    } else {
      workers.push(info);
    }
  }

  if (json) {
    console.log(JSON.stringify({ master, workers }, null, 2));
    return;
  }

  // Human output
  if (master) {
    const status = master.container ? STATUS_UP : STATUS_DOWN;
    console.log(
      `\n${MASTER_EMOJI}${BOLD}Master${NC}  ${status} ${CYAN}${master.model}${NC} ${master.container ? 'up' : 'down'}`,
    );
  }

  if (workers.length > 0) {
    console.log(`\n${WORKERS_EMOJI}${BOLD}Workers${NC}`);
    for (const w of workers) {
      const status = w.container ? STATUS_UP : STATUS_STOPPED;
      const usage =
        w.requests > 0
          ? `  ${w.requests} reqs, ${formatTokens(w.tokens)} tok`
          : '';
      const displayName = w.name.replace(/^devbox server /, '');
      console.log(
        `  ${status} ${displayName.padEnd(12)} ${CYAN}${w.model.padEnd(20)}${NC} ${w.container ? 'up' : 'stopped'}${usage}`,
      );
    }
  } else {
    console.log(`\n${YELLOW}No workers registered${NC}`);
  }
  console.log();
}

function cmdLogs(
  worker: string,
  n: number,
  filter: 'cache' | 'slow' | null,
  json: boolean,
) {
  const folder = normalizeWorker(worker);
  const file = path.join(LOGS_DIR, folder, 'turns.jsonl');

  if (!existsSync(file)) {
    if (json) {
      console.log(JSON.stringify({ error: `No logs for ${worker}` }));
    } else {
      console.error(`${RED}No logs for ${worker}${NC}`);
    }
    process.exit(1);
  }

  let lines = sh(`tail -n 200 "${file}"`, { ignoreError: true })
    .split('\n')
    .filter(Boolean);

  if (filter === 'cache') {
    lines = lines.filter((l) => {
      try {
        const j = JSON.parse(l);
        return j.cached_tokens && j.cached_tokens > 0;
      } catch {
        return false;
      }
    });
  } else if (filter === 'slow') {
    lines = lines.filter((l) => {
      try {
        const j = JSON.parse(l);
        return j.latency_ms && j.latency_ms > 5000;
      } catch {
        return false;
      }
    });
  }

  lines = lines.slice(-n);

  const entries: any[] = [];
  for (const line of lines) {
    let j: any;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (json) {
      entries.push(j);
    } else {
      const ts = j.ts?.slice(11, 19) || '?';
      const model = (j.model || '?').slice(0, 35);
      const cached = j.cached_tokens ? ` cached=${j.cached_tokens}` : '';
      const latency = j.latency_ms ? ` ${j.latency_ms}ms` : '';
      console.log(
        `${ts}  ${model.padEnd(35)}  in=${j.input_tokens}${cached}  out=${j.output_tokens}${latency}`,
      );
    }
  }

  if (json) {
    console.log(JSON.stringify({ worker, entries }, null, 2));
  }
}

function cmdHostLogs(n: number, json: boolean, grepPattern: string | null) {
  const logFile = path.join(LOGS_DIR, '..', 'nanoclaw.log');
  if (!existsSync(logFile)) {
    console.error(`${RED}No nanoclaw.log found${NC}`);
    process.exit(1);
  }

  const content = readFileSync(logFile, 'utf-8');
  let lines = content
    .split('\n')
    .filter(Boolean)
    .slice(-n * 2);

  if (grepPattern) {
    let re: RegExp;
    try {
      re = new RegExp(grepPattern, 'i');
    } catch {
      console.error(`${RED}Invalid regex: ${grepPattern}${NC}`);
      process.exit(1);
    }
    lines = lines.filter((l) => re.test(l));
  }

  lines = lines.slice(-n);

  if (json) {
    const entries = lines.map((line) => {
      const match = line.match(
        /\[(\d{2}:\d{2}:\d{2}\.\d{3})\]\s+(\w+)\s+\((\d+)\):\s+(?:\x1b\[\d+m)?(.+?)(?:\x1b\[0m)?$/,
      );
      if (match) {
        return {
          time: match[1],
          level: match[2],
          pid: parseInt(match[3]),
          message: match[4].replace(/\x1b\[\d+m/g, ''),
        };
      }
      return { raw: line };
    });
    console.log(JSON.stringify(entries, null, 2));
  } else {
    for (const line of lines) {
      console.log(line);
    }
  }
}

function cmdFollowHostLogs() {
  const logFile = path.join(LOGS_DIR, '..', 'nanoclaw.log');
  if (!existsSync(logFile)) {
    console.error(`${RED}No nanoclaw.log found${NC}`);
    process.exit(1);
  }
  execSync(`tail -f "${logFile}"`, { stdio: 'inherit' });
}

async function cmdInject(channel: string, message: string, wait: boolean) {
  const resolved = resolveWorker(channel);
  if (!resolved) {
    console.error(`${RED}Channel not found: ${channel}${NC}`);
    process.exit(1);
  }

  const msgId = `inject-${Date.now()}`;
  const timestamp = new Date().toISOString();
  const safeMsg = escapeSql(message);
  const safeJid = escapeSql(resolved.jid);

  sqlite(
    `INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
     VALUES ('${msgId}', '${safeJid}', 'host-cli', 'CLI', '${safeMsg}', '${timestamp}', 0, 0);`,
  );

  console.log(
    `${GREEN}✓${NC} Injected into ${resolved.name}: ${message.slice(0, 50)}...`,
  );

  if (!wait) {
    console.log('  Agent will respond on next poll (~1s)');
    return;
  }

  console.log('  Waiting for response...');

  const container = getContainerName(resolved.folder);
  if (!container) {
    console.log('  Container not running, will spawn on next poll');
    return;
  }

  const existing = parseInt(
    sh(
      `docker logs "${container}" 2>&1 | grep -c "^---NANOCLAW_OUTPUT_END---" || echo 0`,
      { ignoreError: true },
    ),
  );

  const deadline = Date.now() + TIMEOUTS.RESPONSE_WAIT;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, TIMEOUTS.POLL_INTERVAL));
    const current = parseInt(
      sh(
        `docker logs "${container}" 2>&1 | grep -c "^---NANOCLAW_OUTPUT_END---" || echo 0`,
        { ignoreError: true },
      ),
    );
    if (current > existing) {
      const result = sh(
        `docker logs "${container}" 2>&1 | grep -A1 "^---NANOCLAW_OUTPUT_START---" | tail -1`,
        { ignoreError: true },
      );
      try {
        const parsed = JSON.parse(result);
        console.log(`\n${parsed.result || '(no result)'}`);
      } catch {
        console.log(`\n${result || '(no output)'}`);
      }
      return;
    }
  }

  console.error(`${RED}Timeout waiting for response${NC}`);
  process.exit(1);
}

function cmdSwitch(worker: string, backend: string, model?: string) {
  const resolved = resolveWorker(worker);
  if (!resolved) {
    console.error(`${RED}Worker not found: ${worker}${NC}`);
    process.exit(1);
  }

  if (backend !== 'anthropic' && backend !== 'neuralwatt') {
    console.error(`${RED}Backend must be 'anthropic' or 'neuralwatt'${NC}`);
    process.exit(1);
  }

  const payload: Record<string, unknown> = {
    type: 'switch_backend',
    worker_name: worker,
    backend,
  };
  if (model) payload.model = model;

  ipc(payload);
  console.log(
    `${GREEN}✓${NC} Switched ${resolved.name} to ${backend}${model ? `/${model}` : ''}`,
  );
  console.log('  Container will restart if needed');
}

function cmdRestart(worker: string, fresh: boolean) {
  const resolved = resolveWorker(worker);
  if (!resolved) {
    console.error(`${RED}Worker not found: ${worker}${NC}`);
    process.exit(1);
  }

  const container = getContainerName(resolved.folder);

  if (fresh) {
    const sessionDir = path.join(DATA_DIR, 'sessions', resolved.folder);
    if (existsSync(sessionDir)) {
      rmSync(sessionDir, { recursive: true, force: true });
      console.log(`${YELLOW}✓${NC} Cleared session history`);
    }
    const safeFolder = escapeSql(resolved.folder);
    sqlite(`DELETE FROM sessions WHERE group_folder='${safeFolder}';`);
  }

  if (container) {
    sh(`docker kill "${container}"`, { ignoreError: true });
    console.log(`${GREEN}✓${NC} Stopped container ${container}`);
  }

  console.log(`  Worker will respawn on next message`);
}

function cmdCreate(
  name: string,
  opts: { backend?: string; model?: string; trigger?: string },
) {
  const guildId =
    process.env.DISCORD_GUILD_ID ||
    sh(`grep DISCORD_GUILD_ID "${PROJECT_DIR}/.env" | cut -d= -f2`, {
      ignoreError: true,
    });
  if (!guildId) {
    console.error(`${RED}DISCORD_GUILD_ID not found${NC}`);
    process.exit(1);
  }

  const folder = `discord_${name}`;
  const payload: Record<string, unknown> = {
    type: 'create_worker',
    guild_id: guildId.trim(),
    channel_name: name,
    folder,
    trigger: opts.trigger || '@Andy',
  };
  if (opts.backend) payload.backend = opts.backend;
  if (opts.model) payload.model = opts.model;

  ipc(payload);
  console.log(`${GREEN}✓${NC} Creating worker ${name}`);
  console.log('  Check status in a few seconds: ncf status');
}

function cmdDestroy(worker: string) {
  const resolved = resolveWorker(worker);
  if (!resolved) {
    console.error(`${RED}Worker not found: ${worker}${NC}`);
    process.exit(1);
  }

  ipc({ type: 'destroy_worker', jid: resolved.jid });
  console.log(`${GREEN}✓${NC} Destroying worker ${resolved.name}`);
  console.log('  Workspace will be preserved');
}

// jq filter for rendering session JSONL as a human-readable transcript
const SESSION_JQ_FILTER = `
  select(.message) |
  .message as $m |
  if $m.role == "user" then
    ($m.content // [] | if type == "array" then
      [.[] | select(.type == "text") | .text] | join("\\n")
    else . end) | if . != "" then "👤 USER:\\n" + .[0:500] else empty end
  elif $m.role == "assistant" then
    ($m.content // [] | if type == "array" then
      [.[] |
        if .type == "text" then "💬 " + .text
        elif .type == "tool_use" then "🔧 " + .name + "(" + (.input | keys | join(", ")) + ")"
        elif .type == "tool_result" then "📎 result(" + .tool_use_id[0:8] + ")"
        elif .type == "thinking" then "💭 " + .thinking[0:200]
        else empty end
      ] | join("\\n")
    else empty end) | if . != "" then "🤖 ASSISTANT:\\n" + . else empty end
  else empty end
`.trim();

function getSessionFile(worker: string): string | null {
  const folder = normalizeWorker(worker);
  const sessionDir = path.join(
    DATA_DIR,
    'sessions',
    folder,
    '.claude/projects/-workspace-group',
  );

  if (!existsSync(sessionDir)) return null;

  const jsonlFiles = readdirSync(sessionDir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .reverse();

  if (jsonlFiles.length === 0) return null;
  return path.join(sessionDir, jsonlFiles[0]);
}

function cmdSession(worker: string, lines: number, json: boolean, live: boolean) {
  const file = getSessionFile(worker);
  if (!file) {
    if (json) {
      console.log(JSON.stringify({ error: `No session for ${worker}` }));
    } else {
      console.error(`${RED}No session for ${worker}${NC}`);
    }
    process.exit(1);
  }

  if (live) {
    // Stream the session transcript in real-time using tail -f piped through jq.
    // Shows user messages, assistant text, tool calls, and thinking blocks
    // as they happen — useful for debugging agent behavior live.
    console.log(`${CYAN}Live session transcript (Ctrl+C to stop)${NC}\n`);
    execSync(
      `tail -f "${file}" | jq --unbuffered -r '${SESSION_JQ_FILTER}'`,
      { stdio: 'inherit', timeout: TIMEOUTS.FOLLOW },
    );
    return;
  }

  if (json) {
    const content = sh(`tail -n ${lines} "${file}"`, { ignoreError: true });
    const entries: any[] = [];
    for (const line of content.split('\n').filter(Boolean)) {
      try {
        entries.push(JSON.parse(line));
      } catch {}
    }
    console.log(
      JSON.stringify({ worker, file: path.basename(file), entries }, null, 2),
    );
    return;
  }

  console.log(`${CYAN}Session: ${path.basename(file)}${NC}\n`);

  sh(`tail -n ${lines} "${file}" | jq -r '${SESSION_JQ_FILTER}'`);
}

function cmdHistory(
  worker?: string,
  since?: string,
  limit: number = 50,
  json: boolean = false,
) {
  const eventsFile = path.join(PROJECT_DIR, 'logs/worker-events.jsonl');

  if (!existsSync(eventsFile)) {
    if (json) {
      console.log(JSON.stringify({ events: [] }));
    } else {
      console.log(`${YELLOW}No worker event history${NC}`);
    }
    return;
  }

  const lines = readFileSync(eventsFile, 'utf-8').trim().split('\n');
  const events: any[] = [];

  for (const line of lines) {
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch {}
  }

  let filtered = events;
  if (worker) {
    const w = worker.toLowerCase();
    filtered = filtered.filter(
      (e) =>
        e.worker?.toLowerCase().includes(w) ||
        e.folder?.toLowerCase().includes(w),
    );
  }
  if (since) {
    const sinceTime = new Date(since).getTime();
    filtered = filtered.filter(
      (e) => new Date(e.timestamp).getTime() >= sinceTime,
    );
  }

  filtered = filtered.slice(-limit).reverse();

  if (json) {
    console.log(JSON.stringify({ events: filtered }, null, 2));
    return;
  }

  if (filtered.length === 0) {
    console.log(`${YELLOW}No events found${NC}`);
    return;
  }

  for (const e of filtered) {
    const ts = e.timestamp?.slice(0, 19) || '?';
    const event = e.event || '?';
    const name = e.worker || '?';
    let details = '';

    if (event === 'created') {
      details = `${e.details?.backend || 'anthropic'}${e.details?.model ? '/' + e.details.model : ''}`;
    } else if (event === 'backend_switched') {
      details = `${e.details?.from || '?'} -> ${e.details?.to || '?'}${e.details?.model ? ' (' + e.details.model + ')' : ''}`;
    } else if (event === 'destroyed') {
      details = '';
    }

    console.log(
      `${CYAN}${ts}${NC}  ${event.padEnd(16)}  ${name.padEnd(20)} ${details}`,
    );
  }
}

function cmdDebug() {
  console.log(`\n${BOLD}NanoClaw Debug Info${NC}\n`);

  console.log(`${CYAN}Project${NC}`);
  console.log(`  PROJECT_DIR: ${PROJECT_DIR}`);
  console.log(`  DB_PATH: ${DB_PATH}`);
  console.log(`  DATA_DIR: ${DATA_DIR}`);

  console.log(`\n${CYAN}Host Process${NC}`);
  console.log(`  PID: ${process.pid}`);
  console.log(`  Node: ${process.version}`);
  console.log(`  Platform: ${process.platform}`);

  console.log(`\n${CYAN}Database${NC}`);
  const dbExists = existsSync(DB_PATH);
  console.log(`  Exists: ${dbExists ? GREEN + 'yes' : RED + 'no'}${NC}`);
  if (dbExists) {
    const groups = sqlite('SELECT count(*) FROM registered_groups;');
    const sessions = sqlite('SELECT count(*) FROM sessions;');
    console.log(`  Groups: ${groups}`);
    console.log(`  Sessions: ${sessions}`);
  }

  console.log(`\n${CYAN}Worker Backends${NC}`);
  const backends = jsonRead(path.join(DATA_DIR, 'worker-backends.json'));
  if (backends) {
    for (const [folder, cfg] of Object.entries(backends) as [string, any][]) {
      console.log(
        `  ${folder}: ${cfg.backend || 'anthropic'}/${cfg.model || 'default'}`,
      );
    }
  } else {
    console.log(`  ${YELLOW}Not configured${NC}`);
  }

  console.log(`\n${CYAN}Containers${NC}`);
  const containers = sh(
    'docker ps --filter "name=nanoclaw-" --format "{{.Names}} {{.Status}}"',
    { ignoreError: true },
  );
  if (containers) {
    for (const line of containers.split('\n')) {
      console.log(`  ${line}`);
    }
  } else {
    console.log(`  ${YELLOW}None running${NC}`);
  }

  console.log(`\n${CYAN}Proxies${NC}`);
  const proxyPort =
    sh('grep CREDENTIAL_PROXY_PORT .env 2>/dev/null | cut -d= -f2', {
      ignoreError: true,
    }) || '3001';
  const nwPort =
    sh('grep NEURALWATT_PROXY_PORT .env 2>/dev/null | cut -d= -f2', {
      ignoreError: true,
    }) || '3003';

  const proxyUp = sh(
    `curl -s -o /dev/null -w "%{http_code}" http://${HOST_PREFIX}:${proxyPort}/ 2>/dev/null`,
    { ignoreError: true },
  );
  const nwUp = sh(
    `curl -s -o /dev/null -w "%{http_code}" http://${HOST_PREFIX}:${nwPort}/models 2>/dev/null`,
    { ignoreError: true },
  );

  console.log(
    `  Credential proxy :${proxyPort}: ${proxyUp === '200' ? GREEN + 'up' : YELLOW + proxyUp}${NC}`,
  );
  console.log(
    `  Neuralwatt proxy :${nwPort}: ${nwUp === '200' ? GREEN + 'up' : YELLOW + nwUp}${NC}`,
  );

  console.log();
}

function cmdRebuild(worker?: string) {
  if (worker) {
    console.log(`${YELLOW}Rebuilding container for ${worker}...${NC}`);
    sh('./container/build.sh', { timeout: TIMEOUTS.REBUILD });
    console.log(`${GREEN}✓${NC} Container image rebuilt`);
    console.log('  Restart worker to use new image: ncf restart ' + worker);
  } else {
    console.log(`${YELLOW}Rebuilding all containers...${NC}`);
    sh('./container/build.sh', { timeout: TIMEOUTS.REBUILD });
    console.log(`${GREEN}✓${NC} Container image rebuilt`);
    console.log('  Restart workers to use new image');
  }
}

function cmdFollowLogs(worker: string) {
  const folder = normalizeWorker(worker);
  const container = getContainerName(folder);
  if (!container) {
    console.error(`${RED}Container not running for ${worker}${NC}`);
    process.exit(1);
  }
  console.log(`${CYAN}Following logs for ${container}...${NC}\n`);
  // Use stdio: 'inherit' so logs stream to the terminal in real-time
  // (execSync with 'pipe' would buffer everything until the command exits)
  execSync(`docker logs -f "${container}"`, {
    timeout: TIMEOUTS.FOLLOW,
    stdio: 'inherit',
  });
}

function printHelp() {
  console.log(`
${BOLD}ncf${NC} — NanoClaw Fleet CLI

${BOLD}USAGE${NC}
  ncf <command> [options]

${BOLD}COMMANDS${NC}
  ${CYAN}status${NC}                 Show all workers and containers
  ${CYAN}logs${NC} <worker> [n]      Show last N audit log entries (default: 20)
    --cache               Show only cache hits
    --slow                Show only slow requests (>5s)
    --follow              Follow container logs in real-time
  
  ${CYAN}inject${NC} <ch> <msg>      Inject message to channel
    --wait                Wait for response
  
  ${CYAN}switch${NC} <w> <bk> [m]    Switch backend for worker
                         backend: anthropic, neuralwatt
                         model: model ID for neuralwatt
  
  ${CYAN}restart${NC} <worker>       Restart worker container
    --fresh               Clear session history first
  
  ${CYAN}create${NC} <name>          Create new worker
    --backend <b>         Backend to use
    --model <m>           Model ID (for neuralwatt)
    --trigger <t>         Trigger pattern (default: @Andy)
  
  ${CYAN}destroy${NC} <worker>       Destroy worker (keeps workspace)
  
  ${CYAN}session${NC} <worker> [n]   Show session transcript (default: 80 lines)
    --live                Stream transcript in real-time (user msgs, tool calls, responses)
  
  ${CYAN}history${NC} [worker]       Show worker event history
    --since <date>       Events since date (ISO format)
    --limit <n>          Max events (default: 50)
  
  ${CYAN}debug${NC}                  Show debug info (paths, DB, containers, proxies)
  
  ${CYAN}rebuild${NC} [worker]       Rebuild container image

  ${CYAN}test${NC} [--skip-nw]        Run e2e smoke tests (creates/destroys workers)

${BOLD}OUTPUT${NC}
  --json                 JSON output (status, logs, history, session)

${BOLD}EXAMPLES${NC}
  ncf status
  ncf status --json
  ncf history
  ncf history pareto
  ncf logs pareto --cache
  ncf inject main "hello"
  ncf inject --wait test "what model?"
  ncf switch pareto neuralwatt zai-org/GLM-5-FP8
  ncf restart main --fresh
  ncf create myworker --backend neuralwatt --model kimi-k2.5
`);
}

// ── Main ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (
  args.length === 0 ||
  args[0] === 'help' ||
  args[0] === '--help' ||
  args[0] === '-h'
) {
  printHelp();
  process.exit(0);
}

process.stdout.on('error', (err) => {
  if (err.code === 'EPIPE') process.exit(0);
});

const cmd = args[0];

(async () => {
  try {
    switch (cmd) {
      case 'status': {
        const json = args.includes('--json');
        const noColor = args.includes('--no-color');
        cmdStatus(json, noColor);
        break;
      }

      case 'logs': {
        const worker = args[1];
        if (!worker) {
          console.error(
            `${RED}Usage: ncf logs <worker|--host> [n] [--cache|--slow|--follow|--json|--grep PATTERN]${NC}`,
          );
          process.exit(1);
        }
        if (args.includes('--follow')) {
          if (worker === '--host') {
            cmdFollowHostLogs();
          } else {
            cmdFollowLogs(worker);
          }
          break;
        }
        const json = args.includes('--json');
        const n = parseInt(args.find((a) => /^\d+$/.test(a)) || '20');
        const grepIdx = args.indexOf('--grep');
        const grepPattern =
          grepIdx !== -1 && args[grepIdx + 1] ? args[grepIdx + 1] : null;
        const filter = args.includes('--cache')
          ? 'cache'
          : args.includes('--slow')
            ? 'slow'
            : null;
        if (worker === '--host') {
          cmdHostLogs(n, json, grepPattern);
        } else {
          cmdLogs(worker, n, filter, json);
        }
        break;
      }

      case 'inject': {
        const waitIdx = args.indexOf('--wait');
        const wait = waitIdx !== -1;
        const filtered = args.filter((a) => a !== '--wait');
        const channel = filtered[1];
        const message = filtered.slice(2).join(' ');
        if (!channel || !message) {
          console.error(
            `${RED}Usage: ncf inject [--wait] <channel> <message>${NC}`,
          );
          process.exit(1);
        }
        await cmdInject(channel, message, wait);
        break;
      }

      case 'switch': {
        const worker = args[1];
        const backend = args[2];
        const model = args[3];
        if (!worker || !backend) {
          console.error(
            `${RED}Usage: ncf switch <worker> <backend> [model]${NC}`,
          );
          process.exit(1);
        }
        cmdSwitch(worker, backend, model);
        break;
      }

      case 'restart': {
        const fresh = args.includes('--fresh');
        const worker = args.find((a) => a !== '--fresh' && a !== 'restart');
        if (!worker) {
          console.error(`${RED}Usage: ncf restart <worker> [--fresh]${NC}`);
          process.exit(1);
        }
        cmdRestart(worker, fresh);
        break;
      }

      case 'create': {
        const name = args[1];
        if (!name) {
          console.error(
            `${RED}Usage: ncf create <name> [--backend <b>] [--model <m>] [--trigger <t>]${NC}`,
          );
          process.exit(1);
        }
        const opts = {
          backend: args[args.indexOf('--backend') + 1],
          model: args[args.indexOf('--model') + 1],
          trigger: args[args.indexOf('--trigger') + 1],
        };
        cmdCreate(name, opts);
        break;
      }

      case 'destroy': {
        const worker = args[1];
        if (!worker) {
          console.error(`${RED}Usage: ncf destroy <worker>${NC}`);
          process.exit(1);
        }
        cmdDestroy(worker);
        break;
      }

      case 'session': {
        const worker = args[1];
        const lines = parseInt(args[2]) || 80;
        const json = args.includes('--json');
        if (!worker) {
          console.error(
            `${RED}Usage: ncf session <worker> [lines] [--json] [--live]${NC}`,
          );
          process.exit(1);
        }
        const live = args.includes('--live');
        cmdSession(worker, lines, json, live);
        break;
      }

      case 'debug': {
        cmdDebug();
        break;
      }

      case 'history': {
        const json = args.includes('--json');
        const workerIdx = args.findIndex(
          (a) => !a.startsWith('--') && a !== 'history',
        );
        const worker = workerIdx > 0 ? args[workerIdx] : undefined;
        const sinceIdx = args.indexOf('--since');
        const since = sinceIdx > 0 ? args[sinceIdx + 1] : undefined;
        const limitIdx = args.indexOf('--limit');
        const limit = limitIdx > 0 ? parseInt(args[limitIdx + 1]) || 50 : 50;
        cmdHistory(worker, since, limit, json);
        break;
      }

      case 'rebuild': {
        cmdRebuild(args[1]);
        break;
      }

      case 'test': {
        // Thin wrapper around the e2e test script
        const testArgs = args.slice(1).join(' ');
        execSync(
          `npx tsx "${path.join(PROJECT_DIR, 'tools/e2e-test.ts')}" ${testArgs}`,
          {
            stdio: 'inherit',
            cwd: PROJECT_DIR,
          },
        );
        break;
      }

      default:
        console.error(`${RED}Unknown command: ${cmd}${NC}`);
        console.error('Run `ncf help` for usage');
        process.exit(1);
    }
  } catch (e: any) {
    console.error(`${RED}Error: ${e.message}${NC}`);
    process.exit(1);
  }
})();
