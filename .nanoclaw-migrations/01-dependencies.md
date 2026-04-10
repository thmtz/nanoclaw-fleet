# Migration Guide: Dependencies and Configuration

## Node.js Version Requirement

**Intent:** Ensure runtime compatibility with native modules and modern features.

**Files:** `.nvmrc`, `package.json` (engines field)

**How to apply:**
- Set Node.js requirement to 20 or higher: `echo "20" > .nvmrc`
- Update `package.json` engines field: `"engines": { "node": ">=20" }`
- Verify: `node --version` should report v20.x.x or higher

---

## New Dependencies Added

### discord.js ^14.18.0
**Intent:** Discord bot channel integration.

**Files:** `package.json` (dependencies)

**How to apply:**
```bash
npm install discord.js@^14.18.0
```

### pino-roll ^4.0.0
**Intent:** Log file rotation to prevent unbounded log growth.

**Files:** `package.json` (dependencies), logging configuration in `src/index.ts`

**How to apply:**
```bash
npm install pino-roll@^4.0.0
```

### qrcode ^1.5.4
**Intent:** Generate QR codes for WhatsApp authentication flow.

**Files:** `package.json` (dependencies), `src/whatsapp-auth.ts`

**How to apply:**
```bash
npm install qrcode@^1.5.4
```

### yaml ^2.8.2
**Intent:** Parse and serialize YAML configuration files (worker profiles, custom instructions).

**Files:** `package.json` (dependencies), setup and configuration modules

**How to apply:**
```bash
npm install yaml@^2.8.2
```

### husky ^9.1.7
**Intent:** Git hooks framework for pre-push validation (formatting, type-checking).

**Files:** `package.json` (devDependencies), `.githooks/pre-push`

**How to apply:**
```bash
npm install husky@^9.1.7 --save-dev
npx husky install
git config core.hooksPath .githooks
```

### prettier ^3.8.1
**Intent:** Code formatting enforcement.

**Files:** `package.json` (devDependencies), `.prettierrc`

**How to apply:**
```bash
npm install prettier@^3.8.1 --save-dev
```

Content of `.prettierrc`:
```json
{
  "singleQuote": true
}
```

### vitest ^4.0.18
**Intent:** Unit testing framework for host code and skills.

**Files:** `package.json` (devDependencies), `vitest.config.ts`, `vitest.skills.config.ts`

**How to apply:**
```bash
npm install vitest@^4.0.18 --save-dev
```

### @vitest/coverage-v8 ^4.0.18
**Intent:** Code coverage reporting for vitest.

**Files:** `package.json` (devDependencies)

**How to apply:**
```bash
npm install @vitest/coverage-v8@^4.0.18 --save-dev
```

### @types/qrcode-terminal (updated to ^0.12.0)
**Intent:** TypeScript definitions for qrcode-terminal (version constraint aligned with qrcode module).

**Files:** `package.json` (devDependencies)

**How to apply:**
```bash
npm install @types/qrcode-terminal@^0.12.0 --save-dev
```

---

## Removed Dependencies

### @anthropic-ai/claude-agent-sdk
**Intent:** Removed as agents now run in containers via Claude Agent SDK (not imported by host process).

**Files:** Container-based agent-runner handles SDK; host uses stdin/stdout IPC.

**How to apply:**
```bash
npm uninstall @anthropic-ai/claude-agent-sdk
```

### eslint
**Intent:** Replaced with prettier for formatting and tsc for type-checking.

**How to apply:**
```bash
npm uninstall eslint
```

---

## New npm Scripts

### format
```bash
npm run format
```
Formats all TypeScript in `src/**/*.ts` using Prettier (write mode).

### format:fix
```bash
npm run format:fix
```
Alias for `format` (write mode).

### format:check
```bash
npm run format:check
```
Check for formatting violations without modifying files (exits 1 if issues found).

### typecheck
```bash
npm run typecheck
```
Run TypeScript compiler in check-only mode (no emit).

### prepare
```bash
npm run prepare
```
Husky hook initialization (runs automatically on npm install).

### setup
```bash
npm run setup
```
Run interactive setup flow for authentication and configuration (executes `setup/index.ts`).

### test
```bash
npm run test
```
Run vitest in single-run mode (CI-friendly).

### test:watch
```bash
npm run test:watch
```
Run vitest in watch mode for development.

### ncf
```bash
npm run ncf
```
Run the CLI tool directly (executes `src/cli.ts` via tsx).

---

## Config Files

### .prettierrc
**Intent:** Enforce consistent code formatting.

**Files:** `.prettierrc`

**Content:**
```json
{
  "singleQuote": true
}
```

**How to apply:**
Create file with above content, or update if it exists.

### vitest.config.ts
**Intent:** Configure test runner for host code and setup modules.

**Files:** `vitest.config.ts`

**Content:**
```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'setup/**/*.test.ts'],
  },
});
```

**How to apply:**
Create or update this file in project root.

### vitest.skills.config.ts
**Intent:** Separate test config for skill tests in `.claude/skills/`.

**Files:** `vitest.skills.config.ts`

**Content:**
```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['.claude/skills/**/tests/*.test.ts'],
  },
});
```

**How to apply:**
Create in project root.

### .mcp.json
**Intent:** MCP server configuration (Slack integration for reading channel history).

**Files:** `.mcp.json`

**Content:**
```json
{
  "mcpServers": {
    "slack": {
      "command": "npx",
      "args": ["-y", "slack-mcp-server"],
      "env": {
        "SLACK_MCP_XOXP_TOKEN": "${SLACK_USER_TOKEN}"
      }
    }
  }
}
```

**How to apply:**
Create this file in project root. The `SLACK_USER_TOKEN` is substituted from environment at runtime.

---

## .env.example Variables

### Authentication
- `ANTHROPIC_API_KEY` — Direct Anthropic API access (exclusive with OAuth token)
- `CLAUDE_CODE_OAUTH_TOKEN` — OAuth token for Claude Max subscriptions (exclusive with API key)

### Model Selection
- `NANOCLAW_MODEL` — Which Claude model to use: `opus`, `sonnet`, or `haiku` (default: opus)

### Assistant Identity
- `ASSISTANT_NAME` — Bot's trigger name for @mentions (default: Eugene)
- `ASSISTANT_HAS_OWN_NUMBER` — Set to `"true"` if bot has its own WhatsApp number

### Discord
- `DISCORD_BOT_TOKEN` — Bot token from Discord Developer Portal
- `DISCORD_GUILD_ID` — Server ID where worker channels are created

### Slack (read-only)
- `SLACK_USER_TOKEN` — User token (xoxp-...) for reading channel history
  - Required scopes: `channels:history`, `groups:history`, `im:history`, `mpim:history`, `channels:read`, `groups:read`, `im:read`, `mpim:read`, `users:read`

### GitHub
- `NANOCLAW_GITHUB_TOKEN_PATH` — Systemd environment variable pointing to file containing GitHub PAT
  - Set in systemd service file, not in `.env`
  - PAT must have `repo` scope for private repo access

### Docker (optional)
- `NANOCLAW_ENABLE_DOCKER` — Set to `"true"` to give main agent Docker socket access (workers never get this)

**How to apply:**
Copy `.env.example` to `.env` and fill in required values for your deployment:
```bash
cp .env.example .env
# Edit .env with your tokens and configuration
```

---

## Git Hooks Configuration

### Pre-push Hook Setup
**Intent:** Enforce code quality before pushing (formatting, types, source validation).

**Files:** `.githooks/pre-push`

**How to apply:**
```bash
# One-time setup per clone
git config core.hooksPath .githooks

# Verify it's installed
cat .git/config | grep hooksPath
```

The hook will:
1. Block direct pushes to `main` (requires feature branch + PR)
2. Check code formatting with `npm run format:check`
3. Type-check host code with `tsc --noEmit`
4. Type-check agent-runner code (if `container/agent-runner/node_modules` exists)

Exit codes:
- 1: Formatting or type errors (run `npm run format` to fix)
- 0: All checks passed

---

## Installation Checklist

Run these commands in order on a fresh clone:

```bash
# 1. Install Node.js 20+
nvm use 20
# or verify: node --version

# 2. Bootstrap script
bash setup.sh

# 3. Install dependencies
npm ci

# 4. Setup git hooks (one-time per clone)
git config core.hooksPath .githooks

# 5. Verify setup
npm run typecheck
npm run format:check
npm run test

# 6. Build for production
npm run build
```

---

## Migration Path from Old Setup

If upgrading from a version without these changes:

```bash
# 1. Update package.json
npm ci

# 2. Setup formatting and testing
npm run format:check
npm run test

# 3. Enable git hooks
git config core.hooksPath .githooks

# 4. Configure environment
cp .env.example .env
# Edit .env with your values

# 5. Verify the new CLI
npm run ncf -- status
```
