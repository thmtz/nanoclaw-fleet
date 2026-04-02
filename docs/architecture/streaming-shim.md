# Streaming Shim

Status: **Implemented** | Created: 2026-03-28

The translation shim translates OpenAI streaming SSE (from Neuralwatt) into Anthropic streaming SSE (which the SDK expects). Without this, the SDK sends each request twice (streaming + non-streaming fallback), causing duplicate responses and double-counted usage. With streaming support, the SDK gets streamed chunks back and never triggers the fallback.

## SSE Format Translation

**OpenAI (Neuralwatt sends):**
```
data: {"choices": [{"delta": {"role": "assistant", "content": ""}}]}
data: {"choices": [{"delta": {"reasoning": "thinking..."}}]}
data: {"choices": [{"delta": {"content": "Hello"}}]}
data: {"choices": [{"delta": {}, "finish_reason": "stop"}]}
data: {"choices": [], "usage": {"prompt_tokens": 12, "total_tokens": 62, "completion_tokens": 50}}
: energy {"energy_joules": 9.99, ...}
data: [DONE]
```

**Anthropic (SDK expects):**
```
event: message_start
data: {"type": "message_start", "message": {"id": "msg_...", "type": "message", "role": "assistant", "content": [], "model": "claude-opus-4-6", "usage": {"input_tokens": 12}}}

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

## Translation Rules

Each OpenAI chunk maps to Anthropic events:

| OpenAI chunk | Anthropic event(s) |
|-|-|
| First chunk (role: assistant) | `message_start` + `content_block_start` |
| `delta.reasoning` | `content_block_delta` with `thinking_delta` type |
| `delta.content` | `content_block_delta` with `text_delta` type |
| `finish_reason` present | `content_block_stop` + `message_delta` (stop_reason) |
| `usage` chunk (empty choices) | Include in `message_delta` |
| `: energy {...}` comment | Parse + record usage (don't forward, Anthropic has no equivalent) |
| `[DONE]` | `message_stop` |

Thinking content and text content are separate content blocks with separate indices.

## State Machine

The translator tracks:
- `currentBlockIndex`: which content block we're in
- `inThinking`: whether we're emitting thinking deltas
- `messageId`: synthetic ID for the response
- `usage`: accumulated from chunks

When the stream transitions from `reasoning` deltas to `content` deltas, close the thinking block (`content_block_stop`) and open a text block (`content_block_start` with next index).

## Tool Calls

OpenAI streaming tool calls arrive as:
```
data: {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "call_...", "function": {"name": "get_weather", "arguments": ""}}]}}]}
data: {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": "{\"loc"}}]}}]}
```

Translate to Anthropic `tool_use` content blocks:
```
event: content_block_start
data: {"type": "content_block_start", "index": 1, "content_block": {"type": "tool_use", "id": "toolu_...", "name": "get_weather"}}

event: content_block_delta
data: {"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": "{\"loc"}}
```

## Energy Capture

The `: energy {...}` SSE comment appears near the end of the stream. Standard SSE parsers ignore comments. The shim reads raw lines and captures this before forwarding `[DONE]`.

## Implementation

The shim's Neuralwatt handler changes from:
```
const resp = await fetch(URL, { body });
const json = await resp.json();
return Response.json(translate(json));
```

To:
```
const resp = await fetch(URL, { body: { ...body, stream: true } });
return new Response(translateStream(resp.body), {
  headers: { "content-type": "text/event-stream" }
});
```

Where `translateStream` is a `TransformStream` that reads OpenAI SSE lines and writes Anthropic SSE lines.

## Risks

- Tool call streaming is complex (partial JSON accumulation). Start with text-only, add tools after.
- Thinking/reasoning blocks need a transition detector (reasoning → content switch).
- Error mid-stream: if Neuralwatt errors after partial response, need to emit a clean Anthropic error event.
