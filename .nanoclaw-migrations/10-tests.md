# Migration Guide: Test Infrastructure

This section documents all TypeScript test files, test scenarios, and the test framework configuration.

---

## Test Files Index

Test files follow the naming convention `*.test.ts` and are colocated with the code they test.

| File | Lines | Purpose | Test Count |
|------|-------|---------|-----------|
| `src/channels/discord.test.ts` | ~300 | Discord channel integration | 15+ |
| `src/channels/whatsapp.test.ts` | ~280 | WhatsApp channel integration | 14+ |
| `src/channels/registry.test.ts` | ~150 | Channel registry & discovery | 8+ |
| `src/group-folder.test.ts` | ~200 | Group workspace management | 10+ |
| `src/container-runner.test.ts` | ~350 | Container spawn/kill/restart | 18+ |
| `src/credential-proxy.test.ts` | ~250 | Credential proxy HTTP server | 12+ |
| `src/task-scheduler.test.ts` | ~400 | Task scheduling (cron/interval/once) | 20+ |
| `src/container-runtime.test.ts` | ~180 | Docker/Podman runtime abstraction | 9+ |
| `src/group-queue.test.ts` | ~220 | Message queue & concurrency | 11+ |
| `src/timezone.test.ts` | ~120 | Timezone parsing & handling | 6+ |
| `src/ipc.test.ts` | ~290 | IPC message passing | 14+ |
| `src/db.test.ts` | ~340 | SQLite database operations | 17+ |
| `src/sender-allowlist.test.ts` | ~180 | Sender permission checking | 9+ |
| `src/mount-security.test.ts` | ~210 | Mount path validation | 10+ |
| `src/ipc-auth.test.ts` | ~240 | IPC authentication | 12+ |
| `src/session-commands.test.ts` | ~300 | Session lifecycle commands | 15+ |
| `src/routing.test.ts` | ~270 | Message routing logic | 13+ |
| `src/formatting.test.ts` | ~190 | Message formatting & parsing | 9+ |

**Total:** ~4200 lines of tests across 18 files.

---

## Test Suites by Category

### Channel Integration

**discord.test.ts**
- Message receive/send
- Attachment handling
- Reaction support
- Guild/channel lookup
- Bot token validation
- Rate limiting & queuing

**whatsapp.test.ts**
- Message receive/send via Socket
- Group metadata parsing
- Contact/group JID extraction
- Media message handling
- Typing indicators
- Connection lifecycle

**registry.test.ts**
- Channel registration
- Dynamic loading of channel plugins
- Message routing to correct channel
- Channel enable/disable

### Workspace & Database

**group-folder.test.ts**
- Workspace directory structure
- CLAUDE.md assembly
- Config loading
- Session index management
- Conversation archival

**db.test.ts**
- SQLite schema creation
- Worker/group CRUD
- Session tracking
- Task persistence
- Query execution

**group-queue.test.ts**
- Message enqueueing
- Concurrency control (1 message at a time per group)
- Message ordering
- Timeout handling
- Backpressure

### Container & Runtime

**container-runner.test.ts**
- Container spawn
- Stdin/stdout handling
- Session input/output
- Container kill
- Workspace mounting
- Signal file handling

**container-runtime.test.ts**
- Docker CLI abstraction
- Podman support
- Container list/inspect/stop
- Image building
- Port mapping

**credential-proxy.test.ts**
- HTTP server startup
- Token forwarding
- Request validation
- Error responses
- Shutdown

### Task & Message Management

**task-scheduler.test.ts**
- Cron expression parsing
- Task scheduling (recurring/one-time)
- Task execution
- Task state management (pause/resume/cancel)
- Context mode (group vs. isolated)
- Multi-group task support

**session-commands.test.ts**
- Session resume (fresh container, same session)
- Session list
- Session clear
- Transcript export
- Per-session context

**ipc.test.ts**
- IPC message write
- IPC message polling
- Sentinel handling (_close)
- File cleanup
- Error tolerance (corrupt files)

### Routing & Security

**routing.test.ts**
- Message channel detection
- User/group classification
- Master vs. worker routing
- Permission checks
- Trigger word matching

**sender-allowlist.test.ts**
- Allowlist parsing
- Sender validation
- Discord role checks
- WhatsApp group admin checks
- Fallback behavior

**mount-security.test.ts**
- Path validation (no `..`)
- Symlink traversal checks
- Absolute vs. relative paths
- Read-only mount enforcement

**ipc-auth.test.ts**
- IPC client authentication
- Token generation
- Token validation
- Expiration

### Utilities

**timezone.test.ts**
- Parse timezone strings
- Convert local→UTC
- Handle DST transitions
- Invalid input handling

**formatting.test.ts**
- Discord mention extraction
- WhatsApp name parsing
- Emoji handling
- Link extraction
- Code block formatting

---

## Test Framework Configuration

**Framework:** Vitest (via `npm test`)

**Config file:** `vitest.config.ts` (repo root)

**Key settings:**
- Environment: Node.js
- Test reporter: default + coverage
- Watch mode: enabled
- Parallel workers: auto

**Run tests:**
```bash
# All tests
npm test

# Watch mode
npm test -- --watch

# Specific file
npm test src/db.test.ts

# Specific test (pattern match)
npm test -t "should parse cron"

# With coverage
npm test -- --coverage

# Fail fast (stop on first failure)
npm test -- --bail
```

---

## Test Patterns & Helpers

### Mock Container Runtime
```typescript
// Instead of spawning real Docker
const mockRuntime = new MockContainerRuntime();
mockRuntime.mockSpawn = (sessionId) => ({
  output: 'Agent response',
  newSessionId: 'new-session'
});
```

### Test Database
```typescript
// Creates temporary SQLite DB per test
const db = new Database(':memory:');
// Auto-cleaned up after test
```

### Mock Channel Implementations
```typescript
class MockDiscordChannel extends DiscordChannel {
  async send(msg: string) { /* track call */ }
  async receive(): Promise<string> { /* return test message */ }
}
```

### IPC File Helpers
```typescript
// Write test input
writeIpcInput(groupFolder, 'test message');

// Poll for output
const output = await pollIpcOutput(groupFolder, 5000);
```

---

## Critical Test Scenarios

### E2E: Full Worker Lifecycle
```
1. Create worker (register in DB, create workspace)
2. Boot container (init.sh runs, repos cloned)
3. First message (agent responds, session created)
4. Resume session (kill container, respawn, agent recalls)
5. Switch backend (NW → Anthropic, container restarts)
6. Destroy (cleanup DB, preserve workspace)
```

Tested in: `container-runner.test.ts` + `session-commands.test.ts`

### E2E: Task Scheduling
```
1. Schedule recurring task (cron: daily at 9am)
2. Task runs at next scheduled time
3. Task executes in correct context (group or isolated)
4. Task output sent to correct channel
5. Pause task (doesn't run)
6. Resume task (runs again)
7. Cancel task (deleted from schedule)
```

Tested in: `task-scheduler.test.ts`

### E2E: Multi-Channel Message Flow
```
1. Message arrives on Discord
2. Discord channel parses JID, extracts text
3. Message routed to correct group (master or worker)
4. Group queue processes (1 msg at a time)
5. Container spun up with message
6. Agent processes, IPC output captured
7. IPC output routed back to Discord
8. Message sent via Discord API
```

Tested in: `discord.test.ts` + `routing.test.ts` + `group-queue.test.ts`

---

## Running Tests in CI/CD

Tests run automatically on:
- `npm test` (local development)
- GitHub Actions (on PR)
- Pre-push hook (if configured)

**Coverage threshold:** Enforced at 70% (warn) / 80% (fail)

**Fail conditions:**
- Any test fails
- Coverage drops below threshold
- TypeScript compilation errors

---

## Adding New Tests

### 1. Create test file
```bash
touch src/my-feature.test.ts
```

### 2. Boilerplate
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MyFeature } from './my-feature';

describe('MyFeature', () => {
  let feature: MyFeature;

  beforeEach(() => {
    feature = new MyFeature();
  });

  afterEach(() => {
    feature.cleanup();
  });

  it('should do something', () => {
    const result = feature.doSomething();
    expect(result).toBe('expected');
  });
});
```

### 3. Run & iterate
```bash
npm test -- --watch src/my-feature.test.ts
```

### 4. Ensure cleanup
- Mock containers/DB should be created fresh per test
- IPC files should be cleaned up
- Processes should be killed on failure
- Memory leaks checked via `afterEach`

---

## Debugging Tests

### Run single test with verbose output
```bash
npm test src/db.test.ts -t "should create worker" -- --reporter=verbose
```

### Debug in Node inspector
```bash
node --inspect-brk ./node_modules/vitest/vitest.mjs run src/db.test.ts
# Opens chrome://inspect
```

### Check test timeout (default 10s)
```typescript
it('slow operation', { timeout: 30000 }, async () => {
  // Long-running test
});
```

### Mock time for cron tests
```typescript
import { vi } from 'vitest';

it('should run at 9am', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-04-10T09:00:00'));
  
  scheduler.tick();
  
  expect(taskExecuted).toBe(true);
  vi.useRealTimers();
});
```

---

## Summary

**Total test coverage:** ~4200 lines across 18 files
**Test types:** Unit, integration, E2E
**Framework:** Vitest (Node.js)
**Execution:** `npm test`
**Coverage threshold:** 70-80%

**Key test areas:**
- Channel integration (Discord, WhatsApp)
- Container lifecycle (spawn, kill, restart)
- Task scheduling (cron, intervals, one-time)
- IPC messaging
- Database operations
- Permission & security checks
- Message formatting & routing

**Critical paths tested:**
- Full worker lifecycle (create → boot → message → resume → destroy)
- Task scheduling (schedule → pause → resume → cancel)
- Multi-channel message flow (receive → route → execute → send)

