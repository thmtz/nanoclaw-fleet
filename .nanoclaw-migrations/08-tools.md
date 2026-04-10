# Migration Guide: Tools & Utilities

This section documents host-side tools and utilities that support worker management, testing, and inference routing.

---

## tools/anthropic-shim.ts (MODIFIED)

**Intent:** Universal proxy that all worker containers route API traffic through. Reads per-worker config to decide whether to forward to Anthropic or Neuralwatt, with full Anthropic→OpenAI protocol translation.

**File size:** 1010 lines

**How it works:**

### Worker identification
Each request includes `X-Worker-Folder` header (set by container-runner). This identifies which worker is making the request.

### Config loading (lines 236–247)
```typescript
function loadConfig(): Record<string, WorkerBackendConfig> {
  // Read data/worker-backends.json
  // Re-read on every request (detect runtime config changes)
  // Cache with mtime tracking (avoid unnecessary re-parses)
}
```

Config file format:
```json
{
  "discord_foobar": { "backend": "neuralwatt", "model": "Qwen/Qwen3.5-397B" },
  "discord_other": { "backend": "anthropic" }
}
```

Default: `{ "backend": "anthropic" }` (forward to Anthropic).

### Routing logic (lines 249–252)
```typescript
function getWorkerConfig(workerFolder: string): WorkerBackendConfig {
  const config = loadConfig();
  return config[workerFolder] || { backend: 'anthropic' };
}
```

Per-request: check config, route accordingly.

### Neuralwatt backend (lines 254–271)

**Model mapping:** Maps Claude model names to Neuralwatt OSS models:
```typescript
const NEURALWATT_MODEL_MAP: Record<string, string> = {
  'claude-opus-4-6': 'Qwen/Qwen3.5-397B-A17B-FP8',
  'claude-sonnet-4-5-20250929': 'Qwen/Qwen3.5-397B-A17B-FP8',
  'claude-haiku-4-5-20251001': 'Qwen/Qwen3.5-35B-A3B',
};
```

**Fuzzy matching:** `/models/resolve/{query}` endpoint supports hyphens:
```bash
curl http://localhost:3003/models/resolve/kimi-fast
# Returns: Qwen/Qwen3.5-397B-A17B-FP8
```

### Anthropic→OpenAI translation (lines 275–347)

**Input transform:**
- Splits Anthropic messages (complex content blocks) into OpenAI format
- Converts tool_use blocks → tool_calls (OpenAI format)
- Converts tool_result blocks → tool role messages
- Preserves all semantic meaning

**Example:**
```typescript
// Anthropic
{
  role: 'assistant',
  content: [
    { type: 'text', text: 'Let me search...' },
    { type: 'tool_use', id: 'abc', name: 'search', input: {...} }
  ]
}

// → OpenAI
{
  role: 'assistant',
  content: 'Let me search...',
  tool_calls: [
    {
      id: 'abc',
      type: 'function',
      function: { name: 'search', arguments: '{}' }
    }
  ]
}
```

### Streaming (lines ~600+)
- By default: enabled
- `SHIM_STREAMING=0` to disable (fallback to buffered non-streaming)
- Streaming was previously disabled due to suspected token bug (turned out to be stale containers with invalid keys)

### Usage tracking (lines 61–174)

**Global usage stats:** `/data/worker-usage.json`
```typescript
interface WorkerUsage {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  energy_joules: number;
  energy_kwh: number;
  last_updated: string;
}
```

**Per-request audit logs:** `logs/workers/{folder}/turns.jsonl`
```typescript
interface TurnEntry {
  ts: string;
  model: string;
  backend: 'neuralwatt' | 'anthropic';
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number | null;
  latency_ms: number;
  energy_joules: number | null;
  stop_reason: string;
  stream: boolean;
}
```

One JSONL entry per API call (queryable via `ncf logs <worker>`).

### Deduplication (lines 176–188)
Tracks last request per worker to detect SDK retries (SDK sends each request twice with different max_tokens):
```typescript
function isDuplicateRequest(workerFolder: string, msgCount: number): boolean {
  // Return true if same worker + same msgCount within 5s window
}
```

Prevents double-counting tokens.

### Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/` | POST | Forward inference request (Anthropic or Neuralwatt) |
| `/models` | GET | List available Neuralwatt models |
| `/models/resolve/{query}` | GET | Fuzzy match model name |
| `/worker-config` | GET | Get current config for this worker (via X-Worker-Folder) |
| `/usage/{worker?}` | GET | Global or per-worker usage stats |

**How to apply:**
```bash
# Start the shim
NEURALWATT_API_KEY=sk-... CREDENTIAL_PROXY_URL=http://localhost:3001 \
  bun run tools/anthropic-shim.ts

# Or as systemd service:
systemctl --user start nanoclaw-shim

# Test routing
curl -X POST http://localhost:3003/ \
  -H 'Content-Type: application/json' \
  -H 'X-Worker-Folder: discord_test' \
  -d '{"model":"claude-opus-4-6","messages":[...]}'

# Check available models
curl http://localhost:3003/models | jq '.models[]'
```

**Monitoring:**
```bash
# View per-worker tokens & latency
jq '.' logs/workers/discord_test/turns.jsonl | tail -20

# Total usage across all workers
curl http://localhost:3003/usage
```

---

## tools/e2e-test.ts (MODIFIED)

**Intent:** Comprehensive end-to-end smoke test for NanoClaw. Tests worker lifecycle, both backends, and all critical features.

**File size:** 761 lines

**Usage:**
```bash
npx tsx tools/e2e-test.ts              # Run all scenarios
npx tsx tools/e2e-test.ts --skip-nw    # Skip Neuralwatt tests
```

**Environment detection:**
- Detects if running inside container (checks `/.dockerenv` or `NANOCLAW_CHAT_JID`)
- Adjusts systemctl calls → watchdog sentinel file when in-container
- Uses `IN_CONTAINER` flag to adapt checks

**Test scenarios:**

1. **Preflight** — Validate preconditions
   - Docker running
   - Guild ID present
   - NanoClaw responsive on HTTP

2. **Worker creation** — DB registration, workspace
   - DB row created for worker
   - `/workspace/{folder}/` directory exists
   - `CLAUDE.md` assembled correctly

3. **First boot** — Container spawns, agent responds
   - Container starts successfully
   - Agent returns non-empty response
   - Session ID generated

4. **Session resume** — Kill container, respawn, agent recalls
   - Kill running container
   - Spawn new container with same session ID
   - Agent recalls conversation state (secret from previous session)

5. **Neuralwatt backend** — Create NW worker, shim response, streaming
   - Create worker with `--backend neuralwatt`
   - Shim accepts request and forwards to Neuralwatt
   - Response streaming works

6. **Backend switching** — Neuralwatt → Anthropic
   - Switch worker from NW to Anthropic
   - Container automatically restarts
   - Uses new backend

7. **Credential proxy** — Reachable on :3001
   - Verify proxy listening and responding

8. **Destroy** — DB cleanup, container stopped, workspace preserved
   - Worker DB row deleted
   - Container stopped
   - `/workspace/{folder}/` preserved (not deleted)

9. **Port mapping** — Create worker with ports, verify docker config
   - Create worker with port mapping config
   - Verify docker container has correct port bindings

**Key test helpers:**

```typescript
function pass(msg: string) { /* green checkmark */ }
function fail(msg: string) { /* red X */ }
function sh(cmd: string, opts?: {ignoreError?: boolean; timeout?: number}): string
function sqlite(query: string): string  // Run SQLite query
function sleep(ms: number): Promise<void>
```

**How to apply:**
```bash
# Run from host
cd /home/joey/git/nanoclaw-fleet
npx tsx tools/e2e-test.ts

# Run from inside master container
# (some systemctl checks adapt to container environment)
npx tsx /workspace/project/tools/e2e-test.ts

# Run specific test (grep output)
npx tsx tools/e2e-test.ts 2>&1 | grep "Session resume"
```

**Gotchas:**
- Requires NanoClaw to be running (`npm run dev` or systemd service)
- Requires valid GUILD_ID in `.env` (Discord channel where workers live)
- Requires DB at `store/messages.db`
- Neuralwatt tests require `NEURALWATT_API_KEY` env var (skip with `--skip-nw`)

---

## tools/restart-watchdog.sh (MODIFIED)

**Intent:** Systemd user service that watches for a signal file and rebuilds + restarts NanoClaw on demand.

**Signal file:** `~/.nanoclaw-restart`

**How it works:**

1. Polls signal file every 2 seconds
2. If file exists:
   - Reads reason (optional content inside file)
   - Runs `npm run build` in NanoClaw directory
   - Restarts `nanoclaw` systemd service
   - Attempts to restart `nanoclaw-shim` (silent fail if not running)
   - Deletes signal file
3. Repeats

**Trigger from inside container:**
```bash
# Trigger rebuild (no reason)
touch /home/host/.nanoclaw-restart

# Or with reason (logged)
echo "fixed IPC bug" > /home/host/.nanoclaw-restart
```

**Benefits:**
- Containers can request rebuild without needing access to systemctl
- No manual operator intervention needed
- Build failures are logged (doesn't restart if build fails)
- Restart is atomic: all services restart together

**How to apply:**

Install as systemd user service:
```bash
# ~/.config/systemd/user/nanoclaw-restart.service
[Unit]
Description=NanoClaw Restart Watchdog
After=network.target

[Service]
Type=simple
ExecStart=/home/joey/git/nanoclaw-fleet/tools/restart-watchdog.sh
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

Enable and start:
```bash
systemctl --user enable nanoclaw-restart
systemctl --user start nanoclaw-restart
```

Monitor:
```bash
journalctl --user -u nanoclaw-restart -f
```

---

## Summary of Tools

| File | Size | Purpose | Key Feature |
|------|------|---------|------------|
| anthropic-shim.ts | 1010 lines | Inference router | Live config reload, Anthropic↔OpenAI translation, usage tracking |
| e2e-test.ts | 761 lines | Integration tests | 9 scenarios covering worker lifecycle & backends |
| restart-watchdog.sh | 54 lines | Auto-rebuild trigger | Container-initiated restart without systemctl access |

