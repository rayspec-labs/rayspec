/**
 * @rayspec/tasks — the durable task engine's kernel contract.
 *
 * The closed status/reason vocabulary and the frozen transition table (status.ts), the single
 * sanctioned status writer (apply-transition.ts), the single insert site (create-task.ts), the
 * journal vocabulary + writer (events.ts), and the typed errors. The scheduler and turn machinery
 * live beside the existing durable infrastructure in @rayspec/durable-dbos and consume THIS
 * package; the HTTP and CLI surfaces consume it through the composition root.
 */
export { type ApplyTransitionInput, applyTransition, type TaskRecord } from './apply-transition.js';
export {
  authorizeTurn,
  BUDGET_WINDOWS,
  type BudgetWindow,
  EPOCH_WINDOW_START,
  LedgerCostPolicy,
  ledgerScopesFor,
  resolveWorkforceBudgets,
  settleTurn,
  type WorkforceBudgets,
  windowStartFor,
  workforceBudgetsSchema,
} from './budget.js';
export {
  type ChildTaskSpec,
  type CreateRootTaskInput,
  childTaskSpecSchema,
  createRootTask,
  createRootTaskInputSchema,
  insertChildTask,
  TASK_PRIORITIES,
  type TaskPriority,
} from './create-task.js';
export {
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
  ensureWorkforceRuntime,
  readWorkforceRuntime,
  type WorkforceRuntimeRecord,
} from './runtime.js';
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
