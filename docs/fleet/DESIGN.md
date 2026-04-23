# Fleet on v2 — Design

Port `nanoclaw-fleet` affordances onto NanoClaw v2 base. Keep v2 entity model, session DB, provider registry, OneCLI credential vault, admin/owner, `create_agent`. Add back fleet-specific: Discord-channel-per-worker, destroy+preserve-workspace, runtime backend switch with Claude-Agent-SDK-over-OpenAI-compat, fuzzy model resolve, `ncf` CLI, session restore on recreate.

Scope: prototype. MVP = admin in one Discord "master" channel can run `create worker X`, `destroy X`, `switch X to <backend> <model>`, `list workers`. Each worker has own channel + own container + own session. OpenAI-compat workers route via shim; Claude workers route via OneCLI. Backend and model persist in central DB.

## Layers

### 1. Fleet MCP tools (admin-only)

Container-side tool file `container/agent-runner/src/mcp-tools/fleet.ts`. Tools emit `messages_out` with `kind: 'system'`. Host handler modules do the work. Same pattern as `create_agent`.

| Tool | Args | Handler result |
|-|-|-|
| `create_worker` | name, backend?, model?, instructions? | Creates agent_group + folder + CLAUDE.md, creates Discord channel, wires messaging_group_agents, bidirectional destinations, seeds container.json with backend/model. |
| `destroy_worker` | name, delete_channel? | Stops container. Marks agent_group archived (new `status` col). Keeps sessions/ folder and group folder. Optionally deletes Discord channel. Drops destination from parent. |
| `switch_backend` | name, backend, model? | Updates `agent_groups.agent_provider` + `container.json::providers.<backend>.model`. Kills container; next wake uses new provider. |
| `list_workers` | (none) | Returns agent_groups (non-archived) + sessions summary + current backend/model. Query-only, no messages_out. |

Admin gating: tool exposure filtered in `mcp-tools/index.ts` by admin-flag from session DB metadata (same approach as `create_agent`). Host re-checks on delivery via `src/command-gate.ts` pattern.

### 2. Host-side fleet module

`src/modules/fleet/`:

- `create-worker.ts` — delivery handler for `action: 'create_worker'`
- `destroy-worker.ts` — handler for `destroy_worker`
- `switch-backend.ts` — handler for `switch_backend`
- `discord-channel.ts` — Discord REST wrapper (create/delete channel)
- `backend-config.ts` — write `container.json::providers.<name>` block
- `migrations/` — add `status` col to agent_groups, `fleet_meta` table (backend/model cache for fast list)
- `index.ts` — register delivery actions in action router

### 3. Neuralwatt provider (Claude Agent SDK → OpenAI-compat shim)

`container/agent-runner/src/providers/neuralwatt.ts`:

- Subclass (or factory-mirror) of ClaudeProvider
- Sets `ANTHROPIC_BASE_URL=http://host.docker.internal:3003` in env
- Sets `ANTHROPIC_AUTH_TOKEN` from OneCLI-proxied secret
- Passes model per-query (drives shim routing)

`src/providers/neuralwatt.ts` host-side:

- Registers provider container config
- Ensures shim is running (spawns as child of host on provider registration)
- Tracks shim port (default 3003)

`tools/anthropic-shim.ts` (port of fleet shim):

- Express server on 3003
- Translates Anthropic Messages API ↔ OpenAI-compat `/v1/messages` of Neuralwatt endpoint
- Streaming SSE translation
- Fuzzy model resolution: `/v1/models` at shim startup, fuzzy-match on request
- Per-request audit log → `logs/workers/<folder>/turns.jsonl`

### 4. ncf CLI

`bin/ncf` → TS script in `scripts/ncf.ts`. Shares code with host module handlers via `src/modules/fleet/lib.ts`.

| Command | Path |
|-|-|
| `ncf status` | query central DB agent_groups + sessions + container_status |
| `ncf logs <w> [--follow --cache --slow]` | tail `logs/workers/<folder>/turns.jsonl` |
| `ncf inject <channel> <msg> [--wait]` | write messages_in directly, optionally poll messages_out |
| `ncf switch <w> <backend> [model]` | calls same handler as `switch_backend` tool |
| `ncf create <name> [--backend --model]` | calls same handler as `create_worker` tool |
| `ncf destroy <w>` | calls same handler as `destroy_worker` tool |
| `ncf session <w> [n]` | dump recent session transcript from `.claude/` |
| `ncf restart <w> [--fresh]` | kill container; `--fresh` wipes `.claude/` |

No ncf-specific business logic. All work in `src/modules/fleet/lib.ts`.

### 5. Session restore on recreate

In `create_worker` handler:

1. Normalize name to folder slug
2. Query `agent_groups WHERE folder = ? AND status = 'archived'`
3. If found + name matches: unarchive (`status = 'active'`), reuse folder + sessions, re-wire Discord channel, return "resumed"
4. If found + name differs (collision): ask via `ask_user_question` → resume / new with suffix / cancel
5. Else: fresh create

### 6. Master agent CLAUDE.md

`groups/master/CLAUDE.md` seeded on first setup:

- Parses natural language like "create worker named X based on neuralwatt kimi k2"
- Maps to `create_worker(name="X", backend="neuralwatt", model="kimi")`
- Same for destroy/switch/list
- Instructed NOT to implement work itself — only lifecycle operations

## Data model additions

```sql
-- migration: 010-fleet.ts
ALTER TABLE agent_groups ADD COLUMN status TEXT DEFAULT 'active';  -- 'active' | 'archived'
ALTER TABLE agent_groups ADD COLUMN fleet_backend TEXT;            -- cached from container.json
ALTER TABLE agent_groups ADD COLUMN fleet_model TEXT;
CREATE INDEX idx_agent_groups_status ON agent_groups(status);
```

Why cache backend/model on row: `ncf status` and `list_workers` shouldn't read container.json per-row. Handlers keep row and file in sync.

## Container config extension

`groups/<folder>/container.json`:

```json
{
  "providers": {
    "neuralwatt": {
      "model": "zai-org/GLM-5.1-FP8",
      "base_url": "http://host.docker.internal:3003"
    },
    "claude": {
      "model": "claude-opus-4-7"
    }
  },
  "active_provider": "neuralwatt"
}
```

Host reads `active_provider` → picks env/mount block → passes to container. `switch_backend` rewrites this file and kicks container.

## Security/gating

- `create_worker`, `destroy_worker`, `switch_backend` admin-only
- Only users with `owner` or `admin` (global or scoped to master agent group) can invoke
- `list_workers` allowed to any member of master group
- Discord channel creation gated by bot permission + category env var
- Neuralwatt shim binds to localhost only

## MVP cut (what I'll actually build first)

Goal: boot up, create a worker via master, send it a message, destroy it.

1. v2 setup works on devbox (Discord, master channel, owner user)
2. Fleet migration applied (status col)
3. `create_worker` MCP tool + handler wired, admin-gated
4. `destroy_worker` MCP tool + handler
5. `list_workers` query tool
6. `discord-channel.ts` — create/delete channel, wire DB row
7. Claude provider path works end-to-end (skip Neuralwatt for now)
8. Smoke test via debug bot in Discord

Layer 3 (Neuralwatt provider), Layer 4 (ncf), `switch_backend`, session restore — all post-MVP. Verify core shape first.

## Verification plan

1. Boot NanoClaw v2 with fleet branch
2. Pair Discord bot, register master agent group + channel, promote joey to owner
3. In master channel: "create a worker named testbot that runs on claude"
4. Master calls `create_worker`; handler creates channel + agent_group; new channel appears in Discord
5. Send message in new channel → container spins up → replies
6. In master channel: "list workers" → shows testbot
7. In master channel: "destroy testbot" → channel deleted, agent archived
8. "create worker named testbot" again → resume prompt; workspace preserved

## Open issues

- v2's `create_agent` already exists. Wrap or replace? Plan: `create_worker` = `create_agent` + Discord channel provisioning + backend config. Keep `create_agent` for agent-only sub-agents (no channel).
- Admin flag propagation to MCP tool exposure: check how v2 currently does this for `create_agent` (assume session-DB metadata). Mirror.
- Shim port conflict with multiple installs: use v2's `install-slug` pattern to namespace port.
