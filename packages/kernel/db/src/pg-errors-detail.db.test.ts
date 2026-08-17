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
import postgres from 'postgres';
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

/**
 * THE OTHER DIRECTION: WITHHOLDING WHERE THERE IS NOTHING TO WITHHOLD.
 *
 * Everything above asks whether a value escapes. These ask the opposite question, because a redactor
 * that answers the first one perfectly can still be wrong: withholding costs the operator the fact
 * they came for, so it has to be paid only where there is something to buy.
 *
 * The line is STRUCTURAL, and it is the premise the first test here pins: a bind value exists only
 * inside a statement, and every statement-scoped failure carries its statement AND its values. So a
 * failure arriving WITHOUT a statement cannot hold one, and the connection-scoped refusals that make
 * up that class — `3D000`, `28P01`, `22023` — quote nothing but the DSN and the connection options.
 * Rendering those from the phrase table replaced `database "x" does not exist` with a sentence naming
 * two hazards, `detail` and a coercion message, that a connect-time refusal does not have.
 *
 * And a `code` is not a SQLSTATE just because it is a string: the driver hangs its OWN faults on the
 * same property using words (`CONNECTION_CLOSED`). Printing one as a SQLSTATE asserts that the server
 * answered and that the code is one an operator can look up, and neither is true.
 */
describeDb(
  'a failure with no statement keeps the diagnosis, and a driver fault is not a SQLSTATE',
  () => {
    it('PREMISE: every statement-scoped failure carries its statement AND its values', async () => {
      // The load-bearing claim behind the whole block. If a driver version ever stops attaching
      // `parameters` on one of these doors, the statement-less branch below starts returning a message
      // that COULD hold a bind value — so this pins the premise itself, not a rendering derived from it.
      //
      // Its OWN client: the block above ends `db.$client` in its `afterAll`, and a reused handle here
      // fails with `CONNECTION_ENDED` before any door is measured — a red that would say nothing about
      // the premise.
      const client = postgres(process.env.DATABASE_URL ?? '', { max: 2, idle_timeout: 5 });
      await client.unsafe(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
      await client.unsafe(`DROP TABLE IF EXISTS ${SCHEMA}.doors_probe`);
      await client.unsafe(`CREATE TABLE ${SCHEMA}.doors_probe (id uuid, n int NOT NULL)`);

      const doors: ReadonlyArray<readonly [string, () => Promise<unknown>]> = [
        [
          'bound parameters',
          () => client.unsafe(`INSERT INTO ${SCHEMA}.doors_probe (id, n) VALUES ($1, 1)`, [CANARY]),
        ],
        // Simple-query mode: NO parameters at all. `parameters` is an empty array, not absent — which
        // is what keeps this door on the statement-carrying side of the branch.
        [
          'simple query mode',
          () => client.unsafe(`INSERT INTO ${SCHEMA}.doors_probe (id, n) VALUES ('${CANARY}', 1)`),
        ],
        [
          'inside a transaction',
          () =>
            client.begin((tx) =>
              tx.unsafe(`INSERT INTO ${SCHEMA}.doors_probe (id, n) VALUES ('${CANARY}', 1)`),
            ),
        ],
        [
          'on a reserved connection',
          async () => {
            const reserved = await client.reserve();
            try {
              await reserved.unsafe(
                `INSERT INTO ${SCHEMA}.doors_probe (id, n) VALUES ('${CANARY}', 1)`,
              );
            } finally {
              reserved.release();
            }
          },
        ],
        [
          'a not-null violation',
          () => client.unsafe(`INSERT INTO ${SCHEMA}.doors_probe (id, n) VALUES (NULL, NULL)`),
        ],
        ['a missing relation', () => client.unsafe(`SELECT * FROM ${SCHEMA}.no_such_relation`)],
        ['a syntax error', () => client.unsafe('this is not sql')],
      ];

      for (const [door, run] of doors) {
        const err = (await thrownBy(run, `the ${door} statement`)) as {
          query?: unknown;
          parameters?: unknown;
        };
        expect(typeof err.query, `${door}: carries its statement`).toBe('string');
        expect(Array.isArray(err.parameters), `${door}: carries its values`).toBe(true);
      }

      await client.unsafe(`DROP TABLE IF EXISTS ${SCHEMA}.doors_probe`);
      await client.end({ timeout: 2 });
    });

    it('withholds an EXISTING ROW quoted by a migration that bound no values', async () => {
      // The migration shape: `ALTER TABLE … TYPE uuid USING label::uuid` over a table already holding a
      // value that will not cast. The statement binds NOTHING, and the offending value appears in the
      // SQL text nowhere — it is a row, reachable only through the server's message. So this is the one
      // case where the bind-value count is zero and something was withheld all the same, and reporting
      // `0 bind values withheld` told an operator precisely the opposite.
      const client = postgres(process.env.DATABASE_URL ?? '', { max: 2, idle_timeout: 5 });
      try {
        await client.unsafe(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
        await client.unsafe(`DROP TABLE IF EXISTS ${SCHEMA}.cast_probe`);
        await client.unsafe(
          `CREATE TABLE ${SCHEMA}.cast_probe (id serial PRIMARY KEY, label text)`,
        );
        await client.unsafe(`INSERT INTO ${SCHEMA}.cast_probe (label) VALUES ($1)`, [CANARY]);

        const ddl = `ALTER TABLE ${SCHEMA}.cast_probe ALTER COLUMN label TYPE uuid USING label::uuid`;
        // Accept control: the DDL itself never names the value — so a rendering that keeps the
        // statement verbatim is safe here, and any appearance of the canary came from the message.
        expect(ddl, 'the migration names no value').not.toContain(CANARY);

        const err = (await thrownBy(
          () => client.begin((tx) => tx.unsafe(ddl)),
          'the column type change',
        )) as Error & { code?: string; detail?: string; parameters?: unknown };

        expect(err.code).toBe('22P02');
        expect(err.message, 'accept control: the ROW value IS in the message').toContain(CANARY);
        expect(
          err.detail ?? '',
          'and it is NOT in `detail` — the message is the only door',
        ).not.toContain(CANARY);
        expect((err.parameters as unknown[]).length, 'the statement bound nothing').toBe(0);

        const rendered = operatorSafeDbErrorMessage(err);
        expect(rendered).not.toContain(CANARY);
        expect(rendered).toContain('22P02');
        expect(rendered, 'the DDL is authored and stays').toContain('ALTER COLUMN');
        // Zero bound values must not read as "nothing was withheld".
        expect(rendered).toContain('bound no values');
        expect(
          rendered,
          "the server's message was the disclosure, and is named as withheld",
        ).toMatch(/server's own message is withheld/);
      } finally {
        await client.unsafe(`DROP TABLE IF EXISTS ${SCHEMA}.cast_probe`).catch(() => {});
        await client.end({ timeout: 2 }).catch(() => {});
      }
    });

    it('keeps WHICH DATABASE for a connect-time refusal (3D000) instead of a generic sentence', async () => {
      const missing = `rayspec_no_such_db_${Date.now().toString(36)}`;
      const dsn = new URL(process.env.DATABASE_URL ?? '');
      dsn.pathname = `/${missing}`;
      const client = postgres(dsn.toString(), { max: 1, idle_timeout: 1, connect_timeout: 5 });

      const err = (await thrownBy(
        () => client.unsafe('SELECT 1'),
        'a connection to a database that does not exist',
      )) as Error & { code?: string; query?: unknown };
      await client.end({ timeout: 2 }).catch(() => {});

      // Accept control: this really is a server refusal with a real SQLSTATE, and it really does carry
      // no statement — so it is the class the branch is about, not a socket error mislabelled as one.
      expect(err.code).toBe('3D000');
      expect(err.query, 'a connect-time refusal carries no statement').toBeUndefined();
      expect(err.message, 'accept control: the name IS in the raw message').toContain(missing);

      // The operator's one fact survives. Rendering this from the phrase table produced
      // `the database refused the statement (SQLSTATE 3D000) — this driver error carries no statement…`
      // which names two hazards a connect refusal does not have and drops the only actionable word.
      expect(operatorSafeDbErrorMessage(err)).toContain(missing);
    });

    it('keeps WHICH ROLE for an authentication refusal (28P01)', async () => {
      const role = `rayspec_no_such_role_${Date.now().toString(36)}`;
      const dsn = new URL(process.env.DATABASE_URL ?? '');
      dsn.username = role;
      dsn.password = 'not-the-password';
      const client = postgres(dsn.toString(), { max: 1, idle_timeout: 1, connect_timeout: 5 });

      const err = (await thrownBy(
        () => client.unsafe('SELECT 1'),
        'a connection as a role that does not exist',
      )) as Error & { code?: string; query?: unknown };
      await client.end({ timeout: 2 }).catch(() => {});

      expect(err.code).toMatch(/^28/);
      expect(err.query, 'an auth refusal carries no statement').toBeUndefined();
      expect(err.message, 'accept control: the role IS in the raw message').toContain(role);
      expect(operatorSafeDbErrorMessage(err)).toContain(role);
    });

    it('does not call a DRIVER FAULT a SQLSTATE — and still withholds the values', async () => {
      // Provoked, not synthesized: terminate the backend with a statement in flight. The driver builds
      // this error itself, so `code` is a word rather than a five-character SQLSTATE, and `severity` —
      // which the server would have sent — is absent.
      const victim = postgres(process.env.DATABASE_URL ?? '', { max: 1, idle_timeout: 5 });
      const killer = postgres(process.env.DATABASE_URL ?? '', { max: 1, idle_timeout: 5 });
      try {
        const [{ pid }] = await victim<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        const inFlight = victim`SELECT pg_sleep(5), ${CANARY}::text`;
        await new Promise((resolve) => setTimeout(resolve, 400));
        await killer`SELECT pg_terminate_backend(${pid})`;

        const err = (await thrownBy(
          () => inFlight,
          'a statement whose backend was terminated',
        )) as Error & { code?: string; severity?: string };

        // Accept control: a string `code` that is NOT a SQLSTATE, on an error that DOES carry a
        // statement and a bound value — the exact shape an ungated walk mislabels.
        expect(err.code).toBe('CONNECTION_CLOSED');
        expect(err.severity, 'the server never answered, so there is no severity').toBeUndefined();

        const rendered = operatorSafeDbErrorMessage(err);
        expect(rendered, 'a driver fault is not a SQLSTATE').not.toContain('SQLSTATE');
        expect(rendered, 'but the fault token is kept — it is what names the failure').toContain(
          'CONNECTION_CLOSED',
        );
        // The statement DID carry a value, so the withholding still applies: this branch changes what
        // the failure is called, never what is disclosed.
        expect(rendered).not.toContain(CANARY);
        expect(rendered).toMatch(/withheld/);
      } finally {
        await victim.end({ timeout: 2 }).catch(() => {});
        await killer.end({ timeout: 2 }).catch(() => {});
      }
    });
  },
);
