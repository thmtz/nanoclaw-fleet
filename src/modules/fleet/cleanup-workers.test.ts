/**
 * Unit tests for the cleanup_workers handler. Mirrors fleet.test.ts patterns:
 * Discord REST + child_process are hard-mocked, central DB is in-memory.
 */
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  initTestDb,
  closeDb,
  runMigrations,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
} from '../../db/index.js';
import { updateAgentGroup } from '../../db/agent-groups.js';
import type { Session } from '../../types.js';

// Stub out wakeContainer / killContainer so notifyAgent doesn't try to
// hit a real container during the master notification path.
vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  killContainer: vi.fn(),
  isContainerRunning: vi.fn().mockReturnValue(false),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-cleanup', GROUPS_DIR: '/tmp/nanoclaw-test-cleanup/groups' };
});

vi.mock('../../session-manager.js', async () => {
  const actual = await vi.importActual('../../session-manager.js');
  return { ...actual, writeSessionMessage: vi.fn() };
});

// Discord REST: configurable per test via the mocked listDiscordChannels.
const mockListDiscordChannels = vi.fn();
const mockDeleteDiscordChannel = vi.fn();
vi.mock('./discord-channel.js', () => ({
  loadDiscordFleetConfig: () => ({ botToken: 'test-token', guildId: 'test-guild' }),
  createDiscordChannel: vi.fn(),
  deleteDiscordChannel: mockDeleteDiscordChannel,
  listDiscordChannels: mockListDiscordChannels,
}));

// child_process: control docker ps output and capture rm -f calls.
const mockExecSync = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

const { handleCleanupWorkers, runCleanup } = await import('./cleanup-workers.js');

const TEST_DIR = '/tmp/nanoclaw-test-cleanup';

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

function makeWorker(id: string, folder: string, opts: { archived?: boolean } = {}): void {
  createAgentGroup({
    id,
    name: folder,
    folder,
    agent_provider: 'claude',
    created_at: now(),
  });
  updateAgentGroup(id, { fleet_role: 'worker', status: opts.archived ? 'archived' : 'active' });
}

function wireDiscordChannel(workerId: string, channelId: string): void {
  const mgId = `mg-${workerId}`;
  createMessagingGroup({
    id: mgId,
    channel_type: 'discord',
    platform_id: `discord:${channelId}`,
    name: 'test',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  createMessagingGroupAgent({
    id: `mga-${workerId}`,
    messaging_group_id: mgId,
    agent_group_id: workerId,
    engage_mode: 'pattern',
    engage_pattern: null,
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now(),
  });
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

  // Default docker ps: nothing running.
  mockExecSync.mockReturnValue('');
  mockListDiscordChannels.mockResolvedValue([]);
  mockDeleteDiscordChannel.mockResolvedValue(undefined);
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  vi.clearAllMocks();
});

describe('cleanup_workers', () => {
  it('reports nothing when state is consistent', async () => {
    makeWorker('ag-alpha', 'alpha');
    wireDiscordChannel('ag-alpha', 'chan-alpha');
    mockListDiscordChannels.mockResolvedValue([{ id: 'chan-alpha', name: 'worker-alpha', type: 0, parent_id: null }]);

    const report = await runCleanup({ dryRun: false });
    expect(report.orphanChannels).toEqual([]);
    expect(report.orphanWorkers).toEqual([]);
    expect(report.orphanContainers).toEqual([]);
    expect(report.errors).toEqual([]);
  });

  it('detects + deletes orphan Discord channels', async () => {
    makeWorker('ag-alpha', 'alpha');
    wireDiscordChannel('ag-alpha', 'chan-alpha');
    mockListDiscordChannels.mockResolvedValue([
      { id: 'chan-alpha', name: 'worker-alpha', type: 0, parent_id: null },
      { id: 'chan-orphan', name: 'worker-ghost', type: 0, parent_id: null },
    ]);

    const report = await runCleanup({ dryRun: false });
    expect(report.orphanChannels).toEqual([{ id: 'chan-orphan', name: 'worker-ghost' }]);
    expect(mockDeleteDiscordChannel).toHaveBeenCalledWith(expect.anything(), 'chan-orphan');
  });

  it('skips channels that do not match the fleet name prefix', async () => {
    mockListDiscordChannels.mockResolvedValue([
      { id: 'chan-user', name: 'general', type: 0, parent_id: null },
      { id: 'chan-meta', name: 'announcements', type: 0, parent_id: null },
    ]);

    const report = await runCleanup({ dryRun: false });
    expect(report.orphanChannels).toEqual([]);
    expect(mockDeleteDiscordChannel).not.toHaveBeenCalled();
  });

  it('detects orphan workers (active worker, channel missing) and does NOT auto-archive', async () => {
    makeWorker('ag-alpha', 'alpha');
    wireDiscordChannel('ag-alpha', 'chan-alpha');
    mockListDiscordChannels.mockResolvedValue([]); // channel is gone from Discord

    const report = await runCleanup({ dryRun: false });
    expect(report.orphanWorkers).toHaveLength(1);
    expect(report.orphanWorkers[0]).toMatchObject({ name: 'alpha', folder: 'alpha' });
    // NOT auto-archived — master decides.
    const { getAgentGroupByFolder } = await import('../../db/agent-groups.js');
    expect(getAgentGroupByFolder('alpha')?.status).toBe('active');
  });

  it('detects + kills orphan containers', async () => {
    makeWorker('ag-alpha', 'alpha');
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('docker ps')) {
        return 'nanoclaw-v2-alpha-1234567890\nnanoclaw-v2-ghost-9876543210\n';
      }
      return '';
    });

    const report = await runCleanup({ dryRun: false });
    expect(report.orphanContainers).toEqual(['nanoclaw-v2-ghost-9876543210']);
    expect(mockExecSync).toHaveBeenCalledWith(
      'docker rm -f nanoclaw-v2-ghost-9876543210',
      expect.objectContaining({ stdio: expect.any(Array) }),
    );
  });

  it('correctly parses container names with hyphens in the folder', async () => {
    makeWorker('ag-foo', 'foo-bar-baz');
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('docker ps')) return 'nanoclaw-v2-foo-bar-baz-1234567890\n';
      return '';
    });

    const report = await runCleanup({ dryRun: false });
    expect(report.orphanContainers).toEqual([]); // foo-bar-baz is active, not orphan
  });

  it('dry_run does not delete or kill anything', async () => {
    makeWorker('ag-alpha', 'alpha');
    wireDiscordChannel('ag-alpha', 'chan-alpha');
    mockListDiscordChannels.mockResolvedValue([{ id: 'chan-orphan', name: 'worker-ghost', type: 0, parent_id: null }]);
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('docker ps')) return 'nanoclaw-v2-ghost-9876543210\n';
      return '';
    });

    const report = await runCleanup({ dryRun: true });
    expect(report.orphanChannels).toHaveLength(1);
    expect(report.orphanContainers).toEqual(['nanoclaw-v2-ghost-9876543210']);
    expect(mockDeleteDiscordChannel).not.toHaveBeenCalled();
    // Should not have called `docker rm -f`.
    const rmCalls = mockExecSync.mock.calls.filter((c) => String(c[0]).startsWith('docker rm'));
    expect(rmCalls).toHaveLength(0);
  });

  it('rejects non-master callers via handleCleanupWorkers', async () => {
    updateAgentGroup('ag-master', { fleet_role: null });
    await handleCleanupWorkers({}, makeMasterSession()); // master role is gone
    // No throw, just no work — runCleanup wasn't called.
    expect(mockListDiscordChannels).not.toHaveBeenCalled();
  });
});
