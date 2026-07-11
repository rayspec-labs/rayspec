/**
 * The product-MIGRATION-SQL generator — product-agnostic platform MECHANISM.
 *
 * Pure / deterministic: `StoreSpec[] -> migration SQL string` (CREATE TABLE + FK constraints +
 * indexes) for the materialized product tables. Emits in Drizzle's own DDL style (double-quoted
 * idents, `--> statement-breakpoint` separators, `gen_random_uuid()` PK default) so a generated
 * migration is byte-shape-identical to a hand-authored one and feeds the EXISTING gates unchanged:
 * the destructive `migration-scan` lints it, `shadow-dryrun.sh` applies it, drift-detect introspects
 * the applied result.
 *
 * WHY a deterministic SQL generator rather than blind `drizzle-kit generate`: we forbid blind
 * autogenerate (an earlier attempt proved drizzle-kit contaminates against a stale snapshot — it re-CREATEs
 * unrelated tables when the snapshot drifts). This generator produces ONLY the product tables from
 * the validated spec, deterministically and reviewably, so the human review is "read THIS SQL", not
 * "diff a contaminated autogen". The committed SQL is the artifact; a test asserts it is not stale
 * (equals `generateProductSql(stores)` now). A `drizzle-kit generate` CROSS-CHECK of this clean SQL
 * is the deploy pipeline's job.
 *
 * Injected tenancy/GDPR columns mirror schema.ts EXACTLY (from the shared INJECTED_COLUMNS
 * descriptor). The tenant_id FK -> orgs(id) ON DELETE CASCADE is the ONLY FK-to-core; product->
 * product FKs carry the author's onDelete (an FK local column is uuid — lint-enforced, GEN-1). The
 * table is purely ADDITIVE (CREATE TABLE only) — no destructive statement, so the destructive scan
 * has no findings for a first materialization. Store/column/FK identifiers are re-asserted safe
 * (TEN-1 defense-in-depth) before any verbatim interpolation into DDL.
 */
import {
  assertSafeIdentifier,
  type ColumnType,
  type StoreColumn,
  type StoreForeignKey,
  type StoreSpec,
} from '@rayspec/spec';
import { INJECTED_AFTER, INJECTED_BEFORE } from './injected-columns.js';

/** Map the closed ColumnType vocabulary to its Postgres column type (deterministic). */
const PG_TYPE: Record<ColumnType, string> = {
  text: 'text',
  uuid: 'uuid',
  timestamp: 'timestamp with time zone',
  integer: 'integer',
  boolean: 'boolean',
  jsonb: 'jsonb',
};

/**
 * Re-assert safe identifiers + the FK-uuid rule on a store before emitting any SQL (the generator
 * may run on a code-built spec bypassing parseSpec). THROWS on a metacharacter/over-long name or a
 * non-uuid FK column — never interpolates an unsafe identifier into DDL. (TEN-1 / GEN-1)
 */
function assertStoreSafeSql(store: StoreSpec): void {
  assertSafeIdentifier(store.name, `store name '${store.name}'`);
  const fkColumns = new Map(store.foreignKeys.map((fk) => [fk.column, fk]));
  for (const col of store.columns) {
    assertSafeIdentifier(col.name, `column '${store.name}.${col.name}'`);
    if (fkColumns.has(col.name) && col.type !== 'uuid') {
      throw new Error(
        `generate-product-sql: FK column '${store.name}.${col.name}' must be 'uuid', got '${col.type}' (GEN-1).`,
      );
    }
  }
  for (const fk of store.foreignKeys) {
    assertSafeIdentifier(fk.column, `FK column '${store.name}.${fk.column}'`);
    assertSafeIdentifier(fk.references, `FK reference '${store.name} -> ${fk.references}'`);
  }
}

/** Emit ONE author business column line (matches drizzle DDL: `"name" type [NOT NULL]`). */
function emitColumnSql(col: StoreColumn): string {
  const nn = col.nullable ? '' : ' NOT NULL';
  return `\t"${col.name}" ${PG_TYPE[col.type]}${nn}`;
}

/**
 * Emit one store as the CREATE TABLE + the FK ALTER statements + indexes. Returns the list of
 * statements (each later joined by Drizzle's `--> statement-breakpoint`). Index names mirror
 * drizzle's `<table>_<col>_unique` / our own tenant index naming so drift-detect + scan see stable
 * names.
 *
 * Exported so the delta-diff core (`diffProductStores`) materializes an ADDED table with
 * the byte-identical CREATE path — same injected tenancy/GDPR columns, tenant FK, product FKs, and
 * indexes as a first materialization — instead of duplicating (and drifting from) this DDL style.
 */
export function emitStoreSql(store: StoreSpec): string[] {
  assertStoreSafeSql(store);
  const statements: string[] = [];
  const colLines: string[] = [];

  // Injected tenancy/GDPR columns BEFORE business cols (shared descriptor: id, tenant_id), then the
  // author business columns, then the injected AFTER columns — identical ORDER to the TS module +
  // schema.ts. The descriptor's `sqlDef` is the single source for these lines.
  for (const inj of INJECTED_BEFORE) colLines.push(`\t${inj.sqlDef}`);
  for (const col of store.columns) colLines.push(emitColumnSql(col));
  for (const inj of INJECTED_AFTER) colLines.push(`\t${inj.sqlDef}`);

  statements.push(`CREATE TABLE "${store.name}" (\n${colLines.join(',\n')}\n)`);

  // The injected tenant_id FK -> orgs(id) ON DELETE CASCADE (the tenant predicate + GDPR cascade).
  statements.push(
    `ALTER TABLE "${store.name}" ADD CONSTRAINT "${store.name}_tenant_id_orgs_id_fk" ` +
      `FOREIGN KEY ("tenant_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action`,
  );

  // Product->product FKs (author onDelete policy). Drizzle names them `<table>_<col>_<parent>_id_fk`.
  for (const fk of store.foreignKeys) {
    statements.push(emitFkSql(store.name, fk));
  }

  // UNIQUE indexes for author `unique: true` columns (drizzle name `<table>_<col>_unique`).
  for (const col of store.columns) {
    if (col.unique) {
      statements.push(
        `CREATE UNIQUE INDEX "${store.name}_${col.name}_unique" ON "${store.name}" ` +
          `USING btree ("${col.name}")`,
      );
    }
  }
  // A tenant index for the predicate read path (mirrors schema.ts `<table>_tenant_idx`).
  statements.push(
    `CREATE INDEX "${store.name}_tenant_idx" ON "${store.name}" USING btree ("tenant_id")`,
  );

  return statements;
}

/** Emit a product->product FK ALTER statement with the author's ON DELETE policy. */
function emitFkSql(table: string, fk: StoreForeignKey): string {
  return (
    `ALTER TABLE "${table}" ADD CONSTRAINT "${table}_${fk.column}_${fk.references}_id_fk" ` +
    `FOREIGN KEY ("${fk.column}") REFERENCES "public"."${fk.references}"("id") ` +
    `ON DELETE ${fk.onDelete} ON UPDATE no action`
  );
}

/**
 * Generate the full product migration SQL for a set of declared stores (DECLARED order). Joins
 * statements with Drizzle's `--> statement-breakpoint` marker so `shadow-dryrun.sh` (which strips
 * the markers) and `drizzle-kit migrate` both apply it identically. An EMPTY `stores[]` produces an
 * empty string (the product-empty baseline adds NO platform migration).
 */
export function generateProductSql(stores: StoreSpec[]): string {
  if (stores.length === 0) return '';
  const header = [
    '-- GENERATED product migration — review before applying (read the SQL, never blind-apply).',
    '-- Produced by @rayspec/db generate-product-sql from a validated RaySpec `stores[]`.',
    '-- Purely ADDITIVE (CREATE TABLE + FK + index) — the destructive scan has no findings.',
    '-- tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE is INJECTED on every table',
    '-- (the tenant predicate + GDPR cascade); product->product FKs carry the author onDelete policy.',
    '',
  ].join('\n');

  const allStatements = stores.flatMap(emitStoreSql);
  // Drizzle terminates each statement with `;` then the breakpoint marker (the FINAL statement
  // gets a trailing `;` too); shadow-dryrun strips the markers and runs the file.
  const body = allStatements.map((s) => `${s};`).join('\n--> statement-breakpoint\n');
  return `${header}${body}`;
}
