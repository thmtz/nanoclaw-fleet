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

  // Regression: switch_backend only updated worker-backends.json but not
  // worker.env, so container-runner routed to the wrong proxy on next spawn.
  it('adds NANOCLAW_BACKEND when switching to neuralwatt', () => {
    fs.writeFileSync(envPath, 'WORKER_REPOS=foo\nNANOCLAW_MODEL=opus');
    updateWorkerEnvBackend(folder, 'neuralwatt');
    const content = fs.readFileSync(envPath, 'utf-8');
    expect(content).toContain('NANOCLAW_BACKEND=neuralwatt');
    expect(content).toContain('WORKER_REPOS=foo');
  });

  it('removes NANOCLAW_BACKEND when switching to anthropic', () => {
    fs.writeFileSync(
      envPath,
      'WORKER_REPOS=foo\nNANOCLAW_BACKEND=neuralwatt\nNANOCLAW_MODEL=opus',
    );
    updateWorkerEnvBackend(folder, 'anthropic');
    const content = fs.readFileSync(envPath, 'utf-8');
    expect(content).not.toContain('NANOCLAW_BACKEND');
    expect(content).toContain('WORKER_REPOS=foo');
  });

  it('replaces existing NANOCLAW_BACKEND (no duplicates)', () => {
    fs.writeFileSync(envPath, 'NANOCLAW_BACKEND=anthropic\nOTHER=val');
    updateWorkerEnvBackend(folder, 'neuralwatt');
    const content = fs.readFileSync(envPath, 'utf-8');
    const matches = content.match(/NANOCLAW_BACKEND/g);
    expect(matches).toHaveLength(1);
    expect(content).toContain('NANOCLAW_BACKEND=neuralwatt');
  });

  it('is a no-op when worker.env does not exist', () => {
    // No file created — should not throw
    updateWorkerEnvBackend(folder, 'neuralwatt');
    expect(fs.existsSync(envPath)).toBe(false);
  });
});
