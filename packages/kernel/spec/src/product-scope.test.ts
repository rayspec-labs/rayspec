/**
 * `assertProductScope` — the fail-closed boot-scope gate.
 *
 * A parsed `ProductSpec` may be grammar-valid yet declare a shape the composable v1 envelope does NOT
 * support end-to-end (a sufficiency finding). This gate is the boot FRONT-DOOR: it rejects
 * those out-of-scope shapes with an actionable message BEFORE the deeper compose/derive machinery
 * (which enforces the single-scope law 3× but with an internal, less-actionable error), and it rejects
 * a shape the deeper machinery does NOT catch (a non-capability POST view — an interpreted read on POST
 * mounts and boots today). The SUPPORTED shapes (acme-notes, support-triage, the acceptance product) pass.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseProductSpec } from './product-parse.js';
import {
  assertProductScope,
  collectProductScopeViolations,
  ProductScopeError,
} from './product-scope.js';

const here = dirname(fileURLToPath(import.meta.url));
const ACME_NOTES_YAML = resolve(here, '../../../../examples/acme-notes/acme-notes.product.yaml');
const SUPPORT_TRIAGE = resolve(here, '__fixtures__/product/support-triage.product.yaml');

function parse(text: string) {
  const res = parseProductSpec(text);
  if (!res.ok) throw new Error(`fixture did not parse: ${JSON.stringify(res.errors, null, 2)}`);
  return res.value;
}

/** A minimal SUPPORTED non-audio doc: single scope, GET views only. */
const SUPPORTED = `
version: "1.0"
product: { id: ok, name: Ok }
requires: { capabilities: [record_input] }
capabilities:
  - { id: record_input, tier: B, status: available, contracts: [record_input.record_submitted] }
contracts:
  ok.row: { type: object }
  ok.resp: { type: object }
stores:
  - name: log
    columns:
      - { name: log_ref, type: text }
      - { name: record_id, type: text }
    key: [log_ref]
workflows:
  - id: w
    trigger: { capability: record_input, event: record_submitted, scope: record }
    steps:
      - id: write
        type: store_write
        use: store.write
        store: log
        values: { log_ref: { event: record_id }, record_id: { event: record_id } }
views:
  - id: v
    route: { method: GET, path: "/log/{record_id}" }
    auth: bearer_tenant
    params: { record_id: { in: path, shape: safe_id } }
    source: { kind: store, ref: log }
    read:
      mode: single
      filter: { record_id: { param: record_id } }
      shape:
        fields:
          record_id: { kind: param, param: record_id }
    absent_state: not_ready_409
    response_contract: ok.resp
`;

describe('assertProductScope — supported shapes pass', () => {
  it('the acme-notes product (single scope, capability-backed POST play-token view) passes', () => {
    const spec = parse(readFileSync(ACME_NOTES_YAML, 'utf8'));
    expect(collectProductScopeViolations(spec)).toEqual([]);
    expect(() => assertProductScope(spec)).not.toThrow();
  });

  it('the support-triage fixture (single scope, GET view) passes', () => {
    const spec = parse(readFileSync(SUPPORT_TRIAGE, 'utf8'));
    expect(collectProductScopeViolations(spec)).toEqual([]);
    expect(() => assertProductScope(spec)).not.toThrow();
  });

  it('a minimal single-scope, GET-view-only doc passes', () => {
    const spec = parse(SUPPORTED);
    expect(collectProductScopeViolations(spec)).toEqual([]);
    expect(() => assertProductScope(spec)).not.toThrow();
  });

  it('a POST view over a CAPABILITY source (a playback-token-style command) passes', () => {
    const doc = `
version: "1.0"
product: { id: cap, name: Cap }
capabilities:
  - { id: media_playback, tier: B, status: available, contracts: [media_playback.token] }
contracts:
  cap.resp:
    type: object
    additional_properties: false
    properties: { token: { type: string } }
    required: [token]
views:
  - id: play
    route: { method: POST, path: "/play-token" }
    auth: bearer_tenant
    source: { kind: capability, ref: media_playback.token }
    response_contract: cap.resp
`;
    expect(collectProductScopeViolations(parse(doc))).toEqual([]);
  });
});

describe('assertProductScope — out-of-scope shapes fail closed', () => {
  it('rejects MULTI-SCOPE persistence (2 distinct scopes across persisted artifacts)', () => {
    const doc = `
version: "1.0"
product: { id: multiscope, name: MultiScope }
contracts:
  a.c: { type: object }
  b.c: { type: object }
artifacts:
  - { kind: alpha, contract: a.c, scope: ticket, collection: coll_a, lifecycle: { persist: true } }
  - { kind: beta, contract: b.c, scope: account, collection: coll_b, lifecycle: { persist: true } }
`;
    const spec = parse(doc);
    const violations = collectProductScopeViolations(spec);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('multi-scope persistence');
    expect(violations[0]).toContain('ticket');
    expect(violations[0]).toContain('account');
    expect(() => assertProductScope(spec)).toThrow(ProductScopeError);
    try {
      assertProductScope(spec);
    } catch (e) {
      expect(e).toBeInstanceOf(ProductScopeError);
      expect((e as ProductScopeError).violations).toHaveLength(1);
    }
  });

  it('does NOT count a persist:false artifact toward the scope set (single effective scope passes)', () => {
    const doc = `
version: "1.0"
product: { id: onescope, name: OneScope }
contracts:
  a.c: { type: object }
  b.c: { type: object }
artifacts:
  - { kind: alpha, contract: a.c, scope: ticket, collection: coll_a, lifecycle: { persist: true } }
  - { kind: beta, contract: b.c, scope: account, lifecycle: { persist: false } }
`;
    expect(collectProductScopeViolations(parse(doc))).toEqual([]);
  });

  it('rejects a WRITE/ADMIN surface — a POST view over a STORE source', () => {
    const doc = `
version: "1.0"
product: { id: postwrite, name: PostWrite }
contracts:
  pw.resp: { type: object }
stores:
  - name: s
    columns: [{ name: s_ref, type: text }]
    key: [s_ref]
views:
  - id: mutate
    route: { method: POST, path: "/s/{s_ref}" }
    auth: bearer_tenant
    params: { s_ref: { in: path, shape: safe_id } }
    source: { kind: store, ref: s }
    read:
      mode: single
      filter: { s_ref: { param: s_ref } }
      shape:
        fields:
          s_ref: { kind: param, param: s_ref }
    absent_state: not_ready_409
    response_contract: pw.resp
`;
    const spec = parse(doc);
    const violations = collectProductScopeViolations(spec);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('write/admin surface');
    expect(violations[0]).toContain("view 'mutate'");
    expect(() => assertProductScope(spec)).toThrow(ProductScopeError);
  });

  it('aggregates MULTIPLE violations in one throw (both shapes at once)', () => {
    const doc = `
version: "1.0"
product: { id: both, name: Both }
contracts:
  a.c: { type: object }
  b.c: { type: object }
  both.resp: { type: object }
artifacts:
  - { kind: alpha, contract: a.c, scope: ticket, collection: coll_a, lifecycle: { persist: true } }
  - { kind: beta, contract: b.c, scope: account, collection: coll_b, lifecycle: { persist: true } }
stores:
  - name: s
    columns: [{ name: s_ref, type: text }]
    key: [s_ref]
views:
  - id: mutate
    route: { method: POST, path: "/s/{s_ref}" }
    auth: bearer_tenant
    params: { s_ref: { in: path, shape: safe_id } }
    source: { kind: store, ref: s }
    read:
      mode: single
      filter: { s_ref: { param: s_ref } }
      shape:
        fields:
          s_ref: { kind: param, param: s_ref }
    absent_state: not_ready_409
    response_contract: both.resp
`;
    const spec = parse(doc);
    const violations = collectProductScopeViolations(spec);
    expect(violations).toHaveLength(2);
    expect(() => assertProductScope(spec)).toThrow(
      /multi-scope persistence[\s\S]*write\/admin surface/,
    );
  });
});
