/**
 * Seed the fleet master agent_group wired to a pre-existing Discord channel.
 *
 * Unlike init-fleet-master.ts (which wires CLI), this variant hooks the master
 * into a real Discord channel so workers can be created/destroyed from Discord
 * itself. The channel must already exist — the script does not create it.
 *
 * Usage:
 *   DISCORD_MASTER_CHANNEL_ID=<id> \
 *   OWNER_DISCORD_USER_ID=<id> \
 *   pnpm exec tsx scripts/init-fleet-master-discord.ts
 *
 * Idempotent — safe to re-run. Existing rows are reused.
 */
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { createAgentGroup, getAgentGroupByFolder, updateAgentGroup } from '../src/db/agent-groups.js';
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

const MASTER_FOLDER = 'master';
const MASTER_NAME = 'Fleet Master';

const MASTER_INSTRUCTIONS = `# Fleet Master

You are the fleet master. Your one and only job is worker lifecycle — create, destroy, switch backends on, and list workers. You do NOT do any real work yourself. Delegate everything.

## Tools

- create_worker({ name, backend?, model?, instructions? }) — spin up a new worker. Default backend = claude. Each worker gets a Discord channel + container.
- destroy_worker({ name, delete_channel? }) — archive a worker. Filesystem and history persist; creating with the same name resumes.
- switch_backend({ name, backend, model? }) — flip a worker's inference provider / model. Conversation is kept.
- list_workers — request the worker list. The host posts it back in your next message batch.

## Style

- Parse intent loosely:
  - "create worker X" → create_worker({name:"X"})
  - "create worker X on neuralwatt kimi k2" → create_worker({name:"X",backend:"neuralwatt",model:"kimi-k2"})
  - "switch X to claude" → switch_backend({name:"X",backend:"claude"})
  - "kill X" / "destroy X" → destroy_worker({name:"X"})
  - "list workers" / "what workers do I have" → list_workers
- Terse. Mobile-friendly replies. One line is usually enough.
- Never implement code. If the user describes a task, create a worker and delegate to it.
`;

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function main(): Promise<void> {
  const channelId = process.env.DISCORD_MASTER_CHANNEL_ID;
  const ownerDiscordId = process.env.OWNER_DISCORD_USER_ID;
  if (!channelId) {
    console.error('Missing DISCORD_MASTER_CHANNEL_ID');
    process.exit(2);
  }
  if (!ownerDiscordId) {
    console.error('Missing OWNER_DISCORD_USER_ID');
    process.exit(2);
  }

  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db);

  const now = new Date().toISOString();

  const ownerUserId = `discord:${ownerDiscordId}`;
  upsertUser({ id: ownerUserId, kind: 'discord', display_name: 'joey', created_at: now });
  try {
    grantRole({ user_id: ownerUserId, role: 'owner', agent_group_id: null, granted_by: null, granted_at: now });
    console.log(`Granted owner to ${ownerUserId}`);
  } catch {
    console.log(`${ownerUserId} already has owner role`);
  }

  let master = getAgentGroupByFolder(MASTER_FOLDER);
  if (!master) {
    const agId = genId('ag');
    createAgentGroup({
      id: agId,
      name: MASTER_NAME,
      folder: MASTER_FOLDER,
      agent_provider: 'claude',
      created_at: now,
      status: 'active',
      fleet_role: 'master',
      fleet_backend: 'claude',
    });
    master = getAgentGroupByFolder(MASTER_FOLDER)!;
    console.log(`Created master agent group: ${master.id}`);
  } else {
    updateAgentGroup(master.id, { fleet_role: 'master', fleet_backend: 'claude' });
    console.log(`Reusing master agent group: ${master.id}`);
  }

  initGroupFilesystem(master as AgentGroup, { instructions: MASTER_INSTRUCTIONS });

  let mg: MessagingGroup | undefined = getMessagingGroupByPlatform('discord', channelId);
  if (!mg) {
    mg = {
      id: genId('mg'),
      channel_type: 'discord',
      platform_id: channelId,
      name: 'v2-master',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now,
    };
    createMessagingGroup(mg);
    console.log(`Created messaging group for Discord channel ${channelId}: ${mg.id}`);
  } else {
    console.log(`Reusing messaging group: ${mg.id}`);
  }

  const existing = getMessagingGroupAgentByPair(mg.id, master.id);
  if (!existing) {
    createMessagingGroupAgent({
      id: genId('mga'),
      messaging_group_id: mg.id,
      agent_group_id: master.id,
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now,
    });
    console.log(`Wired discord:${channelId} -> master (${master.id})`);
  } else {
    console.log(`Wiring already exists: ${existing.id}`);
  }

  console.log('');
  console.log('Fleet master initialized.');
  console.log(`  master: ${master.name} [${master.id}] @ groups/${MASTER_FOLDER}`);
  console.log(`  owner:  ${ownerUserId}`);
  console.log(`  channel: discord/${channelId}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
