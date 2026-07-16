/**
 * The `record_submitted` EVENT SEAM (the audio `events.ts` pattern).
 *
 * Submitting a record is a Tier B capability operation; STARTING a product workflow is Tier A's
 * job. So this capability does NOT enqueue a durable run itself — it EMITS a product-neutral
 * `record_submitted` event through an injected `RecordSubmittedSink`. The Tier A workflow runtime
 * subscribes to that event and enforces record-scoped single-flight by the event's `event_id`
 * (= `${tenantId}:${recordId}`) / the descriptor-derived idempotency key, so a client re-submit
 * (retry = redelivery) converges on EXACTLY one workflow run (C10).
 */
import type { SubmittedRecordEvent } from './types.js';

/**
 * The event sink the capability emits `record_submitted` through. Delivery MUST be idempotent by
 * `event.event_id`: submit emits on the first-persist path, the identical-re-submit path, AND the
 * divergent-conflict 409 path (the heal — always the STORED event, so a crash between
 * persist and emit is recovered by ANY retry payload) — the sink treats the second delivery of
 * one `event_id` as a no-op (one workflow).
 */
export interface RecordSubmittedSink {
  emit(event: SubmittedRecordEvent): Promise<void>;
}

/**
 * A sink's DELIBERATE fail-closed rejection of a record event (the audio
 * `SessionEventRejectedError` class, mirrored). A sink that refuses to forward an event as a
 * matter of LAW (e.g. the workflow bridge's cross-tenant assertion) throws a subclass of this —
 * the sink keeps throwing (the fail-closed law is unchanged; NOTHING was enqueued), and the
 * RaySpec route binding maps an instance of THIS class to a clean
 * `403 { error: 'record_event_rejected' }` instead of an unhandled 500. Any other sink throw is a
 * genuine fault and still surfaces as a 500.
 */
export class RecordEventRejectedError extends Error {
  /** A stable machine-readable reason code (e.g. `cross_tenant`). Never carries tenant ids. */
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = 'RecordEventRejectedError';
    this.reason = reason;
  }
}

/**
 * A deterministic in-memory sink for tests/dev — the single-flight authority: it dedupes by
 * `event_id`, keeping the FIRST delivered event per id (later re-emissions are no-ops). The fake
 * ENFORCES the real downstream constraint (one workflow per record — the fail-the-fix
 * discipline), so a test relying on it proves the capability emits a record-scoped key.
 */
export class InMemoryRecordSubmittedSink implements RecordSubmittedSink {
  private readonly byId = new Map<string, SubmittedRecordEvent>();
  /** Every raw emission (incl. deduped re-emissions) in order — for asserting the emit call count. */
  private readonly emissions: SubmittedRecordEvent[] = [];

  async emit(event: SubmittedRecordEvent): Promise<void> {
    this.emissions.push(event);
    if (!this.byId.has(event.event_id)) {
      this.byId.set(event.event_id, event);
    }
  }

  /** The DEDUPED delivered events (one per event_id) — what a single-flight consumer acts on. */
  delivered(): SubmittedRecordEvent[] {
    return [...this.byId.values()];
  }

  /** The delivered event for one id, if any. */
  deliveredFor(eventId: string): SubmittedRecordEvent | undefined {
    return this.byId.get(eventId);
  }

  /** The count of RAW emit() calls (before dedupe) — proves submit emitted on every path. */
  emitCount(): number {
    return this.emissions.length;
  }

  /** The count of DISTINCT delivered events (after dedupe) — proves record-scoped single-flight. */
  deliveredCount(): number {
    return this.byId.size;
  }

  clear(): void {
    this.byId.clear();
    this.emissions.length = 0;
  }
}

/** Build the deterministic in-memory sink (the test/dev default). */
export function createInMemoryRecordSubmittedSink(): InMemoryRecordSubmittedSink {
  return new InMemoryRecordSubmittedSink();
}
