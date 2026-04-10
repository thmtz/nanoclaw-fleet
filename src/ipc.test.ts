import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { updateWorkerEnvBackend } from './ipc.js';
import { DATA_DIR } from './config.js';

describe('updateWorkerEnvBackend', () => {
  const folder = 'discord_test-switch';
  const envDir = path.join(DATA_DIR, 'sessions', folder);
  const envPath = path.join(envDir, 'worker.env');

  beforeEach(() => {
    fs.mkdirSync(envDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(envDir, { recursive: true, force: true });
  });

  // Backend routing now comes from worker-backends.json. updateWorkerEnvBackend
  // only strips stale NANOCLAW_BACKEND/MODEL from worker.env (legacy cleanup).
  it('strips stale NANOCLAW_BACKEND and NANOCLAW_MODEL from worker.env', () => {
    fs.writeFileSync(
      envPath,
      'WORKER_REPOS=foo\nNANOCLAW_BACKEND=neuralwatt\nNANOCLAW_MODEL=opus',
    );
    updateWorkerEnvBackend(folder, 'neuralwatt', 'zai-org/GLM-5-FP8');
    const content = fs.readFileSync(envPath, 'utf-8');
    expect(content).not.toContain('NANOCLAW_BACKEND');
    expect(content).not.toContain('NANOCLAW_MODEL');
    expect(content).toContain('WORKER_REPOS=foo');
  });

  it('preserves other env vars when stripping backend', () => {
    fs.writeFileSync(
      envPath,
      'NANOCLAW_BACKEND=anthropic\nNANOCLAW_MODEL=sonnet\nOTHER=val',
    );
    updateWorkerEnvBackend(folder, 'anthropic');
    const content = fs.readFileSync(envPath, 'utf-8');
    expect(content).not.toContain('NANOCLAW_BACKEND');
    expect(content).not.toContain('NANOCLAW_MODEL');
    expect(content).toContain('OTHER=val');
  });

  it('is a no-op when worker.env does not exist', () => {
    // No file created — should not throw
    updateWorkerEnvBackend(folder, 'neuralwatt', 'zai-org/GLM-5-FP8');
    expect(fs.existsSync(envPath)).toBe(false);
  });
});
