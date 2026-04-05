#!/bin/bash
# Query per-worker audit logs.
#
# Usage:
#   nc-logs.sh                          # Summary of all workers
#   nc-logs.sh <worker>                 # Last 20 turns for a worker
#   nc-logs.sh <worker> <n>             # Last N turns for a worker
#   nc-logs.sh <worker> --cache         # Show only turns with cache hits
#   nc-logs.sh <worker> --slow [ms]     # Show turns slower than N ms (default: 5000)
#
# The audit log is at logs/workers/<folder>/turns.jsonl
# Each line: {"ts","model","backend","input_tokens","output_tokens","cached_tokens","latency_ms","stop_reason","stream"}

set -e

NANOCLAW_DIR="${NANOCLAW_DIR:-$(dirname "$0")/..}"
LOGS_DIR="$NANOCLAW_DIR/logs/workers"

if [ ! -d "$LOGS_DIR" ]; then
  echo "No audit logs found at $LOGS_DIR"
  echo "Logs are written after workers process API requests."
  exit 0
fi

# No args: summary of all workers
if [ -z "$1" ]; then
  printf "%-30s %6s %10s %10s %10s %8s\n" "WORKER" "TURNS" "IN_TOK" "OUT_TOK" "CACHED" "LAST"
  printf "%-30s %6s %10s %10s %10s %8s\n" "------" "-----" "------" "-------" "------" "----"
  for dir in "$LOGS_DIR"/*/; do
    [ -d "$dir" ] || continue
    folder=$(basename "$dir")
    file="$dir/turns.jsonl"
    [ -f "$file" ] || continue
    turns=$(wc -l < "$file" | tr -d ' ')
    # Use jq for aggregation
    stats=$(jq -s '{
      in: ([.[].input_tokens] | add // 0),
      out: ([.[].output_tokens] | add // 0),
      cached: ([.[].cached_tokens // 0] | add),
      last: (last.ts // "n/a")
    }' "$file" 2>/dev/null || echo '{"in":0,"out":0,"cached":0,"last":"n/a"}')
    in_tok=$(echo "$stats" | jq -r '.in')
    out_tok=$(echo "$stats" | jq -r '.out')
    cached=$(echo "$stats" | jq -r '.cached')
    last=$(echo "$stats" | jq -r '.last' | cut -c12-19)  # HH:MM:SS
    printf "%-30s %6d %10d %10d %10d %8s\n" "$folder" "$turns" "$in_tok" "$out_tok" "$cached" "$last"
  done
  exit 0
fi

WORKER="$1"
# Normalize: if just a name, try discord_ prefix
FOLDER="$WORKER"
if [ ! -d "$LOGS_DIR/$FOLDER" ]; then
  FOLDER="discord_$WORKER"
fi

FILE="$LOGS_DIR/$FOLDER/turns.jsonl"
if [ ! -f "$FILE" ]; then
  echo "No audit log for $FOLDER"
  echo "Checked: $FILE"
  exit 1
fi

# --cache: filter to cache hits only
if [ "$2" = "--cache" ]; then
  echo "Cache hits for $FOLDER:"
  jq -r 'select(.cached_tokens != null and .cached_tokens > 0) |
    "\(.ts | .[11:19]) \(.model | .[0:30]) in=\(.input_tokens) cached=\(.cached_tokens) (\(.cached_tokens * 100 / .input_tokens | floor)%)"' "$FILE"
  exit 0
fi

# --slow: filter to slow requests
if [ "$2" = "--slow" ]; then
  threshold="${3:-5000}"
  echo "Requests slower than ${threshold}ms for $FOLDER:"
  jq -r "select(.latency_ms != null and .latency_ms > $threshold) |
    \"\(.ts | .[11:19]) \(.model | .[0:30]) \(.latency_ms)ms in=\(.input_tokens) out=\(.output_tokens)\"" "$FILE"
  exit 0
fi

# Default: last N turns
N="${2:-20}"
echo "Last $N turns for $FOLDER ($(wc -l < "$FILE" | tr -d ' ') total):"
echo ""
tail -n "$N" "$FILE" | jq -r '
  "\(.ts | .[11:19])  \(.backend | .[0:4])  \(.model | .[0:35] | . + " " * (35 - length))  in=\(.input_tokens)\(if .cached_tokens then " cached=\(.cached_tokens)" else "" end)  out=\(.output_tokens)\(if .latency_ms then "  \(.latency_ms)ms" else "" end)  \(.stop_reason)"'
