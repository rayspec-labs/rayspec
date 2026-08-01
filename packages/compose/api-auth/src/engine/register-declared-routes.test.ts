/**
 * Boot-time fail-closed unit tests for the declared-route registrar.
 *
 * These assert `registerDeclaredRoutes` ABORTS THE BOOT (throws synchronously, before any request)
 * on a deploy-wiring mistake — never ships a route that 404s/500s/shadows at request time:
 *   - a `{agent}` route whose agent is absent from the injected registry (symmetric with the
 *     {store} branch's missing-product-table boot-fail);
 *   - a declared route under a RESERVED platform prefix (/v1/*, /oidc/*).
 *
 * No DB: the registrar throws while WIRING routes (before any handler runs), so a minimal app + a
 * minimal AppDeps cast is sufficient — the failure path never touches deps.db / the stores.
 */

import { OpenAPIHono } from '@hono/zod-openapi';
import type { Permission, RateLimitPolicy } from '@rayspec/auth-core';
import { RateLimiter } from '@rayspec/auth-core';
import type { BlobStore, BlobStoreFactory, ResolvedHandler } from '@rayspec/platform';
import type { ApiRouteSpec, HandlerSpec, RaySpec } from '@rayspec/spec';
import type { PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import type { AgentRegistry, AppDeps, AppEnv } from '../app-context.js';
import { requirePermission } from '../http/middleware.js';
import type { MediaTokenService } from '../media/media-token.js';
import { registerDeclaredRoutes, toHonoPath } from './register-declared-routes.js';
import { DEFAULT_ROUTE_RATE_TIERS } from './route-rate-limit.js';

// Spy on `requirePermission` so a route-registration test can assert WHICH permission a declared
// route is wired behind (the middleware itself is never run here — the registrar throws/records at
// wiring time). The real implementation is preserved; only the call is recorded.
vi.mock('../http/middleware.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../http/middleware.js')>();
  return { ...actual, requirePermission: vi.fn(actual.requirePermission) };
});

// A minimal, shape-valid RaySpec with overridable `api`/`agents`. The boot-fail paths under test
// throw during route wiring, so only `api`/`agents`/`stores` are consulted.
function makeSpec(overrides: Partial<RaySpec> = {}): RaySpec {
  return {
    version: '1.0',
    metadata: { name: 'test', description: 't' },
    stores: [],
    api: [],
    agents: [],
    tooling: [],
    triggers: [],
    handlers: [],
    ...overrides,
  } as RaySpec;
}

// A minimal AppDeps — only `agentRegistry` is read on the failure paths (requireAuth()/resolveTenant
// /requirePermission build middleware but never run here). The rest is cast (never dereferenced).
function makeDeps(agentRegistry?: AgentRegistry): AppDeps {
  return { agentRegistry } as unknown as AppDeps;
}

const emptyTables: ReadonlyMap<string, PgTable> = new Map();

function register(spec: RaySpec, deps: AppDeps): void {
  const app = new OpenAPIHono<AppEnv>();
  registerDeclaredRoutes(app, deps, { spec, productTables: emptyTables });
}

describe('registerDeclaredRoutes — {agent} boot-time fail-closed (agent must be in the registry)', () => {
  const agentRoute: ApiRouteSpec = {
    method: 'POST',
    path: '/run',
    action: { kind: 'agent', agent: 'ghost' },
  };

  it('aborts the boot when the declared agent is NOT in the injected registry', () => {
    // No registry at all → fail closed.
    expect(() => register(makeSpec({ api: [agentRoute] }), makeDeps(undefined))).toThrow(
      /agent 'ghost'.*not in the injected agent registry/s,
    );
    // A registry that lacks the agent → also fail closed.
    const otherAgent: AgentRegistry = new Map([
      ['someone-else', { spec: {} as never, backend: {} as never }],
    ]);
    expect(() => register(makeSpec({ api: [agentRoute] }), makeDeps(otherAgent))).toThrow(
      /agent 'ghost'.*not in the injected agent registry/s,
    );
  });

  it('registers fine when the declared agent IS present (no throw)', () => {
    const registry: AgentRegistry = new Map([
      ['ghost', { spec: {} as never, backend: {} as never }],
    ]);
    expect(() => register(makeSpec({ api: [agentRoute] }), makeDeps(registry))).not.toThrow();
  });
});

describe('registerDeclaredRoutes — reserved-namespace boot guard (no /v1/* or /oidc/* shadowing)', () => {
  const registry: AgentRegistry = new Map([['ghost', { spec: {} as never, backend: {} as never }]]);

  it('aborts the boot for a declared route under /v1/* (would shadow the auth/run surface)', () => {
    const route: ApiRouteSpec = {
      method: 'GET',
      path: '/v1/agents/abc/runs',
      action: { kind: 'agent', agent: 'ghost' },
    };
    expect(() => register(makeSpec({ api: [route] }), makeDeps(registry))).toThrow(
      /RESERVED platform prefix/,
    );
  });

  it('aborts the boot for a declared route under /oidc/* (would shadow the OIDC mount)', () => {
    const route: ApiRouteSpec = {
      method: 'POST',
      path: '/oidc/token',
      action: { kind: 'agent', agent: 'ghost' },
    };
    expect(() => register(makeSpec({ api: [route] }), makeDeps(registry))).toThrow(
      /RESERVED platform prefix/,
    );
  });

  it('aborts even for the BARE reserved prefix (e.g. exactly /v1)', () => {
    const route: ApiRouteSpec = {
      method: 'GET',
      path: '/v1',
      action: { kind: 'agent', agent: 'ghost' },
    };
    expect(() => register(makeSpec({ api: [route] }), makeDeps(registry))).toThrow(
      /RESERVED platform prefix/,
    );
  });

  it('allows a non-reserved path (e.g. /meetings) — no false positive', () => {
    const route: ApiRouteSpec = {
      method: 'POST',
      path: '/meetings/run',
      action: { kind: 'agent', agent: 'ghost' },
    };
    expect(() => register(makeSpec({ api: [route] }), makeDeps(registry))).not.toThrow();
  });
});

describe('registerDeclaredRoutes — {handler} route boot-time fail-closed (no-DB unit, HANDLER-ROUTE-BOOTFAIL)', () => {
  const handlerRoute: ApiRouteSpec = {
    method: 'POST',
    path: '/custom',
    action: { kind: 'handler', handler: 'custom_route' },
  };
  function registerWith(
    spec: RaySpec,
    handlers: ReadonlyMap<string, ResolvedHandler> | undefined,
  ): void {
    const app = new OpenAPIHono<AppEnv>();
    registerDeclaredRoutes(app, makeDeps(undefined), {
      spec,
      productTables: emptyTables,
      handlers,
    });
  }

  it('ABORTS the boot when config.handlers is OMITTED (no loaded handler for the route)', () => {
    expect(() => registerWith(makeSpec({ api: [handlerRoute] }), undefined)).toThrow(
      /references handler 'custom_route' but no loaded handler/,
    );
  });

  it('ABORTS the boot when config.handlers is EMPTY (handler not loaded)', () => {
    expect(() => registerWith(makeSpec({ api: [handlerRoute] }), new Map())).toThrow(
      /references handler 'custom_route' but no loaded handler/,
    );
  });

  it("ABORTS the boot when the loaded handler is the WRONG kind ('tool', not 'route')", () => {
    const handlers = new Map<string, ResolvedHandler>([
      ['custom_route', { kind: 'tool', fn: async () => ({}) }],
    ]);
    expect(() => registerWith(makeSpec({ api: [handlerRoute] }), handlers)).toThrow(
      /kind 'tool', expected 'route'/,
    );
  });

  it('registers fine when the loaded handler is present + kind:route (no throw)', () => {
    const handlers = new Map<string, ResolvedHandler>([
      ['custom_route', { kind: 'route', fn: async () => ({ ok: true }) }],
    ]);
    expect(() => registerWith(makeSpec({ api: [handlerRoute] }), handlers)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------------
// the `stream` route arm boot guards (no DB; the registrar throws while wiring).
// ---------------------------------------------------------------------------------------
describe('registerDeclaredRoutes — {stream} mode:ingest boot-time fail-closed', () => {
  const ingestRoute: ApiRouteSpec = {
    method: 'POST',
    path: '/uploads/{upload_id}/chunks/{chunk_index}',
    action: { kind: 'stream', handler: 'ingest_h', mode: 'ingest' },
  };
  const playbackRoute: ApiRouteSpec = {
    method: 'GET',
    path: '/uploads/{upload_id}/chunks/{chunk_index}/playback',
    action: { kind: 'stream', handler: 'playback_h', mode: 'playback' },
  };
  // A no-op blob factory — the guards under test throw BEFORE any blob op, so the handle is never used.
  const dummyBlob = {} as BlobStore;
  const dummyBlobFactory: BlobStoreFactory = () => dummyBlob;
  // A no-op media-token service — the guards under test throw BEFORE any verify/mint, so it is unused.
  const dummyMediaService = {} as unknown as MediaTokenService;
  const routeHandlers = new Map<string, ResolvedHandler>([
    ['ingest_h', { kind: 'route', fn: async () => ({}) }],
  ]);

  function register(
    spec: RaySpec,
    handlers: ReadonlyMap<string, ResolvedHandler> | undefined,
    blobFactory: BlobStoreFactory | undefined,
    mediaTokenService?: MediaTokenService,
  ): void {
    const app = new OpenAPIHono<AppEnv>();
    registerDeclaredRoutes(app, makeDeps(undefined), {
      spec,
      productTables: emptyTables,
      ...(handlers ? { handlers } : {}),
      ...(blobFactory ? { blobFactory } : {}),
      ...(mediaTokenService ? { mediaTokenService } : {}),
    });
  }

  // DEPLOY GUARD (fail-the-fix): a stream route with NO blob backend wired → boot aborts.
  it('ABORTS the boot when a stream INGEST route is declared but NO blobFactory is wired', () => {
    expect(() => register(makeSpec({ api: [ingestRoute] }), routeHandlers, undefined)).toThrow(
      /stream INGEST route .* NO blob backend was wired/,
    );
  });

  it('ABORTS the boot when the stream handler is OMITTED (no loaded handler)', () => {
    expect(() => register(makeSpec({ api: [ingestRoute] }), undefined, dummyBlobFactory)).toThrow(
      /stream route referencing handler 'ingest_h' but no loaded handler/,
    );
  });

  it("ABORTS the boot when the stream handler is the WRONG kind ('tool', not 'route')", () => {
    const wrong = new Map<string, ResolvedHandler>([
      ['ingest_h', { kind: 'tool', fn: async () => ({}) }],
    ]);
    expect(() => register(makeSpec({ api: [ingestRoute] }), wrong, dummyBlobFactory)).toThrow(
      /stream handler 'ingest_h' is kind 'tool', expected 'route'/,
    );
  });

  it('registers fine when the stream INGEST route has a loaded route handler + a blobFactory (no throw)', () => {
    expect(() =>
      register(makeSpec({ api: [ingestRoute] }), routeHandlers, dummyBlobFactory),
    ).not.toThrow();
  });

  // PLAYBACK — its OWN boot guards. A playback route is reachable only via the media-JWT, so it
  // requires BOTH a blob backend (to stream bytes) AND a media-token service (the 2nd auth path).
  const playbackHandlers = new Map<string, ResolvedHandler>([
    ['playback_h', { kind: 'route', fn: async () => ({}) }],
  ]);

  it('ABORTS the boot on a PLAYBACK route with NO blob backend wired', () => {
    expect(() =>
      register(makeSpec({ api: [playbackRoute] }), playbackHandlers, undefined, dummyMediaService),
    ).toThrow(/stream PLAYBACK route .* NO blob backend was wired/);
  });

  it('ABORTS the boot on a PLAYBACK route with NO media-token service wired (fail-the-fix)', () => {
    // A playback route without the media verifier would be UNAUTHENTICATED — fail-closed at boot.
    expect(() =>
      register(makeSpec({ api: [playbackRoute] }), playbackHandlers, dummyBlobFactory, undefined),
    ).toThrow(/stream PLAYBACK route .* NO media-token service was wired/);
  });

  it('ABORTS the boot on a PLAYBACK route whose handler is OMITTED', () => {
    expect(() =>
      register(makeSpec({ api: [playbackRoute] }), undefined, dummyBlobFactory, dummyMediaService),
    ).toThrow(/stream PLAYBACK route referencing handler 'playback_h' but no loaded handler/);
  });

  it("ABORTS the boot on a PLAYBACK route whose handler is the WRONG kind ('tool')", () => {
    const wrong = new Map<string, ResolvedHandler>([
      ['playback_h', { kind: 'tool', fn: async () => ({}) }],
    ]);
    expect(() =>
      register(makeSpec({ api: [playbackRoute] }), wrong, dummyBlobFactory, dummyMediaService),
    ).toThrow(/stream PLAYBACK handler 'playback_h' is kind 'tool', expected 'route'/);
  });

  it('registers fine when a PLAYBACK route has a route handler + a blobFactory + a media service (no throw)', () => {
    expect(() =>
      register(
        makeSpec({ api: [playbackRoute] }),
        playbackHandlers,
        dummyBlobFactory,
        dummyMediaService,
      ),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------------
// the `{handler}` route permission derivation: readonly:true → store:read, else store:write.
// ---------------------------------------------------------------------------------------
describe('registerDeclaredRoutes — {handler} readonly gates store:read (default store:write)', () => {
  // Register a single `{handler}` route whose declared handler carries the given `readonly` value
  // (omitted when undefined) and return the permission the registrar wired it behind.
  function permForHandlerRoute(readonly: boolean | undefined): Permission {
    vi.mocked(requirePermission).mockClear();
    const declared: HandlerSpec = {
      id: 'custom_route',
      module: 'handlers/custom.ts',
      export: 'custom',
      kind: 'route',
      ...(readonly === undefined ? {} : { readonly }),
    };
    const spec = makeSpec({
      handlers: [declared],
      api: [
        { method: 'GET', path: '/custom', action: { kind: 'handler', handler: 'custom_route' } },
      ],
    });
    const loaded = new Map<string, ResolvedHandler>([
      ['custom_route', { kind: 'route', fn: async () => ({ ok: true }) }],
    ]);
    const app = new OpenAPIHono<AppEnv>();
    registerDeclaredRoutes(app, makeDeps(undefined), {
      spec,
      productTables: emptyTables,
      handlers: loaded,
    });
    const calls = vi.mocked(requirePermission).mock.calls;
    // exactly one declared route → requirePermission called exactly once
    expect(calls).toHaveLength(1);
    return calls[0]?.[1] as Permission;
  }

  it('a readonly:true handler route is gated store:read', () => {
    expect(permForHandlerRoute(true)).toBe('store:read');
  });

  it('a handler route WITHOUT readonly is gated store:write (default unchanged)', () => {
    expect(permForHandlerRoute(undefined)).toBe('store:write');
  });

  it('an explicit readonly:false handler route is gated store:write (fail-closed on false)', () => {
    expect(permForHandlerRoute(false)).toBe('store:write');
  });
});

describe('toHonoPath — `{param}` → `:param` conversion (linear, no-regex scan)', () => {
  it('converts every legitimate declared path EXACTLY as before', () => {
    expect(toHonoPath('/widgets')).toBe('/widgets');
    expect(toHonoPath('/widgets/{id}')).toBe('/widgets/:id');
    expect(toHonoPath('/x/{a}/y/{b}')).toBe('/x/:a/y/:b');
    expect(toHonoPath('/uploads/{key}/chunk')).toBe('/uploads/:key/chunk');
    const long = `long_${'x'.repeat(100)}`;
    expect(toHonoPath(`/r/{${long}}`)).toBe(`/r/:${long}`);
  });

  it('a long unclosed-`{`-run input does not hang the rewrite (linear scan)', () => {
    // The single forward scan is strictly linear on a pathological unclosed brace — no backtracking.
    const pathological = `/x/{${'a'.repeat(200_000)}`; // 200k chars, no closing brace
    const start = Date.now();
    const out = toHonoPath(pathological);
    expect(Date.now() - start).toBeLessThan(1000);
    // No closing `}` ⇒ nothing to rewrite ⇒ returned unchanged.
    expect(out).toBe(pathological);
  });

  it('a 129+-char param name is rewritten too — the scan is length-SAFE, not length-capped (fail-the-fix)', () => {
    // A route path is only `z.string().min(1)` — a param name has no length cap anywhere, so a 129+
    // char name is schema-legal and MUST still convert. FAIL-THE-FIX: a `[^}/]{1,128}` bounded regex
    // would silently leave `/r/{<129 chars>}` un-rewritten (the brace becomes a literal segment); the
    // no-regex scan converts it just like a short name, and still stays linear.
    const long129 = 'a'.repeat(129);
    expect(toHonoPath(`/r/{${long129}}`)).toBe(`/r/:${long129}`);
    const long5000 = 'z'.repeat(5000);
    expect(toHonoPath(`/r/{${long5000}}`)).toBe(`/r/:${long5000}`);
    // ~65 emoji already exceed 128 UTF-16 code units (2 units each) — still rewritten.
    const emoji = '😀'.repeat(65);
    expect(toHonoPath(`/r/{${emoji}}/s/{ok}`)).toBe(`/r/:${emoji}/s/:ok`);
    // A neighbouring in-bound param on the same path still converts normally.
    expect(toHonoPath(`/r/{ok}/s/{${long129}}`)).toBe(`/r/:ok/s/:${long129}`);
  });
});

// ---------------------------------------------------------------------------------------
// The DECLARED per-route budget — what gets MOUNTED, and the boot guards around it.
//
// The "no limit when the field is absent" property is pinned STRUCTURALLY here, not behaviourally.
// A behavioural "the route still answers" assertion would stay green against a no-op passthrough
// middleware quietly inserted into every chain, which is exactly the regression worth catching: it
// would change the shape of every declared route in the product for a feature nobody opted into.
// ---------------------------------------------------------------------------------------
describe('registerDeclaredRoutes — a declared rateLimit mounts ONE extra middleware, after auth', () => {
  const declaredHandlers = new Map<string, ResolvedHandler>([
    ['h', { kind: 'route', fn: async () => ({ ok: true }) }],
  ]);
  const plain: ApiRouteSpec = {
    method: 'GET',
    path: '/plain',
    action: { kind: 'handler', handler: 'h' },
  };
  const budgeted: ApiRouteSpec = {
    method: 'GET',
    path: '/budgeted',
    action: { kind: 'handler', handler: 'h' },
    rateLimit: { windowSeconds: 60, max: 3 },
  };

  /** A limiter that records every `check` call, third argument included. */
  function recordingLimiter(): { limiter: RateLimiter; calls: unknown[][] } {
    const calls: unknown[][] = [];
    const limiter = new RateLimiter();
    const real = limiter.check.bind(limiter);
    limiter.check = ((bucket: string, id: string, policy?: RateLimitPolicy) => {
      calls.push([bucket, id, policy]);
      return real(bucket, id, policy);
    }) as RateLimiter['check'];
    return { limiter, calls };
  }

  /**
   * Register BOTH routes in ONE call, so the shared front of the chain (the tier throttle,
   * `requireAuth`, `resolveTenant`) is literally the same middleware OBJECT for both — which is what
   * makes an identity comparison between the two chains meaningful.
   */
  function registerBoth(limiter: RateLimiter): {
    app: OpenAPIHono<AppEnv>;
  } {
    const app = new OpenAPIHono<AppEnv>();
    const deps = { rateLimiter: limiter } as unknown as AppDeps;
    registerDeclaredRoutes(app, deps, {
      spec: makeSpec({ api: [plain, budgeted] }),
      productTables: emptyTables,
      handlers: declaredHandlers,
    });
    return { app };
  }

  /** The registered middleware chain for one declared path, in mount order. */
  function chainFor(app: OpenAPIHono<AppEnv>, path: string): unknown[] {
    return app.routes.filter((r) => r.path === path).map((r) => r.handler);
  }

  it("registers EXACTLY today's chain for a route with no rateLimit, and one more for a route with one", () => {
    const { app } = registerBoth(new RateLimiter());
    const withoutLimit = chainFor(app, '/plain');
    const withLimit = chainFor(app, '/budgeted');
    // Today: routeRateLimit → requireAuth → resolveTenant → requirePermission → handler.
    expect(withoutLimit).toHaveLength(5);
    expect(withLimit).toHaveLength(6);
  });

  it('keeps the SAME middleware identities, and splices the budget between auth and tenant', () => {
    const { app } = registerBoth(new RateLimiter());
    const withoutLimit = chainFor(app, '/plain');
    const withLimit = chainFor(app, '/budgeted');
    // The shared front is the same OBJECT in both chains — the tier throttle and requireAuth are
    // untouched by the feature, not merely equivalent.
    expect(withLimit[0]).toBe(withoutLimit[0]);
    expect(withLimit[1]).toBe(withoutLimit[1]);
    // resolveTenant is also the same object, one slot LATER — which is precisely the claim that the
    // extra middleware sits between authentication and tenant resolution.
    expect(withLimit[3]).toBe(withoutLimit[2]);
    // And the spliced middleware is genuinely new: it appears nowhere in the unbudgeted chain.
    expect(withoutLimit).not.toContain(withLimit[2]);
    expect(withLimit[2]).toBeTypeOf('function');
  });

  it('drives EXACTLY ONE limiter check, carrying NO policy, for a request on the unbudgeted route', async () => {
    const { limiter, calls } = recordingLimiter();
    const { app } = registerBoth(limiter);
    // Boot spends exactly two calls on the one-shot probe (the budgeted route in this pair triggers
    // it); drop them so what remains is attributable to the REQUEST alone.
    expect(calls).toHaveLength(2);
    calls.length = 0;
    // The tier throttle runs, then requireAuth refuses the credential-less call — so the request never
    // reaches a second check, and the one it did make carried no per-route budget.
    await app.request('/plain');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe(DEFAULT_ROUTE_RATE_TIERS.source);
    expect(calls[0]?.[2]).toBeUndefined();
  });

  it('NEVER touches the limiter at boot for a spec that declares no rateLimit anywhere', () => {
    // The probe is lazy on purpose: a deployment with no declared budget must not depend on the
    // limiter answering a question it never asks.
    const { limiter, calls } = recordingLimiter();
    const app = new OpenAPIHono<AppEnv>();
    const deps = { rateLimiter: limiter } as unknown as AppDeps;
    registerDeclaredRoutes(app, deps, {
      spec: makeSpec({ api: [plain] }),
      productTables: emptyTables,
      handlers: declaredHandlers,
    });
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------
// EVERY action arm mounts the budget — not just the one an earlier test happened to use.
//
// The budget is spliced in at FOUR separate `registerOn` call sites, one per action kind. A required
// parameter makes the compiler prove each site DECIDED about the budget, but `undefined` is a valid
// decision at every one of them, so the type system cannot prove the decision was the right one. Only
// a test can. This arm registers a budgeted and an unbudgeted route for every kind that mounts the
// authenticated chain, in ONE call, and asserts the same shape for each: one extra middleware, at
// index 2, with the shared front identical. Replacing `budget` with `undefined` at any single call
// site turns this red — which is precisely the regression it exists to catch, because a declared
// `rateLimit` that mounts nothing is a limit the spec, the boot and the served OpenAPI all promise
// and none of them delivers.
// ---------------------------------------------------------------------------------------
describe('registerDeclaredRoutes — the per-route budget is mounted on EVERY action arm', () => {
  const declaredHandlers = new Map<string, ResolvedHandler>([
    ['h', { kind: 'route', fn: async () => ({ ok: true }) }],
  ]);
  const registry: AgentRegistry = new Map([['ghost', { spec: {} as never, backend: {} as never }]]);
  const dummyBlobFactory: BlobStoreFactory = () => ({}) as BlobStore;
  const limit = { windowSeconds: 60, max: 3 } as const;

  // One unbudgeted + one budgeted route per action kind that mounts the authenticated chain. The
  // `{store}` arm is exercised end-to-end against a real database in declared-route-rate-limit.db.test.ts;
  // the three wired here are the ones no other test mounts with a budget.
  const api: ApiRouteSpec[] = [
    { method: 'GET', path: '/h-plain', action: { kind: 'handler', handler: 'h' } },
    {
      method: 'GET',
      path: '/h-budgeted',
      action: { kind: 'handler', handler: 'h' },
      rateLimit: limit,
    },
    { method: 'POST', path: '/a-plain', action: { kind: 'agent', agent: 'ghost' } },
    {
      method: 'POST',
      path: '/a-budgeted',
      action: { kind: 'agent', agent: 'ghost' },
      rateLimit: limit,
    },
    { method: 'PUT', path: '/s-plain', action: { kind: 'stream', handler: 'h', mode: 'ingest' } },
    {
      method: 'PUT',
      path: '/s-budgeted',
      action: { kind: 'stream', handler: 'h', mode: 'ingest' },
      rateLimit: limit,
    },
  ];

  function registerAll(): OpenAPIHono<AppEnv> {
    const app = new OpenAPIHono<AppEnv>();
    const deps = { rateLimiter: new RateLimiter(), agentRegistry: registry } as unknown as AppDeps;
    registerDeclaredRoutes(app, deps, {
      spec: makeSpec({ api }),
      productTables: emptyTables,
      handlers: declaredHandlers,
      blobFactory: dummyBlobFactory,
    });
    return app;
  }

  function chainFor(app: OpenAPIHono<AppEnv>, path: string): unknown[] {
    return app.routes.filter((r) => r.path === path).map((r) => r.handler);
  }

  it.each([
    ['{handler}', '/h-plain', '/h-budgeted'],
    ['{agent}', '/a-plain', '/a-budgeted'],
    ["{stream mode:'ingest'}", '/s-plain', '/s-budgeted'],
  ])('splices the budget into the %s arm, between auth and tenant', (_kind, plainPath, budgetedPath) => {
    const app = registerAll();
    const withoutLimit = chainFor(app, plainPath);
    const withLimit = chainFor(app, budgetedPath);
    // Today's chain: routeRateLimit → requireAuth → resolveTenant → requirePermission → handler.
    expect(withoutLimit).toHaveLength(5);
    // One more, and exactly one more — a budgeted route of this kind actually mounts something.
    expect(withLimit).toHaveLength(6);
    // The shared front is the same OBJECT in both chains: the feature adds a middleware, it does not
    // rebuild the chain around it.
    expect(withLimit[0]).toBe(withoutLimit[0]);
    expect(withLimit[1]).toBe(withoutLimit[1]);
    // resolveTenant is the same object one slot later — the budget sits after authentication and
    // before the two middlewares that touch the database.
    expect(withLimit[3]).toBe(withoutLimit[2]);
    // And the spliced middleware is genuinely new, not a shifted copy of something already there.
    expect(withoutLimit).not.toContain(withLimit[2]);
    expect(withLimit[2]).toBeTypeOf('function');
  });

  it("gives each budgeted arm its OWN middleware — one route can never mount another route's budget", () => {
    const app = registerAll();
    const spliced = ['/h-budgeted', '/a-budgeted', '/s-budgeted'].map((p) => chainFor(app, p)[2]);
    expect(new Set(spliced).size).toBe(3);
  });
});

describe('registerDeclaredRoutes — boot guards around a declared rateLimit', () => {
  const declaredHandlers = new Map<string, ResolvedHandler>([
    ['h', { kind: 'route', fn: async () => ({ ok: true }) }],
    ['play_h', { kind: 'route', fn: async () => ({ ok: true }) }],
  ]);
  const dummyBlobFactory: BlobStoreFactory = () => ({}) as BlobStore;
  const dummyMediaService = {} as unknown as MediaTokenService;

  function registerApi(api: ApiRouteSpec[], deps: AppDeps): void {
    const app = new OpenAPIHono<AppEnv>();
    registerDeclaredRoutes(app, deps, {
      spec: makeSpec({ api }),
      productTables: emptyTables,
      handlers: declaredHandlers,
      blobFactory: dummyBlobFactory,
      mediaTokenService: dummyMediaService,
    });
  }

  function depsWith(limiter: RateLimiter): AppDeps {
    return { rateLimiter: limiter } as unknown as AppDeps;
  }

  it('REFUSES a rateLimit on a stream PLAYBACK route, explaining why and where to declare it', () => {
    expect(() =>
      registerApi(
        [
          {
            method: 'GET',
            path: '/media/{key}',
            action: { kind: 'stream', handler: 'play_h', mode: 'playback' },
            rateLimit: { windowSeconds: 60, max: 3 },
          },
        ],
        depsWith(new RateLimiter()),
      ),
    ).toThrow(/stream PLAYBACK route and may not declare a rateLimit/);
    // The message has to say WHY and what to do instead, or an author cannot act on it.
    expect(() =>
      registerApi(
        [
          {
            method: 'GET',
            path: '/media/{key}',
            action: { kind: 'stream', handler: 'play_h', mode: 'playback' },
            rateLimit: { windowSeconds: 60, max: 3 },
          },
        ],
        depsWith(new RateLimiter()),
      ),
    ).toThrow(/own middleware tuple.*MINTS the playback token/s);
  });

  it('still registers a PLAYBACK route that declares NO rateLimit (no false positive)', () => {
    expect(() =>
      registerApi(
        [
          {
            method: 'GET',
            path: '/media/{key}',
            action: { kind: 'stream', handler: 'play_h', mode: 'playback' },
          },
        ],
        depsWith(new RateLimiter()),
      ),
    ).not.toThrow();
  });

  it('ABORTS registration when the injected limiter IGNORES the carried policy', () => {
    // A version-skewed or subclassed limiter that drops the third argument type-checks, finds no
    // registered policy for the deliberately-unregistered route bucket, and would allow everything —
    // every budgeted route silently unlimited. The boot refuses instead.
    class IgnoresPolicy extends RateLimiter {
      override check(bucket: string, id: string): { allowed: boolean; retryAfterMs: number } {
        return super.check(bucket, id);
      }
    }
    expect(() =>
      registerApi(
        [
          {
            method: 'GET',
            path: '/budgeted',
            action: { kind: 'handler', handler: 'h' },
            rateLimit: { windowSeconds: 60, max: 3 },
          },
        ],
        depsWith(new IgnoresPolicy()),
      ),
    ).toThrow(/does not honour an explicit per-call policy/);
  });

  /** A limiter that type-checks but silently drops the carried policy. */
  class IgnoresPolicy extends RateLimiter {
    override check(bucket: string, id: string): { allowed: boolean; retryAfterMs: number } {
      return super.check(bucket, id);
    }
  }

  it('reports the BAD DECLARATION, not the probe, when the FIRST budgeted route is the bad one', () => {
    // The probe runs only after a route has survived its own validation, so on the first budgeted
    // route the specific message wins. That ordering is exactly as far as the guarantee reaches —
    // see the next test for where it stops.
    expect(() =>
      registerApi(
        [
          {
            method: 'GET',
            path: '/budgeted',
            action: { kind: 'handler', handler: 'h' },
            rateLimit: { windowSeconds: 0, max: 3 },
          },
        ],
        depsWith(new IgnoresPolicy()),
      ),
    ).toThrow(/rateLimit\.windowSeconds/);
  });

  it('reports the PROBE once an earlier route already armed it, which bounds the ordering claim', () => {
    // The probe is memoized on the FIRST route that survives its own validation, so a VALID budgeted
    // route ahead of an invalid one arms it — and the broken limiter is then reported before the
    // second route's numbers are ever examined. Pinned deliberately rather than fixed: the probe is a
    // property of the injected limiter, so a deployment that trips it has to fix the limiter before
    // any per-route message is worth reading, and both refusals abort the same boot. What matters is
    // that neither failure is ever silently swallowed; which of the two names itself first is not a
    // guarantee this code makes, and the comments no longer claim it does.
    expect(() =>
      registerApi(
        [
          {
            method: 'GET',
            path: '/ok',
            action: { kind: 'handler', handler: 'h' },
            rateLimit: { windowSeconds: 60, max: 3 },
          },
          {
            method: 'GET',
            path: '/bad',
            action: { kind: 'handler', handler: 'h' },
            rateLimit: { windowSeconds: 0, max: 3 },
          },
        ],
        depsWith(new IgnoresPolicy()),
      ),
    ).toThrow(/does not honour an explicit per-call policy/);
  });

  it('still reports the BAD DECLARATION behind a valid route when the limiter is HEALTHY', () => {
    // With a working limiter the probe passes silently on `/ok`, so the invalid second route still
    // names its own offending member — the case an author actually hits.
    expect(() =>
      registerApi(
        [
          {
            method: 'GET',
            path: '/ok',
            action: { kind: 'handler', handler: 'h' },
            rateLimit: { windowSeconds: 60, max: 3 },
          },
          {
            method: 'GET',
            path: '/bad',
            action: { kind: 'handler', handler: 'h' },
            rateLimit: { windowSeconds: 0, max: 3 },
          },
        ],
        depsWith(new RateLimiter()),
      ),
    ).toThrow(/rateLimit\.windowSeconds/);
  });
});
