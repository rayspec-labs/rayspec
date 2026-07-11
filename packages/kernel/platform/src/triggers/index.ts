/**
 * The `triggers` seam — PARSE/REGISTER ONLY.
 *
 * Registers `spec.triggers[]` descriptors + resolves their `action` (agent/handler) refs FAIL-CLOSED
 * at boot. A runtime FIRE is fail-closed-rejected (`TriggerDeferredError`) — the durable
 * cron/event worker is a later stage (DBOS). Product-agnostic platform mechanism.
 */
export {
  type RegisterTriggersConfig,
  type ResolvedTriggerAction,
  registerTriggers,
  TriggerDeferredError,
  type TriggerDescriptor,
  TriggerRegistrationError,
  TriggerRegistry,
} from './registry.js';
