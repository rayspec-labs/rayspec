/**
 * @rayspec/tasks — the durable task engine's kernel contract.
 *
 * The closed status/reason vocabulary and the frozen transition table (status.ts), the single
 * sanctioned status writer (apply-transition.ts), the single insert site (create-task.ts), the
 * journal vocabulary + writer (events.ts), and the typed errors. The scheduler and turn machinery
 * live beside the existing durable infrastructure in @rayspec/durable-dbos and consume THIS
 * package; the HTTP and CLI surfaces consume it through the composition root.
 */
export {
  type ApplyTurnInput,
  type ApplyTurnOutcome,
  afterTaskTerminal,
  applyBudgetExhausted,
  applyTurnOutcome,
  cancelDescendants,
  DELEGATION_STATUSES,
  type DelegationStatus,
  delegationStatusSchema,
  lockDescendants,
  lockRootFirst,
  MAX_MESSAGE_BODY_CHARS,
  MAX_MESSAGES_PER_TURN,
  type TurnReviewPolicy,
  TurnStateError,
  turnMessagesSchema,
  turnReviewPolicySchema,
} from './apply-intents.js';
export { type ApplyTransitionInput, applyTransition, type TaskRecord } from './apply-transition.js';
export {
  ApprovalAlreadyDecidedError,
  type ApprovalDecisionInput,
  ApprovalNotFoundError,
  type ApprovalRecord,
  type ApprovalSweepOutcome,
  approvalDecisionSchema,
  decideApproval,
  sweepApprovalTimeouts,
} from './approvals.js';
export {
  authorizeTurn,
  BUDGET_WINDOWS,
  type BudgetWindow,
  EPOCH_WINDOW_START,
  LedgerCostPolicy,
  ledgerScopesFor,
  releaseTurnReservation,
  resolveWorkforceBudgets,
  settleTurn,
  type WorkforceBudgets,
  windowStartFor,
  workforceBudgetsSchema,
} from './budget.js';
export {
  type CancelCascadeOutcome,
  cancelTaskCascade,
  type HaltWorkforceOutcome,
  haltWorkforce,
  type PauseWorkforceInput,
  pauseWorkforce,
  resumeWorkforce,
  WorkforceDrainTimeoutError,
} from './control.js';
export {
  assertDependenciesResolvable,
  type ChildTaskSpec,
  type CreateRootTaskInput,
  childTaskSpecSchema,
  createRootTask,
  createRootTaskInputSchema,
  type DelegationChildSpec,
  delegationChildSpecSchema,
  insertChildTask,
  MAX_TASK_DEPENDENCIES,
  MAX_TASK_TEXT_CHARS,
  TASK_PRIORITIES,
  type TaskPriority,
} from './create-task.js';
export {
  TaskDependenciesInvalidError,
  TaskNotFoundError,
  TaskRowCorruptError,
  TaskVersionConflictError,
  WorkforceBudgetsInvalidError,
  WorkforceUnknownError,
} from './errors.js';
export {
  appendTaskEvents,
  appendWorkforceEvents,
  WORKFORCE_EVENT_TYPES,
  WORKFORCE_EVENT_VERSION,
  type WorkforceEventInput,
  type WorkforceEventType,
  workforceControlStreamId,
  workforceJournalEventSchema,
} from './events.js';
export { deterministicChildTaskId, newRootTaskId } from './ids.js';
export {
  DELEGATION_REJECTION_REASONS,
  type DelegationRejectionReason,
  ESCALATION_REASONS,
  type EscalationReason,
  invalidIntentPlan,
  type PlanTurnInput,
  planTurnOutcome,
  type ToolErrorFate,
  TURN_CLASSIFICATIONS,
  type TurnClassification,
  type TurnIntent,
  type TurnPlan,
  turnClassificationSchema,
  turnIntentSchema,
  type WorkerResult,
  workerResultSchema,
} from './intent-applier.js';
export {
  isJoinSatisfied,
  type JoinPolicy,
  joinPolicySchema,
  type MergedChildResult,
  mergeChildResults,
} from './join.js';
export {
  applyReviewVerdict,
  applyReviewVerdictInTx,
  ReviewAlreadyDecidedError,
  ReviewNotForParkError,
  ReviewNotFoundError,
  type ReviewRecord,
  ReviewTaskStateError,
  type ReviewVerdictInput,
  reviewVerdictSchema,
} from './reviews.js';
export {
  ensureWorkforceRuntime,
  isReservedWorkforceSegment,
  RESERVED_WORKFORCE_SEGMENTS,
  readWorkforceRuntime,
  type WorkforceRuntimeRecord,
} from './runtime.js';
export {
  absorbPendingWakes,
  consumePendingCancels,
  type DeliverSignalInput,
  type DeliverSignalOutcome,
  deliverSignal,
  escalationTargetsPark,
  OPERATOR_SIGNAL_KINDS,
  type OperatorSignalKind,
  operatorSignalKindSchema,
  SIGNAL_KINDS,
  type SignalKind,
  type SignalRecord,
  signalKindSchema,
} from './signals.js';
export {
  ALLOWED_TRANSITIONS,
  assertTransition,
  isStatusReason,
  isTaskStatus,
  isTerminalStatus,
  REASON_RULES,
  STATUS_REASONS,
  type StatusReason,
  StatusReasonInvalidError,
  TASK_STATUSES,
  type TaskStatus,
  TaskTransitionIllegalError,
  TERMINAL_STATUSES,
  type TerminalStatus,
} from './status.js';
