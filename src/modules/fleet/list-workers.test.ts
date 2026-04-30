/**
 * Pure formatter + parser tests. DB-backed `getFleetSummary()` is
 * exercised by `fleet.test.ts`; this file covers `formatFleetSummary()`
 * and `readRunningUptimes()` in isolation.
 */
import { describe, it, expect, vi } from 'vitest';

const mockExecSync = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

const { formatFleetSummary, readRunningUptimes } = await import('./list-workers.js');
type FleetSummary = import('./list-workers.js').FleetSummary;

describe('formatFleetSummary', () => {
  it('renders empty fleet with master line + "no workers" prompt', () => {
    const s: FleetSummary = {
      master: {
        name: 'Master',
        backend: 'claude',
        model: 'claude-opus-4-7',
        container_uptime: '2 hours',
        container_status: 'running',
      },
      workers: [],
    };
    const out = formatFleetSummary(s);
    expect(out).toContain('**Master**');
    expect(out).toContain('claude-opus-4-7');
    expect(out).toContain('up 2 hours');
    expect(out).toContain('No fleet workers');
    expect(out).not.toContain('## 🤖 Workers\n-'); // no bullet list
  });

  it('uses master container_status when uptime is null (e.g. master not running)', () => {
    const s: FleetSummary = {
      master: {
        name: 'Master',
        backend: 'claude',
        model: 'claude-opus-4-7',
        container_uptime: null,
        container_status: 'stopped',
      },
      workers: [],
    };
    expect(formatFleetSummary(s)).toContain('· stopped');
  });

  it('renders running, idle, stopped, archived workers with the right icons', () => {
    const s: FleetSummary = {
      master: null,
      workers: [
        {
          name: 'alpha',
          folder: 'alpha',
          status: 'active',
          backend: 'claude',
          model: 'opus-4-7',
          channels: [],
          container_status: 'running',
          container_uptime: '1 hour',
          last_active: null,
        },
        {
          name: 'beta',
          folder: 'beta',
          status: 'active',
          backend: 'neuralwatt',
          model: 'glm-fast',
          channels: [],
          container_status: 'idle',
          container_uptime: null,
          last_active: null,
        },
        {
          name: 'gamma',
          folder: 'gamma',
          status: 'active',
          backend: 'claude',
          model: null,
          channels: [],
          container_status: 'stopped',
          container_uptime: null,
          last_active: null,
        },
        {
          name: 'delta',
          folder: 'delta',
          status: 'archived',
          backend: 'claude',
          model: null,
          channels: [],
          container_status: 'none',
          container_uptime: null,
          last_active: null,
        },
      ],
    };
    const out = formatFleetSummary(s);
    expect(out).toMatch(/🟢 \*\*alpha\*\* · `opus-4-7` · up 1 hour/);
    expect(out).toMatch(/⚫ \*\*beta\*\* · `glm-fast` · idle/);
    expect(out).toMatch(/⚫ \*\*gamma\*\* · `claude` · stopped/);
    expect(out).toMatch(/🗄️ \*\*delta\*\* · `claude` · archived/);
  });

  it('summary footer counts running vs active vs archived correctly', () => {
    const s: FleetSummary = {
      master: null,
      workers: [
        {
          name: 'a',
          folder: 'a',
          status: 'active',
          backend: 'c',
          model: null,
          channels: [],
          container_status: 'running',
          container_uptime: '1h',
          last_active: null,
        },
        {
          name: 'b',
          folder: 'b',
          status: 'active',
          backend: 'c',
          model: null,
          channels: [],
          container_status: 'stopped',
          container_uptime: null,
          last_active: null,
        },
        {
          name: 'c',
          folder: 'c',
          status: 'archived',
          backend: 'c',
          model: null,
          channels: [],
          container_status: 'none',
          container_uptime: null,
          last_active: null,
        },
        {
          name: 'd',
          folder: 'd',
          status: 'archived',
          backend: 'c',
          model: null,
          channels: [],
          container_status: 'none',
          container_uptime: null,
          last_active: null,
        },
      ],
    };
    expect(formatFleetSummary(s)).toMatch(/_1\/2 running · 2 archived_/);
  });

  it('omits master block when master is null', () => {
    const s: FleetSummary = { master: null, workers: [] };
    const out = formatFleetSummary(s);
    expect(out).not.toContain('**Master**');
    expect(out).toContain('No fleet workers');
  });
});

describe('readRunningUptimes', () => {
  it('parses folder→uptime pairs from "Up X" status strings', () => {
    mockExecSync.mockReturnValueOnce(
      ['nanoclaw-v2-alpha-1700000000000|Up 2 hours', 'nanoclaw-v2-beta-bar-1700000001000|Up 5 minutes'].join('\n'),
    );
    const map = readRunningUptimes();
    expect(map.get('alpha')).toBe('2 hours');
    expect(map.get('beta-bar')).toBe('5 minutes');
  });

  it('preserves healthcheck suffixes after stripping "Up "', () => {
    mockExecSync.mockReturnValueOnce('nanoclaw-v2-alpha-1700000000000|Up 2 hours (unhealthy)');
    expect(readRunningUptimes().get('alpha')).toBe('2 hours (unhealthy)');
  });

  it('skips lines that do not match the container-name regex', () => {
    mockExecSync.mockReturnValueOnce(
      [
        'unrelated-container|Up 1 hour',
        'nanoclaw-v1-old-format|Up 1 hour',
        'nanoclaw-v2-good-1700000000000|Up 3 minutes',
      ].join('\n'),
    );
    const map = readRunningUptimes();
    expect(map.size).toBe(1);
    expect(map.get('good')).toBe('3 minutes');
  });

  it('returns empty map when docker fails (e.g., daemon down)', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('Cannot connect to the Docker daemon');
    });
    expect(readRunningUptimes().size).toBe(0);
  });

  it('returns empty map when no containers are running', () => {
    mockExecSync.mockReturnValueOnce('');
    expect(readRunningUptimes().size).toBe(0);
  });
});
