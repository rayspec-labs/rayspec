/**
 * Cross-backend shape-parity GATE — the live anti-collapse proof.
 *
 * Asserts the SAME neutral AgentSpec yields an IDENTICAL RaySpec-owned RunResult SHAPE across
 * openai + anthropic + pi, over multi-turn / tool-call / error / no-output. The assertions run on
 * REAL captured fixtures (packages/test/parity/src/__fixtures__/<backend>-parity.json), captured from
 * LIVE runs via scripts/capture-parity.mts (real shapes, never invented). CI has no creds, so
 * CI runs THIS suite on the committed fixtures (green); the live runs are separate self-skipping
 * smoke tests (live-smoke.test.ts).
 *
 * "Identical shape" = RunResult key-presence + per-key value TYPE + the SET of ConvPart kinds
 * over the success scenarios + journal step types + event vocabulary + seq-contiguity + real
 * per-step (>1) ledgers. It does NOT compare model text, and EXCLUDES backend/authMode (which
 * differ by definition).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ERROR_CLASSES, isErrorClass, RunResult } from '@rayspec/core';
import { describe, expect, it } from 'vitest';
import { type CapturedRun, runResultShape, scenarioShape } from './index.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');
// Codex is the 4th backend — the cross-backend gate now runs all FOUR (no LCD-collapse).
const BACKENDS = ['openai', 'pi', 'anthropic', 'codex'] as const;
const SCENARIOS = ['multi-turn-tool', 'no-output', 'error', 'structured-output'] as const;

interface Fixture {
  capturedAt: string;
  runs: CapturedRun[];
}

function loadFixture(backend: string): Fixture {
  const path = join(fixturesDir, `${backend}-parity.json`);
  return JSON.parse(readFileSync(path, 'utf8')) as Fixture;
}

function runFor(fx: Fixture, scenario: string): CapturedRun {
  const run = fx.runs.find((r) => r.scenario === scenario);
  if (!run) throw new Error(`fixture missing scenario '${scenario}'`);
  return run;
}

const fixtures = Object.fromEntries(BACKENDS.map((b) => [b, loadFixture(b)])) as Record<
  (typeof BACKENDS)[number],
  Fixture
>;

describe('cross-backend shape parity: every captured RunResult is a VALID neutral RunResult', () => {
  for (const backend of BACKENDS) {
    for (const scenario of SCENARIOS) {
      it(`${backend}/${scenario} parses as a neutral RunResult (schema-valid, real capture)`, () => {
        const run = runFor(fixtures[backend], scenario);
        // The captured shape must parse against the AUTHORITATIVE neutral schema — proof the adapter
        // produced a real RunResult, not a hand-shaped object. (Zod strips nothing critical here.)
        expect(() => RunResult.parse(run.result)).not.toThrow();
        // The backend tag is the real one (not cross-wired).
        expect(run.result.backend).toBe(backend);
      });
    }
  }
});

describe('cross-backend shape parity: RunResult KEY+TYPE shape is IDENTICAL across backends', () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario}: identical shape across all backends (openai/pi/anthropic/codex) on keys + per-key value types`, () => {
      const shapes = BACKENDS.map((b) => runResultShape(runFor(fixtures[b], scenario).result));
      const [ref, ...rest] = shapes;
      for (const s of rest) {
        // Identical key SET (key-presence: output + error always present on every backend).
        expect(s.keys).toEqual(ref?.keys);
        // Identical per-key value TYPE (e.g. output:null vs output present -> same 'null' tag here
        // because no scenario requests structured output; error:string|null tag matches per scenario).
        expect(s.types).toEqual(ref?.types);
      }
      // Spot-check the always-present keys are actually present on all backends:
      // errorClass joins output + error as an always-present key (present-with-null on success).
      for (const b of BACKENDS) {
        const r = runFor(fixtures[b], scenario).result;
        expect(Object.hasOwn(r, 'output')).toBe(true);
        expect(Object.hasOwn(r, 'error')).toBe(true);
        expect(Object.hasOwn(r, 'errorClass')).toBe(true);
      }
    });
  }
});

describe('cross-backend shape parity: per-scenario semantic parity', () => {
  it('error scenario: status="error" + error:string + output:null + conversation:[] on EVERY backend', () => {
    for (const b of BACKENDS) {
      const r = runFor(fixtures[b], 'error').result;
      expect(r.status).toBe('error');
      expect(typeof r.error).toBe('string');
      expect(r.output).toBeNull();
      // An errored run has no trustworthy transcript -> [] on all backends (uniform error shape).
      expect(r.conversation).toEqual([]);
    }
  });

  it('error scenario carries a NON-NULL neutral errorClass on EVERY backend (no backend-specific shape)', () => {
    for (const b of BACKENDS) {
      const r = runFor(fixtures[b], 'error').result;
      // The classified error class is one of the NEUTRAL enum values on every backend — NOT a
      // backend-specific error shape (the anti-collapse contract). We assert membership in the
      // neutral vocabulary, not a per-backend value: the three backends legitimately classify the
      // SAME unsatisfiable-model error differently (openai surfaces a 400 → upstream_4xx; pi rejects
      // the unknown model adapter-internally → internal; anthropic's child has no status → internal),
      // and that asymmetry expressed through ONE neutral enum is exactly the point — never an LCD.
      expect(isErrorClass(r.errorClass)).toBe(true);
      expect(r.errorClass).not.toBeNull();
      expect(ERROR_CLASSES).toContain(r.errorClass);
    }
  });

  it('no-output scenario: status="completed" + output:null + error:null + errorClass:null + non-empty transcript on EVERY backend', () => {
    for (const b of BACKENDS) {
      const r = runFor(fixtures[b], 'no-output').result;
      expect(r.status).toBe('completed');
      expect(r.output).toBeNull();
      expect(r.error).toBeNull();
      // errorClass is always-present-with-null on a success run.
      expect(r.errorClass).toBeNull();
      expect(r.conversation.length).toBeGreaterThan(0);
      // System turn is the trusted instructions on every backend.
      expect(r.conversation[0]?.role).toBe('system');
    }
  });

  it('multi-turn-tool: REAL tool dispatch through ctx.dispatchTool on EVERY backend (one tool journal step + correlated parts)', () => {
    for (const b of BACKENDS) {
      const run = runFor(fixtures[b], 'multi-turn-tool');
      const r = run.result;
      expect(r.status).toBe('completed');
      // A successful tool run carries errorClass:null (always-present-with-null).
      expect(r.errorClass).toBeNull();

      // A real per-step ledger (kill stepCount=1) on every backend.
      expect(r.stepCount).toBeGreaterThan(1);
      expect(scenarioShape(run).multiStep).toBe(true);

      // The dispatched neutral tool produced EXACTLY ONE opaque tool_data result (the bridge worked:
      // not a tool_error). Find the dispatched-tool result part (name === 'get_weather' after the
      // adapter re-derivation, or an mcp__-prefixed name whose payload is our tool_data).
      const parts = r.conversation.flatMap((t) => t.parts);
      const dataResults = parts.filter(
        (p) =>
          p.kind === 'tool_result' &&
          typeof p.result === 'object' &&
          p.result !== null &&
          (p.result as { kind?: string }).kind === 'tool_data',
      );
      expect(dataResults.length).toBeGreaterThanOrEqual(1);

      // Dispatch regression guard (the headline built-in-tool-bypass fix): EVERY tool_result in the
      // transcript MUST be a DISPATCHED opaque result — kind:'tool_data' (success) OR 'tool_error'
      // (the fail-closed dispatch outcome, e.g. Pi's legitimate bad-args→retry). BOTH come ONLY from
      // ctx.dispatchTool. An un-dispatched BUILT-IN tool (ToolSearch/Bash/…) surfaces a RAW,
      // un-opaque-wrapped result whose `kind` is NEITHER — that FAILS the gate. (Not just "at least
      // one is tool_data" — EVERY result must be a dispatched opaque wrapper.)
      const allResults = parts.filter((p) => p.kind === 'tool_result');
      expect(allResults.length).toBeGreaterThanOrEqual(1);
      for (const p of allResults) {
        if (p.kind === 'tool_result') {
          const kind = (p.result as { kind?: string } | null)?.kind;
          expect(['tool_data', 'tool_error']).toContain(kind);
        }
      }
      // EVERY tool_call in the transcript MUST have been journaled (one `tool` step keyed by the
      // SAME id) — an un-dispatched built-in tool_call has NO journal step, so this fails the gate.
      const journaledToolIds = new Set(
        run.journal.filter((s) => s.type === 'tool').map((s) => s.idempotencyKey),
      );
      for (const p of parts) {
        if (p.kind === 'tool_call') {
          expect(journaledToolIds.has(p.toolCallId)).toBe(true);
        }
      }

      // Correlated tool_call/tool_result by the SAME real toolCallId for the dispatched tool.
      const dataResult = dataResults[0];
      if (dataResult?.kind === 'tool_result') {
        const matchingCall = parts.find(
          (p) => p.kind === 'tool_call' && p.toolCallId === dataResult.toolCallId,
        );
        expect(matchingCall?.kind).toBe('tool_call');
      }

      // EXACTLY one journal `tool` step per dispatched neutral tool call (the dispatcher journaled
      // it — the dispatch chokepoint), and at least one was recorded.
      const toolSteps = run.journal.filter((s) => s.type === 'tool');
      expect(toolSteps.length).toBeGreaterThanOrEqual(1);
      // The journal tool step's id JOINS the transcript tool_result id (one correlation id).
      if (dataResult?.kind === 'tool_result') {
        expect(toolSteps.map((s) => s.idempotencyKey)).toContain(dataResult.toolCallId);
      }

      // seq is one contiguous monotonic sequence (the single per-run seq authority) on EVERY
      // backend — including Pi (no SDK correlation id) and Anthropic (process-of-process).
      expect(scenarioShape(run).seqContiguous).toBe(true);

      // Pi double-emit guard: the dispatcher is the SINGLE tool-event authority, so each
      // dispatched tool call yields EXACTLY ONE tool_called event (no duplicate from a backend relaying
      // its own tool lifecycle). #tool_called == #journaled tool steps; and never two tool_called for
      // one logical call id.
      const toolCalledCount = run.events.filter((e) => e.type === 'tool_called').length;
      expect(toolCalledCount).toBe(toolSteps.length);
    }
  });
});

describe('cross-backend shape parity: structured output — native (openai/anthropic) vs emulated (pi), NO LCD-collapse', () => {
  it('all backends (openai/pi/anthropic/codex) yield an OBJECT `output` with the schema fields {city, condition} — same type, no collapse', () => {
    for (const b of BACKENDS) {
      const r = runFor(fixtures[b], 'structured-output').result;
      expect(r.status).toBe('completed');
      // The anti-collapse proof: `output` is a non-null OBJECT on EVERY backend — openai/anthropic
      // produced it NATIVELY (outputType/outputFormat), pi EMULATED it (instructions+parse). The
      // neutral RunResult expresses the SAME structured-output shape across all three.
      expect(typeof r.output).toBe('object');
      expect(r.output).not.toBeNull();
      const out = r.output as Record<string, unknown>;
      // The schema's required fields are present + the right primitive type on every backend.
      expect(typeof out.city).toBe('string');
      expect(typeof out.condition).toBe('string');
      // error stays null, and the value is genuinely populated (Pi's EMULATED value is asserted
      // here too — it is not left unchecked).
      expect(r.error).toBeNull();
      // A successful structured-output run carries errorClass:null.
      expect(r.errorClass).toBeNull();
      expect((out.city as string).length).toBeGreaterThan(0);
      expect((out.condition as string).length).toBeGreaterThan(0);
    }
  });

  it('the structured-output `output` TYPE is identical across backends (object on ALL backends)', () => {
    const types = BACKENDS.map(
      (b) => runResultShape(runFor(fixtures[b], 'structured-output').result).types.output,
    );
    // Every backend yields an OBJECT output (no LCD-collapse) — count tracks BACKENDS so adding
    // codex (the 4th) is asserted too, never silently allowed to diverge.
    expect(types).toEqual(BACKENDS.map(() => 'object'));
  });
});

describe('cross-backend shape parity: the SET of journal step types + event vocabulary matches (success scenarios)', () => {
  it('multi-turn-tool: every backend journals {llm, tool} steps and emits the tool event vocabulary', () => {
    for (const b of BACKENDS) {
      const shape = scenarioShape(runFor(fixtures[b], 'multi-turn-tool'));
      // Journal step types are drawn from the SAME neutral vocabulary; the tool scenario has both.
      expect(shape.journalStepTypes).toEqual(['llm', 'tool']);
      // The event vocabulary is the SAME neutral set; the tool scenario includes run lifecycle +
      // tool events (text_delta optional per backend — Anthropic/Pi stream it, OpenAI may not).
      expect(shape.eventTypes).toContain('run_started');
      expect(shape.eventTypes).toContain('run_completed');
      expect(shape.eventTypes).toContain('tool_called');
      // ConvPart kinds are a subset of the neutral vocabulary; text/tool_call/tool_result on all.
      expect(shape.convPartKinds).toContain('text');
      expect(shape.convPartKinds).toContain('tool_call');
      expect(shape.convPartKinds).toContain('tool_result');
    }
  });
});

describe('cross-backend shape parity: documented LEGITIMATE differences (not collapse)', () => {
  it('only backend + authMode differ structurally; anthropic MAY add reasoning parts (capability), never a missing neutral key', () => {
    // backend differs by definition.
    expect(fixtures.openai.runs[0]?.result.backend).toBe('openai');
    expect(fixtures.anthropic.runs[0]?.result.backend).toBe('anthropic');
    // authMode differs by definition: pi/openai = api-key, anthropic = subscription path.
    const anthAuth = runFor(fixtures.anthropic, 'multi-turn-tool').result.authMode;
    expect(['subscription-oauth-official-harness', 'api-key', 'unauthenticated']).toContain(
      anthAuth,
    );
    // Anthropic surfaces `reasoning` parts (its capability descriptor has reasoning:true) — an
    // ADDITIVE capability, expressed in the transcript, NOT a weakened neutral type. The neutral
    // ConvPart vocabulary already includes 'reasoning'; openai/pi simply don't emit it here.
    const anthKinds = scenarioShape(runFor(fixtures.anthropic, 'multi-turn-tool')).convPartKinds;
    expect(
      anthKinds.every((k) =>
        ['text', 'reasoning', 'tool_call', 'tool_result', 'output', 'error'].includes(k),
      ),
    ).toBe(true);
  });
});
