# Debug Checklist

A triage runbook. Run these in order when something is wrong and you don't know where to look. For specific symptoms with known fixes, start with [troubleshooting.md](troubleshooting.md).

## 1. Is the host running?

```bash
# Linux
systemctl --user status nanoclaw

# macOS
launchctl list | grep nanoclaw
```

A live PID column means running; `-` means stopped; a non-zero exit code means it crashed. If crashed:

```bash
journalctl --user -u nanoclaw -n 100      # Linux
tail -200 ~/Library/Logs/nanoclaw.log     # macOS
```

## 2. What does the host think the world looks like?

```bash
ncf debug
```

Dumps paths, the database location, running containers, proxy reachability, and resolved env. The fastest first look.

## 3. Containers

```bash
docker ps --format '{{.Names}} {{.Status}}' | grep nanoclaw           # running
docker ps -a --format '{{.Names}} {{.Status}}' | grep nanoclaw        # including stopped
ncf logs <worker> --follow                                            # live container logs
docker logs $(docker ps -q --filter name=<worker>) 2>&1 | tail -50    # last output
```

Per-spawn stderr is archived at `logs/workers/<folder>/stderr-<ts>.log` (last 20 retained), so you can read what a now-dead container said.

## 4. Logs

```bash
tail -f logs/nanoclaw.log                                # pretty
jq 'select(.level >= 50)' logs/nanoclaw.jsonl | tail     # errors as JSON
grep -E 'ERROR|WARN' logs/nanoclaw.log | tail -20
```

Structured fields you'll often filter on:

```bash
# all events for one trace id
jq 'select(.traceId == "t-1775854357638-9475")' logs/nanoclaw.jsonl

# slow container starts
jq 'select(.msg == "Container first output" and .startupMs > 10000)' logs/nanoclaw.jsonl

# group cardinality at boot
jq 'select(.msg | startswith("Loaded"))' logs/nanoclaw.jsonl | tail
```

## 5. Channel connectivity

The Discord gateway can wedge silently. Confirm the socket isn't stuck:

```bash
ss -tnp | grep CLOSE-WAIT | grep $(pgrep -f 'node dist')
grep -E 'Connected|Connection closed|gateway' logs/nanoclaw.log | tail -10
```

If you see CLOSE-WAITs piling up, restart the host.

## 6. Inference layer

```bash
# anthropic credential proxy
curl -s http://localhost:3001/healthz

# neuralwatt translation shim
curl -s http://localhost:3003/models | head
curl -s http://localhost:3003/usage | jq

# end-to-end probe
curl -s http://localhost:3003/w/discord_<worker>/v1/messages \
  -H "Content-Type: application/json" -H "x-api-key: placeholder" -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-opus-4-6","max_tokens":40,"messages":[{"role":"user","content":"hi"}]}'

tail logs/shim.error.log
```

## 7. Backend routing sanity

```bash
cat data/worker-backends.json | jq
ncf status --json | jq '.workers[] | {folder, backend, model}'
```

If the shim is forwarding Neuralwatt traffic to Anthropic by accident, the entry for that folder is missing or wrong. See the seeding section in [inference-routing.md](../architecture/inference-routing.md).

## 8. Mounts

```bash
grep -E 'Mount validated|Mount.*REJECTED|mount' logs/nanoclaw.log | tail
cat ~/.config/nanoclaw/mount-allowlist.json
sqlite3 store/messages.db "SELECT name, container_config FROM registered_groups;"
```

The allowlist is read once at host startup. Edits require `systemctl --user restart nanoclaw`.

## 9. Session state and transcript branching

```bash
# what session id has the host stored?
sqlite3 store/messages.db "SELECT session_id FROM sessions WHERE group_folder='discord_<worker>';"

# how many SDK subprocesses have written to this session?
ls -la data/sessions/discord_<worker>/.claude/debug/ 2>/dev/null

# walk the transcript, show parent UUIDs
python3 - <<'PY'
import json, sys, glob
for path in glob.glob('data/sessions/discord_<worker>/.claude/projects/*/*.jsonl'):
    print(f'== {path}')
    for i, line in enumerate(open(path).read().splitlines(), 1):
        try:
            d = json.loads(line)
            if d.get('type') == 'user' and d.get('message'):
                parent = d.get('parentUuid', 'ROOT')[:8]
                content = str(d['message'].get('content',''))[:60]
                print(f'L{i} parent={parent} {content}')
        except: pass
PY
```

## 10. Image GC (Rancher Desktop)

If `Container exited with code 125: pull access denied for nanoclaw-agent`, the kubelet GC'd the image:

```bash
grep -i 'nanoclaw' ~/Library/Logs/rancher-desktop/k3s.log | grep -i 'remove'
grep -E "image found|image NOT found" logs/nanoclaw.log
```

Disable Kubernetes if you don't need it (`rdctl set --kubernetes-enabled=false`) or push the image somewhere the kubelet won't reap.

## Service management

```bash
# Linux
systemctl --user restart nanoclaw
systemctl --user restart nanoclaw-shim
systemctl --user stop nanoclaw

# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
launchctl bootout gui/$(id -u)/com.nanoclaw
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.nanoclaw.plist
```

`systemctl --user stop nanoclaw` does **not** kill running containers. They keep going until they exit or hit Docker's max-connection cap. Use `docker stop` (or `docker kill`) if you need them gone before a clean restart.
