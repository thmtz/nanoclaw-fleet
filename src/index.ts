import { EventEmitter, once } from 'events';
import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import {
  syncMasterProfile,
  syncWorkerProfiles,
  loadPersonalConfig,
} from './profile-sync.js';
import { startResourceMonitor } from './resource-monitor.js';
import { startStatusPin, markStatusOffline } from './status-pin.js';
import { startWorkerStatusPins } from './worker-status-pin.js';
import type { DiscordChannel } from './channels/discord.js';

import {
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  DEFAULT_TRIGGER,
  getTriggerPattern,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAX_CONCURRENT_CONTAINERS,
  MAX_MESSAGES_PER_PROMPT,
  ONECLI_URL,
  POLL_INTERVAL,
  STATUS_PIN_INTERVAL,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './config.js';
import { startCredentialProxy } from './credential-proxy.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getLastBotMessageTimestamp,
  getMessagesSince,
  getNewMessages,
  getRegisteredGroup,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  deleteSession,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import {
  clearGroupSentMessage,
  didGroupSendMessage,
  startIpcWatcher,
} from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import {
  extractSessionCommand,
  handleSessionCommand,
  isSessionCommandAllowed,
} from './session-commands.js';
import { startSessionCleanup } from './session-cleanup.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { generateTraceId } from './trace.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;
let stopStatusPin: (() => void) | undefined;
let stopWorkerPins: (() => void) | undefined;

// Per-group throbber state — shared between cold boot (processGroupMessages)
// and warm pipe (startMessageLoop) paths so the reaction throbber works
// regardless of whether the container was already running.
const THROBBER_EMOJIS = ['🔵', '🟦', '🔷'];
const THROBBER_DEBOUNCE_MS = 2000;

interface ThrobberState {
  chatJid: string;
  messageId: string;
  idx: number;
  lastCycle: number;
  active: boolean;
}

const throbberState = new Map<string, ThrobberState>();

function cycleThrobber(groupFolder: string, channel: Channel): void {
  const state = throbberState.get(groupFolder);
  if (!state || !('react' in channel)) return;

  const now = Date.now();
  if (now - state.lastCycle < THROBBER_DEBOUNCE_MS) return;
  state.lastCycle = now;

  const react = (
    channel as unknown as {
      react: (jid: string, msgId: string, emoji: string) => Promise<void>;
    }
  ).react.bind(channel);
  const unreact = (
    channel as unknown as {
      unreact: (jid: string, msgId: string, emoji: string) => Promise<void>;
    }
  ).unreact.bind(channel);

  const prevEmoji =
    THROBBER_EMOJIS[
      (state.idx - 1 + THROBBER_EMOJIS.length) % THROBBER_EMOJIS.length
    ];
  const nextEmoji = THROBBER_EMOJIS[state.idx % THROBBER_EMOJIS.length];

  // Add new emoji before removing old — keeps reaction count >= 1 so the
  // message doesn't visually jump from having reactions to having none
  const doReact = async () => {
    await react(state.chatJid, state.messageId, nextEmoji).catch(() => {});
    if (state.active) {
      await unreact(state.chatJid, state.messageId, prevEmoji).catch(() => {});
    }
  };
  doReact().catch(() => {});
  state.active = true;
  state.idx++;
}

function clearThrobber(groupFolder: string, channel: Channel): void {
  const state = throbberState.get(groupFolder);
  if (!state?.active || !('unreact' in channel)) return;

  const unreact = (
    channel as unknown as {
      unreact: (jid: string, msgId: string, emoji: string) => Promise<void>;
    }
  ).unreact.bind(channel);
  for (const emoji of THROBBER_EMOJIS) {
    unreact(state.chatJid, state.messageId, emoji).catch(() => {});
  }
  throbberState.delete(groupFolder);
}

const channels: Channel[] = [];
const queue = new GroupQueue();

const onecli = new OneCLI({ url: ONECLI_URL });

function ensureOneCLIAgent(jid: string, group: RegisteredGroup): void {
  if (group.isMain) return;
  const identifier = group.folder.toLowerCase().replace(/_/g, '-');
  onecli.ensureAgent({ name: group.name, identifier }).then(
    (res) => {
      logger.info(
        { jid, identifier, created: res.created },
        'OneCLI agent ensured',
      );
    },
    (err) => {
      logger.debug(
        { jid, identifier, err: String(err) },
        'OneCLI agent ensure skipped',
      );
    },
  );
}

// Wake signal: fires when a new message is stored, so the message loop
// can process it immediately instead of waiting for the next poll cycle.
const messageWake = new EventEmitter();
messageWake.setMaxListeners(0); // loop re-registers on every iteration

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

/**
 * Return the message cursor for a group, recovering from the last bot reply
 * if lastAgentTimestamp is missing (new group, corrupted state, restart).
 */
function getOrRecoverCursor(chatJid: string): string {
  const existing = lastAgentTimestamp[chatJid];
  if (existing) return existing;

  const botTs = getLastBotMessageTimestamp(chatJid, ASSISTANT_NAME);
  if (botTs) {
    logger.info(
      { chatJid, recoveredFrom: botTs },
      'Recovered message cursor from last bot reply',
    );
    lastAgentTimestamp[chatJid] = botTs;
    saveState();
    return botTs;
  }
  return '';
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Copy CLAUDE.md template into the new group folder so agents have
  // identity and instructions from the first run.
  const groupMdFile = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(groupMdFile)) {
    const templateFile = path.join(
      GROUPS_DIR,
      group.isMain ? 'main' : 'global',
      'CLAUDE.md',
    );
    if (fs.existsSync(templateFile)) {
      let content = fs.readFileSync(templateFile, 'utf-8');
      if (ASSISTANT_NAME !== 'Andy') {
        content = content.replace(/^# Andy$/m, `# ${ASSISTANT_NAME}`);
        content = content.replace(/You are Andy/g, `You are ${ASSISTANT_NAME}`);
      }
      fs.writeFileSync(groupMdFile, content);
      logger.info({ folder: group.folder }, 'Created CLAUDE.md from template');
    }
  }

  // Ensure a corresponding OneCLI agent exists (best-effort, non-blocking)
  ensureOneCLIAgent(jid, group);

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const chatJids = new Set(chats.map((c) => c.jid));
  const registeredJids = new Set(Object.keys(registeredGroups));

  const fromChats = chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
      folder: registeredGroups[c.jid]?.folder,
    }));

  // Include registered groups that haven't had any messages yet
  // (e.g. just-created workers whose Discord channel hasn't been messaged).
  const fromRegistered = Object.entries(registeredGroups)
    .filter(([jid]) => !chatJids.has(jid))
    .map(([jid, group]) => ({
      jid,
      name: group.name,
      lastActivity: group.added_at || new Date().toISOString(),
      isRegistered: true,
      folder: group.folder,
    }));

  return [...fromChats, ...fromRegistered];
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const missedMessages = getMessagesSince(
    chatJid,
    getOrRecoverCursor(chatJid),
    ASSISTANT_NAME,
    MAX_MESSAGES_PER_PROMPT,
  );

  if (missedMessages.length === 0) return true;

  // --- Session command interception (before trigger check) ---
  const triggerPattern = getTriggerPattern(group.trigger);
  const cmdResult = await handleSessionCommand({
    missedMessages,
    isMainGroup,
    groupName: group.name,
    triggerPattern,
    timezone: TIMEZONE,
    deps: {
      sendMessage: (text) => channel.sendMessage(chatJid, text),
      setTyping: (typing) =>
        channel.setTyping?.(chatJid, typing) ?? Promise.resolve(),
      runAgent: (prompt, onOutput) =>
        runAgent(group, prompt, chatJid, onOutput),
      closeStdin: () => queue.closeStdin(chatJid),
      advanceCursor: (ts) => {
        lastAgentTimestamp[chatJid] = ts;
        saveState();
      },
      formatMessages,
      canSenderInteract: (msg) => {
        const hasTrigger = triggerPattern.test(msg.content.trim());
        const reqTrigger = !isMainGroup && group.requiresTrigger !== false;
        return (
          isMainGroup ||
          !reqTrigger ||
          (hasTrigger &&
            (msg.is_from_me ||
              isTriggerAllowed(chatJid, msg.sender, loadSenderAllowlist())))
        );
      },
    },
  });
  if (cmdResult.handled) return cmdResult.success;
  // --- End session command interception ---

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        triggerPattern.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) {
      return true;
    }
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);
  const traceId = generateTraceId();

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length, traceId },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (group.containerConfig?.disableIdleTimeout) return; // Long-lived worker — no idle reaping
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  // Initialize throbber for this group — tracks which message to react on.
  // State is shared with the warm-container pipe path in startMessageLoop
  // so the throbber works regardless of cold vs warm boot.
  const lastMessageId = missedMessages[missedMessages.length - 1]?.id;
  if (lastMessageId) {
    throbberState.set(group.folder, {
      chatJid,
      messageId: lastMessageId,
      idx: 0,
      lastCycle: 0,
      active: false,
    });
  }

  // Start the throbber immediately
  cycleThrobber(group.folder, channel);

  const output = await runAgent(
    group,
    prompt,
    chatJid,
    async (result) => {
      // Streaming output callback — called for each agent result
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        const suppressed = !!(text && didGroupSendMessage(group.folder));
        logger.info(
          { group: group.name, traceId, suppressed, length: text.length },
          'Agent output',
        );
        // Clear throbber when agent produces output (works for both
        // cold boot and warm piped messages)
        clearThrobber(group.folder, channel);
        // Suppress SDK output if the agent already sent messages via send_message
        // (prevents duplicate Discord messages)
        if (text && !suppressed) {
          await channel.sendMessage(chatJid, text);
          outputSentToUser = true;
          logger.info(
            { group: group.name, traceId, length: text.length },
            'Message sent to channel',
          );
        }
        // Only reset idle timer on actual results, not session-update markers (result: null)
        resetIdleTimer();
      }

      if (result.status === 'success') {
        queue.notifyIdle(chatJid);
      }

      if (result.status === 'error') {
        hadError = true;
      }
    },
    () => cycleThrobber(group.folder, channel),
    traceId,
  );

  clearThrobber(group.folder, channel);
  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);
  clearGroupSentMessage(group.folder);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name, traceId },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name, traceId },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  onHeartbeat?: () => void,
  traceId?: string,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script || undefined,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Update session tracking from container output. On error, clear the
  // session so retries start fresh instead of resuming a broken session.
  const applySessionResult = (output: ContainerOutput) => {
    if (!output.newSessionId) return;
    if (output.status === 'error') {
      delete sessions[group.folder];
      deleteSession(group.folder);
    } else {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }
  };

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        applySessionResult(output);
        await onOutput(output);
      }
    : undefined;

  // Read include_files content for systemPrompt.append (compaction-safe)
  let includeContent: string | undefined;
  const personalConfig = loadPersonalConfig();
  if (personalConfig.include_files?.length) {
    const parts: string[] = [];
    for (const filePath of personalConfig.include_files) {
      const expandedPath = filePath.replace(/^~/, process.env.HOME || '/root');
      try {
        if (fs.existsSync(expandedPath)) {
          parts.push(fs.readFileSync(expandedPath, 'utf-8').trimEnd());
        }
      } catch (err) {
        logger.warn({ path: filePath, err }, 'Failed to read include file');
      }
    }
    if (parts.length > 0) {
      includeContent = parts.join('\n\n---\n\n');
      logger.debug(
        { files: personalConfig.include_files },
        'Loaded include_files for systemPrompt',
      );
    }
  }

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        includeContent,
        traceId,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
      onHeartbeat,
    );

    applySessionResult(output);

    if (output.status === 'error') {
      // Detect stale/corrupt session — clear it so the next retry starts fresh.
      // The session .jsonl can go missing after a crash mid-write, manual
      // deletion, or disk-full. The existing backoff in group-queue.ts
      // handles the retry; we just need to remove the broken session ID.
      const isStaleSession =
        sessionId &&
        output.error &&
        /no conversation found|ENOENT.*\.jsonl|session.*not found/i.test(
          output.error,
        );

      if (isStaleSession) {
        logger.warn(
          { group: group.name, staleSessionId: sessionId, error: output.error },
          'Stale session detected — clearing for next retry',
        );
        delete sessions[group.folder];
        deleteSession(group.folder);
      }

      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (default trigger: ${DEFAULT_TRIGGER})`);

  // Write groups snapshot on startup so the master has current data
  // immediately (not just after processing the first message).
  const startupGroups = getAvailableGroups();
  const startupRegisteredJids = new Set(Object.keys(registeredGroups));
  for (const [, group] of Object.entries(registeredGroups)) {
    if (group.isMain) {
      writeGroupsSnapshot(
        group.folder,
        true,
        startupGroups,
        startupRegisteredJids,
      );
    }
  }

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;

          // --- Session command interception (message loop) ---
          // Scan ALL messages in the batch for a session command.
          const triggerPattern = getTriggerPattern(group.trigger);
          const loopCmdMsg = groupMessages.find(
            (m) => extractSessionCommand(m.content, triggerPattern) !== null,
          );

          if (loopCmdMsg) {
            // Only close active container if the sender is authorized — otherwise an
            // untrusted user could kill in-flight work by sending /compact (DoS).
            // closeStdin no-ops internally when no container is active.
            if (
              isSessionCommandAllowed(
                isMainGroup,
                loopCmdMsg.is_from_me === true,
              )
            ) {
              queue.closeStdin(chatJid);
            }
            // Enqueue so processGroupMessages handles auth + cursor advancement.
            // Don't pipe via IPC — slash commands need a fresh container with
            // string prompt (not MessageStream) for SDK recognition.
            queue.enqueueMessageCheck(chatJid);
            continue;
          }
          // --- End session command interception ---

          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                triggerPattern.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            getOrRecoverCursor(chatJid),
            ASSISTANT_NAME,
            MAX_MESSAGES_PER_PROMPT,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          if (queue.sendMessage(chatJid, formatted)) {
            const pipeTraceId = generateTraceId();
            // Reset the send_message suppression flag for this group.
            // Without this, if the previous message used send_message,
            // the flag stays set and suppresses direct output for all
            // subsequent piped messages in the same container session.
            clearGroupSentMessage(group.folder);
            logger.info(
              { chatJid, count: messagesToSend.length, traceId: pipeTraceId },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();

            // Update throbber target to the latest user message so
            // the reaction appears on the right message in warm containers
            const latestMsgId = messagesToSend[messagesToSend.length - 1]?.id;
            if (latestMsgId) {
              // Clear any existing throbber from the previous message
              clearThrobber(group.folder, channel);
              throbberState.set(group.folder, {
                chatJid,
                messageId: latestMsgId,
                idx: 0,
                lastCycle: 0,
                active: false,
              });
              cycleThrobber(group.folder, channel);
            }

            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    // Wait for either a new message event or the poll interval (whichever first).
    // This gives near-instant response when a Discord message arrives, with the
    // poll interval as a fallback safety net.
    await Promise.race([
      new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL)),
      once(messageWake, 'wake'),
    ]);
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const pending = getMessagesSince(
      chatJid,
      getOrRecoverCursor(chatJid),
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    );
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  const t0 = Date.now();
  let lastStep = t0;
  const step = (label: string) => {
    const now = Date.now();
    const elapsed = now - t0;
    const delta = now - lastStep;
    lastStep = now;
    logger.info(
      { elapsed, delta, step: label },
      `Startup: ${label} (+${elapsed}ms, Δ${delta}ms)`,
    );
  };

  ensureContainerSystemRunning();
  step('container system checked');

  initDatabase();
  step('database initialized');

  loadState();
  step('state loaded');

  // Ensure OneCLI agents exist for all registered groups.
  // Recovers from missed creates (e.g. OneCLI was down at registration time).
  for (const [jid, group] of Object.entries(registeredGroups)) {
    ensureOneCLIAgent(jid, group);
  }

  restoreRemoteControl();

  // Start credential proxy (containers route API calls through this)
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
  );
  step('credential proxy started');

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    const s0 = Date.now();
    let lastShutdownStep = s0;
    const sstep = (label: string) => {
      const now = Date.now();
      const elapsed = now - s0;
      const delta = now - lastShutdownStep;
      lastShutdownStep = now;
      logger.info(
        { elapsed, delta, step: label },
        `Shutdown: ${label} (+${elapsed}ms, Δ${delta}ms)`,
      );
    };

    logger.info({ signal }, 'Shutdown signal received');

    // Notify master channel before tearing down (3s timeout so we don't hang)
    const mainEntry = Object.entries(registeredGroups).find(
      ([, g]) => g.isMain,
    );
    if (mainEntry) {
      const ch = findChannel(channels, mainEntry[0]);
      if (ch) {
        try {
          await Promise.race([
            ch.sendMessage(mainEntry[0], `NanoClaw shutting down (${signal})`),
            new Promise((r) => setTimeout(r, 3000)),
          ]);
        } catch (err) {
          logger.debug({ err }, 'Shutdown notification failed');
        }
      }
      // Stop status pin loop before marking offline
      stopStatusPin?.();
      stopWorkerPins?.();

      // Mark pinned status as offline (best-effort, 3s timeout)
      const dcShutdown = channels.find((c) => c.name === 'discord') as
        | DiscordChannel
        | undefined;
      if (dcShutdown) {
        await markStatusOffline(mainEntry[0], {
          editMessage: (jid, msgId, text) =>
            dcShutdown.editMessage(jid, msgId, text),
        });
        sstep('status pin marked offline');
      }
    }

    proxyServer.close();
    sstep('credential proxy closed');
    await queue.shutdown(10000);
    sstep('queue shut down');
    for (const ch of channels) await ch.disconnect();
    sstep('channels disconnected');
    sstep('shutdown complete');
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
      messageWake.emit('wake');
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels in parallel.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  const channelNames = getRegisteredChannelNames();
  const connectionPromises = channelNames.map(async (channelName) => {
    const t1 = Date.now();
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      return null;
    }
    await channel.connect();
    const elapsed = Date.now() - t1;
    logger.info(
      { channel: channelName, elapsed },
      `Channel connected (${elapsed}ms)`,
    );
    return channel;
  });
  const connectedChannels = (await Promise.all(connectionPromises)).filter(
    Boolean,
  ) as Channel[];
  channels.push(...connectedChannels);
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }
  step(`channels connected (${channels.length})`);

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  // Find the Discord channel instance for dynamic worker operations
  const discordChannel = channels.find((ch) => ch.name === 'discord');

  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    createDiscordChannel: discordChannel?.createChannel
      ? (guildId, name, categoryId) =>
          discordChannel.createChannel!(guildId, name, categoryId)
      : undefined,
    deleteDiscordChannel: discordChannel?.deleteChannel
      ? (channelId) => discordChannel.deleteChannel!(channelId)
      : undefined,
    stopGroupContainer: (jid: string) => {
      queue.closeStdin(jid);
    },
    getContainerStats: () => ({
      active: queue.getActiveCount(),
      max: MAX_CONCURRENT_CONTAINERS,
    }),
    // Don't clear throbber on send_message — the agent may send an
    // intermediate ack ("On it...") while still working. The throbber
    // clears when the final SDK result arrives in the output callback.
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
  });
  startSessionCleanup();
  queue.setProcessMessagesFn(processGroupMessages);

  step('subsystems started');

  // Sync profiles: propagate profile changes to existing workers + master
  syncWorkerProfiles();
  syncMasterProfile();
  step('profiles synced');

  recoverPendingMessages();

  // Auto-respawn reverted: spawning all workers on restart causes Discord spam
  // (each worker responds to the synthetic message). Workers spawn lazily on
  // first real message instead. The CONTAINER RESTARTED notice in agent-runner's
  // system prompt provides restart context when they do spawn.

  // Start resource monitor — alerts #master on high memory/disk/containers
  const mainGroup = Object.entries(registeredGroups).find(([, g]) => g.isMain);
  if (mainGroup) {
    const mainChannel = findChannel(channels, mainGroup[0]);
    if (mainChannel) {
      startResourceMonitor(
        mainGroup[0],
        (jid, text) => mainChannel.sendMessage(jid, text),
        () => queue.getActiveCount(),
      );
    }
  }

  // Start pinned status message updater (Discord only)
  if (mainGroup && discordChannel) {
    const dc = discordChannel as DiscordChannel;
    stopStatusPin = startStatusPin(mainGroup[0], STATUS_PIN_INTERVAL, {
      sendMessage: (jid, text) => dc.sendMessageWithId(jid, text),
      editMessage: (jid, msgId, text) => dc.editMessage(jid, msgId, text),
      pinMessage: (jid, msgId) => dc.pinMessage(jid, msgId),
    });

    // Start worker status pins in each worker channel
    stopWorkerPins = startWorkerStatusPins(STATUS_PIN_INTERVAL, {
      sendMessage: (jid, text) => dc.sendMessageWithId(jid, text),
      editMessage: (jid, msgId, text) => dc.editMessage(jid, msgId, text),
      pinMessage: (jid, msgId) => dc.pinMessage(jid, msgId),
      unpinMessage: (jid, msgId) => dc.unpinMessage?.(jid, msgId),
    });
  }

  step('startup complete');

  // Notify master channel that NanoClaw is online (host-level, no agent involved)
  if (mainGroup) {
    const ch = findChannel(channels, mainGroup[0]);
    if (ch) {
      const elapsedS = ((Date.now() - t0) / 1000).toFixed(1);
      ch.sendMessage(
        mainGroup[0],
        `NanoClaw online (${elapsedS}s startup)`,
      ).catch(() => {});
    }
  }

  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
