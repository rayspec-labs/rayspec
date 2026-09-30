/**
 * THE SOURCE FENCE, AS ONE RUNTIME PROCESS KEEPS IT.
 *
 * `quiesce` takes the fence in the environment's database (`runtime_control_state`: `fence_state`
 * becomes `fenced`, `fence_epoch` increases) and `resume` releases it. Every runtime process of the
 * environment watches that row — this module — and acts on it within one poll interval (500 ms by
 * default), so a quiesce or a resume run from another process (a CLI, a supervisor) reaches a running
 * server.
 *
 * A process moves through three phases:
 *
 *  - `open`: everything runs.
 *  - `draining`: the fence is held. New work is refused — HTTP mutations and new event streams (503,
 *    `http/write-fence.ts` in @rayspec/api-auth), cron and cleanup ticks (their producer gate), and
 *    queue dispatch (paused, not shut down) — and open event streams are closed. Work that was already
 *    running continues: in-flight requests, jobs and fires.
 *  - `fenced`: everything that was running has finished. From here the event bus and object writes
 *    are refused as well, so nothing that slipped past the gates can append or store.
 *
 * The process reports its phase, each producer's state and the external services it calls in a
 * heartbeat row (`runtime_control_processes`), written whenever something changes and at least every
 * `heartbeatMs`. `quiesce` reads those rows: it reports the source fenced only when every live process
 * has reached `fenced` at the new epoch, and timed out otherwise. A process that stops heartbeating is
 * no longer counted as live.
 *
 * The fence SURVIVES A RESTART because it lives in the database: `load()` reads it before the boot
 * starts any producer, so a process that boots under a held fence starts in `draining`, with its
 * queues registered paused. When the fence is released every producer is resumed — the queues
 * dispatch again, the gates open — without restarting the process.
 *
 * A BOOTING PROCESS IS VISIBLE. `load()` writes this process's heartbeat BEFORE it reads the fence, and
 * starts the poll there, so the heartbeat stays fresh for the whole boot. A quiesce that commits while
 * a process is still booting therefore finds a live process that has not observed the new epoch, and
 * waits for it (or times out) instead of reporting the source fenced while that process attaches its
 * producers and launches its queues.
 */
import { randomUUID } from 'node:crypto';
import { ApiError } from '@rayspec/auth-core';
import type { QuiesceData } from '@rayspec/bundle-contract';
import type { Db } from '@rayspec/db';
import type { BlobStore, BlobStoreFactory } from '@rayspec/platform';

/** A process's phase under the fence. */
export type FencePhase = 'open' | 'draining' | 'fenced';

/** One producer's state as `quiesce` reports it. */
export type ProducerState = QuiesceData['producers'][number]['state'];

/** Something that starts work and that a fence stops, drains and restarts. */
export interface FencedProducer {
  /** The name `quiesce` reports it under. */
  readonly name: string;
  /** Stop starting new work. Work already running continues. */
  pause(): Promise<void>;
  /** Start new work again. */
  resume(): Promise<void>;
  /**
   * How much of its work is still running. A producer that has nothing to drain (it only stops)
   * reports 0 always; one whose stop takes a moment to take hold (a queue's settle window) reports
   * at least 1 until it has.
   */
  running(): number;
}

/** The heartbeat a process writes. */
interface Heartbeat {
  fenceEpoch: number;
  phase: FencePhase;
  producers: { producer: string; state: ProducerState }[];
  unfencedExternal: string[];
}

/** The default poll interval: the fence is observed within this long. */
export const DEFAULT_FENCE_POLL_MS = 500;

/** A heartbeat is rewritten at least this often, so a live process never looks stale. */
export const DEFAULT_HEARTBEAT_MS = 5_000;

/** A process whose heartbeat is older than this is no longer counted as live. */
export const PROCESS_LIVE_WINDOW_MS = 15_000;

/** The `Retry-After` a fenced runtime hands a refused client. */
export const DEFAULT_RETRY_AFTER_SECONDS = 30;

export interface RuntimeFenceOptions {
  /** The environment's application database. */
  db: Db;
  pollIntervalMs?: number;
  heartbeatMs?: number;
  retryAfterSeconds?: number;
  /** Where a failed poll is reported (once per failure streak). Default `console.warn`. */
  warn?: (message: string) => void;
}

interface ObservedFence {
  state: 'open' | 'fenced';
  epoch: number;
}

export class RuntimeFence {
  /** This process's heartbeat id. */
  readonly processId = randomUUID();
  readonly #db: Db;
  readonly #pollIntervalMs: number;
  readonly #heartbeatMs: number;
  readonly #retryAfterSeconds: number;
  readonly #warn: (message: string) => void;
  readonly #producers: FencedProducer[] = [];
  readonly #external = new Set<string>();
  #phase: FencePhase = 'open';
  #epoch = 0;
  #httpInFlight = 0;
  #drain = new AbortController();
  #timer: NodeJS.Timeout | undefined;
  #polling: Promise<void> | undefined;
  #lastHeartbeat: { at: number; body: string } | undefined;
  #failing = false;
  #stopped = false;
  #watching = false;
  #syncing: Promise<void> = Promise.resolve();

  constructor(options: RuntimeFenceOptions) {
    this.#db = options.db;
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_FENCE_POLL_MS;
    this.#heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.#retryAfterSeconds = options.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS;
    this.#warn = options.warn ?? ((m) => console.warn(m));
  }

  /** The phase this process is in. */
  get phase(): FencePhase {
    return this.#phase;
  }

  /** The fence epoch this process last observed. */
  get epoch(): number {
    return this.#epoch;
  }

  // ─── what the app and the producers ask ────────────────────────────────────────────────────

  /** Whether a mutation, a new stream or a new tick may start: only while open. */
  admitsWrites(): boolean {
    return this.#phase === 'open';
  }

  /** The producer gate the schedulers ask: the same answer. */
  open(): boolean {
    return this.#phase === 'open';
  }

  /**
   * Whether an event-bus append or an object write may happen: until the process has drained. Work
   * that was running when the drain started still writes; nothing writes once it is `fenced`.
   */
  admitsDataWrites(): boolean {
    return this.#phase !== 'fenced';
  }

  retryAfterSeconds(): number {
    return this.#retryAfterSeconds;
  }

  /** Count one admitted request; the returned function ends it (once). */
  begin(): () => void {
    this.#httpInFlight += 1;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.#httpInFlight -= 1;
    };
  }

  /** Aborts when this process starts draining; a fresh signal after each resume. */
  drainSignal(): AbortSignal {
    return this.#drain.signal;
  }

  // ─── wiring ────────────────────────────────────────────────────────────────────────────────

  /**
   * Register a producer. When the process is already fenced (a boot under a held fence), the
   * producer is paused before this returns, so it never starts work.
   */
  async attach(producer: FencedProducer): Promise<void> {
    this.#producers.push(producer);
    if (this.#phase !== 'open') await producer.pause();
  }

  /** Name external services this process calls, which no fence can stop. */
  addExternal(names: Iterable<string>): void {
    for (const name of names) this.#external.add(name);
  }

  /** Wrap a blob factory so object writes are refused once the process has drained. */
  blobFactory(inner: BlobStoreFactory): BlobStoreFactory {
    return (tenantId: string) => fencedBlobStore(inner(tenantId), () => this.admitsDataWrites());
  }

  // ─── lifecycle ─────────────────────────────────────────────────────────────────────────────

  /**
   * Announce this process and read the fence once, before any producer starts. The heartbeat is
   * written first — `open`, at epoch 0, which no held fence has — so a quiesce that commits from
   * here on counts this process as live and not yet drained. Under a held fence the process starts
   * in `draining`: producers attached afterwards are paused as they attach. The poll starts here
   * too, so the heartbeat stays fresh and a fence taken during the boot is observed during it.
   */
  async load(): Promise<void> {
    await this.#db.$client.unsafe(
      "DELETE FROM runtime_control_processes WHERE seen_at < clock_timestamp() - interval '1 hour'",
    );
    await this.#heartbeat(true);
    const observed = await this.#read();
    this.#epoch = observed.epoch;
    if (observed.state === 'fenced') {
      this.#phase = 'draining';
      this.#drain.abort();
    }
    await this.#heartbeat(true);
    this.#watch();
  }

  /** Watch the fence and heartbeat (a no-op for the poll when `load()` already started it). */
  async start(): Promise<void> {
    await this.sync();
    this.#watch();
  }

  #watch(): void {
    if (this.#watching || this.#stopped) return;
    this.#watching = true;
    this.#schedule();
  }

  /** Stop watching, and remove this process's heartbeat. */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    await this.#polling?.catch(() => {});
    await this.#db.$client
      .unsafe('DELETE FROM runtime_control_processes WHERE process_id = $1', [this.processId])
      .catch(() => {});
  }

  #schedule(): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      this.#polling = this.sync()
        .catch(() => {})
        .finally(() => {
          this.#polling = undefined;
          this.#schedule();
        });
    }, this.#pollIntervalMs);
    this.#timer.unref();
  }

  /**
   * One observation: read the fence, move to the phase it asks for, and heartbeat. Exposed so a
   * caller that just changed the fence in this same process need not wait for the next poll.
   */
  async sync(): Promise<void> {
    // One observation at a time: the poll and an explicit call never interleave their phase changes.
    const next = this.#syncing.then(() => this.#syncOnce());
    this.#syncing = next.catch(() => {});
    return next;
  }

  async #syncOnce(): Promise<void> {
    let observed: ObservedFence;
    try {
      observed = await this.#read();
      this.#failing = false;
    } catch {
      // Keep the phase this process is in: an unreachable database neither takes nor releases a
      // fence. Said once per failure streak, not once per poll.
      if (!this.#failing) {
        this.#failing = true;
        this.#warn('[fence] the fence state could not be read; keeping the current phase');
      }
      return;
    }
    if (observed.state === 'fenced') {
      if (this.#phase === 'open' || observed.epoch !== this.#epoch) {
        await this.#enterDraining(observed.epoch);
      }
      if (
        this.#phase === 'draining' &&
        this.#producerStates().every((p) => p.state !== 'still-running')
      ) {
        this.#phase = 'fenced';
      }
    } else if (this.#phase !== 'open') {
      await this.#reopen(observed.epoch);
    } else {
      this.#epoch = observed.epoch;
    }
    await this.#heartbeat();
  }

  async #enterDraining(epoch: number): Promise<void> {
    this.#epoch = epoch;
    this.#phase = 'draining';
    // Close every open stream (after the chunk in flight), then stop every producer.
    this.#drain.abort();
    for (const producer of this.#producers) await producer.pause();
  }

  async #reopen(epoch: number): Promise<void> {
    this.#epoch = epoch;
    this.#drain = new AbortController();
    for (const producer of this.#producers) await producer.resume();
    this.#phase = 'open';
  }

  #producerStates(): Heartbeat['producers'] {
    const states: Heartbeat['producers'] = [
      {
        producer: 'http-mutations',
        state:
          this.#phase === 'open' ? 'drained' : this.#httpInFlight > 0 ? 'still-running' : 'drained',
      },
      { producer: 'streams', state: 'stopped' },
      { producer: 'event-bus-writes', state: 'stopped' },
    ];
    for (const p of this.#producers) {
      states.push({ producer: p.name, state: p.running() > 0 ? 'still-running' : 'drained' });
    }
    return states;
  }

  #heartbeatBody(): Heartbeat {
    return {
      fenceEpoch: this.#epoch,
      phase: this.#phase,
      producers: this.#phase === 'open' ? [] : this.#producerStates(),
      unfencedExternal: [...this.#external].sort(),
    };
  }

  async #heartbeat(force = false): Promise<void> {
    const body = this.#heartbeatBody();
    const text = JSON.stringify(body);
    const now = Date.now();
    if (
      !force &&
      this.#lastHeartbeat !== undefined &&
      this.#lastHeartbeat.body === text &&
      now - this.#lastHeartbeat.at < this.#heartbeatMs
    ) {
      return;
    }
    await this.#db.$client.unsafe(
      `INSERT INTO runtime_control_processes
         (process_id, fence_epoch, phase, producers, unfenced_external, seen_at)
       VALUES ($1, $2, $3, $4::text::jsonb, $5::text::jsonb, clock_timestamp())
       ON CONFLICT (process_id) DO UPDATE
         SET fence_epoch = EXCLUDED.fence_epoch, phase = EXCLUDED.phase,
             producers = EXCLUDED.producers, unfenced_external = EXCLUDED.unfenced_external,
             seen_at = clock_timestamp()`,
      [
        this.processId,
        body.fenceEpoch,
        body.phase,
        JSON.stringify(body.producers),
        JSON.stringify(body.unfencedExternal),
      ],
    );
    this.#lastHeartbeat = { at: now, body: text };
  }

  async #read(): Promise<ObservedFence> {
    const rows = (await this.#db.$client.unsafe(
      `SELECT fence_state, fence_epoch::text AS fence_epoch FROM runtime_control_state WHERE id = 1`,
    )) as unknown as { fence_state: string; fence_epoch: string }[];
    const row = rows[0];
    if (row === undefined) return { state: 'open', epoch: 0 };
    return {
      state: row.fence_state === 'fenced' ? 'fenced' : 'open',
      epoch: Number(row.fence_epoch),
    };
  }
}

/**
 * A blob store whose writes (put, delete, deleteTenant) are refused while `admits` says no, with the
 * same 503 SERVICE_UNAVAILABLE a fenced mutation gets. Reads are never refused.
 */
export function fencedBlobStore(inner: BlobStore, admits: () => boolean): BlobStore {
  const guard = () => {
    if (!admits()) {
      throw new ApiError(
        'SERVICE_UNAVAILABLE',
        'Object writes are refused while the service is paused. Retry later.',
      );
    }
  };
  return {
    put: async (key, body, opts) => {
      guard();
      return inner.put(key, body, opts);
    },
    get: (key) => inner.get(key),
    createReadStream: (key, opts) => inner.createReadStream(key, opts),
    stat: (key) => inner.stat(key),
    delete: async (key) => {
      guard();
      return inner.delete(key);
    },
    deleteTenant: async (tenantId) => {
      guard();
      return inner.deleteTenant(tenantId);
    },
  };
}

/** A queue a source fence pauses: still running while a job runs or the pause has not settled. */
export function queueProducer(
  name: string,
  queue: {
    pauseDispatch(): Promise<void>;
    resumeDispatch(): Promise<void>;
    readonly inFlight: number;
    readonly dispatchSettled: boolean;
  },
): FencedProducer {
  let paused = false;
  return {
    name,
    pause: async () => {
      paused = true;
      await queue.pauseDispatch();
    },
    resume: async () => {
      paused = false;
      await queue.resumeDispatch();
    },
    running: () => queue.inFlight + (paused && !queue.dispatchSettled ? 1 : 0),
  };
}

/** A producer the fence stops through its gate (the fence itself): only its in-flight work drains. */
export function gatedProducer(name: string, inFlight: () => number): FencedProducer {
  return { name, pause: async () => {}, resume: async () => {}, running: inFlight };
}
