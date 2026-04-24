/**
 * Live-container E2E for the fleet module.
 *
 * Talks to a running NanoClaw host via the CLI Unix socket, exercising the
 * full master→MCP→system-action→handler→container stack. Assumes:
 *   - v2 host is running (`pnpm run dev`)
 *   - Fleet master is seeded (`pnpm exec tsx scripts/init-fleet-master.ts`)
 *   - CLI channel is wired to the master
 *   - Valid Anthropic creds in .env (CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY)
 *
 * Covers:
 *   1. Master responds to chat
 *   2. "create worker named X" → agent_group + folder + container.json + (optional) Discord channel
 *   3. Master → worker agent-to-agent (send "reply pong", verify worker container spawns + replies)
 *   4. "list workers" → master gets the list in a follow-up message
 *   5. "destroy X" → agent_group archived, Discord channel removed
 *   6. "create worker named X" again → resumes same agent_group id
 *
 * Prints PASS / FAIL for each step. Exits non-zero on any failure.
 *
 * Usage:
 *   pnpm exec tsx scripts/test-fleet-live.ts [--keep]
 *
 * --keep  leave the smoke-test worker around after the run (defaults to cleanup)
 */
import net from 'net';
import path from 'path';
import Database from 'better-sqlite3';

import { DATA_DIR } from '../src/config.js';
import { readEnvFile } from '../src/env.js';

// Hydrate process.env with values from .env so the Discord check can detect a
// configured guild without the caller having to re-export them. The host
// already reads from .env via readEnvFile internally; replicating that here
// keeps the harness useful whether it's run via systemd (env-loaded) or
// directly via tsx (not).
for (const key of ['DISCORD_GUILD_ID', 'DISCORD_FLEET_CATEGORY_ID', 'DISCORD_BOT_TOKEN']) {
  if (!process.env[key]) {
    const val = readEnvFile([key])[key];
    if (val) process.env[key] = val;
  }
}

const WORKER_NAME = 'fleet-e2e-smoke';
const OVERALL_TIMEOUT_MS = 300_000;
const REPLY_TIMEOUT_MS = 90_000;

interface CliReply {
  text: string;
}

function socketPath(): string {
  return path.join(DATA_DIR, 'cli.sock');
}

function centralDbPath(): string {
  return path.join(DATA_DIR, 'v2.db');
}

/**
 * Send one line over the CLI socket, collect reply lines until `idle` ms have
 * passed with no new data. Returns every text field the daemon wrote back.
 */
async function chatRequest(text: string, idleMs = 4000, timeoutMs = REPLY_TIMEOUT_MS): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const replies: string[] = [];
    const sock = net.connect(socketPath());
    let buffer = '';
    let idleTimer: NodeJS.Timeout | null = null;
    let hardTimer: NodeJS.Timeout | null = null;

    const done = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      if (hardTimer) clearTimeout(hardTimer);
      sock.end();
      resolve(replies);
    };

    sock.on('connect', () => {
      sock.write(JSON.stringify({ text }) + '\n');
      hardTimer = setTimeout(() => {
        sock.end();
        reject(new Error(`timeout: no reply within ${timeoutMs}ms`));
      }, timeoutMs);
    });
    sock.on('error', reject);
    sock.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg: CliReply = JSON.parse(line);
          if (typeof msg.text === 'string') replies.push(msg.text);
        } catch {
          // ignore
        }
      }
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(done, idleMs);
    });
    sock.on('close', done);
  });
}

function readAgentGroup(folder: string): { id: string; status: string; fleet_role: string | null; fleet_backend: string | null } | undefined {
  const db = new Database(centralDbPath(), { readonly: true });
  try {
    return db
      .prepare('SELECT id, status, fleet_role, fleet_backend FROM agent_groups WHERE folder = ?')
      .get(folder) as { id: string; status: string; fleet_role: string | null; fleet_backend: string | null } | undefined;
  } finally {
    db.close();
  }
}

function readChannelForWorker(agentGroupId: string): { platform_id: string } | undefined {
  const db = new Database(centralDbPath(), { readonly: true });
  try {
    return db
      .prepare(
        `SELECT mg.platform_id
           FROM messaging_groups mg
           JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id
          WHERE mga.agent_group_id = ? AND mg.channel_type = 'discord' LIMIT 1`,
      )
      .get(agentGroupId) as { platform_id: string } | undefined;
  } finally {
    db.close();
  }
}

function step(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  ✓ ${label}${detail ? ' — ' + detail : ''}`);
  } else {
    console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const keep = process.argv.includes('--keep');

  const overallTimer = setTimeout(() => {
    console.error(`overall timeout: ${OVERALL_TIMEOUT_MS}ms`);
    process.exit(1);
  }, OVERALL_TIMEOUT_MS);

  console.log('== Fleet live E2E ==\n');

  console.log('[1] Master reachable');
  const helloReplies = await chatRequest('hello');
  step('master replies to chat', helloReplies.length > 0, helloReplies[0]?.slice(0, 80));

  console.log('\n[2] Create worker');
  // Pre-clean — if a stale row from a prior run is still active, destroy it.
  const stale = readAgentGroup(WORKER_NAME);
  if (stale && stale.status !== 'archived') {
    await chatRequest(`destroy the worker named ${WORKER_NAME}`, 3000);
  }
  await chatRequest(`create a worker named ${WORKER_NAME}`);
  // Host applies the create asynchronously; give the delivery loop a moment.
  await new Promise((r) => setTimeout(r, 8000));
  const afterCreate = readAgentGroup(WORKER_NAME);
  step('worker row exists', afterCreate !== undefined, afterCreate?.id);
  step('worker is active', afterCreate?.status === 'active');
  step('worker has fleet_role=worker', afterCreate?.fleet_role === 'worker');
  const discordCfg = process.env.DISCORD_GUILD_ID;
  if (discordCfg) {
    const channel = readChannelForWorker(afterCreate!.id);
    step('Discord channel provisioned', channel !== undefined, channel?.platform_id);
  } else {
    console.log('  (skipping Discord channel check — no DISCORD_GUILD_ID set)');
  }
  const originalId = afterCreate!.id;

  console.log('\n[3] Agent-to-agent: master → worker → master');
  // Stay connected long enough for the worker container to spawn, reply, and
  // the master to relay back. The CLI socket only allows one client at a
  // time — reopening mid-flight shows "superseded" in master's response.
  const pingReplies = await chatRequest(
    `ask ${WORKER_NAME} to reply with exactly the single word "pong" and nothing else, then tell me what they said`,
    30_000,
    REPLY_TIMEOUT_MS * 2,
  );
  const sawPong = pingReplies.some((t) => /pong/i.test(t));
  step('master reports worker reply containing "pong"', sawPong, pingReplies.slice(-1)[0]?.slice(0, 100));

  console.log('\n[4] list_workers');
  const listReplies = await chatRequest('list workers', 5000);
  const listText = listReplies.join('\n');
  step('list mentions the worker', listText.includes(WORKER_NAME), listText.slice(0, 120));

  console.log('\n[5] Destroy worker');
  await chatRequest(`destroy the worker named ${WORKER_NAME}`);
  await new Promise((r) => setTimeout(r, 6000));
  const afterDestroy = readAgentGroup(WORKER_NAME);
  step('worker archived', afterDestroy?.status === 'archived');
  step('worker kept same id after destroy', afterDestroy?.id === originalId);

  console.log('\n[6] Resume (recreate with same name)');
  await chatRequest(`create a worker named ${WORKER_NAME}`);
  await new Promise((r) => setTimeout(r, 8000));
  const afterResume = readAgentGroup(WORKER_NAME);
  step('worker reactivated', afterResume?.status === 'active');
  step('same agent_group id after resume', afterResume?.id === originalId);
  if (discordCfg) {
    const channel = readChannelForWorker(originalId);
    step('new Discord channel reprovisioned', channel !== undefined, channel?.platform_id);
  }

  if (!keep) {
    console.log('\n[7] Cleanup');
    await chatRequest(`destroy the worker named ${WORKER_NAME}`);
    await new Promise((r) => setTimeout(r, 4000));
    const final = readAgentGroup(WORKER_NAME);
    step('cleaned up', final?.status === 'archived');
  } else {
    console.log('\n[7] Skipping cleanup (--keep)');
  }

  clearTimeout(overallTimer);
  console.log('\n== ALL PASSED ==');
}

main().catch((err) => {
  console.error('\nE2E failed:', err);
  process.exit(1);
});
