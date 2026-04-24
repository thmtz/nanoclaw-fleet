/**
 * Discord inbound E2E — real Discord path, not CLI.
 *
 * Uses a separate "debug bot" (token at ~/.config/nanoclaw/debug_bot_token)
 * to post into the master channel as a "user" message, then watches the
 * channel for a reply from the NanoClaw bot. The debug bot must be
 * allowlisted via DISCORD_ALLOWED_BOT_IDS so the SDK's bot-author filter
 * doesn't drop it.
 *
 * Assumes a running NanoClaw host with Discord master seeded via
 * scripts/init-fleet-master-discord.ts.
 *
 * Env:
 *   DISCORD_MASTER_CHANNEL_ID   — channel to post into (required)
 *   DEBUG_BOT_TOKEN_PATH         — defaults to ~/.config/nanoclaw/debug_bot_token
 *   NANOCLAW_BOT_USERNAME       — defaults to "NanoClaw"
 *   REPLY_TIMEOUT_MS             — defaults to 120000
 *
 * Usage:
 *   DISCORD_MASTER_CHANNEL_ID=<channel_id> \
 *   pnpm exec tsx scripts/test-fleet-discord-inbound.ts
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { readEnvFile } from '../src/env.js';

const REPLY_TIMEOUT_MS = parseInt(process.env.REPLY_TIMEOUT_MS ?? '120000', 10);
const BOT_USERNAME = process.env.NANOCLAW_BOT_USERNAME ?? 'NanoClaw';
const DEBUG_BOT_TOKEN_PATH = process.env.DEBUG_BOT_TOKEN_PATH ?? path.join(os.homedir(), '.config/nanoclaw/debug_bot_token');

interface DiscordMessage {
  id: string;
  author: { id: string; username: string };
  content: string;
  timestamp: string;
}

async function getMessages(channelId: string, botToken: string, after?: string): Promise<DiscordMessage[]> {
  const url = new URL(`https://discord.com/api/v10/channels/${channelId}/messages`);
  url.searchParams.set('limit', '20');
  if (after) url.searchParams.set('after', after);
  const res = await fetch(url.toString(), { headers: { Authorization: `Bot ${botToken}` } });
  if (!res.ok) throw new Error(`get messages failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as DiscordMessage[];
}

async function postMessage(channelId: string, debugToken: string, content: string): Promise<string> {
  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${debugToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error(`post message failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { id: string };
  return body.id;
}

async function waitForReply(
  channelId: string,
  botToken: string,
  afterMessageId: string,
  fromUsername: string,
  timeoutMs: number,
  matcher: RegExp,
): Promise<DiscordMessage> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const msgs = await getMessages(channelId, botToken, afterMessageId);
    const candidate = msgs
      .filter((m) => m.author.username === fromUsername && matcher.test(m.content))
      // Discord returns newest-first; reverse so earliest-matching is returned.
      .reverse()[0];
    if (candidate) return candidate;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`no reply from ${fromUsername} matching ${matcher} within ${timeoutMs}ms`);
}

async function main(): Promise<void> {
  const channelId = process.env.DISCORD_MASTER_CHANNEL_ID;
  if (!channelId) {
    console.error('Missing DISCORD_MASTER_CHANNEL_ID');
    process.exit(2);
  }

  const env = readEnvFile(['DISCORD_BOT_TOKEN', 'DISCORD_ALLOWED_BOT_IDS']);
  const botToken = env.DISCORD_BOT_TOKEN ?? process.env.DISCORD_BOT_TOKEN;
  if (!botToken) {
    console.error('Missing DISCORD_BOT_TOKEN (set in .env)');
    process.exit(2);
  }
  if (!env.DISCORD_ALLOWED_BOT_IDS && !process.env.DISCORD_ALLOWED_BOT_IDS) {
    console.warn('Warning: DISCORD_ALLOWED_BOT_IDS not set — debug bot messages will be filtered.');
  }

  if (!fs.existsSync(DEBUG_BOT_TOKEN_PATH)) {
    console.error(`debug bot token file not found: ${DEBUG_BOT_TOKEN_PATH}`);
    process.exit(2);
  }
  const debugToken = fs.readFileSync(DEBUG_BOT_TOKEN_PATH, 'utf-8').trim();

  console.log('== Fleet Discord inbound E2E ==');
  console.log(`  channel: ${channelId}`);
  console.log(`  bot username expected: ${BOT_USERNAME}`);
  console.log(`  reply timeout: ${REPLY_TIMEOUT_MS}ms`);

  // Step 1 — baseline: plain ping, expect any response
  const marker = `ping-${Date.now()}`;
  const prompt = `Reply with exactly the word pong and include the marker ${marker}.`;
  console.log(`\n[1] Posting prompt as debug bot: ${prompt.slice(0, 80)}`);
  const postedId = await postMessage(channelId, debugToken, prompt);
  console.log(`  posted: ${postedId}`);

  console.log(`\n[2] Waiting for ${BOT_USERNAME} to reply with marker ${marker}`);
  const reply = await waitForReply(
    channelId,
    botToken,
    postedId,
    BOT_USERNAME,
    REPLY_TIMEOUT_MS,
    new RegExp(marker),
  );
  console.log(`  got reply (${reply.id}): ${reply.content.slice(0, 120)}`);

  if (!/pong/i.test(reply.content)) {
    console.warn('  note: reply did not contain "pong" — master probably rephrased. Marker matched which is enough.');
  }

  console.log('\n== PASSED ==');
}

main().catch((err) => {
  console.error('\nDiscord inbound E2E failed:', err);
  process.exit(1);
});
