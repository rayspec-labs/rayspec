/**
 * Column enum-whitelist registry — a module-level identity map from a runtime `PgTable` object to its
 * declared column value whitelists (declared column name → the set of allowed values).
 *
 * WHY a registry (not a threaded param): the handler-db FACADE (`makeHandlerDb`, @rayspec/platform)
 * receives only a name→`PgTable` map (`productTables`) — it has NO access to the `StoreSpec`, so it
 * cannot see a column's declared `enum` value whitelist. The HTTP create/update route (a `z.enum` in
 * store-validation) and the workflow `store.write` node already reject an out-of-whitelist value; the
 * facade (the richer read/write surface behind declarative views, workflow store_read/store_write
 * nodes, and tool/route/trigger handlers) must reject the SAME out-of-whitelist value, or a low-level
 * escape-hatch handler writing directly through the facade could persist a value the declared whitelist
 * forbids — breaking parity with the two declarative write surfaces.
 *
 * `buildProductTables` — the ONE place both the facade's tables and the routes' tables are built —
 * records each store's non-empty column whitelists here; the facade then asks `enumWhitelistFor(table)`
 * by object IDENTITY. This mirrors the soft-delete registry: a module-level identity map the chokepoint
 * consults, rather than plumbing the whitelist through every facade signature. A `WeakMap` keyed by the
 * table object lets the record ride the table's own lifetime (no leak; no name collision across
 * deployments/suites — each `buildStoreTable` mints a FRESH `PgTable`, so a record is per-object).
 */
import type { PgTable } from 'drizzle-orm/pg-core';

/** A store's declared column value whitelists: declared (snake_case) column name → its allowed values. */
export type ColumnEnumWhitelists = ReadonlyMap<string, ReadonlySet<string>>;

/** Identity map from a runtime product table to its declared column value whitelists. */
const ENUM_WHITELISTS = new WeakMap<PgTable, ColumnEnumWhitelists>();

/**
 * Record a runtime `PgTable`'s declared column value whitelists (called by `buildProductTables` for each
 * store that declares at least one `enum` column). Keyed by the DECLARED (snake_case) column name — the
 * same key `store.columns[].name` carries and the runtime column's `.name` reports.
 */
export function markEnumWhitelist(table: PgTable, whitelistByColumn: ColumnEnumWhitelists): void {
  ENUM_WHITELISTS.set(table, whitelistByColumn);
}

/**
 * The declared column value whitelists for `table`, or `undefined` when the store declared no `enum`
 * column (consulted by the handler-db facade to reject an out-of-whitelist write value — parity with the
 * HTTP create/update route + the workflow store.write node). `undefined` for the common no-enum store,
 * whose facade write behaviour is byte-behaviourally unchanged.
 */
export function enumWhitelistFor(table: PgTable): ColumnEnumWhitelists | undefined {
  return ENUM_WHITELISTS.get(table);
}
