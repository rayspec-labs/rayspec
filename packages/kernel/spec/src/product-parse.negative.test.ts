/**
 * Product-YAML NEGATIVE tests — each takes a known-good BASE spec, injects EXACTLY ONE defect,
 * and asserts the EXACT closed error SET (length + code + PATH). Fail-the-fix, not pass-the-shape: a rule
 * that stopped rejecting its defect BREAKS its case, AND a regression that changes the path or ADDS a
 * spurious error also breaks it (a fail-the-fix strengthening).
 *
 * Several of these cases document behavior that the earlier REAL parser did NOT have at all: before
 * this stage the enforcement lived only in the opt-in check script (over the frozen draft doc),
 * so `parseSpec`/`deploy` had NO Product-YAML validation — a Product-YAML doc simply failed
 * `unsupported_version`. These tests prove the guardrails now live in the real parser, fail-closed.
 */
import { describe, expect, it } from 'vitest';
import type { SpecErrorCode } from './errors.js';
import { parseProductSpec } from './product-parse.js';

/** A known-good base product spec (every section present, all cross-refs resolve). */
const BASE = `
version: "1.0"
product:
  id: demo
  name: Demo
requires:
  capabilities:
    - cap_a
    - grounding
capabilities:
  - id: cap_a
    tier: B
    status: reserved
    contracts:
      - cap_a.thing
      - cap_a.thing_ready
    provider_policy:
      default_provider: some_provider
      default_model: some_model
      adapter_visibility: internal
    runtime_notes: cap_a is a future Tier B capability (deepgram is a candidate adapter).
  - id: grounding
    tier: B
    status: reserved
    contracts:
      - grounding.check
      - grounding.result
artifacts:
  - kind: result
    contract: demo.result
    provenance:
      source: cap_a.thing
      evidence_field: evidence
      required: true
contracts:
  cap_a.thing:
    type: object
    additional_properties: false
    properties:
      id: { type: string }
    required: [id]
  demo.result:
    type: object
    additional_properties: false
    properties:
      value: { type: string }
      evidence:
        type: array
        items: { type: string }
    required: [value, evidence]
  demo.intelligence:
    type: object
    additional_properties: false
    properties:
      value: { type: string }
    required: [value]
  demo.response:
    type: object
    additional_properties: false
    properties:
      value: { type: string }
    required: [value]
extractors:
  - id: extractor
    purpose: Extract demo intelligence from thing spans.
    extraction:
      intent: demo_extraction
      input_artifacts:
        - name: thing
          ref: cap_a.thing
          kind: thing
          required: true
          source_step_id: receive
      output_artifacts:
        - name: candidate
          ref: demo.intelligence
          kind: candidate
          schema_ref: demo.intelligence
          materialization_target: typed_artifact_ref
      required_output_shape:
        schema_ref: demo.intelligence
      acceptance_boundary:
        type: validation_node
        requires:
          - grounding.check
      materialization:
        target: typed_artifact_ref
workflows:
  - id: process
    trigger:
      capability: cap_a
      event: thing_ready
      scope: thing
    steps:
      - id: receive
        type: capability
        use: cap_a.thing_ready
        outputs:
          thing: cap_a.thing
      - id: extract
        type: agent
        use: agent.extractor
        depends_on: [receive]
        inputs:
          thing: cap_a.thing
        outputs:
          candidate: demo.intelligence
      - id: ground
        type: validation
        use: grounding.check
        depends_on: [extract]
        inputs:
          candidate: demo.intelligence
        outputs:
          grounding_result: grounding.result
grounding:
  require_source_spans: true
  source_span_contract: cap_a.thing
  validation_capability: grounding.check
views:
  - id: get_result
    route:
      method: GET
      path: /things/{id}/result
    auth: bearer_tenant
    source:
      kind: artifact_query
      ref: demo.response
    absent_state: empty_200
    response_contract: demo.response
`;

/** One fail-closed error, as a `[code, path]` pair (path `undefined` for a whole-doc failure). */
type ErrPair = [SpecErrorCode, string | undefined];

/** Normalize an error set to a sorted `code@path` list so the assertion is order-insensitive but EXACT. */
function normSet(pairs: ErrPair[]): string[] {
  return pairs.map(([code, path]) => `${code}@${path ?? ''}`).sort();
}

/**
 * Assert the parse failed with the EXACT expected error set (length + code + PATH). This is the TH-2
 * strengthening over a loose `toContain`: a path-wrong regression, or an over-rejecting one that adds a
 * spurious error, now FAILS the case.
 */
function expectExact(yaml: string, expected: ErrPair[]): void {
  const res = parseProductSpec(yaml);
  expect(res.ok).toBe(false);
  if (res.ok) return;
  const actual = res.errors.map((e) => [e.code, e.path] as ErrPair);
  expect(normSet(actual)).toEqual(normSet(expected));
}

/** Assert the parse failed and its error set CONTAINS all of `codes` (for the multi-defect aggregation). */
function expectContainsAll(yaml: string, codes: SpecErrorCode[]): void {
  const res = parseProductSpec(yaml);
  expect(res.ok).toBe(false);
  if (res.ok) return;
  const got = res.errors.map((e) => e.code);
  for (const code of codes) expect(got).toContain(code);
}

describe('BASE is valid (so each negative isolates ONE defect)', () => {
  it('parses ok', () => {
    const res = parseProductSpec(BASE);
    if (!res.ok) throw new Error(`base must parse:\n${JSON.stringify(res.errors, null, 2)}`);
    expect(res.ok).toBe(true);
  });
});

describe('unsupported_version (two-phase, checked FIRST)', () => {
  it('rejects an unknown version with EXACTLY one clean error', () => {
    expectExact(BASE.replace('version: "1.0"', 'version: "9.9"'), [
      ['unsupported_version', 'version'],
    ]);
  });

  it('rejects a missing version', () => {
    expectExact(BASE.replace('version: "1.0"\n', ''), [['unsupported_version', 'version']]);
  });

  it('rejects an unquoted numeric version with a quote-it hint (no coercion)', () => {
    const res = parseProductSpec(BASE.replace('version: "1.0"', 'version: 1.0'));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]?.code).toBe('unsupported_version');
    expect(res.errors[0]?.message).toMatch(/quoted string/i);
  });

  it('REJECTS a removed-legacy product_yaml_version:"0.2" document fail-closed (one-version purity)', () => {
    // The 0.2 transition shim is CUT: a `product_yaml_version` doc carries no `version` key, so the
    // two-phase version check fails first with a single clean `unsupported_version` (missing version).
    expectExact(BASE.replace('version: "1.0"', 'product_yaml_version: "0.2"'), [
      ['unsupported_version', 'version'],
    ]);
  });
});

describe('removed-legacy `agents:` section is rejected (one-version purity, negative twin)', () => {
  it('REJECTS a canonical version:1.0 product doc using the removed legacy `agents:` section', () => {
    // The 1.0 product grammar declares `extractors:`, not `agents:`. With the agents→extractors shim
    // removed, an `agents:` section on a 1.0 doc is an unknown top-level field → strict-rejected
    // fail-closed. (This invariant migrated here from the deleted transition-shim negative twin.)
    const yaml = `version: "1.0"
product:
  id: p
  name: P
agents:
  - id: x
    purpose: Extract something from ticket evidence.
`;
    const res = parseProductSpec(yaml);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(
      res.errors.some((e) => e.code === 'unknown_field' && (e.path ?? '').startsWith('agents')),
    ).toBe(true);
  });
});

describe('capabilities[].input_normalize.output_contract → resolve (dangling_ref)', () => {
  const RUNTIME_NOTES =
    '    runtime_notes: cap_a is a future Tier B capability (deepgram is a candidate adapter).\n';
  const withNormalize = (outputContract: string, extra = ''): string =>
    BASE.replace(
      RUNTIME_NOTES,
      `${RUNTIME_NOTES}    input_normalize:\n      agent: field_normalizer\n      output_contract: ${outputContract}\n${extra}`,
    );

  it('rejects an input_normalize whose output_contract does not resolve (EXACTLY one dangling_ref)', () => {
    expectExact(withNormalize('nope.missing'), [
      ['dangling_ref', 'capabilities[0].input_normalize.output_contract'],
    ]);
  });

  it('ACCEPTS an input_normalize whose output_contract resolves to a declared contract (additive — BASE stays valid)', () => {
    const res = parseProductSpec(withNormalize('cap_a.thing'));
    if (!res.ok) throw new Error(`must parse:\n${JSON.stringify(res.errors, null, 2)}`);
    expect(res.ok).toBe(true);
  });

  it('rejects an unknown key inside input_normalize (.strict())', () => {
    const res = parseProductSpec(withNormalize('cap_a.thing', '      bogus: 1\n'));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.some((e) => (e.path ?? '').includes('input_normalize'))).toBe(true);
  });
});

describe('yaml_parse_error', () => {
  it('rejects non-YAML text', () => {
    expectExact('version: "1.0"\nproduct: { id: ', [['yaml_parse_error', undefined]]);
  });
});

describe('unknown_field (strict, fail-closed)', () => {
  it('rejects an unknown TOP-LEVEL section', () => {
    expectExact(`${BASE}\nbogus_section: []\n`, [['unknown_field', 'bogus_section']]);
  });

  it('rejects an unknown key inside product', () => {
    expectExact(BASE.replace('  name: Demo\n', '  name: Demo\n  tenant: acme\n'), [
      ['unknown_field', 'product.tenant'],
    ]);
  });

  it('rejects an unknown key inside a view (benign typo)', () => {
    expectExact(
      BASE.replace('    auth: bearer_tenant\n', '    auth: bearer_tenant\n    paginationn: {}\n'),
      [['unknown_field', 'views[0].paginationn']],
    );
  });
});

describe('schema_violation (shape)', () => {
  it('rejects a capability tier other than B', () => {
    expectExact(
      BASE.replace(
        '    tier: B\n    status: reserved\n    contracts:\n      - cap_a.thing',
        '    tier: A\n    status: reserved\n    contracts:\n      - cap_a.thing',
      ),
      [['schema_violation', 'capabilities[0].tier']],
    );
  });

  it('rejects a view method outside GET/POST', () => {
    expectExact(BASE.replace('      method: GET', '      method: PUT'), [
      ['schema_violation', 'views[0].route.method'],
    ]);
  });

  it('rejects absent_state processing_200 (the draft-banned value is not in the enum)', () => {
    expectExact(BASE.replace('    absent_state: empty_200', '    absent_state: processing_200'), [
      ['schema_violation', 'views[0].absent_state'],
    ]);
  });

  it('rejects an unknown/typo workflow step type (fail-CLOSED, never silently dropped)', () => {
    expectExact(
      BASE.replace(
        '        type: capability\n        use: cap_a.thing_ready',
        '        type: capabilty\n        use: cap_a.thing_ready',
      ),
      [['schema_violation', 'workflows[0].steps[0].type']],
    );
  });

  it('rejects a non-positive retry.max_attempts', () => {
    expectExact(
      BASE.replace(
        '        use: grounding.check\n        depends_on: [extract]',
        '        use: grounding.check\n        retry:\n          max_attempts: 0\n        depends_on: [extract]',
      ),
      [['schema_violation', 'workflows[0].steps[2].retry.max_attempts']],
    );
  });

  it('rejects an empty acceptance_boundary.requires', () => {
    expectExact(
      BASE.replace(
        '      acceptance_boundary:\n        type: validation_node\n        requires:\n          - grounding.check',
        '      acceptance_boundary:\n        type: validation_node\n        requires: []',
      ),
      [['schema_violation', 'extractors[0].extraction.acceptance_boundary.requires']],
    );
  });

  it('rejects a workflow with zero steps', () => {
    expectExact(BASE.replace(/ {4}steps:\n(?:.*\n)*?grounding:/, '    steps: []\ngrounding:'), [
      ['schema_violation', 'workflows[0].steps'],
    ]);
  });

  // ── SHOULD-1 (S5 review): the agent id is a SafeIdentifier — a `..`/`/` id would traverse into the
  // per-agent extractor-config PATH (resolveExtractorConfigPath). The grammar rejects it fail-closed at
  // parse (schema_violation@extractors[0].id) — the SOURCE half of the defense-in-depth (the resolver jail is
  // the SINK half). Zod short-circuits before lint, so the dangling `agent.extractor` ref is NOT reported.
  it('rejects an agent id with `..`/`/` path-traversal metacharacters (SafeIdentifier)', () => {
    expectExact(BASE.replace('  - id: extractor', '  - id: "../../../../../tmp/pwned"'), [
      ['schema_violation', 'extractors[0].id'],
    ]);
  });

  it('rejects an agent id with a bare forward slash (SafeIdentifier)', () => {
    expectExact(BASE.replace('  - id: extractor', '  - id: "evil/extractor"'), [
      ['schema_violation', 'extractors[0].id'],
    ]);
  });
});

describe('no_code_in_yaml (code/handlers never in YAML)', () => {
  it('rejects a `module:` key (handler module ref) anywhere', () => {
    // `get_result` as the value trips ONLY the `module` KEY ban → an exact single error.
    expectExact(
      BASE.replace(
        '    auth: bearer_tenant\n',
        '    auth: bearer_tenant\n    module: get_result\n',
      ),
      [['no_code_in_yaml', 'views[0].module']],
    );
  });

  it('rejects a `handler:` key inside a workflow step', () => {
    expectExact(
      BASE.replace(
        '        use: cap_a.thing_ready\n',
        '        use: cap_a.thing_ready\n        handler: do_thing\n',
      ),
      [['no_code_in_yaml', 'workflows[0].steps[0].handler']],
    );
  });

  it('rejects an inline-code string value', () => {
    // Inject a code-like value into product.metadata (a record<string,string>): `require('./evil.js')`
    // matches the inline-code pattern, so the raw guardrail scan rejects it before shape validation.
    const yaml = BASE.replace(
      '  name: Demo\n',
      '  name: Demo\n  metadata:\n    onload: "require(\'./evil.js\')"\n',
    );
    expectExact(yaml, [['no_code_in_yaml', 'product.metadata.onload']]);
  });

  it('rejects a prompt key inside an agent (graph)', () => {
    expectExact(
      BASE.replace(
        '    purpose: Extract demo intelligence from thing spans.\n',
        '    purpose: Extract demo intelligence from thing spans.\n    system_prompt: You are a helpful assistant.\n',
      ),
      [['no_code_in_yaml', 'extractors[0].system_prompt']],
    );
  });
});

describe('provider_native_leak (provider blobs / graph policy leaks)', () => {
  it('rejects a provider wire-blob key (`body`) anywhere', () => {
    expectExact(
      BASE.replace(
        '    auth: bearer_tenant\n',
        '    auth: bearer_tenant\n    body: { raw: true }\n',
      ),
      [['provider_native_leak', 'views[0].body']],
    );
  });

  it('rejects a provider/model policy key (`model`) INSIDE a workflow step', () => {
    expectExact(
      BASE.replace(
        '        use: cap_a.thing_ready\n',
        '        use: cap_a.thing_ready\n        model: gpt-5\n',
      ),
      [['provider_native_leak', 'workflows[0].steps[0].model']],
    );
  });

  it('rejects a provider NAME as a value inside the workflow graph', () => {
    expectExact(
      BASE.replace('        use: cap_a.thing_ready', '        use: deepgram.transcribe'),
      [['provider_native_leak', 'workflows[0].steps[0].use']],
    );
  });

  it('SECTION-AWARE: a provider name in capability.runtime_notes is FINE, the SAME name in a workflow FAILS', () => {
    // The BASE already has "deepgram" in cap_a.runtime_notes and parses ok (asserted above), proving the
    // provider-name ban is scoped to the executable graph. Now inject it into an agent purpose (graph):
    expectExact(
      BASE.replace(
        '    purpose: Extract demo intelligence from thing spans.',
        '    purpose: Extract intelligence using deepgram directly.',
      ),
      [['provider_native_leak', 'extractors[0].purpose']],
    );
  });
});

describe('prompt/production execution claims (GR-1 — graph VALUE bans, mirror the bridge)', () => {
  it('rejects a prompt/LLM-execution claim as a graph string value', () => {
    expectExact(
      BASE.replace(
        '    purpose: Extract demo intelligence from thing spans.',
        '    purpose: Extract demo intelligence via an llm call.',
      ),
      [['prompt_execution_claim', 'extractors[0].purpose']],
    );
  });

  it('rejects a production-execution claim as a graph string value', () => {
    expectExact(
      BASE.replace(
        '    purpose: Extract demo intelligence from thing spans.',
        '    purpose: Extract demo intelligence (production_ready).',
      ),
      [['production_execution_claim', 'extractors[0].purpose']],
    );
  });
});

describe('capability status vocabulary', () => {
  it("ACCEPTS status:available at doc level — wiredness is the deploy composition's job now", () => {
    // Fix-flip record: this doc was formerly rejected with `invalid_capability_status`
    // ("no Tier B runtime is wired yet"). The runtime later landed and unlocked the
    // deploy mount, so the doc-level rejection's premise expired; the fail-closed wiredness gate
    // moved to `composeProductDeploy` (@rayspec/product-yaml), tested there + in deploy.test.ts.
    const res = parseProductSpec(
      BASE.replace(
        '    status: reserved\n    contracts:\n      - cap_a.thing',
        '    status: available\n    contracts:\n      - cap_a.thing',
      ),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.capabilities[0]?.status).toBe('available');
  });
  it('still rejects an UNKNOWN status at the shape level (closed enum)', () => {
    const res = parseProductSpec(
      BASE.replace(
        '    status: reserved\n    contracts:\n      - cap_a.thing',
        '    status: live\n    contracts:\n      - cap_a.thing',
      ),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.map((e) => e.code)).toContain('schema_violation');
      expect(res.errors.some((e) => (e.path ?? '').includes('capabilities'))).toBe(true);
    }
  });
});

describe('invalid_contract (closed declarative vocabulary)', () => {
  it('rejects an unknown contract schema key (e.g. pattern)', () => {
    expectExact(
      BASE.replace('      id: { type: string }', '      id: { type: string, pattern: "^x" }'),
      [['invalid_contract', 'contracts.cap_a.thing.properties.id.pattern']],
    );
  });

  it('rejects a contract type outside the allowed set', () => {
    expectExact(
      BASE.replace('  cap_a.thing:\n    type: object', '  cap_a.thing:\n    type: blob'),
      [['invalid_contract', 'contracts.cap_a.thing.type']],
    );
  });

  it('rejects a nested OBJECT smuggled under `description` (GR-2 exemption hole — the exact evil fixture)', () => {
    // `contracts` is exempt from the global code-key scan (a DATA property may be named `code`/`handler`),
    // and `description` was never type-checked, so `description: { handler, code }` escaped BOTH scans.
    // GR-2 closes it: a non-string `description` is `invalid_contract` — the nested handler/code never run.
    const yaml = `version: "1.0"
product:
  id: p
  name: P
contracts:
  evil:
    type: object
    description:
      handler: /handlers/evil.ts
      code: "import x from 'y'"
`;
    expectExact(yaml, [['invalid_contract', 'contracts.evil.description']]);
  });

  it('rejects a non-boolean additional_properties (GR-2 scalar-shape enforcement)', () => {
    expectExact(
      BASE.replace(
        '  cap_a.thing:\n    type: object\n    additional_properties: false',
        '  cap_a.thing:\n    type: object\n    additional_properties: { nope: 1 }',
      ),
      [['invalid_contract', 'contracts.cap_a.thing.additional_properties']],
    );
  });

  it('rejects a NON-SCALAR enum element (an object/array member could smuggle a nested shape)', () => {
    // A scalar enum (`enum: [a, b]`) is fine; an object element is not a valid enum member and would carry
    // a nested map past both the contracts-exempt global scan and the vocabulary check (GR-2 class).
    const yaml = `version: "1.0"
product:
  id: p
  name: P
contracts:
  status_enum:
    type: string
    enum:
      - ok
      - handler: /handlers/evil.ts
        code: "import x from 'y'"
`;
    expectExact(yaml, [['invalid_contract', 'contracts.status_enum.enum[1]']]);
  });
});

describe('dangling_ref (cross-references must resolve)', () => {
  it('rejects requires.capabilities → undeclared capability', () => {
    expectExact(
      BASE.replace(
        '    - grounding\ncapabilities:',
        '    - grounding\n    - ghost_cap\ncapabilities:',
      ),
      [['dangling_ref', 'requires.capabilities[2]']],
    );
  });

  it('rejects artifacts[].contract → undeclared contract', () => {
    expectExact(BASE.replace('    contract: demo.result', '    contract: nope.nothing'), [
      ['dangling_ref', 'artifacts[0].contract'],
    ]);
  });

  it('rejects a capability-NAMESPACED ref whose contract is not declared on that capability (GR-4)', () => {
    // `cap_a` is a declared capability but `cap_a.typoed_contract` is NOT one of its contracts — it used
    // to resolve on the namespace ALONE. Now it must be an EXACT declared contract of that capability.
    expectExact(BASE.replace('    contract: demo.result', '    contract: cap_a.typoed_contract'), [
      ['dangling_ref', 'artifacts[0].contract'],
    ]);
  });

  it('rejects a workflow trigger.capability → undeclared', () => {
    expectExact(
      BASE.replace(
        '      capability: cap_a\n      event: thing_ready',
        '      capability: ghost_cap\n      event: thing_ready',
      ),
      [['dangling_ref', 'workflows[0].trigger.capability']],
    );
  });

  it('rejects a workflow trigger.event that resolves to no declared capability contract (GR-4)', () => {
    expectExact(BASE.replace('event: thing_ready', 'event: thing_readyyy'), [
      ['dangling_ref', 'workflows[0].trigger.event'],
    ]);
  });

  it('rejects a step depends_on → unknown step (fail-open lesson)', () => {
    expectExact(BASE.replace('        depends_on: [receive]', '        depends_on: [ghost_step]'), [
      ['dangling_ref', 'workflows[0].steps[1].depends_on'],
    ]);
  });

  it('rejects a capability step whose namespace is undeclared', () => {
    expectExact(
      BASE.replace('        use: cap_a.thing_ready', '        use: ghost_cap.thing_ready'),
      [['dangling_ref', 'workflows[0].steps[0].use']],
    );
  });

  it('rejects an agent step → agent.<unknown>', () => {
    expectExact(BASE.replace('        use: agent.extractor', '        use: agent.ghost'), [
      ['dangling_ref', 'workflows[0].steps[1].use'],
    ]);
  });

  it('rejects a view source.ref → undeclared', () => {
    expectExact(
      BASE.replace(
        '      ref: demo.response\n    absent_state',
        '      ref: nope.nothing\n    absent_state',
      ),
      [['dangling_ref', 'views[0].source.ref']],
    );
  });

  it('rejects a view response_contract → undeclared', () => {
    expectExact(
      BASE.replace('    response_contract: demo.response', '    response_contract: nope.nothing'),
      [['dangling_ref', 'views[0].response_contract']],
    );
  });

  it('rejects grounding.source_span_contract → undeclared', () => {
    expectExact(
      BASE.replace('  source_span_contract: cap_a.thing', '  source_span_contract: nope.nothing'),
      [['dangling_ref', 'grounding.source_span_contract']],
    );
  });

  it('rejects an agent extraction ref → undeclared', () => {
    expectExact(
      BASE.replace(
        '          ref: demo.intelligence\n          kind: candidate',
        '          ref: nope.nothing\n          kind: candidate',
      ),
      [['dangling_ref', 'extractors[0].extraction.output_artifacts[0].ref']],
    );
  });
});

describe('invalid_dependency_order (GR-3 — declaration-order; cycles impossible)', () => {
  it('rejects a forward depends_on (a step depending on a LATER step)', () => {
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
      - id: a
        type: capability
        use: cap.op
        depends_on: [b]
      - id: b
        type: capability
        use: cap.op
`;
    expectExact(yaml, [['invalid_dependency_order', 'workflows[0].steps[0].depends_on']]);
  });

  it('rejects a dependency cycle (A↔B — the forward edge is caught)', () => {
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
      - id: a
        type: capability
        use: cap.op
        depends_on: [b]
      - id: b
        type: capability
        use: cap.op
        depends_on: [a]
`;
    expectExact(yaml, [['invalid_dependency_order', 'workflows[0].steps[0].depends_on']]);
  });
});

describe('view streaming guardrail (TH-4 — real, tested, not decorative)', () => {
  it('rejects a `/playback` route path (belongs to Tier-B media serving)', () => {
    expectExact(
      BASE.replace('      path: /things/{id}/result', '      path: /things/{id}/playback'),
      [['schema_violation', 'views[0].route.path']],
    );
  });

  it('rejects a `/stream` route path', () => {
    expectExact(
      BASE.replace('      path: /things/{id}/result', '      path: /things/{id}/stream'),
      [['schema_violation', 'views[0].route.path']],
    );
  });

  it('rejects a COMPOUND `/livestream` route path (evades a `\\bstream\\b`-only marker)', () => {
    expectExact(
      BASE.replace('      path: /things/{id}/result', '      path: /things/{id}/livestream'),
      [['schema_violation', 'views[0].route.path']],
    );
  });

  it('rejects a `/live-streaming` route path', () => {
    expectExact(
      BASE.replace('      path: /things/{id}/result', '      path: /things/{id}/live-streaming'),
      [['schema_violation', 'views[0].route.path']],
    );
  });

  it('does NOT over-reject a benign `/downstream-jobs` route (no internal stream word-boundary)', () => {
    // Negative-of-the-negative: the marker must not fire on a name that merely CONTAINS "stream" without a
    // word boundary (`downstream`) — else it would false-reject legitimate non-media routes.
    const res = parseProductSpec(
      BASE.replace('      path: /things/{id}/result', '      path: /things/{id}/downstream-jobs'),
    );
    if (!res.ok)
      throw new Error(`/downstream-jobs must parse:\n${JSON.stringify(res.errors, null, 2)}`);
    expect(res.ok).toBe(true);
  });

  it('rejects a streaming SOURCE KIND structurally (closed enum → schema_violation)', () => {
    expectExact(BASE.replace('      kind: artifact_query', '      kind: stream'), [
      ['schema_violation', 'views[0].source.kind'],
    ]);
  });
});

describe('duplicate_name', () => {
  it('rejects two capabilities with the same id', () => {
    expectExact(
      BASE.replace(
        '  - id: grounding\n    tier: B',
        '  - id: cap_a\n    tier: B\n    status: reserved\n    contracts: []\n  - id: grounding\n    tier: B',
      ),
      [['duplicate_name', 'capabilities[1].id']],
    );
  });

  it('rejects two workflows with the same id', () => {
    expectExact(
      BASE.replace(
        'workflows:\n  - id: process',
        'workflows:\n  - id: process\n    trigger: { capability: cap_a, event: thing_ready }\n    steps:\n      - { id: s, type: capability, use: cap_a.thing_ready }\n  - id: process',
      ),
      [['duplicate_name', 'workflows[1].id']],
    );
  });

  it('rejects two views with the same route', () => {
    // Quote the path: `{id}` in a YAML flow scalar would start a flow-mapping (a parse error).
    expectExact(
      BASE.replace(
        '  - id: get_result',
        '  - id: get_result_2\n    route: { method: GET, path: "/things/{id}/result" }\n    response_contract: demo.response\n  - id: get_result',
      ),
      [['duplicate_name', 'views[1].route']],
    );
  });

  it('rejects two workflow steps with the same id', () => {
    expectExact(
      BASE.replace(
        '      - id: receive\n        type: capability\n        use: cap_a.thing_ready\n        outputs:\n          thing: cap_a.thing',
        '      - id: receive\n        type: capability\n        use: cap_a.thing_ready\n      - id: receive\n        type: capability\n        use: cap_a.thing_ready\n        outputs:\n          thing: cap_a.thing',
      ),
      [['duplicate_name', 'workflows[0].steps[1].id']],
    );
  });

  it('rejects two artifacts with the same kind', () => {
    expectExact(
      BASE.replace(
        'artifacts:\n  - kind: result',
        'artifacts:\n  - kind: result\n    contract: demo.result\n  - kind: result',
      ),
      [['duplicate_name', 'artifacts[1].kind']],
    );
  });
});

describe('aggregation (all violations in one pass, not just the first)', () => {
  it('reports multiple independent violations together', () => {
    const yaml = BASE.replace('    contract: demo.result', '    contract: nope.nothing') // dangling_ref
      .replace(
        '  - id: grounding\n    tier: B',
        '  - id: cap_a\n    tier: B\n    status: reserved\n    contracts: []\n  - id: grounding\n    tier: B',
      ); // duplicate_name
    const res = parseProductSpec(yaml);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expectContainsAll(yaml, ['dangling_ref', 'duplicate_name']);
    expect(res.errors.length).toBeGreaterThanOrEqual(2);
  });
});
