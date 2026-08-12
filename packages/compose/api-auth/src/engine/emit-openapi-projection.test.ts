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
 *    overrides it wholesale (back to the raw snake shape);
 *  - a route WITHOUT `project` emits a byte-identical document (accept-control).
 */
import { lintSpec, RaySpec } from '@rayspec/spec';
import { describe, expect, it } from 'vitest';
import { buildDeclaredRoutesOpenApi } from './emit-openapi.js';

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
    expect(props.numCol).toEqual({ type: 'string', pattern: '^-?\\d+(\\.\\d+)?$' });
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
