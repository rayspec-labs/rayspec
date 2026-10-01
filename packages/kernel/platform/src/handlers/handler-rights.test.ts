/**
 * Scoped handler rights through the real loader and the real init builders: a handler that declares
 * `uses` receives exactly those capabilities, and reaching for any other configured one throws
 * `ToolRightNotGrantedError` where it asks; a handler that declares nothing receives what the
 * deployment configured, as before. And the boot check: a declared right the deployment does not
 * grant, or (managed posture) a handler that declares nothing, refuses with a message naming both.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TenantDb } from '@rayspec/db';
import type { RouteHandlerInit, SttCapability, ToolHandlerInit } from '@rayspec/handler-sdk';
import type { HandlerSpec, RaySpec } from '@rayspec/spec';
import type { PgTable } from 'drizzle-orm/pg-core';
import { afterAll, describe, expect, it } from 'vitest';
import {
  assertHandlerRights,
  type GrantedRights,
  HandlerRightsError,
  scopeInit,
  ToolRightNotGrantedError,
} from './handler-rights.js';
import { loadHandlers } from './loader.js';
import { buildToolFactory } from './resolve-tools.js';
import { invokeRouteHandler } from './route-init.js';

const root = mkdtempSync(join(tmpdir(), 'rayspec-rights-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function fakeTdb(): TenantDb {
  const handle: Record<string, unknown> = {
    tenantId: 'tenant-a',
    async transaction<R>(fn: (tx: TenantDb) => Promise<R>): Promise<R> {
      return fn(handle as unknown as TenantDb);
    },
  };
  return handle as unknown as TenantDb;
}

const NO_TABLES: ReadonlyMap<string, PgTable> = new Map();
const stt = { transcribe: async () => ({ status: 'completed' }) } as unknown as SttCapability;

/** Load one route handler through the real loader, with an importer that serves `fn`. */
async function loadRoute(spec: Partial<HandlerSpec>, fn: (init: RouteHandlerInit) => unknown) {
  const handler = {
    id: 'h',
    module: 'handlers/h.mjs',
    export: 'h',
    kind: 'route',
    lintSuppress: [],
    ...spec,
  } as HandlerSpec;
  const loaded = await loadHandlers(root, [handler], async () => ({ h: fn }));
  const resolved = loaded.get('h');
  if (resolved?.kind !== 'route') throw new Error('not a route handler');
  return resolved.fn;
}

describe('scopeInit', () => {
  it('keeps the declared rights, and turns a configured undeclared one into a throwing field', () => {
    const init = { tenantId: 't', db: {}, stt, emit: async () => {}, params: {} };
    const scoped = scopeInit(init, 'reporter', ['stt']);
    expect(scoped.stt).toBe(stt);
    expect(scoped.tenantId).toBe('t');
    expect(() => scoped.emit).toThrow(ToolRightNotGrantedError);
    expect(() => scoped.emit).toThrow(/handler 'reporter' reached for init.emit/);
    // Not enumerable: spreading or serializing the init never trips it.
    expect(Object.keys(scoped)).not.toContain('emit');
    // A capability the deployment did not configure stays absent.
    expect('blob' in scoped).toBe(false);
  });
});

describe('a declaring route handler, through the loader and the init builder', () => {
  it('receives the right it declares', async () => {
    const fn = await loadRoute({ uses: ['stt'] }, async (init) => ({ has: init.stt === stt }));
    const body = await invokeRouteHandler(
      fn,
      fakeTdb(),
      NO_TABLES,
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      stt,
    );
    expect(body).toEqual({ has: true });
  });

  it('is refused when it reaches for one it does not declare, where it asks', async () => {
    const fn = await loadRoute({ uses: [] }, async (init) =>
      init.stt?.transcribe(new Uint8Array()),
    );
    await expect(
      invokeRouteHandler(
        fn,
        fakeTdb(),
        NO_TABLES,
        {},
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        stt,
      ),
    ).rejects.toBeInstanceOf(ToolRightNotGrantedError);
  });

  it('without a declaration, receives every configured capability, as before', async () => {
    const fn = await loadRoute({}, async (init) => ({ has: init.stt === stt }));
    expect(
      await invokeRouteHandler(
        fn,
        fakeTdb(),
        NO_TABLES,
        {},
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        stt,
      ),
    ).toEqual({ has: true });
  });
});

describe('a declaring tool handler', () => {
  it('is refused a blob handle it does not declare, though the deployment built one', async () => {
    const tool: HandlerSpec = {
      id: 'tool_h',
      module: 'handlers/t.mjs',
      export: 't',
      kind: 'tool',
      uses: ['stt'],
      lintSuppress: [],
    };
    const loaded = await loadHandlers(root, [tool], async () => ({
      t: async (_args: unknown, init: ToolHandlerInit) => init.blob?.stat('k'),
    }));
    const spec = {
      tooling: [
        {
          id: 'tool_h',
          name: 'tool_h',
          description: 'd',
          parameters: { type: 'object' },
          handler: 'tool_h',
          idempotent: true,
          timeoutMs: 1000,
        },
      ],
    } as unknown as RaySpec;
    const [neutral] = buildToolFactory(
      spec,
      loaded,
      NO_TABLES,
      ['tool_h'],
      () => ({}) as never,
    )(fakeTdb());
    await expect(neutral?.handler({}, new AbortController().signal)).rejects.toThrow(
      /handler 'tool_h' reached for init.blob, a right it does not declare/,
    );
  });
});

describe('assertHandlerRights', () => {
  const allGranted: GrantedRights = {
    blob: null,
    fsSource: null,
    stt: null,
    tts: null,
    emit: null,
    enqueue: null,
    mintPlayToken: null,
    bindings: null,
  };
  const handler = (id: string, uses?: HandlerSpec['uses']): HandlerSpec =>
    ({
      id,
      module: 'm.mjs',
      export: 'e',
      kind: 'route',
      lintSuppress: [],
      ...(uses ? { uses } : {}),
    }) as HandlerSpec;

  it('passes when every declared right is granted, and an undeclared handler outside the managed posture', () => {
    expect(() =>
      assertHandlerRights([handler('a', ['stt', 'emit']), handler('b')], allGranted, {
        managedPosture: false,
      }),
    ).not.toThrow();
  });

  it('refuses a declared right the deployment does not grant, naming the handler and what is missing', () => {
    const granted = { ...allGranted, stt: 'STT_PROVIDER is not set' };
    expect(() =>
      assertHandlerRights([handler('reporter', ['stt'])], granted, { managedPosture: false }),
    ).toThrow(
      "handler 'reporter' asks for the right 'stt', which this deployment does not grant: STT_PROVIDER is not set",
    );
  });

  it('refuses, under the managed posture, a handler that declares nothing; an empty list is a declaration', () => {
    expect(() =>
      assertHandlerRights([handler('quiet')], allGranted, { managedPosture: true }),
    ).toThrow(HandlerRightsError);
    expect(() =>
      assertHandlerRights([handler('quiet', [])], allGranted, { managedPosture: true }),
    ).not.toThrow();
  });
});
