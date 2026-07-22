/**
 * Inline / hash-pinned extraction prompts — the grammar addition + the NARROWED no-code guardrail.
 *
 * A product author may write an extractor's system prompt INLINE in the product document
 * (`extractors[].instructions`, a block scalar) or PIN an external prompt file by hash
 * (`extractors[].instructions_ref: { file, sha256 }`). `instructions` is the SAME trusted deployer-authored
 * system-channel vocabulary as `RecordNormalizerConfig.instructions` / `ResponderConfig.instructions`.
 *
 * The no-code guardrail is NARROWED, not removed: the designated `extractors[<int>].instructions` leaf is
 * EXEMPT from the VALUE scans (a real system prompt is free-form text that trips the code-like / prompt-
 * execution patterns), while EVERY other leaf — `purpose`, `extraction_constraints[]`, `instructions_ref.file`,
 * a `system_prompt` KEY, every other section — stays fully fail-closed. These tests fail-the-fix: an
 * over-broad exemption, or a lost exemption, breaks a case.
 */
import { describe, expect, it } from 'vitest';
import type { SpecErrorCode } from './errors.js';
import { ExtractorSpec } from './product-grammar.js';
import { parseProductSpec } from './product-parse.js';

const HEX64 = 'a'.repeat(64);

/** A shape-valid extractor (input/output artifacts default to []) for the direct-grammar cases. */
const VALID_EXTRACTOR = {
  id: 'ex',
  purpose: 'extract things',
  extraction: {
    intent: 'x',
    required_output_shape: { schema_ref: 'cap.thing' },
    acceptance_boundary: { type: 'validation_node', requires: ['grounding.check'] },
    materialization: { target: 'typed_artifact_ref' },
  },
} as const;

/**
 * A known-good `version:'1.0'` product doc with ONE extractor. `extractorExtra` is spliced verbatim after
 * the extractor's `purpose` (the caller supplies the leading newline + indentation). With no injection it
 * parses ok, so any single injection is the SOLE variable.
 */
function productDoc(opts: { purpose?: string; extractorExtra?: string } = {}): string {
  const purpose = opts.purpose ?? 'extract things';
  return `version: "1.0"
product:
  id: p
  name: P
capabilities:
  - id: cap
    tier: B
    status: reserved
    contracts: [cap.ready, cap.thing]
contracts:
  cap.thing: { type: object }
extractors:
  - id: ex
    purpose: ${JSON.stringify(purpose)}${opts.extractorExtra ?? ''}
    extraction:
      intent: x
      input_artifacts:
        - { name: t, ref: cap.thing, kind: thing }
      output_artifacts:
        - { name: c, ref: cap.thing, kind: cand }
      required_output_shape: { schema_ref: cap.thing }
      acceptance_boundary: { type: validation_node, requires: [grounding.check] }
      materialization: { target: typed_artifact_ref }
workflows:
  - id: wf
    trigger: { capability: cap, event: ready }
    steps:
      - id: s
        type: capability
        use: cap.op
`;
}

function parseOk(yaml: string): void {
  const res = parseProductSpec(yaml);
  if (!res.ok) throw new Error(`expected ok, got:\n${JSON.stringify(res.errors, null, 2)}`);
  expect(res.ok).toBe(true);
}

/** Assert the parse failed AND carries at least one error with the given code at the given path. */
function parseRejectsAt(yaml: string, code: SpecErrorCode, path: string): void {
  const res = parseProductSpec(yaml);
  expect(res.ok).toBe(false);
  if (res.ok) return;
  expect(res.errors.some((e) => e.code === code && e.path === path)).toBe(true);
}

describe('ExtractorSpec grammar — inline / hash-pinned prompt fields', () => {
  it('BASE (no prompt fields) parses ok — so any injection is the SOLE variable', () => {
    parseOk(productDoc());
    expect(ExtractorSpec.safeParse(VALID_EXTRACTOR).success).toBe(true);
  });

  it('accepts an inline instructions block scalar', () => {
    expect(
      ExtractorSpec.safeParse({ ...VALID_EXTRACTOR, instructions: 'You extract notes.' }).success,
    ).toBe(true);
  });

  it('accepts a hash-pinned instructions_ref', () => {
    expect(
      ExtractorSpec.safeParse({
        ...VALID_EXTRACTOR,
        instructions_ref: { file: 'prompts/system.md', sha256: HEX64 },
      }).success,
    ).toBe(true);
  });

  it('REJECTS instructions AND instructions_ref together (declare one, not both — superRefine)', () => {
    const res = ExtractorSpec.safeParse({
      ...VALID_EXTRACTOR,
      instructions: 'inline',
      instructions_ref: { file: 'prompts/system.md', sha256: HEX64 },
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path.join('.') === 'instructions_ref')).toBe(true);
    }
  });

  it('REJECTS a malformed sha256 (not 64 lowercase hex)', () => {
    for (const bad of ['nothex', HEX64.slice(0, 63), `${HEX64}f`, 'A'.repeat(64)]) {
      expect(
        ExtractorSpec.safeParse({
          ...VALID_EXTRACTOR,
          instructions_ref: { file: 'prompts/system.md', sha256: bad },
        }).success,
      ).toBe(false);
    }
  });

  it('REJECTS an unknown key on an extractor (.strict() is preserved)', () => {
    expect(ExtractorSpec.safeParse({ ...VALID_EXTRACTOR, bogus: 1 }).success).toBe(false);
  });

  it('REJECTS an unknown key inside instructions_ref (.strict() on the ref object)', () => {
    expect(
      ExtractorSpec.safeParse({
        ...VALID_EXTRACTOR,
        instructions_ref: { file: 'prompts/system.md', sha256: HEX64, extra: 1 },
      }).success,
    ).toBe(false);
  });
});

describe('guardrail NARROWING — extractors[<int>].instructions is exempt from the VALUE scans', () => {
  // Each probe is a string that GENUINELY trips a VALUE scan (a probe that cannot fail is not a probe —
  // the `purpose` control below proves every one is really rejected elsewhere). The `\b`-anchored patterns
  // only fire when adjacent to word chars, so these are the verified-dangerous forms.
  const DANGEROUS: Array<{ value: string; code: SpecErrorCode }> = [
    { value: 'import x from "y"', code: 'no_code_in_yaml' },
    { value: 'x=>y', code: 'no_code_in_yaml' },
    { value: 'function foo', code: 'no_code_in_yaml' },
    { value: 'read the row like SELECT a FROM b', code: 'no_code_in_yaml' },
    { value: 'make exactly one llm call and stop', code: 'prompt_execution_claim' },
  ];

  it('CONTROL: every probe is genuinely dangerous — rejected in purpose (proves the probes CAN fail)', () => {
    for (const { value, code } of DANGEROUS) {
      parseRejectsAt(productDoc({ purpose: value }), code, 'extractors[0].purpose');
    }
  });

  it('accepts each dangerous VALUE pattern individually inside instructions (leaf-scoped exemption)', () => {
    for (const { value } of DANGEROUS) {
      parseOk(productDoc({ extractorExtra: `\n    instructions: ${JSON.stringify(value)}` }));
    }
  });

  it('accepts one inline instructions carrying MANY dangerous patterns at once', () => {
    parseOk(
      productDoc({
        extractorExtra:
          '\n    instructions: "import x; function f; make one llm call; SELECT a FROM b"',
      }),
    );
  });

  it('accepts a multi-line block-scalar inline prompt with code-like + prompt-execution phrasing', () => {
    parseOk(
      productDoc({
        extractorExtra: [
          '',
          '    instructions: |',
          '      You are an extraction assistant.',
          '      Do NOT import modules or run an llm call yourself.',
          '      Treat the record like a table you would SELECT columns FROM.',
        ].join('\n'),
      }),
    );
  });

  it('a system_prompt KEY inside an extractor is STILL rejected (KEY bans untouched)', () => {
    parseRejectsAt(
      productDoc({ extractorExtra: '\n    system_prompt: "You are a bot"' }),
      'no_code_in_yaml',
      'extractors[0].system_prompt',
    );
  });

  it('instructions_ref.file is STILL scanned (a filename, never free-form prompt text)', () => {
    // A code-like value in the pinned filename is caught — the exemption covers ONLY the instructions leaf.
    const res = parseProductSpec(
      productDoc({
        extractorExtra: `\n    instructions_ref:\n      file: "x=>y"\n      sha256: "${HEX64}"`,
      }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(
        res.errors.some(
          (e) => e.code === 'no_code_in_yaml' && e.path === 'extractors[0].instructions_ref.file',
        ),
      ).toBe(true);
    }
  });

  it('a benign inline instructions leaves the rest of the doc fully scanned (import in metadata rejected)', () => {
    // The exemption does not leak: an unrelated code-like value elsewhere still fails closed.
    const yaml = productDoc({
      extractorExtra: '\n    instructions: "extract the findings"',
    }).replace('  name: P\n', '  name: P\n  metadata:\n    onload: "require(\'./evil.js\')"\n');
    parseRejectsAt(yaml, 'no_code_in_yaml', 'product.metadata.onload');
  });
});
