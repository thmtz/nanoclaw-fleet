import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  BACKEND_ANTHROPIC: 'anthropic',
  BACKEND_NEURALWATT: 'neuralwatt',
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  CREDENTIAL_PROXY_PORT: 3001,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GITHUB_TOKEN_PATH: null,
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  NEURALWATT_PROXY_PORT: 3003,
  TIMEZONE: 'America/Los_Angeles',
  WORKER_API_KEY_PREFIX: 'sk-ant-worker-',
  WORKER_BACKENDS_FILENAME: 'worker-backends.json',
}));

vi.mock('./backend-defaults.js', () => ({
  resolveEffectiveBackendConfig: vi.fn(() => ({
    backend: 'anthropic',
    model: 'claude-opus-4-6',
  })),
  seedBackendEntry: vi.fn(() => false),
  MAIN_FOLDER: 'discord_main',
  FALLBACK_ANTHROPIC_MODEL: 'claude-opus-4-6',
  FALLBACK_NEURALWATT_MODEL: 'moonshotai/Kimi-K2.5',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

import { runContainerAgent, ContainerOutput } from './container-runner.js';
import {
  resolveEffectiveBackendConfig,
  seedBackendEntry,
} from './backend-defaults.js';
import fs from 'fs';
import { spawn } from 'child_process';
import type { RegisteredGroup } from './types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });
});

describe('container-runner backend seeding', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(seedBackendEntry).mockClear();
    vi.mocked(spawn).mockClear();
    vi.mocked(fs.readFileSync).mockReset();
    vi.mocked(fs.existsSync).mockReturnValue(false);
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function runAndFinish() {
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      vi.fn(async () => {}),
    );
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'ok',
      newSessionId: 's',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
  }

  // Regression: shim defaulted to anthropic for workers with no entry in
  // worker-backends.json, routing NW traffic to the real Anthropic API with
  // a placeholder key → 401. container-runner must seed the entry so the
  // shim (separate process) agrees with the container's backend.
  it('seeds worker-backends.json when no entry exists', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue('');
    vi.mocked(resolveEffectiveBackendConfig).mockReturnValueOnce({
      backend: 'neuralwatt',
      model: 'moonshotai/Kimi-K2.5',
    });

    await runAndFinish();

    expect(seedBackendEntry).toHaveBeenCalledWith('test-group', {
      backend: 'neuralwatt',
      model: 'moonshotai/Kimi-K2.5',
    });
    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(args).toContain('NANOCLAW_BACKEND=neuralwatt');
    expect(args).toContain('NANOCLAW_MODEL=moonshotai/Kimi-K2.5');
  });

  it('does not seed when entry already exists', async () => {
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
      if (String(p).endsWith('worker-backends.json')) {
        return JSON.stringify({
          'test-group': { backend: 'anthropic', model: 'claude-opus-4-6' },
        });
      }
      return '';
    });
    vi.mocked(resolveEffectiveBackendConfig).mockReturnValueOnce({
      backend: 'anthropic',
      model: 'claude-opus-4-6',
    });

    await runAndFinish();

    expect(seedBackendEntry).not.toHaveBeenCalled();
    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(args).toContain('NANOCLAW_BACKEND=anthropic');
    expect(args).toContain('NANOCLAW_MODEL=claude-opus-4-6');
  });
});
