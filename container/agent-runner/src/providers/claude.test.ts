import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { closeSessionDb, getInboundDb, initTestSessionDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { sendCompactionNotice } from './claude.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function setSessionRouting(channel_type: string | null, platform_id: string | null, thread_id: string | null) {
  const db = getInboundDb();
  db.prepare(
    `CREATE TABLE IF NOT EXISTS session_routing (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       channel_type TEXT,
       platform_id TEXT,
       thread_id TEXT
     )`,
  ).run();
  db.prepare(
    `INSERT OR REPLACE INTO session_routing (id, channel_type, platform_id, thread_id) VALUES (1, ?, ?, ?)`,
  ).run(channel_type, platform_id, thread_id);
}

describe('sendCompactionNotice', () => {
  it('writes a chat message to outbound when session routing is set', () => {
    setSessionRouting('discord', 'channel-123', null);
    sendCompactionNotice('auto');

    const out = getUndeliveredMessages();
    expect(out.length).toBe(1);
    expect(out[0].kind).toBe('chat');
    expect(out[0].channel_type).toBe('discord');
    expect(out[0].platform_id).toBe('channel-123');
    const content = JSON.parse(out[0].content);
    expect(content.text).toContain('Compacting context');
    expect(content.text).toContain('auto');
  });

  it('preserves thread_id from session routing', () => {
    setSessionRouting('discord', 'channel-123', 'thread-456');
    sendCompactionNotice('manual');

    const out = getUndeliveredMessages();
    expect(out.length).toBe(1);
    expect(out[0].thread_id).toBe('thread-456');
    const content = JSON.parse(out[0].content);
    expect(content.text).toContain('manual');
  });

  it('silently skips when session routing is missing', () => {
    sendCompactionNotice('auto');
    expect(getUndeliveredMessages().length).toBe(0);
  });
});
