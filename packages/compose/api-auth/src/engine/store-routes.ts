/**
 * The `{ kind:'store', store, op }` route-action interpreter.
 *
 * CRUD over a materialized product store via the `TenantDb` chokepoint, INSIDE a
 * `forTenant(db, tenantId).transaction(...)` — is the FIRST production consumer of the
 * `app.current_tenant` GUC seam (correction A3). Every DB touch runs in that transaction, so a
 * external-exposure hardening RLS policy binds to an already-populated GUC with zero call-site churn.
 *
 * Tenant safety: the tenant predicate is STRUCTURAL — TenantDb auto-injects
 * `eq(tenant_id, tenantId)` on select/update/delete and auto-stamps it on insert. Org B can never
 * list/get/update/delete org A's rows; a cross-tenant or absent id yields zero rows → a UNIFORM 404
 * (no existence leak — the closed ErrorCode envelope, reused verbatim). The id is the injected `id`
 * uuid PK.
 *
 * Body validation: create/update bodies are validated by a Zod schema DERIVED from the store's
 * declared columns (store-validation.ts) — strict, so an unknown/injected field is a VALIDATION_ERROR
 * and the server-controlled columns (id/tenant_id/created_at/…) are never client-settable.
 *
 * PRODUCT-AGNOSTIC: the store table object is resolved at runtime from the injected product-table
 * registry (AppDeps.productTables, keyed by declared store name) — no product table is referenced in
 * platform source. The platform main line ships a product-EMPTY registry.
 */

import { ApiError } from '@rayspec/auth-core';
import { forTenant, isUniqueViolation, uniqueViolationConstraintName } from '@rayspec/db';
import type { StoreOp, StoreSpec } from '@rayspec/spec';
import { eq, getTableColumns } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { Context } from 'hono';
import type { AppDeps, AppEnv } from '../app-context.js';
import {
  createBodySchema,
  serializeRow,
  toDbValues,
  updateBodySchema,
} from './store-validation.js';

/** A bounded default page size for `list` (capped at 200 in v0.1; keyset pagination deferred). */
export const STORE_LIST_LIMIT = 200;

/**
 * RFC-4122 uuid shape (case-insensitive) — the injected `id` PK column is a uuid. A `{id}` path param
 * is validated against this BEFORE the query so a malformed (non-uuid) id yields the SAME uniform 404
 * as an absent row (no 500 from a bad-uuid cast, no behavioural difference an attacker could probe).
 * Mirrors the shape db/tenant-db.ts UUID_SHAPE + store-validation.ts use; kept local (UUID_SHAPE is
 * not exported from @rayspec/db).
 */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Read the `:id` path param and assert it is a well-formed uuid. A missing OR malformed id is a
 * uniform `NOT_FOUND` (never a 500): the injected PK is a uuid, so a non-uuid id can never match a
 * row, and surfacing it as 404 keeps absent and malformed indistinguishable (no existence leak).
 */
function requireUuidId(c: Context<AppEnv>): string {
  const id = c.req.param('id');
  if (!id || !UUID_SHAPE.test(id)) throw new ApiError('NOT_FOUND', 'Not found.');
  return id;
}

/**
 * Build a TENANT-SAFE 409 for a store-write uniqueness violation (Postgres 23505). The message NAMES
 * the violated column but NEVER echoes the offending value or any foreign-tenant data. Post-S1 the
 * author-`unique` index is TENANT-SCOPED (compound `(tenant_id, col)`), so a 23505 on a store write is
 * a SAME-tenant duplicate — the caller's OWN row — and naming the column leaks nothing cross-tenant.
 */
function storeConflict(store: StoreSpec, err: unknown): ApiError {
  const col = conflictColumn(store, err);
  const message = col
    ? `A record with this '${col}' already exists.`
    : 'A record with a conflicting unique value already exists.';
  return new ApiError('CONFLICT', message);
}

/**
 * Resolve the violated unique column NAME tenant-safely, or `undefined` if it cannot be pinned to a
 * DECLARED business-unique column. Prefer the Postgres constraint name (`<store>_<col>_unique`, derived
 * from the schema — never a row value) mapped to a declared `unique` column; when the error carries no
 * constraint name, fall back to the single declared unique column (unambiguous). A constraint that is
 * NOT a declared business-unique index (e.g. the injected PK) yields `undefined` → a generic message.
 */
function conflictColumn(store: StoreSpec, err: unknown): string | undefined {
  const uniqueCols = store.columns.filter((c) => c.unique).map((c) => c.name);
  const constraint = uniqueViolationConstraintName(err);
  if (constraint) {
    return uniqueCols.find((name) => constraint === `${store.name}_${name}_unique`);
  }
  return uniqueCols.length === 1 ? uniqueCols[0] : undefined;
}

/** Resolve the injected `id` PK column object for an `eq()` predicate on a runtime product table. */
function idColumn(table: PgTable): Parameters<typeof eq>[0] {
  const col = (getTableColumns(table) as Record<string, unknown>).id;
  if (!col) {
    throw new ApiError('INTERNAL', 'Internal server error.');
  }
  return col as Parameters<typeof eq>[0];
}

/**
 * Build the Hono handler for one declared `{store, op}` route. The store table is resolved ONCE at
 * registration (boot) from the registry; the handler runs per request inside a tenant transaction.
 */
export function makeStoreHandler(args: {
  store: StoreSpec;
  table: PgTable;
  op: StoreOp;
  deps: AppDeps;
}): (c: Context<AppEnv>) => Promise<Response> {
  const { store, table, op, deps } = args;
  const createSchema = createBodySchema(store);
  const updateSchema = updateBodySchema(store);

  return async (c: Context<AppEnv>): Promise<Response> => {
    const tenantId = c.get('tenantId');
    // resolveTenant + requirePermission already established a tenant; defensive 404 if not.
    if (!tenantId) throw new ApiError('NOT_FOUND', 'Not found.');
    const tdb = forTenant(deps.db, tenantId);
    // Every store action runs inside the GUC transaction (A3) — read it back in a test to prove it.
    return tdb.transaction(async (tx) => {
      switch (op) {
        case 'list': {
          // Tenant-scoped list, capped at STORE_LIST_LIMIT (v0.1; keyset pagination deferred). When
          // the result hits the cap there MAY be more rows, so emit an HONEST signal rather than
          // silently truncating: `X-Result-Truncated: true` tells the caller the page was capped.
          const rows = (await tx
            .select(table as never)
            .all()
            .limit(STORE_LIST_LIMIT)) as Record<string, unknown>[];
          if (rows.length === STORE_LIST_LIMIT) c.header('X-Result-Truncated', 'true');
          return c.json(rows.map((r) => serializeRow(store, r)));
        }
        case 'get': {
          const id = requireUuidId(c);
          const rows = (await tx.select(table as never).where(eq(idColumn(table), id))) as Record<
            string,
            unknown
          >[];
          const row = rows[0];
          // Cross-tenant or absent → zero rows → uniform 404 (the tenant predicate is AND-combined).
          if (!row) throw new ApiError('NOT_FOUND', 'Not found.');
          return c.json(serializeRow(store, row));
        }
        case 'create': {
          const raw = await c.req.json().catch(() => ({}));
          const body = createSchema.parse(raw); // VALIDATION_ERROR on unknown/bad field (defaultHook/onError)
          const values = toDbValues(store, body as Record<string, unknown>);
          // TenantDb.insert auto-stamps tenant_id; id/created_at/region carry DB defaults.
          // A same-tenant uniqueness violation (23505) → 409 CONFLICT (tenant-safe), never a bare 500.
          // Detect → map → rethrow with NO further in-tx statement: the transaction rolls back cleanly
          // (an in-tx 23505 poisons the tx, so we never touch it again before the rollback).
          let inserted: Record<string, unknown>[];
          try {
            inserted = (await tx.insert(table as never, values).returning()) as Record<
              string,
              unknown
            >[];
          } catch (err) {
            if (isUniqueViolation(err)) throw storeConflict(store, err);
            throw err;
          }
          const row = inserted[0];
          if (!row) throw new ApiError('INTERNAL', 'Internal server error.');
          return c.json(serializeRow(store, row), 201);
        }
        case 'update': {
          const id = requireUuidId(c);
          const raw = await c.req.json().catch(() => ({}));
          const body = updateSchema.parse(raw);
          const values = toDbValues(store, body as Record<string, unknown>);
          // An empty update would be a no-op SET; reject so an empty PATCH is not a silent success
          // that returns a row the caller did not change (and so Drizzle does not emit an empty SET).
          if (Object.keys(values).length === 0) {
            throw new ApiError('VALIDATION_ERROR', 'Update body must set at least one field.');
          }
          // An update that sets a `unique` column to a value another same-tenant row holds is the same
          // 23505 → 409 CONFLICT (tenant-safe) as create; map it identically (no in-tx recovery).
          let updated: Record<string, unknown>[];
          try {
            updated = (await tx
              .update(table as never, values)
              .where(eq(idColumn(table), id))
              .returning()) as Record<string, unknown>[];
          } catch (err) {
            if (isUniqueViolation(err)) throw storeConflict(store, err);
            throw err;
          }
          const row = updated[0];
          // No row updated ⇒ cross-tenant/absent ⇒ uniform 404 (tenant predicate AND-combined).
          if (!row) throw new ApiError('NOT_FOUND', 'Not found.');
          return c.json(serializeRow(store, row));
        }
        case 'delete': {
          const id = requireUuidId(c);
          const deleted = (await tx
            .delete(table as never)
            .where(eq(idColumn(table), id))
            .returning()) as Record<string, unknown>[];
          if (!deleted[0]) throw new ApiError('NOT_FOUND', 'Not found.');
          // 204 No Content on a successful delete (uniform, no body leak).
          return c.body(null, 204);
        }
        default: {
          // Exhaustiveness: StoreOp is a closed union (list/get/create/update/delete). If a new op is
          // added to the grammar without a case here, this fails to typecheck (never) AND fail-closed
          // at runtime (INTERNAL, never a silent fall-through that returns undefined).
          const _exhaustive: never = op;
          throw new ApiError('INTERNAL', `Internal server error.${String(_exhaustive)}`);
        }
      }
    });
  };
}
