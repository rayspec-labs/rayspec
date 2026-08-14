/**
 * OpenAPI emission for PROJECTED store routes — the generated document must describe the ACTUAL
 * wire shape a `project`ed route serves, not the un-projected default.
 *
 * Pure + network-free (no DB). Pins, fail-the-fix:
 *  - a `casing: camel` projection re-keys the response row schema — ALL 8 injected props and all
 *    9 column-type fragments ride under their wire names with their type fragments intact
 *    (bigint keeps its bounds, numeric stays a pattern'd string, nullability unions survive);
 *  - `omitInjected`/`rename`/`fields` shape the documented row exactly like the serializer
 *    (one shared projection resolution — the doc cannot drift from the wire);
 *  - the REQUEST surface stays author-named: query params (filters/order/operators) and the
 *    create/update body schemas are byte-identical to the un-projected emission, and the operation
 *    description states the naming split explicitly;
 *  - a store-level projection applies to the store's routes, and a route-level `project: {}`
 *    overrides it wholesale (back to the raw snake shape) AND states no split, because there is none;
 *  - the split sentence names the request-side casing rule the server actually applies (bodies take
 *    either casing, query parameters take the declared name only) — both halves measured here;
 *  - a route WITHOUT `project` emits a byte-identical document (accept-control).
 */
import { ApiError } from '@rayspec/auth-core';
import { buildProductTables } from '@rayspec/db/testing';
import { lintSpec, RaySpec } from '@rayspec/spec';
import { describe, expect, it } from 'vitest';
import { buildDeclaredRoutesOpenApi } from './emit-openapi.js';
import { buildListQuery } from './store-query.js';
import { NUMERIC_WIRE_RE, normalizeBodyCasing } from './store-validation.js';

/** Validate a plain object through the REAL grammar + linter (mirrors emit-openapi.test.ts). */
function specFromObject(obj: Record<string, unknown>): RaySpec {
  const spec = RaySpec.parse(obj);
  const lintErrors = lintSpec(spec);
  if (lintErrors.length > 0) throw new Error(`spec lint failed: ${JSON.stringify(lintErrors)}`);
  return spec;
}

/** A store exercising ALL NINE column types, with multiword snake names so casing is observable. */
const NINE_TYPE_COLUMNS = [
  { name: 'text_col', type: 'text' },
  { name: 'uuid_col', type: 'uuid' },
  { name: 'ts_col', type: 'timestamp' },
  { name: 'int_col', type: 'integer' },
  { name: 'big_col', type: 'bigint' },
  { name: 'bool_col', type: 'boolean' },
  { name: 'json_col', type: 'jsonb' },
  { name: 'dbl_col', type: 'double' },
  { name: 'num_col', type: 'numeric', precision: 8, scale: 2 },
];

function specWith(project: Record<string, unknown> | undefined): RaySpec {
  return specFromObject({
    version: '1.0',
    metadata: { name: 'projection-doc-backend' },
    stores: [{ name: 'things', columns: NINE_TYPE_COLUMNS }],
    api: [
      {
        method: 'GET',
        path: '/things',
        action: { kind: 'store', store: 'things', op: 'list' },
        ...(project ? { project } : {}),
      },
      {
        method: 'POST',
        path: '/things',
        action: { kind: 'store', store: 'things', op: 'create' },
        ...(project ? { project } : {}),
      },
    ],
  });
}

/** The response row schema of the list op (the array item schema). */
function listRowSchema(spec: RaySpec): Record<string, Record<string, unknown>> {
  const doc = buildDeclaredRoutesOpenApi(spec);
  const res = doc.paths['/things']?.get?.responses['200'];
  const schema = res?.content?.['application/json']?.schema as
    | { items?: { properties?: Record<string, Record<string, unknown>> } }
    | undefined;
  const props = schema?.items?.properties;
  if (!props) throw new Error('list 200 row schema missing');
  return props;
}

describe('OpenAPI — projected store routes describe the actual wire shape', () => {
  it('casing: camel re-keys ALL 8 injected props and all 9 type fragments, fragments intact', () => {
    const props = listRowSchema(specWith({ casing: 'camel' }));
    expect(Object.keys(props).sort()).toEqual(
      [
        // The 8 injected columns, camel wire names.
        'id',
        'tenantId',
        'createdAt',
        'deletedAt',
        'retentionDays',
        'region',
        'createdBy',
        'idempotencyKey',
        // The 9 declared columns, camel wire names.
        'textCol',
        'uuidCol',
        'tsCol',
        'intCol',
        'bigCol',
        'boolCol',
        'jsonCol',
        'dblCol',
        'numCol',
      ].sort(),
    );
    // Type fragments ride along unchanged (the projection renames keys, never reshapes values).
    expect(props.bigCol).toEqual({
      type: 'integer',
      minimum: Number.MIN_SAFE_INTEGER,
      maximum: Number.MAX_SAFE_INTEGER,
    });
    expect(props.numCol).toEqual({ type: 'string', pattern: NUMERIC_WIRE_RE.source });
    expect(props.dblCol).toEqual({ type: 'number' });
    expect(props.tsCol).toEqual({ type: 'string', format: 'date-time' });
    expect(props.jsonCol).toEqual({});
    expect(props.deletedAt).toEqual({ type: ['string', 'null'], format: 'date-time' });
    expect(props.retentionDays).toEqual({ type: ['integer', 'null'] });
    expect(props.createdBy).toEqual({ type: ['string', 'null'] });
    expect(props.idempotencyKey).toEqual({ type: ['string', 'null'] });
  });

  it('omitInjected + rename + fields document EXACTLY the projected field set', () => {
    const props = listRowSchema(
      specWith({
        casing: 'camel',
        omitInjected: true,
        rename: { id: 'thingId' },
        fields: ['thingId', 'textCol', 'createdAt'],
      }),
    );
    // fields is the last word on membership: thingId (renamed id), textCol, and createdAt (an
    // injected column the allowlist explicitly re-includes past omitInjected).
    expect(Object.keys(props).sort()).toEqual(['createdAt', 'textCol', 'thingId']);
    expect(props.thingId).toEqual({ type: 'string', format: 'uuid' });
    expect(props.textCol).toEqual({ type: 'string' });
    expect(props.createdAt).toEqual({ type: 'string', format: 'date-time' });
  });

  it('the REQUEST surface stays author-named: query params + body schemas are byte-identical, and the split is stated', () => {
    const plain = buildDeclaredRoutesOpenApi(specWith(undefined));
    const projected = buildDeclaredRoutesOpenApi(specWith({ casing: 'camel' }));

    // The list query parameters (filters, order, operator params) keep the DECLARED column names.
    const plainParams = plain.paths['/things']?.get?.parameters;
    const projectedParams = projected.paths['/things']?.get?.parameters;
    expect(projectedParams).toEqual(plainParams);
    const names = (projectedParams ?? []).map((p) => p.name);
    expect(names).toContain('text_col');
    expect(names).toContain('num_col__gt');
    expect(names).not.toContain('textCol');

    // The create request body is byte-identical (write side needs nothing new).
    expect(projected.paths['/things']?.post?.requestBody).toEqual(
      plain.paths['/things']?.post?.requestBody,
    );

    // The naming split is stated on the projected operations, absent on the plain ones.
    const desc = (projected.paths['/things']?.get as { description?: string }).description ?? '';
    expect(desc).toMatch(/declared column names/i);
    expect(Object.hasOwn(plain.paths['/things']?.get as object, 'description')).toBe(false);
  });

  it("a store-level projection applies to the store's routes; a route-level project: {} overrides it wholesale", () => {
    const spec = specFromObject({
      version: '1.0',
      metadata: { name: 'store-level-projection' },
      stores: [
        {
          name: 'things',
          columns: [{ name: 'text_col', type: 'text' }],
          project: { casing: 'camel' },
        },
      ],
      api: [
        { method: 'GET', path: '/things', action: { kind: 'store', store: 'things', op: 'list' } },
        {
          method: 'GET',
          path: '/things-plain',
          action: { kind: 'store', store: 'things', op: 'list' },
          project: {},
        },
      ],
    });
    const doc = buildDeclaredRoutesOpenApi(spec);
    const inherited = (
      doc.paths['/things']?.get?.responses['200']?.content?.['application/json']?.schema as {
        items?: { properties?: Record<string, unknown> };
      }
    ).items?.properties;
    expect(Object.keys(inherited ?? {})).toContain('textCol');
    expect(Object.keys(inherited ?? {})).toContain('tenantId');
    const overridden = (
      doc.paths['/things-plain']?.get?.responses['200']?.content?.['application/json']?.schema as {
        items?: { properties?: Record<string, unknown> };
      }
    ).items?.properties;
    expect(Object.keys(overridden ?? {})).toContain('text_col');
    expect(Object.keys(overridden ?? {})).toContain('tenant_id');
  });

  it('a route-level `project: {}` (the documented opt-out) states NO naming split', () => {
    // `{}` is not nullish, so an opt-out route used to land on the `project !== undefined` arm and
    // carried the split sentence onto a route whose wire shape is the plain declared one. The
    // inherited-projection route on the same store is the accept-control: it DOES state the split.
    const spec = specFromObject({
      version: '1.0',
      metadata: { name: 'opt-out-projection' },
      stores: [
        {
          name: 'things',
          columns: [{ name: 'text_col', type: 'text' }],
          project: { casing: 'camel' },
        },
      ],
      api: [
        { method: 'GET', path: '/things', action: { kind: 'store', store: 'things', op: 'list' } },
        {
          method: 'GET',
          path: '/things-plain',
          action: { kind: 'store', store: 'things', op: 'list' },
          project: {},
        },
        {
          method: 'POST',
          path: '/things-plain',
          action: { kind: 'store', store: 'things', op: 'create' },
          project: {},
        },
      ],
    });
    const doc = buildDeclaredRoutesOpenApi(spec);
    expect((doc.paths['/things']?.get as { description?: string }).description).toMatch(
      /declares a response projection/,
    );
    for (const method of ['get', 'post'] as const) {
      const op = doc.paths['/things-plain']?.[method] as object;
      expect(`${method}: ${JSON.stringify(Object.hasOwn(op, 'description'))}`).toBe(
        `${method}: false`,
      );
    }
  });

  it('the split sentence states the request-side casing rule the server actually applies', () => {
    const spec = specWith({ casing: 'camel' });
    const store = spec.stores[0];
    const desc =
      (buildDeclaredRoutesOpenApi(spec).paths['/things']?.get as { description?: string })
        .description ?? '';
    // A client generator reading only this document must not conclude that snake_case bodies are
    // required: the server normalizes a declared snake key to its camelCase twin before the strict
    // parse, so BOTH casings are accepted on a body — while the query side has no such normalizer.
    expect(desc).toContain('may use either casing');
    expect(desc).toContain('declared snake_case name or its camelCase twin');
    expect(desc).toContain('Query parameters take the declared snake_case name only');

    // Both halves of that sentence, measured against the code that enforces them.
    expect(normalizeBodyCasing(store, { text_col: 'x' })).toEqual({ textCol: 'x' });
    expect(normalizeBodyCasing(store, { textCol: 'x' })).toEqual({ textCol: 'x' });
    expect(() => normalizeBodyCasing(store, { text_col: 'x', textCol: 'y' })).toThrow(ApiError);
    const table = buildProductTables(spec.stores).get('things');
    if (!table) throw new Error("expected a runtime table for store 'things'");
    const filter = (key: string): string => {
      const params = new URLSearchParams();
      params.set(key, 'x');
      try {
        buildListQuery(store, table, params);
        return 'ok';
      } catch (e) {
        return e instanceof ApiError ? `${e.code}: ${e.message}` : String(e);
      }
    };
    expect(filter('text_col')).toBe('ok');
    expect(filter('textCol')).toBe("VALIDATION_ERROR: Unknown query parameter 'textCol'.");
  });

  it("documents columns named after Object.prototype members ('constructor', '__proto__') under their OWN wire names", () => {
    // Both names are SafeIdentifier-legal. The rename lookup is an OWN-property read — a
    // prototype-walking `rename[col]` resolved these columns to inherited Object.prototype
    // members and documented a garbage property key ("function Object() { [native code] }").
    const spec = specFromObject({
      version: '1.0',
      metadata: { name: 'proto-named-doc' },
      stores: [
        {
          name: 'relics',
          columns: [
            { name: 'wire_name', type: 'text' },
            { name: 'constructor', type: 'text' },
            { name: '__proto__', type: 'text' },
          ],
        },
      ],
      api: [
        {
          method: 'GET',
          path: '/things',
          action: { kind: 'store', store: 'relics', op: 'list' },
          project: { rename: { wire_name: 'wireName' } },
        },
      ],
    });
    const props = (
      buildDeclaredRoutesOpenApi(spec).paths['/things']?.get?.responses['200']?.content?.[
        'application/json'
      ]?.schema as { items?: { properties?: Record<string, unknown> } }
    ).items?.properties;
    const keys = Object.keys(props ?? {});
    expect(keys).toContain('wireName');
    expect(keys).toContain('constructor');
    expect(keys).toContain('__proto__');
    expect(keys.some((k) => k.includes('native code') || k === '[object Object]')).toBe(false);
  });

  it('accept-control: a spec WITHOUT project emits the document byte-identically (deep-equal across builds)', () => {
    const a = buildDeclaredRoutesOpenApi(specWith(undefined));
    const props = listRowSchema(specWith(undefined));
    // The un-projected row keeps the snake author/injected names — the pre-projection shape.
    expect(Object.keys(props).sort()).toEqual(
      [
        'id',
        'tenant_id',
        'created_at',
        'deleted_at',
        'retention_days',
        'region',
        'created_by',
        'idempotency_key',
        'text_col',
        'uuid_col',
        'ts_col',
        'int_col',
        'big_col',
        'bool_col',
        'json_col',
        'dbl_col',
        'num_col',
      ].sort(),
    );
    // Determinism (the golden property the byte-identity claim rests on): two builds agree.
    expect(JSON.stringify(a)).toBe(JSON.stringify(buildDeclaredRoutesOpenApi(specWith(undefined))));
  });
});
