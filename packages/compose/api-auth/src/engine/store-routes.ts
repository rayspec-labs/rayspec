/**
 * The `{ kind:'store', store, op }` route-action interpreter.
 *
 * CRUD over a materialized product store via the `TenantDb` chokepoint, INSIDE a
 * `forTenant(db, tenantId).transaction(...)` — is the FIRST production consumer of the
 * `app.current_tenant` GUC seam. Every DB touch runs in that transaction, so a
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
import {
  fkConstraintName,
  foreignKeyViolationConstraintName,
  forTenant,
  isForeignKeyViolation,
  isUniqueViolation,
  uniqueViolationConstraintName,
} from '@rayspec/db';
import type { StoreOp, StoreSpec } from '@rayspec/spec';
import { and, eq, getTableColumns, isNull, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { Context } from 'hono';
import type { AppDeps, AppEnv } from '../app-context.js';
import { readBoundedJson } from '../http/bounded-body.js';
import { principalActor } from './principal-actor.js';
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

/**
 * Build a TENANT-SAFE 400 for a store-write FOREIGN-KEY violation (Postgres 23503) on CREATE/UPDATE —
 * an inserted/updated row whose business-key FK column names a parent that does NOT exist (in THIS
 * tenant; the compound business-key FK is tenant-scoped, so a cross-tenant parent is invisible and
 * counts as absent). It is a 400 (not a 409) because it is a bad INPUT — the client supplied a value
 * that references nothing, exactly like a failed value-format check — not a concurrency conflict.
 *
 * The message NAMES the local FK column (derived from the constraint name, which is schema-only) and
 * says the referenced record does not exist — it NEVER echoes the offending value or any foreign row
 * data (mirroring `storeConflict`'s no-cross-tenant-existence-leak posture). The value lives on the
 * error's `detail` field, which the constraint-name extractor never reads.
 */
function storeFkViolation(store: StoreSpec, err: unknown): ApiError {
  const col = fkViolationColumn(store, err);
  const message = col
    ? `The referenced record for '${col}' does not exist.`
    : 'A referenced record does not exist.';
  return new ApiError('VALIDATION_ERROR', message);
}

/**
 * Resolve the local FK column NAME a 23503 names on a CREATE/UPDATE, or `undefined` (⇒ a generic
 * message). A create/update FK violation fires THIS store's own FK constraint, so its name
 * (`<store>_<col>_<parent>_<refcol>_fk`, derived from the SCHEMA — never a row value) reconstructs from
 * one of `store.foreignKeys` via the shared `fkConstraintName`. Returns that FK's local column.
 */
function fkViolationColumn(store: StoreSpec, err: unknown): string | undefined {
  const constraint = foreignKeyViolationConstraintName(err);
  if (!constraint) return undefined;
  const fk = store.foreignKeys.find((f) => fkConstraintName(store.name, f) === constraint);
  return fk?.column;
}

/**
 * A TENANT-SAFE 409 for a restrict-blocked mutation: a CHILD foreign key (with the default
 * `ON DELETE`/`ON UPDATE no action`) still references this row, so the parent cannot be `deleted` (a
 * restrict-blocked physical delete) OR `updated` (changing a parent's referenced unique key while a
 * child still points at the OLD value fires the child's `ON UPDATE no action`). It is a state CONFLICT
 * (409), not a bad-INPUT value (400). The message NAMES NO child table/column/value — a child
 * constraint is not in THIS store's FK set, and naming a foreign relationship could leak cross-tenant
 * existence (the same no-oracle posture as `storeConflict`). Shared by the delete + update branches so
 * their tenant-safe phrasing never drifts.
 */
function stillReferencedConflict(action: 'deleted' | 'updated'): ApiError {
  return new ApiError(
    'CONFLICT',
    `This record is still referenced by related records and cannot be ${action}.`,
  );
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
 * Resolve the injected `deleted_at` tombstone column object for an `isNull()` predicate. Every
 * materialized store carries `deleted_at` (the generator injects it); on a `softDelete` store it is
 * the tombstone the runtime writes on delete and filters `IS NULL` on every read/update.
 */
function deletedAtColumn(table: PgTable): Parameters<typeof eq>[0] {
  const col = (getTableColumns(table) as Record<string, unknown>).deletedAt;
  if (!col) {
    throw new ApiError('INTERNAL', 'Internal server error.');
  }
  return col as Parameters<typeof eq>[0];
}

/**
 * The single-row visibility predicate for get/update/delete: `id = :id`, AND — ONLY when the store
 * opts into soft delete — `deleted_at IS NULL`. So on a `softDelete` store a tombstoned row is
 * UNIFORMLY invisible (get → 404, update → 404) and the delete-path tombstone stamp matches only a
 * not-yet-tombstoned row (a 2nd delete → 404). On a NON-softDelete store (the default) it is EXACTLY
 * the id match — no `deleted_at` filtering, no behavioural change from the pre-soft-delete engine.
 * The tenant predicate is AND-combined downstream by the `TenantDb` chokepoint, never here.
 */
function visibleRowPredicate(store: StoreSpec, table: PgTable, id: string): SQL {
  const idMatch = eq(idColumn(table), id) as SQL;
  return store.softDelete ? (and(idMatch, isNull(deletedAtColumn(table))) as SQL) : idMatch;
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
    // Every store action runs inside the GUC transaction — read it back in a test to prove it.
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
            const rows = (await tx
              .select(table as never)
              .where(visibleRowPredicate(store, table, id))) as Record<string, unknown>[];
            const row = rows[0];
            // Cross-tenant, absent, OR (softDelete) tombstoned → zero rows → uniform 404 (the tenant
            // predicate is AND-combined by TenantDb; `deleted_at IS NULL` folds in for a softDelete store).
            if (!row) throw new ApiError('NOT_FOUND', 'Not found.');
            return c.json(serializeRow(store, row));
          }
          case 'create': {
            // Drain the body under the configured byte cap (413 pre-parse for an over-cap body),
            // then the same best-effort parse (an absent/invalid body ⇒ `{}` → the schema 400 below).
            const raw = await readBoundedJson(c, deps.maxJsonBodyBytes, {});
            // Accept snake_case OR camelCase per declared column (both variants → 400) before parse.
            const body = createSchema.parse(normalizeBodyCasing(store, raw)); // VALIDATION_ERROR on unknown/bad field
            const values = toDbValues(store, body as Record<string, unknown>);
            // Stamp the actor SERVER-SIDE (never client-settable — created_by is reserved + strict).
            // A JWT principal → `user:<userId>`; an API key → `key:<apiKeyId>` (there is no api-key NAME).
            // The SAME derivation the escape-hatch handler store facade uses (one shared helper).
            const actor = principalActor(c.get('principal'));
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
              // A business-key FK onto a NON-existent (or cross-tenant, hence invisible) parent → 23503
              // → a 400 VALIDATION_ERROR (bad input), tenant-safe. Detect → map → rethrow with NO further
              // in-tx statement (the 23503 poisoned the tx; the outer rollback is clean).
              if (isForeignKeyViolation(err)) throw storeFkViolation(store, err);
              throw err;
            }
            const row = inserted[0];
            if (!row) throw new ApiError('INTERNAL', 'Internal server error.');
            return c.json(serializeRow(store, row), 201);
          }
          case 'update': {
            const id = requireUuidId(c);
            // Drain the body under the configured byte cap (413 pre-parse for an over-cap body).
            const raw = await readBoundedJson(c, deps.maxJsonBodyBytes, {});
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
                .where(visibleRowPredicate(store, table, id))
                .returning()) as Record<string, unknown>[];
            } catch (err) {
              if (isUniqueViolation(err)) throw storeConflict(store, err, conflictKeys);
              if (isForeignKeyViolation(err)) {
                // Two distinct 23503 shapes reach here on UPDATE:
                //  (a) THIS store's OWN business-key FK column set to a NON-existent parent — bad
                //      INPUT → 400 (the constraint resolves to a LOCAL declared FK column, tenant-safe,
                //      names the column, never a foreign value); versus
                //  (b) a CHILD's `ON UPDATE no action` restrict — this store is the PARENT of a
                //      business-key FK and the client changed the referenced unique key while a child
                //      still points at the OLD value → a "still referenced" CONFLICT (409), NOT bad
                //      input. The child constraint is NOT in THIS store's FK set, so `fkViolationColumn`
                //      does not resolve it → fall to the 409 with the SAME tenant-safe phrasing the
                //      delete branch uses (naming no child/value — no cross-tenant existence oracle).
                if (fkViolationColumn(store, err) !== undefined) throw storeFkViolation(store, err);
                throw stillReferencedConflict('updated');
              }
              throw err;
            }
            const row = updated[0];
            // No row updated ⇒ cross-tenant/absent/(softDelete) tombstoned ⇒ uniform 404 (tenant
            // predicate AND-combined; a tombstoned row is uniformly invisible: a PATCH on it is a 404).
            if (!row) throw new ApiError('NOT_FOUND', 'Not found.');
            return c.json(serializeRow(store, row));
          }
          case 'delete': {
            const id = requireUuidId(c);
            if (store.softDelete) {
              // Soft delete (opt-in): STAMP the tombstone (`deleted_at = now`) via the EXISTING update
              // chokepoint instead of a physical delete — the row survives at the DB level but reads as
              // gone. `visibleRowPredicate` ANDs `deleted_at IS NULL`, so a row that is ALREADY
              // tombstoned (or absent, or cross-tenant) matches ZERO rows → uniform 404 — a 2nd delete
              // of the same row is a 404, exactly like get/update on a tombstoned row.
              const tombstoned = (await tx
                .update(table as never, { deletedAt: new Date() })
                .where(visibleRowPredicate(store, table, id))
                .returning()) as Record<string, unknown>[];
              if (!tombstoned[0]) throw new ApiError('NOT_FOUND', 'Not found.');
              // 204 No Content (uniform with the hard-delete path — no body leak).
              return c.body(null, 204);
            }
            // DEFAULT (softDelete falsy/undefined): a HARD physical delete — behaviourally IDENTICAL to
            // the pre-soft-delete engine (the row is physically gone, its freed sequence value reusable).
            // No `deleted_at` filtering happens anywhere on a non-softDelete store.
            // A child FK with onDelete:'restrict' that still references this row makes the physical
            // DELETE fail 23503 → a 409 CONFLICT (tenant-safe, generic): the row is still referenced by
            // related records. It is a 409 (not the create/update 400) because it is a state CONFLICT —
            // the parent cannot be removed while children point at it — not a bad-input value. Detect →
            // map → rethrow with NO further in-tx statement (the 23503 poisoned the tx; the rollback is
            // clean). The message names NO child table/column/value (a child constraint is not in THIS
            // store's FK set, and naming a foreign relationship could leak cross-tenant existence).
            let deleted: Record<string, unknown>[];
            try {
              deleted = (await tx
                .delete(table as never)
                .where(eq(idColumn(table), id))
                .returning()) as Record<string, unknown>[];
            } catch (err) {
              if (isForeignKeyViolation(err)) throw stillReferencedConflict('deleted');
              throw err;
            }
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
        // softDelete interaction (documented, deliberately simple): this replay read is keyed on the
        // PHYSICAL `(tenant, idempotency_key)` row and is NOT filtered by `deleted_at IS NULL`. So a
        // create RETRY whose original row was later soft-deleted still finds that (tombstoned) row and
        // REPLAYS it (200 + Idempotency-Replay) — idempotency tracks the physical creation event by key,
        // and the tombstoned row physically persists holding that key. This is consistent (the key maps
        // to exactly one creation) and needs no over-engineering: a genuinely NEW create uses a NEW key.
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
