/**
 * Run admission — the refusal a bounded queue gives when it is full.
 *
 * The execution policy bounds how many agent runs may be queued or executing at once, per tenant
 * (`RAYSPEC_AGENT_QUEUE_MAX_PER_TENANT`) and in total (`RAYSPEC_AGENT_QUEUE_MAX`), and how many runs one
 * process holds in-request (`RAYSPEC_AGENT_SYNC_RUNS_MAX`). A run over a bound is refused before
 * anything is recorded for it: no job, no run header, no reservation kept. The refusal is this neutral
 * error; the run surface answers it with 429 and a `Retry-After`.
 */

/** Which bound refused the run. */
export type RunAdmissionScope = 'tenant' | 'global' | 'in-request';

/** How long a refused caller is advised to wait before it tries again. */
export const RUN_ADMISSION_RETRY_AFTER_MS = 5_000;

/** Raised when a run is refused because a bounded queue is full. */
export class RunAdmissionRefusedError extends Error {
  readonly scope: RunAdmissionScope;
  readonly limit: number;
  readonly retryAfterMs: number;
  constructor(scope: RunAdmissionScope, limit: number) {
    super(runAdmissionRefusedMessage(scope, limit));
    this.name = 'RunAdmissionRefusedError';
    this.scope = scope;
    this.limit = limit;
    this.retryAfterMs = RUN_ADMISSION_RETRY_AFTER_MS;
  }
}

/** The refusal text: which bound is full, at what size, and what to do. */
export function runAdmissionRefusedMessage(scope: RunAdmissionScope, limit: number): string {
  switch (scope) {
    case 'tenant':
      return (
        `The run was not queued: this organization already has ${limit} agent runs queued or ` +
        'executing (RAYSPEC_AGENT_QUEUE_MAX_PER_TENANT). Retry when some have finished.'
      );
    case 'global':
      return (
        `The run was not queued: the runtime already has ${limit} agent runs queued or executing ` +
        '(RAYSPEC_AGENT_QUEUE_MAX). Retry when some have finished.'
      );
    case 'in-request':
      return (
        `The run was not started: this process already holds ${limit} agent runs in-request ` +
        '(RAYSPEC_AGENT_SYNC_RUNS_MAX). Retry later, or start the run with async:true.'
      );
  }
}
