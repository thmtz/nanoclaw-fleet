---
name: status
description: Report a Discord-formatted status dashboard of the fleet — master state, every worker's backend/model/uptime, and a summary footer. Trigger on the user typing "/status", "status?", "fleet status", "what's running", or anything semantically equivalent to "show me what's running right now."
---

# /status — fleet dashboard

## When to use

The user wants a snapshot of fleet state — master plus every worker, their backends, and uptime. Trigger on any phrasing that maps to "show me what's running":

- `/status`
- `status?`
- `fleet status`
- `what's running?`
- `list workers`
- `who's up?`

## What to do

Call the `mcp__nanoclaw__list_workers` MCP tool. The host runs the query synchronously and posts a formatted dashboard (master state + per-worker bullets + summary footer) to the master's channel as a chat message. Your turn-result text after the call should be wrapped in `<internal>...</internal>` because the dashboard already landed via the MCP tool path — anything you write afterwards is duplicate chatter.

```
<internal>Status dashboard delivered via list_workers.</internal>
```

That's the entire skill.

## What NOT to do

- Don't try to enumerate workers from `docker ps` or your own context — `list_workers` is the only source of truth. It also includes archived workers and master state which `docker ps` doesn't.
- Don't paraphrase the dashboard. The format is intentional: the user reads it on a phone, scanning for icons + uptimes. Reformatting loses information.
- Don't run after every message. Only on explicit "show me status" intent.

## v1 parity note

This is the v2 equivalent of v1 fleet's `/status` skill (FORK-SPEC §13.3), which ran `tools/nc-status.sh` and forwarded the output. The v2 form is simpler because the dashboard logic lives in `list_workers` itself rather than a separate shell script — the skill just routes the request.
