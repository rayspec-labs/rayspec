/**
 * PRODUCT-NEUTRALITY: (1) a different product (a lending library)
 * declares + interprets views through the SAME YAML→parse→mount chain — proving the runtime carries
 * no product assumptions; (2) a SOURCE SCAN asserts the runtime files contain ZERO product concepts
 * (the whole invariant: every runtime source file, every product word — product shapes live only in
 * declarations and test fixtures).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isHttpResponse, type RouteHandlerInit } from '@rayspec/handler-sdk';
import { parseProductSpec, type StoreSpec } from '@rayspec/spec';
import { describe, expect, it } from 'vitest';
import { type MountedProductViews, mountProductViews } from './index.js';
import { FakeReadSurface } from './test-support/fake-read-surface.js';

const TENANT = '00000000-0000-0000-0000-0000000000dd';

const LIBRARY_YAML = `
version: "1.0"
product:
  id: lending_library
  name: Lending Library (neutrality fixture)
contracts:
  library.book_list_response:
    type: object
    additional_properties: false
    properties:
      books:
        type: array
        items: { type: object }
      total: { type: integer }
      next_offset: { type: [integer, "null"] }
    required: [books, total, next_offset]
  library.scan_response:
    type: object
    additional_properties: false
    properties:
      book_id: { type: string }
      scan_state: { type: string }
    required: [book_id, scan_state]
views:
  - id: book_list
    route: { method: GET, path: /books }
    auth: bearer_tenant
    source: { kind: store, ref: library_books }
    pagination: { limit_param: limit, offset_param: offset, max_limit: 20, default_limit: 5 }
    read:
      mode: list
      order_by: [{ column: title }]
      shape:
        fields:
          books:
            kind: page_items
            shape:
              fields:
                book_id: { kind: column, column: book_id, type: string, default: "" }
                title: { kind: column, column: title, type: string, default: "" }
                available: { kind: column, column: available, type: boolean, default: false }
          total: { kind: page_total }
          next_offset: { kind: page_next_offset }
    response_contract: library.book_list_response

  # A readiness-gated single view: the digitization scan is 409 until the scan row exists.
  - id: book_scan
    route: { method: GET, path: "/books/{book_id}/scan" }
    auth: bearer_tenant
    params:
      book_id: { in: path, shape: safe_id }
    source: { kind: store, ref: book_scans }
    absent_state: not_ready_409
    read:
      mode: single
      filter:
        book_id: { param: book_id }
      shape:
        fields:
          book_id: { kind: param, param: book_id }
          scan_state: { kind: column, column: scan_state, type: string, default: "" }
    response_contract: library.scan_response
`;

const STORES: StoreSpec[] = [
  {
    name: 'library_books',
    columns: [
      { name: 'book_id', type: 'text', nullable: false, unique: false },
      { name: 'title', type: 'text', nullable: false, unique: false },
      { name: 'available', type: 'boolean', nullable: false, unique: false },
    ],
    foreignKeys: [],
  },
  {
    name: 'book_scans',
    columns: [
      { name: 'book_id', type: 'text', nullable: false, unique: false },
      { name: 'scan_state', type: 'text', nullable: false, unique: false },
    ],
    foreignKeys: [],
  },
];

async function call(
  mounted: MountedProductViews,
  surface: FakeReadSurface,
  viewId: string,
  params: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  const handler = mounted.handlers.get(mounted.handlerIds.get(viewId) as string);
  if (!handler) throw new Error(`view '${viewId}' not mounted`);
  const init = {
    tenantId: TENANT,
    db: surface.forTenant(TENANT),
    params,
  } as unknown as RouteHandlerInit;
  const result = await handler.fn(init);
  if (isHttpResponse(result)) return { status: result.status ?? 200, body: result.body };
  return { status: 200, body: result };
}

describe('a different product interprets through the same chain (neutrality)', () => {
  const res = parseProductSpec(LIBRARY_YAML);
  if (!res.ok)
    throw new Error(`library fixture must parse:\n${JSON.stringify(res.errors, null, 2)}`);
  const spec = res.value;

  it('list view: ordered, paginated, clamped', async () => {
    const surface = new FakeReadSurface(STORES);
    for (const [id, title, available] of [
      ['b1', 'Zeta', true],
      ['b2', 'Alpha', false],
      ['b3', 'Mid', true],
    ] as const) {
      surface.seed(TENANT, 'library_books', { book_id: id, title, available });
    }
    const mounted = mountProductViews({
      views: spec.views,
      contracts: spec.contracts,
      stores: STORES,
    });
    const page = await call(mounted, surface, 'book_list', { limit: '2' });
    expect(page.body).toEqual({
      books: [
        { book_id: 'b2', title: 'Alpha', available: false },
        { book_id: 'b3', title: 'Mid', available: true },
      ],
      total: 3,
      next_offset: 2,
    });
    const clamped = await call(mounted, surface, 'book_list', { limit: '0' });
    // limit=0 clamps to the DEFAULT (5) → all three books, never an empty page.
    expect((clamped.body as Record<string, unknown>).books).toHaveLength(3);
  });

  it('readiness view: 409 not_ready until the row exists, then the DTO', async () => {
    const surface = new FakeReadSurface(STORES);
    const mounted = mountProductViews({
      views: spec.views,
      contracts: spec.contracts,
      stores: STORES,
    });
    const notReady = await call(mounted, surface, 'book_scan', { book_id: 'b1' });
    expect(notReady.status).toBe(409);
    expect((notReady.body as Record<string, unknown>).error).toBe('not_ready');
    surface.seed(TENANT, 'book_scans', { book_id: 'b1', scan_state: 'done' });
    const ready = await call(mounted, surface, 'book_scan', { book_id: 'b1' });
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ book_id: 'b1', scan_state: 'done' });
  });
});

describe('the runtime source contains ZERO product concepts (the whole invariant)', () => {
  // Product/provider words that must never appear in RUNTIME sources. ('audio'/'media' are Tier-B
  // CAPABILITY references — platform, not product — and are deliberately not on this list.)
  const PRODUCT_WORDS = [
    'acme_notes',
    'meeting',
    'transcript',
    'intelligence',
    'recording',
    'deepgram',
    'session',
    'play-token',
    'ticket',
    'triage',
    'library',
    'book',
  ];

  it('every runtime source file is clean of every product word', () => {
    const srcDir = fileURLToPath(new URL('.', import.meta.url));
    const files = readdirSync(srcDir, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.ts') && !d.name.endsWith('.test.ts'))
      .map((d) => join(d.parentPath, d.name))
      .filter((p) => !p.includes('__fixtures__'));
    expect(files.length).toBeGreaterThanOrEqual(6); // compile/interpret/mount/openapi/index/test-support
    for (const file of files) {
      const text = readFileSync(file, 'utf8').toLowerCase();
      for (const word of PRODUCT_WORDS) {
        expect(text.includes(word), `runtime source ${file} contains product word '${word}'`).toBe(
          false,
        );
      }
    }
  });
});
