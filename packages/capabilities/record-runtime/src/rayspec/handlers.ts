/**
 * The RaySpec platform binding (the audio `rayspec/handlers.ts` pattern) — the thin adapter that
 * turns the product-neutral capability core into a `RouteHandler` running behind RaySpec's real
 * auth/tenancy chain. It imports `@rayspec/handler-sdk` TYPE-ONLY for shapes (plus the
 * `httpResponse` envelope helper), threading `init.db`/`init.tenantId`/`init.params`/`init.body`
 * straight into the core ports. The binding owns ONLY transport concerns (status-code mapping);
 * the contract lives in the core (submit.ts).
 *
 * ── THE PRE-PARSE BODY-SIZE POSTURE (HS-1, deliberate) ────────────────────────────────────────
 * `init.body` arrives ALREADY parsed by the shared `{handler}` route interpreter
 * (route-handlers.ts `c.req.json().catch(() => undefined)`), which has no Content-Length guard —
 * so this capability CANNOT pre-parse-bound the raw body from its own layer (the parse happened
 * before the handler runs, and `content-length` is not in the interpreter's forwarded-header
 * allowlist). What IS guarded here: an unparseable/absent body arrives as `undefined` → the clean
 * 422 (the interpreter's catch already contains any JSON.parse blow-up, incl. deep-nesting
 * RangeErrors); the parsed value is depth-bounded (422 `record_too_deep`) BEFORE any
 * canonicalization and byte-bounded (413) after — the trust-boundary stack-overflow DoS is closed at the
 * capability core. What is NOT guarded here (a PLATFORM-wide posture, not a record-route gap): an
 * authenticated caller can still stream a large body that the shared interpreter buffers+parses
 * before this handler rejects it — the same exposure every `{handler}`/CRUD route has (only the
 * OAuth token endpoint carries a bespoke Content-Length bound, app.ts
 * OAUTH_TOKEN_MAX_BODY_BYTES). Bounding request bodies for ALL declared routes belongs in the
 * shared interpreter as its own reviewed change, not as a record-capability special case.
 */
import { httpResponse, type RouteHandler, type RouteHandlerInit } from '@rayspec/handler-sdk';
import type { ResolvedRecordConfig } from '../config.js';
import { RecordEventRejectedError, type RecordSubmittedSink } from '../events.js';
import type { RecordNormalizerFactory } from '../normalizer.js';
import type { RecordCoreContext } from '../ports.js';
import { submitRecord } from '../submit.js';

/** The wiring the capability handler needs (built by `mountRecordCapability`). */
export interface RecordHandlersConfig {
  readonly resolved: ResolvedRecordConfig;
  /** The sink `submit` emits `record_submitted` through — the workflow-ingress event seam. */
  readonly recordSubmittedSink: RecordSubmittedSink;
  /**
   * OPTIONAL tenant-bound normalizer factory — invoked per request with the SERVER-DERIVED
   * `init.tenantId` (the sink/responder factory trust shape). Present iff the deployment wires an
   * input-normalize step for this capability; absent ⇒ the submit stores the raw record unchanged.
   */
  readonly recordNormalizer?: RecordNormalizerFactory;
}

/** Build the tenant-bound core context from a `{handler}` route init. */
function coreContext(init: RouteHandlerInit, config: ResolvedRecordConfig): RecordCoreContext {
  return { tenantId: init.tenantId, db: init.db, config };
}

/** The `record_input.submit` handler route (persist idempotently + emit `record_submitted`). */
export function makeRecordSubmitHandler(config: RecordHandlersConfig): RouteHandler {
  return async (init: RouteHandlerInit) => {
    const ctx = coreContext(init, config.resolved);
    // Build the tenant-bound normalizer per request from the SERVER-DERIVED tenant (absent when no
    // input-normalize step is wired — the submit then stores the raw record unchanged).
    const normalizer = config.recordNormalizer?.(init.tenantId);
    try {
      const result = await submitRecord(
        ctx,
        init.params,
        init.body,
        config.recordSubmittedSink,
        normalizer,
      );
      if (result.ok) return result.value;
      return httpResponse({
        status: result.status,
        body: { error: result.error, detail: result.detail },
      });
    } catch (e) {
      // A sink's DELIBERATE fail-closed rejection (e.g. the workflow bridge's cross-tenant
      // assertion) is a clean 403 with the capability's stable {error, detail} taxonomy — not an
      // unhandled 500. The sink keeps THROWING (its fail-closed law is unchanged; NOTHING was
      // enqueued — though the capability-owned submission row persisted under the CALLER's own
      // tenant, exactly like an audio session persists before its finalize event is rejected).
      //
      // CTI-1 (DELIBERATE, the audio-mirror posture): persist-then-reject is NOT a leak — the row
      // lives under the caller's OWN server-derived tenant behind the TenantDb predicate, and the
      // 403 means no workflow was enqueued for it. Under the single-deployment-tenant beta posture
      // (see LIMITATIONS) the dispatcher is bound to the deployment tenant, so a non-deployment
      // tenant's submit persists its row and is rejected HERE — the same contract the audio
      // capability pins for a sealed session whose finalize event is rejected (its e2e test (f)).
      //
      // The detail carries the stable machine reason, never tenant ids. Any OTHER throw is a
      // genuine fault → rethrow (500).
      if (e instanceof RecordEventRejectedError) {
        return httpResponse({
          status: 403,
          body: {
            error: 'record_event_rejected',
            detail: `the record_submitted event was rejected fail-closed (${e.reason}) — no workflow was started.`,
          },
        });
      }
      throw e;
    }
  };
}
