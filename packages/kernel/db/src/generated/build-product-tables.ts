/**
 * RUNTIME product-table builder — the executable twin of the source generator.
 *
 * `generate-product-schema.ts` emits Drizzle-TS SOURCE (committed, codegen-into-committed-source —
 * correction A1). This module builds the EQUIVALENT runtime `PgTable` objects from the same
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
  uuid,
} from 'drizzle-orm/pg-core';
import { orgs } from '../schema.js';

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
function buildStoreTable(store: StoreSpec, tableLookup: Map<string, PgTable>): PgTable {
  const fkByColumn = new Map(store.foreignKeys.map((fk) => [fk.column, fk]));

  const columns: Record<string, ChainableBuilder> = {
    id: chain(uuid('id')).defaultRandom().primaryKey(),
    tenantId: chain(uuid('tenant_id'))
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
  };

  for (const col of store.columns) {
    const camel = col.name.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
    const fk = fkByColumn.get(col.name);
    if (fk) {
      const parent = tableLookup.get(fk.references);
      if (!parent) {
        throw new Error(
          `build-product-tables: FK '${store.name}.${col.name}' references undeclared/late store ` +
            `'${fk.references}' (declare parents before children).`,
        );
      }
      // The parent's injected PK is `id` (a uuid). Reference it with the author onDelete policy.
      const parentId = (parent as unknown as { id: unknown }).id;
      let b = chain(uuid(col.name)).references(() => parentId, { onDelete: fk.onDelete });
      if (!col.nullable) b = b.notNull();
      columns[camel] = b;
    } else {
      let b = businessBuilder(col.type, col.name);
      if (!col.nullable) b = b.notNull();
      if (col.unique) b = b.unique();
      columns[camel] = b;
    }
  }

  columns.createdAt = chain(timestamp('created_at', { withTimezone: true }))
    .notNull()
    .defaultNow();
  columns.deletedAt = chain(timestamp('deleted_at', { withTimezone: true }));
  columns.retentionDays = chain(integer('retention_days'));
  columns.region = chain(text('region')).notNull().default('eu');

  return pgTable(store.name, columns as never) as unknown as PgTable;
}

/**
 * Build runtime `PgTable` objects for a set of declared stores (DECLARED order; parents before
 * children for product->product FKs). Returns a name->table map — the input to the parameterizable
 * cross-tenant gate + the generalized shadow assertions.
 */
export function buildProductTables(stores: StoreSpec[]): Map<string, PgTable> {
  const tables = new Map<string, PgTable>();
  for (const store of stores) {
    tables.set(store.name, buildStoreTable(store, tables));
  }
  return tables;
}
