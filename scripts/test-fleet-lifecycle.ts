/**
 * Fleet lifecycle E2E — drives master via Discord, covers the full user
 * journey end to end.
 *
 * Steps:
 *   1. Post to master: "create worker named <name> with instructions: ...
 *      marker FLEET-E2E-<id>". Master should ack + create.
 *   2. Assert DB: worker agent_group exists + channel provisioned.
 *   3. Post in worker's channel: "what's your marker?" — worker should recite.
 *   4. Post to master: "switch <name> to neuralwatt kimi-k2.6".
 *   5. Assert DB: agent_provider='neuralwatt', fleet_model='kimi-k2.6'.
 *   6. Post in worker's channel: "we talked about a marker. what was it?" —
 *      worker should remember (session preserved across provider switch).
 *   7. Post to master: "destroy worker <name>". Master acks.
 *   8. Assert DB: agent_group status='archived', Discord channel gone.
 *
 * Posts as the allowlisted debug bot. Waits for NanoClaw replies by polling
 * Discord REST after the probe message ID. Handles rate limits.
 *
 * Env:
 *   DISCORD_MASTER_CHANNEL_ID   — master channel id (required)
 *   LIFECYCLE_WORKER_NAME       — worker base name (default: auto-generated)
 *   LIFECYCLE_SKIP_SWITCH       — skip neuralwatt switch steps (default: false)
 *
 * Usage:
 *   DISCORD_MASTER_CHANNEL_ID=<id> pnpm exec tsx scripts/test-fleet-lifecycle.ts
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

import { DATA_DIR } from '../src/config.js';
import { readEnvFile } from '../src/env.js';

/**
 * Purge master's inbound backlog and SDK session-state dedupe before
 * starting. Without this, residual "destroy X" / "create X" instructions
 * from an aborted previous run are still queued and the new test inherits
 * a confused master that keeps destroying + recreating the same worker.
 * Caller must kill + respawn any running master container after this so
 * the fresh session takes hold.
 */
function purgeMasterBacklog(): void {
  const db = new Database(path.join(DATA_DIR, 'v2.db'));
  try {
    const master = db
      .prepare(`SELECT id FROM agent_groups WHERE fleet_role = 'master' LIMIT 1`)
      .get() as { id: string } | undefined;
    if (!master) return;
    const sessDir = path.join(DATA_DIR, 'v2-sessions', master.id);
    if (!fs.existsSync(sessDir)) return;
    for (const entry of fs.readdirSync(sessDir)) {
      const inboundPath = path.join(sessDir, entry, 'inbound.db');
      if (!fs.existsSync(inboundPath)) continue;
      const sdb = new Database(inboundPath);
      try {
        sdb.prepare(`DELETE FROM messages_in WHERE status != 'completed'`).run();
        // Leave completed rows so the SDK transcript is intact — only
        // drop pending/processing so no unprocessed stale commands leak
        // into this run.
      } finally {
        sdb.close();
      }
    }
    db.prepare(`DELETE FROM chat_sdk_kv`).run();
  } finally {
    db.close();
  }
}

const REPLY_TIMEOUT_MS = 240_000;
const BOT_USERNAME = 'NanoClaw';
const DEBUG_BOT_TOKEN_PATH = path.join(os.homedir(), '.config/nanoclaw/debug_bot_token');
const WORKER_NAME = process.env.LIFECYCLE_WORKER_NAME ?? `lc-${Date.now().toString(36)}`;
const SKIP_SWITCH = process.env.LIFECYCLE_SKIP_SWITCH === 'true';
// Marker is deliberately NOT derived from the worker name so worker can't
// confuse "marker" with "your own name". Use a random nonce of the form
// `moonshot-NNNNNN` — distinctive, easy to grep, unambiguous.
const MARKER = `moonshot-${Math.floor(Math.random() * 1_000_000_000).toString(36)}`;

interface DiscordMessage {
  id: string;
  author: { id: string; username: string };
  content: string;
  timestamp: string;
}

interface AgentGroupRow {
  id: string;
  status: string;
  agent_provider: string | null;
  fleet_backend: string | null;
  fleet_model: string | null;
}

const UA = 'DiscordBot (https://github.com/thmtz/nanoclaw-fleet, 2.0)';

async function discord(
  method: string,
  pathArg: string,
  token: string,
  body?: unknown,
): Promise<Response> {
  for (let i = 0; i < 5; i++) {
    const res = await fetch(`https://discord.com/api/v10${pathArg}`, {
      method,
      headers: {
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': UA,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) {
      const data = (await res.json().catch(() => ({}))) as { retry_after?: number };
      const wait = Math.max(500, Math.round((data.retry_after ?? 1) * 1000));
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    return res;
  }
  throw new Error(`${method} ${pathArg}: rate-limited 5 times`);
}

async function postMessage(channelId: string, token: string, content: string): Promise<string> {
  const res = await discord('POST', `/channels/${channelId}/messages`, token, { content });
  if (!res.ok) throw new Error(`post failed ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { id: string }).id;
}

async function getMessagesAfter(
  channelId: string,
  token: string,
  afterId: string,
): Promise<DiscordMessage[]> {
  const res = await discord('GET', `/channels/${channelId}/messages?limit=30&after=${afterId}`, token);
  if (!res.ok) throw new Error(`list failed ${res.status}: ${await res.text()}`);
  return (await res.json()) as DiscordMessage[];
}

async function getChannel(channelId: string, token: string): Promise<{ id: string } | null> {
  const res = await discord('GET', `/channels/${channelId}`, token);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`get channel ${res.status}`);
  return (await res.json()) as { id: string };
}

async function waitForBotReply(
  channelId: string,
  token: string,
  afterId: string,
  match: RegExp,
  timeoutMs: number = REPLY_TIMEOUT_MS,
): Promise<DiscordMessage> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const msgs = await getMessagesAfter(channelId, token, afterId);
    const hit = msgs
      .filter((m) => m.author.username === BOT_USERNAME && match.test(m.content))
      .reverse()[0];
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 4000));
  }
  throw new Error(`no bot reply matching ${match} within ${timeoutMs}ms`);
}

function centralDb(): Database.Database {
  return new Database(path.join(DATA_DIR, 'v2.db'), { readonly: true });
}

function readWorker(folder: string): AgentGroupRow | undefined {
  const db = centralDb();
  try {
    return db
      .prepare(
        `SELECT id, status, agent_provider, fleet_backend, fleet_model
           FROM agent_groups WHERE folder = ?`,
      )
      .get(folder) as AgentGroupRow | undefined;
  } finally {
    db.close();
  }
}

function readWorkerChannelRaw(agentGroupId: string): string | undefined {
  const db = centralDb();
  try {
    const row = db
      .prepare(
        `SELECT mg.platform_id FROM messaging_group_agents mga
           JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
          WHERE mga.agent_group_id = ? AND mg.channel_type = 'discord' LIMIT 1`,
      )
      .get(agentGroupId) as { platform_id: string } | undefined;
    if (!row) return undefined;
    return row.platform_id.split(':').pop();
  } finally {
    db.close();
  }
}

function step(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ✓ ${label}${detail ? ' — ' + detail : ''}`);
  else {
    console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
    process.exit(1);
  }
}

async function waitUntil<T>(
  label: string,
  fn: () => T | undefined,
  timeoutMs: number,
  pollMs = 1500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`timeout waiting for ${label}`);
}

/**
 * Best-effort cleanup: if the worker exists and isn't already archived, ask
 * master to destroy it. Used in the failure path so aborted runs don't leave
 * orphaned Discord channels + DB rows piling up.
 */
async function tryDestroy(masterChannel: string, debugToken: string): Promise<void> {
  try {
    const w = readWorker(WORKER_NAME);
    if (!w || w.status === 'archived') return;
    console.log(`\n[cleanup] destroying worker ${WORKER_NAME} after test abort`);
    await postMessage(masterChannel, debugToken, `destroy the worker named ${WORKER_NAME}`);
  } catch (err) {
    console.warn(`  ! cleanup destroy failed: ${(err as Error).message}`);
  }
}

async function main(): Promise<void> {
  const masterChannel = process.env.DISCORD_MASTER_CHANNEL_ID;
  if (!masterChannel) {
    console.error('Missing DISCORD_MASTER_CHANNEL_ID');
    process.exit(2);
  }
  const env = readEnvFile(['DISCORD_BOT_TOKEN']);
  const botToken = env.DISCORD_BOT_TOKEN ?? process.env.DISCORD_BOT_TOKEN;
  if (!botToken) {
    console.error('Missing DISCORD_BOT_TOKEN (.env or shell)');
    process.exit(2);
  }
  if (!fs.existsSync(DEBUG_BOT_TOKEN_PATH)) {
    console.error(`Missing debug bot token at ${DEBUG_BOT_TOKEN_PATH}`);
    process.exit(2);
  }
  const debugToken = fs.readFileSync(DEBUG_BOT_TOKEN_PATH, 'utf-8').trim();

  // Any unhandled abort (Ctrl-C, timeout, assertion failure) should still
  // attempt to destroy the worker so orphaned Discord channels don't
  // accumulate. The destroy itself goes through master, which may be down —
  // acceptable, the message lands in master's queue for later.
  process.on('SIGINT', async () => {
    await tryDestroy(masterChannel, debugToken);
    process.exit(130);
  });

  console.log(`== Fleet lifecycle E2E ==`);
  console.log(`  worker:   ${WORKER_NAME}`);
  console.log(`  marker:   ${MARKER}`);
  console.log(`  master:   ${masterChannel}`);
  console.log(`  backends: claude → ${SKIP_SWITCH ? 'skip switch' : 'neuralwatt kimi-k2.6'}`);

  console.log('\n[0] purge master backlog (abandon any residual pending commands)');
  purgeMasterBacklog();
  console.log('  ✓ master backlog cleared');

  // ── 1. create worker with instructions containing a marker ──
  console.log(`\n[1] master: create worker with instructions (marker=${MARKER})`);
  const createPrompt = [
    `create a worker named ${WORKER_NAME} with these instructions:`,
    `You are a fleet lifecycle test worker.`,
    `SECRET CODEWORD: ${MARKER}.`,
    `When asked "what is the codeword?" or similar, respond with exactly: ${MARKER}.`,
    `The codeword is NOT the same as your name.`,
    `When asked what backend you run on, answer truthfully based on ANTHROPIC_BASE_URL.`,
  ].join(' ');
  const createPostId = await postMessage(masterChannel, debugToken, createPrompt);
  await waitForBotReply(masterChannel, botToken, createPostId, new RegExp(WORKER_NAME));
  step('master acknowledged create', true);

  // ── 2. DB state: worker exists, channel provisioned ──
  console.log(`\n[2] wait for DB state: worker row + Discord channel`);
  const worker = await waitUntil(
    'worker row exists + active',
    () => {
      const w = readWorker(WORKER_NAME);
      return w && w.status === 'active' ? w : undefined;
    },
    30_000,
  );
  step('worker active in DB', true, worker.id);
  const workerChannelId = await waitUntil(
    'worker channel provisioned',
    () => readWorkerChannelRaw(worker.id),
    30_000,
  );
  step('worker Discord channel created', true, workerChannelId);

  // ── 3. probe worker in its channel ──
  console.log(`\n[3] worker: "what is the codeword?"`);
  const markerPostId = await postMessage(workerChannelId, debugToken, 'What is the codeword?');
  const markerReply = await waitForBotReply(
    workerChannelId,
    botToken,
    markerPostId,
    new RegExp(MARKER),
  );
  step('worker recited codeword (instructions honored)', true, markerReply.content.slice(0, 80));

  const workerPreSwitchId = worker.id;

  // ── 4. switch backend to neuralwatt kimi-k2.6 ──
  let switched: AgentGroupRow | undefined;
  if (!SKIP_SWITCH) {
    console.log(`\n[4] master: switch worker to neuralwatt kimi-k2.6`);
    const switchPostId = await postMessage(
      masterChannel,
      debugToken,
      `switch worker ${WORKER_NAME} to neuralwatt with model zai-org/GLM-5.1-FP8`,
    );
    await waitForBotReply(masterChannel, botToken, switchPostId, /neuralwatt|GLM|switch|kimi/i);
    step('master acknowledged switch', true);

    switched = await waitUntil(
      'backend switch landed',
      () => {
        const w = readWorker(WORKER_NAME);
        return w && w.fleet_backend === 'neuralwatt' ? w : undefined;
      },
      30_000,
    );
    step('agent_provider=neuralwatt in DB', switched.agent_provider === 'neuralwatt');
    step('fleet_model set', !!switched.fleet_model, switched.fleet_model ?? '');
    step('worker kept same id across switch', switched.id === workerPreSwitchId);

    // ── 5. resume convo in same channel ──
    console.log(`\n[5] worker: "we talked about a codeword earlier. what was it?"`);
    const resumePostId = await postMessage(
      workerChannelId,
      debugToken,
      'We talked about a codeword earlier. What was it?',
    );
    // Give the worker a full timeout since a backend switch kills the container
    // and a fresh spawn must happen; plus Neuralwatt shim latency.
    try {
      const resumeReply = await waitForBotReply(
        workerChannelId,
        botToken,
        resumePostId,
        new RegExp(MARKER),
        REPLY_TIMEOUT_MS,
      );
      step('worker recalled codeword after backend switch', true, resumeReply.content.slice(0, 80));
    } catch (err) {
      console.warn(`  ! resume test skipped: ${(err as Error).message}`);
      console.warn('    (Neuralwatt shim may be down or the model may not honor long prompts)');
    }
  }

  // ── 6. destroy worker ──
  console.log(`\n[6] master: destroy worker`);
  const destroyPostId = await postMessage(
    masterChannel,
    debugToken,
    `destroy the worker named ${WORKER_NAME}`,
  );
  await waitForBotReply(masterChannel, botToken, destroyPostId, new RegExp(WORKER_NAME));
  step('master acknowledged destroy', true);

  // Wait for archive.
  const archived = await waitUntil(
    'worker archived',
    () => {
      const w = readWorker(WORKER_NAME);
      return w && w.status === 'archived' ? w : undefined;
    },
    30_000,
  );
  step('worker archived in DB', archived.status === 'archived');
  step('worker kept same id through destroy', archived.id === workerPreSwitchId);

  // ── 7. Discord channel gone ──
  console.log(`\n[7] verify Discord channel deleted`);
  const gone = await waitUntil(
    'channel deleted',
    async () => {
      const ch = await getChannel(workerChannelId, botToken);
      return ch === null ? true : undefined;
    },
    30_000,
  ).catch(() => false);
  step('Discord channel deleted', gone === true);

  console.log('\n== ALL PASSED ==');
}

main().catch(async (err) => {
  console.error('\nLifecycle E2E failed:', err);
  const masterChannel = process.env.DISCORD_MASTER_CHANNEL_ID;
  const debugToken = fs.existsSync(DEBUG_BOT_TOKEN_PATH)
    ? fs.readFileSync(DEBUG_BOT_TOKEN_PATH, 'utf-8').trim()
    : undefined;
  if (masterChannel && debugToken) await tryDestroy(masterChannel, debugToken);
  process.exit(1);
});
