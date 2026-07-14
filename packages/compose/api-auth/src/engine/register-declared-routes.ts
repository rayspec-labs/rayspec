/**
 * Boot-time DECLARED-ROUTE registration — the `api[]` runtime interpreter ("interpret"
 * half;: extend `createAuthApp`, keep auth a registerable sub-router).
 *
 * Iterates a validated `RaySpec.api[]` and registers each declared route on the SAME
 * `OpenAPIHono<AppEnv>` app, behind the SAME ordered middleware chain every other route uses —
 * `requireAuth()` → `resolveTenant(deps)` → `requirePermission(deps, perm)` — REUSED VERBATIM (the
 * server-derived tenant + live-membership recheck, NOT a parallel authz). Routes are 100% interpreted
 * at runtime: a route change is a safe redeploy, no codegen (the cleanest application of 's
 * "interpret" half).
 *
 * Route `action` interpreters:
 *  - `{ kind:'store', store, op }`       → CRUD via TenantDb inside a tenant transaction (store-routes.ts).
 *  - `{ kind:'agent', agent }`           → the EXISTING run surface (`executeAgentRun` from runs.ts) —
 *                                          sync/SSE, idempotency-keyed; `async:true` enqueues onto the
 * durable worker (202 + runId) when one is wired, else 501.
 *  - `{ kind:'handler', handler }`       → a declared ROUTE handler, wired through the escape-hatch
 * handler model inside a TenantDb.transaction.
 *  - `{ kind:'stream', handler, mode }`  → a raw binary ingest / Range-206 playback stream handler
 * (grammar; the INTERPRETER lands in /S3). Until
 *                                          then this arm FAILS CLOSED at boot with a clear error —
 *                                          never a silent no-op (a declared stream route that 200s
 *                                          nothing would be a worse outcome than a loud refusal).
 *
 * EXHAUSTIVENESS: the action dispatch is an exhaustive if/continue chain terminated by an
 * `assertNever` default — adding a member to the closed `RouteAction` union without a matching arm
 * is a COMPILE error here, so a future route kind can never silently fall through.
 *
 * PRODUCT-AGNOSTIC: every route, permission, store table, and validator is DERIVED from the spec +
 * the injected product-table registry at runtime. No product route, table, or name is in platform
 * source. The platform main line ships a product-EMPTY registry, so no declared route registers there.
 *
 * NOTE (doc emission): declared routes are registered with raw `app.on(...)` (not zod-openapi's
 * typed `createRoute`), so they do NOT contribute to zod-openapi's typed OpenAPI document. Instead, an
 * OpenAPI 3.1 document is DERIVED from the validated `spec.api[]` at runtime by `emit-openapi.ts` and
 * served at `GET /v1/openapi.json` (registered in `createAuthApp` alongside this call). So the declared
 * routes ARE documented — just via a spec-derived emission rather than zod-openapi's typed registry.
 */

import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Permission } from '@rayspec/auth-core';
import type { StoreConflictKeys } from '@rayspec/db';
import type { BlobStoreFactory, ResolvedHandler } from '@rayspec/platform';
import type { HttpMethod, RaySpec, StoreOp } from '@rayspec/spec';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { Context, MiddlewareHandler } from 'hono';
import type { AppDeps, AppEnv } from '../app-context.js';
import { requireAuth, requirePermission, resolveTenant } from '../http/middleware.js';
import type { MediaTokenService } from '../media/media-token.js';
import { mediaAuth, perUserStreamSemaphore } from '../media/playback-middleware.js';
import { executeAgentRun } from '../routes/runs.js';
import { makeRouteHandler } from './route-handlers.js';
import { makeStoreHandler } from './store-routes.js';
import { makeStreamIngestHandler, makeStreamPlaybackHandler } from './stream-routes.js';

/**
 * Convert an OpenAPI-style path (`/meetings/{id}`) to Hono's param syntax (`/meetings/:id`). The
 * declared grammar uses `{param}`; Hono's router uses `:param`. (The same transform `@hono/zod-openapi`
 * applies internally via `ConvertPathType` for its typed routes — we do it explicitly for raw
 * registration.)
 */
export function toHonoPath(path: string): string {
  return path.replace(/\{([^}/]+)\}/g, ':$1');
}

/**
 * The permission a declared store route requires: read ops (list/get) → `store:read`;
 * mutating ops (create/update/delete) → `store:write` (SENSITIVE — live-membership rechecked). These
 * are the GENERIC product-agnostic CRUD permissions (auth-core authz.ts), not per-store grants.
 */
function storePermission(op: StoreOp): Permission {
  return op === 'list' || op === 'get' ? 'store:read' : 'store:write';
}

/**
 * Register a route for any HttpMethod behind the EXACT auth chain (Hono `app.on`). The handler list
 * is always the fixed 3-middleware + handler tuple every auth route uses (requireAuth → resolveTenant
 * → requirePermission → handler), passed POSITIONALLY (not as a spread array) so it matches Hono's
 * tuple-typed `on` overload rather than the `(method[], path[], handler)` overload. The
 * MiddlewareHandler casts bridge the api-auth `{ Variables }` middleware env to Hono's default env —
 * the SAME middleware objects the typed `app.post(...)` calls in runs.ts/orgs.ts already accept.
 */
function registerOn(
  app: OpenAPIHono<AppEnv>,
  method: HttpMethod,
  path: string,
  m1: MiddlewareHandler,
  m2: MiddlewareHandler,
  m3: MiddlewareHandler,
  handler: (c: Context<AppEnv>) => Promise<Response>,
): void {
  app.on(method, path, m1, m2, m3, handler as MiddlewareHandler);
}

/**
 * Register a route behind its OWN 2-middleware tuple (the playback route). The playback
 * route does NOT use the standard `requireAuth → resolveTenant → requirePermission` chain: it has a
 * DISTINCT auth path (the media-JWT verifier sets the server-derived tenant from the token) + a
 * per-user streaming semaphore. So it mounts `mediaAuth → perUserStreamSemaphore → handler` as its own
 * tuple — `tenant-db.ts`/`resolveTenant` are never touched (the second key chain is fully disjoint).
 */
function registerOn2(
  app: OpenAPIHono<AppEnv>,
  method: HttpMethod,
  path: string,
  m1: MiddlewareHandler,
  m2: MiddlewareHandler,
  handler: (c: Context<AppEnv>) => Promise<Response>,
): void {
  app.on(method, path, m1, m2, handler as MiddlewareHandler);
}

/**
 * Reserved platform path prefixes a declared route must NEVER shadow. `/v1/*` is the auth + run
 * surface (auth/orgs/oauth/runs); `/oidc/*` is the mounted OIDC provider. A declared `api[]` path
 * under either would silently override (or be overridden by) a platform route on the SAME app — a
 * boot-time fail-closed error (this is an api-auth deploy-wiring guard, NOT a @rayspec/spec rule:
 * the spec package is platform-agnostic and knows nothing of these prefixes).
 */
const RESERVED_PATH_PREFIXES = ['/v1/', '/oidc/'] as const;

/** True if a declared route path falls under a reserved platform prefix (exact prefix or the bare prefix). */
function isReservedPath(path: string): boolean {
  return RESERVED_PATH_PREFIXES.some(
    (prefix) => path === prefix || path === prefix.slice(0, -1) || path.startsWith(prefix),
  );
}

/** Build the deps for the declared-route engine — a spec + the resolved product-table registry. */
export interface DeclaredRoutesConfig {
  /** The validated spec whose `api[]` is interpreted. */
  spec: RaySpec;
  /** Declared store name → its runtime Drizzle `PgTable` (built via @rayspec/db buildProductTables). */
  productTables: ReadonlyMap<string, PgTable>;
  /**
   * Declared store name → its CONFLICT-KEY column set (the GLOBAL single-column unique /
   * durable `ON CONFLICT` targets, from `deriveConflictKeys`). Threaded ONLY on the PRODUCT-profile
   * registration path; a store's set is passed to `makeStoreHandler` so a 23505 on a global-unique
   * key column falls to the GENERIC 409 message (never a cross-tenant existence oracle), while a
   * tenant-scoped author-`unique` column is still named. Absent (backend-profile / auth-only) ⇒ every
   * author-`unique` column is tenant-scoped, so any violated unique column is safe to name.
   */
  conflictKeys?: StoreConflictKeys;
  /**
   * the BOOT-LOADED escape-hatch handlers (id → resolved fn + kind). A
   * `{handler}` route resolves its declared handler here + invokes it through the platform's
   * `invokeRouteHandler` (inside a `TenantDb.transaction()` — A2/A3). Absent ⇒ a `{handler}` route
   * fails closed at BOOT (no loader supplied), never a runtime 501-that-should-have-worked.
   */
  handlers?: ReadonlyMap<string, ResolvedHandler>;
  /**
   * the tenant-bound blob backend factory the `stream` (mode:'ingest') arm
   * injects as `init.blob`. A `kind:'stream'` route declared WITHOUT this aborts the BOOT (fail-
   * closed): a stream route exists to move bytes, and there is nowhere to put them without a blob
   * backend. Absent for a stores/api/handler-only deploy (no stream routes). The factory mints a
   * handle ALREADY bound to a tenant — a handler can never supply/override it.
   */
  blobFactory?: BlobStoreFactory;
  /**
   * the media-token service for the `stream` (mode:'playback') arm — the SECOND
   * auth path. It verifies the `?token=` media-JWT (HS256, distinct `RAYSPEC_MEDIA_SIGNING_KEY`) at
   * the playback route's own middleware tuple. A `kind:'stream', mode:'playback'` route declared
   * WITHOUT this aborts the BOOT (fail-closed): a playback route is reachable ONLY via a media token,
   * so without the verifier it would be unauthenticated. Absent for an ingest-only / no-playback
   * deploy. (Built once at the composition root from the distinct media secret.)
   */
  mediaTokenService?: MediaTokenService;
  /**
   * the per-user concurrent-stream cap for the playback route's semaphore (default 4) +
   * the Retry-After (seconds) advertised on saturation. Optional override (a test sets a tiny cap to
   * exercise the 429 deterministically). Per-NODE (in-process) — a multi-node deploy is a future concern.
   */
  playbackMaxStreamsPerUser?: number;
}

/**
 * Register every declared `api[]` route on `app`. Called from `createAuthApp` AFTER the auth/run
 * routes (so the auth surface is the stable base and a declared route inherits the same chain).
 *
 * Fail-closed at BOOT: a `{store}` route whose store is not in `productTables` (a deploy that forgot
 * to build/register the table), or a `{store}` whose `StoreSpec` is missing, ABORTS registration with
 * a clear error — never a route that 500s at request time. (The lint pass already resolved the
 * cross-refs; this is the deploy-wiring check.)
 */
export function registerDeclaredRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: AppDeps,
  config: DeclaredRoutesConfig,
): void {
  const { spec, productTables, handlers, blobFactory, mediaTokenService } = config;
  const storeByName = new Map(spec.stores.map((s) => [s.name, s]));
  // The shared front of the chain — IDENTICAL to every auth/run route (server-derived tenant +
  // live-membership recheck), only the trailing requirePermission(perm) differs per route.
  const auth = requireAuth();
  const tenant = resolveTenant(deps);

  for (const route of spec.api) {
    // Fail-closed at BOOT: a declared route must never shadow a reserved platform prefix (/v1/*,
    // /oidc/*) — it is registered on the SAME app, so a collision would silently override a platform
    // route (or be shadowed by one). Abort the boot with a clear message rather than ship the clash.
    if (isReservedPath(route.path)) {
      throw new Error(
        `registerDeclaredRoutes: route ${route.method} ${route.path} is under a RESERVED platform ` +
          `prefix (${RESERVED_PATH_PREFIXES.join(', ')}) — a declared route may not shadow the ` +
          'auth/run or OIDC surface. Choose a path outside these prefixes.',
      );
    }
    const honoPath = toHonoPath(route.path);
    const action = route.action;

    if (action.kind === 'store') {
      const store = storeByName.get(action.store);
      if (!store) {
        // lint resolves store refs, so this only fires on a code-built spec; abort the boot clearly.
        throw new Error(
          `registerDeclaredRoutes: route ${route.method} ${route.path} references undeclared ` +
            `store '${action.store}'.`,
        );
      }
      const table = productTables.get(action.store);
      if (!table) {
        throw new Error(
          `registerDeclaredRoutes: store '${action.store}' has no registered product table — ` +
            `the deployment must build it (buildProductTables) and register it in TENANT_SCOPED_TABLES.`,
        );
      }
      const perm = storePermission(action.op);
      // Pass this store's conflict-key set (product-profile only) so a global-unique key
      // column is never named in a 409 (cross-tenant oracle); absent ⇒ name any tenant-scoped unique.
      const storeConflictKeys = config.conflictKeys?.get(action.store);
      const handler = makeStoreHandler({
        store,
        table,
        op: action.op,
        deps,
        ...(storeConflictKeys ? { conflictKeys: storeConflictKeys } : {}),
      });
      registerOn(app, route.method, honoPath, auth, tenant, requirePermission(deps, perm), handler);
      continue;
    }

    if (action.kind === 'agent') {
      // Reuse the run surface VERBATIM (sync/SSE, idempotency; async:true enqueues onto the durable
      // worker when wired). The route's fixed agent id is passed; the run input comes from the
      // request body (same StartRunRequest contract).
      const agentId = action.agent;
      // Fail-closed at BOOT (symmetric with the {store} branch): the declared agent must be present
      // in the injected registry. lint resolves agent refs against the spec's agents[], but the
      // RUNTIME registry (deps.agentRegistry) is what executeAgentRun resolves against — a deploy
      // that declared the agent but forgot to register its backend would otherwise 404 at request
      // time instead of failing the boot loudly. Abort registration with a clear deploy-wiring error.
      if (!deps.agentRegistry?.has(agentId)) {
        throw new Error(
          `registerDeclaredRoutes: route ${route.method} ${route.path} references agent '${agentId}' ` +
            'which is not in the injected agent registry — the deployment must register its base spec ' +
            '+ backend (AppDeps.agentRegistry).',
        );
      }
      // (path-param binding — supersedes the prior deferral): a declared agent-route
      // path param (e.g. the `{id}` in `/meetings/{id}/summarize`) is now BOUND into the agent run.
      // We capture the matched params via `c.req.param()` and thread them into `executeAgentRun`,
      // which prepends them to the run input as a clearly-delimited, trusted `Route parameters:` block
      // (see `bindRouteParams` for the documented contract). `body.input` still flows in as before; a
      // route with NO path params behaves EXACTLY as today (the binding is additive).
      //
      // NOTE (A3 / external-exposure hardening deferral): A3's GUC-populating `TenantDb.transaction` covers declared
      // `{store}` route DB access (store-routes.ts) and route-handler DB access; the agent-run path is
      // DELIBERATELY NOT wrapped in a TenantDb.transaction here — that would hold a DB connection
      // across the entire model run and break run-core's streaming persist-before-flush. The agent
      // run delegates persistence to run-core's journal / EventPipeline. Moving run-core's write
      // sites onto the GUC seam is deferred to external-exposure hardening (S0).
      registerOn(
        app,
        route.method,
        honoPath,
        auth,
        tenant,
        requirePermission(deps, 'agent:run'),
        (c) => executeAgentRun(c, deps, agentId, c.req.param()),
      );
      continue;
    }

    if (action.kind === 'handler') {
      // a declared ROUTE handler, WIRED. The handler runs INSIDE a
      // `TenantDb.transaction()` (the GUC seam — A2/A3) via the platform's `invokeRouteHandler`,
      // through the single `HandlerRuntime` indirection. The handler is the escape-hatch fn the
      // loader resolved (path-jailed, fail-closed at boot).
      //
      // AUTHZ: a route handler is trusted-author product logic. By DEFAULT it may READ AND WRITE the
      // tenant's product stores, so it is gated on `store:write` — the SENSITIVE, most-privileged
      // product permission (live-membership rechecked for JWT principals; api-key-grantable with
      // scope). A handler the author opts into `readonly:true` only reads product stores, so its route
      // is gated on `store:read` instead (letting a read-scoped credential reach it, while a
      // write-only credential still cannot). Fail-closed: an absent/false flag keeps the write gate, so
      // a handler that in fact writes is never under-protected. This is product-agnostic (no per-
      // handler grant); the permission is derived from the DECLARED handler (`spec.handlers`) below.
      const handler = handlers?.get(action.handler);
      if (!handler) {
        // No loader supplied (or the handler was not loaded) → abort the BOOT clearly, never ship a
        // route that 500s. lint already resolved the ref against spec.handlers; this is the deploy-
        // wiring check (the composition root must call loadHandlers + pass the map as config.handlers).
        throw new Error(
          `registerDeclaredRoutes: route ${route.method} ${route.path} references handler ` +
            `'${action.handler}' but no loaded handler was supplied (the deployment must call ` +
            'loadHandlers(escapeHatchRoot, spec.handlers) and pass the map). Fail-closed at boot.',
        );
      }
      if (handler.kind !== 'route') {
        // lint enforces route→route-kind; this is the defense-in-depth boot guard.
        throw new Error(
          `registerDeclaredRoutes: route ${route.method} ${route.path} handler '${action.handler}' is ` +
            `kind '${handler.kind}', expected 'route' (fail-closed at boot).`,
        );
      }
      const routeHandler = makeRouteHandler({
        handler,
        productTables,
        deps,
        // pass the media-token service (when wired) so a mint {handler} route receives the
        // `init.mintPlayToken` capability. Absent for a deploy with no media key.
        ...(mediaTokenService ? { mediaTokenService } : {}),
      });
      // Derive the gate from the DECLARED handler (the grammar/author `readonly` flag lives on
      // `spec.handlers`, NOT the code-level ResolvedHandler). Opt-in read-only ⇒ `store:read`;
      // default ⇒ `store:write` (fail-closed).
      const declaredHandler = spec.handlers.find((h) => h.id === action.handler);
      const perm: Permission = declaredHandler?.readonly === true ? 'store:read' : 'store:write';
      registerOn(
        app,
        route.method,
        honoPath,
        auth,
        tenant,
        requirePermission(deps, perm),
        routeHandler,
      );
      continue;
    }

    if (action.kind === 'stream') {
      // the `stream` route interpreter. `mode:'ingest'` is BUILT here (the raw
      // binary write half); `mode:'playback'` (Range/206 media read) lands in S3 and still fails
      // closed at boot below. A stream route resolves a `route`-kind handler (the grammar: a stream
      // handler dispatches through the api chokepoint, like a `{handler}` route) — but the RUNTIME
      // init it receives is a `StreamRouteHandlerInit` (raw Request + blob), not a `RouteHandlerInit`
      // (parsed JSON). That raw-vs-JSON shape is a runtime concern; the loader resolved it as
      // `route`-kind, and makeStreamIngestHandler invokes its fn with the stream init.
      if (action.mode === 'ingest') {
        // A stream route requires a blob backend (it exists to move bytes). Fail-closed at BOOT if the
        // deployment declared a stream route but wired no blob backend — never ship a route that 500s
        // at request time. (This is the deploy-wiring guard the composition root relies on;.)
        if (!blobFactory) {
          throw new Error(
            `registerDeclaredRoutes: route ${route.method} ${route.path} is a stream INGEST route ` +
              `(handler '${action.handler}') but NO blob backend was wired (config.blobFactory is ` +
              'absent). A stream route moves binary bytes through the tenant-bound BlobStore; the ' +
              'deployment must inject a blob backend at the composition root (makeFsBlobStoreFactory). ' +
              'Fail-closed at boot (never a runtime 500).',
          );
        }
        const handler = handlers?.get(action.handler);
        if (!handler) {
          // No loader supplied (or the handler was not loaded) → abort the BOOT clearly (symmetric
          // with the {handler} arm). lint already resolved the ref against spec.handlers; this is the
          // deploy-wiring check (the composition root must call loadHandlers + pass the map).
          throw new Error(
            `registerDeclaredRoutes: route ${route.method} ${route.path} is a stream route referencing ` +
              `handler '${action.handler}' but no loaded handler was supplied (the deployment must call ` +
              'loadHandlers(escapeHatchRoot, spec.handlers) and pass the map). Fail-closed at boot.',
          );
        }
        if (handler.kind !== 'route') {
          // lint enforces stream→route-kind (the grammar: a stream handler is a route-kind handler);
          // this is the defense-in-depth boot guard.
          throw new Error(
            `registerDeclaredRoutes: route ${route.method} ${route.path} stream handler ` +
              `'${action.handler}' is kind '${handler.kind}', expected 'route' (a stream handler is a ` +
              'route-kind handler — fail-closed at boot).',
          );
        }
        // AUTHZ (S2 decision — documented): a stream INGEST handler is arbitrary trusted-author product
        // logic that WRITES (its pointer row + the blob bytes), so it is gated on `store:write` — the
        // SAME sensitive, most-privileged product permission the `{handler}` route uses (live-membership
        // rechecked for JWT principals; api-key-grantable with scope). A raw binary write is a SENSITIVE
        // mutation; we fail-closed to the write gate (never the weaker `store:read`). Product-agnostic.
        const streamHandler = makeStreamIngestHandler({
          handler,
          productTables,
          deps,
          blobFactory,
        });
        registerOn(
          app,
          route.method,
          honoPath,
          auth,
          tenant,
          requirePermission(deps, 'store:write'),
          streamHandler,
        );
        continue;
      }
      // mode:'playback': the Range/206 media read half + the SECOND auth path. The
      // playback route mounts its OWN 2-middleware tuple: the media-JWT verifier (distinct HS256 key —
      // it sets the server-derived tenant from the token) then the per-user streaming semaphore. It
      // does NOT use requireAuth/resolveTenant/requirePermission (the disjoint key chain) — so it never
      // touches tenant-db.ts. The handler is the SAME route-kind stream handler, invoked with the
      // verified-but-not-trusted media `resource` claim; the pack handler re-validates ownership in DB.
      if (!blobFactory) {
        // A playback route serves bytes from the tenant-bound BlobStore — fail-closed if none wired
        // (symmetric with the ingest arm; the composition root relies on this deploy-wiring guard).
        throw new Error(
          `registerDeclaredRoutes: route ${route.method} ${route.path} is a stream PLAYBACK route ` +
            `(handler '${action.handler}') but NO blob backend was wired (config.blobFactory is ` +
            'absent). A playback route streams binary bytes from the tenant-bound BlobStore; the ' +
            'deployment must inject a blob backend at the composition root (makeFsBlobStoreFactory). ' +
            'Fail-closed at boot (never a runtime 500).',
        );
      }
      if (!mediaTokenService) {
        // A playback route is reachable ONLY via a `?token=` media-JWT — without the verifier it would
        // be UNAUTHENTICATED. Fail-closed at BOOT: the deployment must configure the distinct media
        // signing key (RAYSPEC_MEDIA_SIGNING_KEY) at the composition root.
        throw new Error(
          `registerDeclaredRoutes: route ${route.method} ${route.path} is a stream PLAYBACK route ` +
            `(handler '${action.handler}') but NO media-token service was wired (config.mediaTokenService ` +
            'is absent). A playback route is authenticated by a signed ?token= media-JWT (distinct HS256 ' +
            'key); the deployment must set RAYSPEC_MEDIA_SIGNING_KEY at the composition root. ' +
            'Fail-closed at boot (a playback route without a verifier would be unauthenticated).',
        );
      }
      const playbackHandler = handlers?.get(action.handler);
      if (!playbackHandler) {
        throw new Error(
          `registerDeclaredRoutes: route ${route.method} ${route.path} is a stream PLAYBACK route ` +
            `referencing handler '${action.handler}' but no loaded handler was supplied (the deployment ` +
            'must call loadHandlers(escapeHatchRoot, spec.handlers) and pass the map). Fail-closed at boot.',
        );
      }
      if (playbackHandler.kind !== 'route') {
        throw new Error(
          `registerDeclaredRoutes: route ${route.method} ${route.path} stream PLAYBACK handler ` +
            `'${action.handler}' is kind '${playbackHandler.kind}', expected 'route' (a stream handler ` +
            'is a route-kind handler — fail-closed at boot).',
        );
      }
      const streamPlaybackHandler = makeStreamPlaybackHandler({
        handler: playbackHandler,
        productTables,
        deps,
        blobFactory,
      });
      // The playback route's OWN tuple: media-JWT verify → per-user semaphore → handler. NO standard
      // auth chain (the disjoint second key path); tenant-db.ts is never touched.
      registerOn2(
        app,
        route.method,
        honoPath,
        mediaAuth(mediaTokenService),
        perUserStreamSemaphore(
          config.playbackMaxStreamsPerUser !== undefined
            ? { maxPerUser: config.playbackMaxStreamsPerUser }
            : {},
        ),
        streamPlaybackHandler,
      );
      continue;
    }

    // Exhaustiveness guard: every `RouteAction.kind` is handled above (each arm `continue`s
    // or throws). If a new member is added to the closed union without a matching arm, `action` is
    // NOT `never` here and this call is a COMPILE error — a future route kind can never silently
    // fall through. `assertNever` throws (returns `never`), so control never proceeds past it.
    assertNever(action, route);
  }
}

/**
 * Compile-time exhaustiveness assertion for the `RouteAction` union. Typed to accept `never`
 * so an unhandled union member is a COMPILE error at the call site; at RUNTIME (only reachable via a
 * code-built spec that bypassed parse/lint with an unknown kind) it throws fail-closed rather than
 * registering a silently-broken route.
 */
function assertNever(action: never, route: { method: string; path: string }): never {
  throw new Error(
    `registerDeclaredRoutes: route ${route.method} ${route.path} has an unknown action kind ` +
      `${JSON.stringify((action as { kind?: unknown }).kind)} (fail-closed; the RouteAction union ` +
      'gained a member without an interpreter arm).',
  );
}
