/**
 * @rayspec/db/testing — the RAW-HANDLE entrypoint.
 *
 * `makeDb` / `makeDbWithSchema` return the raw, tenant-UNSCOPED Drizzle handle. `makeDbWithSchema`
 * (the per-schema TEST factory) is the test/bootstrap seam ONLY and is deliberately kept OFF the
 * main `@rayspec/db` surface (this subpath is public, but `makeDbWithSchema` is not re-exported
 * from `.`), so shipped request/orchestration code never reaches the per-schema raw handle through
 * the main entrypoint. `makeDb` (the PRODUCTION factory) IS on the main surface (the boot entrypoint
 * needs it); it is re-exported here too for tests/spikes that want a non-schema-pinned
 * handle. Three layers keep raw access from leaking into SCOPED code:
 *   1. main-surface scope — `@rayspec/db` (the `.` export) exposes only the production `makeDb`,
 *      not the per-schema `makeDbWithSchema` nor the gate-only Set mutators;
 *   2. a Biome `noRestrictedImports` ban (biome.json overrides) FAILS lint if any shipped
 *      `packages/**\/src` file imports `@rayspec/db/testing` — carving out exactly the build's
 *      own non-shipped seams (`*.test.ts` and `test-support/**`), which legitimately use it. NOTE:
 *      Biome overrides REPLACE (not merge) a rule's options, so the SECOND override (the scoped roots
 *      platform/src + api-auth/src + durable-dbos/src) RE-DECLARES this `/testing` ban alongside its
 *      makeDb + `/composition` bans — without that re-declaration those roots would silently lose it;
 *   3. the tenant-chokepoint CI gate additionally fails the build if the `makeDb`/`makeDbWithSchema`
 *      TOKEN appears in a SCOPED root (packages/platform/src, packages/api-auth/src) — regardless of
 *      import surface. `@rayspec/server/src` is NOT a scoped root (it is the composition root).
 * Layers 2+3 are greppable CI barriers; the subpath itself is public (importable from a test),
 * which is intended.
 *
 * Request/run-core code holds ONLY a `TenantDb` via `forTenant(db, tenantId)` from the main
 * surface.
 *
 * The GATE-ONLY product-tenancy machinery lives HERE too, OFF the main surface:
 *   - `withScopedTables` mutates the REAL deny-by-default Set (registers product tables for the
 *     assertion's scope) — a request-path caller could defeat deny-by-default with it;
 *   - `assertProductTenancy` calls `withScopedTables`.
 * Keeping them on `/testing` means the same Biome `noRestrictedImports` ban that blocks the raw
 * factories in shipped `packages/**\/src` also blocks these — it is IMPOSSIBLE to reach the raw Set
 * mutator from request-path code (the import itself fails lint). The pure deploy MECHANISM
 * (`buildProductTables`, `generateProduct*`, `detectDrift`) stays on the main `@rayspec/db` surface.
 *
 * The SANCTIONED registration door for SHIPPED BOOT code (the composition root + the CLI `deploy`, NOT
 * request-path code) is `@rayspec/db/composition` (`registerProductStores`): it VALIDATES every product
 * table's tenant predicate (a tenant_id column / shape / FK → orgs) BEFORE delegating once to
 * `registerScopedTables`, closing the unscoped-INSERT escalation the raw seam leaves open. `/composition`
 * is itself banned in the scoped roots (biome + the tenant-chokepoint gate's registerProductStores
 * token) — only the boot composition root / CLI deploy entrypoint may import it.
 */
export { type Db, makeDb, makeDbWithSchema } from './client.js';
export { buildProductTables } from './generated/build-product-tables.js';
export type { StoreConflictKeys } from './generated/generate-product-sql.js';
export {
  assertProductTenancy,
  type ProductTenancyResult,
  type QueryFn as ProductTenancyQueryFn,
} from './generated/product-tenancy-gate.js';
export { registerScopedTables, withScopedTables } from './tenant-db.js';
export {
  type InjectedColumnLines,
  type InjectedColumnLinesOptions,
  injectedColumnLinesSql,
  parseCreateTableColumnNames,
} from './testing-ddl.js';
