/**
 * The `{ kind:'handler' }` route-action interpreter (the
 * declared ROUTE handler, wired through the escape-hatch handler model).
 *
 * A declared route handler is trusted-author product logic (layer 2) referenced by id. The
 * loader resolved it (path-jailed, fail-closed at boot); this interpreter builds the Hono handler
 * that runs it per request:
 *   - on the SAME ordered auth/tenant middleware chain as every route (server-derived tenant);
 *   - INSIDE `forTenant(db, tenantId).transaction(...)` (the GUC seam), so every DB touch the
 *     handler makes is in ONE tenant-scoped transaction (route handlers, unlike tool handlers, DO get
 *     an outer transaction);
 * through the platform's single `HandlerRuntime` indirection (external-exposure hardening isolate seam).
 *
 * (.3 — store rows are DATA): the handler receives a serializable-shaped
 * `HandlerInit` (a name-keyed `HandlerDb` over the tenant's product stores). Anything it reads from a
 * store is DATA the handler returns as a JSON body — there is NO path here that turns a store row into
 * a system/user model turn (a route handler does not call the model; it returns a response body). The
 * route's PATH/QUERY params are likewise DATA (server-parsed strings), passed as `init.params`.
 *
 * PRODUCT-AGNOSTIC: the handler fn + the product tables are injected at runtime; no product handler,
 * store, or name is in platform source.
 */

import { ApiError } from '@rayspec/auth-core';
import { forTenant } from '@rayspec/db';
import {
  invokeRouteHandler,
  invokeRouteHandlerDetached,
  isHttpResponse,
  type ResolvedHandler,
} from '@rayspec/platform';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AppDeps, AppEnv } from '../app-context.js';
import { readBoundedJson } from '../http/bounded-body.js';
import type { MediaTokenService } from '../media/media-token.js';
import { makeEnqueueAgentRunCapability } from '../routes/runs.js';
import { principalActor } from './principal-actor.js';

/**
 * Methods that may carry a request body. A GET/HEAD route never has one, so we don't attempt to read
 * it (avoids consuming a non-existent stream). For the rest, the body is parsed best-effort below.
 */
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Clamp a handler-chosen HTTP status to a status the WHATWG `Response` constructor accepts (an integer
 * in 200–599). fail-closed: a malformed/out-of-range value can never make Hono throw on an
 * invalid `Response` status. A non-integer or out-of-range value falls back to 200 (the default
 * success).
 *
 * LOWER BOUND IS 200, NOT 100: `new Response(body, { status })` THROWS
 * a `RangeError` for ANY status < 200 (all 1xx informational). 1xx statuses cannot be carried on a
 * `Response` at all, and a 1xx WITH a JSON body is doubly invalid — so the only fail-closed choice is
 * to fall back to 200. (A non-integer / >599 likewise falls back to 200.)
 */
function clampStatus(status: unknown): number {
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 200 || status > 599) {
    return 200;
  }
  return status;
}

/**
 * Sanitize handler-chosen response headers FAIL-CLOSED (symmetry with
 * the status clamp). A header with a malformed name or value makes `new Headers().set(name, value)`
 * THROW a `TypeError` — and the existing flow applied headers AFTER the tenant transaction had already
 * committed, so such a throw would escape as an uncaught 500 rather than fail-closing to the safe
 * response. We validate each entry against a throwaway `Headers` and DROP any that throw (and any
 * non-string value), returning only the entries that can be applied without throwing.
 *
 * A trusted-author handler deliberately overriding e.g. Content-Type is acceptable (that's a
 * trusted-author choice) — we only guard against a THROW escaping post-commit, not against legitimate
 * header values.
 */
function sanitizeHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== 'string') continue; // a non-string value can't be a valid header value.
    try {
      // A throwaway Headers validates BOTH the name (token) and the value (no control chars) — set()
      // throws TypeError on a malformed name/value; we drop those rather than let them throw later.
      new Headers().set(name, value);
      safe[name] = value;
    } catch {
      // Malformed header name/value — drop it (fail-closed to the safe response).
    }
  }
  return safe;
}

/**
 * Collect the route's path + query params into a `{ key: string }` map (DATA). Path params win
 * over a same-named query param (the path is the more specific binding). Hono exposes both via the
 * request; we read both so a declared handler can use either. All values are strings (server-parsed).
 *
 * NULL-PROTOTYPE (FCY-2): a caller-chosen param name is an object KEY — on a plain `{}` a param
 * named `toString`/`valueOf` shadows an Object.prototype member (and a consumer reading
 * `params.toString` when absent gets the inherited FUNCTION, a false-positive "present" value),
 * while `__proto__` as a key is a pollution vector. `Object.create(null)` removes the prototype
 * entirely: every key is an own data property, nothing is inherited.
 */
function collectParams(c: Context<AppEnv>): Record<string, string> {
  const params: Record<string, string> = Object.create(null);
  // Query params first (so a path param of the same name overrides below).
  for (const [k, v] of Object.entries(c.req.query())) params[k] = v;
  // Path params (the route's `:id` etc.).
  for (const [k, v] of Object.entries(c.req.param())) {
    if (v !== undefined) params[k] = v;
  }
  return params;
}

/**
 * the request headers a `{handler}` route FORWARDS into `init.headers` — a CLOSED ALLOWLIST.
 * This seam exists for the declared `conditional_read` feature (an SDK-consumption
 * capability of the views runtime: If-None-Match → 304) plus content-negotiation basics — NOT for
 * general header passthrough. Forwarding an allowlist instead of stripping a denylist means a
 * credential header (`authorization`, `cookie`, `proxy-authorization`, or any FUTURE credential
 * scheme) can NEVER reach a product handler: everything outside this set is simply not forwarded.
 *
 * EXTENSION POINT (deliberate): when a new DECLARED platform feature needs a request header, add it
 * HERE with a comment naming the feature that consumes it — never widen to a wildcard/denylist.
 */
const FORWARDED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  // The conditional-read set (the views runtime's declared `conditional_read` feature).
  'if-none-match',
  'if-match',
  'if-modified-since',
  'if-unmodified-since',
  'if-range',
  'range',
  // Content-negotiation basics (a handler choosing a representation reads these as DATA).
  'accept',
  'accept-language',
  'content-type',
]);

/**
 * collect the ALLOWLISTED request headers into a LOWERCASE-keyed string map (DATA — injected
 * as `init.headers`). The Fetch `Headers` iterator already yields lowercase names; values are plain
 * strings.: header values are UNTRUSTED CALLER DATA — never instructions, never a tenant
 * signal (the tenant stays server-derived by resolveTenant). Only `FORWARDED_REQUEST_HEADERS`
 * members are forwarded (see above) — credentials and unknown headers never reach a product handler.
 * The map is NULL-PROTOTYPE so a header named like an Object.prototype member can never shadow one.
 */
function collectHeaders(c: Context<AppEnv>): Record<string, string> {
  const headers: Record<string, string> = Object.create(null);
  c.req.raw.headers.forEach((value, name) => {
    if (FORWARDED_REQUEST_HEADERS.has(name)) headers[name] = value;
  });
  return headers;
}

/**
 * HTTP statuses that MUST NOT carry a body (`new Response(body, {status})` THROWS a TypeError for a
 * non-null body on these). A branded `httpResponse({ status: 304 })` from a handler (the views
 * runtime's If-None-Match) is therefore emitted via `c.body(null, …)` — a `c.json(null, 304)` would
 * serialize the string "null" and throw at request time (an uncaught post-commit 500). Any body a
 * handler attached to such a status is DROPPED fail-closed (the status semantics win).
 */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/**
 * Build the Hono handler for one declared `{handler}` route. The resolved handler fn is captured at
 * registration (boot); the handler runs per request inside a tenant transaction via the platform's
 * `invokeRouteHandler`. The return value is serialized as the JSON response body (200).
 */
export function makeRouteHandler(args: {
  handler: ResolvedHandler;
  productTables: ReadonlyMap<string, PgTable>;
  deps: AppDeps;
  /**
   * the media-token service (when a media key is wired). When present, a `{handler}` route
   * receives an `init.mintPlayToken` capability bound to the run's server-derived tenant + the authed
   * user — so a mint route can issue a short-lived `?token=` for a resource the caller owns. Absent ⇒
   * `init.mintPlayToken` is omitted (a mint handler fail-closes loudly).
   */
  mediaTokenService?: MediaTokenService;
}): (c: Context<AppEnv>) => Promise<Response> {
  const { handler, productTables, deps, mediaTokenService } = args;
  if (handler.kind !== 'route') {
    // Guarded again at registration; narrows the ResolvedHandler union so `handler.fn` is a RouteHandler.
    throw new Error(`makeRouteHandler: expected a 'route' handler, got '${handler.kind}'.`);
  }
  // `handler.fn` is typed as `RouteHandler` by the union now that `kind === 'route'` is established.
  const fn = handler.fn;

  return async (c: Context<AppEnv>): Promise<Response> => {
    const tenantId = c.get('tenantId');
    // resolveTenant + requirePermission already established a tenant; defensive 404 if not.
    if (!tenantId) throw new ApiError('NOT_FOUND', 'Not found.');
    const tdb = forTenant(deps.db, tenantId);
    const params = collectParams(c);
    // build the play-token mint capability bound to THIS request's SERVER-DERIVED tenant + the
    // authed user (the principal). The handler supplies only the opaque resource + the TTL — it can
    // neither forge a tenant (server-derived) nor mint for another user (the authed sub). Built only
    // when a media key is wired AND a user principal is present (a mint route is on the authed Bearer
    // chain, so the principal is always set here). Omitted otherwise ⇒ init.mintPlayToken is absent.
    const userId = c.get('principal')?.userId;
    // derive the un-spoofable caller identity for the `created_by` stamp (user:<userId> / key:<apiKeyId>)
    // from THIS request's server-derived principal — the SAME derivation the declarative store.create
    // path uses. Threaded into the handler's store facade so a handler insert records who created a row.
    const createdByActor = principalActor(c.get('principal'));
    const mintPlayToken =
      mediaTokenService && userId
        ? (mintArgs: { resource: string; ttlSeconds: number }): Promise<string> =>
            mediaTokenService.mint({
              tenantId,
              resource: mintArgs.resource,
              sub: userId,
              ttlSeconds: mintArgs.ttlSeconds,
            })
        : undefined;
    // build the TENANT-BOUND durable-enqueue capability for THIS request. The tenant is
    // the server-derived `tenantId` captured here + CLOSED OVER (the closure exposes NO tenant param), so
    // a pack handler can never enqueue cross-tenant. `undefined` when no durable worker is wired ⇒
    // init.enqueue is omitted (a handler that needs it fail-closes loudly — like blob/mintPlayToken).
    const enqueue = makeEnqueueAgentRunCapability(deps, tenantId);
    // read the request body for a body-bearing method (DATA the handler may use). Drained under the
    // configured byte cap (a body over the cap is a 413 BEFORE any handler side effect), then parsed
    // best-effort like the store-route CRUD path — an absent/invalid body yields `undefined` ⇒
    // init.body is omitted (a GET handler is unchanged). Never throws on a bad (but in-cap) body here.
    const requestBody = BODY_METHODS.has(c.req.method.toUpperCase())
      ? await readBoundedJson(c, deps.maxJsonBodyBytes, undefined)
      : undefined;
    // invokeRouteHandler opens the TenantDb.transaction (GUC) + builds the HandlerInit + routes
    // through the single HandlerRuntime indirection. The result is the JSON response body — OR the
    // OPT-IN branded `httpResponse({...})` envelope carrying a handler-chosen status/headers.
    //
    // The TX-POSTURE branch: a handler ENTRY carrying `routeTx: 'handler-managed'` is
    // invoked DETACHED (no engine transaction; the SAME init builder + brand strip), so it can
    // commit its intake BEFORE an in-request model run and hold no tx across it (the conversational
    // turn route). ABSENT flag (every loader-resolved handler + every other capability entry) keeps
    // the engine-tx path byte-identical. Pinned DB-observably in route-tx-posture.db.test.ts.
    const invoke =
      handler.routeTx === 'handler-managed' ? invokeRouteHandlerDetached : invokeRouteHandler;
    const result = await invoke(
      fn,
      tdb,
      productTables,
      params,
      undefined,
      mintPlayToken,
      enqueue,
      requestBody,
      // the ALLOWLISTED request headers (lowercase-keyed DATA — the conditional-read set +
      // content-negotiation basics; nothing else is forwarded, so credentials can never cross).
      collectHeaders(c),
      // the server-derived caller identity → the handler facade stamps `created_by` un-spoofably.
      createdByActor,
    );
    // a BRANDED enriched return chooses the status + headers; a plain return keeps the
    // existing behavior (HTTP 200 + that value as the JSON body). The brand check is unambiguous — a
    // plain object (even `{ status: 'ok' }`) is NOT mis-read (it lacks the reserved brand key).
    if (isHttpResponse(result)) {
      // A STREAMING (`sseResponse`) envelope drives a `text/event-stream` response: the
      // engine encodes each `SseFrame` to the SSE wire and exposes the live abort signal, BYPASSING
      // c.json entirely. This branch is reached ONLY when the handler chose to stream (the content-
      // negotiation lives in the handler — e.g. the conversational turn route reads `init.headers.
      // accept`); an ABSENT `sse` (every existing httpResponse consumer) falls through to the
      // byte-identical JSON path below. The producer OWNS its terminal/error framing (an SSE 200 is
      // already flushed — the status cannot change mid-stream; the canonical honesty note); if it
      // throws unexpectedly the stream tears down and the (independently-persisted) operation still
      // converges on the client's idempotent retry.
      if (result.sse) {
        const produce = result.sse;
        return streamSSE(c, async (stream) => {
          await produce((frame) => stream.writeSSE(frame), {
            get aborted() {
              return stream.aborted;
            },
          });
        });
      }
      const status = clampStatus(result.status);
      // FAIL-CLOSED: a malformed handler header name/value is dropped rather than thrown AFTER the
      // handler has already run — its writes are already committed on either tx posture (the engine
      // tx in the default arm, the handler's own short txs when handler-managed) — symmetry with
      // the status clamp.
      const headers = sanitizeHeaders(result.headers ?? {});
      // a null-body status (204/205/304) cannot carry a JSON body — `c.json(null, 304)` would
      // serialize "null" and make the Response constructor THROW post-commit. Emit a bodyless response
      // (any handler-attached body is dropped fail-closed; the ETag/cache headers still apply).
      if (NULL_BODY_STATUSES.has(status)) {
        return c.body(null, status as never, headers);
      }
      // c.json sets Content-Type: application/json; extra handler headers are merged on top.
      return c.json((result.body ?? null) as never, status as never, headers);
    }
    return c.json((result ?? null) as never);
  };
}
