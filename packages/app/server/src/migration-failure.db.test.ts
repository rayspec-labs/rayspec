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
 * verified doc-first (the `applyMigrations` docstring in `composition-root.ts`) and never observed.
 *
 * WHY THIS DRIVES `migrate()` AND NOT `applyMigrations()`. `applyMigrations` hands the migrator
 * `migrationsFolder: migrationsDir()`, and `migrationsDir()` takes no argument, so the only way to
 * point the SHIPPED wrapper at a poisoned chain is to poison the committed one. The arms below
 * therefore call the SAME migrator, the same journal reader and the same
 * `drizzle.__drizzle_migrations` bookkeeping table, with ONE argument changed: a temp COPY of the
 * committed chain with one migration appended. The equivalence is not asserted by prose — the first
 * arm reads `composition-root.ts` and pins that the wrapper still makes exactly ONE `migrate()` call
 * over that folder, with no per-migration loop, so a future change that split the batch (and with it
 * the whole-chain atomicity arms 3 and 5 rest on) would break this suite's premise loudly rather
 * than silently making it a test of nothing.
 *
 * THE FOUR-PART ORACLE — "fail-closed" and "diagnosable" spelled out as four separate facts, because
 * a migrator can satisfy any three of them and still leave an operator stuck:
 *   1. it THROWS — not a resolved promise, not a warning;
 *   2. the error names the failing STATEMENT verbatim and carries the Postgres cause (SQLSTATE +
 *      message), so the failure is describable from the error alone;
 *   3. `drizzle.__drizzle_migrations` does NOT record the failed migration, and the failed migration's
 *      own DDL is fully rolled back — there is no half-applied migration to reason about;
 *   4. a real PROCESS that performs the same apply and lets the rejection escape exits NON-ZERO.
 *      (`serve.ts:167-183` turns any escaping boot error into `process.exit(1)`; this arm proves the
 *      rejection actually escapes rather than being swallowed by drizzle or postgres-js.)
 *
 * The FAILING TAG is the one thing the migrator does NOT put in the message, and arm 4 pins that —
 * still, because it is still true of `migrate()` itself. It is recovered deterministically by
 * joining the bookkeeping table's high-water mark against `meta/_journal.json`, and this suite
 * implements and asserts that recovery so an operator reading a RAW migrator error (`drizzle-kit
 * migrate`, psql) has a procedure rather than a hope. Since B-019f the SHIPPED wrapper runs that
 * same join itself, BEFORE the apply, and rethrows a `MigrationChainError` naming the pending tags —
 * so a boot log needs no recovery step. That half is proven end to end in
 * `boot-migrator-concurrency.db.test.ts`, which is the only place the shipped wrapper can be made to
 * fail over the COMMITTED chain (by staging a conflicting `orgs` table).
 *
 * ANTI-VACUITY. Arm 5 REPAIRS the same appended tag and asserts the bookkeeping table gains exactly
 * one row. Without it, arm 3's "the count did not move" would also pass against a migrator that
 * records nothing at all. Both are written against the committed journal's length rather than a
 * literal, so appending migration 0014 does not silently retire the check.
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
/**
 * Strictly greater than the LAST committed migration's `when` — DERIVED, never hard-coded.
 *
 * The journal is strict-monotonic (shadow-dryrun.sh:97-108) and drizzle applies only entries above
 * the recorded high-water mark, so a plant whose `when` sorts BELOW the tail of the chain is treated
 * as already applied and silently skipped — the migrator then resolves, nothing is planted, and
 * every arm of this suite fails for a reason that has nothing to do with what it tests.
 *
 * This was originally `1786661701294` (0012's `when` + 1), correct while 0012 was the last
 * migration. Migration 0013 landed with a later `when` and the constant went stale on the merge —
 * the suite passed on both branches and failed only once they met. Deriving it from the committed
 * journal makes the plant correct for 0014 and every migration after it.
 */
const APPENDED_WHEN =
  Math.max(
    ...(
      JSON.parse(readFileSync(join(migrationsDir(), 'meta', '_journal.json'), 'utf8')) as {
        entries: { when: number }[];
      }
    ).entries.map((e) => e.when),
  ) + 1;

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
 * Everything else — every committed .sql file, their order, the journal format — is byte-identical
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

  it('the shipped wrapper drives the SAME migrator, over the SAME folder, in ONE batch', () => {
    // The premise of every arm below, and the reason it is not simply "the body is one line": since
    // B-019f `applyMigrations` DOES wrap the call — an advisory lock around it and a
    // `MigrationChainError` rethrow — and neither of those changes what the migrator is handed.
    // What these arms depend on is narrower and is what is asserted: the same `migrate()`, the same
    // `migrationsFolder: migrationsDir()`, called EXACTLY ONCE, so the whole pending set is still one
    // all-or-nothing batch. A wrapper that applied migrations one at a time (a loop, a second call)
    // would trade away that atomicity, and arm 3's "records nothing / rolls back completely" would
    // silently become a test of something else. This arm says so before the others report a green.
    const src = readFileSync(join(here, 'composition-root.ts'), 'utf8');
    const body =
      /export async function applyMigrations\(db: Db\): Promise<void> \{([\s\S]*?)\n\}/.exec(src);
    expect(body, 'applyMigrations was renamed or reshaped — re-derive this suite').not.toBeNull();
    const source = body?.[1] ?? '';
    const calls = source.match(/\bmigrate\(/g) ?? [];
    expect(calls, 'the wrapper no longer calls the migrator exactly once').toHaveLength(1);
    expect(source).toContain('await migrate(db, { migrationsFolder: migrationsDir() });');
    // …and it is not a per-migration apply wearing a one-call disguise.
    expect(source).not.toMatch(/\bfor\s*\(|\bwhile\s*\(|\.forEach\(/);
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
    // read off the drizzle source (the `applyMigrations` docstring in composition-root.ts).
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

    // PINNED, and no longer a gap in the shipped path: the MIGRATOR's own message names the
    // statement but NOT the tag. That is a fact about drizzle 0.45.2 and it is why
    // `applyMigrations` has to compute the pending tags itself and rethrow a `MigrationChainError`
    // naming them (B-019f; the end-to-end proof is `boot-migrator-concurrency.db.test.ts`, the arm
    // that stages a conflicting `orgs` and reads the tags off the rejection). This assertion stays
    // because the wrapper's work is only justified while the underlying message lacks the tag — if a
    // drizzle upgrade starts naming it, this goes red, and the wrapper's rationale should be
    // revisited rather than the assertion relaxed. The recovery procedure below remains the route
    // for anyone reading a raw migrator error (`drizzle-kit migrate`, psql) rather than a boot log.
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
