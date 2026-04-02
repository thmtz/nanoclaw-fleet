# Design: Shared Beads Inbox via Remote Dolt Server

Status: **Implemented** | Created: 2026-03-28 | Updated: 2026-03-29

## Problem

Workers need to file beads (issues, ideas, env requests) that other workers and the host can see. The obvious approach — mounting the host's `.beads/` directory into containers — fails because dolt (beads' database backend) uses file-level locks. When a container dies, stale lock files remain, blocking the next `bd` invocation. Multiple dolt servers can't share the same data directory.

We also hit a beads version mismatch: the container's `bd` (0.62.0) created a schema the host's `bd` (0.61.0) couldn't read ("column crystallizes not found"). Both need to run the same version.

See [beads issue #1084](https://github.com/steveyegge/beads/issues/1084) for the same problem in devcontainers.

## Solution

Run a single dolt server on the host, bound to the Docker bridge interface (`0.0.0.0:3307`). Workers connect to it as remote clients via `host.docker.internal:3307`. No `.beads/` mount needed — workers get a lightweight config file created by `init.sh` at container startup.

```
Host (dolt sql-server on 0.0.0.0:3307)
  ↑
  ├── Host bd CLI connects via 0.0.0.0:3307
  ├── Worker A connects via host.docker.internal:3307
  └── Worker B connects via host.docker.internal:3307
```

Dolt handles concurrent access natively in server mode. No lock files, no conflicts.

## Setup

The dolt server runs as a systemd service: `beads-inbox-dolt.service`. The inbox database lives at `~/git/claude-inbox/.beads/dolt/`.

Workers get a config file created by `init.sh` at `/workspace/shared-beads/inbox/.beads/` pointing at the host's dolt server. Workers use beads normally (`bd create`, `bd list`, etc.) from the `/workspace/shared-beads/inbox/` directory.

A `root@%` MySQL user was created in dolt to allow container connections (containers connect from Docker bridge IPs, not localhost).

## Services

```bash
systemctl --user status beads-inbox-dolt    # Dolt server for shared inbox
systemctl --user restart beads-inbox-dolt
```

## Usage from Workers

```bash
cd /workspace/shared-beads/inbox
bd create --title="[myproject] foo crashes" --type=bug --priority=2
bd list
bd ready
```

## What Goes in the Inbox

Cross-repo bugs, environment requests, misc ideas. Tag beads with the target repo in brackets. Per-repo beads (private to the worker's task) stay in the worker's own clone in stealth mode.
