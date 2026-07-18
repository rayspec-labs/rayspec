/**
 * @rayspec/handler-sdk — the ONLY package an escape-hatch handler may import.
 *
 * This is the public, TYPE-ONLY contract for a trusted-author escape-hatch handler (the escape-hatch
 * layer): the `HandlerInit` the engine constructs + injects, and the neutral data shapes a handler
 * returns. An escape-hatch module imports ONLY this — never `@rayspec/{platform,db,core,api-auth}`
 * internals or any agent SDK type. The `gate:handler-imports` CI tripwire enforces that boundary.
 *
 * WHY TYPE-ONLY: a handler receives its capabilities by INJECTION (the engine builds the concrete
 * `HandlerInit` per run and passes it in). The handler never CONSTRUCTS a capability, so the SDK
 * ships no runtime — only the shapes the handler declares against. This keeps the package a pure
 * contract and makes the external-exposure isolate seam trivial: the init is a SERIALIZABLE-shaped
 * value (name-keyed store access + plain rows), so the in-process call can become a cross-isolate
 * call WITHOUT changing a single handler or spec.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * TRUSTED-AUTHOR, NOT SANDBOXED (binding posture).
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A handler runs IN OUR PROCESS. The capability scoping below (a tenant-bound store facade,
 * no raw DB, no platform internals) is a DECLARATION + INJECTION SEAM — it is **cosmetic as
 * ENFORCEMENT**: a handler can still reach `fs` / `fetch` / `process.env` via Node globals
 * regardless of what `HandlerInit` exposes, because nothing isolates it. Real enforcement (a
 * per-tenant isolate/worker that the handler cannot escape) is the external-exposure hardening's
 * second `HandlerRuntime` implementation. Therefore handlers are TRUSTED-AUTHOR ONLY, and
 * external-exposure hardening is an ABSOLUTE gate: no untrusted/customer-authored handler runs
 * on shared infra until the isolate exists.
 */

// Pure text utilities re-exported from @rayspec/core. These are stateless,
// dependency-free functions (UAX-29 word tokenization + a token-run subset check) — NOT a capability,
// platform internal, or runtime state — so re-exporting them keeps handler-sdk a thin, serializable-
// seam SDK. A pack handler is confined to @rayspec/handler-sdk by the `gate:handler-imports` tripwire,
// so this conduit is how it CONSUMES the harvested tokenizer instead of keeping its own copy.
// The shared bounded body reader — re-exported from @rayspec/core on the same conduit as the
// tokenizer (a stateless, dependency-free byte primitive; not a capability or platform internal). A
// capability binding (e.g. audio ingest) uses it to cap the bytes it buffers from the raw request
// instead of an unbounded `request.arrayBuffer()`.
export {
  type BoundedBodyOptions,
  type BoundedBodyOutcome,
  type BoundedBodySource,
  drainBounded,
  readBoundedBody,
  tokenRunSubset,
  uax29Tokens,
} from '@rayspec/core';

// The neutral, tenant-bound BlobStore capability contract — the OTHER injected handle a
// handler may receive (opaque-key binary storage; interface only, impl injected at the composition
// root). Re-exported here so a handler imports every capability shape from the one SDK package.
export type {
  BlobNotFound,
  BlobPutOpts,
  BlobRangeOpts,
  BlobReadResult,
  BlobStat,
  BlobStore,
  BlobStoreFactory,
} from './blob.js';

import type { BlobStore } from './blob.js';

// The neutral, READ-ONLY, path-jailed `FsSource` capability contract — the injected handle a handler
// may receive to LIST/READ/SEARCH deployment-static local files under a jailed root (interface only,
// impl injected at the composition root). Re-exported here so a handler imports every capability shape
// from the one SDK package.
export type {
  FsSource,
  FsSourceEntry,
  FsSourceFactory,
  FsSourceMatch,
  FsSourceNotFound,
  FsSourceReadOptions,
  FsSourceReadResult,
  FsSourceSearchOptions,
} from './fs-source.js';

import type { FsSource } from './fs-source.js';

// ---------------------------------------------------------------------------------------
// The store capability facade — a SERIALIZABLE-shaped, NAME-keyed, tenant-bound DB surface.
// ---------------------------------------------------------------------------------------

/**
 * A single product-store row as a handler sees it: a plain, serializable record. The injected `id`
 * (uuid) PK + the tenancy/GDPR columns (`tenant_id`, `created_at`, …) are present on a read; a
 * handler treats every value as DATA. (No Drizzle/PgTable type ever crosses into a handler — that
 * is what keeps the init serializable-shaped for the isolate seam.)
 */
export type StoreRow = Record<string, unknown>;

/**
 * A row filter — an equality map over column names (snake_case, as declared in the spec). `{}` (or
 * omitted) matches all rows in the tenant. Each entry AND-combines; the engine resolves the column
 * names against the declared store + delegates to the real `TenantDb` chokepoint, so the tenant
 * predicate is ALWAYS auto-injected (a handler can never read/write across tenants, and can never
 * touch an auth/core table — only a DECLARED product store, by name).
 *
 * SERIALIZABLE BY DESIGN: a filter is a plain JSON object (no live query builder), so a `HandlerDb`
 * call is a serializable request the isolate can marshal across a boundary unchanged.
 */
export type StoreFilter = Record<string, unknown>;

/**
 * Read-shaping options for `select` (list/aggregation handlers stop hand-rolling N+1 + in-memory
 * sort/slice). ALL fields are PLAIN SERIALIZABLE values (column NAMES + numbers + an `'asc'|'desc'`
 * literal) — NO closures, NO live query builder — so a `select(store, filter, opts)` call stays the
 * SAME marshallable request the external-exposure isolate can ship across a boundary unchanged (the isolate-safe
 * shape, exactly like `StoreFilter`).
 *
 * Each `orderBy.column` is resolved fail-closed against the store's declared columns (an unknown column
 * THROWS, never a silent drop). `limit`/`offset` are passed to the DB (server-side paging). The
 * structural tenant predicate is AND-combined by `TenantDb` BENEATH this — ordering/limit/offset can
 * NEVER drop the tenant scope (a 2nd tenant's rows are structurally invisible regardless of opts).
 */
export interface SelectOptions {
  /** Order the result by these columns, in order (each a declared column; default direction `asc`). */
  readonly orderBy?: ReadonlyArray<{ readonly column: string; readonly dir?: 'asc' | 'desc' }>;
  /** Max rows to return (server-side LIMIT). */
  readonly limit?: number;
  /** Rows to skip (server-side OFFSET) — pair with `orderBy` for stable paging. */
  readonly offset?: number;
}

/**
 * Options for `upsert` — ALL fields PLAIN SERIALIZABLE values (column NAMES → equality values), so an
 * `upsert(store, cols, values, opts)` call stays the SAME marshallable request the external-exposure
 * isolate can ship across a boundary unchanged (the isolate-safe shape, like `StoreFilter`/`SelectOptions`).
 */
export interface UpsertOptions {
  /**
   * A CONDITIONAL-UPDATE guard on the `ON CONFLICT … DO UPDATE` arm: an equality map the CONFLICTING
   * row must ALSO match for the update to apply, AND-combined BENEATH the structural tenant scope.
   * When set, a conflict on the named `conflictColumns` target whose row does NOT match this guard
   * updates ZERO rows and the upsert returns **`undefined`** (a fail-closed no-op — the same empty
   * result a foreign-tenant conflict yields), leaving the conflicting row UNTOUCHED. This lets a caller
   * express "insert, OR overwrite ONLY a row still in the expected state" atomically in one statement —
   * the sanctioned STRUCTURAL close for a first-write TOCTOU (never an in-tx 23505 catch-and-recover,
   * which poisons the transaction). Each key is resolved fail-closed to a real column and each value
   * runs the SAME data-value guard a filter does. Absent ⇒ the conflict DO-UPDATE is scoped by the
   * tenant predicate ALONE (byte-behaviorally identical to the pre-`updateWhere` upsert). Meaningful
   * ONLY on the DO-UPDATE arm: an ensure-exists upsert (values ⊆ conflictColumns → DO NOTHING) never
   * overwrites regardless, so the guard is trivially satisfied there.
   */
  readonly updateWhere?: StoreFilter;
}

/**
 * The tenant-bound DB capability a tool/route/trigger handler receives via `HandlerInit.db`
 * (the handler does NOT receive a raw `TenantDb`; the engine builds this name-keyed
 * facade over `forTenant(db, tenantId)` + the deployment's declared product tables and injects it).
 *
 * Every method:
 *  - references a store by its DECLARED NAME (string) — never a PgTable/Drizzle handle;
 *  - is tenant-scoped STRUCTURALLY (the facade delegates to the real `TenantDb`, which auto-injects
 *    `eq(tenant_id, …)` and auto-stamps it on insert);
 *  - fail-closes on an UNDECLARED store name (a handler can only reach stores the spec declared);
 *  - exchanges only plain serializable rows / filters (the isolate-ready shape).
 *
 * TRANSACTION BOUNDARY (the asymmetry is intentional, stated here AND in code):
 *  - a TOOL handler gets NO implicit outer transaction (an agent fires several tools in parallel
 *    under the dispatch Semaphore; wrapping the loop would hold a DB tx open across model latency).
 *    A tool needing atomicity opens one EXPLICITLY via `db.transaction(...)`.
 *  - a ROUTE/TRIGGER handler runs INSIDE a `TenantDb.transaction()` the engine already opened (the
 *    `app.current_tenant` GUC seam); `db.transaction(...)` there nests onto the same tenant.
 */
export interface HandlerDb {
  /**
   * List/select rows from a declared store matching `filter` (tenant-scoped; `{}`/omitted = all).
   *
   * FILTER: an equality map; a value that is an ARRAY becomes a batched set-membership filter
   * (`IN (…)`) on a NON-jsonb column — so a list handler reads N rows in ONE query instead of N
   * round-trips. (On a `jsonb` column an array value is the VALUE ITSELF → matched by equality, never
   * `IN`.) Each array element still passes the same data-value guard a scalar does (an injection vector
   * is rejected fail-closed).
   *
   * OPTS: optional `orderBy`/`limit`/`offset` (see `SelectOptions`) for server-side ordering +
   * paging. The tenant predicate is structural BENEATH this; opts can never widen it.
   */
  select(store: string, filter?: StoreFilter, opts?: SelectOptions): Promise<StoreRow[]>;
  /**
   * OPTIONAL, ADDITIVE: count the rows matching `filter` (tenant-scoped) WITHOUT
   * loading them — one `SELECT count(*)` through the same fail-closed store/column resolution and
   * the same structural tenant predicate as `select`. Lets a paged reader (e.g. the declarative
   * views runtime's list totals) use a bounded `select(…, { limit, offset })` + `count` instead of
   * loading a tenant's entire match set into memory.
   *
   * OPTIONAL because it is additive: the engine-built facade provides it, but an older or
   * alternative `HandlerDb` provider may not — a consumer feature-detects
   * (`typeof db.count === 'function'`) and falls back to a full read. Serializable-shaped like
   * `select` (a store name + a plain equality filter → a number), so the isolate seam is
   * unchanged.
   */
  count?(store: string, filter?: StoreFilter): Promise<number>;
  /** Insert one row into a declared store (tenant_id auto-stamped); returns the inserted row. */
  insert(store: string, values: StoreRow): Promise<StoreRow>;
  /**
   * ATOMIC upsert — one `INSERT … ON CONFLICT (conflictColumns) DO UPDATE` that replaces the
   * race-prone hand-rolled select-else-insert-else-catch-23505 idiom with a SINGLE statement. Inserts
   * `values` (tenant_id auto-stamped); on a unique-constraint conflict over `conflictColumns` it UPDATES
   * the conflicting row with `values` (minus the conflict columns) INSTEAD of erroring.
   *
   * STRUCTURALLY TENANT-SAFE (the load-bearing guarantee): the DO-UPDATE is scoped to THIS tenant
   * (`setWhere tenant_id = <run tenant>`). So even if `conflictColumns` is a GLOBAL (non-tenant-scoped)
   * unique, a conflict on ANOTHER tenant's row updates ZERO rows — the upsert NEVER overwrites a foreign
   * tenant's data. `conflictColumns` + every value column are resolved fail-closed against the declared
   * store (an unknown column throws); `values` runs the same server-controlled-column / SF-1 injection
   * guard `insert` does.
   *
   * RETURN (`StoreRow | undefined`) — the guarantee below is SCOPED to a conflict on the NAMED
   * `conflictColumns` target: the written row (the inserted OR same-tenant-updated row) on success;
   * **`undefined`** when the conflict on the NAMED target landed on a DIFFERENT tenant's row — the
   * tenant-scoped DO-UPDATE matched nothing, so nothing was written (the correct FAIL-CLOSED no-op).
   * `undefined` is ALSO returned for an ENSURE-EXISTS upsert whose `values` are a SUBSET of
   * `conflictColumns` (the DO-UPDATE SET would be empty, so the engine uses `DO NOTHING`): a conflict on
   * the named target no-ops → `undefined`; no conflict inserts → the row. It is `undefined`, NOT a throw:
   * a throw would both be wrong (the conflict is legitimate, not an error) and leak more about the other
   * tenant than the empty result does. (Inferring "this key is held elsewhere" from the empty return is
   * inherent to CHOOSING a global-unique conflict target; a pack wanting strict per-tenant key isolation
   * makes its unique tenant-scoped — `tenant_id` + key — so a foreign key never conflicts.)
   *
   * A conflict on a DIFFERENT global unique (NOT the named `conflictColumns` target) raises a
   * unique-violation error — SAME as `insert`. The facade SANITIZES it to a neutral
   * `unique constraint violation` (the raw Postgres constraint name is NEVER relayed — it would be a
   * cross-tenant existence oracle). The `undefined` no-op contract above applies ONLY to a conflict on
   * the named target.
   *
   * OPTS (`updateWhere`, additive): a CONDITIONAL-UPDATE guard on the DO-UPDATE arm — see
   * `UpsertOptions.updateWhere`. When set, a conflict whose row does not match the guard adds a THIRD
   * `undefined` case to the return contract above (a same-tenant conflict that no-ops because the row
   * is no longer in the guarded state). Omitted ⇒ byte-behaviorally identical to the prior upsert.
   */
  upsert(
    store: string,
    conflictColumns: string[],
    values: StoreRow,
    opts?: UpsertOptions,
  ): Promise<StoreRow | undefined>;
  /** Update rows matching `filter` with `patch` (tenant-scoped); returns the updated rows. */
  update(store: string, filter: StoreFilter, patch: StoreRow): Promise<StoreRow[]>;
  /** Delete rows matching `filter` (tenant-scoped); returns the count deleted. */
  delete(store: string, filter: StoreFilter): Promise<number>;
  /**
   * Run `fn` inside a tenant-scoped transaction (populates the `app.current_tenant` GUC, RLS-ready).
   * The callback receives a `HandlerDb` bound to the SAME tenant over the transactional handle.
   *
   * ⚠ ISOLATE-READINESS (honest): the rest of `HandlerDb` is serializable-shaped (name-keyed calls +
   * plain rows/filters), so an in-process call becomes a cross-isolate call under the isolate seam with
   * NO handler change. `transaction(fn)`, however, takes a CLOSURE callback — a closure does NOT
   * trivially cross an isolate boundary (it cannot be serialized). So the CROSS-ISOLATE transaction
   * model is a DESIGN POINT for the isolate (an explicit begin/commit protocol, or running the whole
   * handler in one isolate-side tx), NOT something this seam already solves. The in-process impl is
   * correct + GUC-populated.
   */
  transaction<R>(fn: (tx: HandlerDb) => Promise<R>): Promise<R>;
}

// ---------------------------------------------------------------------------------------
// HandlerInit — the capability-scoped, serializable-shaped init the engine injects.
// ---------------------------------------------------------------------------------------

/**
 * The capabilities common to every handler kind. SERIALIZABLE-SHAPED on purpose (deliverable d):
 * `tenantId` is a string and the `db` facade is name-keyed + plain-row — so the init could be
 * marshalled across an isolate boundary without a single handler change, with the lone exception of
 * `db.transaction` (a closure callback — an isolate design point; see `HandlerDb.transaction`).
 */
export interface HandlerInit {
  /** The run/request's server-derived tenant (org) id. DATA — never a trust signal. */
  readonly tenantId: string;
  /** The tenant-bound, name-keyed store capability (over the real `TenantDb` chokepoint). */
  readonly db: HandlerDb;
  /**
   * The tenant-bound `BlobStore` capability — opaque-key binary storage, bound
   * to THIS run's `tenantId` BY CONSTRUCTION (the handler supplies only a caller key; the engine
   * built the handle pre-bound to the run's tenant). OPTIONAL: it is present only when the deployment
   * injected a blob backend at the composition root (a stores/api-only deployment has none), so a
   * handler that needs it fail-closes loudly on `undefined` rather than the engine forcing a backend
   * onto every deployment. The `stream` route primitive consumes it via `StreamRouteHandlerInit`,
   * where it is REQUIRED. Like `db`, it is a SERIALIZABLE-shaped handle (string keys + bytes/streams),
   * preserving the external-exposure isolate seam.
   */
  readonly blob?: BlobStore;
  /**
   * The READ-ONLY, path-jailed `FsSource` capability — LIST/READ/SEARCH over a
   * DEPLOYER-configured local root (reference material, templates, a static content directory). OPTIONAL:
   * present only when the deployment configured a source root at the composition root (an unset root ⇒
   * absent), so a handler that needs it fail-closes loudly on `undefined` rather than the engine forcing
   * a root onto every deployment (mirrors `blob`). There is NO write surface — read-only is structural
   * (the interface exposes no mutating method). Every path is JAILED strictly under the root (a `..` /
   * absolute / symlink escape is refused fail-closed — never foreign bytes). It is a SERIALIZABLE-shaped
   * handle (string paths + bytes), preserving the external-exposure isolate seam. NOT tenant-partitioned
   * (a shared, deployment-static read root — see `FsSource`).
   */
  readonly fsSource?: FsSource;
}

/**
 * What a TOOL handler receives. Identical to `HandlerInit` today; named distinctly so the contract
 * a tool author writes against is explicit and so a future tool-only capability can be added here
 * WITHOUT widening route/trigger inits.
 *
 * NO implicit outer transaction: a tool that needs atomicity calls `init.db.transaction(...)`.
 *
 * A tool init carries the tenant-bound `init.blob` (inherited from `HandlerInit`)
 * when the deployment wired a blob backend, exactly like a ROUTE/STREAM init. The resolver
 * (`buildNeutralTool`) builds it per run from the SAME composition-root `BlobStoreFactory` the
 * route/stream arms use, bound to the run's SERVER-DERIVED `tenantId` (never a tool/arg-supplied
 * value). So a tool reads/writes blobs through the SANCTIONED, tenant-bound, path-jailed `BlobStore`
 * rather than re-implementing an fs path-jail. As elsewhere, `blob` is OPTIONAL: a stores/api-only
 * deploy wires no backend, so a tool that needs it fail-closes loudly on `undefined`. (This closes
 * the previously-documented gap where a tool init was ONLY `{ tenantId, db }`.)
 *
 * (No `toolCallId` is surfaced: the central `dispatchTool` chokepoint owns the real per-call id as
 * its journal/uniqueness key and — by design — calls the wrapped handler with only `(args)`, so
 * the resolver cannot thread the real id through without changing the UNCHANGED chokepoint. A tool
 * handler needs the args + the tenant-bound db (+ the optional tenant-bound blob), not the dispatch
 * correlation id; we do not fabricate one.)
 */
export type ToolHandlerInit = HandlerInit;

/**
 * The durable-enqueue seam. A TENANT-BOUND capability a ROUTE handler may
 * receive to ENQUEUE a durable, off-request agent run (so a pack's `finalize` route can trigger an
 * off-request long-running job instead of blocking the request). The closure rides
 * the durable engine (the same `runAgentJob` + reserve-before-enqueue + `run_started`
 * started-once guard + the non-idempotent-taint quarantine the HTTP `async:true` path uses) — NO new
 * job type.
 *
 * SECURITY (the external-exposure isolate makes the real guarantee; these are the in-process contract):
 *  - TENANT-BOUND BY CONSTRUCTION: there is NO `tenantId` parameter. The engine captured the run's
 *    SERVER-DERIVED tenant when it built this closure (`init.tenantId`), so a handler can NEVER enqueue
 *    for another tenant — the closure has no path to one.
 *  - REGISTRY-BOUND: `agentId` is resolved against the DEPLOYED agent registry; an undeclared/foreign
 *    agent id fail-closes (a clear error, never a silent/dangling enqueue). A pack can only enqueue an
 *    agent the deployed spec declares.
 *  - FAIL-CLOSED WHEN UNWIRED: this capability is ABSENT (`undefined`) on a deployment with no durable
 *    worker wired — a handler that needs it fail-closes loudly on `undefined` (mirrors `blob`/
 *    `mintPlayToken`), never a silent no-op.
 *
 * IDEMPOTENCY: an OPTIONAL `idempotencyKey` makes the enqueue exactly-once for that key (the SAME
 * Idempotency-Key reserve the HTTP path uses — a re-call with the same key + same `{agentId,input}`
 * returns the PRIOR runId, no second job; a different input under the same key fail-closes 409). An
 * OPTIONAL `runId` lets the caller pin a DETERMINISTIC runId (e.g. derived from a stable ref) so a
 * crash-retry of the trigger reconciles to one run. A pinned runId is TENANT-NAMESPACED server-side (the
 * engine derives it from the SERVER-DERIVED tenant + the pinned value) so it is exactly-once WITHIN the
 * tenant and CANNOT collide cross-tenant — the bare pinned string is NOT the global durable id; two
 * tenants pinning the same value get DISTINCT runs. Returns the durable run's `runId` (the caller polls
 * / streams it via the existing `GET /v1/runs/{id}` and `/events`).
 *
 * ⚠ ISOLATE-READINESS (honest — like `db.transaction` and `mintPlayToken`): `enqueue` is a CLOSURE over
 * the engine's durable executor + tenant binding, so it does NOT trivially cross an external-exposure
 * isolate boundary (a closure cannot be serialized). The cross-isolate enqueue is an isolate design point
 * (an explicit enqueue RPC). The in-process call is correct (the tenant is engine-bound, not
 * handler-supplied); the closure is external-exposure-isolate debt, consistent with the trusted-author posture.
 */
export type EnqueueAgentRun = (req: {
  /** The declared agent to run — resolved against the deployed registry (undeclared → fail-closed). */
  agentId: string;
  /** The agent's run input (the per-run task value). DATA. */
  input: string;
  /** OPTIONAL Idempotency-Key for exactly-once enqueue (a re-call with the same key + input dedupes). */
  idempotencyKey?: string;
  /**
   * OPTIONAL caller-pinned deterministic runId. TENANT-NAMESPACED server-side (derived from the
   * server-derived tenant + this value) → exactly-once WITHIN the tenant, never a cross-tenant collision;
   * the bare string is NOT the global durable id.
   */
  runId?: string;
}) => Promise<{ runId: string }>;

/**
 * The OPT-IN enriched `{handler}` route response envelope.
 *
 * By default a `{handler}` route returns a plain JSON body that maps to HTTP 200 (unchanged — a handler
 * that returns `{ ok: true }` or even `{ status: 'ok' }` still gets 200; a plain object is NEVER
 * mis-read as a status envelope). A handler that needs to CHOOSE the status (e.g. 201/202/404/409) or
 * set response headers returns this BRANDED envelope built via `httpResponse({...})`. The brand is a
 * unique non-data marker key (`__rayspecHttpResponse`) the engine checks with `isHttpResponse`.
 *
 * SAFETY POSTURE (accurate — the brand is honored ONLY on the handler RETURN; caller input cannot
 * shape the response through it):
 *  - The discriminator keys on the reserved brand on the handler's RETURN value. The brand is NOT a
 *    value an author would naturally produce as a plain body, so a legitimate plain return is never
 *    mis-classified as a status envelope (UNAMBIGUOUS, backward-compatible).
 *  - The UNTRUSTED request body (injected as `init.body`) has this reserved brand key STRIPPED at the
 *    injection boundary (the engine's `invokeRouteHandler`). So a caller POSTing
 *    `{"__rayspecHttpResponse":true,...}` cannot make a handler that echoes `init.body` emit a
 *    caller-controlled status/headers/body envelope — the forged brand never reaches the discriminator.
 *  - The engine CLAMPS the chosen `status` to a valid `Response` integer (200–599; 1xx informational
 *    statuses cannot be set on a `Response` so they fall back to 200) and applies handler-chosen
 *    headers FAIL-CLOSED (a malformed header name/value is dropped, never an uncaught post-commit
 *    throw) — so even a deliberate handler return can never produce an invalid `Response`.
 *
 * TRUST BOUNDARY: a route handler does NOT call the model (the body is DATA for trusted-author logic — no
 * prompt-frame-injection concern). Controlling status/headers is no new privilege over controlling the
 * body — handlers are trusted-author-NOT-sandboxed.
 *
 * Exported so the engine's request-body injection boundary strips the SAME key (a single source of
 * truth — never a hardcoded second copy).
 */
export const HTTP_RESPONSE_BRAND = '__rayspecHttpResponse' as const;

/**
 * The branded enriched response envelope. `body` is the JSON body (serialized like a plain return);
 * `status` is the handler-chosen HTTP status (CLAMPED to 100–599 by the engine); `headers` are extra
 * response headers (merged onto the JSON response). Built ONLY via `httpResponse(...)` so the brand is
 * single-sourced.
 */
export interface HttpResponse<T = unknown> {
  /** The brand marker — a literal `true` under a reserved key. Present ONLY on `httpResponse(...)`. */
  readonly [HTTP_RESPONSE_BRAND]: true;
  /** The HTTP status code the handler chose (engine clamps to 100–599; defaults to 200). */
  readonly status?: number;
  /** Extra response headers to merge onto the JSON response (e.g. Location, Cache-Control). */
  readonly headers?: Readonly<Record<string, string>>;
  /** The JSON response body (serialized exactly like a plain handler return). */
  readonly body?: T;
  /**
   * The OPTIONAL Server-Sent Events producer. When PRESENT, the engine responds with a
   * `text/event-stream` stream by DRIVING this producer, instead of serializing `body` as JSON
   * (`status`/`body` are then ignored — an SSE response is a 200 stream whose terminal frame carries
   * the outcome; see the conversational turn route). ABSENT ⇒ the envelope is the plain-value JSON
   * envelope above, byte-identical to the body-only shape (every existing consumer never sets this).
   *
   * ⚠ THE ONE NON-SERIALIZABLE MEMBER of this otherwise plain-value envelope: `sse` is a CLOSURE,
   * carrying the SAME external-exposure-isolate debt as the `blob`/`mintPlayToken`/`enqueue` closures and the
   * `StreamRouteHandler` raw Request/Response (route-init.ts) — it is IN-PROCESS today and NOT
   * isolate-ready (the cross-isolate streaming model is an isolate design point). Only the FRAMES it emits
   * (`SseFrame` — plain strings) are serializable. Build it via `sseResponse(...)` for clear intent.
   */
  readonly sse?: SseProducer;
}

/**
 * ONE Server-Sent Events frame: the generic SSE wire shape (`id:`/`event:`/`data:`). It is
 * transport-neutral DATA — NOT a `NeutralEvent` and NOT conversation-specific — so a capability owns
 * its own `event:` names + `data:` payloads (e.g. a `text_delta` pass-through frame + a terminal
 * `conversation_reply` frame). `data` is the already-serialized frame body (the producer serializes).
 */
export interface SseFrame {
  /** OPTIONAL SSE `id:` — the resume cursor a client echoes as `Last-Event-ID` (e.g. a run seq). */
  readonly id?: string;
  /** OPTIONAL SSE `event:` name (the frame type). Absent ⇒ the client's default `message` handler. */
  readonly event?: string;
  /** The SSE `data:` payload — an ALREADY-SERIALIZED string (the producer owns serialization). */
  readonly data: string;
}

/**
 * A Server-Sent Events producer the engine drives to stream a `text/event-stream` response.
 * The engine calls it once with:
 *   - `emit(frame)` — write ONE `SseFrame` to the stream (the engine owns the wire encoding + any
 *     persist-before-flush discipline of its own; a post-disconnect write is a safe no-op);
 *   - `signal.aborted` — flips `true` when the client disconnects (the producer MAY short-circuit
 *     further emits, but MUST NOT rely on it for durability: an operation the stream is a VIEW of —
 *     e.g. the conversational reply persist — completes server-side regardless of the connection).
 * NON-SERIALIZABLE (a closure) — the external-exposure-isolate debt documented on `HttpResponse.sse`.
 */
export type SseProducer = (
  emit: (frame: SseFrame) => Promise<void>,
  signal: { readonly aborted: boolean },
) => Promise<void>;

/**
 * Build the OPT-IN enriched `{handler}` route response. A handler returns this (instead
 * of a plain body) to choose the HTTP status and/or set response headers:
 *
 *   return httpResponse({ status: 201, headers: { Location: `/x/${id}` }, body: { id } });
 *
 * A plain return (any non-branded value) keeps the existing behavior (HTTP 200 + that value as the
 * JSON body) — so this is purely additive. The engine clamps `status` to a valid integer.
 */
export function httpResponse<T = unknown>(init: {
  status?: number;
  headers?: Readonly<Record<string, string>>;
  body?: T;
}): HttpResponse<T> {
  return {
    [HTTP_RESPONSE_BRAND]: true,
    ...(init.status !== undefined ? { status: init.status } : {}),
    ...(init.headers !== undefined ? { headers: init.headers } : {}),
    ...(init.body !== undefined ? { body: init.body } : {}),
  };
}

/**
 * Build a STREAMING (`text/event-stream`) `{handler}` route response. A handler returns this
 * (instead of a plain body / `httpResponse({...})`) when it wants to stream Server-Sent Events; the
 * engine drives `producer` and encodes each `SseFrame` to the wire. It reuses the SAME brand as
 * `httpResponse` (so the `isHttpResponse` discriminator AND the untrusted-request-body brand-strip
 * cover it with no second surface), carrying ONLY the brand + `sse` — so a plain / body-only envelope
 * stays byte-identical (it never has an `sse` key).
 *
 * ⚠ `producer` is a CLOSURE — the non-serializable, in-process-only member documented on
 * `HttpResponse.sse`. NOT isolate-ready; the emitted frames are the serializable part.
 */
export function sseResponse(producer: SseProducer): HttpResponse {
  return { [HTTP_RESPONSE_BRAND]: true, sse: producer };
}

/**
 * Type guard: is a handler return the BRANDED enriched envelope (vs a plain body that maps to 200)?
 * Checks ONLY the reserved brand key === `true`, so a plain object — even `{ status: 'ok' }` or
 * `{ status: 201 }` — is NOT mis-classified (it lacks the brand). Used by the engine; safe to use in a
 * handler too. (The reserved brand is stripped from the UNTRUSTED request body at injection, so a
 * caller cannot forge it into a handler that echoes `init.body` — see `HTTP_RESPONSE_BRAND`.)
 */
export function isHttpResponse(value: unknown): value is HttpResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>)[HTTP_RESPONSE_BRAND] === true
  );
}

/** What a ROUTE handler receives. Runs INSIDE the engine's `TenantDb.transaction()` (the tenant-GUC seam). */
export interface RouteHandlerInit extends HandlerInit {
  /**
   * Path/query params bound by the route (e.g. `{id}` → `params.id`). All values are DATA (server-
   * parsed strings) — never instructions, never a tenant signal (the tenant is server-derived).
   */
  readonly params: Readonly<Record<string, string>>;
  /**
   * The parsed JSON request body (DATA — for a POST/PUT/PATCH/DELETE `{handler}` route).
   * ABSENT for a GET/HEAD route (no body) and when the body is not valid JSON (parse failures yield an
   * absent body, never a throw). TRUST BOUNDARY: the body is UNTRUSTED CALLER DATA the trusted-author handler
   * treats as a plain value — a route handler does not call the model, so there is no prompt-frame
   * concern. Like every other field here it is a plain serializable value (isolate-safe).
   */
  readonly body?: unknown;
  /**
   * An ALLOWLISTED subset of the request's HTTP headers, LOWERCASE-keyed (DATA). This seam
   * exists for the declared `conditional_read` feature (an SDK-consumption capability — e.g. the
   * views runtime's `if-none-match` → 304) plus content-negotiation basics; it is NOT general header
   * passthrough and NOT a wire-parity requirement. The engine forwards ONLY a closed allowlist
   * (conditional-read headers + accept/accept-language/content-type — see the api interpreter's
   * `FORWARDED_REQUEST_HEADERS`); credentials (`authorization`/`cookie`/`proxy-authorization`/any
   * future scheme) can therefore never reach a handler. ABSENT when the api interpreter does not
   * inject them (older engines / non-HTTP invocations) — a handler that wants a header treats a
   * missing map exactly like a missing header. TRUST BOUNDARY: header values are UNTRUSTED CALLER DATA (never
   * instructions, never a tenant signal — the tenant stays server-derived). A plain string map, so
   * the init stays serializable-shaped (isolate-safe).
   */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * The TENANT-BOUND durable agent-run enqueue capability (see `EnqueueAgentRun`).
   * OPTIONAL: present only when the deployment wired a durable worker (a no-worker deploy omits it, and a
   * handler that needs it fail-closes loudly on `undefined`). The tenant is captured server-side from
   * the init — a pack can NEVER name a tenant. External-exposure-isolate debt (a closure; the real isolate is the
   * per-tenant sandbox — trusted-author posture).
   */
  readonly enqueue?: EnqueueAgentRun;
  /**
   * The play-token MINT capability. A generic, product-agnostic capability the
   * engine injects ONLY when the deployment configured a media signing key: mint a short-lived,
   * tenant-scoped, resource-bound bearer token (a `?token=` value) authorizing the CURRENT authed
   * principal to stream the OPAQUE `resource` (the handler's chosen blob key). `ttlSeconds` is the hard
   * expiry (the handler scales it to the recording duration). The minted token is bound to the run's
   * SERVER-DERIVED tenant + the authed user BY THE ENGINE — the handler supplies only the opaque
   * `resource` + the TTL; it can neither forge a tenant nor mint for another user. OPTIONAL: absent
   * when no media key is wired (a mint handler then fail-closes loudly on `undefined`).
   *
   * ⚠ ISOLATE-READINESS (honest — like `db.transaction`): `mintPlayToken` is a CLOSURE over the engine's
   * media signer, so it does NOT trivially cross an external-exposure isolate boundary (a closure cannot be
   * serialized). The cross-isolate mint is an isolate design point (an explicit mint RPC). The in-process
   * call is correct (the tenant + user are engine-bound, not handler-supplied).
   */
  readonly mintPlayToken?: (args: { resource: string; ttlSeconds: number }) => Promise<string>;
}

/** What a TRIGGER handler receives. Runs INSIDE the engine's `TenantDb.transaction()` (the tenant-GUC seam). */
export interface TriggerHandlerInit extends HandlerInit {
  /** The declared trigger's name (DATA — for logging/branching). */
  readonly triggerName: string;
}

/**
 * What a `stream` ROUTE handler receives (the shape is declared here; the interpreter that BUILDS
 * + invokes it is the stream ingest/playback path). UNLIKE a `RouteHandler`, a stream handler reads
 * the RAW Web-standard `Request` (binary body for ingest, Range headers for playback) and returns a
 * raw `Response` — so the platform stays product-agnostic (zero media/audio vocabulary): the bytes +
 * the 200-ack/409-gap ingest contract + the Range/206 playback contract live in the (pack) handler.
 *
 * `blob` is REQUIRED here (a stream handler exists to move bytes): the engine fail-closes at deploy if
 * a `stream` route is declared without a blob backend injected. `db` (the name-keyed tenant store) +
 * `params` (the route's path params, DATA) are inherited so a stream handler can write its pointer row
 * + read its upload id. The raw `request` is the Web `Request`; the handler returns a Web `Response`.
 *
 * IMPLEMENTATION NOTE: this is the TYPE only. The raw `request`/`Response` plumbing lives in
 * `registerDeclaredRoutes` (the stream ingest/playback interpreter); the base `HandlerInit` carries the
 * `blob` capability + the slot.
 */
export interface StreamRouteHandlerInit extends HandlerInit {
  /** REQUIRED for a stream handler — the tenant-bound blob capability (deploy fail-closes if absent). */
  readonly blob: BlobStore;
  /** Path/query params bound by the route (e.g. `{upload_id}` → `params.upload_id`). All DATA. */
  readonly params: Readonly<Record<string, string>>;
  /** The raw Web-standard request (binary body / Range headers) — the body is UNTRUSTED DATA. */
  readonly request: Request;
  /**
   * Playback ONLY: the OPAQUE resource reference the verified media token authorized this
   * bearer to read (absent on an ingest request — there is no media token there). The platform's
   * media-JWT verifier already authenticated the token (signature + alg=HS256 + exp + the distinct
   * media key) and set the run's server-derived `tenantId` from the token's claim; this surfaces the
   * token's `resource` claim so the playback handler can BIND it to the requested route resource AND
   * re-validate the resource's ACTUAL owning tenant against the DB (via `init.db`) before serving a
   * byte — the claim is NEVER trusted alone. OPAQUE to the platform (the pack chose it as its blob key).
   */
  readonly mediaResource?: string;
}

/**
 * A `stream` ROUTE handler: `(init) => Response`. Reads the raw request, moves bytes through the
 * tenant-bound `BlobStore`, returns a raw Web `Response` (the ingest 200-ack / the Range/206 playback).
 * RESERVED for the stream-route interpreter to invoke — declared here so the contract a pack author
 * writes against is fixed up front.
 */
export type StreamRouteHandler = (init: StreamRouteHandlerInit) => Promise<Response> | Response;

// ---------------------------------------------------------------------------------------
// Handler function shapes — what an escape-hatch module exports.
// ---------------------------------------------------------------------------------------

/**
 * A TOOL handler: `(args, init) => neutral data`. `args` are the model-supplied tool arguments
 * (validated against the tool's `parameters` JSON-Schema by the central `dispatchTool` BEFORE this
 * runs); the return is NEUTRAL DATA (validated against the tool's `outputSchema` by `dispatchTool`
 * AFTER, then opaque-wrapped + journaled). The handler returns ONLY plain serializable data — never
 * a platform object — so the result crosses the dispatch chokepoint (and an isolate boundary)
 * losslessly. `In`/`Out` default to `unknown` so an untyped handler is still well-formed.
 *
 * TRUST BOUNDARY: `args` is untrusted MODEL output; treat it as DATA. The returned data is itself opaque-
 * wrapped by `dispatchTool` (`{kind:'tool_data'}`) so it re-enters the model as DATA, never as
 * instructions.
 */
export type ToolHandler<In = unknown, Out = unknown> = (
  args: In,
  init: ToolHandlerInit,
) => Promise<Out> | Out;

/**
 * A ROUTE handler: `(init) => neutral JSON body`. Runs inside the engine's `TenantDb.transaction()`
 * behind the SAME auth/tenant middleware chain as every route (the tenant is server-derived). The
 * return is the response body (serialized as JSON by the engine).
 */
export type RouteHandler<Out = unknown> = (init: RouteHandlerInit) => Promise<Out> | Out;

/**
 * A TRIGGER handler: `(init) => void`. Runs inside the engine's `TenantDb.transaction()`. A
 * trigger is parse/register-only — the durable cron/event worker is a reserved seam (a synchronous
 * past-bound fire is fail-closed-rejected), so this contract is RESERVED for that worker to invoke.
 */
export type TriggerHandler = (init: TriggerHandlerInit) => Promise<void> | void;
