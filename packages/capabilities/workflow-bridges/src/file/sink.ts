/**
 * The `FileSubmittedSink` implementation that bridges a file submit into the Tier A durable
 * workflow runtime (the record `WorkflowIngressRecordSubmittedSink` pattern, mirrored exactly). A
 * deployment injects this into `mountFileCapability({ fileSubmittedSink })`, so a submitted file
 * ENQUEUES a durable workflow run through the `WorkflowEventDispatcher`.
 *
 * TENANT RECONCILIATION (fail-closed). The dispatcher is tenant-bound at construction
 * (server-derived, single-deployment LOCAL posture); an `emit()` can NEVER cross tenants. This
 * sink is constructed with that SAME bound tenant, and asserts every event's server-derived
 * `tenant_id` matches it BEFORE forwarding — a cross-tenant event throws
 * (`CrossTenantFileEventError`) and is NEVER enqueued, rather than silently running under the
 * wrong tenant.
 *
 * The sink does NOT single-flight itself: the capability re-emits the SAME file-scoped event on
 * every successful submit (first + re-submit) AND on the divergent-conflict 409 heal paths (the
 * STORED event, re-emitted so a sealed-but-never-enqueued file is recovered by
 * any retry), and the dispatcher's per-file enqueue idempotency key (the descriptor-derived
 * `payloadFieldIdempotencyKey('file_id')` → the tenant-namespaced `durableWorkflowRunId`) is what
 * dedups the re-emissions to ONE durable run (single-flight). So delivery is idempotent by design
 * end-to-end.
 */
import {
  FileEventRejectedError,
  type FileSubmittedSink,
  type SubmittedFileEvent,
} from '@rayspec/file-runtime';
import type { WorkflowEventIngress } from '@rayspec/workflow-durable';
import { submittedFileEventToWorkflowInput } from './adapter.js';

/**
 * Raised when a file-submit event's tenant does not match the dispatcher's bound tenant. Extends
 * `FileEventRejectedError`: the throw is the sink's fail-closed LAW (never enqueue cross-tenant —
 * ZERO enqueue), and the base class is what lets the route binding map it to a clean deliberate
 * 403 instead of an unhandled 500.
 */
export class CrossTenantFileEventError extends FileEventRejectedError {
  readonly boundTenant: string;
  readonly eventTenant: string;
  readonly eventId: string;
  constructor(boundTenant: string, eventTenant: string, eventId: string) {
    super(
      'cross_tenant',
      `file_submitted event tenant '${eventTenant}' does not match the dispatcher's bound tenant ` +
        `'${boundTenant}' (event ${eventId}) — refusing to enqueue cross-tenant (fail-closed).`,
    );
    this.name = 'CrossTenantFileEventError';
    this.boundTenant = boundTenant;
    this.eventTenant = eventTenant;
    this.eventId = eventId;
  }
}

export interface WorkflowIngressFileSubmittedSinkConfig {
  /** The tenant-bound workflow event dispatcher a submitted file enqueues a durable run through. */
  readonly ingress: WorkflowEventIngress;
  /** The dispatcher's bound (server-derived) tenant — every event's `tenant_id` MUST match it. */
  readonly tenantId: string;
}

/** A `FileSubmittedSink` that adapts + forwards a submitted file to a `WorkflowEventIngress`. */
export class WorkflowIngressFileSubmittedSink implements FileSubmittedSink {
  readonly #ingress: WorkflowEventIngress;
  readonly #tenantId: string;

  constructor(config: WorkflowIngressFileSubmittedSinkConfig) {
    this.#ingress = config.ingress;
    this.#tenantId = config.tenantId;
  }

  async emit(event: SubmittedFileEvent): Promise<void> {
    if (event.tenant_id !== this.#tenantId) {
      throw new CrossTenantFileEventError(this.#tenantId, event.tenant_id, event.event_id);
    }
    await this.#ingress.emit(submittedFileEventToWorkflowInput(event));
  }
}

/** Build the workflow-ingress file-submitted sink a deployment injects into `mountFileCapability`. */
export function createWorkflowIngressFileSubmittedSink(
  config: WorkflowIngressFileSubmittedSinkConfig,
): WorkflowIngressFileSubmittedSink {
  return new WorkflowIngressFileSubmittedSink(config);
}
