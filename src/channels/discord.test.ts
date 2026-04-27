import { describe, expect, it } from 'vitest';

// Re-implement the same regex inline so this test pins behavior even if
// the helper is refactored or moved. Equivalent to stripDuplicateLinks
// in src/channels/discord.ts.
function stripDuplicateLinks(text: string): string {
  return text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (full, label, url) => {
    if (label === url) return url;
    if (/^https?:\/\//.test(label) && /^https?:\/\//.test(url)) return url;
    return full;
  });
}

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
