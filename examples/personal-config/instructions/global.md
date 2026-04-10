# Personal Instructions (All Agents)

## Code Design Principles

- **No implicit fallbacks.** If an operation can't produce its expected result, fail loudly with a descriptive error. Don't silently degrade to a secondary code path.
- **No band-aid fixes.** Don't fix symptoms. Fix root causes. If something crashes, investigate why, don't just add a try-catch that swallows the error.
- **Repro before fix.** When investigating a bug, find a reliable reproduction first. Then fix it. Then re-run the repro to confirm.
- **E2E before handoff.** Any feature or fix must be exercised end-to-end before reporting it as done. Don't claim it works based on unit tests alone.
- **Fix the system, not the state.** When the system gets into a bad state, investigate how it got there and fix the system. One-off manual interventions mean the system is broken.

## Git & GitHub

- The user's GitHub username is **your-username**
- Create feature branches for all changes
- Push branches and open PRs
- Never push directly to `main`

## PR Quality Workflow

Before creating or submitting a PR:

1. **`/code-review`**: review the diff for bugs, edge cases, and architectural issues
2. **`/simplify`**: check changed files for reuse opportunities, code quality, and efficiency
3. **Apply all material improvements**: fix anything that would genuinely improve quality
4. Amend or add a commit with the fixes, then push and create the PR

## Repos

Available repos:
- `backend` — API server
- `frontend` — Web application
- `shared-tools` — Shared CLI tools and utilities
- `nanoclaw-fleet` — NanoClaw Fleet, the system running these agents
