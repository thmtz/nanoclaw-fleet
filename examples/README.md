# Personal config templates

Reference files the user copies into `~/.config/nanoclaw/` to drive per-host
behaviour the repo itself doesn't ship.

For full documentation of how the personal layer composes into a running
agent's `CLAUDE.md`, see
[`docs/fleet/architecture/instructions.md`](../docs/fleet/architecture/instructions.md)
and [`docs/fleet/guides/personal-config.md`](../docs/fleet/guides/personal-config.md).

## worker-profiles/

Reference artifacts the fleet worker-profile loader expects:

- `example.json` — schema reference. Copy to
  `~/.config/nanoclaw/worker-profiles/default.json` and edit.
- `init.sh.example` — original v1 container-side init script. v2 ships its
  own copy at `container/worker-init.sh` that reads `fleetProfile` from the
  mounted `container.json`; this file is kept here as a readable reference
  for the profile contract.

## Where the agent's behaviour comes from

There's no example `CLAUDE.md` to copy any more — the runtime CLAUDE.md is
composed at every spawn from:

- `container/CLAUDE.md` (shared base, mounted RO)
- per-MCP-tool fragments under
  `container/agent-runner/src/mcp-tools/*.instructions.md`
- per-skill fragments
- `~/.config/nanoclaw/instructions/{global,master,worker}.md` (your personal
  layer)
- `groups/<folder>/CLAUDE.local.md` (per-group memory the agent edits over
  time)

If you're customizing how an agent behaves, edit the personal layer. If
you're customizing what tools/repos a worker boots with, edit
`worker-profiles/default.json`. The repo doesn't ship behaviour templates
because they drift against the runtime fragments.
