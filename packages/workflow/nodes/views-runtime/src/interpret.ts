/**
 * @rayspec/views-runtime — the REQUEST-TIME view interpreter.
 *
 * `makeViewRouteHandler(compiled, stores)` builds the `RouteHandler` a compiled view executes as.
 * The handler is PURE DATA-DRIVEN — it never runs product code (there is none: the compile step
 * proved the declaration is closed) — and READ-ONLY BY CONSTRUCTION: the only capability it touches
 * is `init.db.select` (the tenant-bound, name-keyed facade over the real `TenantDb` chokepoint), so
 * every read carries the structural tenant predicate and a view can never write.
 *
 * REQUEST LAWS (the DECLARED read semantics — EXCEPT where marked ADDITIVE; the package README's
 * "Request laws" section is the prose companion):
 *  - PARAMS: every declared param is validated against its closed preset (+ optional enum). A
 *    missing-required / mis-shaped param → 400 `{ error: 'bad_request', detail }` (the donor's
 *    behavior; `detail` wording is product-neutral — the comparator treats detail as
 *    informational). Undeclared query params are IGNORED (donor-compatible; request params are DATA).
 *  - LEAF TYPES: a raw value matching the declared type passes through; anything else becomes the
 *    declared literal `default` (default `null`) — the donor's `typeof x === 'number' ? x : null`
 *    family as stable, declared behavior.
 *  - PAGINATION (list): `limit` missing/non-integer/`< 1` → default_limit (never an empty page);
 *    `> max_limit` → max_limit; `offset` missing/non-integer/`< 0` → 0. `total` is the FULL
 *    (tenant-scoped, post-exclude) match count; `next_offset` = `offset+limit < total ? … : null`.
 *    READ SHAPE (TEN-1): the page is a BOUNDED server-side LIMIT/OFFSET select + a `count` for the
 *    total (wire-identical to the donor's full-read-and-slice math, without the unbounded
 *    within-tenant read); falls back to the full read + in-interpreter slice when the facade offers
 *    no `count` or the view declares an in-memory `exclude`.
 *  - ABSENT (single): no row → the DECLARED `read.absent` DTO (200) or `409 { error: 'not_ready' }`
 *    per `absent_state` — never an improvised shape, never a 404 for a mid-processing read model.
 *  - CONDITIONAL READ (`conditional_read: etag`, GET) — ADDITIVE vs the frozen donor (the donor's
 *    read routes served neither an ETag nor a 304): a strong ETag (sha-256 of the canonical DTO
 *    JSON) is set on the 200; a matching `If-None-Match` → bodyless 304 with the same ETag.
 *    `If-Range` is NOT a view behavior (byte-range serving is Tier-B media capability — the
 *    compatibility map); no view construct exists for it.
 *  - SUB-READS: a match value that resolves to `undefined`/`null` yields NO rows (deterministic,
 *    no query) — fail-closed, never an unfiltered read.
 *
 * SECURITY: params, headers, and store rows are DATA end-to-end (a view handler never calls a model).
 */
import { createHash } from 'node:crypto';
import type { RouteHandler, RouteHandlerInit, StoreRow } from '@rayspec/handler-sdk';
import { httpResponse } from '@rayspec/handler-sdk';
import type {
  ColumnType,
  ViewAbsentShape,
  ViewConstValue,
  ViewField,
  ViewItemShape,
  ViewLeafType,
  ViewMatchArg,
  ViewObjectShape,
  ViewParamSpec,
  ViewSubRead,
} from '@rayspec/spec';
import type { CompiledView, StoreIndex } from './compile.js';

// ---------------------------------------------------------------------------------------
// param validation (the closed presets)
// ---------------------------------------------------------------------------------------

/** The frozen safe-id shape (the donor's id-param rule). */
const SAFE_ID_RE = /^[A-Za-z0-9_.-]{1,128}$/;
const INT_RE = /^\d+$/;
const MAX_STRING_PARAM = 1024;

function paramShapeOk(spec: ViewParamSpec, raw: string): boolean {
  switch (spec.shape) {
    case 'safe_id':
      return SAFE_ID_RE.test(raw);
    case 'positive_int':
      return INT_RE.test(raw) && Number(raw) >= 1 && Number.isSafeInteger(Number(raw));
    case 'nonnegative_int':
      return INT_RE.test(raw) && Number.isSafeInteger(Number(raw));
    case 'string':
      return raw.length >= 1 && raw.length <= MAX_STRING_PARAM;
  }
}

/**
 * Read a raw request param as an OWN property only (FCY-2). The injected params map may be a plain
 * object — an optional param named `toString`/`valueOf`/`hasOwnProperty` must never read the
 * inherited Object.prototype member as a "present" (malformed) value.
 */
function ownParam(raw: Readonly<Record<string, string>>, name: string): string | undefined {
  return Object.hasOwn(raw, name) ? raw[name] : undefined;
}

/**
 * Validate the declared params against the request. Returns the validated string map, or the
 * offending param name (→ 400). A path param is required by construction; a query param defaults to
 * optional (absent ⇒ simply not in the map — a `{param}` filter over it yields no read constraint
 * violation because filters resolve validated params only; an absent OPTIONAL param makes the
 * sub-value undefined → the leaf default / no-rows law applies).
 *
 * FCY-2: reads OWN properties only and returns a NULL-PROTOTYPE map, so a param named like an
 * Object.prototype member can neither false-positive as present nor read a function on echo.
 */
function validateParams(
  declared: ReadonlyMap<string, ViewParamSpec>,
  raw: Readonly<Record<string, string>>,
): { ok: true; params: Record<string, string> } | { ok: false; param: string } {
  const out: Record<string, string> = Object.create(null);
  for (const [name, spec] of declared) {
    const value = ownParam(raw, name);
    const required = spec.in === 'path' ? true : (spec.required ?? false);
    if (value === undefined || value === '') {
      if (required) return { ok: false, param: name };
      continue;
    }
    if (!paramShapeOk(spec, value)) return { ok: false, param: name };
    if (spec.enum && !spec.enum.includes(value)) return { ok: false, param: name };
    out[name] = value;
  }
  return { ok: true, params: out };
}

// ---------------------------------------------------------------------------------------
// leaf typing (stable null/default behavior)
// ---------------------------------------------------------------------------------------

/** Does a raw value MATCH the declared leaf type? (integer = finite integer; number = finite.) */
function matchesLeafType(value: unknown, type: ViewLeafType): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
  }
}

/** Deep-copy a literal (arrays/objects) so DTOs never alias declared spec values. */
function cloneConst(value: ViewConstValue): unknown {
  if (Array.isArray(value)) return [...value];
  if (typeof value === 'object' && value !== null) return { ...value };
  return value;
}

/** The declared-type-or-default law. `default` omitted ⇒ null. */
function typedLeaf(raw: unknown, type: ViewLeafType, deflt: ViewConstValue | undefined): unknown {
  if (matchesLeafType(raw, type)) return raw;
  return deflt === undefined ? null : cloneConst(deflt);
}

/**
 * Walk a key path over parsed-JSON data reading OWN properties only (`Object.hasOwn`) — a declared
 * `__proto__`-class segment can therefore never read a prototype (and a legitimate own key of that
 * name — JSON.parse creates own keys — is still readable as plain data).
 */
function getPath(value: unknown, path: readonly string[]): unknown {
  let cur: unknown = value;
  for (const seg of path) {
    if (typeof cur !== 'object' || cur === null || Array.isArray(cur)) return undefined;
    if (!Object.hasOwn(cur, seg)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

// ---------------------------------------------------------------------------------------
// pagination (the frozen clamp law)
// ---------------------------------------------------------------------------------------

/** The donor's clamp: undefined/''/non-integer/`< min` → def; `> max` → max. */
function clampInt(raw: string | undefined, def: number, min: number, max: number): number {
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) return def;
  return n > max ? max : n;
}

// ---------------------------------------------------------------------------------------
// the interpreter
// ---------------------------------------------------------------------------------------

/** The read-only slice of the handler db the interpreter touches (select + count — no write path). */
type ReadOnlyDb = Pick<RouteHandlerInit['db'], 'select' | 'count'>;

interface RequestCtx {
  readonly db: ReadOnlyDb;
  readonly params: Readonly<Record<string, string>>;
  readonly stores: StoreIndex;
  /**
   * DF-2: the per-REQUEST sub-read memo. Key = the full query signature (store + resolved match
   * values + exclude + order_by + limit); value = the post-exclude rows promise. Identical sub-reads
   * within ONE interpretation pass (e.g. three per-track lookups on the same (store, match)) share
   * ONE select AND one row set — so they can never stitch fields from DIFFERENT rows, and the donor's
   * one-select-per-track read cost is reproduced. Scoped to the request (created per handler call);
   * all reads run inside the request's one tenant transaction, so memoization cannot change results.
   */
  readonly subReadMemo: Map<string, Promise<StoreRow[]>>;
}

/** Resolve a sub-read match arg to a runtime value (undefined ⇒ the no-rows law). */
function resolveMatchArg(
  arg: ViewMatchArg,
  parentRow: StoreRow | undefined,
  ctx: RequestCtx,
  childStore: string,
  childColumn: string,
): unknown {
  if ('const' in arg) return arg.const;
  if ('param' in arg) {
    const raw = ctx.params[arg.param];
    if (raw === undefined) return undefined;
    return coerceParamForColumn(raw, childStore, childColumn, ctx.stores);
  }
  return parentRow?.[arg.column];
}

/** Coerce a validated param string for an equality filter on a typed column (compile-verified). */
function coerceParamForColumn(
  raw: string,
  store: string,
  column: string,
  stores: StoreIndex,
): unknown {
  const t: ColumnType | undefined = stores.get(store)?.get(column);
  return t === 'integer' ? Number(raw) : raw;
}

/**
 * Execute a sub-read: keyed equality match (fail-closed on unresolved keys) + exclude + order.
 * MEMOIZED per request on the full query signature (DF-2) — see `RequestCtx.subReadMemo`.
 */
function runSubRead(
  sub: ViewSubRead,
  parentRow: StoreRow | undefined,
  ctx: RequestCtx,
  limit?: number,
): Promise<StoreRow[]> {
  const filter: Record<string, unknown> = {};
  for (const [col, arg] of Object.entries(sub.match)) {
    const value = resolveMatchArg(arg, parentRow, ctx, sub.store, col);
    if (value === undefined || value === null) return Promise.resolve([]); // deterministic no-rows (fail-closed)
    filter[col] = value;
  }
  // The FULL query signature: two sub-reads share a select only when every part that shapes the
  // query — store, resolved match values (sorted), exclude, order_by, and the limit — is identical.
  const key = JSON.stringify([
    sub.store,
    Object.entries(filter).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    sub.exclude ?? null,
    sub.order_by ?? null,
    limit ?? null,
  ]);
  const memoized = ctx.subReadMemo.get(key);
  if (memoized) return memoized;
  const pending = (async () => {
    const rows = await ctx.db.select(sub.store, filter, {
      ...(sub.order_by
        ? {
            orderBy: sub.order_by.map((o) => ({
              column: o.column,
              ...(o.dir ? { dir: o.dir } : {}),
            })),
          }
        : {}),
      ...(limit !== undefined && !sub.exclude?.length ? { limit } : {}),
    });
    return applyExclude(rows, sub.exclude);
  })();
  ctx.subReadMemo.set(key, pending);
  return pending;
}

/** In-memory exclusion (strict equality — a malformed flag never hides a row; the donor's `=== true`). */
function applyExclude(rows: StoreRow[], exclude: ViewSubRead['exclude'] | undefined): StoreRow[] {
  if (!exclude || exclude.length === 0) return rows;
  return rows.filter((row) => !exclude.some((ex) => row[ex.column] === ex.equals));
}

/** Project one FIELD in a ROW context (single-row / list-item / group-row / nested list shapes). */
async function projectField(field: ViewField, row: StoreRow, ctx: RequestCtx): Promise<unknown> {
  switch (field.kind) {
    case 'column':
      return typedLeaf(row[field.column], field.type, field.default);
    case 'json':
      return typedLeaf(getPath(row[field.column], field.path), field.type, field.default);
    case 'param':
      return ctx.params[field.param] ?? null;
    case 'const':
      return cloneConst(field.value);
    case 'items': {
      const raw = field.path?.length ? getPath(row[field.column], field.path) : row[field.column];
      if (!Array.isArray(raw)) return [];
      return raw.map((element) => projectItem(field.shape, element));
    }
    case 'list': {
      const rows = await runSubRead(field.source, row, ctx);
      return Promise.all(rows.map((child) => projectShape(field.shape, child, ctx)));
    }
    case 'lookup': {
      const rows = await runSubRead(field.source, row, ctx, 1);
      const match = rows[0];
      if (!match) return field.default === undefined ? null : cloneConst(field.default);
      const raw = field.field.path?.length
        ? getPath(match[field.field.column], field.field.path)
        : match[field.field.column];
      return typedLeaf(raw, field.type, field.default);
    }
    case 'counts': {
      // In a row context, `of` is REQUIRED (compile/lint enforced) — tally the sub-read's rows.
      const rows = field.of ? await runSubRead(field.of, row, ctx) : [];
      return tallyCounts(rows, field.by, field.buckets, field.total);
    }
    default:
      // group/page_* never reach a row context (lint/compile enforced); fail LOUDLY if they do.
      throw new Error(`views-runtime: field kind '${field.kind}' is not valid in a row context`);
  }
}

/** Project an ITEMS shape over one jsonb array element (item/const fields only — grammar-closed). */
function projectItem(shape: ViewItemShape, element: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(shape.fields)) {
    out[name] =
      field.kind === 'const'
        ? cloneConst(field.value)
        : typedLeaf(getPath(element, field.path), field.type, field.default);
  }
  return out;
}

/** Project a ROW-context object shape. */
async function projectShape(
  shape: ViewObjectShape,
  row: StoreRow,
  ctx: RequestCtx,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(shape.fields)) {
    out[name] = await projectField(field, row, ctx);
  }
  return out;
}

/** The counts tally (`all_rows` counts EVERY row; `bucket_rows` only rows landing in a bucket). */
function tallyCounts(
  rows: readonly StoreRow[],
  by: string,
  buckets: readonly string[],
  total: 'all_rows' | 'bucket_rows',
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const bucket of buckets) out[bucket] = 0;
  out.total = 0;
  for (const row of rows) {
    const key = row[by];
    const inBucket = typeof key === 'string' && buckets.includes(key);
    if (inBucket) out[key as string] = (out[key as string] ?? 0) + 1;
    if (total === 'all_rows' || inBucket) out.total += 1;
  }
  return out;
}

/** Project the ABSENT shape (param/const only — grammar-closed). */
function projectAbsent(
  shape: ViewAbsentShape,
  params: Readonly<Record<string, string>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(shape.fields)) {
    out[name] = field.kind === 'const' ? cloneConst(field.value) : (params[field.param] ?? null);
  }
  return out;
}

/** Project the COLLECT-mode top shape (param/const/group/counts over the collected rows). */
async function projectCollectTop(
  shape: ViewObjectShape,
  rows: readonly StoreRow[],
  ctx: RequestCtx,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(shape.fields)) {
    switch (field.kind) {
      case 'param':
        out[name] = ctx.params[field.param] ?? null;
        break;
      case 'const':
        out[name] = cloneConst(field.value);
        break;
      case 'counts': {
        const source = field.of ? await runSubRead(field.of, undefined, ctx) : [...rows];
        out[name] = tallyCounts(source, field.by, field.buckets, field.total);
        break;
      }
      case 'group': {
        const matching = rows.filter((r) => r[field.column] === field.equals);
        if (field.mode === 'list') {
          out[name] = field.shape
            ? await Promise.all(
                matching.map((r) => projectShape(field.shape as ViewObjectShape, r, ctx)),
              )
            : matching.map((r) => {
                const v = field.value as NonNullable<typeof field.value>;
                const raw = v.path?.length ? getPath(r[v.column], v.path) : r[v.column];
                return typedLeaf(raw, v.type, v.default);
              });
        } else {
          const row = field.mode === 'first' ? matching[0] : matching[matching.length - 1];
          if (!row) {
            out[name] = field.absent === undefined ? null : cloneConst(field.absent);
          } else if (field.shape) {
            out[name] = await projectShape(field.shape, row, ctx);
          } else {
            const v = field.value as NonNullable<typeof field.value>;
            const raw = v.path?.length ? getPath(row[v.column], v.path) : row[v.column];
            out[name] = typedLeaf(raw, v.type, v.default);
          }
        }
        break;
      }
      default:
        throw new Error(
          `views-runtime: field kind '${field.kind}' is not valid at a collect top level`,
        );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// the route handler builder
// ---------------------------------------------------------------------------------------

/** The donor's 400 body (product-neutral detail — the comparator compares on {status, error}). */
function badRequest(param: string) {
  return httpResponse({
    status: 400,
    body: { error: 'bad_request', detail: `param '${param}' is missing or malformed.` },
  });
}

/** Strong ETag over the canonical DTO JSON (shape key order is declaration order — deterministic). */
function etagOf(dto: unknown): string {
  return `"${createHash('sha256').update(JSON.stringify(dto)).digest('hex')}"`;
}

/** Strong-compare If-None-Match (a weak `W/` validator never matches a strong ETag; `*` matches any). */
function ifNoneMatchHits(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  return header.split(',').some((candidate) => {
    const c = candidate.trim();
    return c === '*' || c === etag;
  });
}

/**
 * Build the `RouteHandler` for one compiled view. Registered as a `{ kind:'handler' }` route action,
 * so it runs on the platform's standard chain (requireAuth → resolveTenant → requirePermission)
 * inside `TenantDb.transaction()` via `invokeRouteHandler` — the same path every declared route uses.
 */
export function makeViewRouteHandler(compiled: CompiledView, stores: StoreIndex): RouteHandler {
  const { view, read, storeName, params: declaredParams } = compiled;
  const pagination = view.pagination;

  return async (init: RouteHandlerInit): Promise<unknown> => {
    // ---- 1. validate declared params (400 on violation — the donor's behavior) -------------
    const validated = validateParams(declaredParams, init.params);
    if (!validated.ok) return badRequest(validated.param);
    // The sub-read memo is REQUEST-SCOPED (DF-2): fresh per handler call, never shared across requests.
    const ctx: RequestCtx = {
      db: init.db,
      params: validated.params,
      stores,
      subReadMemo: new Map(),
    };

    // ---- 2. build the base filter (compile-verified columns; params coerced per column type) -
    const filter: Record<string, unknown> = {};
    for (const [col, arg] of Object.entries(read.filter ?? {})) {
      if ('const' in arg) {
        filter[col] = arg.const;
      } else {
        const raw = validated.params[arg.param];
        if (raw === undefined) {
          // Unreachable by construction: lint requires a filter param to be REQUIRED (path or
          // required:true) and required params were just validated. Fail LOUDLY if it ever happens.
          throw new Error(
            `views-runtime: view '${view.id}' filter param '${arg.param}' is absent after ` +
              'validation — a filter param must be required (lint invariant violated)',
          );
        }
        filter[col] = coerceParamForColumn(raw, storeName, col, stores);
      }
    }
    const orderBy = read.order_by?.map((o) => ({
      column: o.column,
      ...(o.dir ? { dir: o.dir } : {}),
    }));

    // ---- 3. execute the declared read mode ---------------------------------------------------
    let dto: Record<string, unknown>;
    if (read.mode === 'list') {
      // TEN-1: a BOUNDED page read — server-side LIMIT/OFFSET for the page + `count` for the total —
      // whenever the read surface offers the count primitive and nothing forces the full match set
      // into memory (an in-memory `exclude` needs every row for the post-exclude total). The WIRE
      // output is identical to the full-read law (same DTO, same total/next_offset — the goldens pin
      // it); both statements run inside the request's ONE tenant transaction. Falls back to the
      // donor-shaped full read + in-interpreter slice when `count` is unavailable (older facades) or
      // `exclude` is declared.
      const bounded =
        typeof ctx.db.count === 'function' &&
        !read.exclude?.length &&
        pagination?.max_limit !== undefined;
      let page: StoreRow[];
      let total: number;
      let limit: number;
      let offset: number;
      // Pagination params are PAGINATION-OWNED (lint rejects a params collision), so they are read
      // from the RAW request params — the clamp law IS their validation (donor-identical: a
      // malformed value clamps, it never 400s). Read as OWN properties (FCY-2).
      const rawLimit = pagination?.limit_param
        ? ownParam(init.params, pagination.limit_param)
        : undefined;
      const rawOffset = pagination?.offset_param
        ? ownParam(init.params, pagination.offset_param)
        : undefined;
      if (bounded && pagination?.max_limit !== undefined && ctx.db.count) {
        const max = pagination.max_limit;
        const def = pagination.default_limit ?? max;
        limit = clampInt(rawLimit, def, 1, max);
        offset = clampInt(rawOffset, 0, 0, Number.MAX_SAFE_INTEGER);
        total = await ctx.db.count(storeName, filter);
        page = await init.db.select(storeName, filter, {
          ...(orderBy ? { orderBy } : {}),
          limit,
          offset,
        });
      } else {
        // The FULL ordered tenant-scoped match, then the clamp law + the in-interpreter slice.
        const all = applyExclude(
          await init.db.select(storeName, filter, orderBy ? { orderBy } : undefined),
          read.exclude,
        );
        const max = pagination?.max_limit ?? all.length;
        const def = pagination?.default_limit ?? max;
        limit = clampInt(rawLimit, def, 1, max);
        offset = clampInt(rawOffset, 0, 0, Number.MAX_SAFE_INTEGER);
        page = all.slice(offset, offset + limit);
        total = all.length;
      }
      const nextOffset = offset + limit < total ? offset + limit : null;

      dto = {};
      for (const [name, field] of Object.entries(read.shape.fields)) {
        switch (field.kind) {
          case 'page_items':
            dto[name] = await Promise.all(page.map((row) => projectShape(field.shape, row, ctx)));
            break;
          case 'page_total':
            dto[name] = total;
            break;
          case 'page_next_offset':
            dto[name] = nextOffset;
            break;
          case 'param':
            dto[name] = validated.params[field.param] ?? null;
            break;
          case 'const':
            dto[name] = cloneConst(field.value);
            break;
          default:
            throw new Error(
              `views-runtime: field kind '${field.kind}' is not valid in a list envelope`,
            );
        }
      }
    } else if (read.mode === 'single') {
      const rows = applyExclude(
        await init.db.select(storeName, filter, {
          ...(orderBy ? { orderBy } : {}),
          // exclude filters in-memory, so only cap the read when there is nothing to exclude.
          ...(read.exclude?.length ? {} : { limit: 1 }),
        }),
        read.exclude,
      );
      const row = rows[0];
      if (!row) return finishAbsent(view, read, validated.params, init);
      dto = await projectShape(read.shape, row, ctx);
    } else {
      const rows = applyExclude(
        await init.db.select(storeName, filter, orderBy ? { orderBy } : undefined),
        read.exclude,
      );
      dto = await projectCollectTop(read.shape, rows, ctx);
    }

    // ---- 4. conditional read (GET + etag) -----------------------------------------------------
    return finishDto(view, dto, init);
  };
}

/** The declared absent behavior (single mode; also the fail-closed empty read for absent filters). */
function finishAbsent(
  view: CompiledView['view'],
  read: CompiledView['read'],
  params: Readonly<Record<string, string>>,
  init: RouteHandlerInit,
): unknown {
  if (view.absent_state === 'not_ready_409') {
    return httpResponse({
      status: 409,
      body: { error: 'not_ready', detail: 'the requested resource is not ready yet.' },
    });
  }
  // empty_200 (lint guarantees read.absent for single mode; list/collect never reach here).
  const dto = read.absent ? projectAbsent(read.absent, params) : {};
  return finishDto(view, dto, init);
}

/** Apply the conditional-read law and return the response value. */
function finishDto(view: CompiledView['view'], dto: unknown, init: RouteHandlerInit): unknown {
  if (view.conditional_read !== 'etag') return dto;
  const etag = etagOf(dto);
  if (ifNoneMatchHits(init.headers?.['if-none-match'], etag)) {
    return httpResponse({ status: 304, headers: { ETag: etag } });
  }
  return httpResponse({ status: 200, headers: { ETag: etag }, body: dto });
}
