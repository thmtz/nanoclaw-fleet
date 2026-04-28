import { afterEach, describe, expect, it } from 'vitest';

import type { Adapter } from 'chat';

import {
  createChatSdkBridge,
  fetchAttachmentFromUrl,
  shouldFetchAttachment,
  splitForLimit,
} from './chat-sdk-bridge.js';

function stubAdapter(partial: Partial<Adapter>): Adapter {
  return { name: 'stub', ...partial } as unknown as Adapter;
}

describe('splitForLimit', () => {
  it('returns a single chunk when text fits', () => {
    expect(splitForLimit('short text', 100)).toEqual(['short text']);
  });

  it('splits on paragraph boundaries when available', () => {
    const text = 'para one line one\npara one line two\n\npara two line one\npara two line two';
    const chunks = splitForLimit(text, 40);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(40);
  });

  it('falls back to line boundaries when no paragraph fits', () => {
    const text = 'alpha\nbravo\ncharlie\ndelta\necho\nfoxtrot';
    const chunks = splitForLimit(text, 15);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(15);
  });

  it('hard-cuts when no whitespace is available', () => {
    const text = 'a'.repeat(100);
    const chunks = splitForLimit(text, 30);
    expect(chunks.length).toBe(Math.ceil(100 / 30));
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(30);
    expect(chunks.join('')).toBe(text);
  });
});

describe('createChatSdkBridge', () => {
  // The bridge is now transport-only: forward inbound events, relay outbound
  // ops. All per-wiring engage / accumulate / drop / subscribe decisions live
  // in the router (src/router.ts routeInbound / evaluateEngage) and are
  // exercised by host-core.test.ts end-to-end. These tests only cover the
  // bridge's narrow, platform-adjacent surface.

  it('omits openDM when the underlying Chat SDK adapter has none', () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({}),
      supportsThreads: false,
    });
    expect(bridge.openDM).toBeUndefined();
  });

  it('exposes openDM when the underlying adapter has one, and delegates directly', async () => {
    const openDMCalls: string[] = [];
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({
        openDM: async (userId: string) => {
          openDMCalls.push(userId);
          return `thread::${userId}`;
        },
        channelIdFromThreadId: (threadId: string) => `stub:${threadId.replace(/^thread::/, '')}`,
      }),
      supportsThreads: false,
    });
    expect(bridge.openDM).toBeDefined();
    const platformId = await bridge.openDM!('user-42');
    // Delegation: adapter.openDM → adapter.channelIdFromThreadId, no chat.openDM in between.
    expect(openDMCalls).toEqual(['user-42']);
    expect(platformId).toBe('stub:user-42');
  });

  it('exposes subscribe (lets the router initiate thread subscription on mention-sticky engage)', () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({}),
      supportsThreads: true,
    });
    expect(typeof bridge.subscribe).toBe('function');
  });
});

describe('shouldFetchAttachment', () => {
  it('fetches text/* mime types', () => {
    expect(shouldFetchAttachment({ mimeType: 'text/plain' })).toBe(true);
    expect(shouldFetchAttachment({ mimeType: 'text/markdown' })).toBe(true);
    expect(shouldFetchAttachment({ mimeType: 'TEXT/CSV' })).toBe(true);
  });

  it('fetches structured-data mime types', () => {
    expect(shouldFetchAttachment({ mimeType: 'application/json' })).toBe(true);
    expect(shouldFetchAttachment({ mimeType: 'application/xml' })).toBe(true);
    expect(shouldFetchAttachment({ mimeType: 'application/x-yaml' })).toBe(true);
  });

  it('fetches attachments with no mimeType (Discord paste-as-txt drops content_type)', () => {
    // The motivating case for this whole feature: a user pastes a wall of
    // text into Discord and the client auto-uploads it as a .txt file.
    // Discord sometimes omits content_type on those, leaving us with
    // attachments that have only url/name/size. We want to download those.
    expect(shouldFetchAttachment({})).toBe(true);
    expect(shouldFetchAttachment({ mimeType: '' })).toBe(true);
  });

  it('skips images / video / audio (already surfaced via URL in formatter)', () => {
    expect(shouldFetchAttachment({ mimeType: 'image/png' })).toBe(false);
    expect(shouldFetchAttachment({ mimeType: 'video/mp4' })).toBe(false);
    expect(shouldFetchAttachment({ mimeType: 'audio/mpeg' })).toBe(false);
    expect(shouldFetchAttachment({ mimeType: 'application/pdf' })).toBe(false);
  });

  it('skips when declared size exceeds the cap', () => {
    expect(shouldFetchAttachment({ mimeType: 'text/plain', size: 100 * 1024 * 1024 })).toBe(false);
  });
});

describe('fetchAttachmentFromUrl', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('returns the body for a successful fetch under the size cap', async () => {
    globalThis.fetch = (async () => {
      return new Response('hello world', { status: 200, headers: { 'content-length': '11' } });
    }) as typeof fetch;
    const buf = await fetchAttachmentFromUrl('https://example.test/file.txt', 11);
    expect(buf).not.toBeNull();
    expect(buf!.toString('utf-8')).toBe('hello world');
  });

  it('returns null when declaredSize blows past the cap (no fetch issued)', async () => {
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return new Response('', { status: 200 });
    }) as typeof fetch;
    const buf = await fetchAttachmentFromUrl('https://example.test/huge', 50 * 1024 * 1024);
    expect(buf).toBeNull();
    expect(fetched).toBe(false);
  });

  it('returns null when content-length blows past the cap', async () => {
    globalThis.fetch = (async () => {
      return new Response('', { status: 200, headers: { 'content-length': String(50 * 1024 * 1024) } });
    }) as typeof fetch;
    const buf = await fetchAttachmentFromUrl('https://example.test/huge');
    expect(buf).toBeNull();
  });

  it('throws on non-2xx so the caller can log + skip', async () => {
    globalThis.fetch = (async () => {
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    await expect(fetchAttachmentFromUrl('https://example.test/missing')).rejects.toThrow(/HTTP 404/);
  });
});
