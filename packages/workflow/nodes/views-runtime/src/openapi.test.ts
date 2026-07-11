/**
 * The views produce an INSPECTABLE API-contract document. Asserts: paths/methods/params
 * derive from the declarations (preset schemas, enums, the pagination clamp docs), the 200 schema is
 * the translated response contract (`ref` → resolvable `$ref`s into components.schemas, `nullable` →
 * a 3.1 type union), the conditional/absent behaviors document their 304/409, and EVERY emitted
 * `$ref` resolves inside the document (no dangling contract pointers).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseProductSpec } from '@rayspec/spec';
import { describe, expect, it } from 'vitest';
import { emitProductViewsOpenApi, producibleViewResponseStatuses } from './openapi.js';

function loadAcmeNotesFixture() {
  const yaml = readFileSync(
    fileURLToPath(new URL('./__fixtures__/acme-notes-views.product.yaml', import.meta.url)),
    'utf8',
  );
  const res = parseProductSpec(yaml);
  if (!res.ok) throw new Error(`fixture must parse:\n${JSON.stringify(res.errors, null, 2)}`);
  return res.value;
}

/** Collect every `$ref` string in a JSON tree. */
function collectRefs(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const v of value) collectRefs(v, out);
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === '$ref' && typeof v === 'string') out.push(v);
      else collectRefs(v, out);
    }
  }
  return out;
}

describe('emitProductViewsOpenApi', () => {
  const spec = loadAcmeNotesFixture();
  const doc = emitProductViewsOpenApi({
    views: spec.views,
    contracts: spec.contracts,
    info: { title: 'fixture views', version: '0.0.0' },
  });

  it('emits one operation per declared view route', () => {
    expect(Object.keys(doc.paths).sort()).toEqual([
      '/sessions',
      '/sessions/{session_id}/notes',
      '/sessions/{session_id}/{track}/transcript',
    ]);
    expect(doc.paths['/sessions']?.get?.operationId).toBe('view_session_list');
  });

  it('derives params from the declarations (presets + enums + pagination clamp docs)', () => {
    const transcript = doc.paths['/sessions/{session_id}/{track}/transcript']?.get;
    const params = transcript?.parameters ?? [];
    const sessionId = params.find((p) => p.name === 'session_id');
    expect(sessionId).toMatchObject({
      in: 'path',
      required: true,
      schema: { type: 'string', pattern: '^[A-Za-z0-9_.-]{1,128}$' },
    });
    const track = params.find((p) => p.name === 'track');
    expect(track?.schema).toMatchObject({ enum: ['mic', 'system'] });

    const list = doc.paths['/sessions']?.get;
    const limit = (list?.parameters ?? []).find((p) => p.name === 'limit');
    expect(limit).toMatchObject({
      in: 'query',
      required: false,
      schema: { type: 'integer', minimum: 1, maximum: 200 },
    });
    expect(limit?.description).toContain('clamps');
    const offset = (list?.parameters ?? []).find((p) => p.name === 'offset');
    expect(offset?.schema).toMatchObject({ type: 'integer', minimum: 0 });
  });

  it('translates the response contract (nullable unions; closed vocabulary → JSON Schema)', () => {
    const transcript = doc.paths['/sessions/{session_id}/{track}/transcript']?.get;
    const schema = (
      (
        transcript?.responses['200'] as {
          content: Record<string, { schema: Record<string, unknown> }>;
        }
      ).content['application/json'] as { schema: Record<string, unknown> }
    ).schema;
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.model?.type).toEqual(['string', 'null']);
    expect(props.word_count?.type).toBe('integer');
    const words = props.words as { type: string; items: Record<string, unknown> };
    expect(words.type).toBe('array');
    expect(words.items.properties as Record<string, unknown>).toHaveProperty('punctuated_word');
    expect(schema.required).toContain('billed_duration_seconds');
  });

  it('documents 400 (DECLARED params only), 304 + the ETag header (etag), and nothing spurious', () => {
    const transcript = doc.paths['/sessions/{session_id}/{track}/transcript']?.get;
    expect(Object.keys(transcript?.responses ?? {}).sort()).toEqual(['200', '304', '400']);
    const ok = transcript?.responses['200'] as Record<string, unknown>;
    expect((ok.headers as Record<string, unknown>)?.ETag).toBeDefined();
    // RC-1 (red-first): session_list declares NO params — its only request inputs are the
    // pagination params, which CLAMP (never 400). A documented 400 the runtime can never produce is
    // a false contract; the list view documents exactly ['200'].
    const list = doc.paths['/sessions']?.get;
    expect(Object.keys(list?.responses ?? {}).sort()).toEqual(['200']);
  });

  it('RC-1: documented responses EQUAL the producible responses for every fixture view (runtime consistency)', () => {
    for (const view of spec.views) {
      const op = doc.paths[view.route.path]?.[view.route.method.toLowerCase()];
      const documented = Object.keys(op?.responses ?? {}).sort();
      const producible = [...producibleViewResponseStatuses(view)].sort();
      expect(documented, `view '${view.id}'`).toEqual(producible);
    }
  });

  it('RC-1: producibleViewResponseStatuses derives exactly {200} ∪ 400(declared params) ∪ 409 ∪ 304', () => {
    const base = {
      id: 'v',
      route: { method: 'GET' as const, path: '/x' },
      auth: 'bearer_tenant',
      response_contract: 'c',
    };
    expect([...producibleViewResponseStatuses(base as never)].sort()).toEqual(['200']);
    expect(
      [
        ...producibleViewResponseStatuses({
          ...base,
          params: { q: { in: 'query', shape: 'string' } },
        } as never),
      ].sort(),
    ).toEqual(['200', '400']);
    expect(
      [
        ...producibleViewResponseStatuses({
          ...base,
          absent_state: 'not_ready_409',
          conditional_read: 'etag',
        } as never),
      ].sort(),
    ).toEqual(['200', '304', '409']);
  });

  it('documents the 409 readiness gate for not_ready_409 views', () => {
    const res = parseProductSpec(`
version: "1.0"
product: { id: p, name: P }
contracts:
  p.r:
    type: object
    properties:
      state: { type: string }
    required: [state]
views:
  - id: gate
    route: { method: GET, path: "/things/{id}/gate" }
    auth: bearer_tenant
    params:
      id: { in: path, shape: safe_id }
    source: { kind: store, ref: things }
    absent_state: not_ready_409
    read:
      mode: single
      filter: { thing_id: { param: id } }
      shape:
        fields:
          state: { kind: column, column: state, type: string, default: "" }
    response_contract: p.r
`);
    if (!res.ok) throw new Error(JSON.stringify(res.errors, null, 2));
    const gated = emitProductViewsOpenApi({
      views: res.value.views,
      contracts: res.value.contracts,
      info: { title: 't', version: '0' },
    });
    const op = gated.paths['/things/{id}/gate']?.get;
    expect(Object.keys(op?.responses ?? {}).sort()).toEqual(['200', '400', '409']);
  });

  it('SEP-1: the session-list items emit REAL nested types (closed nodes), not bare object[]', () => {
    const list = doc.paths['/sessions']?.get;
    const schema = (
      (list?.responses['200'] as { content: Record<string, { schema: Record<string, unknown> }> })
        .content['application/json'] as { schema: Record<string, unknown> }
    ).schema;
    const sessions = (schema.properties as Record<string, Record<string, unknown>>).sessions as {
      items: Record<string, unknown>;
    };
    expect(sessions.items.additionalProperties).toBe(false);
    const sessionProps = sessions.items.properties as Record<string, Record<string, unknown>>;
    expect(sessionProps.protocol_version?.type).toBe('integer');
    const trackItems = (sessionProps.tracks as { items: Record<string, unknown> }).items;
    expect(trackItems.additionalProperties).toBe(false);
    const trackProps = trackItems.properties as Record<string, Record<string, unknown>>;
    expect(trackProps.transcript_word_count?.type).toEqual(['integer', 'null']);
    expect(sessions.items.required).toContain('note_counts');
  });

  it('EVERY emitted $ref resolves inside the document (no dangling contract pointers)', () => {
    const refs = collectRefs(doc);
    for (const ref of refs) {
      expect(ref.startsWith('#/components/schemas/')).toBe(true);
      const id = ref.slice('#/components/schemas/'.length);
      expect(doc.components.schemas[id], `dangling $ref ${ref}`).toBeDefined();
    }
  });
});
