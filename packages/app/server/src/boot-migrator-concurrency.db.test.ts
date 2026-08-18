/**
 * The boot migrator takes NO advisory lock — this suite PINS what that costs and what it does not.
 *
 * `composition-root.ts:1633-1636` states it plainly: two boots racing the SAME fresh empty database
 * would both try to apply 0000's non-`IF NOT EXISTS` CREATEs, one wins and the other's transaction
 * aborts cleanly. That is an accepted single-node caveat, and until now it was an accepted caveat
 * with NO test — a sentence in a comment that nothing would notice going stale in either direction.
 *
 * WHAT IS PINNED HERE (the current contract, stated as behaviour so a future change is deliberate):
 *
 *   1. the comment is still there. If someone ADDS the lock, this arm goes red and the upgrade notes
 *      (docs/workforce-architecture.md → "Upgrade and rollback notes") get corrected in the same
 *      change rather than left claiming a caveat that no longer exists;
 *   2. a boot that meets objects a CONCURRENT runner already created aborts with a DUPLICATE-OBJECT
 *      error and records NOTHING — fail-closed, never a half-applied chain. Driven deterministically
 *      (the winner's effect is staged, then the boot runs) so it is a real assertion rather than a
 *      race that may or may not happen on a given machine;
 *   3. the empirical race itself: two concurrent `applyMigrations` against one fresh empty database.
 *      At least one settles fulfilled, AT MOST one is rejected, the database ends FULLY migrated
 *      (journal count ≡ the on-disk chain) and structurally complete, and any rejection is
 *      duplicate-object class — never corruption, never a partial schema. Measured five times on the
 *      certification host: EXACTLY one rejection every time, always SQLSTATE 23505 on the migrator's
 *      very FIRST statement, `CREATE SCHEMA IF NOT EXISTS "drizzle"` — the `IF NOT EXISTS`
 *      check-then-create window `tenant-provision.ts:157-164` describes, observed. And always 13/13
 *      migrations recorded, so the loser costs a boot and nothing else. The bound is written as "at
 *      most one" rather than "exactly one" because a sufficiently serialized pair would let the loser
 *      see the high-water mark and no-op — the good case, which must not fail the suite;
 *   4. the idempotent re-run: a third `applyMigrations` over the finished database is a clean no-op.
 *
 * WHAT IS NOT CLAIMED. This is NOT multi-replica boot safety. The ONE advisory-locked path in the
 * repo is `tenant-provision.ts:173-178` (`pg_advisory_xact_lock`), whose own race arm
 * (`tenant-provision.db.test.ts:152-181`) resolves BOTH runs — that is the shape a future fix for the
 * boot migrator should mirror, and the difference between these two suites is exactly the gap.
 *
 * Skips without DATABASE_URL; the un-skippable ran-guard hard-fails a REQUIRED run that did not run.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Db, makeDb, migrationsDir } from '@rayspec/db';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from './composition-root.js';

const baseUrl = process.env.DATABASE_URL;
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
let armsRan = 0;

const RACE_DB = `rayspec_boot_migrator_race_${process.pid}`;
const STAGED_DB = `rayspec_boot_migrator_staged_${process.pid}`;
const here = dirname(fileURLToPath(import.meta.url));

/** Postgres classes a losing runner may legitimately die on. Anything else is not "clean abort". */
const DUPLICATE_OBJECT_CLASSES = new Set(['42P07', '42710', '23505', '40001', '40P01']);

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
function chainLength(): number {
  const journal = JSON.parse(
    readFileSync(join(migrationsDir(), 'meta', '_journal.json'), 'utf8'),
  ) as { entries: unknown[] };
  return journal.entries.length;
}
/** Walk to the root Postgres error of a wrapped driver rejection. */
function sqlStateOf(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur !== undefined && cur !== null; i += 1) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

describe.skipIf(!baseUrl)(
  'the boot migrator has no advisory lock — what that does and does not cost',
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

    it('the single-runner constraint is still documented at the migrator itself', () => {
      // The doc and the behaviour must move together. If the lock lands, correct the upgrade notes.
      const src = readFileSync(join(here, 'composition-root.ts'), 'utf8');
      expect(src).toContain('the migrator takes NO advisory lock');
      // …and the one path that DOES lock is still the model to mirror.
      const provision = readFileSync(join(here, 'tenant-provision.ts'), 'utf8');
      expect(provision).toContain('pg_advisory_xact_lock');
      armsRan += 1;
    });

    it('a boot that meets a concurrent runner’s objects aborts DUPLICATE-OBJECT and records nothing', async () => {
      // The winner's effect, staged deterministically: `orgs` is 0000's first non-IF-NOT-EXISTS CREATE,
      // so a runner that arrives after another has created it dies exactly here. No sleep, no luck.
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
          Error,
        );
        expect(sqlStateOf(caught)).toBe('42P07'); // duplicate_table — a clean abort, not corruption.
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

    it('two concurrent boots on ONE fresh empty database: one wins, the database ends complete', async () => {
      const url = withDbName(baseUrl as string, RACE_DB);
      const a = makeDb(url, 1);
      const b = makeDb(url, 1);
      let settled: PromiseSettledResult<void>[];
      try {
        settled = await Promise.allSettled([applyMigrations(a as Db), applyMigrations(b as Db)]);
        // At least one boot got the chain in. (Both may: a sufficiently serialized pair sees the
        // high-water mark and the loser no-ops — that is the good case, not a skipped assertion.)
        expect(settled.some((r) => r.status === 'fulfilled')).toBe(true);
        // …and never more than one loser: two rejections would mean nobody applied the chain, which is
        // a different and much worse failure than the caveat this suite pins.
        expect(settled.filter((r) => r.status === 'rejected').length).toBeLessThanOrEqual(1);
        // Every rejection is a clean duplicate-object abort. THIS is the accepted caveat, pinned: the
        // loser's boot FAILS, and it fails without leaving anything behind.
        for (const r of settled) {
          if (r.status === 'rejected') {
            expect(
              DUPLICATE_OBJECT_CLASSES.has(sqlStateOf(r.reason) ?? ''),
              `a losing boot died on an unexpected SQLSTATE ${sqlStateOf(r.reason)}: ${String(r.reason)}`,
            ).toBe(true);
          }
        }
        // …and the database is FULLY migrated regardless of who won — no half-applied chain.
        const rows = (await a.$client.unsafe(
          'SELECT count(*)::int AS c FROM drizzle.__drizzle_migrations',
        )) as unknown as { c: number }[];
        expect(rows[0]?.c).toBe(chainLength());
        const tables = (await a.$client.unsafe(
          `SELECT count(*)::int AS c FROM information_schema.tables WHERE table_schema='public' AND table_name IN
         ('orgs','runs','journal_steps','run_events','workforce_tasks','workforce_task_transitions',
          'workforce_task_signals','workforce_delegations','workforce_approvals','workforce_reviews',
          'workforce_messages','workforce_budget_ledger','workforce_runtime')`,
        )) as unknown as { c: number }[];
        expect(tables[0]?.c).toBe(13);
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
        expect(rows[0]?.c).toBe(chainLength());
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
      'absent — refusing to silently skip the single-runner constraint pin.',
  );
}
