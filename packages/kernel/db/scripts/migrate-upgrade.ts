/**
 * UPGRADE-FROM-THE-RELEASED-DATABASE gate — the other half of the migration exit bar.
 *
 * WHY THIS EXISTS. Every other database gate in this repository bootstraps from an EMPTY database:
 * `scripts/shadow-dryrun.sh:13` applies the chain "against a TRULY EMPTY DB", and
 * `scripts/migrate-clean.sh:66-68` provisions a fresh one. Nothing materialized the database a
 * released deployment actually has and then applied the newer migrations to it, so the CLEAN-INSTALL
 * half of the bar was proven and the UPGRADE half was not. What was already guarded is the MECHANISM
 * that makes an incremental apply correct — `shadow-dryrun.sh:97-108` asserts the journal `when`
 * values are strictly monotonic, which is exactly drizzle's silent-skip failure mode — but the apply
 * itself was never exercised on a populated database. This gate is that missing half.
 *
 * WHAT IT DOES. Against a throwaway database on the server named by DATABASE_URL:
 *
 *   Step 1  Build a RELEASED-BASELINE copy of `drizzle/` in a temp directory: the same .sql files,
 *           with `meta/_journal.json` truncated to the released prefix and the post-baseline .sql
 *           files REMOVED from the copy, so "only the prefix can be applied" is structural.
 *   Step 2  Apply that baseline through the real programmatic migrator.
 *   Step 3  Seed representative pre-upgrade rows across the core platform tables a released
 *           deployment holds: two orgs, plus runs / journal_steps / run_events /
 *           tenant_event_streams / tenant_events.
 *   Step 4  Capture, per seeded table, the live PRE-UPGRADE column list and a row digest computed
 *           over exactly those columns — so a later migration that ADDS a column does not read as a
 *           change to existing data, while any rewrite, loss or fabrication of existing data does.
 *   Step 5  Apply the FULL committed chain to that populated database. This is the incremental apply.
 *   Step 6  Assert the oracle (below).
 *   Step 7  Apply the full chain a THIRD time and assert the bookkeeping table is unchanged.
 *   Step 8  Run `scripts/migrate-clean-assert.ts` — the SAME entry point `migrate-clean.sh:156`
 *           runs — against the upgraded database, so the zero-drift oracle here is that script and
 *           not a re-implementation of it.
 *
 * THE ORACLE.
 *   - `drizzle.__drizzle_migrations` holds exactly `baselineCount` rows after the baseline apply and
 *     exactly `baselineCount + newCount` after the upgrade — no silent skip, no double apply.
 *   - Every baseline bookkeeping row (id, hash, created_at) is byte-identical after the upgrade — no
 *     already-applied migration was re-applied.
 *   - Every seeded row is byte-identical after the upgrade, and every pre-upgrade column still exists
 *     with the same type, nullability and default.
 *   - The tables the upgrade CREATES (derived as a set difference, never listed here, so this tracks
 *     whatever the committed chain adds) are non-empty as a set and each holds ZERO rows.
 *   - A third apply changes nothing.
 *   - `migrate-clean-assert.ts` reports zero structural drift against schema.ts.
 *
 * HOW THE BASELINE IS PINNED. The released boundary is a fixed historical fact, so it is anchored on
 * the migration TAG that ends the released chain (`BASELINE_TAG` below), never on a count. Its index
 * is looked up in the live journal and everything else is derived from that, so the number of
 * migrations this gate upgrades across is read off the journal at run time. A renamed or removed
 * anchor fails loudly rather than silently applying the wrong prefix, and a chain with nothing after
 * the baseline fails too (a gate with nothing to upgrade across proves nothing).
 *
 * WHY A JOURNAL PREFIX RATHER THAN THE RELEASED TAG'S TREE. Checking `v1.8.0`'s `drizzle/` out of git
 * would be the more faithful source, but it cannot run where this gate must run: the database job in
 * `.github/workflows/ci.yml:348` checks out with `actions/checkout` defaults — depth 1, no tags —
 * unlike the lane above it, which pins `fetch-depth: 0` for the secret scan. The journal filter needs
 * only the working tree.
 *
 * WHY THE PROGRAMMATIC MIGRATOR. Both applies go through `migrate(db, { migrationsFolder })` from
 * `drizzle-orm/postgres-js/migrator` — the exact call the boot makes in
 * `packages/app/server/src/composition-root.ts:1640`. That is the path a real upgrade takes (a
 * deployed server booting a newer version against its existing database), and it accepts the folder
 * as an argument, which is what makes applying a prefix possible at all: `drizzle-kit migrate` reads
 * its folder from `out` in `drizzle.config.ts`, a fixed `'./drizzle'`. `gate:migrate-clean` already
 * covers the `drizzle-kit migrate` applier from empty, so the two gates together cover both real
 * appliers.
 *
 * Clean-room: derives the server from DATABASE_URL (falling back to the documented local default),
 * creates its OWN throwaway database on that server, and drops it on ANY exit. Exits non-zero on the
 * first failed assertion.
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

/**
 * The migration tag that ENDS the released chain — the database a deployment running the latest
 * published release actually has. A fixed historical fact, so it is named rather than counted; every
 * other number in this gate is derived from where this tag sits in the live journal.
 */
const BASELINE_TAG = '0011_tenant_event_bus';

const DB_PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHAIN_DIR = join(DB_PKG_DIR, 'drizzle');

const BASE_URL = process.env.DATABASE_URL ?? 'postgres://rayspec:rayspec@localhost:5433/rayspec';

function fail(msg: string): never {
  console.error(`MIGRATE-UPGRADE: FAIL — ${msg}`);
  process.exit(1);
}

function withDbName(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

const baseDbName = decodeURIComponent(new URL(BASE_URL).pathname.replace(/^\//, '')) || 'rayspec';
const UPGRADE_DB = `${baseDbName}_migrate_upgrade`;
const UPGRADE_URL = withDbName(BASE_URL, UPGRADE_DB);
const ADMIN_URL = withDbName(BASE_URL, 'postgres');

interface JournalEntry {
  readonly idx: number;
  readonly version: string;
  readonly when: number;
  readonly tag: string;
  readonly breakpoints: boolean;
}
interface Journal {
  readonly version: string;
  readonly dialect: string;
  readonly entries: JournalEntry[];
}

/** One captured table snapshot: the live column list and a digest over exactly those columns. */
interface TableSnapshot {
  readonly columns: string[];
  readonly rows: number;
  readonly digest: string;
  readonly columnShape: string[];
}

/** The core tables a released deployment holds rows in, seeded below with deterministic values. */
const SEEDED_TABLES = [
  'orgs',
  'runs',
  'journal_steps',
  'run_events',
  'tenant_event_streams',
  'tenant_events',
] as const;

const TENANT_A = '00000000-0000-4000-8000-00000000a001';
const TENANT_B = '00000000-0000-4000-8000-00000000b002';

async function main(): Promise<void> {
  // ── Step 1: build the released-baseline copy of the migration folder ───────────────────────────
  const journal = JSON.parse(
    readFileSync(join(CHAIN_DIR, 'meta', '_journal.json'), 'utf8'),
  ) as Journal;
  const ordered = [...journal.entries].sort((a, b) => a.idx - b.idx);
  const anchor = ordered.findIndex((e) => e.tag === BASELINE_TAG);
  if (anchor < 0) {
    fail(
      `the released-baseline anchor tag "${BASELINE_TAG}" is not in drizzle/meta/_journal.json. The ` +
        'anchor names a published migration; if the chain was renumbered, re-derive it rather than ' +
        `guessing. Journal tags: ${ordered.map((e) => e.tag).join(', ')}`,
    );
  }
  const baselineCount = anchor + 1;
  const newCount = ordered.length - baselineCount;
  if (newCount < 1) {
    fail(
      `the committed chain ends at the released baseline "${BASELINE_TAG}" (${ordered.length} ` +
        'journal entries), so there is no upgrade for this gate to exercise. A gate with nothing to ' +
        'prove must go red, not green.',
    );
  }
  console.log(
    `== released baseline: ${baselineCount} migration(s) through ${BASELINE_TAG}; the upgrade applies ` +
      `${newCount} more (${ordered
        .slice(baselineCount)
        .map((e) => e.tag)
        .join(', ')}) ==`,
  );

  const tmpRoot = mkdtempSync(join(tmpdir(), 'rayspec-migrate-upgrade-'));
  const baselineDir = join(tmpRoot, 'baseline');
  cpSync(CHAIN_DIR, baselineDir, { recursive: true });
  const baselineEntries = ordered.slice(0, baselineCount);
  writeFileSync(
    join(baselineDir, 'meta', '_journal.json'),
    `${JSON.stringify({ ...journal, entries: baselineEntries }, null, 2)}\n`,
    'utf8',
  );
  // Remove the post-baseline .sql files from the COPY so the prefix is structural, not a promise: a
  // filtered journal that still had the newer files beside it would apply the prefix only for as long
  // as nothing else read the directory.
  for (const e of ordered.slice(baselineCount)) unlinkSync(join(baselineDir, `${e.tag}.sql`));
  // The orphan rule the chain gate holds (`shadow-dryrun.sh:121-129`) applied to the filtered copy:
  // its journal tags must equal its .sql basenames, or the prefix this gate applies is not the prefix
  // it thinks it is.
  const baselineTags = baselineEntries.map((e) => e.tag).sort();
  const baselineFiles = readdirSync(baselineDir)
    .filter((f) => /^\d.*\.sql$/.test(f))
    .map((f) => f.replace(/\.sql$/, ''))
    .sort();
  if (baselineTags.join(',') !== baselineFiles.join(',')) {
    fail(
      `the released-baseline copy is inconsistent — journal tags [${baselineTags.join(', ')}] != ` +
        `*.sql basenames [${baselineFiles.join(', ')}].`,
    );
  }
  console.log(`  ok: released-baseline folder holds exactly ${baselineTags.length} migration(s).`);

  // ── the throwaway database ─────────────────────────────────────────────────────────────────────
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`DROP DATABASE IF EXISTS "${UPGRADE_DB}" WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE "${UPGRADE_DB}"`);
  // Pin the two session settings that decide how a timestamp renders as text, at the DATABASE level so
  // every connection inherits them. The row digests below are taken over `ROW(...)::text`, so an
  // ambient TimeZone/DateStyle difference between the capture and the re-read would show up as a data
  // change that never happened.
  await admin.unsafe(`ALTER DATABASE "${UPGRADE_DB}" SET TimeZone TO 'UTC'`);
  await admin.unsafe(`ALTER DATABASE "${UPGRADE_DB}" SET DateStyle TO 'ISO, YMD'`);
  await admin.end();
  console.log(`== target server: ${new URL(BASE_URL).host}; throwaway DB: ${UPGRADE_DB} ==`);

  const sql = postgres(UPGRADE_URL, { max: 1, onnotice: () => {} });
  const db = drizzle(sql);

  const cleanup = async (): Promise<void> => {
    try {
      await sql.end({ timeout: 5 });
    } catch {
      /* ignore */
    }
    try {
      const a = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
      await a.unsafe(`DROP DATABASE IF EXISTS "${UPGRADE_DB}" WITH (FORCE)`);
      await a.end();
    } catch {
      /* ignore */
    }
    rmSync(tmpRoot, { recursive: true, force: true });
  };

  try {
    // ── Step 2: apply the released baseline through the real migrator ────────────────────────────
    console.log(
      '== applying the RELEASED BASELINE chain through the real programmatic migrator ==',
    );
    await migrate(db, { migrationsFolder: baselineDir });
    const appliedAtBaseline = await bookkeeping(sql);
    if (appliedAtBaseline.length !== baselineCount) {
      fail(
        `the baseline apply recorded ${appliedAtBaseline.length} migration(s) but the released ` +
          `baseline is ${baselineCount}.`,
      );
    }
    const tablesBefore = await publicTables(sql);
    console.log(
      `  ok: ${appliedAtBaseline.length} baseline migration(s) applied; ${tablesBefore.length} ` +
        'public table(s) present.',
    );

    // ── Step 3: seed representative pre-upgrade rows ─────────────────────────────────────────────
    console.log('== seeding representative PRE-UPGRADE rows (two tenants) ==');
    await seed(sql);
    for (const t of SEEDED_TABLES) {
      const [r] = (await sql.unsafe(`SELECT count(*)::int AS n FROM public."${t}"`)) as unknown as {
        n: number;
      }[];
      if (!r || r.n === 0)
        fail(`the seed left "${t}" EMPTY — the byte-identity oracle would be vacuous.`);
    }
    console.log(`  ok: all ${SEEDED_TABLES.length} seeded table(s) hold rows.`);

    // ── Step 4: capture the pre-upgrade shape + row digests ──────────────────────────────────────
    const before: Record<string, TableSnapshot> = {};
    for (const t of SEEDED_TABLES) before[t] = await snapshot(sql, t);

    // ── Step 5: the INCREMENTAL apply — the full committed chain onto the populated baseline ─────
    console.log(
      '== applying the FULL committed chain INCREMENTALLY onto the populated baseline ==',
    );
    await migrate(db, { migrationsFolder: CHAIN_DIR });

    // ── Step 6: the oracle ───────────────────────────────────────────────────────────────────────
    const appliedAfter = await bookkeeping(sql);
    if (appliedAfter.length !== baselineCount + newCount) {
      fail(
        `after the upgrade __drizzle_migrations holds ${appliedAfter.length} row(s); expected ` +
          `${baselineCount} baseline + ${newCount} new = ${baselineCount + newCount}. A short count is ` +
          "a SILENTLY SKIPPED migration (drizzle's `when` high-water mark); a long one is a re-apply.",
      );
    }
    console.log(
      `  ok: __drizzle_migrations advanced ${baselineCount} -> ${appliedAfter.length} (exactly the ` +
        `${newCount} new migration(s), no skip, no double apply).`,
    );

    for (let i = 0; i < baselineCount; i++) {
      const b = appliedAtBaseline[i];
      const a = appliedAfter[i];
      if (!b || !a || b.id !== a.id || b.hash !== a.hash || b.created_at !== a.created_at) {
        fail(
          `baseline bookkeeping row ${i} CHANGED across the upgrade — an already-applied migration was ` +
            `re-applied. before=${JSON.stringify(b)} after=${JSON.stringify(a)}`,
        );
      }
    }
    console.log(
      `  ok: all ${baselineCount} baseline bookkeeping row(s) byte-identical — no re-apply.`,
    );

    for (const t of SEEDED_TABLES) {
      const b = before[t] as TableSnapshot;
      const a = await snapshot(sql, t, b.columns);
      if (a.rows !== b.rows) {
        fail(`"${t}" held ${b.rows} row(s) before the upgrade and ${a.rows} after.`);
      }
      if (a.digest !== b.digest) {
        fail(
          `"${t}" rows CHANGED across the upgrade (digest over the pre-upgrade columns ` +
            `[${b.columns.join(', ')}]: ${b.digest} -> ${a.digest}).`,
        );
      }
      const missing = b.columnShape.filter((c) => !a.columnShape.includes(c));
      if (missing.length > 0) {
        fail(
          `"${t}" lost or retyped pre-upgrade column(s) across the upgrade: ${missing.join(' | ')}. ` +
            `Live shape now: ${a.columnShape.join(' | ')}`,
        );
      }
    }
    console.log(
      `  ok: all ${SEEDED_TABLES.length} seeded table(s) byte-identical after the upgrade, and every ` +
        'pre-upgrade column still present with the same type, nullability and default.',
    );

    const tablesAfter = await publicTables(sql);
    const created = tablesAfter.filter((t) => !tablesBefore.includes(t));
    if (created.length === 0) {
      fail(
        'the upgrade created NO new table, so the baseline was not actually older than the committed ' +
          'chain and this gate proved nothing about an upgrade.',
      );
    }
    for (const t of created) {
      const [r] = (await sql.unsafe(`SELECT count(*)::int AS n FROM public."${t}"`)) as unknown as {
        n: number;
      }[];
      if ((r?.n ?? -1) !== 0) fail(`newly created table "${t}" holds ${r?.n} row(s); expected 0.`);
    }
    console.log(
      `  ok: the upgrade created ${created.length} table(s) (${created.join(', ')}), each EMPTY.`,
    );

    // ── Step 7: a repeated apply on the upgraded database changes nothing ────────────────────────
    await migrate(db, { migrationsFolder: CHAIN_DIR });
    const appliedTwice = await bookkeeping(sql);
    if (JSON.stringify(appliedTwice) !== JSON.stringify(appliedAfter)) {
      fail('re-applying the committed chain to the upgraded DB changed __drizzle_migrations.');
    }
    console.log('  ok: a repeated apply on the upgraded DB is a no-op (bookkeeping unchanged).');

    await sql.end({ timeout: 5 });

    // ── Step 8: zero structural drift vs schema.ts, via the clean gate's own assertion script ────
    console.log(
      '== complete structural cross-check of the UPGRADED DB (migrate-clean-assert.ts) ==',
    );
    const res = spawnSync('pnpm', ['exec', 'tsx', 'scripts/migrate-clean-assert.ts'], {
      cwd: DB_PKG_DIR,
      env: { ...process.env, MIGRATE_CLEAN_URL: UPGRADE_URL },
      stdio: 'inherit',
    });
    if (res.status !== 0) {
      fail(
        'the UPGRADED database drifts from schema.ts (see the structural cross-check output above). ' +
          'A clean install reaching the right shape does not prove an incremental apply reaches it.',
      );
    }
  } finally {
    await cleanup();
  }

  console.log(
    'MIGRATE-UPGRADE: PASS — a released database upgrades incrementally to the committed chain with ' +
      'no skipped or re-applied migration, no change to any pre-existing row, and zero drift.',
  );
}

/** The drizzle bookkeeping rows, in apply order. */
async function bookkeeping(
  sql: postgres.Sql,
): Promise<{ id: number; hash: string; created_at: string }[]> {
  const rows = (await sql.unsafe(
    'SELECT id, hash, created_at::text AS created_at FROM drizzle.__drizzle_migrations ORDER BY id',
  )) as unknown as { id: number; hash: string; created_at: string }[];
  return rows.map((r) => ({ id: r.id, hash: r.hash, created_at: r.created_at }));
}

/** The `public` BASE TABLE names, sorted. */
async function publicTables(sql: postgres.Sql): Promise<string[]> {
  const rows = (await sql.unsafe(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name",
  )) as unknown as { table_name: string }[];
  return rows.map((r) => r.table_name);
}

/**
 * Snapshot one table: its live column list, its row count, a digest over the given columns (defaulting
 * to the live ones), and a per-column type/nullability/default shape line.
 *
 * The digest is taken over an EXPLICIT column list rather than the whole row so a later migration that
 * ADDS a column does not read as a change to data that did not change — the post-upgrade re-read is
 * asked for exactly the columns the pre-upgrade capture saw. Ordering by the rendered row text makes it
 * independent of physical row order, which a table rewrite is free to change.
 */
async function snapshot(
  sql: postgres.Sql,
  table: string,
  pinnedColumns?: string[],
): Promise<TableSnapshot> {
  const live = (await sql.unsafe(
    "SELECT column_name, data_type, is_nullable, coalesce(column_default, '') AS column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position",
    [table],
  )) as unknown as {
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string;
  }[];
  const columns = pinnedColumns ?? live.map((c) => c.column_name);
  const columnShape = live.map(
    (c) => `${c.column_name}:${c.data_type}:${c.is_nullable}:${c.column_default}`,
  );
  const cols = columns.map((c) => `"${c}"`).join(', ');
  const [row] = (await sql.unsafe(
    `SELECT count(*)::int AS n, coalesce(md5(string_agg(t, '|' ORDER BY t)), '') AS digest
     FROM (SELECT ROW(${cols})::text AS t FROM public."${table}") s`,
  )) as unknown as { n: number; digest: string }[];
  return {
    columns,
    rows: row?.n ?? 0,
    digest: row?.digest ?? '',
    columnShape,
  };
}

/**
 * Seed the released database with representative rows for two tenants.
 *
 * Written as explicit SQL against the RELEASED column set rather than through schema.ts: schema.ts
 * describes the chain's END state, and this insert runs against the released one. Every value —
 * including the ids and timestamps that would otherwise default — is supplied explicitly, so the
 * byte-identity digests compare a fixture and not a clock.
 */
async function seed(sql: postgres.Sql): Promise<void> {
  const t0 = '2026-01-02 03:04:05+00';
  for (const [id, name, slug] of [
    [TENANT_A, 'Upgrade Fixture A', 'upgrade-fixture-a'],
    [TENANT_B, 'Upgrade Fixture B', 'upgrade-fixture-b'],
  ] as const) {
    await sql.unsafe(
      'INSERT INTO public.orgs (id, name, slug, region, retention_days, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, name, slug, 'eu', 30, t0],
    );
  }
  for (const [tenant, suffix] of [
    [TENANT_A, 'a'],
    [TENANT_B, 'b'],
  ] as const) {
    const runId = `run-upgrade-${suffix}`;
    await sql.unsafe(
      `INSERT INTO public.runs
         (run_id, tenant_id, backend, auth_mode, agent_name, model, status, final_text, output,
          cost_usd, provider_cost_usd, billed_cost_usd, cost_drift, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14)`,
      [
        runId,
        tenant,
        'openai',
        'api-key',
        'fixture_agent',
        'gpt-4o-mini',
        'completed',
        `final text for ${suffix}`,
        JSON.stringify({ text: `output for ${suffix}` }),
        '0.0100',
        '0.0110',
        '0.0100',
        false,
        t0,
      ],
    );
    await sql.unsafe(
      `INSERT INTO public.journal_steps
         (step_id, run_id, tenant_id, backend, type, idempotency_key, input_hash, output,
          input_tokens, output_tokens, total_tokens, cost_usd, provider_cost_usd, billed_cost_usd,
          cost_drift, produced_by, pricing_version, latency_ms, status, error_class, retry_after_ms,
          auth_mode, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
      [
        `00000000-0000-4000-8000-0000000${suffix === 'a' ? '0' : '1'}0001`,
        runId,
        tenant,
        'openai',
        'llm',
        `idem-${suffix}-0`,
        `hash-${suffix}-0`,
        JSON.stringify({ text: `step output for ${suffix}` }),
        '11',
        '22',
        '33',
        '0.0100',
        '0.0110',
        '0.0100',
        false,
        'fixture@1',
        'gpt-4o-mini@2026-01-01',
        '123',
        'succeeded',
        null,
        null,
        'api-key',
        t0,
      ],
    );
    await sql.unsafe(
      `INSERT INTO public.run_events (id, run_id, tenant_id, seq, type, data, created_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
      [
        `00000000-0000-4000-8000-0000000${suffix === 'a' ? '0' : '1'}0002`,
        runId,
        tenant,
        '1',
        'run_completed',
        JSON.stringify({ v: 1, type: 'run_completed' }),
        t0,
      ],
    );
    await sql.unsafe(
      'INSERT INTO public.tenant_event_streams (tenant_id, last_seq, truncated_through, updated_at) VALUES ($1,$2,$3,$4)',
      [tenant, 2, 0, t0],
    );
    for (const seq of [1, 2]) {
      await sql.unsafe(
        'INSERT INTO public.tenant_events (tenant_id, seq, topic, payload, at) VALUES ($1,$2,$3,$4::jsonb,$5)',
        [tenant, seq, `fixture.topic.${suffix}`, JSON.stringify({ n: seq }), t0],
      );
    }
  }
}

main().catch(async (err) => {
  console.error('MIGRATE-UPGRADE: FAIL — the upgrade gate threw:', err);
  try {
    const a = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
    await a.unsafe(`DROP DATABASE IF EXISTS "${UPGRADE_DB}" WITH (FORCE)`);
    await a.end();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
