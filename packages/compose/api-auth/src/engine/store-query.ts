/**
 * Query-power for the declarative `list` route (filters + order + keyset pagination).
 *
 * Derives a `WHERE`/`ORDER BY`/`LIMIT` from the request query string, PRODUCT-AGNOSTICally (from the
 * `StoreSpec` + the runtime `PgTable`, no product vocabulary). The result is folded into the tenant
 * chokepoint: the caller passes the built `extra` predicate to `scoped.select(table).where(extra)`, so
 * the tenant predicate stays STRUCTURAL (`and(tenantPredicate, extra)`) and can NEVER be dropped — a
 * filter/order/keyset from tenant B can never surface tenant A's rows.
 *
 * Fail-CLOSED: every query param must be a recognized control key (`order`/`after`/`limit`) OR a
 * filterable column (a declared business column, or the injected `created_by`). An UNKNOWN param is a
 * VALIDATION_ERROR (never silently ignored — a typo'd filter must not return the whole table).
 *
 * Deliberately NARROW: equality filters (AND-combined) only — no OR, no ranges, no full-text. Order is
 * a single `order=<col>.asc|desc`; the default is a deterministic `id asc` so keyset pagination is
 * stable. Keyset (`after=<opaque cursor>` + `limit`) compares `(order_col, id)` against the cursor in
 * the sort direction, so paging is correct even when the order column has duplicate values.
 *
 * ORDER COLUMNS ARE NON-NULLABLE ONLY: keyset pagination compares `(order_col, id)`
 * against the cursor's stored order value; a NULL order value makes `col > NULL` / `col = NULL`
 * never-true under SQL three-valued logic, so paging across a NULL boundary would silently DROP the
 * remaining rows. So `order` accepts ONLY non-nullable columns — the injected `id`/`created_at` (both
 * NOT NULL) and a declared business column that is NOT `nullable`. A `nullable` business column (and the
 * nullable injected `created_by`) is FILTERABLE but a 400 as an order column. `created_by` is therefore
 * FILTERABLE but NOT sortable.
 */

import { ApiError } from '@rayspec/auth-core';
import type { ColumnType, StoreSpec } from '@rayspec/spec';
import { and, asc, desc, eq, getTableColumns, gt, lt, or, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { snakeToCamel } from './injected-columns-view.js';

/** Case-insensitive RFC-4122 uuid shape (mirrors store-routes/store-validation; kept local). */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The reserved control params (everything else must be a filterable column, else fail-closed). Exported
 * so the OpenAPI emitter (emit-openapi.ts) can defensively skip a declared column of one of these names
 * when building per-column filter params — it already emits them as hard-coded control params, so a
 * same-named column would produce a DUPLICATE query parameter (an invalid OpenAPI 3.1 doc). The linter
 * (@rayspec/spec `RESERVED_QUERY_KEYWORDS`) rejects such a column at config; this skip is belt-and-braces
 * for a code-built spec that bypassed the parser.
 */
export const CONTROL_KEYS: ReadonlySet<string> = new Set(['order', 'after', 'limit']);

/** Bounded page size: 1..200, default 200 (the hard cap). */
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 200;

/** The injected columns that are FILTERABLE in addition to the declared business columns. */
const INJECTED_FILTERABLE: ReadonlyMap<string, ColumnType> = new Map([['created_by', 'text']]);
/**
 * Sortable injected columns — `id` + `created_at` ONLY, both NOT NULL (a deterministic, keyset-stable
 * order). The nullable injected `created_by` is deliberately NOT here: a NULL order value breaks keyset
 * pagination (see the file header) — it is FILTERABLE (above) but never an order column.
 */
const INJECTED_SORTABLE: ReadonlyMap<string, ColumnType> = new Map<string, ColumnType>([
  ['id', 'uuid'],
  ['created_at', 'timestamp'],
]);

/** The built query fragments to fold into the tenant-scoped select. */
export interface ListQuery {
  /** The AND-combined equality + keyset predicate (undefined ⇒ tenant predicate only). */
  where: SQL | undefined;
  /** The ORDER BY expressions (always includes the `id` tiebreaker for determinism). */
  orderBy: SQL[];
  /** The bounded row limit (1..200). */
  limit: number;
  /** The resolved order column (snake name) + direction — used to mint the next-page cursor. */
  order: { column: string; direction: 'asc' | 'desc'; type: ColumnType };
}

function validationError(message: string): never {
  throw new ApiError('VALIDATION_ERROR', message);
}

/** Resolve the runtime drizzle column for a snake_case declared/injected name (or throw). */
function drizzleColumn(table: PgTable, snake: string): PgColumn {
  const col = (getTableColumns(table) as Record<string, unknown>)[snakeToCamel(snake)];
  if (!col) validationError(`Unknown column '${snake}'.`);
  return col as PgColumn;
}

/** Coerce ONE query-string value to the typed value for an equality/keyset comparison (or 400). */
function coerceValue(type: ColumnType, name: string, raw: string): unknown {
  switch (type) {
    case 'text':
      return raw;
    case 'uuid':
      if (!UUID_SHAPE.test(raw)) validationError(`Filter '${name}' must be a UUID.`);
      return raw;
    case 'integer': {
      const n = Number(raw);
      if (!Number.isInteger(n)) validationError(`Filter '${name}' must be an integer.`);
      return n;
    }
    case 'boolean':
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      return validationError(`Filter '${name}' must be 'true' or 'false'.`);
    case 'timestamp': {
      const d = new Date(raw);
      if (Number.isNaN(d.getTime()))
        validationError(`Filter '${name}' must be an ISO-8601 datetime.`);
      return d;
    }
    case 'jsonb':
      return validationError(`Column '${name}' is not filterable.`);
  }
}

/** The opaque keyset cursor payload (base64url JSON). Binds to the exact order it was minted for. */
interface CursorPayload {
  /** order column (snake) it was minted for — a mismatch with the current order ⇒ 400. */
  c: string;
  /** order direction it was minted for. */
  d: 'asc' | 'desc';
  /** the last row's order-column value, in wire form (string/number/boolean). */
  v: string | number | boolean | null;
  /** the last row's `id` (uuid) tiebreaker. */
  id: string;
}

function encodeCursor(p: CursorPayload): string {
  return Buffer.from(JSON.stringify(p), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): CursorPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return validationError("Invalid 'after' cursor.");
  }
  if (parsed === null || typeof parsed !== 'object')
    return validationError("Invalid 'after' cursor.");
  const p = parsed as Record<string, unknown>;
  if (
    typeof p.c !== 'string' ||
    (p.d !== 'asc' && p.d !== 'desc') ||
    typeof p.id !== 'string' ||
    !UUID_SHAPE.test(p.id)
  ) {
    return validationError("Invalid 'after' cursor.");
  }
  return { c: p.c, d: p.d, v: p.v as CursorPayload['v'], id: p.id };
}

/**
 * Mint the next-page cursor from the LAST row of a full page (the row keys are camelCase drizzle
 * props). Returns undefined if the row is missing the order/id value (defensive — never happens for a
 * real row). The order-column value is encoded in WIRE form (a Date → ISO string) so decode is symmetric.
 */
export function nextCursor(
  order: ListQuery['order'],
  lastRow: Record<string, unknown>,
): string | undefined {
  const id = lastRow.id;
  if (typeof id !== 'string') return undefined;
  const rawVal = lastRow[snakeToCamel(order.column)];
  const v =
    rawVal instanceof Date
      ? rawVal.toISOString()
      : rawVal === null ||
          typeof rawVal === 'string' ||
          typeof rawVal === 'number' ||
          typeof rawVal === 'boolean'
        ? rawVal
        : String(rawVal);
  return encodeCursor({ c: order.column, d: order.direction, v, id });
}

/** Build the keyset predicate `(order_col, id) </> cursor` in the sort direction, folded with tiebreak. */
function keysetPredicate(table: PgTable, order: ListQuery['order'], cursor: CursorPayload): SQL {
  const idCol = drizzleColumn(table, 'id');
  const cmp = order.direction === 'asc' ? gt : lt;
  // The id tiebreaker alone when ordering BY id (no separate order column).
  if (order.column === 'id') {
    return cmp(idCol, cursor.id) as SQL;
  }
  const orderCol = drizzleColumn(table, order.column);
  const v = cursor.v === null ? null : coerceValue(order.type, order.column, String(cursor.v));
  // (order_col <cmp> v) OR (order_col = v AND id <cmp> cursorId).
  return or(cmp(orderCol, v), and(eq(orderCol, v), cmp(idCol, cursor.id))) as SQL;
}

/**
 * Parse `order=<col>.asc|desc`. `<col>` must be a NON-nullable declared business column or an injected
 * SORTABLE column (`id`/`created_at`); direction must be `asc`/`desc`. Default (absent) = `id asc`
 * (deterministic + keyset-stable). A NULLABLE declared business column is rejected 400: a NULL order
 * value breaks keyset pagination (never-true comparisons drop rows — see the file header).
 */
function parseOrder(store: StoreSpec, raw: string | null): ListQuery['order'] {
  if (raw === null) return { column: 'id', direction: 'asc', type: 'uuid' };
  const dot = raw.lastIndexOf('.');
  if (dot <= 0 || dot === raw.length - 1) {
    return validationError("Query 'order' must be '<column>.asc' or '<column>.desc'.");
  }
  const column = raw.slice(0, dot);
  const direction = raw.slice(dot + 1);
  if (direction !== 'asc' && direction !== 'desc') {
    return validationError("Query 'order' direction must be 'asc' or 'desc'.");
  }
  const business = store.columns.find((c) => c.name === column);
  if (business) {
    // A NULLABLE order column would make the keyset comparison drop rows across a NULL boundary — reject.
    if (business.nullable) {
      return validationError(
        `Query 'order' column '${column}' is nullable and cannot be used for ordering / keyset pagination.`,
      );
    }
    return { column, direction, type: business.type };
  }
  const injectedType = INJECTED_SORTABLE.get(column);
  if (injectedType === undefined) {
    return validationError(`Query 'order' column '${column}' is not sortable.`);
  }
  return { column, direction, type: injectedType };
}

/**
 * Build the `list` query fragments from the request search params. THROWS a VALIDATION_ERROR (400) on
 * any unknown param, malformed order/cursor, out-of-range limit, or a bad filter value — fail-closed.
 */
export function buildListQuery(
  store: StoreSpec,
  table: PgTable,
  params: URLSearchParams,
): ListQuery {
  // Filterable column → its ColumnType (declared business + injected created_by).
  const filterable = new Map<string, ColumnType>();
  for (const c of store.columns) filterable.set(c.name, c.type);
  for (const [name, type] of INJECTED_FILTERABLE) filterable.set(name, type);

  const order = parseOrder(store, params.get('order'));

  // --- limit ---
  let limit = DEFAULT_LIMIT;
  const rawLimit = params.get('limit');
  if (rawLimit !== null) {
    const n = Number(rawLimit);
    if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
      validationError(`Query 'limit' must be an integer between 1 and ${MAX_LIMIT}.`);
    }
    limit = n;
  }

  // --- equality filters (unknown param ⇒ fail-closed) ---
  const predicates: SQL[] = [];
  for (const [key, rawValue] of params) {
    if (CONTROL_KEYS.has(key)) continue;
    const type = filterable.get(key);
    if (type === undefined) validationError(`Unknown query parameter '${key}'.`);
    const col = drizzleColumn(table, key);
    predicates.push(eq(col, coerceValue(type, key, rawValue)) as SQL);
  }

  // --- keyset cursor (compared against (order_col, id) in the sort direction) ---
  const rawAfter = params.get('after');
  if (rawAfter !== null) {
    const cursor = decodeCursor(rawAfter);
    if (cursor.c !== order.column || cursor.d !== order.direction) {
      validationError("The 'after' cursor does not match the current 'order'.");
    }
    predicates.push(keysetPredicate(table, order, cursor));
  }

  // --- ORDER BY (order column, then the id tiebreaker — same direction — for determinism) ---
  const dir = order.direction === 'asc' ? asc : desc;
  const idCol = drizzleColumn(table, 'id');
  const orderBy: SQL[] =
    order.column === 'id'
      ? [dir(idCol) as SQL]
      : [dir(drizzleColumn(table, order.column)) as SQL, dir(idCol) as SQL];

  const where = predicates.length === 0 ? undefined : (and(...predicates) as SQL);
  return { where, orderBy, limit, order };
}
