# Migration Guide: Infrastructure and Service Management

## Systemd Service (Linux)

### nanoclaw.service

**Intent:** Run NanoClaw as a user-level systemd service with auto-restart and logging.

**Files:** `systemd/nanoclaw.service` (template)

**Template Variables:**
- `{{PROJECT_ROOT}}` — Absolute path to NanoClaw installation
- `{{NODE_PATH}}` — Absolute path to node binary (e.g., `/usr/local/bin/node`)
- `{{HOME}}` — User home directory

**How to apply:**

1. Copy template to user systemd directory:
```bash
mkdir -p ~/.config/systemd/user
cp systemd/nanoclaw.service ~/.config/systemd/user/nanoclaw.service
```

2. Replace template variables (using sed or manual edit):
```bash
PROJECT_ROOT="$(cd nanoclaw-fleet && pwd)"
NODE_PATH="$(which node)"
HOME_DIR="$HOME"

sed -i.bak \
  -e "s|{{PROJECT_ROOT}}|$PROJECT_ROOT|g" \
  -e "s|{{NODE_PATH}}|$NODE_PATH|g" \
  -e "s|{{HOME}}|$HOME_DIR|g" \
  ~/.config/systemd/user/nanoclaw.service
```

3. Enable and start:
```bash
systemctl --user daemon-reload
systemctl --user enable nanoclaw
systemctl --user start nanoclaw
```

4. Verify:
```bash
systemctl --user status nanoclaw
journalctl --user -u nanoclaw -f
```

**Key Configuration:**
- `Type=simple` — Process runs in foreground
- `WorkingDirectory={{PROJECT_ROOT}}` — Sets working dir for logs and data
- `Restart=always` — Auto-restart on exit
- `RestartSec=5` — Wait 5 seconds between restarts
- `KillMode=process` — Kill only main process (not children)
- `Environment=ASSISTANT_NAME=NanoClaw` — Bot identity
- Comment out `EnvironmentFile` line if not using external `.env` file
- Comment out `NANOCLAW_GITHUB_TOKEN_PATH` if not using private repos

**Optional: Set GitHub Token via Systemd**

If workers need to clone private repos, add to service file:
```ini
Environment=NANOCLAW_GITHUB_TOKEN_PATH={{HOME}}/.config/nanoclaw/github_token
```

Then create the token file:
```bash
mkdir -p ~/.config/nanoclaw
echo "your-github-pat-here" > ~/.config/nanoclaw/github_token
chmod 600 ~/.config/nanoclaw/github_token
```

---

## LaunchD Service (macOS)

### com.nanoclaw.plist

**Intent:** Run NanoClaw as a background service on macOS using launchd with auto-restart and logging.

**Files:** `launchd/com.nanoclaw.plist` (template)

**Template Variables:**
- `{{PROJECT_ROOT}}` — Absolute path to NanoClaw installation
- `{{NODE_PATH}}` — Absolute path to node binary
- `{{HOME}}` — User home directory

**How to apply:**

1. Copy template to launchd directory:
```bash
mkdir -p ~/Library/LaunchAgents
cp launchd/com.nanoclaw.plist ~/Library/LaunchAgents/
```

2. Replace template variables:
```bash
PROJECT_ROOT="$(cd nanoclaw-fleet && pwd)"
NODE_PATH="$(which node)"

sed -i '' \
  -e "s|{{PROJECT_ROOT}}|$PROJECT_ROOT|g" \
  -e "s|{{NODE_PATH}}|$NODE_PATH|g" \
  -e "s|{{HOME}}|$HOME|g" \
  ~/Library/LaunchAgents/com.nanoclaw.plist
```

3. Load the service:
```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

4. Verify:
```bash
launchctl list | grep com.nanoclaw
tail -f ~/Library/Logs/com.nanoclaw.log
```

5. Manage the service:
```bash
# Restart
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Unload
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist

# Load again
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

**Key Configuration:**
- `Label` — Service identifier (com.nanoclaw)
- `RunAtLoad` — Start on login
- `KeepAlive` — Auto-restart on exit
- `StandardOutPath` — Pretty-printed logs to `logs/nanoclaw.log`
- `StandardErrorPath` — Error logs to `logs/nanoclaw.error.log`
- `EnvironmentVariables` — Set PATH and assistant name

---

## Git Hooks

### pre-push Hook

**Intent:** Prevent direct pushes to `main`, enforce code quality before push.

**Files:** `.githooks/pre-push` (executable)

**How to apply:**

1. One-time configuration per clone:
```bash
git config core.hooksPath .githooks
```

2. Verify:
```bash
cat .git/config | grep hooksPath
```

**Behavior:**

The hook performs these checks in order:

1. **Block direct pushes to main**
   - Reads stdin for push refs
   - If target is `refs/heads/main`, fails unless `ALLOW_MAIN=1` is set
   - Message: "Direct push to 'main' is blocked. Use a feature branch and open a PR instead."
   - Exception (emergency only): `ALLOW_MAIN=1 git push`

2. **Format checking**
   - Runs `npm run format:check`
   - Fails if any files need formatting
   - Fix: `npm run format`

3. **Type checking (host)**
   - Runs `npx tsc --noEmit` on `src/`
   - Fails if TypeScript errors exist

4. **Type checking (agent-runner)**
   - Checks if `container/agent-runner/node_modules` exists
   - If yes, runs `tsc --noEmit` in that directory
   - Warns if dependencies not installed (skip this check)

Exit codes:
- 0: All checks passed
- 1: Format or type errors (fix and retry)
- 2: Would push to main (use feature branch)

---

## Setup Script

### setup.sh

**Intent:** Bootstrap NanoClaw installation on a fresh clone. Detects platform, installs Node.js, handles native modules.

**Files:** `setup.sh` (executable bash script)

**Location:** Project root

**How to apply:**

Run once on fresh clone:
```bash
bash setup.sh
```

**What it does:**

1. **Platform detection**
   - Identifies macOS or Linux
   - Detects WSL (Windows Subsystem for Linux)
   - Checks if running as root

2. **Node.js validation**
   - Checks if `node` exists and is v20+
   - Exits with status 2 if Node.js is missing or too old

3. **Dependencies installation**
   - Runs `npm ci` (clean install)
   - Automatically uses `--unsafe-perm` if running as root
   - Verifies `better-sqlite3` loads (native module)

4. **Build tools check**
   - macOS: Verifies Xcode command-line tools
   - Linux: Checks for `gcc` and `make`

**Output:**
Prints status block summarizing:
```
PLATFORM: linux|macos
IS_WSL: true|false
IS_ROOT: true|false
NODE_VERSION: x.y.z
NODE_OK: true|false
DEPS_OK: true|false
NATIVE_OK: true|false
HAS_BUILD_TOOLS: true|false
STATUS: success|node_missing|deps_failed|native_failed
```

Logs details to `logs/setup.log`.

**Exit codes:**
- 0: Success
- 1: Dependencies or native modules failed
- 2: Node.js missing or too old

---

## Container Build System

### container/build.sh

**Intent:** Build Docker image for agent containers with optional personal customization layer.

**Files:** `container/build.sh`, `container/Dockerfile`, `~/.config/nanoclaw/Dockerfile` (optional)

**How to apply:**

1. Build base image:
```bash
cd nanoclaw-fleet
bash container/build.sh
```

   This creates `nanoclaw-agent:latest` from `container/Dockerfile`.

2. **Optional: Add personal layer**
   Create `~/.config/nanoclaw/Dockerfile`:
   ```dockerfile
   FROM nanoclaw-agent:base
   # Your custom additions
   RUN apt-get install -y custom-tool
   ```

   Rebuild (will layer personal Dockerfile on top):
   ```bash
   bash container/build.sh
   ```

3. Tag custom version:
```bash
bash container/build.sh v1.2.3
```

This creates `nanoclaw-agent:v1.2.3`.

**Rebuild after:**
- Changes to `container/agent-runner/` source (TypeScript, deps)
- Changes to `container/Dockerfile`
- Any system package changes in Dockerfile

**Test the build:**
```bash
echo '{"prompt":"What is 2+2?","groupFolder":"test","chatJid":"test@g.us","isMain":false}' | \
  docker run -i nanoclaw-agent:latest
```

---

## Container Entrypoint

### container/entrypoint.sh

**Intent:** Container startup sequence: run init script, compile TypeScript if needed, start agent.

**Files:** `container/entrypoint.sh` (executable bash script)

**Key behaviors:**

1. **Worker init script** (if mounted)
   - Looks for `/workspace/init.sh` (from `worker-profiles/init.sh` mount)
   - Runs if executable (sets up repos, tools, credentials)
   - Continues even if init fails (logs warning)

2. **TypeScript compilation with caching**
   - Checks if `/app/dist/index.js` exists
   - Computes hash of all `.ts` files in `/app/src`
   - Compares to saved hash in `/app/dist/.src-hash`
   - Only recompiles if source changed
   - Saves new hash after compilation

3. **Timing telemetry** (stderr)
   - All timing output goes to stderr
   - Logs structure: `[entrypoint +XXXms] <message>`
   - Host captures these for startup telemetry

4. **Agent startup**
   - Reads JSON input from stdin (agent request)
   - Pipes to `node /app/dist/index.js`

**Performance note:**
Build the image (`container/build.sh`) after agent-runner changes to avoid 2-3s TypeScript recompilation on every spawn.

---

## GitHub Configuration

### CODEOWNERS

**Intent:** Specify code review requirements for different file areas.

**Files:** `.github/CODEOWNERS`

**Content:**
```
# Core code
/src/
/container/
/groups/
/launchd/
/package.json
/package-lock.json

# Skills - open to contributors
/.claude/skills/
```

**How to apply:**
File already committed. When PRs modify core code, GitHub automatically requests review from CODEOWNERS (currently the repo maintainer). Skills are open for community contributions without owner review.

### PULL_REQUEST_TEMPLATE.md

**Intent:** Guide PR authors on PR types and requirements.

**Files:** `.github/PULL_REQUEST_TEMPLATE.md`

**How to apply:**
File already committed. When authors create a PR, GitHub auto-fills the template. Authors check boxes for PR type and confirm testing.

### CI Workflow

**Intent:** Automated testing on all PRs targeting main.

**Files:** `.github/workflows/ci.yml`

**Workflow steps:**
1. Check out code
2. Setup Node.js 20
3. Run `npm ci`
4. Format check: `npm run format:check`
5. Type-check: `npx tsc --noEmit`
6. Tests: `npx vitest run`

**How to apply:**
File already committed. CI runs automatically on all PRs. Pre-push hook mimics these checks locally.

---

## Directory Structure Summary

```
nanoclaw-fleet/
├── systemd/
│   └── nanoclaw.service          # Linux systemd template
├── launchd/
│   └── com.nanoclaw.plist        # macOS launchd template
├── .githooks/
│   └── pre-push                  # Git pre-push validation hook
├── .github/
│   ├── CODEOWNERS                # Review requirements
│   ├── PULL_REQUEST_TEMPLATE.md  # PR guidance
│   └── workflows/
│       └── ci.yml                # GitHub Actions CI
├── container/
│   ├── build.sh                  # Docker build script
│   ├── entrypoint.sh             # Container startup
│   ├── Dockerfile                # Base image definition
│   └── agent-runner/             # Agent SDK code
├── setup.sh                       # Bootstrap script
├── package.json                   # Node.js project metadata
└── logs/                          # Runtime logs (generated)
```

---

## Quick Checklist: Setting Up on New Machine

```bash
# 1. Clone repo
git clone <repo-url>
cd nanoclaw-fleet

# 2. Bootstrap
bash setup.sh
npm ci

# 3. Setup git hooks
git config core.hooksPath .githooks

# 4. (Linux) Install systemd service
mkdir -p ~/.config/systemd/user
cp systemd/nanoclaw.service ~/.config/systemd/user/
# Edit and replace {{...}} variables
systemctl --user daemon-reload
systemctl --user enable nanoclaw

# 5. (macOS) Install launchd service
mkdir -p ~/Library/LaunchAgents
cp launchd/com.nanoclaw.plist ~/Library/LaunchAgents/
# Edit and replace {{...}} variables
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist

# 6. Build container
bash container/build.sh

# 7. Test
npm run test
npm run build

# 8. Start service (if needed)
# Linux: systemctl --user start nanoclaw
# macOS: launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```
