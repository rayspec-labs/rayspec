/**
 * PACK-OWNED PLATFORM TABLES, END TO END, against a real Postgres and the REAL loader.
 *
 * A pack that needs platform state — hand-shaped indexes, a foreign key, an append-only ledger —
 * declares `migrations: { dir, tablePrefix }` and its chain runs through the SAME drizzle migrator
 * as the platform's, strictly AFTER it, journaled in its own `__migrations_<packId>` table. Every
 * clause of that sentence is measured here rather than asserted:
 *
 *   (1) THE SEAM, REAL: `packages/test/fixture-pack`'s own committed chain, reached the way a
 *       deployment reaches it — the committed `rayspec.yaml` parsed by the real parser, its
 *       `extensions[]` entry resolved by the real `loadExtensions` against the real exact version
 *       pin, the compiled pack entry imported by the production compiled-JavaScript-only importer.
 *       Nothing here is a hand-built manifest: a seam behaviour the fixture does not exercise is
 *       not proven.
 *   (2) AFTER THE PLATFORM CHAIN, NOT BESIDE IT: the fixture chain's foreign key targets `orgs`, a
 *       platform table. It applies on a database the platform chain has already migrated, and the
 *       accept control is the other direction — on an EMPTY database the same chain FAILS, so the
 *       ordering is load-bearing rather than incidental.
 *   (3) ITS OWN JOURNAL: the pack's applied migration is recorded in
 *       `drizzle.__migrations_fixture-pack`, and `drizzle.__drizzle_migrations` — the platform
 *       chain's own bookkeeping — carries exactly the rows it carried before, so a pack chain can
 *       never renumber the core one.
 *   (4) TWO PACKS BOTH RESTARTING AT 0000: each chain is its own chain. Two packs whose first
 *       migration is `0000` both apply, each into its own journal and its own namespace — the case
 *       that a single shared journal would silently swallow, because the second pack's `0000` would
 *       be behind the first's high-water mark.
 *   (5) IDEMPOTENT: a second boot re-applies nothing. The pack table is not recreated (which would
 *       throw) and the journal does not grow.
 *
 * DB ISOLATION: one whole throwaway DATABASE named with process.pid, exactly as the neighbouring
 * boot suites. Skips without DATABASE_URL; the un-skippable ran-guard hard-fails a REQUIRED run that
 * did not run (the false-green class).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyPackMigrations,
  type Db,
  makeDb,
  type PackMigrationChain,
  PackMigrationError,
  packJournalTable,
} from '@rayspec/db';
import { loadExtensions } from '@rayspec/platform';
import { parseSpec } from '@rayspec/spec';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from './composition-root.js';

const baseUrl = process.env.DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');

/**
 * The in-tree fixture pack, its deployment document, and the chain it declares.
 *
 * `rayspec.no-section.yaml` is the same pack and the same exact pin as `rayspec.yaml`, without the
 * claimed top-level section. This suite reads it with the plain `parseSpec`, which is what makes it
 * the right document here: every top-level key in it is one the CORE grammar owns, so resolving the
 * pack is not a precondition of reading the chain off it. The pin, the pack id and the module path
 * all come off the committed file, not out of this test.
 */
const PACK_ROOT = join(repoRoot, 'packages/test/fixture-pack');
const PACK_DOC = join(PACK_ROOT, 'rayspec.no-section.yaml');
const PACK_ID = 'fixture-pack';
const PACK_PREFIX = 'fixture_pack_';

const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
let armsRan = 0;

const CHAIN_DB = `rayspec_pack_chain_${process.pid}`;
const EMPTY_DB = `rayspec_pack_chain_empty_${process.pid}`;
const TENANT = '00000000-0000-4000-8000-00000000041a';

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

// The pack has to have been BUILT — the loader imports compiled JavaScript only, and the chain the
// manifest declares is emitted beside the compiled entry. `test` runs after `^build` in the task
// graph and the pack is a declared devDependency of this package, so any turbo-driven run has it; a
// bare vitest invocation might not. FAIL, loudly and with the fix, rather than skip.
const PACK_ENTRY = join(PACK_ROOT, 'dist/index.js');
if (!existsSync(PACK_ENTRY)) {
  throw new Error(
    `the fixture pack is not built (${PACK_ENTRY} is absent) — run \`pnpm build\` before this ` +
      'suite; the loader imports compiled JavaScript only, so an unbuilt pack is an absent pack.',
  );
}

/** Resolve the fixture pack's chain the way a boot does: the real document, the real loader. */
async function resolveFixtureChains(): Promise<PackMigrationChain[]> {
  const parsed = parseSpec(readFileSync(PACK_DOC, 'utf8'));
  if (!parsed.ok) throw new Error(`the fixture document does not parse: ${JSON.stringify(parsed)}`);
  // The exact pin the committed document carries — not one this test wrote.
  expect(parsed.value.extensions.map((e) => `${e.id}@${e.version}`)).toEqual([`${PACK_ID}@1.0.0`]);
  const loaded = await loadExtensions(parsed.value.extensions, {
    packsRoot: PACK_ROOT,
    deploymentRoot: PACK_ROOT,
  });
  return loaded.migrations;
}

let scratch = '';
let synthetic = 0;

/**
 * A throwaway pack chain: one `0000` migration in `prefix`'s namespace, journaled. Used only for the
 * two-packs-both-at-0000 arm, where the point is that the NUMBERING collides and the journals do not.
 */
function syntheticChain(packId: string, prefix: string): PackMigrationChain {
  synthetic += 1;
  const dir = join(scratch, `chain-${synthetic}`);
  mkdirSync(join(dir, 'meta'), { recursive: true });
  writeFileSync(
    join(dir, '0000_init.sql'),
    `CREATE TABLE "${prefix}items" (\n\t"id" uuid PRIMARY KEY NOT NULL,\n\t"note" text NOT NULL\n);`,
  );
  writeFileSync(
    join(dir, 'meta', '_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'postgresql',
      entries: [
        { idx: 0, version: '7', when: 1_700_000_000_000, tag: '0000_init', breakpoints: true },
      ],
    }),
  );
  return { packId, dir, tablePrefix: prefix };
}

/** One scalar from the database under test. */
async function scalar(db: Db, sql: string, params: unknown[] = []): Promise<string> {
  const rows = (await db.$client.unsafe(sql, params as never[])) as unknown as Record<
    string,
    unknown
  >[];
  return String(Object.values(rows[0] ?? { v: '' })[0]);
}

describe.skipIf(!baseUrl)('a pack owns platform tables — applied after the platform chain', () => {
  let db: Db | undefined;
  let emptyDb: Db | undefined;
  let platformJournalRows = '';

  beforeAll(async () => {
    if (!baseUrl) return;
    scratch = mkdtempSync(join(tmpdir(), 'rayspec-pack-chain-'));
    const admin = postgres(adminUrl(baseUrl), { max: 1 });
    try {
      for (const d of [CHAIN_DB, EMPTY_DB]) {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${d}" WITH (FORCE)`);
        await admin.unsafe(`CREATE DATABASE "${d}"`);
      }
    } finally {
      await admin.end();
    }
    db = makeDb(withDbName(baseUrl, CHAIN_DB));
    emptyDb = makeDb(withDbName(baseUrl, EMPTY_DB));

    // (2) THE PLATFORM CHAIN FIRST — the same call the boot makes, on the same database.
    await applyMigrations(db);
    platformJournalRows = await scalar(db, 'SELECT count(*) FROM drizzle.__drizzle_migrations');
    expect(Number(platformJournalRows)).toBeGreaterThan(0);
  }, 180_000);

  afterAll(async () => {
    await db?.$client.end();
    await emptyDb?.$client.end();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    if (baseUrl) {
      const admin = postgres(adminUrl(baseUrl), { max: 1 });
      try {
        for (const d of [CHAIN_DB, EMPTY_DB]) {
          await admin.unsafe(`DROP DATABASE IF EXISTS "${d}" WITH (FORCE)`);
        }
      } finally {
        await admin.end();
      }
    }
    if (dbRequired && armsRan === 0) {
      throw new Error(
        'pack-migrations.db.test: the DB was REQUIRED (CI / RAYSPEC_REQUIRE_DB_TESTS) but no arm ' +
          'ran — refusing to report a green that measured nothing.',
      );
    }
  }, 120_000);

  it('(1) the REAL loader resolves the fixture pack’s chain from its committed document', async () => {
    armsRan += 1;
    const chains = await resolveFixtureChains();
    expect(chains).toEqual([
      { packId: PACK_ID, dir: join(PACK_ROOT, 'dist', 'migrations'), tablePrefix: PACK_PREFIX },
    ]);
  });

  it('(2) the chain applies on the migrated database, and its objects carry the prefix', async () => {
    armsRan += 1;
    if (!db) return;
    const applied = await applyPackMigrations(db, await resolveFixtureChains());
    expect(applied.map((a) => a.packId)).toEqual([PACK_ID]);

    expect(await scalar(db, "SELECT to_regclass('public.fixture_pack_audit_events')::text")).toBe(
      'fixture_pack_audit_events',
    );
    // Both hand-shaped indexes — the thing a `stores` fragment could not have expressed.
    expect(
      await scalar(
        db,
        "SELECT count(*) FROM pg_indexes WHERE tablename = 'fixture_pack_audit_events' AND indexname LIKE 'fixture_pack_%'",
      ),
    ).toBe('3');
    // The foreign key onto the platform's own `orgs` — and it CASCADES, which is why the chain has
    // to run after the platform's.
    await db.$client.unsafe("INSERT INTO orgs (id, name, slug) VALUES ($1, 'Pack', 'pack')", [
      TENANT,
    ] as never[]);
    await db.$client.unsafe(
      `INSERT INTO fixture_pack_audit_events (tenant_id, actor, action, payload)
       VALUES ($1, 'someone', 'created', '{}'::jsonb)`,
      [TENANT] as never[],
    );
    expect(await scalar(db, 'SELECT count(*) FROM fixture_pack_audit_events')).toBe('1');
    await db.$client.unsafe('DELETE FROM orgs WHERE id = $1', [TENANT] as never[]);
    expect(await scalar(db, 'SELECT count(*) FROM fixture_pack_audit_events')).toBe('0');
  });

  it('(2b) ACCEPT CONTROL: the same chain on a database with NO platform chain FAILS', async () => {
    armsRan += 1;
    if (!emptyDb) return;
    await expect(applyPackMigrations(emptyDb, await resolveFixtureChains())).rejects.toThrow(
      /orgs/,
    );
  });

  it('(3) the pack is journaled in its OWN table, and the platform journal is untouched', async () => {
    armsRan += 1;
    if (!db) return;
    expect(packJournalTable(PACK_ID)).toBe('__migrations_fixture-pack');
    expect(await scalar(db, `SELECT count(*) FROM drizzle."${packJournalTable(PACK_ID)}"`)).toBe(
      '1',
    );
    expect(await scalar(db, 'SELECT count(*) FROM drizzle.__drizzle_migrations')).toBe(
      platformJournalRows,
    );
  });

  it('(5) a second apply re-applies nothing', async () => {
    armsRan += 1;
    if (!db) return;
    await applyPackMigrations(db, await resolveFixtureChains());
    expect(await scalar(db, `SELECT count(*) FROM drizzle."${packJournalTable(PACK_ID)}"`)).toBe(
      '1',
    );
    expect(await scalar(db, 'SELECT count(*) FROM drizzle.__drizzle_migrations')).toBe(
      platformJournalRows,
    );
  });

  it('(4) two packs whose chains BOTH start at 0000 do not renumber each other', async () => {
    armsRan += 1;
    if (!db) return;
    const a = syntheticChain('alpha', 'alpha_');
    const b = syntheticChain('beta', 'beta_');
    await applyPackMigrations(db, [a, b]);
    expect(await scalar(db, "SELECT to_regclass('public.alpha_items')::text")).toBe('alpha_items');
    expect(await scalar(db, "SELECT to_regclass('public.beta_items')::text")).toBe('beta_items');
    expect(await scalar(db, `SELECT count(*) FROM drizzle."${packJournalTable('alpha')}"`)).toBe(
      '1',
    );
    expect(await scalar(db, `SELECT count(*) FROM drizzle."${packJournalTable('beta')}"`)).toBe(
      '1',
    );
    expect(await scalar(db, 'SELECT count(*) FROM drizzle.__drizzle_migrations')).toBe(
      platformJournalRows,
    );
  });

  it('a chain whose prefix collides with a platform table is refused, and nothing is applied', async () => {
    armsRan += 1;
    if (!db) return;
    const bad = syntheticChain('greedy', 'org');
    await expect(applyPackMigrations(db, [bad])).rejects.toThrow(PackMigrationError);
    expect(await scalar(db, "SELECT to_regclass('public.orgitems')::text")).toBe('null');
  });
});
