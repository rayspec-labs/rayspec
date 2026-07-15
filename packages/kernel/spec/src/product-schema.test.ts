/**
 * Product-YAML JSON-Schema round-trip CONTRACT test (TH-3) — the dual of `export.test.ts` for the
 * `exportProductJsonSchema()` artifact (the source `gate:spec-schema` keeps `product.schema.json` fresh
 * against). It compiles the REAL exported artifact through the SAME Ajv2020 the runtime uses and proves,
 * honestly, the SPLIT between the two enforcement layers:
 *
 *   • SHAPE is enforced by the SCHEMA — unknown keys (additionalProperties:false), wrong version const,
 *     closed enums (tier/method) FAIL the artifact, and the minimal + full positive fixtures PASS it.
 *   • SEMANTICS are enforced by the PARSER ONLY — cross-ref resolution, the closed contract vocabulary,
 *     and declaration-order are NOT expressible in this shape schema, so those docs PASS the schema but
 *     FAIL `parseProductSpec`. Each such case asserts BOTH halves, documenting the boundary rather than
 *     pretending the artifact catches semantics it cannot.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Ajv2020 as Ajv2020Class } from 'ajv/dist/2020.js';
import * as Ajv2020Module from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { exportProductJsonSchema } from './export.js';
import { parseProductSpec } from './product-parse.js';

type AjvInstance = Ajv2020Class;
const Ajv2020Ctor = ((Ajv2020Module as { default?: unknown }).default ?? Ajv2020Module) as new (
  opts?: Record<string, unknown>,
) => AjvInstance;

function read(relFromRepoRoot: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../../${relFromRepoRoot}`, import.meta.url)),
    'utf8',
  );
}
function readObj(relFromRepoRoot: string): unknown {
  return parseYaml(read(relFromRepoRoot));
}

const MINIMAL = { version: '1.0', product: { id: 'p', name: 'P' } };

describe('exportProductJsonSchema — Ajv2020 round-trip contract (TH-3)', () => {
  const artifact = exportProductJsonSchema();
  const ajv = new Ajv2020Ctor({ allErrors: true, strict: false });
  const validate = ajv.compile(artifact);

  it('compiles through a real Ajv2020 instance at draft-2020-12', () => {
    expect(typeof validate).toBe('function');
    expect(artifact.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
  });

  it('declares additionalProperties:false at the top level (fail-closed shape)', () => {
    expect(artifact.additionalProperties).toBe(false);
  });

  it('the committed product.schema.json byte-equals the exporter (the gate-tracked artifact is fresh)', () => {
    const committed = JSON.parse(read('packages/kernel/spec/product.schema.json')) as unknown;
    expect(committed).toEqual(artifact);
  });

  // ---- POSITIVE: the minimal + full fixtures validate against the artifact -----------------------
  it('validates a default-OMITTING minimal doc (version + product only)', () => {
    const ok = validate(MINIMAL);
    if (!ok) throw new Error(`minimal should validate; ${ajv.errorsText(validate.errors)}`);
    expect(ok).toBe(true);
  });

  it('validates the full committed acme-notes fixture', () => {
    const ok = validate(readObj('examples/acme-notes/acme-notes.product.yaml'));
    if (!ok)
      throw new Error(`acme-notes fixture should validate; ${ajv.errorsText(validate.errors)}`);
    expect(ok).toBe(true);
  });

  it('validates the full product-neutral support-triage fixture', () => {
    const ok = validate(
      readObj('packages/kernel/spec/src/__fixtures__/product/support-triage.product.yaml'),
    );
    if (!ok) throw new Error(`support-triage should validate; ${ajv.errorsText(validate.errors)}`);
    expect(ok).toBe(true);
  });

  // ---- SHAPE negatives: the SCHEMA is the enforcing layer -----------------------------------------
  it('REJECTS an unknown top-level key (additionalProperties:false)', () => {
    expect(validate({ ...MINIMAL, bogus: 1 })).toBe(false);
  });

  it('REJECTS a wrong version literal (const 1.0)', () => {
    expect(validate({ ...MINIMAL, version: '9.9' })).toBe(false);
  });

  it('REJECTS a capability tier outside the closed enum', () => {
    const bad = { ...MINIMAL, capabilities: [{ id: 'c', tier: 'A', status: 'reserved' }] };
    expect(validate(bad)).toBe(false);
  });

  it('REJECTS a view method outside GET/POST', () => {
    const bad = {
      ...MINIMAL,
      views: [{ id: 'v', route: { method: 'PUT', path: '/x' }, response_contract: 'c' }],
    };
    expect(validate(bad)).toBe(false);
  });

  it('REJECTS an unknown key nested inside a capability (strict composes through the wrap)', () => {
    const bad = {
      ...MINIMAL,
      capabilities: [{ id: 'c', tier: 'B', status: 'reserved', bogus: true }],
    };
    expect(validate(bad)).toBe(false);
  });

  // ---- SEMANTIC negatives: PARSER-ONLY (schema is shape-valid; parser rejects). Documents the split.
  it('a DANGLING contract ref is shape-valid (schema PASSES) but the parser REJECTS it', () => {
    const yaml = `version: "1.0"
product: { id: p, name: P }
artifacts:
  - kind: k
    contract: nope.nothing
`;
    expect(validate(parseYaml(yaml))).toBe(true); // shape is fine
    expect(parseProductSpec(yaml).ok).toBe(false); // semantics are not
  });

  it('an out-of-vocabulary contract schema key is shape-valid (OPEN contracts slot) but the parser REJECTS it', () => {
    const yaml = `version: "1.0"
product: { id: p, name: P }
contracts:
  c:
    type: object
    properties:
      id: { type: string, pattern: "^x" }
`;
    expect(validate(parseYaml(yaml))).toBe(true); // contracts is an OPEN record in the schema
    expect(parseProductSpec(yaml).ok).toBe(false); // the closed vocabulary is a PARSER (lint) rule
  });

  it('a dependency CYCLE is shape-valid (schema PASSES) but the parser REJECTS it', () => {
    const yaml = `version: "1.0"
product: { id: p, name: P }
capabilities:
  - id: cap
    tier: B
    status: reserved
    contracts: [cap.ready]
workflows:
  - id: wf
    trigger: { capability: cap, event: ready }
    steps:
      - { id: a, type: capability, use: cap.op, depends_on: [b] }
      - { id: b, type: capability, use: cap.op, depends_on: [a] }
`;
    expect(validate(parseYaml(yaml))).toBe(true); // declaration-order is not a shape rule
    expect(parseProductSpec(yaml).ok).toBe(false); // it is a PARSER rule
  });
});
