/**
 * The RaySpec platform binding (the audio/record `rayspec/handlers.ts` pattern) — the thin
 * adapter that turns the product-neutral capability core into `RouteHandler`/`StreamRouteHandler`
 * functions running behind RaySpec's real auth/tenancy chain. It imports `@rayspec/handler-sdk`
 * TYPE-ONLY for shapes (plus the `httpResponse` envelope helper), threading
 * `init.db`/`init.blob`/`init.tenantId`/`init.params`/`init.body`/`init.request` straight into the
 * core ports. The binding owns ONLY transport concerns (header extraction, raw-vs-JSON response,
 * status-code mapping); the contract lives in the core (upload.ts / submit.ts).
 *
 * ── THE BODY-SIZE POSTURE (deliberate) ─────────
 * The upload route is a `{kind:'stream', mode:'ingest'}` route: the interpreter hands the RAW
 * `Request` to this binding (no pre-parse buffering — unlike a `{handler}` route's JSON body), so
 * the capability CAN and DOES bound the bytes itself: the core rejects on the declared
 * Content-Length BEFORE reading any body byte (413) and enforces the cap AGAIN while draining
 * chunk-wise (a lying Content-Length aborts at the cap boundary — never audio's unbounded
 * `arrayBuffer()`, never an unbounded buffer). The JSON submit route carries no bytes (a closed
 * tiny body shape) and rides the shared `{handler}` interpreter unchanged.
 */
import {
  httpResponse,
  type RouteHandler,
  type RouteHandlerInit,
  type StreamRouteHandler,
  type StreamRouteHandlerInit,
} from '@rayspec/handler-sdk';
import type { ResolvedFileConfig } from '../config.js';
import type { FileCapabilityError, FileCapabilityResult } from '../errors.js';
import { FileEventRejectedError, type FileSubmittedSink } from '../events.js';
import type { FileBlobContext, FileCoreContext, FileUploadRequest } from '../ports.js';
import { submitFile } from '../submit.js';
import type { FileErrorBody } from '../types.js';
import { uploadFile } from '../upload.js';

/** The OPTIONAL request header carrying the client filename (DATA only — never a key component). */
export const FILE_NAME_HEADER = 'x-file-name';

/** The wiring the capability handlers need (built by `mountFileCapability`). */
export interface FileHandlersConfig {
  readonly resolved: ResolvedFileConfig;
  /** The sink submit (and the upload 409 heal) emits `file_submitted` through — the event seam. */
  readonly fileSubmittedSink: FileSubmittedSink;
}

/** Build the base (db-only) context from a `{handler}` route init. */
function coreContext(init: RouteHandlerInit, config: ResolvedFileConfig): FileCoreContext {
  return { tenantId: init.tenantId, db: init.db, config };
}

/** Build the blob context from a `stream` route init (its `blob` is always present). */
function blobContext(init: StreamRouteHandlerInit, config: ResolvedFileConfig): FileBlobContext {
  return { tenantId: init.tenantId, db: init.db, blob: init.blob, config };
}

/** Render a typed capability error into its JSON body (shared by both transport arms). */
function errorBody(result: FileCapabilityError): FileErrorBody {
  return { error: result.error, detail: result.detail };
}

/** Map a capability result to a raw JSON `Response` (the stream-route transport). */
function toRawResponse(result: FileCapabilityResult<unknown>): Response {
  const body = result.ok ? result.value : errorBody(result);
  const status = result.ok ? 200 : result.status;
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The stable rejected-event 403 body (shared by both transport arms — the record E2E-2 posture). */
function rejectedBody(e: FileEventRejectedError): FileErrorBody {
  return {
    error: 'file_event_rejected',
    detail: `the file_submitted event was rejected fail-closed (${e.reason}) — no workflow was started.`,
  };
}

/** The `file_input.upload` stream-ingest handler (bounded raw bytes in / JSON ack out). */
export function makeFileUploadHandler(config: FileHandlersConfig): StreamRouteHandler {
  return async (init: StreamRouteHandlerInit): Promise<Response> => {
    const ctx = blobContext(init, config.resolved);
    const request: FileUploadRequest = {
      contentLengthHeader: init.request.headers.get('content-length'),
      contentTypeHeader: init.request.headers.get('content-type'),
      fileNameHeader: init.request.headers.get(FILE_NAME_HEADER),
      body: init.request.body,
    };
    try {
      const result = await uploadFile(ctx, init.params, request, config.fileSubmittedSink);
      return toRawResponse(result);
    } catch (e) {
      // A sink's DELIBERATE fail-closed rejection (the workflow bridge's cross-tenant assertion,
      // reachable via the sealed-divergent 409 heal re-emit) is a clean 403 — not an unhandled
      // 500. The sink keeps throwing (its fail-closed law is unchanged; NOTHING was enqueued).
      // Any OTHER throw is a genuine fault → rethrow (500).
      if (e instanceof FileEventRejectedError) {
        return new Response(JSON.stringify(rejectedBody(e)), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw e;
    }
  };
}

/** The `file_input.submit` handler route (seal the staged bytes + emit `file_submitted`). */
export function makeFileSubmitHandler(config: FileHandlersConfig): RouteHandler {
  return async (init: RouteHandlerInit) => {
    const ctx = coreContext(init, config.resolved);
    try {
      const result = await submitFile(ctx, init.params, init.body, config.fileSubmittedSink);
      if (result.ok) return result.value;
      return httpResponse({ status: result.status, body: errorBody(result) });
    } catch (e) {
      // The record CTI-1 posture, mirrored: persist-then-reject is NOT a leak — the pointer row
      // lives under the caller's OWN server-derived tenant behind the TenantDb predicate, and the
      // 403 means no workflow was enqueued for it. The detail carries the stable machine reason,
      // never tenant ids. Any OTHER throw is a genuine fault → rethrow (500).
      if (e instanceof FileEventRejectedError) {
        return httpResponse({ status: 403, body: rejectedBody(e) });
      }
      throw e;
    }
  };
}
