/**
 * @rayspec/db/composition — the SANCTIONED product-store registrar (the boot-time door onto the
 * deny-by-default tenant chokepoint Set).
 *
 * WHY THIS EXISTS — the asymmetry it closes.
 *   `TenantDb`'s four query methods are NOT symmetric about the tenant predicate. `select`/`update`/
 *   `delete` resolve the tenant column via `tenantColumn(table)`, which THROWS if the registered table
 *   has no `tenantId` column. `insert` does NOT: it only calls `assertScoped(table)` and then stamps
 *   `{ ...v, tenantId }` — and Drizzle SILENTLY DROPS an unknown `tenantId` key. So registering a table
 *   that has NO tenant column (e.g. an identity-cluster table like `memberships` / `api_keys`) into the
 *   deny-by-default Set yields an UNSCOPED insert through the least-privilege handle — a real privilege-
 *   escalation class. `registerScopedTables` (tenant-db.ts) validates NOTHING before adding, so it is a
 *   footgun if reached from shipped code.
 *
 * WHAT THIS MODULE GUARANTEES.
 *   `registerProductStores` is the ONE sanctioned way a boot registers a deployment's product tables:
 *   it VALIDATES EVERY table BEFORE registering ANY (validate-all-then-add — a partial registration is
 *   impossible), then delegates ONCE to `registerScopedTables`. Every registered table must carry a
 *   real, correctly-shaped tenant predicate:
 *     1. its SQL name equals the map key (a swapped instance is caught);
 *     2. it HAS a `tenantId` column (this check ALONE closes the escalation — every global/auth table
 *        fails here, so `insert` can never reach an unscoped table through this door);
 *     3. the column is `tenant_id` / `PgUUID` / NOT NULL (the tenant column is really the tenant column,
 *        not a coincidentally-named field);
 *     4. it declares exactly ONE tenant-scoped FK (`['tenant_id'] → orgs.['id']`, ON DELETE CASCADE) —
 *        the same FK `generateProductSql`/`buildProductTables` inject;
 *     5. its name does not shadow a core/global platform table.
 *
 * HONEST LIMIT (read this before overselling it).
 *   This seals the SANCTIONED DOOR, not the Set. `registerScopedTables` stays reachable from
 *   `@rayspec/db/testing` (test/gate code only) and UNSEALED — a real Set seal would need a flag INSIDE
 *   the frozen-surface `tenant-db.ts`, which is out of scope here. The property this module actually ships is:
 *   `@rayspec/db/testing` is banned across `packages/**\/src` (biome `noRestrictedImports`) AND the
 *   `@rayspec/db/composition` subpath is banned in the scoped roots (biome + the tenant-chokepoint gate),
 *   so SHIPPED code cannot register a product table post-boot at all — only this validated door can, and
 *   `sealProductStores()` shuts it after the one boot registration (the CLI `deploy` owns its process and
 *   boots once). Check 2 is the load-bearing security invariant; checks 1/3/4/5 are defence-in-depth.
 *
 * Check 4 is written doc-first against drizzle-orm 0.45.2's introspection surface
 * (`getTableConfig().foreignKeys[].reference()` → `{ columns, foreignTable, foreignColumns }`,
 * `.onDelete`). `composition.fk.test.ts` fails loudly if a drizzle bump changes that shape, so a silent
 * FK-introspection regression cannot quietly weaken the check to a no-op.
 */
import { getTableColumns, getTableName } from 'drizzle-orm';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import {
  apiKeys,
  authAudit,
  CORE_TENANT_SCOPED_TABLES,
  memberships,
  oidcModels,
  orgs,
  sessions,
  users,
} from './schema.js';
import { registerScopedTables } from './tenant-db.js';

/** A fail-closed product-store registration defect (a table that must not join the chokepoint Set). */
export class ProductStoreCompositionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProductStoreCompositionError';
  }
}

/**
 * Core + global platform table names a product store must never shadow (check 5). Derived from the real
 * schema objects via `getTableName` (not hardcoded strings) so a rename in schema.ts cannot silently
 * desync this reserved set. The global/auth tables would already fail check 2 (no tenant column), but a
 * product store that DUPLICATES one of their NAMES would still collide at DDL time — so reject the name.
 */
const RESERVED_PLATFORM_TABLE_NAMES: ReadonlySet<string> = new Set(
  [
    ...CORE_TENANT_SCOPED_TABLES,
    orgs,
    users,
    memberships,
    sessions,
    apiKeys,
    authAudit,
    oidcModels,
  ].map((t) => getTableName(t as PgTable)),
);

/**
 * Module-local seal flag. `sealProductStores()` flips it; a subsequent `registerProductStores` throws.
 * This shuts the sanctioned door after the ONE boot registration (see the HONEST LIMIT above — it is a
 * door seal, not a Set seal). NEVER call `sealProductStores` from `assembleServer` (some tests boot it
 * twice per process via the `/testing` seam); the CLI `deploy` calls it after `assembleServer` returns.
 */
let sealed = false;

/** The narrow view of a Drizzle column this validator reads (name / SQL type / nullability). */
interface IntrospectedColumn {
  readonly name: string;
  readonly columnType: string;
  readonly notNull: boolean;
}

/**
 * Validate ONE product store, fail-closed. THROWS `ProductStoreCompositionError` on any violation; a
 * clean return means the table is safe to auto-scope through the tenant chokepoint. Pure (no I/O / no
 * mutation) so it is exhaustively unit-testable.
 */
export function validateProductStore(mapKey: string, table: PgTable): void {
  // 1. name coherence — the map key must equal the table's own SQL name (catch a swapped instance).
  const tableName = getTableName(table);
  if (tableName !== mapKey) {
    throw new ProductStoreCompositionError(
      `product store '${mapKey}' is registered under a map key that does not match its SQL table ` +
        `name '${tableName}' — a swapped/miskeyed instance. Fail-closed.`,
    );
  }

  // 2. THE load-bearing check: a tenant_id column must exist. Every global/auth table fails HERE, so
  //    `TenantDb.insert` (which only assertScoped()s, never tenantColumn()s) can never reach an
  //    unscoped table through this door — the escalation this module closes.
  const columns = getTableColumns(table) as unknown as Record<
    string,
    IntrospectedColumn | undefined
  >;
  const tenantCol = columns.tenantId;
  if (!tenantCol) {
    throw new ProductStoreCompositionError(
      `product store '${mapKey}' has NO tenant_id column — refusing to register an UNSCOPED table on ` +
        'the tenant chokepoint. TenantDb.insert would stamp a tenantId key that Drizzle silently drops, ' +
        'yielding an unscoped INSERT (the privilege-escalation class this registrar closes). Fail-closed.',
    );
  }

  // 3. the tenant column must really BE the tenant column: tenant_id / PgUUID / NOT NULL.
  if (tenantCol.name !== 'tenant_id') {
    throw new ProductStoreCompositionError(
      `product store '${mapKey}': the tenant column maps to SQL column '${tenantCol.name}', not ` +
        "'tenant_id'. Fail-closed.",
    );
  }
  if (tenantCol.columnType !== 'PgUUID') {
    throw new ProductStoreCompositionError(
      `product store '${mapKey}': tenant_id is '${tenantCol.columnType}', not a PgUUID (uuid). ` +
        'Fail-closed.',
    );
  }
  if (tenantCol.notNull !== true) {
    throw new ProductStoreCompositionError(
      `product store '${mapKey}': tenant_id is NULLABLE — the tenant predicate must be NOT NULL. ` +
        'Fail-closed.',
    );
  }

  // 4. it must declare exactly ONE tenant-scoped FK: (tenant_id) → orgs.(id) ON DELETE CASCADE. Filter
  //    to the FK(s) whose local column set is exactly [tenant_id] (a product→product FK is orthogonal
  //    to tenancy and allowed to coexist); there must be exactly one, correctly targeted.
  const foreignKeys = getTableConfig(table).foreignKeys;
  const tenantFks = foreignKeys.filter((fk) => {
    const cols = fk.reference().columns;
    return cols.length === 1 && cols[0]?.name === 'tenant_id';
  });
  if (tenantFks.length !== 1) {
    throw new ProductStoreCompositionError(
      `product store '${mapKey}': expected exactly ONE tenant FK on (tenant_id), found ` +
        `${tenantFks.length}. Fail-closed.`,
    );
  }
  const fk = tenantFks[0] as (typeof tenantFks)[number];
  const ref = fk.reference();
  if (getTableName(ref.foreignTable) !== getTableName(orgs)) {
    throw new ProductStoreCompositionError(
      `product store '${mapKey}': the tenant FK targets '${getTableName(ref.foreignTable)}', not ` +
        "'orgs' — the tenant predicate must reference the org root. Fail-closed.",
    );
  }
  if (ref.foreignColumns.length !== 1 || ref.foreignColumns[0]?.name !== 'id') {
    throw new ProductStoreCompositionError(
      `product store '${mapKey}': the tenant FK must reference orgs.(id), got ` +
        `(${ref.foreignColumns.map((c) => c.name).join(', ')}). Fail-closed.`,
    );
  }
  if (fk.onDelete !== 'cascade') {
    throw new ProductStoreCompositionError(
      `product store '${mapKey}': the tenant FK is ON DELETE ${fk.onDelete ?? '(none)'}, not ` +
        'CASCADE. Fail-closed.',
    );
  }

  // 5. the name must not shadow a core/global platform table (a product 'runs' would collide). Checked
  //    LAST — the security-critical tenant-predicate checks (2–4) come first, so a table that both
  //    lacks a tenant column AND shadows a name reports the escalation, not the cosmetic collision.
  if (RESERVED_PLATFORM_TABLE_NAMES.has(tableName)) {
    throw new ProductStoreCompositionError(
      `product store '${mapKey}' collides with a core/global platform table name — a product store ` +
        'must not shadow a platform table. Rename it. Fail-closed.',
    );
  }
}

/**
 * The SANCTIONED product-store registrar. VALIDATE-ALL-THEN-ADD: validate EVERY table (fail-closed) and
 * only then delegate ONCE to `registerScopedTables` — so a bad table in the middle of the set can never
 * leave a partial registration behind. Returns the `unregister()` thunk `registerScopedTables` returns
 * (removes exactly the tables THIS call added). Refuses after `sealProductStores()`.
 */
export function registerProductStores(tables: ReadonlyMap<string, PgTable>): () => void {
  if (sealed) {
    throw new ProductStoreCompositionError(
      'product stores are already sealed — registerProductStores after sealProductStores() is ' +
        'refused (the sanctioned door boots once). Fail-closed.',
    );
  }
  const validated: PgTable[] = [];
  for (const [mapKey, table] of tables) {
    validateProductStore(mapKey, table);
    validated.push(table);
  }
  return registerScopedTables(validated);
}

/**
 * Seal the sanctioned door: a subsequent `registerProductStores` throws. The CLI `deploy` calls this
 * AFTER `assembleServer` returns (it owns its process + boots once). This is a DOOR seal, not a Set seal
 * (see the HONEST LIMIT in the module header) — `registerScopedTables` on the `/testing` seam is
 * unaffected, but shipped code cannot import that seam (biome ban across packages/**\/src).
 */
export function sealProductStores(): void {
  sealed = true;
}
