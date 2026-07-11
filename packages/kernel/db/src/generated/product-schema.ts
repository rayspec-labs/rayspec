/**
 * GENERATED product schema — DO NOT EDIT BY HAND.
 *
 * Produced by @rayspec/db generate-product-schema from a validated RaySpec `stores[]`.
 * The tenancy/GDPR columns (id, tenant_id->orgs ON DELETE CASCADE,
 * created_at, deleted_at, retention_days, region) are INJECTED to match schema.ts exactly;
 * authors declare business columns only. PRODUCT_TENANT_SCOPED_TABLES is the type-enforced
 * seam schema.ts composes into TENANT_SCOPED_TABLES — a generated table is
 * reachable through the TenantDb chokepoint, an unregistered one throws (deny-by-default).
 *
 * PLATFORM MAIN LINE = PRODUCT-EMPTY. The platform
 * ships the generator MECHANISM + the generalized gates + this product-empty baseline (the
 * type-proven seam carrying ZERO product tables). A real deployment runs the generator over its own
 * `rayspec.yaml` and commits the populated module into ITS repo instance; the throwaway
 * acme-notes backend's populated module lives under `examples/acme-notes-backend/generated/`. NO
 * product table (notebooks/entries) ever lands in `packages/`.
 *
 * Regenerate (empty baseline): `pnpm --filter @rayspec/db gen:product-schema` (no spec arg).
 */

/**
 * The product tables this generated module contributes to TENANT_SCOPED_TABLES (a
 * type-enforced tuple extension, composed in schema.ts — NOT a runtime append). Empty on the
 * platform main line (product-empty baseline); populated in a deployment / the throwaway.
 */
export const PRODUCT_TENANT_SCOPED_TABLES = [] as const;
