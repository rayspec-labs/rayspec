/**
 * An out-of-tree `WorkerSelector`: among the candidates who hold every required capability, pick the
 * one this selector has assigned the least work to, breaking ties in declaration order.
 *
 * This is the seam where "premium routing" would live — a real one would weigh measured throughput,
 * queue depth or quality history instead of a local counter. The interesting part is the shape, not
 * the arithmetic:
 *
 *   - it FILTERS the candidate array; it never adds to it. It has no way to add to it — the only
 *     employee ids it has ever seen are the ones the engine handed it in this call;
 *   - it re-checks required capabilities itself, so it cannot promote someone into work they do not
 *     declare. `confineWorkerSelector` re-checks the same thing at the boundary, which is what makes
 *     a selector that skipped this check harmless rather than merely rude;
 *   - it refuses rather than guesses. A selector that answered anyway would be picking somebody at
 *     random and calling it routing.
 */
import {
  type SelectionTask,
  type WorkerCandidate,
  type WorkerSelection,
  WorkerSelectionError,
  type WorkerSelector,
} from '@rayspec/core';

export class LeastLoadedSelector implements WorkerSelector {
  readonly id = 'least-loaded';
  readonly #assigned = new Map<string, number>();

  select(task: SelectionTask, candidates: readonly WorkerCandidate[]): Promise<WorkerSelection> {
    const qualified = candidates.filter((candidate) =>
      task.requiredCapabilities.every((label) => candidate.capabilities.includes(label)),
    );
    if (qualified.length === 0) {
      return Promise.reject(
        new WorkerSelectionError(
          task.taskId,
          candidates.length === 0
            ? 'the candidate list is empty'
            : `no candidate holds every required capability [${task.requiredCapabilities.join(', ')}]`,
        ),
      );
    }

    // Declaration order is the tie-break, so the same inputs always yield the same seat — a routing
    // decision that moved on rerun would make every downstream journal harder to read.
    let chosen = qualified[0] as WorkerCandidate;
    for (const candidate of qualified) {
      if (this.#load(candidate.employeeId) < this.#load(chosen.employeeId)) chosen = candidate;
    }
    this.#assigned.set(chosen.employeeId, this.#load(chosen.employeeId) + 1);

    return Promise.resolve({
      employeeId: chosen.employeeId,
      reason: `least loaded of ${qualified.length} qualified candidate(s) (${this.#load(chosen.employeeId) - 1} prior assignment(s))`,
    });
  }

  #load(employeeId: string): number {
    return this.#assigned.get(employeeId) ?? 0;
  }
}
