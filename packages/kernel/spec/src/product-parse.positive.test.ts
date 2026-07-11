/**
 * Product-YAML POSITIVE tests — specs that are shape-valid AND semantically valid must pass the
 * full pipeline (guardrails → strict Zod → lint) with `ok:true`. The dual of the negatives' false-accept
 * guard: these guard against an over-eager parser (a FALSE rejection), and prove the NEUTRALITY claim —
 * two independent, domain-neutral products validate through the REAL grammar/lint path.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseProductSpec } from './product-parse.js';

function read(relFromRepoRoot: string): string {
  // this file: packages/spec/src/*.test.ts → ../../../ = repo root.
  return readFileSync(
    fileURLToPath(new URL(`../../../../${relFromRepoRoot}`, import.meta.url)),
    'utf8',
  );
}

describe('positive — minimal + defaults', () => {
  it('accepts a minimal doc (only version + product; every section defaults)', () => {
    const res = parseProductSpec('version: "1.0"\nproduct:\n  id: tiny\n  name: Tiny\n');
    if (!res.ok) throw new Error(`expected ok:\n${JSON.stringify(res.errors, null, 2)}`);
    expect(res.value.capabilities).toEqual([]);
    expect(res.value.artifacts).toEqual([]);
    expect(res.value.workflows).toEqual([]);
    expect(res.value.views).toEqual([]);
    expect(res.value.contracts).toEqual({});
    expect(res.value.requires.capabilities).toEqual([]);
  });
});

describe('positive — NEUTRALITY (two independent products validate through the REAL parser)', () => {
  it('accepts the committed neutral acme-notes reference product (loaded directly, no mutation)', () => {
    // The on-disk `acme-notes.product.yaml` is the neutral open-core `version:'1.0'` product reference —
    // loaded verbatim, no in-test version swap. Proves the shipped parser enforces exactly the fixture's
    // intended shape.
    const acme = read('examples/acme-notes/acme-notes.product.yaml');
    const res = parseProductSpec(acme);
    if (!res.ok)
      throw new Error(
        `committed acme-notes fixture must parse:\n${JSON.stringify(res.errors, null, 2)}`,
      );
    expect(res.value.product.id).toBe('acme_notes');
    expect(res.value.workflows[0]?.id).toBe('process_session');
  });

  it('accepts a SECOND, structurally different product (support-triage fixture)', () => {
    const triage = read(
      'packages/kernel/spec/src/__fixtures__/product/support-triage.product.yaml',
    );
    const res = parseProductSpec(triage);
    if (!res.ok)
      throw new Error(`support-triage must parse:\n${JSON.stringify(res.errors, null, 2)}`);
    expect(res.value.product.id).toBe('support_triage');
    expect(res.value.workflows[0]?.id).toBe('process_ticket');
  });
});

describe('NEGATIVE TWIN — the invalid acme-notes fixture proves the positive parse is not tautological', () => {
  it('rejects acme-notes.invalid.product.yaml (an artifact names the undeclared contract acme.item_undeclared)', () => {
    // The negative twin is BYTE-IDENTICAL to the positive fixture except ONE artifact's `contract:` ref
    // (acme.item → acme.item_undeclared), which resolves to no declared contract. The semantic-lint
    // cross-ref pass inside parseProductSpec (checkRef over artifacts[].contract) catches it — so the
    // whole parse FAILS closed with a `dangling_ref`. This is what makes the positive test non-tautological:
    // if the parser accepted anything, the SAME doc minus one contract ref would still pass.
    const invalid = read('examples/acme-notes/acme-notes.invalid.product.yaml');
    const res = parseProductSpec(invalid);
    expect(res.ok).toBe(false);
    if (res.ok)
      throw new Error('the invalid twin must be rejected (it names an undeclared contract)');
    const dangling = res.errors.filter((e) => e.code === 'dangling_ref');
    expect(dangling.length).toBeGreaterThan(0);
    expect(dangling.some((e) => e.message.includes('acme.item_undeclared'))).toBe(true);
    expect(
      dangling.some(
        (e) => (e.path ?? '').includes('artifacts') && (e.path ?? '').includes('contract'),
      ),
    ).toBe(true);
  });
});

describe('positive — section-aware guardrails do NOT over-reject', () => {
  it('accepts a provider NAME + provider policy in a capability (allowed OUTSIDE the graph)', () => {
    const yaml = `
version: "1.0"
product:
  id: p
  name: P
capabilities:
  - id: stt
    tier: B
    status: reserved
    contracts: [stt.transcribe]
    provider_policy:
      default_provider: deepgram
      default_model: nova-2
      adapter_visibility: internal
    runtime_notes: Deepgram is the first adapter binding, not the public architecture.
deployment_overrides:
  providers:
    deepgram:
      default_model: nova-2
`;
    const res = parseProductSpec(yaml);
    if (!res.ok)
      throw new Error(
        `provider policy in a capability must parse:\n${JSON.stringify(res.errors, null, 2)}`,
      );
    expect(res.value.capabilities[0]?.provider_policy?.default_provider).toBe('deepgram');
  });

  it('accepts a contract PROPERTY legitimately named `code` (contracts are excluded from the code-key ban)', () => {
    const yaml = `
version: "1.0"
product:
  id: p
  name: P
contracts:
  p.coupon:
    type: object
    additional_properties: false
    properties:
      code:
        type: string
      function:
        type: string
    required: [code]
`;
    const res = parseProductSpec(yaml);
    if (!res.ok)
      throw new Error(
        `a data property named 'code' must be allowed:\n${JSON.stringify(res.errors, null, 2)}`,
      );
    expect(Object.keys(res.value.contracts)).toContain('p.coupon');
  });
});
