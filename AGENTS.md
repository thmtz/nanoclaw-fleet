# Agent Instructions

This project uses **bd** (beads) for issue tracking. See CLAUDE.md for workflow conventions.

## Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd create "title" -p N -d "description" --json
bd close <id> --reason "what was done" --json
```

## Non-Interactive Shell Commands

**ALWAYS use non-interactive flags** with file operations to avoid hanging on confirmation prompts.

```bash
cp -f source dest           # NOT: cp source dest
mv -f source dest           # NOT: mv source dest
rm -f file                  # NOT: rm file
rm -rf directory            # NOT: rm -r directory
```

Other commands that may prompt:
- `scp` / `ssh` — use `-o BatchMode=yes`
- `apt-get` — use `-y` flag
