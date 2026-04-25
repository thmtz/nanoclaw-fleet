# Instructions Composition

How each agent's `CLAUDE.md` is assembled from the repo, skills, MCP tool fragments, per-group memory, and personal config.

## What runs and when

`composeGroupClaudeMd(group)` (`src/claude-md-compose.ts`) runs on every container spawn from `container-runner.buildMounts()`. Output is deterministic — the same inputs produce the same `groups/<folder>/CLAUDE.md`. Output paths:

- `groups/<folder>/.claude-fragments/` — per-fragment files (one per skill, MCP tool, etc.)
- `groups/<folder>/CLAUDE.md` — the assembled top-level file with `@import` directives
- `groups/<folder>/CLAUDE.local.md` — created empty if missing; per-group memory the agent edits over time

The agent runner reads `CLAUDE.md` at startup and injects it into the SDK's `systemPrompt.append`. That puts it in the actual system prompt sent on every API call, so it survives compaction. `CLAUDE.local.md` is loaded by Claude Code's auto-memory and is editable per session.

## Layers

The composer assembles in this order:

1. **Shared base.** `/app/CLAUDE.md` (or whatever the v2 base ships) — instructions every agent shares, mounted read-only into the container.
2. **Skill fragments.** For each skill installed in `container/skills/<skill>/`, if the skill has an `instructions.md`, that file is added.
3. **MCP tool fragments.** For each built-in MCP tool module that ships an `instructions.md` (e.g. `container/agent-runner/src/mcp-tools/schedule_task.instructions.md`), the file is added.
4. **Per-MCP-server fragments.** Each entry in the agent group's `container.json::mcpServers` can declare an inline `instructions` field. Those are added too.
5. **Per-group `CLAUDE.local.md`.** The mutable scratchpad. Loaded automatically by Claude Code's auto-memory.
6. **Personal instructions** (fleet addition):
   - `~/.config/nanoclaw/instructions/global.md` — both master and workers
   - `~/.config/nanoclaw/instructions/master.md` — master only
   - `~/.config/nanoclaw/instructions/worker.md` — workers only
7. **`include_files`** (fleet addition): each path listed in `~/.config/nanoclaw/config.json::include_files` is inlined as another fragment.

Role-gated layers (master/worker) read `agent_groups.fleet_role` to decide which file to include.

## Why on every spawn

Two reasons. First, the composer is cheap and deterministic, so re-running it is a non-issue. Second, the alternative — caching — invites bugs where someone edits an instruction file and the agent keeps using the old one because the cache wasn't invalidated. The simplest correct rule is "regenerate every time".

## Personal instructions layering

The fleet adds the personal layer at step 6. Repo instructions set baseline behaviour (communication style, first-boot, workspace layout, channel manners). Personal fragments add your conventions — code-design rules, PR workflow, repo list, mount map, beads conventions. You don't edit repo instructions for personal preferences; you add a personal fragment.

The role gate matters: a `worker.md` fragment is added to worker `CLAUDE.md` and not to master `CLAUDE.md`, so you can keep master's instructions tight (it should be doing orchestration, not engineering) and worker instructions rich.

## `include_files`

If you keep a global `~/.claude/CLAUDE.md` with conventions you want every agent to follow, list it under `include_files`:

```json
{
  "include_files": ["~/.claude/CLAUDE.md"]
}
```

The composer inlines each file as a separate fragment. Behaviour is identical to the personal layer above — the file content lands in `systemPrompt.append`, surviving compaction.

`~/`-prefixed paths expand to the user's home directory. Absolute paths are accepted as-is. Missing files are logged and skipped.

## Why not write directly to CLAUDE.md?

A common temptation is "just put the personal stuff in `~/.claude/CLAUDE.md` and let Claude Code's `settingSources` load it". That works, but `settingSources` content is loaded as a setting source — under heavy compaction it can be trimmed before the conversation. Going through `systemPrompt.append` (which is what fragments and `include_files` do) is durable. You pay nothing for the safer path, so it's the default.

## CLAUDE.local.md (per-group memory)

`CLAUDE.local.md` is the per-group scratchpad. Agents edit it directly during their work; it survives across sessions. The composer creates an empty one if missing but never overwrites. Treat it as the agent's notebook — the place to record "I tried X, it didn't work because Y" or "the canonical entry point for this codebase is `src/foo.ts`".

For master, `CLAUDE.local.md` is also where the fleet keeps its discipline notes — for instance, the rule "do not unsolicited-destroy a worker" lives in the master's `CLAUDE.local.md` after `4ddfb43`.

## Files

| File | Role |
|-|-|
| `src/claude-md-compose.ts` | The composer |
| `src/group-init.ts` | Per-group filesystem scaffold (calls the composer on init) |
| `src/container-runner.ts` | Calls `composeGroupClaudeMd` in `buildMounts()` so every spawn picks up edits |
| `~/.config/nanoclaw/instructions/{global,master,worker}.md` | Personal layer |
| `~/.config/nanoclaw/config.json` | `include_files` list |
| `groups/<folder>/.claude-fragments/` | Generated fragment files |
| `groups/<folder>/CLAUDE.md` | Assembled output (regenerated every spawn) |
| `groups/<folder>/CLAUDE.local.md` | Per-group memory (agent editable, never overwritten) |
