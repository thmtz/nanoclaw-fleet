/**
 * MCP tools barrel — imports each tool module for its side-effect
 * `registerTools([...])` call, then starts the MCP server.
 *
 * Adding a new tool module: create the file, call `registerTools([...])`
 * at module scope, and append the import here. No central list.
 */
import './core.js';
import './scheduling.js';
import './interactive.js';
import './agents.js';
import './self-mod.js';
// Fleet tools are only exposed to master-role containers. Keeping the import
// here + env-gated registration inside fleet.ts is simpler than a conditional
// import (which Bun's bundler handles poorly for side-effect-only modules).
if (process.env.NANOCLAW_FLEET_ROLE === 'master') {
  await import('./fleet.js');
}
import { startMcpServer } from './server.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

startMcpServer().catch((err) => {
  log(`MCP server error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
