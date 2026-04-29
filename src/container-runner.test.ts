/**
 * Unit tests for container-runner helpers.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { pickOauthToken, readContainerCredentials } from './container-runner.js';

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
