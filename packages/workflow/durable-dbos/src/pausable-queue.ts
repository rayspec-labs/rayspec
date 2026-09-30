/**
 * A DBOS queue whose dispatch can be PAUSED and RESUMED without shutting the engine down, and a count
 * of the jobs this process is running from it.
 *
 * WHY NOT `DBOS.shutdown()`. Shutting DBOS down stops dequeuing, but it also destroys the executor:
 * the process cannot start dispatching again without a restart. A source fence has to be released by
 * a later resume, so it needs a stop that can be undone.
 *
 * HOW. A registered queue is database-backed, and DBOS's dispatch loop re-reads the queue's row on
 * every poll. With `worker_concurrency` 0 the dequeue claims nothing (the installed 4.21.6
 * `findAndMarkStartableWorkflows` computes `max(0, workerConcurrency - running)` and returns before
 * it touches a row). So pausing writes 0 and resuming writes the configured value back. Jobs that are
 * already running are not interrupted: they are what a drain waits for, and `inFlight` counts them.
 *
 * THE SETTLE WINDOW. The dispatch loop reads the row, SLEEPS one poll interval (about a second), and
 * only then dequeues with what it read. A loop that read the row just before the pause can therefore
 * still claim jobs up to one interval after it. `settled` turns true once `settleMs` (default three
 * intervals) has passed since the pause; a job claimed in the window is counted in `inFlight` like any
 * other, so a drain that waits for `settled` AND zero in flight has waited for it too. (DBOS lengthens
 * the interval only after lock contention on the queue; the window is sized for the ordinary case.)
 *
 * WHAT IT SHARES. The `queues` row is keyed on the queue NAME alone, so every process on the same DBOS
 * system database reads the same row: a pause stops dequeuing on all of them, and a process that
 * registers the queue while another has paused it must register it paused too (`register` takes the
 * current pause state), or it would switch dispatch back on for everyone.
 */
import { DBOS, type WorkflowQueue } from '@dbos-inc/dbos-sdk';

/** How long after a pause a dispatch loop may still claim a job it was already about to claim. */
export const DEFAULT_PAUSE_SETTLE_MS = 3_000;

export class PausableQueue {
  readonly name: string;
  readonly workerConcurrency: number;
  readonly settleMs: number;
  #queue: WorkflowQueue | undefined;
  #paused = false;
  #pausedAt = 0;
  #inFlight = 0;

  constructor(name: string, workerConcurrency: number, settleMs = DEFAULT_PAUSE_SETTLE_MS) {
    this.name = name;
    this.workerConcurrency = workerConcurrency;
    this.settleMs = settleMs;
  }

  /**
   * Whether the pause has taken hold everywhere in this process: paused, and the settle window has
   * passed, so no dispatch loop can still claim a job with the concurrency it read before the pause.
   */
  get settled(): boolean {
    return this.#paused && Date.now() - this.#pausedAt >= this.settleMs;
  }

  /** Whether dispatch is paused (or will be registered paused). */
  get paused(): boolean {
    return this.#paused;
  }

  /** How many jobs from this queue are running in this process right now. */
  get inFlight(): number {
    return this.#inFlight;
  }

  /**
   * Register the queue with DBOS (after launch: queues are database-backed). A queue paused before it
   * was registered is registered with a worker concurrency of 0, so no job is dequeued in between.
   */
  async register(): Promise<void> {
    this.#queue = await DBOS.registerQueue(this.name, {
      workerConcurrency: this.#paused ? 0 : this.workerConcurrency,
      onConflict: 'always_update',
    });
  }

  /** Stop dequeuing. Running jobs continue; nothing new starts until `resume`. */
  async pause(): Promise<void> {
    if (!this.#paused) this.#pausedAt = Date.now();
    this.#paused = true;
    await this.#queue?.setWorkerConcurrency(0);
  }

  /** Dequeue again at the configured worker concurrency. */
  async resume(): Promise<void> {
    this.#paused = false;
    await this.#queue?.setWorkerConcurrency(this.workerConcurrency);
  }

  /** Run one job body, counted in `inFlight` for as long as it runs. */
  async track<T>(body: () => Promise<T>): Promise<T> {
    this.#inFlight += 1;
    try {
      return await body();
    } finally {
      this.#inFlight -= 1;
    }
  }
}
