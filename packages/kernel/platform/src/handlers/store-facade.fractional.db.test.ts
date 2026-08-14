/**
 * Store-facade DB tests for the FRACTIONAL column types — `double` (float8) and
 * `numeric(precision, scale)` (exact decimal) — on the low-level HandlerDb write/read funnel.
 *
 * The facade is the OTHER write chokepoint (beside the HTTP body validator) and the ONLY read
 * chokepoint for handlers, the workflow `store_read`/`store_write` nodes, and the declarative views
 * interpreter — so the two types' envelopes must hold here too:
 *  - `double` takes a FINITE JS number. A handler passes real JS numbers, so NaN/Infinity CAN reach
 *    this boundary (unlike JSON) — each is refused fail-closed, never stored, never a silent null.
 *  - `numeric` takes a decimal STRING validated against the column's declared (precision, scale) —
 *    read off the runtime PgColumn — refused rather than rounded when it does not fit. A JS number
 *    is refused outright (float64 already corrupted what the author meant; exactness is unprovable).
 *  - READ side: a numeric value returns as the exact string; a non-finite float8 planted by SQL is
 *    refused (JSON.stringify would silently turn NaN into null — the corruption the guard refuses).
 *
 * Skips when DATABASE_URL is absent; HARD-FAILS when the DB is required (CI /
 * RAYSPEC_REQUIRE_DB_TESTS) yet absent.
 */
import { forTenant } from '@rayspec/db';
import {
  buildProductTables,
  injectedColumnLinesSql,
  makeDbWithSchema,
  registerScopedTables,
} from '@rayspec/db/testing';
import type { StoreSpec } from '@rayspec/spec';
import type { PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeHandlerDb, StoreInputError } from './store-facade.js';

const SCHEMA = 'rayspec_test_handlerdb_fractional';
const TENANT_A = '00000000-0000-0000-0000-0000000000da';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (requireDb && !hasDb) {
  throw new Error(
    'store-facade.fractional.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but ' +
      'absent — refusing to silently skip the double/numeric facade envelope suite.',
  );
}
let testsRan = 0;

/** A decimal a float64 round-trip corrupts (18 integer digits + nonzero fraction) — see the api twin. */
const EXACT_DECIMAL = '123456789012345678.123456';

// FRACTIONAL fixture — one store carrying both new types (a real float8 + a real numeric(24, 6)
// column, so the driver hands the facade exactly what a deployment's column would).
const measurementsStore: StoreSpec = {
  name: 'measurements',
  columns: [
    { name: 'confidence', type: 'double', nullable: false, unique: false },
    { name: 'amount', type: 'numeric', nullable: false, unique: false, precision: 24, scale: 6 },
    { name: 'label', type: 'text', nullable: true, unique: false },
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
      CREATE TABLE measurements (
        ${before},
        confidence double precision NOT NULL,
        amount numeric(24, 6) NOT NULL,
        label text,
        ${after}
      );
      INSERT INTO orgs (id, name) VALUES ('${TENANT_A}', 'A');
    `;
}

describe.skipIf(!hasDb)('makeHandlerDb — double/numeric envelopes over the real chokepoint', () => {
  let db: ReturnType<typeof makeDbWithSchema>;
  let productTables: Map<string, PgTable>;
  let unregister: () => void;

  beforeAll(async () => {
    db = makeDbWithSchema(process.env.DATABASE_URL as string, SCHEMA);
    await db.$client.unsafe(buildSchemaSql());
    productTables = buildProductTables([measurementsStore]);
    unregister = registerScopedTables([...productTables.values()]);
  });
  beforeEach(async () => {
    await db.$client.unsafe(`TRUNCATE ${SCHEMA}.measurements`);
  });
  afterAll(async () => {
    unregister();
    await db.$client.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await db.$client.end();
  });

  const handlerDb = () => makeHandlerDb(forTenant(db, TENANT_A), productTables);

  it('round-trips a finite double and an exact numeric string (byte-equal past float64)', async () => {
    testsRan += 1;
    const hdb = handlerDb();
    const row = await hdb.insert('measurements', {
      confidence: 0.30000000000000004,
      amount: EXACT_DECIMAL,
    });
    expect(row.confidence).toBe(0.30000000000000004);
    expect(typeof row.confidence).toBe('number');
    expect(row.amount).toBe(EXACT_DECIMAL); // exact string, never through float64
    expect(typeof row.amount).toBe('string');

    const read = await hdb.select('measurements', { amount: EXACT_DECIMAL });
    expect(read.length).toBe(1);
    expect(read[0]?.amount).toBe(EXACT_DECIMAL);
  });

  it('REFUSES NaN and Infinity on a double column — fail-closed, never stored, never null', async () => {
    testsRan += 1;
    const hdb = handlerDb();
    for (const v of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      await expect(hdb.insert('measurements', { confidence: v, amount: '1' })).rejects.toThrow(
        StoreInputError,
      );
    }
    // A string on a double column is refused too (the envelope is a JS number).
    await expect(hdb.insert('measurements', { confidence: '0.5', amount: '1' })).rejects.toThrow(
      StoreInputError,
    );
    // Nothing was written by any refused insert.
    expect((await hdb.count('measurements')).valueOf()).toBe(0);
  });

  it('REFUSES a numeric value that does not fit numeric(24, 6) — never rounded', async () => {
    testsRan += 1;
    const hdb = handlerDb();
    // A JS number is refused outright (exactness unprovable after float64).
    await expect(hdb.insert('measurements', { confidence: 1, amount: 12.5 })).rejects.toThrow(
      StoreInputError,
    );
    // More fractional digits than the scale would ROUND in Postgres — refused instead.
    await expect(
      hdb.insert('measurements', { confidence: 1, amount: '1.2345671' }),
    ).rejects.toThrow(StoreInputError);
    // More integer digits than precision - scale would overflow — refused early, named clearly.
    await expect(
      hdb.insert('measurements', { confidence: 1, amount: '1234567890123456789.5' }),
    ).rejects.toThrow(StoreInputError);
    // Malformed decimal shapes.
    for (const bad of ['abc', '1e5', '', '1.2.3', '+1', 'NaN']) {
      await expect(hdb.insert('measurements', { confidence: 1, amount: bad })).rejects.toThrow(
        StoreInputError,
      );
    }
    expect((await hdb.count('measurements')).valueOf()).toBe(0);
  });

  it('READ guard: a non-finite float8 planted by direct SQL is REFUSED, not a silent null', async () => {
    testsRan += 1;
    const hdb = handlerDb();
    const row = await hdb.insert('measurements', { confidence: 0.5, amount: '1' });
    await db.$client.unsafe(
      `UPDATE ${SCHEMA}.measurements SET confidence = 'NaN'::float8 WHERE id = $1`,
      [row.id as string],
    );
    // JSON.stringify(NaN) is null — the silent corruption the read-side guard refuses.
    await expect(hdb.select('measurements')).rejects.toThrow(StoreInputError);
  });

  it('READ guard: a NaN planted into a NUMERIC column by direct SQL is REFUSED too', async () => {
    testsRan += 1;
    const hdb = handlerDb();
    const row = await hdb.insert('measurements', { confidence: 0.5, amount: '1' });
    // NaN is the one non-decimal a DECLARED numeric column can hold: `precision`/`scale` are
    // required on the type, and PostgreSQL refuses ±Infinity for a column that has them (22003,
    // "A field with precision 24, scale 6 cannot hold an infinite value") — pinned below. The write
    // paths refuse the string 'NaN' as well, so only direct SQL can put one here. The read refuses
    // rather than hand a handler (or the views interpreter, or a `store_read` node) a value under
    // a type whose whole promise is an exact decimal.
    await db.$client.unsafe(
      `UPDATE ${SCHEMA}.measurements SET amount = 'NaN'::numeric WHERE id = $1`,
      [row.id as string],
    );
    await expect(hdb.select('measurements', { id: row.id as string })).rejects.toThrow(
      StoreInputError,
    );
    // Why the loop above is one value and not three: the DB itself closes the other two.
    await expect(
      db.$client.unsafe(
        `UPDATE ${SCHEMA}.measurements SET amount = 'Infinity'::numeric WHERE id = $1`,
        [row.id as string],
      ),
    ).rejects.toThrow(/numeric field overflow/);

    // ACCEPT CONTROL: the same read on an unplanted row returns the exact decimal untouched — so
    // the refusal above is the guard firing on that value, not a read that refuses everything.
    await db.$client.unsafe(`DELETE FROM ${SCHEMA}.measurements WHERE id = $1`, [row.id as string]);
    const clean = await hdb.insert('measurements', { confidence: 0.5, amount: EXACT_DECIMAL });
    const read = await hdb.select('measurements', { id: clean.id as string });
    expect(read.map((r) => r.amount)).toEqual([EXACT_DECIMAL]);
  });

  it('orders both types NUMERICALLY through the facade select (the sortability seam)', async () => {
    testsRan += 1;
    const hdb = handlerDb();
    // '9.999999' sorts after '10.000001' lexicographically — the discriminator for numeric ordering.
    await hdb.insert('measurements', { confidence: 2.5, amount: '10.000002' });
    await hdb.insert('measurements', { confidence: 0.5, amount: '9.999999' });
    await hdb.insert('measurements', { confidence: 1.5, amount: '10.000001' });

    const byAmount = await hdb.select('measurements', undefined, {
      orderBy: [{ column: 'amount', dir: 'asc' }],
    });
    expect(byAmount.map((r) => r.amount)).toEqual(['9.999999', '10.000001', '10.000002']);

    const byConfidence = await hdb.select('measurements', undefined, {
      orderBy: [{ column: 'confidence', dir: 'desc' }],
    });
    expect(byConfidence.map((r) => r.confidence)).toEqual([2.5, 1.5, 0.5]);
  });
});

/** Ran-guard: fails when the DB is REQUIRED but the arms did not run (no silent false-green). */
describe('fractional facade acceptance — ran-guard (must not silently skip in CI)', () => {
  it('the double/numeric facade arms ACTUALLY RAN when the DB is required (CI / opt-in)', () => {
    if (requireDb) {
      expect(testsRan).toBe(6);
    } else {
      expect(requireDb).toBe(false);
    }
  });
});
