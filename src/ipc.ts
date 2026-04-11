import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  BACKEND_ANTHROPIC,
  BACKEND_NEURALWATT,
  DATA_DIR,
  type InferenceBackend,
  IPC_POLL_INTERVAL,
  NEURALWATT_PROXY_PORT,
  TIMEZONE,
  WORKER_BACKENDS_FILENAME,
} from './config.js';

const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-4-6';
import { AvailableGroup } from './container-runner.js';
import { sanitizeFolderName } from './container-runtime.js';
import { readEnvFile } from './env.js';
import { logWorkerEvent, readWorkerEvents } from './worker-events.js';

/**
 * Sanitize session transcripts when switching from Neuralwatt to Claude.
 *
 * Background: Neuralwatt models produce thinking blocks with empty signatures
 * ("signature":""). When the worker is switched back to Claude, the SDK resumes
 * the session by replaying the full JSONL transcript to Claude's API. Claude's
 * API validates thinking block signatures and rejects empty ones with:
 *
 *   "messages.N.content.0: Invalid signature in thinking block"
 *
 * The reverse direction (Claude → NW) works fine because NW ignores signatures.
 *
 * This function strips thinking blocks with empty/missing signatures from all
 * JSONL transcript files for the worker. The rest of the conversation (user
 * messages, tool calls, text responses) is preserved, so the agent retains
 * its memory of prior turns after the switch.
 *
 * Note: Modified lines are re-serialized with JSON.stringify, so any
 * non-standard formatting in the original JSONL is normalized. This is fine
 * since JSONL lines are independent and the SDK only cares about the data.
 */
function sanitizeThinkingBlocks(folder: string): number {
  const sessionsDir = path.join(DATA_DIR, 'sessions', folder);

  // Find all JSONL transcript files (main + subagent conversations)
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sessionsDir, {
      recursive: true,
      withFileTypes: true,
    });
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      logger.warn({ err, folder }, 'Failed to read sessions directory');
    }
    return 0;
  }
  const jsonlFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
    .map((e) => path.join(e.parentPath, e.name));
  let totalStripped = 0;

  for (const filePath of jsonlFiles) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    let modified = false;

    const newLines = lines.map((line) => {
      if (!line.trim()) return line;
      try {
        const entry = JSON.parse(line);
        // Only process assistant messages with content arrays
        if (
          entry.type !== 'assistant' ||
          !Array.isArray(entry.message?.content)
        )
          return line;

        const originalLength = entry.message.content.length;
        entry.message.content = entry.message.content.filter(
          (block: { type: string; signature?: string }) => {
            if (block.type !== 'thinking') return true;
            // Strip thinking blocks with empty or missing signatures
            // (produced by NW models). Keep blocks with real signatures (Claude).
            if (!block.signature) {
              totalStripped++;
              return false;
            }
            return true;
          },
        );

        if (entry.message.content.length !== originalLength) {
          modified = true;
          // If all content blocks were thinking blocks, add a placeholder
          // so the SDK doesn't choke on an empty content array.
          if (entry.message.content.length === 0) {
            entry.message.content.push({
              type: 'text',
              text: '[thinking redacted]',
            });
          }
          return JSON.stringify(entry);
        }
        return line;
      } catch {
        return line; // Don't touch unparseable lines
      }
    });

    if (modified) {
      // Atomic write: write to temp file then rename, so a crash mid-write
      // doesn't corrupt the transcript.
      const tmpPath = filePath + '.tmp';
      fs.writeFileSync(tmpPath, newLines.join('\n'));
      fs.renameSync(tmpPath, filePath);
    }
  }

  return totalStripped;
}

/** Read the current backend for a worker. Returns 'anthropic' if not in worker-backends.json. */
function getCurrentBackend(folder: string): string {
  const backendsPath = path.join(DATA_DIR, WORKER_BACKENDS_FILENAME);
  try {
    const backends = JSON.parse(fs.readFileSync(backendsPath, 'utf-8'));
    return backends[folder]?.backend || BACKEND_ANTHROPIC;
  } catch {
    return BACKEND_ANTHROPIC; // File missing or corrupt
  }
}

const DEFAULT_NEURALWATT_MODEL = 'moonshotai/Kimi-K2.5';

/** Read-modify-write worker-backends.json. Atomic via temp file. */
function updateWorkerBackends(
  folder: string,
  backend: string | null,
  model?: string,
): void {
  const backendsPath = path.join(DATA_DIR, WORKER_BACKENDS_FILENAME);
  let backends: Record<string, { backend: string; model?: string }> = {};
  try {
    backends = JSON.parse(fs.readFileSync(backendsPath, 'utf-8'));
  } catch {
    /* File missing or corrupt — start fresh */
  }

  if (backend === BACKEND_NEURALWATT) {
    backends[folder] = {
      backend: BACKEND_NEURALWATT,
      model: model || DEFAULT_NEURALWATT_MODEL,
    };
  } else if (backend === BACKEND_ANTHROPIC) {
    backends[folder] = {
      backend: BACKEND_ANTHROPIC,
      model: model || DEFAULT_ANTHROPIC_MODEL,
    };
  } else if (backend === null) {
    delete backends[folder];
  }

  fs.mkdirSync(path.dirname(backendsPath), { recursive: true });
  const tmpPath = `${backendsPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(backends, null, 2));
  fs.renameSync(tmpPath, backendsPath);
}

/** Clean stale NANOCLAW_BACKEND/MODEL from worker.env (legacy cleanup).
 * Backend routing now comes from worker-backends.json; the container-runner
 * injects NANOCLAW_BACKEND directly. This just strips the dead env vars. */
export function updateWorkerEnvBackend(
  folder: string,
  _backend: InferenceBackend | string,
  _model?: string,
): void {
  const envPath = path.join(DATA_DIR, 'sessions', folder, 'worker.env');
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf-8');
  const lines = content
    .split('\n')
    .filter(
      (l) =>
        !l.startsWith('NANOCLAW_BACKEND=') && !l.startsWith('NANOCLAW_MODEL='),
    );
  const result = lines.join('\n');
  fs.writeFileSync(envPath, content.endsWith('\n') ? result + '\n' : result);
}

/** Format a usage stats object into a human-readable string. */
function formatUsageStats(stats: {
  requests?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  energy_joules?: number;
  energy_kwh?: number;
}): string {
  const parts: string[] = [];
  if (stats.requests) parts.push(`${stats.requests} requests`);
  if (stats.total_tokens) {
    const t = stats.total_tokens;
    parts.push(t >= 1000 ? `${(t / 1000).toFixed(1)}k tokens` : `${t} tokens`);
  }
  if (stats.energy_joules) {
    const j = stats.energy_joules;
    if (j >= 1000) parts.push(`${(j / 1000).toFixed(2)} kJ`);
    else parts.push(`${j.toFixed(1)} J`);
  }
  if (stats.energy_kwh) {
    const kwh = stats.energy_kwh;
    if (kwh >= 0.001) parts.push(`${(kwh * 1000).toFixed(1)} Wh`);
    else parts.push(`${(kwh * 1e6).toFixed(1)} mWh`);
  }
  return parts.join(', ') || 'no usage data';
}

/** Fetch usage stats for a worker from the shim. Returns null if unavailable. */
async function fetchWorkerUsage(
  folder: string,
): Promise<Record<string, number> | null> {
  try {
    const resp = await fetch(
      `http://localhost:${NEURALWATT_PROXY_PORT}/usage/${folder}`,
    );
    if (!resp.ok) {
      logger.debug({ folder, status: resp.status }, 'Shim usage fetch failed');
      return null;
    }
    const data = await resp.json();
    if ((data as any).error) return null;
    return data as Record<string, number>;
  } catch (err) {
    logger.debug(
      { err, folder },
      'Shim usage fetch error (shim may not be running)',
    );
    return null;
  }
}
import {
  createTask,
  deleteRegisteredGroup,
  deleteSession,
  deleteTask,
  getSession,
  getTaskById,
  getTasksForGroup,
  setSession,
  updateTask,
} from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import {
  assembleWorkerInstructions,
  loadWorkerProfile,
} from './profile-sync.js';
import { RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  // Optional: create/delete Discord channels for dynamic workers
  createDiscordChannel?: (
    guildId: string,
    name: string,
    categoryId?: string,
  ) => Promise<string>;
  deleteDiscordChannel?: (channelId: string) => Promise<void>;
  // Optional: stop a group's running container
  stopGroupContainer?: (jid: string) => void;
  // Container stats for capacity warnings
  getContainerStats?: () => { active: number; max: number };
  // Callback when tasks change via IPC (broadcasts updated snapshots)
  onTasksChanged?: () => void;
}

let ipcWatcherRunning = false;

/**
 * Tracks groups that sent IPC messages (send_message) during the current agent turn.
 * The output callback in index.ts checks this to suppress duplicate SDK output.
 */
const groupsSentMessage = new Set<string>();

export function markGroupSentMessage(sourceGroup: string): void {
  groupsSentMessage.add(sourceGroup);
}

export function didGroupSendMessage(sourceGroup: string): boolean {
  return groupsSentMessage.has(sourceGroup);
}

export function clearGroupSentMessage(sourceGroup: string): void {
  groupsSentMessage.delete(sourceGroup);
}

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await deps.sendMessage(data.chatJid, data.text);
                  markGroupSentMessage(sourceGroup);
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity and filename for response files
              await processTaskIpc(data, sourceGroup, isMain, deps, file);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

/** Refresh the available_groups.json snapshot for the master's IPC directory. */
function refreshGroupsSnapshot(deps: IpcDeps, sourceGroup: string): void {
  const groups = deps.getAvailableGroups();
  deps.writeGroupsSnapshot(
    sourceGroup,
    true,
    groups,
    new Set(Object.keys(deps.registeredGroups())),
  );
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    // For create_worker / destroy_worker
    guild_id?: string;
    channel_name?: string;
    category_id?: string;
    reply_jid?: string;
    profile?: string;
    backend?: string;
    model?: string;
    worker_name?: string;
    reuse?: 'resume' | 'fresh';
    ports?: string[];
    // For worker_history
    event?: string;
    since?: string;
    limit?: number;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
  taskFilename?: string, // For writing response files back to the agent
): Promise<void> {
  // Write a response file that the agent can poll for
  const writeResponse = (success: boolean, message: string) => {
    if (!taskFilename) return;
    const responsesDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'responses');
    fs.mkdirSync(responsesDir, { recursive: true });
    const responsePath = path.join(responsesDir, taskFilename);
    fs.writeFileSync(responsePath, JSON.stringify({ success, message }));
  };
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const date = new Date(data.schedule_value);
          if (isNaN(date.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = date.toISOString();
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedTask.schedule_value,
                { tz: TIMEZONE },
              );
              updates.next_run = interval.next().toISOString();
            } catch {
              logger.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
                'Invalid cron in task update',
              );
              break;
            }
          } else if (updatedTask.schedule_type === 'interval') {
            const ms = parseInt(updatedTask.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = new Date(Date.now() + ms).toISOString();
            }
          }
        }

        updateTask(data.taskId, updates);
        logger.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        refreshGroupsSnapshot(deps, sourceGroup);
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'create_worker':
      // Create a Discord channel and register a new group for it.
      // Main group only.
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized create_worker attempt blocked',
        );
        break;
      }
      if (!deps.createDiscordChannel) {
        logger.warn('create_worker: no createDiscordChannel handler available');
        break;
      }
      if (data.guild_id && data.channel_name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { folder: data.folder },
            'create_worker: invalid folder name',
          );
          break;
        }
        // Check for duplicate worker name (live worker)
        const existingGroups = deps.registeredGroups();
        const duplicate = Object.values(existingGroups).find(
          (g) => g.folder === data.folder,
        );
        if (duplicate) {
          logger.warn(
            { folder: data.folder },
            'create_worker: duplicate folder name',
          );
          writeResponse(
            false,
            `Worker "${data.channel_name}" already exists. Destroy it first or use a different name.`,
          );
          if (data.reply_jid) {
            await deps.sendMessage(
              data.reply_jid,
              `Worker "${data.channel_name}" already exists. Destroy it first or use a different name.`,
            );
          }
          break;
        }

        // Check for leftover workspace from a previously destroyed worker.
        // If the worker has no session (fully destroyed), default to fresh.
        // Only prompt resume/fresh when there's a session worth preserving.
        const leftoverGroupDir = path.join(
          process.cwd(),
          'groups',
          data.folder,
        );
        const hasLeftover = fs.existsSync(leftoverGroupDir);
        if (hasLeftover && data.reuse !== 'resume' && data.reuse !== 'fresh') {
          // Leftover workspace from a previously destroyed worker.
          // Default to fresh — the worker is gone, the workspace is stale.
          logger.info(
            { folder: data.folder },
            'create_worker: leftover workspace found, defaulting to fresh',
          );
          data.reuse = 'fresh';
        }

        // Handle reuse=fresh: wipe old workspace and session
        if (hasLeftover && data.reuse === 'fresh') {
          fs.rmSync(leftoverGroupDir, { recursive: true, force: true });
          const leftoverSessionDir = path.join(
            DATA_DIR,
            'sessions',
            data.folder,
          );
          if (fs.existsSync(leftoverSessionDir)) {
            fs.rmSync(leftoverSessionDir, { recursive: true, force: true });
          }
          // deleteSession handled by unconditional cleanup below
          logger.info(
            { folder: data.folder },
            'create_worker: wiped leftover workspace (fresh start)',
          );
        }

        // Clear stale session data so a new/recreated worker starts fresh.
        // Stale .claude/ dirs (with old debug logs, skills symlinks, etc.) cause the
        // SDK to crash with exit code 1 before making any API call.
        // Skip when resuming — preserve the existing session ID and .claude/ dir.
        if (data.reuse !== 'resume') {
          deleteSession(data.folder);
          const staleClaudeDir = path.join(
            DATA_DIR,
            'sessions',
            data.folder,
            '.claude',
          );
          if (fs.existsSync(staleClaudeDir)) {
            fs.rmSync(staleClaudeDir, { recursive: true, force: true });
            logger.info(
              { folder: data.folder },
              'create_worker: cleared stale .claude session data',
            );
          }
        }
        // Always clear cached agent-runner source (even on resume) — it's a
        // build cache, not user data. container-runner re-syncs it on spawn.
        const staleRunnerDir = path.join(
          DATA_DIR,
          'sessions',
          data.folder,
          'agent-runner-src',
        );
        if (fs.existsSync(staleRunnerDir)) {
          fs.rmSync(staleRunnerDir, { recursive: true, force: true });
        }

        try {
          const profileName = (data.profile as string) || 'default';
          const { profile, profilePath } = loadWorkerProfile(profileName);
          if (fs.existsSync(profilePath)) {
            logger.info({ profileName, profilePath }, 'Loaded worker profile');
          } else {
            logger.warn(
              { profileName },
              'Worker profile not found, using empty defaults',
            );
          }

          const channelId = await deps.createDiscordChannel(
            data.guild_id,
            data.channel_name,
            data.category_id,
          );
          const jid = `dc:${channelId}`;

          // Set up group directory with assembled CLAUDE.md
          const groupDir = path.join(process.cwd(), 'groups', data.folder);
          fs.mkdirSync(groupDir, { recursive: true });
          // Import is at top of file; assembleInstructions handles the
          // layered concatenation of repo + personal instruction fragments.
          assembleWorkerInstructions(groupDir, data.folder);

          // Write worker env file for init script (repos + tools + skills)
          // Use | as separator — newlines break docker -e parsing
          const workerEnv: Record<string, string> = {};
          if (profile.repos?.length) {
            workerEnv.WORKER_REPOS = profile.repos.map((r) => r.url).join('|');
            const postClones = profile.repos
              .filter((r) => r.postClone)
              .map((r) => `${path.basename(r.url, '.git')}:${r.postClone}`);
            if (postClones.length > 0) {
              workerEnv.WORKER_REPO_POST_CLONE = postClones.join('|');
            }
          }
          if (profile.tools?.length) {
            workerEnv.WORKER_TOOLS = profile.tools.join('|');
          }
          if (profile.skills_repo) {
            workerEnv.WORKER_SKILLS_REPO = profile.skills_repo;
          }
          // Backend selection: 'anthropic' (default) or 'neuralwatt'
          if (data.backend === BACKEND_NEURALWATT) {
            const model = data.model || DEFAULT_NEURALWATT_MODEL;
            workerEnv.NANOCLAW_BACKEND = BACKEND_NEURALWATT;
            workerEnv.NANOCLAW_MODEL = model;
            updateWorkerBackends(data.folder, BACKEND_NEURALWATT, model);
          } else {
            // Anthropic backend - also track in worker-backends.json for status pins
            const model = data.model || DEFAULT_ANTHROPIC_MODEL;
            workerEnv.NANOCLAW_BACKEND = BACKEND_ANTHROPIC;
            workerEnv.NANOCLAW_MODEL = model;
            updateWorkerBackends(data.folder, BACKEND_ANTHROPIC, model);
          }
          const envDir = path.join(DATA_DIR, 'sessions', data.folder);
          fs.mkdirSync(envDir, { recursive: true });
          fs.writeFileSync(
            path.join(envDir, 'worker.env'),
            Object.entries(workerEnv)
              .map(([k, v]) => `${k}=${v}`)
              .join('\n'),
          );

          deps.registerGroup(jid, {
            name: data.channel_name,
            folder: data.folder,
            trigger: data.trigger,
            added_at: new Date().toISOString(),
            containerConfig: {
              additionalMounts: profile.mounts || [],
              ports: [...(profile.ports || []), ...(data.ports || [])],
              disableIdleTimeout: true, // Workers stay alive until explicitly destroyed
            },
            requiresTrigger: false, // Workers have dedicated channels — no trigger needed
          });
          // Notify the master channel that the worker was created
          const backendDesc =
            data.backend === BACKEND_NEURALWATT
              ? ` on **${data.model || 'Neuralwatt'}**`
              : '';
          if (data.reply_jid) {
            await deps.sendMessage(
              data.reply_jid,
              `Worker created: **#${data.channel_name}**${backendDesc} (channel <#${channelId}>)`,
            );
          }
          logger.info(
            {
              channelId,
              folder: data.folder,
              backend: data.backend,
              model: data.model,
            },
            'Worker created',
          );
          logWorkerEvent({
            timestamp: new Date().toISOString(),
            event: data.reuse === 'resume' ? 'resumed' : 'created',
            worker: data.channel_name,
            folder: data.folder,
            details: {
              backend: data.backend || 'anthropic',
              model: data.model,
              profile: data.profile,
            },
          });

          // Refresh snapshot so master can immediately resolve by name
          refreshGroupsSnapshot(deps, sourceGroup);

          // Warn if at or near container capacity.
          // active count doesn't include this new worker yet (spawns on first message),
          // so compare active+1 against max.
          const stats = deps.getContainerStats?.();
          const capacityNote =
            stats && stats.active + 1 > stats.max
              ? `\n⚠️ All container slots are full (${stats.active}/${stats.max}). The worker won't start until a slot frees up.`
              : stats && stats.active + 1 >= stats.max
                ? `\n⚠️ Container slots will be full after this worker starts (${stats.active + 1}/${stats.max}).`
                : '';

          writeResponse(
            true,
            `Worker created: #${data.channel_name}${backendDesc} (channel <#${channelId}>)${capacityNote}`,
          );
          if (capacityNote && data.reply_jid) {
            await deps.sendMessage(data.reply_jid, capacityNote.trim());
          }
        } catch (err) {
          logger.error({ err, data }, 'Failed to create worker');
          writeResponse(false, `Failed to create worker: ${err}`);
          if (data.reply_jid) {
            await deps.sendMessage(
              data.reply_jid,
              `Failed to create worker: ${err}`,
            );
          }
        }
      } else {
        logger.warn(
          { data },
          'create_worker: missing required fields (guild_id, channel_name, folder, trigger)',
        );
      }
      break;

    case 'destroy_worker':
      // Delete a Discord channel and unregister the group.
      // Main group only.
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized destroy_worker attempt blocked',
        );
        break;
      }
      if (!deps.deleteDiscordChannel) {
        logger.warn(
          'destroy_worker: no deleteDiscordChannel handler available',
        );
        break;
      }
      if (data.jid) {
        // Guard against self-destruction
        const groups = deps.registeredGroups();
        const targetGroup = groups[data.jid];
        if (targetGroup?.isMain) {
          logger.warn(
            { jid: data.jid },
            'destroy_worker: refusing to destroy main group',
          );
          if (data.reply_jid) {
            await deps.sendMessage(
              data.reply_jid,
              `Refused: cannot destroy the master group.`,
            );
          }
          break;
        }
        try {
          // Stop the container first, then wait briefly for it to wind down
          // before deleting the channel (avoids race where container tries to
          // send to a deleted channel).
          if (deps.stopGroupContainer) {
            deps.stopGroupContainer(data.jid);
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
          const channelId = data.jid.replace(/^dc:/, '');
          try {
            await deps.deleteDiscordChannel(channelId);
          } catch (channelErr: unknown) {
            // Treat "Unknown Channel" (already deleted) as success —
            // proceed with unregistration cleanup regardless.
            const msg = channelErr instanceof Error ? channelErr.message : '';
            if (!msg.includes('Unknown Channel')) {
              throw channelErr;
            }
            logger.info(
              { jid: data.jid },
              'Discord channel already deleted, proceeding with cleanup',
            );
          }
          // Remove from registered groups (memory + DB)
          if (groups[data.jid]) {
            delete groups[data.jid];
          }
          // Fetch usage stats before removing from DB
          const destroyedFolder = targetGroup?.folder;
          let usageReport = '';
          if (destroyedFolder) {
            const usage = await fetchWorkerUsage(destroyedFolder);
            if (usage && usage.requests > 0) {
              usageReport = `\n📊 Lifetime usage: ${formatUsageStats(usage)}`;
            }
          }

          deleteRegisteredGroup(data.jid);
          if (destroyedFolder) {
            // Keep session ID in the DB so create_worker with reuse="resume"
            // can look it up and pass it to the Claude SDK for continuation.
            // deleteSession is intentionally NOT called here.

            // Preserve session dir (.claude/ with conversation history) so
            // create_worker with reuse="resume" can restore the full session.
            // Only clear the cached agent-runner source — it's a build cache
            // that container-runner re-syncs on spawn anyway.
            const staleRunnerDir = path.join(
              DATA_DIR,
              'sessions',
              destroyedFolder,
              'agent-runner-src',
            );
            if (fs.existsSync(staleRunnerDir)) {
              fs.rmSync(staleRunnerDir, { recursive: true, force: true });
            }

            // Clean up worker-backends.json entry (prevents unbounded growth)
            updateWorkerBackends(destroyedFolder, null);

            // Clean up IPC directory for this worker
            const ipcDir = path.join(DATA_DIR, 'ipc', destroyedFolder);
            if (fs.existsSync(ipcDir)) {
              fs.rmSync(ipcDir, { recursive: true, force: true });
            }

            // Cancel scheduled tasks for this worker
            const workerTasks = getTasksForGroup(destroyedFolder);
            for (const task of workerTasks) {
              deleteTask(task.id);
            }
            if (workerTasks.length > 0) {
              logger.info(
                { folder: destroyedFolder, count: workerTasks.length },
                'Cleaned up scheduled tasks for destroyed worker',
              );
            }
          }
          const destroyMsg = `Worker destroyed: ${targetGroup?.name || data.jid}${usageReport}`;
          if (data.reply_jid) {
            await deps.sendMessage(data.reply_jid, destroyMsg);
          }
          logger.info({ jid: data.jid }, 'Worker destroyed');
          if (destroyedFolder) {
            logWorkerEvent({
              timestamp: new Date().toISOString(),
              event: 'destroyed',
              worker: targetGroup?.name || data.jid,
              folder: destroyedFolder,
            });
          }

          // Refresh snapshot so master no longer resolves this worker
          refreshGroupsSnapshot(deps, sourceGroup);

          writeResponse(true, destroyMsg);
        } catch (err) {
          logger.error({ err, data }, 'Failed to destroy worker');
          writeResponse(false, `Failed to destroy worker: ${err}`);
          if (data.reply_jid) {
            await deps.sendMessage(
              data.reply_jid,
              `Failed to destroy worker: ${err}`,
            );
          }
        }
      } else {
        logger.warn({ data }, 'destroy_worker: missing jid');
      }
      break;

    case 'cleanup_workers': {
      // Kill orphaned containers and remove stale registrations.
      // Main group only.
      if (!isMain) break;
      try {
        const cleaned: string[] = [];

        // 1. Stop orphaned containers (nanoclaw-* that aren't the master)
        const { execSync } = await import('child_process');
        const containerOutput = execSync(
          `docker ps --filter name=nanoclaw- --format '{{.Names}}'`,
          { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
        ).trim();
        const runningContainers = containerOutput
          ? containerOutput.split('\n')
          : [];
        const groups = deps.registeredGroups();
        // Container names sanitize folder names (see sanitizeFolderName),
        // so we apply the same transform to match correctly.
        const groupValues = Object.values(groups);
        const registeredFolders = new Set(
          groupValues.map((g) => sanitizeFolderName(g.folder)),
        );
        const mainFolders = new Set(
          groupValues
            .filter((g) => g.isMain)
            .map((g) => sanitizeFolderName(g.folder)),
        );
        for (const name of runningContainers) {
          // Extract folder from container name: nanoclaw-<folder>-<timestamp>
          const match = name.match(/^nanoclaw-(.+)-\d+$/);
          if (!match) continue;
          const folder = match[1];
          // Keep master container
          if (mainFolders.has(folder)) continue;
          // Kill if not registered
          if (!registeredFolders.has(folder)) {
            try {
              execSync(`docker stop ${name}`, { stdio: 'pipe' });
              cleaned.push(`stopped orphan container: ${name}`);
            } catch {
              /* already stopped */
            }
          }
        }

        // 2. Count remaining containers
        const remainingOutput = execSync(
          `docker ps --filter name=nanoclaw- --format '{{.Names}}'`,
          { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
        ).trim();
        const remaining = remainingOutput
          ? remainingOutput.split('\n').length
          : 0;

        const msg =
          cleaned.length > 0
            ? `Cleaned up ${cleaned.length} items:\n${cleaned.map((c) => `• ${c}`).join('\n')}\n\n${remaining} container(s) running.`
            : `Nothing to clean up. ${remaining} container(s) running.`;
        writeResponse(true, msg);
        if (data.reply_jid) {
          await deps.sendMessage(data.reply_jid, msg);
        }
        logger.info(
          { cleaned: cleaned.length, remaining },
          'cleanup_workers completed',
        );
      } catch (err) {
        const msg = `Cleanup failed: ${err}`;
        writeResponse(false, msg);
        if (data.reply_jid) {
          await deps.sendMessage(data.reply_jid, msg);
        }
      }
      break;
    }

    case 'switch_backend': {
      if (!isMain) break;
      const workerName = data.worker_name as string;
      if (!workerName || !data.backend) {
        writeResponse(false, 'switch_backend: missing worker_name or backend');
        break;
      }

      // Validate model ID against the shim's model list for Neuralwatt switches
      if (data.backend === BACKEND_NEURALWATT && data.model) {
        try {
          const resp = await fetch(
            `http://localhost:${NEURALWATT_PROXY_PORT}/models`,
          );
          const { models } = (await resp.json()) as { models: string[] };
          if (!models.includes(data.model as string)) {
            writeResponse(
              false,
              `Unknown model "${data.model}". Available models:\n${models.join('\n')}`,
            );
            break;
          }
        } catch {
          logger.warn(
            'switch_backend: could not validate model (shim unreachable)',
          );
        }
      }

      // Find the target group by name or folder.
      // "master" or "self" targets the main group (allows switching the
      // master agent's own backend to Neuralwatt or back to Claude).
      const groups = deps.registeredGroups();
      const isMasterTarget = workerName === 'master' || workerName === 'self';
      let targetEntry: [string, RegisteredGroup] | undefined;

      if (isMasterTarget) {
        targetEntry = Object.entries(groups).find(([, g]) => g.isMain === true);
      } else {
        const folder = workerName.startsWith('discord_')
          ? workerName
          : `discord_${workerName}`;
        targetEntry = Object.entries(groups).find(
          ([, g]) => g.folder === folder || g.name === workerName,
        );
      }

      if (!targetEntry) {
        writeResponse(
          false,
          isMasterTarget
            ? 'Main group not found in registered groups.'
            : `Worker "${workerName}" not found.`,
        );
        break;
      }

      const [workerJid, workerGroup] = targetEntry;

      const oldBackend = getCurrentBackend(workerGroup.folder);
      const newBackend =
        data.backend === BACKEND_NEURALWATT
          ? BACKEND_NEURALWATT
          : BACKEND_ANTHROPIC;
      const crossBackendSwitch = oldBackend !== newBackend;

      updateWorkerBackends(
        workerGroup.folder,
        data.backend === BACKEND_NEURALWATT ? BACKEND_NEURALWATT : BACKEND_ANTHROPIC,
        data.model as string | undefined,
      );

      // Clean stale NANOCLAW_BACKEND from worker.env (legacy — routing now
      // comes from worker-backends.json, injected by container-runner).
      updateWorkerEnvBackend(
        workerGroup.folder,
        data.backend as string,
        data.model as string | undefined,
      );

      // When switching from NW to Claude, sanitize thinking blocks in the
      // session transcript BEFORE stopping the container. NW models produce
      // thinking blocks with empty signatures that Claude's API rejects
      // ("Invalid signature in thinking block"). Strip them so the session
      // can resume cleanly on Claude.
      // This must happen before stopGroupContainer because for the master
      // case, stopping the container kills this very process.
      if (
        crossBackendSwitch &&
        oldBackend === BACKEND_NEURALWATT &&
        newBackend === BACKEND_ANTHROPIC
      ) {
        const stripped = sanitizeThinkingBlocks(workerGroup.folder);
        if (stripped > 0) {
          logger.info(
            { worker: workerGroup.name, stripped },
            'Stripped NW thinking blocks from session transcript',
          );
        }
      }

      const modelDesc =
        data.backend === BACKEND_NEURALWATT
          ? `${data.model || 'default Neuralwatt model'}`
          : 'Claude (Anthropic)';

      // Send the response and log BEFORE stopping the container, since
      // stopGroupContainer closes stdin and may kill this process (master case).
      await deps.sendMessage(
        workerJid,
        crossBackendSwitch
          ? `⚙️ Backend switched to **${modelDesc}**. Container restarting, send a message to resume.`
          : `⚙️ Model switched to **${modelDesc}**. Takes effect on your next response.`,
      );

      const msg = `Switched ${workerGroup.name} to ${modelDesc}.`;
      logger.info(
        { worker: workerGroup.name, backend: data.backend, model: data.model },
        msg,
      );

      // Cross-backend switches (Anthropic <-> Neuralwatt) need a container
      // restart because ANTHROPIC_BASE_URL is set at container start.
      // Stop the running container; it will respawn on the next message
      // with the correct URL. Session and workspace are preserved.
      // NOTE: For the master case, this kills our own process — all work
      // (sanitization, messaging, logging) must be done above this point.
      if (crossBackendSwitch && deps.stopGroupContainer) {
        deps.stopGroupContainer(workerJid);
      }
      logWorkerEvent({
        timestamp: new Date().toISOString(),
        event: 'backend_switched',
        worker: workerGroup.name,
        folder: workerGroup.folder,
        details: {
          from: oldBackend,
          to: newBackend,
          model: data.model,
          crossBackendSwitch,
        },
      });
      writeResponse(true, msg);
      if (data.reply_jid) {
        await deps.sendMessage(data.reply_jid as string, msg);
      }
      break;
    }

    case 'worker_history': {
      if (!isMain) break;
      const events = readWorkerEvents({
        worker: data.worker_name as string | undefined,
        event: data.event as string | undefined,
        since: data.since as string | undefined,
        limit: (data.limit as number) || 50,
      });

      if (events.length === 0) {
        writeResponse(true, 'No matching worker events found.');
        break;
      }

      const lines = events.map((e) => {
        const details = e.details
          ? ` (${Object.entries(e.details)
              .filter(([, v]) => v != null)
              .map(([k, v]) => `${k}: ${v}`)
              .join(', ')})`
          : '';
        return `${e.timestamp} | ${e.event} | ${e.worker}${details}`;
      });
      writeResponse(true, lines.join('\n'));
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
