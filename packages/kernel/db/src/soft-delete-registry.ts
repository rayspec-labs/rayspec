/**
 * Soft-delete table registry — a module-level identity set of the runtime `PgTable` objects that
 * belong to a store declared with `softDelete: true`.
 *
 * WHY a registry (not a threaded param): the handler-db FACADE (`makeHandlerDb`, @rayspec/platform)
 * receives only a name→`PgTable` map (`productTables`) — it has NO access to the `StoreSpec`, so it
 * cannot see a store's `softDelete` flag. The CRUD store routes DO carry the `StoreSpec` and already
 * fold `deleted_at IS NULL` into every read/update + stamp the tombstone on delete; the facade (the
 * richer read/write surface behind declarative VIEWS, workflow `store_read`/`store_write` nodes, and
 * tool/route/trigger handlers) must enforce the SAME "a tombstoned row is uniformly invisible" contract,
 * or a view/workflow/handler read would resurface tombstoned rows (a same-tenant data resurface) and a
 * facade delete would HARD-delete a soft-delete store.
 *
 * `buildProductTables` — the ONE place both the facade's tables and the routes' tables are built — marks
 * each `softDelete` store's built table here; the facade then asks `isSoftDeleteTable(table)` by object
 * IDENTITY. This mirrors the `registerScopedTables` pattern (a module-level identity set the chokepoint
 * consults) rather than plumbing a new flag through ~10 signatures. A `WeakSet` keyed by the table object
 * lets the mark ride the table's own lifetime (no leak; no name collision across deployments/suites —
 * each `buildStoreTable` mints a FRESH `PgTable`, so a mark is per-object).
 */
import type { PgTable } from 'drizzle-orm/pg-core';

/** Identity set of runtime product tables whose store declared `softDelete: true`. */
const SOFT_DELETE_TABLES = new WeakSet<PgTable>();

/**
 * Mark a runtime `PgTable` as belonging to a `softDelete` store (called by `buildProductTables` for
 * each store with `softDelete === true`). Idempotent — re-marking the same object is a no-op.
 */
export function markSoftDeleteTable(table: PgTable): void {
  SOFT_DELETE_TABLES.add(table);
}

/**
 * True if `table` was built for a `softDelete` store (consulted by the handler-db facade to fold
 * `deleted_at IS NULL` into reads/updates + stamp the tombstone on delete). False for the default
 * (hard-delete) store — its facade behaviour is byte-behaviourally unchanged.
 */
export function isSoftDeleteTable(table: PgTable): boolean {
  return SOFT_DELETE_TABLES.has(table);
}
