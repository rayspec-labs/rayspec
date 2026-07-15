/**
 * The `RecordSubmittedSink` implementation that bridges a record submit into the Tier A durable
 * workflow runtime (the audio `WorkflowIngressSessionFinalizedSink` pattern, mirrored exactly). A
 * deployment injects this into `mountRecordCapability({ recordSubmittedSink })`, so a submitted
 * record ENQUEUES a durable workflow run through the `WorkflowEventDispatcher`.
 *
 * TENANT RECONCILIATION (fail-closed). The dispatcher is tenant-bound at construction
 * (server-derived, single-deployment LOCAL posture); an `emit()` can NEVER cross tenants. This
 * sink is constructed with that SAME bound tenant, and asserts every event's server-derived
 * `tenant_id` matches it BEFORE forwarding — a cross-tenant event throws
 * (`CrossTenantRecordEventError`) and is NEVER enqueued, rather than silently running under the
 * wrong tenant.
 *
 * The sink does NOT single-flight itself: the capability re-emits the SAME record-scoped event on
 * every successful submit (first + identical re-submit) AND on the divergent-conflict 409 path
 * (the STORED event, re-emitted so a persisted-but-never-enqueued record is
 * recovered by any retry), and the dispatcher's per-record enqueue idempotency key (the
 * descriptor-derived `payloadFieldIdempotencyKey('record_id')` → the tenant-namespaced
 * `durableWorkflowRunId`) is what dedups the re-emissions to ONE durable run (C10). So delivery
 * is idempotent by design end-to-end.
 */
import {
  RecordEventRejectedError,
  type RecordSubmittedSink,
  type SubmittedRecordEvent,
} from '@rayspec/record-runtime';
import type { WorkflowEventIngress } from '@rayspec/workflow-durable';
import { submittedRecordEventToWorkflowInput } from './adapter.js';

/**
 * Raised when a record-submit event's tenant does not match the dispatcher's bound tenant.
 * Extends `RecordEventRejectedError`: the throw is the sink's fail-closed LAW (never enqueue
 * cross-tenant — ZERO enqueue), and the base class is what lets the route binding map it to a
 * clean deliberate 403 instead of an unhandled 500.
 */
export class CrossTenantRecordEventError extends RecordEventRejectedError {
  readonly boundTenant: string;
  readonly eventTenant: string;
  readonly eventId: string;
  constructor(boundTenant: string, eventTenant: string, eventId: string) {
    super(
      'cross_tenant',
      `record_submitted event tenant '${eventTenant}' does not match the dispatcher's bound tenant ` +
        `'${boundTenant}' (event ${eventId}) — refusing to enqueue cross-tenant (fail-closed).`,
    );
    this.name = 'CrossTenantRecordEventError';
    this.boundTenant = boundTenant;
    this.eventTenant = eventTenant;
    this.eventId = eventId;
  }
}

export interface WorkflowIngressRecordSubmittedSinkConfig {
  /** The tenant-bound workflow event dispatcher a submitted record enqueues a durable run through. */
  readonly ingress: WorkflowEventIngress;
  /** The dispatcher's bound (server-derived) tenant — every event's `tenant_id` MUST match it. */
  readonly tenantId: string;
}

/** A `RecordSubmittedSink` that adapts + forwards a submitted record to a `WorkflowEventIngress`. */
export class WorkflowIngressRecordSubmittedSink implements RecordSubmittedSink {
  readonly #ingress: WorkflowEventIngress;
  readonly #tenantId: string;

  constructor(config: WorkflowIngressRecordSubmittedSinkConfig) {
    this.#ingress = config.ingress;
    this.#tenantId = config.tenantId;
  }

  async emit(event: SubmittedRecordEvent): Promise<void> {
    if (event.tenant_id !== this.#tenantId) {
      throw new CrossTenantRecordEventError(this.#tenantId, event.tenant_id, event.event_id);
    }
    await this.#ingress.emit(submittedRecordEventToWorkflowInput(event));
  }
}

/** Build the workflow-ingress record-submitted sink a deployment injects into `mountRecordCapability`. */
export function createWorkflowIngressRecordSubmittedSink(
  config: WorkflowIngressRecordSubmittedSinkConfig,
): WorkflowIngressRecordSubmittedSink {
  return new WorkflowIngressRecordSubmittedSink(config);
}
