/**
 * Full Discord E2E — exercise master via Discord, verify worker lifecycle.
 *
 * Posts commands to the master channel as a debug bot (allowlisted via
 * DISCORD_ALLOWED_BOT_IDS) and asserts:
 *   1. master replies to a simple prompt
 *   2. "create worker named <name>" creates an agent_group + Discord channel
 *   3. Sent to the new channel, worker replies
 *   4. "destroy worker named <name>" archives the group + deletes channel
 *   5. "create worker named <name>" on the archived name resumes (same id)
 *
 * Requires:
 *   - running v2 host with Discord wiring seeded
 *   - DISCORD_ALLOWED_BOT_IDS in .env listing the debug bot's id
 *   - working Anthropic creds in the container
 *
 * Env:
 *   DISCORD_MASTER_CHANNEL_ID   — channel to post into (required)
 *
 * Usage:
 *   DISCORD_MASTER_CHANNEL_ID=<id> pnpm exec tsx scripts/test-fleet-discord-full.ts
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

import { DATA_DIR } from '../src/config.js';
import { readEnvFile } from '../src/env.js';

const REPLY_TIMEOUT_MS = 180_000;
const BOT_USERNAME = 'NanoClaw';
const DEBUG_BOT_TOKEN_PATH = path.join(os.homedir(), '.config/nanoclaw/debug_bot_token');
const WORKER_NAME = `e2e-${Date.now().toString(36)}`;

interface DiscordMessage {
  id: string;
  author: { id: string; username: string };
  content: string;
}

async function postMessage(channelId: string, token: string, content: string): Promise<string> {
  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error(`post failed ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { id: string };
  return body.id;
}

async function getMessagesAfter(channelId: string, token: string, afterId: string): Promise<DiscordMessage[]> {
  const url = new URL(`https://discord.com/api/v10/channels/${channelId}/messages`);
  url.searchParams.set('limit', '20');
  url.searchParams.set('after', afterId);
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url.toString(), { headers: { Authorization: `Bot ${token}` } });
    if (res.status === 429) {
      const body = (await res.json().catch(() => ({}))) as { retry_after?: number };
      const wait = Math.max(500, Math.round((body.retry_after ?? 1) * 1000));
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) throw new Error(`list failed ${res.status}: ${await res.text()}`);
    return (await res.json()) as DiscordMessage[];
  }
  throw new Error('list failed: rate-limited 5 times');
}

async function waitForBotReply(
  channelId: string,
  token: string,
  afterId: string,
  match: RegExp,
  timeoutMs: number,
): Promise<DiscordMessage> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const msgs = await getMessagesAfter(channelId, token, afterId);
    const hit = msgs
      .filter((m) => m.author.username === BOT_USERNAME && match.test(m.content))
      .reverse()[0];
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`no bot reply matching ${match} within ${timeoutMs}ms`);
}

function db(): Database.Database {
  return new Database(path.join(DATA_DIR, 'v2.db'), { readonly: true });
}

function readWorker(folder: string): { id: string; status: string } | undefined {
  const h = db();
  try {
    return h.prepare('SELECT id, status FROM agent_groups WHERE folder = ?').get(folder) as
      | { id: string; status: string }
      | undefined;
  } finally {
    h.close();
  }
}

function readWorkerChannel(agentGroupId: string): string | undefined {
  const h = db();
  try {
    const row = h
      .prepare(
        `SELECT mg.platform_id FROM messaging_group_agents mga
           JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
          WHERE mga.agent_group_id = ? AND mg.channel_type = 'discord' LIMIT 1`,
      )
      .get(agentGroupId) as { platform_id: string } | undefined;
    if (!row) return undefined;
    // Platform_id is `discord:<guild>:<channel>`. Return raw channel id.
    return row.platform_id.split(':').pop();
  } finally {
    h.close();
  }
}

function step(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ✓ ${label}${detail ? ' — ' + detail : ''}`);
  else {
    console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
    process.exit(1);
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
    console.error('Missing DISCORD_BOT_TOKEN');
    process.exit(2);
  }
  if (!fs.existsSync(DEBUG_BOT_TOKEN_PATH)) {
    console.error(`Missing debug bot token at ${DEBUG_BOT_TOKEN_PATH}`);
    process.exit(2);
  }
  const debugToken = fs.readFileSync(DEBUG_BOT_TOKEN_PATH, 'utf-8').trim();

  console.log(`== Fleet Discord full E2E (worker=${WORKER_NAME}) ==\n`);

  console.log('[1] Master replies to chat');
  const helloMarker = `hello-${Date.now()}`;
  const helloId = await postMessage(
    masterChannel,
    debugToken,
    `Say back exactly the marker ${helloMarker} and nothing else.`,
  );
  const helloReply = await waitForBotReply(masterChannel, botToken, helloId, new RegExp(helloMarker), REPLY_TIMEOUT_MS);
  step('master reply contains marker', /./.test(helloReply.content), helloReply.content.slice(0, 60));

  console.log('\n[2] create worker');
  const createId = await postMessage(masterChannel, debugToken, `create a worker named ${WORKER_NAME}`);
  const createReply = await waitForBotReply(
    masterChannel,
    botToken,
    createId,
    new RegExp(WORKER_NAME),
    REPLY_TIMEOUT_MS,
  );
  step('master acknowledges create', /./.test(createReply.content), createReply.content.slice(0, 80));

  // Wait briefly then check DB.
  await new Promise((r) => setTimeout(r, 4000));
  const worker = readWorker(WORKER_NAME);
  step('worker row exists', worker !== undefined, worker?.id);
  step('worker active', worker?.status === 'active');

  const workerChannel = readWorkerChannel(worker!.id);
  step('worker discord channel provisioned', !!workerChannel, workerChannel);

  console.log('\n[3] Worker responds in its own channel');
  const workerPrompt = `worker-ping-${Date.now()}`;
  const workerPostId = await postMessage(
    workerChannel!,
    debugToken,
    `Reply with only the marker ${workerPrompt}`,
  );
  const workerReply = await waitForBotReply(
    workerChannel!,
    botToken,
    workerPostId,
    new RegExp(workerPrompt),
    REPLY_TIMEOUT_MS,
  );
  step('worker replies with marker', /./.test(workerReply.content), workerReply.content.slice(0, 80));

  console.log('\n[4] destroy worker');
  const destroyId = await postMessage(masterChannel, debugToken, `destroy the worker named ${WORKER_NAME}`);
  await waitForBotReply(masterChannel, botToken, destroyId, new RegExp(WORKER_NAME), REPLY_TIMEOUT_MS);
  await new Promise((r) => setTimeout(r, 6000));
  const archived = readWorker(WORKER_NAME);
  step('worker archived', archived?.status === 'archived');
  step('worker kept same id', archived?.id === worker?.id);

  console.log('\n[5] resume worker (create on archived name)');
  const resumeId = await postMessage(masterChannel, debugToken, `create a worker named ${WORKER_NAME}`);
  await waitForBotReply(masterChannel, botToken, resumeId, new RegExp(WORKER_NAME), REPLY_TIMEOUT_MS);
  await new Promise((r) => setTimeout(r, 6000));
  const resumed = readWorker(WORKER_NAME);
  step('worker reactivated', resumed?.status === 'active');
  step('worker kept same id after resume', resumed?.id === worker?.id);
  const newChannel = readWorkerChannel(resumed!.id);
  step('fresh discord channel reprovisioned', !!newChannel && newChannel !== workerChannel, newChannel);

  console.log('\n[6] cleanup');
  const cleanupId = await postMessage(masterChannel, debugToken, `destroy the worker named ${WORKER_NAME}`);
  await waitForBotReply(masterChannel, botToken, cleanupId, new RegExp(WORKER_NAME), REPLY_TIMEOUT_MS);
  step('cleanup acknowledged', true);

  console.log('\n== ALL PASSED ==');
}

main().catch((err) => {
  console.error('\nDiscord full E2E failed:', err);
  process.exit(1);
});
