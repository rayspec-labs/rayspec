/**
 * The store capability FACADE — builds the serializable-shaped `HandlerDb` (@rayspec/handler-sdk)
 * a handler receives, over the REAL `TenantDb` chokepoint.
 *
 * A handler does NOT receive a raw `TenantDb` (it could not — it cannot import a `PgTable`, and the
 * per-tenant isolate seam requires a serializable shape). Instead the engine builds THIS facade per run,
 * closing over `forTenant(db, tenantId)` + the deployment's declared product tables (name → PgTable),
 * and injects it as `HandlerInit.db`. The facade IS the trust boundary, so every rule below is
 * STRUCTURAL + fail-closed (each has a fail-the-fix test). Every call:
 *  - #1 references a store by its DECLARED NAME (string), resolved here ONLY against `productTables`
 *    (the deployment's declared product stores). An UNKNOWN name — or any auth/core table
 *    (`orgs`/`users`/`sessions`/`api_keys`/`memberships`/`runs`/`run_events`/`journal_steps`/
 *    `conversation_items`/`idempotency_keys`/`auth_audit`/`oidc_models`) — is a FAIL-CLOSED error:
 *    those tables are never in `productTables`, so they are unreachable through this facade;
 *  - #2 delegates to the real `TenantDb`, so the tenant predicate is STRUCTURAL (auto-injected on
 *    select/update/delete, auto-stamped on insert) — a handler can never read/write across tenants,
 *    EVEN IF it puts a foreign `tenant_id` in values (TenantDb overwrites it with the run's tenant;
 *    #3 below additionally rejects the key at the facade edge);
 *  - #3 REJECTS server-controlled/injected columns in insert/update VALUES (a handler may never SET
 *    `id`/`tenant_id`/`created_at`/`deleted_at`/`retention_days`/`region`);
 *  - #4 every filter/value key MUST be a real declared column (fail-closed on an unknown column);
 *    FILTERS are EQUALITY-ONLY in v0.1 (`{ col: value }` → AND-combined `eq`) — NO operators
 *    (>/</>=/<=/like/in); a richer filter grammar is a deliberate later spec-version decision;
 *  - exchanges only plain serializable rows / equality filters (the isolate-ready shape — except
 *    `transaction`, whose closure callback is an isolate design point, #5; see the method + the SDK header).
 *
 * SNAKE ↔ CAMEL: the spec/handler speak snake_case column names (the declared/wire shape); the
 * runtime `PgTable` keys columns by camelCase (the Drizzle builder). The facade maps both ways using
 * the SAME `snakeToCamel` rule the table builder + the api store interpreter use, so a handler's
 * `{ note_id }` filter lands on the `noteId` column and a returned row is keyed by snake_case.
 *
 * TRANSACTION BOUNDARY (the asymmetry, stated here AND enforced by who calls `transaction`):
 *  - a TOOL handler gets NO implicit outer transaction (the resolver builds its facade over a plain
 *    `TenantDb`; an agent fires several tools in parallel under the dispatch Semaphore, so wrapping
 *    would hold a DB tx across model latency). A tool that needs atomicity calls `db.transaction(...)`.
 *  - a ROUTE/TRIGGER handler's facade is built over a `TenantDb` ALREADY inside `.transaction()` (the
 *    GUC seam); `db.transaction(...)` there nests onto the same tenant-scoped tx.
 */
import {
  enumWhitelistFor,
  INJECTED_COLUMN_NAMES,
  isSoftDeleteTable,
  type TenantDb,
} from '@rayspec/db';
import type {
  HandlerDb,
  SelectOptions,
  StoreFilter,
  StoreRow,
  UpsertOptions,
} from '@rayspec/handler-sdk';
import {
  and,
  asc,
  count as countRows,
  desc,
  eq,
  getTableColumns,
  getTableName,
  inArray,
  isNull,
  type SQL,
} from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';

/**
 * A fail-closed INPUT-validation rejection at the store facade — a handler db call that names an
 * unknown column, sets a server-controlled column, passes a non-data/injection value, writes an
 * out-of-whitelist enum value, supplies an invalid date for a timestamp column, or requests an
 * out-of-range limit/offset. It is a CLIENT error (the request shape is invalid), NOT a server fault:
 * the api layer classifies it as HTTP 400 (an unhandled `Error` would otherwise surface as an
 * INTERNAL 500, misreporting a bad request as a server incident).
 *
 * Two messages, deliberately: `message` (Error.message) keeps the DETAILED text — naming the column,
 * the op, the guard — for local throw-site assertions and dev logs, and is NEVER sent to the client;
 * `publicMessage` is a GENERIC, non-leaking summary the api layer puts in the 400 envelope (never the
 * store's column list, the offending value, or a DB message). Keeping the two separate means the 400
 * response leaks nothing while the internal text stays available server-side.
 */
export class StoreInputError extends Error {
  /** A generic, non-leaking summary safe to return to the client (used for the 400 envelope). */
  readonly publicMessage: string;
  constructor(message: string, publicMessage: string) {
    super(message);
    this.name = 'StoreInputError';
    this.publicMessage = publicMessage;
  }
}

/**
 * snake_case → camelCase — the SAME transform `buildProductTables`/`generate-product-schema` apply
 * to column names (`note_id` → `noteId`). Re-derived here (one rule) so the facade's name
 * mapping matches the runtime table keys exactly; it cannot drift (the rule is trivial + shared by
 * construction with the db builder + the api interpreter's injected-columns-view).
 */
function snakeToCamel(snake: string): string {
  return snake.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

/** A `Date` → ISO string; everything else passes through (rows are plain serializable values). */
function serializeValue(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Resolve a runtime `PgTable` for a declared store NAME, fail-closed. An undeclared store is a
 * handler reaching for a table the spec never declared — refuse loudly (never silently no-op, never
 * fall through to an auth/core table).
 */
function resolveTable(productTables: ReadonlyMap<string, PgTable>, store: string): PgTable {
  const table = productTables.get(store);
  if (!table) {
    throw new Error(
      `HandlerDb: store '${store}' is not a declared product store (fail-closed) — a handler may ` +
        'only access stores declared in the spec, never an auth/core or unregistered table.',
    );
  }
  return table;
}

/**
 * Resolve a column NAME (snake or already-camel) to the runtime `PgColumn` object, FAIL-CLOSED on an
 * unknown column (refinement #4: a filter/value key MUST be a real declared column of that store —
 * never silently ignored). Used by both the filter path (any real column, incl. injected, is a valid
 * read predicate) and the values path (which additionally rejects server-controlled columns, below).
 */
function resolveColumn(table: PgTable, name: string): PgColumn {
  const cols = getTableColumns(table) as Record<string, PgColumn>;
  const camel = snakeToCamel(name);
  const col = cols[camel] ?? cols[name];
  if (!col) {
    throw new StoreInputError(
      `HandlerDb: column '${name}' is not a column of the store (fail-closed) — check the declared ` +
        'column name.',
      'The request references a column that does not exist on the target store.',
    );
  }
  return col;
}

/** True if a runtime PgColumn is a jsonb column (so a JSON-serializable object/array value is allowed). */
function isJsonbColumn(col: PgColumn): boolean {
  // Drizzle's jsonb column reports columnType 'PgJsonb' (+ dataType 'json'). Either match = jsonb.
  const c = col as unknown as { columnType?: string; dataType?: string };
  return c.columnType === 'PgJsonb' || c.dataType === 'json';
}

/**
 * True for a value that is ALWAYS a SQL-injection / non-data vector and must be rejected for EVERY
 * column type (scalar AND jsonb): a Drizzle `SQL` object (the real attack — forwarding it into
 * `eq()`/`.set()` injects raw SQL), a function, or a non-plain CLASS INSTANCE (prototype is not
 * Object/Array.prototype — e.g. a SQL/Param/Placeholder builder, a Buffer, a Map). A plain
 * Object/Array (literal data) is NOT a forbidden non-data value — whether it is ACCEPTED depends on
 * the column type (jsonb yes, scalar no), decided by the caller.
 */
function isForbiddenNonDataValue(value: unknown): boolean {
  if (typeof value === 'function') return true;
  // A Drizzle SQL object (and its kin) — detect by constructor name AND any `queryChunks`/`getSQL`
  // shape (a SQL object exposes `getSQL()`; the named-class check catches `SQL`/`Param`/`Placeholder`).
  const ctorName = (value as { constructor?: { name?: string } })?.constructor?.name;
  if (ctorName === 'SQL' || ctorName === 'Param' || ctorName === 'Placeholder') return true;
  if (typeof (value as { getSQL?: unknown })?.getSQL === 'function') return true;
  return false;
}

/** True if `value` is a PLAIN object/array (prototype is exactly Object.prototype / Array.prototype). */
function isPlainObjectOrArray(value: object): boolean {
  if (Array.isArray(value)) return true;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Assert a handler-supplied filter/insert/update VALUE is a valid DATA value for its column (SF-1, now
 * COLUMN-TYPE-AWARE — fixes SF1-JSONB-REGRESSION). The facade is the trust boundary:
 *  - EVERY column type rejects a Drizzle `SQL` object / function / non-plain class instance
 *    (`isForbiddenNonDataValue`) — the SQL-injection block SF-1 exists for, preserved verbatim;
 *  - a `jsonb` column ALSO accepts a JSON-serializable PLAIN Object/Array (free-form JSON) — matching
 *    the api write path (store-validation.ts `z.unknown()` for jsonb), so the facade is not stricter
 *    than the api path for the same column;
 *  - a NON-jsonb column accepts only a plain scalar (string/number/boolean/null/Date).
 * (`undefined` is "omitted" — it never reaches here from `Object.entries`.)
 */
function assertValidValue(col: PgColumn, where: string, name: string, value: unknown): void {
  if (value === null) return;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return;
  if (value instanceof Date) return;
  // From here `value` is an object/function/etc. A FORBIDDEN NON-DATA value is rejected for EVERY
  // column type (the SF-1 injection block): a function, a Drizzle SQL object, OR any non-plain value —
  // i.e. anything that is not a plain Object/Array (a class instance: Buffer/Map/SQL/Param/Date is
  // handled above/Evil/etc.). isForbiddenNonDataValue catches function + SQL by shape/name; the
  // not-a-plain-object check catches every OTHER class instance. Only a plain Object/Array survives.
  const isPlain = t === 'object' && isPlainObjectOrArray(value as object);
  if (isForbiddenNonDataValue(value) || !isPlain) {
    throw new StoreInputError(
      `HandlerDb: ${where} value for '${name}' is a forbidden non-data value (a Drizzle SQL object, ` +
        'a function, or a class instance) — a SQL-injection vector, rejected fail-closed (SF-1).',
      'A supplied value is not a permitted data value.',
    );
  }
  // A plain Object/Array is allowed ONLY for a jsonb column (free-form JSON, parity with the api path).
  if (isJsonbColumn(col)) return;
  throw new StoreInputError(
    `HandlerDb: ${where} value for '${name}' must be a plain scalar (string/number/boolean/null/Date)` +
      ` for a non-jsonb column — got ${Array.isArray(value) ? 'an array' : 'a non-plain object'} ` +
      '(only a `jsonb` column accepts a JSON object/array). Rejected fail-closed (SF-1).',
    'A supplied value is not a permitted data value.',
  );
}

/**
 * Build the AND-combined predicate for a filter (refinement #4). The v0.1 default is EQUALITY
 * (`{ column: value }` → `eq(column, value)`, multiple keys AND-combined) — still NO comparison
 * operators (>/</>=/<=/like); a richer operator grammar is a deliberate later spec-version decision.
 *
 * BATCHED `inArray` (the ONE additive form): a filter VALUE that is an ARRAY on a NON-jsonb column
 * is a SET-MEMBERSHIP filter — `inArray(column, value)` (a single `IN (…)` query, so a list handler
 * stops doing N+1 round-trips). COLUMN-TYPE-AWARE (a hard-won lesson): on a `jsonb` column an
 * array value is the VALUE ITSELF, so it is matched by EQUALITY (`eq`) — never `IN` — preserving legit
 * jsonb-array equality. Each `inArray` ELEMENT passes the SAME `assertValidValue` guard the scalar
 * path uses, so a crafted SQL/function/class element is rejected fail-closed (no injection through the
 * batched path).
 *
 * Each key is resolved fail-closed to a real column (#4); injected columns (e.g. `id`) ARE valid filter
 * keys (a read-by-id is legitimate). The tenant predicate is AND-combined by TenantDb BENEATH this, so a
 * filter can NEVER drop the tenant scope.
 */
function filterPredicate(table: PgTable, filter: StoreFilter | undefined): SQL | undefined {
  const entries = Object.entries(filter ?? {});
  if (entries.length === 0) return undefined;
  const preds = entries.map(([name, value]) => {
    const col = resolveColumn(table, name);
    // Read-shaping: an ARRAY value on a NON-jsonb column → batched set-membership (inArray); each element is
    // still SF-1-guarded. A jsonb column keeps eq (the array IS the value — do not break jsonb equality).
    if (Array.isArray(value) && !isJsonbColumn(col)) {
      for (const element of value) assertValidValue(col, 'filter', name, element);
      return inArray(col, value as unknown[]);
    }
    assertValidValue(col, 'filter', name, value);
    return eq(col, value);
  });
  return preds.length === 1 ? preds[0] : and(...preds);
}

/**
 * Resolve the injected `deleted_at` tombstone column of a store table (every materialized store injects
 * it — build-product-tables / the generator). Used ONLY for a `softDelete` store: to AND
 * `deleted_at IS NULL` into reads/updates + to stamp the tombstone on delete. Resolved the SAME way the
 * CRUD route does (`getTableColumns(table).deletedAt`).
 */
function deletedAtColumn(table: PgTable): PgColumn {
  const col = (getTableColumns(table) as Record<string, PgColumn>).deletedAt;
  if (!col) {
    throw new Error(
      'HandlerDb: soft-delete store table has no deleted_at column (internal invariant — every ' +
        'materialized store injects it).',
    );
  }
  return col;
}

/**
 * For a `softDelete` store, AND `deleted_at IS NULL` into the caller-side predicate so a tombstoned row
 * is UNIFORMLY invisible to the handler read/write surface (declarative views, workflow
 * store_read/store_write nodes, tool/route/trigger handlers) — the SAME contract the CRUD routes +
 * list-query already enforce, so a view/workflow/handler read never resurfaces a tombstoned row. For the
 * default (hard-delete) store this returns `pred` UNCHANGED (byte-behaviourally identical to the
 * pre-soft-delete facade). It ONLY ADDS an AND-term to the caller-side predicate; the STRUCTURAL tenant
 * predicate is AND-combined BENEATH this by the TenantDb chokepoint and is never touched here.
 */
function visiblePredicate(table: PgTable, pred: SQL | undefined): SQL | undefined {
  if (!isSoftDeleteTable(table)) return pred;
  const notDeleted = isNull(deletedAtColumn(table));
  return pred === undefined ? notDeleted : (and(pred, notDeleted) as SQL);
}

/** True if a runtime PgColumn is a timestamp column (so an ISO-string value is coerced to Date). */
function isTimestampColumn(col: PgColumn): boolean {
  // Drizzle's timestamp column reports columnType 'PgTimestamp' (+ dataType 'date'). Check both for
  // resilience across minor drizzle versions; either match means "coerce a string value to a Date".
  const c = col as unknown as { columnType?: string; dataType?: string };
  return c.columnType === 'PgTimestamp' || c.dataType === 'date';
}

/** The injected/server-controlled columns (camelCase) a handler may never SET (platform-managed). */
const SERVER_CONTROLLED_CAMEL: ReadonlySet<string> = new Set(
  INJECTED_COLUMN_NAMES.map((snake) => snakeToCamel(snake)),
);

/**
 * Map a snake_case-keyed insert/update VALUES object to the camelCase Drizzle keys — FAIL-CLOSED on
 * BOTH (refinements #3 + #4, the facade IS the trust boundary so these THROW, not silently drop):
 *  - #4: an UNKNOWN column key (not a real column of this store) → throw (a handler typo / a stray
 *        field is a loud error, never a silently-ignored write).
 *  - #3: a SERVER-CONTROLLED/injected column (`id`/`tenant_id`/`created_at`/`deleted_at`/
 *        `retention_days`/`region`) → throw (a handler may never SET these — they are platform-
 *        managed: `tenant_id` is auto-stamped by TenantDb, `id`/timestamps carry DB defaults). This
 *        is defense-in-depth ON TOP OF #2 (even if one slipped through, TenantDb still stamps the
 *        run's tenant — see the tenant-db tests); here we reject it at the facade edge.
 * Injected columns are allowed in a FILTER (a read predicate) but NOT in VALUES (a write) — the split
 * is intentional: you may read-by-id, you may not set the id/tenant.
 */
function toDbValues(
  table: PgTable,
  values: StoreRow,
  op: 'insert' | 'update',
): Record<string, unknown> {
  const cols = getTableColumns(table) as Record<string, PgColumn>;
  // The store's declared column `enum` value whitelists (undefined for a no-enum store → no extra
  // check). Resolved once per call by table identity (build-product-tables recorded it).
  const enumWhitelist = enumWhitelistFor(table);
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(values)) {
    const camel = snakeToCamel(name);
    const key = camel in cols ? camel : name in cols ? name : undefined;
    if (key === undefined) {
      throw new StoreInputError(
        `HandlerDb: ${op} into the store names column '${name}', which is not a declared column ` +
          '(fail-closed) — a handler may only write declared business columns.',
        'The request references a column that does not exist on the target store.',
      );
    }
    if (SERVER_CONTROLLED_CAMEL.has(key)) {
      throw new StoreInputError(
        `HandlerDb: ${op} may not set server-controlled column '${name}' (id/tenant_id/created_at/` +
          'deleted_at/retention_days/region are platform-managed — tenant_id is auto-stamped, the ' +
          'rest carry DB defaults). Remove it from the values (fail-closed, refinement #3).',
        'The request may not set a server-managed column.',
      );
    }
    // SF-1 (column-type-aware): reject a Drizzle SQL object / function / class instance for EVERY
    // column (the injection block); a jsonb column additionally accepts a JSON object/array (parity
    // with the api write path); a non-jsonb column accepts only a plain scalar.
    assertValidValue(cols[key] as PgColumn, op, name, value);
    // ENUM WHITELIST: if the store declared an `enum` value whitelist for this column, reject any
    // written value that is not one of the declared members — the SAME server-side whitelist the HTTP
    // create/update route (store-validation, a `z.enum`) and the workflow store.write node enforce, so a
    // low-level escape-hatch handler writing directly through this facade cannot persist an
    // out-of-whitelist value (closing the parity gap the two declarative surfaces already cover). The
    // `enum` vocabulary is lint-restricted to `type:'text'`, so a declared member is always a STRING; a
    // NON-STRING resolved value (a number/boolean) is by definition NOT a member and is rejected here
    // regardless of JS type — matching the declarative paths, and closing the scalar-non-string bypass
    // the scalar-accepting SF-1 guard above does NOT catch. null/undefined is a nullability concern
    // (deferred to the column's NOT NULL / nullable enforcement, mirroring the HTTP `z.enum().nullable()`
    // posture — not an out-of-whitelist VALUE). The message names the store + column ONLY, never the
    // offending value (no cross-tenant value oracle).
    if (enumWhitelist) {
      const allowed = enumWhitelist.get((cols[key] as PgColumn).name);
      const isMember = typeof value === 'string' && allowed?.has(value) === true;
      if (allowed && value !== null && value !== undefined && !isMember) {
        throw new StoreInputError(
          `HandlerDb: ${op} value for column '${name}' of store '${getTableName(table)}' is not one ` +
            'of the declared allowed values — rejected fail-closed (the enum whitelist is enforced on ' +
            'this handler write path, parity with the HTTP route and the workflow store.write node).',
          'A supplied value is not one of the permitted values for its column.',
        );
      }
    }
    // SF-2: the SDK contract is "plain serializable rows", which includes ISO-string timestamps. A
    // timestamp column's driver mapper expects a Date, so coerce a string → Date here (and reject an
    // invalid date fail-closed). A Date passes through; null passes through. (jsonb passes through.)
    out[key] = coerceForColumn(cols[key] as PgColumn, name, value, op);
  }
  return out;
}

/** Coerce a write value for its column: a timestamp column accepts an ISO string → Date (SF-2). */
function coerceForColumn(col: PgColumn, name: string, value: unknown, op: string): unknown {
  if (value === null) return null;
  if (isTimestampColumn(col) && typeof value === 'string') {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) {
      // A malformed timestamp value is a CLIENT input error (a bad request shape), not a server fault:
      // throw a StoreInputError so the api layer returns HTTP 400, uniform with the other facade input
      // guards. The detailed text (column + offending value) stays on the internal `message` (logs /
      // throw-site assertions); the client sees only the GENERIC publicMessage.
      throw new StoreInputError(
        `HandlerDb: ${op} value for timestamp column '${name}' is not a valid date: ` +
          `${JSON.stringify(value)} (fail-closed, SF-2).`,
        'A supplied value is not a valid date.',
      );
    }
    return d;
  }
  return value;
}

/**
 * limit/offset guard: validate a `select` `limit`/`offset` BEFORE it reaches drizzle. An unvalidated value is a
 * FAIL-OPEN hazard — a negative / NaN `limit` makes drizzle SILENTLY DROP the LIMIT clause (returns ALL
 * tenant rows, a quiet over-read), and a negative `offset` emits a raw DB error. Require a NON-NEGATIVE
 * INTEGER (throwing the same shape resolveColumn/coerceForColumn do). `0` is VALID — `LIMIT 0` returns 0
 * rows, `OFFSET 0` is a no-op — so it is intentionally NOT rejected.
 */
function assertNonNegativeInt(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    // An out-of-range limit/offset is CLIENT-supplied bad input (a bad request shape), not a server
    // fault: throw a StoreInputError so the api layer returns HTTP 400, uniform with the other facade
    // input guards. The detailed text (which field + offending value) stays on the internal `message`;
    // the client sees only the GENERIC publicMessage.
    throw new StoreInputError(
      `HandlerDb: select '${field}' must be a non-negative integer (got ${JSON.stringify(value)}) — ` +
        'a negative/NaN value would silently drop the clause or raise a raw DB error. Rejected ' +
        'fail-closed.',
      'A supplied pagination value is not a permitted value.',
    );
  }
}

/**
 * True if a DB error is a Postgres UNIQUE-violation (SQLSTATE 23505). The driver (postgres.js v3.4.9)
 * surfaces the SQLSTATE on a `PostgresError.code` (`Object.assign(this, x)` with the wire message, whose
 * `code` field is the SQLSTATE). DRIZZLE 0.45.2 then WRAPS that in a `DrizzleQueryError` (message
 * `Failed query: …`) whose `.cause` is the original `PostgresError` — the WRAPPER itself carries NO
 * `code`. So we detect STRUCTURALLY (a `code === '23505'`) by WALKING the `.cause` chain (bounded depth,
 * cycle-safe), matching whether the raw driver error or the drizzle wrapper is thrown — independent of
 * the message text. (Doc-first verified against the installed drizzle-orm@0.45.2 + postgres@3.4.9.)
 */
function isUniqueViolation(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur != null; depth++) {
    if (typeof cur === 'object' && (cur as { code?: unknown }).code === '23505') return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Sanitize a DB error before it can cross the facade boundary back to a (model-facing) handler
 * (security hygiene). A raw 23505 names the violated constraint — `duplicate key value violates unique
 * constraint "<store>_<col>_unique"` — which is a CROSS-TENANT EXISTENCE ORACLE (it reveals that another
 * tenant holds a value on a GLOBAL unique). Re-throw a NEUTRAL error carrying NO constraint/column name.
 * Every NON-unique error is returned UNCHANGED.
 *
 * CONCURRENCY-FIX: this ONLY sanitizes the MESSAGE + rethrows — it NEVER "recovers" from an
 * in-transaction 23505 by re-reading/retrying (an in-tx 23505 poisons the tx). The caller/tx sees a
 * (now-neutral) error exactly as before, just without the leaked constraint name — fail-closed.
 *
 * SQLSTATE PRESERVED (regression fix): the neutral Error carries `code === '23505'` as a
 * NON-ENUMERABLE property. `err.code === '23505'` (DIRECT access) lets in-handler SAVEPOINT-recovery
 * (chunk-ingest et al. — they detect the concurrent-same-index race via `err.code`/`err.cause?.code`)
 * still recognize + recover the race instead of 500ing. NON-enumerable means a `JSON.stringify(err)` at
 * the model boundary CANNOT expose it, and `String(err)` is just the neutral message — so the raw
 * constraint NAME (the cross-tenant existence oracle the sanitize exists to hide) still never
 * reaches the model. (We preserve only the SQLSTATE, never the constraint/column name.)
 */
function sanitizeDbError(err: unknown): unknown {
  if (!isUniqueViolation(err)) return err;
  const sanitized = new Error('unique constraint violation');
  Object.defineProperty(sanitized, 'code', {
    value: '23505',
    enumerable: false,
    configurable: true,
  });
  return sanitized;
}

/** Serialize a Drizzle row (camelCase keys) back to a snake_case-keyed `StoreRow` for the handler. */
function serializeRow(table: PgTable, row: Record<string, unknown>): StoreRow {
  // Build camel→snake from the table's columns (the column's `.name` is the snake SQL name).
  const cols = getTableColumns(table) as Record<string, PgColumn>;
  const camelToSnake = new Map<string, string>();
  for (const [camel, col] of Object.entries(cols)) camelToSnake.set(camel, col.name);
  const out: StoreRow = {};
  for (const [key, value] of Object.entries(row)) {
    out[camelToSnake.get(key) ?? key] = serializeValue(value);
  }
  return out;
}

/**
 * Stamp the injected `created_by` actor column from the ROUTE-CONTEXT principal — un-spoofable, and
 * exactly the same server-side stamp the declarative store.create path applies. A handler can never
 * SUPPLY `created_by`: it is a server-controlled column that `toDbValues` rejects (#3), so this facade
 * is the SOLE writer of the value and the route actor always wins. No-op when no actor is bound (a tool
 * or trigger handler, and every pre-existing 2-arg caller) OR the target store carries no `created_by`
 * column, so the prior behavior is byte-identical. Stamped ONLY on the create ops (insert + the insert
 * arm of upsert), never on update — `created_by` is create-only (immutable after creation).
 */
function stampCreatedBy(
  table: PgTable,
  dbValues: Record<string, unknown>,
  actor: string | undefined,
): void {
  if (actor === undefined) return;
  const cols = getTableColumns(table) as Record<string, PgColumn>;
  if ('createdBy' in cols) dbValues.createdBy = actor;
}

/**
 * Build the `HandlerDb` facade over a `TenantDb` + the declared product tables. The TenantDb is the
 * REAL chokepoint (its predicate is structural); this facade only translates name-keyed,
 * serializable-shaped calls into TenantDb calls + maps rows back. Used for tool handlers (plain
 * TenantDb — no outer tx) AND, inside `.transaction()`, for route/trigger handlers (the tx-boundary asymmetry).
 *
 * `createdByActor` is the OPTIONAL server-derived caller identity (`user:<userId>` / `key:<apiKeyId>`)
 * of the request whose route handler owns this facade. When present, insert/upsert stamp it onto the
 * injected `created_by` column (un-spoofable — see `stampCreatedBy`). Absent (tool/trigger handlers and
 * every pre-existing 2-arg caller) ⇒ `created_by` is left as-is, byte-identical to the prior facade.
 */
export function makeHandlerDb(
  tdb: TenantDb,
  productTables: ReadonlyMap<string, PgTable>,
  createdByActor?: string,
): HandlerDb {
  return {
    async select(store: string, filter?: StoreFilter, opts?: SelectOptions): Promise<StoreRow[]> {
      const table = resolveTable(productTables, store);
      // A softDelete store hides tombstoned rows (deleted_at IS NULL folded in); default store unchanged.
      const pred = visiblePredicate(table, filterPredicate(table, filter));
      // TenantDb.select<T> wants the registered table type; the runtime PgTable is admitted via the
      // chokepoint's deny-by-default Set (the deployment registered it). The `as never` bridges the
      // literal-tuple member type to the runtime PgTable (same bridge store-routes.ts uses).
      // `.$dynamic()` lets us chain orderBy/limit/offset CONDITIONALLY (drizzle's dynamic builder keeps
      // each method available; without it each call narrows the type and drops the method).
      let q = tdb
        .select(table as never)
        .where(pred)
        .$dynamic();
      if (opts?.orderBy && opts.orderBy.length > 0) {
        // Read-shaping: server-side ORDER BY — each column resolved fail-closed (an unknown column throws).
        const order = opts.orderBy.map(({ column, dir }) => {
          const col = resolveColumn(table, column);
          return dir === 'desc' ? desc(col) : asc(col);
        });
        q = q.orderBy(...order);
      }
      // guard limit/offset fail-closed — a negative/NaN limit would SILENTLY drop the LIMIT clause
      // (return ALL tenant rows), a negative offset would raise a raw DB error. (limit:0 stays valid.)
      if (opts?.limit !== undefined) {
        assertNonNegativeInt('limit', opts.limit);
        q = q.limit(opts.limit);
      }
      if (opts?.offset !== undefined) {
        assertNonNegativeInt('offset', opts.offset);
        q = q.offset(opts.offset);
      }
      const rows = (await q) as Record<string, unknown>[];
      return rows.map((r) => serializeRow(table, r));
    },

    async count(store: string, filter?: StoreFilter): Promise<number> {
      // count (additive): ONE `SELECT count(*)` through the SAME fail-closed resolution +
      // filter guard `select` uses (resolveTable/filterPredicate incl. the SF-1 value guard), over
      // the SAME TenantDb chokepoint — `TenantDb.select(table, columns)` AND-combines the structural
      // tenant predicate beneath the filter, so a count can never see another tenant's rows. Lets a
      // paged reader total without loading the tenant's whole match set.
      const table = resolveTable(productTables, store);
      // A softDelete store excludes tombstoned rows from the count too (uniform with select).
      const pred = visiblePredicate(table, filterPredicate(table, filter));
      const rows = (await tdb.select(table as never, { value: countRows() }).where(pred)) as Array<{
        value: number;
      }>;
      return Number(rows[0]?.value ?? 0);
    },

    async insert(store: string, values: StoreRow): Promise<StoreRow> {
      const table = resolveTable(productTables, store);
      // #3/#4: fail-closed on unknown OR server-controlled columns in the VALUES.
      const dbValues = toDbValues(table, values, 'insert');
      // Stamp the un-spoofable caller identity onto `created_by` from the route context (no-op when no
      // actor is bound or the store lacks the column). The handler could not have set it — toDbValues
      // rejected it as server-controlled above — so the actor is the SOLE writer.
      stampCreatedBy(table, dbValues, createdByActor);
      let inserted: Record<string, unknown>[];
      try {
        inserted = (await tdb.insert(table as never, dbValues).returning()) as Record<
          string,
          unknown
        >[];
      } catch (err) {
        // Security: a UNIQUE-violation (a conflict on a global unique) is sanitized to a neutral
        // message so the raw pg constraint name (a cross-tenant existence oracle) never reaches the
        // model. Every non-unique error rethrows unchanged.
        throw sanitizeDbError(err);
      }
      const row = inserted[0];
      if (!row) throw new Error(`HandlerDb: insert into '${store}' returned no row.`);
      return serializeRow(table, row);
    },

    async upsert(
      store: string,
      conflictColumns: string[],
      values: StoreRow,
      opts?: UpsertOptions,
    ): Promise<StoreRow | undefined> {
      const table = resolveTable(productTables, store);
      // #3/#4 + SF-1: the SAME guard insert uses — fail-closed on unknown/server-controlled cols; reject
      // a SQL/function/class injection value. Zero new trust surface (we reuse toDbValues verbatim).
      const dbValues = toDbValues(table, values, 'insert');
      // Stamp the un-spoofable caller identity onto `created_by` for the INSERT arm (no-op without an
      // actor or a `created_by` column) — same as insert.
      stampCreatedBy(table, dbValues, createdByActor);
      // Resolve every conflict-target column fail-closed (an unknown column throws — never a silent
      // ON CONFLICT on the wrong column). These are the unique-index columns the conflict matches on.
      const targets = conflictColumns.map((name) => resolveColumn(table, name));
      // The DO-UPDATE SET = the written values MINUS the conflict columns (you don't re-assign the key
      // you matched on) AND MINUS `created_by`. Keys here are already camelCase (toDbValues output).
      const conflictCamel = new Set(conflictColumns.map((name) => snakeToCamel(name)));
      const setValues: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(dbValues)) {
        if (conflictCamel.has(key)) continue;
        // `created_by` is create-only (immutable): never re-assign it on a conflict-update, so a
        // same-tenant conflict KEEPS the ORIGINAL creator (parity with the declarative create-only
        // stamp). Without an actor this key is never present, so this is byte-identical to before.
        if (key === 'createdBy') continue;
        setValues[key] = value;
      }
      const tenantCol = resolveColumn(table, 'tenant_id');
      const builder = tdb.insert(table as never, dbValues);
      // The OPTIONAL conditional-update guard: `updateWhere` (an equality map the conflicting row must
      // ALSO match). Built with the SAME fail-closed column resolution + SF-1 value guard a filter uses
      // (`filterPredicate`), so an unknown column throws + an injection value is rejected. `undefined`
      // when absent (or an empty `{}`) ⇒ the DO-UPDATE is scoped by the tenant predicate ALONE, byte-
      // behaviorally identical to the pre-`updateWhere` upsert.
      const updateWherePred = filterPredicate(table, opts?.updateWhere);
      // EMPTY DO-UPDATE SET: when `values` is a SUBSET of `conflictColumns` (an ensure-exists
      // upsert, e.g. upsert('tags',['name'],{name})), the SET-exclusion loop above yields `setValues={}`,
      // and `.onConflictDoUpdate({set:{}})` throws drizzle's synchronous "No values to set". Use DO
      // NOTHING instead: ensure-exists semantics — on a conflict (same OR foreign tenant) it no-ops, on no
      // conflict it inserts. DO NOTHING never WRITES, so there is no cross-tenant write risk and NO
      // setWhere is needed (a foreign-tenant conflict is a pure no-op); `updateWhere` is likewise moot
      // there (nothing is ever overwritten, so the guard is trivially satisfied).
      //
      // ── THE SECURITY-CRITICAL LINE (the DO-UPDATE arm) ───────────────────────────────────────────────
      // Scope the DO-UPDATE to THIS tenant. Without it, a conflict on a NON-tenant-scoped (global) unique
      // column would let the DO-UPDATE OVERWRITE ANOTHER tenant's row — a cross-tenant write. With it, a
      // foreign-tenant conflict matches ZERO rows (a fail-closed no-op), never corrupting another tenant.
      // The caller-supplied `updateWhere` is AND-combined BENEATH the tenant scope (never in place of it),
      // so a conditional upsert can never widen the tenant guard — it only NARROWS which same-tenant row
      // the conflict may overwrite (a still-guarded-state row); a row that has left that state matches
      // ZERO rows → the fail-closed `undefined` no-op, leaving it untouched.
      const setWhere: SQL = updateWherePred
        ? (and(eq(tenantCol, tdb.tenantId), updateWherePred) as SQL)
        : eq(tenantCol, tdb.tenantId);
      const stmt =
        Object.keys(setValues).length === 0
          ? builder.onConflictDoNothing({ target: targets })
          : builder.onConflictDoUpdate({
              target: targets,
              set: setValues as never,
              setWhere,
            });
      let upserted: Record<string, unknown>[];
      try {
        upserted = (await stmt.returning()) as Record<string, unknown>[];
      } catch (err) {
        // Security: a conflict on a DIFFERENT global unique (NOT the named target) raises 23505, whose
        // raw message names the constraint — a cross-tenant existence oracle. Sanitize to a neutral error
        // (same as insert). NON-unique errors rethrow unchanged. (We never recover from an in-tx 23505 —
        // CONCURRENCY-FIX — we only sanitize + rethrow.)
        throw sanitizeDbError(err);
      }
      const row = upserted[0];
      // RETURN CONTRACT — scoped to a conflict on the NAMED `conflictColumns` target:
      //  - DO-UPDATE arm: a same-tenant conflict updates this tenant's row → RETURNING a row; a
      //    foreign-tenant conflict is matched by the tenant-scoped setWhere as ZERO rows → RETURNING empty
      //    → `undefined` (the fail-closed no-op), NOT a throw (the conflict is legitimate; a throw leaks
      //    more than the empty result). A no-conflict insert returns the inserted row.
      //  - DO-NOTHING arm (ensure-exists, empty SET): a conflict on the named target no-ops → `undefined`;
      //    no conflict inserts → the row.
      // A conflict on a DIFFERENT global unique (NOT the named target) is NOT reached here — it raised
      // 23505 and was sanitized above to a neutral unique-violation error (same as insert), so the raw
      // constraint name never crosses to the model.
      return row ? serializeRow(table, row) : undefined;
    },

    async update(store: string, filter: StoreFilter, patch: StoreRow): Promise<StoreRow[]> {
      const table = resolveTable(productTables, store);
      // #3/#4: fail-closed on unknown OR server-controlled columns in the PATCH.
      const dbPatch = toDbValues(table, patch, 'update');
      // A softDelete store never modifies a tombstoned row (deleted_at IS NULL folded in) — a PATCH on a
      // tombstoned row matches zero rows, uniform with the CRUD route. (A handler still cannot set
      // deleted_at itself — toDbValues rejects the server-controlled column; delete() is the one stamp path.)
      const pred = visiblePredicate(table, filterPredicate(table, filter));
      const updated = (await tdb
        .update(table as never, dbPatch)
        .where(pred)
        .returning()) as Record<string, unknown>[];
      return updated.map((r) => serializeRow(table, r));
    },

    async delete(store: string, filter: StoreFilter): Promise<number> {
      const table = resolveTable(productTables, store);
      const pred = filterPredicate(table, filter);
      if (isSoftDeleteTable(table)) {
        // Soft delete (opt-in): STAMP the tombstone (`deleted_at = now`) via the EXISTING update
        // chokepoint instead of a physical delete — parity with the CRUD delete route. `visiblePredicate`
        // ANDs `deleted_at IS NULL`, so an ALREADY-tombstoned row matches ZERO rows → a 2nd delete is a
        // no-op (0). The row survives at the DB level but reads as gone everywhere. Returns the count of
        // rows tombstoned by THIS call. (TenantDb.update AND-combines the structural tenant predicate
        // beneath — a cross-tenant delete still affects zero rows — and strips a stray tenant_id from the SET.)
        const tombstoned = (await tdb
          .update(table as never, { deletedAt: new Date() })
          .where(visiblePredicate(table, pred))
          .returning()) as Record<string, unknown>[];
        return tombstoned.length;
      }
      // DEFAULT (softDelete falsy/undefined): a HARD physical delete — byte-behaviourally identical to
      // the pre-soft-delete facade (the row is physically gone).
      const deleted = (await tdb
        .delete(table as never)
        .where(pred)
        .returning()) as Record<string, unknown>[];
      return deleted.length;
    },

    async transaction<R>(fn: (tx: HandlerDb) => Promise<R>): Promise<R> {
      // Delegate to the real TenantDb transaction (populates the app.current_tenant GUC — RLS-ready).
      // The callback's facade is bound to the SAME tenant over the transactional TenantDb handle.
      //
      // ⚠ ISOLATE-READINESS (refinement #5 — honest): the REST of HandlerDb is serializable-shaped
      // (name-keyed calls + plain rows/filters), so an in-process call becomes a cross-isolate call in
      // a future isolate with no handler change. `transaction(fn)`, however, takes a CLOSURE callback — a closure
      // does NOT trivially cross an isolate boundary (you cannot serialize it). So the CROSS-ISOLATE
      // transaction model is a future DESIGN POINT (e.g. an explicit begin/commit token protocol, or
      // running the whole handler inside one isolate-side tx), NOT something this seam already solves.
      // The in-process impl is correct + GUC-populated; do NOT claim the transaction path is
      // isolate-ready. (See handler-runtime.ts / @rayspec/handler-sdk for the same caveat.)
      return tdb.transaction(async (txTdb) =>
        fn(makeHandlerDb(txTdb, productTables, createdByActor)),
      );
    },
  };
}
