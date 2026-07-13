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

/**
 * The per-store CONFLICT-KEY carve-out. A store's conflict keys are the columns
 * that a durable `ON CONFLICT (<col>)` upsert targets (the product-profile `key` column, and the
 * capability/collection/transcript `*_ref` idiom). Such a column MUST keep a SINGLE-column `(col)`
 * unique index — a compound `(tenant_id, col)` index does not satisfy `ON CONFLICT (col)` (Postgres
 * 42P10). Every OTHER `unique: true` column (author-declared on a plain column, written via a plain
 * REST INSERT with no `ON CONFLICT`) becomes a TENANT-SCOPED compound `(tenant_id, col)` unique so two
 * tenants can hold the same value with no cross-tenant existence leak.
 *
 * Keyed by store name → the set of conflict-key column names for that store. SECURE BY DEFAULT: a
 * store with NO entry (or an omitted map) makes EVERY unique column compound (tenant-safe) — forgetting
 * to mark a durable key fails the durable upsert LOUD (42P10), never a silent global-unique leak. Only
 * a product-profile materialization passes this (see `@rayspec/product-yaml` `deriveConflictKeys`); a
 * backend-profile materialization passes nothing → all author-unique columns are tenant-scoped.
 */
export type StoreConflictKeys = ReadonlyMap<string, ReadonlySet<string>>;

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
    const fk = fkColumns.get(col.name);
    // (GEN-1) An ID-TARGET FK column references the parent's injected uuid PK (`id`), so it MUST be
    // uuid. A BUSINESS-KEY FK (`referencesColumn` set) references a NAMED parent column whose TYPE the
    // lint pass matches to this column's type — the uuid rule is relaxed for it (the compound FK
    // emitted below carries the author type verbatim, so no cross-generator divergence).
    if (fk && fk.referencesColumn === undefined && col.type !== 'uuid') {
      throw new Error(
        `generate-product-sql: FK column '${store.name}.${col.name}' must be 'uuid', got '${col.type}' (GEN-1).`,
      );
    }
  }
  for (const fk of store.foreignKeys) {
    assertSafeIdentifier(fk.column, `FK column '${store.name}.${fk.column}'`);
    assertSafeIdentifier(fk.references, `FK reference '${store.name} -> ${fk.references}'`);
    if (fk.referencesColumn !== undefined) {
      assertSafeIdentifier(
        fk.referencesColumn,
        `FK referencesColumn '${store.name} -> ${fk.references}.${fk.referencesColumn}'`,
      );
    }
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
 *
 * `conflictKeys` is this store's conflict-key column set (see {@link StoreConflictKeys}): a unique
 * column IN it → single-column `(col)` index (the durable `ON CONFLICT` target); a unique column NOT
 * in it (or an omitted set) → tenant-scoped compound `(tenant_id, col)` index (secure default).
 */
export function emitStoreSql(store: StoreSpec, conflictKeys?: ReadonlySet<string>): string[] {
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

  // UNIQUE indexes for `unique: true` columns (drizzle name `<table>_<col>_unique`, UNCHANGED so
  // drift-detect + the DROP counterpart key off the stable name). A conflict-key column keeps a
  // SINGLE-column `(col)` index (the durable `ON CONFLICT (col)` target — a compound index would
  // 42P10); every other unique column is TENANT-SCOPED compound `("tenant_id", col)` so two tenants
  // can hold the same value with no cross-tenant existence leak. Secure default (no
  // conflict-key set) = compound.
  for (const col of store.columns) {
    if (col.unique) {
      const indexColumns = conflictKeys?.has(col.name)
        ? `"${col.name}"`
        : `"tenant_id", "${col.name}"`;
      statements.push(
        `CREATE UNIQUE INDEX "${store.name}_${col.name}_unique" ON "${store.name}" ` +
          `USING btree (${indexColumns})`,
      );
    }
  }
  // INJECTED unique indexes (idempotency_key): a tenant-scoped compound `(tenant_id, col)`
  // unique index for every injected column marked `uniqueIndex:'tenant-scoped'`. DDL-only (the ORM twins
  // carry the column, not the index — like the tenant_idx below); Postgres NULLs never collide, so a row
  // without the key is unconstrained. Index NAME mirrors the business `<table>_<col>_unique` convention.
  for (const inj of INJECTED_AFTER) {
    if (inj.uniqueIndex === 'tenant-scoped') {
      statements.push(
        `CREATE UNIQUE INDEX "${store.name}_${inj.sqlName}_unique" ON "${store.name}" ` +
          `USING btree ("tenant_id", "${inj.sqlName}")`,
      );
    }
  }
  // A tenant index for the predicate read path (mirrors schema.ts `<table>_tenant_idx`).
  statements.push(
    `CREATE INDEX "${store.name}_tenant_idx" ON "${store.name}" USING btree ("tenant_id")`,
  );

  return statements;
}

/**
 * The Drizzle-style constraint name for a product->product FK. Byte-identical to the historic
 * `<table>_<col>_<parent>_id_fk` for an ID-TARGET FK (the referenced column defaults to `id`); a
 * BUSINESS-KEY FK encodes its referenced unique column: `<table>_<col>_<parent>_<refcol>_fk`. The
 * name is a total function of `(table, fk)` so the generator (ADD) and the diff (ADD + DROP) agree
 * byte-for-byte — a reviewed FK change never spuriously re-blocks at the deploy gate.
 *
 * Exported so `diffProductStores` names the DROP counterpart identically (single source of truth).
 */
export function fkConstraintName(table: string, fk: StoreForeignKey): string {
  const refCol = fk.referencesColumn ?? 'id';
  return `${table}_${fk.column}_${fk.references}_${refCol}_fk`;
}

/**
 * Emit a product->product FK ALTER statement with the author's ON DELETE policy.
 *
 * ID-TARGET FK (`referencesColumn` absent): a single-column FK onto the parent's injected uuid PK
 * (`id`) — the historic form, emitted BYTE-IDENTICALLY (so every existing golden/first-materialization
 * assertion holds).
 *
 * BUSINESS-KEY FK (`referencesColumn` set): a TENANT-SCOPED COMPOUND FK
 * `("tenant_id", <col>) REFERENCES <parent>("tenant_id", <refcol>)`. It MUST be compound because the
 * parent's business-unique index is the secure-default compound `(tenant_id, refcol)` — a single-column
 * REFERENCES onto it is Postgres 42830 (no matching unique constraint). Compounding it ALSO structurally
 * forbids a cross-tenant reference: a child row can only point at a parent row of the SAME tenant.
 *
 * Exported so the diff's ADD path (`addFkSql`) reuses this exact DDL (byte-fidelity single source).
 */
export function emitFkSql(table: string, fk: StoreForeignKey): string {
  const name = fkConstraintName(table, fk);
  if (fk.referencesColumn === undefined) {
    return (
      `ALTER TABLE "${table}" ADD CONSTRAINT "${name}" ` +
      `FOREIGN KEY ("${fk.column}") REFERENCES "public"."${fk.references}"("id") ` +
      `ON DELETE ${fk.onDelete} ON UPDATE no action`
    );
  }
  return (
    `ALTER TABLE "${table}" ADD CONSTRAINT "${name}" ` +
    `FOREIGN KEY ("tenant_id", "${fk.column}") ` +
    `REFERENCES "public"."${fk.references}"("tenant_id", "${fk.referencesColumn}") ` +
    `ON DELETE ${fk.onDelete} ON UPDATE no action`
  );
}

/**
 * (GEN-3, defense-in-depth) A BUSINESS-KEY FK emits a TENANT-SCOPED COMPOUND reference
 * `("tenant_id", <col>) REFERENCES <parent>("tenant_id", <refcol>)` (see {@link emitFkSql}) — which is
 * appliable ONLY when the parent's unique index on `<refcol>` is the compound `(tenant_id, refcol)`
 * form. A parent column that is a CONFLICT KEY carries a SINGLE-column `(refcol)` unique index instead
 * (the durable `ON CONFLICT (refcol)` target), so the compound REFERENCES has no matching unique
 * constraint → an unappliable Postgres 42830 at deploy.
 *
 * This is UNREACHABLE by a valid spec today (business-key FKs materialize ONLY on the backend profile,
 * which passes NO conflict keys → every unique column is the compound secure default; the product
 * profile strips FKs), but lint has NO conflict-key visibility. So we re-assert it HERE — the ONE
 * boundary where the full conflict-key map IS available — and THROW a clear config-time error naming
 * the FK + column rather than letting a cryptic 42830 surface at deploy (mirroring the
 * `assertSafeIdentifier` defense-in-depth posture). `conflictKeys` absent ⇒ nothing to check (every
 * unique column is compound).
 */
function assertBusinessKeyFksTargetCompoundUnique(
  stores: StoreSpec[],
  conflictKeys?: StoreConflictKeys,
): void {
  if (!conflictKeys) return;
  for (const store of stores) {
    for (const fk of store.foreignKeys) {
      // ID-target FK (referencesColumn absent) points at the parent's injected uuid PK — always safe.
      if (fk.referencesColumn === undefined) continue;
      if (conflictKeys.get(fk.references)?.has(fk.referencesColumn)) {
        throw new Error(
          `generate-product-sql: business-key FK '${store.name}.${fk.column}' -> ` +
            `'${fk.references}.${fk.referencesColumn}' references a CONFLICT-KEY column (a single-column ` +
            `unique index — the durable ON CONFLICT target). A tenant-scoped compound FK cannot ` +
            `reference it (no matching unique constraint → Postgres 42830 at deploy); a business-key FK ` +
            `must reference a tenant-scoped compound-unique column, not a conflict key (GEN-3).`,
        );
      }
    }
  }
}

/**
 * Generate the full product migration SQL for a set of declared stores (DECLARED order). Joins
 * statements with Drizzle's `--> statement-breakpoint` marker so `shadow-dryrun.sh` (which strips
 * the markers) and `drizzle-kit migrate` both apply it identically. An EMPTY `stores[]` produces an
 * empty string (the product-empty baseline adds NO platform migration).
 */
export function generateProductSql(stores: StoreSpec[], conflictKeys?: StoreConflictKeys): string {
  if (stores.length === 0) return '';
  // Defense-in-depth (GEN-3): reject an unappliable business-key FK onto a conflict-key column here,
  // where the full conflict-key map is available, rather than at deploy as a cryptic 42830.
  assertBusinessKeyFksTargetCompoundUnique(stores, conflictKeys);
  const header = [
    '-- GENERATED product migration — review before applying (read the SQL, never blind-apply).',
    '-- Produced by @rayspec/db generate-product-sql from a validated RaySpec `stores[]`.',
    '-- Purely ADDITIVE (CREATE TABLE + FK + index) — the destructive scan has no findings.',
    '-- tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE is INJECTED on every table',
    '-- (the tenant predicate + GDPR cascade); product->product FKs carry the author onDelete policy.',
    '',
  ].join('\n');

  const allStatements = stores.flatMap((s) => emitStoreSql(s, conflictKeys?.get(s.name)));
  // Drizzle terminates each statement with `;` then the breakpoint marker (the FINAL statement
  // gets a trailing `;` too); shadow-dryrun strips the markers and runs the file.
  const body = allStatements.map((s) => `${s};`).join('\n--> statement-breakpoint\n');
  return `${header}${body}`;
}
