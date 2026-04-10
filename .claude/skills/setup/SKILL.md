---
name: setup
description: Run initial NanoClaw Fleet setup. Use when user wants to install dependencies, configure Discord, set up worker profiles, or start the background services. Triggers on "setup", "install", "configure nanoclaw", or first-time setup requests.
---

# NanoClaw Fleet Setup

This is a fork of NanoClaw customized for Discord-based fleet management. Setup uses `bash setup.sh` for bootstrap, then `npx tsx setup/index.ts --step <name>` for remaining steps. Steps emit structured status blocks to stdout. Verbose logs go to `logs/setup.log`.

**Principle:** When something is broken or missing, fix it. Don't tell the user to go fix it themselves unless it genuinely requires their manual action (e.g. creating a Discord bot, pasting a token). If a dependency is missing, install it. If a service won't start, diagnose and repair. Ask the user for permission when needed, then do the work.

**UX Note:** Use `AskUserQuestion` for all user-facing questions.

## Before You Start

Tell the user what setup will walk them through. If they already have some of these, each step can reuse existing credentials instead of asking again.

1. **Claude auth**: OAuth token (via `claude setup-token`) or Anthropic API key
2. **Discord bot token**: from the Discord Developer Portal
3. **Discord Guild (Server) ID**: right-click server name in Discord
4. **Discord Channel ID** for `#master`: right-click the channel in Discord
5. **GitHub PAT** *(optional)*: only needed if workers clone private repos
6. **OpenAI-compatible API key** *(optional)*: only if using open-weight models

## 0. Git Remote Setup

This fork uses `thmtz/nanoclaw-fleet` as `origin`. Upstream NanoClaw (`qwibitai/nanoclaw`) should be configured as `upstream` for pulling updates.

Run `git remote -v`.

- If no `upstream` remote exists, add it:
  ```bash
  git remote add upstream https://github.com/qwibitai/nanoclaw.git
  ```
- If `origin` points to `thmtz/nanoclaw-fleet` and the user wants to push their own customizations, suggest they fork `thmtz/nanoclaw-fleet` on GitHub and update their origin.

No need to fork upstream NanoClaw directly. This repo already includes everything.

## 1. Bootstrap (Node.js + Dependencies)

Run `bash setup.sh` and parse the status block.

- If NODE_OK=false: Node.js is missing or too old. AskUserQuestion: "Would you like me to install Node.js 22?"
  - macOS: `brew install node@22` or nvm
  - Linux: `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs`
  - Re-run `bash setup.sh` after installing
- If DEPS_OK=false: delete `node_modules`, re-run `bash setup.sh`. If native module build fails, install build tools (`build-essential` on Linux, `xcode-select --install` on macOS).
- If NATIVE_OK=false: better-sqlite3 failed. Install build tools and re-run.
- Record PLATFORM for later steps.

## 2. Check Environment

Run `npx tsx setup/index.ts --step environment` and parse the status block.

- Record DOCKER value for step 3
- If HAS_ENV=true: `.env` already exists — step 4 should check it for existing credentials before asking
- If HAS_REGISTERED_GROUPS=true: note existing config, offer to skip or reconfigure

## 3. Docker Setup

This fork uses Docker for worker containers (Apple Container is not supported for fleet workers).

- DOCKER=running: continue to step 4
- DOCKER=installed_not_running: `sudo systemctl start docker` (Linux) or `open -a Docker` (macOS). Wait 15s, re-check.
- DOCKER=not_found: AskUserQuestion: "Docker is required. Install it?"
  - Linux: `curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER`
  - macOS: `brew install --cask docker` or direct to https://docker.com/products/docker-desktop

### Build the container image

```bash
./container/build.sh
```

If the build fails, read the error output. Try `docker builder prune -f` and retry.

## 4. Claude Authentication

Check `.env` for `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`.

**If credentials already exist** (HAS_ENV=true from step 2 and a token/key is set): Tell the user what's configured and AskUserQuestion: "Keep existing Claude credentials, or reconfigure?" If keeping, skip to step 5.

**If no credentials exist:**

AskUserQuestion: "Claude subscription (Pro/Max) or Anthropic API key?"

- **Subscription:** Tell user to run `claude setup-token` in another terminal, then paste the token as a chat message. Write `CLAUDE_CODE_OAUTH_TOKEN=<token>` to `.env`.
- **API key:** Tell user to paste their API key as a chat message. Write `ANTHROPIC_API_KEY=<key>` to `.env`.

## 5. Discord Setup

This fork uses Discord exclusively. Invoke `/add-discord` to handle:
1. Creating or configuring the Discord bot
2. Collecting the bot token and writing it to `.env`
3. Registering the main `#master` channel

**After `/add-discord` completes**, also configure these recommended `.env` vars:

```
ASSISTANT_NAME=Andy          # Bot trigger name (default: Andy, used as @Andy in workers)
NANOCLAW_MODEL=sonnet        # Default model for new workers (opus/sonnet/haiku)
TZ=America/Denver            # Timezone for log timestamps and status messages
```

Then collect the Discord Guild (Server) ID:

Tell the user:
> Right-click your Discord server name and click "Copy Server ID" (Developer Mode must be enabled in Discord settings).

Add to `.env`:
```
DISCORD_GUILD_ID=<their-guild-id>
```

The guild ID is required for the master agent to create and delete worker channels.

**Important:** The master channel must be registered with `requires_trigger = 0` and `is_main = 1` so the master agent responds to all messages without needing an @mention.

## 6. GitHub Token (for Workers)

Workers clone private repos via HTTPS using a GitHub Personal Access Token.

AskUserQuestion: "Do your workers need to clone private GitHub repos?"

**Yes:**
1. Tell user to create a classic PAT at https://github.com/settings/tokens with `repo` and `workflow` scopes
2. Save it:
   ```bash
   mkdir -p ~/.config/nanoclaw
   echo "ghp_yourtoken" > ~/.config/nanoclaw/github_token
   chmod 600 ~/.config/nanoclaw/github_token
   ```
3. Add to `.env`: `NANOCLAW_GITHUB_TOKEN_PATH=<path-to-token-file>`

**No:** Skip this step. Workers will only be able to clone public repos.

## 7. Worker Profiles

Worker profiles define what repos, tools, and credentials each worker container gets. They live at `~/.config/nanoclaw/worker-profiles/`. See `docs/guides/personal-config.md` for the full config reference and `examples/personal-config/` for a complete example.

```bash
mkdir -p ~/.config/nanoclaw/worker-profiles
cp worker-profiles/example.json ~/.config/nanoclaw/worker-profiles/default.json
cp worker-profiles/init.sh ~/.config/nanoclaw/worker-profiles/init.sh
chmod +x ~/.config/nanoclaw/worker-profiles/init.sh
```

Walk the user through editing `default.json`. Key fields:

- **`repos`**: list of git URLs to clone on worker startup
- **`tools`**: shell commands to run after cloning (e.g. `uv tool install ./mypackage`)
- **`init_script`**: path to init.sh (relative to worker-profiles dir), runs on every container boot
- **`claude_md`**: path to a worker-specific CLAUDE.md (e.g. `CLAUDE.worker.md`)
- **`skills_repo`**: name of a cloned repo containing `.claude/skills/` to mount into the container

AskUserQuestion: "Which repos should workers clone on startup? (comma-separated, e.g. org/repo1, org/repo2)"

Update `default.json` with their repos. If they have no specific repos, leave the default.

## 8. Personal Instructions (Optional)

Agent instructions are assembled from repo-level fragments (`instructions/{global,master,worker}.md`) plus optional personal additions. Ask the user if they want to add personal instructions:

AskUserQuestion: "Do you want to add personal agent instructions? (code conventions, repo lists, integrations, etc.) You can always add these later."

If yes:
```bash
mkdir -p ~/.config/nanoclaw/instructions
```

Create `global.md` (applies to all agents), `master.md` (master only), or `worker.md` (workers only) as needed. Help them add their conventions. Reference examples are in `examples/personal-config/instructions/`.

### Personal Dockerfile (Optional)

If the user has heavy packages to install (databases, test frameworks, CLI tools), they can create a personal Dockerfile that layers on top of the base image:

```bash
cat > ~/.config/nanoclaw/Dockerfile << 'EOF'
FROM nanoclaw-agent:base
USER root
# Add your packages here
USER node
EOF
```

`container/build.sh` will automatically detect and apply this layer. Heavy packages that are the same every boot (databases, compilers, test frameworks) go in the Dockerfile. Setup that needs host context (repo cloning, credential symlinks) stays in init.sh. Per-profile tools that depend on workspace content stay in profile tools.

## 9. Optional: Open-Weight Model Support

AskUserQuestion: "Do you want to use open-weight models (e.g. Kimi K2.5, Qwen) in addition to Claude?"

**Yes:** Collect the OpenAI-compatible endpoint URL and API key. Add to `.env`:
```
NEURALWATT_API_URL=<endpoint-url>
NEURALWATT_API_KEY=<api-key>
```

The translation shim converts between Anthropic and OpenAI API formats automatically. Workers can be created with `backend: neuralwatt` to use these models.

**No:** Skip. All workers will use Claude.

## 10. Start Service

Build and install the service:

```bash
npm run build
```

If service already running, stop it first:
- Linux: `systemctl --user stop nanoclaw`
- macOS: `launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist`

Run `npx tsx setup/index.ts --step service` and parse the status block.

**If DOCKER_GROUP_STALE=true:** User was added to docker group after session started. Ask user to run:
```bash
sudo setfacl -m u:$(whoami):rw /var/run/docker.sock
```
Then re-run the service step.

**If SERVICE_LOADED=false:** Read `logs/setup.log`, diagnose, and fix.

## 11. Verify

Run `npx tsx setup/index.ts --step verify` and parse the status block.

Fields to check: `SERVICE`, `CREDENTIALS`, `REGISTERED_GROUPS`, `CONTAINER_RUNTIME`, `CONFIGURED_CHANNELS`, `CHANNEL_AUTH`, `MOUNT_ALLOWLIST`.

Fix any failures by re-running the relevant step. `MOUNT_ALLOWLIST=missing` is non-fatal but means no extra mounts will be allowed in containers (create `~/.config/nanoclaw/mount-allowlist.json` if needed).

Then tell the user:

> Send a message in your `#master` Discord channel: "create a worker called test-worker"
>
> You should see:
> 1. The master agent acknowledges the request
> 2. A new `#test-worker` channel appears in the server
> 3. Sending a message in `#test-worker` spawns a container and the worker responds
>
> If it works, you're all set! Destroy the test worker with: "destroy worker test-worker"

Show: `tail -f logs/nanoclaw.log`

## Troubleshooting

**Service not starting:** Check `logs/nanoclaw.error.log`. Common: wrong Node path, missing `.env` vars, Docker not running.

**Container agent fails:** Ensure Docker is running. Check container logs in `groups/main/logs/container-*.log`.

**No response to messages:** Check trigger pattern. Main channel should have `requires_trigger = 0`. Check `logs/nanoclaw.log`.

**Worker channels not created:** Verify `DISCORD_GUILD_ID` is set in `.env` and the bot has `Manage Channels` permission.

**Unload service:** Linux: `systemctl --user stop nanoclaw` | macOS: `launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist`
