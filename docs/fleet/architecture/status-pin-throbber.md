# Status Pin and Throbber

Two small UX features that surface fleet state directly in Discord without spamming notifications.

## Status pin

Pinned messages give you a live snapshot of the fleet without checking `ncf status`. Two kinds:

- **Master pin** in `#master` — overall fleet state (master + every worker).
- **Per-worker pin** in each worker's channel — that worker's state alone (model, container, requests, tokens, energy, last activity).

Both use Discord's edit-in-place primitive, so updates don't trigger push notifications. The pinned message id is persisted in the central `chat_sdk_kv` KV table:

- `fleet:status-pin:master`
- `fleet:status-pin:worker:<folder>`

Edits every 30 seconds (configurable via `FLEET_STATUS_PIN_INTERVAL_MS`; set to `0` to disable). The format inside the pin is the same `ncf status --no-color` output, with a fleet usage summary appended when energy data is available.

## Stale-pin self-heal

Status pins only stay one-per-channel if everyone plays nicely. Two failure modes leak extra pins:

1. The bot identity changes (token rotation, debug-bot debugging) and old pins from the previous identity stay pinned.
2. The host can't edit the existing pin (channel permissions, deleted message), creates a new one, but doesn't unpin the old.

The status pin runner sweeps stale pins on every channel update, force-unpinning any pin authored by the bot that isn't the current expected message id. The first sweep on host startup is unconditional; subsequent sweeps run at most every 10 minutes per channel to keep API traffic down.

Source: `src/modules/status-pin/index.ts`. Two key entry points:

- `startStatusPin(masterMsgId, workerFolders, deps)` — spawns the loop.
- `unpinStalePins(adapter, channelType, platformId, threadId, key)` — the sweeper.

## Energy in the status pin

If `NW_SHIM_USAGE_PATH` points at the shim's per-folder usage file, the status pin reads it on every update and includes per-worker usage (requests, tokens, kWh) plus a fleet total. The shim's accumulator is the source of truth for energy; no double-counting.

Without the env, the pin still shows everything else and just omits energy lines.

## Throbber

A different signal: while a worker is actively thinking, the user's incoming message gets a reaction emoji that cycles. When the agent stops cycling, you know inference is hung — not just slow.

How it works:

1. The container touches `/workspace/.heartbeat` on every SDK event.
2. The host watches the heartbeat file with `fs.watchFile` (polling at ~400ms granularity).
3. Each heartbeat tick advances the reaction emoji on the user's message (e.g. 🔵 → 🟦 → 🔷 → ⚪️ → 🟦).
4. When the first non-system, user-facing message lands in `outbound.db`, the throbber stops and the reaction is cleared.

If the heartbeat goes silent for more than a few seconds, the emoji stops changing. That's your visual signal that the SDK or the model is stuck. No log spam, no DM — the worker's own channel tells you.

Source: `src/modules/throbber/index.ts`.

## Why both?

The status pin is a low-frequency snapshot ("what does the fleet look like right now?"). The throbber is a high-frequency progress signal ("is this worker still alive?"). They cover different operational questions and don't interfere — the pin lives in the channel header, the throbber lives on the inbound message.

## Files

| File | Role |
|-|-|
| `src/modules/status-pin/index.ts` | Pin runner, sweeper, energy read-through |
| `src/modules/throbber/index.ts` | Heartbeat watcher, reaction cycler |
| `chat_sdk_kv` (central DB) | Persisted pin message ids |
| `data/v2-sessions/<ag>/<sess>/.heartbeat` | Container heartbeat file |
| `NW_SHIM_USAGE_PATH` | Optional env: shim's usage accumulator path |
| `FLEET_STATUS_PIN_INTERVAL_MS` | Optional env: pin update cadence (default 30000) |
