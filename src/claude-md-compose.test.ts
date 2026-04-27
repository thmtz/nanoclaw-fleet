import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { composeGroupClaudeMd } from './claude-md-compose.js';
import { GROUPS_DIR } from './config.js';
import { initContainerConfig } from './container-config.js';
import type { AgentGroup } from './types.js';

// Compose runs against the real GROUPS_DIR + the real
// container/agent-runner/src/mcp-tools/ checkout. Tests use a folder
// name unlikely to collide with a live install and clean up after.
const TEST_FOLDER = '__compose_test_fixture__';

const fixtureGroup: AgentGroup = {
  id: 'ag-test',
  name: 'compose-test',
  folder: TEST_FOLDER,
  agent_provider: 'claude',
  created_at: new Date().toISOString(),
  status: 'active',
  fleet_role: 'worker',
};

const groupDir = path.join(GROUPS_DIR, TEST_FOLDER);

function cleanup(): void {
  if (fs.existsSync(groupDir)) {
    fs.rmSync(groupDir, { recursive: true, force: true });
  }
}

describe('composeGroupClaudeMd', () => {
  beforeEach(() => {
    cleanup();
    fs.mkdirSync(groupDir, { recursive: true });
    initContainerConfig(TEST_FOLDER);
  });

  afterEach(cleanup);

  it('creates a fragment for every *.instructions.md in mcp-tools', () => {
    const mcpToolsDir = path.join(process.cwd(), 'container', 'agent-runner', 'src', 'mcp-tools');
    const expectedModules = fs
      .readdirSync(mcpToolsDir)
      .filter((f) => f.endsWith('.instructions.md'))
      .map((f) => `module-${f.replace(/\.instructions\.md$/, '')}.md`);

    composeGroupClaudeMd(fixtureGroup);

    const fragmentsDir = path.join(groupDir, '.claude-fragments');
    const found = fs.readdirSync(fragmentsDir);
    for (const expected of expectedModules) {
      expect(found).toContain(expected);
    }
  });

  it('symlinks each module fragment to /app/src/mcp-tools/<name>.instructions.md', () => {
    composeGroupClaudeMd(fixtureGroup);

    const fragPath = path.join(groupDir, '.claude-fragments', 'module-core.md');
    const target = fs.readlinkSync(fragPath);
    expect(target).toBe('/app/src/mcp-tools/core.instructions.md');
  });

  it('imports every module fragment from CLAUDE.md', () => {
    composeGroupClaudeMd(fixtureGroup);

    const claudeMd = fs.readFileSync(path.join(groupDir, 'CLAUDE.md'), 'utf-8');
    const fragmentsDir = path.join(groupDir, '.claude-fragments');
    for (const fragment of fs.readdirSync(fragmentsDir)) {
      expect(claudeMd).toContain(`@./.claude-fragments/${fragment}`);
    }
  });

  it('regression: discord-formatting fragment is composed for every agent', () => {
    composeGroupClaudeMd(fixtureGroup);

    const fragPath = path.join(groupDir, '.claude-fragments', 'module-discord-formatting.md');
    // lstat (not existsSync) — fragments are symlinks pointing at container
    // paths (/app/src/...), so existsSync follows the dangling link.
    expect(fs.lstatSync(fragPath).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(fragPath)).toBe('/app/src/mcp-tools/discord-formatting.instructions.md');
  });

  it('creates an empty CLAUDE.local.md if missing', () => {
    composeGroupClaudeMd(fixtureGroup);
    expect(fs.existsSync(path.join(groupDir, 'CLAUDE.local.md'))).toBe(true);
  });

  it('is deterministic — re-running over the same group produces the same fragment set', () => {
    composeGroupClaudeMd(fixtureGroup);
    const first = fs.readdirSync(path.join(groupDir, '.claude-fragments')).sort();

    composeGroupClaudeMd(fixtureGroup);
    const second = fs.readdirSync(path.join(groupDir, '.claude-fragments')).sort();

    expect(second).toEqual(first);
  });

  it('prunes stale fragments when their source is removed', () => {
    composeGroupClaudeMd(fixtureGroup);

    // Plant a fake stale fragment that has no source. Re-run should drop it.
    const stalePath = path.join(groupDir, '.claude-fragments', 'module-no-such-tool.md');
    fs.writeFileSync(stalePath, '# stale');

    composeGroupClaudeMd(fixtureGroup);
    expect(fs.existsSync(stalePath)).toBe(false);
  });
});
