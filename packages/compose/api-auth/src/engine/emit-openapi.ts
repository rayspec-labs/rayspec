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

import type { ApiRouteSpec, ColumnType, RaySpec, StoreOp, StoreSpec } from '@rayspec/spec';
import { z } from 'zod';
import { StartRunRequest } from '../routes/runs.js';
import { INJECTED_COLUMN_TS_NAMES } from './injected-columns-view.js';
import { createBodySchema, updateBodySchema } from './store-validation.js';

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
  operationId: string;
  parameters?: OpenApiParameter[];
  requestBody?: {
    required: boolean;
    content: { 'application/json': { schema: Record<string, unknown> } };
  };
  responses: Record<string, OpenApiResponse>;
}

interface OpenApiParameter {
  name: string;
  in: 'path';
  required: true;
  schema: { type: 'string' };
}

interface OpenApiResponse {
  description: string;
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
    case 'boolean':
      return { type: 'boolean' };
    case 'jsonb':
      return {}; // free-form JSON value
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
};

/**
 * Build the RESPONSE (row) JSON-Schema for a store: the injected server-controlled columns (snake_case
 * wire names, exactly what `serializeRow` exposes) + the declared business columns (author snake_case
 * names, nullable where declared). This mirrors `serializeRow` so the documented response shape is the
 * real wire shape, not a guess.
 */
function storeRowSchema(store: StoreSpec): Record<string, unknown> {
  const properties: Record<string, Record<string, unknown>> = {};
  // Injected columns first (the same set serializeRow re-keys to snake_case).
  for (const snake of Object.keys(INJECTED_COLUMN_TS_NAMES)) {
    properties[snake] = INJECTED_RESPONSE_PROPS[snake] ?? {};
  }
  // Declared business columns under their author snake_case names. A nullable column uses the 3.1
  // `[type, 'null']` union (consistent with the injected columns above) — NOT the removed `nullable`
  // keyword.
  for (const col of store.columns) {
    const base = responseSchemaForColumnType(col.type);
    properties[col.name] = col.nullable ? nullable3_1(base) : base;
  }
  // The row carries EXACTLY the injected + declared columns (the closed, server-serialized wire shape),
  // so the response schema is strict — no silent extra props (matching the strict create/update bodies).
  return { type: 'object', properties, additionalProperties: false };
}

/** Path params parsed from a declared OpenAPI-style path (`/meetings/{id}/x` → `['id']`). */
function pathParamNames(path: string): string[] {
  const out: string[] = [];
  const re = /\{([^}/]+)\}/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard global-regex exec loop.
  while ((m = re.exec(path)) !== null) {
    const name = m[1];
    if (name) out.push(name);
  }
  return out;
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
  const slug = path
    // `{name}` → `_by_name_` (the leading/trailing `_` keep it a distinct token after collapse), so a
    // brace segment is structurally distinguishable from a literal segment of the same characters.
    .replace(/\{([^}/]+)\}/g, '_by_$1_')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
  return `${method.toLowerCase()}_${slug || 'root'}`;
}

/** A generic opaque-object schema for `{handler}`/`{stream}` routes (body is arbitrary product logic). */
const OPAQUE_OBJECT: Record<string, unknown> = { type: 'object', additionalProperties: true };

/** Build the operation for ONE declared route. Returns undefined for a kind we cannot resolve. */
function operationForRoute(
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
    return storeOperation(store, action.op, base);
  }

  if (action.kind === 'agent') {
    return {
      ...base,
      summary: `Run the '${action.agent}' agent.`,
      requestBody: {
        required: true,
        content: { 'application/json': { schema: toJsonSchema(StartRunRequest) } },
      },
      responses: {
        '200': {
          description:
            'The neutral RunResult (sync) — Accept: text/event-stream streams it as SSE.',
          content: { 'application/json': { schema: OPAQUE_OBJECT } },
        },
        '202': {
          description: 'Accepted — an async run was enqueued (async:true on a durable worker).',
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

/** Build the operation for a `{store}` route from its op + the StoreSpec-derived schemas. */
function storeOperation(
  store: StoreSpec,
  op: StoreOp,
  base: { operationId: string; parameters?: OpenApiParameter[] },
): OpenApiOperation {
  const row = storeRowSchema(store);
  const rowResponse: OpenApiResponse = {
    description: `A '${store.name}' row.`,
    content: { 'application/json': { schema: row } },
  };
  switch (op) {
    case 'list':
      return {
        ...base,
        summary: `List '${store.name}' rows (tenant-scoped).`,
        responses: {
          '200': {
            description: `An array of '${store.name}' rows (bounded; X-Result-Truncated on a full page).`,
            content: { 'application/json': { schema: { type: 'array', items: row } } },
          },
        },
      };
    case 'get':
      return {
        ...base,
        summary: `Get one '${store.name}' row by id.`,
        responses: {
          '200': rowResponse,
          '404': { description: 'Not found (or not in this tenant).' },
        },
      };
    case 'create':
      return {
        ...base,
        summary: `Create a '${store.name}' row.`,
        requestBody: {
          required: true,
          content: { 'application/json': { schema: toJsonSchema(createBodySchema(store)) } },
        },
        responses: { '201': rowResponse },
      };
    case 'update':
      return {
        ...base,
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
  const paths: Record<string, OpenApiPathItem> = {};
  for (const route of spec.api) {
    const op = operationForRoute(route, storeByName);
    if (!op) continue; // skip an unresolvable route rather than emit a broken entry
    let item = paths[route.path];
    if (!item) {
      item = {};
      paths[route.path] = item;
    }
    item[route.method.toLowerCase()] = op;
  }
  return {
    openapi: '3.1.0',
    info: {
      title: spec.metadata.name,
      version: spec.version,
      ...(spec.metadata.description ? { description: spec.metadata.description } : {}),
    },
    paths,
  };
}
