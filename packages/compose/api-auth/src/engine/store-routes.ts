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
import { buildListQuery, nextCursor } from './store-query.js';
import {
  createBodySchema,
  normalizeBodyCasing,
  serializeRow,
  toDbValues,
  updateBodySchema,
} from './store-validation.js';

/**
 * Idempotency-key replay sentinel: a store.create with an `Idempotency-Key` hit SOME unique index (23505). We do
 * NOT decide inside the tx which index fired — a store with a declared `unique` business column emits
 * that business index at a LOWER OID than the injected idempotency index, so an identical idempotent
 * RETRY reports the BUSINESS constraint first, not `<store>_idempotency_key_unique` (the pre-fix code
 * keyed the replay off that exact name and so replayed 200 for a keyless store but wrongly 409'd a
 * unique-column store). Instead, when a key is present ANY unique violation is a POSSIBLE replay: we
 * throw this from INSIDE the tx (an in-tx 23505 poisons the tx — we must NOT read the prior row in it),
 * carry the ORIGINAL error, and let the OUTER catch decide by reading whether a `(tenant, key)` row
 * actually exists — a row EXISTS ⇒ replay it (200 + Idempotency-Replay); NO row ⇒ the 23505 was a
 * GENUINE business-unique conflict on a NEW key ⇒ re-map to a 409 (via the carried `cause`).
 */
class IdempotencyReplayNeeded extends Error {
  constructor(
    readonly key: string,
    /** The original 23505 error — the outer catch re-maps it to a 409 when no `(tenant, key)` row exists. */
    override readonly cause: unknown,
  ) {
    super('idempotency-replay');
    this.name = 'IdempotencyReplayNeeded';
  }
}

/**
 * The `list` default page size AND hard cap (200). A page that fills to this cap signals
 * `X-Result-Truncated: true` and hands back an `X-Next-Cursor`; keyset pagination (`after=<cursor>`,
 * implemented in store-query.ts) then walks the remaining rows.
 */
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
 * the violated column ONLY when its index is TENANT-SCOPED (a compound `(tenant_id, col)` author-
 * `unique` index — the secure default, so naming it leaks nothing cross-tenant: a 23505 there is a
 * SAME-tenant duplicate, the caller's OWN row). A CONFLICT-KEY column (a GLOBAL single-column unique —
 * e.g. a product-profile `key` column, the durable `ON CONFLICT` target) is NEVER named: a global
 * unique can collide ACROSS tenants, so naming it would be a cross-tenant existence oracle — exactly
 * what `store-facade.ts`'s `sanitizeDbError` strips at the model boundary. Such a column falls to the
 * GENERIC message. `conflictKeys` is this store's conflict-key column set (threaded from the product
 * route-registration path via `deriveConflictKeys`); absent (a backend-profile store) ⇒ every author-
 * `unique` column is tenant-scoped, so any resolved column is safe to name.
 */
function storeConflict(
  store: StoreSpec,
  err: unknown,
  conflictKeys?: ReadonlySet<string>,
): ApiError {
  const col = conflictColumn(store, err, conflictKeys);
  const message = col
    ? `A record with this '${col}' already exists.`
    : 'A record with a conflicting unique value already exists.';
  return new ApiError('CONFLICT', message);
}

/**
 * Resolve the violated unique column NAME tenant-safely, or `undefined` (⇒ a generic message) if it
 * cannot be pinned to a TENANT-SCOPED declared business-unique column. Prefer the Postgres constraint
 * name (`<store>_<col>_unique`, derived from the schema — never a row value) mapped to a declared
 * `unique` column; when the error carries no constraint name, fall back to the single declared unique
 * column (unambiguous). A constraint that is NOT a declared business-unique index (e.g. the injected
 * PK) yields `undefined`. FINALLY, a resolved column that is a CONFLICT-KEY (in `conflictKeys` — a
 * GLOBAL single-column unique that can collide cross-tenant) also yields `undefined`, so a global-
 * unique column is NEVER named on the wire (no cross-tenant existence oracle). Absent `conflictKeys`
 * ⇒ name any resolved unique column (correct for a backend-profile store: every author-`unique` there
 * is tenant-scoped compound).
 */
function conflictColumn(
  store: StoreSpec,
  err: unknown,
  conflictKeys?: ReadonlySet<string>,
): string | undefined {
  const uniqueCols = store.columns.filter((c) => c.unique).map((c) => c.name);
  const constraint = uniqueViolationConstraintName(err);
  const candidate = constraint
    ? uniqueCols.find((name) => constraint === `${store.name}_${name}_unique`)
    : uniqueCols.length === 1
      ? uniqueCols[0]
      : undefined;
  // A conflict-key column is GLOBAL-unique → never name it (cross-tenant oracle); fall to generic.
  if (candidate !== undefined && conflictKeys?.has(candidate)) return undefined;
  return candidate;
}

/** Resolve the injected `id` PK column object for an `eq()` predicate on a runtime product table. */
function idColumn(table: PgTable): Parameters<typeof eq>[0] {
  const col = (getTableColumns(table) as Record<string, unknown>).id;
  if (!col) {
    throw new ApiError('INTERNAL', 'Internal server error.');
  }
  return col as Parameters<typeof eq>[0];
}

/** Resolve the injected `idempotency_key` column object for the replay-read `eq()` predicate. */
function idempotencyKeyColumn(table: PgTable): Parameters<typeof eq>[0] {
  const col = (getTableColumns(table) as Record<string, unknown>).idempotencyKey;
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
  /**
   * This store's CONFLICT-KEY columns (the GLOBAL single-column unique / durable `ON CONFLICT`
   * targets). A 23505 on one of these is NOT named in the 409 (a global unique can collide cross-tenant
   * → an existence oracle) — it falls to the generic message. Threaded ONLY from the product route-
   * registration path (`deriveConflictKeys`). Absent (backend-profile) ⇒ every author-`unique` column
   * is tenant-scoped, so any resolved unique column is safe to name.
   */
  conflictKeys?: ReadonlySet<string>;
}): (c: Context<AppEnv>) => Promise<Response> {
  const { store, table, op, deps, conflictKeys } = args;
  const createSchema = createBodySchema(store);
  const updateSchema = updateBodySchema(store);

  return async (c: Context<AppEnv>): Promise<Response> => {
    const tenantId = c.get('tenantId');
    // resolveTenant + requirePermission already established a tenant; defensive 404 if not.
    if (!tenantId) throw new ApiError('NOT_FOUND', 'Not found.');
    const tdb = forTenant(deps.db, tenantId);
    // Every store action runs inside the GUC transaction (A3) — read it back in a test to prove it.
    // A store.create idempotency-index collision throws IdempotencyReplayNeeded from INSIDE the tx
    // (a poisoned tx cannot read the prior row); we catch it OUTSIDE and REPLAY the prior row in a
    // fresh tenant-scoped read (200 + Idempotency-Replay: true, no duplicate, no 409).
    try {
      return await tdb.transaction(async (tx) => {
        switch (op) {
          case 'list': {
            // Equality filters + order + keyset pagination, all folded THROUGH the tenant
            // chokepoint (`and(tenantPredicate, extra)`) so NO query can cross tenants. Unknown params
            // fail closed (400). Default order is `id asc` (deterministic + keyset-stable).
            const { where, orderBy, limit, order } = buildListQuery(
              store,
              table,
              new URL(c.req.url).searchParams,
            );
            const rows = (await tx
              .select(table as never)
              .where(where)
              .orderBy(...orderBy)
              .limit(limit)) as Record<string, unknown>[];
            if (rows.length === limit) {
              // The page hit the cap — signal HONESTLY + hand back the opaque next-page cursor.
              c.header('X-Result-Truncated', 'true');
              const last = rows[rows.length - 1];
              const cursor = last ? nextCursor(order, last) : undefined;
              if (cursor) c.header('X-Next-Cursor', cursor);
            }
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
            // Accept snake_case OR camelCase per declared column (both variants → 400) before parse.
            const body = createSchema.parse(normalizeBodyCasing(store, raw)); // VALIDATION_ERROR on unknown/bad field
            const values = toDbValues(store, body as Record<string, unknown>);
            // Stamp the actor SERVER-SIDE (never client-settable — created_by is reserved + strict).
            // A JWT principal → `user:<userId>`; an API key → `key:<apiKeyId>` (there is no api-key NAME).
            const principal = c.get('principal');
            const actor =
              principal?.kind === 'user' && principal.userId
                ? `user:${principal.userId}`
                : principal?.apiKeyId
                  ? `key:${principal.apiKeyId}`
                  : undefined;
            if (actor) values.createdBy = actor;
            // Stamp the Idempotency-Key (absent ⇒ NULL ⇒ never collides — Postgres NULLs are distinct).
            // Replay is KEY-based (standard idempotency semantics): a repeat with the SAME
            // Idempotency-Key returns the ORIGINAL row (200 + Idempotency-Replay: true) REGARDLESS of the
            // body — a different body under the same key does NOT create a new row and does NOT error; the
            // outer catch reads the prior `(tenant, key)` row and replays it.
            const idemKey = c.req.header('idempotency-key');
            if (idemKey) values.idempotencyKey = idemKey;
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
              if (isUniqueViolation(err)) {
                // With an Idempotency-Key present, ANY unique violation is a POSSIBLE replay — we do
                // NOT key off the idempotency constraint NAME here (a lower-OID business `unique` index
                // fires FIRST on an identical retry, so a name check would miss it and wrongly 409). Signal
                // a REPLAY carrying the original error; the OUTER catch reads the prior `(tenant, key)` row
                // and decides: a row EXISTS ⇒ 200 replay; NO row ⇒ a GENUINE new-key conflict ⇒ 409.
                if (idemKey) throw new IdempotencyReplayNeeded(idemKey, err);
                throw storeConflict(store, err, conflictKeys);
              }
              throw err;
            }
            const row = inserted[0];
            if (!row) throw new ApiError('INTERNAL', 'Internal server error.');
            return c.json(serializeRow(store, row), 201);
          }
          case 'update': {
            const id = requireUuidId(c);
            const raw = await c.req.json().catch(() => ({}));
            // Tolerant casing (never touches created_by — not a declared column, stays reserved).
            const body = updateSchema.parse(normalizeBodyCasing(store, raw));
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
              if (isUniqueViolation(err)) throw storeConflict(store, err, conflictKeys);
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
    } catch (err) {
      // OUTSIDE the (rolled-back) tx, decide what the unique violation actually was. Read the prior
      // `(tenant, idempotency_key = err.key)` row in a FRESH tenant transaction (the read runs
      // in a tenant tx so it sets the `app.current_tenant` GUC — the same invariant every store touch
      // holds — so an external-exposure RLS policy binds to a populated GUC and this read never
      // fail-closes; a bare non-tx select would set no GUC).
      if (err instanceof IdempotencyReplayNeeded) {
        const rows = await forTenant(deps.db, tenantId).transaction(
          async (tx) =>
            (await tx
              .select(table as never)
              .where(eq(idempotencyKeyColumn(table), err.key))) as Record<string, unknown>[],
        );
        const row = rows[0];
        if (row) {
          // A `(tenant, key)` row EXISTS ⇒ this WAS an idempotent retry — replay the original row.
          c.header('Idempotency-Replay', 'true');
          return c.json(serializeRow(store, row), 200);
        }
        // NO `(tenant, key)` row ⇒ the 23505 was a GENUINE business-unique conflict on a NEW key (the
        // insert collided on a declared `unique` column, not on the idempotency index) ⇒ map to a 409,
        // preserving the tenant-safe conflict semantics for a new key hitting an existing business value.
        throw storeConflict(store, err.cause, conflictKeys);
      }
      throw err;
    }
  };
}
