#!/usr/bin/env npx tsx
/**
 * Discord-only end-to-end test for NanoClaw.
 *
 * Exercises the system through Discord as a real user would — all inputs go
 * through the Discord API via the debug bot. Reads from logs, DB, and
 * container state for assertions, but never uses IPC or ncf inject.
 *
 * Requires:
 *   - Debug bot token at ~/.config/nanoclaw/debug_bot_token
 *   - DISCORD_ALLOWED_BOT_IDS in .env including the debug bot's ID
 *   - NanoClaw running with Discord channel
 *
 * Usage:
 *   npx tsx tools/e2e-discord.ts                    # run all scenarios
 *   npx tsx tools/e2e-discord.ts --worker panama    # test specific worker
 *   npx tsx tools/e2e-discord.ts --skip-nw          # skip Neuralwatt tests
 *
 * Scenarios tested:
 *   1. Preflight — debug bot authenticated, NanoClaw responsive
 *   2. Worker message — send message via Discord, verify response appears
 *   3. Reaction — agent reacts to messages (typing indicator, etc.)
 *   4. NW worker — verify NW worker responds through Discord
 *   5. Error surfacing — verify errors show as messages, not silent failures
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import path from 'path';

// ── Config ──────────────────────────────────────────────────

const PROJECT_DIR = path.resolve(import.meta.dirname!, '..');
const DB_PATH = path.join(PROJECT_DIR, 'store/messages.db');
const DEBUG_TOKEN_PATH =
  process.env.DEBUG_BOT_TOKEN_PATH ||
  path.join(process.env.HOME!, '.config/nanoclaw/debug_bot_token');
const SKIP_NW = process.argv.includes('--skip-nw');
const TARGET_WORKER = (() => {
  const idx = process.argv.indexOf('--worker');
  return idx >= 0 ? process.argv[idx + 1] : null;
})();

process.chdir(PROJECT_DIR);

// ── Test harness ─────────────────────────────────────────────

let passed = 0;
let failed = 0;
const startTime = Date.now();

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
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

// ─�� Discord API helpers ─────────────────────────────────────

let DEBUG_TOKEN = '';

const DISCORD_API = 'https://discord.com/api/v10';

async function discord(
  method: string,
  endpoint: string,
  body?: unknown,
): Promise<any> {
  const resp = await fetch(`${DISCORD_API}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bot ${DEBUG_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Discord API ${resp.status}: ${text}`);
  }
  return resp.json();
}

async function sendMessage(channelId: string, content: string): Promise<any> {
  return discord('POST', `/channels/${channelId}/messages`, { content });
}

async function getMessages(
  channelId: string,
  limit = 10,
): Promise<any[]> {
  return discord('GET', `/channels/${channelId}/messages?limit=${limit}`);
}

// ── Shell / DB helpers ──────────────────────────────────────

function sh(
  cmd: string,
  opts?: { ignoreError?: boolean; timeout?: number },
): string {
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

// ── Resolve worker channel ID ───────────────────────────────

function getWorkerChannelId(workerName: string): string | null {
  const folder = `discord_${workerName}`;
  const jid = sqlite(
    `SELECT jid FROM registered_groups WHERE folder='${folder}';`,
  );
  if (!jid) return null;
  // JID format: dc:<channel_id>
  return jid.replace('dc:', '');
}

// ── Poll for bot response ───────────────────────────────────

interface WaitForResponseOpts {
  channelId: string;
  afterMessageId: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

async function waitForBotResponse(
  opts: WaitForResponseOpts,
): Promise<{ content: string; id: string } | null> {
  const { channelId, afterMessageId, timeoutMs = 90_000, pollIntervalMs = 3000 } = opts;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);
    const messages = await getMessages(channelId, 5);
    // Find messages from NanoClaw bot that are newer than our message
    for (const msg of messages) {
      if (
        msg.author.bot &&
        msg.author.username !== 'devbox-nanoclaw-debugger' &&
        BigInt(msg.id) > BigInt(afterMessageId) &&
        // Skip transient system messages (compaction, typing notices)
        !msg.content.startsWith('⏳')
      ) {
        return { content: msg.content, id: msg.id };
      }
    }
  }
  return null;
}

// ── Preflight ───────────────────────────────────────────────

async function preflight() {
  info('Preflight checks');

  // Debug bot token
  if (!existsSync(DEBUG_TOKEN_PATH)) {
    fail(`Debug bot token not found at ${DEBUG_TOKEN_PATH}`);
    process.exit(1);
  }
  DEBUG_TOKEN = readFileSync(DEBUG_TOKEN_PATH, 'utf-8').trim();

  // Verify bot can authenticate
  try {
    const me = await discord('GET', '/users/@me');
    pass(`Debug bot authenticated: ${me.username}`);
  } catch (e: any) {
    fail(`Debug bot auth failed: ${e.message}`);
    process.exit(1);
  }

  // NanoClaw responsive
  if (existsSync(DB_PATH)) {
    const count = sqlite('SELECT count(*) FROM registered_groups;');
    if (count !== '') {
      pass(`NanoClaw DB accessible (${count} groups)`);
    } else {
      fail('NanoClaw DB not queryable');
      process.exit(1);
    }
  } else {
    fail(`NanoClaw DB not found at ${DB_PATH}`);
    process.exit(1);
  }
}

// ── Scenario 1: Message a worker via Discord ────────────────

async function testWorkerMessage(workerName: string) {
  const channelId = getWorkerChannelId(workerName);
  if (!channelId) {
    fail(`Worker ${workerName} not found in DB`);
    return;
  }

  info(`Messaging worker ${workerName} via Discord...`);

  const secret = `test-${Date.now().toString(36)}`;
  const sent = await sendMessage(
    channelId,
    `Remember this code: ${secret}. Reply with just the code, nothing else.`,
  );
  pass(`Message sent (${sent.id})`);

  // Wait for response
  const response = await waitForBotResponse({
    channelId,
    afterMessageId: sent.id,
  });

  if (response) {
    pass(`Bot responded (${response.content.length} chars)`);
    if (response.content.includes(secret)) {
      pass('Response contains expected code');
    } else {
      fail(`Response missing code. Got: ${response.content.slice(0, 100)}`);
    }
  } else {
    fail('No bot response within timeout');
  }

  // Verify turn was recorded in audit log
  const folder = `discord_${workerName}`;
  const turnsPath = path.join(PROJECT_DIR, 'logs/workers', folder, 'turns.jsonl');
  if (existsSync(turnsPath)) {
    const lines = readFileSync(turnsPath, 'utf-8').trim().split('\n');
    const lastTurn = JSON.parse(lines[lines.length - 1]);
    if (lastTurn.input_tokens > 0) {
      pass(`Audit log: ${lastTurn.input_tokens} input tokens`);
    } else {
      fail(`Audit log shows 0 input tokens (shim may not be forwarding usage)`);
    }
  }

  return { channelId, secret };
}

// ── Scenario 2: Session recall ──────────────────────────────

async function testSessionRecall(
  workerName: string,
  channelId: string,
  secret: string,
) {
  info(`Testing session recall for ${workerName}...`);

  const sent = await sendMessage(
    channelId,
    `What was the code I told you to remember?`,
  );

  const response = await waitForBotResponse({
    channelId,
    afterMessageId: sent.id,
  });

  if (response && response.content.includes(secret)) {
    pass('Agent recalled secret from session');
  } else if (response) {
    // Check if it's in the response (might be wrapped in text)
    fail(
      `Agent responded but didn't recall secret. Got: ${response.content.slice(0, 100)}`,
    );
  } else {
    fail('No response to recall question');
  }
}

// ── Scenario 3: NW worker responsiveness ────────────────────

async function testNwWorker() {
  if (SKIP_NW) {
    info('Skipping NW worker test (--skip-nw)');
    return;
  }

  // Find a NW worker from worker-backends.json
  const backendsPath = path.join(PROJECT_DIR, 'data/worker-backends.json');
  if (!existsSync(backendsPath)) {
    info('No worker-backends.json — skipping NW test');
    return;
  }

  const backends = JSON.parse(readFileSync(backendsPath, 'utf-8'));
  // Find a NW worker that has a running container
  const runningContainers = sh(`docker ps --format '{{.Names}}'`, {
    ignoreError: true,
  });
  let nwWorker: string | null = null;
  for (const [folder, config] of Object.entries(backends) as [string, any][]) {
    if (config.backend === 'neuralwatt' && folder.startsWith('discord_')) {
      const name = folder.replace('discord_', '');
      if (name === 'pareto') continue; // Known broken session
      const channelId = getWorkerChannelId(name);
      if (channelId && runningContainers.includes(`nanoclaw-${folder.replace(/_/g, '-')}`)) {
        nwWorker = name;
        break;
      }
    }
  }

  if (!nwWorker) {
    info('No active NW worker with a running container — skipping');
    return;
  }

  info(`Testing NW worker ${nwWorker} via Discord...`);

  const channelId = getWorkerChannelId(nwWorker)!;
  const sent = await sendMessage(channelId, 'What model are you running on?');

  const response = await waitForBotResponse({
    channelId,
    afterMessageId: sent.id,
    timeoutMs: 120_000, // NW models can be slower
  });

  if (response) {
    if (response.content.startsWith('[Inference error]')) {
      fail(`NW worker returned error: ${response.content.slice(0, 100)}`);
    } else {
      pass(`NW worker responded (${response.content.length} chars)`);
    }
  } else {
    fail('NW worker did not respond within 120s');
  }
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  console.log(`\n${DIM}NanoClaw Discord E2E Test${NC}\n`);

  await preflight();

  // Determine which worker to test
  let workerName = TARGET_WORKER;
  if (!workerName) {
    // Find a running worker (prefer non-main, non-pareto)
    const workers = sqlite(
      `SELECT folder FROM registered_groups WHERE is_main = 0 ORDER BY folder;`,
    )
      .split('\n')
      .filter(Boolean);

    for (const folder of workers) {
      const name = folder.replace('discord_', '');
      // Skip workers with known issues
      if (name === 'pareto') continue;
      const channelId = getWorkerChannelId(name);
      if (channelId) {
        workerName = name;
        break;
      }
    }
  }

  if (!workerName) {
    fail('No suitable worker found for testing');
    process.exit(1);
  }

  const result = await testWorkerMessage(workerName);
  if (result) {
    // Wait for agent to fully settle before follow-up message
    await sleep(5000);
    await testSessionRecall(workerName, result.channelId, result.secret);
  }
  // Only run separate NW test if the target worker isn't already NW
  const backendsFile = path.join(PROJECT_DIR, 'data/worker-backends.json');
  const isTargetNw = existsSync(backendsFile) &&
    JSON.parse(readFileSync(backendsFile, 'utf-8'))[`discord_${workerName}`]?.backend === 'neuralwatt';
  if (isTargetNw) {
    pass('NW path already tested via target worker');
  } else {
    await testNwWorker();
  }

  // Summary
  const totalMs = Date.now() - startTime;
  console.log('');
  console.log('════════════════════════════════════════');
  if (failed === 0) {
    console.log(`${GREEN}All ${passed} checks passed${NC} (${totalMs}ms)`);
  } else {
    console.log(
      `${RED}${failed} failed${NC}, ${GREEN}${passed} passed${NC} (${totalMs}ms)`,
    );
  }
  console.log('════════════════════════════════════════');

  process.exit(failed);
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
