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

export { classifyTurnIntent } from './classify.js';
export {
  type BufferedCreatedChild,
  type BufferedMessage,
  type CollectedTurn,
  MALFORMED_TURN_ENDING,
  TurnCollector,
} from './collector.js';
export {
  assembleTurnInput,
  CHILD_RESULT_MAX_BYTES,
  ContextInputOverflowError,
  ContextSectionOverflowError,
  GoalExceedsContextBudgetError,
  SECTION_BUDGETS,
  SIGNAL_PAYLOAD_MAX_BYTES,
  TURN_INPUT_MAX_BYTES,
  type TurnInputFacts,
  type TurnMessageFact,
  type TurnSignalFact,
} from './context.js';
export {
  ApprovalAlreadyResolvedError,
  ApprovalEscalationTargetMissingError,
  DelegationTargetInvalidError,
  EscalationTargetMissingError,
  ManagerTargetForbiddenError,
  ReservedToolNameError,
  TaskNotVisibleError,
  TurnAlreadyEndedError,
  WorkforceToolError,
} from './errors.js';
export { type ApplicableReviewRuleFact, computeTurnFacts, type TurnFacts } from './facts.js';
export {
  formatRecallAge,
  RECALL_HIT_TEXT_MAX_CHARS,
  RECALL_MAX_AGE_MS,
  RECALL_MAX_HITS,
  RECALL_SCAN_LIMIT,
  type RecallScope,
  scoreRecallCandidate,
  TaskHistoryMemoryProvider,
  tokenizeRecallQuery,
} from './memory.js';
export {
  DATA_BOUNDARY_LINE,
  ROLE_GUIDANCE,
  SECTION_HEADERS,
  TURN_ENDING_REMINDER,
  TURN_PROMPT_VERSION,
} from './prompt.js';
export {
  assertManagerMayTarget,
  type DelegationTarget,
  parseDelegationTarget,
  type ResolvedTarget,
  resolveDelegationTarget,
} from './resolve-target.js';
export {
  type MatchedApprovalRule,
  type MatchedReviewPolicy,
  matchApprovalRule,
  matchReviewPolicy,
} from './review-policy.js';
export {
  EMPLOYEE_ROLES,
  type EmployeeRole,
  isTurnEndingToolName,
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
