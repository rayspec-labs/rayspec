/**
 * Typed task-engine errors. Leaf module on purpose (the BootConfigError lesson): a caller can
 * `instanceof` these without importing the engine's write paths. The transition-legality errors
 * (`TaskTransitionIllegalError`, `StatusReasonInvalidError`) live in status.ts beside the table
 * they enforce; everything else lives here.
 */

/** The task id does not exist under this tenant. Uniform with a foreign task (no existence leak). */
export class TaskNotFoundError extends Error {
  readonly taskId: string;
  constructor(taskId: string) {
    super(`task '${taskId}' not found for this tenant. Fail-closed.`);
    this.name = 'TaskNotFoundError';
    this.taskId = taskId;
  }
}

/**
 * The compare-and-swap on `version` found a different value than the caller presented — another
 * transition won the race. The caller re-reads and retries (or gives up); it NEVER force-writes.
 */
export class TaskVersionConflictError extends Error {
  readonly taskId: string;
  readonly expectedVersion: number;
  readonly actualVersion: number;
  constructor(taskId: string, expectedVersion: number, actualVersion: number) {
    super(
      `task '${taskId}' version conflict: expected ${expectedVersion}, found ${actualVersion} — ` +
        'another transition applied first. Re-read and retry; never force-write. Fail-closed.',
    );
    this.name = 'TaskVersionConflictError';
    this.taskId = taskId;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

/** A stored status/reason column carries a value outside the closed sets — refuse to interpret it. */
export class TaskRowCorruptError extends Error {
  readonly taskId: string;
  constructor(taskId: string, detail: string) {
    super(
      `task '${taskId}' carries a value outside the closed vocabulary (${detail}) — refusing to ` +
        'interpret a corrupted row. Fail-closed.',
    );
    this.name = 'TaskRowCorruptError';
    this.taskId = taskId;
  }
}

/** The stored budgets declaration fails the strict schema — refuse to enforce a guess. */
export class WorkforceBudgetsInvalidError extends Error {
  readonly workforceId: string;
  constructor(workforceId: string, detail: string) {
    super(
      `workforce '${workforceId}' carries a budgets declaration outside the strict schema — ` +
        `refusing to enforce a guess. Fail-closed. (${detail})`,
    );
    this.name = 'WorkforceBudgetsInvalidError';
    this.workforceId = workforceId;
  }
}

/** The named workforce has no runtime row (never initialized under this tenant). */
export class WorkforceUnknownError extends Error {
  readonly workforceId: string;
  constructor(workforceId: string) {
    super(`workforce '${workforceId}' has no runtime row for this tenant. Fail-closed.`);
    this.name = 'WorkforceUnknownError';
    this.workforceId = workforceId;
  }
}
