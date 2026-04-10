# Source Core Layer

The orchestration engine: database, security, IPC, message routing, container lifecycle, and scheduling.

---

## src/db.ts (MODIFIED)

**Intent:** Migrated state from JSON files to SQLite. Sessions, registered groups, and router state that were previously stored in `data/sessions.json`, `data/registered_groups.json`, and `data/router_state.json` are now in the same `store/messages.db` SQLite database. Includes automatic migration of those JSON files on first startup.

**Dependencies:** `better-sqlite3`, `./config.js`, `./group-folder.js`, `./logger.js`, `./types.js`.

**How to apply:**

Schema additions (all `CREATE TABLE IF NOT EXISTS`):
- `router_state (key TEXT PK, value TEXT)` — replaces `router_state.json`.
- `sessions (group_folder TEXT PK, session_id TEXT)` — replaces `sessions.json`.
- `registered_groups (jid PK, name, folder UNIQUE, trigger_pattern, added_at, container_config, requires_trigger, is_main)` — replaces `registered_groups.json`.

Column migrations (auto-applied via `ALTER TABLE ... ADD COLUMN` with try/catch):
- `messages.is_bot_message INTEGER DEFAULT 0`
- `registered_groups.is_main INTEGER DEFAULT 0`
- `chats.channel TEXT`, `chats.is_group INTEGER DEFAULT 0`
- `scheduled_tasks.context_mode TEXT DEFAULT 'isolated'`

`storeMessage` signature changed — now takes a `NewMessage` object instead of a `proto.IWebMessageInfo` (Baileys type removed). Dependency on `@whiskeysockets/baileys` removed from this file entirely.

`storeChatMetadata` now accepts optional `name`, `channel`, `isGroup` parameters and does an upsert that preserves the newer timestamp.

New exports:

```typescript
// Sessions
export function getSession(groupFolder: string): string | undefined
export function setSession(groupFolder: string, sessionId: string): void
export function deleteSession(groupFolder: string): void
export function getAllSessions(): Record<string, string>

// Registered groups
export function getRegisteredGroup(jid: string): (RegisteredGroup & { jid: string }) | undefined
export function setRegisteredGroup(jid: string, group: RegisteredGroup): void
export function getAllRegisteredGroups(): Record<string, RegisteredGroup>
export function deleteRegisteredGroup(jid: string): void

// Chats
export function getAllChats(): ChatInfo[]
export function updateChatName(chatJid: string, name: string): void
export function getLastGroupSync(): string | null
export function setLastGroupSync(): void

// Router state (replaces JSON file)
export function getRouterState(key: string): string | null
export function setRouterState(key: string, value: string): void

// Testing
export function _initTestDatabase(): void  // in-memory DB for unit tests
```

JSON migration runs once on `initDatabase()` — renames migrated files to `*.migrated` after importing.

`getAllRegisteredGroups()` validates each folder with `isValidGroupFolder()` and logs a warning (skips the row) for any invalid entries — prevents path-traversal from corrupted legacy data.

---

## src/credential-proxy.ts (NEW)

**Intent:** HTTP proxy that sits between containers and the Anthropic API. Containers point `ANTHROPIC_BASE_URL` at this proxy; the proxy injects real credentials before forwarding. Credentials never appear inside containers. Supports two auth modes: API key (injects `x-api-key`) and OAuth (injects Bearer token only on the exchange request).

**Dependencies:** `http`, `https`, `./env.js`, `./logger.js`.

**How to apply:**

```typescript
export type AuthMode = 'api-key' | 'oauth';

export function startCredentialProxy(port: number, host?: string): Promise<Server>
// Reads ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL
// from .env via readEnvFile (never from process.env).
// Supports HTTPS upstream (Anthropic) and HTTP upstream (custom ANTHROPIC_BASE_URL).

export function detectAuthMode(): AuthMode
// Returns 'api-key' if ANTHROPIC_API_KEY is set in .env, else 'oauth'.
```

The proxy binds to `PROXY_BIND_HOST` (from `container-runtime.ts`):
- macOS / WSL: `127.0.0.1`
- Linux bare metal: docker0 bridge IP (falls back to `0.0.0.0`)

Containers reach it via `http://host.docker.internal:<CREDENTIAL_PROXY_PORT>`.

---

## src/mount-security.ts (NEW)

**Intent:** Validates `additionalMounts` from worker profiles against an allowlist stored at `~/.config/nanoclaw/mount-allowlist.json` — a path that is never mounted into containers, making it tamper-proof from agent code.

**Dependencies:** `fs`, `os`, `path`, `./config.js`, `./types.js` (pino imported directly — note: this module uses its own pino instance, not the shared logger).

**How to apply:**

```typescript
export function loadMountAllowlist(): MountAllowlist | null
// Cached after first load. Returns null if file absent or invalid.
// Logs error and blocks all additional mounts when null.

export function validateMount(mount: AdditionalMount, isMain: boolean): MountValidationResult
export function validateAdditionalMounts(
  mounts: AdditionalMount[],
  groupName: string,
  isMain: boolean,
): Array<{ hostPath: string; containerPath: string; readonly: boolean }>
// Container paths are prefixed with /workspace/extra/<containerPath>.

export function generateAllowlistTemplate(): string
// Returns a JSON template string for new installs.
```

Default blocked patterns (always applied, even if allowlist is present):
`.ssh`, `.gnupg`, `.aws`, `.azure`, `.gcloud`, `.kube`, `.docker`, `credentials`, `.env`, `.netrc`, `.npmrc`, `id_rsa`, `id_ed25519`, `private_key`, `.secret`.

An explicit `allowedRoot` entry can override a blocked pattern (logged at info level).

Allowlist file format (`~/.config/nanoclaw/mount-allowlist.json`):
```json
{
  "allowedRoots": [
    { "path": "~/projects", "allowReadWrite": true, "description": "Development projects" }
  ],
  "blockedPatterns": [],
  "nonMainReadOnly": false
}
```

---

## src/sender-allowlist.ts (NEW)

**Intent:** Per-chat sender filtering. Controls which senders can trigger the agent and whether unauthorized messages should be dropped or silently ignored. Config lives at `~/.config/nanoclaw/sender-allowlist.json` (outside project root).

**Dependencies:** `fs`, `./config.js`, `./logger.js`.

**How to apply:**

```typescript
export interface ChatAllowlistEntry {
  allow: '*' | string[];  // '*' = all senders allowed
  mode: 'trigger' | 'drop';  // 'drop' = silently ignore message
}
export interface SenderAllowlistConfig {
  default: ChatAllowlistEntry;
  chats: Record<string, ChatAllowlistEntry>;  // keyed by chat JID
  logDenied: boolean;
}

export function loadSenderAllowlist(pathOverride?: string): SenderAllowlistConfig
export function isSenderAllowed(chatJid: string, sender: string, cfg: SenderAllowlistConfig): boolean
export function shouldDropMessage(chatJid: string, cfg: SenderAllowlistConfig): boolean
export function isTriggerAllowed(chatJid: string, sender: string, cfg: SenderAllowlistConfig): boolean
```

Default when file absent: `{ default: { allow: '*', mode: 'trigger' }, chats: {}, logDenied: true }` — all senders allowed, nothing dropped.

---

## src/ipc.ts (NEW)

**Intent:** Host-side IPC handler. Watches `data/ipc/<group>/tasks/` for task files dropped by containers (worker create/destroy/switch/restart commands), parses them, and dispatches to handler functions. Also tracks which groups have sent outbound messages during a turn (used to suppress duplicate SDK output).

**Dependencies:** `fs`, `path`, `cron-parser`, `./config.js`, `./container-runner.js`, `./container-runtime.js`, `./env.js`, `./worker-events.js`.

**How to apply:**

```typescript
export function startIpcWatcher(
  opts: {
    getRegisteredGroups: () => Record<string, RegisteredGroup>;
    getSessions: () => Record<string, string>;
    getAvailableGroups: () => AvailableGroup[];
    registerGroup: (jid: string, group: RegisteredGroup) => void;
    unregisterGroup: (jid: string) => void;
    deleteSession: (folder: string) => void;
    sendMessage: (jid: string, text: string) => Promise<void>;
    stopContainer: (folder: string) => void;
  }
): () => void  // returns cleanup fn

export function didGroupSendMessage(folder: string): boolean
export function clearGroupSentMessage(folder: string): void
```

IPC task files are JSON dropped into `data/ipc/<group>/tasks/`. Supported task types: `create_worker`, `destroy_worker`, `switch_backend`, `restart_worker`, `list_workers`, `send_message`.

For `switch_backend`, the IPC module also handles transcript sanitization (strips NW thinking blocks with empty signatures before switching back to Claude — see `sanitizeThinkingBlocks` function).

Worker backend state is persisted to `data/worker-backends.json` (JSON, read by the CLI and container-runner at startup).

---

## src/router.ts (NEW)

**Intent:** Pure utility functions for message formatting and channel dispatch. Extracted from `index.ts` for testability.

**Dependencies:** `./types.js`, `./timezone.js`.

**How to apply:**

```typescript
export function escapeXml(s: string): string
export function formatMessages(messages: NewMessage[], timezone: string): string
// Returns XML: <context timezone="..."/>\n<messages>\n<message sender="..." time="...">...</message>\n</messages>

export function stripInternalTags(text: string): string
// Removes <internal>...</internal> blocks from agent output

export function formatOutbound(rawText: string): string
// Strips internal tags, returns trimmed text

export function routeOutbound(channels: Channel[], jid: string, text: string): Promise<void>
// Finds the channel that owns the JID and sends. Throws if none found.

export function findChannel(channels: Channel[], jid: string): Channel | undefined
```

---

## src/group-folder.ts (NEW)

**Intent:** Validation and path resolution for group folder names. Prevents path traversal attacks where a malicious agent or crafted IPC payload could escape `groups/` or `data/ipc/` by injecting `../` sequences into folder names.

**Dependencies:** `path`, `./config.js`.

**How to apply:**

```typescript
export function isValidGroupFolder(folder: string): boolean
// Allows: [A-Za-z0-9][A-Za-z0-9_-]{0,63}, no slashes, no .., not 'global'

export function assertValidGroupFolder(folder: string): void
// Throws on invalid

export function resolveGroupFolderPath(folder: string): string
// Returns: path.resolve(GROUPS_DIR, folder) — throws if it would escape GROUPS_DIR

export function resolveGroupIpcPath(folder: string): string
// Returns: path.resolve(DATA_DIR/ipc, folder) — throws if it would escape
```

Always use these instead of `path.join(GROUPS_DIR, folder)` directly.

---

## src/group-queue.ts (NEW)

**Intent:** Per-group concurrency manager. Enforces `MAX_CONCURRENT_CONTAINERS` across all groups, queues incoming message checks and scheduled tasks, handles retry with exponential backoff, and manages container lifecycle (idle detection, stdin close, graceful shutdown).

**Dependencies:** `child_process`, `fs`, `path`, `./config.js`, `./logger.js`.

**How to apply:**

```typescript
export class GroupQueue {
  getActiveCount(): number
  setProcessMessagesFn(fn: (groupJid: string) => Promise<boolean>): void

  enqueueMessageCheck(groupJid: string): void
  // Triggers processMessagesFn for the group when a slot is available.
  // If a container is already active, sets pendingMessages=true.

  enqueueTask(groupJid: string, taskId: string, fn: () => Promise<void>): void
  // Queues a scheduled task. Tasks are prioritized over messages in drain order.

  registerProcess(groupJid: string, proc: ChildProcess, containerName: string, groupFolder?: string): void
  // Called by container-runner after spawn so the queue can reference the process.

  notifyIdle(groupJid: string): void
  // Called when agent reports 'success' (finished work, waiting for IPC).
  // If tasks are pending, closes stdin to preempt the idle container.

  sendMessage(groupJid: string, text: string): boolean
  // Writes a follow-up message to the active container's IPC input dir.

  closeStdin(groupJid: string): void
  // Writes _close sentinel to IPC input dir.

  async shutdown(gracePeriodMs: number): Promise<void>
  // Sets shuttingDown=true. Containers are detached (not killed) so in-flight
  // work completes. The --rm flag on docker run handles cleanup.
}
```

Retry policy: up to 5 retries with exponential backoff starting at 5 s. After max retries, drops pending messages (they'll be retried on the next incoming message).

---

## src/channels/registry.ts (NEW)

**Intent:** Channel plugin registry. Each channel module calls `registerChannel()` at import time (side-effect registration). The orchestrator instantiates channels via factory functions rather than importing channel classes directly.

**Dependencies:** `../types.js`.

**How to apply:**

```typescript
export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}
export type ChannelFactory = (opts: ChannelOpts) => Channel | null;

export function registerChannel(name: string, factory: ChannelFactory): void
export function getChannelFactory(name: string): ChannelFactory | undefined
export function getRegisteredChannelNames(): string[]
```

---

## src/channels/index.ts (NEW)

**Intent:** Self-registration barrel. Importing this file triggers all channel `registerChannel()` calls. Currently registers `discord` (always) and `whatsapp` (commented out — install via `/add-whatsapp`).

**Dependencies:** `./discord.js`.

**How to apply:**

Add a bare `import './channels/index.js'` in `index.ts`. To enable a channel, uncomment (or add) its import here.

---

## src/channels/discord.ts (NEW)

**Intent:** Discord channel implementation. Uses `discord.js` (gateway/WebSocket) instead of polling. Handles: `@bot` mention → trigger translation, attachment type detection, reply context prefixing, message chunking at the 2000-char limit, and Discord-specific extras (pin/unpin, edit, typing indicator, channel create/delete).

**Dependencies:** `discord.js`, `../config.js`, `../env.js`, `../logger.js`, `./registry.js`, `../types.js`.

**How to apply:**

```typescript
export class DiscordChannel implements Channel {
  name: 'discord'
  connect(): Promise<void>
  sendMessage(jid: string, text: string): Promise<void>
  sendMessageWithId(jid: string, text: string): Promise<string | undefined>
  // Returns Discord message ID — used by status-pin to track pinned message.

  isConnected(): boolean
  ownsJid(jid: string): boolean  // true for 'dc:*' JIDs
  disconnect(): Promise<void>

  // Status pin extras:
  editMessage(jid: string, messageId: string, text: string): Promise<void>
  pinMessage(jid: string, messageId: string): Promise<void>
  unpinMessage(jid: string, messageId: string): Promise<void>
  setTyping(jid: string, isTyping: boolean): Promise<void>

  // Worker management:
  createChannel(guildId: string, name: string, categoryId?: string): Promise<string>
  deleteChannel(channelId: string): Promise<void>
}
```

Self-registers at module end:
```typescript
registerChannel('discord', (opts: ChannelOpts) => {
  const token = process.env.DISCORD_BOT_TOKEN || readEnvFile(['DISCORD_BOT_TOKEN']).DISCORD_BOT_TOKEN;
  if (!token) { logger.warn('...'); return null; }
  return new DiscordChannel(token, opts);
});
```

JID format: `dc:<channelId>`.

---

## src/channels/whatsapp.ts (NEW)

**Intent:** WhatsApp channel via Baileys (moved out of `index.ts` into the channel abstraction). Implements `Channel` interface, handles LID→phone mapping, group sync, outgoing queue, and self-registration.

**Dependencies:** `@whiskeysockets/baileys`, `./registry.js`, `../types.js`, etc.

**How to apply:** Install via `/add-whatsapp` skill. To enable, uncomment `import './whatsapp.js'` in `src/channels/index.ts`.

---

## src/container-runner.ts (MODIFIED)

**Intent:** Manages Docker container spawning for agent execution. Heavily rewritten: Apple Container (`container` binary) replaced with Docker; credential injection replaced with credential proxy; IPC moved to per-group namespaced directories; streaming output parsed via sentinel markers; audit log extraction added post-turn.

**Dependencies:** `child_process`, `fs`, `path`, plus many local modules.

**How to apply:**

Key behavioral changes:

- **Runtime**: spawns `docker` instead of `container`. Runtime abstracted in `container-runtime.ts`.
- **Streaming output**: The container writes `---NANOCLAW_OUTPUT_START---{json}---NANOCLAW_OUTPUT_END---` markers. `runContainerAgent` streams these to callers via `onOutput` callback instead of returning a single result at process exit.
- **Timeout resets**: Hard timeout is reset on each streaming output marker, so long-running tasks don't time out mid-work.
- **Per-group sessions**: `data/sessions/<folder>/.claude/` instead of `~/.claude/` — each group has isolated SDK state.
- **Agent-runner sync**: `container/agent-runner/src/` is copied to `data/sessions/<folder>/agent-runner-src/` by mtime comparison before each spawn.
- **`.env` shadowed**: Main group gets project root mounted, but `.env` is shadowed by `/dev/null` so the agent cannot read secrets.
- **Port mappings**: `ContainerConfig.ports` passed to `docker run -p`.
- **User mapping**: Runs as host UID:GID so bind-mounted files are owned correctly.
- **Tailscale**: Mounts `/var/run/tailscale/tailscaled.sock` if present; sets `--dns 100.100.100.100 --dns 1.1.1.1`.
- **Docker socket**: Mounted for main group when `NANOCLAW_ENABLE_DOCKER=true`.

```typescript
export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  includeContent?: string;  // content of include_files, injected as system prompt append
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | object | null;
  newSessionId?: string;
  error?: string;
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
  folder?: string;
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput>

export function writeTasksSnapshot(folder: string, isMain: boolean, tasks: ...): void
export function writeGroupsSnapshot(folder: string, isMain: boolean, groups: AvailableGroup[], registeredJids: Set<string>): void
```

---

## src/container-runtime.ts (NEW)

**Intent:** Abstracts container runtime specifics so switching from Docker to another runtime means editing one file.

**Dependencies:** `child_process`, `fs`, `os`, `./logger.js`.

**How to apply:**

```typescript
export const CONTAINER_RUNTIME_BIN = 'docker';
export const CONTAINER_HOST_GATEWAY = 'host.docker.internal';

export const PROXY_BIND_HOST: string
// macOS/WSL: '127.0.0.1'
// Linux: docker0 bridge IP or '0.0.0.0'

export function hostGatewayArgs(): string[]
// Linux: ['--add-host=host.docker.internal:host-gateway']
// macOS: []

export function readonlyMountArgs(hostPath: string, containerPath: string): string[]
// Returns ['-v', 'hostPath:containerPath:ro']

export function sanitizeFolderName(folder: string): string
// Replaces non-[a-zA-Z0-9-] with '-' for container name safety

export function stopContainer(name: string): string
// Returns the shell command: 'docker stop <name>'

export function ensureContainerRuntimeRunning(): void
// Calls 'docker info', prints a friendly error box and throws if unreachable

export function cleanupOrphans(): void
// Stops all containers matching 'nanoclaw-*' prefix from previous runs
```

---

## src/profile-sync.ts (NEW)

**Intent:** Loads worker profiles from `~/.config/nanoclaw/worker-profiles/<name>.json` (falls back to `worker-profiles/<name>.json` in the repo). On startup and after worker create/update, syncs `container_config` and `worker.env` for all non-main workers. Assembles `CLAUDE.md` from layered instruction fragments.

**Dependencies:** `fs`, `path`, `./db.js`, `./config.js`, `./logger.js`, `./types.js`.

**How to apply:**

```typescript
export interface WorkerProfile {
  repos?: { url: string; postClone?: string }[];
  tools?: string[];
  mounts?: { hostPath: string; containerPath: string; readonly: boolean }[];
  ports?: string[];
  claude_md?: string;
  skills_repo?: string;
}

export function loadPersonalConfig(): PersonalConfig
// Loads ~/.config/nanoclaw/config.json

export function loadWorkerProfile(profileName = 'default'): { profile: WorkerProfile; profilePath: string }

export function syncWorkerProfiles(): number
// Updates container_config + worker.env for all non-main workers.
// Preserves per-worker settings (NANOCLAW_BACKEND).
// Returns count of workers updated.

export function syncMasterProfile(): void
// Assembles CLAUDE.md for the main group.

export function assembleWorkerInstructions(groupDir: string, groupName: string): void
// Assembles CLAUDE.md from 4 fragments in order:
//   1. instructions/global.md (repo)
//   2. instructions/worker.md (repo)
//   3. ~/.config/nanoclaw/instructions/global.md (personal)
//   4. ~/.config/nanoclaw/instructions/worker.md (personal)
// Only writes if content changed (avoids mtime churn).
```

`worker.env` format written to `data/sessions/<folder>/worker.env`:
```
WORKER_REPOS=url1|url2
WORKER_REPO_POST_CLONE=reponame:command
WORKER_TOOLS=tool1|tool2
WORKER_SKILLS_REPO=https://...
NANOCLAW_BACKEND=neuralwatt  # preserved if set
```

---

## src/worker-events.ts (NEW)

**Intent:** Append-only JSONL event log at `logs/worker-events.jsonl`. Tracks worker lifecycle (created, destroyed, backend_switched, resumed). Queried by the master via the `worker_history` MCP tool and by `ncf history`.

**Dependencies:** `fs`, `path`.

**How to apply:**

```typescript
export interface WorkerEvent {
  timestamp: string;  // ISO 8601
  event: 'created' | 'destroyed' | 'backend_switched' | 'resumed';
  worker: string;
  folder: string;
  details?: Record<string, unknown>;
}

export function logWorkerEvent(event: WorkerEvent): void
// Appends JSON line to logs/worker-events.jsonl

export function readWorkerEvents(opts?: {
  worker?: string;    // substring match on worker or folder
  event?: string;     // exact event type
  since?: string;     // ISO timestamp
  limit?: number;     // tail N entries
}): WorkerEvent[]
```

---

## src/audit-log.ts (NEW)

**Intent:** Per-worker token and latency audit log at `logs/workers/<folder>/turns.jsonl`. After each container turn, reads new entries from the Claude SDK transcript JSONL and extracts usage data. For Neuralwatt workers, the translation shim writes turns directly.

**Dependencies:** `fs`, `path`, `./logger.js`, `./config.js`.

**How to apply:**

```typescript
export function extractTurnsFromTranscript(
  groupFolder: string,
  sessionId: string | undefined,
  sinceOffset: number,  // byte offset from getTranscriptOffset(), read only new bytes
): void
// Reads assistant messages with usage from the SDK transcript.
// Also scans subagent transcripts (data/sessions/<folder>/.claude/projects/-workspace-group/<sessionId>/subagents/).
// Appends TurnEntry lines to logs/workers/<folder>/turns.jsonl.

export function getTranscriptOffset(
  groupFolder: string,
  sessionId: string | undefined,
): number
// Returns current size of the transcript file (bytes). Pass to extractTurnsFromTranscript
// before container spawn; the function reads only bytes added after that offset.
```

TurnEntry shape written to JSONL:
```jsonc
{
  "ts": "2026-04-10T21:00:00Z",
  "model": "claude-opus-4-5",
  "backend": "anthropic",
  "input_tokens": 12345,
  "output_tokens": 456,
  "cached_tokens": 8000,
  "cache_creation_tokens": null,
  "latency_ms": null,  // null for Anthropic (SDK doesn't expose it); set by NW shim
  "stop_reason": "end_turn",
  "stream": true
}
```

---

## src/session-commands.ts (NEW)

**Intent:** Intercepts session slash commands (e.g., `/compact`) from chat messages before they reach the normal agent flow. Handles authorization, runs pre-command messages through the agent first, then runs the command itself.

**Dependencies:** `./types.js`, `./logger.js`.

**How to apply:**

```typescript
export function extractSessionCommand(content: string, triggerPattern: RegExp): string | null
// Returns '/compact' or null.

export function isSessionCommandAllowed(isMainGroup: boolean, isFromMe: boolean): boolean
// Currently always true (all senders may trigger /compact).

export interface SessionCommandDeps {
  sendMessage: (text: string) => Promise<void>;
  setTyping: (typing: boolean) => Promise<void>;
  runAgent: (prompt: string, onOutput: (result: AgentResult) => Promise<void>) => Promise<'success' | 'error'>;
  closeStdin: () => void;
  advanceCursor: (timestamp: string) => void;
  formatMessages: (msgs: NewMessage[], timezone: string) => string;
  canSenderInteract: (msg: NewMessage) => boolean;
}

export async function handleSessionCommand(opts: {
  missedMessages: NewMessage[];
  isMainGroup: boolean;
  groupName: string;
  triggerPattern: RegExp;
  timezone: string;
  deps: SessionCommandDeps;
}): Promise<{ handled: false } | { handled: true; success: boolean }>
// Returns { handled: false } if no session command found.
// Returns { handled: true, success } otherwise — caller should return success directly.
// success=false means the agent run failed before output was sent; caller should retry.
```

Flow for `/compact`: messages before the command are sent to the agent first, then `/compact` is forwarded as the literal prompt (not XML-formatted). Cursor is advanced to the command message; messages after it remain pending for the next poll.

---

## src/task-scheduler.ts (MODIFIED)

**Intent:** Upstream ran tasks directly; this version queues them through `GroupQueue` so scheduled tasks respect container concurrency limits. Added drift-prevention for interval tasks, proper validation of group folders, and uses the shared `logger`.

**Dependencies:** `child_process`, `cron-parser`, `fs`, `./config.js`, `./container-runner.js`, `./db.js`, `./group-folder.js`, `./group-queue.js`, `./logger.js`, `./types.js`.

**How to apply:**

New `SchedulerDependencies` interface:
```typescript
export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (groupJid: string, proc: ChildProcess, containerName: string, groupFolder: string) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
}
```

New export:
```typescript
export function computeNextRun(task: ScheduledTask): string | null
// Cron: uses cron-parser with TIMEZONE.
// Interval: anchors to task.next_run (not Date.now()) to prevent drift.
// Once: returns null.
```

Tasks with invalid `group_folder` are paused (`updateTask(task.id, { status: 'paused' })`) instead of retried in a tight loop.
