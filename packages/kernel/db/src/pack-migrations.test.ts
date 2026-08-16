/**
 * The pack-migration namespace rules — every refusal that must happen BEFORE a statement runs.
 *
 * `applyPackMigrations` is the one door a pack's own migration chain reaches the database through.
 * Everything it refuses, it refuses with no database work done at all, so each arm here hands it a
 * `Db` that throws on ANY property access: a rule that let a chain through would not fail on a
 * missing assertion, it would fail on the forbidden handle. That is the accept control for the whole
 * file — the last arm proves the same handle IS reached once the rules are satisfied, so the others
 * cannot be green because nothing ever gets that far.
 *
 * The rules, one arm each:
 *   - a prefix whose namespace CONTAINS a platform table is refused, naming BOTH — the pack and the
 *     platform table it would have swallowed;
 *   - two packs whose prefixes NEST are refused, naming BOTH packs (neither can be the winner by
 *     accident), and equal prefixes are the same refusal;
 *   - a chain the SCAN rejects does not apply: the destructive statement, and the statement that
 *     leaves the declared namespace, are both refused here, at boot, not only in CI;
 *   - a chain with no `meta/_journal.json`, or with a committed `.sql` the journal does not list, is
 *     refused — a migration that silently never runs is the failure this repository names elsewhere
 *     as the silent-skip class;
 *   - a pack id long enough to push `__migrations_<packId>` past Postgres's 63-byte identifier limit
 *     is refused, because the server would TRUNCATE it and two packs would share one journal.
 *
 * No database: every arm here is a refusal, and the one that is not asserts only that the handle was
 * reached. The apply half — the journals, the ordering, the idempotency — is proven against a real
 * Postgres in `packages/app/server/src/pack-migrations.db.test.ts`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from './client.js';
import { applyPackMigrations, PackMigrationError, packJournalTable } from './pack-migrations.js';

/** A conforming one-statement chain in the `fx_` namespace. */
const CONFORMING = 'CREATE TABLE "fx_events" (\n\t"id" uuid PRIMARY KEY NOT NULL\n);';

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'rayspec-pack-migrations-'));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

let n = 0;

/** A fresh directory name, so no two throwaway chains in this file share one. */
function nextChainDir(): string {
  n += 1;
  return join(root, `chain-${n}`);
}

/**
 * Write a throwaway chain: `files` are `tag -> sql`, journalled in the order given unless
 * `journalTags` says otherwise (so the un-journalled-file arm can leave one out). Returns the
 * absolute directory.
 */
function chain(files: Record<string, string>, journalTags?: readonly string[]): string {
  const dir = nextChainDir();
  mkdirSync(join(dir, 'meta'), { recursive: true });
  for (const [tag, sql] of Object.entries(files)) writeFileSync(join(dir, `${tag}.sql`), sql);
  const tags = journalTags ?? Object.keys(files);
  writeFileSync(
    join(dir, 'meta', '_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'postgresql',
      entries: tags.map((tag, idx) => ({
        idx,
        version: '7',
        when: 1_700_000_000_000 + idx,
        tag,
        breakpoints: true,
      })),
    }),
  );
  return dir;
}

/** A chain directory with no `meta/` at all. */
function chainWithoutJournal(sql: string): string {
  const dir = nextChainDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '0000_x.sql'), sql);
  return dir;
}

/**
 * A `Db` that throws on ANY property access. Every refusal below must happen before the handle is
 * touched, so an arm whose rule stopped working fails on THIS rather than on a missing assertion.
 */
const forbiddenDb = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(
        `the database handle was touched (.${String(property)}) — a refused pack migration chain ` +
          'must never reach it',
      );
    },
  },
) as unknown as Db;

describe('applyPackMigrations — the namespace rules, refused before any statement runs', () => {
  it('a prefix whose namespace CONTAINS a platform table is refused, naming both', async () => {
    const dir = chain({ '0000_x': 'CREATE TABLE "org_notes" ("id" uuid PRIMARY KEY NOT NULL);' });
    await expect(
      applyPackMigrations(forbiddenDb, [{ packId: 'p1', dir, tablePrefix: 'org' }]),
    ).rejects.toThrow(PackMigrationError);
    await expect(
      applyPackMigrations(forbiddenDb, [{ packId: 'p1', dir, tablePrefix: 'org' }]),
    ).rejects.toThrow(/'p1'[\s\S]*'org'[\s\S]*orgs/);
  });

  it('a prefix that names NO platform table is not refused for it (the accept control)', async () => {
    const dir = chain({ '0000_x': CONFORMING });
    // Reaches the handle: the prefix rule passed. (`fx_` contains no platform table.)
    await expect(
      applyPackMigrations(forbiddenDb, [{ packId: 'p1', dir, tablePrefix: 'fx_' }]),
    ).rejects.toThrow(/the database handle was touched/);
  });

  it('two packs whose prefixes NEST are refused, naming BOTH packs', async () => {
    const a = chain({ '0000_a': CONFORMING });
    const b = chain({ '0000_b': 'CREATE TABLE "fx_inner_t" ("id" uuid PRIMARY KEY NOT NULL);' });
    await expect(
      applyPackMigrations(forbiddenDb, [
        { packId: 'outer', dir: a, tablePrefix: 'fx_' },
        { packId: 'inner', dir: b, tablePrefix: 'fx_inner_' },
      ]),
    ).rejects.toThrow(/'inner'[\s\S]*'outer'/);
  });

  it('two packs declaring the SAME prefix are the same refusal', async () => {
    const a = chain({ '0000_a': CONFORMING });
    const b = chain({ '0000_b': 'CREATE TABLE "fx_other" ("id" uuid PRIMARY KEY NOT NULL);' });
    await expect(
      applyPackMigrations(forbiddenDb, [
        { packId: 'first', dir: a, tablePrefix: 'fx_' },
        { packId: 'second', dir: b, tablePrefix: 'fx_' },
      ]),
    ).rejects.toThrow(/'second'[\s\S]*'first'/);
  });

  it('a chain carrying a DESTRUCTIVE statement does not apply', async () => {
    const dir = chain({
      '0000_x': `${CONFORMING}\n--> statement-breakpoint\nDROP TABLE "fx_old";`,
    });
    await expect(
      applyPackMigrations(forbiddenDb, [{ packId: 'p1', dir, tablePrefix: 'fx_' }]),
    ).rejects.toThrow(/drop-table/);
  });

  it('a chain that leaves its declared namespace does not apply', async () => {
    const dir = chain({ '0000_x': 'CREATE TABLE "orgs_shadow" ("id" uuid PRIMARY KEY NOT NULL);' });
    await expect(
      applyPackMigrations(forbiddenDb, [{ packId: 'p1', dir, tablePrefix: 'fx_' }]),
    ).rejects.toThrow(/does not carry the declared table prefix 'fx_'/);
  });

  it('a chain directory that reads no .sql file is refused, not skipped', async () => {
    const dir = chain({});
    await expect(
      applyPackMigrations(forbiddenDb, [{ packId: 'p1', dir, tablePrefix: 'fx_' }]),
    ).rejects.toThrow(/scanned 0 migration file/);
  });

  it('a chain with no meta/_journal.json is refused', async () => {
    const dir = chainWithoutJournal(CONFORMING);
    await expect(
      applyPackMigrations(forbiddenDb, [{ packId: 'p1', dir, tablePrefix: 'fx_' }]),
    ).rejects.toThrow(/_journal\.json/);
  });

  it('a committed .sql the journal does not list is refused (it would never run)', async () => {
    const dir = chain(
      {
        '0000_a': CONFORMING,
        '0001_b': 'CREATE TABLE "fx_second" ("id" uuid PRIMARY KEY NOT NULL);',
      },
      ['0000_a'],
    );
    await expect(
      applyPackMigrations(forbiddenDb, [{ packId: 'p1', dir, tablePrefix: 'fx_' }]),
    ).rejects.toThrow(/0001_b/);
  });

  it('a pack id whose journal table would exceed 63 bytes is refused', async () => {
    const dir = chain({ '0000_x': CONFORMING });
    const longId = 'p'.repeat(64 - '__migrations_'.length);
    expect(packJournalTable(longId).length).toBeGreaterThan(63);
    await expect(
      applyPackMigrations(forbiddenDb, [{ packId: longId, dir, tablePrefix: 'fx_' }]),
    ).rejects.toThrow(/63/);
  });

  it('the journal table is the pack id, namespaced — never the platform chain’s', () => {
    expect(packJournalTable('fixture-pack')).toBe('__migrations_fixture-pack');
    expect(packJournalTable('fixture-pack')).not.toBe('__drizzle_migrations');
  });
});
