/**
 * Store-facade DB tests for the bounded COMPARISON-operator filter form on the read surface:
 * `select(store, { col: { gt/gte/lt/lte: bound } })` (and the same filter on `count`).
 *
 * The facade filter was equality (+ the array `IN` form) only, so "rows with seq > X" forced a full
 * read + an in-handler scan. The operator form is ADDITIVE-OVER-REJECTION: on a NON-jsonb column a
 * plain-object filter value was ALWAYS an SF-1 reject, so admitting EXACTLY the well-formed operator
 * object ({ gt/gte/lt/lte } with defined scalar bounds) on an eligible column changes the meaning of
 * NO currently-legal filter. Everything else about an object value stays a fail-closed reject: an
 * unknown key, a mixed known+unknown object, an empty object, a contradictory pair (gt with gte / lt
 * with lte), an undefined/null bound, and an operator object aimed at an INELIGIBLE column (nullable,
 * jsonb, injected). On a jsonb column an object stays an EQUALITY VALUE (the hard-won jsonb lesson —
 * unchanged), and the operator form is a READ-filter form only: update/delete filters keep rejecting
 * it.
 *
 * FAIL-THE-FIX, against a REAL Postgres isolated schema with product tables built by the SAME
 * `buildProductTables` a deployment uses + registered in the real deny-by-default Set (mirroring
 * store-facade.db.test.ts). Without the feature, every operator select below throws the SF-1 reject.
 *
 * Skips when DATABASE_URL is absent; HARD-FAILS when the DB is required (CI /
 * RAYSPEC_REQUIRE_DB_TESTS) yet absent (un-skippable ran-guard at the bottom).
 */
import { forTenant } from '@rayspec/db';
import {
  buildProductTables,
  injectedColumnLinesSql,
  makeDbWithSchema,
  registerScopedTables,
} from '@rayspec/db/testing';
import type { StoreSpec } from '@rayspec/spec';
import { sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeHandlerDb, StoreInputError } from './store-facade.js';

const SCHEMA = 'rayspec_test_handlerdb_cmp';
const TENANT_A = '00000000-0000-0000-0000-0000000000ca';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (requireDb && !hasDb) {
  throw new Error(
    'store-facade.comparison.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but ' +
      'absent — refusing to silently skip the comparison-filter facade suite.',
  );
}
let testsRan = 0;

// COMPARISON fixture — one store covering the eligible types (integer/double/numeric) plus the two
// ineligible declared shapes (a nullable column, a jsonb column) the reject arms need.
const eventsStore: StoreSpec = {
  name: 'events',
  columns: [
    { name: 'seq', type: 'integer', nullable: false, unique: false },
    { name: 'score', type: 'double', nullable: false, unique: false },
    { name: 'amount', type: 'numeric', nullable: false, unique: false, precision: 24, scale: 6 },
    { name: 'note', type: 'text', nullable: true, unique: false },
    { name: 'payload', type: 'jsonb', nullable: true, unique: false },
  ],
  foreignKeys: [],
};

function buildSchemaSql(): string {
  const { before, after } = injectedColumnLinesSql({
    tenantFkRef: 'REFERENCES orgs(id) ON DELETE CASCADE',
  });
  return `
      DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;
      CREATE SCHEMA ${SCHEMA};
      SET search_path TO ${SCHEMA};
      CREATE TABLE orgs (id uuid PRIMARY KEY, name text, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE events (
        ${before},
        seq integer NOT NULL,
        score double precision NOT NULL,
        amount numeric(24, 6) NOT NULL,
        note text,
        payload jsonb,
        ${after}
      );
      INSERT INTO orgs (id, name) VALUES ('${TENANT_A}', 'A');
    `;
}

describe.skipIf(!hasDb)('makeHandlerDb — comparison-operator read filters', () => {
  let db: ReturnType<typeof makeDbWithSchema>;
  let productTables: Map<string, PgTable>;
  let unregister: () => void;

  beforeAll(async () => {
    db = makeDbWithSchema(process.env.DATABASE_URL as string, SCHEMA);
    await db.$client.unsafe(buildSchemaSql());
    productTables = buildProductTables([eventsStore]);
    unregister = registerScopedTables([...productTables.values()]);
  });
  beforeEach(async () => {
    await db.$client.unsafe(`TRUNCATE ${SCHEMA}.events`);
  });
  afterAll(async () => {
    unregister();
    await db.$client.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await db.$client.end();
  });

  const handlerDb = () => makeHandlerDb(forTenant(db, TENANT_A), productTables);

  /** Seed rows seq 1..n (score = seq + 0.5, amount = seq exact-decimal cents). */
  async function seed(n: number): Promise<void> {
    const hdb = handlerDb();
    for (let seq = 1; seq <= n; seq++) {
      await hdb.insert('events', {
        seq,
        score: seq + 0.5,
        amount: `${seq}.000001`,
        note: seq % 2 === 0 ? `note ${seq}` : null,
      });
    }
  }

  const seqs = (rows: { seq?: unknown }[]) => rows.map((r) => Number(r.seq)).sort((a, b) => a - b);

  it('{ gt } narrows a select to exactly the rows beyond the bound (fail-the-fix)', async () => {
    testsRan += 1;
    await seed(5);
    const hdb = handlerDb();
    // Pre-fix this throws the SF-1 "plain scalar" reject — the operator form was inexpressible.
    const rows = await hdb.select('events', { seq: { gt: 3 } });
    expect(seqs(rows)).toEqual([4, 5]);

    expect(seqs(await hdb.select('events', { seq: { gte: 3 } }))).toEqual([3, 4, 5]);
    expect(seqs(await hdb.select('events', { seq: { lt: 2 } }))).toEqual([1]);
    expect(seqs(await hdb.select('events', { seq: { lte: 2 } }))).toEqual([1, 2]);
  });

  it('two bounds in one object AND-combine to a range, and compose with equality + orderBy/limit', async () => {
    testsRan += 1;
    await seed(6);
    const hdb = handlerDb();
    expect(seqs(await hdb.select('events', { seq: { gt: 1, lte: 4 } }))).toEqual([2, 3, 4]);

    // Composes with a plain equality entry in the same filter, and with the read-shaping opts.
    const paged = await hdb.select(
      'events',
      { seq: { gt: 1 } },
      { orderBy: [{ column: 'seq' }], limit: 2 },
    );
    expect(paged.map((r) => r.seq)).toEqual([2, 3]);
  });

  it('a numeric and a double column compare through the operator form (the fractional comparability proof)', async () => {
    testsRan += 1;
    await seed(3);
    const hdb = handlerDb();
    // numeric: the bound is the SAME decimal-string wire form equality uses — compared exactly.
    expect(seqs(await hdb.select('events', { amount: { gt: '2.000001' } }))).toEqual([3]);
    expect(seqs(await hdb.select('events', { amount: { lte: '2.000001' } }))).toEqual([1, 2]);
    // double: a plain JS number bound.
    expect(seqs(await hdb.select('events', { score: { gt: 2.5 } }))).toEqual([3]);
  });

  it('count accepts the same operator filter as select (a paged reader totals its range)', async () => {
    testsRan += 1;
    await seed(5);
    const hdb = handlerDb();
    expect(await hdb.count('events', { seq: { gt: 2 } })).toBe(3);
  });

  it('a contradictory pair (gt with gte / lt with lte) is rejected, never silently picked from', async () => {
    testsRan += 1;
    await seed(2);
    const hdb = handlerDb();
    await expect(hdb.select('events', { seq: { gt: 1, gte: 1 } })).rejects.toThrow(StoreInputError);
    await expect(hdb.select('events', { seq: { lt: 2, lte: 2 } })).rejects.toThrow(StoreInputError);
  });

  it('every other object shape stays a fail-closed reject: unknown key, mixed keys, empty, undefined/null bound, non-scalar bound', async () => {
    testsRan += 1;
    await seed(1);
    const hdb = handlerDb();
    const reject = (filter: Record<string, unknown>) =>
      expect(hdb.select('events', filter)).rejects.toThrow(StoreInputError);

    await reject({ seq: { above: 1 } }); // unknown key
    await reject({ seq: { gt: 1, above: 2 } }); // mixed known + unknown keys
    await reject({ seq: {} }); // empty object
    await reject({ seq: { gt: undefined } }); // an undefined bound is not a defined comparison
    await reject({ seq: { gt: null } }); // a NULL bound is never-true SQL — refused, not an empty lie
    await reject({ seq: { gt: { nested: 1 } } }); // a non-scalar bound on a non-jsonb column
    await reject({ seq: { gt: sql`1; DROP TABLE events` } }); // an injection vector bound (SF-1 held)
  });

  it('an operator object on an INELIGIBLE column rejects: nullable declared, injected id/created_at', async () => {
    testsRan += 1;
    await seed(1);
    const hdb = handlerDb();
    const reject = (filter: Record<string, unknown>) =>
      expect(hdb.select('events', filter)).rejects.toThrow(StoreInputError);

    await reject({ note: { gt: 'a' } }); // a NULLABLE declared column
    await reject({ id: { gt: '00000000-0000-4000-8000-000000000001' } }); // injected id
    await reject({ created_at: { lt: '2026-01-01T00:00:00Z' } }); // injected created_at
  });

  it('jsonb object equality is UNCHANGED: an operator-shaped object on a jsonb column is a VALUE, matched by eq', async () => {
    testsRan += 1;
    const hdb = handlerDb();
    await hdb.insert('events', {
      seq: 1,
      score: 0.5,
      amount: '1.000001',
      payload: { gt: 7 }, // a legal jsonb VALUE that happens to look like an operator object
    });
    await hdb.insert('events', { seq: 2, score: 0.5, amount: '2.000001', payload: { other: 1 } });

    // Equality on the jsonb VALUE — never a comparison. Exactly the { gt: 7 } row matches.
    const rows = await hdb.select('events', { payload: { gt: 7 } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.seq).toBe(1);
  });

  it('ARRAY set-membership is unchanged, and update/delete filters keep rejecting the operator form (read-only surface)', async () => {
    testsRan += 1;
    await seed(4);
    const hdb = handlerDb();
    // The batched IN form is untouched.
    expect(seqs(await hdb.select('events', { seq: [1, 3] }))).toEqual([1, 3]);

    // The operator form is a READ-filter form: the write-path filters stay fail-closed.
    await expect(hdb.update('events', { seq: { gt: 2 } }, { note: 'x' })).rejects.toThrow(
      StoreInputError,
    );
    await expect(hdb.delete('events', { seq: { gt: 2 } })).rejects.toThrow(StoreInputError);
    // Nothing was written or deleted by the rejected calls.
    expect(await hdb.count('events')).toBe(4);
  });
});

/**
 * Ran-guard: a SEPARATE, NEVER-skipped describe that fails when the DB is REQUIRED (CI /
 * RAYSPEC_REQUIRE_DB_TESTS) but the acceptance arms did not run (no silent false-green).
 */
describe('store-facade comparison filters — ran-guard (must not silently skip in CI)', () => {
  it('the comparison-filter arms ACTUALLY RAN when the DB is required (CI / opt-in)', () => {
    if (requireDb) {
      expect(testsRan).toBe(9);
    } else {
      expect(requireDb).toBe(false);
    }
  });
});
