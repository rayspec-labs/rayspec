/**
 * Bounded back-pressure event pipeline — the durable + resumable streaming seam.
 *
 * This replaces run-core's previous DIRECT/awaited `onEvent` emit (and the earlier Pi
 * `void this.forwardEvent(...)` fire-and-forget flagged as a back-pressure regression)
 * with ONE bounded in-memory queue between the adapter/dispatcher emits and two consumers:
 *
 *   (a) the durable run_events persist (every NeutralEvent → one run_events row), and
 *   (b) the OPTIONAL live SSE sink (the HTTP client, if one is attached).
 *
 * PERSIST-BEFORE-FLUSH (the load-bearing invariant): an event is written to run_events FIRST and
 * only THEN flushed to the live SSE sink. So any frame the client has seen is already durable —
 * an SSE reconnect (`Last-Event-ID`) is a lossless `seq > lastEventId` replay from run_events, never
 * a re-run. (If the durable persist throws, the event is NOT flushed live — fail-closed: we never
 * show the client a frame we could not make durable.)
 *
 * BOUNDED + EXPLICIT OVERFLOW POLICY (the back-pressure contract):
 *  - The queue is bounded by `maxQueue`. When a slow consumer lets it fill, the ONLY frames we may
 *    shed are `text_delta` (a cosmetic incremental render): under pressure we COALESCE — drop the
 *    OLDEST still-queued text_delta to make room. (Coalescing the oldest preserves the newest text,
 *    which is what a late-joining render wants; the full final text is always in the terminal
 *    RunResult + the persisted assistant turn regardless.)
 *  - We NEVER drop a structural/terminal frame: run_started, tool_called, tool_result, tool_error,
 *    turn_completed, run_completed. If the queue is full of NON-droppable frames, enqueue BLOCKS
 *    (applies real back-pressure to the producer) rather than dropping — correctness over latency.
 *  - reasoning_delta is treated like text_delta (also coalescible — it is incremental render too).
 *
 * The single per-run seq authority still lives in run-core (stampSeq); this pipeline consumes
 * already-seq-stamped NeutralEvents and never reorders them (a single FIFO worker drains the queue,
 * so persist + flush happen in seq order). A dropped (coalesced) text_delta leaves a seq GAP in the
 * live stream — that is fine and expected: the durable run_events still has it ONLY if it was
 * persisted before being shed; a coalesced delta is shed BEFORE persist, so it is intentionally
 * absent from both the live stream and the durable log (a cosmetic delta is not worth the write).
 */
import type { NeutralEvent } from '@rayspec/core';

/** The droppable (coalescible-under-pressure) event types — purely incremental render frames. */
const COALESCIBLE = new Set<NeutralEvent['type']>(['text_delta', 'reasoning_delta']);

/** A sink that persists ONE neutral event durably (run_events). Must resolve before the live flush. */
export type DurablePersist = (event: NeutralEvent) => Promise<void>;

/** The optional live sink (the SSE client). Flushed ONLY after the durable persist resolves. */
export type LiveSink = (event: NeutralEvent) => void | Promise<void>;

export interface EventPipelineOptions {
  /** Persist-before-flush durable sink (run_events). Required. */
  persist: DurablePersist;
  /** Optional live SSE sink. Flushed after persist. */
  live?: LiveSink;
  /**
   * Max events buffered before back-pressure kicks in. When full: coalesce (drop the oldest queued
   * text_delta/reasoning_delta) to admit a new frame; if there is no coalescible frame to shed,
   * BLOCK the producer until the worker drains one (never drop a structural/terminal frame).
   */
  maxQueue?: number;
}

/** Conservative default queue bound. Small enough to exercise coalescing under a slow consumer. */
export const DEFAULT_MAX_QUEUE = 256;

/**
 * A bounded, FIFO, persist-before-flush event pipeline for ONE run.
 *
 * Usage: `const p = new EventPipeline(opts);` then call `await p.emit(event)` from the run's
 * (seq-stamped) onEvent sink, and `await p.drain()` once the run completes to flush the tail.
 */
export class EventPipeline {
  private readonly persist: DurablePersist;
  private readonly live?: LiveSink;
  private readonly maxQueue: number;
  /** The waiting room — pending events NOT yet picked up by the worker (bounded by maxQueue). */
  private readonly queue: NeutralEvent[] = [];
  /** The event the worker is CURRENTLY persisting/flushing (out of the queue, not yet done). */
  private inFlight: NeutralEvent | null = null;
  private draining = false;
  /**
   * FIFO queue of producers blocked on a full non-droppable queue (the FIFO-fairness fix). Each blocked producer
   * pushes its `{ resolve, reject }`; the worker wakes EXACTLY ONE (the oldest) per freed slot, in
   * order. A SINGLE slot was the deadlock: a second concurrent producer overwrote the first's
   * resolver, orphaning it forever (its emit() never resolved → drain() hung → its structural frame
   * was never persisted). On a persist failure we reject ALL waiters (fail-closed, no orphan).
   */
  private readonly spaceWaiters: Array<{ resolve: () => void; reject: (e: unknown) => void }> = [];
  /** A terminal/fatal error from the worker (persist failure) surfaced to the producer + drain(). */
  private failure: unknown = null;
  /** Count of coalesced (shed) frames — inspection aid for the deterministic overflow test. */
  coalescedCount = 0;

  constructor(opts: EventPipelineOptions) {
    this.persist = opts.persist;
    this.live = opts.live;
    this.maxQueue = Math.max(1, opts.maxQueue ?? DEFAULT_MAX_QUEUE);
  }

  /**
   * Enqueue one (already-seq-stamped) event. Returns once the event is ADMITTED to the queue (the
   * worker persists+flushes it asynchronously, in seq order). If the queue is full: shed the OLDEST
   * queued coalescible frame to admit this one; if none is sheddable, await space (real
   * back-pressure). A non-coalescible (structural/terminal) frame is NEVER dropped.
   */
  async emit(event: NeutralEvent): Promise<void> {
    if (this.failure) throw this.failure;

    while (this.queue.length >= this.maxQueue) {
      // Try to coalesce: shed the OLDEST queued coalescible (text_delta/reasoning_delta) frame.
      // A shed frame is admitted-but-not-yet-persisted, so it is intentionally absent from BOTH the
      // live stream AND the durable log (a cosmetic delta is not worth the write under pressure).
      const idx = this.queue.findIndex((q) => COALESCIBLE.has(q.type));
      if (idx !== -1) {
        this.queue.splice(idx, 1);
        this.coalescedCount += 1;
        break;
      }
      // The queue is full of NON-droppable frames — block until the worker drains one (back-pressure).
      // Push a FIFO waiter: the worker wakes EXACTLY ONE waiter (the oldest) per freed slot, so a
      // second concurrent producer can no longer overwrite/orphan the first's resolver. A persist
      // failure rejects this waiter (fail-closed) rather than leaving it hung.
      await new Promise<void>((resolve, reject) => {
        this.spaceWaiters.push({ resolve, reject });
      });
      if (this.failure) throw this.failure;
    }

    this.queue.push(event);
    this.startWorker();
  }

  /** Kick the single FIFO worker if it is not already running. */
  private startWorker(): void {
    if (this.draining) return;
    this.draining = true;
    void this.work();
  }

  /**
   * Wake EXACTLY ONE producer (the oldest, FIFO) blocked on a full non-droppable queue — called once
   * per freed slot. Waking exactly one per slot preserves the back-pressure bound (a freed slot admits
   * exactly one waiting frame) AND admission order (the oldest waiter resumes first, so its frame is
   * pushed/persisted ahead of newer waiters'). Never overwrites/orphans a concurrent waiter.
   */
  private wakeOneWaiter(): void {
    const w = this.spaceWaiters.shift();
    if (w) w.resolve();
  }

  /** Fail-closed: reject ALL blocked producers (a persist failure stopped the worker — no orphans). */
  private rejectAllWaiters(err: unknown): void {
    while (this.spaceWaiters.length > 0) {
      const w = this.spaceWaiters.shift();
      w?.reject(err);
    }
  }

  /** The single FIFO worker: persist-before-flush, in seq order, one event at a time. */
  private async work(): Promise<void> {
    try {
      while (this.queue.length > 0) {
        // Move the head OUT of the waiting room into `inFlight` — this frees one queue slot
        // IMMEDIATELY, so a producer blocked on a full non-droppable queue can admit one more while
        // we persist/flush this one (the queue length is the waiting room, never counting in-flight).
        const item = this.queue.shift() as NeutralEvent;
        this.inFlight = item;
        // Exactly one slot just freed → wake exactly one (oldest, FIFO) blocked producer.
        this.wakeOneWaiter();
        // PERSIST FIRST (durable), THEN flush live — the persist-before-flush invariant.
        await this.persist(item);
        if (this.live) await this.live(item);
        this.inFlight = null;
      }
    } catch (err) {
      this.failure = err;
      // Leave `inFlight` set (its persist/flush did not complete); reject EVERY producer waiting on
      // space so none is left hung on a worker that has stopped (fail-closed, no orphan).
      this.rejectAllWaiters(err);
    } finally {
      this.draining = false;
    }
  }

  /**
   * Wait until every admitted event has been persisted (+ flushed). Call once the run completes so
   * the tail of the queue is durable before run-core returns the RunResult. Rejects if the worker
   * hit a persist failure (fail-closed: the caller learns the durable log is incomplete).
   */
  async drain(): Promise<void> {
    // Ensure the worker is running, then poll until BOTH the waiting room is empty AND nothing is
    // in flight (the worker is async). A persist failure short-circuits the wait and rethrows.
    this.startWorker();
    while ((this.queue.length > 0 || this.inFlight !== null) && !this.failure) {
      await new Promise<void>((r) => setTimeout(r, 0));
    }
    if (this.failure) throw this.failure;
  }
}
