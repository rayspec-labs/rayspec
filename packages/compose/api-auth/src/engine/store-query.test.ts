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
import type { PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { buildListQuery } from './store-query.js';

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
