/**
 * OpenAPI doc-emission for the DECLARED `api[]` routes.
 *
 * The declared routes register via raw `app.on(...)` (register-declared-routes.ts) — they share the
 * uniform validation + closed-ErrorCode envelope contract but, being raw, contribute NOTHING to an
 * OpenAPI document on their own (zod-openapi only documents routes registered via its typed
 * `.openapi(createRoute(...))`). This module closes that gap WITHOUT rewriting the interpreter: it
 * builds a plain OpenAPI 3.1 paths object DERIVED from the validated `spec.api[]` at runtime, which
 * `createAuthApp` serves at `GET /v1/openapi.json` (engine-only — a product-empty deploy has no
 * declared routes, so the served document carries an EMPTY `paths` object).
 *
 * HONEST SCOPE (do not oversell): the platform's STATIC routes (auth/orgs/oauth/runs)
 * are themselves registered raw (`app.post(...)`, not `createRoute`), so they too are absent from any
 * OpenAPI document today — this module documents the DECLARED routes only, and that is exactly what
 * scoped. A future slice can document the static surface by porting it to `createRoute` (or by
 * an analogous hand-built contribution); that is NOT done here.
 *
 * PRODUCT-AGNOSTIC: every path, parameter, and schema is DERIVED from the spec + the store columns at
 * runtime — no product route, store, or column name appears in platform source. The emission for
 * `{store}` routes derives request/response schemas from the `StoreSpec` (the SAME column → Zod
 * mapping the runtime validators use, via `store-validation.ts` + `z.toJSONSchema`, so the documented
 * shape cannot drift from what the route actually accepts/returns); `{agent}` derives its request body
 * from the SAME `StartRunRequest` Zod the run surface parses; `{handler}`/`{stream}` are documented as
 * OPAQUE (their bodies are arbitrary trusted-author product logic the platform cannot statically know).
 */

import {
  type ApiRouteSpec,
  braceParamNames,
  type ColumnType,
  type RaySpec,
  type ResponseProjection,
  rewriteBraceParams,
  type StoreOp,
  type StoreSpec,
} from '@rayspec/spec';
import { z } from 'zod';
import { StartRunRequest } from '../routes/runs.js';
import { INJECTED_COLUMN_TS_NAMES } from './injected-columns-view.js';
import { resolveResponseProjection } from './store-projection.js';
import { CONTROL_KEYS } from './store-query.js';
import { createBodySchema, NUMERIC_WIRE_RE, updateBodySchema } from './store-validation.js';

/**
 * THE POSTURE NOTICE both OpenAPI documents carry in `info.description`.
 *
 * Two documents describe this runtime and they are built by different code: the one written to a
 * file by `rayspec openapi` (`@rayspec/cli` `openapi.ts`), and the one THIS module builds, which
 * `createAuthApp` serves at `GET /v1/openapi.json` (`app.ts`, registered on the engine path). The
 * served one travels furthest: the generated artifact requires someone to have run the CLI, while
 * this one is handed to any client of a running deployment that asks — and the read is PUBLIC, so
 * it is handed over without a credential (`declared-routes.test.ts`, 'the openapi.json read is
 * PUBLIC'). A consumer holding only that response — a client generator, an API console, a
 * downstream integrator — has no other copy of this server's posture: not the README, not
 * SECURITY.md, and not the boot banner, which says the same thing at runtime (`@rayspec/server`
 * `banner.ts`, the `bootBanner` title line) but only to whoever watched the process start. A
 * description assembled only from `metadata.description` therefore reached the one audience with no
 * other copy of the warning, and reached it silently.
 *
 * TWO literals, and a test that holds them byte-identical. This paragraph used to say "ONE literal,
 * deliberately" and forbid a second copy in the CLI. That was FALSE THE DAY IT MERGED: #492 and #493
 * landed the two copies independently, so the file documented an invariant it did not have. The
 * copies are `packages/compose/api-auth/src/engine/emit-openapi.ts` (this one, served at
 * `GET /v1/openapi.json`) and `packages/app/cli/src/openapi.ts` (written to a file by
 * `rayspec openapi`).
 *
 * They are not ONE export because `@rayspec/cli` cannot cheaply reach this package — measured, not
 * assumed:
 *   - there is no dependency edge today: importing `@rayspec/api-auth` from `packages/app/cli`
 *     fails `ERR_MODULE_NOT_FOUND`;
 *   - adding one would rewrite the `importers` block of `pnpm-lock.yaml`, which `gate:sbom-fresh`
 *     hashes — forcing a regeneration of `docs/dependency-sbom.json`, the factual backing of
 *     `THIRD-PARTY-NOTICES.md`;
 *   - and `openapi.ts` is imported STATICALLY by the CLI entrypoint, so every `rayspec` invocation
 *     would pay the graph: `@rayspec/spec` + `@rayspec/views-runtime`, which is all that command
 *     loads today, is 128 modules / ~0.6 s; this package's barrel is 810 modules / ~2.4 s, and
 *     routing through `@rayspec/server` instead (which re-exports the product-boot graph) is 2261
 *     modules / ~4.1 s. A four-line string constant does not justify any of that on `rayspec init`.
 *
 * So the copies stay, and the DRIFT is what is closed instead: `emit-openapi.test.ts` and
 * `openapi.test.ts` each byte-pin the value AND read the other file off disk to assert the two
 * declarations are byte-identical. The pin is mirrored in both packages on purpose — CI splits the
 * test lanes, and a one-sided pin would leave one lane silent. Softening either sentence is red in
 * both suites; verified by mutating each copy in turn.
 *
 * Appended, never substituted: a declared description is the product's own and survives whole.
 * `emit-openapi.test.ts` pins both spec branches (declared description, and the branch that used to
 * emit no `description` key at all), and `declared-routes.test.ts` pins the notice on the SERVED
 * response body rather than on the builder's return value.
 *
 * Unconditional by construction: no env var, request header, query parameter or flag is read on the
 * way to emitting it, so there is no supported way to serve this document without the notice.
 */
export const OPENAPI_POSTURE_NOTICE =
  'LOCAL / trusted posture / NOT internet-facing — this API is served by a LOCAL, single-node, ' +
  'pre-external-hardening RaySpec deployment. The separate hardening layer (per-tenant sandbox, ' +
  'RLS, KMS-DEK, DPoP) is the gate before any external exposure and is not built yet. Never put ' +
  'this behind a public address.';

/** A minimal OpenAPI 3.1 document shape (only the parts we emit — no external type dependency). */
export interface OpenApiDocument {
  openapi: '3.1.0';
  info: { title: string; version: string; description?: string };
  paths: Record<string, OpenApiPathItem>;
}

/** One OpenAPI path item: a map of (lowercase) HTTP method → operation. */
type OpenApiPathItem = Record<string, OpenApiOperation>;

/** One OpenAPI operation (the subset we populate). */
interface OpenApiOperation {
  summary: string;
  /**
   * Optional operation prose. Emitted ONLY on a store operation whose route carries a NON-EMPTY
   * response projection, where it states the request/response NAMING SPLIT explicitly (query/path
   * parameters by declared column name, response fields by projected wire name) — a generated
   * client must read that rule here, not infer it from a 400. Absent otherwise: on an un-projected
   * route (the document is byte-identical) and on a `project: {}` opt-out route, which serves the
   * plain declared shape and therefore has no split to state.
   */
  description?: string;
  operationId: string;
  parameters?: OpenApiParameter[];
  requestBody?: {
    required: boolean;
    content: { 'application/json': { schema: Record<string, unknown> } };
  };
  responses: Record<string, OpenApiResponse>;
}

/**
 * One OpenAPI parameter — a `path` param (every declared `{param}`), a `query` param (the
 * `list` filters + order/after/limit), or a `header` param (the `create` `Idempotency-Key`).
 * `required` defaults to false for the query/header params (all optional); path params set it `true`.
 */
interface OpenApiParameter {
  name: string;
  in: 'path' | 'query' | 'header';
  required?: boolean;
  description?: string;
  schema: Record<string, unknown>;
}

/** A documented response header (X-Next-Cursor/X-Result-Truncated/Idempotency-Replay/Retry-After). */
interface OpenApiHeader {
  description: string;
  schema: { type: 'string' };
}

interface OpenApiResponse {
  description: string;
  headers?: Record<string, OpenApiHeader>;
  content?: { 'application/json': { schema: Record<string, unknown> } };
}

/**
 * Convert a Zod schema to a plain JSON-Schema object for embedding in the OpenAPI document. Uses
 * `z.toJSONSchema` with `io: 'input'` (the SAME setting `@rayspec/spec`'s exporter uses) so an
 * optional/`.default()`ed field is documented as NOT required on input — matching what the route
 * actually accepts. Wrapped in a try so an exotic schema degrades to a permissive object rather than
 * throwing and breaking the whole document (the doc is a best-effort description, never load-bearing).
 */
function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  try {
    return z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
  } catch {
    return { type: 'object', additionalProperties: true };
  }
}

/** Map a declared ColumnType to its JSON-Schema fragment for the RESPONSE (row) shape. */
function responseSchemaForColumnType(type: ColumnType): Record<string, unknown> {
  switch (type) {
    case 'text':
    case 'uuid':
      return { type: 'string' };
    case 'timestamp':
      return { type: 'string', format: 'date-time' };
    case 'integer':
      return { type: 'integer' };
    case 'bigint':
      // Bounded, because the RUNTIME is bounded: a bigint row value outside ±(2^53-1) is refused with
      // a 400 rather than serialized. An unbounded `{type:'integer'}` would document a 64-bit response
      // range this API does not actually serve.
      return {
        type: 'integer',
        minimum: Number.MIN_SAFE_INTEGER,
        maximum: Number.MAX_SAFE_INTEGER,
      };
    case 'boolean':
      return { type: 'boolean' };
    case 'jsonb':
      return {}; // free-form JSON value
    case 'double':
      // A plain JSON number — float8 IS IEEE-754 binary64, so the float a client wrote is the float
      // it reads back (float64 semantics are the documented contract; a non-finite stored value is
      // refused with a 400 rather than serialized, since JSON cannot carry NaN/Infinity).
      return { type: 'number' };
    case 'numeric':
      // A decimal STRING, because the RUNTIME is exact: a numeric value crosses the wire as a plain
      // decimal string in both directions (JSON numbers pass through float64 in every parser, which
      // corrupts a decimal past 2^53 — exactness is the point of the type, so the string is the only
      // honest wire form; the bounded bigint schema above is the model for documenting the runtime's
      // real envelope). Reads render Postgres's canonical form with exactly `scale` fractional digits.
      //
      // The pattern is `NUMERIC_WIRE_RE` ITSELF (store-validation.ts) — the same object the
      // create/update body validator enforces and `store-query.ts` tests every numeric filter and
      // cursor value against, so the three numeric patterns in this document cannot diverge from the
      // envelope the server applies. Its 1..1000 digit runs also bound what a READ can carry: the
      // grammar caps `precision` at 1000 and lint keeps `scale <= precision`, so a rendered
      // numeric(precision, scale) never exceeds them. A hand-written `^-?\d+(\.\d+)?$` used to sit
      // here and documented unbounded digit runs the wire never carries.
      return { type: 'string', pattern: NUMERIC_WIRE_RE.source };
  }
}

/**
 * Make a base JSON-Schema fragment NULLABLE in OpenAPI **3.1** style (JSON-Schema 2020-12): widen its
 * `type` to a `[base, 'null']` UNION. The doc declares `openapi: '3.1.0'`, where the OpenAPI-3.0
 * `nullable: true` keyword was REMOVED — so we must NOT emit it. A carried `format` (e.g. `date-time`)
 * stays as an annotation alongside the union (it annotates the string variant; harmless on the null
 * variant). Applied to BOTH the declared business columns and the injected columns so the whole row
 * schema uses one consistent 3.1 nullability representation.
 */
function nullable3_1(base: Record<string, unknown>): Record<string, unknown> {
  const t = base.type;
  // A typeless fragment (jsonb → `{}`, a free-form JSON value) already permits null — leave it as-is
  // (adding `type: ['null', ...]` would WRONGLY narrow a free-form value to null only). For a scalar
  // `type` widen it to a 2-member `[type, 'null']` union; an already-array `type` is left unchanged.
  if (typeof t !== 'string') return base;
  return { ...base, type: [t, 'null'] };
}

/** The injected-column → JSON-Schema fragment for the response row (server-controlled columns). */
const INJECTED_RESPONSE_PROPS: Record<string, Record<string, unknown>> = {
  id: { type: 'string', format: 'uuid' },
  tenant_id: { type: 'string', format: 'uuid' },
  created_at: { type: 'string', format: 'date-time' },
  // Nullable injected columns use the 3.1 `[type, 'null']` union (NOT the removed `nullable` keyword).
  deleted_at: { type: ['string', 'null'], format: 'date-time' },
  retention_days: { type: ['integer', 'null'] },
  region: { type: 'string' },
  // The actor stamp + the store.create idempotency key (both nullable server-controlled).
  created_by: { type: ['string', 'null'] },
  idempotency_key: { type: ['string', 'null'] },
};

/**
 * Build the RESPONSE (row) JSON-Schema for a store: the injected server-controlled columns (snake_case
 * wire names, exactly what `serializeRow` exposes) + the declared business columns (author snake_case
 * names, nullable where declared). This mirrors `serializeRow` so the documented response shape is the
 * real wire shape, not a guess.
 *
 * A route-level/store-level `project` reshapes BOTH sides of that mirror through the SAME resolution
 * (`resolveResponseProjection` — one shared `snake → wire name` map the serializer consumes too, so
 * the documented shape and the served shape cannot drift): each column's type fragment is emitted
 * under its WIRE name, and a column the projection omits is absent. Values are untouched — the
 * projection renames/filters keys, never reshapes a fragment. No `project` ⇒ byte-identical emission.
 */
function storeRowSchema(store: StoreSpec, project?: ResponseProjection): Record<string, unknown> {
  const wireBySnake = resolveResponseProjection(store, project);
  // Prototype-free accumulator: the keys are author-derived column/wire names, so a name like
  // `__proto__`/`constructor` lands as a plain own-property here, never a prototype mutation (on a plain
  // `{}` such a key would be silently dropped/reparented). Behaviour is otherwise identical — own
  // enumerable keys serialize the same, and the doc is JSON-serialized (no prototype method is called).
  const properties: Record<string, Record<string, unknown>> = Object.create(null);
  // Injected columns first (the same set serializeRow re-keys to snake_case).
  for (const snake of Object.keys(INJECTED_COLUMN_TS_NAMES)) {
    const wire = wireBySnake === undefined ? snake : wireBySnake.get(snake);
    if (wire === undefined) continue; // projected away
    properties[wire] = INJECTED_RESPONSE_PROPS[snake] ?? {};
  }
  // Declared business columns under their wire names (author snake_case without a projection). A
  // nullable column uses the 3.1 `[type, 'null']` union (consistent with the injected columns above)
  // — NOT the removed `nullable` keyword.
  for (const col of store.columns) {
    const wire = wireBySnake === undefined ? col.name : wireBySnake.get(col.name);
    if (wire === undefined) continue; // projected away
    const base = responseSchemaForColumnType(col.type);
    properties[wire] = col.nullable ? nullable3_1(base) : base;
  }
  // The row carries EXACTLY the injected + declared columns the projection exposes (the closed,
  // server-serialized wire shape), so the response schema is strict — no silent extra props
  // (matching the strict create/update bodies).
  return { type: 'object', properties, additionalProperties: false };
}

/** Path params parsed from a declared OpenAPI-style path (`/meetings/{id}/x` → `['id']`). */
function pathParamNames(path: string): string[] {
  // Shared linear, no-regex scan (byte-exact `\{([^}/]+)\}` extraction, no length cap on the name).
  return braceParamNames(path);
}

/** The OpenAPI `parameters` array for a path's `{param}`s (every declared path param is a string). */
function pathParameters(path: string): OpenApiParameter[] | undefined {
  const names = pathParamNames(path);
  if (names.length === 0) return undefined;
  return names.map((name) => ({ name, in: 'path', required: true, schema: { type: 'string' } }));
}

/**
 * A short, stable operationId from a method + path (e.g. `get_meetings_by_id`). COLLISION-RESISTANT:
 * a `{param}` is rendered as a distinct `_by_<param>` marker BEFORE the non-alphanumeric collapse, so a
 * literal path segment can never produce the same slug as a `{param}` one (pre-fix `/x/{id_status}` and
 * `/x/id-status` both collapsed to `x_id_status` → a duplicate operationId, which breaks OpenAPI's
 * unique-operationId requirement + codegen). The marker text is itself slug-collapsed afterward.
 */
function operationId(method: string, path: string): string {
  const slug = rewriteBraceParams(path, (name) => `_by_${name}_`)
    // `{name}` → `_by_name_` (the leading/trailing `_` keep it a distinct token after collapse), so a
    // brace segment is structurally distinguishable from a literal segment of the same characters. The
    // brace rewrite is a linear, no-regex forward scan (no length cap on the param name).
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
  return `${method.toLowerCase()}_${slug || 'root'}`;
}

/** A generic opaque-object schema for `{handler}`/`{stream}` routes (body is arbitrary product logic). */
const OPAQUE_OBJECT: Record<string, unknown> = { type: 'object', additionalProperties: true };

/**
 * The declared-route request throttle's `429`. Every declared route that mounts the Bearer chain can
 * answer it, so it is attached centrally rather than restated per action arm. It fires BEFORE the
 * route runs, which is what distinguishes it from an `{agent}` route's run-outcome `429`; that arm
 * documents its own richer `429` covering both meanings and keeps it.
 *
 * The "one budget for the whole declared surface" claim is scoped to the two SHARED TIER allowances,
 * and only to those. A route may additionally declare its own `rateLimit`, whose budget is per route —
 * `routeBudgetSentence` states it, and a route that declares one gets that sentence appended.
 */
const THROTTLE_429: OpenApiResponse = {
  description:
    'Rate limited by the declared-route request throttle, which fires BEFORE the route runs (so ' +
    'nothing was executed). The tier is chosen after the credential has been validated: a validated ' +
    'principal is counted against a generous per-principal budget, an absent or invalid credential ' +
    'against a strict one keyed on the client source. Each of those two TIER allowances is ONE budget ' +
    'for the whole declared surface, not one per route. Retry advice is carried twice — a Retry-After ' +
    'header in whole seconds and error.details.retryAfterMs in the body.',
  headers: {
    'Retry-After': {
      description: 'Seconds to wait before retrying. Always present on a throttle 429.',
      schema: { type: 'string' },
    },
  },
};

/**
 * The one sentence that documents a route's OWN declared budget, next to the surface-wide tier. It is
 * additive: a call must be inside BOTH, so the effective allowance is the smaller of the two.
 */
function routeBudgetSentence(rateLimit: NonNullable<ApiRouteSpec['rateLimit']>): string {
  return (
    `This route additionally declares its own budget of ${rateLimit.max} request(s) per ` +
    `${rateLimit.windowSeconds} second(s), counted per tenant and principal for this route alone and ` +
    'applied IN ADDITION to the surface-wide tier above.'
  );
}

/** Build the operation for ONE declared route. Returns undefined for a kind we cannot resolve. */
function operationForRoute(
  route: ApiRouteSpec,
  storeByName: ReadonlyMap<string, StoreSpec>,
): OpenApiOperation | undefined {
  const op = buildOperation(route, storeByName);
  if (!op) return undefined;
  // A stream `playback` route is authorized by a signed media token and mounts its own middleware, so
  // it never reaches this throttle — it is bounded by the per-user concurrent-stream limit instead.
  // (Such a route may not declare a `rateLimit` at all; the registrar refuses that at boot.)
  if (route.action.kind === 'stream' && route.action.mode === 'playback') return op;
  const budget = route.rateLimit ? ` ${routeBudgetSentence(route.rateLimit)}` : '';
  // An arm that already documents a 429 (the `{agent}` run-outcome one) keeps its own description —
  // the cross-cutting one must not overwrite it. A declared per-route budget is still APPENDED to it,
  // because that budget is enforced on this route whichever 429 the arm chose to describe.
  const existing = op.responses['429'];
  if (existing) {
    if (!budget) return op;
    return {
      ...op,
      responses: {
        ...op.responses,
        '429': { ...existing, description: `${existing.description}${budget}` },
      },
    };
  }
  return {
    ...op,
    responses: {
      ...op.responses,
      '429': { ...THROTTLE_429, description: `${THROTTLE_429.description}${budget}` },
    },
  };
}

/** The per-kind operation shape, before the cross-cutting throttle response is attached. */
function buildOperation(
  route: ApiRouteSpec,
  storeByName: ReadonlyMap<string, StoreSpec>,
): OpenApiOperation | undefined {
  const params = pathParameters(route.path);
  const base = {
    operationId: operationId(route.method, route.path),
    ...(params ? { parameters: params } : {}),
  };
  const action = route.action;

  if (action.kind === 'store') {
    const store = storeByName.get(action.store);
    if (!store) return undefined; // an undeclared store ref (lint normally resolves it) — skip it.
    // The route's EFFECTIVE projection — a route-level `project` overrides the store-level one
    // WHOLESALE (the same resolution the registrar hands makeStoreHandler, so the document
    // describes exactly what the route serves).
    return storeOperation(store, action.op, base, route.project ?? store.project);
  }

  if (action.kind === 'agent') {
    return {
      ...base,
      summary: `Run the '${action.agent}' agent.`,
      requestBody: {
        required: true,
        content: { 'application/json': { schema: toJsonSchema(StartRunRequest) } },
      },
      // The failed-run statuses ARE the run surface's errorClass → HTTP mapping (runs.ts
      // `statusForErrorClass`), described here so a generated client reads the same rule the spec
      // reference states instead of having to infer it from a live 429: a TERMINAL class is a real,
      // repeatable outcome that stays 200 and is replayed under the Idempotency-Key, a TRANSIENT one
      // gets a real error status and releases the key so a same-key retry re-runs. The 409 is the one
      // status that is NOT an errorClass mapping: it is a state conflict, and the operation answers it
      // for TWO distinct reasons — an Idempotency-Key conflict (the key reused with a different body, or
      // a run still in progress under it) and a run ended on demand while this request held it. They
      // advise a caller differently, so the description names both rather than the newer one alone.
      responses: {
        '200': {
          description:
            'The neutral RunResult (sync) — Accept: text/event-stream streams it as SSE. Also the ' +
            'response for a run that FAILED with a TERMINAL errorClass (upstream_4xx, model_refusal, ' +
            'cancelled, internal): the run executed (or was ended on demand) and produced a repeatable ' +
            "outcome, so the body carries it as status:'error' + errorClass, and a same-key retry " +
            'replays this result rather than re-running.',
          content: { 'application/json': { schema: OPAQUE_OBJECT } },
        },
        '202': {
          description: 'Accepted — an async run was enqueued (async:true on a durable worker).',
        },
        '409': {
          description:
            'A state conflict — this operation answers it for two distinct reasons, and the body code ' +
            'says which. (1) IDEMPOTENCY_CONFLICT: the Idempotency-Key was reused with a different ' +
            'agent/body, or a run is already in progress under it. Neither replays a result — a retry ' +
            'answers 409 again until the offending key is changed (different body) or the in-progress ' +
            'run has finished (same body). (2) CONFLICT: the run this request was holding was ENDED ON ' +
            "DEMAND (POST /v1/runs/{id}/cancel) before it produced a result. The run's own terminal " +
            "outcome — status:'error' with errorClass 'cancelled' — is durable and readable at " +
            'GET /v1/runs/{id}, and its Idempotency-Key reservation is KEPT, so a same-key retry replays ' +
            'that outcome (200) rather than re-running a run someone stopped.',
          content: { 'application/json': { schema: OPAQUE_OBJECT } },
        },
        '429': {
          description:
            "The run failed with the TRANSIENT errorClass rate_limited; the body is the RunResult (status:'error'). " +
            'A same-key retry RE-RUNS the agent (the Idempotency-Key reservation is released) — unless the run ' +
            'fired a non-idempotent tool, in which case the reservation is kept and the retry replays this 429. ' +
            'A 429 can ALSO come from the declared-route request throttle, which fires BEFORE the route runs: ' +
            "that one carries the standard error envelope (error.code 'RATE_LIMITED', no status/errorClass field) " +
            'plus error.details.retryAfterMs, always sets Retry-After, and means no agent executed and no ' +
            'Idempotency-Key reservation was taken or released. The body shape is what distinguishes them.',
          headers: {
            'Retry-After': {
              description:
                'Seconds to wait before retrying. On a run-produced 429 it is present when the backend adapter ' +
                'captured retry advice from the upstream rate limit, and is identical on a live 429 and on a ' +
                'replayed one; on a request-throttle 429 it is always present.',
              schema: { type: 'string' },
            },
          },
          content: { 'application/json': { schema: OPAQUE_OBJECT } },
        },
        '502': {
          description:
            "The run failed with the TRANSIENT errorClass upstream_5xx; the body is the RunResult (status:'error'). " +
            'A same-key retry RE-RUNS the agent (the reservation is released), unless the run fired a ' +
            'non-idempotent tool.',
          headers: {
            'Retry-After': {
              description:
                'Seconds to wait before retrying — present when the backend adapter captured retry advice ' +
                'from the upstream 5xx. Identical on a live 502 and on a replayed one.',
              schema: { type: 'string' },
            },
          },
          content: { 'application/json': { schema: OPAQUE_OBJECT } },
        },
        '504': {
          description:
            "The run failed with the TRANSIENT errorClass timeout; the body is the RunResult (status:'error') " +
            'and a same-key retry RE-RUNS the agent, unless the run fired a non-idempotent tool. A run that ' +
            'THREW instead — the held request hitting its timeout — answers the same status with the standard ' +
            'error envelope (GATEWAY_TIMEOUT), carrying the neutral class in details.errorClass.',
          content: { 'application/json': { schema: OPAQUE_OBJECT } },
        },
      },
    };
  }

  if (action.kind === 'handler') {
    // {handler}: an arbitrary trusted-author JSON body/response the platform cannot statically know —
    // documented as opaque (still listing the path + its params).
    return {
      ...base,
      summary: `A declared route handler ('${action.handler}') — opaque JSON body/response.`,
      requestBody: {
        required: false,
        content: { 'application/json': { schema: OPAQUE_OBJECT } },
      },
      responses: { '200': { description: 'Handler-defined response (opaque).' } },
    };
  }

  if (action.kind === 'stream') {
    // {stream}: a raw binary ingest/playback body+response (NOT JSON) — opaque, no JSON requestBody.
    return {
      ...base,
      summary: `A ${action.mode} stream handler ('${action.handler}') — raw binary body/response (opaque).`,
      responses: { '200': { description: 'Handler-defined response (opaque).' } },
    };
  }

  // Exhaustiveness guard (mirrors registerDeclaredRoutes): every `RouteAction.kind` is handled above. If
  // a new member is added to the closed union without a matching arm, `action` is NOT `never` here and
  // this is a COMPILE error — a future route kind can never silently fall through to a generic shape.
  return assertNever(action);
}

/**
 * Compile-time exhaustiveness assertion for the `RouteAction` union — so a new member added without an
 * emission arm is a COMPILE error at the call site (NOT silently documented as a generic shape). At
 * RUNTIME (only reachable via a code-built spec that bypassed parse/lint with an unknown kind) it
 * returns undefined fail-closed, so the doc skips an unresolvable route rather than emitting a broken
 * entry (matching `operationForRoute`'s `| undefined` contract).
 */
function assertNever(action: never): undefined {
  void (action as { kind?: unknown }).kind;
  return undefined;
}

/**
 * The bounded `list` page size (mirrors store-query.ts `MAX_LIMIT`). Documented as the `limit` param's
 * maximum; kept in sync by the `list` query-param test (a doc, not a runtime bound — the runtime cap
 * lives in store-query.ts).
 */
const LIST_MAX_LIMIT = 200;

/**
 * The bounded `<col>__in` set-filter element count (mirrors store-query.ts `MAX_IN_VALUES`). Documented
 * in the `<col>__in` param description; kept in sync by the `list` query-param test (a doc, not a
 * runtime bound — the runtime cap lives in store-query.ts).
 */
const LIST_MAX_IN_VALUES = 100;

/** Map a declared ColumnType to a JSON-Schema fragment for a `list` equality-filter QUERY parameter. */
function filterParamSchema(type: ColumnType): Record<string, unknown> {
  switch (type) {
    case 'integer':
      return { type: 'integer' };
    case 'bigint':
      // A bigint column IS filterable (only jsonb is excluded downstream), and the filter coercion
      // applies the SAME ±(2^53-1) bound the body validator and the row serializer apply — one range
      // end to end: body in, body out, equality filter, `__in` element, keyset cursor.
      return {
        type: 'integer',
        minimum: Number.MIN_SAFE_INTEGER,
        maximum: Number.MAX_SAFE_INTEGER,
      };
    case 'boolean':
      return { type: 'boolean' };
    case 'uuid':
      return { type: 'string', format: 'uuid' };
    case 'timestamp':
      return { type: 'string', format: 'date-time' };
    case 'text':
      return { type: 'string' };
    case 'double':
      // The filter coercion parses a finite float64 — the same value semantics as the body/row.
      return { type: 'number' };
    case 'numeric':
      // A plain decimal string (no exponent), compared EXACTLY server-side — same wire form as the
      // body/row, one string envelope end to end: body in, body out, equality filter, `__in`
      // element, keyset cursor. The pattern is `NUMERIC_WIRE_RE` ITSELF — the very regex
      // `store-query.ts` tests a numeric filter value against — so the documented filter envelope IS
      // the runtime's, never a looser hand-copy of it (the previous `^-?\d+(\.\d+)?$` admitted digit
      // runs past the 1..1000 bound, which the query builder answers with a 400).
      return { type: 'string', pattern: NUMERIC_WIRE_RE.source };
    case 'jsonb':
      return { type: 'string' }; // unreachable — jsonb columns are excluded from filter params below
  }
}

/**
 * Build the `list` QUERY parameters DERIVED from the StoreSpec — the SAME surface store-query.ts accepts:
 *  - control params `order` / `after` / `limit`;
 *  - one equality-filter param per declared BUSINESS column (a `jsonb` column is NOT filterable at
 *    runtime, so it is excluded — documenting it would over-claim), keyed by the AUTHOR snake name;
 *  - a `<col>__in` SET-filter param per filterable column (a comma-separated value list → SQL `IN`);
 *  - a `<col>__gt`/`__gte`/`__lt`/`__lte` COMPARISON-filter param set per non-nullable, non-jsonb
 *    DECLARED column (the operator eligibility rule — injected columns are excluded);
 *  - the injected `created_by` equality + `created_by__in` set filter.
 * All optional. Product-agnostic: every name is derived from the spec, none is hard-coded.
 */
function inFilterParam(name: string): OpenApiParameter {
  // The `<col>__in` value is a raw comma-separated list (matches store-query.ts, which splits on `,` +
  // coerces each element to the column type) — documented as a string, not an array, because the wire
  // form is the literal `?<col>__in=v1,v2` (a distinct query key), not an `explode`d array param.
  return {
    name: `${name}__in`,
    in: 'query',
    required: false,
    description: `Set filter on '${name}': a comma-separated list (1..${LIST_MAX_IN_VALUES}) of '${name}' values — matches a row whose '${name}' is ANY of them (SQL IN).`,
    schema: { type: 'string' },
  };
}

/**
 * The `<col>__contains` SUBSTRING-filter param for a TEXT column (matches store-query.ts, which runs a
 * case-insensitive `ILIKE '%term%'` on that column with the term's LIKE wildcards escaped). A raw string
 * term — the wire form is the literal `?<col>__contains=term`.
 */
function containsFilterParam(name: string): OpenApiParameter {
  return {
    name: `${name}__contains`,
    in: 'query',
    required: false,
    description: `Case-insensitive substring filter on '${name}': matches a row whose '${name}' CONTAINS the given term (the term's wildcards are matched literally).`,
    schema: { type: 'string' },
  };
}

/**
 * The comparison-operator suffixes and their prose (matches store-query.ts `OPERATOR_SUFFIXES`).
 * One `<col>__<op>` query param each per ELIGIBLE column — a non-nullable, non-jsonb DECLARED
 * business column (never an injected column) — mirroring the runtime eligibility rule exactly, so
 * the document never advertises an operator param the server 400s.
 */
const COMPARISON_OPS: ReadonlyArray<readonly [string, string]> = [
  ['gt', 'greater than'],
  ['gte', 'greater than or equal to'],
  ['lt', 'less than'],
  ['lte', 'less than or equal to'],
];

/**
 * A `<col>__gt`/`__gte`/`__lt`/`__lte` COMPARISON-filter param (matches store-query.ts, which coerces
 * the value with the SAME per-type rules equality uses and folds a single bound into the AND-chain —
 * two compatible bounds make a range). The value schema is the SAME per-type fragment the equality
 * filter documents.
 */
function comparisonFilterParam(
  name: string,
  op: string,
  prose: string,
  type: ColumnType,
): OpenApiParameter {
  return {
    name: `${name}__${op}`,
    in: 'query',
    required: false,
    description:
      `Comparison filter on '${name}': matches a row whose '${name}' is ${prose} the given value. ` +
      'Available only on non-nullable, non-jsonb declared columns; composes with other filters, ' +
      'order, and keyset pagination.',
    schema: filterParamSchema(type),
  };
}

function listQueryParameters(store: StoreSpec): OpenApiParameter[] {
  const params: OpenApiParameter[] = [
    {
      name: 'order',
      in: 'query',
      required: false,
      description:
        "Sort as '<column>.asc' or '<column>.desc' over a NON-nullable column (id, created_at, or a " +
        'non-nullable declared column). Default: id.asc.',
      schema: { type: 'string' },
    },
    {
      name: 'after',
      in: 'query',
      required: false,
      description:
        'Opaque keyset cursor from a prior page (the X-Next-Cursor response header); must match the ' +
        'current order.',
      schema: { type: 'string' },
    },
    {
      name: 'limit',
      in: 'query',
      required: false,
      description: `Page size (1..${LIST_MAX_LIMIT}). Default ${LIST_MAX_LIMIT}.`,
      schema: { type: 'integer', minimum: 1, maximum: LIST_MAX_LIMIT },
    },
  ];
  // Every name the RUNTIME resolves at Precedence 1 (store-query.ts): ALL declared column names —
  // jsonb ones included — plus the injected filterable `created_by`. This, and NOT the equality-param
  // set below, is what the `__in`/`__contains`/comparison companions must be DE-DUPLICATED against.
  // A key that names a declared column never reaches its suffix branch at runtime: the full key is
  // looked up first. So for every such companion name exactly one of two things is true, and neither
  // wants the companion emitted — a FILTERABLE column of that name answers it as plain equality (its
  // own param is already emitted below), and a JSONB column of that name answers it with a 400
  // (jsonb is not filterable). Keying the de-dup on the equality set, which omits jsonb columns,
  // documented the second case: a store with an eligible column `foo` and a jsonb column literally
  // named `foo__gt` carried a `foo__gt` parameter the server always refuses.
  const precedenceOneNames = new Set<string>(store.columns.map((c) => c.name));
  precedenceOneNames.add('created_by'); // the injected filterable column (store-query INJECTED_FILTERABLE)
  // The equality-filter surface: one param per declared non-jsonb business column (a control-key-named
  // column is skipped — defense-in-depth), PLUS the injected `created_by`. Collected FIRST, with their
  // names, so the `<col>__in` set-filter companions below know which columns to companion.
  const equalityNames = new Set<string>();
  // The TEXT columns (declared business + injected created_by) that each back a `?<col>__contains=`
  // substring-filter companion — collected alongside the equality params. NOTE the `?search=` control
  // param is gated SEPARATELY (on the DECLARED text columns only — see below): at runtime `search` scans
  // the declared text columns and the injected created_by does NOT widen it, so it must not appear in
  // this set's role of deciding whether `search` is emitted.
  const textNames = new Set<string>();
  // The COMPARISON-eligible columns (name → type): the non-nullable, non-jsonb DECLARED business
  // columns — the exact runtime eligibility set (store-query.ts). The injected `created_by` is
  // deliberately NEVER added (injected columns are not operator-eligible), so no `created_by__gt`
  // param can over-claim a request the server 400s.
  const comparableColumns = new Map<string, ColumnType>();
  for (const col of store.columns) {
    if (col.type === 'jsonb') continue; // jsonb is not filterable — omit rather than over-claim
    // Defense-in-depth: a column named after a control key (order/after/limit/search) is already
    // rejected at config by the linter (@rayspec/spec RESERVED_QUERY_KEYWORDS), but skip it here too so a
    // code-built spec that bypassed the parser can never emit a DUPLICATE query parameter (control param
    // + filter param sharing name+in) → keeping the emitted document a VALID OpenAPI 3.1 doc.
    if (CONTROL_KEYS.has(col.name)) continue;
    equalityNames.add(col.name);
    if (col.type === 'text') textNames.add(col.name);
    if (!col.nullable) comparableColumns.set(col.name, col.type);
    params.push({
      name: col.name,
      in: 'query',
      required: false,
      description: `Equality filter on '${col.name}'.`,
      schema: filterParamSchema(col.type),
    });
  }
  // The injected created_by equality filter (always present on a list op); it is a text column, so it
  // also backs a `created_by__contains` substring filter.
  equalityNames.add('created_by');
  textNames.add('created_by');
  params.push({
    name: 'created_by',
    in: 'query',
    required: false,
    description: 'Equality filter on the injected created_by actor stamp.',
    schema: { type: 'string' },
  });
  // The substring-search control param — emitted ONLY when the store declares at least one text column,
  // mirroring the runtime EXACTLY (store-query.ts scans `store.columns.filter(c => c.type === 'text')`).
  // The injected created_by is a text column but does NOT back `?search=` at runtime, so it must never
  // make `search` available here: on a store with no declared text column `?search=` 400s, so
  // documenting it would over-claim a param the server rejects.
  if (store.columns.some((c) => c.type === 'text')) {
    params.push({
      name: 'search',
      in: 'query',
      required: false,
      description:
        'Case-insensitive substring search: matches a row where ANY text column CONTAINS the given ' +
        'term (the term is matched literally — its wildcards do not act as wildcards).',
      schema: { type: 'string' },
    });
  }
  // The ranked FULL-TEXT-SEARCH control param — emitted ONLY when the store enables `fullTextSearch`
  // (mirrors the runtime: `?__search=` 400s on a store without full-text search). It is mutually
  // exclusive with `order`/`after`/`search` (the server rejects the combination) and returns a single
  // relevance-ordered page (no keyset cursor). `__search` is a reserved query keyword, so no declared
  // column can share its name.
  if (store.fullTextSearch === true) {
    params.push({
      name: '__search',
      in: 'query',
      required: false,
      description:
        'Ranked full-text search: matches rows whose text columns satisfy the query ' +
        '(websearch syntax) and orders them by relevance (ts_rank). Mutually exclusive with ' +
        'order/after/search; returns a single relevance-ordered page (no keyset cursor).',
      schema: { type: 'string' },
    });
  }
  // The `<col>__in` SET-filter companions — one per equality column, EXCEPT when the companion name is
  // ITSELF a name the runtime resolves at Precedence 1. That happens when a column is literally named
  // `<x>__in` (colliding with `<x>`'s IN-companion) or when a business column is named `created_by__in`
  // (colliding with the injected `created_by`'s companion). Either way `?<col>__in=` is answered by
  // that column and never as a set filter, so the companion is DROPPED: the emitted document neither
  // carries a duplicate (name+in) parameter — it stays a valid OpenAPI 3.1 doc — nor advertises a set
  // filter on a jsonb column, which the server refuses with a 400.
  for (const name of equalityNames) {
    if (precedenceOneNames.has(`${name}__in`)) continue;
    params.push(inFilterParam(name));
  }
  // The `<col>__contains` SUBSTRING-filter companions — one per TEXT column, EXCEPT when the companion
  // name is ITSELF a Precedence-1 name (a column literally named `<x>__contains`). Same rule as the
  // `__in` companions above, for the same two reasons: no duplicate parameter, and no substring filter
  // documented on a key the server answers as equality or refuses outright.
  for (const name of textNames) {
    if (precedenceOneNames.has(`${name}__contains`)) continue;
    params.push(containsFilterParam(name));
  }
  // The `<col>__gt`/`__gte`/`__lt`/`__lte` COMPARISON-filter companions — one set per eligible
  // (non-nullable, non-jsonb, declared) column, EXCEPT when a companion name is ITSELF a Precedence-1
  // name (a column literally named `<x>__gt`). Each of the four operators is checked on its own, so a
  // column that shadows one of them costs its eligible sibling only that one bound.
  for (const [name, type] of comparableColumns) {
    for (const [op, prose] of COMPARISON_OPS) {
      if (precedenceOneNames.has(`${name}__${op}`)) continue;
      params.push(comparisonFilterParam(name, op, prose, type));
    }
  }
  return params;
}

/**
 * Build the operation for a `{store}` route from its op + the StoreSpec-derived schemas.
 *
 * `project` (the route's effective response projection) reshapes the RESPONSE row schemas only —
 * the request surface (path/query parameters, create/update body schemas) stays author-named, and
 * the operation `description` states that naming split explicitly so a generated client reads the
 * rule instead of inferring it from a 400. No `project` ⇒ a byte-identical operation.
 */
function storeOperation(
  store: StoreSpec,
  op: StoreOp,
  base: { operationId: string; parameters?: OpenApiParameter[] },
  project?: ResponseProjection,
): OpenApiOperation {
  const row = storeRowSchema(store, project);
  const rowResponse: OpenApiResponse = {
    description: `A '${store.name}' row.`,
    content: { 'application/json': { schema: row } },
  };
  // The documented naming split of a projected route: responses carry the projected WIRE names;
  // everything request-side keeps the DECLARED column names (the projection is read-side only).
  //
  // Gated on a NON-EMPTY projection. `project: {}` is the documented per-route OPT-OUT (a route-level
  // projection overrides a store-level one WHOLESALE, so `{}` opts that route back out) — and `{}` is
  // not nullish, so it reaches here as a defined projection whose resolved shape is the plain declared
  // one. An opted-out route serves no split, so it must not state one.
  //
  // The request-side casing clause is what the server actually accepts, not a restatement of the
  // response rule: `normalizeBodyCasing` (store-validation.ts, applied in store-routes.ts on both the
  // create and the update body BEFORE the strict Zod parse) renames a declared snake key to its
  // camelCase twin and refuses a body carrying both variants of one column; the query side has no such
  // normalizer — `buildListQuery` looks a filter key up under the DECLARED name only.
  const split =
    project !== undefined && Object.keys(project).length > 0
      ? {
          description:
            'This route declares a response projection: response fields carry the projected wire ' +
            'names (casing/rename/fields applied server-side), while path and query parameters — ' +
            'equality/set/comparison filters, order — and the create/update body keys keep the ' +
            'declared column names. Query parameters take the declared snake_case name only; a ' +
            'create/update body key may use either casing — the declared snake_case name or its ' +
            'camelCase twin (sending both for one column is refused as ambiguous). The projection ' +
            'is read-side only.',
        }
      : {};
  switch (op) {
    case 'list':
      return {
        ...base,
        ...split,
        summary: `List '${store.name}' rows (tenant-scoped).`,
        // The declared filters + order/after/limit query surface (plus any path params from base).
        parameters: [...(base.parameters ?? []), ...listQueryParameters(store)],
        responses: {
          '200': {
            description: `An array of '${store.name}' rows (bounded; X-Result-Truncated on a full page).`,
            headers: {
              'X-Next-Cursor': {
                description:
                  'Opaque keyset cursor bound to the LAST row of the page — present on every ' +
                  'non-empty keyset-ordered page (an empty page carries none, and a ranked __search ' +
                  'page is relevance-ordered and carries none). Pass it back as ?after= to fetch the ' +
                  'rows beyond it — including rows that arrive later.',
                schema: { type: 'string' },
              },
              'X-Result-Truncated': {
                description:
                  "Present as 'true' when the page hit the row cap and more rows may exist (page with ?after=).",
                schema: { type: 'string' },
              },
            },
            content: { 'application/json': { schema: { type: 'array', items: row } } },
          },
        },
      };
    case 'get':
      return {
        ...base,
        ...split,
        summary: `Get one '${store.name}' row by id.`,
        responses: {
          '200': rowResponse,
          '404': { description: 'Not found (or not in this tenant).' },
        },
      };
    case 'create':
      return {
        ...base,
        ...split,
        summary: `Create a '${store.name}' row.`,
        // The optional Idempotency-Key request header: a repeat CREATE with the same key returns
        // the ORIGINAL row (200 + Idempotency-Replay) instead of creating a duplicate.
        parameters: [
          ...(base.parameters ?? []),
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: false,
            description:
              'Optional idempotency key. A repeat CREATE with the same key returns the ORIGINAL row ' +
              '(200, Idempotency-Replay: true) regardless of body — no duplicate is created.',
            schema: { type: 'string' },
          },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: toJsonSchema(createBodySchema(store)) } },
        },
        responses: {
          '201': rowResponse,
          // Idempotent replay: a repeated Idempotency-Key returns the prior row (no duplicate created).
          '200': {
            description: `Idempotent replay — the original '${store.name}' row for a repeated Idempotency-Key (no duplicate created).`,
            headers: {
              'Idempotency-Replay': {
                description:
                  "Present as 'true' when this response is an idempotent replay of a prior create.",
                schema: { type: 'string' },
              },
            },
            content: { 'application/json': { schema: row } },
          },
        },
      };
    case 'update':
      return {
        ...base,
        ...split,
        summary: `Update a '${store.name}' row by id (partial).`,
        requestBody: {
          required: true,
          content: { 'application/json': { schema: toJsonSchema(updateBodySchema(store)) } },
        },
        responses: {
          '200': rowResponse,
          '404': { description: 'Not found (or not in this tenant).' },
        },
      };
    case 'delete':
      return {
        ...base,
        summary: `Delete a '${store.name}' row by id.`,
        responses: { '204': { description: 'Deleted.' }, '404': { description: 'Not found.' } },
      };
  }
}

/**
 * Build the OpenAPI 3.1 document for a validated spec's declared `api[]`. Product-agnostic + pure: a
 * product-EMPTY spec (`api: []`) yields a document with an EMPTY `paths` object. The path keys are the
 * declared OpenAPI-style paths VERBATIM (`/meetings/{id}` — already OpenAPI `{param}` form), so a path
 * with multiple methods (e.g. GET + POST + PATCH + DELETE on the same path) merges into one path item.
 */
export function buildDeclaredRoutesOpenApi(spec: RaySpec): OpenApiDocument {
  const storeByName = new Map(spec.stores.map((s) => [s.name, s]));
  // Prototype-free accumulators: the keys are author-derived (the declared path + method), so building
  // them on a null prototype makes an `__proto__`/`constructor` path key a plain own-property, never a
  // prototype mutation. Behaviour is otherwise identical (own enumerable keys serialize the same).
  const paths: Record<string, OpenApiPathItem> = Object.create(null);
  for (const route of spec.api) {
    const op = operationForRoute(route, storeByName);
    if (!op) continue; // skip an unresolvable route rather than emit a broken entry
    let item = paths[route.path];
    if (!item) {
      item = Object.create(null) as OpenApiPathItem;
      paths[route.path] = item;
    }
    item[route.method.toLowerCase()] = op;
  }
  return {
    openapi: '3.1.0',
    info: {
      title: spec.metadata.name,
      version: spec.version,
      // The posture notice is UNCONDITIONAL — it was the branch with NO declared description that
      // emitted no `description` key at all, so the document carrying the least context was also
      // the one carrying no warning. The declared text, when there is one, comes first and survives
      // whole. Still product-agnostic: the notice is a fixed platform string, derived from no
      // product name, store or column, so the emission stays a pure function of the spec.
      description: spec.metadata.description
        ? `${spec.metadata.description}\n\n${OPENAPI_POSTURE_NOTICE}`
        : OPENAPI_POSTURE_NOTICE,
    },
    paths,
  };
}
