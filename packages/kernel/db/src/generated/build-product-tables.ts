/**
 * RUNTIME product-table builder — the executable twin of the source generator.
 *
 * `generate-product-schema.ts` emits Drizzle-TS SOURCE (committed, codegen-into-committed-source —
 * the table-registration contract). This module builds the EQUIVALENT runtime `PgTable` objects from the same
 * `StoreSpec[]`, using the SAME injected-column pattern + the SAME ColumnType→builder mapping, so a
 * test / a generalized gate can exercise generated product tables through the real TenantDb
 * chokepoint WITHOUT importing a committed `generated/product-schema.ts` (whose `../schema.js`
 * import path is relative to a deployment's package layout, not a test's).
 *
 * Honesty: source-gen and runtime-build share one ColumnType→builder vocabulary + one injected-
 * column list, and a meta-test asserts the runtime tables and the generated SQL agree column-for-
 * column (so the twin cannot silently drift from the committed source). This is the building block
 * for the parameterizable cross-tenant gate (deliverable 7) — it lets the gate run over the
 * throwaway's `notebooks`/`entries` even though the platform baseline is product-empty.
 */
import type { ColumnType, StoreSpec } from '@rayspec/spec';
import {
  boolean,
  integer,
  jsonb,
  type PgTable,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { markEnumWhitelist } from '../enum-whitelist-registry.js';
import { markFtsTable } from '../fts-registry.js';
import { orgs } from '../schema.js';
import { markSoftDeleteTable } from '../soft-delete-registry.js';
import type { StoreConflictKeys } from './generate-product-sql.js';

/** snake_case → camelCase (mirrors generate-product-schema's toCamel — the runtime prop key). */
function toCamel(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

/**
 * A drizzle column builder with the chainable modifiers we use. The pg-core builder generics are
 * deeply parameterized; for a RUNTIME twin (not the typed source) we only need the chain to run, so
 * we model the minimal chainable surface and let drizzle's runtime do the real work.
 */
interface ChainableBuilder {
  notNull(): ChainableBuilder;
  unique(): ChainableBuilder;
  defaultRandom(): ChainableBuilder;
  primaryKey(): ChainableBuilder;
  defaultNow(): ChainableBuilder;
  default(value: unknown): ChainableBuilder;
  references(ref: () => unknown, opts: { onDelete: string }): ChainableBuilder;
}
const chain = (b: unknown): ChainableBuilder => b as ChainableBuilder;

/** Build the business-column builder for a ColumnType (mirrors generate-product-schema.ts). */
function businessBuilder(type: ColumnType, snake: string): ChainableBuilder {
  switch (type) {
    case 'text':
      return chain(text(snake));
    case 'uuid':
      return chain(uuid(snake));
    case 'timestamp':
      return chain(timestamp(snake, { withTimezone: true }));
    case 'integer':
      return chain(integer(snake));
    case 'boolean':
      return chain(boolean(snake));
    case 'jsonb':
      return chain(jsonb(snake));
  }
}

/**
 * Build one runtime `PgTable` for a store: injected tenancy/GDPR columns (matching schema.ts) +
 * the author's business columns, with FK columns carrying the `.references()` chain. `tableLookup`
 * resolves a product->product FK parent (built earlier in declared order). The injected tenant_id
 * always references the core `orgs` root ON DELETE CASCADE.
 */
function buildStoreTable(
  store: StoreSpec,
  tableLookup: Map<string, PgTable>,
  conflictKeys?: ReadonlySet<string>,
): PgTable {
  const fkByColumn = new Map(store.foreignKeys.map((fk) => [fk.column, fk]));

  const columns: Record<string, ChainableBuilder> = {
    id: chain(uuid('id')).defaultRandom().primaryKey(),
    tenantId: chain(uuid('tenant_id'))
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
  };

  for (const col of store.columns) {
    const camel = toCamel(col.name);
    const fk = fkByColumn.get(col.name);
    if (fk) {
      const parent = tableLookup.get(fk.references);
      if (!parent) {
        throw new Error(
          `build-product-tables: FK '${store.name}.${col.name}' references undeclared/late store ` +
            `'${fk.references}' (declare parents before children).`,
        );
      }
      if (fk.referencesColumn === undefined) {
        // ID-TARGET FK: the parent's injected PK is `id` (a uuid). Reference it with the author onDelete
        // policy — the historic form, runtime twin agrees with the generator's single-column FK DDL.
        const parentId = (parent as unknown as { id: unknown }).id;
        let b = chain(uuid(col.name)).references(() => parentId, { onDelete: fk.onDelete });
        if (!col.nullable) b = b.notNull();
        columns[camel] = b;
      } else {
        // BUSINESS-KEY FK: a TENANT-SCOPED COMPOUND FK `(tenant_id, col) -> parent(tenant_id, refcol)`,
        // which a single-column drizzle `.references()` cannot express — the DB constraint (emitted by
        // generate-product-sql) is the sole enforcer, and this runtime twin only needs the column with
        // its DECLARED type (matched to the referenced unique column's type by lint) so a select/insert
        // round-trips correctly. NO forced uuid (the column may be text/integer/…) and NO runtime
        // `.references()` (it would mis-model the compound FK). A `unique: true` business-key FK column
        // still gets its compound unique index via the `compoundUnique` extras below.
        let b = businessBuilder(col.type, col.name);
        if (!col.nullable) b = b.notNull();
        columns[camel] = b;
      }
    } else {
      let b = businessBuilder(col.type, col.name);
      if (!col.nullable) b = b.notNull();
      // A conflict-key unique keeps a SINGLE-column `.unique()`; a NON-key unique becomes a
      // TENANT-SCOPED compound `uniqueIndex` table-extra below. Secure default = compound.
      if (col.unique && (conflictKeys?.has(col.name) ?? false)) b = b.unique();
      columns[camel] = b;
    }
  }

  columns.createdAt = chain(timestamp('created_at', { withTimezone: true }))
    .notNull()
    .defaultNow();
  columns.deletedAt = chain(timestamp('deleted_at', { withTimezone: true }));
  columns.retentionDays = chain(integer('retention_days'));
  columns.region = chain(text('region')).notNull().default('eu');
  // Injected columns (nullable): the actor stamp (created_by) + the store.create
  // Idempotency-Key (idempotency_key). The idempotency uniqueness is a DB-level index the migration
  // owns (see generate-product-sql / the tenant_idx precedent), NOT an ORM uniqueIndex here.
  columns.createdBy = chain(text('created_by'));
  columns.idempotencyKey = chain(text('idempotency_key'));

  // Tenant-scoped (compound) unique indexes for NON-key `unique: true` columns: the runtime twin mirrors
  // the DDL — `uniqueIndex('<table>_<col>_unique').on(tenant_id, col)` — so a test/gate that inspects the
  // built table agrees with `generateProductSql`. (Enforcement is the DB index; ON CONFLICT targets are
  // the column list db.upsert passes, not the table's declared unique.)
  const compoundUnique = store.columns.filter(
    (c) => c.unique && !(conflictKeys?.has(c.name) ?? false),
  );
  if (compoundUnique.length === 0) {
    return pgTable(store.name, columns as never) as unknown as PgTable;
  }
  const extras = (t: Record<string, unknown>) =>
    compoundUnique.map((c) =>
      uniqueIndex(`${store.name}_${c.name}_unique`).on(
        t.tenantId as never,
        t[toCamel(c.name)] as never,
      ),
    );
  return pgTable(store.name, columns as never, extras as never) as unknown as PgTable;
}

/**
 * Build runtime `PgTable` objects for a set of declared stores (DECLARED order; parents before
 * children for product->product FKs). Returns a name->table map — the input to the parameterizable
 * cross-tenant gate + the generalized shadow assertions.
 */
export function buildProductTables(
  stores: StoreSpec[],
  conflictKeys?: StoreConflictKeys,
): Map<string, PgTable> {
  const tables = new Map<string, PgTable>();
  for (const store of stores) {
    const table = buildStoreTable(store, tables, conflictKeys?.get(store.name));
    // A `softDelete` store's runtime table is marked in the identity registry so the handler-db facade
    // (makeHandlerDb — the read/write surface behind views/workflows/handlers) enforces the SAME
    // tombstone-invisibility the CRUD routes do. Default (hard-delete) stores are never marked → their
    // facade behaviour is byte-behaviourally unchanged.
    if (store.softDelete === true) markSoftDeleteTable(table);
    // A `fullTextSearch` store's runtime table is marked in the FTS identity registry (parity with
    // soft-delete) so a facade-level full-text consumer can resolve it by object identity. The generated
    // `search_vector` tsvector column itself is DB-level (NOT an ORM twin column), so the runtime table
    // shape is byte-behaviourally unchanged; only the registry membership differs.
    if (store.fullTextSearch === true) markFtsTable(table);
    // A store's declared column `enum` value whitelists are recorded in the identity registry so the
    // handler-db facade rejects an out-of-whitelist write value (parity with the HTTP create/update
    // route + the workflow store.write node). Keyed by the DECLARED column name; a store with no `enum`
    // column records nothing → its facade write behaviour is byte-behaviourally unchanged.
    const enumWhitelist = new Map(
      store.columns.filter((c) => c.enum !== undefined).map((c) => [c.name, new Set(c.enum)]),
    );
    if (enumWhitelist.size > 0) markEnumWhitelist(table, enumWhitelist);
    tables.set(store.name, table);
  }
  return tables;
}
