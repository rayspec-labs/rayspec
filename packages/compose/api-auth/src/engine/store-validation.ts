/**
 * Store request validation + row serialization for the declared-`api` store interpreter.
 *
 * A declared `{ kind:'store', store, op }` route's create/update body is validated by a Zod schema
 * DERIVED from the store's declared BUSINESS columns (the `StoreSpec.columns` the throwaway/deploy
 * author wrote). Two fail-closed properties:
 *   1. The schema is `.strict()` — an UNKNOWN field is rejected (VALIDATION_ERROR), so an attacker
 *      cannot smuggle an injected/server-controlled column (id, tenant_id, created_at, deleted_at,
 *      retention_days, region) into the row. Those columns are NEVER client-settable: the generator
 *      injects them, `tenantId` is auto-stamped by TenantDb, the rest carry DB defaults.
 *   2. Each column maps to a Zod type from the closed `ColumnType` vocabulary; `nullable` columns
 *      accept null; on CREATE a non-nullable column with no DB default is required, on UPDATE every
 *      field is optional (partial update) — but still typed + strict.
 *
 * The DB row (a Drizzle select result, keyed by the camelCase TS property the runtime table builder
 * uses) is serialized back to a snake_case JSON object keyed by the AUTHOR's declared names + the
 * injected columns, so the wire shape is the declared store, not Drizzle's internal casing. Dates
 * are ISO strings; everything else passes through (jsonb is already a JS value).
 *
 * This module is PRODUCT-AGNOSTIC: it derives everything from a `StoreSpec` at runtime — no product
 * table, column, or name is hard-coded. The platform stays product-free.
 */

import { ApiError } from '@rayspec/auth-core';
import type { ColumnType, StoreColumn, StoreSpec } from '@rayspec/spec';
import { z } from 'zod';
import { INJECTED_COLUMN_TS_NAMES, snakeToCamel } from './injected-columns-view.js';

/**
 * Tolerant body-casing. The create/update Zod schemas key on the camelCase twin of each
 * declared column (`snakeToCamel(col.name)`). This normalizer lets a client send EITHER the camelCase
 * key (today's) OR the snake_case DECLARED name for a declared column: a snake key is renamed to its
 * camelCase twin BEFORE the strict Zod parse. A body carrying BOTH the snake AND the camel variant of
 * the SAME column is AMBIGUOUS → VALIDATION_ERROR (we refuse to silently pick a winner). Purely
 * additive: an all-camelCase body is returned unchanged, and a non-object body passes straight through
 * (the strict schema rejects it). Only DECLARED business columns are remapped — an injected/reserved key
 * (e.g. `created_by`) is left as-is, so `.strict()` still rejects it and it can never be smuggled in via
 * casing. Responses stay snake_case (serializeRow is unchanged).
 */
export function normalizeBodyCasing(store: StoreSpec, raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const body = raw as Record<string, unknown>;
  const out: Record<string, unknown> = { ...body };
  for (const col of store.columns) {
    const snake = col.name;
    const camel = snakeToCamel(snake);
    if (snake === camel) continue; // single-word column: no snake/camel distinction
    const hasSnake = Object.hasOwn(out, snake);
    const hasCamel = Object.hasOwn(out, camel);
    if (hasSnake && hasCamel) {
      throw new ApiError(
        'VALIDATION_ERROR',
        `Ambiguous body: both '${snake}' and '${camel}' were provided for the same field.`,
      );
    }
    if (hasSnake) {
      out[camel] = out[snake];
      delete out[snake];
    }
  }
  return out;
}

/** Map a declared ColumnType to the Zod validator for a CREATE/UPDATE body value. */
function zodForColumn(type: ColumnType): z.ZodType {
  switch (type) {
    case 'text':
      return z.string();
    case 'uuid':
      // Accept any RFC-4122 uuid shape (case-insensitive); the DB enforces the real uuid type.
      return z
        .string()
        .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'must be a UUID');
    case 'timestamp':
      // ISO-8601 datetime string on the wire; coerced to a Date before insert (toDbValue).
      return z.iso.datetime({ offset: true });
    case 'integer':
      return z.number().int();
    case 'boolean':
      return z.boolean();
    case 'jsonb':
      // Free-form JSON value (object/array/scalar) — the column is jsonb.
      return z.unknown();
  }
}

/**
 * One business column wrapped for nullability (a nullable column also accepts JSON null). When a text
 * column declares an `enum` whitelist, the base validator is a `z.enum` of exactly those values instead
 * of a free `z.string()` — so a value outside the whitelist is a VALIDATION_ERROR at the create/update
 * chokepoint (server-side enforcement, 400), not merely an authoring convention. Lint guarantees `enum`
 * only appears on `type:'text'` with a non-empty, distinct member list, so the cast is sound.
 */
function columnSchema(col: StoreColumn): z.ZodType {
  const base =
    col.enum !== undefined ? z.enum(col.enum as [string, ...string[]]) : zodForColumn(col.type);
  return col.nullable ? base.nullable() : base;
}

/**
 * Build the CREATE-body Zod schema for a store: every declared business column, strict (unknown
 * field rejected). A non-nullable column is REQUIRED; a nullable column is optional (may be omitted
 * or sent as null). Injected/server-controlled columns are not in the shape, so a client that sends
 * one hits the strict unknown-key rejection.
 */
export function createBodySchema(store: StoreSpec): z.ZodObject {
  const shape: Record<string, z.ZodType> = {};
  for (const col of store.columns) {
    const camel = snakeToCamel(col.name);
    const s = columnSchema(col);
    shape[camel] = col.nullable ? s.optional() : s;
  }
  return z.object(shape).strict();
}

/**
 * Build the UPDATE-body Zod schema: like create but EVERY field optional (a partial update), still
 * typed + strict. An empty body is a valid no-op-ish update (the row's updated columns are none).
 */
export function updateBodySchema(store: StoreSpec): z.ZodObject {
  const shape: Record<string, z.ZodType> = {};
  for (const col of store.columns) {
    shape[snakeToCamel(col.name)] = columnSchema(col).optional();
  }
  return z.object(shape).strict();
}

/**
 * Convert ONE validated wire value to the value Drizzle expects for the column. The only conversion
 * is `timestamp` → a `Date` (the wire carries an ISO string; Drizzle's timestamp column wants a Date
 * or accepts the string, but we normalize to Date so the stored value is unambiguous). Null passes
 * through; all other types are already the right JS shape.
 */
function toDbValue(type: ColumnType, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (type === 'timestamp') return new Date(value as string);
  return value;
}

/**
 * Map a validated, camelCase-keyed body to the Drizzle insert/update values (camelCase keys, DB
 * types). Only declared business columns appear (strict validation already dropped unknowns); the
 * injected columns are never present (TenantDb stamps tenantId; the rest carry DB defaults).
 */
export function toDbValues(
  store: StoreSpec,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const typeByCamel = new Map(store.columns.map((c) => [snakeToCamel(c.name), c.type]));
  for (const [key, value] of Object.entries(body)) {
    const type = typeByCamel.get(key);
    if (type === undefined) continue; // defensive: strict schema already rejected unknown keys
    out[key] = toDbValue(type, value);
  }
  return out;
}

/**
 * Serialize a DB row (camelCase Drizzle keys) to the wire JSON the declared store exposes:
 *  - business columns → the AUTHOR's snake_case name;
 *  - injected columns → their snake_case name (id, tenant_id, created_at, deleted_at,
 *    retention_days, region);
 *  - Date → ISO string; everything else passes through.
 * Tenant_id IS returned (it is the row's data; it is the caller's OWN tenant — resolveTenant already
 * matched it, so there is no cross-tenant leak: a row only reaches here if the tenant predicate
 * admitted it).
 */
export function serializeRow(
  store: StoreSpec,
  row: Record<string, unknown>,
): Record<string, unknown> {
  // camelCase → snake_case for every key we expose. Business columns: author names. Injected: known.
  const camelToSnake = new Map<string, string>();
  for (const col of store.columns) camelToSnake.set(snakeToCamel(col.name), col.name);
  for (const [snake, camel] of Object.entries(INJECTED_COLUMN_TS_NAMES)) {
    camelToSnake.set(camel, snake);
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const snake = camelToSnake.get(key) ?? key;
    out[snake] = value instanceof Date ? value.toISOString() : value;
  }
  return out;
}
