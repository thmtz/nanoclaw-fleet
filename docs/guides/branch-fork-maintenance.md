# Branch and Fork Maintenance

How this fork tracks upstream and how to bring upstream changes in cleanly.

## What this fork is

`thmtz/nanoclaw-fleet` is a feature fork of [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw). The base repo provides container isolation, the channel-skill system, and the Claude Agent SDK plumbing. The fork adds the master/worker fleet model, dual inference backends (Anthropic + Neuralwatt), runtime model switching, energy reporting, the `ncf` CLI, and IPC-driven lifecycle.

Upstream is a moving target. This guide covers staying in sync.

## Remotes

```bash
git remote -v
# origin    git@github.com:thmtz/nanoclaw-fleet.git (fetch)
# origin    git@github.com:thmtz/nanoclaw-fleet.git (push)
# upstream  https://github.com/qwibitai/nanoclaw.git (fetch)
# upstream  https://github.com/qwibitai/nanoclaw.git (push)
```

If `upstream` is missing:

```bash
git remote add upstream https://github.com/qwibitai/nanoclaw.git
git fetch upstream
```

## Bringing upstream into the fork

Two practical approaches: a guided migration via the `/migrate-nanoclaw` skill (best for major version bumps) or a lightweight cherry-pick via `/update-nanoclaw` (best for surgical changes).

### Option A — guided migration (recommended for breaking upstream changes)

```
/migrate-nanoclaw
```

The skill extracts what's customised in this fork, generates a replayable migration plan, and reapplies fork features on top of a clean upstream base. Use this when upstream releases a major version (v1 → v2) or restructures the repo.

### Option B — lightweight cherry-pick

```
/update-nanoclaw
```

Pulls a curated subset of upstream changes since the last merge. Better when upstream has accumulated bug fixes and small features and you don't need a full reset.

### Option C — manual merge

For experienced users, plain `git merge upstream/main` works. Conflicts are predictable; the table below lists what to expect.

```bash
git fetch upstream
git checkout main
git merge upstream/main
# resolve conflicts
npm install && npm run build && npx vitest run
git push origin main
```

## Conflicts you'll see every time

| File | Resolution |
|-|-|
| `package.json` | Keep upstream's version field; merge dependency lists. |
| `package-lock.json` | `git checkout upstream/main -- package-lock.json && npm install` |
| `.env.example` | Combine upstream's entries with fork-specific ones (`NANOCLAW_DEFAULT_*`, `NEURALWATT_*`). |
| `README.md` | Always keep the fork's. |
| `docs/upstream/*.md` | Take upstream's; that's literally what this directory mirrors. |
| `src/index.ts`, `src/container-runner.ts` | Usually auto-merge. Verify the master/worker code paths still work. |

Always build and test after a merge. Auto-merged code can be silently wrong; tsc and the test suite catch most of it.

## What lives where

| Path | Owner |
|-|-|
| `src/cli.ts`, `src/ipc.ts`, `src/profile-sync.ts`, `src/backend-defaults.ts`, `src/status-pin.ts`, `src/worker-status-pin.ts`, `src/credential-proxy.ts`, `src/resource-monitor.ts`, `src/audit-log.ts`, `src/worker-events.ts`, `src/trace.ts` | Fork |
| `src/index.ts`, `src/container-runner.ts`, `src/types.ts`, `src/channels/*` | Shared (both touch) |
| `tools/anthropic-shim.ts`, `tools/restart-watchdog.sh`, `tools/e2e-test.ts` | Fork |
| `container/agent-runner/src/mcp-tools/*` | Mostly fork |
| `instructions/master.md`, `instructions/worker.md` | Fork |
| `docs/architecture/*`, `docs/guides/*`, `docs/reference/*` | Fork |
| `docs/upstream/*` | Upstream snapshot |
| `worker-profiles/*` | Fork |

When upstream lands a fix in `src/index.ts` or `src/container-runner.ts`, expect a touch — those are the most-shared files.

## Removing upstream-only files

After every merge, check for files that the fork doesn't want:

```bash
# upstream ships GitHub workflow files we don't use
git rm -f .github/workflows/bump-version.yml \
          .github/workflows/update-tokens.yml 2>/dev/null

# repo-tokens badge auto-regens upstream
git checkout upstream/main -- repo-tokens/badge.svg
```

## Upstream tracking discipline

Forward-merge after any upstream change that touches shared files. Small frequent merges produce trivial conflicts; large infrequent merges produce painful ones.

A `~/git/reference/nanoclaw-upstream/` clone (kept up to date with `git pull`) is useful for comparing fork files against upstream without polluting this checkout.

## When upstream changes break the fork

If upstream replaces or renames a piece the fork relies on (provider abstraction, channel registry, container input shape):

1. Land the upstream merge with the rename in place.
2. Update the fork's affected modules to use the new shape.
3. Re-run `npx vitest run` and `./ncf test`.
4. Verify a real worker spawn end-to-end via [testing.md](testing.md).
5. Commit the fixups in the same PR as the merge so the diff stays self-contained.

## Releases

This fork tags its own releases. Upstream tags are not consumed directly. Bump using whatever flow you prefer; CI runs on every push to `main`.
