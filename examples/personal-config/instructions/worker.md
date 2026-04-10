# Personal Instructions (Worker)

## Skills

Skills come from two sources, both symlinked into `~/.claude/skills/`:

1. **Shared skills repo**: mounted from the host, writable. Edits are immediately visible to all workers and persist on the host.
2. **Host personal skills**: mounted from the host's `~/.claude/skills/`, also writable. Changes persist to the host and are available everywhere.

To create a new skill: write it to `/workspace/extra/host-skills/<skill-name>/SKILL.md`.

## Filesystem Mount Map

| Container path | Source | Writable | Persists |
|-|-|-|-|
| `/workspace/group/` | Host: `groups/<your-folder>/` | yes | yes |
| `~/.claude/` | Host: `data/sessions/<your-folder>/.claude/` | yes | yes |
| `~/.claude/skills/` | Symlinks from init.sh | varies | yes |
| `/workspace/extra/host-skills/` | Host: `~/.claude/skills/` | yes | yes |
| `/workspace/extra/shared-skills-repo/` | Host: `~/git/your-skills-repo/` | yes | yes |
| `/workspace/extra/host-ssh/` | Host: `~/.ssh/` | no | n/a |
| `/workspace/worker-profiles/` | Host: `~/.config/nanoclaw/worker-profiles/` | yes | yes |
| `/workspace/ipc/` | Host: `data/ipc/<your-folder>/` | yes | yes |
| `/app/src/` | Copied from `container/agent-runner/src/` | yes | yes |
| Everything else (`/usr/`, `/tmp/`, etc.) | Container image | yes | no |

**Key takeaways:**
- **To persist anything:** put it in `/workspace/group/`
- **To create a skill visible everywhere:** write to `/workspace/extra/host-skills/<name>/SKILL.md`
- **To install tools permanently:** edit the worker profile or ask the user to update the Dockerfile
- **Credentials** are mounted read-only. Never copy them into repos or committed files.

## Available Repos

- `backend` — API server
- `frontend` — Web application
- `shared-tools` — Shared CLI tools and utilities
- `nanoclaw-fleet` — NanoClaw Fleet, the system running you

## Network & Access

- **Internet access.** You can reach the internet (git, pip, npm, etc.).
- **Host machine.** Accessible at `host.docker.internal`.
- **No access to other workers.** Each worker has its own container and filesystem.
