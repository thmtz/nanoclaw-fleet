# NCF e2e checklist

The mandatory gate before saying "NCF is ready / go try it" to the user.

If you skip this checklist and the user finds NCF broken, that's a process failure. The checklist exists so you don't have to remember which paths to exercise — it remembers for you.

---

## When you MUST run this

Before declaring NCF ready / "go try it" / "deployment is live" after **any** of:

- Host code change in `src/` (built into `dist/`)
- Container code change in `container/agent-runner/src/` (bind-mounted on next spawn)
- `Dockerfile`, `worker-init.sh`, or `container/build.sh` change
- Credential / OAuth / OneCLI / proxy / `.env` changes (any auth touch)
- Host service restart
- `pnpm install` / dependency upgrade
- Migration to a new agent runtime (provider switch, SDK bump)

If you're unsure whether your change qualifies — run it anyway. The cost is ~3 minutes. The cost of a false "ready" is your trust + the user's time.

---

## When you MUST update this

Anytime the user reports "NCF said it was ready but X is broken" and X isn't already a checklist item, **add the test for X to this file BEFORE fixing the underlying bug.** The checklist must accumulate every behavior anyone has ever found broken; that's the entire point.

Same rule applies if you find a regression yourself during exploratory work.

The PR that fixes the bug should include the checklist update. No PR with a "behavior regression fix" should land without a corresponding checklist test that would have caught it.

---

## The checklist

Run in order. Each section is a hard gate; later sections only matter if earlier ones pass.

### 1. Host & infrastructure health

```bash
systemctl --user is-active nanoclaw                                # → active
curl -sf http://127.0.0.1:10254/api/secrets -o /dev/null -w "%{http_code}\n"  # → 200 (OneCLI admin)
curl -sf http://127.0.0.1:3003/v1/models -o /dev/null -w "%{http_code}\n"     # → 200 (shim, only if any neuralwatt worker exists)
docker ps --filter name=nanoclaw-v2-                               # current worker containers
ncf debug                                                           # one-shot health
pnpm test                                                           # → all green (host)
cd container/agent-runner && bun test && cd -                      # → all green (container)
```

If any check fails, stop and fix before proceeding.

### 2. Build freshness

```bash
# dist/ must be newer than src/ — host runs from dist/index.js
ls -lt dist/index.js src/index.ts | head -2
# If src/ is newer: pnpm run build, then restart the host (with user permission)
```

### 3. Smoke test (canonical script)

```bash
./scripts/smoke.sh
```

This is the first-line e2e. It already covers:

- `ncf inject --wait` to master, verify reply
- Status-pin landed in `#master`
- Worker create → message → switch backend (Claude → neuralwatt) → message via new backend → destroy → recreate (resume)
- Reaps orphan channels on exit

**If smoke is green, you've covered most of the surface.** If smoke is red, every red item gets investigated before claiming ready.

### 4. Backend coverage spot-checks (when smoke can't be trusted)

If smoke.sh is unavailable or you've changed something it doesn't exercise, hit each backend path manually:

```bash
# Claude path
ncf create e2e-claude --backend claude
# Then send a Discord message to the new channel; expect a real reply
ncf destroy e2e-claude

# Neuralwatt path (catches the OneCLI / HTTPS_PROXY interaction with the shim)
ncf create e2e-nw --backend neuralwatt --model zai-org/GLM-5.1-FP8
# Then send a Discord message; expect a real reply (no API retry loop, no empty replies from shim)
ncf destroy e2e-nw
```

**Both backends matter.** The OneCLI HTTPS_PROXY breaks shim routing for neuralwatt workers if `NO_PROXY` isn't set — testing only Claude misses this entirely. (Regression baked in 2026-04-29; see commit history for `fix/neuralwatt-noproxy`.)

### 4b. Worker init clones (catches OneCLI / proxy / cert breakage)

The lifecycle test verifies "worker can reply" but not "worker-init.sh exited cleanly with all repos cloned." Several worker behaviors depend on cloned repos (the agent walking `/workspace/<repo>/` to answer "look at this issue"). When OneCLI's HTTPS_PROXY intercepts the HTTPS clones and git doesn't trust the proxy's CA, clones silently fail — the worker still spawns, still replies, but every "look at the inference_frontend repo" task hangs while the agent tries to clone on demand from inside the container.

After creating any fresh worker (one whose workspace dir is brand new, not a resume from archive), check the init log:

```bash
ncf logs <worker> | grep -E "WARNING.*clone failed|repos \(cloned="
```

Expected: a single `repos (cloned=N skipped=M)` line, no `WARNING: clone failed` lines. If clone failed lines appear, capture the `fatal:` reason (`server certificate verification failed`, `host key verification failed`, `Permission denied`, etc.) — that's the actual blocker.

(Regression baked in 2026-04-29 when OneCLI was activated; see `fix/git-trust-onecli-ca`. The proxy intercepts HTTPS clones but git uses its own CA bundle. `GIT_SSL_CAINFO` is now set in `worker-init.sh` when `SSL_CERT_FILE` is present.)

### 4c. `container_credentials` injection (env vars from `~/.config/nanoclaw/config.json`)

If the user has any `container_credentials` entries in `~/.config/nanoclaw/config.json` (file→env injection — see `docs/fleet/guides/personal-config.md`), every spawned container should have those env vars set. Easy to forget when adding new tokens — the doc says they're injected, but the only way to verify is to look inside a container.

```bash
# After any new container_credentials entry is added, restart the host
# and spawn a worker. Then:
docker exec <container> env | grep -E "BETTERSTACK|FIREWORKS|TOGETHER|SYNTHETIC|<your_new_var>"
```

Each entry's env var should be present. Missing = either the source file at `path` doesn't exist (silent skip — check `ls <path>`) or the host needs a restart to pick up the config change.

### 4d. Team skills available to the agent (`skills_repo` + host-skills)

Worker profile lists a `skills_repo` (typically `neuralwatt-claude-skills`) whose contents should be auto-discoverable by the agent. The chain is fragile — the repo must be cloned successfully, and `worker-init.sh` must find the skill layout. Manifestation when this breaks: agent says `"I don't have /review-and-submit"` even though it's in the team repo.

```bash
# After spawning a fresh worker, count expected vs visible skills
docker exec <container> ls /home/node/.claude/skills | wc -l
docker exec <container> ls /workspace/extra/host-skills | wc -l
docker exec <container> ls /workspace/<skills_repo>/ 2>/dev/null
```

Spot-check a known team skill:

```bash
docker exec <container> ls /home/node/.claude/skills/review-and-submit
```

If missing: check `ncf logs <worker>` for the worker-init `skills: linked N from <repo>` line. Common causes:

- The `skills_repo` clone failed (check the clone log lines — see section 4b)
- The repo doesn't follow either layout (`.claude/skills/<name>/SKILL.md` or `<name>/SKILL.md`)
- A `~/.claude/skills/<name>` entry on the host is a symlink pointing OUTSIDE the mount (the mount carries the symlink but not its target — broken symlink in container, gets skipped silently)

(Regression seen 2026-04-30: NWCS skills missing from `better` and others because (a) the SSH→HTTPS rewrite broke the clone — fixed in PR #105 — and (b) `worker-init.sh` only checked `<repo>/.claude/skills/`, missing repos that put skills at the root. Both addressed in `fix/nwcs-skills-layout`.)

### 4e. Resource monitor (host-side background polling for memory/disk/container alerts)

The resource monitor runs every 5 minutes and posts to #master when memory ≥80%, disk ≥80%, or active containers ≥80% of `MAX_CONCURRENT_CONTAINERS`. Hysteresis: alert once on crossing, clear once on dropping below 70% (60% for containers).

```bash
# Verify the monitor started in host startup logs
grep -i "Resource monitor started" logs/nanoclaw.log | tail -2
```

If you can't easily induce a real resource crunch, the threshold logic is exercised by `src/modules/resource-monitor/index.test.ts` (4 cases for crossings, hysteresis, multi-metric ticks). For a real-world spot check, watch `logs/nanoclaw.log` for `Resource alert` entries during heavy use.

### 5. Auth path (verify the source of credentials matches expectation)

After the host restart, look at the host log for the LAST worker spawn:

```bash
tail -100 logs/nanoclaw.log | grep -iE "OneCLI gateway applied|Env credential fallback applied|oauthSource"
```

Expected with OneCLI: `OneCLI gateway applied`. With env fallback: `oauthSource=".env"` (long-lived) — never `oauthSource="credentials.json"` (short-lived) unless `.env.CLAUDE_CODE_OAUTH_TOKEN` is intentionally absent.

Inside a running container:

```bash
docker exec <container> env | grep -iE "ANTHROPIC|HTTPS_PROXY|NO_PROXY"
```

For a Claude worker under OneCLI: `HTTPS_PROXY` set, `ANTHROPIC_BASE_URL` unset (or api.anthropic.com).
For a neuralwatt worker under OneCLI: `HTTPS_PROXY` set, `ANTHROPIC_BASE_URL=http://host.docker.internal:3003/...`, `NO_PROXY` includes `host.docker.internal`.

### 6. Compaction path

The hard one to trigger on demand. Two options:

- Wait for a real long-context turn (auto-compact, takes hours of usage)
- Send the slash command from an admin user: `/compact` in a worker channel

Expected behavior:

1. User sees `⏳ Compacting context (auto)…` (PreCompact hook fires)
2. Compaction completes silently (no fake `Context compacted (X tokens)` terminating reply)
3. Agent's actual response continues and lands

If you only see `Context compacted (X tokens)` and no real reply, the `compact_boundary` regression has reappeared.

### 7. send_message + trailing text

Ask a worker to do a multi-step task: "ack first, do work, then summarize when done."

Expected:

- Early `send_message` ack lands in chat
- Substantive end-of-turn summary lands in chat (auto-suppress regression check)
- Internal scratchpad wrapped in `<internal>...</internal>` does NOT land

### 8. Master MCP tool surface

In a master Discord conversation:

- "list workers" → reply lists fleet
- "create a worker named test-mcp" → worker spawned
- "switch test-mcp to neuralwatt with kimi-k2.6-fast" → backend swapped, container restarted, replies via new backend
- "cleanup workers, dry run" → reports orphan channels / containers / workers without acting
- "destroy test-mcp" → archived, channel deleted

---

## "What changed → what to test" routing

This stays in [`testing.md`](testing.md). The checklist above is the COMPREHENSIVE pass; testing.md tells you what's most likely affected by a specific code change. Run the targeted subset during dev, then the full checklist before declaring ready.
