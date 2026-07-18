/**
 * GENERATED product schema — DO NOT EDIT BY HAND.
 *
 * Produced by @rayspec/db generate-product-schema from a validated RaySpec `stores[]`.
 * The tenancy/GDPR columns (id, tenant_id->orgs ON DELETE CASCADE, created_at, deleted_at,
 * retention_days, region, created_by, idempotency_key) are INJECTED to match schema.ts exactly;
 * authors declare business columns only. PRODUCT_TENANT_SCOPED_TABLES is the type-enforced
 * COMPILE-TIME seam schema.ts composes into the `TENANT_SCOPED_TABLES` tuple (the type-level
 * TenantScopedTable union). RUNTIME reachability through the TenantDb chokepoint is a separate
 * BOOT-TIME step: a product table is admitted to the deny-by-default chokepoint Set at boot via the
 * sanctioned `registerProductTables` hook (`@rayspec/db/composition`'s `registerProductStores`); an
 * unregistered table throws (deny-by-default).
 *
 * PLATFORM MAIN LINE = PRODUCT-EMPTY. The platform
 * ships the generator MECHANISM + the generalized gates + this product-empty baseline (the
 * type-proven seam carrying ZERO product tables). A real deployment runs the generator over its own
 * `rayspec.yaml` to produce the injected-column table DEFINITIONS, then registers those tables into
 * the runtime chokepoint at BOOT through the hook above — no shipped boot path registers by importing
 * a populated main-line tuple. The throwaway acme-notes backend's populated module lives under
 * `examples/acme-notes-backend/generated/`. NO product table (notebooks/entries) ever lands in
 * `packages/`.
 *
 * Regenerate (empty baseline): `pnpm --filter @rayspec/db gen:product-schema` (no spec arg).
 */

/**
 * The product tables this generated module contributes to TENANT_SCOPED_TABLES (a
 * type-enforced tuple extension, composed in schema.ts — NOT a runtime append). Empty on the
 * platform main line (product-empty baseline); populated in a deployment / the throwaway.
 */
export const PRODUCT_TENANT_SCOPED_TABLES = [] as const;
