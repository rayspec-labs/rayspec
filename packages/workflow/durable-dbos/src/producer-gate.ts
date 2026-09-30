/**
 * The switch a scheduler asks before it starts new work, so a source fence can stop it and a resume
 * can start it again without shutting the engine down.
 *
 * A closed gate stops only NEW work. A scheduled tick that arrives while the gate is closed runs its
 * DBOS workflow and returns without doing anything (one log line says so); the engine records that
 * instant as run, so a closed gate does not replay it later. An explicit on-demand fire is refused
 * with `ProducerPausedError`, so its caller learns it did not happen rather than reading a silent
 * no-op. Work that started before the gate closed runs to its end: `inFlight` on each scheduler counts
 * it, and that count is what a drain waits for.
 */

/** Whether a scheduler may start new work now. */
export interface ProducerGate {
  open(): boolean;
}

/** An on-demand fire refused because the producer is paused (the runtime is fenced). */
export class ProducerPausedError extends Error {
  constructor(producer: string) {
    super(`${producer} is paused while the runtime is fenced; retry after it is resumed`);
    this.name = 'ProducerPausedError';
  }
}
