/**
 * Unit proofs for the `list` query-builder's search-term length bound (no DB — `buildListQuery` is a
 * pure function over a StoreSpec + a runtime PgTable + URLSearchParams). A caller-supplied `?search=` /
 * `?<col>__contains=` term feeds an `ILIKE '%term%'` scan, so an unbounded term is a work/DoS lever;
 * the builder caps it at `MAX_SEARCH_TERM` (256) Unicode CODE POINTS.
 *
 * Fail-the-fix: WITHOUT the bound, a 257-character term is accepted (a predicate is built, no throw) —
 * every "must reject" assertion here goes RED. The code-point-measure cases additionally go RED under a
 * WRONG measure (`term.length` / bytes): 256 astral emoji are 512 UTF-16 units, so a UTF-16 measure
 * would wrongly reject them.
 */
import { ApiError } from '@rayspec/auth-core';
import { buildProductTables } from '@rayspec/db/testing';
import { parseSpec, type StoreSpec } from '@rayspec/spec';
import { PgDialect, type PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { buildListQuery, type ListQuery } from './store-query.js';

// A minimal self-contained backend-profile spec: one store with one searchable text column.
const YAML = `
version: '1.0'
metadata:
  name: search-query-unit
  description: A backend exercising the list search-term length bound.
stores:
  - name: docs
    columns:
      - { name: title, type: text }
`;

const parsed = parseSpec(YAML);
if (!parsed.ok) throw new Error(`search-query fixture invalid: ${JSON.stringify(parsed.errors)}`);
const store: StoreSpec = parsed.value.stores[0];
const built = buildProductTables(parsed.value.stores).get('docs');
if (!built) throw new Error("expected a runtime table for store 'docs'");
const table: PgTable = built;

/** Build a URLSearchParams carrying one raw (un-encoded-by-hand) key/value. */
function params(key: string, term: string): URLSearchParams {
  const p = new URLSearchParams();
  p.set(key, term);
  return p;
}

/** Assert `fn` throws an ApiError('VALIDATION_ERROR') whose message matches `re`. */
function expectValidation(fn: () => unknown, re: RegExp): void {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).code).toBe('VALIDATION_ERROR');
  expect((err as ApiError).message).toMatch(re);
}

const A = (n: number): string => 'a'.repeat(n);
// U+1F600 GRINNING FACE — one code point, TWO UTF-16 units (an astral/surrogate-pair char).
const EMOJI = (n: number): string => '😀'.repeat(n);

// A full-text-search store (two text columns) + its NON-FTS counterpart (same shape, no opt-in).
const FTS_YAML = `
version: '1.0'
metadata:
  name: fts-query-unit
stores:
  - name: docs
    fullTextSearch: true
    columns:
      - { name: title, type: text }
      - { name: body, type: text }
  - name: plain
    columns:
      - { name: title, type: text }
`;
const ftsParsed = parseSpec(FTS_YAML);
if (!ftsParsed.ok) throw new Error(`fts fixture invalid: ${JSON.stringify(ftsParsed.errors)}`);
const ftsStore: StoreSpec = ftsParsed.value.stores[0];
const plainStore: StoreSpec = ftsParsed.value.stores[1];
const ftsTable = buildProductTables(ftsParsed.value.stores).get('docs');
const plainTable = buildProductTables(ftsParsed.value.stores).get('plain');
if (!ftsTable || !plainTable) throw new Error('expected fts + plain runtime tables');

/** Build a URLSearchParams from a plain key→value record (multi-key). */
function multi(entries: Record<string, string>): URLSearchParams {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(entries)) p.set(k, v);
  return p;
}
/** Render a drizzle SQL fragment to its parameterized SQL string (no DB). */
function render(sql: ListQuery['where'] | ListQuery['orderBy'][number] | undefined): string {
  if (sql === undefined) return '';
  return new PgDialect().sqlToQuery(sql).sql;
}

describe('buildListQuery — ranked full-text search (?__search=)', () => {
  it('rejects __search on a store that does NOT enable full-text search (fail-closed 400)', () => {
    expectValidation(
      () => buildListQuery(plainStore, plainTable as PgTable, multi({ __search: 'hello' })),
      /'__search' is not available: this store does not enable full-text search/,
    );
  });

  it('rejects an empty __search and one over the length bound', () => {
    expectValidation(
      () => buildListQuery(ftsStore, ftsTable as PgTable, multi({ __search: '' })),
      /'__search' must not be empty/,
    );
    expectValidation(
      () => buildListQuery(ftsStore, ftsTable as PgTable, multi({ __search: A(257) })),
      /'__search' must be at most 256 characters/,
    );
  });

  it('rejects __search combined with order / after / search (mutually exclusive)', () => {
    expectValidation(
      () =>
        buildListQuery(ftsStore, ftsTable as PgTable, multi({ __search: 'x', order: 'title.asc' })),
      /'order' cannot be combined with '__search'/,
    );
    expectValidation(
      () => buildListQuery(ftsStore, ftsTable as PgTable, multi({ __search: 'x', after: 'abc' })),
      /'after' \(keyset pagination\) is not supported with '__search'/,
    );
    expectValidation(
      () => buildListQuery(ftsStore, ftsTable as PgTable, multi({ __search: 'x', search: 'y' })),
      /'search' \(substring\) cannot be combined with '__search'/,
    );
  });

  it('builds a ranked query: a search_vector @@ websearch_to_tsquery predicate + ts_rank DESC order', () => {
    const q = buildListQuery(ftsStore, ftsTable as PgTable, multi({ __search: 'postgres search' }));
    expect(q.rankedSearch).toBe(true);
    const where = render(q.where);
    expect(where).toContain('"search_vector"');
    expect(where).toContain('@@');
    expect(where).toContain('websearch_to_tsquery');
    // ORDER BY ts_rank(...) DESC, id ASC — two expressions, the first ranked descending.
    expect(q.orderBy).toHaveLength(2);
    const rank = render(q.orderBy[0]);
    expect(rank).toContain('ts_rank');
    expect(rank.toLowerCase()).toContain('desc');
  });

  it('composes with equality filters (a __search + a column filter fold into one AND-chain)', () => {
    const q = buildListQuery(
      ftsStore,
      ftsTable as PgTable,
      multi({ __search: 'postgres', title: 'Guide' }),
    );
    expect(q.rankedSearch).toBe(true);
    const where = render(q.where);
    expect(where).toContain('websearch_to_tsquery');
    expect(where).toContain('"title"');
  });

  it('a non-ranked list (no __search) leaves rankedSearch falsy and mints the normal order', () => {
    const q = buildListQuery(ftsStore, ftsTable as PgTable, new URLSearchParams());
    expect(q.rankedSearch ?? false).toBe(false);
    expect(render(q.orderBy[0])).not.toContain('ts_rank');
  });
});

describe('buildListQuery — search-term length bound (256 Unicode code points)', () => {
  describe('?search=', () => {
    it('accepts exactly 256 characters and rejects 257 with a 400 VALIDATION_ERROR', () => {
      expect(() => buildListQuery(store, table, params('search', A(256)))).not.toThrow();
      expectValidation(
        () => buildListQuery(store, table, params('search', A(257))),
        /Query 'search' must be at most 256 characters/,
      );
    });

    it('measures code points, not UTF-16 units: 256 astral emoji accepted, 257 rejected', () => {
      const at = EMOJI(256);
      expect(at.length).toBe(512); // 512 UTF-16 units …
      expect([...at].length).toBe(256); // … but 256 code points → accepted by the code-point measure
      expect(() => buildListQuery(store, table, params('search', at))).not.toThrow();
      expectValidation(
        () => buildListQuery(store, table, params('search', EMOJI(257))),
        /Query 'search' must be at most 256 characters/,
      );
    });
  });

  describe('?<col>__contains=', () => {
    it('accepts exactly 256 characters and rejects 257 with a 400 VALIDATION_ERROR', () => {
      expect(() => buildListQuery(store, table, params('title__contains', A(256)))).not.toThrow();
      expectValidation(
        () => buildListQuery(store, table, params('title__contains', A(257))),
        /Filter 'title__contains' must be at most 256 characters/,
      );
    });

    it('measures code points, not UTF-16 units: 256 astral emoji accepted, 257 rejected', () => {
      expect(() =>
        buildListQuery(store, table, params('title__contains', EMOJI(256))),
      ).not.toThrow();
      expectValidation(
        () => buildListQuery(store, table, params('title__contains', EMOJI(257))),
        /Filter 'title__contains' must be at most 256 characters/,
      );
    });
  });
});
