/**
 * Initialize the fleet master agent group, wired to the CLI channel.
 *
 * Creates (or updates) a master agent group with fleet_role='master', seeds
 * CLAUDE.local.md with fleet-aware instructions, and wires it to cli/local so
 * `pnpm run chat` talks to the master. Idempotent — safe to re-run.
 *
 * Usage:
 *   pnpm exec tsx scripts/init-fleet-master.ts [--display-name "Joey"]
 */
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import {
  createAgentGroup,
  getAgentGroupByFolder,
  updateAgentGroup,
} from '../src/db/agent-groups.js';
import { initDb } from '../src/db/connection.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from '../src/db/messaging-groups.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { grantRole } from '../src/modules/permissions/db/user-roles.js';
import { upsertUser } from '../src/modules/permissions/db/users.js';
import { initGroupFilesystem } from '../src/group-init.js';
import type { AgentGroup, MessagingGroup } from '../src/types.js';

const CLI_CHANNEL = 'cli';
const CLI_PLATFORM_ID = 'local';
const CLI_USER_ID = `${CLI_CHANNEL}:${CLI_PLATFORM_ID}`;

const MASTER_FOLDER = 'master';
const MASTER_NAME = 'Master';

const MASTER_INSTRUCTIONS = `# Fleet Master

You are the fleet master. Your only job is to manage a fleet of worker agents — create, destroy, switch, and list them. You do NOT do coding tasks yourself; delegate to workers.

## Tools

- \`create_worker({ name, backend?, model?, instructions? })\` — spin up a new worker. Default backend = claude. Give each worker its own Discord channel (when configured) and its own container.
- \`destroy_worker({ name, delete_channel? })\` — stop and archive a worker. Filesystem + conversation history are preserved; recreating with the same name resumes.
- \`switch_backend({ name, backend, model? })\` — change a worker's inference provider / model. Conversation is preserved.
- \`list_workers\` — ask the host to send you the current worker list. You'll receive the list as a chat message in your next batch.

## Style

- Parse user intent loosely: "create a worker named X that runs on claude" → create_worker({name:"X",backend:"claude"}).
- "switch X to neuralwatt kimi k2" → switch_backend({name:"X",backend:"neuralwatt",model:"kimi-k2"}).
- Be terse. One line confirmations. The user is watching on mobile.
- When the user asks about a worker's status or says "list workers", call list_workers and pass the reply through.

## Model discovery

The Neuralwatt translation shim at \`http://host.docker.internal:3003\` exposes fuzzy model lookup:

- \`GET /models\` lists available ids.
- \`GET /models/resolve/<query>\` fuzzy-matches a query to one id.

When the user asks for a model by natural name ("kimi fast", "glm"), curl the resolve endpoint first (via Bash), then pass the returned id to create_worker / switch_backend:

    curl -sf http://host.docker.internal:3003/models/resolve/kimi%20fast
    # {"model":"kimi-k2.6-fast","match":"contains"}

If the shim is unreachable, pass the user's literal string and let the tool error loudly.
`;

interface Args {
  displayName: string;
}

function parseArgs(argv: string[]): Args {
  let displayName: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    if (key === '--display-name') {
      displayName = val;
      i++;
    }
  }
  return { displayName: displayName ?? 'Joey' };
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db);

  const now = new Date().toISOString();

  // 1. Synthetic CLI user + owner grant (so fleet MCP tools accept the caller).
  upsertUser({
    id: CLI_USER_ID,
    kind: CLI_CHANNEL,
    display_name: args.displayName,
    created_at: now,
  });
  try {
    grantRole({ user_id: CLI_USER_ID, role: 'owner', agent_group_id: null, granted_by: null, granted_at: now });
    console.log(`Granted owner to ${CLI_USER_ID}`);
  } catch {
    // Already owner — grantRole throws on duplicate PK.
    console.log(`${CLI_USER_ID} already has owner role`);
  }

  // 2. Master agent group + filesystem.
  let master: AgentGroup | undefined = getAgentGroupByFolder(MASTER_FOLDER);
  if (!master) {
    const agId = generateId('ag');
    createAgentGroup({
      id: agId,
      name: MASTER_NAME,
      folder: MASTER_FOLDER,
      agent_provider: 'claude',
      created_at: now,
    });
    master = getAgentGroupByFolder(MASTER_FOLDER)!;
    console.log(`Created master agent group: ${master.id}`);
  }
  updateAgentGroup(master.id, { fleet_role: 'master', fleet_backend: 'claude' });
  console.log(`Marked ${master.id} as fleet master`);

  initGroupFilesystem(master, { instructions: MASTER_INSTRUCTIONS });

  // 3. CLI messaging group + wiring.
  let cliMg: MessagingGroup | undefined = getMessagingGroupByPlatform(CLI_CHANNEL, CLI_PLATFORM_ID);
  if (!cliMg) {
    cliMg = {
      id: generateId('mg'),
      channel_type: CLI_CHANNEL,
      platform_id: CLI_PLATFORM_ID,
      name: 'Local CLI (fleet master)',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now,
    };
    createMessagingGroup(cliMg);
    console.log(`Created CLI messaging group: ${cliMg.id}`);
  }

  const existing = getMessagingGroupAgentByPair(cliMg.id, master.id);
  if (!existing) {
    createMessagingGroupAgent({
      id: generateId('mga'),
      messaging_group_id: cliMg.id,
      agent_group_id: master.id,
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now,
    });
    console.log(`Wired cli -> master: ${cliMg.id} -> ${master.id}`);
  }

  console.log('');
  console.log('Fleet master initialized.');
  console.log(`  master: ${master.name} [${master.id}] @ groups/${MASTER_FOLDER}`);
  console.log(`  owner:  ${CLI_USER_ID}`);
  console.log(`  channel: cli/${CLI_PLATFORM_ID}`);
  console.log('');
  console.log('Start the host: pnpm run dev');
  console.log('Then in another terminal: pnpm run chat "create a worker named smoke-test"');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
