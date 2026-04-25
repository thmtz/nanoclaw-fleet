# Troubleshooting

Common fleet failures with concrete fixes. For broader operational procedures, see [RUNBOOK.md](../RUNBOOK.md). For triage commands when you don't know what's wrong, jump to [debug](#debug-runbook) at the bottom.

## Master doesn't reply

```bash
ncf status                           # master listed, fleet_role='master'?
ncf inject --wait main "ping"        # bypass Discord, test inbound → outbound directly
ncf debug                            # paths, agent groups, docker, wake health
tail -f logs/host.log
```

If `ncf inject` works but Discord doesn't, the gateway is wedged. Restart the host. If `ncf inject` fails too, the master agent_group isn't wired correctly — re-run `pnpm exec tsx scripts/init-fleet-master-discord.ts`.

## Master can't see fleet MCP tools

Check the agent group:

```bash
sqlite3 data/v2.db \
  "SELECT id, slug, fleet_role FROM agent_groups WHERE slug='main';"
```

If `fleet_role` is `NULL`, the agent runner skips loading fleet tools. Fix:

```bash
sqlite3 data/v2.db \
  "UPDATE agent_groups SET fleet_role='master' WHERE slug='main';"
```

Then `ncf restart main` to respawn the container with fleet tools loaded.

## Worker channel exists, agent doesn't reply

```bash
sqlite3 data/v2.db \
  "SELECT ag.slug, ag.fleet_role, mg.platform_id, mg.unknown_sender_policy
   FROM agent_groups ag
   JOIN messaging_group_agents mga ON mga.agent_group_id = ag.id
   JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
   WHERE ag.slug = '<worker>';"
```

If `unknown_sender_policy='strict'` and the sender isn't in `user_roles` or `agent_group_members`, messages are dropped silently. Either add the sender or relax the policy. See [SENDER-ACCESS.md](../SENDER-ACCESS.md).

If the wiring looks right, check the container:

```bash
docker ps | grep <worker>
docker logs $(docker ps -q --filter name=<worker>) 2>&1 | tail -50
```

If the container isn't running, send another message — `wake/<sess>` should respawn it. If respawn fails immediately, check `MIN_RESPAWN_INTERVAL_MS` (the crash-loop guard) — wait 5 seconds and retry, then check `worker-init.sh` output for what's failing at boot.

## `ncf create` says "channel already exists"

Orphan from a previous failed run. Reap:

```bash
ncf reap-orphans            # dry-run first
ncf reap-orphans --confirm  # actually delete
```

Reaper deletes Discord channels named `worker-*` or `lc-*` whose channel id isn't in `messaging_groups`. Won't touch live channels.

## Neuralwatt worker 401s on first turn

The shim defaults to Claude when a folder has no entry. If the v1 shim runs alongside v2 and `NW_SHIM_CONFIG_PATH` isn't set, `create_worker` doesn't sync the new worker into the shim's `worker-backends.json` and the SDK gets `401 invalid x-api-key`.

Fix: set `NW_SHIM_CONFIG_PATH` in `.env` to the absolute path of the shim's `worker-backends.json`, then:

```bash
ncf switch <worker> neuralwatt <model>      # rewrites the entry
```

Verify:

```bash
cat $NW_SHIM_CONFIG_PATH | jq ".\"discord_<worker>\""
```

## Status pin pile-up in `#master`

Multiple pins stack up if a prior bot identity authored them, or if an edit failed and the host created a new one without unpinning the old.

The pin runner sweeps stale pins on every channel update (force-unpinning bot-authored pins that aren't the current expected message id). The first sweep on host startup is unconditional; subsequent ones run at most every ten minutes per channel.

Force a sweep now:

```bash
systemctl --user restart nanoclaw
```

If pins keep coming back, confirm the bot user id matches what the host expects:

```bash
grep '"applicationId"' logs/host.jsonl | tail -1
```

## Container crash loop

```bash
docker logs $(docker ps -aq --filter name=<worker> | head -1) 2>&1 | tail -100
```

Common causes:

- Stale `.claude/` from a previous SDK version. Wipe and recreate:

  ```bash
  ncf restart <worker> --fresh        # clears stored_session_id
  # or, harder reset:
  rm -rf data/v2-sessions/<ag>/<sess>/.claude
  ncf restart <worker>
  ```

- `worker-init.sh` failing on a clone or a tool. Check the worker's `container.json::fleetProfile`, fix the bad entry, restart.

- Mount denied silently. The mount allowlist is read at host startup; recent edits don't apply. Restart the host.

The crash-loop guard (`MIN_RESPAWN_INTERVAL_MS=5000`) prevents respawn storms — you'll see "rate-limited" in host.log if a container is failing fast.

## Discord gateway zombie (no logs, no responses)

The gateway socket can wedge in `CLOSE_WAIT` to Cloudflare without an error. `ncf debug` shows the bot connected; nothing is reaching the host.

```bash
ss -tnp | grep CLOSE-WAIT | grep $(pgrep -f 'node dist')
grep -E 'gateway|disconnect' logs/host.log | tail -10
```

If you see CLOSE-WAITs piling up, restart:

```bash
systemctl --user restart nanoclaw
```

If this recurs, file a bead for a reconnect watchdog.

## Outbound delivered to the wrong channel

When a worker sends a `<message to="...">` block addressed to a destination that doesn't exist (or to itself by mistake), the message goes to the host's "scratchpad" path and lands in the channel matching `session_routing` — usually the channel the user was last chatting in. The fix landed in `2d566c2`: replies use `session_routing` (host-authoritative, current) rather than batch-local routing captured at query start, so master-on-Discord no longer goes silent after a CLI inject.

If you see a worker writing into the master's channel by accident, check the worker's `agent_destinations` rows:

```bash
sqlite3 data/v2.db \
  "SELECT * FROM agent_destinations WHERE agent_group_id =
     (SELECT id FROM agent_groups WHERE slug='<worker>');"
```

A missing or wrong destination is the usual culprit. `ncf restart <worker>` after fixing.

## Mount denied on container spawn

```bash
grep -E 'mount|denied' logs/host.log | tail
cat ~/.config/nanoclaw/mount-allowlist.json
```

Allowlist is read once at startup. Add the path to `allowedRoots`, then `systemctl --user restart nanoclaw`.

## Smoke test fails

The smoke wraps the lifecycle script; failures usually mean Discord, the shim, or the container is in a bad state.

```bash
./scripts/smoke.sh 2>&1 | tee /tmp/smoke.log
```

Read the log from the bottom up. The first failing step is the issue; later failures are usually downstream.

If the failure is "channel not found", run `ncf reap-orphans --confirm` and retry.

## Debug runbook

When you don't know what's wrong, run the triage in order:

```bash
# 1. Host alive?
systemctl --user status nanoclaw

# 2. What does the host think the world looks like?
ncf debug

# 3. Containers
docker ps --format '{{.Names}} {{.Status}}' | grep nanoclaw

# 4. Recent host errors
jq 'select(.level >= 50)' logs/host.jsonl | tail -20

# 5. Discord gateway healthy?
ss -tnp | grep CLOSE-WAIT | grep $(pgrep -f 'node dist')

# 6. Inference layer
curl -s http://localhost:3003/models | head     # only if Neuralwatt
```

For deeper procedures and recovery, see [RUNBOOK.md](../RUNBOOK.md).
