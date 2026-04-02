#!/bin/bash
# Send an IPC task to NanoClaw from the host.
# Usage: nc-ipc.sh <group-folder> <json-payload>
#
# Examples:
#   nc-ipc.sh discord_main '{"type":"create_worker","guild_id":"YOUR_GUILD_ID","channel_name":"test-inject","folder":"discord_test-inject","trigger":"@YourBot"}'
#   nc-ipc.sh discord_main '{"type":"destroy_worker","jid":"dc:123456"}'
#   nc-ipc.sh discord_main '{"type":"list_workers"}'

set -e

NANOCLAW_DIR="${NANOCLAW_DIR:-$(dirname "$0")/..}"
GROUP="$1"
PAYLOAD="$2"

if [ -z "$GROUP" ] || [ -z "$PAYLOAD" ]; then
  echo "Usage: nc-ipc.sh <group-folder> <json-payload>"
  exit 1
fi

TASKS_DIR="$NANOCLAW_DIR/data/ipc/$GROUP/tasks"
mkdir -p "$TASKS_DIR"

FILENAME="$(date +%s%N)-$(head -c 4 /dev/urandom | xxd -p).json"
TMPFILE="$TASKS_DIR/$FILENAME.tmp"
DESTFILE="$TASKS_DIR/$FILENAME"

echo "$PAYLOAD" > "$TMPFILE"
mv "$TMPFILE" "$DESTFILE"

echo "IPC task written: $DESTFILE"
echo "Host will process on next poll cycle (~1s)"
