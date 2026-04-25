# Troubleshooting

Common problems and their fixes. For deeper triage commands, see [debug-checklist.md](debug-checklist.md).

## The host isn't running

```bash
systemctl --user status nanoclaw       # Linux
launchctl list | grep nanoclaw         # macOS
```

If the unit failed: `journalctl --user -u nanoclaw -n 100`. Common causes:

- Wrong `WorkingDirectory` in the systemd unit. Replace `{{PROJECT_ROOT}}` with the absolute path.
- `npm run build` was never run. `dist/` is empty.
- Bad `.env` syntax (unquoted spaces in a value). The host fails fast.

## Worker channel exists but the agent never replies

Check `requires_trigger`:

```bash
sqlite3 store/messages.db "SELECT folder, requires_trigger FROM registered_groups;"
```

Workers should be `0`. If yours is `1`, the bot only responds to `@<assistant>` mentions, which the master never sends.

```sql
UPDATE registered_groups SET requires_trigger=0 WHERE folder='discord_<name>';
```

## "ncf create: missing required fields"

`DISCORD_GUILD_ID` isn't reaching the host process. Confirm it's in `.env` and the systemd unit reads `EnvironmentFile=` from that file. Restart after edits.

## Agent doesn't see new MCP tools or instructions

Stale agent-runner cache or stale CLAUDE.md. Both refresh on the next container spawn.

```bash
ncf restart <worker>           # respawn the container
```

For instruction changes that need to apply to all workers, also restart the host so `profile-sync` regenerates each `groups/<folder>/CLAUDE.md`:

```bash
systemctl --user restart nanoclaw
```

## Container build doesn't pick up source changes

Docker layer cache is aggressive. Use the build script — it forces a clean rebuild for the agent layer:

```bash
./container/build.sh
```

If you suspect deeper cache issues, prune the builder:

```bash
docker builder prune -af
./container/build.sh
```

## Repos fail to clone (403 / 404)

The container needs a GitHub token with `repo` scope (and `workflow` if any worker pushes `.github/workflows/*`).

```bash
# host has the token?
cat ~/.config/nanoclaw/github_token | head -c 10

# .env points at it?
grep NANOCLAW_GITHUB_TOKEN_PATH .env

# token reaches the container?
docker exec <container> bash -c 'echo $GITHUB_TOKEN | head -c 10'
```

Classic PATs cover all orgs you belong to. Fine-grained PATs need per-org approval and break in confusing ways; use classic PATs unless you know you need fine-grained.

## Worker stuck in a crash loop

Stale `.claude/` is the usual culprit. Destroy and recreate with `fresh`:

```bash
ncf destroy <worker>
ncf create <worker>             # answer "fresh" at the prompt
```

If the issue is in `init.sh` or the image, fix that first; the next spawn will pick it up.

## Discord gateway zombies (no logs, no responses)

The gateway socket can wedge in `CLOSE_WAIT` to Cloudflare without a visible error. Symptoms: systemd shows the unit active, but messages stop landing in the host log.

```bash
ss -tnp | grep CLOSE-WAIT | grep $(pgrep -f 'node dist')   # confirm zombies
systemctl --user restart nanoclaw                          # fix
```

If this recurs, file a bead for a reconnect watchdog.

## Status pin pile-up in `#master`

The host pins one status message per channel. Stale pins should be unpinned automatically every ten minutes, but if you have multiple bot identities or recently changed the bot user, leftovers can stack up. The host now sweeps stale pins on every channel scan; restart the host to force an immediate sweep:

```bash
systemctl --user restart nanoclaw
```

If the pile keeps coming back, check the bot user id matches what the host expects:

```bash
grep '"applicationId"' logs/nanoclaw.jsonl | tail -1
```

## Shim returns 500 on Neuralwatt requests

Most likely a bad API key or unknown model.

```bash
# direct hit on the shim
curl -s http://localhost:3003/w/discord_<worker>/v1/messages \
  -H 'Content-Type: application/json' -H 'x-api-key: placeholder' -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"claude-opus-4-6","max_tokens":40,"messages":[{"role":"user","content":"hi"}]}'

# direct provider check
curl -s https://api.neuralwatt.com/v1/models -H "Authorization: Bearer $(grep NEURALWATT_API_KEY .env | cut -d= -f2)" | head

tail logs/shim.error.log
```

The shim resolves model names via fuzzy match, but requires the underlying provider to know the model. Try the canonical id directly to confirm.

## "401 invalid x-api-key" from the SDK

The shim default falls back to Anthropic when a folder has no entry in `data/worker-backends.json`. If you spawned a Neuralwatt worker but the entry never landed, the shim happily forwards to `api.anthropic.com` with the placeholder key. The container-runner now seeds the entry on every spawn (`seedBackendEntry` in `src/backend-defaults.ts`), so this should not happen on a fresh build. If you see it:

```bash
cat data/worker-backends.json | jq '."discord_<worker>"'
ncf switch <worker> neuralwatt <model>     # rewrites the entry
```

## Mount denied on container spawn

The mount allowlist (`~/.config/nanoclaw/mount-allowlist.json`) is read at host startup and immutable for the process. New paths require a host restart.

```bash
grep -E 'Mount.*REJECTED|mount' logs/nanoclaw.log | tail
cat ~/.config/nanoclaw/mount-allowlist.json
```

Add the path to `allowedRoots`, then `systemctl --user restart nanoclaw`.

## Kubernetes / image garbage collection

If you run Rancher Desktop with Kubernetes enabled, `kubelet` GCs unreferenced images when disk usage crosses ~85%. NanoClaw containers run with `--rm`, so the image has no long-running referrer and gets reaped overnight.

```bash
grep -i 'nanoclaw' ~/Library/Logs/rancher-desktop/k3s.log | grep 'Removing image'
grep -E 'image found|image NOT found' logs/nanoclaw.log
```

Disable Kubernetes if you don't need it:

```bash
rdctl set --kubernetes-enabled=false
./container/build.sh
```

If you need Kubernetes, push `nanoclaw-agent` to a registry the kubelet won't GC, or raise GC thresholds.

## "Worker not found" from `ncf inject`

The channel name resolution is partial-match. Two workers with overlapping prefixes confuse it:

```bash
ncf status        # confirms what's registered
ncf inject discord_<exact-folder> "..."
```

## Logs to read first

```bash
tail -f logs/nanoclaw.log
jq 'select(.level >= 50)' logs/nanoclaw.jsonl | tail -20
docker logs $(docker ps -q --filter name=<worker>) 2>&1 | tail -50
tail -f logs/shim.error.log
```

For tracing one request through every layer, see [testing.md](testing.md#trace-ids-end-to-end).
