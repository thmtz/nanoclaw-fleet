import { randomUUID } from 'node:crypto';
import fs from 'fs';
import path from 'path';

import {
  query as sdkQuery,
  type HookCallback,
  type PostCompactHookInput,
  type PreCompactHookInput,
} from '@anthropic-ai/claude-agent-sdk';

import { clearContainerToolInFlight, setContainerToolInFlight } from '../db/connection.js';
import { writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting } from '../db/session-routing.js';
import { registerProvider } from './provider-registry.js';
import type {
  AgentProvider,
  AgentQuery,
  McpServerConfig,
  ProviderEvent,
  ProviderOptions,
  QueryInput,
} from './types.js';

function log(msg: string): void {
  console.error(`[claude-provider] ${msg}`);
}

// Deferred SDK builtins that either sidestep nanoclaw's own scheduling or
// don't fit our async message-passing model (they're designed for Claude
// Code's interactive UI and would hang here).
//
// - CronCreate / CronDelete / CronList / ScheduleWakeup: we have durable
//   scheduling via mcp__nanoclaw__schedule_task.
// - AskUserQuestion: SDK returns a placeholder instead of blocking on a
//   real answer — we have mcp__nanoclaw__ask_user_question that persists
//   the question and blocks on the real reply.
// - EnterPlanMode / ExitPlanMode / EnterWorktree / ExitWorktree: Claude
//   Code UI affordances; in a headless container they'd appear stuck.
const SDK_DISALLOWED_TOOLS = [
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'EnterWorktree',
  'ExitWorktree',
];

// Tool allowlist for NanoClaw agent containers
const TOOL_ALLOWLIST = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Task',
  'TaskOutput',
  'TaskStop',
  'TeamCreate',
  'TeamDelete',
  'SendMessage',
  'TodoWrite',
  'ToolSearch',
  'Skill',
  'NotebookEdit',
  'mcp__nanoclaw__*',
];

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

/**
 * Push-based async iterable for streaming user messages to the Claude SDK.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

// ── Transcript archiving (PreCompact hook) ──

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text =
          typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
      /* skip unparseable lines */
    }
  }
  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null, assistantName?: string): string {
  const now = new Date();
  const dateStr = now.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const lines = [`# ${title || 'Conversation'}`, '', `Archived: ${dateStr}`, '', '---', ''];
  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : assistantName || 'Assistant';
    const content = msg.content.length > 2000 ? msg.content.slice(0, 2000) + '...' : msg.content;
    lines.push(`**${sender}**: ${content}`, '');
  }
  return lines.join('\n');
}

/**
 * PreToolUse hook: record the current tool + its declared timeout so the host
 * sweep can widen its stuck tolerance while Bash is running a long-declared
 * script. Defense-in-depth: if SDK_DISALLOWED_TOOLS slips through somehow,
 * block the call here instead of letting the agent hang.
 */
const preToolUseHook: HookCallback = async (input) => {
  const i = input as { tool_name?: string; tool_input?: Record<string, unknown> };
  const toolName = i.tool_name ?? '';
  if (SDK_DISALLOWED_TOOLS.includes(toolName)) {
    return {
      decision: 'block',
      stopReason: `Tool '${toolName}' is not available in this environment — use the nanoclaw equivalent.`,
    } as unknown as ReturnType<HookCallback>;
  }
  // Bash exposes its timeout via the tool_input.timeout field (ms). Any other
  // tool: no declared timeout.
  const declaredTimeoutMs =
    toolName === 'Bash' && typeof i.tool_input?.timeout === 'number' ? (i.tool_input.timeout as number) : null;
  try {
    setContainerToolInFlight(toolName, declaredTimeoutMs);
  } catch (err) {
    log(`PreToolUse: failed to record container_state: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { continue: true };
};

/** Clear in-flight tool on PostToolUse / PostToolUseFailure. */
const postToolUseHook: HookCallback = async () => {
  try {
    clearContainerToolInFlight();
  } catch (err) {
    log(`PostToolUse: failed to clear container_state: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { continue: true };
};

/**
 * Post a Discord notice to the user's channel before compaction begins.
 * Compaction can take several seconds; without this the user sees the
 * agent go silent mid-turn with no signal that anything's happening.
 *
 * Mirrors v1's `sendCompactionNotice` (container/agent-runner/src/index.ts
 * in the v1-old tree) — same wording, but writes to the v2 outbound DB
 * instead of the v1 IPC file drop.
 */
export function sendCompactionNotice(trigger: string): void {
  try {
    const routing = getSessionRouting();
    if (!routing.channel_type || !routing.platform_id) {
      log('Skipping compaction notice — no session routing');
      return;
    }
    writeMessageOut({
      id: randomUUID(),
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({
        text: `⏳ Compacting context (${trigger})… I'll be back in a moment.`,
      }),
      systemNotice: true,
    });
    log(`Sent compaction notice (trigger=${trigger})`);
  } catch (err) {
    log(`Failed to send compaction notice: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Closes the loop opened by sendCompactionNotice — the user knows the
 * agent went silent for compaction and is waiting to hear it's back.
 * The SDK auto-continues the in-flight conversation after compaction
 * (so any user message that arrived during it is processed normally),
 * which means this notice + the agent's actual reply land back-to-back.
 */
export function sendPostCompactionNotice(trigger: string): void {
  try {
    const routing = getSessionRouting();
    if (!routing.channel_type || !routing.platform_id) {
      log('Skipping post-compaction notice — no session routing');
      return;
    }
    writeMessageOut({
      id: randomUUID(),
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({
        text: `✅ Compaction complete (${trigger}). Continuing…`,
      }),
      systemNotice: true,
    });
    log(`Sent post-compaction notice (trigger=${trigger})`);
  } catch (err) {
    log(`Failed to send post-compaction notice: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const postCompactHook: HookCallback = async (input) => {
  const postCompact = input as PostCompactHookInput;
  sendPostCompactionNotice(postCompact.trigger || 'auto');
  return {};
};

function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input) => {
    const preCompact = input as PreCompactHookInput;
    const { transcript_path: transcriptPath, session_id: sessionId } = preCompact;

    sendCompactionNotice(preCompact.trigger || 'auto');

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);
      if (messages.length === 0) return {};

      // Try to get summary from sessions index
      let summary: string | undefined;
      const indexPath = path.join(path.dirname(transcriptPath), 'sessions-index.json');
      if (fs.existsSync(indexPath)) {
        try {
          const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
          summary = index.entries?.find(
            (e: { sessionId: string; summary?: string }) => e.sessionId === sessionId,
          )?.summary;
        } catch {
          /* ignore */
        }
      }

      const name = summary
        ? summary
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 50)
        : `conversation-${new Date().getHours().toString().padStart(2, '0')}${new Date().getMinutes().toString().padStart(2, '0')}`;

      const conversationsDir = '/workspace/agent/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });
      const filename = `${new Date().toISOString().split('T')[0]}-${name}.md`;
      fs.writeFileSync(
        path.join(conversationsDir, filename),
        formatTranscriptMarkdown(messages, summary, assistantName),
      );
      log(`Archived conversation to ${filename}`);
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }
    return {};
  };
}

// ── Provider ──

/**
 * Claude Code auto-compacts context at this window (tokens). Kept here so
 * the generic bootstrap doesn't need to know about Claude-specific env vars.
 */
const CLAUDE_CODE_AUTO_COMPACT_WINDOW = '165000';

/**
 * Stale-session detection. Matches Claude Code's error text when a
 * resumed session can't be found — missing transcript .jsonl, unknown
 * session ID, etc.
 */
const STALE_SESSION_RE = /no conversation found|ENOENT.*\.jsonl|session.*not found/i;

export class ClaudeProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = true;

  private assistantName?: string;
  private mcpServers: Record<string, McpServerConfig>;
  private env: Record<string, string | undefined>;
  private additionalDirectories?: string[];

  constructor(options: ProviderOptions = {}) {
    this.assistantName = options.assistantName;
    this.mcpServers = options.mcpServers ?? {};
    this.additionalDirectories = options.additionalDirectories;
    // Default first, host-supplied env wins. Lets the host override
    // CLAUDE_CODE_AUTO_COMPACT_WINDOW per-worker (resolved from the
    // worker's model in src/compact-window.ts) without touching this
    // constant. Pre-fix the spread order was inverted, so the hardcoded
    // 165k always won regardless of what the host passed.
    this.env = {
      CLAUDE_CODE_AUTO_COMPACT_WINDOW,
      ...(options.env ?? {}),
    };
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    const stream = new MessageStream();
    stream.push(input.prompt);

    const instructions = input.systemContext?.instructions;

    // Allow the host to pin a specific Claude model via ANTHROPIC_MODEL
    // (set by src/providers/claude.ts from container.json.providers.claude
    // .model). Empty / unset ⇒ SDK picks its default (user's subscription).
    const model = process.env.ANTHROPIC_MODEL?.trim() || undefined;

    const sdkResult = sdkQuery({
      prompt: stream,
      options: {
        cwd: input.cwd,
        additionalDirectories: this.additionalDirectories,
        resume: input.continuation,
        pathToClaudeCodeExecutable: '/pnpm/claude',
        systemPrompt: instructions
          ? { type: 'preset' as const, preset: 'claude_code' as const, append: instructions }
          : undefined,
        allowedTools: TOOL_ALLOWLIST,
        disallowedTools: SDK_DISALLOWED_TOOLS,
        env: this.env,
        ...(model ? { model } : {}),
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project', 'user'],
        mcpServers: this.mcpServers,
        hooks: {
          PreToolUse: [{ hooks: [preToolUseHook] }],
          PostToolUse: [{ hooks: [postToolUseHook] }],
          PostToolUseFailure: [{ hooks: [postToolUseHook] }],
          PreCompact: [{ hooks: [createPreCompactHook(this.assistantName)] }],
          PostCompact: [{ hooks: [postCompactHook] }],
        },
      },
    });

    let aborted = false;

    async function* translateEvents(): AsyncGenerator<ProviderEvent> {
      let messageCount = 0;
      // Track the most recent assistant message's stop_reason + model so
      // the result event can report them alongside aggregate usage.
      let lastStopReason: string | undefined;
      let lastModel: string | undefined;
      for await (const message of sdkResult) {
        if (aborted) return;
        messageCount++;

        // Yield activity for every SDK event so the poll loop knows the agent is working
        yield { type: 'activity' };

        if (message.type === 'system' && message.subtype === 'init') {
          yield { type: 'init', continuation: message.session_id };
        } else if (message.type === 'assistant') {
          // Claude Code SDK wraps the raw Anthropic API message in
          // message.message; usage + stop_reason live there.
          const inner = (
            message as {
              message?: { stop_reason?: string; model?: string; content?: Array<{ type?: string; name?: string }> };
            }
          ).message;
          if (inner?.stop_reason) lastStopReason = inner.stop_reason;
          if (inner?.model) lastModel = inner.model;
          // Surface tool_use blocks to the poll loop so it can track
          // whether `mcp__nanoclaw__send_message` ran this turn (used by
          // dispatchResultText to suppress the final turn text when a
          // real send_message already delivered the reply).
          if (Array.isArray(inner?.content)) {
            for (const block of inner.content) {
              if (block?.type === 'tool_use' && typeof block.name === 'string') {
                yield { type: 'tool_use', tool_name: block.name };
              }
            }
          }
        } else if (message.type === 'result') {
          const text = 'result' in message ? ((message as { result?: string }).result ?? null) : null;
          // Aggregate token usage from the SDK's result summary (the SDK
          // sums per-turn usage across an entire query).
          const rawUsage = (
            message as {
              usage?: {
                input_tokens?: number;
                output_tokens?: number;
                cache_read_input_tokens?: number;
                cache_creation_input_tokens?: number;
              };
            }
          ).usage;
          const usage = rawUsage
            ? {
                model: lastModel,
                input_tokens:
                  (rawUsage.input_tokens ?? 0) +
                  (rawUsage.cache_read_input_tokens ?? 0) +
                  (rawUsage.cache_creation_input_tokens ?? 0),
                output_tokens: rawUsage.output_tokens ?? 0,
                cached_tokens: rawUsage.cache_read_input_tokens ?? 0,
                cache_creation_tokens: rawUsage.cache_creation_input_tokens ?? 0,
                stop_reason: lastStopReason,
              }
            : lastStopReason || lastModel
              ? { model: lastModel, stop_reason: lastStopReason }
              : undefined;
          yield { type: 'result', text, usage };
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'api_retry') {
          yield { type: 'error', message: 'API retry', retryable: true };
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'rate_limit_event') {
          yield { type: 'error', message: 'Rate limit', retryable: false, classification: 'quota' };
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'compact_boundary') {
          // compact_boundary is a mid-stream system event — the SDK keeps
          // streaming the agent's actual response after compaction. Yielding
          // `result` here (as we used to) caused the poll-loop to treat the
          // turn as done, mark messages completed, and dispatch
          // "Context compacted (X tokens)." as if it were the agent's reply.
          // The user's pre-compact "I'll be back" notice now comes from the
          // PreCompact hook; this branch is informational only.
          const meta = (message as { compact_metadata?: { pre_tokens?: number } }).compact_metadata;
          const detail = meta?.pre_tokens ? ` (${meta.pre_tokens.toLocaleString()} tokens compacted)` : '';
          yield { type: 'progress', message: `Context compacted${detail}.` };
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
          const tn = message as { summary?: string };
          yield { type: 'progress', message: tn.summary || 'Task notification' };
        }
      }
      log(`Query completed after ${messageCount} SDK messages`);
    }

    return {
      push: (msg) => stream.push(msg),
      end: () => stream.end(),
      events: translateEvents(),
      abort: () => {
        aborted = true;
        stream.end();
      },
    };
  }
}

registerProvider('claude', (opts) => new ClaudeProvider(opts));
