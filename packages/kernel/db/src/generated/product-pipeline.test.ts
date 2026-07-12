/**
 * The full `stores` materialization PIPELINE, exercised on the THROWAWAY.
 *
 * DB-backed (real Postgres via DATABASE_URL, isolated per-suite schema — never `public`). Reads the
 * throwaway `examples/acme-notes-backend/rayspec.yaml`, runs the materialization pipeline against an isolated
 * schema, and proves the load-bearing invariants NON-VACUOUSLY:
 *
 *   validate  — parseSpec(throwaway) is ok (the input is a real, validated spec).
 *   diff      — the COMMITTED generated SQL artifact (examples/.../drizzle) equals what
 *               generateProductSql() produces now (the checked-in artifact is not stale).
 *   lint/gate — the generated SQL has NO destructive findings (purely additive CREATE TABLE).
 *   migrate   — the generated SQL APPLIES cleanly to the isolated schema (after the orgs root).
 *   tenancy   — assertProductTenancy over the THROWAWAY tables: every product table has the
 *               tenant_id FK -> orgs ON DELETE CASCADE, is reachable via the REAL TenantDb
 *               chokepoint, enforces the tenant predicate, and the cascade removes rows on org
 *               delete. META: the asserted-table list is NON-EMPTY (guard against a vacuous gate).
 *   deny      — an UNREGISTERED runtime table throws through forTenant (deny-by-default).
 *   drift     — detectDrift on the freshly-migrated schema returns NO drift; a REAL introduced
 *               drift (drop a column, weaken a cascade) IS reported.
 *
 * The runtime tables (build-product-tables) are pinned to the generated SQL column-for-column by a
 * meta-assertion, so the tenancy proof on the twin holds for the committed generated source.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSpec, type StoreSpec } from '@rayspec/spec';
import { getTableColumns } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../client.js';
import { MIGRATION_ALLOWLIST } from '../migration-scan.allowlist.js';
import { scanMigrationSql } from '../migration-scan.js';
import { forTenant } from '../tenant-db.js';
import { makeDbWithSchema } from '../testing.js';
import { buildProductTables } from './build-product-tables.js';
import { detectDrift } from './drift-detect.js';
import { generateProductSql } from './generate-product-sql.js';
import { assertProductTenancy, type QueryFn } from './product-tenancy-gate.js';

const here = dirname(fileURLToPath(import.meta.url));
// packages/db/src/generated -> repo-root/examples/acme-notes-backend
const THROWAWAY = resolve(here, '../../../../../examples/acme-notes-backend');
const YAML_PATH = resolve(THROWAWAY, 'rayspec.yaml');
const COMMITTED_SQL = resolve(THROWAWAY, 'drizzle/0000_product_stores.sql');

const SCHEMA = 'rayspec_test_product_pipeline';
const TENANT_A = '00000000-0000-0000-0000-0000000000a1';
const TENANT_B = '00000000-0000-0000-0000-0000000000b1';

let db: Db;
let stores: StoreSpec[];
let query: QueryFn;

/**
 * Apply the generated SQL to an ISOLATED test SCHEMA: strip drizzle statement-breakpoints (like
 * shadow-dryrun) and rewrite the `"public".` FK qualifier to the test schema (the committed artifact
 * uses drizzle's `"public"."orgs"` convention — correct for a real deployment on `public`; the test
 * runs in an isolated schema so the explicit qualifier is retargeted).
 */
function forSchema(sql: string, schema: string): string {
  return sql.replace(/-->\s*statement-breakpoint/g, '').replace(/"public"\./g, `"${schema}".`);
}

/** The orgs root the injected tenant_id FK references (minimal — the gate needs id only). */
const ORGS_DDL = `CREATE TABLE orgs (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL DEFAULT 'x',
  created_at timestamptz NOT NULL DEFAULT now()
);`;

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required for the product pipeline test');

  const parsed = parseSpec(readFileSync(YAML_PATH, 'utf8'));
  if (!parsed.ok) throw new Error(`throwaway spec invalid: ${JSON.stringify(parsed.errors)}`);
  stores = parsed.value.stores;

  db = makeDbWithSchema(url, SCHEMA);
  query = (sql, params) =>
    db.$client.unsafe(sql, params as never[]) as unknown as Promise<Record<string, unknown>[]>;

  // Fresh isolated schema: orgs root + the generated product SQL applied.
  await db.$client.unsafe(`
    DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;
    CREATE SCHEMA ${SCHEMA};
    SET search_path TO ${SCHEMA};
    ${ORGS_DDL}
  `);
  // Seed the two tenant orgs.
  await db.$client.unsafe(`INSERT INTO ${SCHEMA}.orgs (id, name) VALUES ($1,'A'), ($2,'B')`, [
    TENANT_A,
    TENANT_B,
  ]);
  // MIGRATE: apply the generated SQL (statement-breakpoints stripped, FK qualifier retargeted).
  await db.$client.unsafe(
    `SET search_path TO ${SCHEMA}; ${forSchema(generateProductSql(stores), SCHEMA)}`,
  );
});

afterAll(async () => {
  await db.$client.end();
});

describe('validate', () => {
  it('the throwaway spec parses ok and declares the expected stores', () => {
    expect(stores.map((s) => s.name)).toEqual(['notebooks', 'entries']);
  });
});

describe('diff — the committed generated artifact is not stale', () => {
  it('examples/.../drizzle/0000_product_stores.sql equals generateProductSql(stores) now', () => {
    const committed = readFileSync(COMMITTED_SQL, 'utf8');
    // The CLI writes the SQL with a trailing newline; match that.
    expect(committed).toBe(`${generateProductSql(stores)}\n`);
  });

  it('examples/.../generated/product-schema.ts is the committed generated module', () => {
    const committed = readFileSync(resolve(THROWAWAY, 'generated/product-schema.ts'), 'utf8');
    // It imports orgs + declares both tables + the populated tuple.
    expect(committed).toContain("import { orgs } from '../schema.js';");
    expect(committed).toContain("export const notebooks = pgTable('notebooks', {");
    expect(committed).toContain("export const entries = pgTable('entries', {");
    expect(committed).toContain(
      'export const PRODUCT_TENANT_SCOPED_TABLES = [notebooks, entries] as const;',
    );
  });
});

describe('lint/gate — destructive scan', () => {
  it('the generated SQL has NO destructive findings (purely additive)', () => {
    const allow = MIGRATION_ALLOWLIST['0000_product_stores.sql'] ?? [];
    const result = scanMigrationSql(generateProductSql(stores), allow);
    expect(result.pass).toBe(true);
    // Specifically: zero findings (not "findings that happen to be allowlisted").
    expect(result.findings).toEqual([]);
  });

  it('a DESTRUCTIVE product migration (DROP COLUMN) is BLOCKED until an allowlist entry clears it', () => {
    // The breaking-change mechanism: a later product migration that drops a column is destructive.
    const destructive = 'ALTER TABLE "notebooks" DROP COLUMN "subtitle";';
    // Unreviewed -> BLOCKED.
    const blocked = scanMigrationSql(destructive, []);
    expect(blocked.pass).toBe(false);
    expect(blocked.findings.some((f) => f.kind === 'drop-column' && !f.allowed)).toBe(true);
    // With a reviewed full-statement-equality allowlist entry -> cleared.
    const cleared = scanMigrationSql(destructive, [
      { kind: 'drop-column', match: destructive, reason: 'reviewed: drop unused subtitle column' },
    ]);
    expect(cleared.pass).toBe(true);
  });

  it('the drizzle DROP+ADD RENAME trap is caught (both halves flagged) until reviewed', () => {
    // drizzle-kit emits a rename as DROP COLUMN old + ADD COLUMN new (data loss). The scan flags the
    // DROP half so a human must rewrite to RENAME + add a reviewed allowlist entry.
    const renameTrap =
      'ALTER TABLE "notebooks" DROP COLUMN "title";\n' +
      'ALTER TABLE "notebooks" ADD COLUMN "subject" text;';
    const result = scanMigrationSql(renameTrap, []);
    expect(result.pass).toBe(false);
    expect(result.findings.some((f) => f.kind === 'drop-column')).toBe(true);
  });
});

describe('migrate + tenancy (the cross-tenant gate over the THROWAWAY, NON-VACUOUS)', () => {
  it('every product table is FK+cascade, reachable via TenantDb, predicate-enforced, cascades', async () => {
    const tables = buildProductTables(stores);
    const result = await assertProductTenancy({
      db,
      schemaName: SCHEMA,
      tables,
      query,
      tenantA: TENANT_A,
      tenantB: TENANT_B,
      // Seed one row per table; notebooks is a parent, entries carries notebook_id FK.
      seedRow: (name, ctx) => {
        if (name === 'notebooks') {
          return { title: 'Standup', scheduledAt: new Date(), completed: false };
        }
        if (name === 'entries') {
          return { notebookId: ctx.parentId, body: 'hello world' };
        }
        throw new Error(`no seed for ${name}`);
      },
      parentOf: (name) => (name === 'entries' ? 'notebooks' : undefined),
    });
    // META: the gate asserted EVERY product table — NON-EMPTY, not a vacuous pass.
    expect(result.asserted).toEqual(['notebooks', 'entries']);
    expect(result.asserted.length).toBe(stores.length);
  });
});

describe('twin pin — runtime tables match the generated SQL AND the live DB (three-way, TEN-2)', () => {
  it('getTableColumns(twin) == live DB columns == spec (name, type, nullability)', async () => {
    const tables = buildProductTables(stores);
    for (const [name, table] of tables) {
      const store = stores.find((s) => s.name === name);
      if (!store) throw new Error(`no store ${name}`);

      // (A) The RUNTIME TWIN's columns, read straight off the drizzle table via getTableColumns —
      // this is the real read the original vacuous pin skipped.
      const twinCols = getTableColumns(table);
      const twin = new Map<string, { sqlType: string; notNull: boolean }>();
      for (const col of Object.values(twinCols)) {
        const c = col as unknown as { name: string; getSQLType(): string; notNull: boolean };
        twin.set(c.name, { sqlType: c.getSQLType().toLowerCase(), notNull: c.notNull });
      }

      // (B) The LIVE DB columns (from the applied generated SQL).
      const liveRows = (await query(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2`,
        [SCHEMA, name],
      )) as { column_name: string; data_type: string; is_nullable: string }[];
      const live = new Map<string, { dataType: string; notNull: boolean }>();
      for (const r of liveRows) {
        live.set(r.column_name, { dataType: r.data_type, notNull: r.is_nullable === 'NO' });
      }

      // (C) The SPEC's expected column set (business + injected).
      const expectedNames = new Set<string>([
        'id',
        'tenant_id',
        ...store.columns.map((c) => c.name),
        'created_at',
        'deleted_at',
        'retention_days',
        'region',
        'created_by',
        'idempotency_key',
      ]);

      // Three-way name agreement.
      expect(new Set(twin.keys())).toEqual(expectedNames);
      expect(new Set(live.keys())).toEqual(expectedNames);

      // Per-business-column: twin notNull == spec, twin notNull == live notNull, twin type == live.
      // Map drizzle's getSQLType() to the information_schema data_type for comparison.
      const sqlTypeToDataType: Record<string, string> = {
        text: 'text',
        uuid: 'uuid',
        integer: 'integer',
        boolean: 'boolean',
        jsonb: 'jsonb',
        'timestamp with time zone': 'timestamp with time zone',
      };
      for (const col of store.columns) {
        const t = twin.get(col.name);
        const l = live.get(col.name);
        if (!t || !l) throw new Error(`twin/live missing column ${name}.${col.name}`);
        // nullability: spec == twin == live.
        expect(t.notNull).toBe(!col.nullable);
        expect(l.notNull).toBe(!col.nullable);
        // type: twin's SQL type maps to live's data_type.
        expect(sqlTypeToDataType[t.sqlType] ?? t.sqlType).toBe(l.dataType);
      }
    }
  });

  it('the twin emits FK columns with the author onDelete (cascade/restrict/set null) — via live DB', async () => {
    // The twin's FK onDelete is exercised through the live DB it was applied against (the generated
    // SQL carries the policy). The throwaway's entries.notebook_id is ON DELETE CASCADE.
    const fk = (await query(
      `SELECT rc.delete_rule FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
         JOIN information_schema.referential_constraints rc
           ON tc.constraint_name = rc.constraint_name AND tc.table_schema = rc.constraint_schema
        WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1
          AND tc.table_name = 'entries' AND kcu.column_name = 'notebook_id'`,
      [SCHEMA],
    )) as { delete_rule: string }[];
    expect(fk[0]?.delete_rule).toBe('CASCADE');
  });
});

describe('deny-by-default', () => {
  it('an UNREGISTERED runtime product table throws through forTenant', () => {
    // Build a table NOT registered (we do not wrap in withScopedTables here), so the real
    // deny-by-default Set rejects it.
    const tables = buildProductTables(stores);
    const notebooks = tables.get('notebooks');
    if (!notebooks) throw new Error('notebooks table missing');
    // forTenant().select on an unregistered table throws (the platform baseline is product-empty).
    expect(() => forTenant(db, TENANT_A).select(notebooks as never)).toThrow(
      /not registered in TENANT_SCOPED_TABLES/,
    );
  });
});

describe('drift-detect (report-only)', () => {
  const driftQuery: QueryFn = (s, p) =>
    db.$client.unsafe(s, p as never[]) as unknown as Promise<Record<string, unknown>[]>;

  /** Build a fresh isolated schema with the orgs root + the generated product migration applied. */
  async function setupDriftSchema(suffix: string): Promise<string> {
    const ds = `${SCHEMA}_${suffix}`;
    await db.$client.unsafe(`
      DROP SCHEMA IF EXISTS ${ds} CASCADE;
      CREATE SCHEMA ${ds};
      SET search_path TO ${ds};
      ${ORGS_DDL}
    `);
    await db.$client.unsafe(
      `SET search_path TO ${ds}; ${forSchema(generateProductSql(stores), ds)}`,
    );
    return ds;
  }

  it('reports NO drift on the freshly-migrated schema', async () => {
    const findings = await detectDrift(stores, SCHEMA, query);
    expect(findings).toEqual([]);
  });

  // A fail-the-fix introduced-drift case for EACH drift kind (report-only, cheap).
  it('REPORTS missing_table (the whole table dropped)', async () => {
    const ds = await setupDriftSchema('drift_table');
    await db.$client.unsafe(`DROP TABLE ${ds}.entries;`);
    const f = await detectDrift(stores, ds, driftQuery);
    expect(f.some((x) => x.table === 'entries' && x.kind === 'missing_table')).toBe(true);
    await db.$client.unsafe(`DROP SCHEMA IF EXISTS ${ds} CASCADE;`);
  });

  it('REPORTS missing_column (a dropped business column)', async () => {
    const ds = await setupDriftSchema('drift_col');
    await db.$client.unsafe(`ALTER TABLE ${ds}.entries DROP COLUMN body;`);
    const f = await detectDrift(stores, ds, driftQuery);
    expect(f.find((x) => x.table === 'entries' && x.column === 'body')?.kind).toBe(
      'missing_column',
    );
    await db.$client.unsafe(`DROP SCHEMA IF EXISTS ${ds} CASCADE;`);
  });

  it('REPORTS column_type (a column whose type changed)', async () => {
    const ds = await setupDriftSchema('drift_type');
    // notebooks.title text -> integer (use USING so the ALTER applies on the empty table).
    await db.$client.unsafe(`ALTER TABLE ${ds}.notebooks ALTER COLUMN title TYPE integer USING 0;`);
    const f = await detectDrift(stores, ds, driftQuery);
    expect(f.find((x) => x.table === 'notebooks' && x.column === 'title')?.kind).toBe(
      'column_type',
    );
    await db.$client.unsafe(`DROP SCHEMA IF EXISTS ${ds} CASCADE;`);
  });

  it('REPORTS column_nullability (a NOT NULL column relaxed to nullable)', async () => {
    const ds = await setupDriftSchema('drift_null');
    await db.$client.unsafe(`ALTER TABLE ${ds}.notebooks ALTER COLUMN title DROP NOT NULL;`);
    const f = await detectDrift(stores, ds, driftQuery);
    expect(f.find((x) => x.table === 'notebooks' && x.column === 'title')?.kind).toBe(
      'column_nullability',
    );
    await db.$client.unsafe(`DROP SCHEMA IF EXISTS ${ds} CASCADE;`);
  });

  it('REPORTS tenant_fk_not_cascade (a weakened tenant cascade)', async () => {
    const ds = await setupDriftSchema('drift_tenfk');
    await db.$client.unsafe(`
      ALTER TABLE ${ds}.notebooks DROP CONSTRAINT notebooks_tenant_id_orgs_id_fk;
      ALTER TABLE ${ds}.notebooks ADD CONSTRAINT notebooks_tenant_id_orgs_id_fk
        FOREIGN KEY (tenant_id) REFERENCES ${ds}.orgs(id);
    `);
    const f = await detectDrift(stores, ds, driftQuery);
    expect(f.some((x) => x.table === 'notebooks' && x.kind === 'tenant_fk_not_cascade')).toBe(true);
    await db.$client.unsafe(`DROP SCHEMA IF EXISTS ${ds} CASCADE;`);
  });

  it('REPORTS missing_tenant_fk (the tenant FK dropped entirely)', async () => {
    const ds = await setupDriftSchema('drift_notenfk');
    await db.$client.unsafe(
      `ALTER TABLE ${ds}.notebooks DROP CONSTRAINT notebooks_tenant_id_orgs_id_fk;`,
    );
    const f = await detectDrift(stores, ds, driftQuery);
    expect(f.some((x) => x.table === 'notebooks' && x.kind === 'missing_tenant_fk')).toBe(true);
    await db.$client.unsafe(`DROP SCHEMA IF EXISTS ${ds} CASCADE;`);
  });

  it('REPORTS missing_product_fk (a product FK dropped)', async () => {
    const ds = await setupDriftSchema('drift_prodfk');
    await db.$client.unsafe(
      `ALTER TABLE ${ds}.entries DROP CONSTRAINT entries_notebook_id_notebooks_id_fk;`,
    );
    const f = await detectDrift(stores, ds, driftQuery);
    expect(f.some((x) => x.table === 'entries' && x.kind === 'missing_product_fk')).toBe(true);
    await db.$client.unsafe(`DROP SCHEMA IF EXISTS ${ds} CASCADE;`);
  });

  it('REPORTS product_fk_policy (a product FK onDelete changed)', async () => {
    const ds = await setupDriftSchema('drift_prodpol');
    await db.$client.unsafe(`
      ALTER TABLE ${ds}.entries DROP CONSTRAINT entries_notebook_id_notebooks_id_fk;
      ALTER TABLE ${ds}.entries ADD CONSTRAINT entries_notebook_id_notebooks_id_fk
        FOREIGN KEY (notebook_id) REFERENCES ${ds}.notebooks(id) ON DELETE RESTRICT;
    `);
    const f = await detectDrift(stores, ds, driftQuery);
    expect(f.some((x) => x.table === 'entries' && x.kind === 'product_fk_policy')).toBe(true);
    await db.$client.unsafe(`DROP SCHEMA IF EXISTS ${ds} CASCADE;`);
  });

  it('REPORTS missing_unique (GEN-2 — a dropped UNIQUE on a unique:true column)', async () => {
    // The throwaway has no unique column, so add a store WITH one for this case (code-built stores).
    const uniqStores = [
      ...stores,
      {
        name: 'tags',
        columns: [{ name: 'slug', type: 'text' as const, nullable: false, unique: true }],
        foreignKeys: [],
      },
    ];
    const ds = `${SCHEMA}_drift_uniq`;
    await db.$client.unsafe(`
      DROP SCHEMA IF EXISTS ${ds} CASCADE;
      CREATE SCHEMA ${ds};
      SET search_path TO ${ds};
      ${ORGS_DDL}
    `);
    await db.$client.unsafe(
      `SET search_path TO ${ds}; ${forSchema(generateProductSql(uniqStores), ds)}`,
    );
    // No drift initially.
    expect(
      (await detectDrift(uniqStores, ds, driftQuery)).some((x) => x.kind === 'missing_unique'),
    ).toBe(false);
    // Drop the unique index -> drift reported.
    await db.$client.unsafe(`DROP INDEX ${ds}.tags_slug_unique;`);
    const f = await detectDrift(uniqStores, ds, driftQuery);
    expect(
      f.some((x) => x.table === 'tags' && x.column === 'slug' && x.kind === 'missing_unique'),
    ).toBe(true);
    await db.$client.unsafe(`DROP SCHEMA IF EXISTS ${ds} CASCADE;`);
  });

  it('FLAGS stale_global_unique for a NON-key author-unique on a legacy single-column GLOBAL index (lenient default accepts it — no forced migration)', async () => {
    const uniqStores = [
      ...stores,
      {
        name: 'labels',
        columns: [{ name: 'code', type: 'text' as const, nullable: false, unique: true }],
        foreignKeys: [],
      },
    ];
    const ds = `${SCHEMA}_drift_stale`;
    await db.$client.unsafe(`
      DROP SCHEMA IF EXISTS ${ds} CASCADE;
      CREATE SCHEMA ${ds};
      SET search_path TO ${ds};
      ${ORGS_DDL}
    `);
    // Materialize with the SECURE DEFAULT (no conflict keys) → `code`'s index is compound (tenant_id, code).
    await db.$client.unsafe(
      `SET search_path TO ${ds}; ${forSchema(generateProductSql(uniqStores), ds)}`,
    );
    // `code` is NOT a conflict key (labels has an entry, but `code` ∉ it) → the STRICT check expects the
    // tenant-scoped compound index.
    const authorUnique = new Map<string, ReadonlySet<string>>([['labels', new Set<string>()]]);

    // With the compound index present: the strict (conflictKeys) check reports NO drift for labels.
    expect(
      (await detectDrift(uniqStores, ds, driftQuery, authorUnique)).some(
        (x) => x.table === 'labels',
      ),
    ).toBe(false);

    // Simulate a LEGACY v1.0/v1.1 deployment: replace the compound index with a stale single-column GLOBAL one.
    await db.$client.unsafe(
      `DROP INDEX ${ds}.labels_code_unique;
       CREATE UNIQUE INDEX labels_code_unique ON ${ds}.labels USING btree (code);`,
    );

    // STRICT (conflictKeys passed): the stale global is FLAGGED so an operator knows to migrate.
    const strict = await detectDrift(uniqStores, ds, driftQuery, authorUnique);
    expect(
      strict.some(
        (x) => x.table === 'labels' && x.column === 'code' && x.kind === 'stale_global_unique',
      ),
    ).toBe(true);

    // LENIENT (no conflictKeys — the frozen deploy.ts + boot classify paths): a covering unique index
    // exists → NO drift, so a working legacy deployment is NEVER refused (no forced migration).
    expect((await detectDrift(uniqStores, ds, driftQuery)).some((x) => x.table === 'labels')).toBe(
      false,
    );

    await db.$client.unsafe(`DROP SCHEMA IF EXISTS ${ds} CASCADE;`);
  });
});

describe('P3S1-05 — all three FK onDelete policies apply + the live delete_rule matches', () => {
  it('cascade / restrict / set null each land with the right live delete_rule', async () => {
    // A code-built stores set exercising all three policies against a DB (the throwaway only has
    // cascade). set null requires a nullable FK column.
    const policyStores = [
      {
        name: 'parents',
        columns: [{ name: 'label', type: 'text' as const, nullable: false, unique: false }],
        foreignKeys: [],
      },
      {
        name: 'casc',
        columns: [{ name: 'parent_id', type: 'uuid' as const, nullable: false, unique: false }],
        foreignKeys: [{ column: 'parent_id', references: 'parents', onDelete: 'cascade' as const }],
      },
      {
        name: 'restr',
        columns: [{ name: 'parent_id', type: 'uuid' as const, nullable: false, unique: false }],
        foreignKeys: [
          { column: 'parent_id', references: 'parents', onDelete: 'restrict' as const },
        ],
      },
      {
        name: 'setn',
        columns: [{ name: 'parent_id', type: 'uuid' as const, nullable: true, unique: false }],
        foreignKeys: [
          { column: 'parent_id', references: 'parents', onDelete: 'set null' as const },
        ],
      },
    ];
    const ds = `${SCHEMA}_policies`;
    await db.$client.unsafe(`
      DROP SCHEMA IF EXISTS ${ds} CASCADE; CREATE SCHEMA ${ds};
      SET search_path TO ${ds}; ${ORGS_DDL}
    `);
    await db.$client.unsafe(
      `SET search_path TO ${ds}; ${forSchema(generateProductSql(policyStores), ds)}`,
    );
    const rule = async (table: string) => {
      const rows = (await db.$client.unsafe(
        `SELECT rc.delete_rule FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
           JOIN information_schema.referential_constraints rc
             ON tc.constraint_name = rc.constraint_name AND tc.constraint_schema = rc.constraint_schema
          WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_schema=$1 AND tc.table_name=$2
            AND kcu.column_name='parent_id'`,
        [ds, table],
      )) as unknown as { delete_rule: string }[];
      return rows[0]?.delete_rule;
    };
    expect(await rule('casc')).toBe('CASCADE');
    expect(await rule('restr')).toBe('RESTRICT');
    expect(await rule('setn')).toBe('SET NULL');
    await db.$client.unsafe(`DROP SCHEMA IF EXISTS ${ds} CASCADE;`);
  });
});
