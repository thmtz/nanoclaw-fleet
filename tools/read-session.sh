#!/bin/bash
# Display a worker's session transcript as a readable conversation.
# Usage: read-session.sh <group-folder> [lines]
# Example: read-session.sh discord_main 100

set -e

GROUP="${1:?Usage: read-session.sh <group-folder> [lines]}"
LINES="${2:-80}"
SESSION_DIR="data/sessions/${GROUP}/.claude/projects/-workspace-group"

if [ ! -d "$SESSION_DIR" ]; then
  echo "No sessions found for ${GROUP}" >&2
  exit 1
fi

# Use the most recent session file
FILE=$(ls -t "$SESSION_DIR"/*.jsonl 2>/dev/null | head -1)
if [ -z "$FILE" ]; then
  echo "No session files in ${SESSION_DIR}" >&2
  exit 1
fi

echo "Session: $FILE"
echo "---"

jq -r '
select(.message) |
.message as $m |
if $m.role == "user" then
  ($m.content // [] | if type == "array" then
    [.[] | select(.type == "text") | .text] | join("\n")
  else . end) | if . != "" then "\n👤 USER:\n" + .[0:500] else empty end
elif $m.role == "assistant" then
  ($m.content // [] | if type == "array" then
    [.[] |
      if .type == "text" then "💬 " + .text
      elif .type == "tool_use" then "🔧 " + .name + "(" + (.input | keys | join(", ")) + ")"
      elif .type == "thinking" then "💭 " + .thinking[0:200]
      else empty end
    ] | join("\n")
  else empty end) | if . != "" then "\n🤖 ASSISTANT:\n" + . else empty end
else empty end
' "$FILE" | tail -"$LINES"
