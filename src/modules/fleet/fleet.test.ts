/**
 * Unit tests for fleet module delivery handlers.
 *
 * Covers create_worker (fresh), create_worker (resume from archive),
 * destroy_worker, switch_backend, list_workers. Discord channel provisioning
 * is mocked — the env is intentionally missing DISCORD_* so the code takes
 * the "no channel" path.
 */
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  initTestDb,
  closeDb,
  runMigrations,
  createAgentGroup,
  getAgentGroup,
  getAgentGroupByFolder,
} from '../../db/index.js';
import { updateAgentGroup } from '../../db/agent-groups.js';
import { getMessagingGroupsByAgentGroup } from '../../db/messaging-groups.js';
import type { Session } from '../../types.js';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  killContainer: vi.fn(),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-fleet', GROUPS_DIR: '/tmp/nanoclaw-test-fleet/groups' };
});

vi.mock('../../session-manager.js', async () => {
  const actual = await vi.importActual('../../session-manager.js');
  return { ...actual, writeSessionMessage: vi.fn() };
});

vi.mock('../agent-to-agent/write-destinations.js', () => ({
  writeDestinations: vi.fn(),
}));

// Import handlers AFTER mocks so they pick up the mocked modules.
const { handleCreateWorker } = await import('./create-worker.js');
const { handleDestroyWorker } = await import('./destroy-worker.js');
const { handleSwitchBackend } = await import('./switch-backend.js');
const { listWorkers } = await import('./list-workers.js');

const TEST_DIR = '/tmp/nanoclaw-test-fleet';

function now(): string {
  return new Date().toISOString();
}

function makeMasterSession(): Session {
  return {
    id: 'sess-master',
    agent_group_id: 'ag-master',
    messaging_group_id: 'mg-master',
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    last_active: now(),
    created_at: now(),
  };
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR + '/groups', { recursive: true });
  const db = initTestDb();
  runMigrations(db);

  createAgentGroup({
    id: 'ag-master',
    name: 'Master',
    folder: 'master',
    agent_provider: 'claude',
    created_at: now(),
  });
  updateAgentGroup('ag-master', { fleet_role: 'master' });

  // Ensure master folder exists so any writeContainerConfig calls can land.
  fs.mkdirSync(TEST_DIR + '/groups/master', { recursive: true });
  fs.writeFileSync(TEST_DIR + '/groups/master/container.json', '{}');
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  vi.clearAllMocks();
});

describe('create_worker', () => {
  it('creates a worker agent_group with fleet metadata', async () => {
    await handleCreateWorker({ name: 'alpha', backend: 'claude', model: 'opus-4.7' }, makeMasterSession());

    const worker = getAgentGroupByFolder('alpha');
    expect(worker).toBeDefined();
    expect(worker?.name).toBe('alpha');
    expect(worker?.fleet_role).toBe('worker');
    expect(worker?.fleet_backend).toBe('claude');
    expect(worker?.fleet_model).toBe('opus-4.7');
    expect(worker?.status ?? 'active').toBe('active');
  });

  it('rejects non-master callers', async () => {
    updateAgentGroup('ag-master', { fleet_role: null });
    await handleCreateWorker({ name: 'alpha' }, makeMasterSession());
    expect(getAgentGroupByFolder('alpha')).toBeUndefined();
  });

  it('rejects duplicate active worker name', async () => {
    await handleCreateWorker({ name: 'alpha' }, makeMasterSession());
    const first = getAgentGroupByFolder('alpha');
    await handleCreateWorker({ name: 'alpha' }, makeMasterSession());
    const second = getAgentGroupByFolder('alpha');
    expect(first?.id).toBe(second?.id); // no new row created
  });

  it('seeds container.json with providers block', async () => {
    await handleCreateWorker({ name: 'alpha', backend: 'claude', model: 'opus-4.7' }, makeMasterSession());
    const cfg = JSON.parse(fs.readFileSync(TEST_DIR + '/groups/alpha/container.json', 'utf-8'));
    expect(cfg.active_provider).toBe('claude');
    expect(cfg.providers.claude.model).toBe('opus-4.7');
  });
});

describe('destroy_worker', () => {
  it('archives the worker instead of deleting', async () => {
    await handleCreateWorker({ name: 'beta' }, makeMasterSession());
    const before = getAgentGroupByFolder('beta');
    expect(before?.status ?? 'active').toBe('active');

    await handleDestroyWorker({ name: 'beta' }, makeMasterSession());
    const after = getAgentGroupByFolder('beta');
    expect(after?.id).toBe(before?.id);
    expect(after?.status).toBe('archived');
  });

  it('is a no-op on an already-archived worker', async () => {
    await handleCreateWorker({ name: 'gamma' }, makeMasterSession());
    await handleDestroyWorker({ name: 'gamma' }, makeMasterSession());
    await handleDestroyWorker({ name: 'gamma' }, makeMasterSession());
    const g = getAgentGroupByFolder('gamma');
    expect(g?.status).toBe('archived');
  });
});

describe('resume from archive', () => {
  it('create_worker on an archived name unarchives instead of creating', async () => {
    await handleCreateWorker({ name: 'delta', backend: 'claude' }, makeMasterSession());
    const original = getAgentGroupByFolder('delta');
    await handleDestroyWorker({ name: 'delta' }, makeMasterSession());
    expect(getAgentGroupByFolder('delta')?.status).toBe('archived');

    await handleCreateWorker({ name: 'delta', backend: 'claude', model: 'haiku-4.5' }, makeMasterSession());
    const resumed = getAgentGroupByFolder('delta');
    expect(resumed?.id).toBe(original?.id);
    expect(resumed?.status).toBe('active');
    expect(resumed?.fleet_model).toBe('haiku-4.5');
  });
});

describe('switch_backend', () => {
  it('updates agent_provider + fleet fields + container.json', async () => {
    await handleCreateWorker({ name: 'epsilon', backend: 'claude' }, makeMasterSession());
    await handleSwitchBackend({ name: 'epsilon', backend: 'neuralwatt', model: 'kimi-k2.5' }, makeMasterSession());
    const w = getAgentGroupByFolder('epsilon');
    expect(w?.agent_provider).toBe('neuralwatt');
    expect(w?.fleet_backend).toBe('neuralwatt');
    expect(w?.fleet_model).toBe('kimi-k2.5');
    const cfg = JSON.parse(fs.readFileSync(TEST_DIR + '/groups/epsilon/container.json', 'utf-8'));
    expect(cfg.active_provider).toBe('neuralwatt');
  });
});

describe('list_workers', () => {
  it('returns only fleet workers, not plain agents or the master', async () => {
    createAgentGroup({
      id: 'ag-plain',
      name: 'plain',
      folder: 'plain',
      agent_provider: null,
      created_at: now(),
    });
    await handleCreateWorker({ name: 'zeta' }, makeMasterSession());
    await handleCreateWorker({ name: 'eta' }, makeMasterSession());
    const list = listWorkers();
    expect(list.map((w) => w.folder).sort()).toEqual(['eta', 'zeta']);
  });

  it('includes archived workers in the list', async () => {
    await handleCreateWorker({ name: 'theta' }, makeMasterSession());
    await handleDestroyWorker({ name: 'theta' }, makeMasterSession());
    const list = listWorkers();
    expect(list.find((w) => w.folder === 'theta')?.status).toBe('archived');
  });
});
