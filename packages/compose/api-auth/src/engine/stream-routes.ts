/**
 * The `{ kind:'stream', mode:'ingest' }` route-action interpreter (the binary
 * write half of the `stream` primitive).
 *
 * A `stream` route is the platform's CHOKEPOINT-BYPASS surface: it reads the RAW Web `Request` (the
 * binary body — `c.req.raw`, NEVER `c.req.json()`) and returns a raw Web `Response`, bypassing the
 * uniform JSON envelope every other route uses. That makes it security-load-bearing, so the entire DB
 * + blob surface a stream handler can touch is the INJECTED, tenant-bound capability set (never a raw
 * pool/db/blob backend):
 *   - on the SAME ordered auth/tenant middleware chain as every route (server-derived tenant);
 *   - INSIDE `forTenant(db, tenantId).transaction(...)` (the GUC seam — A3) via the platform's
 *     `invokeStreamRouteHandler`, so every `init.db` write (the pointer row) is in ONE tenant-scoped,
 *     atomic transaction;
 *   - with `init.blob` a `BlobStore` tenant-bound BY CONSTRUCTION (the blob does NOT traverse the SQL
 *     chokepoint — its tenant-prefix + path jail ARE its entire tenant isolation).
 * The new `gate:extension-capability` enforces that a stream handler self-constructs no raw capability.
 *
 * PRODUCT-AGNOSTIC (zero media/audio vocabulary): the platform provides only the raw-stream plumbing +
 * the tenant-bound capabilities. The 200-ack/409-gap/200-no-op ingest CONTRACT (and any media shape)
 * lives entirely in the (synthetic) PACK handler — the platform stays 100% product-empty.
 *
 * ISOLATE-READINESS (honest): the raw `Request`/`Response` a stream handler exchanges is NOT trivially
 * serializable across a external-exposure hardening isolate boundary (it carries a live body stream + header object, not a
 * plain value) — like `HandlerDb.transaction`'s closure, the cross-isolate stream model is a design
 * point, NOT solved here. The in-process call is correct + GUC-populated; see `invokeStreamRouteHandler`.
 *
 * TX POSTURE (S3): the optional `ResolvedHandler.routeTx` flag is NOT honored here — both stream
 * arms ALWAYS run inside the engine's tenant transaction (only the plain `{kind:'handler'}` route
 * interpreter dispatches on it; see handler-runtime.ts).
 */

import { ApiError } from '@rayspec/auth-core';
import { forTenant } from '@rayspec/db';
import {
  type BlobStoreFactory,
  invokeStreamRouteHandler,
  type ResolvedHandler,
  type StreamRouteHandler,
} from '@rayspec/platform';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { Context } from 'hono';
import type { AppDeps, AppEnv } from '../app-context.js';
import { principalActor } from './principal-actor.js';

/**
 * Collect the route's path + query params into a plain `{ key: string }` map (DATA). Path params win
 * over a same-named query param (the path is the more specific binding). All values are server-parsed
 * strings — never instructions, never a tenant signal (the tenant is server-derived). (Mirrors
 * route-handlers.ts `collectParams` — kept local so the two arms do not couple through a shared util.)
 */
function collectParams(c: Context<AppEnv>): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.req.query())) params[k] = v;
  for (const [k, v] of Object.entries(c.req.param())) {
    if (v !== undefined) params[k] = v;
  }
  return params;
}

/**
 * Build the Hono handler for one declared `{ kind:'stream', mode:'ingest' }` route. The resolved
 * handler fn is captured at registration (boot); it runs per request inside a tenant transaction via
 * the platform's `invokeStreamRouteHandler`, receiving the RAW Web `Request` + the tenant-bound blob.
 * The handler's raw Web `Response` is returned to Hono verbatim (no JSON envelope).
 */
export function makeStreamIngestHandler(args: {
  handler: ResolvedHandler;
  productTables: ReadonlyMap<string, PgTable>;
  deps: AppDeps;
  blobFactory: BlobStoreFactory;
}): (c: Context<AppEnv>) => Promise<Response> {
  const { handler, productTables, deps, blobFactory } = args;
  if (handler.kind !== 'route') {
    // Guarded again at registration; a stream handler is a route-kind handler (the grammar).
    throw new Error(`makeStreamIngestHandler: expected a 'route' handler, got '${handler.kind}'.`);
  }
  // The loader resolves a stream handler as `route`-kind (path-jailed, fail-closed at boot), so
  // `handler.fn` is typed `RouteHandler`. The RUNTIME signature of a stream handler is
  // `StreamRouteHandler` ((StreamRouteHandlerInit) => Response) — the raw-vs-JSON init shape is a
  // runtime concern the grammar does not distinguish (no separate HandlerKind). Cast here (sound for a
  // trusted-author handler — TS-checked at the author's edge against `StreamRouteHandler`, exactly the
  // class of cast the loader's `exported as never` makes across the dynamic-import boundary).
  const fn = handler.fn as unknown as StreamRouteHandler;

  return async (c: Context<AppEnv>): Promise<Response> => {
    const tenantId = c.get('tenantId');
    // resolveTenant + requirePermission already established a tenant; defensive 404 if not.
    if (!tenantId) throw new ApiError('NOT_FOUND', 'Not found.');
    const tdb = forTenant(deps.db, tenantId);
    const params = collectParams(c);
    // derive the un-spoofable caller identity for the `created_by` stamp (user:<userId> / key:<apiKeyId>)
    // from THIS request's SERVER-DERIVED principal — the SAME derivation the JSON {handler} route and the
    // declarative store.create path use. An ingest route runs the full auth chain (requireAuth →
    // resolveTenant → requirePermission('store:write')), so a principal is always present here. Threaded
    // into the handler's store facade so the pointer-row insert records who created it (un-spoofable: the
    // handler could not supply created_by — the facade rejects that server-controlled column).
    const createdByActor = principalActor(c.get('principal'));
    // The RAW Web Request — the binary body reaches the handler UNPARSED (the body is UNTRUSTED
    // DATA the handler treats as bytes; we never call c.req.json()). invokeStreamRouteHandler opens the
    // TenantDb.transaction (GUC), builds the StreamRouteHandlerInit (db + tenant-bound blob + params +
    // request), invokes the handler, and returns its raw Response.
    return invokeStreamRouteHandler(
      fn,
      tdb,
      productTables,
      params,
      c.req.raw,
      blobFactory,
      // no media resource on the ingest path (playback-only); the actor follows as the next arg.
      undefined,
      createdByActor,
    );
  };
}

/**
 * Build the Hono handler for one declared `{ kind:'stream', mode:'playback' }` route (
 * the media-streaming READ half). Structurally IDENTICAL to the ingest handler (the same
 * raw-Request-in / raw-Response-out plumbing through `invokeStreamRouteHandler` inside a tenant
 * transaction); the differences are entirely in the route's MIDDLEWARE TUPLE (the media-JWT verifier +
 * the per-user streaming semaphore, mounted at registration) and in the PACK handler (the Range/206 +
 * conditional-GET + 416 logic + the DB ownership re-validation). The platform stays product-agnostic:
 * it provides the tenant-bound `init.blob`/`init.db`, the raw Request/Response channel, and the
 * verified-but-NOT-trusted media `resource` claim — the media/Range vocabulary lives in the pack.
 *
 * `tenantId` here is SERVER-DERIVED by the media-JWT verifier (it set `c.tenantId` from the token's
 * verified claim — this route does NOT run `resolveTenant`). `mediaResource` is the OPAQUE resource the
 * token authorized (stashed by the verifier); it is passed to the handler, which BINDS it to the
 * requested route resource AND re-validates the resource's actual owning tenant against the DB before
 * serving a byte — the claim is never trusted alone.
 */
export function makeStreamPlaybackHandler(args: {
  handler: ResolvedHandler;
  productTables: ReadonlyMap<string, PgTable>;
  deps: AppDeps;
  blobFactory: BlobStoreFactory;
}): (c: Context<AppEnv>) => Promise<Response> {
  const { handler, productTables, deps, blobFactory } = args;
  if (handler.kind !== 'route') {
    throw new Error(
      `makeStreamPlaybackHandler: expected a 'route' handler, got '${handler.kind}'.`,
    );
  }
  const fn = handler.fn as unknown as StreamRouteHandler;

  return async (c: Context<AppEnv>): Promise<Response> => {
    const tenantId = c.get('tenantId');
    // The media-JWT verifier established the tenant (from the token); defensive 401 if somehow absent.
    if (!tenantId) throw new ApiError('UNAUTHENTICATED', 'Authentication failed.');
    const tdb = forTenant(deps.db, tenantId);
    const params = collectParams(c);
    // The OPAQUE resource the verified media token authorized (the verifier stashed it). The handler
    // binds it to the route resource + re-validates ownership in the DB; never trusted alone.
    const mediaResource = c.get('mediaResource');
    return invokeStreamRouteHandler(
      fn,
      tdb,
      productTables,
      params,
      c.req.raw,
      blobFactory,
      mediaResource,
    );
  };
}
