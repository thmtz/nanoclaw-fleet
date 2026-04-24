# Personal config templates

Reference files the user copies into `~/.config/nanoclaw/` to drive per-host
behaviour the repo itself doesn't ship.

## master-profiles/CLAUDE.master.example.md

Reference master-agent system prompt ported from the v1 nanoclaw-fleet fork.
Covers worker lifecycle orchestration, `ncf` CLI usage, dual-backend routing,
and "dumb master, smart worker" discipline.

To use: drop the contents into `~/.config/nanoclaw/instructions/master.md`.
Fleet v2's CLAUDE.md compose (`src/claude-md-compose.ts`) inlines that file
as a fragment on every master spawn.

## worker-profiles/

Reference artifacts the fleet worker-profile loader expects:

- `CLAUDE.worker.example.md` — system prompt content for workers. Copy into
  `~/.config/nanoclaw/instructions/worker.md` for role-level instructions.
- `example.json` — schema reference. Copy to
  `~/.config/nanoclaw/worker-profiles/default.json` and edit.
- `init.sh.example` — original v1 container-side init script. v2 ships its
  own copy at `container/worker-init.sh` that reads `fleetProfile` from the
  mounted `container.json`; this file is kept here as a readable reference
  for the profile contract.
