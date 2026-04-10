# Source Foundation Layer

These files form the lowest-level primitives — logging, env loading, config constants, and types. Everything else imports from here.

---

## src/config.ts (MODIFIED)

**Intent:** Centralizes all runtime configuration constants. The upstream version was a thin file with ~5 exports; this version is the canonical config hub with 30+ exports covering inference backends, security paths, feature flags, and timeouts. It no longer calls `pino` directly (logging moved to `logger.ts`) and all values fall back through three layers: `process.env` → `.env` file (via `readEnvFile`) → hardcoded default.

**Dependencies:** `./env.js`, Node `os`, `path`.

**How to apply:**

Key additions over upstream:

- `.env` fallback via `readEnvFile` for every configurable value — secrets are NOT loaded here.
- `MOUNT_ALLOWLIST_PATH` / `SENDER_ALLOWLIST_PATH` — point to `~/.config/nanoclaw/` so they live outside the project root and cannot be overwritten by mounted containers.
- `CONTAINER_MAX_OUTPUT_SIZE` (10 MB), `CREDENTIAL_PROXY_PORT` (3001), `NEURALWATT_PROXY_PORT` (3003).
- `BACKEND_ANTHROPIC`, `BACKEND_NEURALWATT`, `InferenceBackend` type, `WORKER_BACKENDS_FILENAME`, `WORKER_API_KEY_PREFIX`.
- `IDLE_TIMEOUT` (30 min) and `MAX_CONCURRENT_CONTAINERS` (5).
- `TRIGGER_PATTERN` now uses a local `escapeRegex` helper so the assistant name is regex-safe.
- `TIMEZONE` — from `TZ` env or `Intl.DateTimeFormat` fallback.
- `STATUS_PIN_INTERVAL` (30 s).
- `ENABLE_DOCKER_SOCKET` — gate for mounting `/var/run/docker.sock`.
- `GITHUB_TOKEN_PATH` — path to a file containing a PAT; the host reads it and injects `GITHUB_TOKEN` into containers.
- Removed `MAIN_GROUP_FOLDER` constant — replaced by `group.isMain` field in the DB.

```typescript
// New constants summary
export const MOUNT_ALLOWLIST_PATH: string;
export const SENDER_ALLOWLIST_PATH: string;
export const CONTAINER_MAX_OUTPUT_SIZE: number;
export const CREDENTIAL_PROXY_PORT: number;
export const NEURALWATT_PROXY_PORT: number;
export const BACKEND_ANTHROPIC: 'anthropic';
export const BACKEND_NEURALWATT: 'neuralwatt';
export type InferenceBackend = 'anthropic' | 'neuralwatt';
export const WORKER_BACKENDS_FILENAME: string;
export const WORKER_API_KEY_PREFIX: string;
export const IDLE_TIMEOUT: number;
export const MAX_CONCURRENT_CONTAINERS: number;
export const TRIGGER_PATTERN: RegExp;
export const TIMEZONE: string;
export const STATUS_PIN_INTERVAL: number;
export const ENABLE_DOCKER_SOCKET: boolean;
export const GITHUB_TOKEN_PATH: string | null;
```

---

## src/types.ts (MODIFIED)

**Intent:** Shared TypeScript interfaces. Added the multi-channel abstraction (`Channel`, `OnInboundMessage`, `OnChatMetadata`), security types (`MountAllowlist`, `AllowedRoot`), and enriched existing types.

**Dependencies:** None.

**How to apply:**

Key additions:

- `PersonalConfig` — `{ include_files?: string[] }` — loaded from `~/.config/nanoclaw/config.json`. The `include_files` array lists host paths whose content is injected into each container prompt as a system append (compaction-safe instruction injection).
- `AdditionalMount.containerPath` is now optional (defaults to `basename(hostPath)`).
- `MountAllowlist` / `AllowedRoot` — external security config at `~/.config/nanoclaw/mount-allowlist.json`.
- `ContainerConfig` — added `ports?: string[]` (Docker port mappings) and `disableIdleTimeout?: boolean` (keep container alive indefinitely).
- `RegisteredGroup` — added `requiresTrigger?: boolean` and `isMain?: boolean`. Removed `Session` interface (sessions are now in SQLite).
- `NewMessage` — added `is_from_me?: boolean` and `is_bot_message?: boolean`.
- `ScheduledTask` — added `context_mode: 'group' | 'isolated'`.
- New channel abstraction:

```typescript
export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  syncGroups?(force: boolean): Promise<void>;
  createChannel?(guildId: string, name: string, categoryId?: string): Promise<string>;
  deleteChannel?(channelId: string): Promise<void>;
}
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;
```

---

## src/env.ts (NEW)

**Intent:** Parse `.env` file without polluting `process.env`. Keeps secrets out of the process environment so they cannot leak to child processes. `config.ts` uses it for non-secret config; `credential-proxy.ts` uses it for API keys.

**Dependencies:** `fs`, `path`, `./logger.js`.

**How to apply:**

Drop-in — no external packages.

```typescript
export function readEnvFile(keys: string[]): Record<string, string>
```

- Reads `<cwd>/.env`.
- Returns only the requested keys (whitelist approach).
- Strips surrounding single/double quotes from values.
- Returns `{}` if the file is absent (logs debug, not warn).

---

## src/logger.ts (NEW)

**Intent:** Replaces per-file `pino({ transport: 'pino-pretty' })` instances scattered across the upstream codebase. Single shared logger that writes pretty output to stdout (captured by systemd to `logs/nanoclaw.log`) and structured JSONL to `logs/nanoclaw.jsonl` via `pino-roll` (daily rotation, 7-day retention).

**Dependencies:** `pino`, `pino-pretty` (dev), `pino-roll`.

**How to apply:**

```typescript
export const logger: pino.Logger
```

- `logs/` directory is created on import.
- Also installs `process.on('uncaughtException')` and `process.on('unhandledRejection')` handlers that route through pino with timestamps.
- Every module that previously created its own `pino()` instance now imports `logger` from here instead.

---

## src/utils.ts (DELETED)

**Intent:** Upstream contained two helpers (`loadJson`, `saveJson`). Both are now replaced by SQLite accessors in `db.ts`. Any remaining callers that need JSON I/O use `fs.readFileSync`/`fs.writeFileSync` directly.

**How to apply:**

Remove any import of `utils.js`. Replace:
- `loadJson(path, default)` → `JSON.parse(fs.readFileSync(path, 'utf-8'))` with a try/catch returning the default.
- `saveJson(path, data)` → `fs.writeFileSync(path, JSON.stringify(data, null, 2))` with `fs.mkdirSync` for the directory.

---

## src/timezone.ts (NEW)

**Intent:** Localized timestamp formatting using `Intl` (no external dependencies). Used by `router.ts` (message XML formatting), `status-pin.ts`, and `worker-status-pin.ts`.

**Dependencies:** None.

**How to apply:**

```typescript
export function formatLocalTime(utcIso: string, timezone: string): string
// Returns: "Apr 10, 2026, 9:48 PM" style

export function formatCurrentTime(timezone: string): string
// Returns: "9:48:05 PM MDT" style — used for status pins
```
