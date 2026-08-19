/**
 * The boot migrator is SERIALIZED on a Postgres advisory lock — this suite pins what that buys and
 * what it still does not promise.
 *
 * HISTORY, kept because the contract inverted rather than grew. Until B-019f `applyMigrations` took
 * no lock at all, and this file pinned the caveat: two boots racing one fresh empty database both
 * tried to apply `0000`'s non-`IF NOT EXISTS` CREATEs, one won, the loser's transaction aborted
 * cleanly and its boot failed. That was an accepted single-node cost with a test rather than a
 * comment, and its arm 1 said in as many words that ADDING the lock must turn this file and the
 * upgrade notes over in the same change. This is that change.
 *
 * WHAT IS PINNED NOW:
 *
 *   1. the lock IS taken, on the key `@rayspec/db` owns, and it is taken in exactly ONE place. The
 *      key is a convention — two runners serialize only while they name the same pair — so a second
 *      copy of it anywhere is a way for a future runner to serialize against nothing. The arm also
 *      pins that `tenant-provision.ts` no longer wraps its own lock around `applyMigrations`: that
 *      would be one process waiting on itself across two connections;
 *   2. a boot that meets objects a CONCURRENT runner already created still aborts fail-closed and
 *      records NOTHING — the lock removes the race, it does not make the migrator forgiving — AND
 *      the rejection now NAMES the pending migration tags in chain order. Driven deterministically
 *      (the winner's effect is staged, then the boot runs), which is also the only way to make the
 *      SHIPPED wrapper fail over the COMMITTED chain, and therefore the only end-to-end proof of the
 *      tag half of B-019f;
 *   3. the empirical race: two concurrent `applyMigrations` against one fresh empty database. BOTH
 *      settle fulfilled — zero rejections, not "at most one" — the database ends fully migrated
 *      (journal count ≡ the on-disk chain) and structurally complete. This is the assertion that
 *      would have failed before the lock: measured five times on the certification host back then,
 *      it produced exactly one rejection EVERY time, always SQLSTATE 23505 on the migrator's very
 *      first statement, `CREATE SCHEMA IF NOT EXISTS "drizzle"`;
 *   4. the idempotent re-run: a third `applyMigrations` over the finished database is a clean no-op.
 *
 * WHAT IS STILL NOT CLAIMED. An advisory lock serializes runners that TAKE it. It is not a schema
 * migration protocol: a rolling deploy whose old and new binaries expect different schemas is
 * unaffected by it, and a runner that applies this chain by some other route (`drizzle-kit migrate`,
 * psql) takes no lock and is not serialized against these. "Run migrations from one runner" remains
 * the operational advice; what changed is that a fan-out on a first bring-up no longer costs a boot.
 *
 * Skips without DATABASE_URL; the un-skippable ran-guard hard-fails a REQUIRED run that did not run.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Db, makeDb, migrationsDir } from '@rayspec/db';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, MigrationChainError } from './composition-root.js';

const baseUrl = process.env.DATABASE_URL;
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
let armsRan = 0;

const RACE_DB = `rayspec_boot_migrator_race_${process.pid}`;
const STAGED_DB = `rayspec_boot_migrator_staged_${process.pid}`;
const here = dirname(fileURLToPath(import.meta.url));

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
function journalEntries(): { when: number; tag: string }[] {
  const journal = JSON.parse(
    readFileSync(join(migrationsDir(), 'meta', '_journal.json'), 'utf8'),
  ) as { entries: { when: number; tag: string }[] };
  return journal.entries;
}
/** Walk to the root Postgres error of a wrapped driver rejection. */
function sqlStateOf(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let i = 0; i < 6 && cur !== undefined && cur !== null; i += 1) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

describe.skipIf(!baseUrl)(
  'the boot migrator is serialized on an advisory lock — what that does and does not cost',
  () => {
    const created: string[] = [];

    beforeAll(async () => {
      if (!baseUrl) return;
      const admin = postgres(adminUrl(baseUrl), { max: 1 });
      try {
        for (const name of [RACE_DB, STAGED_DB]) {
          await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
          await admin.unsafe(`CREATE DATABASE "${name}"`);
          created.push(name);
        }
      } finally {
        await admin.end();
      }
    }, 180_000);

    afterAll(async () => {
      if (!baseUrl) return;
      const admin = postgres(adminUrl(baseUrl), { max: 1 });
      try {
        for (const name of created) {
          await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
        }
      } finally {
        await admin.end();
      }
    }, 60_000);

    it('the lock is taken at the migrator, on the ONE key, and nowhere else', () => {
      // The behaviour and its single source have to move together. An advisory lock is a convention:
      // runners serialize only while they name the same (namespace, slot), and nothing in Postgres
      // can tell you what pair to use — so a SECOND literal of the key is how a future runner ends
      // up serializing against nothing at all.
      const src = readFileSync(join(here, 'composition-root.ts'), 'utf8');
      // As a regex, not a string literal: the thing being matched IS a template placeholder, and a
      // `${…}` inside a plain string is the mistake `noTemplateCurlyInString` exists to catch.
      expect(src).toMatch(/pg_advisory_lock\(\$\{MIGRATION_LOCK_NAMESPACE\}/);
      expect(src).toMatch(/\$\{MIGRATION_LOCK_SLOT\}/);
      // The key itself is declared by the package that owns the chain, not restated here or there.
      const keySrc = readFileSync(
        join(here, '..', '..', '..', 'kernel', 'db', 'src', 'migrations.ts'),
        'utf8',
      );
      expect(keySrc).toContain('export const MIGRATION_LOCK_NAMESPACE = 0x7261_7973;');
      expect(keySrc).toContain('export const MIGRATION_LOCK_SLOT = 1;');
      // …and `provision-tenant` no longer takes its own. It used to wrap `applyMigrations` in
      // `pg_advisory_xact_lock` on a pooled connection; with the lock inside `applyMigrations`, that
      // outer holder would be one process waiting on ITSELF across two connections.
      const provision = readFileSync(join(here, 'tenant-provision.ts'), 'utf8');
      expect(provision).not.toContain('pg_advisory');
      expect(provision).toContain('await applyMigrations(db);');
      armsRan += 1;
    });

    it('a boot that meets a concurrent runner’s objects aborts fail-closed AND names the pending tags', async () => {
      // The winner's effect, staged deterministically: `orgs` is 0000's first non-IF-NOT-EXISTS CREATE,
      // so a runner that arrives after another has created it dies exactly here. No sleep, no luck.
      // This is also the ONLY way to make the shipped wrapper fail over the COMMITTED chain, which is
      // why the tag assertion lives here rather than in `migration-failure.db.test.ts` (that suite
      // drives `migrate()` directly, over a temp copy of the chain, and so never reaches the wrapper).
      const staged = makeDb(withDbName(baseUrl as string, STAGED_DB), 1);
      try {
        await staged.$client.unsafe('CREATE TABLE orgs (id uuid PRIMARY KEY)');
        let caught: unknown;
        try {
          await applyMigrations(staged as Db);
        } catch (err) {
          caught = err;
        }
        expect(caught, 'the boot migrator applied over another runner’s objects').toBeInstanceOf(
          MigrationChainError,
        );
        expect(sqlStateOf(caught)).toBe('42P07'); // duplicate_table — a clean abort, not corruption.
        // THE TAG, which the migrator's own message never carries. This database has recorded
        // nothing, so every committed migration is pending and `0000` is the earliest — the first
        // candidate for the failure, and here in fact the failing one.
        const tags = journalEntries().map((e) => e.tag);
        expect((caught as MigrationChainError).pendingTags).toEqual(tags);
        expect((caught as Error).message).toContain(tags[0] as string);
        // …and the message still says what an operator must know before acting: nothing landed.
        expect((caught as Error).message).toContain('UNCHANGED');
        // Fail-closed: the bookkeeping table exists (it is created before the batch) but the chain
        // recorded NOTHING, so the next boot re-applies from the top rather than resuming a fiction.
        const rows = (await staged.$client.unsafe(
          'SELECT count(*)::int AS c FROM drizzle.__drizzle_migrations',
        )) as unknown as { c: number }[];
        expect(rows[0]?.c).toBe(0);
        // …and nothing the aborted batch created survives it. `journal_steps` is created BEFORE `orgs`
        // in 0000, so its absence is the whole-batch rollback observed, not inferred: there is no
        // half-applied migration for an operator to reason about.
        const partial = (await staged.$client.unsafe(
          `SELECT count(*)::int AS c FROM information_schema.tables WHERE table_schema='public' AND table_name='journal_steps'`,
        )) as unknown as { c: number }[];
        expect(partial[0]?.c).toBe(0);
      } finally {
        await staged.$client.end();
      }
      armsRan += 1;
    }, 180_000);

    it('two concurrent boots on ONE fresh empty database: BOTH succeed, the database ends complete', async () => {
      // Pool size 1 on purpose. It is the size that a transaction-scoped lock on a POOLED connection
      // would deadlock at — the lock would hold the only connection while `migrate()` waited for a
      // second — so this also pins that the lock runs on a connection of its own.
      const url = withDbName(baseUrl as string, RACE_DB);
      const a = makeDb(url, 1);
      const b = makeDb(url, 1);
      try {
        const settled = await Promise.allSettled([
          applyMigrations(a as Db),
          applyMigrations(b as Db),
        ]);
        // THE PROPERTY THE LOCK BUYS. Before it, this was "at least one fulfilled, at most one
        // rejected" and the certification host produced a loser every single time. A rejection here
        // now is a real regression, so the reason is printed rather than hidden behind a count.
        for (const r of settled) {
          expect(
            r.status === 'rejected' ? `rejected: ${String(r.reason)}` : 'fulfilled',
            'a serialized boot lost the race — the advisory lock is not holding',
          ).toBe('fulfilled');
        }
        // …and the database is FULLY migrated — no half-applied chain, and no double application.
        const rows = (await a.$client.unsafe(
          'SELECT count(*)::int AS c FROM drizzle.__drizzle_migrations',
        )) as unknown as { c: number }[];
        expect(rows[0]?.c).toBe(journalEntries().length);
        const tables = (await a.$client.unsafe(
          `SELECT count(*)::int AS c FROM information_schema.tables WHERE table_schema='public' AND table_name IN
         ('orgs','runs','journal_steps','run_events','workforce_tasks','workforce_task_transitions',
          'workforce_task_signals','workforce_delegations','workforce_approvals','workforce_reviews',
          'workforce_messages','workforce_budget_ledger','workforce_runtime')`,
        )) as unknown as { c: number }[];
        expect(tables[0]?.c).toBe(13);
        // The lock is RELEASED, both times: the sidecar connections are closed in a `finally`, and a
        // session-scoped advisory lock dies with its session. A leaked one would block every later
        // boot against this database, which is a far worse failure than the race it replaced.
        // Scoped to THIS database's oid — `pg_locks` is a cluster-wide view and this server is shared
        // with other suites, so an unscoped count would be reading somebody else's lock.
        const held = (await a.$client.unsafe(
          `SELECT count(*)::int AS c FROM pg_locks
             WHERE locktype='advisory'
               AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
        )) as unknown as { c: number }[];
        expect(held[0]?.c).toBe(0);
      } finally {
        await a.$client.end();
        await b.$client.end();
      }
      armsRan += 1;
    }, 240_000);

    it('a THIRD boot over the finished database is a clean no-op — repeated boot stays safe', async () => {
      const c = makeDb(withDbName(baseUrl as string, RACE_DB), 1);
      try {
        await expect(applyMigrations(c as Db)).resolves.toBeUndefined();
        const rows = (await c.$client.unsafe(
          'SELECT count(*)::int AS c FROM drizzle.__drizzle_migrations',
        )) as unknown as { c: number }[];
        expect(rows[0]?.c).toBe(journalEntries().length);
      } finally {
        await c.$client.end();
      }
      armsRan += 1;
    }, 180_000);

    it('ran-guard: every arm ran (a required DB run may not silently skip)', () => {
      expect(armsRan).toBe(4);
    });
  },
);

if (dbRequired && !baseUrl) {
  throw new Error(
    'boot-migrator-concurrency.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but ' +
      'absent — refusing to silently skip the migrator serialization pin.',
  );
}
