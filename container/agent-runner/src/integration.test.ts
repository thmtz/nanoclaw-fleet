import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './db/connection.js';
import { getUndeliveredMessages, writeMessageOut } from './db/messages-out.js';
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

  it('drops trailing text whenever the agent already delivered chat via tool this turn', async () => {
    // v1 design: host tracks "did the agent deliver this turn?" via a
    // chat-delivery counter incremented inside writeMessageOut. If yes,
    // the trailing turn-text is dropped — substantive or not, wrapped
    // or not. The agent is instructed to call send_message for anything
    // it wants delivered; trailing turn-text is scratchpad.
    //
    // Why not the previous "agent self-wraps in <internal>" design: it
    // broke after Claude SDK auto-compaction, where the compacted summary
    // made the agent think a prior turn's send_message was "this turn"
    // and wrap the new reply too. The user got bare scratchpad
    // ("Reply delivered via send_message.") instead of an answer.
    //
    // We invoke writeMessageOut directly from inside the responseFactory
    // to simulate the delivery the real send_message MCP tool would have
    // produced — that's what the suppression keys off.
    insertMessage(
      'm1',
      { sender: 'Alice', text: 'check the pricing_tbd models' },
      { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-1' },
    );

    const summary = 'PR #2829 is up. Migration 173 covers all three base models.';
    const provider = new MockProvider({}, () => {
      // Simulate the real send_message tool firing during the turn.
      writeMessageOut({
        id: 'tool-delivered-1',
        kind: 'chat',
        platform_id: 'chan-1',
        channel_type: 'discord',
        thread_id: 'thread-1',
        content: JSON.stringify({ text: 'On it — checking now…' }),
      });
      return summary;
    });

    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 1500);

    // Wait until the early ack lands in outbound — that guarantees the
    // mock provider's responseFactory ran (and wrote the ack via tool)
    // and dispatchResultText fired (deciding what to do with trailing
    // text). Polling pending status alone is racy: it flips when the
    // loop marks 'processing', not when the result event completes.
    await waitFor(() => getUndeliveredMessages().length > 0, 1500);
    // Give dispatchResultText one tick to write the trailing text if it
    // was going to (it shouldn't, but we want to assert that, not race
    // it).
    await sleep(50);
    controller.abort();

    // Exactly one delivery — the early ack. The substantive summary as
    // trailing turn-text was dropped. The agent is expected to call
    // send_message a second time for the summary.
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('On it — checking now…');

    await loopPromise.catch(() => {});
  });

  it('salvages internal-only output when no chat delivery ran (rather than going silent)', async () => {
    // Bug PR #93 surfaced: agent emits ONLY <internal>...</internal> with no
    // chat delivery via tool. Old behavior stripped the wrapper, leaving
    // empty text, leaving the user with silence. New behavior unwraps the
    // <internal> block and surfaces the text — weird-looking but not
    // silent, so the user can see the agent's broken state and ask again.
    insertMessage(
      'm1',
      { sender: 'Alice', text: 'Hi' },
      { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-1' },
    );

    const provider = new MockProvider({}, () => '<internal>Acknowledged via send_message.</internal>');

    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 1500);

    await waitFor(() => getUndeliveredMessages().length > 0, 1500);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    const surfaced = JSON.parse(out[0].content).text;
    expect(surfaced).toContain('Acknowledged via send_message.');
    // The salvage path now appends a warning suffix so the user knows the
    // content came through the safety net (post-compaction confusion has
    // produced wrapped meta-claims that the salvage was surfacing as if
    // they were deliberate replies). Suffix triggers on `salvaged === true`.
    expect(surfaced).toMatch(/scratchpad recovery/i);

    await loopPromise.catch(() => {});
  });

  it('warns on post-compaction meta-claim hallucination (salvage suffix on "Done — answered X")', async () => {
    // Reproduces the 2026-04-30 regression where two workers (nwme,
    // better) produced wrapped meta-claims like
    //   <internal>Done — answered the BetterStack best practice question
    //   and surfaced the open PR.</internal>
    // The salvage surfaced this verbatim, the user read it as a deliberate
    // reply, and only when they pushed back did the agent produce the real
    // answer. The suffix lets the user catch the hallucination immediately
    // and re-ask without first being misled.
    insertMessage(
      'm1',
      { sender: 'Alice', text: 'Is this email correct?' },
      { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-1' },
    );

    const provider = new MockProvider(
      {},
      () => '<internal>Done — answered the BetterStack best practice question and surfaced the open PR.</internal>',
      // critically: no chat delivery via tool this turn — salvage triggers
    );

    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 1500);

    await waitFor(() => getUndeliveredMessages().length > 0, 1500);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    const surfaced = JSON.parse(out[0].content).text;
    // Original meta-claim is still surfaced — we don't drop content, we
    // bias toward noise.
    expect(surfaced).toContain('Done — answered the BetterStack best practice question');
    // But the warning suffix flags it as recovered scratchpad.
    expect(surfaced).toMatch(/scratchpad recovery/i);
    expect(surfaced).toMatch(/ask again/i);

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
