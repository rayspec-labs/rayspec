/**
 * `rayspec dev db` — create-if-absent against a throwaway database name (DB-backed, fail-the-fix).
 *
 * GROUND TRUTH: we don't assert the shape, we create a real DB and read `pg_database` back.
 *   1. from-absent → `created:true`, and the database now EXISTS.
 *   2. a 2nd run  → `created:false` (idempotent no-op), no throw, never DROPs — the DB still exists.
 * The test's OWN teardown drops the throwaway DB; the COMMAND never drops anything.
 *
 * UN-SKIPPABLE RAN-GUARD (guards against the DB-less false-green class): a separate,
 * NON-skipped describe hard-FAILS when the DB is REQUIRED (CI / RAYSPEC_REQUIRE_DB_TESTS) but the
 * create-if-absent scenarios did not run (a DATABASE_URL-less CI run can never read green here).
 *
 * The usage-guard tests need NO DB (the validation fires before any connection), so they always run.
 */
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runDevDb } from './db.js';
import { DevCliError } from './errors.js';

function adminUrl(url: string): string {
  const u = new URL(url);
  u.pathname = '/postgres';
  return u.toString();
}

const baseUrl = process.env.DATABASE_URL;
const SUITE_DB = `rayspec_cli_dev_db_${process.pid}`;
const RESET_DB = `rayspec_cli_dev_db_reset_${process.pid}`;
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
let scenariosRan = 0;
let resetScenariosRan = 0;

/** Does a database with this name exist on the host? (read `pg_database` via an admin connection). */
async function dbExists(name: string): Promise<boolean> {
  const sql = postgres(adminUrl(baseUrl as string), { max: 1, onnotice: () => {} });
  try {
    const rows = await sql`select 1 from pg_database where datname = ${name}`;
    return rows.length > 0;
  } finally {
    await sql.end();
  }
}

describe('dev db — create-if-absent (idempotent; never destructive)', () => {
  const maybe = baseUrl ? it : it.skip;

  beforeAll(async () => {
    if (!baseUrl) return;
    // Start from ABSENT (drop any leftover from a prior crashed run) so run #1 exercises the create path.
    const sql = postgres(adminUrl(baseUrl), { max: 1, onnotice: () => {} });
    try {
      await sql.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
    } finally {
      await sql.end();
    }
  });

  afterAll(async () => {
    if (!baseUrl) return;
    const sql = postgres(adminUrl(baseUrl), { max: 1, onnotice: () => {} });
    try {
      await sql.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
    } finally {
      await sql.end();
    }
  });

  maybe('(1) from-absent → created:true and the database now exists', async () => {
    expect(await dbExists(SUITE_DB)).toBe(false);
    const result = await runDevDb(['--database-url', baseUrl as string, '--name', SUITE_DB]);
    expect(result.ok).toBe(true);
    expect(result.db).toBe(SUITE_DB);
    expect(result.created).toBe(true);
    expect(await dbExists(SUITE_DB)).toBe(true);
    scenariosRan++;
  });

  maybe('(2) a 2nd run is an idempotent no-op → created:false, never throws/drops', async () => {
    const result = await runDevDb(['--database-url', baseUrl as string, '--name', SUITE_DB]);
    expect(result.ok).toBe(true);
    expect(result.created).toBe(false);
    // Still there — the no-op path never dropped it.
    expect(await dbExists(SUITE_DB)).toBe(true);
    scenariosRan++;
  });
});

/**
 * `--reset` DROPs + re-CREATEs a clean DB, GATED on --yes. GROUND TRUTH: we seed a real marker
 * table+row into a throwaway DB, then prove `--reset --yes` recreated it clean (marker gone) while
 * `--reset` WITHOUT --yes and plain `dev db` leave the row untouched. The throwaway name is DISTINCT
 * from the create-if-absent SUITE_DB.
 */
describe('dev db --reset — DROP + re-create, gated on --yes (never destructive without --yes)', () => {
  const maybe = baseUrl ? it : it.skip;

  /** Run `fn` against a connection to RESET_DB itself (not the maintenance DB). */
  async function withResetDb<T>(fn: (sql: ReturnType<typeof postgres>) => Promise<T>): Promise<T> {
    const u = new URL(baseUrl as string);
    u.pathname = `/${RESET_DB}`;
    const sql = postgres(u.toString(), { max: 1, onnotice: () => {} });
    try {
      return await fn(sql);
    } finally {
      await sql.end();
    }
  }

  /** Ensure RESET_DB exists (create-if-absent) and holds exactly one marker row. */
  async function seedMarker(): Promise<void> {
    await runDevDb(['--database-url', baseUrl as string, '--name', RESET_DB]);
    await withResetDb(async (sql) => {
      await sql.unsafe('CREATE TABLE IF NOT EXISTS marker (id int)');
      await sql.unsafe('DELETE FROM marker');
      await sql.unsafe('INSERT INTO marker (id) VALUES (1)');
    });
  }

  /** Marker rows in RESET_DB, or `null` when the marker table is ABSENT (i.e. the DB was recreated). */
  async function markerCount(): Promise<number | null> {
    return withResetDb(async (sql) => {
      const reg = await sql.unsafe(`select (to_regclass('public.marker') is not null) as present`);
      if (!reg[0].present) return null;
      const rows = await sql.unsafe('select count(*)::int as c from marker');
      return rows[0].c as number;
    });
  }

  beforeAll(async () => {
    if (!baseUrl) return;
    const sql = postgres(adminUrl(baseUrl), { max: 1, onnotice: () => {} });
    try {
      await sql.unsafe(`DROP DATABASE IF EXISTS "${RESET_DB}" WITH (FORCE)`);
      await sql.unsafe(`DROP DATABASE IF EXISTS "${RESET_DB}_dbos_sys" WITH (FORCE)`);
    } finally {
      await sql.end();
    }
  });

  afterAll(async () => {
    if (!baseUrl) return;
    const sql = postgres(adminUrl(baseUrl), { max: 1, onnotice: () => {} });
    try {
      await sql.unsafe(`DROP DATABASE IF EXISTS "${RESET_DB}" WITH (FORCE)`);
      await sql.unsafe(`DROP DATABASE IF EXISTS "${RESET_DB}_dbos_sys" WITH (FORCE)`);
    } finally {
      await sql.end();
    }
  });

  maybe('(1) --reset --yes on a DB with a row → recreated CLEAN (the row is gone)', async () => {
    await seedMarker();
    expect(await markerCount()).toBe(1);
    const result = await runDevDb([
      '--database-url',
      baseUrl as string,
      '--name',
      RESET_DB,
      '--reset',
      '--yes',
    ]);
    expect(result.ok).toBe(true);
    expect(result.created).toBe(true);
    expect(result.reset).toBe(true);
    // The marker table (and its row) is GONE — the DB was DROPped + re-CREATEd clean.
    expect(await markerCount()).toBe(null);
    resetScenariosRan++;
  });

  maybe('(2) --reset WITHOUT --yes → refuses (DevCliError); DB + row UNTOUCHED', async () => {
    await seedMarker();
    expect(await markerCount()).toBe(1);
    await expect(
      runDevDb(['--database-url', baseUrl as string, '--name', RESET_DB, '--reset']),
    ).rejects.toBeInstanceOf(DevCliError);
    // The gate fired before any DB work — the row survives.
    expect(await markerCount()).toBe(1);
    resetScenariosRan++;
  });

  maybe('(3) plain dev db (no --reset) stays non-destructive → the row survives', async () => {
    await seedMarker();
    expect(await markerCount()).toBe(1);
    const result = await runDevDb(['--database-url', baseUrl as string, '--name', RESET_DB]);
    expect(result.ok).toBe(true);
    expect(result.created).toBe(false); // already existed → idempotent no-op
    expect(await markerCount()).toBe(1);
    resetScenariosRan++;
  });
});

describe('dev db — usage guards (no DB needed; always run)', () => {
  it('rejects an unsafe database name (CREATE DATABASE cannot be parameterized)', async () => {
    await expect(
      runDevDb(['--database-url', 'postgres://u:p@localhost:5432/base', '--name', 'evil"; DROP']),
    ).rejects.toBeInstanceOf(DevCliError);
  });

  it('--reset WITHOUT --yes refuses (DevCliError) before any DB connection', async () => {
    await expect(
      runDevDb(['--database-url', 'postgres://u:p@localhost:5432/base', '--name', 'x', '--reset']),
    ).rejects.toBeInstanceOf(DevCliError);
  });

  it('requires a base URL (no --database-url and no DATABASE_URL)', async () => {
    const prev = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      await expect(runDevDb(['--name', 'whatever'])).rejects.toBeInstanceOf(DevCliError);
    } finally {
      if (prev === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prev;
    }
  });
});

/**
 * Ran-guard: a SEPARATE, NON-skipped describe that fails the run when the DB is REQUIRED
 * (CI / RAYSPEC_REQUIRE_DB_TESTS) but the two create-if-absent scenarios did not run — so a CI run that
 * lost DATABASE_URL can never silently skip the proof.
 */
describe('dev db — ran-guard (the create-if-absent + reset proofs must not silently skip in CI)', () => {
  it('the create-if-absent + reset scenarios ACTUALLY RAN when the DB is required (CI / opt-in)', () => {
    if (dbRequired) {
      expect(scenariosRan).toBe(2);
      expect(resetScenariosRan).toBe(3);
    } else {
      expect(dbRequired).toBe(false);
    }
  });
});
