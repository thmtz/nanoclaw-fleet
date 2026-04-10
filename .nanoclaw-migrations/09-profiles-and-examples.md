# Migration Guide: Profiles & Examples

This section documents worker/master profiles and example configurations that users copy to personalize their NanoClaw setup.

---

## worker-profiles/

Directory: `/home/joey/git/nanoclaw-fleet/worker-profiles/`

**Intent:** Repo-side example files that define how workers are created. Users copy these to `~/.config/nanoclaw/worker-profiles/` and customize.

---

### worker-profiles/example.json (MODIFIED)

**Intent:** Example worker profile JSON. Users copy to `~/.config/nanoclaw/worker-profiles/default.json` and edit.

**Contents:**
```json
{
  "name": "example",
  "description": "Example worker profile — copy to ~/.config/nanoclaw/worker-profiles/default.json and customize",

  "repos": [
    {"url": "git@github.com:your-org/your-repo.git", "postClone": "git config core.hooksPath .githooks"}
  ],

  "tools": [
    "uv tool install /workspace/group/your-repo --force"
  ],

  "mounts": [
    {"hostPath": "~/.config/your-tool", "containerPath": "your-tool", "readonly": true}
  ],

  "skills_repo": null,

  "init_script": "init.sh",
  "claude_md": "CLAUDE.worker.md"
}
```

**Fields:**

| Field | Type | Purpose |
|-------|------|---------|
| `name` | string | Profile name (displayed in CLI) |
| `description` | string | Help text |
| `repos` | array | Repos to clone on worker boot |
| `repos[].url` | string | Git URL (supports SSH or HTTPS) |
| `repos[].postClone` | string | Optional: run after clone (e.g., git config) |
| `tools` | array | Commands to run after repos (uv install, pip, npm, etc.) |
| `mounts` | array | Host directories to bind-mount into worker |
| `mounts[].hostPath` | string | Host path (supports `~` expansion) |
| `mounts[].containerPath` | string | Container path (relative to `/workspace/extra/`) |
| `mounts[].readonly` | bool | Read-only mount |
| `skills_repo` | string or null | Optional: clone skills from this URL to `~/.claude/skills/` |
| `init_script` | string | Which init.sh to use (path relative to profile dir) |
| `claude_md` | string | Which CLAUDE.md to use (path relative to profile dir) |

**How to apply:**

1. Copy to personal config:
   ```bash
   cp /home/joey/git/nanoclaw-fleet/worker-profiles/example.json \
      ~/.config/nanoclaw/worker-profiles/default.json
   ```

2. Edit with your repos, tools, mounts:
   ```json
   {
     "name": "my-dev-worker",
     "repos": [
       {"url": "git@github.com:myorg/my-project.git"},
       {"url": "git@github.com:myorg/my-tools.git"}
     ],
     "tools": [
       "cd /workspace/group/my-tools && uv tool install . --force"
     ],
     "mounts": [
       {"hostPath": "~/.ssh", "containerPath": "host-ssh", "readonly": true},
       {"hostPath": "~/.config/myapp", "containerPath": "myapp-config"}
     ]
   }
   ```

3. Create workers:
   ```bash
   ncf create my-worker              # Uses default.json
   ncf create my-worker --profile custom  # Uses custom.json (if exists)
   ```

---

### worker-profiles/init.sh (MODIFIED)

**Intent:** Script that runs inside worker container on first boot. Handles SSH setup, repo cloning, and tool installation.

**Key sections:**

#### Symlink mounted configs (lines 25–34)
```bash
for dir in /workspace/extra/*/; do
  [ -d "$dir" ] || continue
  name=$(basename "$dir")
  ln -sfn "$dir" ~/.config/"$name"
done
```

All mounted directories (from `mounts` in profile) are symlinked to `~/.config/`. Example: `hostPath: ~/.config/myapp` becomes `~/.config/myapp` inside container.

#### SSH key setup (lines 36–58)
Priority order:
1. Host's SSH key (`/workspace/extra/host-ssh/id_ed25519`)
2. Workspace copy (`/workspace/group/.ssh/id_ed25519`)
3. Generate new key (fallback)

Allows workers to use the same SSH key registered with GitHub/cloud providers.

#### Repo cloning (lines 60–80+)
```bash
IFS='|' read -ra REPOS <<< "$WORKER_REPOS"
for repo_url in "${REPOS[@]}"; do
  [ ! -d "$repo_name" ] && git clone "$repo_url" 2>&1 &
done
# Wait for all clones to finish
```

- Values passed via `WORKER_REPOS` env var (pipe-separated, due to docker -e parsing limits)
- Clones in parallel
- Idempotent: skips if directory already exists
- Includes timing profiling (logged to stderr)

#### Tool installation (lines 80+)
```bash
for tool_cmd in "${TOOL_COMMANDS[@]}"; do
  eval "$tool_cmd"
done
```

Runs commands from `tools` array in profile (e.g., `uv tool install`, `pip install`).

**Environment variables passed by container-runner:**
- `WORKER_REPOS` — pipe-separated URLs
- `WORKER_TOOLS` — pipe-separated commands
- `WORKER_MOUNTS` — JSON array of mount configs
- `WORKER_SKILLS_REPO` — optional skills repo URL

**Timing profiling:**
All steps logged to stderr with elapsed milliseconds. Captured by container entrypoint and systemd logs:
```bash
[init +245ms] start
[init +456ms] configs symlinked
[init +789ms] ssh keys
[init +1234ms] repos cloned
[init +2345ms] tools installed
```

**How to apply:**
- Already baked into container
- Customization: edit `/home/joey/git/nanoclaw-fleet/worker-profiles/init.sh`, rebuild container (`container/build.sh`)
- Personal overrides: copy to `~/.config/nanoclaw/worker-profiles/init.sh` and reference in profile JSON

---

### worker-profiles/CLAUDE.worker.example.md (MODIFIED)

**Intent:** Example system prompt for worker agents. Users customize and reference in profile JSON.

**Sections:**

1. **How You Got Here**
   - Explains master/worker relationship
   - Defines terminology (master, worker, profile, template, init.sh)

2. **Continuous Improvement**
   - Emphasizes friction reporting
   - Beads workflow if enabled (`BEADS_ENABLED=1`)
   - Goal: next worker never hits same snag

3. **Inference Backend**
   - Clarifies: system prompt may claim "Claude Opus" (SDK default)
   - Use `get_backend` MCP tool to check actual model
   - Explains Neuralwatt behavior differences (OSS models)

4. **Environment**
   - Container ephemeral but workspace persistent
   - Session state bind-mounted (survives restart)
   - Network access (git, pip, npm)
   - Host reachable at `host.docker.internal`

5. **Tools & Workspace** (later sections)
   - Repos cloned to `/workspace/group/`
   - Mounts at `/workspace/extra/`
   - MCP tools available (send_message, schedule_task, etc.)

6. **Messaging & Sessions**
   - How to send messages to user/group
   - How to check conversation context
   - When to ask for input vs. proceed

7. **Testing & Debugging**
   - How to verify work
   - Container logs and troubleshooting
   - When to reach out to user

**How to apply:**

1. Copy example:
   ```bash
   cp /home/joey/git/nanoclaw-fleet/worker-profiles/CLAUDE.worker.example.md \
      ~/.config/nanoclaw/worker-profiles/CLAUDE.worker.md
   ```

2. Edit to match your needs:
   - Add company/team context
   - Clarify which tools are available
   - Add custom behavior guidelines
   - Include project-specific knowledge

3. Reference in profile JSON:
   ```json
   {
     "claude_md": "CLAUDE.worker.md"
   }
   ```

4. When workers are created, this file is assembled into their system prompt.

---

## master-profiles/

Directory: `/home/joey/git/nanoclaw-fleet/master-profiles/`

**Intent:** Repo-side example system prompt for the master agent. Users copy to `~/.config/nanoclaw/instructions/CLAUDE.master.md` and customize.

---

### master-profiles/CLAUDE.master.example.md (MODIFIED)

**Intent:** System prompt for master orchestrator agent (runs in #master Discord channel).

**Key sections:**

1. **Communication Style**
   - Always acknowledge immediately (ack before work)
   - Keep messages brief (mobile-first)
   - Long-running tasks: run in background
   - Use `send_message` for Discord replies, wrap in `<internal>` tags

2. **Worker Management**
   - ncf CLI commands (create, destroy, switch, logs, etc.)
   - MCP tools (send_message, schedule_task, list_tasks, etc.)
   - When to ask for confirmation vs. proceed

3. **Inference Backends**
   - Default: Claude (Anthropic)
   - `ncf create test-oss --backend neuralwatt --model some-org/some-model`
   - Model discovery via `/models` endpoint on shim
   - Fuzzy matching for user queries

4. **Docker Access**
   - Build container: `cd /workspace/project/container && ./build.sh`
   - Inspect workers: `docker ps --filter name=nanoclaw`
   - View logs: `docker logs <container-name>`
   - Debug: `docker exec -it <container-name> bash`

5. **Working on NanoClaw Code**
   - Repo location: `/workspace/project/`
   - Key docs: CLAUDE.md, docs/architecture/, docs/guides/testing.md
   - E2E verification: use `ncf inject`, `ncf switch`, etc.
   - Always check logs after testing

**How to apply:**

1. Copy to personal config:
   ```bash
   cp /home/joey/git/nanoclaw-fleet/master-profiles/CLAUDE.master.example.md \
      ~/.config/nanoclaw/instructions/CLAUDE.master.md
   ```

2. Customize:
   - Add company/org context
   - Clarify team processes
   - Add custom worker management rules
   - Link to internal docs/wikis

3. Master uses this on startup (loaded by master-agent.ts in main codebase).

---

## examples/personal-config/

Directory: `/home/joey/git/nanoclaw-fleet/examples/personal-config/`

**Intent:** Example of what goes in `~/.config/nanoclaw/` (user's personal config directory).

---

### examples/personal-config/config.json

**Intent:** Metadata for personal config (not used internally, informational).

**Contents:**
```json
{
  "type": "nanoclaw-personal-config",
  "version": "1.0.0",
  "description": "Personal NanoClaw configuration"
}
```

### examples/personal-config/Dockerfile

**Intent:** Optional personal Dockerfile that layers on top of `nanoclaw-agent:base`.

**Purpose:** Add personal tools/system deps without modifying repo Dockerfile.

**Example:**
```dockerfile
FROM nanoclaw-agent:base

# Install personal CLI tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    ripgrep \
    fd-find \
    && rm -rf /var/lib/apt/lists/*

# Install Python packages globally
RUN pip install --no-cache-dir \
    anthropic \
    pandas \
    requests
```

Build: `container/build.sh` automatically detects and layers this.

### examples/personal-config/instructions/

**Intent:** Example of personal instructions directory.

**Contents:**
- `CLAUDE.master.md` — master agent system prompt
- `CLAUDE.worker.md` — worker agent system prompt
- `CLAUDE.global.md` — appended to all agents

These override repo defaults if present at `~/.config/nanoclaw/instructions/`.

### examples/personal-config/worker-profiles/

**Intent:** Example worker profiles (users copy and customize).

**Typical setup:**
```
~/.config/nanoclaw/worker-profiles/
├── default.json           # Used by ncf create (no --profile)
├── neuralwatt.json        # ncf create --profile neuralwatt
└── heavy-compute.json     # ncf create --profile heavy-compute
```

---

## How to Set Up Personal Config

```bash
# 1. Copy example config
mkdir -p ~/.config/nanoclaw
cp -r /home/joey/git/nanoclaw-fleet/examples/personal-config/* \
    ~/.config/nanoclaw/

# 2. Customize profiles
vi ~/.config/nanoclaw/worker-profiles/default.json
# Edit repos, tools, mounts

# 3. Customize system prompts
vi ~/.config/nanoclaw/instructions/CLAUDE.master.md
vi ~/.config/nanoclaw/instructions/CLAUDE.worker.md

# 4. Optional: add personal Dockerfile
vi ~/.config/nanoclaw/Dockerfile
# Add your system deps / global tools

# 5. Build container (includes personal layer)
/home/joey/git/nanoclaw-fleet/container/build.sh

# 6. Create a worker
ncf create test-worker
```

---

## Summary of Profiles & Examples

| File/Dir | Type | Purpose | Location |
|----------|------|---------|----------|
| example.json | Config | Worker profile template | `worker-profiles/` |
| init.sh | Script | Worker boot script | `worker-profiles/` |
| CLAUDE.worker.example.md | Prompt | Worker system prompt | `worker-profiles/` |
| CLAUDE.master.example.md | Prompt | Master system prompt | `master-profiles/` |
| personal-config/ | Example | Full config directory example | `examples/` |
| ~/.config/nanoclaw/ | User | Personal config (created by user) | Home |

