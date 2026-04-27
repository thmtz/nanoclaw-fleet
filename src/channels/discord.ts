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
 * messages — it shows the brackets and parens as literal characters.
 * chat-sdk-discord's renderer emits links in that exact form because the
 * SDK's markdown parser turns bare URLs into link nodes upstream. By the
 * time we have the rendered string, all we can do is collapse the
 * pathological cases:
 *
 *   [url](url)             → url             (label is the same URL)
 *   [https://...](url)     → url             (label is also a URL — Discord
 *                                              auto-links the bare URL anyway)
 *
 * Leave intentional `[label](url)` (different label and url) alone — the
 * markdown is broken there too on Discord, but stripping the label loses
 * information. The instructions fragment tells agents to write bare URLs
 * directly; this transform handles the common round-trip case where they did.
 */
function stripDuplicateLinks(text: string): string {
  return text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (full, label, url) => {
    if (label === url) return url;
    if (/^https?:\/\//.test(label) && /^https?:\/\//.test(url)) return url;
    return full;
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
      adapter: discordAdapter,
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
      // Collapse `[url](url)` round-trips back to bare URLs — Discord shows
      // brackets/parens literal, so duplicate-label links read as junk.
      transformOutboundText: stripDuplicateLinks,
    });
  },
});
