# Setup: Dynamic Worker Agents

How to set up NanoClaw Fleet with dynamic worker spawning via Discord.

## Recommended: Automated Setup

The fastest way to get running is to let Claude handle it:

```bash
git clone https://github.com/thmtz/nanoclaw-fleet.git && cd nanoclaw-fleet
claude
```

Then run `/setup`. The setup skill walks you through everything below automatically, only pausing when it needs your input.

## Manual Setup

If you prefer to set things up by hand, follow the steps below.

### Prerequisites

- Node.js 22+
- Docker installed and accessible to your user
- A Discord bot application (https://discord.com/developers/applications)

### What Setup Covers

Whether you use `/setup` or follow the manual steps below, you'll configure:

1. **Claude auth**: OAuth token or Anthropic API key
2. **Discord bot token**: from the Developer Portal
3. **Discord Guild ID + Channel ID**: copied from Discord
4. **GitHub PAT** *(optional)*: for workers that clone private repos
5. **OpenAI-compatible API key** *(optional)*: for open-weight models

Each step explains how to create these if you don't have them yet.

## Repo vs. User Config

NanoClaw separates generic code from per-installation configuration. The repo contains everything needed to run any NanoClaw instance — the host process, container image, agent runner, MCP tools, and example profiles. User-specific configuration lives outside the repo at `~/.config/nanoclaw/`.

**What goes in the repo** (`nanoclaw/`):

| Directory | Purpose |
|-|-|
| `src/` | Host process (message routing, container lifecycle, IPC) |
| `container/` | Dockerfile, agent runner, MCP tools, skills |
| `worker-profiles/` | Example worker profiles — templates you copy and customize |
| `master-profiles/` | Example master agent instructions — copy to `groups/discord_main/` |
| `tools/` | Utility scripts (status dashboard, shims, injection helpers) |
| `docs/` | Architecture docs, setup guides, testing procedures |
| `.env.example` | Template for required environment variables |

**What goes in user config** (`~/.config/nanoclaw/`):

| Path | Purpose |
|-|-|
| `worker-profiles/default.json` | Your worker profile — repos to clone, credential mounts, tools to install |
| `worker-profiles/init.sh` | Your init script — runs inside each container at boot |
| `instructions/global.md` | Personal instructions for all agents (beads, code conventions, etc.) |
| `instructions/master.md` | Personal master-only instructions (mounts, GPU workflow, etc.) |
| `instructions/worker.md` | Personal worker-only instructions (mount map, repos, network) |

**Other per-installation state** (also outside the repo):

| Path | Purpose |
|-|-|
| `.env` | Secrets and tunables (bot tokens, guild IDs, backend config, container limits) |
| `data/` | Runtime state — SQLite database, session data, usage metrics (gitignored) |
| `groups/` | Worker workspaces — cloned repos, uncommitted changes (gitignored except for default CLAUDE.md files) |
| `logs/` | Application logs (gitignored) |

The setup steps below walk through creating your user config from the repo's examples. When you later update NanoClaw (pull new code), your `~/.config/nanoclaw/` files are untouched — only the repo-side defaults change, and you can merge those into your config as needed.

## 1. Create a Discord Server

Create a dedicated Discord server for your NanoClaw instance. This keeps worker channels organized and separate from personal servers.

1. In Discord: click **+** at the bottom of the server list → Create My Own
2. Name it (e.g., "devbox server")
3. Enable Developer Mode: Settings → App Settings → Advanced → Developer Mode
4. Right-click the server name → **Copy Server ID** — save this for step 3

## 2. Configure the Discord Bot

The bot needs `Manage Channels` permission to create/delete worker channels.

1. Go to https://discord.com/developers/applications
2. Select your bot application
3. **OAuth2** → URL Generator:
   - Scopes: `bot`
   - Bot Permissions: `Send Messages`, `Read Messages/View Channels`, `Manage Channels`, `Read Message History`
4. Copy the generated URL, open it, and invite the bot to your server
5. Save the bot token to `~/.config/discord/nanoclaw_bot_token`

## 3. Create a GitHub Personal Access Token

Workers clone private repos via HTTPS using a GitHub PAT. The container rewrites `git@github.com:` URLs to HTTPS automatically.

1. Go to https://github.com/settings/tokens (classic tokens)
2. Generate new token with the `repo` and `workflow` scopes. `repo` covers all orgs you're a member of. `workflow` is required to push changes to `.github/workflows/` files — without it, agents get a 403 on workflow YAML pushes.
3. Save it:

```bash
mkdir -p ~/.config/nanoclaw
echo "ghp_yourtoken" > ~/.config/nanoclaw/github_token
chmod 600 ~/.config/nanoclaw/github_token
```

## 4. Configure NanoClaw

Add to your `.env`:

```env
DISCORD_BOT_TOKEN=<your bot token>
DISCORD_GUILD_ID=<your server/guild ID from step 1>
```

Copy the systemd service template and customize it:

```bash
mkdir -p ~/.config/systemd/user
cp systemd/nanoclaw.service ~/.config/systemd/user/nanoclaw.service
# Edit the file: replace {{PROJECT_ROOT}}, {{NODE_PATH}}, {{HOME}} with real paths
# Add: Environment=NANOCLAW_GITHUB_TOKEN_PATH=/path/to/github_token
systemctl --user daemon-reload
```

A launchd plist template is also available at `launchd/com.nanoclaw.plist` for macOS.

## 5. Create the Master Channel

1. In your Discord server, create a `#master` text channel
2. Right-click it → Copy Channel ID
3. Register it as the main NanoClaw group:

```bash
sqlite3 store/messages.db \
  "INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, requires_trigger, is_main) \
   VALUES ('dc:<channel-id>', 'Master', 'discord_main', '@YourBotName', datetime('now'), 0, 1);"
```

Set `requires_trigger = 0` so the master responds to all messages (no @mention needed).

## 6. Personal Instructions (Optional)

Agent instructions are assembled from layered fragments. The repo provides base instructions in `instructions/{global,master,worker}.md`. You can add personal instructions that get appended:

```bash
mkdir -p ~/.config/nanoclaw/instructions
# Create any or all of these — they're all optional:
# global.md  — applied to all agents (master + workers)
# master.md  — master-only additions
# worker.md  — worker-only additions
```

The final CLAUDE.md for each agent is assembled at startup:
1. `instructions/global.md` (repo — shared base for all agents)
2. `instructions/master.md` or `instructions/worker.md` (repo — role-specific)
3. `~/.config/nanoclaw/instructions/global.md` (personal — all agents)
4. `~/.config/nanoclaw/instructions/master.md` or `worker.md` (personal — role-specific)

## 7. Set Up Worker Profiles

Worker profiles define what repos, tools, and credentials each worker gets. Config lives at `~/.config/nanoclaw/worker-profiles/`.

```bash
mkdir -p ~/.config/nanoclaw/worker-profiles
cp worker-profiles/example.json ~/.config/nanoclaw/worker-profiles/default.json
cp worker-profiles/init.sh ~/.config/nanoclaw/worker-profiles/init.sh
chmod +x ~/.config/nanoclaw/worker-profiles/init.sh
```

Edit `default.json` to configure your repos, tools, and credential mounts. See the example file for the format.

## 8. Rebuild and Restart

```bash
# Build host code (TypeScript → dist/)
npm run build

# Rebuild agent container (needed if container/ or worker-profiles/ changed)
./container/build.sh

# Restart
systemctl --user restart nanoclaw
```

## 9. Test

In `#master`, send:

```
create a worker called test-worker
```

You should see:
1. The master agent acknowledges the request
2. A new `#test-worker` channel appears in the server
3. Sending a message in `#test-worker` spawns a container and the worker responds

## What Happens on Restart

When NanoClaw restarts (systemd restart, host reboot, crash):

| What | Survives restart? | Survives destroy? | Why |
|-|-|-|-|
| Discord channels | ✅ | ❌ (deleted) | Server-side |
| Registered groups (SQLite) | ✅ | ❌ (deleted) | On-disk database |
| Worker repos + code changes | ✅ | ✅ (kept for resume) | Bind-mounted at `groups/{worker}/` |
| SDK session state (`.claude/`) | ✅ | ❌ (deleted) | Bind-mounted at `data/sessions/{worker}/.claude/` |
| Running containers | ❌ | ❌ | `--rm` flag — auto-removed on exit |
| Installed packages | ❌ | ❌ | Rebuilt by `init.sh` on next spawn |

**Recovery flow (restart):** NanoClaw loads groups from SQLite on startup. Next message to any worker spawns a fresh container. `init.sh` runs but skips already-cloned repos.

**Recovery flow (destroy + recreate):** Workspace is preserved on disk. When `create_worker` is called with the same name, it detects the leftover workspace and asks whether to "resume" (keep repos/code, fresh SDK session) or "fresh" (wipe everything). SDK session state is always cleared on create to prevent stale state from crashing the new worker.

## Troubleshooting

**Worker channel created but no response to messages:**
- Check `requires_trigger` — workers should have `requires_trigger = 0`
- Check logs: `tail -f logs/nanoclaw.log`

**"create_worker: missing required fields":**
- `DISCORD_GUILD_ID` isn't reaching the container. Verify it's in `.env` and that `container-runner.ts` forwards it.

**Agent doesn't know about create_worker tool:**
- Stale cached source. Kill the worker container (agent-runner auto-syncs by mtime on next spawn).

**Container builds don't pick up source changes:**
- Docker caches COPY layers. Use `./container/build.sh` (or `docker build --no-cache`) when `container/` changes.
- Agent-runner source auto-syncs by mtime — kill the container and message the worker again.

**Repos fail to clone (403 or 404):**
- Check that `NANOCLAW_GITHUB_TOKEN_PATH` is set in the systemd service and points to a valid token file.
- The token needs `repo` scope for private repos. Classic PATs with `repo` scope work across all orgs.
- Fine-grained PATs need per-org approval — use classic PATs for simplicity.
- Verify: `docker exec <container> bash -c 'echo $GITHUB_TOKEN | head -c 10'`

**Bot can't create channels:**
- Verify the bot has `Manage Channels` permission in the Discord server.
- Check the bot's role in Server Settings → Roles.
