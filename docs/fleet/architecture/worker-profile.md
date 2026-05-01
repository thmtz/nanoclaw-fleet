# Worker Profile

How each worker gets its repos, tools, mounts, and skills at boot.

## What it is

A worker profile is a JSON file at `~/.config/nanoclaw/worker-profiles/default.json` that declares what every worker should have available when it spawns: which repos to clone, which tools to install, which host directories to mount, which Discord-skills repo to symlink. It lives in personal config, outside the repo, so upgrades don't touch it.

Without a profile, workers still work — they just boot empty.

## Schema

```typescript
interface WorkerProfile {
  name?: string;
  description?: string;
  env?: Record<string, string>;
  repos?: Array<{ url: string; postClone?: string }>;
  tools?: string[];
  mounts?: Array<{ hostPath: string; containerPath: string; readonly?: boolean }>;
  ports?: string[];
  skills_repo?: string;
  init_script?: string; // alternative init script name
  claude_md?: string; // alternative CLAUDE.md template
}
```

| Field         | Purpose                                                                                                                                                                                                                                                                                  |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repos`       | Cloned on first boot. SSH URLs are rewritten to HTTPS using `$GH_TOKEN` / `$GITHUB_TOKEN` if available (set via `container_credentials` in `~/.config/nanoclaw/config.json`). `postClone` runs after each clone.                                                                         |
| `tools`       | Shell commands run during init (e.g. `uv tool install /workspace/group/your-tool --force`). Idempotent.                                                                                                                                                                                  |
| `mounts`      | Host paths bind-mounted into the container. Validated against `~/.config/nanoclaw/mount-allowlist.json`.                                                                                                                                                                                 |
| `ports`       | Port mappings (`8080:8080`) passed to docker run.                                                                                                                                                                                                                                        |
| `skills_repo` | Name of one of the cloned repos whose skills should be symlinked into the agent's skill path. Two layouts auto-detected: `<repo>/.claude/skills/<name>/SKILL.md` (Claude Code convention) or `<repo>/<name>/SKILL.md` (each top-level dir IS a skill — e.g. `neuralwatt-claude-skills`). |
| `env`         | Extra env vars merged into the container spawn (per-worker, on top of provider env).                                                                                                                                                                                                     |

## Loading

`loadWorkerProfile()` (`src/modules/fleet/worker-profile.ts`) reads the profile path, in this order:

1. `process.env.NANOCLAW_WORKER_PROFILE_PATH` if set.
2. `~/.config/nanoclaw/worker-profiles/default.json`.

Missing or unparseable: returns an empty profile, logs a warning, fleet still works.

## Apply at create time

`create_worker` calls `applyProfileToContainerConfig(config, profile)`. The profile becomes part of the new worker's `groups/<folder>/container.json`:

- `repos`, `tools`, `skills_repo` go inline under a `fleetProfile` block. The container reads them at boot from `worker-init.sh`.
- `mounts` are expanded (`~/` → absolute) and validated against the mount allowlist before being merged into `additionalMounts`. Anything denied is logged and dropped.
- `ports` and `env` merge into the container spawn args.

## Apply on resume

When a destroyed worker is recreated by name, the profile is re-read and re-applied to the existing `container.json`. This means profile edits take effect on the next resume without needing a fresh wipe. Trade-off: the profile is the source of truth for repos and tools; manual edits to the resumed worker's `container.json::fleetProfile` will be overwritten the next time the worker is recreated.

## Boot sequence (`worker-init.sh`)

The container runs `container/worker-init.sh` after the agent runner mounts complete and before the SDK starts. The script:

1. **GitHub token.** Reads `$GH_TOKEN` (falling back to `$GITHUB_TOKEN`) — both injected by host-side `container_credentials` (see [personal-config.md](../guides/personal-config.md)). When SSH isn't usable, SSH URLs in `repos[].url` are rewritten to `https://<token>@github.com/...` so private repos still clone.
2. **SSH symlink.** If `~/host-ssh` is mounted (e.g. via a worker profile mount), symlinks it to `/home/node/.ssh` so SSH-based clones still work where you want them.
3. **Repos.** For each `fleetProfile.repos` entry, `git clone` into `/workspace/group/<repo-name>/` if it doesn't already exist. If `postClone` is set, run it from the cloned directory.
4. **Skills.** If `fleetProfile.skills_repo` matches a cloned repo's name and that repo has a `.claude/skills/` directory, symlink each skill subdirectory into the agent's skill path so the agent runner picks them up.
5. **Tools.** Run each `fleetProfile.tools` command. Failures are logged and surfaced as setup errors but don't kill the boot — partial tools are better than no agent.

Idempotent throughout. A repo that's already cloned is skipped; a tool that's already installed re-runs (the user is responsible for using `--force` flags or guards if reinstall is expensive).

## Mount validation

Profile mounts go through `validateAdditionalMounts()` (`src/modules/mount-security/index.ts`) before being included in the container spawn. The allowlist lives at `~/.config/nanoclaw/mount-allowlist.json`:

```json
{
  "allowedRoots": [
    { "path": "~/.ssh", "allowReadWrite": false, "description": "SSH keys (read-only)" },
    { "path": "~/.config/gpuctl", "allowReadWrite": true, "description": "gpuctl CLI config" }
  ],
  "blockedPatterns": []
}
```

The default blocklist matches `.gnupg`, `.aws`, `.docker`, `.npmrc`, `id_rsa`, `id_ed25519`, `.env`, `credentials`, etc. An explicit `allowedRoots` entry overrides the blocklist (so you can opt into mounting `~/.ssh` knowingly), but anything outside `allowedRoots` and matching a blocked pattern is rejected.

The allowlist is read once at host startup. New entries require a restart.

## Per-worker env

`profile.env` lets you set env vars that should be visible inside every worker. Used for things like `BEADS_DIR=/workspace/shared-beads/inbox/.beads` or any other declarative wiring you want at boot. Provider env (set by `src/providers/{claude,neuralwatt}.ts`) is merged on top — provider keys win on collision.

## Files

| File                                       | Role                                                           |
| ------------------------------------------ | -------------------------------------------------------------- |
| `src/modules/fleet/worker-profile.ts`      | `loadWorkerProfile`, `applyProfileToContainerConfig`, schema   |
| `container/worker-init.sh`                 | Boot script (clones, tools, skills)                            |
| `src/modules/mount-security/index.ts`      | Allowlist validation                                           |
| `examples/worker-profiles/example.json`    | Reference template                                             |
| `examples/worker-profiles/init.sh.example` | Reference init script (for forks that need a fully custom one) |
