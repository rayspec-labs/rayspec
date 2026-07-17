/**
 * Product-YAML VIEW read + projection vocabulary.
 *
 * This module declares HOW a Product-YAML view reads backing data and shapes its DTO — as CLOSED,
 * FAIL-CLOSED, ZERO-CODE data. It resolves the earlier conflation of "what backing
 * data does the view read" with "what DTO shape does it return") by giving each half its own
 * declaration with its own validation:
 *
 *   - `source` (+ `read`)      = the BACKING DATA: a store / artifact query / capability ref, an
 *                                equality filter over declared params, exclusions, ordering, and a
 *                                read MODE (list | single | collect). Validated kind-aware by
 *                                `product-views-lint.ts` (a contract id NEVER satisfies a source).
 *   - `response_contract` (+ `read.shape`) = the DTO: the declared contract names the client-facing
 *                                shape; `shape` declares how rows PROJECT into it. Validated by the
 *                                shape⊆contract conformance pass (separate from source resolution).
 *
 * DESIGN LAWS (enforced by product-views-lint + the @rayspec/views-runtime interpreter):
 *   - EVERYTHING here is data: literals, column names, param names, JSON paths. There is no
 *     expression language, no computed string, no handler reference — the "route declarations
 *     cannot run arbitrary code" gate is structural (closed discriminated unions + strict objects).
 *   - Every leaf carries a declared `type` from a closed set and an optional literal `default`
 *     (default `null`): a raw value that does not match the type is replaced by the default, which
 *     reproduces the frozen legacy read handlers' null-safety (`typeof x === 'number' ? x : null`)
 *     as DECLARED, stable behavior ("stable null behavior").
 *   - Recursion is real (a list item may contain lookups/items) but each context is CLOSED: an
 *     `items` (jsonb-array) shape admits only `item`/`const` fields BY CONSTRUCTION; a `read.absent`
 *     shape admits only `param`/`const`. Context rules that depend on the read mode (page fields
 *     only in `list`, group/self-counts only in `collect`, …) live in `product-views-lint.ts`.
 *
 * REPRESENTABLE: the recursive `ViewObjectShape` uses `z.lazy`, which the pinned zod@4.4.3
 * `z.toJSONSchema` exports as a `$defs` self-reference (verified empirically for this shape) — so
 * `exportProductJsonSchema` keeps working and the committed `product.schema.json` stays derivable.
 */
import { z } from 'zod';
import { SafeIdentifier } from './grammar.js';

// ---------------------------------------------------------------------------------------
// params — the view's DECLARED request inputs (path/query), each with a closed shape preset
// ---------------------------------------------------------------------------------------

/**
 * The CLOSED param shape presets ("input params"). A free-form author regex is deliberately NOT
 * offered (an adversarial pattern is a ReDoS vector; a preset set is fail-closed and product-neutral):
 *  - `safe_id`         — `/^[A-Za-z0-9_.-]{1,128}$/` (a bounded id/token shape).
 *  - `positive_int`    — an integer string ≥ 1.
 *  - `nonnegative_int` — an integer string ≥ 0.
 *  - `string`          — any non-empty string ≤ 1024 chars (bounded; params are DATA, never code).
 */
export const ViewParamShapePreset = z.enum([
  'safe_id',
  'positive_int',
  'nonnegative_int',
  'string',
]);
export type ViewParamShapePreset = z.infer<typeof ViewParamShapePreset>;

export const ViewParamSpec = z
  .object({
    /** Where the param binds: a `{name}` path segment or a `?name=` query param. */
    in: z.enum(['path', 'query']),
    /**
     * Whether the request MUST carry it. Path params are required by construction (the router only
     * matches a present segment) — lint rejects `required:false` on a path param. Query params
     * default to optional.
     */
    required: z.boolean().optional(),
    /** The closed validation preset (see `ViewParamShapePreset`). */
    shape: ViewParamShapePreset,
    /** An optional CLOSED value set (e.g. `[mic, system]`) — the param must be one of these. */
    enum: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();
export type ViewParamSpec = z.infer<typeof ViewParamSpec>;

// ---------------------------------------------------------------------------------------
// literal values + leaf types (the closed data vocabulary)
// ---------------------------------------------------------------------------------------

/** A literal scalar (string/number/boolean). */
const ViewScalar = z.union([z.string(), z.number(), z.boolean()]);
export type ViewScalar = z.infer<typeof ViewScalar>;

/**
 * A literal DATA value a view may declare: a scalar, `null`, an array of scalars (e.g. the frozen
 * `artifacts: []`), or the EMPTY object `{}`. Nothing else — a nested object/array literal would be
 * an un-inspected blob; richer defaults belong in the projection itself.
 */
export const ViewConstValue = z.union([
  ViewScalar,
  z.null(),
  z.array(ViewScalar),
  z.strictObject({}),
]);
export type ViewConstValue = z.infer<typeof ViewConstValue>;

/**
 * The CLOSED leaf type a projected value is checked against. A raw value that does not match
 * is replaced by the field's declared `default` (default `null`) — never passed through mis-typed:
 *  - `integer` — a finite integer; `number` — any finite number; `string`/`boolean` — typeof checks;
 *  - `object`  — a non-null, non-array object (e.g. a persisted jsonb payload surfaced verbatim);
 *  - `array`   — an array (surfaced verbatim; use `items` to PROJECT array elements instead).
 */
export const ViewLeafType = z.enum(['string', 'number', 'integer', 'boolean', 'object', 'array']);
export type ViewLeafType = z.infer<typeof ViewLeafType>;

// ---------------------------------------------------------------------------------------
// value references — how filters and sub-read matches name their inputs
// ---------------------------------------------------------------------------------------

/** A reference to a DECLARED view param (validated by lint: the param must exist in `params`). */
export const ViewParamRef = z.object({ param: z.string().min(1) }).strict();
export type ViewParamRef = z.infer<typeof ViewParamRef>;

/** A literal value. */
export const ViewConstRef = z.object({ const: ViewConstValue }).strict();
export type ViewConstRef = z.infer<typeof ViewConstRef>;

/** A reference to the PARENT row's column (sub-read matches only). */
export const ViewColumnRef = z.object({ column: SafeIdentifier }).strict();
export type ViewColumnRef = z.infer<typeof ViewColumnRef>;

/** A view-level filter argument: a declared param or a literal. */
export const ViewFilterArg = z.union([ViewParamRef, ViewConstRef]);
export type ViewFilterArg = z.infer<typeof ViewFilterArg>;

/** A sub-read match argument: the parent row's column, a declared param, or a literal. */
export const ViewMatchArg = z.union([ViewColumnRef, ViewParamRef, ViewConstRef]);
export type ViewMatchArg = z.infer<typeof ViewMatchArg>;

/** Order rows by a column (default `asc`). Executed server-side through the tenant-bound facade. */
export const ViewOrderBy = z
  .object({ column: SafeIdentifier, dir: z.enum(['asc', 'desc']).optional() })
  .strict();
export type ViewOrderBy = z.infer<typeof ViewOrderBy>;

/**
 * Exclude rows where `column === equals` (e.g. the frozen `dismissed === true` skip). STRICT
 * equality on a literal — a non-matching / malformed column value is NOT excluded (the safe
 * read-route default: a read never hides rows on a bad flag — mirrors the canonical `=== true` test).
 */
export const ViewExclude = z
  .object({ column: SafeIdentifier, equals: z.union([ViewScalar, z.null()]) })
  .strict();
export type ViewExclude = z.infer<typeof ViewExclude>;

/**
 * A nested one-to-many / one-to-one read against another STORE, keyed by equality matches. The
 * tenant predicate is STRUCTURAL beneath every match (the interpreter reads through the tenant-bound
 * `HandlerDb` facade over the real `TenantDb` chokepoint) — a match can narrow, never widen. A match
 * value that resolves to `undefined`/`null` at request time yields NO rows (deterministic, no query)
 * rather than an unfiltered read — fail-closed.
 */
export const ViewSubRead = z
  .object({
    store: SafeIdentifier,
    /** Child-column → parent-column/param/literal equality matches (lint requires ≥ 1). */
    match: z.record(SafeIdentifier, ViewMatchArg),
    exclude: z.array(ViewExclude).optional(),
    order_by: z.array(ViewOrderBy).optional(),
  })
  .strict();
export type ViewSubRead = z.infer<typeof ViewSubRead>;

// ---------------------------------------------------------------------------------------
// leaf fields
// ---------------------------------------------------------------------------------------

/** Project a row column, type-checked, with a literal default on mismatch/absence. */
export const ViewFieldColumn = z
  .object({
    kind: z.literal('column'),
    column: SafeIdentifier,
    type: ViewLeafType,
    default: ViewConstValue.optional(),
  })
  .strict();
export type ViewFieldColumn = z.infer<typeof ViewFieldColumn>;

/** Project a JSON path INTO a jsonb column (e.g. `payload.duration`), type-checked + defaulted. */
export const ViewFieldJson = z
  .object({
    kind: z.literal('json'),
    column: SafeIdentifier,
    /** The key path into the jsonb value (data keys, no expressions). */
    path: z.array(z.string().min(1)).min(1),
    type: ViewLeafType,
    default: ViewConstValue.optional(),
  })
  .strict();
export type ViewFieldJson = z.infer<typeof ViewFieldJson>;

/** Echo a DECLARED, validated request param (e.g. `session_id`) into the DTO. */
export const ViewFieldParam = z
  .object({ kind: z.literal('param'), param: z.string().min(1) })
  .strict();
export type ViewFieldParam = z.infer<typeof ViewFieldParam>;

/** A literal DTO value (the frozen `sample_rate: null`, `artifacts: []`, …). */
export const ViewFieldConst = z
  .object({ kind: z.literal('const'), value: ViewConstValue })
  .strict();
export type ViewFieldConst = z.infer<typeof ViewFieldConst>;

/** Inside an `items` shape ONLY: project a key path from the CURRENT array element. */
export const ViewFieldItem = z
  .object({
    kind: z.literal('item'),
    path: z.array(z.string().min(1)).min(1),
    type: ViewLeafType,
    default: ViewConstValue.optional(),
  })
  .strict();
export type ViewFieldItem = z.infer<typeof ViewFieldItem>;

/**
 * The shape applied to each element of a jsonb ARRAY (`items` fields). CLOSED BY CONSTRUCTION to
 * `item`/`const` fields — an array element has no row/param context, so no other kind is even
 * representable here (fail-closed at the grammar, not by convention).
 */
export const ViewItemShape = z
  .object({ fields: z.record(SafeIdentifier, z.union([ViewFieldItem, ViewFieldConst])) })
  .strict();
export type ViewItemShape = z.infer<typeof ViewItemShape>;

/** The scalar a `lookup` extracts from its matched row: a column, optionally a JSON path into it. */
export const ViewLookupLeaf = z
  .object({ column: SafeIdentifier, path: z.array(z.string().min(1)).optional() })
  .strict();
export type ViewLookupLeaf = z.infer<typeof ViewLookupLeaf>;

// ---------------------------------------------------------------------------------------
// composite fields (recursive) — TS interfaces first, zod schemas below
// ---------------------------------------------------------------------------------------

/** Map a jsonb ARRAY column/path to projected objects (the transcript `words`/`segments`). */
export interface ViewFieldItems {
  kind: 'items';
  column: string;
  path?: string[];
  shape: ViewItemShape;
}

/** One-to-many child rows, projected per row (the session-list `tracks`). */
export interface ViewFieldList {
  kind: 'list';
  source: ViewSubRead;
  shape: ViewObjectShape;
}

/** One-to-one child value: the FIRST matched row's leaf, type-checked + defaulted when absent. */
export interface ViewFieldLookup {
  kind: 'lookup';
  source: ViewSubRead;
  field: ViewLookupLeaf;
  type: ViewLeafType;
  default?: ViewConstValue;
}

/**
 * Per-bucket row tallies (`intelligence_counts` / intelligence `counts`). With `of`, counts a
 * sub-read per parent row; without `of` (collect mode only) counts the view's own collected rows.
 * `total`: `all_rows` counts EVERY row (the frozen session-list tally, which counts unknown kinds
 * too); `bucket_rows` counts only rows landing in a declared bucket (the frozen intelligence tally).
 */
export interface ViewFieldCounts {
  kind: 'counts';
  of?: ViewSubRead;
  by: string;
  buckets: string[];
  total: 'all_rows' | 'bucket_rows';
}

/**
 * A bucket of the view's COLLECTED rows (`collect` mode only): rows where `column === equals`,
 * surfaced as a projected list (`mode: list`) or a single first/last row (`absent` literal when no
 * row matches — the frozen `summary: null`). Exactly ONE of `value` (a leaf off each row) or `shape`
 * (a projected object per row) must be declared (lint-enforced).
 */
export interface ViewFieldGroup {
  kind: 'group';
  column: string;
  equals: ViewScalar;
  mode: 'list' | 'first' | 'last';
  value?: ViewGroupValue;
  shape?: ViewObjectShape;
  absent?: ViewConstValue;
}

/** The leaf a `group` extracts per row (like a column/json leaf, without the `kind` tag). */
export const ViewGroupValue = z
  .object({
    column: SafeIdentifier,
    path: z.array(z.string().min(1)).optional(),
    type: ViewLeafType,
    default: ViewConstValue.optional(),
  })
  .strict();
export type ViewGroupValue = z.infer<typeof ViewGroupValue>;

/** The paginated page's projected items (`list` mode only; exactly one per list view). */
export interface ViewFieldPageItems {
  kind: 'page_items';
  shape: ViewObjectShape;
}

/** The DTO shape: DTO field name → how its value is produced. */
export interface ViewObjectShape {
  fields: Record<string, ViewField>;
}

export type ViewField =
  | ViewFieldColumn
  | ViewFieldJson
  | ViewFieldParam
  | ViewFieldConst
  | ViewFieldItems
  | ViewFieldList
  | ViewFieldLookup
  | ViewFieldCounts
  | ViewFieldGroup
  | ViewFieldPageItems
  | { kind: 'page_total' }
  | { kind: 'page_next_offset' };

/**
 * The recursive object shape. `z.lazy` defers the union so `list`/`group`/`page_items` can nest
 * shapes; zod@4.4.3 parses this and `z.toJSONSchema` exports it as a `$defs` self-reference.
 */
export const ViewObjectShape: z.ZodType<ViewObjectShape> = z
  .object({
    fields: z.record(
      SafeIdentifier,
      z.lazy((): z.ZodType<ViewField> => ViewField),
    ),
  })
  .strict() as unknown as z.ZodType<ViewObjectShape>;

const ViewFieldItemsSchema = z
  .object({
    kind: z.literal('items'),
    column: SafeIdentifier,
    path: z.array(z.string().min(1)).optional(),
    shape: ViewItemShape,
  })
  .strict();

const ViewFieldListSchema = z
  .object({ kind: z.literal('list'), source: ViewSubRead, shape: ViewObjectShape })
  .strict();

const ViewFieldLookupSchema = z
  .object({
    kind: z.literal('lookup'),
    source: ViewSubRead,
    field: ViewLookupLeaf,
    type: ViewLeafType,
    default: ViewConstValue.optional(),
  })
  .strict();

const ViewFieldCountsSchema = z
  .object({
    kind: z.literal('counts'),
    of: ViewSubRead.optional(),
    by: SafeIdentifier,
    buckets: z.array(SafeIdentifier).min(1),
    total: z.enum(['all_rows', 'bucket_rows']),
  })
  .strict();

const ViewFieldGroupSchema = z
  .object({
    kind: z.literal('group'),
    column: SafeIdentifier,
    equals: ViewScalar,
    mode: z.enum(['list', 'first', 'last']),
    value: ViewGroupValue.optional(),
    shape: ViewObjectShape.optional(),
    absent: ViewConstValue.optional(),
  })
  .strict();

const ViewFieldPageItemsSchema = z
  .object({ kind: z.literal('page_items'), shape: ViewObjectShape })
  .strict();
const ViewFieldPageTotalSchema = z.object({ kind: z.literal('page_total') }).strict();
const ViewFieldPageNextOffsetSchema = z.object({ kind: z.literal('page_next_offset') }).strict();

/**
 * The CLOSED field union. An unknown/typo'd `kind` is fail-closed-rejected by the discriminated
 * union (a `schema_violation`, never a silently-dropped field — the FAIL-OPEN lesson: reject loudly).
 */
export const ViewField: z.ZodType<ViewField> = z.discriminatedUnion('kind', [
  ViewFieldColumn,
  ViewFieldJson,
  ViewFieldParam,
  ViewFieldConst,
  ViewFieldItemsSchema,
  ViewFieldListSchema,
  ViewFieldLookupSchema,
  ViewFieldCountsSchema,
  ViewFieldGroupSchema,
  ViewFieldPageItemsSchema,
  ViewFieldPageTotalSchema,
  ViewFieldPageNextOffsetSchema,
]) as unknown as z.ZodType<ViewField>;

// ---------------------------------------------------------------------------------------
// read — the view's declarative read (mode + filter + shape [+ absent])
// ---------------------------------------------------------------------------------------

/**
 * How the view reads its source:
 *  - `list`    — many rows, PAGINATED (pagination declaration required): the top-level shape is the
 *                ENVELOPE (page_items / page_total / page_next_offset + param/const fields only).
 *  - `single`  — the first matching row: the top-level shape projects THAT row; `absent` (or
 *                `absent_state: not_ready_409`) declares what happens when there is none.
 *  - `collect` — ALL matching rows, aggregated: the top-level shape admits param/const/group/counts.
 */
export const ViewReadMode = z.enum(['list', 'single', 'collect']);
export type ViewReadMode = z.infer<typeof ViewReadMode>;

/**
 * The absent-row DTO for `single` mode with `absent_state: empty_200` (the frozen absent-transcript /
 * absent-intelligence 200 shapes). CLOSED to `param`/`const` fields by construction — there is no row
 * to project from.
 */
export const ViewAbsentShape = z
  .object({ fields: z.record(SafeIdentifier, z.union([ViewFieldParam, ViewFieldConst])) })
  .strict();
export type ViewAbsentShape = z.infer<typeof ViewAbsentShape>;

export const ViewRead = z
  .object({
    mode: ViewReadMode,
    /** Source-column → param/literal equality filter (AND; the tenant predicate is beneath it). */
    filter: z.record(SafeIdentifier, ViewFilterArg).optional(),
    exclude: z.array(ViewExclude).optional(),
    order_by: z.array(ViewOrderBy).optional(),
    /** The DTO projection (SEPARATE from `response_contract`, which names the contract it must fit). */
    shape: ViewObjectShape,
    /** `single` + `empty_200` ONLY: the absent-row DTO. */
    absent: ViewAbsentShape.optional(),
  })
  .strict();
export type ViewRead = z.infer<typeof ViewRead>;

/**
 * Conditional-read behavior. `etag` (GET only): the runtime derives a strong ETag from the
 * response DTO, sets it on the 200, and answers a matching `If-None-Match` with a bodyless 304.
 * `If-Range` is DELIBERATELY not a view construct: byte-range serving is Tier-B media-capability
 * behavior (a media-serving concern), never a Product-YAML view — so it cannot be mis-declared.
 */
export const ViewConditionalRead = z.enum(['etag']);
export type ViewConditionalRead = z.infer<typeof ViewConditionalRead>;

/**
 * DTO field / param names that can never be declared (prototype-pollution guards). `SafeIdentifier`
 * admits a leading underscore, so `__proto__` would otherwise pass — lint rejects these everywhere a
 * name is declared (fields, params, match keys, buckets).
 */
export const VIEW_RESERVED_NAMES: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);
