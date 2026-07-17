/**
 * Request-law tests for the interpreter — the behaviors the acme-notes goldens do not already
 * pin: the full leaf-coercion table, the sub-read no-rows law, counts semantics (all_rows vs
 * bucket_rows, unknown kinds, non-string keys), group first/last/value-default, the 409 readiness
 * gate, ETag validator forms, optional-param echo, and exclusion strictness. All over a
 * PRODUCT-NEUTRAL domain (orders/items) and the REAL-CONSTRAINT fake surface.
 */
import { isHttpResponse, type RouteHandlerInit } from '@rayspec/handler-sdk';
import type { ProductViewSpec, StoreSpec } from '@rayspec/spec';
import { describe, expect, it } from 'vitest';
import { compileProductViews } from './compile.js';
import { makeViewRouteHandler } from './interpret.js';
import { FakeReadSurface } from './test-support/fake-read-surface.js';

const TENANT = '00000000-0000-0000-0000-0000000000cc';

const STORES: StoreSpec[] = [
  {
    name: 'orders',
    columns: [
      { name: 'order_id', type: 'text', nullable: false, unique: false },
      { name: 'state', type: 'text', nullable: false, unique: false },
      { name: 'ref_code', type: 'text', nullable: true, unique: false },
      { name: 'qty', type: 'integer', nullable: false, unique: false },
      { name: 'rush', type: 'boolean', nullable: false, unique: false },
      { name: 'payload', type: 'jsonb', nullable: true, unique: false },
    ],
    foreignKeys: [],
  },
  {
    name: 'order_events',
    columns: [
      { name: 'order_id', type: 'text', nullable: false, unique: false },
      { name: 'kind', type: 'text', nullable: false, unique: false },
      { name: 'payload', type: 'jsonb', nullable: true, unique: false },
      { name: 'hidden', type: 'boolean', nullable: false, unique: false },
    ],
    foreignKeys: [],
  },
];

const CONTRACTS = { open_response: { type: 'object' } };

function handlerFor(view: ProductViewSpec) {
  const compiled = compileProductViews({ views: [view], contracts: CONTRACTS, stores: STORES });
  const c = compiled.interpreted[0];
  if (!c) throw new Error('expected one interpreted view');
  return makeViewRouteHandler(c, compiled.stores);
}

async function run(
  view: ProductViewSpec,
  surface: FakeReadSurface,
  params: Record<string, string>,
  headers?: Record<string, string>,
): Promise<{ status: number; body: unknown; headers: Record<string, string> }> {
  const handler = handlerFor(view);
  const init = {
    tenantId: TENANT,
    db: surface.forTenant(TENANT),
    params,
    ...(headers ? { headers } : {}),
  } as unknown as RouteHandlerInit;
  const result = await handler(init);
  if (isHttpResponse(result)) {
    return {
      status: result.status ?? 200,
      body: result.body,
      headers: { ...(result.headers ?? {}) },
    };
  }
  return { status: 200, body: result, headers: {} };
}

/** A single-row order view whose shape is the per-case variable. */
function singleView(
  shapeFields: Record<string, unknown>,
  extra?: Partial<ProductViewSpec>,
): ProductViewSpec {
  return {
    id: 'order_view',
    route: { method: 'GET', path: '/orders/{order_id}' },
    auth: 'bearer_tenant',
    params: { order_id: { in: 'path', shape: 'safe_id' } },
    source: { kind: 'store', ref: 'orders' },
    absent_state: 'empty_200',
    read: {
      mode: 'single',
      filter: { order_id: { param: 'order_id' } },
      shape: { fields: shapeFields },
      absent: { fields: { order_id: { kind: 'param', param: 'order_id' } } },
    },
    response_contract: 'open_response',
    ...extra,
  } as ProductViewSpec;
}

describe('the leaf-coercion table (declared type or declared default — never a mistyped passthrough)', () => {
  it('coerces EVERY leaf type: matching values pass, mismatches become the default', async () => {
    const surface = new FakeReadSurface(STORES);
    surface.seed(TENANT, 'orders', {
      order_id: 'o1',
      state: 'open',
      qty: 3,
      rush: true,
      payload: {
        s: 'text',
        n: 1.5,
        i: 7,
        b: false,
        o: { k: 'v' },
        a: [1, 2],
        n_bad: 'NaN-ish',
        i_frac: 2.5,
        o_arr: [1],
      },
    });
    const view = singleView({
      // matching values pass through
      s: { kind: 'json', column: 'payload', path: ['s'], type: 'string', default: 'D' },
      n: { kind: 'json', column: 'payload', path: ['n'], type: 'number', default: 0 },
      i: { kind: 'json', column: 'payload', path: ['i'], type: 'integer', default: 0 },
      b: { kind: 'json', column: 'payload', path: ['b'], type: 'boolean', default: true },
      o: { kind: 'json', column: 'payload', path: ['o'], type: 'object', default: {} },
      a: { kind: 'json', column: 'payload', path: ['a'], type: 'array', default: [] },
      // mismatches fall to the declared default (or null when omitted)
      n_bad: { kind: 'json', column: 'payload', path: ['n_bad'], type: 'number', default: -1 },
      i_frac: { kind: 'json', column: 'payload', path: ['i_frac'], type: 'integer' }, // 2.5 not an int → null
      o_arr: { kind: 'json', column: 'payload', path: ['o_arr'], type: 'object', default: {} }, // array ≠ object
      missing: { kind: 'json', column: 'payload', path: ['nope'], type: 'string' }, // absent → null
      deep_missing: {
        kind: 'json',
        column: 'payload',
        path: ['o', 'nope', 'x'],
        type: 'string',
        default: 'D',
      },
    });
    const res = await run(view, surface, { order_id: 'o1' });
    expect(res.body).toEqual({
      s: 'text',
      n: 1.5,
      i: 7,
      b: false,
      o: { k: 'v' },
      a: [1, 2],
      n_bad: -1,
      i_frac: null,
      o_arr: {},
      missing: null,
      deep_missing: 'D',
    });
  });

  it('items over a NON-array raw value yields [] and non-object elements project to defaults', async () => {
    const surface = new FakeReadSurface(STORES);
    surface.seed(TENANT, 'orders', {
      order_id: 'o1',
      state: 'open',
      qty: 1,
      rush: false,
      payload: { not_array: 'x', mixed: [{ v: 'a' }, 'plain', { v: 3 }] },
    });
    const view = singleView({
      none: {
        kind: 'items',
        column: 'payload',
        path: ['not_array'],
        shape: { fields: { v: { kind: 'item', path: ['v'], type: 'string', default: '' } } },
      },
      mixed: {
        kind: 'items',
        column: 'payload',
        path: ['mixed'],
        shape: { fields: { v: { kind: 'item', path: ['v'], type: 'string', default: '' } } },
      },
    });
    const res = await run(view, surface, { order_id: 'o1' });
    expect(res.body).toEqual({
      none: [],
      mixed: [{ v: 'a' }, { v: '' }, { v: '' }], // a plain string and a number-valued v → default
    });
  });
});

describe('the sub-read no-rows law (an unresolvable match key can NEVER widen a read)', () => {
  it('a null parent-column match value yields [] / the lookup default — no query fires', async () => {
    const surface = new FakeReadSurface(STORES);
    // ref_code is NULL — the sub-reads keyed on it must return nothing, deterministically.
    surface.seed(TENANT, 'orders', {
      order_id: 'o1',
      state: 'open',
      qty: 1,
      rush: false,
      ref_code: null,
    });
    // A same-keyed event exists — it must NOT be reachable through a null key.
    surface.seed(TENANT, 'order_events', { order_id: 'o1', kind: 'audit', hidden: false });
    const view = singleView({
      events: {
        kind: 'list',
        source: { store: 'order_events', match: { order_id: { column: 'ref_code' } } },
        shape: {
          fields: { kind: { kind: 'column', column: 'kind', type: 'string', default: '' } },
        },
      },
      first_kind: {
        kind: 'lookup',
        source: { store: 'order_events', match: { order_id: { column: 'ref_code' } } },
        field: { column: 'kind' },
        type: 'string',
        default: 'none',
      },
    });
    const res = await run(view, surface, { order_id: 'o1' });
    expect(res.body).toEqual({ events: [], first_kind: 'none' });
  });
});

describe('counts semantics', () => {
  function collectView(counts: Record<string, unknown>): ProductViewSpec {
    return {
      id: 'order_counts',
      route: { method: 'GET', path: '/orders/{order_id}/counts' },
      auth: 'bearer_tenant',
      params: { order_id: { in: 'path', shape: 'safe_id' } },
      source: { kind: 'store', ref: 'order_events' },
      read: {
        mode: 'collect',
        filter: { order_id: { param: 'order_id' } },
        shape: { fields: { counts: counts as never } },
      },
      response_contract: 'open_response',
    } as ProductViewSpec;
  }

  it('all_rows counts unknown kinds in total (buckets only tally known ones)', async () => {
    const surface = new FakeReadSurface(STORES);
    for (const kind of ['a', 'a', 'b', 'weird', 'weirder']) {
      surface.seed(TENANT, 'order_events', { order_id: 'o1', kind, hidden: false });
    }
    const res = await run(
      collectView({ kind: 'counts', by: 'kind', buckets: ['a', 'b'], total: 'all_rows' }),
      surface,
      { order_id: 'o1' },
    );
    expect((res.body as Record<string, unknown>).counts).toEqual({ a: 2, b: 1, total: 5 });
  });

  it('bucket_rows counts ONLY bucketed rows in total', async () => {
    const surface = new FakeReadSurface(STORES);
    for (const kind of ['a', 'a', 'b', 'weird']) {
      surface.seed(TENANT, 'order_events', { order_id: 'o1', kind, hidden: false });
    }
    const res = await run(
      collectView({ kind: 'counts', by: 'kind', buckets: ['a', 'b'], total: 'bucket_rows' }),
      surface,
      { order_id: 'o1' },
    );
    expect((res.body as Record<string, unknown>).counts).toEqual({ a: 2, b: 1, total: 3 });
  });
});

describe('group modes', () => {
  function groupView(group: Record<string, unknown>): ProductViewSpec {
    return {
      id: 'order_group',
      route: { method: 'GET', path: '/orders/{order_id}/group' },
      auth: 'bearer_tenant',
      params: { order_id: { in: 'path', shape: 'safe_id' } },
      source: { kind: 'store', ref: 'order_events' },
      read: {
        mode: 'collect',
        filter: { order_id: { param: 'order_id' } },
        order_by: [{ column: 'created_at' }],
        shape: { fields: { g: group as never } },
      },
      response_contract: 'open_response',
    } as ProductViewSpec;
  }

  it('first takes the first matching row, last the last, absent falls back to the literal', async () => {
    const surface = new FakeReadSurface(STORES);
    surface.seed(TENANT, 'order_events', {
      order_id: 'o1',
      kind: 'note',
      payload: { v: 'first' },
      hidden: false,
      created_at: '2026-07-01T10:00:00.000Z',
    });
    surface.seed(TENANT, 'order_events', {
      order_id: 'o1',
      kind: 'note',
      payload: { v: 'last' },
      hidden: false,
      created_at: '2026-07-01T11:00:00.000Z',
    });
    const first = await run(
      groupView({
        kind: 'group',
        column: 'kind',
        equals: 'note',
        mode: 'first',
        value: { column: 'payload', path: ['v'], type: 'string', default: '' },
      }),
      surface,
      { order_id: 'o1' },
    );
    expect((first.body as Record<string, unknown>).g).toBe('first');
    const last = await run(
      groupView({
        kind: 'group',
        column: 'kind',
        equals: 'note',
        mode: 'last',
        value: { column: 'payload', path: ['v'], type: 'string', default: '' },
      }),
      surface,
      { order_id: 'o1' },
    );
    expect((last.body as Record<string, unknown>).g).toBe('last');
    const absent = await run(
      groupView({
        kind: 'group',
        column: 'kind',
        equals: 'missing_kind',
        mode: 'first',
        value: { column: 'payload', path: ['v'], type: 'string', default: '' },
        absent: 'fallback',
      }),
      surface,
      { order_id: 'o1' },
    );
    expect((absent.body as Record<string, unknown>).g).toBe('fallback');
  });
});

describe('exclusion strictness (a malformed flag never hides a row — the canonical `=== true` law)', () => {
  it('excludes ONLY strict-equal rows', async () => {
    const surface = new FakeReadSurface(STORES);
    surface.seed(TENANT, 'order_events', { order_id: 'o1', kind: 'a', hidden: true });
    surface.seed(TENANT, 'order_events', { order_id: 'o1', kind: 'b', hidden: false });
    // a malformed (string) flag — NOT excluded (surfaced, the safe read-route default)
    surface.seed(TENANT, 'order_events', { order_id: 'o1', kind: 'c', hidden: 'yes' as never });
    const view: ProductViewSpec = {
      id: 'order_kinds',
      route: { method: 'GET', path: '/orders/{order_id}/kinds' },
      auth: 'bearer_tenant',
      params: { order_id: { in: 'path', shape: 'safe_id' } },
      source: { kind: 'store', ref: 'order_events' },
      read: {
        mode: 'collect',
        filter: { order_id: { param: 'order_id' } },
        exclude: [{ column: 'hidden', equals: true }],
        shape: {
          fields: {
            kinds: {
              kind: 'group',
              column: 'order_id',
              equals: 'o1',
              mode: 'list',
              value: { column: 'kind', type: 'string', default: '' },
            },
          },
        },
      },
      response_contract: 'open_response',
    } as ProductViewSpec;
    const res = await run(view, surface, { order_id: 'o1' });
    expect((res.body as Record<string, unknown>).kinds).toEqual(['b', 'c']);
  });
});

describe('absent_state not_ready_409 (the readiness gate)', () => {
  it('returns the frozen 409 error contract when no row matches, and the DTO when one does', async () => {
    const surface = new FakeReadSurface(STORES);
    const view = singleView(
      { state: { kind: 'column', column: 'state', type: 'string', default: '' } },
      { absent_state: 'not_ready_409' },
    );
    // lint forbids read.absent with not_ready_409 — drop it from the base view.
    delete (view.read as { absent?: unknown }).absent;
    const notReady = await run(view, surface, { order_id: 'o1' });
    expect(notReady.status).toBe(409);
    expect((notReady.body as Record<string, unknown>).error).toBe('not_ready');
    surface.seed(TENANT, 'orders', { order_id: 'o1', state: 'ready', qty: 1, rush: false });
    const ready = await run(view, surface, { order_id: 'o1' });
    expect(ready.status).toBe(200);
    expect((ready.body as Record<string, unknown>).state).toBe('ready');
  });
});

describe('ETag validator forms', () => {
  function etagView(): ProductViewSpec {
    return singleView(
      { state: { kind: 'column', column: 'state', type: 'string', default: '' } },
      { conditional_read: 'etag' },
    );
  }

  it("matches an exact validator, a validator LIST, and '*'; a weak validator does NOT match", async () => {
    const surface = new FakeReadSurface(STORES);
    surface.seed(TENANT, 'orders', { order_id: 'o1', state: 'open', qty: 1, rush: false });
    const first = await run(etagView(), surface, { order_id: 'o1' });
    const etag = first.headers.ETag as string;
    expect(first.status).toBe(200);

    const exact = await run(etagView(), surface, { order_id: 'o1' }, { 'if-none-match': etag });
    expect(exact.status).toBe(304);

    const list = await run(
      etagView(),
      surface,
      { order_id: 'o1' },
      {
        'if-none-match': `"other", ${etag}`,
      },
    );
    expect(list.status).toBe(304);

    const star = await run(etagView(), surface, { order_id: 'o1' }, { 'if-none-match': '*' });
    expect(star.status).toBe(304);

    const weak = await run(
      etagView(),
      surface,
      { order_id: 'o1' },
      {
        'if-none-match': `W/${etag}`,
      },
    );
    expect(weak.status).toBe(200); // strong comparison only

    // The ETag CHANGES when the data changes (it is a real validator, not a constant).
    surface.seed(TENANT, 'orders', { order_id: 'o2', state: 'x', qty: 1, rush: false });
    const other = await run(etagView(), surface, { order_id: 'o2' });
    expect(other.headers.ETag).not.toBe(etag);
  });
});

describe('identical sub-reads are MEMOIZED per interpretation pass (one select, one row)', () => {
  const LOOKUP_SOURCE = {
    store: 'order_events',
    match: { order_id: { column: 'order_id' } },
  } as const;

  it('three lookups with the SAME (store, match) issue exactly ONE select and read the SAME row', async () => {
    const surface = new FakeReadSurface(STORES);
    surface.seed(TENANT, 'orders', { order_id: 'o1', state: 'open', qty: 1, rush: false });
    surface.seed(TENANT, 'order_events', {
      order_id: 'o1',
      kind: 'audit',
      hidden: false,
      payload: { a: 'x', b: 7 },
    });
    const db = surface.forTenant(TENANT);
    const selects: string[] = [];
    const countingDb = {
      select: (store: string, filter?: Record<string, unknown>, opts?: unknown) => {
        selects.push(store);
        return db.select(store, filter, opts as never);
      },
    };
    // The fixture's per-track pattern: THREE fields, one underlying row (the invariant: ONE select).
    const view = singleView({
      k1: { kind: 'lookup', source: LOOKUP_SOURCE, field: { column: 'kind' }, type: 'string' },
      k2: {
        kind: 'lookup',
        source: LOOKUP_SOURCE,
        field: { column: 'payload', path: ['a'] },
        type: 'string',
      },
      k3: {
        kind: 'lookup',
        source: LOOKUP_SOURCE,
        field: { column: 'payload', path: ['b'] },
        type: 'integer',
      },
    });
    const handler = handlerFor(view);
    const result = await handler({
      tenantId: TENANT,
      db: countingDb,
      params: { order_id: 'o1' },
    } as unknown as RouteHandlerInit);
    expect(result).toEqual({ k1: 'audit', k2: 'x', k3: 7 });
    // Red-first: the un-memoized interpreter issued THREE limit-1 selects here — and under a
    // broken uniqueness assumption could stitch the three fields from DIFFERENT rows.
    expect(selects.filter((s) => s === 'order_events')).toHaveLength(1);
  });

  it('DIFFERENT match values / different sub-reads are NOT conflated (memo key is the full query signature)', async () => {
    const surface = new FakeReadSurface(STORES);
    surface.seed(TENANT, 'orders', {
      order_id: 'o1',
      state: 'open',
      qty: 1,
      rush: false,
      ref_code: 'o2',
    });
    surface.seed(TENANT, 'order_events', { order_id: 'o1', kind: 'own', hidden: false });
    surface.seed(TENANT, 'order_events', { order_id: 'o2', kind: 'other', hidden: false });
    const view = singleView({
      own_kind: {
        kind: 'lookup',
        source: LOOKUP_SOURCE,
        field: { column: 'kind' },
        type: 'string',
      },
      other_kind: {
        kind: 'lookup',
        source: { store: 'order_events', match: { order_id: { column: 'ref_code' } } },
        field: { column: 'kind' },
        type: 'string',
      },
    });
    const res = await run(view, surface, { order_id: 'o1' });
    expect(res.body).toEqual({ own_kind: 'own', other_kind: 'other' });
  });
});

describe('bounded list reads (server-side LIMIT/OFFSET + count; never load-the-tenant)', () => {
  function listView(): ProductViewSpec {
    return {
      id: 'order_event_list',
      route: { method: 'GET', path: '/orders/{order_id}/events' },
      auth: 'bearer_tenant',
      params: { order_id: { in: 'path', shape: 'safe_id' } },
      source: { kind: 'store', ref: 'order_events' },
      pagination: {
        limit_param: 'limit',
        offset_param: 'offset',
        max_limit: 100,
        default_limit: 2,
      },
      read: {
        mode: 'list',
        filter: { order_id: { param: 'order_id' } },
        order_by: [{ column: 'created_at' }],
        shape: {
          fields: {
            items: {
              kind: 'page_items',
              shape: {
                fields: { kind: { kind: 'column', column: 'kind', type: 'string', default: '' } },
              },
            },
            total: { kind: 'page_total' },
            next_offset: { kind: 'page_next_offset' },
          },
        },
      },
      response_contract: 'open_response',
    } as ProductViewSpec;
  }

  function seedFive(surface: FakeReadSurface): void {
    for (let i = 0; i < 5; i++) {
      surface.seed(TENANT, 'order_events', {
        order_id: 'o1',
        kind: `k${i}`,
        hidden: false,
        created_at: `2026-07-01T10:0${i}:00.000Z`,
      });
    }
  }

  it('fetches EXACTLY the page rows (bounded select) and totals via count — wire output unchanged', async () => {
    const surface = new FakeReadSurface(STORES);
    seedFive(surface);
    const db = surface.forTenant(TENANT);
    const mainSelects: Array<{ opts?: { limit?: number; offset?: number }; rows: number }> = [];
    let countCalls = 0;
    const countingDb = {
      select: async (
        store: string,
        filter?: Record<string, unknown>,
        opts?: { limit?: number; offset?: number },
      ) => {
        const rows = await db.select(store, filter, opts as never);
        if (store === 'order_events')
          mainSelects.push({ ...(opts ? { opts } : {}), rows: rows.length });
        return rows;
      },
      count: async (store: string, filter?: Record<string, unknown>) => {
        countCalls += 1;
        return (await db.select(store, filter)).length;
      },
    };
    const handler = handlerFor(listView());
    const body = (await handler({
      tenantId: TENANT,
      db: countingDb,
      params: { order_id: 'o1', limit: '2', offset: '1' },
    } as unknown as RouteHandlerInit)) as Record<string, unknown>;
    // Wire output — BYTE-identical to the full-read law (the goldens pin the same math).
    expect((body.items as Array<{ kind: string }>).map((i) => i.kind)).toEqual(['k1', 'k2']);
    expect(body.total).toBe(5);
    expect(body.next_offset).toBe(3);
    // Red-first: the un-bounded interpreter loaded the ENTIRE tenant match (5 rows, no
    // limit) and sliced in memory. Bounded: ONE select carrying limit/offset, fetching page-size rows.
    expect(mainSelects).toHaveLength(1);
    expect(mainSelects[0]?.opts?.limit).toBe(2);
    expect(mainSelects[0]?.opts?.offset).toBe(1);
    expect(mainSelects[0]?.rows).toBe(2);
    expect(countCalls).toBe(1);
  });

  it('FALLS BACK to the full read when the surface has no count primitive (older facades) — same wire output', async () => {
    const surface = new FakeReadSurface(STORES);
    seedFive(surface);
    const db = surface.forTenant(TENANT);
    const selectOnly = {
      select: (store: string, filter?: Record<string, unknown>, opts?: unknown) =>
        db.select(store, filter, opts as never),
    };
    const handler = handlerFor(listView());
    const body = (await handler({
      tenantId: TENANT,
      db: selectOnly,
      params: { order_id: 'o1', limit: '2', offset: '1' },
    } as unknown as RouteHandlerInit)) as Record<string, unknown>;
    expect((body.items as Array<{ kind: string }>).map((i) => i.kind)).toEqual(['k1', 'k2']);
    expect(body.total).toBe(5);
    expect(body.next_offset).toBe(3);
  });
});

describe('param handling beyond the goldens', () => {
  it('FCY-2: an optional param named like an Object.prototype member works when ABSENT (no false-positive 400)', async () => {
    const surface = new FakeReadSurface(STORES);
    surface.seed(TENANT, 'orders', { order_id: 'o1', state: 'open', qty: 1, rush: false });
    for (const name of ['toString', 'valueOf', 'hasOwnProperty']) {
      const view = singleView(
        {
          state: { kind: 'column', column: 'state', type: 'string', default: '' },
          echo: { kind: 'param', param: name },
        },
        {
          params: {
            order_id: { in: 'path', shape: 'safe_id' },
            [name]: { in: 'query', shape: 'string' },
          },
        },
      );
      // ABSENT: the inherited Object.prototype method must NOT read as a present (malformed) value.
      const missing = await run(view, surface, { order_id: 'o1' });
      expect(missing.status, `optional '${name}' absent must not 400`).toBe(200);
      expect((missing.body as Record<string, unknown>).echo).toBeNull();
      // PRESENT: the real own value flows through.
      const present = await run(view, surface, { order_id: 'o1', [name]: 'v' });
      expect(present.status).toBe(200);
      expect((present.body as Record<string, unknown>).echo).toBe('v');
    }
  });

  it('a MISSING required query param → 400; an absent OPTIONAL param echoes null', async () => {
    const surface = new FakeReadSurface(STORES);
    surface.seed(TENANT, 'orders', { order_id: 'o1', state: 'open', qty: 1, rush: false });
    const view = singleView(
      {
        state: { kind: 'column', column: 'state', type: 'string', default: '' },
        echo: { kind: 'param', param: 'note' },
      },
      {
        params: {
          order_id: { in: 'path', shape: 'safe_id' },
          note: { in: 'query', shape: 'string' },
          must: { in: 'query', shape: 'safe_id', required: true },
        },
      },
    );
    const missing = await run(view, surface, { order_id: 'o1' });
    expect(missing.status).toBe(400);
    expect((missing.body as Record<string, unknown>).error).toBe('bad_request');

    const ok = await run(view, surface, { order_id: 'o1', must: 'x' });
    expect(ok.status).toBe(200);
    expect((ok.body as Record<string, unknown>).echo).toBeNull(); // optional absent → null

    const withNote = await run(view, surface, { order_id: 'o1', must: 'x', note: 'hi' });
    expect((withNote.body as Record<string, unknown>).echo).toBe('hi');
  });

  it('UNDECLARED query params are ignored (wire-compatible — request params are DATA)', async () => {
    const surface = new FakeReadSurface(STORES);
    surface.seed(TENANT, 'orders', { order_id: 'o1', state: 'open', qty: 1, rush: false });
    const view = singleView({
      state: { kind: 'column', column: 'state', type: 'string', default: '' },
    });
    const res = await run(view, surface, { order_id: 'o1', cache_bust: '123', limt: '5' });
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).state).toBe('open');
  });
});
