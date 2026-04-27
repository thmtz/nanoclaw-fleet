import { describe, expect, it } from 'vitest';

import { stripDuplicateLinks } from './discord.js';

describe('Discord stripDuplicateLinks', () => {
  it('collapses [url](url) where label equals url', () => {
    const out = stripDuplicateLinks('Tunnel is live. Demo URL: [https://example.com/foo](https://example.com/foo)');
    expect(out).toBe('Tunnel is live. Demo URL: https://example.com/foo');
  });

  it('collapses [http url](other http url) — both are URLs', () => {
    const out = stripDuplicateLinks('[https://x.com/a](https://x.com/b)');
    expect(out).toBe('https://x.com/b');
  });

  it('preserves intentional [label](url) where label is not a URL', () => {
    const out = stripDuplicateLinks('See the [docs](https://example.com/docs) for more.');
    expect(out).toBe('See the [docs](https://example.com/docs) for more.');
  });

  it('handles multiple links in one message', () => {
    const out = stripDuplicateLinks(
      '[https://a.com](https://a.com) and [b](https://b.com) and [https://c.com](https://c.com)',
    );
    expect(out).toBe('https://a.com and [b](https://b.com) and https://c.com');
  });

  it('leaves text with no links unchanged', () => {
    const text = 'Plain text with no markdown links at all.';
    expect(stripDuplicateLinks(text)).toBe(text);
  });

  it('leaves bare URLs unchanged', () => {
    const text = 'Visit https://example.com for the docs.';
    expect(stripDuplicateLinks(text)).toBe(text);
  });
});
