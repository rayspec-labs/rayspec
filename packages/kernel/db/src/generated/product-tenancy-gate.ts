/**
 * Reusable PRODUCT-TENANCY assertions — the parameterizable core the
 * CI cross-tenant gate runs over a GENERATED schema.
 *
 * The platform main line is product-EMPTY, so the cross-tenant gate cannot assert tenancy over a
 * real product table from `packages/db`. This module makes the assertion PARAMETERIZABLE over a
 * runtime-built product schema (`buildProductTables`) so a test/gate feeds it the THROWAWAY's
 * `notebooks`/`entries` and the assertion is NON-VACUOUS. It proves, for EVERY product table:
 *   (a) it has the tenant_id FK -> orgs ON DELETE CASCADE (introspected);
 *   (b) it is reachable via the REAL TenantDb chokepoint and a tenant predicate is enforced
 *       (tenant B never reads tenant A's rows through forTenant);
 *   (c) the cascade ACTUALLY removes product rows when the org is deleted.
 *
 * It exercises the REAL TenantDb machinery: the throwaway tables are registered into the real
 * deny-by-default Set via `withScopedTables` (a gate-only hook on tenant-db) for the duration of the
 * assertion — EXACTLY mirroring what a real deployment does (where the tables ARE in TENANT_SCOPED_
 * TABLES via the committed generated tuple). The platform baseline stays empty; the gate registers
 * at runtime only. The runtime tables are pinned to the generated SQL column-for-column by a
 * meta-test, so proving tenancy on them proves it for the committed generated source.
 */
import type { PgTable } from 'drizzle-orm/pg-core';
import type { Db } from '../client.js';
import { forTenant, withScopedTables } from '../tenant-db.js';

/** The introspection thunk (same shape as drift-detect). */
export type QueryFn = (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>;

export interface ProductTenancyResult {
  /** Per-table assertions that PASSED — MUST be non-empty for a non-vacuous gate. */
  asserted: string[];
}

/**
 * Assert tenancy for EVERY product table in `tables` against a live db (already migrated in
 * `schemaName`). Returns the list of tables asserted (non-empty for a real product schema) so the
 * caller can meta-assert non-vacuity.
 *
 * `seedRow(name, ctx)` returns a column->value record for one insert (the helper stamps tenant_id);
 * `parentOf(name)` gives a child's parent table so a product FK is satisfied (parent seeded first).
 */
export async function assertProductTenancy(args: {
  db: Db;
  schemaName: string;
  tables: Map<string, PgTable>;
  query: QueryFn;
  tenantA: string;
  tenantB: string;
  seedRow: (tableName: string, ctx: { parentId?: string }) => Record<string, unknown>;
  parentOf: (tableName: string) => string | undefined;
}): Promise<ProductTenancyResult> {
  const { db, schemaName, tables, query, tenantA, tenantB, seedRow, parentOf } = args;

  // Register the runtime product tables in the REAL deny-by-default Set for the assertion's scope.
  return withScopedTables([...tables.values()], async () => {
    const asserted: string[] = [];
    const tdbA = forTenant(db, tenantA);
    const tdbB = forTenant(db, tenantB);

    for (const [name, table] of tables) {
      // (a) tenant_id FK -> orgs ON DELETE CASCADE (introspected). The tenant_id FK is ALWAYS a
      // single-column FK (the injected predicate column), so matching on kcu.column_name='tenant_id'
      // is exact — no composite-FK ambiguity to disambiguate here (TEN-4). drift-detect's general FK
      // read is likewise single-column by construction (all generated FKs are 1-column).
      const fk = (await query(
        `SELECT ccu.table_name AS foreign_table_name, rc.delete_rule
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
           JOIN information_schema.constraint_column_usage ccu
             ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
           JOIN information_schema.referential_constraints rc
             ON tc.constraint_name = rc.constraint_name AND tc.table_schema = rc.constraint_schema
          WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1
            AND tc.table_name = $2 AND kcu.column_name = 'tenant_id'`,
        [schemaName, name],
      )) as { foreign_table_name: string; delete_rule: string }[];
      if (fk.length !== 1 || fk[0]?.foreign_table_name !== 'orgs') {
        throw new Error(`product-tenancy: ${name} missing tenant_id FK -> orgs`);
      }
      if (fk[0]?.delete_rule !== 'CASCADE') {
        throw new Error(`product-tenancy: ${name} tenant_id FK is not ON DELETE CASCADE`);
      }

      // (b) reachable via the REAL TenantDb chokepoint + tenant predicate enforced.
      const parentName = parentOf(name);
      const parentId = parentName
        ? await seedAndGetId(db, tables, parentName, tenantA, seedRow, undefined)
        : undefined;
      await seedAndGetId(db, tables, name, tenantA, seedRow, parentId);

      const aRows = await tdbA.select(table as never).all();
      const bRows = await tdbB.select(table as never).all();
      if (aRows.length < 1) throw new Error(`product-tenancy: ${name} not reachable for tenant A`);
      if (bRows.length !== 0)
        throw new Error(`product-tenancy: ${name} leaks A's rows to tenant B`);

      asserted.push(name);
    }

    // (c) cascade ACTUALLY removes product rows: delete tenant A's org -> A's product rows gone.
    await db.$client.unsafe(`DELETE FROM ${ident(schemaName)}.orgs WHERE id = $1`, [tenantA]);
    for (const name of tables.keys()) {
      const cnt = (await db.$client.unsafe(
        `SELECT count(*)::int AS c FROM ${ident(schemaName)}.${ident(name)} WHERE tenant_id = $1`,
        [tenantA],
      )) as unknown as { c: number }[];
      if (cnt[0]?.c !== 0) {
        throw new Error(`product-tenancy: ${name} rows NOT cascaded after org delete`);
      }
    }

    return { asserted };
  });
}

/** Insert one row through the REAL scoped TenantDb (auto-stamps tenant_id) and return its id. */
async function seedAndGetId(
  db: Db,
  tables: Map<string, PgTable>,
  name: string,
  tenantId: string,
  seedRow: (tableName: string, ctx: { parentId?: string }) => Record<string, unknown>,
  parentId: string | undefined,
): Promise<string> {
  const table = tables.get(name);
  if (!table) throw new Error(`product-tenancy: unknown table ${name}`);
  const values = seedRow(name, { parentId });
  const inserted = (await forTenant(db, tenantId)
    .insert(table as never, values)
    .returning()) as unknown as { id: string }[];
  const id = inserted[0]?.id;
  if (!id) throw new Error(`product-tenancy: insert into ${name} returned no id`);
  return id;
}

/** A conservative identifier guard for the unparameterizable schema/table name interpolations. */
function ident(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
    throw new Error(`product-tenancy: refusing unsafe identifier '${name}'`);
  }
  return name;
}
