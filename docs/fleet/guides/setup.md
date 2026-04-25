# Setup

How to stand up a fleet-on-v2 install. The [runbook](../RUNBOOK.md) has more operational detail; this guide is the fastest path from clone to first worker.

## Prereqs

- Node 22+, pnpm 10+, Docker.
- A Discord bot with `Manage Channels` permission, in a guild you control.
- Anthropic credentials. OneCLI set up is the recommended path; the `.env` fallback (`CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`) also works.

## 1. Clone and build

```bash
git clone https://github.com/qwibitai/nanoclaw.git nanoclaw-fleet
cd nanoclaw-fleet
git checkout feat/fleet
pnpm install
./container/build.sh
```

`./container/build.sh` builds `nanoclaw-agent-v2-<slug>:base`. If `~/.config/nanoclaw/Dockerfile` exists, the script layers it on top and tags `:latest`. Otherwise `:latest` aliases `:base`.

## 2. `.env`

Minimum configuration:

```env
ASSISTANT_NAME=fleet-master
TZ=America/Denver

# Discord adapter
DISCORD_BOT_TOKEN=...
DISCORD_APPLICATION_ID=...
DISCORD_PUBLIC_KEY=...

# Fleet channel provisioning
DISCORD_GUILD_ID=...
DISCORD_FLEET_CATEGORY_ID=...                 # optional, parent category for worker channels

# Anthropic credentials (one of these — OneCLI vault is preferred)
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
# ANTHROPIC_API_KEY=sk-ant-api03-...
```

Pull `DISCORD_APPLICATION_ID` and `DISCORD_PUBLIC_KEY` from the Discord API:

```bash
curl -s https://discord.com/api/v10/oauth2/applications/@me \
  -H "Authorization: Bot $DISCORD_BOT_TOKEN" | jq '{id, verify_key}'
```

## 3. Optional: Neuralwatt shim

Skip this if you only run Claude workers. To use Neuralwatt or any OpenAI-compatible provider:

```env
NW_SHIM_CONFIG_PATH=/abs/path/to/nanoclaw-fleet/data/worker-backends.json
NW_SHIM_USAGE_PATH=/abs/path/to/nanoclaw-fleet/data/worker-usage.json
NEURALWATT_API_KEY=sk-...
```

Run the shim from the v1 fleet repo (the v2 fleet reuses it as-is):

```bash
# in the v1 fleet checkout
bun run tools/anthropic-shim.ts
```

The shim listens on `:3003`. Verify:

```bash
curl -s http://localhost:3003/models | head
```

## 4. Personal config (optional)

Copy the example into place:

```bash
mkdir -p ~/.config/nanoclaw/{instructions,worker-profiles}
cp examples/worker-profiles/example.json ~/.config/nanoclaw/worker-profiles/default.json
cp examples/worker-profiles/init.sh ~/.config/nanoclaw/worker-profiles/init.sh   # if you want a custom init
chmod +x ~/.config/nanoclaw/worker-profiles/init.sh
```

Edit `default.json` to point at your repos, tools, and mounts. See [personal-config.md](personal-config.md).

If your worker profile mounts host paths, write a `mount-allowlist.json`:

```bash
cat > ~/.config/nanoclaw/mount-allowlist.json <<'EOF'
{
  "allowedRoots": [
    {"path": "~/.ssh", "allowReadWrite": false},
    {"path": "~/.config/gpuctl", "allowReadWrite": true}
  ],
  "blockedPatterns": []
}
EOF
```

The allowlist is read once at host startup; new entries require a restart.

## 5. Seed the master

Create `#master` in your guild, copy its channel id, then:

```bash
DISCORD_MASTER_CHANNEL_ID=<master-channel-id> \
OWNER_DISCORD_USER_ID=<your-discord-user-id> \
pnpm exec tsx scripts/init-fleet-master-discord.ts
```

This creates the master `agent_group` with `fleet_role='master'`, wires it to the Discord channel, and promotes your Discord user to `owner`. Idempotent — safe to re-run.

## 6. Start the host

```bash
pnpm run dev
```

Or in production:

```bash
pnpm run build
node dist/index.js
```

You should see the host log connecting to Discord and announcing the master agent. Send a message in `#master`:

```
hello
```

The master agent should reply.

## 7. Create the first worker

In `#master`:

```
create a worker named test
```

The master calls `create_worker`, the host provisions a Discord channel (`#test`), wires destinations, and acks "Worker `test` is ready." in `#master`.

Switch to `#test` and send a message. The first message spawns the container, which clones repos, runs tools, and starts the SDK. Subsequent messages get a fast turnaround.

## 8. Verify

```bash
ncf status                # master + workers, container state, backend
ncf debug                 # paths, agent groups, docker, shim, wake
./scripts/smoke.sh        # end-to-end smoke through real Discord
```

`ncf status` should show your master and the new worker. If anything looks off, see [troubleshooting.md](troubleshooting.md).

## Service management

```bash
# Linux (recommended): systemd user unit
systemctl --user daemon-reload
systemctl --user start nanoclaw

# macOS: launchd
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Restart for code changes
systemctl --user restart nanoclaw
```

A systemd unit template is in `systemd/nanoclaw.service`; a launchd plist is in `launchd/com.nanoclaw.plist`. Both need path placeholders replaced before installing.

## What survives restart

| Layer | Survives host restart? | Survives `destroy_worker`? |
|-|-|-|
| Discord channels | Yes | No (deleted unless `delete_channel: false`) |
| Agent group registration (DB) | Yes | Archived, kept for resume |
| Worker repos and edits | Yes | Yes |
| SDK session state | Yes | Yes (kept for resume) |
| Running containers | No (`--rm`) | No |
| Status pin message ids | Yes (in central DB) | No (channel gone) |

Sending a message to a worker after the host restarts respawns the container; `worker-init.sh` runs but is idempotent.

## Troubleshooting

If the master doesn't reply, the worker channel doesn't get created, or the worker doesn't respond, jump to [troubleshooting.md](troubleshooting.md). Triage commands in [debug-checklist style](../RUNBOOK.md#debug).
