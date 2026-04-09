import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Message,
  TextChannel,
} from 'discord.js';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

// Discord enforces a 2000-character limit per message.
const DISCORD_MAX_MESSAGE_LENGTH = 2000;

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: DiscordChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  /** Extract the Discord channel ID from a dc:-prefixed JID. */
  private jidToChannelId(jid: string): string {
    if (!jid.startsWith('dc:')) {
      throw new Error(`Expected dc: JID, got: ${jid}`);
    }
    return jid.slice(3);
  }

  /** Fetch a text channel by JID. Throws if not found or not text-based. */
  private async fetchTextChannel(jid: string): Promise<TextChannel> {
    if (!this.client) throw new Error('Discord client not initialized');
    const channelId = this.jidToChannelId(jid);
    // force: false lets discord.js use its internal cache (avoids API call per poll)
    const channel = await this.client.channels.fetch(channelId, {
      force: false,
    });
    if (!channel || !('messages' in channel)) {
      throw new Error(`Discord channel not found or not text-based: ${jid}`);
    }
    return channel as TextChannel;
  }

  async connect(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      // Ignore bot messages (including own)
      if (message.author.bot) return;

      const channelId = message.channelId;
      const chatJid = `dc:${channelId}`;
      let content = message.content;
      const timestamp = message.createdAt.toISOString();
      const senderName =
        message.member?.displayName ||
        message.author.displayName ||
        message.author.username;
      const sender = message.author.id;
      const msgId = message.id;

      // Determine chat name
      let chatName: string;
      if (message.guild) {
        const textChannel = message.channel as TextChannel;
        chatName = `${message.guild.name} #${textChannel.name}`;
      } else {
        chatName = senderName;
      }

      // Translate Discord @bot mentions into TRIGGER_PATTERN format.
      // Discord mentions look like <@botUserId> — these won't match
      // TRIGGER_PATTERN (e.g., ^@Andy\b), so we prepend the trigger
      // when the bot is @mentioned.
      if (this.client?.user) {
        const botId = this.client.user.id;
        const isBotMentioned =
          message.mentions.users.has(botId) ||
          content.includes(`<@${botId}>`) ||
          content.includes(`<@!${botId}>`);

        if (isBotMentioned) {
          // Strip the <@botId> mention to avoid visual clutter
          content = content
            .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
            .trim();
          // Prepend trigger if not already present
          if (!TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }
      }

      // Handle attachments — store placeholders so the agent knows something was sent
      if (message.attachments.size > 0) {
        const attachmentDescriptions = [...message.attachments.values()].map(
          (att) => {
            const contentType = att.contentType || '';
            if (contentType.startsWith('image/')) {
              return `[Image: ${att.name || 'image'}]`;
            } else if (contentType.startsWith('video/')) {
              return `[Video: ${att.name || 'video'}]`;
            } else if (contentType.startsWith('audio/')) {
              return `[Audio: ${att.name || 'audio'}]`;
            } else {
              return `[File: ${att.name || 'file'}]`;
            }
          },
        );
        if (content) {
          content = `${content}\n${attachmentDescriptions.join('\n')}`;
        } else {
          content = attachmentDescriptions.join('\n');
        }
      }

      // Handle reply context — include who the user is replying to
      if (message.reference?.messageId) {
        try {
          const repliedTo = await message.channel.messages.fetch(
            message.reference.messageId,
          );
          const replyAuthor =
            repliedTo.member?.displayName ||
            repliedTo.author.displayName ||
            repliedTo.author.username;
          content = `[Reply to ${replyAuthor}] ${content}`;
        } catch {
          // Referenced message may have been deleted
        }
      }

      // Store chat metadata for discovery
      const isGroup = message.guild !== null;
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'discord',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Discord channel',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Discord message stored',
      );
    });

    // Handle errors gracefully
    this.client.on(Events.Error, (err) => {
      logger.error({ err: err.message }, 'Discord client error');
    });

    return new Promise<void>((resolve) => {
      this.client!.once(Events.ClientReady, (readyClient) => {
        logger.info(
          { username: readyClient.user.tag, id: readyClient.user.id },
          'Discord bot connected',
        );
        console.log(`\n  Discord bot: ${readyClient.user.tag}`);
        console.log(
          `  Use /chatid command or check channel IDs in Discord settings\n`,
        );
        resolve();
      });

      this.client!.login(this.botToken);
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    await this.sendMessageWithId(jid, text);
  }

  /**
   * Send a message and return its Discord message ID.
   * Used by status-pin to track the pinned message.
   */
  async sendMessageWithId(
    jid: string,
    text: string,
  ): Promise<string | undefined> {
    try {
      const textChannel = await this.fetchTextChannel(jid);

      let firstMessageId: string | undefined;
      if (text.length <= DISCORD_MAX_MESSAGE_LENGTH) {
        const sent = await textChannel.send(text);
        firstMessageId = sent.id;
      } else {
        for (let i = 0; i < text.length; i += DISCORD_MAX_MESSAGE_LENGTH) {
          const sent = await textChannel.send(
            text.slice(i, i + DISCORD_MAX_MESSAGE_LENGTH),
          );
          if (!firstMessageId) firstMessageId = sent.id;
        }
      }
      logger.info({ jid, length: text.length }, 'Discord message sent');
      return firstMessageId;
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
      return undefined;
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('dc:');
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
      logger.info('Discord bot stopped');
    }
  }

  async createChannel(
    guildId: string,
    name: string,
    categoryId?: string,
  ): Promise<string> {
    if (!this.client) throw new Error('Discord client not initialized');
    const guild = await this.client.guilds.fetch(guildId);
    const channel = await guild.channels.create({
      name,
      type: ChannelType.GuildText,
      ...(categoryId ? { parent: categoryId } : {}),
    });
    logger.info(
      { guildId, name, channelId: channel.id },
      'Discord channel created',
    );
    return channel.id;
  }

  async deleteChannel(channelId: string): Promise<void> {
    if (!this.client) throw new Error('Discord client not initialized');
    const channel = await this.client.channels.fetch(channelId);
    if (channel) {
      await channel.delete();
      logger.info({ channelId }, 'Discord channel deleted');
    }
  }

  async editMessage(
    jid: string,
    messageId: string,
    text: string,
  ): Promise<void> {
    const textChannel = await this.fetchTextChannel(jid);
    const truncated = text.slice(0, DISCORD_MAX_MESSAGE_LENGTH);
    if (text.length > DISCORD_MAX_MESSAGE_LENGTH) {
      logger.warn(
        { jid, original: text.length, truncated: DISCORD_MAX_MESSAGE_LENGTH },
        'editMessage: content truncated',
      );
    }
    await textChannel.messages.edit(messageId, truncated);
  }

  async pinMessage(jid: string, messageId: string): Promise<void> {
    const textChannel = await this.fetchTextChannel(jid);
    const message = await textChannel.messages.fetch(messageId);
    if (!message.pinned) {
      await message.pin();
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client || !isTyping) return;
    try {
      const textChannel = await this.fetchTextChannel(jid);
      await textChannel.sendTyping();
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Discord typing indicator');
    }
  }
}

registerChannel('discord', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['DISCORD_BOT_TOKEN']);
  const token =
    process.env.DISCORD_BOT_TOKEN || envVars.DISCORD_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Discord: DISCORD_BOT_TOKEN not set');
    return null;
  }
  return new DiscordChannel(token, opts);
});
