/**
 * The `SessionFinalizedSink` implementation that bridges an Audio/Media session-finalize into the Tier A
 * durable workflow runtime. A deployment injects this into `mountAudioCapability({ sessionFinalizedSink })`,
 * so a finalized session ENQUEUES a durable workflow run through the `WorkflowEventDispatcher`.
 * This is the real production sink the in-memory `InMemorySessionFinalizedSink` stands in for in
 * pure capability tests.
 *
 * TENANT RECONCILIATION (fail-closed). The dispatcher is tenant-bound at construction (server-derived,
 * single-deployment LOCAL posture — exactly like `DbosCronScheduler`); an `emit()` can NEVER cross
 * tenants. This sink is constructed with that SAME bound tenant, and asserts every event's
 * server-derived `tenant_id` matches it BEFORE forwarding — a cross-tenant event throws
 * (`CrossTenantSessionEventError`) and is NEVER enqueued, rather than silently running under the wrong
 * tenant. In the single-deployment posture the capability's finalize tenant always equals the
 * deployment tenant, so this only ever fires on a genuine misconfiguration.
 *
 * The sink does NOT single-flight itself: the capability re-emits the SAME session-scoped event on every
 * seal path (first-track / second-track / re-finalize), and the dispatcher's per-session enqueue
 * idempotency key (`sessionScopedIdempotencyKey`, → the tenant-namespaced `durableWorkflowRunId`) is what
 * dedups the re-emissions to ONE durable run (single-flight). So delivery is idempotent by design end-to-end.
 */
import {
  type FinalizedSessionEvent,
  SessionEventRejectedError,
  type SessionFinalizedSink,
} from '@rayspec/audio-runtime';
import type { WorkflowEventIngress } from '@rayspec/workflow-durable';
import { finalizedSessionEventToWorkflowInput } from './adapter.js';

/**
 * Raised when a session-finalize event's tenant does not match the dispatcher's bound tenant.
 * Extends `SessionEventRejectedError` (E2E-2): the throw is the sink's fail-closed LAW (never
 * enqueue cross-tenant), and the base class is what lets the route binding map it to a clean
 * deliberate 403 instead of an unhandled 500 — the substance (zero enqueue) is unchanged.
 */
export class CrossTenantSessionEventError extends SessionEventRejectedError {
  readonly boundTenant: string;
  readonly eventTenant: string;
  readonly eventId: string;
  constructor(boundTenant: string, eventTenant: string, eventId: string) {
    super(
      'cross_tenant',
      `session_finalized event tenant '${eventTenant}' does not match the dispatcher's bound tenant ` +
        `'${boundTenant}' (event ${eventId}) — refusing to enqueue cross-tenant (fail-closed).`,
    );
    this.name = 'CrossTenantSessionEventError';
    this.boundTenant = boundTenant;
    this.eventTenant = eventTenant;
    this.eventId = eventId;
  }
}

export interface WorkflowIngressSessionFinalizedSinkConfig {
  /** The tenant-bound workflow event dispatcher a finalized session enqueues a durable run through. */
  readonly ingress: WorkflowEventIngress;
  /** The dispatcher's bound (server-derived) tenant — every event's `tenant_id` MUST match it. */
  readonly tenantId: string;
}

/** A `SessionFinalizedSink` that adapts + forwards a finalized session to a `WorkflowEventIngress`. */
export class WorkflowIngressSessionFinalizedSink implements SessionFinalizedSink {
  readonly #ingress: WorkflowEventIngress;
  readonly #tenantId: string;

  constructor(config: WorkflowIngressSessionFinalizedSinkConfig) {
    this.#ingress = config.ingress;
    this.#tenantId = config.tenantId;
  }

  async emit(event: FinalizedSessionEvent): Promise<void> {
    if (event.tenant_id !== this.#tenantId) {
      throw new CrossTenantSessionEventError(this.#tenantId, event.tenant_id, event.event_id);
    }
    await this.#ingress.emit(finalizedSessionEventToWorkflowInput(event));
  }
}

/** Build the workflow-ingress session-finalized sink a deployment injects into `mountAudioCapability`. */
export function createWorkflowIngressSessionFinalizedSink(
  config: WorkflowIngressSessionFinalizedSinkConfig,
): WorkflowIngressSessionFinalizedSink {
  return new WorkflowIngressSessionFinalizedSink(config);
}
