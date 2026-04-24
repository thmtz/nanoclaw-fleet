# Sender access control: v1 → v2 mapping

The v1 nanoclaw-fleet fork had a single file — `data/sender-allowlist.json` —
that governed who could send messages to each chat. It supported two
behaviours per chat:

- `mode: "trigger"` — allow only the listed senders to *wake the agent*;
  ignored senders' messages were stored but did not trigger a turn.
- `mode: "drop"` — discard messages from non-allowlisted senders entirely.

v2 replaces this with a **three-axis model** on the messaging_groups +
messaging_group_agents tables, plus a user-level `user_roles` table.
Covers the same behaviours, but the knobs are separate and combine.

## v2 knobs

| Column | Table | Values | Effect |
|-|-|-|-|
| `unknown_sender_policy`       | messaging_groups         | `strict` \| `request_approval` \| `public` | What happens when a *never-seen-before* sender posts. strict = silent drop. request_approval = escalate to owner. public = auto-allow |
| `denied_at`                   | messaging_groups         | ISO string \| NULL      | Owner denied the whole chat. Every message drops. Set by the channel-request gate |
| `sender_scope`                | messaging_group_agents   | `all` \| `known`        | Whether the wired agent engages for all senders or only `known` ones (have a users row). Per-wiring |
| `role` + `agent_group_id`     | user_roles               | `owner` \| `admin`      | Elevates a user to owner / admin. Unrelated to engagement but often paired |

## Equivalences

| v1                                          | v2                                                                                 |
|-|-|
| allowlist `allow: "*"`, `mode: "trigger"`   | `unknown_sender_policy='public'`, `sender_scope='all'` — default for worker channels |
| allowlist `allow: [...]`, `mode: "trigger"` | `unknown_sender_policy='request_approval'`, `sender_scope='known'` — allowed users are those in the users table; new ones need owner approval |
| allowlist `allow: [...]`, `mode: "drop"`    | `unknown_sender_policy='strict'`, `sender_scope='known'` — unapproved messages are silently dropped |
| allowlist `allow: "*"`, `mode: "drop"`      | not meaningful (drop-all wouldn't accept anything; use `denied_at` instead)         |
| chat-wide block                             | `denied_at` on the messaging_group row                                              |

## Gaps vs v1

**Ban-a-known-user**: v1 could drop messages from a specific user by
omitting them from the allowlist. v2 has no per-user deny list — if a
user appears in the users table and `sender_scope='known'`, they can
engage. Workarounds:

1. Remove the user from the users table. (Breaks everything they did.)
2. Revoke their `user_roles` row and set `unknown_sender_policy='strict'`.
   Then they're effectively a known-but-unapproved sender and fall
   through to the strict branch.

If the workaround isn't sufficient, the natural extension is a small
`user_denylist(user_id, agent_group_id)` table with a router-side check
before engagement. Not yet implemented because the use case hasn't come
up in practice — filed for the day it does.

## TL;DR

v2 covers every v1 allowlist scenario except per-user bans within an
otherwise-allowed chat. For that, wait for a reason to add it.
