/**
 * Product-schema DRIFT DETECTION — report-only.
 *
 * Introspects the LIVE database (`information_schema.columns` + `pg_constraint`) and compares it
 * against the LOAD-BEARING facts a validated `stores[]` spec implies. Reports drift; NEVER
 * auto-heals (auto-healing would re-introduce the blind-autogenerate risk we forbid —
 * reconciliation goes back through the full migration gate as a reviewed PR).
 *
 * SCOPE IS TIGHT (avoid false drift from defaults / type-normalization / index-ordering). It checks
 * ONLY:
 *   - every spec table EXISTS;
 *   - every spec business column exists with the expected Postgres base type (normalized) +
 *     nullability;
 *   - the INJECTED tenancy/GDPR columns (id/tenant_id/created_at/deleted_at/retention_days/region)
 *     exist with the expected type/nullability;
 *   - the tenant_id FK -> orgs(id) ON DELETE CASCADE exists (the tenant predicate + GDPR cascade);
 *   - each declared product->product FK exists with the expected ON DELETE policy.
 * It does NOT compare DEFAULT expressions, index existence/order, comments, or column ORDINAL
 * position — those are not load-bearing and normalize unreliably across PG versions.
 *
 * The caller passes a `query(sql, params) => rows` thunk (the live db handle) so this stays a pure,
 * testable function with no client coupling. `schemaName` scopes the introspection to one Postgres
 * schema (tests use an isolated schema; a deployment uses `public`).
 */
import type { ColumnType, StoreSpec } from '@rayspec/spec';
import { INJECTED_COLUMNS as INJECTED_DESCRIPTOR } from './injected-columns.js';

/** A single drift finding (report-only). `expected`/`actual` are human-readable. */
export interface DriftFinding {
  table: string;
  /** The aspect that drifted. */
  kind:
    | 'missing_table'
    | 'missing_column'
    | 'column_type'
    | 'column_nullability'
    | 'missing_unique'
    | 'missing_tenant_fk'
    | 'tenant_fk_not_cascade'
    | 'missing_product_fk'
    | 'product_fk_policy';
  column?: string;
  expected: string;
  actual: string;
}

/** The introspection rows we read (a minimal shape; the query supplies these columns). */
interface ColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string; // 'YES' | 'NO'
}
interface FkRow {
  table_name: string;
  column_name: string;
  foreign_table_name: string;
  delete_rule: string; // 'CASCADE' | 'RESTRICT' | 'SET NULL' | 'NO ACTION'
}

/** A live-DB query thunk: run parameterized SQL, return rows. */
export type QueryFn = (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>;

/** Map the closed ColumnType -> the normalized information_schema.data_type. */
const EXPECTED_DATA_TYPE: Record<ColumnType, string> = {
  text: 'text',
  uuid: 'uuid',
  timestamp: 'timestamp with time zone',
  integer: 'integer',
  boolean: 'boolean',
  jsonb: 'jsonb',
};

/**
 * The injected tenancy/GDPR columns + their expected (data_type, nullable), DERIVED from the single
 * shared INJECTED_COLUMNS descriptor (fix P3S1-02) so a descriptor change propagates to drift too.
 */
const INJECTED_COLUMNS: { name: string; dataType: string; nullable: boolean }[] =
  INJECTED_DESCRIPTOR.map((c) => ({
    name: c.sqlName,
    dataType: EXPECTED_DATA_TYPE[c.type],
    nullable: c.nullable,
  }));

/** ON DELETE policy as the spec declares it -> information_schema.delete_rule. */
const POLICY_TO_RULE: Record<string, string> = {
  cascade: 'CASCADE',
  restrict: 'RESTRICT',
  'set null': 'SET NULL',
};

/**
 * Detect drift between the live DB (introspected via `query` in `schemaName`) and the spec-implied
 * load-bearing facts for `stores`. Returns the FULL finding list (report-only; empty = no drift).
 */
export async function detectDrift(
  stores: StoreSpec[],
  schemaName: string,
  query: QueryFn,
): Promise<DriftFinding[]> {
  const findings: DriftFinding[] = [];
  const tableNames = stores.map((s) => s.name);
  if (tableNames.length === 0) return findings;

  // --- columns ------------------------------------------------------------------------------
  const colRows = (await query(
    `SELECT table_name, column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = ANY($2)`,
    [schemaName, tableNames],
  )) as unknown as ColumnRow[];
  const colByTable = new Map<string, Map<string, ColumnRow>>();
  for (const r of colRows) {
    if (!colByTable.has(r.table_name)) colByTable.set(r.table_name, new Map());
    colByTable.get(r.table_name)?.set(r.column_name, r);
  }

  // --- foreign keys -------------------------------------------------------------------------
  const fkRows = (await query(
    `SELECT tc.table_name, kcu.column_name, ccu.table_name AS foreign_table_name, rc.delete_rule
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
       JOIN information_schema.referential_constraints rc
         ON tc.constraint_name = rc.constraint_name AND tc.table_schema = rc.constraint_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1 AND tc.table_name = ANY($2)`,
    [schemaName, tableNames],
  )) as unknown as FkRow[];

  // --- single-column UNIQUE indexes (GEN-2) -------------------------------------------------
  // A dropped author `unique:true` is otherwise invisible drift. Read pg_index for single-column
  // UNIQUE indexes (the generator emits a 1-col unique index per `unique` column). We key by
  // (table, column) so a missing unique on a still-present column is reported.
  const uniqueRows = (await query(
    `SELECT t.relname AS table_name, a.attname AS column_name
       FROM pg_index ix
       JOIN pg_class t ON t.oid = ix.indrelid
       JOIN pg_namespace ns ON ns.oid = t.relnamespace
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
      WHERE ix.indisunique = true
        AND ns.nspname = $1 AND t.relname = ANY($2)
        AND array_length(ix.indkey, 1) = 1`,
    [schemaName, tableNames],
  )) as unknown as { table_name: string; column_name: string }[];
  const uniqueByTable = new Map<string, Set<string>>();
  for (const r of uniqueRows) {
    if (!uniqueByTable.has(r.table_name)) uniqueByTable.set(r.table_name, new Set());
    uniqueByTable.get(r.table_name)?.add(r.column_name);
  }

  for (const store of stores) {
    const cols = colByTable.get(store.name);
    if (!cols || cols.size === 0) {
      findings.push({
        table: store.name,
        kind: 'missing_table',
        expected: 'table present',
        actual: 'table absent',
      });
      continue;
    }

    // Business columns.
    for (const col of store.columns) {
      const live = cols.get(col.name);
      if (!live) {
        findings.push({
          table: store.name,
          kind: 'missing_column',
          column: col.name,
          expected: `column ${col.name} present`,
          actual: 'absent',
        });
        continue;
      }
      const expectedType = EXPECTED_DATA_TYPE[col.type];
      if (live.data_type !== expectedType) {
        findings.push({
          table: store.name,
          kind: 'column_type',
          column: col.name,
          expected: expectedType,
          actual: live.data_type,
        });
      }
      const expectedNullable = col.nullable;
      const liveNullable = live.is_nullable === 'YES';
      if (expectedNullable !== liveNullable) {
        findings.push({
          table: store.name,
          kind: 'column_nullability',
          column: col.name,
          expected: expectedNullable ? 'nullable' : 'not null',
          actual: liveNullable ? 'nullable' : 'not null',
        });
      }
      // (GEN-2) A declared `unique:true` column must have a live single-column UNIQUE index.
      if (col.unique && !(uniqueByTable.get(store.name)?.has(col.name) ?? false)) {
        findings.push({
          table: store.name,
          kind: 'missing_unique',
          column: col.name,
          expected: 'UNIQUE index present',
          actual: 'no unique index',
        });
      }
    }

    // Injected tenancy/GDPR columns.
    for (const inj of INJECTED_COLUMNS) {
      const live = cols.get(inj.name);
      if (!live) {
        findings.push({
          table: store.name,
          kind: 'missing_column',
          column: inj.name,
          expected: `injected ${inj.name} present`,
          actual: 'absent',
        });
        continue;
      }
      if (live.data_type !== inj.dataType) {
        findings.push({
          table: store.name,
          kind: 'column_type',
          column: inj.name,
          expected: inj.dataType,
          actual: live.data_type,
        });
      }
      const liveNullable = live.is_nullable === 'YES';
      if (inj.nullable !== liveNullable) {
        findings.push({
          table: store.name,
          kind: 'column_nullability',
          column: inj.name,
          expected: inj.nullable ? 'nullable' : 'not null',
          actual: liveNullable ? 'nullable' : 'not null',
        });
      }
    }

    // The injected tenant_id FK -> orgs ON DELETE CASCADE.
    const tenantFk = fkRows.find(
      (f) => f.table_name === store.name && f.column_name === 'tenant_id',
    );
    if (tenantFk?.foreign_table_name !== 'orgs') {
      findings.push({
        table: store.name,
        kind: 'missing_tenant_fk',
        column: 'tenant_id',
        expected: 'FK tenant_id -> orgs',
        actual: tenantFk ? `FK -> ${tenantFk.foreign_table_name}` : 'no FK',
      });
    } else if (tenantFk.delete_rule !== 'CASCADE') {
      findings.push({
        table: store.name,
        kind: 'tenant_fk_not_cascade',
        column: 'tenant_id',
        expected: 'ON DELETE CASCADE',
        actual: `ON DELETE ${tenantFk.delete_rule}`,
      });
    }

    // Declared product->product FKs + their ON DELETE policy.
    for (const fk of store.foreignKeys) {
      const live = fkRows.find(
        (f) =>
          f.table_name === store.name &&
          f.column_name === fk.column &&
          f.foreign_table_name === fk.references,
      );
      if (!live) {
        findings.push({
          table: store.name,
          kind: 'missing_product_fk',
          column: fk.column,
          expected: `FK ${fk.column} -> ${fk.references}`,
          actual: 'absent',
        });
        continue;
      }
      const expectedRule = POLICY_TO_RULE[fk.onDelete];
      if (live.delete_rule !== expectedRule) {
        findings.push({
          table: store.name,
          kind: 'product_fk_policy',
          column: fk.column,
          expected: `ON DELETE ${expectedRule}`,
          actual: `ON DELETE ${live.delete_rule}`,
        });
      }
    }
  }

  return findings;
}

/**
 * The classification of the LIVE product schema vs the spec, used by the composition-root boot path to
 * decide between MATERIALIZE (first roll-out) and MOUNT (reboot — data survives). PURE (stores +
 * findings → state), so it is exhaustively unit-testable with hand-built finding arrays.
 *   - `absent`           — NOTHING is materialized: the FIRST roll-out. `deploy()` materializes.
 *   - `present-matching` — the live schema matches the spec's load-bearing facts (no drift): MOUNT,
 *                          NO product DDL is run (so existing data — recordings/transcripts — survives).
 *   - `drifted`          — the live schema is PARTIALLY materialized or has diverged from the spec
 *                          (some tables present, some absent; or a column/type/FK/unique difference):
 *                          FAIL CLOSED. mount-without-deploy refuses to boot against a drifted schema;
 *                          reconcile via an explicit reviewed FORWARD migration / re-deploy.
 */
export type ProductSchemaState = 'absent' | 'present-matching' | 'drifted';

/**
 * Classify the live product schema from the spec stores + the `detectDrift` findings (PURE — no DB).
 *
 * Decision (mount-without-deploy):
 *   - no stores                                 → 'present-matching' (nothing to materialize)
 *   - no findings                               → 'present-matching' (the live schema matches; MOUNT)
 *   - EVERY finding is `missing_table` AND the
 *     distinct missing tables === stores.length → 'absent' (CLEAN DB: every store table is missing →
 *                                                  the FIRST roll-out; deploy() materializes them all)
 *   - anything else (mixed: some tables present
 *     and some absent; OR any column/type/FK/
 *     unique drift)                             → 'drifted' (FAIL CLOSED — needs explicit migration)
 *
 * The distinct-table check is what separates 'absent' (a truly clean DB — all N stores missing) from a
 * PARTIAL/drifted DB (e.g. one of two store tables missing → only one `missing_table` finding → the
 * Set size is 1 ≠ stores.length → 'drifted'). A 'drifted' classification is the fail-closed signal: the
 * boot path NEVER auto-materializes or drops on a non-clean DB. Because mount performs ZERO product
 * DDL, an UNCHECKED-aspect difference (detectDrift's tight scope: it does not compare DEFAULT exprs,
 * secondary-index existence/order, or column ordinal) can never cause data loss — the worst case is the
 * app running against the live schema (e.g. a missing non-unique index = a slower query), never a drop.
 */
export function classifyProductSchema(
  stores: StoreSpec[],
  findings: DriftFinding[],
): ProductSchemaState {
  if (stores.length === 0) return 'present-matching';
  if (findings.length === 0) return 'present-matching';
  const allTablesMissing =
    findings.every((f) => f.kind === 'missing_table') &&
    new Set(findings.map((f) => f.table)).size === stores.length;
  return allTablesMissing ? 'absent' : 'drifted';
}

/** Pretty one-line-per-finding summary for CI logs (report-only). */
export function formatDrift(findings: DriftFinding[]): string {
  if (findings.length === 0) return 'drift-detect: no drift — live schema matches the spec.';
  return findings
    .map(
      (f) =>
        `  [DRIFT] ${f.table}${f.column ? `.${f.column}` : ''} (${f.kind}): ` +
        `expected ${f.expected}, got ${f.actual}`,
    )
    .join('\n');
}
