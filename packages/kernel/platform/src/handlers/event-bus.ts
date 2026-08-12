/**
 * The event-bus INJECTION SEAM — the shape the composition root wires and the handler builders call.
 *
 * The other optional capabilities arrive as a ready handle (`stt`, `tts`) or as a factory taking the
 * run's tenant (`blob`). This one takes the run's tenant-bound `TenantDb`, because that is what
 * carries both the tenant AND the transaction the events must land in: the emit is a statement on the
 * handler's own transaction, not a call to some outside service.
 *
 * TWO CONSTRUCTORS, because the two handler kinds have different transaction boundaries and pretending
 * otherwise would make one of them wrong:
 *
 *  - `buffered(tdb)` — for a ROUTE handler, which the engine already runs inside one transaction. The
 *    handler's `emit()` calls APPEND TO A REQUEST-LOCAL BUFFER and the engine flushes them as the LAST
 *    statement before COMMIT. This is not an optimisation: allocating at the `emit()` call would take
 *    the tenant's counter lock and hold it for the rest of the handler, serialising every request of
 *    that tenant behind its slowest handler run. Flushing at the boundary also makes the events atomic
 *    with the handler's own writes, so a subscriber can never see an event announcing a state change
 *    that is not yet readable.
 *
 *  - `immediate(tdb)` — for a TOOL handler, which has NO outer transaction by design (an agent fires
 *    several tools in parallel under the dispatch Semaphore). There is no boundary to flush at, so
 *    each emit is its own statement, durable when it returns.
 */
import type { TenantDb } from '@rayspec/db';
import type { EmitEvent } from '@rayspec/handler-sdk';

/** A route handler's buffered emit plus the flush the engine performs at the transaction boundary. */
export interface BufferedTenantEmit {
  /** The capability spread onto the init as `init.emit` — appends to the request-local buffer. */
  readonly emit: EmitEvent;
  /**
   * Write the buffered events. Called by the engine AFTER the handler returns and BEFORE the
   * transaction commits, on the same transactional handle the buffer was built from. A no-op when the
   * handler emitted nothing (an emit-free request touches the tenant's counter not at all).
   */
  flush(): Promise<void>;
}

/**
 * The deployment's event bus, injected when — and only when — the deployment enabled it. Its PRESENCE
 * is the enablement signal: absent ⇒ no init carries `emit` (the field is spread, so it is ABSENT, not
 * `undefined`-valued) and a handler that needs it fail-closes loudly.
 */
export interface TenantEventBus {
  /** Build the BUFFERED emit for a handler running inside the engine's route transaction. */
  buffered(tdb: TenantDb): BufferedTenantEmit;
  /** Build the IMMEDIATE emit for a handler with no outer transaction (a tool). */
  immediate(tdb: TenantDb): EmitEvent;
}
