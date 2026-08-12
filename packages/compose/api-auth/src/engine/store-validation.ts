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
 * are ISO strings; everything else passes through (jsonb is already a JS value). A route that
 * declares a `project` response projection re-keys/filters that shape through the resolved
 * projection map (store-projection.ts) — read side only, values untouched.
 *
 * This module is PRODUCT-AGNOSTIC: it derives everything from a `StoreSpec` at runtime — no product
 * table, column, or name is hard-coded. The platform stays product-free.
 */

import { ApiError } from '@rayspec/auth-core';
import type { ColumnType, StoreColumn, StoreSpec } from '@rayspec/spec';
import { z } from 'zod';
import { INJECTED_COLUMN_TS_NAMES, snakeToCamel } from './injected-columns-view.js';

/** The bigint JSON boundary: the widest magnitude a JSON number carries without losing an integer. */
const MAX_SAFE_BIG = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIG = BigInt(Number.MIN_SAFE_INTEGER);

/**
 * The `numeric` wire shape: a plain decimal string — optional sign, integer digits, optional
 * fractional digits. No exponent, no hex, no whitespace, no lone `.`: every accepted form is a
 * decimal literal whose EXACT value is legible from its digits (exactness is the point of the type;
 * a form that needs interpretation cannot be proven exact). The 1..1000 digit-run bounds cover the
 * whole Postgres numeric range (precision <= 1000) and keep an adversarial string away from any
 * unbounded scan. Serializes into the exported OpenAPI body schema as a `pattern`.
 */
const NUMERIC_WIRE_RE = /^-?\d{1,1000}(\.\d{1,1000})?$/;

/**
 * Does a NUMERIC_WIRE_RE-shaped decimal string FIT the declared numeric(precision, scale) without
 * Postgres changing a digit? Two counts, each against the declared parameters:
 *  - fractional digits AS WRITTEN must be <= scale — one more and Postgres would silently ROUND on
 *    insert (its numeric assignment cast rounds, it does not error), which is exactly the silent
 *    value change this platform refuses. Even all-zero excess digits are refused: the envelope is
 *    "at most `scale` fractional digits", one rule with no value-inspection carve-outs.
 *  - integer digits (leading zeros ignored — padding, not value) must be <= precision - scale, or
 *    the insert would fail 22003 AFTER commit-side effects; refused early with a clear message.
 */
function fitsNumericParams(value: string, precision: number, scale: number): boolean {
  const unsigned = value.startsWith('-') ? value.slice(1) : value;
  const dot = unsigned.indexOf('.');
  const intPart = dot === -1 ? unsigned : unsigned.slice(0, dot);
  const fracDigits = dot === -1 ? 0 : unsigned.length - dot - 1;
  if (fracDigits > scale) return false;
  const significantIntDigits = intPart.replace(/^0+/, '').length;
  return significantIntDigits <= precision - scale;
}

/**
 * Tolerant body-casing. The create/update Zod schemas key on the camelCase twin of each
 * declared column (`snakeToCamel(col.name)`). This normalizer lets a client send EITHER the camelCase
 * key (today's) OR the snake_case DECLARED name for a declared column: a snake key is renamed to its
 * camelCase twin BEFORE the strict Zod parse. A body carrying BOTH the snake AND the camel variant of
 * the SAME column is AMBIGUOUS → VALIDATION_ERROR (we refuse to silently pick a winner). Purely
 * additive: an all-camelCase body is returned unchanged, and a non-object body passes straight through
 * (the strict schema rejects it). Only DECLARED business columns are remapped — an injected/reserved key
 * (e.g. `created_by`) is left as-is, so `.strict()` still rejects it and it can never be smuggled in via
 * casing. Responses stay snake_case unless the route declares a `project` response projection
 * (serializeRow's projection arm) — the projection is READ-SIDE ONLY and never widens what this
 * normalizer (or the strict schemas) accepts: bodies key on the DECLARED column names, never on a
 * projected wire name.
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

/** Map a declared column to the Zod validator for a CREATE/UPDATE body value (parameter-aware:
 *  a `numeric` column's validator is built from its declared precision/scale). */
function zodForColumn(col: StoreColumn): z.ZodType {
  switch (col.type) {
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
    case 'bigint':
      // A bigint value crosses a JSON surface as a JSON NUMBER while its magnitude is at most
      // Number.MAX_SAFE_INTEGER; beyond that the write is refused rather than silently rounded. The
      // explicit .min/.max change no behaviour (a bare `.int()` already rejects 2**53 and already
      // exports the same JSON-Schema bounds) — they are written out because the bound IS the safety
      // story of this type and must be legible here rather than inherited from `.int()` semantics.
      // Honest limit: `JSON.parse` rounds an over-large integer literal BEFORE any validator runs,
      // so exactness on the wire is not achievable. The bound still holds, because every integer
      // literal above 2^53-1 parses to a value that is itself >= 2^53 and is therefore rejected here.
      return z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
    case 'boolean':
      return z.boolean();
    case 'jsonb':
      // Free-form JSON value (object/array/scalar) — the column is jsonb.
      return z.unknown();
    case 'double':
      // A JSON NUMBER — float8 IS IEEE-754 binary64, so JSON round-trips the value natively and the
      // float the client wrote is the float it reads back (the honest contract of this type is
      // float64 semantics, never a re-rounded decimal). NaN/±Infinity cannot appear in JSON, and
      // zod's z.number() additionally rejects them for any non-JSON caller of this schema —
      // fail-closed everywhere a double enters, never a silent null.
      return z.number();
    case 'numeric': {
      // A decimal STRING, both directions — never a JSON number. The honest limit is JSON.parse
      // itself: it maps every numeric literal through float64 BEFORE any validator runs, so a
      // decimal past float64 exactness (18+ significant digits) would arrive already corrupted,
      // indistinguishable from a value the author really meant — and exactness is the entire point
      // of numeric. A string survives JSON.parse byte-exactly, so it is the only wire form on which
      // exactness can be PROVEN, and a JSON number is refused rather than re-rendered. The value
      // must FIT the declared numeric(precision, scale): more fractional digits than `scale` would
      // silently ROUND in Postgres (refused instead — never rounded), more integer digits than
      // `precision - scale` would overflow (refused early with the declared shape in the message).
      const { precision, scale } = col;
      const base = z
        .string()
        .regex(
          NUMERIC_WIRE_RE,
          'must be a plain decimal string (optional sign, digits, optional fractional digits — no exponent)',
        );
      if (precision === undefined || scale === undefined) return base; // lint-unreachable; fail-safe shape-only
      return base.refine((v) => fitsNumericParams(v, precision, scale), {
        message:
          `must fit numeric(${precision}, ${scale}): at most ${scale} fractional digits and at ` +
          `most ${precision - scale} integer digits — refused rather than rounded`,
      });
    }
  }
}

/**
 * One business column wrapped for nullability (a nullable column also accepts JSON null). When a text
 * column declares an `enum` whitelist, the base validator is a `z.enum` of exactly those values instead
 * of a free `z.string()` — so a value outside the whitelist is a VALIDATION_ERROR (400) at THIS
 * create/update HTTP chokepoint. Lint guarantees `enum` only appears on `type:'text'` with a non-empty,
 * distinct member list, so the cast is sound.
 *
 * ENFORCEMENT SURFACE (honest scope — this `z.enum` is NOT the only enforcer): the same declared
 * whitelist is enforced on all THREE store write surfaces, so no path can persist an out-of-whitelist
 * value:
 *  - HTTP create/update — this `z.enum` (a value outside the whitelist is a 400 VALIDATION_ERROR);
 *  - the workflow `store.write` value-resolution path (`@rayspec/product-yaml` `makeStoreWriteNode`), so
 *    an agent's classification output cannot persist an out-of-whitelist value;
 *  - the low-level `HandlerDb` facade (`insert`/`upsert`/`update`) a custom escape-hatch TS handler
 *    writes through. The facade closes over Drizzle `PgTable`s (which carry no spec-level `enum`
 *    vocabulary), so the whitelist is supplied by object IDENTITY: `buildProductTables` records each
 *    store's declared column whitelists in the `@rayspec/db` enum-whitelist registry, and the facade's
 *    single insert/upsert/update value-mapper (`store-facade.ts` `toDbValues`) consults it and rejects a
 *    non-member value fail-closed — parity with the two declarative surfaces above.
 */
function columnSchema(col: StoreColumn): z.ZodType {
  const base =
    col.enum !== undefined ? z.enum(col.enum as [string, ...string[]]) : zodForColumn(col);
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
 * Convert ONE validated wire value to the value Drizzle expects for the column. Two conversions:
 * `timestamp` → a `Date` (the wire carries an ISO string; Drizzle's timestamp column wants a Date or
 * accepts the string, but we normalize to Date so the stored value is unambiguous), and `bigint` → a
 * `BigInt` (the wire carries a JSON number; drizzle's `{ mode: 'bigint' }` column maps a BigInt
 * through unchanged). Zod has already proved the bigint value is a SAFE integer, so the conversion
 * cannot throw. A plain number would also reach the column — but only via the driver's untyped-
 * parameter fallback, so we normalize and the value below Drizzle has exactly one representation.
 * Null passes through; all other types are already the right JS shape.
 */
function toDbValue(type: ColumnType, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (type === 'timestamp') return new Date(value as string);
  if (type === 'bigint') return BigInt(value as number);
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
 *  - Date → ISO string; BigInt → a JSON number, or a 400 when it cannot be one; a non-finite
 *    number (a NaN/Infinity float8 planted by SQL) → a 400, never a silent JSON null; everything
 *    else passes through (a numeric column's exact decimal string included, verbatim).
 * Tenant_id IS returned (it is the row's data; it is the caller's OWN tenant — resolveTenant already
 * matched it, so there is no cross-tenant leak: a row only reaches here if the tenant predicate
 * admitted it).
 *
 * THE READ-SIDE RANGE GUARD IS LOAD-BEARING and nothing in the compiler defends it — only the tests
 * that assert 400-rather-than-500. A value can reach an int8 column by a route other than the HTTP
 * write chokepoint (a hand-written migration, a direct SQL write, a facade write, or a column that was
 * `integer` before a reviewed type change), so this serializer is the last place the platform can
 * still tell an exactly-representable value from one it would have to round. It refuses instead. The
 * refusal is keyed on the VALUE SHAPE (`typeof value === 'bigint'`), not on a per-column type table,
 * so a BigInt arriving from any source is caught. Without it, the same request is a 500 from
 * `JSON.stringify` (which cannot serialize a BigInt) — loud, but an internal-fault claim for a value
 * the platform stored deliberately. The stated cost: ONE out-of-range row makes the whole LIST page
 * containing it a 400, and the filter bound means you cannot query for that row either — recovering
 * it is a SQL-level operation. That is the deliberate price of never returning a wrong number, which
 * is why the message names the column and the row id rather than the value.
 *
 * PROJECTION (`projection` — the resolved `snake → wire name` map from `resolveResponseProjection`,
 * threaded by the route that declared a `project`): each column's value is emitted under its WIRE
 * name, a column absent from the map is OMITTED (skipped BEFORE the range guards — nothing reaches
 * the wire, so there is nothing to refuse; the guard messages keep naming the column by its author
 * snake name either way). `undefined` (no `project` declared) keeps the historical path
 * byte-identically. DELIBERATE BOUNDARY the projection closes: the un-projected path passes an
 * UNKNOWN row key through raw (the `?? key` arm below — unreachable today, every row key is a
 * declared or injected column); a projected route serializes EXACTLY the resolved column set, so
 * an unknown key can never ride a projected response.
 */
export function serializeRow(
  store: StoreSpec,
  row: Record<string, unknown>,
  projection?: ReadonlyMap<string, string>,
): Record<string, unknown> {
  // camelCase → snake_case for every key we expose. Business columns: author names. Injected: known.
  const camelToSnake = new Map<string, string>();
  for (const col of store.columns) camelToSnake.set(snakeToCamel(col.name), col.name);
  for (const [snake, camel] of Object.entries(INJECTED_COLUMN_TS_NAMES)) {
    camelToSnake.set(camel, snake);
  }
  // Prototype-free accumulator on the PROJECTED path only: wire names are author-chosen (a name
  // like `__proto__` must land as a plain own-property, never a prototype mutation). The
  // un-projected path keeps its plain `{}` untouched (the byte-identity accept-control).
  const out: Record<string, unknown> = projection === undefined ? {} : Object.create(null);
  for (const [key, value] of Object.entries(row)) {
    const snake = camelToSnake.get(key) ?? key;
    // The wire name this column serializes under: its snake name (no projection — historical
    // behaviour, byte-identical), or the projection's resolved name; absent ⇒ omitted.
    const wireName = projection === undefined ? snake : projection.get(snake);
    if (wireName === undefined) continue;
    if (typeof value === 'bigint') {
      if (value > MAX_SAFE_BIG || value < MIN_SAFE_BIG) {
        throw new ApiError(
          'VALIDATION_ERROR',
          `Column '${snake}' holds a value outside the range this API represents as a JSON number ` +
            `(±9007199254740991) — row id ${String(row.id)}.`,
        );
      }
      out[wireName] = Number(value);
      continue;
    }
    // The double READ guard (same posture as the bigint guard above, keyed on VALUE SHAPE): a float8
    // column can hold NaN/±Infinity at the SQL level, but JSON cannot carry them —
    // `JSON.stringify(NaN)` is `null`, i.e. a SILENT substitution of a different value. A non-finite
    // number can only have arrived by a route other than the HTTP write path (the body validator
    // refuses it), so refuse here rather than let the response silently null it.
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new ApiError(
        'VALIDATION_ERROR',
        `Column '${snake}' holds a non-finite value (NaN/Infinity) JSON cannot represent — ` +
          `row id ${String(row.id)}.`,
      );
    }
    out[wireName] = value instanceof Date ? value.toISOString() : value;
  }
  return out;
}
