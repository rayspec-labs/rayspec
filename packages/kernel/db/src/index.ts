/**
 * @rayspec/db public surface.
 *
 * Request-path + run-core code holds ONLY a `TenantDb` (via `forTenant`). The raw, UNSCOPED
 * Drizzle handle factory `makeDbWithSchema` (the per-schema TEST seam) is NOT re-exported here — it
 * lives on the separate `@rayspec/db/testing` subpath, so the default import path cannot name it.
 *
 * `makeDb(databaseUrl)` — the PRODUCTION composition-root factory (the deploy analogue of the
 * per-schema test `makeDbWithSchema`) — IS on this surface: a real boot entrypoint
 * (`@rayspec/server`) MUST be able to build the one raw handle the deployment needs, and the
 * composition root is the documented single place a raw handle is built (`app-context.ts`). Putting
 * the PRODUCTION factory on the main surface does NOT weaken the tenant boundary for scoped code —
 * it is double-guarded, like `makeDbWithSchema`:
 *   1. PRIMARY (import-source-agnostic): the tenant-chokepoint GREP gate STILL fails the build if the
 *      `makeDb`/`makeDbWithSchema` TOKEN appears in a scoped root (`packages/platform/src`,
 *      `packages/api-auth/src`) outside a whitelisted global-table module — regardless of which
 *      surface it was imported from (it catches alias/namespace/re-export/dynamic-import too).
 *   2. SECONDARY (module boundary): a Biome `noRestrictedImports` override on the
 *      SAME scoped roots bans the NAMED import `makeDb` from `@rayspec/db` (biome.json — the
 *      `importNames` rule), mirroring the existing `@rayspec/db/testing`-subpath ban that
 *      double-guards `makeDbWithSchema`. The `Db` TYPE + `forTenant` from `@rayspec/db` stay allowed.
 * `@rayspec/server/src` is NOT a scoped root (it is the composition root), so it may name `makeDb`
 * under BOTH barriers. The `Db` TYPE is still exported (a type, not a handle; TenantDb signatures
 * reference it).
 */
export { type Db, makeDb } from './client.js';
// The pure delta-diff core: old→new `StoreSpec[]` -> forward-migration SQL + a
// byte-faithful machine-proposed allowlist + the versioned migration-naming convention. Product-
// agnostic platform mechanism (the update analogue of the CREATE-only generator).
export {
  type DiffProductStoresOptions,
  diffProductStores,
  nextMigrationFilename,
  type StatementFinding,
  type StoreDiffResult,
} from './diff-product-stores.js';
// The PURE product-schema MECHANISM (generator + drift). Product-agnostic platform/
// deploy tooling. The platform main line ships these + a PRODUCT-EMPTY generated baseline; a
// deployment / the throwaway runs the generator over its own spec. The GATE-ONLY product-tenancy
// machinery (`assertProductTenancy`, `withScopedTables`) is DELIBERATELY off this surface — it lives
// on `@rayspec/db/testing` (ZPC-3), blocked in shipped `packages/**\/src` by the same Biome
// `noRestrictedImports` ban as the raw factories, so a request-path caller cannot reach the
// deny-by-default Set mutator.
export { buildProductTables } from './generated/build-product-tables.js';
export {
  classifyProductSchema,
  type DriftFinding,
  detectDrift,
  formatDrift,
  type ProductSchemaState,
  type QueryFn,
} from './generated/drift-detect.js';
export {
  generateProductSchema,
  INJECTED_COLUMN_NAMES,
} from './generated/generate-product-schema.js';
export { generateProductSql, type StoreConflictKeys } from './generated/generate-product-sql.js';
export { PRODUCT_TENANT_SCOPED_TABLES } from './generated/product-schema.js';
export { MIGRATION_ALLOWLIST } from './migration-scan.allowlist.js';
export {
  type AllowlistEntry,
  type DestructiveFinding,
  type DestructiveKind,
  formatFindings,
  type ScanResult,
  scanMigrationSql,
} from './migration-scan.js';
export { migrationsDir } from './migrations.js';
// The ONE shared Postgres-error-shape detectors (the 23505 cause-chain walk + the constraint-name
// reader). Request-path/capability code maps a UNIQUE violation to a typed conflict through these.
export { isUniqueViolation, uniqueViolationConstraintName } from './pg-errors.js';
export * as schema from './schema.js';
// The CORE tenant-scoped table set (runs / journal_steps / conversation_items / run_events /
// idempotency_keys). Additive named re-export (also reachable via `schema.CORE_TENANT_SCOPED_TABLES`)
// so a platform consumer — e.g. a tenant data-erasure — can erase the core run-journal/transcript
// tables through the SAME `forTenant` chokepoint without naming each table. NOT kill-set (schema.ts is
// unchanged; this just surfaces an already-exported const on the package barrel).
export { CORE_TENANT_SCOPED_TABLES } from './schema.js';
// The soft-delete table-identity registry: `buildProductTables` marks a `softDelete` store's runtime
// table; the handler-db facade (makeHandlerDb — views/workflows/handlers) consults `isSoftDeleteTable`
// to fold `deleted_at IS NULL` into reads/updates + stamp the tombstone on delete (parity with the CRUD
// routes). Mirrors the `registerScopedTables` identity-set pattern (no wide param plumbing).
export { isSoftDeleteTable, markSoftDeleteTable } from './soft-delete-registry.js';
export { forTenant, TENANT_GUC, TenantDb } from './tenant-db.js';
