import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { resolveCompactWindow } from './compact-window.js';

let tmpDir: string;
let limitsPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-window-'));
  limitsPath = path.join(tmpDir, 'model-limits.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('resolveCompactWindow', () => {
  it('uses the explicit override when provided', () => {
    const result = resolveCompactWindow('claude-opus-4-7', { override: 500_000 });
    expect(result).toBe(500_000);
  });

  it('returns 85% of context for known Claude models (1M-context Opus/Sonnet)', () => {
    expect(resolveCompactWindow('claude-opus-4-7')).toBe(850_000);
    expect(resolveCompactWindow('claude-sonnet-4-6')).toBe(850_000);
  });

  it('returns 85% of context for Claude Haiku (200k)', () => {
    expect(resolveCompactWindow('claude-haiku-4-5')).toBe(170_000);
  });

  it('reads Neuralwatt limits from the cache file', () => {
    fs.writeFileSync(limitsPath, JSON.stringify({ 'Qwen/Qwen3.6-35B-A3B': 131072, 'moonshotai/Kimi-K2.6': 262144 }));
    expect(resolveCompactWindow('Qwen/Qwen3.6-35B-A3B', { limitsPath })).toBe(Math.floor(131072 * 0.85));
    expect(resolveCompactWindow('moonshotai/Kimi-K2.6', { limitsPath })).toBe(Math.floor(262144 * 0.85));
  });

  it('falls back when model is unknown to both maps', () => {
    fs.writeFileSync(limitsPath, JSON.stringify({ 'known-model': 100_000 }));
    expect(resolveCompactWindow('unknown-model', { limitsPath })).toBe(165_000);
  });

  it('falls back when model is undefined', () => {
    expect(resolveCompactWindow(undefined)).toBe(165_000);
  });

  it('honors custom fallback', () => {
    expect(resolveCompactWindow('unknown', { limitsPath, fallback: 99_999 })).toBe(99_999);
  });

  it('survives missing limits cache file', () => {
    expect(resolveCompactWindow('unknown', { limitsPath: '/nonexistent/path.json' })).toBe(165_000);
  });

  it('survives malformed limits cache file', () => {
    fs.writeFileSync(limitsPath, 'not json');
    expect(resolveCompactWindow('unknown', { limitsPath })).toBe(165_000);
  });
});
