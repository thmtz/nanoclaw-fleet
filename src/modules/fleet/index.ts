/**
 * Fleet module — master-agent-driven worker lifecycle on top of v2.
 *
 * Registers three delivery actions (create_worker, destroy_worker,
 * switch_backend). list_workers is a synchronous query invoked directly
 * from the MCP tool and so doesn't need a delivery-action handler.
 *
 * The master agent group (fleet_role='master') is the only one whose
 * container loads the fleet MCP tools, so workers themselves never emit
 * these actions. Each handler re-checks fleet_role as defense-in-depth.
 *
 * Without this module: fleet_role column is empty for all groups, the
 * delivery actions log "Unknown system action", and the MCP tools are
 * not loaded (container/agent-runner/src/mcp-tools/fleet.ts gates on
 * NANOCLAW_FLEET_ROLE=master).
 */
import { registerDeliveryAction } from '../../delivery.js';
import { handleCreateWorker } from './create-worker.js';
import { handleDestroyWorker } from './destroy-worker.js';
import { handleForkWorker } from './fork-worker.js';
import { handleListWorkersRequest } from './list-workers.js';
import { handleSwitchBackend } from './switch-backend.js';

registerDeliveryAction('create_worker', handleCreateWorker);
registerDeliveryAction('destroy_worker', handleDestroyWorker);
registerDeliveryAction('switch_backend', handleSwitchBackend);
registerDeliveryAction('fork_worker', handleForkWorker);
registerDeliveryAction('list_workers_request', handleListWorkersRequest);
