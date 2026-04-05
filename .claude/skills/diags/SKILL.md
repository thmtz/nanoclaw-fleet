---
name: diags
description: Run NanoClaw diagnostics — check for orphaned containers/channels, auth issues, worker crashes, slow startups, and stale state. Use when something isn't working or when asked to run diagnostics.
user-invocable: true
---

# NanoClaw Diagnostics

Run all checks below and report a summary. Skip checks that don't apply (e.g., shim checks if nanoclaw-shim isn't running).

## 1. Service Health

```bash
# Check core services
systemctl --user is-active nanoclaw 2>/dev/null || echo "nanoclaw: NOT RUNNING"
systemctl --user is-active nanoclaw-shim 2>/dev/null || echo "shim: NOT RUNNING"

# Check credential proxy
curl -s -o /dev/null -w "%{http_code}" http://172.17.0.1:3001/ 2>/dev/null || echo "credential proxy: UNREACHABLE"

# Check shim
curl -s http://localhost:3003/health 2>/dev/null | jq -r '.status' || echo "shim: UNREACHABLE"
```

## 2. Orphaned Containers

Containers running that don't match any registered worker.

```bash
# Get running container folders
docker ps --filter name=nanoclaw- --format '{{.Names}}' | sed 's/nanoclaw-//;s/-[0-9]*$//' | tr '-' '_' | sort > /tmp/nc-running.txt

# Get registered folders
sqlite3 store/messages.db "SELECT folder FROM registered_groups;" | sort > /tmp/nc-registered.txt

# Diff
comm -23 /tmp/nc-running.txt /tmp/nc-registered.txt
```

If any are found, report them. They can be cleaned up with `docker stop <name>`.

## 3. Orphaned Discord Channels

Registered workers whose Discord channels no longer exist. This is harder to check without Discord API access. Instead, check for registered workers with no workspace:

```bash
sqlite3 store/messages.db "SELECT folder, name FROM registered_groups WHERE is_main=0;" | while IFS='|' read folder name; do
  [ -d "groups/$folder" ] || echo "ORPHAN: $name ($folder) — registered but no workspace"
done
```

## 4. Recent Errors

```bash
# Last 10 errors from JSONL logs
jq -r 'select(.level >= 50) | "\(.time / 1000 | strftime("%H:%M:%S")) \(.msg[0:100])"' logs/nanoclaw.jsonl 2>/dev/null | tail -10
```

## 5. Auth Failures

```bash
# Recent auth errors
jq -r 'select(.msg != null and (.msg | test("401|authenticate|API key|unauthorized"; "i"))) | "\(.time / 1000 | strftime("%H:%M:%S")) [\(.group // "host")] \(.msg[0:100])"' logs/nanoclaw.jsonl 2>/dev/null | tail -10
```

If auth failures are found, check:
- Is `.env` configured with a valid `CLAUDE_CODE_OAUTH_TOKEN`?
- Is the credential proxy running and reachable?
- Has the OAuth token expired?

## 6. Worker Health

```bash
# Workers that errored recently
jq -r 'select(.msg == "Agent returned error") | "\(.time / 1000 | strftime("%H:%M:%S")) [\(.group)] \(.error[0:100])"' logs/nanoclaw.jsonl 2>/dev/null | tail -10

# Container exit codes (non-zero = crash)
for log in $(ls -t groups/*/logs/container-*.log 2>/dev/null | head -5); do
  grep "Exit Code:" "$log" | grep -v "Exit Code: 0" && echo "  in: $log"
done
```

## 7. Slow Startups

```bash
# Container startups > 30s
jq -r 'select(.msg == "Container first output" and .startupMs > 30000) | "\(.time / 1000 | strftime("%H:%M:%S")) [\(.group)] \(.startupMs)ms"' logs/nanoclaw.jsonl 2>/dev/null | tail -10

# Last host startup timing
jq -r 'select(.msg | startswith("Startup: startup complete")) | "\(.time / 1000 | strftime("%H:%M:%S")) host startup: \(.elapsed)ms"' logs/nanoclaw.jsonl 2>/dev/null | tail -1
```

## 8. Stale State

```bash
# Sessions with no matching registered group (orphaned sessions)
for dir in data/sessions/discord_*/; do
  folder=$(basename "$dir")
  count=$(sqlite3 store/messages.db "SELECT count(*) FROM registered_groups WHERE folder='$folder';")
  [ "$count" = "0" ] && echo "STALE SESSION: $folder (not registered)"
done

# Worker env files for non-existent workers
for env in data/sessions/*/worker.env; do
  folder=$(basename "$(dirname "$env")")
  count=$(sqlite3 store/messages.db "SELECT count(*) FROM registered_groups WHERE folder='$folder';")
  [ "$count" = "0" ] && echo "STALE ENV: $folder"
done
```

## 9. Audit Log Summary

```bash
# Quick usage summary if nc-logs.sh exists
if [ -x tools/nc-logs.sh ]; then
  tools/nc-logs.sh
fi
```

## Report Format

Summarize findings in a short message:

- **Healthy**: "All checks passed — N workers running, no errors"
- **Issues found**: List each problem with a one-line description and suggested fix
- Don't dump raw command output — interpret it and report what matters
