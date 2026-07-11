/**
 * The `TurnSubmittedSink` implementation that bridges a turn submit into the Tier A durable
 * workflow runtime (the record/file `WorkflowIngress*Sink` pattern, mirrored exactly). A
 * deployment injects this into `mountConversationCapability({ turnSubmittedSink })`, so a
 * submitted turn ENQUEUES a durable workflow run through the `WorkflowEventDispatcher`.
 *
 * TENANT RECONCILIATION (fail-closed). The dispatcher is tenant-bound at construction
 * (server-derived, single-deployment LOCAL posture); an `emit()` can NEVER cross tenants. This
 * sink is constructed with that SAME bound tenant, and asserts every event's server-derived
 * `tenant_id` matches it BEFORE forwarding — a cross-tenant event throws
 * (`CrossTenantTurnEventError`) and is NEVER enqueued, rather than silently running under the
 * wrong tenant.
 *
 * The sink does NOT single-flight itself: the capability re-emits the SAME turn-scoped event on
 * every successful submit (first + re-POST) AND on the divergent-message 409 heal path (the DUR-1
 * heal — the STORED event, re-emitted so a persisted-but-never-enqueued turn is recovered by any
 * retry), and the dispatcher's per-turn enqueue idempotency key (the descriptor-derived
 * `payloadFieldIdempotencyKey('turn_ref')` → the tenant-namespaced `durableWorkflowRunId`) is what
 * dedups the re-emissions to ONE durable run per turn (C10). So delivery is idempotent by design
 * end-to-end — and PER-TURN, so a conversation's turns each get their own run.
 */
import {
  ConversationEventRejectedError,
  type SubmittedTurnEvent,
  type TurnSubmittedSink,
} from '@rayspec/conversation-runtime';
import type { WorkflowEventIngress } from '@rayspec/workflow-durable';
import { submittedTurnEventToWorkflowInput } from './adapter.js';

/**
 * Raised when a turn-submit event's tenant does not match the dispatcher's bound tenant. Extends
 * `ConversationEventRejectedError`: the throw is the sink's fail-closed LAW (never enqueue
 * cross-tenant — ZERO enqueue), and the base class is what lets the route binding map it to a
 * clean deliberate 403 instead of an unhandled 500.
 */
export class CrossTenantTurnEventError extends ConversationEventRejectedError {
  readonly boundTenant: string;
  readonly eventTenant: string;
  readonly eventId: string;
  constructor(boundTenant: string, eventTenant: string, eventId: string) {
    super(
      'cross_tenant',
      `turn_submitted event tenant '${eventTenant}' does not match the dispatcher's bound tenant ` +
        `'${boundTenant}' (event ${eventId}) — refusing to enqueue cross-tenant (fail-closed).`,
    );
    this.name = 'CrossTenantTurnEventError';
    this.boundTenant = boundTenant;
    this.eventTenant = eventTenant;
    this.eventId = eventId;
  }
}

export interface WorkflowIngressTurnSubmittedSinkConfig {
  /** The tenant-bound workflow event dispatcher a submitted turn enqueues a durable run through. */
  readonly ingress: WorkflowEventIngress;
  /** The dispatcher's bound (server-derived) tenant — every event's `tenant_id` MUST match it. */
  readonly tenantId: string;
}

/** A `TurnSubmittedSink` that adapts + forwards a submitted turn to a `WorkflowEventIngress`. */
export class WorkflowIngressTurnSubmittedSink implements TurnSubmittedSink {
  readonly #ingress: WorkflowEventIngress;
  readonly #tenantId: string;

  constructor(config: WorkflowIngressTurnSubmittedSinkConfig) {
    this.#ingress = config.ingress;
    this.#tenantId = config.tenantId;
  }

  async emit(event: SubmittedTurnEvent): Promise<void> {
    if (event.tenant_id !== this.#tenantId) {
      throw new CrossTenantTurnEventError(this.#tenantId, event.tenant_id, event.event_id);
    }
    await this.#ingress.emit(submittedTurnEventToWorkflowInput(event));
  }
}

/** Build the workflow-ingress turn-submitted sink a deployment injects into the mount. */
export function createWorkflowIngressTurnSubmittedSink(
  config: WorkflowIngressTurnSubmittedSinkConfig,
): WorkflowIngressTurnSubmittedSink {
  return new WorkflowIngressTurnSubmittedSink(config);
}
