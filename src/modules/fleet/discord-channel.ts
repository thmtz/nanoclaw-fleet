/**
 * Discord REST client for fleet channel provisioning.
 *
 * Fleet workers each get their own Discord text channel. This module wraps
 * the Discord REST API for channel create/delete using the already-configured
 * bot token. No new adapter dependency — raw fetch.
 *
 * Env required when fleet is installed with Discord:
 *   DISCORD_BOT_TOKEN          — bot auth (also read by add-discord adapter)
 *   DISCORD_GUILD_ID           — guild where worker channels get created
 *   DISCORD_FLEET_CATEGORY_ID  — (optional) parent category for worker channels
 *
 * The module is Discord-specific for now. Future: other channel backends
 * (Slack, Telegram) would add their own provisioner; fleet picks by the
 * master's channel_type.
 */
import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';

const API = 'https://discord.com/api/v10';

export interface DiscordChannelConfig {
  botToken: string;
  guildId: string;
  categoryId?: string;
}

export function loadDiscordFleetConfig(): DiscordChannelConfig | null {
  const env = readEnvFile(['DISCORD_BOT_TOKEN', 'DISCORD_GUILD_ID', 'DISCORD_FLEET_CATEGORY_ID']);
  if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_GUILD_ID) return null;
  return {
    botToken: env.DISCORD_BOT_TOKEN,
    guildId: env.DISCORD_GUILD_ID,
    categoryId: env.DISCORD_FLEET_CATEGORY_ID,
  };
}

async function discordFetch(cfg: DiscordChannelConfig, path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bot ${cfg.botToken}`,
      'Content-Type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  return res;
}

/**
 * Create a text channel in the configured guild. Returns the channel ID
 * (platform_id for the messaging_group row) and the channel name as
 * accepted by Discord (may differ from the requested name if Discord
 * normalized it). Throws on Discord API error.
 */
export async function createDiscordChannel(
  cfg: DiscordChannelConfig,
  name: string,
  topic?: string,
): Promise<{ id: string; name: string }> {
  const body: Record<string, unknown> = {
    name,
    type: 0, // GUILD_TEXT
  };
  if (topic) body.topic = topic;
  if (cfg.categoryId) body.parent_id = cfg.categoryId;

  const res = await discordFetch(cfg, `/guilds/${cfg.guildId}/channels`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Discord create channel failed: ${res.status} ${txt}`);
  }
  const json = (await res.json()) as { id: string; name: string };
  log.info('Discord channel created', { channelId: json.id, name: json.name });
  return { id: json.id, name: json.name };
}

/**
 * List all text channels in the configured guild. Returns id + name + parent
 * so the caller can filter (e.g. by category) and reconcile against
 * `messaging_groups.platform_id`.
 */
export async function listDiscordChannels(
  cfg: DiscordChannelConfig,
): Promise<Array<{ id: string; name: string; type: number; parent_id: string | null }>> {
  const res = await discordFetch(cfg, `/guilds/${cfg.guildId}/channels`);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Discord list channels failed: ${res.status} ${txt}`);
  }
  return (await res.json()) as Array<{ id: string; name: string; type: number; parent_id: string | null }>;
}

/**
 * Delete a Discord channel by ID. Idempotent in the sense that we log and
 * swallow 404 (channel already gone) so destroy can retry safely.
 */
export async function deleteDiscordChannel(cfg: DiscordChannelConfig, channelId: string): Promise<void> {
  const res = await discordFetch(cfg, `/channels/${channelId}`, { method: 'DELETE' });
  if (res.status === 404) {
    log.info('Discord channel already gone', { channelId });
    return;
  }
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Discord delete channel failed: ${res.status} ${txt}`);
  }
  log.info('Discord channel deleted', { channelId });
}
