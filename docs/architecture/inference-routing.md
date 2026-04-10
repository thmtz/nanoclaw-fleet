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
                                │  :3001 (OAuth inject) │
                                └──────────┬───────────┘
                                           │
         ┌─────────────────────────────────┼─────────────────────────────────┐
         │                                 │                                 │
┌────────┴─────────┐  ┌───────────────────┴──────────┐  ┌────────────────────┴───────┐
│  Anthropic Worker │  │  Anthropic Worker            │  │  Neuralwatt Worker         │
│  ANTHROPIC_BASE_  │  │  ANTHROPIC_BASE_URL=         │  │  ANTHROPIC_BASE_URL=       │
│  URL=:3001        │  │  :3001                       │  │  :3003/w/discord_foo       │
│  (OAuth)          │  │  (OAuth)                     │  │  (API key placeholder)     │
└──────────────────┘  └──────────────────────────────┘  └────────────┬───────────────┘
                                                                     │
                                                          ┌──────────┴───────────┐
                                                          │  Translation Shim    │
                                                          │  :3003               │
                                                          │  Anthropic → OpenAI  │
                                                          │  reads config/req    │
                                                          └──────────┬───────────┘
                                                                     │
                                                          ┌──────────┴───────────┐
                                                          │  api.neuralwatt.com  │
                                                          │  (OpenAI format)     │
                                                          └──────────────────────┘
```

## Request Flow: Anthropic Worker

```
1. Agent SDK sends POST /v1/messages
   Headers: Authorization: Bearer <temp-api-key>
   Body: { model: "claude-opus-4-6", messages: [...] }

2. Credential proxy (:3001)
   - First request: SDK sends OAuth exchange to /api/oauth/claude_cli/create_api_key
     Proxy replaces "Bearer placeholder" with real OAuth token
     Anthropic returns a temporary API key
   - Subsequent requests: SDK sends x-api-key: <temp-key>
     Proxy passes through (temp key is already valid)

3. api.anthropic.com responds with Anthropic Messages format
```

## Request Flow: Neuralwatt Worker

```
1. Agent SDK sends POST /w/discord_foo/v1/messages
   Headers: x-api-key: placeholder
   Body: { model: "claude-opus-4-6", messages: [...], tools: [...] }

2. Shim (:3003)
   - Extracts worker folder from URL path: "discord_foo"
   - Reads data/worker-backends.json → { backend: "neuralwatt", model: "moonshotai/Kimi-K2.5" }
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

## Configuration

**Per-worker backend** is set at container creation time in `worker.env`:
```
NANOCLAW_BACKEND=neuralwatt   # or absent for anthropic
```

`container-runner.ts` reads this and sets `ANTHROPIC_BASE_URL` accordingly. The backend cannot be changed without restarting the container.

**Per-worker model** (Neuralwatt only) can be changed at runtime via `data/worker-backends.json`:
```json
{
  "discord_foo": { "backend": "neuralwatt", "model": "moonshotai/Kimi-K2.5" }
}
```

The shim re-reads this file on each request (cached with mtime check). Model changes take effect immediately.

## Key Files

| File | Role |
|-|-|
| `src/credential-proxy.ts` | OAuth/API key injection for Anthropic |
| `tools/anthropic-shim.ts` | Anthropic→OpenAI translation + routing |
| `src/container-runner.ts` | Sets ANTHROPIC_BASE_URL per container |
| `data/worker-backends.json` | Runtime model config (shim reads per-request) |

## Limitations

- Backend (Anthropic vs Neuralwatt) is fixed per container lifetime
- Streaming is supported but tool call streaming can be complex (partial JSON accumulation)
- Tool call translation covers common cases but complex schemas may hit edge cases
- Open-source models vary in tool calling quality
