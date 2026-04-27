/**
 * Discord channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 */
import { createDiscordAdapter } from '@chat-adapter/discord';

import { readEnvFile } from '../env.js';
import { createChatSdkBridge, type ReplyContext } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractReplyContext(raw: Record<string, any>): ReplyContext | null {
  if (!raw.referenced_message) return null;
  const reply = raw.referenced_message;
  return {
    text: reply.content || '',
    sender: reply.author?.global_name || reply.author?.username || 'Unknown',
  };
}

/**
 * Discord doesn't render `[text](url)` markdown link syntax in regular
 * messages — brackets and parens show as literal characters. chat-sdk-
 * discord's `formatConverter.renderPostable` turns bare URLs in agent
 * markdown into link nodes and emits them as `[url](url)`. Collapse those
 * pathological cases back to a bare URL:
 *
 *   [url](url)             → url
 *   [http url](other url)  → url
 *
 * Leave intentional `[label](url)` (non-URL label) alone — markdown is
 * still broken there on Discord, but losing the label is worse than
 * showing it raw.
 */
export function stripDuplicateLinks(text: string): string {
  return text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (full, label, url) => {
    if (label === url) return url;
    if (/^https?:\/\//.test(label) && /^https?:\/\//.test(url)) return url;
    return full;
  });
}

/**
 * Wrap the chat-sdk-discord adapter so we can post-process the rendered
 * Discord text after `formatConverter.renderPostable` has done its
 * markdown→Discord conversion. The bridge's `transformOutboundText` hook
 * runs *before* render and so doesn't see the link wrapping. Wrapping at
 * the adapter level lets us render once, fix the duplicate-link cases,
 * and short-circuit the second render by passing `{raw: rendered}`
 * (which the converter forwards verbatim except for @-mention conversion).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrapAdapterForLinkFix(adapter: any): any {
  const origPost = adapter.postMessage?.bind(adapter);
  const origEdit = adapter.editMessage?.bind(adapter);
  const renderer = adapter.formatConverter;
  if (!origPost || !renderer) return adapter;

  const fix = (msg: Record<string, unknown>): Record<string, unknown> => {
    if (typeof msg !== 'object' || msg === null) return msg;
    if ('raw' in msg) return msg;
    if (!('markdown' in msg) && !('text' in msg)) return msg;
    const rendered: string = renderer.renderPostable(msg);
    const fixed = stripDuplicateLinks(rendered);
    if (fixed === rendered) return msg;
    return { ...msg, raw: fixed, markdown: undefined, text: undefined };
  };

  return Object.assign(Object.create(Object.getPrototypeOf(adapter)), adapter, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    postMessage: (tid: string, message: any) => origPost(tid, fix(message)),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    editMessage: origEdit ? (tid: string, mid: string, message: any) => origEdit(tid, mid, fix(message)) : undefined,
  });
}

registerChannelAdapter('discord', {
  factory: () => {
    const env = readEnvFile([
      'DISCORD_BOT_TOKEN',
      'DISCORD_PUBLIC_KEY',
      'DISCORD_APPLICATION_ID',
      'DISCORD_ALLOWED_BOT_IDS',
    ]);
    if (!env.DISCORD_BOT_TOKEN) return null;
    // DISCORD_ALLOWED_BOT_IDS is consumed by a patch to @chat-adapter/discord
    // that reads it from process.env (see patches/). readEnvFile deliberately
    // does not populate process.env, so bridge the value here — only after
    // we know the Discord adapter is being registered.
    if (env.DISCORD_ALLOWED_BOT_IDS) process.env.DISCORD_ALLOWED_BOT_IDS = env.DISCORD_ALLOWED_BOT_IDS;
    const discordAdapter = createDiscordAdapter({
      botToken: env.DISCORD_BOT_TOKEN,
      publicKey: env.DISCORD_PUBLIC_KEY,
      applicationId: env.DISCORD_APPLICATION_ID,
    });
    return createChatSdkBridge({
      adapter: wrapAdapterForLinkFix(discordAdapter),
      concurrency: 'concurrent',
      botToken: env.DISCORD_BOT_TOKEN,
      extractReplyContext,
      supportsThreads: true,
      // Discord per-message hard limit. Without this, the chat-sdk-discord
      // adapter silently truncates anything over 2000 chars with "..." —
      // long agent replies (research summaries, file dumps, etc.) get cut
      // mid-sentence. Setting this triggers chat-sdk-bridge's splitForLimit
      // which breaks long text on paragraph → line → space → hard-char
      // boundaries and posts each chunk as a separate Discord message.
      maxTextLength: 2000,
    });
  },
});
