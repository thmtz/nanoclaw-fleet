# Personal Configuration

NanoClaw Fleet separates reusable code (the repo) from per-installation config (`~/.config/nanoclaw/`). Personal config covers what only matters for your install: which repos workers clone, what conventions the agents follow, which host paths are mountable, and what extra layers go into the container image.

For working examples, see `examples/`.

## Why personal config

The repo ships generic agent instructions, an example worker profile, and a base container image. Your personal config layers on top so upstream pulls don't touch your setup. If removing something would break NanoClaw for any user, it lives in the repo. If it only matters for your installation, it's personal config.

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
│   └── init.sh                   # alternative init script (optional)
├── mount-allowlist.json          # host paths workers may mount
└── debug_bot_token               # debug bot token (testing only)
```

## How instructions compose

Each agent's `CLAUDE.md` is assembled at every container spawn from the layers below. See [architecture/instructions.md](../architecture/instructions.md) for the full mechanism.

Repo layers (set baseline behaviour):

1. Shared base
2. Skill fragments
3. MCP tool fragments
4. Per-MCP-server fragments

Personal layers (your conventions):

5. `~/.config/nanoclaw/instructions/global.md` — both master and workers
6. `~/.config/nanoclaw/instructions/{master,worker}.md` — role-gated
7. Files listed in `~/.config/nanoclaw/config.json::include_files`

Repo conventions live in repo instructions; your personal style and house rules live in your personal layer. Don't edit repo instructions for personal preferences; add a personal fragment.

## include_files

If you keep a global `~/.claude/CLAUDE.md` with conventions you want every agent to follow:

```json
{
  "include_files": ["~/.claude/CLAUDE.md"]
}
```

The composer inlines each file as a separate fragment. Behaviour is identical to the personal instructions layer — content lands in `systemPrompt.append`, surviving compaction.

`~/`-prefixed paths expand to the user's home directory. Absolute paths work as-is. Missing files are logged and skipped.

## Worker profile

`~/.config/nanoclaw/worker-profiles/default.json` controls what each worker container gets at boot:

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
| `repos` | Cloned on first boot. SSH URLs rewritten to HTTPS using `NANOCLAW_GITHUB_TOKEN` if available. `postClone` runs from the cloned dir. |
| `tools` | Shell commands run during init. Idempotent. |
| `mounts` | Host paths mounted into the container. Validated against the allowlist. |
| `ports` | Docker port mappings (`host:container`). |
| `skills_repo` | Name of one of the cloned repos whose `.claude/skills/` is symlinked into the agent. |

Profile changes take effect on the next worker spawn. Existing workers re-apply the profile on resume.

For full schema and boot details, see [architecture/worker-profile.md](../architecture/worker-profile.md).

## Mount allowlist

`mount-allowlist.json` is the security boundary for the worker profile's `mounts`:

```json
{
  "allowedRoots": [
    {"path": "~/.ssh", "allowReadWrite": false, "description": "SSH keys (read-only)"},
    {"path": "~/.config/gpuctl", "allowReadWrite": true, "description": "gpuctl CLI config"}
  ],
  "blockedPatterns": []
}
```

Defaults block `.gnupg`, `.aws`, `.docker`, `.npmrc`, `id_rsa`, `id_ed25519`, `credentials`, `.env`. An explicit `allowedRoots` entry overrides the blocklist (so you can opt into mounting `~/.ssh` knowingly), but anything outside `allowedRoots` and matching a default block is denied.

The file is read once at host startup. New entries require a restart.

## Personal Dockerfile

If your workers need system packages (databases, compilers, language runtimes), drop a Dockerfile at `~/.config/nanoclaw/Dockerfile`:

```dockerfile
FROM nanoclaw-agent-v2-<slug>:base

USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    postgresql redis-server \
 && rm -rf /var/lib/apt/lists/*

RUN uv pip install --system --break-system-packages pytest httpx

USER node
```

`container/build.sh` builds the base image first, then layers your Dockerfile on top with `--build-arg BASE=<slug>:base` so `FROM nanoclaw-agent-v2-<slug>:base` resolves. The final tag is `:latest`. Without your Dockerfile, `:latest` aliases `:base`.

## Where to put what

| Lives where | Why |
|-|-|
| Source code, container image base, default skills, MCP tools | Repo |
| Repo-shared instructions (`instructions/`) | Repo |
| Channel adapters (skills) | Repo (per `channels` skill branch) |
| Personal instructions, worker profile, mount allowlist | `~/.config/nanoclaw/` |
| Personal Docker layers | `~/.config/nanoclaw/Dockerfile` |
| Tokens, secrets, paths | `.env` (in repo, gitignored) and OneCLI vault |

## Getting started

```bash
cp -r examples/personal-config/ ~/.config/nanoclaw/   # if examples ship one
# or assemble piecewise:
mkdir -p ~/.config/nanoclaw/{instructions,worker-profiles}
cp examples/worker-profiles/example.json ~/.config/nanoclaw/worker-profiles/default.json
```

Edit `worker-profiles/default.json` to point at your repos. Edit `instructions/global.md` (and `master.md`/`worker.md` if you have role-specific notes). Rebuild and restart:

```bash
./container/build.sh                # only if you changed the Dockerfile
systemctl --user restart nanoclaw   # picks up instruction and profile changes
```

## See also

- [Setup guide](setup.md)
- [Architecture: instructions composition](../architecture/instructions.md)
- [Architecture: worker profile](../architecture/worker-profile.md)
