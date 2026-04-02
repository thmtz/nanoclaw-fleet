/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const RESPONSES_DIR = path.join(IPC_DIR, 'responses');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

// ── available_groups.json typed helpers ──────────────────────────
interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
  folder?: string;
}
interface AvailableGroupsFile {
  groups: AvailableGroup[];
  lastSync?: string;
}

/** Read and parse available_groups.json, returning typed group list. */
function readAvailableGroups(): AvailableGroup[] {
  const groupsFile = path.join(IPC_DIR, 'available_groups.json');
  const data: AvailableGroupsFile = JSON.parse(
    fs.readFileSync(groupsFile, 'utf-8'),
  );
  return data.groups || [];
}

/** Find a worker by name or folder slug (e.g. "nw-dev" matches folder "discord_nw-dev"). */
function resolveWorkerJid(nameOrJid: string): string | null {
  if (nameOrJid.startsWith('dc:')) return nameOrJid;
  const groups = readAvailableGroups();
  const match = groups.find(
    (g) =>
      g.isRegistered !== false &&
      (g.name === nameOrJid || g.folder === `discord_${nameOrJid}`),
  );
  return match?.jid ?? null;
}

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

/** Poll for a response file from the host. Returns the parsed response or null on timeout. */
async function waitForResponse(
  taskFilename: string,
  timeoutMs = 15000,
): Promise<{ success: boolean; message: string } | null> {
  // Response filename matches the task filename
  const responsePath = path.join(RESPONSES_DIR, taskFilename);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(responsePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(responsePath, 'utf-8'));
        fs.unlinkSync(responsePath); // Clean up
        return data;
      } catch {
        return null;
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null; // Timed out
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
  {
    text: z.string().describe('The message text to send'),
    sender: z
      .string()
      .optional()
      .describe(
        'Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.',
      ),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'get_backend',
  'Get the current inference backend and model for this worker. Returns backend (anthropic or neuralwatt) and the resolved model name.',
  {},
  async () => {
    const baseUrl = process.env.ANTHROPIC_BASE_URL || '';
    const backend = process.env.NANOCLAW_BACKEND || 'anthropic';
    const model = process.env.NANOCLAW_MODEL || 'opus';

    // For Neuralwatt workers, query the shim for the live config
    // (model can change at runtime via switch_backend)
    if (backend === 'neuralwatt') {
      try {
        const resp = await fetch(`${baseUrl}/worker-config`);
        if (resp.ok) {
          const config = await resp.json();
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(config, null, 2),
              },
            ],
          };
        }
      } catch (err) {
        // Shim unreachable — fall through to env var fallback.
        // Include source so the caller knows this isn't live config.
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  backend,
                  model,
                  resolved_model: model,
                  source: 'env_fallback',
                  warning: `Could not reach shim: ${err instanceof Error ? err.message : err}`,
                },
                null,
                2,
              ),
            },
          ],
        };
      }
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            { backend, model, resolved_model: model },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z
      .string()
      .describe(
        'What the agent should do when the task runs. For isolated mode, include all necessary context here.',
      ),
    schedule_type: z
      .enum(['cron', 'interval', 'once'])
      .describe(
        'cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time',
      ),
    schedule_value: z
      .string()
      .describe(
        'cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)',
      ),
    context_mode: z
      .enum(['group', 'isolated'])
      .default('group')
      .describe(
        'group=runs with chat history and memory, isolated=fresh session (include context in prompt)',
      ),
    target_group_jid: z
      .string()
      .optional()
      .describe(
        '(Main group only) JID of the group to schedule the task for. Defaults to the current group.',
      ),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).`,
            },
          ],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).`,
            },
          ],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (
        /[Zz]$/.test(args.schedule_value) ||
        /[+-]\d{2}:\d{2}$/.test(args.schedule_value)
      ) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".`,
            },
          ],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".`,
            },
          ],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid =
      isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}`,
        },
      ],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return {
          content: [
            { type: 'text' as const, text: 'No scheduled tasks found.' },
          ],
        };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter(
            (t: { groupFolder: string }) => t.groupFolder === groupFolder,
          );

      if (tasks.length === 0) {
        return {
          content: [
            { type: 'text' as const, text: 'No scheduled tasks found.' },
          ],
        };
      }

      const formatted = tasks
        .map(
          (t: {
            id: string;
            prompt: string;
            schedule_type: string;
            schedule_value: string;
            status: string;
            next_run: string;
          }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return {
        content: [
          { type: 'text' as const, text: `Scheduled tasks:\n${formatted}` },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} pause requested.`,
        },
      ],
    };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} resume requested.`,
        },
      ],
    };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} cancellation requested.`,
        },
      ],
    };
  },
);

server.tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z
      .enum(['cron', 'interval', 'once'])
      .optional()
      .describe('New schedule type'),
    schedule_value: z
      .string()
      .optional()
      .describe('New schedule value (see schedule_task for format)'),
  },
  async (args) => {
    // Validate schedule_value if provided
    if (
      args.schedule_type === 'cron' ||
      (!args.schedule_type && args.schedule_value)
    ) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Invalid cron: "${args.schedule_value}".`,
              },
            ],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid interval: "${args.schedule_value}".`,
            },
          ],
          isError: true,
        };
      }
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.schedule_type !== undefined)
      data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined)
      data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} update requested.`,
        },
      ],
    };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z
      .string()
      .describe(
        'The chat JID (e.g., "120363000000000001@g.us", "tg:-1001234567890", "dc:1234567890123456")',
      ),
    name: z.string().describe('Display name for the group'),
    folder: z
      .string()
      .describe(
        'Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")',
      ),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Only the main group can register new groups.',
          },
        ],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Group "${args.name}" registered. It will start receiving messages immediately.`,
        },
      ],
    };
  },
);

server.tool(
  'create_worker',
  `Create a new dynamic worker: a Discord channel + isolated container + agent. Main group only.

This creates a new text channel in the specified Discord guild, registers it as a group, and a container will automatically spawn when the first message arrives. The worker runs independently with its own context.`,
  {
    guild_id: z
      .string()
      .optional()
      .describe(
        'Discord guild (server) ID. Defaults to DISCORD_GUILD_ID env var.',
      ),
    channel_name: z
      .string()
      .describe(
        'Name for the new Discord channel (lowercase, hyphens, e.g., "gpu-experiment-march")',
      ),
    trigger: z
      .string()
      .optional()
      .describe(
        'Trigger word for the worker agent. Defaults to "@" + ASSISTANT_NAME.',
      ),
    category_id: z
      .string()
      .optional()
      .describe('Optional Discord category ID to place the channel under'),
    profile: z
      .string()
      .optional()
      .describe(
        'Worker profile name (default: "default"). Profiles define repos, tools, and mounts.',
      ),
    backend: z
      .enum(['anthropic', 'neuralwatt'])
      .optional()
      .describe(
        'Inference backend. "anthropic" (default) uses Claude. "neuralwatt" uses open-source models via Neuralwatt API.',
      ),
    model: z
      .string()
      .optional()
      .describe(
        'Model to use with neuralwatt backend (e.g., "moonshotai/Kimi-K2.5", "Qwen/Qwen3.5-397B-A17B-FP8"). Ignored for anthropic backend.',
      ),
    reuse: z
      .enum(['resume', 'fresh'])
      .optional()
      .describe(
        'Required when a workspace from a previous worker with the same name exists. ' +
          '"resume" keeps old workspace + conversation history. "fresh" wipes everything and starts clean. ' +
          'If omitted and a collision is detected, the tool returns an error — you MUST ask the user which option they want.',
      ),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Only the main group can create workers.',
          },
        ],
        isError: true,
      };
    }

    const folder = `discord_${args.channel_name}`;

    const data = {
      type: 'create_worker',
      guild_id: args.guild_id || process.env.DISCORD_GUILD_ID,
      channel_name: args.channel_name,
      folder,
      trigger: args.trigger || `@${process.env.ASSISTANT_NAME || 'Andy'}`,
      category_id: args.category_id,
      profile: args.profile,
      backend: args.backend,
      model: args.model,
      reuse: args.reuse,
      reply_jid: process.env.NANOCLAW_CHAT_JID, // reply back to master channel
      timestamp: new Date().toISOString(),
    };

    const taskFile = writeIpcFile(TASKS_DIR, data);

    // Wait for the host to confirm creation
    const response = await waitForResponse(taskFile);
    if (response) {
      return {
        content: [{ type: 'text' as const, text: response.message }],
        isError: !response.success,
      };
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: `Worker "${args.channel_name}" creation requested (waiting for confirmation timed out — check #master for status).`,
        },
      ],
    };
  },
);

server.tool(
  'list_workers',
  `List all registered worker groups. Main group only. Use this to find a worker's JID before destroying it.`,
  {},
  async () => {
    if (!isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Only the main group can list workers.',
          },
        ],
        isError: true,
      };
    }

    // Read available_groups.json which the host writes for us
    try {
      const allGroups = readAvailableGroups();
      const registered = allGroups.filter(
        (g) =>
          g.isRegistered !== false &&
          g.jid !== process.env.NANOCLAW_CHAT_JID, // exclude self (master)
      );
      if (registered.length === 0) {
        return {
          content: [
            { type: 'text' as const, text: 'No workers currently registered.' },
          ],
        };
      }
      const list = registered
        .map(
          (g: { jid: string; name: string; folder?: string }) =>
            `- **${g.name}**${g.folder ? ` (folder: ${g.folder})` : ''} (jid: ${g.jid})`,
        )
        .join('\n');
      return {
        content: [
          { type: 'text' as const, text: `Registered workers:\n${list}` },
        ],
      };
    } catch {
      return {
        content: [
          { type: 'text' as const, text: 'Could not read worker list.' },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'destroy_worker',
  `Destroy a dynamic worker: delete its Discord channel and unregister the group. Main group only.

The worker's container will be stopped and its Discord channel deleted. You can pass either the worker's JID (e.g., "dc:1234567890") or its channel name (e.g., "test-worker"). If a name is given, it will be resolved to the JID from the registered groups list.`,
  {
    worker: z
      .string()
      .describe(
        'Worker JID (e.g., "dc:1234567890") or channel name (e.g., "test-worker")',
      ),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Only the main group can destroy workers.',
          },
        ],
        isError: true,
      };
    }

    // Resolve name to JID if needed
    let jid: string;
    try {
      const resolved = resolveWorkerJid(args.worker);
      if (!resolved) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Worker "${args.worker}" not found. Use list_workers to see available workers.`,
            },
          ],
          isError: true,
        };
      }
      jid = resolved;
    } catch {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Could not resolve worker name "${args.worker}". Pass the JID directly (e.g., "dc:1234567890").`,
          },
        ],
        isError: true,
      };
    }

    const data = {
      type: 'destroy_worker',
      jid,
      reply_jid: process.env.NANOCLAW_CHAT_JID,
      timestamp: new Date().toISOString(),
    };

    const taskFile = writeIpcFile(TASKS_DIR, data);

    const response = await waitForResponse(taskFile);
    if (response) {
      return {
        content: [{ type: 'text' as const, text: response.message }],
        isError: !response.success,
      };
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: `Worker destruction requested for ${jid} (waiting for confirmation timed out — check #master for status).`,
        },
      ],
    };
  },
);

server.tool(
  'cleanup_workers',
  `Clean up orphaned containers and stale state. Main group only.

Stops any running containers that don't belong to a registered worker (leftover from crashed/destroyed workers). Reports what was cleaned and how many containers are still running.

Use this when workers are stuck, container slots are full, or after a series of create/destroy cycles that may have left orphans.`,
  {},
  async () => {
    const data = {
      type: 'cleanup_workers',
      reply_jid: process.env.NANOCLAW_CHAT_JID,
      timestamp: new Date().toISOString(),
    };

    const taskFile = writeIpcFile(TASKS_DIR, data);

    const response = await waitForResponse(taskFile);
    if (response) {
      return {
        content: [{ type: 'text' as const, text: response.message || 'Cleanup completed.' }],
      };
    }

    return {
      content: [{ type: 'text' as const, text: 'Cleanup requested (timed out waiting for confirmation).' }],
    };
  },
);

server.tool(
  'switch_backend',
  `Switch a worker's inference backend at runtime. Main group only.

Changes the model/backend for an existing worker. Takes effect on the worker's next API call (no container restart needed for model changes within Neuralwatt). Switching between Anthropic and Neuralwatt requires a container restart.`,
  {
    worker_name: z
      .string()
      .describe(
        'Worker name (e.g., "nw-dev") or folder (e.g., "discord_nw-dev")',
      ),
    backend: z.enum(['anthropic', 'neuralwatt']).describe('Target backend'),
    model: z
      .string()
      .optional()
      .describe(
        'Model for neuralwatt backend (e.g., "moonshotai/Kimi-K2.5"). Ignored for anthropic.',
      ),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Only the main group can switch worker backends.',
          },
        ],
        isError: true,
      };
    }

    const data = {
      type: 'switch_backend',
      worker_name: args.worker_name,
      backend: args.backend,
      model: args.model,
      reply_jid: chatJid,
      timestamp: new Date().toISOString(),
    };

    const taskFile = writeIpcFile(TASKS_DIR, data);
    const response = await waitForResponse(taskFile);

    if (response?.success) {
      return {
        content: [{ type: 'text' as const, text: response.message }],
      };
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: response?.message || 'Backend switch timed out.',
        },
      ],
      isError: !response?.success,
    };
  },
);

server.tool(
  'transfer_worker',
  `Transfer a worker's session to a new worker, optionally switching backend. Main group only.

The source worker is destroyed and a new worker is created with the same workspace and conversation history. Use this to switch a worker between Anthropic and Neuralwatt without losing context.`,
  {
    source_worker: z.string().describe('Source worker name (e.g., "nw-dev")'),
    target_name: z
      .string()
      .describe('Name for the new worker (e.g., "nw-dev-claude")'),
    target_backend: z
      .enum(['anthropic', 'neuralwatt'])
      .optional()
      .describe('Backend for the new worker. Defaults to anthropic.'),
    target_model: z
      .string()
      .optional()
      .describe('Model for neuralwatt backend.'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Only the main group can transfer workers.',
          },
        ],
        isError: true,
      };
    }

    const data = {
      type: 'transfer_worker',
      source_worker: args.source_worker,
      target_name: args.target_name,
      target_backend: args.target_backend,
      target_model: args.target_model,
      reply_jid: chatJid,
      timestamp: new Date().toISOString(),
    };

    const taskFile = writeIpcFile(TASKS_DIR, data);
    const response = await waitForResponse(taskFile, 30000);

    if (response?.success) {
      return {
        content: [{ type: 'text' as const, text: response.message }],
      };
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: response?.message || 'Transfer timed out.',
        },
      ],
      isError: !response?.success,
    };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
