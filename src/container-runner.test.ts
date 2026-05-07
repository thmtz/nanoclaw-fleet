/**
 * Unit tests for container-runner helpers.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { pickOauthToken, precreateNestedMountTargets, readContainerCredentials } from './container-runner.js';

// readContainerCredentials reads `~/.config/nanoclaw/config.json`. Patch
// HOME to a temp dir so tests don't touch the real user config.
const TEST_HOME = '/tmp/nanoclaw-container-runner-test';
const CONFIG_DIR = path.join(TEST_HOME, '.config', 'nanoclaw');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
let originalHome: string | undefined;

function setConfig(content: unknown): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(content));
}

beforeEach(() => {
  originalHome = process.env.HOME;
  process.env.HOME = TEST_HOME;
  if (fs.existsSync(TEST_HOME)) fs.rmSync(TEST_HOME, { recursive: true });
  fs.mkdirSync(TEST_HOME, { recursive: true });
});

afterEach(() => {
  process.env.HOME = originalHome;
  if (fs.existsSync(TEST_HOME)) fs.rmSync(TEST_HOME, { recursive: true });
});

describe('pickOauthToken', () => {
  it('prefers .env over credentials.json when both are set', () => {
    expect(pickOauthToken({ envToken: 'long-lived-env', liveToken: 'short-lived-live' })).toEqual({
      token: 'long-lived-env',
      source: '.env',
    });
  });

  it('falls back to credentials.json when .env is empty', () => {
    expect(pickOauthToken({ envToken: undefined, liveToken: 'short-lived-live' })).toEqual({
      token: 'short-lived-live',
      source: 'credentials.json',
    });
  });

  it('returns none when neither is set', () => {
    expect(pickOauthToken({ envToken: undefined, liveToken: undefined })).toEqual({
      token: undefined,
      source: 'none',
    });
  });

  it('treats empty string .env token as unset (so we still try credentials.json)', () => {
    expect(pickOauthToken({ envToken: '', liveToken: 'short-lived-live' })).toEqual({
      token: 'short-lived-live',
      source: 'credentials.json',
    });
  });
});

describe('readContainerCredentials', () => {
  it('returns [] when config.json is missing', () => {
    expect(readContainerCredentials()).toEqual([]);
  });

  it('returns [] when container_credentials field is absent', () => {
    setConfig({ include_files: ['~/foo.md'] });
    expect(readContainerCredentials()).toEqual([]);
  });

  it('returns the configured entries', () => {
    setConfig({
      container_credentials: [
        { env: 'BETTERSTACK_API_TOKEN', path: '~/.config/betterstack/api_key' },
        { env: 'FIREWORKS_API_KEY', path: '/abs/path/fireworks' },
      ],
    });
    expect(readContainerCredentials()).toEqual([
      { env: 'BETTERSTACK_API_TOKEN', path: '~/.config/betterstack/api_key' },
      { env: 'FIREWORKS_API_KEY', path: '/abs/path/fireworks' },
    ]);
  });

  it('skips entries missing env or path (does not throw)', () => {
    setConfig({
      container_credentials: [{ env: 'GOOD', path: '/x' }, { env: 'no_path' }, { path: '/no-env' }, null],
    });
    expect(readContainerCredentials()).toEqual([{ env: 'GOOD', path: '/x' }]);
  });

  it('returns [] on malformed JSON without throwing', () => {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, '{not json');
    expect(readContainerCredentials()).toEqual([]);
  });
});

describe('precreateNestedMountTargets', () => {
  // Regression: create_worker --fresh failed with EACCES on rmdir of
  // <sessdir>/extra/<name> because Docker's runc had created those mount
  // targets as root. Pre-creating them as the host user keeps ownership
  // correct so purgeArchivedWorker can clean up.
  let sessDir: string;
  let hostSrcDir: string;

  beforeEach(() => {
    sessDir = path.join(TEST_HOME, 'sessions', 'sess-test');
    hostSrcDir = path.join(TEST_HOME, 'host-src');
    fs.mkdirSync(sessDir, { recursive: true });
    fs.mkdirSync(hostSrcDir, { recursive: true });
  });

  it('creates host-side mount-points for /workspace/extra/<name> mounts', () => {
    precreateNestedMountTargets(
      [{ hostPath: hostSrcDir, containerPath: '/workspace/extra/discord', readonly: false }],
      sessDir,
    );
    expect(fs.existsSync(path.join(sessDir, 'extra', 'discord'))).toBe(true);
  });

  it('creates host-side mount-points for /workspace/agent', () => {
    precreateNestedMountTargets(
      [{ hostPath: hostSrcDir, containerPath: '/workspace/agent', readonly: false }],
      sessDir,
    );
    expect(fs.existsSync(path.join(sessDir, 'agent'))).toBe(true);
  });

  it('skips the /workspace mount itself (it is the session dir)', () => {
    precreateNestedMountTargets([{ hostPath: hostSrcDir, containerPath: '/workspace', readonly: false }], sessDir);
    // The function must not create something silly like <sessDir>/<empty>.
    expect(fs.readdirSync(sessDir)).toEqual([]);
  });

  it('skips file mounts (only dirs need a pre-created mount-point)', () => {
    const hostFile = path.join(TEST_HOME, 'somefile.json');
    fs.writeFileSync(hostFile, '{}');
    precreateNestedMountTargets(
      [{ hostPath: hostFile, containerPath: '/workspace/agent/container.json', readonly: true }],
      sessDir,
    );
    expect(fs.existsSync(path.join(sessDir, 'agent'))).toBe(false);
  });

  it('skips mounts whose hostPath does not exist', () => {
    precreateNestedMountTargets(
      [{ hostPath: path.join(TEST_HOME, 'missing'), containerPath: '/workspace/extra/missing', readonly: false }],
      sessDir,
    );
    expect(fs.existsSync(path.join(sessDir, 'extra'))).toBe(false);
  });

  it('skips mounts outside /workspace/', () => {
    precreateNestedMountTargets(
      [{ hostPath: hostSrcDir, containerPath: '/home/node/.claude', readonly: false }],
      sessDir,
    );
    expect(fs.readdirSync(sessDir)).toEqual([]);
  });

  it('is idempotent (safe to call when target already exists)', () => {
    fs.mkdirSync(path.join(sessDir, 'extra', 'discord'), { recursive: true });
    expect(() =>
      precreateNestedMountTargets(
        [{ hostPath: hostSrcDir, containerPath: '/workspace/extra/discord', readonly: false }],
        sessDir,
      ),
    ).not.toThrow();
  });

  it('tolerates EACCES on a root-owned parent dir (legacy sessions)', () => {
    // Simulate a legacy session: <sessDir>/agent exists but is unwritable.
    // The new precreate must not throw — it should log and continue so the
    // host doesn't crash on every wake of an old session.
    const legacyParent = path.join(sessDir, 'agent');
    fs.mkdirSync(legacyParent, { recursive: true });
    fs.chmodSync(legacyParent, 0o555); // read+exec, no write
    try {
      expect(() =>
        precreateNestedMountTargets(
          [{ hostPath: hostSrcDir, containerPath: '/workspace/agent/.claude-fragments', readonly: false }],
          sessDir,
        ),
      ).not.toThrow();
      // The intermediate dir didn't get the new sub-target — Docker will create it.
      expect(fs.existsSync(path.join(legacyParent, '.claude-fragments'))).toBe(false);
    } finally {
      fs.chmodSync(legacyParent, 0o755); // restore for cleanup
    }
  });
});
