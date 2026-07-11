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
import type { BlobStore, BlobStoreFactory, ResolvedHandler } from '@rayspec/platform';
import type { ApiRouteSpec, RaySpec } from '@rayspec/spec';
import type { PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import type { AgentRegistry, AppDeps, AppEnv } from '../app-context.js';
import type { MediaTokenService } from '../media/media-token.js';
import { registerDeclaredRoutes } from './register-declared-routes.js';

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
