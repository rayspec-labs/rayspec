/**
 * Full-text-search table registry — a module-level identity set of the runtime `PgTable` objects that
 * belong to a store declared with `fullTextSearch: true`.
 *
 * A `fullTextSearch` store carries a GENERATED-ALWAYS-STORED `search_vector` tsvector column (over its
 * text columns) + a GIN index, emitted by the migration generator (@rayspec/db generate-product-sql).
 * That column is a DB-level search structure — it is NOT represented in the Drizzle ORM twins (exactly
 * like the injected `<table>_tenant_idx` and the idempotency unique index), so it never surfaces in a
 * list/get response.
 *
 * WHY a registry (mirrors `soft-delete-registry.ts`): the ranked list-query surface (`?__search=`,
 * store-query.ts) already carries the `StoreSpec` and reads `store.fullTextSearch` directly, so it needs
 * no registry. But the handler-db FACADE (`makeHandlerDb`, @rayspec/platform — the richer read surface
 * behind declarative VIEWS / workflow nodes / handlers) receives only a name→`PgTable` map and has NO
 * access to the `StoreSpec`. This identity set is the seam a facade-level full-text consumer resolves an
 * FTS store by object IDENTITY through — the SAME pattern soft-delete uses — rather than plumbing a new
 * flag through the facade signatures.
 *
 * `buildProductTables` marks each `fullTextSearch` store's built table here. A `WeakSet` keyed by the
 * table object lets the mark ride the table's own lifetime (no leak; no name collision across
 * deployments/suites — each `buildStoreTable` mints a FRESH `PgTable`, so a mark is per-object).
 */
import type { PgTable } from 'drizzle-orm/pg-core';

/** Identity set of runtime product tables whose store declared `fullTextSearch: true`. */
const FTS_TABLES = new WeakSet<PgTable>();

/**
 * Mark a runtime `PgTable` as belonging to a `fullTextSearch` store (called by `buildProductTables` for
 * each store with `fullTextSearch === true`). Idempotent — re-marking the same object is a no-op.
 */
export function markFtsTable(table: PgTable): void {
  FTS_TABLES.add(table);
}

/**
 * True if `table` was built for a `fullTextSearch` store. False for the default (substring-only) store —
 * its behaviour is byte-behaviourally unchanged.
 */
export function isFtsTable(table: PgTable): boolean {
  return FTS_TABLES.has(table);
}
