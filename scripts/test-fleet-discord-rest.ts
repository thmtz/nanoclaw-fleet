/**
 * Discord REST integration check for the fleet channel provisioner.
 *
 * Hits the real Discord API using the bot token configured in .env — creates
 * a throwaway channel under DISCORD_FLEET_CATEGORY_ID, confirms it exists,
 * then deletes it. Proves createDiscordChannel / deleteDiscordChannel work
 * against a live guild + bot. Fleet unit tests mock Discord; this script
 * fills the gap without needing a full NanoClaw host running.
 *
 * Env required:
 *   DISCORD_BOT_TOKEN
 *   DISCORD_GUILD_ID
 *   DISCORD_FLEET_CATEGORY_ID (optional — channel goes in no category if absent)
 *
 * Usage:
 *   pnpm exec tsx scripts/test-fleet-discord-rest.ts
 */
import { createDiscordChannel, deleteDiscordChannel, loadDiscordFleetConfig } from '../src/modules/fleet/discord-channel.js';

async function main(): Promise<void> {
  const cfg = loadDiscordFleetConfig();
  if (!cfg) {
    console.error('Missing Discord fleet config (DISCORD_BOT_TOKEN + DISCORD_GUILD_ID).');
    console.error('Put them in .env or export them. Category id is optional.');
    process.exit(2);
  }

  const name = `fleet-rest-test-${Date.now()}`;
  console.log(`Creating channel "${name}" in guild ${cfg.guildId}${cfg.categoryId ? ` (category ${cfg.categoryId})` : ''}`);

  const channel = await createDiscordChannel(cfg, name, 'fleet provisioner integration check — safe to delete');
  console.log(`  created: id=${channel.id} name=${channel.name}`);

  // Confirm it shows up via Discord API.
  const res = await fetch(`https://discord.com/api/v10/channels/${channel.id}`, {
    headers: { Authorization: `Bot ${cfg.botToken}` },
  });
  if (!res.ok) {
    console.error(`  verify GET failed: ${res.status}`);
    process.exit(1);
  }
  const body = (await res.json()) as { name: string };
  if (body.name !== channel.name) {
    console.error(`  verify mismatch: expected name=${channel.name} got name=${body.name}`);
    process.exit(1);
  }
  console.log('  verify GET succeeded');

  console.log(`Deleting channel ${channel.id}`);
  await deleteDiscordChannel(cfg, channel.id);

  const res2 = await fetch(`https://discord.com/api/v10/channels/${channel.id}`, {
    headers: { Authorization: `Bot ${cfg.botToken}` },
  });
  if (res2.status !== 404 && res2.status !== 403) {
    console.error(`  channel still reachable after delete: status=${res2.status}`);
    process.exit(1);
  }
  console.log('  verify DELETE succeeded (404)');

  console.log('\n== ALL PASSED ==');
}

main().catch((err) => {
  console.error('Discord REST test failed:', err);
  process.exit(1);
});
