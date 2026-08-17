/**
 * WHAT THE GENERATED PERSIST HANDLER SAYS WHEN THE DATABASE REFUSES ITS WRITE — DB-backed, through
 * the COMMITTED golden module rather than a re-render, and against a REAL driver error.
 *
 * The rendered handler's `detail` is not a log line: `dispatchTool` journals the result object and
 * hands it back to the model. So a value quoted into it is disclosed twice over — into the run
 * journal, and into the next prompt. Postgres puts the offending value INSIDE the error it raises
 * (`detail` on a constraint violation — for a CHECK, the whole failing row; the message itself on a
 * coercion refusal), and the store facade sanitizes ONLY unique violations, so every other class
 * reaches this catch whole.
 *
 * WHY THE GOLDEN AND NOT A RE-RENDER. The byte-gated render tests already prove the emission is
 * stable; what they cannot prove is what the emitted program DOES. This imports the committed
 * `code-claim.gen.js` — the artifact a deployment loads — and drives it through a fake facade whose
 * `update` throws an error a real Postgres produced. A rendering regression is caught by the golden
 * tests; a REASONING regression (a shape the detector fails to recognise) is caught here.
 *
 * THE ACCEPT CONTROL. Each case first asserts the canary IS in the error handed to the handler —
 * in `detail` for the constraint classes, in `message` for the coercion class — so the absence
 * assertions that follow mean something. Without it this suite would keep passing the day the
 * fixture stopped provoking a real refusal.
 *
 * Isolated per-suite schema — never `public`. Skips without DATABASE_URL; HARD-FAILS when the DB is
 * required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(here, '__fixtures__/code-claim.gen.js');

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (requireDb && !hasDb) {
  throw new Error(
    'generated-persist-disclosure.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) ' +
      'but absent — refusing to silently skip the generated-handler disclosure proof.',
  );
}
const describeDb = hasDb ? describe : describe.skip;

const SCHEMA = 'rayspec_test_gen_persist_disclosure';
/** The value that must never come back on the handler's result. */
const CANARY = 'CANARY-gen-7d21e4-must-not-reach-the-journal';

const sql = postgres(process.env.DATABASE_URL ?? '', {
  max: 1,
  connection: { search_path: `${SCHEMA}, public` },
});

/** The handler under test, as a deployment loads it: the committed generated module. */
type PersistResult = { status: string; detail?: string };
type Handler = (
  args: Record<string, unknown>,
  init: { db: { select: () => Promise<unknown[]>; update: () => Promise<unknown[]> } },
) => Promise<PersistResult>;

/** The error a statement threw, or a hard failure if it did not throw at all. */
async function thrownBy(run: () => Promise<unknown>, what: string): Promise<unknown> {
  try {
    await run();
  } catch (e) {
    return e;
  }
  throw new Error(`expected ${what} to fail, but it succeeded — the fixture provokes nothing`);
}

/** Drive the golden handler with a facade whose write throws `err`. */
async function persistWith(handler: Handler, err: unknown): Promise<PersistResult> {
  return handler(
    // Every column the committed holes declare `required` — the coercion is fail-soft and would
    // otherwise answer "arg … missing or invalid" before the arm ever reaches its write.
    {
      claim_id: 'claim-1',
      category_code: 'TRAVEL',
      gl_code: '6000',
      coding_summary: 'a summary',
      policy_flag: 'violation',
    },
    {
      db: {
        // The FK re-check passes, so the arm reaches its write.
        select: async () => [{ code: 'TRAVEL' }],
        update: async () => {
          throw err;
        },
      },
    },
  );
}

describeDb('the generated persist handler never quotes a database refusal back', () => {
  let handler: Handler;

  beforeAll(async () => {
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    await sql.unsafe(`DROP TABLE IF EXISTS ${SCHEMA}.gen_check_probe`);
    await sql.unsafe(`DROP TABLE IF EXISTS ${SCHEMA}.gen_unique_probe`);
    await sql.unsafe(`DROP TABLE IF EXISTS ${SCHEMA}.gen_uuid_probe`);
    await sql.unsafe(`CREATE TABLE ${SCHEMA}.gen_unique_probe (id text PRIMARY KEY)`);
    await sql.unsafe(
      `CREATE TABLE ${SCHEMA}.gen_check_probe (id text PRIMARY KEY, note text, CONSTRAINT gen_note_short CHECK (length(note) < 5))`,
    );
    await sql.unsafe(`CREATE TABLE ${SCHEMA}.gen_uuid_probe (id uuid PRIMARY KEY)`);
    // SEED FIRST — what makes `detail` echo the canary rather than the suite asserting a value the
    // server never saw.
    await sql.unsafe(`INSERT INTO ${SCHEMA}.gen_unique_probe (id) VALUES ($1)`, [CANARY]);

    const mod = (await import(GOLDEN)) as Record<string, unknown>;
    const exported = Object.values(mod).find((v) => typeof v === 'function');
    if (typeof exported !== 'function') {
      throw new Error(`the committed golden at ${GOLDEN} exports no handler function`);
    }
    handler = exported as Handler;
  });

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await sql.end();
  });

  it('withholds a UNIQUE violation, whose `detail` carries the duplicated key', async () => {
    const err = (await thrownBy(
      () => sql.unsafe(`INSERT INTO ${SCHEMA}.gen_unique_probe (id) VALUES ($1)`, [CANARY]),
      'the duplicate-key insert',
    )) as { code?: string; detail?: string };

    expect(err.code, 'accept control: the class under test').toBe('23505');
    expect(err.detail, 'accept control: the value IS in `detail`').toContain(CANARY);

    const result = await persistWith(handler, err);
    expect(result.status).toBe('failed');
    expect(result.detail).not.toContain(CANARY);
    // Not over-redacted, and the withholding is visible.
    expect(result.detail).toContain('23505');
    expect(result.detail).toMatch(/withheld/);
  });

  it('withholds a CHECK violation, whose `detail` carries the WHOLE failing row', async () => {
    const err = (await thrownBy(
      () =>
        sql.unsafe(`INSERT INTO ${SCHEMA}.gen_check_probe (id, note) VALUES ($1, $2)`, [
          'check-1',
          CANARY,
        ]),
      'the check-constraint insert',
    )) as { code?: string; detail?: string };

    expect(err.code, 'accept control: the class under test').toBe('23514');
    expect(err.detail, 'accept control: the whole row IS in `detail`').toContain(CANARY);

    const result = await persistWith(handler, err);
    expect(result.detail).not.toContain(CANARY);
    expect(result.detail).toContain('23514');
  });

  it('withholds a COERCION refusal, whose PRIMARY MESSAGE carries the value', async () => {
    const err = (await thrownBy(
      () => sql.unsafe(`INSERT INTO ${SCHEMA}.gen_uuid_probe (id) VALUES ($1)`, [CANARY]),
      'the uuid coercion insert',
    )) as Error & { code?: string; detail?: string };

    expect(err.code, 'accept control: the class under test').toBe('22P02');
    expect(err.message, 'accept control: the value IS in the message').toContain(CANARY);
    expect(err.detail ?? '', 'this class puts nothing in `detail`').not.toContain(CANARY);

    const result = await persistWith(handler, err);
    expect(result.detail).not.toContain(CANARY);
    expect(result.detail).toContain('22P02');
  });

  it('recognises the ORM-WRAPPED shape too, not only the bare driver error', async () => {
    // The facade's `update` writes through the ORM, so what a handler catches is usually the
    // wrapper: no `code` of its own, the driver error on `.cause`, and the statement + every bound
    // value in its message. The detector has to walk to the cause rather than give up at the top.
    const driver = await thrownBy(
      () => sql.unsafe(`INSERT INTO ${SCHEMA}.gen_unique_probe (id) VALUES ($1)`, [CANARY]),
      'the duplicate-key insert',
    );
    const wrapper = Object.assign(
      new Error(
        `Failed query: update expense_claims set policy_flag = $1 params: ${CANARY}`,
      ) as Error & { query?: string; params?: unknown[]; cause?: unknown },
      {
        query: 'update expense_claims set policy_flag = $1',
        params: [CANARY],
        cause: driver,
      },
    );

    expect(String(wrapper), 'accept control: the wrapper quotes the value').toContain(CANARY);

    const result = await persistWith(handler, wrapper);
    expect(result.detail).not.toContain(CANARY);
    expect(result.detail).toContain('23505');
  });

  it('leaves an error that is NOT a database refusal with its own words', async () => {
    // The handler's catch also covers plain bugs in its own arm. Blanketing those would cost an
    // author the one line that says what broke, so the redaction is scoped to database failures.
    const bug = new TypeError('cannot read properties of undefined (reading "row")');
    const result = await persistWith(handler, bug);
    expect(result.detail).toContain('TypeError');
    expect(result.detail).toContain('cannot read properties of undefined');
  });
});
