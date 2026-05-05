/**
 * Unit tests for startup-notice. Format helper is a pure function; the
 * "no master" path of postHostStartupNotice is covered by mocking the
 * agent_groups db. The IO-heavy outbound write is left to manual e2e —
 * resource-monitor follows the same convention.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { formatStartupMessage, postHostStartupNotice } from './index.js';

describe('formatStartupMessage', () => {
  const fixedNow = new Date('2026-05-04T19:42:00Z');

  it('includes backend, model, and a formatted timestamp', () => {
    const msg = formatStartupMessage({ backend: 'claude', model: 'claude-opus-4-7' }, fixedNow);
    expect(msg).toContain('🚀 NanoClaw host restarted.');
    expect(msg).toContain('Backend: claude (claude-opus-4-7)');
    expect(msg).toMatch(/Time: \w+ \d+, \d{2}:\d{2}/);
  });

  it('omits the model parens when no model is set', () => {
    const msg = formatStartupMessage({ backend: 'claude', model: null }, fixedNow);
    expect(msg).toContain('Backend: claude\n');
    expect(msg).not.toContain('()');
  });

  it('handles neuralwatt backend with a long model id', () => {
    const msg = formatStartupMessage({ backend: 'neuralwatt', model: 'zai-org/GLM-5.1-FP8' }, fixedNow);
    expect(msg).toContain('Backend: neuralwatt (zai-org/GLM-5.1-FP8)');
  });
});

vi.mock('../../db/agent-groups.js', () => ({
  getActiveAgentGroups: vi.fn(() => []),
}));
vi.mock('../../db/messaging-groups.js', () => ({
  getMessagingGroupsByAgentGroup: vi.fn(() => []),
}));
vi.mock('../../db/sessions.js', () => ({
  getSessionsByAgentGroup: vi.fn(() => []),
}));
vi.mock('../../session-manager.js', () => ({
  openOutboundDb: vi.fn(),
}));

describe('postHostStartupNotice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns cleanly when there is no active master agent group', async () => {
    const { getActiveAgentGroups } = await import('../../db/agent-groups.js');
    const { openOutboundDb } = await import('../../session-manager.js');
    vi.mocked(getActiveAgentGroups).mockReturnValue([]);

    expect(() => postHostStartupNotice()).not.toThrow();
    expect(openOutboundDb).not.toHaveBeenCalled();
  });

  it('skips the write when the master has no session yet', async () => {
    const { getActiveAgentGroups } = await import('../../db/agent-groups.js');
    const { getSessionsByAgentGroup } = await import('../../db/sessions.js');
    const { openOutboundDb } = await import('../../session-manager.js');
    vi.mocked(getActiveAgentGroups).mockReturnValue([
      {
        id: 'ag-master',
        name: 'master',
        folder: 'master',
        agent_provider: 'claude',
        created_at: '2026-01-01T00:00:00Z',
        status: 'active',
        fleet_role: 'master',
        fleet_backend: 'claude',
        fleet_model: 'claude-opus-4-7',
      },
    ]);
    vi.mocked(getSessionsByAgentGroup).mockReturnValue([]);

    expect(() => postHostStartupNotice()).not.toThrow();
    expect(openOutboundDb).not.toHaveBeenCalled();
  });
});
