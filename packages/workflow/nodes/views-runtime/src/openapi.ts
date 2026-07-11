/**
 * @rayspec/views-runtime — OpenAPI 3.1 emission for declared views.
 *
 * `emitProductViewsOpenApi` derives an inspectable API-contract document from the view declarations
 * + the product contracts — the "Product YAML produces inspectable API contracts" gate. Every path,
 * parameter, and schema is DERIVED from the declarations (no product concept lives here):
 *
 *   - path/query params document their CLOSED preset shapes (safe_id pattern, integer bounds, enums);
 *   - pagination params document the frozen clamp law (default/max);
 *   - the 200 schema is the view's RESPONSE CONTRACT translated from the closed contract
 *     vocabulary to JSON Schema 2020-12 (`ref` → `$ref` into `components.schemas`, `nullable` →
 *     a `[type, 'null']` union — the 3.1 representation, mirroring emit-openapi.ts);
 *   - responses are the PRODUCIBLE set (RC-1, `producibleViewResponseStatuses`): a 400 ONLY when the
 *     view DECLARES params (pagination params clamp — they can never 400); a 409
 *     `{error:'not_ready'}` for `absent_state: not_ready_409`; a 304 (+ the ETag header on the 200)
 *     for `conditional_read: etag`.
 *
 * The translation is FAITHFUL to the closed vocabulary only — the contract lint already rejected
 * anything outside it, so an unknown key here is a bug, not an input.
 */
import type { ContractsSpec, ProductViewSpec, ViewParamSpec } from '@rayspec/spec';
import { viewPathParams } from '@rayspec/spec';

export interface ViewsOpenApiDocument {
  openapi: '3.1.0';
  info: { title: string; version: string; description?: string };
  paths: Record<string, Record<string, ViewsOpenApiOperation>>;
  components: { schemas: Record<string, Record<string, unknown>> };
}

interface ViewsOpenApiParameter {
  name: string;
  in: 'path' | 'query';
  required: boolean;
  description?: string;
  schema: Record<string, unknown>;
}

interface ViewsOpenApiOperation {
  summary: string;
  operationId: string;
  parameters?: ViewsOpenApiParameter[];
  responses: Record<string, Record<string, unknown>>;
}

/** A stable operationId from the view id (view ids are unique — lint-enforced). */
function operationId(view: ProductViewSpec): string {
  return `view_${view.id}`;
}

/**
 * RC-1: the response statuses the view RUNTIME can actually produce for this declaration — the
 * SINGLE source the emitter documents from, so documented responses ⊆ producible responses holds by
 * construction:
 *  - `200` always (the DTO / the declared absent shape);
 *  - `400` ONLY when the view DECLARES params (`view.params`) — the interpreter 400s exclusively on
 *    declared-param validation. Pagination params CLAMP (never 400), so a list view without declared
 *    params documents NO 400 (the prior any-params rule documented a 400 the runtime could never emit);
 *  - `409` for `absent_state: not_ready_409`;
 *  - `304` for `conditional_read: etag`.
 * For a DELEGATED capability view this is the declaration-derived knowledge (its real behavior is
 * capability code; the declaration is all an emitted contract can honestly claim).
 */
export function producibleViewResponseStatuses(view: ProductViewSpec): ReadonlySet<string> {
  const out = new Set<string>(['200']);
  if (Object.keys(view.params ?? {}).length > 0) out.add('400');
  if (view.absent_state === 'not_ready_409') out.add('409');
  if (view.conditional_read === 'etag') out.add('304');
  return out;
}

/** The JSON-Schema for a param's CLOSED preset (+ optional enum narrowing). */
function paramSchema(spec: ViewParamSpec): Record<string, unknown> {
  const base: Record<string, unknown> = (() => {
    switch (spec.shape) {
      case 'safe_id':
        return { type: 'string', pattern: '^[A-Za-z0-9_.-]{1,128}$' };
      case 'positive_int':
        return { type: 'integer', minimum: 1 };
      case 'nonnegative_int':
        return { type: 'integer', minimum: 0 };
      case 'string':
        return { type: 'string', minLength: 1, maxLength: 1024 };
    }
  })();
  if (spec.enum) base.enum = [...spec.enum];
  return base;
}

/** Translate ONE closed-vocabulary contract node to JSON Schema, collecting `ref` targets. */
function contractNodeToSchema(
  node: Record<string, unknown>,
  contracts: ContractsSpec,
  wanted: Set<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // `ref` → a $ref into components.schemas (the referenced contract is emitted there). A node that
  // ALSO carries local keys (e.g. a nullable union + ref) wraps the $ref in an allOf-like union —
  // we keep it simple + faithful: local `type` (with nullable) is emitted alongside via anyOf.
  const ref = typeof node.ref === 'string' ? node.ref : undefined;
  if (ref && contracts[ref]) wanted.add(ref);

  const types: string[] = [];
  if (typeof node.type === 'string') types.push(node.type);
  else if (Array.isArray(node.type))
    for (const t of node.type) if (typeof t === 'string') types.push(t);
  if (node.nullable === true && !types.includes('null')) types.push('null');

  if (ref && contracts[ref]) {
    const refSchema = { $ref: `#/components/schemas/${encodeRef(ref)}` };
    if (types.includes('null')) {
      return { anyOf: [refSchema, { type: 'null' }] };
    }
    return refSchema;
  }

  if (types.length === 1) out.type = types[0];
  else if (types.length > 1) out.type = types;

  if (typeof node.description === 'string') out.description = node.description;
  if (Array.isArray(node.enum)) out.enum = [...node.enum];
  if (node.additional_properties === false) out.additionalProperties = false;
  if (node.additional_properties === true) out.additionalProperties = true;

  const props = node.properties;
  if (props !== null && typeof props === 'object' && !Array.isArray(props)) {
    const outProps: Record<string, unknown> = {};
    for (const [name, sub] of Object.entries(props as Record<string, unknown>)) {
      if (sub !== null && typeof sub === 'object' && !Array.isArray(sub)) {
        outProps[name] = contractNodeToSchema(sub as Record<string, unknown>, contracts, wanted);
      }
    }
    out.properties = outProps;
  }
  const items = node.items;
  if (items !== null && typeof items === 'object' && !Array.isArray(items)) {
    out.items = contractNodeToSchema(items as Record<string, unknown>, contracts, wanted);
  }
  if (Array.isArray(node.required)) {
    out.required = node.required.filter((r) => typeof r === 'string');
  }
  return out;
}

/** Contract ids may carry dots (`orders.list_response`) — safe as a schema key verbatim. */
function encodeRef(id: string): string {
  return id;
}

/** Build the parameters array: declared params (path first) + the pagination params. */
function parametersFor(view: ProductViewSpec): ViewsOpenApiParameter[] | undefined {
  const out: ViewsOpenApiParameter[] = [];
  const pathParams = viewPathParams(view.route.path);
  const declared = Object.entries(view.params ?? {});
  // Path params in path order (fall back to a plain string schema if undeclared — declaration-only views).
  for (const name of pathParams) {
    const spec = view.params?.[name];
    out.push({
      name,
      in: 'path',
      required: true,
      schema: spec ? paramSchema(spec) : { type: 'string' },
    });
  }
  for (const [name, spec] of declared) {
    if (spec.in === 'query') {
      out.push({ name, in: 'query', required: spec.required ?? false, schema: paramSchema(spec) });
    }
  }
  if (view.pagination?.limit_param) {
    out.push({
      name: view.pagination.limit_param,
      in: 'query',
      required: false,
      description:
        `Page size. Missing/non-integer/< 1 clamps to the default` +
        `${view.pagination.default_limit !== undefined ? ` (${view.pagination.default_limit})` : ''}; ` +
        `values above the max clamp to ${view.pagination.max_limit ?? 'the max'}.`,
      schema: {
        type: 'integer',
        minimum: 1,
        ...(view.pagination.max_limit !== undefined ? { maximum: view.pagination.max_limit } : {}),
      },
    });
  }
  if (view.pagination?.offset_param) {
    out.push({
      name: view.pagination.offset_param,
      in: 'query',
      required: false,
      description: 'Page offset. Missing/non-integer/negative clamps to 0.',
      schema: { type: 'integer', minimum: 0 },
    });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Emit the OpenAPI 3.1 document for the declared views. Pure + product-agnostic: everything is
 * derived from the declarations; an empty view list yields an empty `paths`.
 */
export function emitProductViewsOpenApi(config: {
  views: readonly ProductViewSpec[];
  contracts: ContractsSpec;
  info: { title: string; version: string; description?: string };
}): ViewsOpenApiDocument {
  const wanted = new Set<string>();
  const paths: Record<string, Record<string, ViewsOpenApiOperation>> = {};

  for (const view of config.views) {
    const params = parametersFor(view);
    const contract = config.contracts[view.response_contract];
    const bodySchema = contract
      ? contractNodeToSchema(contract as Record<string, unknown>, config.contracts, wanted)
      : // a capability-contract response has no in-document body — documented as an opaque object.
        { type: 'object', additionalProperties: true };

    const okResponse: Record<string, unknown> = {
      description: `The '${view.response_contract}' response contract.`,
      content: { 'application/json': { schema: bodySchema } },
      ...(view.conditional_read === 'etag'
        ? {
            headers: {
              ETag: {
                description:
                  'Strong validator over the response DTO (sha-256 of the canonical JSON).',
                schema: { type: 'string' },
              },
            },
          }
        : {}),
    };

    // RC-1: every documented status comes from the producible set (documented ⊆ producible by
    // construction — the openapi suite asserts equality per view).
    const producible = producibleViewResponseStatuses(view);
    const responses: Record<string, Record<string, unknown>> = { '200': okResponse };
    if (producible.has('400')) {
      responses['400'] = {
        description:
          "A declared param is missing or malformed — `{ error: 'bad_request', detail }`.",
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: { error: { type: 'string' }, detail: { type: 'string' } },
              required: ['error', 'detail'],
              additionalProperties: false,
            },
          },
        },
      };
    }
    if (producible.has('409')) {
      responses['409'] = {
        description: "The resource is not ready yet — `{ error: 'not_ready', detail }`.",
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: { error: { type: 'string' }, detail: { type: 'string' } },
              required: ['error', 'detail'],
              additionalProperties: false,
            },
          },
        },
      };
    }
    if (producible.has('304')) {
      responses['304'] = {
        description:
          'Not modified — the If-None-Match validator matched the current ETag (no body).',
      };
    }

    const op: ViewsOpenApiOperation = {
      summary: `Declared view '${view.id}' (auth: ${view.auth ?? 'none'}).`,
      operationId: operationId(view),
      ...(params ? { parameters: params } : {}),
      responses,
    };

    let item = paths[view.route.path];
    if (!item) {
      item = {};
      paths[view.route.path] = item;
    }
    item[view.route.method.toLowerCase()] = op;
  }

  // Emit every $ref'd contract into components.schemas (transitively — refs may ref further).
  const schemas: Record<string, Record<string, unknown>> = {};
  const emitted = new Set<string>();
  while (wanted.size > emitted.size) {
    for (const id of [...wanted]) {
      if (emitted.has(id)) continue;
      emitted.add(id);
      const node = config.contracts[id];
      if (node) {
        schemas[encodeRef(id)] = contractNodeToSchema(
          node as Record<string, unknown>,
          config.contracts,
          wanted,
        );
      }
    }
  }

  return {
    openapi: '3.1.0',
    info: {
      title: config.info.title,
      version: config.info.version,
      ...(config.info.description ? { description: config.info.description } : {}),
    },
    paths,
    components: { schemas },
  };
}
