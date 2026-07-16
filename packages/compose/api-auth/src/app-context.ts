/**
 * App composition context — the dependencies injected into the Hono app + its middleware/routes.
 *
 * The raw Db is injected here (the boot composition root constructs it via `makeDb` on the MAIN
 * `@rayspec/db` surface — banned by name in the scoped roots but legitimate at the composition root;
 * the test harness uses the per-schema `makeDbWithSchema` on `@rayspec/db/testing`). Request handlers
 * for TENANT-scoped resources receive a forTenant(db, tenantId) handle via resolveTenant; the
 * global-table STORES hold this raw Db (they are the reviewed, whitelisted predicate-exempt modules); a
 * deployment's PRODUCT tables join the tenant chokepoint Set through the SANCTIONED validating registrar
 * `@rayspec/db/composition`. No Hono type leaks into the stores/services.
 */
import type { HttpBindings } from '@hono/node-server';
import type { JwksProvider, RateLimiter, TokenSigner } from '@rayspec/auth-core';
import type { AgentSpec, Backend, BackendId, NeutralTool } from '@rayspec/core';
import type { Db, StoreConflictKeys } from '@rayspec/db';
import type {
  BlobStoreFactory,
  DurableExecutor,
  ResolvedHandler,
  ToolFactory,
} from '@rayspec/platform';
import type { RaySpec } from '@rayspec/spec';
import type { PgTable } from 'drizzle-orm/pg-core';
import type Provider from 'oidc-provider';
import type { MediaTokenService } from './media/media-token.js';
import type { AuthService } from './services/auth-service.js';
import type { ApiKeyStore } from './stores/api-key-store.js';
import type { AuditStore } from './stores/audit-store.js';
import type { IdempotencyStore } from './stores/idempotency-store.js';
import type { IdentityStore } from './stores/identity-store.js';
import type { OrgStore } from './stores/org-store.js';

/**
 * One entry in the MINIMAL agent registry (seam). Resolves an agent `{id}` to a BASE
 * neutral AgentSpec + the neutral Backend that runs it. The run's `input` (and a small set of
 * allowed overrides) comes from the request body and is merged onto this base before validation.
 *
 * ⚠ DELIBERATELY MINIMAL — NOT the declarative engine. The full declarative agent registry
 * (spec-from-config, tooling/stores/api wiring, per-tenant agent definitions) is. This is
 * the smallest seam that lets the HTTP surface run a registered agent end-to-end; it is injected at
 * composition time (a deploy entrypoint / test harness builds the Map). No product-specific code.
 */
export interface AgentRegistryEntry {
  /** The base neutral spec (instructions/model/tools/outputSchema/maxTurns). */
  spec: AgentSpec;
  /** The neutral Backend (one of the three adapters) that runs this agent. */
  backend: Backend;
  /**
   * The PLATFORM-REGISTERED neutral tools (with handlers) this agent may call (
   * trusted-only TS handlers behind the dispatchTool chokepoint). run-core wires them onto the
   * RunContext + builds dispatchTool; the adapter marshals each SDK tool-call into it. Optional.
   *
   * seam: STATIC tools (a test/deploy passes pre-built NeutralTools). declared agents
   * use `toolFactory` instead (below) because a declared tool's escape-hatch handler needs a per-RUN,
   * per-TENANT `HandlerInit` (the `HandlerDb` closes over the run's `TenantDb`), so its `NeutralTool`
   * cannot be static. A declared agent sets `toolFactory`; a statically-wired entry sets `tools`. (If both
   * are set, the run surface prefers `toolFactory` — the tenant-bound one.)
   */
  tools?: NeutralTool[];
  /**
   * build this agent's tenant-bound `NeutralTool[]` for ONE run from the run's
   * `TenantDb`. Each tool's handler is the escape-hatch function the loader resolved, wrapped so
   * dispatchTool's UNCHANGED `(args, signal)` call routes through the single `HandlerRuntime`
   * indirection with an engine-built `ToolHandlerInit` (the tenant-bound `HandlerDb` — corrects A2).
   * The run surface calls this with `forTenant(db, tenantId)` to produce the run's tools. Optional
   * (a no-tool agent / a static-tools entry omits it).
   */
  toolFactory?: ToolFactory;
}

/** The injected agent registry: agent id → its base spec + backend. */
export type AgentRegistry = ReadonlyMap<string, AgentRegistryEntry>;

/**
 * The declarative-engine input wired into `createAuthApp`. When supplied, the
 * composition root has loaded + validated a `RaySpec` and built the runtime product tables;
 * `createAuthApp` interprets `spec.api[]` and registers each declared route on the SAME app behind
 * the SAME middleware chain. OPTIONAL: an auth-only deploy / a unit suite omits it (no declared
 * routes). PRODUCT-AGNOSTIC: the platform main line ships nothing here; a deployment / the throwaway
 * test fixture builds it from its own `rayspec.yaml`.
 */
export interface DeclarativeEngine {
  /** The validated spec whose `api[]` is interpreted at boot. */
  spec: RaySpec;
  /**
   * Declared store name → its runtime Drizzle `PgTable` (built via `@rayspec/db` buildProductTables
   * from `spec.stores`). The store-route interpreter resolves a declared `store` name → its table
   * here. The deployment is also responsible for registering these tables in `TENANT_SCOPED_TABLES`
   * (the committed generated tuple) so the TenantDb chokepoint admits them — the platform main line
   * stays product-empty.
   */
  productTables: ReadonlyMap<string, PgTable>;
  /**
   * Declared store name → its CONFLICT-KEY column set (the GLOBAL single-column unique /
   * durable `ON CONFLICT` targets, from `@rayspec/product-yaml` `deriveConflictKeys`). Supplied ONLY on
   * the PRODUCT-profile boot path (`product-boot`); `createAuthApp` threads each store's set into its
   * store-route handler so a 23505 on a global-unique key column falls to the GENERIC 409 message
   * (never a cross-tenant existence oracle), while a tenant-scoped author-`unique` column is still
   * named. Absent (backend-profile / auth-only) ⇒ every author-`unique` column is tenant-scoped, so any
   * violated unique column is safe to name — the secure default.
   */
  conflictKeys?: StoreConflictKeys;
  /**
   * the BOOT-LOADED escape-hatch handlers — handler id → resolved function +
   * kind, produced by `@rayspec/platform`'s `loadHandlers(escapeHatchRoot, spec.handlers)` at
   * composition time (BEFORE `createAuthApp`), path-jailed + fail-closed. Required iff the spec
   * declares `tooling`/`{handler}` routes/`triggers` that reference handlers; an api-only spec may
   * omit it. The composition root (deployment / test fixture) supplies the jailed root + the
   * importer — the platform main line ships none (zero product code).
   */
  handlers?: ReadonlyMap<string, ResolvedHandler>;
  /**
   * the backend INSTANCE per `BackendId` a declared agent selects (the deployment wires
   * the OpenAI/Anthropic/Pi adapter instances; the platform ships none — zero-product-code). The
   * engine builds the agent registry from `spec.agents` by resolving each agent's `backend` here.
   * Required iff the spec declares `agents`; omitted for a stores/api-handler-only spec.
   */
  agentBackends?: ReadonlyMap<BackendId, Backend>;
  /**
   * the composition-root `BlobStoreFactory` the `stream` route interpreter
   * uses to build the tenant-bound `init.blob` per request (`blobFactory(serverDerivedTenantId)`).
   * Injected exactly like `agentBackends` (the platform ships no backend): the deployment wires
   * an fs (or later S3) `BlobStore` backend; a stores/api-without-stream deploy omits it. REQUIRED iff
   * the spec declares ANY `kind:'stream'` route — `registerDeclaredRoutes` fail-closes the BOOT if a
   * stream route is present without this (a stream route exists to move bytes; there is nowhere to
   * put them without a blob backend). The factory mints handles ALREADY bound to a tenant; a handler
   * can never supply/override the tenant (the blob's tenant-prefix-by-construction + path jail are
   * its ENTIRE tenant isolation — it does NOT traverse the SQL chokepoint).
   */
  blobFactory?: BlobStoreFactory;
  /**
   * the media-token service for the `stream` (mode:'playback') arm — the SECOND
   * auth path (HS256, distinct `RAYSPEC_MEDIA_SIGNING_KEY`). Injected exactly like `blobFactory` (the
   * platform builds it from the deployer-configured distinct secret at the composition root). REQUIRED
   * iff the spec declares a `kind:'stream', mode:'playback'` route — `registerDeclaredRoutes`
   * fail-closes the BOOT if a playback route is present without it (a playback route is reachable ONLY
   * via a `?token=` media-JWT; without the verifier it would be unauthenticated). It ALSO powers the
   * `init.mintPlayToken` capability a `{handler}` mint route receives. Absent for a deploy with no
   * playback/mint route.
   */
  mediaTokenService?: MediaTokenService;
  /**
   * the per-user concurrent-stream cap for the playback semaphore (default 4, per-node).
   * Optional override a deployment / a test may tune (a test sets it tiny to exercise the 429
   * deterministically). Absent ⇒ the default.
   */
  playbackMaxStreamsPerUser?: number;
}

/** The Hono app environment (Bindings = raw Node req/res for the OIDC mount; Variables below). */
export type AppEnv = { Bindings: HttpBindings; Variables: AppVariables };

/** The variables the middleware chain attaches to the Hono context. */
export interface AppVariables {
  requestId: string;
  /** Set by authenticate when a principal is resolved. */
  principal?: AuthContext;
  /** Set by resolveTenant once a server-derived tenant is established. */
  tenantId?: string;
}

/** A resolved principal — the two-principals-one-model abstraction. */
export interface AuthContext {
  kind: 'user' | 'apikey' | 'm2m';
  userId?: string;
  /** The active org/tenant (from session.current_org or api_key.org_id) — server-derived ONLY. */
  orgId?: string;
  /** The role claim (user principals) — NEVER trusted for sensitive writes (authz re-checks live). */
  role?: string;
  scopes: string[];
  /** The session id (user/cookie principals) for revocation/rotation. */
  sessionId?: string;
  /** The api-key id (apikey/m2m principals). */
  apiKeyId?: string;
}

/** One enqueued (fresh) durable run produced by a reprocess. */
export interface ReprocessEnqueued {
  /** The workflow id that was re-driven. */
  readonly workflowId: string;
  /** The FRESH durable run id (distinct from the session's original finalized run). */
  readonly runId: string;
}

/**
 * The outcome of a reprocess attempt. `found:false` means the session does not exist for the
 * REQUESTING tenant (a foreign/absent session) — the route maps it to a uniform 404 (no existence
 * leak). `found:true` carries every fresh durable run the reprocess enqueued.
 */
export type SessionReprocessResult =
  | { readonly found: false }
  | { readonly found: true; readonly enqueued: readonly ReprocessEnqueued[] };

/**
 * The OPERATIONAL "reprocess a session" seam (opt-in, injected — omit ⇒ the route fail-closes 501,
 * like async runs without a durable worker). Re-drives the workflow a product declared on a session's
 * finalized event as a FRESH durable run — a DISTINCT idempotency key so it is NOT deduped to the
 * session's original finalized run — over the session's CURRENT authoritative store state (a recovery
 * path so re-running extraction after a fix / recovering a stuck session needs no manual DB surgery).
 *
 * PRODUCT-AGNOSTIC from api-auth's view (opaque): the concrete implementation — wired by the
 * composition root — owns the tenant-scoped session existence check and the finalized-event
 * construction, so api-auth carries no product/capability knowledge.
 *
 * TENANT-SCOPED BY CONSTRUCTION: `tenantId` is the caller's SERVER-DERIVED tenant (from the middleware
 * chain); the reprocessor NEVER derives its own tenant and its session read is tenant-scoped, so a
 * tenant can only reprocess ITS OWN session (a foreign/absent session → `found:false` → 404).
 */
export interface SessionReprocessor {
  reprocessSession(input: {
    /** The caller's server-derived tenant (never client-supplied). */
    readonly tenantId: string;
    /** The session to reprocess (the only client-supplied datum — the store state is re-read, not trusted). */
    readonly sessionId: string;
    /** Advisory operator context recorded alongside the reprocess (optional; never trusted for logic). */
    readonly reason?: string;
  }): Promise<SessionReprocessResult>;
}

/** Everything the app needs, wired once at construction. */
export interface AppDeps {
  db: Db;
  signer: TokenSigner;
  jwks: JwksProvider;
  rateLimiter: RateLimiter;
  identityStore: IdentityStore;
  orgStore: OrgStore;
  apiKeyStore: ApiKeyStore;
  auditStore: AuditStore;
  idempotency: IdempotencyStore;
  authService: AuthService;
  /** Optional mounted OIDC provider (omit to skip the /oidc mount in unit-only suites). */
  oidcProvider?: Provider;
  /** Allowed Origins for cookie-authenticated CSRF checks. */
  allowedOrigins: string[];
  /**
   * Trusted-proxy CIDRs (e.g. the deployment's load balancer / ingress hops). The rate limiter's
   * client-identity resolution honors an `X-Forwarded-For` / `X-Real-IP` header ONLY when the socket
   * peer is inside one of these — otherwise the SOCKET PEER is the identity, so a direct caller cannot
   * spoof its identity (evade a per-source throttle / poison another source's bucket) via a forwarding
   * header. Absent/empty ⇒ no forwarding header is ever trusted (the peer is always the identity); a
   * deployment behind a proxy opts in with its proxy CIDRs via the RAYSPEC_TRUSTED_PROXIES deploy env.
   */
  trustedProxies?: readonly string[];
  /**
   * Deployer-injected EXTRA CORS request headers, appended to the platform base set (Authorization,
   * Content-Type, X-Request-Id, Idempotency-Key, Last-Event-Id). A product whose native client sends
   * a custom request header injects it here at deploy (via ALLOWED_REQUEST_HEADERS). Absent/empty ⇒
   * base set only — the platform ships NO product-specific header.
   */
  allowedRequestHeaders?: string[];
  /**
   * operator gate. When `true`, a NON-browser client that opts in
   * (`deliverRefreshTokenInBody`) on register/login/refresh receives the rotated refresh secret in
   * the JSON body (and the Set-Cookie is skipped — one channel per request). Default `false` ⇒
   * today's posture byte-for-byte (the opt-in field is ignored; the secret rides the cookie only).
   * Resolved at boot from `RAYSPEC_BODY_REFRESH_ENABLED` (strict `=== 'true'`).
   */
  bodyRefreshEnabled: boolean;
  /**
   * The MINIMAL agent registry (seam) — agent id → base spec + backend. Optional so
   * unit-only auth suites can skip it; the runs routes 404 an unknown/absent agent id. The full
   * declarative engine is. Server-derived tenant scoping is enforced by the SAME middleware
   * chain as every other route (the registry holds NO tenant data).
   */
  agentRegistry?: AgentRegistry;
  /**
   * The declarative engine — a validated RaySpec + the runtime product
   * tables. When supplied, `createAuthApp` interprets `spec.api[]` and registers each declared route
   * on the SAME app behind the SAME middleware chain. Omit for an auth-only deploy / unit suite.
   */
  engine?: DeclarativeEngine;
  /**
   * Optional override for the in-request agent-run wall-clock timeout (ms). Defaults to the run
   * surface's DEFAULT_RUN_TIMEOUT_MS (120s). A deploy may tune it; a test sets it tiny to exercise
   * the held-request timeout (→ 504 GATEWAY_TIMEOUT) deterministically without a 120s wait.
   */
  runTimeoutMs?: number;
  /**
   * the OPTIONAL durable-execution engine (the off-request job spine). When wired, an
   * `async:true` run is RESERVED (runId) → ENQUEUED onto the worker → HTTP 202 + the runId returned
   * immediately (the client streams completion via the existing GET /v1/runs/{id}/events). When
   * ABSENT, an `async:true` request is a clean fail-closed 501 (async requires a configured durable
   * worker + `deployment.durableWorker:true`). Neutral engine-agnostic type (the DBOS
   * adapter lives in @rayspec/durable-dbos; api-auth carries no DBOS dependency).
   */
  durableExecutor?: DurableExecutor;
  /**
   * the OPTIONAL operational session-reprocess seam. When wired, `POST /v1/sessions/:id/reprocess`
   * re-drives the session's declared finalized-session workflow as a FRESH durable run (distinct
   * idempotency key). When ABSENT, that route is a clean fail-closed 501 (reprocess requires a
   * configured durable workflow reprocessor). PRODUCT-AGNOSTIC: the concrete implementation is wired by
   * the composition root; the platform main line ships none.
   */
  sessionReprocessor?: SessionReprocessor;
  /**
   * OPTIONAL override for the per-request JSON/body byte cap the route interpreters enforce on
   * body-bearing routes (register/login, the declared `{handler}` + store CRUD routes, reprocess). A
   * body over the cap is rejected with a 413 BEFORE it is buffered/parsed, so an authenticated caller
   * cannot stream an unbounded body into memory. Absent ⇒ `DEFAULT_MAX_JSON_BODY_BYTES` (1 MiB), which
   * is generous for a JSON API body; a deploy may tune it (a test sets it tiny to exercise the 413).
   */
  maxJsonBodyBytes?: number;
  /**
   * OPTIONAL server-side error logger (DI seam). `createAuthApp`'s OUTERMOST middleware emits exactly
   * ONE line for EVERY 5xx response through this — both a THROWN error (mapped by `onError`) AND a
   * directly-RETURNED 5xx (e.g. the sync-run 502/504), carrying requestId + status + (for a thrown
   * error) code + message/stack. ABSENT ⇒ the default `console.error` (the codebase's operational-log
   * style). A test injects a spy to assert one 5xx line fired (and that a 4xx fires none). It is called
   * SERVER-SIDE ONLY — this line is NEVER sent to the client (the client still gets the bare envelope).
   * A curated error (an `ApiError`, incl. the 409) carries only a code + a static message and never a
   * row value; a RAW unexpected-error message/stack (the uncontrolled-500 path) MAY embed caller input
   * (standard operational logging, acceptable because it stays server-side). It MUST NOT throw or do a
   * DB write — the middleware guards the call (a 5xx may be happening DURING an outage), and a thrown
   * logger is swallowed so a failed log never turns a 5xx into a crash.
   */
  logError?: (line: string, detail?: unknown) => void;
}
