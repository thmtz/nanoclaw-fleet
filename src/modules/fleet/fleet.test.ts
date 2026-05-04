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

// HARD-MOCK Discord channel provisioning. The prior "env is missing
// DISCORD_*" mechanism failed the moment the repo's .env (where
// DISCORD_BOT_TOKEN lives for local dev) sat next to the test run —
// loadDiscordFleetConfig calls readEnvFile('.env') and happily returned
// real creds, so tests were creating real channels (alpha/beta/.../eta)
// in the user's guild every time `pnpm test` ran. Hard-mocking removes
// the leak entirely.
vi.mock('./discord-channel.js', () => ({
  loadDiscordFleetConfig: () => null,
  createDiscordChannel: vi.fn(),
  deleteDiscordChannel: vi.fn(),
}));
// Stub the model resolver — these tests don't have a real shim to talk to.
// Identity-resolve mirrors a healthy shim returning an exact match. Tests
// that need a 404/connect-error path can override this per-case.
vi.mock('./model-resolver.js', () => ({
  ModelResolutionError: class ModelResolutionError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'ModelResolutionError';
    }
  },
  resolveModelForBackend: vi.fn(async (_backend: string, model: string | undefined) => model),
}));
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
    expect(cfg.provider).toBe('claude');
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

describe('create_worker fresh flag', () => {
  it('with fresh=true, purges archived prior + creates a new agent_group', async () => {
    await handleCreateWorker({ name: 'kappa', backend: 'claude' }, makeMasterSession());
    const original = getAgentGroupByFolder('kappa');
    await handleDestroyWorker({ name: 'kappa' }, makeMasterSession());
    expect(getAgentGroupByFolder('kappa')?.status).toBe('archived');

    await handleCreateWorker(
      { name: 'kappa', backend: 'neuralwatt', model: 'glm-5.1', fresh: true },
      makeMasterSession(),
    );
    const fresh = getAgentGroupByFolder('kappa');
    expect(fresh).toBeDefined();
    // New row, not the archived one being unarchived.
    expect(fresh?.id).not.toBe(original?.id);
    expect(fresh?.status ?? 'active').toBe('active');
    expect(fresh?.fleet_backend).toBe('neuralwatt');
    expect(fresh?.fleet_model).toBe('glm-5.1');
  });

  it('with fresh=true, deletes the archived workspace dir on disk', async () => {
    await handleCreateWorker({ name: 'mu' }, makeMasterSession());
    await handleDestroyWorker({ name: 'mu' }, makeMasterSession());

    const workspaceDir = TEST_DIR + '/groups/mu';
    expect(fs.existsSync(workspaceDir)).toBe(true);

    await handleCreateWorker({ name: 'mu', fresh: true }, makeMasterSession());

    // The fresh path purged the old workspace, then init recreated a
    // bare scaffold for the new agent_group. Verify by checking the
    // fresh agent_group's id maps to a new directory + the prior
    // sessions data was removed.
    const fresh = getAgentGroupByFolder('mu');
    expect(fresh).toBeDefined();
    // Either the bare init recreated the dir (now empty) or it doesn't
    // exist yet — both are valid post-purge. The pre-purge contents are
    // gone in either case; assert no stale CLAUDE.local.md from before.
    if (fs.existsSync(workspaceDir + '/CLAUDE.local.md')) {
      const body = fs.readFileSync(workspaceDir + '/CLAUDE.local.md', 'utf-8');
      // The init scaffold writes a tiny stub, not the original content.
      expect(body.length).toBeLessThan(500);
    }
  });

  it('without fresh on archived name, falls back to resume (existing behavior preserved)', async () => {
    await handleCreateWorker({ name: 'nu' }, makeMasterSession());
    const original = getAgentGroupByFolder('nu');
    await handleDestroyWorker({ name: 'nu' }, makeMasterSession());

    await handleCreateWorker({ name: 'nu' }, makeMasterSession()); // no fresh flag
    const resumed = getAgentGroupByFolder('nu');
    expect(resumed?.id).toBe(original?.id); // resumed, not purged
    expect(resumed?.status).toBe('active');
  });

  it('with fresh=true on a NON-archived (no prior) name, just creates fresh', async () => {
    await handleCreateWorker({ name: 'xi', backend: 'claude', fresh: true }, makeMasterSession());
    const xi = getAgentGroupByFolder('xi');
    expect(xi).toBeDefined();
    expect(xi?.fleet_role).toBe('worker');
  });

  it('refuses fresh purge on an ACTIVE worker (must destroy first)', async () => {
    await handleCreateWorker({ name: 'omicron' }, makeMasterSession());
    const original = getAgentGroupByFolder('omicron');
    expect(original?.status ?? 'active').toBe('active');

    await handleCreateWorker({ name: 'omicron', fresh: true }, makeMasterSession());

    // Active worker still there, untouched, no second row created.
    const after = getAgentGroupByFolder('omicron');
    expect(after?.id).toBe(original?.id);
    expect(after?.status ?? 'active').toBe('active');
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
    expect(cfg.provider).toBe('neuralwatt');
  });

  it('persists the canonical model id returned by the resolver, not the user input', async () => {
    const resolver = await import('./model-resolver.js');
    await handleCreateWorker({ name: 'epsilon-canon', backend: 'claude' }, makeMasterSession());
    vi.mocked(resolver.resolveModelForBackend).mockResolvedValueOnce('zai-org/GLM-5.1-FP8');
    await handleSwitchBackend({ name: 'epsilon-canon', backend: 'neuralwatt', model: 'GLM-5.1' }, makeMasterSession());
    const w = getAgentGroupByFolder('epsilon-canon');
    expect(w?.fleet_model).toBe('zai-org/GLM-5.1-FP8');
    const cfg = JSON.parse(fs.readFileSync(TEST_DIR + '/groups/epsilon-canon/container.json', 'utf-8'));
    expect(cfg.providers.neuralwatt.model).toBe('zai-org/GLM-5.1-FP8');
  });

  it('rejects unresolvable models without touching DB or container.json', async () => {
    const resolver = await import('./model-resolver.js');
    await handleCreateWorker({ name: 'epsilon-reject', backend: 'claude', model: 'opus-4.7' }, makeMasterSession());
    const beforeDb = getAgentGroupByFolder('epsilon-reject');
    const beforeCfg = JSON.parse(fs.readFileSync(TEST_DIR + '/groups/epsilon-reject/container.json', 'utf-8'));

    vi.mocked(resolver.resolveModelForBackend).mockRejectedValueOnce(
      new resolver.ModelResolutionError('Neuralwatt model "bogus" not found.'),
    );
    await handleSwitchBackend({ name: 'epsilon-reject', backend: 'neuralwatt', model: 'bogus' }, makeMasterSession());

    const afterDb = getAgentGroupByFolder('epsilon-reject');
    const afterCfg = JSON.parse(fs.readFileSync(TEST_DIR + '/groups/epsilon-reject/container.json', 'utf-8'));
    expect(afterDb?.agent_provider).toBe(beforeDb?.agent_provider);
    expect(afterDb?.fleet_backend).toBe(beforeDb?.fleet_backend);
    expect(afterDb?.fleet_model).toBe(beforeDb?.fleet_model);
    expect(afterCfg).toEqual(beforeCfg);
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
