/**
 * Query-power for the declarative `list` route (filters + order + keyset pagination).
 *
 * Derives a `WHERE`/`ORDER BY`/`LIMIT` from the request query string, PRODUCT-AGNOSTICally (from the
 * `StoreSpec` + the runtime `PgTable`, no product vocabulary). The result is folded into the tenant
 * chokepoint: the caller passes the built `extra` predicate to `scoped.select(table).where(extra)`, so
 * the tenant predicate stays STRUCTURAL (`and(tenantPredicate, extra)`) and can NEVER be dropped — a
 * filter/order/keyset from tenant B can never surface tenant A's rows.
 *
 * Fail-CLOSED: every query param must be a recognized control key (`order`/`after`/`limit`/`search`), a
 * filterable column (a declared business column, or the injected `created_by`), a `<col>__in` set
 * filter, or a `<col>__contains` substring filter on one such column. An UNKNOWN param is a
 * VALIDATION_ERROR (never silently ignored — a typo'd filter must not return the whole table).
 *
 * Deliberately NARROW: equality filters (`?col=v`, AND-combined) + a per-column set filter
 * (`?col__in=v1,v2,…` → SQL `IN`) + a case-insensitive substring search (`?search=term` matched over
 * EVERY text column as an OR; `?<col>__contains=term` on one text column), all folded into the SAME
 * AND-chain — no ranges, no relevance ranking. `search`/`__contains` escape the term's LIKE wildcards
 * (`%`/`_`) with an explicit `ESCAPE` clause so a term matches LITERALLY (never injects a wildcard). The
 * distinct `__in`/`__contains` SUFFIXES (not a bare `?col=a,b`) keep plain equality byte-identical and
 * unambiguous on a comma-bearing value, and a real column literally named `<x>__in`/`<x>__contains`
 * still takes precedence as plain equality. Order is a single `order=<col>.asc|desc`; the default is a
 * deterministic `id asc` so keyset pagination is stable. Keyset (`after=<opaque cursor>` + `limit`)
 * compares `(order_col, id)` against the cursor in the sort direction, so paging is correct even when
 * the order column has duplicate values.
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
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNull,
  lt,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
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
export const CONTROL_KEYS: ReadonlySet<string> = new Set(['order', 'after', 'limit', 'search']);

/** Bounded page size: 1..200, default 200 (the hard cap). */
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 200;

/**
 * The `<col>__in` set-filter suffix + its bounded element count. The distinct suffix (rather than a bare
 * `?col=a,b`) keeps plain equality byte-identical + unambiguous on a comma-bearing value. An oversized
 * set ⇒ 400 (a bound on the SQL `IN (…)` list size — a work/DoS guard, mirrors the `limit` cap).
 */
const IN_SUFFIX = '__in';
const MAX_IN_VALUES = 100;

/**
 * The substring-search control key + the per-column `__contains` suffix. `?search=term` runs a
 * case-insensitive substring match OR-combined across EVERY declared TEXT column; `?<col>__contains=term`
 * runs the SAME match on ONE named text column. Both fold into the SAME AND-chain as a single predicate,
 * so they compose with equality/`__in` filters, keyset pagination, and the tenant chokepoint. `search` is
 * a CONTROL_KEY (parsed like `order`/`after`/`limit`); `__contains`, being per-column, is parsed in the
 * filter loop alongside `__in`.
 */
const SEARCH_KEY = 'search';
const CONTAINS_SUFFIX = '__contains';

/**
 * The maximum length of a `?search=` / `?<col>__contains=` term. A caller-supplied substring feeds an
 * `ILIKE '%term%'` scan, so an unbounded term is a needless work/DoS lever (a multi-megabyte term makes
 * every row's pattern-match arbitrarily expensive) — bound it, mirroring the `limit`/`__in` caps. The
 * measure is Unicode CODE POINTS (`[...term].length`, which iterates by code point so a surrogate pair
 * counts as one), not UTF-16 units (`term.length`) or bytes: "256 characters" then means what a caller
 * intuitively sees, and a term of multibyte characters (CJK / emoji) is bounded by the same visible
 * count as an ASCII one rather than being throttled ~2–4× earlier on its byte/UTF-16 length.
 */
const MAX_SEARCH_TERM = 256;

/**
 * Escape a user term's LIKE metacharacters so a substring search matches them LITERALLY. Backslash-
 * escapes `%`, `_`, and the backslash escape char itself; the fragment then bracket-wraps the ESCAPED
 * term with the substring wildcards (`%…%`) and pairs it with an explicit `ESCAPE '\'` clause — so the
 * ONLY wildcards are the wrapping `%`, and a term containing `%`/`_` can never act as a wildcard.
 */
function escapeLikeTerm(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * A `col ILIKE '%term%' ESCAPE '\'` substring predicate. The `%…%` pattern is a BOUND parameter (never
 * string-concatenated into SQL); the escape char in the `ESCAPE` clause is the same backslash
 * `escapeLikeTerm` prefixes with, so `%`/`_`/`\` in the term match literally.
 */
function containsPredicate(col: PgColumn, term: string): SQL {
  return sql`${col} ilike ${`%${escapeLikeTerm(term)}%`} escape '\\'`;
}

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

  // --- filters: plain equality + the `<col>__in` set filter (unknown param ⇒ fail-closed) ---
  const predicates: SQL[] = [];
  for (const [key, rawValue] of params) {
    if (CONTROL_KEYS.has(key)) continue;
    // Precedence 1 — the FULL key is itself a declared filterable column (INCLUDING one literally named
    // `<x>__in`): plain equality, byte-identical to the pre-`__in` behaviour. A comma-bearing value on
    // such a column stays a single literal, never silently reinterpreted as a set — the fail-closed
    // reason `__in` is a distinct suffix rather than a bare `?col=a,b`.
    const directType = filterable.get(key);
    if (directType !== undefined) {
      const col = drizzleColumn(table, key);
      predicates.push(eq(col, coerceValue(directType, key, rawValue)) as SQL);
      continue;
    }
    // Precedence 2 — `<col>__in`: a set (IN) filter on a declared filterable column. Parse the value as
    // a comma-separated list, coerce EACH element with the SAME per-type coercion equality uses, and
    // fold `inArray(col, values)` into the SAME AND-chain (so it composes with equality filters + the
    // keyset predicate + the tenant chokepoint automatically). Fail-closed: an empty set / oversized set
    // / a non-filterable (jsonb) column / an unknown prefix column each 400.
    if (key.endsWith(IN_SUFFIX)) {
      const prefix = key.slice(0, -IN_SUFFIX.length);
      const inType = filterable.get(prefix);
      if (inType !== undefined) {
        const col = drizzleColumn(table, prefix);
        const parts = rawValue.split(',');
        if (parts.length > MAX_IN_VALUES) {
          validationError(`Filter '${key}' accepts at most ${MAX_IN_VALUES} values.`);
        }
        const values = parts.map((part) => {
          // A blank element (`?col__in=`, `?col__in=,,`, `a,,b`) is rejected: an empty IN set has no
          // meaning and an empty element is almost always a typo — fail-closed rather than guess.
          if (part === '') {
            validationError(`Filter '${key}' has an empty value in its comma-separated list.`);
          }
          return coerceValue(inType, key, part);
        });
        predicates.push(inArray(col, values) as SQL);
        continue;
      }
    }
    // Precedence 3 — `<col>__contains`: a case-insensitive SUBSTRING (ILIKE '%term%') filter on ONE
    // declared TEXT column, folded into the SAME AND-chain. Only text columns are searchable: a
    // `__contains` on a non-text filterable column (integer/uuid/…) 400s (substring match is undefined
    // for it), and an empty term 400s (a blank substring would match every row — almost certainly a
    // typo). An unknown prefix falls THROUGH to the fail-closed below (like `__in`). A column literally
    // named `<x>__contains` already won as plain equality at Precedence 1.
    if (key.endsWith(CONTAINS_SUFFIX)) {
      const prefix = key.slice(0, -CONTAINS_SUFFIX.length);
      const containsType = filterable.get(prefix);
      if (containsType !== undefined) {
        if (containsType !== 'text') {
          validationError(`Filter '${key}' requires a text column ('${prefix}' is not text).`);
        }
        if (rawValue === '') {
          validationError(`Filter '${key}' must not be empty.`);
        }
        if ([...rawValue].length > MAX_SEARCH_TERM) {
          validationError(`Filter '${key}' must be at most ${MAX_SEARCH_TERM} characters.`);
        }
        predicates.push(containsPredicate(drizzleColumn(table, prefix), rawValue));
        continue;
      }
    }
    // Precedence 4 — none of the above: fail-closed.
    validationError(`Unknown query parameter '${key}'.`);
  }

  // --- substring search: `?search=term` → a case-insensitive substring match OR-combined across EVERY
  // declared TEXT column, folded into the SAME AND-chain as ONE predicate (composes with equality/`__in`
  // filters, keyset pagination, and the tenant chokepoint). The term's LIKE wildcards are escaped (see
  // containsPredicate) so it matches literally. Fail-closed: an empty term 400s, and a store with NO
  // text column to search 400s (searching it can never match — a config/caller mistake, not a silent
  // empty result). `search` is a CONTROL_KEY, so the filter loop above skipped it. ---
  const rawSearch = params.get(SEARCH_KEY);
  if (rawSearch !== null) {
    if (rawSearch === '') {
      validationError("Query 'search' must not be empty.");
    }
    if ([...rawSearch].length > MAX_SEARCH_TERM) {
      validationError(`Query 'search' must be at most ${MAX_SEARCH_TERM} characters.`);
    }
    const textColumns = store.columns.filter((c) => c.type === 'text');
    if (textColumns.length === 0) {
      validationError("Query 'search' is not available: this store has no text columns to search.");
    }
    predicates.push(
      or(
        ...textColumns.map((c) => containsPredicate(drizzleColumn(table, c.name), rawSearch)),
      ) as SQL,
    );
  }

  // --- soft-delete tombstone filter (opt-in) ---
  // When the store opts into soft delete, fold `deleted_at IS NULL` into the predicate so `list` never
  // surfaces a tombstoned row — uniform with get/update/delete on a soft-deleted row. On a
  // non-softDelete store this is skipped entirely (no behavioural change). `deleted_at` is NOT a
  // filterable column (an explicit `?deleted_at=…` still fails closed above as an unknown param), so a
  // caller can never widen the list back to include tombstones.
  if (store.softDelete) {
    predicates.push(isNull(drizzleColumn(table, 'deleted_at')) as SQL);
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
