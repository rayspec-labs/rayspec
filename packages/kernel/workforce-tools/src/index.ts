/**
 * @rayspec/workforce-tools — the workforce toolset layer: role-keyed native tool definitions, the
 * one-turn-ending-intent collector, delegation-target resolution, review-policy matching, and the
 * bounded read snapshot a turn answers its read tools from.
 *
 * THE BOUNDARY (held by scripts/check-delegation-dispatch-boundary.mjs): this package PRODUCES the
 * engine's typed turn intents and never executes anything — nothing here may import the executor,
 * the agent runner, the platform's run surface, an adapter, or an app package, and the engine's
 * write paths (applyTurnOutcome and friends) stay equally out of reach. The composition that runs
 * an employee's agent and applies the collected intent lives with the composition root, on the
 * other side of the gate.
 */
export {
  type BufferedCreatedChild,
  type BufferedMessage,
  type CollectedTurn,
  TurnCollector,
} from './collector.js';
export {
  DelegationTargetInvalidError,
  EscalationTargetMissingError,
  ManagerTargetForbiddenError,
  ReservedToolNameError,
  TaskNotVisibleError,
  TurnAlreadyEndedError,
  WorkforceToolError,
} from './errors.js';
export {
  assertManagerMayTarget,
  type DelegationTarget,
  parseDelegationTarget,
  type ResolvedTarget,
  resolveDelegationTarget,
} from './resolve-target.js';
export { type MatchedReviewPolicy, matchReviewPolicy } from './review-policy.js';
export {
  EMPLOYEE_ROLES,
  type EmployeeRole,
  TOOLSETS_BY_ROLE,
  type ToolName,
  TURN_ENDING_TOOLS,
} from './roles.js';
export {
  buildWorkforceSnapshot,
  SNAPSHOT_DEPARTMENT_LIMIT,
  SNAPSHOT_SUBTREE_LIMIT,
  type TaskSummary,
  type WorkforceReadSnapshot,
  type WorkforceStateView,
} from './snapshot.js';
export { assertNoReservedCollisions, buildRoleToolset, type RoleToolsetInput } from './toolset.js';
