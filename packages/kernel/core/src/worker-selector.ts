/**
 * WorkerSelector — the neutral assignment seam.
 *
 * Given a task that needs doing and the candidates who could do it, the selector picks ONE and
 * says why. It decides assignment and nothing else: the candidate list arrives already filtered by
 * the caller's own rules (declared structure, roles, visibility), and the selection is applied by
 * the engine — a selector can never widen the candidate set or grant a capability.
 *
 * The default matches on declared capability labels only. Labels are OPAQUE: they are compared for
 * equality, never interpreted, and no fitness history or measured quality enters the decision —
 * a deployment that wants informed routing replaces the selector.
 */

export interface WorkerCandidate {
  readonly employeeId: string;
  readonly role: 'orchestrator' | 'manager' | 'worker' | 'reviewer';
  readonly department: string | null;
  /** Declared capability labels — opaque, matched by equality, never interpreted. */
  readonly capabilities: readonly string[];
}

export interface SelectionTask {
  readonly taskId: string;
  /** Labels the task declares it needs; empty means any candidate qualifies. */
  readonly requiredCapabilities: readonly string[];
  readonly department: string | null;
}

export interface WorkerSelection {
  readonly employeeId: string;
  /** Human-facing selection rationale — journal/debug text, never authority. */
  readonly reason: string;
}

/** No candidate qualifies. Fail-closed: a silent misassignment is worse than a typed refusal. */
export class WorkerSelectionError extends Error {
  readonly taskId: string;
  constructor(taskId: string, detail: string) {
    super(`no candidate qualifies for task '${taskId}': ${detail}. Fail-closed.`);
    this.name = 'WorkerSelectionError';
    this.taskId = taskId;
  }
}

export interface WorkerSelector {
  readonly id: string;
  select(task: SelectionTask, candidates: readonly WorkerCandidate[]): Promise<WorkerSelection>;
}

/**
 * The honest default: the first candidate holding EVERY required capability, preferring a
 * department match, in the caller-given (declaration) order — deterministic, no measured-quality
 * input. Throws `WorkerSelectionError` when nobody qualifies rather than guessing.
 */
export class CapabilityMatchSelector implements WorkerSelector {
  readonly id = 'capability-match';

  select(task: SelectionTask, candidates: readonly WorkerCandidate[]): Promise<WorkerSelection> {
    const qualified = candidates.filter((candidate) =>
      task.requiredCapabilities.every((label) => candidate.capabilities.includes(label)),
    );
    const preferred =
      qualified.find(
        (candidate) => task.department !== null && candidate.department === task.department,
      ) ?? qualified[0];
    if (!preferred) {
      return Promise.reject(
        new WorkerSelectionError(
          task.taskId,
          task.requiredCapabilities.length === 0
            ? 'the candidate list is empty'
            : `no candidate holds every required capability [${task.requiredCapabilities.join(', ')}]`,
        ),
      );
    }
    return Promise.resolve({
      employeeId: preferred.employeeId,
      reason:
        preferred.department !== null && preferred.department === task.department
          ? 'first fully-capable candidate in the task department'
          : 'first fully-capable candidate in declaration order',
    });
  }
}
