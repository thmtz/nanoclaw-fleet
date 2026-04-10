# Source UI / Entry Layer

The outer shell: Discord status pins, resource monitoring, the main orchestrator, and the CLI tool.

---

## src/status-pin.ts (NEW)

**Intent:** Maintains a single pinned Discord message in the master channel showing live system status. Runs `ncf status --no-color` on a configurable interval, edits the pinned message in place, and creates a new one if the original was deleted. Disabled when `STATUS_PIN_INTERVAL <= 0`.

**Dependencies:** `child_process`, `util`, `path`, `./db.js`, `./logger.js`, `./config.js`, `./timezone.js`.

**How to apply:**

```typescript
export interface StatusPinDeps {
  sendMessage: (jid: string, text: string) => Promise<string | undefined>;
  // Must return the message ID (DiscordChannel.sendMessageWithId).
  editMessage: (jid: string, messageId: string, text: string) => Promise<void>;
  pinMessage: (jid: string, messageId: string) => Promise<void>;
}

export function startStatusPin(
  mainJid: string,
  intervalMs: number,
  deps: StatusPinDeps,
): () => void  // returns cleanup fn (clears timers)
// First update fires after 10s (let startup finish).
// Pinned message ID persisted in DB under key 'pinned_status_message_id'.
// On Discord error 10008 (message deleted): creates new message.
// On transient errors: skips cycle, does not create new message.

export async function markStatusOffline(
  mainJid: string,
  deps: Pick<StatusPinDeps, 'editMessage'>,
): Promise<void>
// Best-effort edit to "NanoClaw offline — <time>", 3s timeout. Call during shutdown.
```

---

## src/worker-status-pin.ts (NEW)

**Intent:** Maintains per-worker pinned messages in each worker Discord channel showing container state, token usage, and last activity. Runs in parallel for all workers on the same interval as `status-pin.ts`.

**Dependencies:** `child_process`, `fs`, `path`, `./config.js`, `./db.js`, `./logger.js`, `./timezone.js`.

**How to apply:**

```typescript
export interface WorkerStatusPinDeps {
  editMessage: (jid: string, messageId: string, text: string) => Promise<void>;
  sendMessage: (jid: string, text: string) => Promise<string | undefined>;
  pinMessage: (jid: string, messageId: string) => Promise<void>;
  unpinMessage?: (jid: string, messageId: string) => Promise<void>;
}

export async function updateAllWorkerPins(deps: WorkerStatusPinDeps): Promise<void>
// Reads worker list from data/ipc/discord_main/available_groups.json.
// Reads backend from data/worker-backends.json.
// Reads usage from data/worker-usage.json.
// Calls docker ps / docker inspect for container state and uptime.
// Runs all workers in parallel (Promise.allSettled).

export function startWorkerStatusPins(intervalMs: number, deps: WorkerStatusPinDeps): () => void
// First update fires after 15s. Returns cleanup fn.

export async function clearWorkerPin(
  folder: string,
  jid: string,
  deps: Pick<WorkerStatusPinDeps, 'unpinMessage'>,
): Promise<void>
// Unpin and clear state key when a worker is destroyed.
```

Pin message format:
```
🟢 **worker-name** · claude-opus-4-5 · running · 2h 15m uptime

42 requests · 1.2M tokens · last activity 5m ago

_Updated 9:48:05 PM MDT_
```

Worker pin state keys are stored in `router_state` DB as `worker_status_pin_<folder>`.

---

## src/resource-monitor.ts (NEW)

**Intent:** Background loop that polls system resources every 5 minutes and sends alerts to the master channel when thresholds are crossed. Uses hysteresis (alert at 80%, clear at 70%) to prevent alert flapping.

**Dependencies:** `os`, `child_process`, `./logger.js`, `./config.js`.

**How to apply:**

```typescript
export function startResourceMonitor(
  masterJid: string,
  sendMessage: (jid: string, text: string) => Promise<void>,
  getActiveContainers: () => number,
): void
// First poll fires after 30s. Runs indefinitely (no cleanup fn).
// Monitors: memory %, disk % (df /home), active containers vs MAX_CONCURRENT_CONTAINERS.
// Alert thresholds: 80% (alert), 70% (clear).
```

Alert messages use emoji (⚠️ / ✅) and are sent directly to `masterJid` via `sendMessage`. Active alert state is tracked in a module-level `Set<string>` so the same alert won't fire repeatedly.

---

## src/index.ts (MODIFIED)

**Intent:** Complete rewrite of the main orchestrator. Upstream was WhatsApp-only and single-threaded; this version is channel-agnostic, multi-group concurrent, and Docker-based. Key architectural changes:

- **Channel abstraction**: instantiates channels via registry factories; `channels[]` array replaces the `sock` WhatsApp socket.
- **GroupQueue**: all container spawns go through `GroupQueue` for concurrency control.
- **SQLite state**: `loadState()` / `saveState()` read/write SQLite instead of JSON files.
- **Credential proxy**: started on `CREDENTIAL_PROXY_PORT` before any containers spawn.
- **Startup sequence**: `ensureContainerRuntimeRunning()` → `cleanupOrphans()` → `startCredentialProxy()` → connect channels → `syncWorkerProfiles()` → start status pins and resource monitor.
- **Wake signal**: `EventEmitter` (`messageWake`) fires when a message is stored, so the message loop processes it immediately instead of waiting for `POLL_INTERVAL`.
- **`include_files`**: reads `personalConfig.include_files`, concatenates file contents, and passes as `includeContent` to `ContainerInput` (injected as a system prompt append inside the container, compaction-safe).
- **Cursor rollback**: if agent errors before sending any output, rolls back `lastAgentTimestamp` so the message is retried. Does not roll back if output was already sent (prevents duplicates).

**Dependencies:** All of `src/` essentially. Key imports: `./profile-sync.js`, `./resource-monitor.js`, `./status-pin.js`, `./worker-status-pin.js`, `./channels/index.js`, `./channels/registry.js`, `./container-runner.js`, `./container-runtime.js`, `./credential-proxy.js`, `./db.js`, `./group-queue.js`, `./group-folder.js`, `./ipc.js`, `./router.js`, `./sender-allowlist.js`, `./session-commands.js`, `./task-scheduler.js`.

**How to apply:**

Key exported functions (used by tests and the CLI):

```typescript
export function getAvailableGroups(): AvailableGroup[]
// Returns all known chats + registered groups without messages, ordered by activity.

export function _setRegisteredGroups(groups: Record<string, RegisteredGroup>): void
// @internal — for unit tests only.

// Re-exports for backward compatibility:
export { escapeXml, formatMessages } from './router.js';
```

Important internal flow for `processGroupMessages(chatJid)`:
1. Load missed messages since `lastAgentTimestamp[chatJid]`.
2. Check for session commands (`handleSessionCommand`) — if handled, return.
3. Check trigger presence and sender allowlist for non-main groups.
4. Format messages as XML via `formatMessages`.
5. Advance cursor optimistically; run agent with streaming `onOutput`.
6. On `result.status === 'success'`: call `queue.notifyIdle()`.
7. On error after output: skip rollback (no duplicates). On error before output: roll back cursor.
8. Suppress SDK output if `didGroupSendMessage(group.folder)` (agent sent via `send_message` IPC tool).

Idle timeout (`IDLE_TIMEOUT` ms) is reset on each streaming output. Workers with `containerConfig.disableIdleTimeout = true` get a 24-hour hard timeout instead.

Startup sequence (summary):
```typescript
// 1. initDatabase()
// 2. loadState() — loads from SQLite
// 3. ensureContainerRuntimeRunning()
// 4. cleanupOrphans()
// 5. startCredentialProxy(CREDENTIAL_PROXY_PORT, PROXY_BIND_HOST)
// 6. Instantiate channels from registry
// 7. startIpcWatcher(...)
// 8. syncMasterProfile() + syncWorkerProfiles()
// 9. connect all channels
// 10. startStatusPin(...) + startWorkerStatusPins(...)
// 11. startResourceMonitor(...)
// 12. startSchedulerLoop(...)
// 13. startMessageLoop() — polls getNewMessages() + wakes on messageWake
```

Shutdown sequence: `markStatusOffline()` → `queue.shutdown()` → disconnect channels.

---

## src/cli.ts (NEW)

**Intent:** The `ncf` CLI tool (1012 lines). Provides operator commands for managing workers, inspecting logs, injecting test messages, switching backends, and more. Works from both the host and inside containers (detects via `/workspace/project` existence).

**Dependencies:** `child_process`, `fs`, `path`, `sqlite3` (via `sqlite3` CLI shell), no Node.js imports beyond stdlib.

**How to apply:**

Commands:

| Command | Description |
|-|-|
| `ncf status [--json] [--no-color]` | All workers, backends, token usage, container state |
| `ncf logs <worker> [--cache\|--slow\|--follow\|--host]` | Audit log from `logs/workers/<folder>/turns.jsonl` |
| `ncf inject <channel> <msg>` | Write IPC task to trigger agent response |
| `ncf switch <worker> <backend> [model]` | Write IPC switch_backend task |
| `ncf restart <worker> [--fresh]` | Write IPC restart_worker task (--fresh clears session) |
| `ncf create <name> [--channel c] [--jid j]` | Write IPC create_worker task |
| `ncf destroy <worker>` | Write IPC destroy_worker task |
| `ncf session <worker>` | Read Claude SDK JSONL transcript, show conversation |
| `ncf history [worker]` | Read `logs/worker-events.jsonl` |
| `ncf debug` | Dump paths, DB contents, container list, IPC dirs |
| `ncf rebuild` | Run `container/build.sh` |

Worker resolution (`resolveWorker`): accepts folder name, display name, or `dc:` JID. Folder names are automatically prefixed with `discord_` if not already prefixed.

IPC task delivery: writes `data/ipc/discord_main/tasks/<timestamp>-<random>.json` (atomic via temp file + rename). The host IPC watcher picks it up within `IPC_POLL_INTERVAL` ms.

`ncf logs --follow`: polls `docker logs -f <container>` and streams to stdout. `--cache` filters to turns with `cached_tokens > 0`. `--slow` filters to turns with `latency_ms > 5000`. `--host` connects to the host's HTTP IPC server to fetch live logs (used from inside containers).

Token formatting (`formatTokens`): < 1k → integer, < 1M → `1.2k`, < 1G → `1.2M`, else `1.2B`.

Status output reads three JSON files:
- `data/worker-backends.json` — backend and model per folder.
- `data/worker-usage.json` — request count, total tokens, energy (kWh), last updated.
- `data/ipc/discord_main/available_groups.json` — canonical group list including JIDs.

Container detection: `docker ps --filter "name=nanoclaw-<folder>"` pattern with `_` → `-` replacement.
