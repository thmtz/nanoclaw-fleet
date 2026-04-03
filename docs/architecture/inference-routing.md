# Inference Routing

How API traffic flows from worker containers to inference backends.

## Architecture

```
                                ┌──────────────────────┐
                                │   api.anthropic.com   │
                                └──────────┬───────────┘
                                           │
                                ┌──────────┴───────────┐
                                │  Credential Proxy     │
                                │  :3001 (auth inject)  │
                                └──────────┬───────────┘
                                           │
                          ┌────────────────┴────────────────┐
                          │                                 │
               ┌──────────┴───────────┐          ┌─────────┴──────────┐
               │  Universal Shim      │          │  api.neuralwatt.com │
               │  :3003               │──────────│  (OpenAI format)    │
               │  per-request routing  │          └────────────────────┘
               └──────────┬───────────┘
                          │
         ┌────────────────┼────────────────┐
         │                │                │
┌────────┴─────────┐ ┌───┴──────────┐ ┌───┴──────────────┐
│  Worker A        │ │  Worker B    │ │  Worker C        │
│  (Anthropic)     │ │  (Anthropic) │ │  (Neuralwatt)    │
│  BASE_URL=:3003  │ │  BASE_URL=   │ │  BASE_URL=:3003  │
│  /w/discord_a    │ │  :3003/w/b   │ │  /w/discord_c    │
└──────────────────┘ └──────────────┘ └──────────────────┘
```

**All workers route through the shim (:3003).** The shim reads `worker-backends.json`
per-request to decide whether to forward to Anthropic (via credential proxy) or
Neuralwatt (with Anthropic→OpenAI translation). This enables live backend switching
without restarting containers.

## Request Flow: Anthropic Worker

```
1. Agent SDK sends POST /w/discord_foo/v1/messages
   Headers: x-api-key: sk-ant-worker-discord_foo000...
   Body: { model: "claude-opus-4-6", messages: [...] }

2. Shim (:3003)
   - Extracts worker folder from URL path: "discord_foo"
   - Reads worker-backends.json → no entry (default: anthropic)
   - Forwards request to credential proxy (:3001)

3. Credential proxy (:3001)
   - Replaces placeholder API key / OAuth token with real credentials
   - Forwards to api.anthropic.com

4. api.anthropic.com responds with Anthropic Messages format
   (passed through shim and credential proxy unchanged)
```

## Request Flow: Anthropic Worker (SDK Init)

```
1. SDK sends GET /v1/organizations or POST /api/oauth/claude_cli/create_api_key
   Headers: x-api-key: sk-ant-worker-discord_foo000...
   (These go to CLAUDE_CODE_API_BASE_URL, which also points to the shim)

2. Shim (:3003)
   - Extracts worker folder from API key: "discord_foo"
   - Reads worker-backends.json → anthropic
   - Forwards to credential proxy (which injects real auth)

3. Credential proxy → api.anthropic.com → real response back to SDK
```

## Request Flow: Neuralwatt Worker

```
1. Agent SDK sends POST /w/discord_bar/v1/messages
   Headers: x-api-key: sk-ant-worker-discord_bar000...
   Body: { model: "claude-opus-4-6", messages: [...], tools: [...] }

2. Shim (:3003)
   - Extracts worker folder from URL path: "discord_bar"
   - Reads worker-backends.json → { backend: "neuralwatt", model: "moonshotai/Kimi-K2.5" }
   - Translates request:
     * system blocks → system message
     * tool_use/tool_result blocks → OpenAI function call format
     * model name → resolved Neuralwatt model
   - Sends POST /v1/chat/completions to api.neuralwatt.com
     Headers: Authorization: Bearer <neuralwatt-api-key>

3. Neuralwatt responds in OpenAI format

4. Shim translates response back:
   * function calls → tool_use content blocks
   * reasoning_content → thinking blocks
   * finish_reason → stop_reason mapping
   * Returns Anthropic Messages format to the SDK
```

## Request Flow: Neuralwatt Worker (SDK Init)

```
1. SDK sends GET /v1/organizations or POST /api/check_model_access
   Headers: x-api-key: sk-ant-worker-discord_bar000...

2. Shim (:3003)
   - Extracts worker folder from API key: "discord_bar"
   - Reads worker-backends.json → neuralwatt
   - Returns stubbed empty response (fake credentials can't auth with Anthropic)
```

## Live Backend Switching

Backends can be switched at runtime via `switch_backend` (IPC command from master).
This updates `data/worker-backends.json`, which the shim re-reads on every request
(mtime-cached). The change takes effect on the worker's next API call — no container
restart needed.

```
# Before: worker is on Neuralwatt
data/worker-backends.json:
  { "discord_foo": { "backend": "neuralwatt", "model": "moonshotai/Kimi-K2.5" } }

# Master runs switch_backend → updates file
data/worker-backends.json:
  {}  (no entry = default anthropic)

# Next request from worker goes through Anthropic automatically
```

## Worker Identification

Workers are identified by two mechanisms:

1. **URL path prefix**: `/w/{folder}/v1/messages` — used for API requests
2. **API key encoding**: `sk-ant-worker-{folder}000...` — used for init requests
   that don't include the `/w/` prefix (e.g., OAuth exchange, model access checks)

The per-worker API key is generated by `container-runner.ts` using the
`WORKER_API_KEY_PREFIX` constant. The shim extracts the folder by stripping
the prefix and trailing zero-padding.

## Configuration

**Per-worker backend and model** are managed in `data/worker-backends.json`:
```json
{
  "discord_foo": { "backend": "neuralwatt", "model": "moonshotai/Kimi-K2.5" }
}
```

Workers not listed default to Anthropic. The shim re-reads this file on each
request (cached with mtime check). Both backend and model changes take effect
immediately.

## Key Files

| File | Role |
|-|-|
| `tools/anthropic-shim.ts` | Universal proxy — routing, translation, init stubs |
| `src/credential-proxy.ts` | OAuth/API key injection for Anthropic |
| `src/container-runner.ts` | Sets ANTHROPIC_BASE_URL to shim for all containers |
| `data/worker-backends.json` | Runtime backend+model config (shim reads per-request) |

## Limitations

- Streaming is supported but tool call streaming can be complex (partial JSON accumulation)
- Tool call translation covers common cases but complex schemas may hit edge cases
- Open-source models vary in tool calling quality
