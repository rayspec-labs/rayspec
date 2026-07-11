/**
 * The `file_submitted` EVENT SEAM (the record `events.ts` pattern, mirrored).
 *
 * Sealing a file is a Tier B capability operation; STARTING a product workflow is Tier A's job. So
 * this capability does NOT enqueue a durable run itself — it EMITS a product-neutral
 * `file_submitted` event through an injected `FileSubmittedSink`. The Tier A workflow runtime
 * subscribes to that event and enforces file-scoped single-flight by the event's `event_id`
 * (= `${tenantId}:${fileId}`) / the descriptor-derived idempotency key (`file_id:<id>`), so a
 * client re-submit (retry = redelivery) converges on EXACTLY one workflow run (C10).
 */
import type { SubmittedFileEvent } from './types.js';

/**
 * The event sink the capability emits `file_submitted` through. Delivery MUST be idempotent by
 * `event.event_id`: submit emits on the first-seal path, the re-submit path, AND the
 * divergent-conflict 409 paths (the DUR-1 heal — always the STORED event, so a crash between seal
 * and emit is recovered by ANY retry) — the sink treats the second delivery of one `event_id` as a
 * no-op (one workflow).
 */
export interface FileSubmittedSink {
  emit(event: SubmittedFileEvent): Promise<void>;
}

/**
 * A sink's DELIBERATE fail-closed rejection of a file event (the record
 * `RecordEventRejectedError` class, mirrored). A sink that refuses to forward an event as a matter
 * of LAW (e.g. the workflow bridge's cross-tenant assertion) throws a subclass of this — the sink
 * keeps throwing (the fail-closed law is unchanged; NOTHING was enqueued), and the RaySpec route
 * binding maps an instance of THIS class to a clean `403 { error: 'file_event_rejected' }` instead
 * of an unhandled 500. Any other sink throw is a genuine fault and still surfaces as a 500.
 */
export class FileEventRejectedError extends Error {
  /** A stable machine-readable reason code (e.g. `cross_tenant`). Never carries tenant ids. */
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = 'FileEventRejectedError';
    this.reason = reason;
  }
}

/**
 * A deterministic in-memory sink for tests/dev — the single-flight authority: it dedupes by
 * `event_id`, keeping the FIRST delivered event per id (later re-emissions are no-ops). The fake
 * ENFORCES the real downstream constraint (one workflow per file — the fail-the-fix
 * discipline), so a test relying on it proves the capability emits a file-scoped key.
 */
export class InMemoryFileSubmittedSink implements FileSubmittedSink {
  private readonly byId = new Map<string, SubmittedFileEvent>();
  /** Every raw emission (incl. deduped re-emissions) in order — for asserting the emit call count. */
  private readonly emissions: SubmittedFileEvent[] = [];

  async emit(event: SubmittedFileEvent): Promise<void> {
    this.emissions.push(event);
    if (!this.byId.has(event.event_id)) {
      this.byId.set(event.event_id, event);
    }
  }

  /** The DEDUPED delivered events (one per event_id) — what a single-flight consumer acts on. */
  delivered(): SubmittedFileEvent[] {
    return [...this.byId.values()];
  }

  /** The delivered event for one id, if any. */
  deliveredFor(eventId: string): SubmittedFileEvent | undefined {
    return this.byId.get(eventId);
  }

  /** The count of RAW emit() calls (before dedupe) — proves submit emitted on every path. */
  emitCount(): number {
    return this.emissions.length;
  }

  /** The count of DISTINCT delivered events (after dedupe) — proves file-scoped single-flight. */
  deliveredCount(): number {
    return this.byId.size;
  }

  clear(): void {
    this.byId.clear();
    this.emissions.length = 0;
  }
}

/** Build the deterministic in-memory sink (the test/dev default). */
export function createInMemoryFileSubmittedSink(): InMemoryFileSubmittedSink {
  return new InMemoryFileSubmittedSink();
}
