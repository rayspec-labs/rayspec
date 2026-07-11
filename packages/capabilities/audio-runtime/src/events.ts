/**
 * The `session_finalized` EVENT SEAM (the Tier A ↔ Tier B contract half).
 *
 * Finalize is a Tier B capability operation; STARTING a product workflow is Tier A's job. So this
 * capability does NOT call a durable agent run on finalize (that enqueue would be product-specific).
 * Instead it EMITS a product-neutral `session_finalized` event through an injected
 * `SessionFinalizedSink`. The Tier A workflow runtime subscribes to that event and enforces
 * session-scoped single-flight by the event's `event_id` (= `${tenantId}:${sessionId}`), so a dual-track
 * finalize converges on EXACTLY one workflow.
 *
 * INTEGRATION SEAM: the Tier A workflow runtime owns the real event-ingress sink; this is this module's
 * half of the contract, defined against the documented event shape. The in-memory sink
 * below is the deterministic test/dev implementation. A real deployment injects the Tier A ingress as the
 * sink; whether that ingress write must be transactional with the finalize tx is a wiring decision.
 */
import type { FinalizedSessionEvent } from './types.js';

/**
 * The event sink the capability emits `session_finalized` through. Delivery MUST be idempotent by
 * `event.event_id`: finalize emits on BOTH the first-seal path AND the idempotent already-completed
 * path (mirroring the pack's exactly-once enqueue), so a re-finalize / a concurrent second-track finalize
 * re-emits the SAME `event_id` — the sink must treat the second delivery as a no-op (one workflow).
 */
export interface SessionFinalizedSink {
  emit(event: FinalizedSessionEvent): Promise<void>;
}

/**
 * A sink's DELIBERATE fail-closed rejection of a session event (E2E-2). A sink that refuses to
 * forward an event as a matter of LAW (e.g. the workflow bridge's cross-tenant assertion) throws a
 * subclass of this — the sink keeps throwing (the fail-closed law is unchanged), and the RaySpec
 * route binding maps an instance of THIS class to a clean `403 { error: 'session_event_rejected' }`
 * instead of an unhandled 500. Any other sink throw is a genuine fault and still surfaces as a 500.
 */
export class SessionEventRejectedError extends Error {
  /** A stable machine-readable reason code (e.g. `cross_tenant`). Never carries tenant ids. */
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = 'SessionEventRejectedError';
    this.reason = reason;
  }
}

/**
 * A deterministic in-memory sink for tests/dev. It is the single-flight authority: it dedupes by
 * `event_id`, keeping the FIRST delivered event per id (later re-emissions are no-ops). This reproduces
 * the REAL downstream constraint (one workflow per session) so a test that relies on it proves the
 * capability emits a session-scoped key — not a per-track one (the fail-the-fix discipline: the fake
 * ENFORCES the real constraint).
 */
export class InMemorySessionFinalizedSink implements SessionFinalizedSink {
  private readonly byId = new Map<string, FinalizedSessionEvent>();
  /** Every raw emission (incl. deduped re-emissions) in order — for asserting the emit call count. */
  private readonly emissions: FinalizedSessionEvent[] = [];

  async emit(event: FinalizedSessionEvent): Promise<void> {
    this.emissions.push(event);
    if (!this.byId.has(event.event_id)) {
      this.byId.set(event.event_id, event);
    }
  }

  /** The DEDUPED delivered events (one per event_id) — what a single-flight consumer would act on. */
  delivered(): FinalizedSessionEvent[] {
    return [...this.byId.values()];
  }

  /** The delivered event for one id, if any. */
  deliveredFor(eventId: string): FinalizedSessionEvent | undefined {
    return this.byId.get(eventId);
  }

  /** The count of RAW emit() calls (before dedupe) — proves finalize emitted on every seal path. */
  emitCount(): number {
    return this.emissions.length;
  }

  /** The count of DISTINCT delivered events (after dedupe) — proves session-scoped single-flight. */
  deliveredCount(): number {
    return this.byId.size;
  }

  clear(): void {
    this.byId.clear();
    this.emissions.length = 0;
  }
}

/** Build the deterministic in-memory sink (the test/dev default). */
export function createInMemorySessionFinalizedSink(): InMemorySessionFinalizedSink {
  return new InMemorySessionFinalizedSink();
}
