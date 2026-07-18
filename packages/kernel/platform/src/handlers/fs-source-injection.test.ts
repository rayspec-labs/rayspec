/**
 * fs-source capability INJECTION tests — the READ-ONLY `init.fsSource` reaches BOTH a TOOL handler and a
 * ROUTE handler by injection, jailed by construction, and is ABSENT (fail-closed) when no source root is
 * wired.
 *
 * FAIL-THE-FIX against a REAL fs source (the load-bearing path jail, not a re-implementation):
 *   - a tool / route handler receives an `init.fsSource` that reads a jailed file;
 *   - a jail escape through it is REFUSED (the handler can never read outside the root);
 *   - FAIL-CLOSED when no factory is wired: `init.fsSource` is undefined → the handler fail-closes.
 * MUTATING-TO-RED: drop the fsSourceFactory arg → `init.fsSource` is undefined when it SHOULD be present
 * → the assertions that read a file FAIL.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TenantDb } from '@rayspec/db';
import type {
  FsSourceNotFound,
  RouteHandler,
  RouteHandlerInit,
  ToolHandler,
  ToolHandlerInit,
} from '@rayspec/handler-sdk';
import type { RaySpec } from '@rayspec/spec';
import type { PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeFsSourceFactory } from '../fs-source/fs-source.js';
import type { ResolvedHandler } from './handler-runtime.js';
import { buildToolFactory } from './resolve-tools.js';
import { invokeRouteHandler, invokeRouteHandlerDetached } from './route-init.js';

const TENANT = '00000000-0000-0000-0000-0000000000aa';
const noTables: ReadonlyMap<string, PgTable> = new Map();
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);
const isNotFound = (r: unknown): r is FsSourceNotFound =>
  typeof r === 'object' && r !== null && (r as FsSourceNotFound).notFound === true;

const root = mkdtempSync(join(tmpdir(), 'rayspec-inject-fs-'));
const fsSourceFactory = makeFsSourceFactory(root);

beforeAll(() => {
  mkdirSync(join(root, 'ref'), { recursive: true });
  writeFileSync(join(root, 'ref', 'note.md'), 'the reference note body');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

// A fake tenant-bound TenantDb — the fs-source handlers never touch init.db, so a shape stub suffices
// (the same pattern the blob-injection tests use). The engine-tx path needs a `transaction` that runs
// the callback with the same handle.
function fakeTdb(): TenantDb {
  const stub = {
    tenantId: TENANT,
    transaction: async <R>(cb: (tx: TenantDb) => Promise<R>): Promise<R> => cb(stub),
  };
  return stub as unknown as TenantDb;
}

// ── TOOL handler injection ──────────────────────────────────────────────────────────────────────

const fsToolFn: ToolHandler = async (args: unknown, init: ToolHandlerInit) => {
  if (!init.fsSource)
    throw new Error('tool fail-closed: init.fsSource is undefined (no source root wired)');
  const { op, path } = args as { op: 'read' | 'list' | 'escape'; path?: string };
  if (op === 'list') return { entries: await init.fsSource.list(path) };
  if (op === 'escape') {
    // A jail escape MUST throw — it is surfaced so the test asserts the tool cannot read outside.
    await init.fsSource.read('../../../../etc/passwd');
    return { escaped: true };
  }
  const r = await init.fsSource.read(path ?? 'ref/note.md');
  return isNotFound(r) ? { found: false } : { found: true, body: dec(r.bytes) };
};

function toolSpec(): RaySpec {
  return {
    version: '1.0',
    metadata: { name: 't' },
    stores: [],
    api: [],
    agents: [],
    tooling: [
      {
        id: 'fstool',
        name: 'fs_tool',
        description: 'read a reference file',
        parameters: { type: 'object', properties: { op: { type: 'string' } } },
        handler: 'fs_h',
        idempotent: true,
        timeoutMs: 3000,
      },
    ],
    triggers: [],
    handlers: [{ id: 'fs_h', module: './f.ts', export: 'f', kind: 'tool' }],
  } as RaySpec;
}
const toolHandlers = (): Map<string, ResolvedHandler> =>
  new Map([['fs_h', { kind: 'tool', fn: fsToolFn }]]);

describe('fs-source injection — TOOL handler', () => {
  const signal = new AbortController().signal;

  it('gives a tool a READ-ONLY init.fsSource that reads a jailed file', async () => {
    const tool = buildToolFactory(
      toolSpec(),
      toolHandlers(),
      noTables,
      ['fstool'],
      undefined,
      fsSourceFactory,
    )(fakeTdb())[0];
    expect(await tool?.handler({ op: 'read', path: 'ref/note.md' }, signal)).toEqual({
      found: true,
      body: 'the reference note body',
    });
  });

  it('the tool CANNOT escape the jail through init.fsSource', async () => {
    const tool = buildToolFactory(
      toolSpec(),
      toolHandlers(),
      noTables,
      ['fstool'],
      undefined,
      fsSourceFactory,
    )(fakeTdb())[0];
    await expect(tool?.handler({ op: 'escape' }, signal)).rejects.toThrow();
  });

  it('FAILS CLOSED — init.fsSource is undefined when NO source root is wired (drop the factory)', async () => {
    const tool = buildToolFactory(toolSpec(), toolHandlers(), noTables, ['fstool'])(fakeTdb())[0];
    await expect(tool?.handler({ op: 'read' }, signal)).rejects.toThrow(
      /init\.fsSource is undefined/,
    );
  });
});

// ── ROUTE handler injection ─────────────────────────────────────────────────────────────────────

const fsRouteFn: RouteHandler = async (init: RouteHandlerInit) => {
  if (!init.fsSource)
    throw new Error('route fail-closed: init.fsSource is undefined (no source root wired)');
  const r = await init.fsSource.read(init.params.path ?? 'ref/note.md');
  return isNotFound(r) ? { found: false } : { found: true, body: dec(r.bytes) };
};

describe('fs-source injection — ROUTE handler', () => {
  const params = { path: 'ref/note.md' };

  it('engine-tx path (invokeRouteHandler) injects a jailed init.fsSource', async () => {
    const out = (await invokeRouteHandler(
      fsRouteFn,
      fakeTdb(),
      noTables,
      params,
      undefined, // blobFactory
      undefined, // mintPlayToken
      undefined, // enqueue
      undefined, // body
      undefined, // headers
      undefined, // createdByActor
      fsSourceFactory,
    )) as { found: boolean; body?: string };
    expect(out).toEqual({ found: true, body: 'the reference note body' });
  });

  it('detached path (invokeRouteHandlerDetached) injects a jailed init.fsSource', async () => {
    const out = (await invokeRouteHandlerDetached(
      fsRouteFn,
      fakeTdb(),
      noTables,
      params,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      fsSourceFactory,
    )) as { found: boolean; body?: string };
    expect(out).toEqual({ found: true, body: 'the reference note body' });
  });

  it('FAILS CLOSED — a route init has NO fsSource when no factory is wired', async () => {
    await expect(
      invokeRouteHandlerDetached(fsRouteFn, fakeTdb(), noTables, params),
    ).rejects.toThrow(/init\.fsSource is undefined/);
  });
});
