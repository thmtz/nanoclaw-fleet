# Setup

How to get a NanoClaw Fleet instance running with Discord and dynamic workers.

## Recommended: `/setup`

```bash
git clone https://github.com/thmtz/nanoclaw-fleet.git
cd nanoclaw-fleet
claude     # or your coding agent of choice
# then: /setup
```

The `/setup` skill installs Node and Docker (if missing), walks you through the Discord bot, configures `.env`, registers the master channel, and starts the systemd service. It only stops to ask for inputs it cannot generate (bot tokens, guild ids).

If you would rather drive setup by hand, the rest of this guide covers the same ground.

## Prerequisites

- Node.js 22 or later
- Docker, with the daemon accessible to your user
- A Discord server you control and a Discord bot application
- [Bun](https://bun.sh), only if you plan to route workers through Neuralwatt or another OpenAI-compatible provider (see [the shim section](#9-inference-shim-optional))

## Repo vs. user config

NanoClaw separates generic code from per-installation configuration. The repo holds the host process, container image, agent runner, MCP tools, and example profiles. Your installation lives at `~/.config/nanoclaw/`.

| Directory | What's in it |
|-|-|
| `src/` | Host process: gateway, container lifecycle, IPC |
| `container/` | Dockerfile, agent runner, MCP tools, container skills |
| `instructions/` | Repo-side agent instructions: global, master, worker |
| `worker-profiles/` | Example worker profiles (templates) |
| `tools/` | Translation shim, status helpers, restart watchdog |
| `docs/` | These docs |

| Path under `~/.config/nanoclaw/` | What it is |
|-|-|
| `Dockerfile` | Personal container layer (databases, dev tools) — optional |
| `worker-profiles/default.json` | Your worker profile (repos, mounts, tools) |
| `worker-profiles/init.sh` | Per-spawn setup script |
| `instructions/{global,master,worker}.md` | Personal instructions, layered on top of repo defaults |
| `mount-allowlist.json` | Hosts the worker profile is allowed to mount |
| `Dockerfile` | Optional personal image layer |

| Other state outside the repo | What it is |
|-|-|
| `.env` | Tokens, guild ids, defaults, container limits |
| `data/` | SQLite database, sessions, usage metrics |
| `groups/` | Per-agent workspaces (cloned repos, edits) |
| `logs/` | Application and per-worker logs |

When you pull NanoClaw updates later, your `~/.config/nanoclaw/` files are untouched. See [personal-config.md](personal-config.md) for the full layout.

## 1. Create a Discord server

A dedicated server keeps worker channels organized and isolated.

1. In Discord: click **+** at the bottom of the server list, **Create My Own**.
2. Name it (e.g. "devbox").
3. Settings → Advanced → enable **Developer Mode**.
4. Right-click the server name → **Copy Server ID**. Save it for step 4.

## 2. Configure the Discord bot

The bot needs `Manage Channels` to create and delete worker channels.

1. Go to <https://discord.com/developers/applications>.
2. Select (or create) your bot application.
3. **OAuth2 → URL Generator**:
   - Scopes: `bot`
   - Bot Permissions: `Send Messages`, `Read Messages/View Channels`, `Manage Channels`, `Read Message History`
4. Open the generated URL and invite the bot to your server.
5. Save the bot token to `~/.config/discord/nanoclaw_bot_token`.

## 3. Create a GitHub PAT (for private repos)

Workers clone private repos over HTTPS using a GitHub personal access token. The container rewrites `git@github.com:` URLs to HTTPS automatically.

1. <https://github.com/settings/tokens> → classic tokens → generate.
2. Scopes: `repo` (covers all orgs you belong to) and `workflow` (needed if any worker pushes `.github/workflows/*` changes).
3. Save it:

```bash
mkdir -p ~/.config/nanoclaw
echo "ghp_yourtoken" > ~/.config/nanoclaw/github_token
chmod 600 ~/.config/nanoclaw/github_token
```

## 4. Configure NanoClaw

Add to `.env`:

```env
DISCORD_BOT_TOKEN=<from step 2>
DISCORD_GUILD_ID=<from step 1>
NANOCLAW_GITHUB_TOKEN_PATH=~/.config/nanoclaw/github_token

# default backend for new workers and the master (read on every spawn):
NANOCLAW_DEFAULT_MASTER_BACKEND=anthropic
NANOCLAW_DEFAULT_MASTER_MODEL=claude-opus-4-7
NANOCLAW_DEFAULT_WORKER_BACKEND=anthropic
NANOCLAW_DEFAULT_WORKER_MODEL=claude-opus-4-7
```

Copy the systemd template:

```bash
mkdir -p ~/.config/systemd/user
cp systemd/nanoclaw.service ~/.config/systemd/user/nanoclaw.service
# Edit: replace {{PROJECT_ROOT}}, {{NODE_PATH}}, {{HOME}} with real values.
systemctl --user daemon-reload
```

A launchd plist template is at `launchd/com.nanoclaw.plist` for macOS.

## 5. Register the master channel

1. In Discord, create the `#master` text channel.
2. Right-click → Copy Channel ID.
3. Register it:

```bash
sqlite3 store/messages.db \
  "INSERT OR REPLACE INTO registered_groups
     (jid, name, folder, trigger_pattern, added_at, requires_trigger, is_main)
   VALUES ('dc:<channel-id>', 'Master', 'discord_main', '@YourBotName', datetime('now'), 0, 1);"
```

`requires_trigger=0` makes the master respond to every message in `#master` without a mention.

## 6. Personal instructions (optional)

Agent instructions are assembled from four fragments. The repo provides base instructions; your personal layer is appended.

```bash
mkdir -p ~/.config/nanoclaw/instructions
# Create whichever you need (all optional):
#   global.md   shared across master and workers
#   master.md   master-only additions
#   worker.md   worker-only additions
```

Assembly order at startup:

1. `instructions/global.md` (repo)
2. `instructions/master.md` or `instructions/worker.md` (repo)
3. `~/.config/nanoclaw/instructions/global.md` (personal)
4. `~/.config/nanoclaw/instructions/master.md` or `worker.md` (personal)

The result lands in `groups/<folder>/CLAUDE.md`.

## 7. Worker profile

```bash
mkdir -p ~/.config/nanoclaw/worker-profiles
cp worker-profiles/example.json ~/.config/nanoclaw/worker-profiles/default.json
cp worker-profiles/init.sh ~/.config/nanoclaw/worker-profiles/init.sh
chmod +x ~/.config/nanoclaw/worker-profiles/init.sh
```

Edit `default.json` to declare repos to clone, tools to install, and mounts to expose. The example file is fully commented.

If the profile mounts host paths, add them to `~/.config/nanoclaw/mount-allowlist.json` (the host enforces the allowlist before spawning a container).

## 8. Build and start

```bash
npm run build               # compile host TypeScript
./container/build.sh        # build the agent container image
systemctl --user restart nanoclaw
```

For macOS:

```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## 9. Inference shim (optional)

The translation shim (`tools/anthropic-shim.ts`) routes worker traffic to Neuralwatt or any other OpenAI-compatible provider. Skip this if you only run Anthropic workers.

The shim runs on Bun:

```bash
curl -fsSL https://bun.sh/install | bash
```

Add provider config to `.env`:

```env
NEURALWATT_API_KEY=sk-...
# default base URL is https://api.neuralwatt.com/v1
# override for another provider:
# NEURALWATT_BASE_URL=https://api.example.com/v1
```

Create `~/.config/systemd/user/nanoclaw-shim.service`:

```ini
[Unit]
Description=NanoClaw inference shim (Anthropic ↔ OpenAI)
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/nanoclaw-fleet
ExecStart=/home/YOU/.bun/bin/bun run tools/anthropic-shim.ts
Restart=always
RestartSec=5
EnvironmentFile=/path/to/nanoclaw-fleet/.env
StandardOutput=append:/path/to/nanoclaw-fleet/logs/shim.log
StandardError=append:/path/to/nanoclaw-fleet/logs/shim.error.log

[Install]
WantedBy=default.target
```

Enable and verify:

```bash
systemctl --user daemon-reload
systemctl --user enable --now nanoclaw-shim
curl -s http://localhost:3003/models | head
```

The output should be a JSON list of models. If it isn't, check `logs/shim.error.log`.

Once the shim is up, create a Neuralwatt worker:

```bash
./ncf create my-task --backend neuralwatt --model kimi-k2.5
```

The `--backend neuralwatt` name is historical — it routes through the shim regardless of which OpenAI-compatible provider you point it at.

## 10. (Optional) Provider API keys

If your workers need direct provider access (eval scripts, model comparisons), add API keys to `.env` and they will be injected into every container as env vars:

```env
FIREWORKS_API_KEY=fw_...
TOGETHER_API_KEY=tgp_v1_...
SYNTHETIC_API_KEY=syn_...
```

These are independent of the per-worker shim routing above.

## 11. Test

In `#master`:

```
create a worker called test-worker
```

You should see:

1. The master ack the request.
2. A new `#test-worker` channel in the server.
3. The first message in `#test-worker` spawns a container; the worker replies.

For more thorough end-to-end tests, see [testing.md](testing.md).

## What survives restart

| What | Survives restart? | Survives destroy? |
|-|-|-|
| Discord channels | Yes | No (deleted) |
| Registered groups (SQLite) | Yes | No (deleted) |
| Worker repos + edits | Yes | Yes (kept for resume) |
| SDK session (`.claude/`) | Yes | Yes (kept for resume) |
| Running containers | No (`--rm`) | No |
| Installed packages inside the container | No | No (rebuilt by `init.sh`) |

When NanoClaw restarts, the host reads registrations from SQLite, then waits. The first message to any worker spawns a fresh container; `init.sh` runs but skips already-cloned repos.

When you destroy and recreate with the same name, the host detects the leftover workspace and asks whether to `resume` (keep repos and SDK session) or `fresh` (wipe everything).

## Troubleshooting

**Worker channel exists but no response.** Check `requires_trigger` is `0`. Then `tail -f logs/nanoclaw.log`.

**"ncf create: missing required fields".** `DISCORD_GUILD_ID` isn't reaching the container. Confirm it's in `.env` and exported.

**Agent doesn't see new MCP tools.** Stale agent-runner cache. `ncf restart <worker>` (the host auto-syncs by mtime on the next spawn).

**Container build doesn't pick up source changes.** Docker caches COPY layers. Run `./container/build.sh` (it forces a clean rebuild for the agent layer).

**Repo clone fails with 403/404.** Check `NANOCLAW_GITHUB_TOKEN_PATH` points to a valid PAT. Use a classic PAT with `repo` scope for the simplest setup.

**Bot can't create channels.** Verify the bot has `Manage Channels` and that its role is above any `@everyone` overrides for the server.

For a deeper dive, see [troubleshooting.md](troubleshooting.md).
