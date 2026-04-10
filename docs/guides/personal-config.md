# Personal Configuration Guide

NanoClaw separates reusable code (the repo) from per-installation config (`~/.config/nanoclaw/`). This guide explains the config system, what goes where, and how to set up your own.

A complete reference example lives at [`examples/personal-config/`](../../examples/personal-config/).

## Why Personal Config?

The repo ships with generic agent instructions, example profiles, and a base container image. Your personal config layers on top: which repos your workers clone, which tools are pre-installed, what coding conventions your agents follow, and what credentials are mounted. Because personal config lives outside the repo, pulling upstream updates never overwrites your setup.

## Directory Structure

```
~/.config/nanoclaw/
├── config.json                   # Personal config (include_files, etc.)
├── Dockerfile                    # Personal container image layer (optional)
├── instructions/
│   ├── global.md                 # Instructions for ALL agents (master + workers)
│   ├── master.md                 # Master-only instructions
│   └── worker.md                 # Worker-only instructions
├── worker-profiles/
│   ├── default.json              # Worker profile (repos, tools, mounts, ports)
│   └── init.sh                   # Boot script (runs every container start)
└── mount-allowlist.json          # Allowed host paths for container mounts
```

## How Instructions Are Assembled

Each agent's `CLAUDE.md` is assembled from four fragments at startup:

```
1. instructions/global.md          (repo, shared, all agents)
2. instructions/{master,worker}.md (repo, shared, role-specific)
3. ~/.config/nanoclaw/instructions/global.md   (personal, all agents)
4. ~/.config/nanoclaw/instructions/{master,worker}.md (personal, role-specific)
```

Repo instructions set baseline behavior (communication style, first-boot, workspace layout). Personal instructions add your conventions (code design, PR workflow, repo list, mount map). You never edit repo instructions for personal preferences; add a personal fragment instead.

**How they reach the model**: The assembled CLAUDE.md is read by the agent-runner at startup and injected into `systemPrompt.append`. This puts it in the actual system prompt, which is sent on **every** API call and survives context compaction. Files from `include_files` in personal config take the same path. Both are durable across compaction.

### Including External Files

If you have a global `~/.claude/CLAUDE.md` with coding conventions you want all agents to follow, include it via `config.json`:

```json
{
  "include_files": ["~/.claude/CLAUDE.md"]
}
```

Included files are passed to the SDK via `systemPrompt.append`, which guarantees they survive conversation compaction. This is safer than writing to CLAUDE.md directly, which gets loaded via `settingSources` and could potentially be trimmed during long sessions.

## Worker Profile

The worker profile (`default.json`) controls what each worker container gets:

```json
{
  "name": "default",
  "repos": [
    {
      "url": "git@github.com:your-org/your-repo.git",
      "postClone": "git config core.hooksPath .githooks"
    }
  ],
  "tools": ["uv tool install /workspace/group/your-tool --force"],
  "mounts": [
    { "hostPath": "~/.ssh", "containerPath": "host-ssh", "readonly": true }
  ],
  "ports": ["8080:8080"],
  "skills_repo": "your-skills-repo-name"
}
```

| Field         | Purpose                                                                             |
| ------------- | ----------------------------------------------------------------------------------- |
| `name`        | Profile name (used to select non-default profiles).                                 |
| `repos`       | Git repos cloned on first boot. `postClone` runs after each clone.                  |
| `tools`       | Shell commands run during init (package installs, CLI setup).                       |
| `mounts`      | Host directories mounted into the container. Must be on the allowlist.              |
| `ports`       | Docker port mappings (`host:container`).                                            |
| `skills_repo` | Name of a cloned repo containing Claude skills. Symlinked into `~/.claude/skills/`. |

## Personal Dockerfile

If your workers need system packages (databases, compilers, language runtimes), add a personal Dockerfile:

```dockerfile
FROM nanoclaw-agent:base

USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    postgresql redis-server \
    && rm -rf /var/lib/apt/lists/*

RUN uv pip install --system --break-system-packages pytest httpx

USER node
```

`container/build.sh` automatically layers this on top of the base image if it exists at `~/.config/nanoclaw/Dockerfile`.

## What Goes Where

The rule of thumb: if removing it would break NanoClaw for any user, it belongs in the repo. If it only matters for your setup, it's personal config. The [setup guide](setup.md#repo-vs-user-config) has the full breakdown.

## Getting Started

The examples at `examples/personal-config/` show a realistic config. To use them as a starting point:

```bash
cp -r examples/personal-config/ ~/.config/nanoclaw/
```

Then customize each file for your setup. At minimum, edit `worker-profiles/default.json` to point at your repos, and `instructions/global.md` to set your GitHub username. The [setup guide](setup.md) walks through each file in detail.

After changes, rebuild the container image (if you added a Dockerfile) and restart NanoClaw:

```bash
cd container && ./build.sh          # only if Dockerfile changed
systemctl --user restart nanoclaw   # picks up instruction changes
```

## See Also

- [Setup guide](setup.md): full installation walkthrough
- [Architecture overview](../architecture/overview.md): system design and config model
- [Container lifecycle](../architecture/container-lifecycle.md): how workers boot and use profiles
