import { describe, it, expect, vi, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

// Mock config
vi.mock('./config.js', () => ({
  MOUNT_ALLOWLIST_PATH: '/tmp/nanoclaw-test-allowlist.json',
}));

// Silence logger
vi.mock('pino', () => ({
  default: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Create temp directories that tests can use regardless of host filesystem
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-mount-test-'));
const tmpSsh = path.join(tmpRoot, '.ssh');
const tmpGnupg = path.join(tmpRoot, '.gnupg');
const tmpProjects = path.join(tmpRoot, 'projects');
const tmpEnvDir = path.join(tmpRoot, '.environment');
fs.mkdirSync(tmpSsh);
fs.mkdirSync(tmpGnupg);
fs.mkdirSync(tmpProjects);
fs.mkdirSync(tmpEnvDir);

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  try {
    fs.unlinkSync('/tmp/nanoclaw-test-allowlist.json');
  } catch {}
});

// We need to import after mocks are set up
const { validateMount } = await import('./mount-security.js');

// Write a test allowlist before each test
function writeAllowlist(allowlist: object) {
  fs.writeFileSync(
    '/tmp/nanoclaw-test-allowlist.json',
    JSON.stringify(allowlist),
  );
}

// Reset the cached allowlist between tests
async function resetCache() {
  vi.resetModules();
  const mod = await import('./mount-security.js');
  return mod;
}

describe('mount-security', () => {
  describe('blocked patterns', () => {
    it('blocks .ssh when not in allowedRoots', async () => {
      const { validateMount } = await resetCache();
      writeAllowlist({
        allowedRoots: [
          { path: tmpProjects, allowReadWrite: true, description: 'test' },
        ],
        blockedPatterns: [],
        nonMainReadOnly: false,
      });

      const result = validateMount(
        { hostPath: tmpSsh, containerPath: 'ssh', readonly: true },
        false,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('blocked pattern');
    });

    it('uses exact component matching, not substring', async () => {
      const { validateMount } = await resetCache();
      writeAllowlist({
        allowedRoots: [{ path: tmpEnvDir, allowReadWrite: true }],
        blockedPatterns: [],
        nonMainReadOnly: false,
      });

      // ".environment" should NOT be blocked by ".env" pattern
      // because we use exact match, not substring
      const result = validateMount(
        {
          hostPath: tmpEnvDir,
          containerPath: 'env',
          readonly: true,
        },
        false,
      );
      expect(result.allowed).toBe(true);
    });

    it('blocks exact .gnupg component when not in allowedRoots', async () => {
      const { validateMount } = await resetCache();
      writeAllowlist({
        allowedRoots: [
          { path: tmpProjects, allowReadWrite: true, description: 'test' },
        ],
        blockedPatterns: [],
        nonMainReadOnly: false,
      });

      const result = validateMount(
        { hostPath: tmpGnupg, containerPath: 'gnupg', readonly: true },
        false,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('.gnupg');
    });
  });

  describe('allowedRoots override', () => {
    it('allows blocked paths when explicitly in allowedRoots', async () => {
      const { validateMount } = await resetCache();
      writeAllowlist({
        allowedRoots: [
          {
            path: tmpSsh,
            allowReadWrite: false,
            description: 'SSH keys',
          },
        ],
        blockedPatterns: [],
        nonMainReadOnly: false,
      });

      const result = validateMount(
        { hostPath: tmpSsh, containerPath: 'host-ssh', readonly: true },
        false,
      );
      expect(result.allowed).toBe(true);
    });

    it('rejects paths not in allowedRoots even without blocked pattern match', async () => {
      const { validateMount } = await resetCache();
      writeAllowlist({
        allowedRoots: [
          { path: tmpProjects, allowReadWrite: true, description: 'test' },
        ],
        blockedPatterns: [],
        nonMainReadOnly: false,
      });

      const result = validateMount(
        {
          hostPath: '/etc/hostname',
          containerPath: 'hostname',
          readonly: true,
        },
        false,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('not under any allowed root');
    });
  });

  describe('readonly enforcement', () => {
    it('forces read-only when allowReadWrite is false', async () => {
      const { validateMount } = await resetCache();
      writeAllowlist({
        allowedRoots: [
          {
            path: tmpSsh,
            allowReadWrite: false,
            description: 'SSH keys',
          },
        ],
        blockedPatterns: [],
        nonMainReadOnly: false,
      });

      const result = validateMount(
        { hostPath: tmpSsh, containerPath: 'host-ssh', readonly: false },
        false,
      );
      expect(result.allowed).toBe(true);
      expect(result.effectiveReadonly).toBe(true);
    });
  });
});
