/**
 * buildToolFactory tests (the tool-resolution site).
 *
 * FAIL-THE-FIX: the factory must fail-closed at BOOT on an unresolved tool/handler/wrong-kind,
 * and the NeutralTool it builds must carry the declared replay-safety + schema contract (so the
 * UNCHANGED dispatchTool chokepoint enforces them). The handler-routes-through-the-runtime property
 * is proven in handler-runtime.test.ts (the seam test).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TenantDb } from '@rayspec/db';
import type {
  BlobNotFound,
  BlobReadResult,
  ToolHandler,
  ToolHandlerInit,
} from '@rayspec/handler-sdk';
import type { RaySpec } from '@rayspec/spec';
import type { PgTable } from 'drizzle-orm/pg-core';
import { afterAll, describe, expect, it } from 'vitest';
import { makeFsBlobStoreFactory } from '../blob/fs-blob-store.js';
import type { ResolvedHandler } from './handler-runtime.js';
import { buildToolFactory } from './resolve-tools.js';

const fakeTdb = { tenantId: '11111111-1111-1111-1111-111111111111' } as unknown as TenantDb;
const noTables: ReadonlyMap<string, PgTable> = new Map();
const toolFn: ToolHandler = async () => ({ ok: true });

function spec(): RaySpec {
  return {
    version: '1.0',
    metadata: { name: 't' },
    stores: [],
    api: [],
    agents: [],
    tooling: [
      {
        id: 'lookup',
        name: 'lookup_meeting',
        description: 'd',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: { q: { type: 'string' } },
        },
        outputSchema: { type: 'object', properties: { title: { type: 'string' } } },
        handler: 'lookup_h',
        idempotent: true,
        timeoutMs: 3000,
      },
    ],
    triggers: [],
    handlers: [{ id: 'lookup_h', module: './h.ts', export: 'lookup', kind: 'tool' }],
  } as RaySpec;
}

const handlers = (): Map<string, ResolvedHandler> =>
  new Map([['lookup_h', { kind: 'tool', fn: toolFn }]]);

describe('buildToolFactory', () => {
  it('builds a NeutralTool carrying the declared name/params/outputSchema/timeout/idempotent', () => {
    const factory = buildToolFactory(spec(), handlers(), noTables, ['lookup']);
    const tools = factory(fakeTdb);
    expect(tools).toHaveLength(1);
    const t = tools[0];
    expect(t?.spec.name).toBe('lookup_meeting');
    expect(t?.spec.parameters).toEqual(spec().tooling[0]?.parameters);
    expect(t?.inputSchema).toEqual(spec().tooling[0]?.parameters);
    expect(t?.outputSchema).toEqual(spec().tooling[0]?.outputSchema);
    expect(t?.timeoutMs).toBe(3000);
    expect(t?.idempotent).toBe(true);
    expect(typeof t?.handler).toBe('function');
  });

  it('an empty toolIds list yields a no-tool factory', () => {
    const factory = buildToolFactory(spec(), handlers(), noTables, []);
    expect(factory(fakeTdb)).toHaveLength(0);
  });

  it('FAILS CLOSED at boot when a referenced tool id is undeclared', () => {
    expect(() => buildToolFactory(spec(), handlers(), noTables, ['ghost'])).toThrow(
      /undeclared tool 'ghost'/,
    );
  });

  it('FAILS CLOSED at boot when the tool references an UNLOADED handler', () => {
    expect(() => buildToolFactory(spec(), new Map(), noTables, ['lookup'])).toThrow(
      /unloaded handler 'lookup_h'/,
    );
  });

  it("FAILS CLOSED at boot when the resolved handler is the WRONG kind (not 'tool')", () => {
    const wrong = new Map<string, ResolvedHandler>([
      ['lookup_h', { kind: 'route', fn: async () => ({}) }],
    ]);
    expect(() => buildToolFactory(spec(), wrong, noTables, ['lookup'])).toThrow(/expected 'tool'/);
  });

  it('a tool with NO outputSchema omits it on the NeutralTool', () => {
    const s = spec();
    if (s.tooling[0]) s.tooling[0].outputSchema = undefined;
    const tools = buildToolFactory(s, handlers(), noTables, ['lookup'])(fakeTdb);
    expect(tools[0]?.outputSchema).toBeUndefined();
  });
});

/**
 * A TOOL handler init now carries the tenant-bound `init.blob`. FAIL-THE-FIX
 * against a REAL fs `BlobStore` (the load-bearing path-jail primitive, not a re-implementation):
 *   - a tool builds the SANCTIONED tenant-bound blob (no tenant param anywhere — it is bound to the
 *     run's server-derived `tdb.tenantId`);
 *   - TENANT-SCOPED BY CONSTRUCTION: a value a tool puts under tenant A is UNREADABLE by a tool
 *     running as tenant B (each tenant's blob root is its own `<root>/<tenantId>/` prefix);
 *   - FAIL-CLOSED when no blob backend is wired: `init.blob` is undefined → the tool fail-closes.
 * MUTATING-TO-RED: drop `blob` from the tool init (omit the blobFactory) → the tool's `init.blob` is
 * undefined when it SHOULD be present → the assertions that read a blob FAIL.
 */
describe('buildToolFactory — tenant-bound init.blob', () => {
  const TENANT_A = '00000000-0000-0000-0000-0000000000aa';
  const TENANT_B = '00000000-0000-0000-0000-0000000000bb';
  const tdbFor = (tenantId: string): TenantDb => ({ tenantId }) as unknown as TenantDb;

  const root = mkdtempSync(join(tmpdir(), 'rayspec-tool-blob-'));
  const blobFactory = makeFsBlobStoreFactory(root);
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
  const isNotFound = (r: BlobReadResult | BlobNotFound): r is BlobNotFound =>
    (r as BlobNotFound).notFound === true;
  async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader();
    let out = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) out += new TextDecoder().decode(value);
    }
    return out;
  }

  // A blob tool: PUT under a fixed key on the first call, then GET it back. It reads/writes ONLY via
  // its injected `init.blob` — there is NO tenant param, so it can only ever touch its own tenant's
  // bytes. It fail-closes loudly if `init.blob` is undefined (no backend wired).
  const BLOB_KEY = 'recordings/clip.bin';
  const blobToolFn: ToolHandler = async (args: unknown, init: ToolHandlerInit) => {
    if (!init.blob)
      throw new Error('tool fail-closed: init.blob is undefined (no blob backend wired)');
    const { op, value } = args as { op: 'put' | 'get'; value?: string };
    if (op === 'put') {
      await init.blob.put(BLOB_KEY, enc(value ?? ''), { contentType: 'application/octet-stream' });
      return { put: true };
    }
    const res = await init.blob.get(BLOB_KEY);
    if (isNotFound(res)) return { found: false };
    return { found: true, value: await drain(res.body) };
  };

  function blobSpec(): RaySpec {
    return {
      version: '1.0',
      metadata: { name: 't' },
      stores: [],
      api: [],
      agents: [],
      tooling: [
        {
          id: 'blobtool',
          name: 'blob_tool',
          description: 'read/write a blob',
          parameters: { type: 'object', properties: { op: { type: 'string' } } },
          handler: 'blob_h',
          idempotent: false,
          timeoutMs: 3000,
        },
      ],
      triggers: [],
      handlers: [{ id: 'blob_h', module: './b.ts', export: 'b', kind: 'tool' }],
    } as RaySpec;
  }
  const blobHandlers = (): Map<string, ResolvedHandler> =>
    new Map([['blob_h', { kind: 'tool', fn: blobToolFn }]]);

  it('gives a tool a tenant-bound init.blob; a value put as tenant A is UNREADABLE as tenant B', async () => {
    const factory = buildToolFactory(
      blobSpec(),
      blobHandlers(),
      noTables,
      ['blobtool'],
      blobFactory,
    );
    const signal = new AbortController().signal;

    // Tenant A puts a secret under the key, then reads it back through its OWN tenant-bound blob.
    const toolA = factory(tdbFor(TENANT_A))[0];
    expect(await toolA?.handler({ op: 'put', value: 'tenant-A-secret' }, signal)).toEqual({
      put: true,
    });
    expect(await toolA?.handler({ op: 'get' }, signal)).toEqual({
      found: true,
      value: 'tenant-A-secret',
    });

    // Tenant B — built from the SAME factory but bound to its OWN tenant — reads the SAME key and
    // gets NOTHING: the blob is tenant-scoped by construction (separate `<root>/<tenantId>/` prefix),
    // and there is no tenant param a tool could pass to reach A's bytes. Cross-tenant read denied.
    const toolB = factory(tdbFor(TENANT_B))[0];
    expect(await toolB?.handler({ op: 'get' }, signal)).toEqual({ found: false });
  });

  it('FAILS CLOSED — init.blob is undefined when NO blob backend is wired (drop the factory)', async () => {
    // No blobFactory passed (a stores/api-only deploy). The tool gets `init.blob === undefined` and
    // fail-closes loudly — this is the mutating-to-red arm: it proves the value flows ONLY when wired.
    const factory = buildToolFactory(blobSpec(), blobHandlers(), noTables, ['blobtool']);
    const tool = factory(tdbFor(TENANT_A))[0];
    await expect(
      tool?.handler({ op: 'put', value: 'x' }, new AbortController().signal),
    ).rejects.toThrow(/init\.blob is undefined/);
  });
});
