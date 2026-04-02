#!/bin/bash
# Inject a message into a NanoClaw channel from the host.
# Usage: nc-inject.sh [--wait] <channel-name-or-jid> <message>
#
# Options:
#   --wait    Wait for the agent to respond and print the output (polls docker logs)
#
# Examples:
#   nc-inject.sh master "list all workers"
#   nc-inject.sh --wait test "what model are you?"
#   nc-inject.sh dc:YOUR_CHANNEL_ID "hi"

set -e

WAIT=false
if [ "$1" = "--wait" ]; then
  WAIT=true
  shift
fi

DB="${NANOCLAW_DB:-$(dirname "$0")/../store/messages.db}"
CHANNEL="$1"
MESSAGE="$2"

if [ -z "$CHANNEL" ] || [ -z "$MESSAGE" ]; then
  echo "Usage: nc-inject.sh [--wait] <channel-name-or-jid> <message>"
  echo ""
  echo "Channel can be: worker name, folder name, or full JID (dc:...)"
  echo "  --wait    Wait for agent response and print it"
  exit 1
fi

# Resolve channel to JID (escape quotes for safety)
SAFE_CHANNEL="${CHANNEL//\'/\'\'}"
if [[ "$CHANNEL" == dc:* ]]; then
  JID="$CHANNEL"
elif [[ "$CHANNEL" == discord_* ]]; then
  JID=$(sqlite3 "$DB" "SELECT jid FROM registered_groups WHERE folder = '$SAFE_CHANNEL' LIMIT 1;")
  FOLDER="$CHANNEL"
else
  JID=$(sqlite3 "$DB" "SELECT jid FROM registered_groups WHERE name = '$SAFE_CHANNEL' LIMIT 1;")
  FOLDER=$(sqlite3 "$DB" "SELECT folder FROM registered_groups WHERE name = '$SAFE_CHANNEL' LIMIT 1;")
  if [ -z "$JID" ]; then
    JID=$(sqlite3 "$DB" "SELECT jid FROM registered_groups WHERE folder = 'discord_$SAFE_CHANNEL' LIMIT 1;")
    FOLDER="discord_$CHANNEL"
  fi
fi

if [ -z "$JID" ]; then
  echo "Error: channel '$CHANNEL' not found"
  echo ""
  echo "Available channels:"
  sqlite3 "$DB" "SELECT name, folder, jid FROM registered_groups;" | while IFS='|' read -r name folder jid; do
    echo "  $name ($folder) → $jid"
  done
  exit 1
fi

# Resolve folder if we only have JID
if [ -z "$FOLDER" ]; then
  FOLDER=$(sqlite3 "$DB" "SELECT folder FROM registered_groups WHERE jid = '$JID' LIMIT 1;")
fi

# Generate unique message ID and timestamp
MSG_ID="inject-$(date +%s%N)"
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)

# Escape single quotes for SQLite
SAFE_MESSAGE="${MESSAGE//\'/\'\'}"

# Insert message
sqlite3 "$DB" "INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES ('$MSG_ID', '$JID', 'host-agent', 'Host Agent', '$SAFE_MESSAGE', '$TIMESTAMP', 0, 0);"

echo "Injected into $JID: $MESSAGE"

if [ "$WAIT" = false ]; then
  echo "NanoClaw will pick it up on next poll cycle (~1s)"
  exit 0
fi

echo "Waiting for response..."

# Find the container for this group
TIMEOUT=120
ELAPSED=0
CONTAINER=""

# Wait for container to exist
while [ $ELAPSED -lt $TIMEOUT ] && [ -z "$CONTAINER" ]; do
  # Container names use dashes: nanoclaw-discord-test-<timestamp>
  # Folder uses underscore: discord_test. Convert for matching.
  CONTAINER_PATTERN="nanoclaw-${FOLDER//_/-}"
  CONTAINER=$(docker ps --format '{{.Names}}' | grep "$CONTAINER_PATTERN" | head -1)
  if [ -z "$CONTAINER" ]; then
    sleep 2
    ELAPSED=$((ELAPSED + 2))
  fi
done

if [ -z "$CONTAINER" ]; then
  echo "Timeout: no container spawned for $FOLDER after ${TIMEOUT}s"
  exit 1
fi

echo "Container: $CONTAINER"

# Count existing results before our message
EXISTING_RESULTS=$(docker logs "$CONTAINER" 2>&1 | grep -c "^---NANOCLAW_OUTPUT_END---" || true)

# Wait for a new result
while [ $ELAPSED -lt $TIMEOUT ]; do
  CURRENT_RESULTS=$(docker logs "$CONTAINER" 2>&1 | grep -c "^---NANOCLAW_OUTPUT_END---" || true)
  if [ "$CURRENT_RESULTS" -gt "$EXISTING_RESULTS" ]; then
    # Extract the latest result
    docker logs "$CONTAINER" 2>&1 | \
      grep -A1 "^---NANOCLAW_OUTPUT_START---" | tail -1 | \
      python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result','(no result)'))" 2>/dev/null || \
      docker logs "$CONTAINER" 2>&1 | grep "Result #" | tail -1
    exit 0
  fi
  sleep 2
  ELAPSED=$((ELAPSED + 2))
done

echo "Timeout: no response after ${TIMEOUT}s"
exit 1
