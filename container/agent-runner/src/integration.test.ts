import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './db/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { getPendingMessages } from './db/messages-in.js';
import { MockProvider } from './providers/mock.js';
import { runPollLoop } from './poll-loop.js';

beforeEach(() => {
  initTestSessionDb();
  // Seed a destination so output parsing can resolve "discord-test" → routing
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('discord-test', 'Discord Test', 'channel', 'discord', 'chan-1', NULL)`,
    )
    .run();
});

afterEach(() => {
  closeSessionDb();
});

function insertMessage(
  id: string,
  content: object,
  opts?: { platformId?: string; channelType?: string; threadId?: string },
) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES (?, 'chat', datetime('now'), 'pending', ?, ?, ?, ?)`,
    )
    .run(id, opts?.platformId ?? null, opts?.channelType ?? null, opts?.threadId ?? null, JSON.stringify(content));
}

describe('poll loop integration', () => {
  it('should pick up a message, process it, and write a response', async () => {
    insertMessage(
      'm1',
      { sender: 'Alice', text: 'What is the meaning of life?' },
      { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-1' },
    );

    const provider = new MockProvider({}, () => '<message to="discord-test">42</message>');

    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('42');
    expect(out[0].platform_id).toBe('chan-1');
    expect(out[0].channel_type).toBe('discord');
    expect(out[0].in_reply_to).toBe('m1');

    // Input message should be acked (not pending)
    const pending = getPendingMessages();
    expect(pending).toHaveLength(0);

    await loopPromise.catch(() => {});
  });

  it('should process multiple messages in a batch', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'Hello' });
    insertMessage('m2', { sender: 'Bob', text: 'World' });

    const provider = new MockProvider({}, () => '<message to="discord-test">Got both messages</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('Got both messages');

    await loopPromise.catch(() => {});
  });

  it('drops trailing text when the agent wrapped it in <internal> and send_message ran', async () => {
    // Canonical ack-then-work: agent sent the substantive reply via
    // send_message, then closed with `<internal>done</internal>`. Stripping
    // the wrapper leaves "" → nothing lands in outbound (correct: the
    // reply already went via send_message). Salvage doesn't fire here
    // because send_message ran (we shouldn't re-surface the wrapped text
    // as if it were the missing reply). The MCP-side send_message itself
    // is a no-op in MockProvider, so the only thing that *would* land in
    // outbound is the scratchpad — assert nothing lands.
    insertMessage(
      'm1',
      { sender: 'Alice', text: 'Do the thing' },
      { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-1' },
    );

    const provider = new MockProvider(
      {},
      () => '<internal>Sent reply via send_message. No further output needed.</internal>',
      ['mcp__nanoclaw__send_message'],
    );

    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 1500);

    // Wait for the result event by waiting for the message to be ack'd.
    await waitFor(() => getPendingMessages().length === 0, 1500);
    controller.abort();

    expect(getUndeliveredMessages()).toHaveLength(0);

    await loopPromise.catch(() => {});
  });

  it('delivers substantive trailing text even when send_message ran earlier (no auto-suppress)', async () => {
    // models-endpoint regression: agent calls send_message early ("On it…"),
    // does the work, then writes a substantive summary as the trailing
    // turn-result text. The previous auto-suppress-when-send_message-ran
    // logic dropped these summaries. We now deliver them — the agent is
    // expected to explicitly wrap closing chatter in <internal> when it
    // wants suppression (see core.instructions.md).
    insertMessage(
      'm1',
      { sender: 'Alice', text: 'check the pricing_tbd models' },
      { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-1' },
    );

    const summary = 'PR #2829 is up. Migration 173 covers all three base models (K2.5, MiniMax, Devstral).';
    const provider = new MockProvider({}, () => summary, ['mcp__nanoclaw__send_message']);

    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 1500);

    await waitFor(() => getUndeliveredMessages().length > 0, 1500);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe(summary);

    await loopPromise.catch(() => {});
  });

  it('salvages internal-only output when no send_message ran (rather than going silent)', async () => {
    // Bug PR #93 surfaced: agent emits ONLY <internal>...</internal> with no
    // send_message tool_use. Old behavior stripped the wrapper, leaving
    // empty text, leaving the user with silence. New behavior unwraps the
    // <internal> block and surfaces the text — weird-looking but not
    // silent, so the user can see the agent's broken state and ask again.
    insertMessage(
      'm1',
      { sender: 'Alice', text: 'Hi' },
      { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-1' },
    );

    const provider = new MockProvider(
      {},
      () => '<internal>Acknowledged via send_message.</internal>',
      [], // no tool_use this turn
    );

    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 1500);

    await waitFor(() => getUndeliveredMessages().length > 0, 1500);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('Acknowledged via send_message.');

    await loopPromise.catch(() => {});
  });

  it('should process messages arriving after loop starts', async () => {
    const provider = new MockProvider({}, () => '<message to="discord-test">Processed</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 3000);

    // Insert message after loop has started
    await sleep(200);
    insertMessage('m-late', { sender: 'Charlie', text: 'Late arrival' });

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out.length).toBeGreaterThanOrEqual(1);

    await loopPromise.catch(() => {});
  });
});

// Helper: run poll loop until aborted or timeout. Passes the signal
// directly into runPollLoop so the loop exits cleanly at its next
// iteration boundary instead of leaving a leaked while(true) running
// past closeSessionDb (which was the source of the bun-test
// SQLiteError + late-describe flakes).
async function runPollLoopWithTimeout(provider: MockProvider, signal: AbortSignal, timeoutMs: number): Promise<void> {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  // Combined signal: abort if either the test's controller fires or the
  // timeout elapses. AbortSignal.any is supported in Bun + Node 22+.
  const combined = AbortSignal.any([signal, timeoutController.signal]);
  try {
    await runPollLoop({ provider, cwd: '/tmp', signal: combined });
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await sleep(50);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
