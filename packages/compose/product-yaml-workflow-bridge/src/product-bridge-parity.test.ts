/**
 * PARSER ↔ BRIDGE neutrality PARITY cross-check (finding GR-1 anti-drift guard).
 *
 * The Product-YAML parser (`@rayspec/spec` `parseProductSpec` → `scanProductGuardrails`) and THIS bridge
 * (`validateProductYamlWorkflowBridgeInput` → `walkWorkflowDeclarations`) each enforce a neutrality walk
 * over the executable `workflows`/`extractors` graph. They live in two packages with DUPLICATED rule tables,
 * so they can DRIFT — the S7-2 validate/compile hazard GR-1 caught: a doc whose graph carried e.g. an
 * `llm call` string PASSED `parseProductSpec` but the bridge THREW on it.
 *
 * This test is the anti-drift forcing function. It does NOT byte-compare the two private rule tables
 * (representation could differ while behavior agrees, or vice versa); it asserts the load-bearing
 * INVARIANT behaviorally, FAIL-THE-FIX (lesson):
 *   • VALUE probes inject the dangerous string into a valid free-text graph field (`extractors[].purpose`) of
 *     an OTHERWISE-VALID doc (asserted clean by `PARSER_BASE parses ok`). For THREE of them (provider
 *     NAME, production-execution claim, prompt/LLM-execution claim) the GRAPH guardrail is the SOLE reason
 *     the parser rejects — remove it and the probe flips to `ok:true`. The FOURTH (product-owned handler
 *     PATH `packs/x/handlers/y.ts`) is DOUBLE-COVERED: the global `CODE_LIKE_VALUE` scan ALSO matches its
 *     `handlers/`/`.ts` fragments, so it is NOT a single-rule isolation of the graph path check — it still
 *     proves parity (both sides reject), just not via one sole-cause graph rule.
 *   • The bridge side is inherently isolated: `validateProductYamlWorkflowBridgeInput` runs ONLY the
 *     neutrality walk, so it throws IFF the walk finds the dangerous element.
 * For each probe: the parser rejects (`ok:false`) AND the bridge rejects (throws). The dangerous drift
 * direction (parser LOOSER than the bridge) is exactly what this locks. The representative probes touch
 * only a few keys; the exhaustive KEY-SET table cross-check (last test) locks the full superset invariant.
 *
 * SINCE S1 this file ALSO pins the trigger-event normalization SINGLE SOURCE: the
 * bridge's `compileTriggerEvent` must BE `@rayspec/spec`'s `normalizeProductTriggerEvent` (identity),
 * and the audio alias + the default join must behave identically through the FULL parser and the FULL
 * bridge compile (behavior) — a re-introduced local copy or a divergence fails here.
 */
import {
  GLOBAL_CODE_KEYS,
  GLOBAL_PROVIDER_BLOB_KEYS,
  GRAPH_PROMPT_KEYS,
  GRAPH_PROVIDER_POLICY_KEYS,
  normalizeProductTriggerEvent,
  parseProductSpec,
} from '@rayspec/spec';
import { describe, expect, it } from 'vitest';
import {
  compileProductYamlWorkflow,
  compileTriggerEvent,
  handlerKeys,
  promptExecutionKeys,
  providerNativeKeys,
  validateProductYamlWorkflowBridgeInput,
} from './compiler.js';
import { type ProductYamlBridgeInput, ProductYamlWorkflowBridgeError } from './types.js';

/**
 * An OTHERWISE-VALID Product-YAML doc: one capability, one agent (declared extraction), one workflow. The
 * only variation points are `purpose` (a free-text graph field, NOT ref-checked), a stray step key, and a
 * stray agent key. With no injection it parses `ok:true` (asserted below) — so any single injection is the
 * SOLE defect.
 */
function parserDoc(
  opts: { purpose?: string; stepExtra?: string; agentExtra?: string } = {},
): string {
  const purpose = opts.purpose ?? 'extract things';
  const agentExtra = opts.agentExtra ? `\n    ${opts.agentExtra}` : '';
  const stepExtra = opts.stepExtra ? `\n        ${opts.stepExtra}` : '';
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
    purpose: ${JSON.stringify(purpose)}${agentExtra}
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
        use: cap.op${stepExtra}
`;
}

/** A benign bridge workflow (the neutrality walk finds nothing dangerous in it). */
const BENIGN_WORKFLOW = {
  id: 'wf',
  trigger: { capability: 'cap', event: 'ready' },
  steps: [{ id: 's', type: 'capability', use: 'cap.op' }],
};

interface Probe {
  readonly name: string;
  readonly parserDoc: string;
  readonly bridgeInput: ProductYamlBridgeInput;
}

/** A dangerous VALUE in the graph, injected into `extractors[].purpose` on BOTH sides (true isolation). */
function valueProbe(name: string, value: string): Probe {
  return {
    name,
    parserDoc: parserDoc({ purpose: value }),
    bridgeInput: {
      workflows: [BENIGN_WORKFLOW],
      extractors: [{ id: 'ex', purpose: value }],
    },
  };
}

const PROBES: Probe[] = [
  // KEY probes — a banned key in the graph (parser rejects via guardrail OR strict-Zod backstop; the
  // bridge rejects via its walk). Keys can never be silently accepted, so no isolation claim is needed.
  {
    name: 'handler/module path KEY in a step',
    parserDoc: parserDoc({ stepExtra: 'module_path: packs/x/handler' }),
    bridgeInput: {
      workflows: [
        {
          ...BENIGN_WORKFLOW,
          steps: [{ ...BENIGN_WORKFLOW.steps[0], module_path: 'packs/x/handler' }],
        },
      ],
    },
  },
  {
    name: 'provider/model policy KEY in a step',
    parserDoc: parserDoc({ stepExtra: 'model: gpt-5' }),
    bridgeInput: {
      workflows: [{ ...BENIGN_WORKFLOW, steps: [{ ...BENIGN_WORKFLOW.steps[0], model: 'gpt-5' }] }],
    },
  },
  {
    name: 'provider-native wire-blob KEY in a step',
    parserDoc: parserDoc({ stepExtra: 'native_payload: { raw: true }' }),
    bridgeInput: {
      workflows: [
        {
          ...BENIGN_WORKFLOW,
          steps: [{ ...BENIGN_WORKFLOW.steps[0], native_payload: { raw: true } }],
        },
      ],
    },
  },
  {
    name: 'prompt KEY in an extractor',
    parserDoc: parserDoc({ agentExtra: 'system_prompt: "You are a bot"' }),
    bridgeInput: {
      workflows: [BENIGN_WORKFLOW],
      extractors: [
        { id: 'ex', purpose: 'x', system_prompt: 'You are a bot' } as Record<string, unknown>,
      ],
    },
  },
  // VALUE probes — a dangerous VALUE in a valid free-text field. The next three are ISOLATED fail-the-fix
  // cases (the graph guardrail is the SOLE rejection reason; removing it flips the parser to ok:true).
  // This first one is DOUBLE-COVERED: the global `CODE_LIKE_VALUE` scan also matches `handlers/`/`.ts`, so
  // it proves parity but is not a single-rule isolation of the graph path check (see the header).
  valueProbe('product-owned handler PATH as a VALUE', 'packs/x/handlers/y.ts'),
  valueProbe('provider NAME as a VALUE', 'deepgram'),
  valueProbe('production-execution claim as a VALUE (GR-1 gap)', 'production_ready'),
  valueProbe('prompt/LLM-execution claim as a VALUE (GR-1 gap)', 'llm call'),
];

describe('parser ↔ bridge neutrality parity (GR-1 anti-drift)', () => {
  it('PARSER_BASE (no injection) parses ok — so any injection is the SOLE defect', () => {
    const res = parseProductSpec(parserDoc());
    if (!res.ok) throw new Error(`base must parse:\n${JSON.stringify(res.errors, null, 2)}`);
    expect(res.ok).toBe(true);
    // Sanity: the benign bridge input is accepted (walk finds nothing) — isolates the bridge side too.
    expect(() =>
      validateProductYamlWorkflowBridgeInput({
        workflows: [BENIGN_WORKFLOW],
        extractors: [{ id: 'ex', purpose: 'ok' }],
      }),
    ).not.toThrow();
  });

  for (const probe of PROBES) {
    it(`both REJECT: ${probe.name}`, () => {
      expect(parseProductSpec(probe.parserDoc).ok).toBe(false);

      let bridgeThrew: unknown;
      try {
        validateProductYamlWorkflowBridgeInput(probe.bridgeInput);
      } catch (e) {
        bridgeThrew = e;
      }
      expect(bridgeThrew).toBeInstanceOf(ProductYamlWorkflowBridgeError);
    });
  }

  it('the two GR-1 execution-claim codes match the bridge code NAMES exactly', () => {
    // "the same code the bridge family uses" (GR-1): the parser emits `production_execution_claim` /
    // `prompt_execution_claim` — byte-identical to the bridge's `ProductYamlWorkflowBridgeErrorCode`s.
    const prod = parseProductSpec(parserDoc({ purpose: 'production_ready' }));
    const prompt = parseProductSpec(parserDoc({ purpose: 'llm call' }));
    if (prod.ok || prompt.ok) throw new Error('expected both to reject');
    expect(prod.errors.map((e) => e.code)).toContain('production_execution_claim');
    expect(prompt.errors.map((e) => e.code)).toContain('prompt_execution_claim');
  });

  it('trigger-event normalization is the ONE spec function — identity, not a re-synced copy', () => {
    // The bridge's `compileTriggerEvent` must BE `@rayspec/spec`'s `normalizeProductTriggerEvent`
    // (the same function object). Re-introducing a local copy in compiler.ts either collides with
    // this binding at compile time or breaks this identity pin — the KEEP-IN-SYNC era is over.
    expect(compileTriggerEvent).toBe(normalizeProductTriggerEvent);
  });

  it('the audio alias behaves identically through the FULL parser AND the FULL bridge compile', () => {
    // Parser side: `trigger: { capability: audio_input, event: session_finalized }` resolves ONLY via
    // the alias — the capability declares the CANONICAL id (`audio_input.finalized_session`), never
    // the raw `${capability}.${event}` join. A parser-side alias drop flips this to a dangling_ref.
    const res = parseProductSpec(`version: "1.0"
product:
  id: p
  name: P
capabilities:
  - id: audio_input
    tier: B
    status: reserved
    contracts: [audio_input.finalized_session]
contracts:
  audio_input.finalized_session: { type: object }
workflows:
  - id: wf
    trigger: { capability: audio_input, event: session_finalized }
    steps:
      - id: s
        type: capability
        use: audio_input.op
`);
    if (!res.ok) throw new Error(`alias doc must parse:\n${JSON.stringify(res.errors, null, 2)}`);
    expect(res.ok).toBe(true);

    // Bridge side: the SAME trigger compiles onto the canonical id, validated against an inventory
    // that (like the deploy composition) contains ONLY canonical ids. A bridge-side alias drop makes
    // this throw `unknown_trigger_event` ('audio_input.session_finalized' is not in the inventory).
    const spec = compileProductYamlWorkflow(
      {
        workflows: [
          {
            id: 'wf',
            trigger: { capability: 'audio_input', event: 'session_finalized' },
            steps: [{ id: 's', type: 'capability', use: 'cap.op' }],
          },
        ],
      },
      {
        capabilityInventory: {
          operations: new Set(['cap.op']),
          contracts: new Set(),
          events: new Set(['audio_input.finalized_session']),
        },
      },
    );
    expect(spec.trigger.event).toBe('audio_input.finalized_session');
  });

  it('a non-aliased pair joins identically on both sides — <capability>.<event>', () => {
    // Parser side: PARSER_BASE (trigger { cap, ready } against declared contract 'cap.ready')
    // already proves the default join — re-asserted here so THIS test names the invariant.
    expect(parseProductSpec(parserDoc()).ok).toBe(true);
    // Bridge side: the same default join through the full compile.
    const spec = compileProductYamlWorkflow(
      { workflows: [BENIGN_WORKFLOW] },
      {
        capabilityInventory: {
          operations: new Set(['cap.op']),
          contracts: new Set(),
          events: new Set(['cap.ready']),
        },
      },
    );
    expect(spec.trigger.event).toBe('cap.ready');
  });

  it('parser banned-KEY sets are a SUPERSET of the bridge banned-KEY sets (exhaustive KEY-SET cross-check)', () => {
    // The representative KEY probes above touch only a handful of keys. This is the exhaustive table check:
    // EVERY key the bridge's neutrality walk bans in the graph (handler ∪ prompt ∪ provider-native) MUST
    // also be banned by the parser IN THE GRAPH. In the graph the parser's effective ban is the UNION of
    // its GLOBAL key sets (which scan the whole doc, incl. workflows/extractors) and its GRAPH-only sets. A
    // future bridge-ONLY key addition — the exact drift a representative probe would miss — fails here,
    // enumerated by name.
    const parserGraphBanned = new Set<string>([
      ...GLOBAL_CODE_KEYS,
      ...GLOBAL_PROVIDER_BLOB_KEYS,
      ...GRAPH_PROVIDER_POLICY_KEYS,
      ...GRAPH_PROMPT_KEYS,
    ]);
    const bridgeBanned = [...handlerKeys, ...promptExecutionKeys, ...providerNativeKeys];
    const missingFromParser = bridgeBanned.filter((key) => !parserGraphBanned.has(key)).sort();
    expect(missingFromParser).toEqual([]);
  });
});
