/**
 * The Hono app factory — the first HTTP server.
 *
 * Uses @hono/zod-openapi's OpenAPIHono (the framework choice). The ordered middleware chain
 * (requestId, securityHeaders, authenticate, resolveTenant, requirePermission) is the single
 * request chokepoint; routes are mounted per resource. A global onError maps ApiError + Zod
 * failures to the closed ErrorCode envelope with the request id. The OIDC provider (if supplied)
 * is mounted under /oidc via the interop-spike-proven raw-handler bridge.
 *
 * Boot-fails-closed: assertBootSecrets() runs at construction — the app REFUSES to build without
 * RAYSPEC_JWT_SIGNING_KEY AND RAYSPEC_API_KEY_PEPPER.
 */

import { OpenAPIHono } from '@hono/zod-openapi';
import {
  ApiError,
  assertBootSecrets,
  type ErrorCode,
  errorEnvelope,
  STATUS_BY_CODE,
} from '@rayspec/auth-core';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import { ZodError } from 'zod';
import type { AppDeps, AppEnv } from './app-context.js';
import { buildAgentRegistry } from './engine/build-agent-registry.js';
import { buildDeclaredRoutesOpenApi } from './engine/emit-openapi.js';
import { registerDeclaredRoutes } from './engine/register-declared-routes.js';
import { authenticate, requestId, securityHeaders } from './http/middleware.js';
import { mountOidc } from './oidc/mount.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerOAuthRoutes } from './routes/oauth.js';
import { registerOrgRoutes } from './routes/orgs.js';
import { registerRunsRoutes } from './routes/runs.js';

/** A ContentfulStatusCode-compatible cast for Hono's c.json status arg. */
type HttpStatus = Parameters<Context['json']>[1];

/**
 * Pre-mount cap on the OAuth token request body (input-size bound). A legitimate
 * client_credentials / authorization_code+PKCE token body is well under 1 KiB; 8 KiB is a generous
 * ceiling that still rejects an abusive oversized body (and, since the body is form-urlencoded, an
 * over-long scopes-array) BEFORE the provider parses it.
 */
export const OAUTH_TOKEN_MAX_BODY_BYTES = 8 * 1024;

/**
 * True if `path` resolves to the provider's token endpoint under the OIDC mount.
 *
 * The guard MUST match every path variant the provider's own router serves as `/token`, or an
 * attacker bypasses the rate-limit + size-cap by hitting a variant the guard misses. The mount
 * hands the raw req straight to oidc-provider, whose @koa/router (verified doc-first against
 * oidc-provider 9.8.5 / @koa/router 15.6.0: routes.token = '/token', non-strict + non-sensitive
 * matching) accepts `/token`, `/token/` (trailing slash) AND case variants (`/Token`, `/TOKEN`).
 * Hono's own `/oidc/*` catch-all likewise forwards `/oidc/token/` and mixed-case `/oidc/Token`.
 * So we normalise (lowercase + strip a single trailing slash + drop the query) and compare against
 * `/oidc/token`. (A request with a different case in the `/oidc` prefix — e.g. `/OIDC/...` — never
 * matches Hono's lowercase `/oidc/*` mount, so it cannot reach the provider and needs no guard.)
 */
export function isOidcTokenPath(path: string): boolean {
  const noQuery = path.split('?', 1)[0] ?? path;
  const trimmed = noQuery.length > 1 && noQuery.endsWith('/') ? noQuery.slice(0, -1) : noQuery;
  return trimmed.toLowerCase() === '/oidc/token';
}

export function createAuthApp(deps: AppDeps): OpenAPIHono<AppEnv> {
  // Boot-fails-closed: refuse to construct without BOTH boot-required secrets.
  assertBootSecrets();

  const app = new OpenAPIHono<AppEnv>({
    // defaultHook turns Zod validation failures from zod-openapi routes into the VALIDATION_ERROR
    // envelope. Manual-validated routes throw ZodError, mapped in onError below.
    defaultHook: (result, c) => {
      if (!result.success) {
        const rid = c.get('requestId') ?? 'unknown';
        return c.json(
          errorEnvelope(
            'VALIDATION_ERROR',
            'Request validation failed.',
            rid,
            formatZod(result.error),
          ),
          400,
        );
      }
    },
  });

  // --- the shared middleware prefix (order is load-bearing) ---------------------------------
  app.use('*', requestId);
  app.use('*', securityHeaders);
  // serve CORS for the configured cross-origin allowlist (a generic platform feature, NOT
  // product-specific). A native WKWebView / cross-origin browser client uses a plain `fetch`; without
  // these response headers a cross-origin request from an allow-listed origin is blocked by the
  // browser (the native path otherwise needs a dev Vite proxy). FAIL-CLOSED: registered ONLY when
  // `allowedOrigins` is non-empty — an unset/empty `ALLOWED_ORIGINS` (the loadServerConfig default,
  // composition-root.ts) registers NOTHING, so the current same-origin behaviour is byte-preserved
  // and no `Access-Control-*` header is ever emitted (incl. on an OPTIONS preflight).
  //
  // Mounted on `*` (NOT `/v1/*`) so it also covers the declared product routes (`/sessions/*`) and the
  // root `/health`. `origin` is the ARRAY `deps.allowedOrigins` — hono/cors (verified doc-first vs
  // hono@4.12.26 dist/middleware/cors) ECHOES a matched origin exactly and emits NOTHING for an
  // unmatched origin (never `*` for an array), and sets `Vary: Origin` on both the preflight and the
  // post-handler path. The preflight OPTIONS short-circuits with a fresh 204 and does NOT call
  // `next()` — so it never reaches `authenticate`/the route handlers (a preflight cannot bypass auth).
  //
  // This is the SAME single allowlist the cookie-endpoint CSRF guard already uses
  // (isCsrfSafeForCookieEndpoint → `allowedOrigins.includes(origin)`) — identical match semantics, no
  // new trust surface: CORS is a response-header grant only; the auth/tenant chokepoint stays the
  // access control.
  //
  // `credentials` is OMITTED (false) — the client is bearer-only; the refresh cookie is
  // `__Host-…; SameSite=Strict` (not cross-site usable). Enabling credentials would be a separate,
  // deliberate cookie-SPA decision (D-FU1), so we do NOT, and we never emit
  // `Access-Control-Allow-Credentials: true`.
  //
  // `allowHeaders`: the platform BASE set is `Authorization`/`Content-Type` (the safelisted request
  // headers a bearer client needs) plus `X-Request-Id`, `Idempotency-Key`, and `Last-Event-Id` so the
  // platform's request-id echo, idempotency-keyed run POSTs, and SSE resume paths are usable
  // cross-origin. Any product whose native client sends a custom (non-safelisted) request header
  // injects it via `deps.allowedRequestHeaders` at deploy (from ALLOWED_REQUEST_HEADERS) — the
  // platform hardcodes NO product-specific header. The `new Set([...])` dedups an injected header that
  // already appears in the base set. (hono/cors — verified doc-first vs hono@4.12.26 — echoes this
  // explicit list verbatim into `Access-Control-Allow-Headers`; an extra entry is purely additive.)
  if (deps.allowedOrigins.length > 0) {
    app.use(
      '*',
      cors({
        origin: deps.allowedOrigins,
        allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowHeaders: [
          ...new Set([
            'Authorization',
            'Content-Type',
            'X-Request-Id',
            'Idempotency-Key',
            'Last-Event-Id',
            ...(deps.allowedRequestHeaders ?? []),
          ]),
        ],
        exposeHeaders: ['X-Request-Id'],
        maxAge: 600,
      }),
    );
  }
  app.use('*', authenticate(deps));

  // if the declarative engine supplies `agents` + their backends
  // + the loaded handlers, build the agent registry FROM THE SPEC and merge it into the registry the
  // run surface resolves against — so a declared agent runs through the EXISTING runAgent/
  // executeAgentRun (zero new agent-execution code). The spec-derived entries carry a per-run,
  // tenant-bound `toolFactory` (declared tooling → NeutralTool via the dispatchTool chokepoint).
  // A directly-injected `deps.agentRegistry` (the seam / a test) is preserved; the spec entries
  // augment it (a declared id overrides a same-id direct entry — the spec is the engine's source).
  const effectiveDeps = withDeclaredAgents(deps);

  // --- routes -------------------------------------------------------------------------------
  registerAuthRoutes(app, effectiveDeps);
  registerOrgRoutes(app, effectiveDeps);
  registerOAuthRoutes(app, effectiveDeps);
  // agent-run HTTP/SSE routes on the SAME middleware chain (server-derived tenant). Uses
  // the effective deps so a declared agent (spec-built registry entry) resolves on /v1/agents/:id/runs
  // too — one registry, both surfaces.
  registerRunsRoutes(app, effectiveDeps);
  // the declarative engine — interpret `api[]` and register each
  // declared route on THIS app behind the SAME middleware chain. The `{handler}` route now resolves
  // its declared handler from the boot-loaded map. Omitted ⇒ an auth-only app (the platform
  // main line ships no declared routes).
  if (effectiveDeps.engine) {
    // serve the OpenAPI document DERIVED from the declared `api[]` at GET /v1/openapi.json. The
    // declared routes register raw (app.on), so they are absent from zod-openapi's typed document; we
    // emit a runtime-derived document instead (product-agnostic — a product-empty spec emits empty
    // `paths`). Registered on the engine path only; the platform main line (no engine) serves none.
    // It is a public, non-sensitive structural read (no secrets; OpenAPI docs are conventionally
    // open) — registered BEFORE the declared routes so a declared route can never shadow it.
    const openApiDoc = buildDeclaredRoutesOpenApi(effectiveDeps.engine.spec);
    app.get('/v1/openapi.json', (c) =>
      c.json(openApiDoc as unknown as Record<string, unknown>, 200),
    );

    registerDeclaredRoutes(app, effectiveDeps, {
      spec: effectiveDeps.engine.spec,
      productTables: effectiveDeps.engine.productTables,
      handlers: effectiveDeps.engine.handlers,
      // the tenant-bound blob backend the `stream` arm injects as `init.blob`. Absent ⇒
      // a declared `stream` route fails closed at BOOT (the interpreter requires a blob backend).
      blobFactory: effectiveDeps.engine.blobFactory,
      // the media-token service for the playback arm's 2nd auth path + the mint capability.
      // Absent ⇒ a declared `stream` playback route fails closed at BOOT (requires the media verifier).
      mediaTokenService: effectiveDeps.engine.mediaTokenService,
      // the per-user playback stream cap (default 4). Spread so absent ⇒ the default.
      ...(effectiveDeps.engine.playbackMaxStreamsPerUser !== undefined
        ? { playbackMaxStreamsPerUser: effectiveDeps.engine.playbackMaxStreamsPerUser }
        : {}),
    });
  }

  // --- OIDC mount (raw-handler bridge) ------------------------------------------------------
  if (deps.oidcProvider) {
    // The /oidc catch-all hands the raw req/res straight to the provider and bypasses the
    // per-route guards the auth routes use, so we guard the TOKEN path HERE (a thin Hono
    // middleware on the WHOLE /oidc prefix, BEFORE the catch-all). It runs for every /oidc request
    // but only ENFORCES on the token endpoint (isOidcTokenPath — matches the same trailing-slash +
    // case variants the provider's router serves, so a variant cannot slip past). Two real,
    // pre-mount bounds:
    // 1.: rate-limit the token endpoint (credential-stuffing + client-secret
    //      brute-force). Only the token endpoint is throttled — discovery/JWKS are public reads.
    // 2. input-size bound: reject an oversized request body BEFORE the provider parses
    //      it. The body is form-urlencoded; a huge `scope` array (or any field) inflates the body,
    //      so a byte cap bounds the token body AND the scopes-array length pre-mount. We do NOT
    //      read the body itself — the mount needs the raw stream intact — so the cap is on the
    //      declared Content-Length. A request that carries a body (POST/PUT/PATCH) MUST declare a
    //      finite, in-budget Content-Length: an ABSENT or non-numeric length (or chunked transfer)
    //      would let an attacker stream an unbounded body straight past the cap, so we REJECT it.
    //      A real OAuth client always sends a Content-Length on its small form body.
    app.use('/oidc/*', async (c, next) => {
      if (!isOidcTokenPath(c.req.path)) return next();
      const ip = c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip') ?? 'unknown';
      const { allowed, retryAfterMs } = deps.rateLimiter.check('oauth-token', ip);
      if (!allowed) throw new ApiError('RATE_LIMITED', 'Too many requests.', { retryAfterMs });
      // Only body-bearing methods need the size bound; GET/HEAD/OPTIONS carry no token body.
      const method = c.req.method.toUpperCase();
      if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
        const lenHeader = c.req.header('content-length');
        const len = lenHeader === undefined ? Number.NaN : Number.parseInt(lenHeader, 10);
        if (!Number.isFinite(len) || len < 0 || len > OAUTH_TOKEN_MAX_BODY_BYTES) {
          // Covers oversized, absent, and chunked/unbounded bodies — none reach the provider.
          throw new ApiError('VALIDATION_ERROR', 'OAuth token request body is too large.');
        }
      }
      await next();
    });
    app.route('/oidc', mountOidc(deps.oidcProvider));
  }

  // --- global error handler → the closed envelope ------------------------------------------
  app.onError((err, c) => {
    const rid = c.get('requestId') ?? 'unknown';
    // Every 5xx emits ONE server-side log line (requestId + error) — the 500 branch was a silent
    // swallow. A 4xx (incl. the 409 conflict + 400/401/403/404/429) emits NONE. The status is the
    // SAME one the response below returns, so the two never diverge.
    const status =
      err instanceof ApiError ? STATUS_BY_CODE[err.code] : err instanceof ZodError ? 400 : 500;
    if (status >= 500) logServerError(deps, rid, err);
    if (err instanceof ApiError) {
      return c.json(
        errorEnvelope(err.code, err.message, rid, err.details),
        STATUS_BY_CODE[err.code] as HttpStatus,
      );
    }
    if (err instanceof ZodError) {
      return c.json(
        errorEnvelope('VALIDATION_ERROR', 'Request validation failed.', rid, formatZod(err)),
        400,
      );
    }
    // Unexpected → 500, no internals leaked (the log line above already carried the detail server-side).
    return c.json(errorEnvelope('INTERNAL', 'Internal server error.', rid), 500);
  });

  // --- uniform 404 for unknown routes -------------------------------------------------------
  app.notFound((c) => {
    const rid = c.get('requestId') ?? 'unknown';
    return c.json(errorEnvelope('NOT_FOUND', 'Not found.', rid), 404);
  });

  return app;
}

/**
 * return `deps` with the declarative engine's DECLARED agents merged into the agent
 * registry. When the engine supplies `agents` + `agentBackends` + the loaded `handlers`, build the
 * spec-derived `AgentRegistry` (each entry: base AgentSpec + selected Backend + per-run tenant-bound
 * `toolFactory`) and merge it over any directly-injected `deps.agentRegistry` (the seam / a test).
 * A spec-declared id WINS over a same-id direct entry — the spec is the engine's source of truth.
 *
 * No-op (returns `deps` unchanged) when there is no engine, no declared agents, or the backends/
 * handlers are not supplied (an api/stores-only deploy) — so an auth-only or statically-wired app is
 * untouched. FAIL-CLOSED at boot inside `buildAgentRegistry` on a missing backend / unloaded handler.
 */
function withDeclaredAgents(deps: AppDeps): AppDeps {
  const engine = deps.engine;
  if (!engine || engine.spec.agents.length === 0) return deps;
  // Spec-derived agents are built ONLY when the deployment wires `agentBackends` (the backend
  // instances the platform cannot ship — zero-product-code). Absent ⇒ the deployment is using the
  // DIRECTLY-injected `deps.agentRegistry` (the seam / a test that supplies its own
  // registry + a fake backend), so we leave `deps` unchanged. This keeps the two registry sources
  // non-conflicting: a deploy either declares agents+backends (engine-built) or injects a registry.
  if (!engine.agentBackends) return deps;
  const declared = buildAgentRegistry({
    spec: engine.spec,
    agentBackends: engine.agentBackends,
    handlers: engine.handlers ?? new Map(),
    productTables: engine.productTables,
    // thread the wired blob backend so a declared tool's init carries a tenant-bound
    // `init.blob` (the SAME factory the route/stream arms use). Absent on a no-blob-backend deploy.
    ...(engine.blobFactory ? { blobFactory: engine.blobFactory } : {}),
  });
  // Merge: direct entries first, spec-declared entries override on id collision (spec is the source).
  const merged = new Map(deps.agentRegistry ?? []);
  for (const [id, entry] of declared) merged.set(id, entry);
  return { ...deps, agentRegistry: merged };
}

/**
 * Emit exactly ONE server-side log line for a 5xx response. SERVER-SIDE only (the client still gets
 * the bare envelope) — carries the requestId, the closed error code, and the error message; the stack
 * rides as a second argument for the console. It NEVER carries a request body, secret, or
 * foreign-tenant value. Fail-safe: a 5xx may be happening DURING a DB/logging outage, so the log path
 * does NO DB write and NEVER throws — a thrown/absent logger is swallowed so a failed log can never
 * turn a 5xx into a crash.
 */
function logServerError(deps: AppDeps, requestId: string, err: unknown): void {
  try {
    const code: ErrorCode = err instanceof ApiError ? err.code : 'INTERNAL';
    const message = err instanceof Error ? err.message : String(err);
    const line = `[api-auth] 5xx requestId=${requestId} code=${code}: ${message}`;
    const stack = err instanceof Error ? err.stack : undefined;
    const log = deps.logError ?? defaultLogError;
    log(line, stack);
  } catch {
    /* the error path must never throw — a failed log must not turn a 5xx into a crash */
  }
}

/** Default 5xx logger: the codebase's operational `console.error('[prefix] …')` style. */
function defaultLogError(line: string, detail?: unknown): void {
  if (detail !== undefined) console.error(line, detail);
  else console.error(line);
}

/** Compact, non-leaky Zod error detail (field paths + messages only). */
function formatZod(err: ZodError): { issues: { path: string; message: string }[] } {
  return {
    issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  };
}

/** Re-export so a consumer that only wants the type does not import the whole module graph. */
export type { ErrorCode };
