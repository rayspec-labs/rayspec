/**
 * The product-schema GENERATOR — product-agnostic platform MECHANISM.
 *
 * Pure / deterministic: `StoreSpec[] -> Drizzle-TS source string` for a product-schema module.
 * The platform ships ONLY this mechanism; it carries ZERO product tables. A real deployment runs
 * the generator over its own `rayspec.yaml` `stores[]` and commits the emitted source into its
 * own `packages/db/src/generated/product-schema.ts` (codegen-into-committed-source — a
 * type-enforced tuple extension, NOT a runtime append). The platform main line commits the
 * PRODUCT-EMPTY baseline (`product-schema.ts` with `PRODUCT_TENANT_SCOPED_TABLES = []`); the
 * throwaway acme-notes backend's generated module is produced as a forcing-function artifact under
 * `examples/acme-notes-backend/generated/` and exercised end-to-end in tests.
 *
 * WHAT IT INJECTS (the non-negotiable tenancy/GDPR columns — must match schema.ts EXACTLY so a
 * product table is structurally identical to a core tenant table; see packages/db/src/schema.ts
 * journalSteps/runEvents for the canonical pattern):
 *   - `id`            uuid PRIMARY KEY DEFAULT gen_random_uuid()   (defaultRandom().primaryKey())
 *   - `tenant_id`     uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE   (the tenant predicate +
 *                     GDPR cascade — this is the ONLY FK-to-core the generator emits)
 *   - `created_at`    timestamptz NOT NULL DEFAULT now()
 *   - `deleted_at`    timestamptz NULL                              (soft-delete tombstone)
 *   - `retention_days` integer NULL                                (residency/retention)
 *   - `region`        text NOT NULL DEFAULT 'eu'                    (residency)
 *
 * Authors declare BUSINESS columns only; the six above are NEVER declared (the `@rayspec/spec`
 * `reserved_column_name` lint already rejects an author trying to). The generator emits product->
 * product FKs from `foreignKeys[]` with the author's `onDelete` policy and NEVER emits or modifies
 * a core table (FK-to-core is only the injected `tenant_id`).
 *
 * TENANCY BY CONSTRUCTION: every generated table is emitted into the `PRODUCT_TENANT_SCOPED_TABLES`
 * tuple AS SOURCE, so `schema.ts` composes it into `TENANT_SCOPED_TABLES` and a product table is
 * reachable through the TenantDb chokepoint (deny-by-default) — there is no non-tenant store
 * (`@rayspec/spec` makes opt-out inexpressible).
 *
 * DETERMINISM: stores are emitted in DECLARED order; columns in DECLARED order (injected columns
 * first, in the fixed order above, then business columns); no timestamps / no nondeterministic
 * output, so the golden test is stable and a field-flip (a column type, a nullable, an FK onDelete)
 * BREAKS the golden.
 */
import {
  assertSafeIdentifier,
  type ColumnType,
  type StoreColumn,
  type StoreForeignKey,
  type StoreSpec,
} from '@rayspec/spec';
import type { StoreConflictKeys } from './generate-product-sql.js';
import {
  INJECTED_AFTER,
  INJECTED_BEFORE,
  INJECTED_COLUMN_NAMES as INJECTED_NAMES,
} from './injected-columns.js';

/**
 * The injected tenancy/GDPR column NAMES (snake_case) — re-exported from the SINGLE shared
 * descriptor (`injected-columns.ts`) so the names, the TS emit, the SQL emit, the runtime twin, and
 * drift all derive from one table. A meta-test asserts these equal `@rayspec/spec`'s
 * `RESERVED_COLUMN_NAMES`.
 */
export const INJECTED_COLUMN_NAMES = INJECTED_NAMES;

/** Map the closed ColumnType vocabulary to its Drizzle pg-core builder SYMBOL (deterministic). */
const COLUMN_TYPE_TO_SYMBOL: Record<ColumnType, string> = {
  text: 'text',
  uuid: 'uuid',
  timestamp: 'timestamp',
  integer: 'integer',
  boolean: 'boolean',
  jsonb: 'jsonb',
};

/** Map the closed ColumnType vocabulary to a Drizzle pg-core column-builder call (deterministic). */
const DRIZZLE_BUILDER: Record<ColumnType, (snake: string) => string> = {
  text: (s) => `text('${s}')`,
  uuid: (s) => `uuid('${s}')`,
  // timestamptz everywhere (mirrors schema.ts `timestamp(..., { withTimezone: true })`).
  timestamp: (s) => `timestamp('${s}', { withTimezone: true })`,
  integer: (s) => `integer('${s}')`,
  boolean: (s) => `boolean('${s}')`,
  jsonb: (s) => `jsonb('${s}')`,
};

/**
 * The pg-core builder symbols the INJECTED tenancy/GDPR columns always need: `pgTable` (the table)
 * + whatever the shared injected-column descriptor uses (uuid/timestamp/integer/text). DERIVED from
 * INJECTED_COLUMNS so a descriptor change propagates here automatically. `boolean`/
 * `jsonb` are emitted ONLY if a business column uses them — no unused import (Biome would flag).
 */
const ALWAYS_USED_SYMBOLS: readonly string[] = [
  'pgTable',
  ...[...INJECTED_BEFORE, ...INJECTED_AFTER].map((c) => COLUMN_TYPE_TO_SYMBOL[c.type]),
];

/** Does this store carry at least one TENANT-SCOPED (compound) unique — i.e. a `unique: true` column
 *  that is NOT a conflict key? Such a column is emitted as a table-level `uniqueIndex(...)`. */
function hasCompoundUnique(store: StoreSpec, conflictKeys?: StoreConflictKeys): boolean {
  const keys = conflictKeys?.get(store.name);
  return store.columns.some((c) => c.unique && !(keys?.has(c.name) ?? false));
}

/** Compute the exact, sorted set of pg-core import symbols the generated stores use. */
function computePgCoreImports(stores: StoreSpec[], conflictKeys?: StoreConflictKeys): string[] {
  const needed = new Set<string>(ALWAYS_USED_SYMBOLS);
  for (const store of stores) {
    for (const col of store.columns) needed.add(COLUMN_TYPE_TO_SYMBOL[col.type]);
    // An FK column is always re-emitted as `uuid(...)` (already in ALWAYS_USED_SYMBOLS via id/tenant_id).
    // A tenant-scoped (compound) unique needs the `uniqueIndex` table-extra builder.
    if (hasCompoundUnique(store, conflictKeys)) needed.add('uniqueIndex');
  }
  return [...needed].sort();
}

/** Convert a store/column name to the exported Drizzle const identifier (camelCase). */
function toCamel(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

/**
 * Emit the `drizzle-orm/pg-core` named import Biome-canonically: single line when it fits printWidth
 * (100), else one symbol per 2-space line with a trailing comma (matched doc-first against Biome 2.5.0
 * — adding `uniqueIndex` for a compound unique can push the six-type import past 100 chars).
 */
function emitPgCoreImport(symbols: string[]): string {
  const single = `import { ${symbols.join(', ')} } from 'drizzle-orm/pg-core';`;
  if (single.length <= 100) return single;
  return ['import {', ...symbols.map((s) => `  ${s},`), "} from 'drizzle-orm/pg-core';"].join('\n');
}

/**
 * Guard: a generator input that slipped past `@rayspec/spec` validation is a HARD error (the
 * generator may be called on a code-built spec that bypassed parseSpec). Re-asserts (a) safe
 * identifiers — TEN-1 defense-in-depth, never interpolate a metacharacter name into emitted TS;
 * (b) no reserved/injected column name; (c) an FK local column is `type:'uuid'` (GEN-1).
 */
function assertStoreSafe(store: StoreSpec): void {
  assertSafeIdentifier(store.name, `store name '${store.name}'`);
  const reserved = new Set<string>(INJECTED_COLUMN_NAMES);
  const fkColumns = new Map(store.foreignKeys.map((fk) => [fk.column, fk]));
  for (const col of store.columns) {
    assertSafeIdentifier(col.name, `column '${store.name}.${col.name}'`);
    if (reserved.has(col.name)) {
      throw new Error(
        `generate-product-schema: store '${store.name}' declares reserved column '${col.name}' ` +
          '(an injected tenancy/GDPR column). This must be rejected at config time by ' +
          "@rayspec/spec's reserved_column_name lint — the generator runs only on validated specs.",
      );
    }
    const fk = fkColumns.get(col.name);
    if (fk && col.type !== 'uuid') {
      throw new Error(
        `generate-product-schema: FK column '${store.name}.${col.name}' is type '${col.type}' but ` +
          "must be 'uuid' (it references the parent's uuid PK). Rejected at config time by lint (GEN-1).",
      );
    }
  }
  for (const fk of store.foreignKeys) {
    assertSafeIdentifier(fk.column, `FK column '${store.name}.${fk.column}'`);
    assertSafeIdentifier(fk.references, `FK reference '${store.name} -> ${fk.references}'`);
  }
}

/**
 * Emit ONE author business column as a Drizzle builder chain (`text('x').notNull()` …). A conflict-key
 * unique column keeps the column-level `.unique()` (a single-column index — the durable `ON CONFLICT`
 * target); a NON-key `unique: true` column emits NO `.unique()` here — it is materialized as a
 * TENANT-SCOPED table-level `uniqueIndex(...)` (compound `(tenant_id, col)`) by {@link emitStore}.
 */
function emitBusinessColumn(col: StoreColumn, isConflictKey: boolean): string {
  const prop = toCamel(col.name);
  let chain = DRIZZLE_BUILDER[col.type](col.name);
  if (!col.nullable) chain += '.notNull()';
  if (col.unique && isConflictKey) chain += '.unique()';
  return `  ${prop}: ${chain},`;
}

/**
 * Emit the FK reference for the local `column` against another product store, with the author's
 * onDelete policy. Re-emits the column as a `uuid` reference builder (a product->parent FK is a
 * uuid PK reference — the parent's injected `id`). The author still declares the local column in
 * `columns[]` (as a `uuid`); we OVERRIDE its emitted builder to add the `.references(...)` chain.
 */
function emitFkColumn(fk: StoreForeignKey, col: StoreColumn): string {
  const prop = toCamel(col.name);
  const parentConst = toCamel(fk.references);
  // `set null` requires a NULLABLE column — @rayspec/spec lint already rejects a NOT-NULL column
  // with `set null` (a fail-the-fix lint test covers it); we honor `col.nullable` here verbatim.
  const onDelete = fk.onDelete;
  const ref = `.references(() => ${parentConst}.id, { onDelete: '${onDelete}' })`;
  return emitReferenceColumn(prop, `uuid('${col.name}')`, !col.nullable, ref);
}

/**
 * Emit a column whose builder ends in a `.references(...)` thunk, matching BIOME's canonical
 * method-chain wrap exactly: Biome breaks a member chain onto continuation lines when it has 3+
 * call members and KEEPS a 2-member chain inline (independent of line width). For our FK columns
 * that means: `uuid(x).notNull().references(...)` (3 members) WRAPS; `uuid(x).references(...)`
 * (a nullable FK, 2 members) stays INLINE. (Verified doc-first against Biome 2.5.0.)
 */
function emitReferenceColumn(prop: string, base: string, notNull: boolean, ref: string): string {
  if (!notNull) {
    // 2-member chain — inline.
    return `  ${prop}: ${base}${ref},`;
  }
  // 3-member chain — wrap each call onto its own 4-space-indented continuation line.
  return [`  ${prop}: ${base}`, '    .notNull()', `    ${ref},`].join('\n');
}

/** Emit one injected column line from the shared descriptor (the tenant_id FK gets its chain). */
function emitInjectedColumn(col: (typeof INJECTED_BEFORE)[number]): string {
  if (col.isTenantFk) {
    // tenant_id is always NOT NULL -> the 3-member chain wraps (matches Biome + schema.ts).
    return emitReferenceColumn(
      col.tsName,
      col.tsSource,
      true,
      ".references(() => orgs.id, { onDelete: 'cascade' })",
    );
  }
  return `  ${col.tsName}: ${col.tsSource},`;
}

/** Emit ONE store as a `pgTable(...)` const + push it into the tuple. */
function emitStore(store: StoreSpec, conflictKeys?: ReadonlySet<string>): string {
  assertStoreSafe(store);
  const tableConst = toCamel(store.name);
  const fkByColumn = new Map<string, StoreForeignKey>();
  for (const fk of store.foreignKeys) fkByColumn.set(fk.column, fk);

  const lines: string[] = [];
  // --- injected tenancy/GDPR columns BEFORE business cols (shared descriptor: id, tenant_id) ---
  for (const inj of INJECTED_BEFORE) lines.push(emitInjectedColumn(inj));
  // --- author business columns (declared order), FK columns get the .references chain ---------
  for (const col of store.columns) {
    const fk = fkByColumn.get(col.name);
    lines.push(
      fk ? emitFkColumn(fk, col) : emitBusinessColumn(col, conflictKeys?.has(col.name) ?? false),
    );
  }
  // --- injected tenancy/GDPR columns AFTER business cols (created_at/deleted_at/…) -------------
  for (const inj of INJECTED_AFTER) lines.push(emitInjectedColumn(inj));

  const banner = `/** Generated product store '${store.name}'. Tenant-scoped by construction (tenant_id -> orgs). */`;

  // TENANT-SCOPED (compound) uniques: a `unique: true` column that is NOT a conflict key is emitted as
  // a table-level `uniqueIndex('<table>_<col>_unique').on(t.tenant_id, t.<col>)` (compound), so two
  // tenants can hold the same value with no cross-tenant existence leak. A conflict-key unique
  // stayed column-level `.unique()` (single) above.
  const compoundUnique = store.columns.filter(
    (c) => c.unique && !(conflictKeys?.has(c.name) ?? false),
  );
  if (compoundUnique.length === 0) {
    // 2-arg form — the base output (no compound unique index).
    return [
      banner,
      `export const ${tableConst} = pgTable('${store.name}', {`,
      ...lines,
      '});',
    ].join('\n');
  }

  // 3-arg form. Biome breaks `pgTable(name, { ...cols }, extras)` onto separate lines and re-indents the
  // column object by one level (2→4 spaces, incl. wrapped chain continuation lines). Matched doc-first
  // against Biome 2.5.0 (the same fidelity discipline as emitReferenceColumn).
  const indentedLines = lines.map((l) =>
    l
      .split('\n')
      .map((s) => `  ${s}`)
      .join('\n'),
  );
  const indexExprs = compoundUnique.map(
    (c) => `uniqueIndex('${store.name}_${c.name}_unique').on(t.tenantId, t.${toCamel(c.name)})`,
  );
  const inlineExtras = `  (t) => [${indexExprs.join(', ')}],`;
  // Biome keeps the `(t) => [...]` array inline when it fits printWidth (100); else one element per
  // 4-space line with the `[`/`]` on their own lines.
  const extras =
    inlineExtras.length <= 100
      ? inlineExtras
      : ['  (t) => [', ...indexExprs.map((e) => `    ${e},`), '  ],'].join('\n');
  return [
    banner,
    `export const ${tableConst} = pgTable(`,
    `  '${store.name}',`,
    '  {',
    ...indentedLines,
    '  },',
    extras,
    ');',
  ].join('\n');
}

/**
 * Generate the full product-schema module SOURCE for a set of declared stores.
 *
 * Output shape:
 *   - a banner comment (DO NOT EDIT — generated)
 *   - the pg-core import (only the needed builders) + `orgs` from the core schema
 *   - one `pgTable(...)` const per store (injected columns + business columns + FKs)
 *   - the `PRODUCT_TENANT_SCOPED_TABLES` tuple (`[...] as const`) — the type-enforced tuple seam
 *
 * `stores` is taken in DECLARED order; a store referenced by an FK MUST be declared before /
 * anywhere in the list (Drizzle `.references(() => parent.id)` is a thunk, so forward refs within
 * the module are fine — but `@rayspec/spec` lint already requires `references` to resolve to a
 * declared store). For an EMPTY `stores[]` the module is the product-empty baseline.
 */
export function generateProductSchema(
  stores: StoreSpec[],
  conflictKeys?: StoreConflictKeys,
): string {
  const empty = stores.length === 0;
  const banner = [
    '/**',
    ' * GENERATED product schema — DO NOT EDIT BY HAND.',
    ' *',
    ' * Produced by @rayspec/db generate-product-schema from a validated RaySpec `stores[]`.',
    ' * The tenancy/GDPR columns (id, tenant_id->orgs ON DELETE CASCADE, created_at, deleted_at,',
    ' * retention_days, region, created_by, idempotency_key) are INJECTED to match schema.ts exactly;',
    ' * authors declare business columns only. PRODUCT_TENANT_SCOPED_TABLES is the type-enforced',
    ' * COMPILE-TIME seam schema.ts composes into the `TENANT_SCOPED_TABLES` tuple (the type-level',
    ' * TenantScopedTable union). RUNTIME reachability through the TenantDb chokepoint is a separate',
    ' * BOOT-TIME step: a product table is admitted to the deny-by-default chokepoint Set at boot via the',
    " * sanctioned `registerProductTables` hook (`@rayspec/db/composition`'s `registerProductStores`); an",
    ' * unregistered table throws (deny-by-default).',
    ...(empty
      ? [
          ' *',
          ' * PLATFORM MAIN LINE = PRODUCT-EMPTY. The platform',
          ' * ships the generator MECHANISM + the generalized gates + this product-empty baseline (the',
          ' * type-proven seam carrying ZERO product tables). A real deployment runs the generator over its own',
          ' * `rayspec.yaml` to produce the injected-column table DEFINITIONS, then registers those tables into',
          ' * the runtime chokepoint at BOOT through the hook above — no shipped boot path registers by importing',
          " * a populated main-line tuple. The throwaway acme-notes backend's populated module lives under",
          ' * `examples/acme-notes-backend/generated/`. NO product table (notebooks/entries) ever lands in',
          ' * `packages/`.',
          ' *',
          ' * Regenerate (empty baseline): `pnpm --filter @rayspec/db gen:product-schema` (no spec arg).',
        ]
      : []),
    ' */',
  ].join('\n');

  // No stores => no tables => no imports needed (the product-empty baseline is import-free). For a
  // populated module, emit ONLY the builder symbols actually used (no unused import for Biome).
  const imports = empty
    ? null
    : [
        emitPgCoreImport(computePgCoreImports(stores, conflictKeys)),
        // The ONLY core-table reference: the injected tenant_id FK target. The generator never
        // emits or modifies a core table — it only points the tenancy FK at the existing orgs root.
        "import { orgs } from '../schema.js';",
      ].join('\n');

  const tableBlocks = stores.map((s) => emitStore(s, conflictKeys?.get(s.name)));

  const tupleMembers = stores.map((s) => toCamel(s.name));
  const tuple = [
    '/**',
    ' * The product tables this generated module contributes to TENANT_SCOPED_TABLES (a',
    ' * type-enforced tuple extension, composed in schema.ts — NOT a runtime append). Empty on the',
    ' * platform main line (product-empty baseline); populated in a deployment / the throwaway.',
    ' */',
    tupleMembers.length === 0
      ? 'export const PRODUCT_TENANT_SCOPED_TABLES = [] as const;'
      : `export const PRODUCT_TENANT_SCOPED_TABLES = [${tupleMembers.join(', ')}] as const;`,
  ].join('\n');

  const parts = imports
    ? [banner, imports, ...tableBlocks, tuple]
    : [banner, ...tableBlocks, tuple];
  const body = parts.join('\n\n');
  // Trailing newline (Biome/POSIX); a single final newline keeps the golden byte-stable.
  return `${body}\n`;
}
