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
 *   - both of those hold in POSTGRES'S case space rather than in the declared text's: the server
 *     folds an unquoted identifier to lower case, so `Orgs` names the platform's `orgs` and two
 *     packs declaring `fx_`/`FX_` own ONE namespace. The second describe block below is that half,
 *     and every arm in it carries the lowercase arm beside it as its control;
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

/**
 * THE SAME RULES, IN THE CASE SPACE THE SERVER USES.
 *
 * PostgreSQL folds an UNQUOTED identifier to lower case before it names anything, and keeps a QUOTED
 * one exactly: `ALTER TABLE Orgs` targets the platform's `orgs`, and two packs declaring `fx_` and
 * `FX_` own ONE namespace, not two. Every rule above compares text, so read verbatim they would all
 * have cleared a case-varied prefix — the pack's declared namespace would have been measured against
 * a name the database never writes down.
 *
 * Each arm here is paired with the arm one case-shift away, so none of them can be green because the
 * comparison became a blanket refusal: an unquoted name that FOLDS INTO the declared namespace still
 * reaches the handle, and so does a prefix that is already in the folded form.
 */
describe('applyPackMigrations — namespace rules in PostgreSQL’s own case space', () => {
  it('a prefix whose FOLDED form contains a platform table is refused, naming both', async () => {
    // The statement the refusal prevents: unquoted `Orgs` IS the platform's `orgs` to the server.
    const dir = chain({ '0000_x': 'ALTER TABLE Orgs ADD COLUMN "note" text;' });
    await expect(
      applyPackMigrations(forbiddenDb, [{ packId: 'p1', dir, tablePrefix: 'Orgs' }]),
    ).rejects.toThrow(/'p1'[\s\S]*'Orgs'[\s\S]*contains the platform table orgs/);
  });

  it('CONTROL: the same chain declared in the folded case is the same refusal', async () => {
    const dir = chain({ '0000_x': 'ALTER TABLE orgs ADD COLUMN "note" text;' });
    await expect(
      applyPackMigrations(forbiddenDb, [{ packId: 'p1', dir, tablePrefix: 'orgs' }]),
    ).rejects.toThrow(/'p1'[\s\S]*'orgs'[\s\S]*contains the platform table orgs/);
  });

  it('two packs whose prefixes differ ONLY in case are one namespace, refused naming both', async () => {
    const a = chain({ '0000_a': 'CREATE TABLE fx2_one ("id" uuid PRIMARY KEY NOT NULL);' });
    const b = chain({ '0000_b': 'CREATE TABLE FX2_two ("id" uuid PRIMARY KEY NOT NULL);' });
    await expect(
      applyPackMigrations(forbiddenDb, [
        { packId: 'lower', dir: a, tablePrefix: 'fx2_' },
        { packId: 'upper', dir: b, tablePrefix: 'FX2_' },
      ]),
    ).rejects.toThrow(/'upper'[\s\S]*'FX2_'[\s\S]*'fx2_'[\s\S]*'lower'/);
  });

  it('CONTROL: two packs whose prefixes are genuinely disjoint are not refused for it', async () => {
    const a = chain({ '0000_a': 'CREATE TABLE fx2_one ("id" uuid PRIMARY KEY NOT NULL);' });
    const b = chain({ '0000_b': 'CREATE TABLE gx2_two ("id" uuid PRIMARY KEY NOT NULL);' });
    await expect(
      applyPackMigrations(forbiddenDb, [
        { packId: 'first', dir: a, tablePrefix: 'fx2_' },
        { packId: 'second', dir: b, tablePrefix: 'gx2_' },
      ]),
    ).rejects.toThrow(/the database handle was touched/);
  });

  it('an UNQUOTED object name is folded, so a case-varied one is INSIDE the namespace', async () => {
    // `CREATE TABLE FX_events` creates `fx_events` — the pack's own table, not an escape.
    const dir = chain({ '0000_x': 'CREATE TABLE FX_events ("id" uuid PRIMARY KEY NOT NULL);' });
    await expect(
      applyPackMigrations(forbiddenDb, [{ packId: 'p1', dir, tablePrefix: 'fx_' }]),
    ).rejects.toThrow(/the database handle was touched/);
  });

  it('a QUOTED object name keeps its case, and one outside the namespace is refused', async () => {
    // `"FX_events"` is a DIFFERENT table from `fx_events`, and it carries no declared prefix.
    const dir = chain({ '0000_x': 'CREATE TABLE "FX_events" ("id" uuid PRIMARY KEY NOT NULL);' });
    await expect(
      applyPackMigrations(forbiddenDb, [{ packId: 'p1', dir, tablePrefix: 'fx_' }]),
    ).rejects.toThrow(/does not carry the declared table prefix 'fx_'/);
  });

  it('a prefix that is not in the folded form is refused even when it collides with nothing', async () => {
    const dir = chain({ '0000_x': 'CREATE TABLE Acme_events ("id" uuid PRIMARY KEY NOT NULL);' });
    await expect(
      applyPackMigrations(forbiddenDb, [{ packId: 'p1', dir, tablePrefix: 'Acme_' }]),
    ).rejects.toThrow(/'Acme_' is not a plain lowercase SQL identifier fragment/);
  });

  it('CONTROL: the same pack with the folded prefix passes every rule', async () => {
    const dir = chain({ '0000_x': 'CREATE TABLE Acme_events ("id" uuid PRIMARY KEY NOT NULL);' });
    await expect(
      applyPackMigrations(forbiddenDb, [{ packId: 'p1', dir, tablePrefix: 'acme_' }]),
    ).rejects.toThrow(/the database handle was touched/);
  });
});
