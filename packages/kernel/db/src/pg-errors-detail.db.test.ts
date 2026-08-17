/**
 * DISCLOSURE HYGIENE FOR A DRIVER ERROR'S DIAGNOSTIC FIELDS — DB-backed, against real driver errors.
 *
 * Postgres does not put the offending value only in the message it writes. On a constraint violation
 * it fills the error's `detail` field with the value the caller supplied:
 *
 *     unique  (23505) → Key (id)=(<the value>) already exists.
 *     foreign (23503) → Key (parent)=(<the value>) is not present in table "…".
 *     check   (23514) → Failing row contains (<EVERY column of the row>).
 *
 * The check case is the widest: `detail` is the WHOLE ROW, not one key column. And `detail` is an
 * OWN ENUMERABLE property of the driver's error, while `message` and `stack` are not — so it escapes
 * through exactly the shapes that look least like a mistake at the call site: `console.error(msg,
 * err)`, `JSON.stringify(err)`, `{...err}`, `Object.entries(err)`. None of those touch `.message`.
 *
 * TWO ERROR SHAPES, NOT ONE. The ORM wraps a driver failure in an error of its own (`query` + the
 * bound `params`, with the driver's error as `.cause`); the raw-SQL door throws the driver's error
 * DIRECTLY, with no wrapper and its statement under a different property name. Both are caught by
 * shipped code, so both are exercised here — the renderer has to be safe for the pair, not for the
 * one the ORM happens to produce.
 *
 * THE ACCEPT CONTROL IS NOT OPTIONAL. Every assertion here is "this string is absent", and an
 * absence proves nothing unless the string is provably present in the material the renderer was
 * handed. So each case FIRST asserts the canary IS in the raw error — in `detail`, in the enumerable
 * entries, in `JSON.stringify` — and only then that it is gone from the rendering. A suite that
 * checked absence alone would keep passing the day the fixture stopped binding the value, which is
 * exactly how a redaction defect survives its own tests.
 *
 * THE CANARY IS THE DUPLICATED KEY, SEEDED FIRST, so `detail` genuinely echoes it rather than the
 * suite asserting against a value Postgres never saw.
 *
 * Isolated per-suite schema — never `public`. Skips without DATABASE_URL; HARD-FAILS when the DB is
 * required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { operatorSafeDbErrorMessage, operatorSafeDbErrorStack } from './pg-errors.js';
import { makeDbWithSchema } from './testing.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (requireDb && !hasDb) {
  throw new Error(
    'pg-errors-detail.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — ' +
      'refusing to silently skip the driver-diagnostic disclosure proofs.',
  );
}
const describeDb = hasDb ? describe : describe.skip;

const SCHEMA = 'rayspec_test_pg_errors_detail';

/** The value that must never reach an operator-facing rendering. Distinctive: a substring match decides. */
const CANARY = 'CANARY-detail-9f3c1d-must-not-be-rendered';
/** A second value, present only in the check-violation ROW, to prove `detail` carries the whole row. */
const ROW_MATE = 'ROWMATE-detail-51ab7e-must-not-be-rendered';

const db = makeDbWithSchema(process.env.DATABASE_URL ?? '', SCHEMA, 1);

/** Every own ENUMERABLE entry of an error, flattened — the material `console.error(obj)` prints. */
function enumerableEntriesOf(err: unknown): string {
  const seen = new Set<unknown>();
  const walk = (node: unknown, depth: number): string => {
    if (depth > 5 || node === null || typeof node !== 'object' || seen.has(node)) return '';
    seen.add(node);
    return Object.entries(node)
      .map(([k, v]) => `${k}=${typeof v === 'object' ? walk(v, depth + 1) : String(v)}`)
      .join(' ');
  };
  return walk(err, 0);
}

/** The error a statement threw, or a hard failure if it did not throw at all. */
async function thrownBy(run: () => Promise<unknown>, what: string): Promise<unknown> {
  try {
    await run();
  } catch (e) {
    return e;
  }
  throw new Error(`expected ${what} to fail, but it succeeded — the fixture provokes nothing`);
}

describeDb('a driver error carries the offending value in fields a message never shows', () => {
  beforeAll(async () => {
    await db.$client.unsafe(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    await db.$client.unsafe(`DROP TABLE IF EXISTS ${SCHEMA}.check_probe`);
    await db.$client.unsafe(`DROP TABLE IF EXISTS ${SCHEMA}.child_probe`);
    await db.$client.unsafe(`DROP TABLE IF EXISTS ${SCHEMA}.unique_probe`);
    await db.$client.unsafe(`DROP TABLE IF EXISTS ${SCHEMA}.uuid_probe`);
    await db.$client.unsafe(`CREATE TABLE ${SCHEMA}.unique_probe (id text PRIMARY KEY)`);
    await db.$client.unsafe(
      `CREATE TABLE ${SCHEMA}.child_probe (id text PRIMARY KEY, parent text REFERENCES ${SCHEMA}.unique_probe(id))`,
    );
    await db.$client.unsafe(
      `CREATE TABLE ${SCHEMA}.check_probe (id text PRIMARY KEY, note text, mate text, CONSTRAINT check_probe_note_not_short CHECK (length(note) < 5))`,
    );
    await db.$client.unsafe(`CREATE TABLE ${SCHEMA}.uuid_probe (id uuid PRIMARY KEY)`);
    // SEED FIRST — this is what makes `detail` echo the canary on the second insert rather than
    // the suite asserting against a value the server never saw.
    await db.$client.unsafe(`INSERT INTO ${SCHEMA}.unique_probe (id) VALUES ($1)`, [CANARY]);
  });

  afterAll(async () => {
    await db.$client.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await db.$client.end();
  });

  // ── The accept control, stated once per shape, over every violation class ────────────────────

  it('ACCEPT CONTROL: `detail` echoes the offending value for unique, foreign-key and check', async () => {
    const unique = (await thrownBy(
      () => db.$client.unsafe(`INSERT INTO ${SCHEMA}.unique_probe (id) VALUES ($1)`, [CANARY]),
      'the duplicate-key insert',
    )) as { code?: string; detail?: string };
    expect(unique.code).toBe('23505');
    expect(unique.detail).toContain(CANARY);

    const foreign = (await thrownBy(
      () =>
        db.$client.unsafe(`INSERT INTO ${SCHEMA}.child_probe (id, parent) VALUES ($1, $2)`, [
          'child-1',
          `${CANARY}-absent`,
        ]),
      'the dangling foreign-key insert',
    )) as { code?: string; detail?: string };
    expect(foreign.code).toBe('23503');
    expect(foreign.detail).toContain(CANARY);

    // The WIDEST case: a check violation's `detail` is `Failing row contains (…)` — EVERY column of
    // the row, not the one the constraint named. `mate` is in no constraint and still comes back.
    const check = (await thrownBy(
      () =>
        db.$client.unsafe(
          `INSERT INTO ${SCHEMA}.check_probe (id, note, mate) VALUES ($1, $2, $3)`,
          ['check-1', CANARY, ROW_MATE],
        ),
      'the check-constraint insert',
    )) as { code?: string; detail?: string };
    expect(check.code).toBe('23514');
    expect(check.detail).toContain(CANARY);
    expect(check.detail).toContain(ROW_MATE);
  });

  it('ACCEPT CONTROL: `detail` is an OWN ENUMERABLE property, so it escapes without touching .message', async () => {
    const raw = (await thrownBy(
      () => db.$client.unsafe(`INSERT INTO ${SCHEMA}.unique_probe (id) VALUES ($1)`, [CANARY]),
      'the duplicate-key insert',
    )) as Error;

    // The property is enumerable — this is the mechanism behind every shape below.
    expect(Object.keys(raw)).toContain('detail');
    // …while `message` is not, which is why "we never print .message" was never enough.
    expect(Object.keys(raw)).not.toContain('message');

    // The three shapes that print enumerable properties all carry the value.
    expect(JSON.stringify(raw)).toContain(CANARY);
    expect(enumerableEntriesOf(raw)).toContain(CANARY);
    expect(JSON.stringify({ ...raw })).toContain(CANARY);

    // And the primary message does NOT — so a site that reads `.message` looks clean while the
    // object beside it is not. That asymmetry is the whole finding.
    expect(raw.message).not.toContain(CANARY);
  });

  it('ACCEPT CONTROL: the ORM wrapper re-exposes the driver error through an enumerable `cause`', async () => {
    const wrapped = (await thrownBy(
      () => db.execute(sql`INSERT INTO ${sql.identifier('unique_probe')} (id) VALUES (${CANARY})`),
      'the wrapped duplicate-key insert',
    )) as Error & { cause?: { detail?: string } };

    expect(Object.keys(wrapped)).toContain('cause');
    expect(wrapped.cause?.detail).toContain(CANARY);
    // So the value escapes the WRAPPER too, through the same object-printing shapes.
    expect(JSON.stringify(wrapped)).toContain(CANARY);
    expect(enumerableEntriesOf(wrapped)).toContain(CANARY);
  });

  // ── What the renderer must do with each of them ──────────────────────────────────────────────

  it('withholds `detail` from a RAW driver error — unique, foreign-key and check', async () => {
    const cases: { what: string; run: () => Promise<unknown>; code: string }[] = [
      {
        what: 'unique',
        code: '23505',
        run: () =>
          db.$client.unsafe(`INSERT INTO ${SCHEMA}.unique_probe (id) VALUES ($1)`, [CANARY]),
      },
      {
        what: 'foreign key',
        code: '23503',
        run: () =>
          db.$client.unsafe(`INSERT INTO ${SCHEMA}.child_probe (id, parent) VALUES ($1, $2)`, [
            'child-2',
            `${CANARY}-absent`,
          ]),
      },
      {
        what: 'check',
        code: '23514',
        run: () =>
          db.$client.unsafe(
            `INSERT INTO ${SCHEMA}.check_probe (id, note, mate) VALUES ($1, $2, $3)`,
            ['check-2', CANARY, ROW_MATE],
          ),
      },
    ];

    for (const { what, run, code } of cases) {
      const raw = await thrownBy(run, `the ${what} insert`);
      // Accept control, re-stated per case: the value IS in the material handed to the renderer.
      expect(JSON.stringify(raw), `${what}: accept control`).toContain(CANARY);

      const rendered = operatorSafeDbErrorMessage(raw);
      expect(rendered, `${what}: rendered message`).not.toContain(CANARY);
      expect(rendered, `${what}: rendered message`).not.toContain(ROW_MATE);
      // Not over-redacted: the SQLSTATE and the statement still name what failed.
      expect(rendered, `${what}: keeps the SQLSTATE`).toContain(code);
      expect(rendered, `${what}: keeps the statement`).toContain('INSERT INTO');
      // The withholding is VISIBLE — an operator must not read this as a complete message.
      expect(rendered, `${what}: says it withheld`).toMatch(/withheld/);

      const stack = operatorSafeDbErrorStack(raw);
      expect(stack, `${what}: rendered stack`).not.toContain(CANARY);
      expect(stack, `${what}: rendered stack`).not.toContain(ROW_MATE);
    }
  });

  it('withholds `detail` from an ORM-WRAPPED driver error', async () => {
    const wrapped = await thrownBy(
      () => db.execute(sql`INSERT INTO ${sql.identifier('unique_probe')} (id) VALUES (${CANARY})`),
      'the wrapped duplicate-key insert',
    );
    expect(JSON.stringify(wrapped), 'accept control').toContain(CANARY);

    const rendered = operatorSafeDbErrorMessage(wrapped);
    expect(rendered).not.toContain(CANARY);
    expect(rendered).toContain('23505');
    expect(rendered).toMatch(/withheld/);
    expect(operatorSafeDbErrorStack(wrapped)).not.toContain(CANARY);
  });

  it('withholds the value a COERCION refusal puts in the primary message of a RAW driver error', async () => {
    // The class the `detail` cases cannot reach: here `detail` is empty and the value is echoed into
    // the PRIMARY MESSAGE instead (`invalid input syntax for type uuid: "…"`). A renderer that
    // returned a bare driver error's message unchanged would print the value while claiming safety.
    const raw = (await thrownBy(
      () => db.$client.unsafe(`INSERT INTO ${SCHEMA}.uuid_probe (id) VALUES ($1)`, [CANARY]),
      'the uuid coercion insert',
    )) as Error & { code?: string; detail?: string };

    // Accept control: the value IS in the message, and is NOT in `detail` — so this case is only
    // caught by reading the message, which is why it is here beside the `detail` cases.
    expect(raw.code).toBe('22P02');
    expect(raw.message).toContain(CANARY);
    expect(raw.detail ?? '').not.toContain(CANARY);

    const rendered = operatorSafeDbErrorMessage(raw);
    expect(rendered).not.toContain(CANARY);
    expect(rendered).toContain('22P02');
    expect(operatorSafeDbErrorStack(raw)).not.toContain(CANARY);
  });

  it('leaves an error that is not a database failure alone', async () => {
    // The renderer is a redactor for database failures, not a general message filter: rewriting a
    // refusal it does not understand would cost every other caller its own wording.
    const plain = new Error(`a handler bug mentioning ${CANARY}`);
    expect(operatorSafeDbErrorMessage(plain)).toBe(`a handler bug mentioning ${CANARY}`);
  });
});
