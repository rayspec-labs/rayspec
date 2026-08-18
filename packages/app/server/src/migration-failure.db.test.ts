/**
 * A BROKEN MIGRATION, planted in the real migrator — the missing half of "migration failure is
 * fail-closed and diagnosable".
 *
 * WHAT WAS ALREADY PROVEN, AND WHAT WAS NOT. Fail-closed is real for POLICY refusals
 * (`deploy-apply-migration.db.test.ts:267-315` — an unallowlisted destructive delta refuses, exit
 * non-zero, DB unchanged) and for MISUSE of the product-update mechanism
 * (`product-update-boot.db.test.ts:479-506` — a real `42P01` captured and asserted diagnosable). But
 * nothing ever handed the PLATFORM migrator a migration that cannot apply and asked what happens.
 * The chain-apply fail-closed property rested on shell semantics (`set -euo pipefail`,
 * `ON_ERROR_STOP=1`) that were never driven red, and on drizzle's whole-batch transaction, which was
 * verified doc-first (`composition-root.ts:1620-1636`) and never observed.
 *
 * WHY THIS DRIVES `migrate()` AND NOT `applyMigrations()`. `applyMigrations` is one line —
 * `await migrate(db, { migrationsFolder: migrationsDir() })` — and `migrationsDir()` takes no
 * argument, so the only way to point the SHIPPED wrapper at a poisoned chain is to poison the
 * committed one. The arms below therefore call the SAME migrator, the same journal reader and the
 * same `drizzle.__drizzle_migrations` bookkeeping table, with ONE argument changed: a temp COPY of
 * the committed chain with one migration appended. The equivalence is not asserted by prose — the
 * first arm reads `composition-root.ts` and pins that `applyMigrations`'s body is exactly that
 * unguarded delegation, so a future `try/catch` that swallowed a migrator error would break this
 * suite's premise loudly rather than silently making it a test of nothing.
 *
 * THE FOUR-PART ORACLE (§5 W-7 of the B-018 inventory):
 *   1. it THROWS — not a resolved promise, not a warning;
 *   2. the error names the failing STATEMENT verbatim and carries the Postgres cause (SQLSTATE +
 *      message), so the failure is describable from the error alone;
 *   3. `drizzle.__drizzle_migrations` does NOT record the failed migration, and the failed migration's
 *      own DDL is fully rolled back — there is no half-applied migration to reason about;
 *   4. a real PROCESS that performs the same apply and lets the rejection escape exits NON-ZERO.
 *      (`serve.ts:167-183` turns any escaping boot error into `process.exit(1)`; this arm proves the
 *      rejection actually escapes rather than being swallowed by drizzle or postgres-js.)
 *
 * The FAILING TAG is the one thing the migrator does NOT put in the message, and arm 3 pins that gap
 * rather than glossing it: the tag is recovered deterministically by joining the bookkeeping table's
 * high-water mark against `meta/_journal.json`, and this suite implements and asserts that recovery
 * so an operator has a procedure rather than a hope. Making the wrapper name the tag itself is a
 * `composition-root.ts` change and is filed as follow-up work.
 *
 * ANTI-VACUITY. Arm 5 REPAIRS the same appended tag and asserts the bookkeeping table goes 13 → 14.
 * Without it, arm 3's "still 13" would also pass against a migrator that records nothing at all.
 *
 * Skips without DATABASE_URL; the un-skippable ran-guard hard-fails a REQUIRED run that did not run.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrationsDir } from '@rayspec/db';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const baseUrl = process.env.DATABASE_URL;
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
let armsRan = 0;

const SUITE_DB = `rayspec_migration_failure_${process.pid}`;
const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');

/** The tag appended to the temp chain. Poisoned first, repaired later under the SAME tag. */
const APPENDED_TAG = '9999_planted_failure';
/** Strictly greater than 0012's `when` — the journal is strict-monotonic (shadow-dryrun.sh:97-108). */
const APPENDED_WHEN = 1786661701294;

/** The statement that cannot apply. A missing TYPE is deterministic, non-transient and unambiguous. */
const POISON_SQL = `CREATE TABLE "planted_failure_landing" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "planted_failure_landing" ADD COLUMN "bad" no_such_type NOT NULL;`;

/** The same migration, repaired — the anti-vacuity control for "the failed one was not recorded". */
const REPAIRED_SQL = `CREATE TABLE "planted_failure_landing" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL
);`;

function adminUrl(url: string): string {
  const u = new URL(url);
  u.pathname = '/postgres';
  return u.toString();
}
function withDbName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

interface JournalEntry {
  readonly idx: number;
  readonly version: string;
  readonly when: number;
  readonly tag: string;
  readonly breakpoints: boolean;
}

/**
 * A temp COPY of the committed chain with one extra migration appended to `meta/_journal.json`.
 * Everything else — the 13 committed .sql files, their order, the journal format — is byte-identical
 * to what `migrationsDir()` returns, so the only variable under test is the appended migration.
 */
function chainWithAppended(sql: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'rayspec-migfail-'));
  cpSync(migrationsDir(), dir, { recursive: true });
  const journalPath = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: JournalEntry[];
  };
  journal.entries.push({
    idx: journal.entries.length,
    version: '7',
    when: APPENDED_WHEN,
    tag: APPENDED_TAG,
    breakpoints: true,
  });
  writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  writeFileSync(join(dir, `${APPENDED_TAG}.sql`), sql);
  return dir;
}

/** The committed journal, read the way the migrator reads it. */
function committedJournal(): JournalEntry[] {
  return (
    JSON.parse(readFileSync(join(migrationsDir(), 'meta', '_journal.json'), 'utf8')) as {
      entries: JournalEntry[];
    }
  ).entries;
}

describe.skipIf(!baseUrl)('a planted broken migration is fail-closed and diagnosable', () => {
  let dbUrl = '';
  let client: ReturnType<typeof postgres> | undefined;
  let db: ReturnType<typeof drizzle> | undefined;
  const tempDirs: string[] = [];

  beforeAll(async () => {
    if (!baseUrl) return;
    dbUrl = withDbName(baseUrl, SUITE_DB);
    const admin = postgres(adminUrl(baseUrl), { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE "${SUITE_DB}"`);
    } finally {
      await admin.end();
    }
    client = postgres(dbUrl, { max: 1, onnotice: () => {} });
    db = drizzle(client);
  }, 180_000);

  afterAll(async () => {
    await client?.end();
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    if (baseUrl) {
      const admin = postgres(adminUrl(baseUrl), { max: 1 });
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    }
  }, 60_000);

  /** Rows currently recorded in drizzle's own bookkeeping table. */
  async function recorded(): Promise<{ count: number; highWater: string | null }> {
    const rows = (await (client as ReturnType<typeof postgres>).unsafe(
      'SELECT count(*)::int AS c, max(created_at)::text AS hw FROM drizzle.__drizzle_migrations',
    )) as unknown as { c: number; hw: string | null }[];
    return { count: rows[0]?.c ?? 0, highWater: rows[0]?.hw ?? null };
  }

  async function tableExists(name: string): Promise<boolean> {
    const rows = (await (client as ReturnType<typeof postgres>).unsafe(
      `SELECT count(*)::int AS c FROM information_schema.tables WHERE table_schema='public' AND table_name='${name}'`,
    )) as unknown as { c: number }[];
    return (rows[0]?.c ?? 0) > 0;
  }

  it('the shipped wrapper is an UNGUARDED delegation to the same migrator these arms drive', () => {
    // The premise of every arm below. If `applyMigrations` ever grows a try/catch, or stops being a
    // straight `migrate(db, { migrationsFolder: … })`, then driving `migrate()` here would no longer
    // measure the shipped path — and this arm says so before the others report a green.
    const src = readFileSync(join(here, 'composition-root.ts'), 'utf8');
    const body =
      /export async function applyMigrations\(db: Db\): Promise<void> \{([\s\S]*?)\n\}/.exec(src);
    expect(body, 'applyMigrations was renamed or reshaped — re-derive this suite').not.toBeNull();
    expect((body?.[1] ?? '').trim()).toBe(
      'await migrate(db, { migrationsFolder: migrationsDir() });',
    );
    armsRan += 1;
  });

  it('the committed chain applies clean and records every migration', async () => {
    await migrate(db as ReturnType<typeof drizzle>, { migrationsFolder: migrationsDir() });
    const journal = committedJournal();
    const after = await recorded();
    expect(after.count).toBe(journal.length);
    // The high-water mark IS the last journal entry's `when` — the fact arm 4's tag recovery rests on.
    expect(after.highWater).toBe(String(journal[journal.length - 1]?.when));
    armsRan += 1;
  }, 180_000);

  it('a planted broken migration THROWS, names the failing statement, and records nothing', async () => {
    const before = await recorded();
    const poisoned = chainWithAppended(POISON_SQL);
    tempDirs.push(poisoned);

    let caught: unknown;
    try {
      await migrate(db as ReturnType<typeof drizzle>, { migrationsFolder: poisoned });
    } catch (err) {
      caught = err;
    }

    // 1. it THROWS.
    expect(caught, 'the migrator resolved over a migration that cannot apply').toBeInstanceOf(
      Error,
    );
    // 2. diagnosable: the failing STATEMENT verbatim, plus the Postgres cause underneath it.
    const message = (caught as Error).message;
    expect(message).toContain('Failed query');
    expect(message).toContain(
      'ALTER TABLE "planted_failure_landing" ADD COLUMN "bad" no_such_type',
    );
    const cause = (caught as Error).cause as { message?: string; code?: string } | undefined;
    expect(cause?.message).toContain('type "no_such_type" does not exist');
    expect(cause?.code).toBe('42704'); // undefined_object — an operator can classify it without prose.
    // 3. the bookkeeping table is UNCHANGED: the failed migration is not recorded…
    const after = await recorded();
    expect(after).toEqual(before);
    // …and there is no half-applied migration either: the statement BEFORE the poison was a plain
    // CREATE TABLE, and it is gone too. That is the whole-batch transaction observed rather than
    // read off the drizzle source (composition-root.ts:1620-1636).
    expect(await tableExists('planted_failure_landing')).toBe(false);
    armsRan += 1;
  }, 180_000);

  it('the failing TAG is recoverable — the one thing the error itself does not carry', async () => {
    const { highWater } = await recorded();
    const journal = committedJournal();
    // The procedure, mechanized: the bookkeeping high-water mark is a journal `when`; the failing
    // migration is the FIRST entry after it in the chain that was handed to the migrator.
    const appliedThrough = journal.findIndex((e) => String(e.when) === highWater);
    expect(appliedThrough).toBe(journal.length - 1);
    const poisonedJournal = (
      JSON.parse(readFileSync(join(tempDirs[0] as string, 'meta', '_journal.json'), 'utf8')) as {
        entries: JournalEntry[];
      }
    ).entries;
    const failing = poisonedJournal.find((e) => e.when > Number(highWater));
    expect(failing?.tag).toBe(APPENDED_TAG);

    // PINNED GAP: the migrator's own message names the statement but NOT the tag, so the recovery
    // above is REQUIRED rather than a convenience. If a drizzle upgrade (or a wrapper in
    // `applyMigrations`) starts naming the tag, this assertion goes red — flip it deliberately then,
    // and drop the recovery step from the upgrade notes.
    const poisoned = chainWithAppended(POISON_SQL);
    tempDirs.push(poisoned);
    let message = '';
    try {
      await migrate(db as ReturnType<typeof drizzle>, { migrationsFolder: poisoned });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain(APPENDED_TAG);
    armsRan += 1;
  }, 180_000);

  it('a PROCESS that lets the rejection escape exits NON-ZERO', () => {
    // The fail-closed claim as a process fact. `serve.ts:167-183` turns any escaping boot error into
    // `process.exit(1)`; what needed proving is that the rejection escapes at all — that drizzle and
    // postgres-js neither swallow it nor resolve. Run from the package directory so the child's bare
    // specifiers resolve through this package's own node_modules, exactly as the shipped boot's do.
    const poisoned = tempDirs[0] as string;
    const script = [
      "import { drizzle } from 'drizzle-orm/postgres-js';",
      "import { migrate } from 'drizzle-orm/postgres-js/migrator';",
      "import postgres from 'postgres';",
      `const client = postgres(${JSON.stringify(dbUrl)}, { max: 1, onnotice: () => {} });`,
      // No catch, no exit code of our own: whatever the runtime does with the rejection is the answer.
      `await migrate(drizzle(client), { migrationsFolder: ${JSON.stringify(poisoned)} });`,
      'await client.end();',
    ].join('\n');
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: packageRoot,
      encoding: 'utf8',
      timeout: 180_000,
    });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('ALTER TABLE "planted_failure_landing" ADD COLUMN "bad"');
    armsRan += 1;
  }, 200_000);

  it('the SAME tag, repaired, records — so "not recorded" above was a refusal, not an inability', async () => {
    const before = await recorded();
    const repaired = chainWithAppended(REPAIRED_SQL);
    tempDirs.push(repaired);
    await migrate(db as ReturnType<typeof drizzle>, { migrationsFolder: repaired });
    const after = await recorded();
    expect(after.count).toBe(before.count + 1);
    expect(after.highWater).toBe(String(APPENDED_WHEN));
    expect(await tableExists('planted_failure_landing')).toBe(true);
    armsRan += 1;
  }, 180_000);

  it('ran-guard: every arm ran (a required DB run may not silently skip)', () => {
    expect(armsRan).toBe(6);
  });
});

if (dbRequired && !baseUrl) {
  throw new Error(
    'migration-failure.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — ' +
      'refusing to silently skip the planted-broken-migration proof.',
  );
}
