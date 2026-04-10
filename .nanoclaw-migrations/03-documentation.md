# Migration Guide: Documentation and Instructions

## Documentation Files (docs/)

### docs/README.md
**Purpose:** Index of all documentation files with navigation guide.

**How to apply:** Copy from main tree. No customization needed.

### Architecture Documentation (docs/architecture/)

These files describe system behavior and design decisions. Safe to copy from main tree without modification.

#### docs/architecture/overview.md
**Purpose:** High-level goals, design principles, and system overview.

**Dependencies:** None (purely descriptive).

**How to apply:** Copy from main tree.

#### docs/architecture/container-lifecycle.md
**Purpose:** Worker container creation, destruction, resumption, and state management.

**Dependencies:** None (describes lifecycle stages and state transitions).

**How to apply:** Copy from main tree.

#### docs/architecture/inference-routing.md
**Purpose:** How agents route inference requests between Anthropic API and Neuralwatt backends.

**Dependencies:** References `src/inference-router.ts` code paths, but describes them at a conceptual level.

**How to apply:** Copy from main tree. If you modify inference routing, update this doc.

#### docs/architecture/model-discovery.md
**Purpose:** How workers discover available models, fuzzy matching, and model capabilities.

**Dependencies:** References model registry and matching logic.

**How to apply:** Copy from main tree. If you add model providers or change matching, update this.

#### docs/architecture/streaming-shim.md
**Purpose:** SSE streaming translation from Claude SDK format to agent-runner protocol.

**Dependencies:** References protocol formats and stream handling.

**How to apply:** Copy from main tree. If you change streaming format, update this.

#### docs/architecture/energy-tracking.md
**Purpose:** How worker energy usage is tracked, reported, and persisted in logs.

**Dependencies:** References `logs/workers/<folder>/turns.jsonl` format and calculations.

**How to apply:** Copy from main tree. If you add or modify energy metrics, update this.

### Guide Documentation (docs/guides/)

These guide users through operational tasks. Copy from main tree.

#### docs/guides/setup.md
**Purpose:** Step-by-step first-time installation, authentication, and service configuration.

**Dependencies:** References `.env.example`, `setup.sh`, systemd/launchd templates.

**How to apply:** Copy from main tree. Verify paths and env var names match your setup.

#### docs/guides/testing.md
**Purpose:** E2E testing procedures: create workers, message them, destroy them, verify logs.

**Dependencies:** References `ncf` CLI commands and their behavior.

**How to apply:** Copy from main tree. If you add new testable behaviors, document them here.

#### docs/guides/personal-config.md
**Purpose:** How to separate repo (reusable) from personal config (secrets, custom settings).

**Dependencies:** References `~/.config/nanoclaw/` directory structure and override paths.

**How to apply:** Copy from main tree. This describes the configuration philosophy.

#### docs/guides/troubleshooting.md
**Purpose:** Common issues, diagnostic commands, and solutions.

**Dependencies:** References log paths and `ncf` commands.

**How to apply:** Copy from main tree. Add new troubleshooting sections if you discover issues.

### Reference Documentation (docs/reference/)

#### docs/reference/cli.md
**Purpose:** Complete `ncf` CLI command reference (status, logs, create, destroy, restart, inject, etc.).

**Dependencies:** Documents the CLI in `src/cli.ts`.

**How to apply:** Copy from main tree. If you add CLI commands, document them here with examples and exit codes.

#### docs/reference/sdk-internals.md
**Purpose:** Internal details of SDK structure, channel registration, message routing.

**Dependencies:** References internal code structure.

**How to apply:** Copy from main tree. Update if you modify core SDK internals.

### Upstream Reference Documentation (docs/upstream/)

These are reference docs from the upstream NanoClaw project. Safe to copy as-is; they describe design choices and architecture evolution.

**How to apply:** Copy entire `docs/upstream/` directory from main tree. These are read-only reference.

---

## Instructions (instructions/)

These are Claude Agent instructions that govern how the system behaves. Keep synchronized with code changes.

### instructions/global.md
**Purpose:** Global instructions that all agents (master and workers) follow.

**Dependencies:** References tool definitions, API boundaries, and general behavior rules.

**How to apply:** Copy from main tree. If you add new tools or change fundamental behavior, update this.

**When to customize (in `~/.config/nanoclaw/instructions/global.md`):**
- Add organization-specific policies
- Change tone or communication style
- Restrict or enable capabilities per your deployment

### instructions/master.md
**Purpose:** Master agent instructions (runs in main Node.js process, not containerized).

**Dependencies:** References capabilities available to master (filesystem, Docker control, skill system).

**How to apply:** Copy from main tree. If you change what the master can do, update here.

**When to customize (in `~/.config/nanoclaw/instructions/master.md`):**
- Change how master responds to messages
- Add or remove master-only capabilities
- Customize per-channel behavior

### instructions/worker.md
**Purpose:** Worker agent instructions (runs in containers, has containerized tool access).

**Dependencies:** References containerized tools (code execution, model inference, etc.).

**How to apply:** Copy from main tree. If you add container tools, update this.

**When to customize (in `~/.config/nanoclaw/instructions/worker.md`):**
- Change how workers solve problems
- Add special behaviors per model or backend
- Customize tool usage priorities

---

## Top-Level Documentation Files

### CLAUDE.md
**Purpose:** Project conventions, workflow guidance, development practices for Claude Code sessions.

**Files in repo:**
- `CLAUDE.md` — Public project instructions (checked in)
- `CLAUDE.local.md` — Private local notes (git-ignored, per clone)

**How to apply:**

1. **Copy CLAUDE.md from main tree** — Contains workflow conventions, skill guide, git rules, debugging tips.

2. **Create CLAUDE.local.md** (optional, git-ignored) — Add local-only notes:
   ```markdown
   # Local Development Notes

   ## Repo vs. Personal Config
   - Repo: reusable code, architecture docs, example profiles
   - Config: personal tokens, custom profiles, local overrides

   ## Upstream Reference
   Reference upstream at ~/git/reference/nanoclaw-upstream/

   ## Beads Integration
   Task tracking via `bd ready`, `bd create`, `bd close`
   ```

**How to customize:** Edit `CLAUDE.local.md` for notes specific to your development environment.

### README.md
**Purpose:** Project overview, quick-start guide, feature highlights.

**Dependencies:** None (mostly marketing/overview text).

**How to apply:** Copy from main tree. This is the public-facing intro.

**When to update:** If you add major features, update the feature list.

### README_zh.md
**Purpose:** Simplified Chinese translation of README.md.

**How to apply:** Copy from main tree. Only needed if supporting Chinese-language users.

### AGENTS.md
**Purpose:** Overview of agent roles: master (main process) vs. workers (containers).

**Dependencies:** References agent architecture and responsibilities.

**How to apply:** Copy from main tree. Describes the agent model at a high level.

### CONTRIBUTING.md
**Purpose:** Contribution guidelines for collaborators (PR process, commit style, testing requirements).

**How to apply:** Copy from main tree. This is a social contract with contributors.

### CONTRIBUTORS.md
**Purpose:** List of contributors and their contributions (credits).

**How to apply:** Copy from main tree. Add yourself if you make substantive changes.

### CHANGELOG.md
**Purpose:** Version history, breaking changes, new features per release.

**How to apply:** Copy from main tree. Update when tagging releases.

---

## Configuration Dependencies Reference

### Files that may need updates if you modify code:

| Code Module | Documentation to Update |
|-|-|
| `src/inference-router.ts` | `docs/architecture/inference-routing.md` |
| `src/cli.ts` | `docs/reference/cli.md`, `CLAUDE.md` (quick reference) |
| Worker container startup | `docs/architecture/container-lifecycle.md`, `docs/guides/testing.md` |
| Energy tracking logic | `docs/architecture/energy-tracking.md` |
| Streaming format | `docs/architecture/streaming-shim.md` |
| New tool definitions | `instructions/*.md` |
| Model discovery logic | `docs/architecture/model-discovery.md` |

---

## Documentation Application Checklist

### Fresh Clone Setup

```bash
# 1. Copy all documentation from main tree
rsync -av docs/ /path/to/your/clone/docs/
rsync -av instructions/ /path/to/your/clone/instructions/
cp CLAUDE.md /path/to/your/clone/
cp README.md AGENTS.md CONTRIBUTING.md /path/to/your/clone/

# 2. Create local-only notes (git-ignored)
cat > CLAUDE.local.md <<'EOF'
# Local Development Notes

## This Repo

Public fork at /path/to/nanoclaw-fleet

## Upstream Reference

qwibitai/nanoclaw at ~/git/reference/nanoclaw-upstream/

## Personal Config

~/.config/nanoclaw/ contains:
- Custom instructions/
- Worker profiles
- Auth tokens
EOF

# 3. Verify structure
ls docs/architecture/ docs/guides/ docs/reference/
ls instructions/
cat CLAUDE.md
```

### After Code Changes

If you modify any of these:
- Inference routing → Update `docs/architecture/inference-routing.md`
- CLI commands → Update `docs/reference/cli.md` and `CLAUDE.md` (quick ref section)
- Container lifecycle → Update `docs/architecture/container-lifecycle.md`
- Energy metrics → Update `docs/architecture/energy-tracking.md`
- Streaming format → Update `docs/architecture/streaming-shim.md`
- Tool definitions → Update `instructions/*.md`

### Before Merging PRs

1. Check if code changes warrant doc updates (use the table above)
2. Update affected docs in the same PR
3. Verify links in CLAUDE.md point to correct doc paths
4. Test that referenced commands (e.g., `ncf status`) still work

---

## Documentation Customization Strategy

### What to Keep from Main Tree (No Customization)

- `docs/architecture/` — Pure design docs
- `docs/upstream/` — Reference material
- `docs/guides/setup.md`, `docs/guides/testing.md` — Universal procedures
- `README.md`, `AGENTS.md`, `CONTRIBUTING.md` — Project identity

### What to Customize Locally

**Not checked in** (use `CLAUDE.local.md`):
- Development environment notes
- Upstream reference paths
- Personal task tracking setup

**Checked in but customizable** (in `~/.config/nanoclaw/instructions/`):
- `global.md` — Add org policies, tone adjustments
- `master.md` — Master-specific behaviors
- `worker.md` — Worker-specific behaviors

---

## Quick Navigation Map

**First time?**
- Start: `docs/README.md`
- Overview: `docs/architecture/overview.md`
- Setup: `docs/guides/setup.md`

**Adding a feature?**
- Architecture impact: Update `docs/architecture/overview.md`
- Operational procedures: Update `docs/guides/testing.md`
- Agent behavior: Update `instructions/*.md`
- User-facing CLI: Update `docs/reference/cli.md`

**Debugging an issue?**
- Logs and tools: `docs/guides/troubleshooting.md`
- Lifecycle issues: `docs/architecture/container-lifecycle.md`
- Inference issues: `docs/architecture/inference-routing.md`

**Contributing?**
- Guidelines: `CONTRIBUTING.md`
- Review process: `.github/PULL_REQUEST_TEMPLATE.md`
- Code owners: `.github/CODEOWNERS`
