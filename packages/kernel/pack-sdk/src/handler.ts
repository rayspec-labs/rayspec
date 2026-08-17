/**
 * The HANDLER half of the contract — what the modules a pack's declarations POINT AT are written
 * against.
 *
 * The manifest half says WHERE a handler lives and WHAT IT IS CALLED: `PackHandlerFragment` names the
 * module, the export and the kind; `PackToolFragment` and `PackApiRouteFragment` wire a tool and a
 * route to it. None of that says what a handler IS. A pack that declares a `tooling` or an `api`
 * contribution and then has to write the module behind it needs the other half: the value the
 * platform CALLS it with, and the shape of the function it exports.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THE CONTRACT IS DECLARED HERE RATHER THAN RE-EXPORTED.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The platform's own handler contract (`@rayspec/handler-sdk`) ships in the same release closure as
 * this package, so INSTALLING it is not the obstacle — RE-EXPORTING it is. That package carries
 * RUNTIME (a bounded body reader, a tokenizer conduit) and three production dependencies
 * (`@rayspec/core`, `@rayspec/stt-port`, `@rayspec/tts-port`), and its contract names capability
 * objects owned by the platform. Re-exporting it — or requiring it beside this one — would make the
 * whole of that this package's promise: every internal type it names, every dependency it pulls, and
 * four packages in a pack's install instead of one. That ends the two properties this surface exists
 * for: a pack imports ONE thing for both halves of a contribution, and that thing is a
 * zero-dependency leaf. So the contract is DECLARED here, against what this package already carries,
 * and the correspondence with the value the platform actually passes is pinned AT COMPILE TIME on the
 * platform side — where the value lives. Without that pin the two could drift, and the only place the
 * drift would surface is a pack author's own repository, which is the failure this surface exists to
 * prevent.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT A PACK HANDLER RECEIVES — AND WHAT IT DOES NOT.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A pack handler is NOT automatically entitled to everything the platform hands a first-party
 * handler. What it receives is stated positively below; what is withheld is withheld VISIBLY, named
 * here with the reason, rather than by an omission a reader would have to notice:
 *
 *  - THE INJECTED CAPABILITY HANDLES — a blob backend, the read-only file source, the speech
 *    providers, the event-bus append. Each is a platform CAPABILITY CONTRACT: a runtime object whose
 *    shape is versioned with the platform, exactly as `PackCapabilities` already says of the slot a
 *    pack fills. Copying one here would freeze this surface to every additive change made there and
 *    promise a compatibility it cannot keep. The tenant-bound store door is the ONE exception, and it
 *    is an exception by necessity rather than by taste: without it there is no handler to write.
 *  - THE DURABLE ENQUEUE. The init a deployment builds for a route CAN carry one, and this contract
 *    does not name it. Scheduling a durable agent turn from a pack is what `TurnDispatch` on
 *    `PackServiceContext` is for, and this package already states that a REACTIVE contribution — a
 *    route, a tool, a trigger — does not receive it; promising a route handler a second, differently
 *    named door onto the same power would contradict that in the same surface. It is withheld HERE
 *    rather than removed THERE: what a deployment's own routes are handed is the deployment's affair,
 *    and this is a statement about what a PACK may rely on.
 *  - THE PLAY-TOKEN MINT. It is injected only when the deployment configured a media signing key, and
 *    it closes over that key; a capability a deployment opts into is not a shape this surface can
 *    promise on its behalf.
 *  - THE STATUS-AND-HEADERS RESPONSE ENVELOPE. Choosing an HTTP status or setting response headers
 *    needs the platform's branded envelope, and the brand is a RUNTIME value this types-only package
 *    does not ship. A pack route handler returns a plain body, which the deployment serializes as JSON
 *    with HTTP 200; spelling the brand out by hand would couple a pack to a marker it does not own.
 *    The INCREMENTAL response is the one shape of that envelope a pack can reach, and it is reached
 *    the only way this package's posture allows: the constructor is INJECTED (`init.sseResponse`), so
 *    the pack builds the platform's own envelope through the platform's own implementation and still
 *    names no marker. Status and headers stay withheld — an incremental response is a 200 stream whose
 *    status is already flushed before the first frame, so there is nothing left for a pack to choose.
 *  - THE STREAM ROUTE SHAPE. A `route`-kind handler placed behind a `{kind:'stream'}` api action is a
 *    DIFFERENT contract from `PackRouteHandler` — it is handed the raw Web `Request` plus a REQUIRED
 *    blob backend and returns a raw `Response`, not a JSON body — and this package does not promise
 *    it. Not by oversight: its init REQUIRES the very capability handle the first bullet withholds,
 *    so contracting it here would contradict that rule in the same file. A pack that contributes a
 *    stream route annotates `StreamRouteHandler`/`StreamRouteHandlerInit` from `@rayspec/handler-sdk`
 *    instead — `examples/stream-backend/packs/stream-pack` is the in-tree witness, and
 *    `gate:handler-imports` sanctions that import over a pack handler root for exactly this case.
 *    IT IS NOT THE INCREMENTAL RESPONSE ABOVE, and the two are easy to confuse because both are
 *    called streaming. The `{kind:'stream'}` action moves BYTES through a blob backend — binary
 *    ingest, Range playback — and a route declared under it never reaches `PackRouteHandler` at all.
 *    `init.sseResponse` answers an ORDINARY `{kind:'handler'}` route with an event stream instead of
 *    a JSON body, needs no blob backend, and changes nothing about how that route is registered.
 *    Two doors, not one widened.
 *
 * Everything withheld is withheld from THE CONTRACT, not from the running deployment: the platform
 * builds one init per invocation and a pack simply has no promised name for the rest of it.
 *
 * WHICH DECLARABLE SHAPES ARE CONTRACTED HERE — and which are not. `PackHandlerKind` admits `tool`,
 * `route` and `trigger`; this package contracts the `tool` kind and the `route` kind AS SERVED BEHIND
 * A `{kind:'handler'}` api action. Two shapes are declarable and uncontracted, and each says so
 * rather than going missing:
 *   - `trigger` — a pack's trigger is fired by the durable worker, and until both halves of that seam
 *     are settled a type here would have to change. Declaring one is supported; annotating one
 *     against this package is not.
 *   - a `route`-kind handler behind a `{kind:'stream'}` action — the stream shape above. `route` is
 *     one kind carrying TWO contracts (the spec resolves a stream action's handler against a declared
 *     `route`-kind handler), and only the JSON one is promised here.
 * Saying so is better than a promise this package would have to break — and better than an omission.
 * The compiler already REFUSES a stream handler annotated `PackRouteHandler` (see that type's
 * docblock for the two errors), so the omission would not ship a runtime surprise; what it would ship
 * is a pack author holding a `TS2339` about a missing `request` property with nothing in this package
 * telling them the shape exists elsewhere and where.
 */

import type { PackJournalReader } from './journal.js';
// The door onto a pack's OWN platform tables. Declared with the service context because that is where
// it was first handed out; named here because a handler now receives the same one — see `packDb`.
import type { PackDatabase } from './service.js';

/**
 * One row of a DECLARED store as a handler sees it — a plain, serializable record. The injected `id`
 * and the tenancy columns are present on a read; every value is DATA.
 */
export type PackStoreRow = Record<string, unknown>;

/**
 * A row filter — a value map over the store's declared column names. `{}` (or omitted) matches every
 * row the run's tenant can see. Entries AND-combine and a value is matched by EQUALITY; the platform
 * resolves the column names against the declared store and AND-combines the tenant predicate beneath,
 * so a filter can never widen a read past the run's own tenant.
 *
 * It is deliberately a plain record rather than a closed grammar: the accepted VALUE forms are the
 * deployment's (a batched set-membership array, a bounded comparison on a read filter), and re-stating
 * them here would make every additive form a breaking change to this package.
 */
export type PackStoreFilter = Record<string, unknown>;

/** Read-shaping options for `select` — server-side ordering and paging over a declared store. */
export interface PackSelectOptions {
  /** Order by these declared columns, in order (default direction `asc`). */
  readonly orderBy?: ReadonlyArray<{ readonly column: string; readonly dir?: 'asc' | 'desc' }>;
  /** Max rows to return. */
  readonly limit?: number;
  /** Rows to skip. Pair a non-unique `orderBy` with a unique tiebreaker, or a page can repeat a row. */
  readonly offset?: number;
}

/** Options for `upsert`. */
export interface PackUpsertOptions {
  /**
   * A conditional-update guard on the conflict arm: the conflicting row must ALSO match this equality
   * map for the update to apply. A conflict whose row does not match writes nothing and the call
   * resolves `undefined` — "insert, or overwrite only a row still in the expected state", in one
   * statement.
   */
  readonly updateWhere?: PackStoreFilter;
}

/**
 * The STORE DOOR — how a contributed tool or route handler reads and writes the stores the merged
 * document declares. It is the handler-side counterpart of `PackDatabase`, and the two are
 * deliberately different doors: a SERVICE maintains the platform tables its pack OWNS, which no
 * generator made, so it writes parameterized SQL; a HANDLER runs per invocation under a
 * SERVER-DERIVED tenant and reaches a DECLARED store by NAME, never by SQL.
 *
 * Every method addresses a store by its declared name, exchanges plain rows and filters, is scoped to
 * the run's tenant STRUCTURALLY (the platform AND-combines the predicate and stamps it on insert), and
 * fail-closes on a store the document did not declare — so a handler can reach its own pack's stores
 * and the deployment's, and nothing else.
 */
export interface PackStoreDb {
  /** Read rows matching `filter` (omitted ⇒ every row of the run's tenant), shaped by `opts`. */
  select(
    store: string,
    filter?: PackStoreFilter,
    opts?: PackSelectOptions,
  ): Promise<PackStoreRow[]>;
  /**
   * Count the rows matching `filter` without loading them.
   *
   * OPTIONAL because it is additive: a deployment older than the method provides no implementation, so
   * feature-detect (`typeof db.count === 'function'`) and fall back to a bounded read.
   */
  count?(store: string, filter?: PackStoreFilter): Promise<number>;
  /** Insert one row (the tenant column is stamped by the platform); resolves the inserted row. */
  insert(store: string, values: PackStoreRow): Promise<PackStoreRow>;
  /**
   * Insert `values`, or UPDATE the row that conflicts on `conflictColumns` — one statement, so the
   * race-prone read-then-insert-then-catch idiom is not needed.
   *
   * The update arm is scoped to the run's tenant, so a conflict that lands on ANOTHER tenant's row
   * updates nothing and this resolves `undefined` — the fail-closed no-op, never a write across a
   * tenant. `undefined` also answers an ensure-exists upsert whose `values` are a subset of
   * `conflictColumns`, and an `opts.updateWhere` guard the conflicting row does not match.
   */
  upsert(
    store: string,
    conflictColumns: string[],
    values: PackStoreRow,
    opts?: PackUpsertOptions,
  ): Promise<PackStoreRow | undefined>;
  /** Update the rows matching `filter` with `patch`; resolves the updated rows. */
  update(store: string, filter: PackStoreFilter, patch: PackStoreRow): Promise<PackStoreRow[]>;
  /** Delete the rows matching `filter`; resolves how many were deleted. */
  delete(store: string, filter: PackStoreFilter): Promise<number>;
  /**
   * Run `fn` inside one tenant-scoped transaction. `tx` is a `PackStoreDb` again — the same
   * name-keyed door — so a statement reads the same inside a transaction as outside one.
   *
   * A ROUTE handler already runs inside a transaction the deployment opened, so this nests onto that
   * one. A TOOL handler has NO implicit outer transaction — several tools of one turn run
   * concurrently, and an implicit wrapper would hold a connection across model latency — so a tool
   * that needs a read-decide-write to be atomic opens one here.
   */
  transaction<T>(fn: (tx: PackStoreDb) => Promise<T>): Promise<T>;
}

/**
 * The authenticated caller of a request, as the deployment's own auth chain already resolved it —
 * plain values a handler reads as DATA. It is never a tenant signal (the tenant stays server-derived)
 * and never an authorization decision: the permission checks ran BEFORE the handler was called.
 */
export interface PackHandlerPrincipal {
  /** Which kind of principal the chain resolved: a signed-in user, an api key, or a machine client. */
  readonly kind: 'user' | 'apikey' | 'm2m';
  /** The user id or api-key id — the same value the platform stamps as the row's creator. */
  readonly id: string;
  /** The caller's role claim, when the principal carries a live one. Never trusted for a write. */
  readonly role?: string;
}

/**
 * What EVERY pack handler receives, whichever chokepoint called it. Both members are promised on
 * every invocation: a pack handler always knows which tenant it is running for, and always has the
 * door onto the declared stores.
 */
export interface PackHandlerInit {
  /**
   * The invocation's SERVER-DERIVED tenant id. DATA — a handler reads it (to key its own ledger row,
   * to log) and never supplies it: nothing a caller or a model can write reaches this value, and the
   * store door is already scoped by it.
   */
  readonly tenantId: string;
  /** The tenant-bound, name-keyed door onto the stores the merged document declares. */
  readonly db: PackStoreDb;
  /**
   * The door onto the PLATFORM TABLES THIS PACK'S OWN MIGRATION CHAIN CREATED — a different thing
   * from `db` above, which is the deployment's declared stores.
   *
   * A pack that declares `migrations: { dir, tablePrefix }` owns tables no store name reaches. Until
   * this existed, only a `services[]` module could read them (`PackServiceContext['db']`), so the two
   * contribution kinds did not compose: a pack could own tables and could contribute a route, and the
   * route could not read a row the pack itself had written. The only way across was to capture a
   * service's handle in a module variable at boot, which makes a handler depend on boot order, on a
   * service having been declared at all, and on a value no contract promises.
   *
   * IT IS THE SAME DOOR A SERVICE GETS. Same parameterized `query`, same refusals, same posture: it
   * does not rewrite a pack's SQL and it is NOT a tenant filter, because a pack runs in the
   * deployment's process as a trusted, non-sandboxed author. **Scoping the statement is therefore the
   * pack's job, and here it is dischargeable rather than merely stated** — `init.tenantId` above is
   * server-derived and nothing a caller or a model can write reaches it, so a handler has, on the same
   * object, both the obligation and the value that meets it. (A service context carries no `tenantId`
   * at all and has to be handed one by the deployment; this is the better position of the two.)
   *
   * `transaction(fn)` DEPENDS ON WHERE THE HANDLER RUNS, and the difference is not a wart to work
   * around but the truth about the two situations:
   *   · in a ROUTE it is REFUSED, because the deployment already opened one around the invocation and
   *     the statements are already atomic with the route's own. What a second one would be is not a
   *     savepoint — it reserves another connection out of the same small pool while this request holds
   *     one, which under load is a deadlock rather than a hazard. Do the work in the transaction you
   *     are in, or split it into two.
   *   · in a TOOL it OPENS one, because a tool holds no outer transaction (several tools of one turn
   *     run concurrently, and an implicit wrapper would hold a connection across model latency).
   *
   * OPTIONAL because it is ADDITIVE: a deployment older than this contract injects none, so
   * feature-detect (`if (!init.packDb) …`) and fail-close loudly rather than reading `undefined`. The
   * deployment this ships with populates it on every invocation of both kinds — the optionality is
   * about version skew, not a capability a deployment opts into. It is ALSO absent, on any version,
   * for a pack that declares no migration chain: there are no tables of its own to open a door onto.
   */
  readonly packDb?: PackDatabase;
}

/**
 * What a TOOL handler receives. Identical to `PackHandlerInit` today and named distinctly anyway, so
 * the contract a tool author annotates against is explicit and a later tool-only member can be added
 * without widening the route init.
 */
export type PackToolHandlerInit = PackHandlerInit;

/**
 * ONE frame of an incremental response — the Server-Sent-Events wire shape (`id:`/`event:`/`data:`).
 * Transport-neutral DATA: the pack owns its own `event:` names and its own `data:` payloads, and the
 * deployment owns the encoding.
 */
export interface PackSseFrame {
  /**
   * OPTIONAL frame id — the RESUME CURSOR a client echoes back as `Last-Event-ID`. Emit the journal
   * entry's own `cursor` here and a reconnecting client resumes exactly one entry past the last one it
   * received; emit nothing and it can only start over.
   */
  readonly id?: string;
  /** OPTIONAL frame type. Absent ⇒ the client's default `message` handler. */
  readonly event?: string;
  /** The frame body — an ALREADY-SERIALIZED string (the pack owns the serialization). */
  readonly data: string;
}

/**
 * The function that PRODUCES an incremental response, driven ONCE by the deployment. It receives:
 *   - `emit(frame)` — write one frame; a write after the client disconnected is a safe no-op;
 *   - `signal.aborted` — flips `true` when the client disconnects. A producer MAY stop emitting on it
 *     and MUST NOT rely on it for durability: work the stream is only a VIEW of completes server-side
 *     regardless of the connection.
 *
 * ⚠ IT RUNS AFTER THE ROUTE'S TRANSACTION HAS COMMITTED. The response status is already flushed by
 * the time the first frame is written, so a producer cannot change it and owns its own terminal /
 * error framing. `init.db` belongs to a transaction that has closed by then: read what a producer
 * needs in the handler BODY, or read it through `init.journal`, which is bound to the tenant handle
 * rather than to the route transaction for exactly this reason.
 */
export type PackSseProducer = (
  emit: (frame: PackSseFrame) => Promise<void>,
  signal: { readonly aborted: boolean },
) => Promise<void>;

/**
 * The OPAQUE value `init.sseResponse(...)` returns — the incremental response itself. A pack RETURNS
 * it from its handler and does nothing else with it: its shape is the deployment's, and a hand-built
 * copy would not carry the marker the deployment discriminates on. Naming it as a route handler's
 * `Out` (`PackRouteHandler<PackRouteResponse>`) is the whole of what this type is for.
 *
 * IT IS DELIBERATELY UNSTRUCTURED, for the reason `PackCapabilities` is: the members the deployment's
 * envelope carries are the deployment's own, and re-stating one here would freeze this surface to
 * every additive change made there — and would invite a pack to CONSTRUCT the value instead of
 * passing back the one it was handed, which is the one thing that cannot work.
 */
export type PackRouteResponse = object;

/**
 * The INCREMENTAL-RESPONSE constructor a route handler is handed on its init (`init.sseResponse`).
 *
 * It is a CONSTRUCTOR rather than a writable stream on purpose, and it is INJECTED rather than
 * imported for a stated reason: the deployment's response envelope is discriminated by a runtime
 * marker this types-only package does not ship, so the only honest way to let a pack build one is to
 * hand it the deployment's own builder. A pack therefore emits frames through the SAME implementation
 * a first-party route uses, and still names no platform marker.
 */
export type PackSseResponder = (producer: PackSseProducer) => PackRouteResponse;

/**
 * What a ROUTE handler receives — the common init plus what the request carried.
 *
 * A contributed route rides the deployment's own app: the same auth chain, the same interpreter, the
 * same transaction boundary as a route the deployment declared. Nothing here is a trust signal — the
 * tenant is server-derived and stays that way regardless of what a caller sends.
 */
export interface PackRouteHandlerInit extends PackHandlerInit {
  /**
   * The route's bound path parameters (`/turns/{turn_id}` → `params.turn_id`), as server-parsed
   * strings. All DATA, and never a tenant: a caller cannot name another tenant's data through them.
   */
  readonly params: Readonly<Record<string, string>>;
  /**
   * The parsed JSON request body. ABSENT for a method that carries none and when the body did not
   * parse (a parse failure yields no body, never a throw). UNTRUSTED CALLER DATA.
   */
  readonly body?: unknown;
  /**
   * An ALLOWLISTED subset of the request's headers, lowercase-keyed. Not general passthrough: the
   * deployment forwards a closed set (conditional-read and content-negotiation headers), so no
   * credential header can reach a handler. ABSENT when the deployment injected none — treat a missing
   * map exactly like a missing header. UNTRUSTED CALLER DATA.
   */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * The authenticated caller. ABSENT when the invocation carried no resolved principal — never
   * fabricated, so a handler that needs one fail-closes loudly on `undefined`.
   */
  readonly principal?: PackHandlerPrincipal;
  /**
   * The RUN-JOURNAL READ door for this invocation's tenant (see `PackJournalReader` for what it is
   * scoped to and what it withholds).
   *
   * OPTIONAL because it is ADDITIVE: a deployment older than this contract injects none, so
   * feature-detect (`if (!init.journal) …`) and fail-close loudly rather than reading `undefined`.
   * The deployment this ships with populates it on every route invocation — the OPTIONALITY is about
   * version skew, not about a capability a deployment opts into.
   *
   * IT SURVIVES THE ROUTE TRANSACTION, which is what makes it usable from inside a `PackSseProducer`:
   * the reader is bound to the tenant handle rather than to the transaction the route opened. The cost
   * is stated rather than hidden — a read does not see the route's own uncommitted writes — and it
   * costs nothing here, because a route does not write the journal.
   */
  readonly journal?: PackJournalReader;
  /**
   * The INCREMENTAL-RESPONSE constructor (see `PackSseResponder`). A handler that returns
   * `init.sseResponse(producer)` answers with an event stream the deployment drives, on the SAME
   * registration every other `{kind:'handler'}` route rides — the same auth chain, the same tenant
   * resolution, the same permission gate and the same per-route budget. Nothing about the refusal of
   * an unauthenticated or under-scoped call changes: the response shape is chosen inside the handler,
   * and the handler is reached only after the chain has already let the request through.
   *
   * OPTIONAL for the same version-skew reason as `journal`, and absent for no other: fail-close on
   * `undefined` rather than falling back to a plain body a client would have to detect.
   */
  readonly sseResponse?: PackSseResponder;
  /**
   * The request's RESUME CURSOR — what a reconnecting client sent as `Last-Event-ID`, or an explicit
   * `?lastEventId=` query on a first request, with the header taking precedence. The deployment
   * resolves it with the SAME resolver its own resumable feeds use, so a pack receives a decided value
   * instead of carrying a second copy of that precedence.
   *
   * ABSENT when the request carried neither — which means "from the beginning", never an empty read.
   * UNTRUSTED CALLER DATA: an opaque position marker and never a tenant signal, so passing it straight
   * to `journal.read({ after })` cannot widen a read past the run's own tenant; a value the reader
   * cannot parse is refused there rather than silently replayed from zero.
   */
  readonly resumeFrom?: string;
}

/**
 * A TOOL handler: `(args, init) => neutral data`, the shape a `tooling` contribution's handler module
 * exports.
 *
 * `args` are the model-supplied arguments, ALREADY validated against the tool's declared `parameters`
 * schema before this runs — and still UNTRUSTED: they are model output, to be treated as data and
 * never as instructions. What is returned is validated against the declared `outputSchema`, recorded
 * in the run journal and handed back to the model as data. Return PLAIN SERIALIZABLE VALUES only: the
 * result crosses the platform's dispatch chokepoint, so a platform object would not survive the trip.
 *
 * `In` and `Out` default to `unknown`, so a handler that annotates neither is still well-formed.
 */
export type PackToolHandler<In = unknown, Out = unknown> = (
  args: In,
  init: PackToolHandlerInit,
) => Promise<Out> | Out;

/**
 * A ROUTE handler: `(init) => neutral JSON body`, the shape the module behind an `api` contribution's
 * `{kind:'handler'}` action exports. It runs behind the deployment's auth chain, inside the
 * tenant-scoped transaction the deployment opened, and what it returns is the response body,
 * serialized as JSON with HTTP 200.
 *
 * ONE RETURN, TWO SHAPES. `Out` is a plain JSON body by default; a handler that answers INCREMENTALLY
 * returns `init.sseResponse(producer)` instead and annotates `PackRouteHandler<PackRouteResponse>`.
 * That is still one returned value — the increments are written by the producer the deployment drives
 * — which is why no writable stream appears on the init.
 *
 * NOT the shape for a `{kind:'stream'}` action. That action also resolves against a declared
 * `route`-kind handler, but the module behind it exchanges a raw Web `Request`/`Response` and needs
 * the blob backend — a contract this package withholds (see the module docblock).
 *
 * The compiler REFUSES that annotation rather than accepting it: reading `init.request` or
 * `init.blob` is `TS2339` (the property is not on `PackRouteHandlerInit`), and spelling the parameter
 * `StreamRouteHandlerInit` — or assigning a `StreamRouteHandler` value to this type — is `TS2322`,
 * because a function parameter position is CONTRAVARIANT under `strict`. What the compiler does NOT
 * do is name the shape to reach for instead; its message names a missing property. That is what this
 * docblock is for: annotate `StreamRouteHandler`/`StreamRouteHandlerInit` from
 * `@rayspec/handler-sdk`.
 */
export type PackRouteHandler<Out = unknown> = (init: PackRouteHandlerInit) => Promise<Out> | Out;
