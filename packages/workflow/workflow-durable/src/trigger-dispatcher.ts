import type { WorkflowInputEvent, WorkflowSpec } from '@rayspec/foundation';

/**
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE WORKFLOW EVENT-INGRESS SEAM (the execution ↔ capability composition contract).
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The workflow engine owns EXECUTION; the Audio/Media capability EMITS a
 * `session_finalized`-class event when a recording session finalizes. So the two sides compose
 * across a NEUTRAL seam WITHOUT a cross-dependency:
 *
 *   Audio/Media capability  ──emit(WorkflowInputEvent)──▶  WorkflowEventDispatcher  ──enqueue──▶  durable run
 *
 * THE CONTRACT THE CAPABILITY IMPLEMENTS AGAINST (`WorkflowEventIngress`):
 *  1. When a session finalizes, the Audio/Media capability constructs a neutral `WorkflowInputEvent`
 *     with `type: 'audio_input.finalized_session'` (or its capability's event id) and a `payload`
 *     carrying the session identity (at minimum `session_id`) — DATA only, never instructions.
 *  2. It calls `ingress.emit(event)` (the `WorkflowEventDispatcher`) with NO tenant argument — the
 *     dispatcher is tenant-bound at construction (server-derived tenant, single-deployment LOCAL
 *     posture, exactly like `DbosCronScheduler`), so an emit can NEVER cross tenants.
 *  3. The dispatcher matches the event `type` to a registered workflow trigger and ENQUEUES a durable
 *     workflow run whose idempotency key is DERIVED FROM THE EVENT (per-session), so RE-DELIVERY of
 *     the same session's finalize event DEDUPS to one run (single-flight) while distinct sessions
 *     are distinct runs.
 *
 * COMPOSITION IS NOT ZERO-GLUE. The dispatcher's `emit()` takes a neutral
 * `WorkflowInputEvent`; the Audio/Media capability produces its OWN `FinalizedSessionEvent` shape.
 * So composing the two needs a small ADAPTER (landing in the post-merge integration commit, NOT here)
 * that maps `FinalizedSessionEvent → WorkflowInputEvent`:
 *   - `type`      ← `'audio_input.finalized_session'` (the trigger event id this dispatcher matches on);
 *   - `id`        ← the finalized-session event's `event_id`;
 *   - `occurred_at` ← the session's finalize timestamp;
 *   - `payload`   ← `{ session_id, tenant_id, tracks, source_capability }` (DATA only — never instructions).
 * The `session_id` in the payload is what `sessionScopedIdempotencyKey('session_id')` keys the run on, so
 * the mapping MUST carry it. Until that capability + adapter land, a FAKE emitter (tests / a deployment
 * harness) calls `emit()` with a synthetic finalized-session `WorkflowInputEvent` in exactly this shape.
 * The dispatcher itself is byte-identical either way; the ADAPTER (not just "the emitter") is the glue
 * that changes.
 */
/**
 * Per-emit options (ADDITIVE — omit for the byte-identical default dispatch).
 *
 * `forceKey` OVERRIDES the per-trigger idempotency key for THIS emit, bypassing the registered
 * `idempotencyKeyForEvent` (default `sessionScopedIdempotencyKey`). It is the OPERATIONAL reprocess
 * seam: re-driving a session's declared finalized-session workflow through the NORMAL emit path would
 * dedup to the prior run (the default per-session key resolves to the SAME `durableWorkflowRunId`), so
 * a reprocess supplies a DISTINCT key (e.g. `session_id:<id>:reprocess:<nonce>`) to enqueue a FRESH
 * durable run over the CURRENT store state — WITHOUT changing the byte-frozen `sessionScopedIdempotencyKey`
 * format the live audio finalize path depends on. An empty/whitespace `forceKey` FALLS BACK to the
 * per-trigger keyFn (fail-safe: never a silent shared collision key). `reason` is advisory operator
 * context the caller records alongside the reprocess (the dispatcher does not thread it into the frozen
 * enqueue signature).
 */
export interface WorkflowEmitOptions {
  readonly forceKey?: string;
  readonly reason?: string;
}

export interface WorkflowEventIngress {
  /** Ingest ONE neutral event; enqueue every registered workflow whose trigger event matches. */
  emit(event: WorkflowInputEvent, options?: WorkflowEmitOptions): Promise<WorkflowDispatchResult>;
}

/** The seam a dispatcher enqueues durable workflow runs through (the DBOS executor implements it). */
export interface WorkflowEnqueuer {
  /**
   * Enqueue a durable workflow run for `tenantId`, single-flighted by the tenant-namespaced run id
   * derived from `(tenantId, workflow.id, idempotencyKey)` — a redelivery/concurrent enqueue of the
   * same key dedups to the prior run. Returns the run id + whether it was a dedupe.
   */
  enqueueWorkflowRun(input: {
    tenantId: string;
    workflow: WorkflowSpec;
    event: WorkflowInputEvent;
    idempotencyKey: string;
  }): Promise<{ workflowRunId: string; deduped: boolean }>;
}

/** A workflow trigger registered on the dispatcher — the compiled workflow + how to key a run per event. */
export interface RegisteredWorkflowTrigger {
  /** The compiled workflow spec to run when the trigger event fires. */
  readonly workflow: WorkflowSpec;
  /** The event `type` that fires it (defaults to `workflow.trigger.event`). */
  readonly triggerEvent?: string;
  /**
   * Derive the PER-EVENT idempotency key (the single-flight scope). A `session_finalized` trigger keys
   * on the session id, so re-delivery of the same session's event dedups while distinct sessions are
   * distinct runs. Defaults to `sessionScopedIdempotencyKey('session_id')`.
   */
  readonly idempotencyKeyForEvent?: (event: WorkflowInputEvent) => string;
}

/** One enqueued (or deduped) run from a dispatch. */
export interface WorkflowDispatchEnqueued {
  workflowId: string;
  workflowRunId: string;
  deduped: boolean;
}

/** The outcome of dispatching one event: every matched workflow's enqueue result. */
export interface WorkflowDispatchResult {
  enqueued: WorkflowDispatchEnqueued[];
}

/**
 * The tenant-bound workflow event dispatcher — the `WorkflowEventIngress` implementation. Matches an
 * emitted event to its registered workflow trigger(s) and enqueues a durable run per match, keyed
 * per-event (single-flight on redelivery). Product-agnostic: the workflows + the tenant are injected.
 */
export class WorkflowEventDispatcher implements WorkflowEventIngress {
  readonly #tenantId: string;
  readonly #enqueuer: WorkflowEnqueuer;
  /** triggerEvent → the triggers listening on it. */
  readonly #byEvent = new Map<string, RegisteredWorkflowTrigger[]>();

  constructor(config: {
    /** The deployment tenant every dispatched run executes under (server-derived, single-deployment). */
    tenantId: string;
    enqueuer: WorkflowEnqueuer;
    triggers: readonly RegisteredWorkflowTrigger[];
  }) {
    this.#tenantId = config.tenantId;
    this.#enqueuer = config.enqueuer;
    for (const trigger of config.triggers) {
      const event = trigger.triggerEvent ?? trigger.workflow.trigger.event;
      const list = this.#byEvent.get(event) ?? [];
      list.push(trigger);
      this.#byEvent.set(event, list);
    }
  }

  async emit(
    event: WorkflowInputEvent,
    options?: WorkflowEmitOptions,
  ): Promise<WorkflowDispatchResult> {
    const triggers = this.#byEvent.get(event.type) ?? [];
    const enqueued: WorkflowDispatchEnqueued[] = [];
    // A non-empty forceKey overrides the per-trigger keyFn for THIS emit (the reprocess seam);
    // an empty/whitespace value FALLS BACK to the keyFn (never a silent shared collision key).
    const forced =
      typeof options?.forceKey === 'string' && options.forceKey.trim().length > 0
        ? options.forceKey
        : undefined;
    for (const trigger of triggers) {
      const keyFn = trigger.idempotencyKeyForEvent ?? sessionScopedIdempotencyKey('session_id');
      const idempotencyKey = forced ?? keyFn(event);
      const { workflowRunId, deduped } = await this.#enqueuer.enqueueWorkflowRun({
        tenantId: this.#tenantId,
        workflow: trigger.workflow,
        event,
        idempotencyKey,
      });
      enqueued.push({ workflowId: trigger.workflow.id, workflowRunId, deduped });
    }
    return { enqueued };
  }

  /** The events this dispatcher listens on (for a boot banner / test). */
  get triggerEvents(): string[] {
    return [...this.#byEvent.keys()];
  }
}

/**
 * Derive a per-event idempotency key from an event-payload field (e.g. `session_id`). A missing field
 * FALLS BACK to the event id (still a stable per-delivery key) rather than colliding every event onto
 * one key — fail-safe, never a silent cross-session merge.
 *
 * ⚠ LEGACY KEY FORMAT (`<field>:<value>:finalized`) — AUDIO-ONLY, BYTE-FROZEN: live deployment
 * durable run ids derive from this exact string (a format drift re-keys live runs → duplicate runs
 * on redelivery). NEW trigger events use `payloadFieldIdempotencyKey` below — this function
 * stays for the audio event and must never change.
 */
export function sessionScopedIdempotencyKey(field: string): (event: WorkflowInputEvent) => string {
  return (event: WorkflowInputEvent) => {
    const value = event.payload[field];
    if (typeof value === 'string' && value.length > 0) return `${field}:${value}:finalized`;
    return `event:${event.id}`;
  };
}

/**
 * The GENERIC per-event idempotency key derivation (ADDITIVE): `<field>:<value>`
 * — the clean format every NEW trigger event's descriptor-derived key uses (the `:finalized` suffix
 * above is audio-only legacy). Same fail-safe law: a missing/empty field FALLS BACK to the event id
 * (a stable per-delivery key), never a shared collision key.
 */
export function payloadFieldIdempotencyKey(field: string): (event: WorkflowInputEvent) => string {
  return (event: WorkflowInputEvent) => {
    const value = event.payload[field];
    if (typeof value === 'string' && value.length > 0) return `${field}:${value}`;
    return `event:${event.id}`;
  };
}
