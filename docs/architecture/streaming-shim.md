# Streaming Shim

The translation shim turns Neuralwatt's OpenAI-style streaming SSE into Anthropic-style streaming SSE so the Claude Agent SDK gets real-time output.

Without streaming the SDK falls back to two requests per turn (streaming attempt followed by non-streaming retry), which double-counts usage and doubles latency. The shim's streaming path keeps the SDK on a single request.

## SSE format translation

**OpenAI input from Neuralwatt:**

```
data: {"choices": [{"delta": {"role": "assistant", "content": ""}}]}
data: {"choices": [{"delta": {"reasoning": "thinking..."}}]}
data: {"choices": [{"delta": {"content": "Hello"}}]}
data: {"choices": [{"delta": {}, "finish_reason": "stop"}]}
data: {"choices": [], "usage": {"prompt_tokens": 12, "total_tokens": 62, "completion_tokens": 50}}
: energy {"energy_joules": 9.99, ...}
data: [DONE]
```

**Anthropic output the SDK expects:**

```
event: message_start
data: {"type": "message_start", "message": {"id": "msg_...", "role": "assistant", "content": [], "model": "claude-opus-4-6", "usage": {"input_tokens": 12}}}

event: content_block_start
data: {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}

event: content_block_delta
data: {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Hello"}}

event: content_block_stop
data: {"type": "content_block_stop", "index": 0}

event: message_delta
data: {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 50}}

event: message_stop
data: {"type": "message_stop"}
```

## Translation rules

| OpenAI chunk | Anthropic event |
|-|-|
| First chunk with `role: "assistant"` | `message_start` + `content_block_start` |
| `delta.reasoning` | `content_block_delta` with `thinking_delta` |
| `delta.content` | `content_block_delta` with `text_delta` |
| `finish_reason` present | `content_block_stop` + `message_delta` carrying `stop_reason` |
| `usage` chunk (empty `choices`) | Folded into `message_delta` |
| `: energy {...}` SSE comment | Parsed and recorded; not forwarded (Anthropic has no equivalent) |
| `[DONE]` | `message_stop` |

Thinking content and text content live in separate content blocks with separate indices. When the stream switches from `reasoning` deltas to `content` deltas, the shim closes the thinking block (`content_block_stop`) and opens a text block (`content_block_start` at the next index).

The translator keeps a small state machine: `currentBlockIndex`, `inThinking`, synthetic `messageId`, and accumulated `usage`.

## Tool calls

OpenAI streams tool calls in pieces:

```
data: {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "call_...", "function": {"name": "get_weather", "arguments": ""}}]}}]}
data: {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": "{\"loc"}}]}}]}
```

The shim emits `tool_use` content blocks with `input_json_delta` partial JSON so the SDK can assemble them:

```
event: content_block_start
data: {"type": "content_block_start", "index": 1, "content_block": {"type": "tool_use", "id": "toolu_...", "name": "get_weather"}}

event: content_block_delta
data: {"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": "{\"loc"}}
```

Partial JSON accumulation is the trickiest piece — keep tool schemas simple where you can.

## Energy capture

Neuralwatt sends a non-standard SSE comment line near the end:

```
: energy {"energy_joules": 9.99, ...}
```

Standard SSE parsers throw comment lines away. The shim reads raw lines so it can capture energy data before forwarding `[DONE]`. Captured values land in `data/worker-usage.json` and the per-worker turn log. See [energy-tracking.md](energy-tracking.md).

## Implementation shape

```
const resp = await fetch(URL, { body: { ...body, stream: true } });
return new Response(translateStream(resp.body), {
  headers: { "content-type": "text/event-stream" }
});
```

`translateStream` is a `TransformStream` that reads OpenAI SSE lines and writes Anthropic SSE lines. Source: `tools/anthropic-shim.ts`.

## Limitations

- Tool-call streaming relies on partial-JSON accumulation; complex schemas can hit edges.
- Reasoning-to-content transitions assume the model produces them in order. Out-of-order streams would confuse the state machine; no observed cases so far.
- A mid-stream upstream error is rewritten into a clean Anthropic error event so the SDK's stream parser doesn't choke. The original error body is logged on the host.
