# Personal Configuration

NanoClaw separates reusable code (the repo) from per-installation config (`~/.config/nanoclaw/`). This guide covers what goes where, how the layers compose, and what each piece controls.

For a working example, see `examples/personal-config/`.

## Why personal config

The repo ships generic agent instructions, example profiles, and a base container image. Your personal config layers on top: which repos workers clone, which tools come pre-installed, what coding conventions agents follow, what credentials get mounted. Because personal config lives outside the repo, pulling upstream updates does not touch your setup.

## Directory layout

```
~/.config/nanoclaw/
├── config.json                   # personal config (include_files, etc.)
├── Dockerfile                    # personal container layer (optional)
├── instructions/
│   ├── global.md                 # all agents
│   ├── master.md                 # master only
│   └── worker.md                 # workers only
├── worker-profiles/
│   ├── default.json              # repos, tools, mounts, ports
│   └── init.sh                   # runs every container spawn
└── mount-allowlist.json          # host paths workers may mount
```

## How instructions compose

Each agent's `CLAUDE.md` is assembled from four fragments at startup:

```
1. instructions/global.md                                    (repo, shared)
2. instructions/{master,worker}.md                           (repo, role)
3. ~/.config/nanoclaw/instructions/global.md                 (personal, shared)
4. ~/.config/nanoclaw/instructions/{master,worker}.md        (personal, role)
```

Repo instructions set baseline behaviour: communication style, first-boot, workspace layout. Personal fragments add your conventions: code-design rules, PR workflow, repo list, mount map. Don't edit repo instructions for personal preferences; add a personal fragment instead.

The assembled `CLAUDE.md` is read by the agent runner at startup and injected via `systemPrompt.append`. That puts it in the actual system prompt sent on every API call, so it survives context compaction.

## Including external files

If you keep a global `~/.claude/CLAUDE.md` with coding conventions you want all agents to follow, include it via `config.json`:

```json
{
  "include_files": ["~/.claude/CLAUDE.md"]
}
```

Included files take the same `systemPrompt.append` path as the assembled CLAUDE.md, so they survive compaction.

## Worker profile

`worker-profiles/default.json` controls what each container gets:

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

| Field | Purpose |
|-|-|
| `name` | Profile name (selects non-default profiles) |
| `repos` | Cloned on first boot. `postClone` runs after each clone. |
| `tools` | Shell commands run during init (package installs, CLI setup) |
| `mounts` | Host paths mounted into the container. Must be on the allowlist. |
| `ports` | Docker port mappings (`host:container`) |
| `skills_repo` | Name of a cloned repo whose `.claude/skills/` is symlinked into the agent's skill path |

## Mount allowlist

`mount-allowlist.json` is the security boundary for `mounts` in the worker profile. It is read once at host startup; new entries require a restart.

```json
{
  "allowedRoots": [
    {"path": "~/.ssh", "allowReadWrite": false, "description": "SSH keys (read-only)"},
    {"path": "~/.config/gpuctl", "allowReadWrite": true, "description": "gpuctl CLI config"}
  ],
  "blockedPatterns": [],
  "nonMainReadOnly": false
}
```

`blockedPatterns` blocks substrings (e.g. `credentials`, `.env`). `nonMainReadOnly: true` forces every worker mount to read-only regardless of the per-mount `readonly` flag.

## Personal Dockerfile

If your workers need system packages (databases, compilers, language runtimes), add a Dockerfile at `~/.config/nanoclaw/Dockerfile`:

```dockerfile
FROM nanoclaw-agent:base

USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    postgresql redis-server \
 && rm -rf /var/lib/apt/lists/*

RUN uv pip install --system --break-system-packages pytest httpx

USER node
```

`container/build.sh` builds the base image first, then layers your Dockerfile on top if the file exists.

## Where to put what

The rule of thumb: if removing it would break NanoClaw for any user, it lives in the repo. If it only matters for your installation, it's personal config. The [setup guide](setup.md#repo-vs-user-config) has the full breakdown.

## Getting started

```bash
cp -r examples/personal-config/ ~/.config/nanoclaw/
```

Edit `worker-profiles/default.json` to point at your repos, then edit `instructions/global.md` (and `master.md`/`worker.md` if you have role-specific notes). After changes:

```bash
./container/build.sh                # only if you changed the Dockerfile
systemctl --user restart nanoclaw   # picks up instruction and profile changes
```

## See also

- [Setup guide](setup.md)
- [Architecture overview](../architecture/overview.md)
- [Container lifecycle](../architecture/container-lifecycle.md) — how `init.sh`, profile, and Dockerfile relate
