---
name: status
description: Show NanoClaw system status — workers, containers, backends, energy usage, and orphans.
allowed-tools: Bash(bash), mcp__nanoclaw__send_message
---

# /status — NanoClaw System Status

Run the status dashboard script and send the output to Discord.

## Steps

1. Run the status script:
   ```bash
   bash /workspace/project/tools/nc-status.sh
   ```

2. Send the full output to Discord via `send_message`. Do not truncate or summarize — send the complete output as-is.

3. Do NOT also return text output — wrap your final output in `<internal>` tags so it isn't duplicated.
