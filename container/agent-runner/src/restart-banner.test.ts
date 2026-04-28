import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, getInboundDb, initTestSessionDb } from './db/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { clearStoredSessionId, setStoredSessionId } from './db/session-state.js';
import { runPollLoop } from './poll-loop.js';
import { MockProvider } from './providers/mock.js';

beforeEach(() => {
  initTestSessionDb();
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('discord-test', 'Discord Test', 'channel', 'discord', 'chan-1', NULL)`,
    )
    .run();
  clearStoredSessionId();
});

afterEach(() => {
  clearStoredSessionId();
  closeSessionDb();
});

function insertMessage(id: string, text: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES (?, 'chat', datetime('now'), 'pending', 'chan-1', 'discord', 'thread-1', ?)`,
    )
    .run(id, JSON.stringify({ sender: 'Test', text }));
}

async function runUntil(provider: MockProvider, predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const controller = new AbortController();
  const timeoutCtl = new AbortController();
  const timer = setTimeout(() => timeoutCtl.abort(), timeoutMs);
  const combined = AbortSignal.any([controller.signal, timeoutCtl.signal]);
  const loop = runPollLoop({ provider, cwd: '/tmp', signal: combined });
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  controller.abort();
  try {
    await loop;
  } finally {
    clearTimeout(timer);
  }
}

describe('restart banner', () => {
  it("prepends '[CONTAINER RESTARTED at ...]' to the first prompt when resuming a session", async () => {
    setStoredSessionId('prior-session-id');
    insertMessage('m1', 'hello');

    let firstPrompt: string | null = null;
    const provider = new MockProvider({}, (prompt) => {
      if (firstPrompt === null) firstPrompt = prompt;
      return '<message to="discord-test">ok</message>';
    });

    await runUntil(provider, () => getUndeliveredMessages().length > 0);

    expect(firstPrompt).not.toBeNull();
    expect(firstPrompt!).toMatch(/^\[CONTAINER RESTARTED at /);
    expect(firstPrompt!).toContain('workspace and repos are intact');
    expect(firstPrompt!).toContain('hello');
  });

  it('does not prepend the banner on a fresh session (no stored session id)', async () => {
    insertMessage('m1', 'hello');

    let firstPrompt: string | null = null;
    const provider = new MockProvider({}, (prompt) => {
      if (firstPrompt === null) firstPrompt = prompt;
      return '<message to="discord-test">ok</message>';
    });

    await runUntil(provider, () => getUndeliveredMessages().length > 0);

    expect(firstPrompt).not.toBeNull();
    expect(firstPrompt!).not.toContain('CONTAINER RESTARTED');
  });

  it('only prepends the banner on the first batch — subsequent batches are clean', async () => {
    setStoredSessionId('prior-session-id');
    insertMessage('m1', 'first');

    const prompts: string[] = [];
    const provider = new MockProvider({}, (prompt) => {
      prompts.push(prompt);
      return '<message to="discord-test">ok</message>';
    });

    // Run, observe first batch processed, insert second message, observe second.
    const controller = new AbortController();
    const timeoutCtl = new AbortController();
    const timer = setTimeout(() => timeoutCtl.abort(), 5000);
    const combined = AbortSignal.any([controller.signal, timeoutCtl.signal]);
    const loop = runPollLoop({ provider, cwd: '/tmp', signal: combined });

    // Wait for first turn to land.
    const start = Date.now();
    while (prompts.length < 1 && Date.now() - start < 3000) {
      await new Promise((r) => setTimeout(r, 50));
    }

    insertMessage('m2', 'second');

    while (prompts.length < 2 && Date.now() - start < 5000) {
      await new Promise((r) => setTimeout(r, 50));
    }

    controller.abort();
    try {
      await loop;
    } finally {
      clearTimeout(timer);
    }

    expect(prompts.length).toBeGreaterThanOrEqual(2);
    expect(prompts[0]).toMatch(/^\[CONTAINER RESTARTED at /);
    expect(prompts[1]).not.toContain('CONTAINER RESTARTED');
  });
});
