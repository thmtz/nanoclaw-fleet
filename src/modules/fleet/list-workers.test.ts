/**
 * Pure formatter tests for the fleet dashboard. The DB-backed
 * `getFleetSummary()` is exercised by `fleet.test.ts`; this file covers
 * `formatFleetSummary()` against hand-built `FleetSummary` fixtures.
 */
import { describe, it, expect } from 'vitest';

import { formatFleetSummary, type FleetSummary } from './list-workers.js';

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
