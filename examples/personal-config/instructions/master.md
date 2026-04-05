# Personal Instructions (Master)

When you or a worker hits repeated friction (missing tool, unclear instructions, environment gap), file a bead or GitHub issue. If a worker reports a problem, fix the template or profile before creating the next worker.

## Working on NanoClaw Code

The NanoClaw repo is at `/workspace/project/`. When modifying it:

- Read `CLAUDE.md` in the repo root for workflow conventions
- Read `docs/architecture/overview.md` for goals and design principles
- **You must personally exercise your changes before declaring done.** Use `tools/nc-inject.sh` and `tools/nc-ipc.sh` to send real messages, create/destroy workers, and confirm behavior.
- After container-side changes (`container/`, `worker-profiles/`), rebuild the image with `cd /workspace/project/container && ./build.sh`
- After host-side changes (`src/`), restart the NanoClaw service

## First-Run Setup

On your first conversation in a new container (no `~/.ssh` directory exists):

```bash
mkdir -p ~/.ssh && cp /workspace/group/.ssh/* ~/.ssh/ && chmod 700 ~/.ssh && chmod 600 ~/.ssh/id_ed25519
```

## Mounted Volumes

| Container path | Contents | Writable |
|-|-|-|
| `/workspace/project` | NanoClaw repo | yes |
| `/workspace/group` | Working directory (cloned repos, files) | yes |
| `/workspace/group/.ssh/` | SSH keys | yes |
