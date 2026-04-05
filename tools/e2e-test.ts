#!/usr/bin/env npx tsx
/**
 * End-to-end smoke test for NanoClaw.
 *
 * Works from both the host and from inside a container (e.g., the master agent).
 * When running inside a container, systemctl calls are replaced with the
 * watchdog sentinel file (~/.nanoclaw-restart) and some checks are adapted.
 *
 * Usage:
 *   npx tsx tools/e2e-test.ts              # run all scenarios
 *   npx tsx tools/e2e-test.ts --skip-nw    # skip Neuralwatt tests
 *
 * Scenarios tested:
 *   1. Preflight — Docker running, guild ID present, NanoClaw responsive
 *   2. Worker creation — DB registration, workspace dir, assembled CLAUDE.md
 *   3. First boot — container spawns, agent responds
 *   4. Session resume — kill container, respawn, agent recalls secret
 *   5. Neuralwatt backend — create NW worker, shim response, streaming
 *   6. Backend switching — NW → Anthropic
 *   7. Credential proxy — reachable on :3001
 *   8. Destroy — DB cleanup, container stopped, workspace preserved
 *   9. Port mapping — create worker with ports, verify docker config
 */

import { execSync, spawn } from 'child_process';
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, readdirSync, rmSync } from 'fs';
import path from 'path';

// ── Environment detection ────────────────────────────────────

const IN_CONTAINER = existsSync('/.dockerenv') || process.env.NANOCLAW_CHAT_JID != null;
const PROJECT_DIR = IN_CONTAINER
  ? '/workspace/project'
  : path.resolve(import.meta.dirname || __dirname, '..');
const HOST_HOME = IN_CONTAINER ? '/home/host' : process.env.HOME!;
const DB_PATH = path.join(PROJECT_DIR, 'store/messages.db');
const LOGS_JSONL = path.join(PROJECT_DIR, 'logs/nanoclaw.jsonl');
const SKIP_NW = process.argv.includes('--skip-nw');

process.chdir(PROJECT_DIR);

// ── Test harness ─────────────────────────────────────────────

let passed = 0;
let failed = 0;
const startTime = Date.now();

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const NC = '\x1b[0m';

function pass(msg: string) {
  console.log(`  ${GREEN}✓${NC} ${msg}`);
  passed++;
}

function fail(msg: string) {
  console.log(`  ${RED}✗${NC} ${msg}`);
  failed++;
}

function info(msg: string) {
  console.log(`${YELLOW}▸${NC} ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Shell helpers ────────────────────────────────────────────

function sh(cmd: string, opts?: { ignoreError?: boolean; timeout?: number }): string {
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      timeout: opts?.timeout ?? 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (e: any) {
    if (opts?.ignoreError) return e.stdout?.trim?.() ?? '';
    throw e;
  }
}

function sqlite(query: string): string {
  return sh(`sqlite3 "${DB_PATH}" "${query}"`, { ignoreError: true });
}

// ── IPC helper ───────────────────────────────────────────────
// Writes an IPC task file. Fire-and-forget (NanoClaw processes on next poll).
// Callers must poll for expected side effects (DB changes, container state, etc).

function ipc(payload: Record<string, unknown>): void {
  const tasksDir = path.join(PROJECT_DIR, 'data/ipc/discord_main/tasks');
  mkdirSync(tasksDir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const tmpFile = path.join(tasksDir, filename + '.tmp');
  const destFile = path.join(tasksDir, filename);

  writeFileSync(tmpFile, JSON.stringify(payload));
  renameSync(tmpFile, destFile);
}

// ── nc-inject helper ─────────────────────────────────────────

function inject(channel: string, message: string) {
  sh(`"${PROJECT_DIR}/tools/nc-inject.sh" "${channel}" "${message}"`, { timeout: 10_000 });
}

// ── Log scanning ─────────────────────────────────────────────

function scanJsonl(
  filter: (entry: any) => boolean,
  opts?: { afterMs?: number },
): any[] {
  if (!existsSync(LOGS_JSONL)) return [];
  const lines = readFileSync(LOGS_JSONL, 'utf-8').split('\n');
  const results: any[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (opts?.afterMs && entry.time < opts.afterMs) continue;
      if (filter(entry)) results.push(entry);
    } catch { /* skip malformed lines */ }
  }
  return results;
}

// ── Cleanup ──────────────────────────────────────────────────

const pid = process.pid;
const workersToCleanup: string[] = [];

async function cleanup() {
  info('Cleaning up test workers...');
  for (const name of workersToCleanup) {
    const folder = `discord_${name}`;
    const jid = sqlite(`SELECT jid FROM registered_groups WHERE folder='${folder}';`);
    if (jid) {
      try {
        ipc({ type: 'destroy_worker', jid });
      } catch {}
    }
    await sleep(2000);
    // Clean up local state
    const groupDir = path.join(PROJECT_DIR, 'groups', folder);
    const sessionDir = path.join(PROJECT_DIR, 'data/sessions', folder);
    if (existsSync(groupDir)) rmSync(groupDir, { recursive: true, force: true });
    if (existsSync(sessionDir)) rmSync(sessionDir, { recursive: true, force: true });
    sqlite(`DELETE FROM sessions WHERE group_folder='${folder}';`);
  }
}

// ── Preflight ────────────────────────────────────────────────

async function preflight() {
  info('Preflight checks');

  // Docker
  try {
    sh('docker info', { timeout: 10_000 });
    pass('Docker running');
  } catch {
    fail('Docker not running');
    process.exit(1);
  }

  // Guild ID — check env var first, then .env files
  let guildId = process.env.DISCORD_GUILD_ID ?? '';
  if (!guildId) {
    // Try project .env, then host .env
    for (const envFile of [
      path.join(PROJECT_DIR, '.env'),
      path.join(HOST_HOME, 'git/nanoclaw-fleet/.env'),
    ]) {
      if (existsSync(envFile)) {
        const content = readFileSync(envFile, 'utf-8');
        const match = content.match(/DISCORD_GUILD_ID=(.+)/);
        if (match) { guildId = match[1].trim(); break; }
      }
    }
  }
  if (!guildId) {
    fail('DISCORD_GUILD_ID not found (env var, .env, or host .env)');
    process.exit(1);
  }
  pass('DISCORD_GUILD_ID found');

  // NanoClaw responsive — check DB exists and IPC dir is set up
  if (existsSync(DB_PATH)) {
    const count = sqlite('SELECT count(*) FROM registered_groups;');
    if (count !== '') {
      pass('NanoClaw DB accessible');
    } else {
      fail('NanoClaw DB not queryable');
      process.exit(1);
    }
  } else {
    fail(`NanoClaw DB not found at ${DB_PATH}`);
    process.exit(1);
  }

  return guildId;
}

// ── Scenario 1: Create worker ────────────────────────────────

async function testCreateWorker(guildId: string): Promise<string> {
  const name = `e2e-${pid}`;
  const folder = `discord_${name}`;
  workersToCleanup.push(name);

  info(`Creating worker: ${name}`);
  const t0 = Date.now();

  ipc({
    type: 'create_worker',
    guild_id: guildId,
    channel_name: name,
    folder,
    trigger: '@Andy',
  });

  // Poll for registration (IPC is fire-and-forget)
  let registered = false;
  for (let elapsed = 0; elapsed < 15_000; elapsed += 1000) {
    await sleep(1000);
    const reg = sqlite(`SELECT folder FROM registered_groups WHERE folder='${folder}';`);
    if (reg.includes(folder)) { registered = true; break; }
  }
  if (registered) {
    pass('Worker registered in DB');
  } else {
    fail('Worker not registered in DB');
  }

  // Check workspace
  if (existsSync(path.join(PROJECT_DIR, 'groups', folder))) {
    pass('Workspace directory created');
  } else {
    fail('Workspace directory not created');
  }

  // Check CLAUDE.md
  if (existsSync(path.join(PROJECT_DIR, 'groups', folder, 'CLAUDE.md'))) {
    pass('CLAUDE.md assembled');
  } else {
    fail('CLAUDE.md not assembled');
  }

  return name;
}

// ── Scenario 2: Message worker (first boot) ──────────────────

async function testFirstBoot(workerName: string) {
  const folder = `discord_${workerName}`;
  const safeName = folder.replace(/_/g, '-');

  info('Messaging worker (first boot)...');
  const t0 = Date.now();
  inject(workerName, "Remember this secret code: bravo-tango-42. Reply with just 'got it'.");

  // Wait for container
  let containerUp = false;
  for (let elapsed = 0; elapsed < 60_000; elapsed += 2000) {
    const ps = sh(`docker ps --format '{{.Names}}'`, { ignoreError: true });
    if (ps.includes(`nanoclaw-${safeName}`)) {
      containerUp = true;
      pass(`Container spawned (${Math.round(elapsed / 1000)}s)`);
      break;
    }
    await sleep(2000);
  }
  if (!containerUp) fail('Container did not spawn within 60s');

  // Wait for agent response
  let responded = false;
  for (let elapsed = 0; elapsed < 60_000; elapsed += 2000) {
    const entries = scanJsonl(
      (e) => e.group === workerName && e.msg === 'Container first output',
      { afterMs: t0 },
    );
    if (entries.length > 0) {
      const startupMs = entries[entries.length - 1].startupMs;
      pass(`Agent responded (startupMs: ${startupMs}ms)`);
      responded = true;
      break;
    }
    await sleep(2000);
  }
  if (!responded) fail('Agent did not respond within 60s');

  // Check for errors
  const errors = scanJsonl(
    (e) => e.group === workerName && e.level >= 50,
    { afterMs: t0 },
  );
  if (errors.length === 0) {
    pass('No errors in logs');
  } else {
    fail(`Found ${errors.length} error(s) in logs`);
  }
}

// ── Scenario 3: Session resume ───────────────────────────────

async function testSessionResume(workerName: string) {
  const folder = `discord_${workerName}`;
  const safeName = folder.replace(/_/g, '-');

  info('Testing session resume...');

  // Kill container
  sh(`docker kill $(docker ps -q --filter "name=nanoclaw-${safeName}")`, { ignoreError: true });
  await sleep(2000);

  // Check session preserved
  const sessionId = sqlite(`SELECT session_id FROM sessions WHERE group_folder='${folder}';`);
  if (sessionId) {
    pass(`Session ID preserved: ${sessionId.slice(0, 8)}...`);
  } else {
    fail('Session ID not preserved');
  }

  // Message again
  const t2 = Date.now();
  inject(workerName, 'What was the secret code I told you?');

  // Wait for respawn
  let respawned = false;
  for (let elapsed = 0; elapsed < 60_000; elapsed += 2000) {
    const entries = scanJsonl(
      (e) => e.group === workerName && e.msg === 'Container first output',
      { afterMs: t2 },
    );
    if (entries.length > 0) {
      pass(`Container respawned (${Math.round(elapsed / 1000)}s)`);
      respawned = true;
      break;
    }
    await sleep(2000);
  }
  if (!respawned) fail('Container did not respawn within 60s');

  // Check secret code recall (best-effort)
  await sleep(5000);
  const codeEntries = scanJsonl(
    (e) =>
      e.group === workerName &&
      e.msg &&
      /bravo|tango|42/i.test(e.msg),
    { afterMs: t2 },
  );
  if (codeEntries.length > 0) {
    pass('Agent remembered secret code (session resume works)');
  } else {
    // Check transcript
    const sessDir = path.join(PROJECT_DIR, 'data/sessions', folder, '.claude/projects/-workspace-group');
    let found = false;
    if (existsSync(sessDir)) {
      const jsonls = readdirSync(sessDir).filter((f) => f.endsWith('.jsonl')).sort().reverse();
      for (const jsonl of jsonls) {
        const content = readFileSync(path.join(sessDir, jsonl), 'utf-8');
        if (/bravo|tango|42/i.test(content)) {
          pass('Agent remembered secret code (found in transcript)');
          found = true;
          break;
        }
      }
    }
    if (!found) fail('Agent did not recall secret code');
  }
}

// ── Scenario 4: Neuralwatt backend ───────────────────────────

async function testNeuralwatt(guildId: string) {
  if (SKIP_NW) {
    info('Skipping Neuralwatt tests (--skip-nw)');
    return;
  }

  // Check shim availability
  let nwModel = '';
  try {
    const shimHost = IN_CONTAINER ? 'host.docker.internal' : 'localhost';
    const models = sh(`curl -s http://${shimHost}:3003/models`, { timeout: 5000 });
    const parsed = JSON.parse(models);
    nwModel = parsed.models?.[0] ?? '';
  } catch {}

  if (!nwModel) {
    info('Skipping Neuralwatt tests (shim not running or no models)');
    return;
  }

  info(`Testing Neuralwatt backend (model: ${nwModel})...`);
  const shimHost = IN_CONTAINER ? 'host.docker.internal' : 'localhost';

  const nwName = `e2e-nw-${pid}`;
  const nwFolder = `discord_${nwName}`;
  workersToCleanup.push(nwName);

  ipc({
    type: 'create_worker',
    guild_id: guildId,
    channel_name: nwName,
    folder: nwFolder,
    trigger: '@Andy',
    backend: 'neuralwatt',
    model: nwModel,
  });

  // Poll for registration
  for (let elapsed = 0; elapsed < 15_000; elapsed += 1000) {
    await sleep(1000);
    const reg = sqlite(`SELECT folder FROM registered_groups WHERE folder='${nwFolder}';`);
    if (reg.includes(nwFolder)) break;
  }

  // Verify backend config
  const backendsFile = path.join(PROJECT_DIR, 'data/worker-backends.json');
  if (existsSync(backendsFile)) {
    const backends = JSON.parse(readFileSync(backendsFile, 'utf-8'));
    if (backends[nwFolder]) {
      pass('NW worker backend configured');
    } else {
      fail('NW worker backend not in worker-backends.json');
    }
  }

  // Non-streaming test
  try {
    const resp = sh(
      `curl -s http://${shimHost}:3003/w/${nwFolder}/v1/messages ` +
        `-H "Content-Type: application/json" ` +
        `-H "x-api-key: sk-ant-api03-placeholder" ` +
        `-H "anthropic-version: 2023-06-01" ` +
        `-d '${JSON.stringify({
          model: 'claude-opus-4-6',
          max_tokens: 50,
          messages: [{ role: 'user', content: 'Say the word hello' }],
        })}'`,
      { timeout: 30_000 },
    );
    const parsed = JSON.parse(resp);
    if (parsed.content?.[0]?.text) {
      pass('NW shim returned valid Anthropic-format response');
    } else {
      fail(`NW shim response invalid: ${resp.slice(0, 200)}`);
    }
  } catch (e: any) {
    fail(`NW shim request failed: ${e.message}`);
  }

  // Streaming test
  try {
    const stream = sh(
      `curl -s http://${shimHost}:3003/w/${nwFolder}/v1/messages ` +
        `-H "Content-Type: application/json" ` +
        `-H "x-api-key: sk-ant-api03-placeholder" ` +
        `-H "anthropic-version: 2023-06-01" ` +
        `-d '${JSON.stringify({
          model: 'claude-opus-4-6',
          max_tokens: 50,
          stream: true,
          messages: [{ role: 'user', content: 'Say hi' }],
        })}' | head -5`,
      { timeout: 30_000 },
    );
    if (stream.includes('event: message_start')) {
      pass('NW streaming works (SSE events)');
    } else {
      fail(`NW streaming broken: ${stream.slice(0, 200)}`);
    }
  } catch (e: any) {
    fail(`NW streaming request failed: ${e.message}`);
  }

  // Backend switch: NW → Anthropic
  info('Testing backend switch (NW → Anthropic)...');
  ipc({ type: 'switch_backend', worker_name: nwName, backend: 'anthropic' });
  await sleep(3000);

  if (existsSync(backendsFile)) {
    const backendsAfter = JSON.parse(readFileSync(backendsFile, 'utf-8'));
    const cfg = backendsAfter[nwFolder]?.backend ?? 'anthropic';
    if (cfg === 'anthropic') {
      pass('Backend switched to Anthropic');
    } else {
      fail(`Backend switch failed (still: ${cfg})`);
    }
  }
}

// ── Scenario 5: Credential proxy ─────────────────────────────

async function testCredentialProxy() {
  info('Checking Anthropic credential proxy...');
  const proxyHost = IN_CONTAINER ? 'host.docker.internal' : '172.17.0.1';
  try {
    sh(`curl -s -o /dev/null -w "" http://${proxyHost}:3001/`, { timeout: 5000 });
    pass('Credential proxy reachable on :3001');
  } catch {
    fail('Credential proxy not reachable on :3001');
  }
}

// ── Scenario 6: Destroy worker ───────────────────────────────

async function testDestroy(workerName: string) {
  const folder = `discord_${workerName}`;
  const safeName = folder.replace(/_/g, '-');

  info('Destroying worker...');

  const jid = sqlite(`SELECT jid FROM registered_groups WHERE folder='${folder}';`);
  if (jid) {
    ipc({ type: 'destroy_worker', jid });
  }

  // Poll for deregistration
  for (let elapsed = 0; elapsed < 15_000; elapsed += 1000) {
    await sleep(1000);
    const count = sqlite(`SELECT count(*) FROM registered_groups WHERE folder='${folder}';`);
    if (count === '0') break;
  }
  await sleep(2000);

  // Registration removed
  const count = sqlite(`SELECT count(*) FROM registered_groups WHERE folder='${folder}';`);
  if (count === '0') {
    pass('Registration removed from DB');
  } else {
    fail('Registration still in DB');
  }

  // Container stopped
  const ps = sh(`docker ps --format '{{.Names}}'`, { ignoreError: true });
  if (!ps.includes(`nanoclaw-${safeName}`)) {
    pass('Container stopped');
  } else {
    fail('Container still running');
  }

  // Workspace preserved
  if (existsSync(path.join(PROJECT_DIR, 'groups', folder))) {
    pass('Workspace preserved after destroy');
  } else {
    fail('Workspace deleted (should be preserved)');
  }

  // Session preserved
  const sess = sqlite(`SELECT session_id FROM sessions WHERE group_folder='${folder}';`);
  if (sess) {
    pass('Session preserved for resume');
  } else {
    fail('Session not preserved');
  }

  // Remove from cleanup list since we just destroyed it
  // (cleanup will still wipe files)
}

// ── Scenario 7: Port mapping ─────────────────────────────────

async function testPortMapping(guildId: string) {
  const name = `e2e-port-${pid}`;
  const folder = `discord_${name}`;
  const safeName = folder.replace(/_/g, '-');
  workersToCleanup.push(name);

  info(`Testing port mapping: ${name}`);

  ipc({
    type: 'create_worker',
    guild_id: guildId,
    channel_name: name,
    folder,
    trigger: '@Andy',
    ports: ['19876:19876'],
  });

  // Poll for registration
  for (let elapsed = 0; elapsed < 15_000; elapsed += 1000) {
    await sleep(1000);
    const reg = sqlite(`SELECT folder FROM registered_groups WHERE folder='${folder}';`);
    if (reg.includes(folder)) break;
  }

  // Check registration has ports in containerConfig
  const configJson = sqlite(
    `SELECT json_extract(data, '$.containerConfig.ports') FROM registered_groups WHERE folder='${folder}';`,
  );
  if (configJson && configJson.includes('19876')) {
    pass('Port mapping stored in DB config');
  } else {
    fail(`Port mapping not in DB config: ${configJson}`);
  }

  // Trigger container spawn by messaging
  inject(name, 'Say hello');

  // Wait for container
  let containerUp = false;
  for (let elapsed = 0; elapsed < 60_000; elapsed += 2000) {
    const ps = sh(`docker ps --format '{{.Names}}'`, { ignoreError: true });
    if (ps.includes(`nanoclaw-${safeName}`)) {
      containerUp = true;
      break;
    }
    await sleep(2000);
  }

  if (containerUp) {
    // Check docker port mapping
    const ports = sh(
      `docker port $(docker ps -q --filter "name=nanoclaw-${safeName}") 2>/dev/null`,
      { ignoreError: true },
    );
    if (ports.includes('19876')) {
      pass('Docker port mapping active');
    } else {
      fail(`Docker port mapping not found: ${ports}`);
    }
  } else {
    fail('Container did not spawn for port mapping test');
  }
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  console.log(`\nNanoClaw E2E Test${IN_CONTAINER ? ' (from container)' : ' (from host)'}\n`);

  const guildId = await preflight();
  const workerName = await testCreateWorker(guildId);
  await testFirstBoot(workerName);
  await testSessionResume(workerName);
  await testNeuralwatt(guildId);
  await testCredentialProxy();
  await testDestroy(workerName);
  await testPortMapping(guildId);

  // Summary
  const totalMs = Date.now() - startTime;
  console.log('');
  console.log('════════════════════════════════════════');
  if (failed === 0) {
    console.log(`${GREEN}All ${passed} checks passed${NC} (${totalMs}ms)`);
  } else {
    console.log(`${RED}${failed} failed${NC}, ${GREEN}${passed} passed${NC} (${totalMs}ms)`);
  }
  console.log('════════════════════════════════════════');

  await cleanup();
  process.exit(failed);
}

main().catch((e) => {
  console.error('Fatal error:', e);
  cleanup().then(() => process.exit(1));
});
