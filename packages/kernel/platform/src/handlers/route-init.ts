/**
 * Route + trigger handler invocation (the transaction boundary).
 *
 * A ROUTE/TRIGGER handler — UNLIKE a tool handler — runs INSIDE a `TenantDb.transaction()` (the
 * `app.current_tenant` GUC seam, external-exposure-ready), because it is a single coarse unit of work,
 * not one of several parallel tool calls under the dispatch Semaphore. So these builders:
 *   1. open `tdb.transaction(...)` (populating the GUC),
 *   2. build the `HandlerInit` whose `HandlerDb` is bound to the TRANSACTIONAL TenantDb (so every DB
 *      touch the handler makes is in that one tenant-scoped tx — read+write atomic), and
 *   3. invoke the handler through the SINGLE `HandlerRuntime` indirection (the swappable isolate seam).
 *
 * The route handler's return value is the response body (the api interpreter serializes it as JSON).
 * The trigger handler returns void (parse/register-only — this is the contract the durable worker uses;
 * a synchronous past-bound trigger fire is fail-closed-rejected at the api/worker edge, not here).
 *
 * TRUSTED-AUTHOR: as everywhere in this model, the in-process handler can still reach ambient Node
 * globals; the transaction/GUC scoping is the DB-capability seam, real confinement is the external-exposure isolate.
 */
import type { TenantDb } from '@rayspec/db';
import {
  type BlobStoreFactory,
  type EmitEvent,
  type EnqueueAgentRun,
  type FsSourceFactory,
  type HandlerPrincipal,
  HTTP_RESPONSE_BRAND,
  type RouteHandler,
  type RouteHandlerInit,
  type StreamRouteHandler,
  type StreamRouteHandlerInit,
  type SttCapability,
  type TriggerHandler,
  type TriggerHandlerInit,
  type TtsCapability,
} from '@rayspec/handler-sdk';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { TenantEventBus } from './event-bus.js';
import { getHandlerRuntime } from './handler-runtime.js';
import { makeHandlerDb } from './store-facade.js';

/**
 * TRUST BOUNDARY — strip the RESERVED response-envelope brand key from the
 * UNTRUSTED request body before it is injected as `init.body`. The `{handler}` response discriminator
 * (`isHttpResponse`) keys on `HTTP_RESPONSE_BRAND`; without this strip, a caller POSTing
 * `{"__rayspecHttpResponse":true,"status":302,...}` to a trusted-author handler that simply echoes
 * `init.body` (a natural passthrough/CRUD/debug route) would let the CALLER control the response
 * status/headers/body. Removing the brand key at the injection boundary closes that surface entirely:
 * untrusted request data can NEVER carry the sentinel into the discriminator. Only a top-level brand
 * key matters (the discriminator inspects only the top level of the handler's RETURN), so a top-level
 * delete on a plain object is sufficient; non-object bodies (string/number/array/null) cannot carry an
 * own brand property and pass through untouched. Defense-in-depth — bounded by the trusted-author
 * posture, but the strip removes the surface, not just the likelihood.
 */
function stripResponseBrand(body: unknown): unknown {
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    if (Object.hasOwn(body, HTTP_RESPONSE_BRAND)) {
      const { [HTTP_RESPONSE_BRAND]: _stripped, ...rest } = body as Record<string, unknown>;
      return rest;
    }
  }
  return body;
}

/**
 * Invoke a declared ROUTE handler inside a tenant transaction. `params` are the route's path/query
 * params (DATA — server-parsed strings, never a tenant signal; the tenant is server-derived). Returns
 * the handler's response body.
 *
 * An OPTIONAL `blobFactory` adds `init.blob` — the tenant-bound blob capability, built
 * per run via `blobFactory(txTdb.tenantId)` so the handle is bound to the run's SERVER-DERIVED tenant
 * (NOT a handler-supplied value). Omitted ⇒ `init.blob` is absent (the existing `{handler}` route
 * callers pass nothing → unchanged behavior). The `stream` route interpreter is the real
 * consumer of the slot.
 */
export async function invokeRouteHandler(
  fn: RouteHandler,
  tdb: TenantDb,
  productTables: ReadonlyMap<string, PgTable>,
  params: Readonly<Record<string, string>>,
  blobFactory?: BlobStoreFactory,
  // An OPTIONAL play-token mint capability (built by the api interpreter from the engine's
  // media signer + the run's server-derived tenant + the authed user). Spread onto the init when
  // present; a mint handler reads it. A CLOSURE (the external-exposure-isolate caveat — documented on the SDK type).
  mintPlayToken?: (args: { resource: string; ttlSeconds: number }) => Promise<string>,
  // An OPTIONAL tenant-bound durable agent-run enqueue capability (built by the api
  // interpreter from the engine's durable executor + the run's SERVER-DERIVED tenant). Spread onto the
  // init when present; a finalize/trigger handler reads it to enqueue an off-request run. A CLOSURE
  // (the SAME external-exposure-isolate caveat as mintPlayToken — documented on the SDK type). The tenant is
  // engine-captured (the api interpreter binds it), NEVER handler-supplied — so a pack cannot enqueue
  // cross-tenant. Absent ⇒ init.enqueue is omitted (no durable worker wired; the handler fail-closes).
  enqueue?: EnqueueAgentRun,
  // An OPTIONAL parsed JSON request body (DATA — the api interpreter parsed `c.req.json()`
  // for a body-bearing method). Spread onto the init when present so a `{handler}` route can read the
  // request body. `undefined` (a GET, or a parse failure) ⇒ init.body is ABSENT, keeping the init shape
  // exact (the existing GET `{handler}` routes pass nothing → unchanged). TRUST BOUNDARY: it is UNTRUSTED CALLER
  // DATA the trusted-author handler treats as a plain value (no model call here → no prompt-frame concern).
  body?: unknown,
  // OPTIONAL request headers (DATA — lowercase-keyed strings the api interpreter collected).
  // Spread onto the init when present so a conditional-read handler (the views runtime's If-None-Match
  // → 304) can see them. `undefined` ⇒ init.headers is ABSENT (every existing caller passes nothing →
  // unchanged). TRUST BOUNDARY: header values are UNTRUSTED CALLER DATA; the tenant stays server-derived.
  headers?: Readonly<Record<string, string>>,
  // OPTIONAL server-derived caller identity (`user:<userId>` / `key:<apiKeyId>`), threaded so the
  // handler's store facade stamps `created_by` un-spoofably on inserts. Absent ⇒ no stamp.
  createdByActor?: string,
  // An OPTIONAL READ-ONLY, path-jailed fs-source factory. When wired, adds `init.fsSource` (built via
  // `fsSourceFactory()` — no tenant arg; a shared, deployment-static read root). Absent ⇒ init.fsSource
  // is omitted (no source root configured; a handler that needs it fail-closes loudly on `undefined`).
  fsSourceFactory?: FsSourceFactory,
  // The OPTIONAL authenticated caller as plain values (kind/id/role), resolved by the api
  // interpreter from the SAME request principal `createdByActor` derives from — so `init.principal`
  // and the `created_by` stamp can never drift. DATA — never a tenant signal (the tenant stays
  // server-derived). Absent ⇒ init.principal is omitted (an older caller / no authenticated principal).
  principal?: HandlerPrincipal,
  // An OPTIONAL speech-to-text capability (the provider adapter the composition root built from
  // `STT_PROVIDER`, wrapped so it takes the handler's BYTES). Spread onto the init when present so a
  // `{handler}` route can transcribe an upload. Absent ⇒ init.stt is omitted (no provider configured;
  // the handler fail-closes). NOT tenant-bound — it transcribes the bytes it is handed.
  stt?: SttCapability,
  // An OPTIONAL text-to-speech capability (the provider adapter the composition root built from
  // `TTS_PROVIDER`). Spread onto the init when present so a `{handler}` route can synthesize a reply.
  // Absent ⇒ init.tts is omitted (no provider configured; the handler fail-closes). NOT tenant-bound
  // — it speaks the text it is handed.
  tts?: TtsCapability,
  // An OPTIONAL tenant event bus (present iff the deployment enabled it). Bound HERE to the
  // TRANSACTIONAL handle, so `init.emit` is tenant-bound by construction and its flush lands inside
  // THIS request's transaction. Absent ⇒ init.emit is omitted (the handler fail-closes loudly).
  eventBus?: TenantEventBus,
): Promise<unknown> {
  return tdb.transaction(async (txTdb) => {
    // The request-local emit buffer, bound to the TRANSACTIONAL handle. Built before the handler runs
    // so the capability exists for the whole invocation; flushed after it returns (below).
    const bus = eventBus?.buffered(txTdb);
    const init = buildRouteHandlerInit(
      txTdb,
      productTables,
      params,
      blobFactory,
      mintPlayToken,
      enqueue,
      body,
      headers,
      createdByActor,
      fsSourceFactory,
      principal,
      stt,
      tts,
      bus?.emit,
    );
    const result = await getHandlerRuntime().invokeRoute(fn, init);
    // THE LAST STATEMENT BEFORE COMMIT. It runs only on the success path — a handler that threw
    // takes the whole transaction down with it, so its buffered events are never written (and the
    // sequence numbers they would have taken are never issued). Await it INSIDE the transaction
    // callback: the events must be part of this commit, not a write that races it.
    await bus?.flush();
    return result;
  });
}

/**
 * The ONE `RouteHandlerInit` builder BOTH route postures share — extracted verbatim from
 * `invokeRouteHandler`'s tx callback so the detached posture can never drift from the engine-tx
 * posture on a trust-boundary guard (the response-brand strip) or the spread-ABSENT init-shape semantics.
 * `boundTdb` is the handle the init is bound to: the TRANSACTIONAL TenantDb on the default path,
 * the BASE TenantDb on the detached path.
 */
function buildRouteHandlerInit(
  boundTdb: TenantDb,
  productTables: ReadonlyMap<string, PgTable>,
  params: Readonly<Record<string, string>>,
  blobFactory?: BlobStoreFactory,
  mintPlayToken?: (args: { resource: string; ttlSeconds: number }) => Promise<string>,
  enqueue?: EnqueueAgentRun,
  body?: unknown,
  headers?: Readonly<Record<string, string>>,
  // The server-derived caller identity (`user:<userId>` / `key:<apiKeyId>`) of this request, threaded so
  // the handler's store facade stamps `created_by` un-spoofably on inserts (both route postures share
  // this builder, so both stamp identically). Absent ⇒ no stamp (byte-identical to before).
  createdByActor?: string,
  // The READ-ONLY, path-jailed fs-source factory (shared deployment-static root). Absent ⇒ init.fsSource omitted.
  fsSourceFactory?: FsSourceFactory,
  // The authenticated caller as plain values, derived from the SAME request principal as
  // `createdByActor` (both route postures share this builder, so both inject identically). Absent ⇒
  // init.principal is omitted (byte-identical to before).
  principal?: HandlerPrincipal,
  // The composition-root speech-to-text capability (no tenant arg — it transcribes the bytes the
  // handler hands it). Absent ⇒ init.stt omitted (no STT provider configured).
  stt?: SttCapability,
  // The composition-root text-to-speech capability (no tenant arg — it speaks the text the handler
  // hands it). Absent ⇒ init.tts omitted (no TTS provider configured).
  tts?: TtsCapability,
  // The tenant-bound event-bus emit, ALREADY built from the bound handle by the caller (which owns
  // the flush that pairs with it). Absent ⇒ init.emit omitted (the bus is not enabled).
  emit?: EmitEvent,
): RouteHandlerInit {
  return {
    tenantId: boundTdb.tenantId,
    db: makeHandlerDb(boundTdb, productTables, createdByActor),
    // The tenant-bound blob handle, built from the run's server-derived tenant. Spread so the
    // field is ABSENT (not `undefined`) when no factory is injected — keeping the init shape exact.
    ...(blobFactory ? { blob: blobFactory(boundTdb.tenantId) } : {}),
    // The READ-ONLY, path-jailed fs-source handle (no tenant arg — a shared deployment-static read root).
    // Spread so ABSENT when no source root is configured — keeping the init shape exact.
    ...(fsSourceFactory ? { fsSource: fsSourceFactory() } : {}),
    // The speech-to-text capability (spread so ABSENT when no STT provider is configured).
    ...(stt ? { stt } : {}),
    // The text-to-speech capability (spread so ABSENT when no TTS provider is configured).
    ...(tts ? { tts } : {}),
    // The tenant-bound event-bus emit (spread so ABSENT when the bus is not enabled).
    ...(emit ? { emit } : {}),
    // The play-token mint capability (spread so ABSENT when no media key is wired).
    ...(mintPlayToken ? { mintPlayToken } : {}),
    // The tenant-bound durable-enqueue capability (spread so ABSENT when no worker is wired).
    ...(enqueue ? { enqueue } : {}),
    // The parsed request body (spread so ABSENT when none — a GET / parse-fail). The check
    // is `!== undefined` (not truthiness) so a body of `0`/`false`/`''`/`null` is still injected. TRUST
    // BOUNDARY: the RESERVED response-envelope brand key is STRIPPED here so untrusted caller input
    // can never forge a status/header/body envelope through a handler that echoes init.body.
    ...(body !== undefined ? { body: stripResponseBrand(body) } : {}),
    // The request headers (spread so ABSENT when the interpreter did not collect them).
    ...(headers !== undefined ? { headers } : {}),
    // The authenticated caller (spread so ABSENT when no principal was resolved — an older caller /
    // an invocation context with no authenticated principal; never fabricated). DATA — never a
    // tenant signal (the tenant stays server-derived).
    ...(principal ? { principal } : {}),
    params,
  };
}

/**
 * Invoke a declared ROUTE handler WITHOUT the engine-opened route transaction (the
 * `routeTx: 'handler-managed'` posture a handler ENTRY opts into; see `ResolvedHandler`).
 *
 * WHY THIS EXISTS (the intake-ordering law): a conversational turn route must (1) COMMIT its
 * intake before a model runs, (2) hold NO transaction across the in-request `runAgent` (which
 * journals/persists incrementally on its own connection — run-core.ts documents that the sync HTTP
 * path runs OUTSIDE any transaction; the `{agent}` route arm has the same deliberate posture), and
 * (3) persist the reply in its OWN short write. A single engine-held tx around the whole handler
 * makes all three impossible — so this variant builds the SAME init (one shared builder above,
 * trust-boundary brand strip included) over the BASE TenantDb and lets the handler manage its own short
 * transactions via `init.db.transaction(...)` (each a REAL top-level tx — the store facade's
 * existing tool-handler posture, applied to a route handler).
 *
 * ⚠ RLS-READINESS (honest): statements a handler issues OUTSIDE an explicit `db.transaction(...)`
 * do not populate the `app.current_tenant` GUC (only `TenantDb.transaction` sets it). That is the
 * SAME class as the existing sync run surface (`executeAgentRun` runs `runAgent` on a base
 * TenantDb); the tenant predicate stays STRUCTURAL either way. A handler on this posture should do
 * its writes inside explicit transactions — the conversation binding does.
 */
export async function invokeRouteHandlerDetached(
  fn: RouteHandler,
  tdb: TenantDb,
  productTables: ReadonlyMap<string, PgTable>,
  params: Readonly<Record<string, string>>,
  blobFactory?: BlobStoreFactory,
  mintPlayToken?: (args: { resource: string; ttlSeconds: number }) => Promise<string>,
  enqueue?: EnqueueAgentRun,
  body?: unknown,
  headers?: Readonly<Record<string, string>>,
  // OPTIONAL server-derived caller identity — see invokeRouteHandler. Threaded identically so the
  // handler-managed posture stamps `created_by` the same way the engine-tx posture does.
  createdByActor?: string,
  // OPTIONAL READ-ONLY fs-source factory — see invokeRouteHandler. Threaded identically so the
  // handler-managed posture receives `init.fsSource` the same way the engine-tx posture does.
  fsSourceFactory?: FsSourceFactory,
  // OPTIONAL authenticated caller — see invokeRouteHandler. Threaded identically so the
  // handler-managed posture receives `init.principal` the same way the engine-tx posture does.
  principal?: HandlerPrincipal,
  // OPTIONAL speech-to-text capability — see invokeRouteHandler. Threaded identically so the
  // handler-managed posture receives `init.stt` the same way the engine-tx posture does.
  stt?: SttCapability,
  // OPTIONAL text-to-speech capability — see invokeRouteHandler. Threaded identically so the
  // handler-managed posture receives `init.tts` the same way the engine-tx posture does.
  tts?: TtsCapability,
  // OPTIONAL tenant event bus — see invokeRouteHandler. Threaded identically so this posture also
  // receives `init.emit`, with the ONE honest difference stated below.
  eventBus?: TenantEventBus,
): Promise<unknown> {
  // Same buffer, bound to the BASE handle: this posture holds no engine transaction (that is its
  // whole reason for existing), so the flush below is its own standalone statement rather than the
  // last statement of an enclosing commit. The events are still ordered and durable; what this
  // posture does NOT get is atomicity with writes the handler committed in its own short
  // transactions — it committed them itself, before the flush ran.
  const bus = eventBus?.buffered(tdb);
  const init = buildRouteHandlerInit(
    tdb,
    productTables,
    params,
    blobFactory,
    mintPlayToken,
    enqueue,
    body,
    headers,
    createdByActor,
    fsSourceFactory,
    principal,
    stt,
    tts,
    bus?.emit,
  );
  const result = await getHandlerRuntime().invokeRoute(fn, init);
  // Only on the success path — a throwing handler's buffered events are never written (the buffer
  // dies with the request), matching the engine-tx posture's outcome.
  await bus?.flush();
  return result;
}

/**
 * Invoke a declared `stream` ROUTE handler (mode:'ingest') inside a tenant transaction. UNLIKE
 * `invokeRouteHandler`, a stream handler reads the RAW Web `Request` (the binary
 * body — the api interpreter passed `c.req.raw`, NEVER `c.req.json()`) and returns a raw Web
 * `Response`; this builder wires the tenant-bound capabilities and returns that `Response` verbatim
 * (the api interpreter hands it straight back to Hono — no JSON envelope).
 *
 * The handler runs INSIDE `tdb.transaction(...)` (the `app.current_tenant` GUC seam) so every
 * `init.db` write (the pointer row) is in ONE tenant-scoped, atomic transaction. `init.blob` is the
 * tenant-bound `BlobStore`, built per request via `blobFactory(txTdb.tenantId)` so the handle is
 * bound to the run's SERVER-DERIVED tenant (never a handler-supplied value) — its keys are
 * tenant-prefixed by construction (the blob does NOT traverse the SQL chokepoint, so that prefix +
 * the path jail are its ENTIRE tenant isolation). The transaction COMMITS iff the handler returns
 * (resolves); a thrown handler rolls the pointer-row write back (the blob put-by-index is idempotent,
 * so a retry re-puts the same bytes safely — the pointer UNIQUE is the idempotency authority).
 *
 * The `blobFactory` is REQUIRED here (a stream handler exists to move bytes): the api interpreter
 * fail-closes the BOOT if a `stream` route is declared without a blob backend wired, so by the time
 * this is called `blobFactory` is always present — it is a required param, not optional like
 * `invokeRouteHandler`'s.
 *
 * ⚠ EXTERNAL-EXPOSURE ISOLATE-READINESS (honest — the SAME caveat class as `HandlerDb.transaction`'s closure):
 * the rest of the handler model is SERIALIZABLE-shaped (name-keyed db calls + plain rows + opaque
 * blob keys) so an in-process call becomes a cross-isolate call under the isolate seam with no handler change. The
 * raw Web `Request`/`Response` a STREAM handler exchanges, however, is NOT trivially serializable
 * across an isolate boundary (a `Request`/`Response` carries a live body stream + header object, not
 * a plain value). So — like `HandlerDb.transaction`'s closure — the cross-isolate STREAM model is an
 * isolate DESIGN POINT (an explicit byte-channel + a header/status envelope protocol), NOT something this
 * seam already solves. For exactly that reason a stream handler is invoked DIRECTLY here, NOT through
 * the `HandlerRuntime` indirection (whose `invokeRoute`/`invokeTool`/`invokeTrigger` are the
 * serializable-shaped surfaces the isolate marshals): adding an `invokeStream(Request)→Response`
 * to that interface would falsely imply the raw-Request/Response path is already isolate-ready. The
 * in-process call is correct + GUC-populated; do NOT claim the stream path is isolate-ready.
 */
export async function invokeStreamRouteHandler(
  fn: StreamRouteHandler,
  tdb: TenantDb,
  productTables: ReadonlyMap<string, PgTable>,
  params: Readonly<Record<string, string>>,
  request: Request,
  blobFactory: BlobStoreFactory,
  // Playback: the OPAQUE resource the verified media token authorized (absent on ingest).
  // The api interpreter passes the value the media-JWT verifier stashed on the request context; the
  // handler binds it to the requested route resource + re-validates ownership in the DB (it is never
  // trusted alone). `undefined` ⇒ no media token (the ingest path) — the field is then absent on init.
  mediaResource?: string,
  // OPTIONAL server-derived caller identity (`user:<userId>` / `key:<apiKeyId>`), threaded IDENTICALLY
  // to the JSON `{handler}` route path (invokeRouteHandler) so a stream handler's store facade stamps
  // `created_by` un-spoofably on its inserts (the ingest pointer row). Built by the api interpreter from
  // the request's SERVER-DERIVED principal — never handler-supplied. Absent ⇒ no stamp (byte-identical to
  // before): a posture with no request principal (the media-JWT playback path) passes nothing here.
  createdByActor?: string,
  // The OPTIONAL authenticated caller as plain values (kind/id/role), threaded IDENTICALLY to the
  // JSON `{handler}` route path and derived from the SAME request principal as `createdByActor` — so
  // `init.principal` and the `created_by` stamp can never drift. Absent ⇒ init.principal is omitted
  // (the media-JWT playback posture passes nothing here — no request principal, never fabricated).
  principal?: HandlerPrincipal,
): Promise<Response> {
  return tdb.transaction(async (txTdb) => {
    const init: StreamRouteHandlerInit = {
      tenantId: txTdb.tenantId,
      db: makeHandlerDb(txTdb, productTables, createdByActor),
      // The tenant-bound blob handle, built from the run's server-derived tenant (REQUIRED — a stream
      // handler moves bytes; the deploy fail-closes if no backend is wired, so this is never absent).
      blob: blobFactory(txTdb.tenantId),
      params,
      // The RAW Web Request — the binary body is UNTRUSTED DATA the handler treats as bytes.
      request,
      // Spread so the field is ABSENT (not `undefined`) on the ingest path, keeping the init shape exact.
      ...(mediaResource !== undefined ? { mediaResource } : {}),
      // The authenticated caller (spread so ABSENT when no principal was resolved — the playback
      // posture; never fabricated). DATA — never a tenant signal (the tenant stays server-derived).
      ...(principal ? { principal } : {}),
    };
    return fn(init);
  });
}

/**
 * Invoke a declared TRIGGER handler inside a tenant transaction (the contract the durable worker
 * uses; not fired synchronously today). `triggerName` is the declared trigger's name (DATA).
 *
 * The three DEPLOYMENT-STATIC capabilities a `handler`-kind route init carries — `fsSource`, `stt`,
 * `tts` — are threaded here on the SAME terms: none of them is request-derived (the fs-source root is
 * a shared read root, the speech handles take the bytes/text the handler holds), so a handler that
 * works over HTTP does the same work when a trigger fires it. Each is spread-when-wired, so a
 * deployment that configured none builds the byte-identical init this took before. Nothing ELSE is
 * threaded here and this seam is unchanged for the rest: `mintPlayToken`, `enqueue` and `emit` are
 * assembled PER REQUEST by the api interpreter (the mint from the authed caller, the emit as a buffer
 * against the route transaction it flushes into), and `blob` is the byte-moving handle a `stream`-kind
 * route and a tool get — `invokeRouteHandler` never carries it either.
 */
export async function invokeTriggerHandler(
  fn: TriggerHandler,
  tdb: TenantDb,
  productTables: ReadonlyMap<string, PgTable>,
  triggerName: string,
  // An OPTIONAL READ-ONLY, path-jailed fs-source factory — see invokeRouteHandler. Threaded
  // identically so a trigger fire receives `init.fsSource` the same way a route request does.
  fsSourceFactory?: FsSourceFactory,
  // An OPTIONAL speech-to-text capability — see invokeRouteHandler. Threaded identically so a
  // trigger fire receives `init.stt` the same way a route request does.
  stt?: SttCapability,
  // An OPTIONAL text-to-speech capability — see invokeRouteHandler. Threaded identically so a
  // trigger fire receives `init.tts` the same way a route request does.
  tts?: TtsCapability,
): Promise<void> {
  await tdb.transaction(async (txTdb) => {
    const init: TriggerHandlerInit = {
      tenantId: txTdb.tenantId,
      db: makeHandlerDb(txTdb, productTables),
      // The READ-ONLY, path-jailed fs-source handle (no tenant arg — a shared deployment-static read root).
      // Spread so ABSENT when no source root is configured — keeping the init shape exact.
      ...(fsSourceFactory ? { fsSource: fsSourceFactory() } : {}),
      // The speech-to-text capability (spread so ABSENT when no STT provider is configured).
      ...(stt ? { stt } : {}),
      // The text-to-speech capability (spread so ABSENT when no TTS provider is configured).
      ...(tts ? { tts } : {}),
      triggerName,
    };
    await getHandlerRuntime().invokeTrigger(fn, init);
  });
}
