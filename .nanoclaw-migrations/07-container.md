# Migration Guide: Container Subsystem

This section documents all changes to the container infrastructure — Dockerfile, entrypoint, build script, and the agent-runner TypeScript implementation.

---

## container/Dockerfile (MODIFIED)

**Intent:** Define the NanoClaw agent container image with all system dependencies, tools, and build artifacts.

**Key changes:**
- Base image: `node:22-slim` with comprehensive system dependencies (Chromium, fonts, build tools, Rust, Python)
- Installs global tools: Tailscale CLI, GitHub CLI, uv (Python package manager), rclone (S3/R2 access), Docker CLI, Rust toolchain
- Pre-installs agent-browser and claude-code NPM packages globally
- Sets up git credential helper to use GITHUB_TOKEN for HTTPS authentication (no SSH key needed)
- Builds agent-runner TypeScript and saves source hash to `.src-hash` for runtime skip detection
- Non-root user (node) for security

**Dependencies:** Requires agent-runner/ package.json and entrypoint.sh

**How to apply:**
```bash
cd container && ./build.sh
# Or rebuild from scratch:
docker build -t nanoclaw-agent:latest .
```

Personal Dockerfile layering:
- The build script checks for `~/.config/nanoclaw/Dockerfile` and layers it on top of the base image
- Use this for personal tools (e.g., custom Python packages, additional system deps)

---

## container/entrypoint.sh (MODIFIED)

**Intent:** Run inside the container at startup. Handles init.sh execution, TypeScript compilation with caching, reads stdin, and starts the agent.

**Key features:**
- Timing profiling: all steps logged to stderr with elapsed milliseconds (captured by systemd logs)
- Auto-detection of source changes: compares md5 hash of `/app/src/*.ts` against `.src-hash`
  - If source changed (or dist missing), recompiles via `npm run build`
  - If source unchanged, skips compilation (2-3s savings per spawn)
- Executes optional `/workspace/init.sh` (worker setup: cloning repos, installing tools)
- Reads container input from stdin as JSON, stores to `/tmp/input.json`
- Starts agent-runner with `node dist/index.js`

**Dependencies:** agent-runner TypeScript source and dist/, init.sh

**How to apply:**
- Already integrated into Dockerfile
- Rebuild container after modifying entrypoint.sh:
  ```bash
  ./container/build.sh
  ```
- To test locally: `echo '{"prompt":"test"}' | docker run -i nanoclaw-agent:latest`

**Gotcha:** If you change agent-runner source code but don't rebuild the container image, the entrypoint will recompile on every spawn. Rebuild the image to bake in the new source hash.

---

## container/build.sh (MODIFIED)

**Intent:** Build the NanoClaw agent container with optional personal layer.

**Key features:**
- Builds base image as `nanoclaw-agent:base`
- Checks for `~/.config/nanoclaw/Dockerfile` (personal layer)
  - If present: builds personal Dockerfile on top of base, tags as `nanoclaw-agent:{TAG}`
  - If absent: tags base as final image
- Supports tag override: `./build.sh v1.2.3`
- Supports container runtime override: `CONTAINER_RUNTIME=podman ./build.sh`

**Dependencies:** Dockerfile, entrypoint.sh, agent-runner/

**How to apply:**
```bash
# Build base + personal layer (if configured)
./container/build.sh

# Build with specific tag
./container/build.sh my-custom-tag

# Rebuild from scratch (clears builder cache)
docker builder prune && ./build.sh
```

---

## container/agent-runner/package.json (MODIFIED)

**Intent:** Define Node.js dependencies for the agent-runner.

**Current dependencies:**
```json
{
  "@anthropic-ai/claude-agent-sdk": "^0.2.34",
  "@modelcontextprotocol/sdk": "^1.12.1",
  "cron-parser": "^5.0.0",
  "zod": "^4.0.0"
}
```

- `claude-agent-sdk`: Core SDK for running agents in containers
- `@modelcontextprotocol/sdk`: MCP server implementation (for stdio tools)
- `cron-parser`: Validate cron expressions in scheduled tasks
- `zod`: Runtime schema validation for tool inputs

**How to apply:**
```bash
cd container/agent-runner && npm install
```

---

## container/agent-runner/src/index.ts (MODIFIED)

**Intent:** Main agent-runner entrypoint. Reads container input, manages sessions, polls IPC for follow-up messages, and streams results to stdout.

**Architecture:**

### MessageStream class (lines 70–116)
Async iterable that keeps the SDK's query alive across multiple messages. Prevents `isSingleUserTurn=true`, which would prevent agent teams subagents from completing.

```typescript
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;
  private pushed = 0;  // Track push vs yield gap (diagnostics)
  private yielded = 0;

  push(text: string): void {
    // Add message to queue, wake up iterator if waiting
  }

  end(): void {
    // Signal end of stream (session closed)
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    // Yield from queue, wait if empty, stop when done
  }
}
```

Pushed vs. yielded counters detect if the SDK stops consuming (root cause of 30-min master outage 2026-04-10).

### Main query loop (lines 425–500+)
```typescript
async function runQuery(
  prompt: string,
  sessionId?: string,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string>,
  resumeAt?: string
): Promise<{
  newSessionId?: string;
  lastAssistantUuid?: string;
  closedDuringQuery: boolean;
}>
```

**Key behaviors:**
1. Creates MessageStream with initial prompt
2. Starts IPC polling task that runs during the query:
   - Every 500ms: check for new files in `/workspace/ipc/input/`
   - If `_close` sentinel exists: end the stream
   - Otherwise: drain all `.json` files, push to stream
3. Builds system prompt from two sources:
   - Global CLAUDE.md (if worker, from `/workspace/global/`)
   - Include content (from `includeContent` in container input)
4. Discovers extra directories in `/workspace/extra/*`
5. Calls `query()` with assembled options
6. Streams results via `writeOutput()` markers
7. Returns new session ID if created

### IPC polling pattern (lines 401–417)
```typescript
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);  // 500ms
    };
    poll();
  });
}
```

Checks for `/workspace/ipc/input/*.json` files every 500ms. Non-blocking — doesn't freeze the query loop.

### Pre-compact hook (lines 206–259)
Registered before query runs to archive transcripts before compaction:

```typescript
function createPreCompactHook(
  chatJid: string,
  groupFolder: string,
  assistantName?: string
): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    
    // 1. Send Discord notification: "⏳ Compacting..."
    sendCompactionNotice(chatJid, groupFolder, preCompact.trigger);
    
    // 2. Parse transcript from JSON lines
    const content = fs.readFileSync(transcriptPath, 'utf-8');
    const messages = parseTranscript(content);
    
    // 3. Look up session summary from sessions-index.json
    const summary = getSessionSummary(sessionId, transcriptPath);
    
    // 4. Format as markdown, save to conversations/
    const markdown = formatTranscriptMarkdown(messages, summary, assistantName);
    fs.writeFileSync(filePath, markdown);
    
    return {};
  };
}
```

Archives full context to persistent storage before the SDK compacts.

**How to apply:**
- Already integrated into container build
- Modify behavior: edit `/app/src/index.ts`, rebuild container (`container/build.sh`)
- Test live: send a message that triggers compaction, check `logs/nanoclaw.log` and `workspace/group/conversations/`

---

## container/agent-runner/src/ipc-mcp-stdio.ts (MODIFIED)

**Intent:** Standalone MCP stdio server that agent teams subagents can inherit. Provides tools for messaging, backend info, and task scheduling.

**Key tools:**

### send_message
```typescript
'send_message': {
  text: string,          // Message text
  sender?: string        // Optional role/identity (Telegram multi-bot mode)
}
```
Writes to `/workspace/ipc/messages/*.json` for host to dispatch.

### get_backend
```typescript
'get_backend': {
  // No arguments
}
```
Returns current backend + model. For Neuralwatt: queries `/worker-config` endpoint on shim (live config). For Anthropic: returns env var.

### schedule_task
```typescript
'schedule_task': {
  prompt: string,
  schedule_type: 'cron' | 'interval' | 'once',
  schedule_value: string,  // "0 9 * * *" | "300000" | "2026-02-01T15:30:00"
  context_mode: 'group' | 'isolated',
  target_group_jid?: string  // Main only
}
```
Validates cron/interval, writes to `/workspace/ipc/tasks/*.json`.

### list_tasks, pause_task, resume_task, cancel_task, update_task
CRUD operations on `/workspace/ipc/current_tasks.json`.

### register_group
```typescript
'register_group': {
  jid: string,           // "120363...@g.us" | "tg:-1001..." | "dc:123..."
  name: string,
  folder: string,        // "whatsapp_family-chat" (channel-prefixed)
  trigger: string        // "@Andy"
}
```
Main only. Registers new group for agent responses.

**How to apply:**
- Already baked into container image
- Modify tools: edit `/app/src/ipc-mcp-stdio.ts`, rebuild container
- Test: call a tool from inside a worker agent, check `/workspace/ipc/` for output files

---

## container/agent-runner/src/ipc-mcp.ts (DELETED)

**Intent:** This file was removed because stdio-based MCP is more robust than the previous file-polling approach.

**Why deleted:**
- Old implementation had file-based round-trip: agent writes req → host reads → host writes response → agent reads
- New stdio approach: subagents inherit stdio server directly (no file I/O latency, simpler lifecycle)
- Cleaner separation: container manages container-local IPC, host manages host-local IPC

**Migration note:** If you have custom tooling that referenced `ipc-mcp.ts`, port it to use `ipc-mcp-stdio.ts` instead (tool definitions are the same, only transport changed).

---

## container/skills/agent-browser/SKILL.md (MODIFIED)

**Intent:** Document the agent-browser tool for web automation within worker containers.

**Quick reference:**
- `agent-browser open <url>` — Navigate
- `agent-browser snapshot -i` — Get interactive elements with refs
- `agent-browser click @e1` — Click by ref
- `agent-browser fill @e2 "text"` — Fill input
- `agent-browser close` — Close browser

**Full command reference:** See file for 40+ commands (screenshot, wait, auth state save/load, cookies, JavaScript eval).

**How to apply:**
- Already integrated (agent-browser installed globally in Dockerfile)
- Use from worker agents: `agent-browser open https://...`
- Reference: `/home/joey/git/nanoclaw-fleet/container/skills/agent-browser/SKILL.md`

---

## container/skills/status/SKILL.md (MODIFIED)

**Intent:** Skill that renders system status dashboard and sends to Discord.

**Steps:**
1. Run `/workspace/project/tools/nc-status.sh`
2. Send full output to Discord via `send_message`
3. Wrap in `<internal>` tags so output isn't duplicated

**How to apply:**
- Automatically available to master agent
- Invoked by `/status` command in Discord
- Output goes to Discord, not to agent stdout

---

## Summary of Container Changes

| File | Change | Notes |
|-|-|-|
| Dockerfile | Updated base image, system deps, global tools | Rebuild with `container/build.sh` |
| entrypoint.sh | Source hash caching, init.sh execution | Rebuilds container on agent-runner changes |
| build.sh | Personal layer support | Checks `~/.config/nanoclaw/Dockerfile` |
| package.json | pinned MCP + agent SDK versions | Run `npm install` in agent-runner |
| index.ts | MessageStream, IPC polling, pre-compact hook | Handles streaming, sessions, compaction |
| ipc-mcp-stdio.ts | 7 MCP tools (send_message, schedule_task, etc.) | stdio transport for subagents |
| ipc-mcp.ts | DELETED | Replaced by stdio approach |
| agent-browser SKILL.md | Web automation reference | 40+ commands documented |
| status SKILL.md | Discord status dashboard | Renders system state |

