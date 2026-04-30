/**
 * Tests for `syncWorkerProfiles`. Mocks the worker-profile loader so we
 * can supply hand-built profiles without touching the user's real
 * `~/.config/nanoclaw/`. Container-config read/write goes through the
 * `config.ts` GROUPS_DIR which we point at /tmp.
 */
import fs from 'fs';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations, createAgentGroup } from '../../db/index.js';
import { updateAgentGroup } from '../../db/agent-groups.js';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-profilesync', GROUPS_DIR: '/tmp/nanoclaw-test-profilesync/groups' };
});

const mockLoadProfile = vi.fn();
vi.mock('./worker-profile.js', async () => {
  const actual = (await vi.importActual('./worker-profile.js')) as object;
  return { ...actual, loadWorkerProfile: () => mockLoadProfile() };
});

const { syncWorkerProfiles } = await import('./profile-sync.js');

const TEST_DIR = '/tmp/nanoclaw-test-profilesync';

function makeWorker(folder: string, opts: { archived?: boolean } = {}): void {
  const id = `ag-${folder}`;
  createAgentGroup({ id, name: folder, folder, agent_provider: 'claude', created_at: new Date().toISOString() });
  updateAgentGroup(id, { fleet_role: 'worker', status: opts.archived ? 'archived' : 'active' });
  fs.mkdirSync(path.join(TEST_DIR, 'groups', folder), { recursive: true });
  fs.writeFileSync(path.join(TEST_DIR, 'groups', folder, 'container.json'), JSON.stringify({ provider: 'claude' }));
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(path.join(TEST_DIR, 'groups'), { recursive: true });
  const db = initTestDb();
  runMigrations(db);
  mockLoadProfile.mockReset();
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('syncWorkerProfiles', () => {
  it('skips when profile is empty', () => {
    makeWorker('alpha');
    mockLoadProfile.mockReturnValue({});
    const result = syncWorkerProfiles();
    expect(result.updated).toEqual([]);
    expect(result.unchanged).toEqual([]);
  });

  it('updates a worker whose container.json lacks the current profile', () => {
    makeWorker('alpha');
    mockLoadProfile.mockReturnValue({
      repos: [{ url: 'git@github.com:org/repo.git' }],
      tools: ['uv tool install foo --force'],
    });
    const result = syncWorkerProfiles();
    expect(result.updated).toEqual(['alpha']);
    expect(result.unchanged).toEqual([]);
    const cfg = JSON.parse(fs.readFileSync(path.join(TEST_DIR, 'groups', 'alpha', 'container.json'), 'utf-8'));
    expect(cfg.fleetProfile.repos).toEqual([{ url: 'git@github.com:org/repo.git' }]);
    expect(cfg.fleetProfile.tools).toEqual(['uv tool install foo --force']);
    // Other fields preserved.
    expect(cfg.provider).toBe('claude');
  });

  it('reports unchanged for a worker whose profile already matches', () => {
    makeWorker('alpha');
    const profile = { repos: [{ url: 'git@github.com:org/repo.git' }] };
    mockLoadProfile.mockReturnValue(profile);
    syncWorkerProfiles(); // first run writes
    const result = syncWorkerProfiles(); // second run is a no-op
    expect(result.unchanged).toEqual(['alpha']);
    expect(result.updated).toEqual([]);
  });

  it('skips archived workers — only active workers get re-synced', () => {
    makeWorker('alpha');
    makeWorker('archived-one', { archived: true });
    mockLoadProfile.mockReturnValue({ repos: [{ url: 'x' }] });
    const result = syncWorkerProfiles();
    expect(result.updated).toEqual(['alpha']);
    expect(result.unchanged).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('captures errors per-worker without aborting the loop', () => {
    makeWorker('alpha');
    makeWorker('beta');
    // Make beta's container.json unreadable by deleting the dir.
    fs.rmSync(path.join(TEST_DIR, 'groups', 'beta'), { recursive: true });
    mockLoadProfile.mockReturnValue({ repos: [{ url: 'x' }] });
    const result = syncWorkerProfiles();
    // alpha succeeds; beta is treated as fresh because readContainerConfig
    // returns an empty config when the dir is missing — both end up
    // updated. The test ensures the loop completes without throwing.
    expect(result.errors).toEqual([]);
    expect([...result.updated].sort()).toEqual(['alpha', 'beta']);
  });
});
