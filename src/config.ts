import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { isValidTimezone } from './timezone.js';

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the credential proxy (credential-proxy.ts), never exposed to containers.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'CONTAINER_IMAGE',
  'CONTAINER_TIMEOUT',
  'CONTAINER_MAX_OUTPUT_SIZE',
  'CREDENTIAL_PROXY_PORT',
  'DISCORD_ALLOWED_BOT_IDS',
  'NEURALWATT_PROXY_PORT',
  'IDLE_TIMEOUT',
  'MAX_CONCURRENT_CONTAINERS',
  'NANOCLAW_ENABLE_DOCKER',
  'NANOCLAW_GITHUB_TOKEN_PATH',
  'ONECLI_URL',
  'STATUS_PIN_INTERVAL',
  'TZ',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE ||
  envConfig.CONTAINER_IMAGE ||
  'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || envConfig.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE ||
    envConfig.CONTAINER_MAX_OUTPUT_SIZE ||
    '10485760',
  10,
); // 10MB default
export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT ||
    envConfig.CREDENTIAL_PROXY_PORT ||
    '3001',
  10,
);
export const NEURALWATT_PROXY_PORT = parseInt(
  process.env.NEURALWATT_PROXY_PORT ||
    envConfig.NEURALWATT_PROXY_PORT ||
    '3003',
  10,
);
export const BACKEND_ANTHROPIC = 'anthropic' as const;
export const BACKEND_NEURALWATT = 'neuralwatt' as const;
export type InferenceBackend =
  | typeof BACKEND_ANTHROPIC
  | typeof BACKEND_NEURALWATT;

// Defaults for new workers + master are resolved at call time via
// src/backend-defaults.ts so .env edits take effect without a service restart.
// Vars: NANOCLAW_DEFAULT_{MASTER,WORKER}_{BACKEND,MODEL}

export const WORKER_BACKENDS_FILENAME = 'worker-backends.json';
export const WORKER_API_KEY_PREFIX = 'sk-ant-worker-';
export const ONECLI_URL = process.env.ONECLI_URL || envConfig.ONECLI_URL;

// Optional: bot IDs that NanoClaw should treat as human users (comma-separated).
// Used for E2E testing with a separate debug bot that sends messages as a "user".
export const DISCORD_ALLOWED_BOT_IDS = new Set(
  (
    process.env.DISCORD_ALLOWED_BOT_IDS ||
    envConfig.DISCORD_ALLOWED_BOT_IDS ||
    ''
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
export const MAX_MESSAGES_PER_PROMPT = Math.max(
  1,
  parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(
  process.env.IDLE_TIMEOUT || envConfig.IDLE_TIMEOUT || '1800000',
  10,
); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(
    process.env.MAX_CONCURRENT_CONTAINERS ||
      envConfig.MAX_CONCURRENT_CONTAINERS ||
      '5',
    10,
  ) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTriggerPattern(trigger: string): RegExp {
  return new RegExp(`^${escapeRegex(trigger.trim())}\\b`, 'i');
}

export const DEFAULT_TRIGGER = `@${ASSISTANT_NAME}`;

export function getTriggerPattern(trigger?: string): RegExp {
  const normalizedTrigger = trigger?.trim();
  return buildTriggerPattern(normalizedTrigger || DEFAULT_TRIGGER);
}

export const TRIGGER_PATTERN = buildTriggerPattern(DEFAULT_TRIGGER);

// Timezone for scheduled tasks, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  const candidates = [
    process.env.TZ,
    envConfig.TZ,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  ];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();

// Interval (ms) for updating the pinned status message in Discord. 0 disables.
export const STATUS_PIN_INTERVAL = parseInt(
  process.env.STATUS_PIN_INTERVAL || envConfig.STATUS_PIN_INTERVAL || '30000',
  10,
);

// When true, mounts /var/run/docker.sock into agent containers so they can run Docker commands.
// Enable with NANOCLAW_ENABLE_DOCKER=true in the host environment.
export const ENABLE_DOCKER_SOCKET =
  (process.env.NANOCLAW_ENABLE_DOCKER || envConfig.NANOCLAW_ENABLE_DOCKER) ===
  'true';

// Path to a file containing a GitHub personal access token.
// When set, the token is read by the host process and injected as GITHUB_TOKEN
// into agent containers, enabling git push over HTTPS without SSH key setup.
// Create the file: echo "ghp_yourtoken" > ~/.config/nanoclaw/github-token && chmod 600 ~/.config/nanoclaw/github-token
// Then set: NANOCLAW_GITHUB_TOKEN_PATH=~/.config/nanoclaw/github-token
export const GITHUB_TOKEN_PATH =
  process.env.NANOCLAW_GITHUB_TOKEN_PATH ||
  envConfig.NANOCLAW_GITHUB_TOKEN_PATH ||
  null;
