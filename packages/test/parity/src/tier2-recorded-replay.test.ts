/**
 * TIER 2 — recorded-SDK replay CONTRACT tests for all THREE adapters.
 *
 * A RECORDED real SDK interaction (the committed parity fixtures, captured from LIVE runs of each REAL
 * adapter against its REAL SDK via scripts/capture-parity.mts) is replayed DETERMINISTICALLY (no live
 * call in CI) and asserted against the neutral RunResult / journal / conversation CONTRACT each adapter
 * must honor. Because the fixture IS the neutral output the adapter produced from the real SDK wire, a
 * real SDK change that alters that output breaks here once the fixture is re-recorded (the version-bump
 * rule forces the re-record; tier2 then catches the contract drift).
 *
 * Tier 2 pins the INBOUND derivation contract per adapter; Tier 1 pins the OUTBOUND wire; Tier 3 is the
 * cross-backend parity gate + the re-record rule. Together: an SDK bump becomes a CAUGHT break.
 *
 * NOTE: these assert the REAL recorded shape, not an imagined one — a fixture whose tool result is
 * NOT a dispatched opaque wrapper, or whose tool_call lacks a journal step, FAILS (the dispatch contract).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunResult, validateConversation } from '@rayspec/core';
import { describe, expect, it } from 'vitest';
import type { CapturedRun, ParityBackend, ParityFixture } from './index.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const BACKENDS: ParityBackend[] = ['openai', 'anthropic', 'pi', 'codex'];
const FILE: Record<ParityBackend, string> = {
  openai: 'openai-parity.json',
  anthropic: 'anthropic-parity.json',
  pi: 'pi-parity.json',
  codex: 'codex-parity.json',
};

function load(backend: ParityBackend): ParityFixture {
  return JSON.parse(readFileSync(join(fixturesDir, FILE[backend]), 'utf8')) as ParityFixture;
}
function runFor(fx: ParityFixture, scenario: string): CapturedRun {
  const r = fx.runs.find((x) => x.scenario === scenario);
  if (!r) throw new Error(`fixture missing scenario '${scenario}'`);
  return r;
}

const fixtures = Object.fromEntries(BACKENDS.map((b) => [b, load(b)])) as Record<
  ParityBackend,
  ParityFixture
>;

describe('Tier 2 — every recorded RunResult is a VALID neutral RunResult (real capture, schema-parsed)', () => {
  for (const backend of BACKENDS) {
    for (const run of fixtures[backend].runs) {
      it(`${backend}/${run.scenario}: the recorded RunResult parses against the neutral schema`, () => {
        // The recorded shape MUST parse against the AUTHORITATIVE neutral schema — proof the adapter
        // produced a real neutral RunResult from the SDK wire, not a hand-shaped object.
        expect(() => RunResult.parse(run.result)).not.toThrow();
        expect(run.result.backend).toBe(backend);
      });
    }
  }
});

describe('Tier 2 — the recorded transcript survives the read-path validator unchanged', () => {
  for (const backend of BACKENDS) {
    it(`${backend}: validateConversation drops NOTHING from the recorded multi-turn-tool transcript`, () => {
      const conv = runFor(fixtures[backend], 'multi-turn-tool').result.conversation;
      // A clean, real derivation round-trips with ZERO drops (every part is neutral-valid).
      expect(validateConversation(conv)).toEqual(conv);
    });
  }
});

describe('Tier 2 — recorded multi-turn-tool: the per-adapter neutral tool CONTRACT held (real SDK ids)', () => {
  for (const backend of BACKENDS) {
    it(`${backend}: tool_call/tool_result correlate by the SAME real SDK id; result is a DISPATCHED opaque wrapper; the call is journaled`, () => {
      const run = runFor(fixtures[backend], 'multi-turn-tool');
      const parts = run.result.conversation.flatMap((t) => t.parts);

      // Real per-step ledger (kill stepCount=1) — the recorded run made >1 step.
      expect(run.result.stepCount).toBeGreaterThan(1);

      // At least one dispatched opaque tool_data result (the bridge worked through ctx.dispatchTool).
      const dataResults = parts.filter(
        (p) =>
          p.kind === 'tool_result' &&
          typeof p.result === 'object' &&
          p.result !== null &&
          (p.result as { kind?: string }).kind === 'tool_data',
      );
      expect(dataResults.length).toBeGreaterThanOrEqual(1);

      // EVERY tool_result is a DISPATCHED opaque outcome (tool_data | tool_error) — never a raw
      // un-wrapped SDK result; EVERY tool_call has a journaled tool step keyed by the SAME real id.
      const journaledToolIds = new Set(
        run.journal.filter((s) => s.type === 'tool').map((s) => s.idempotencyKey),
      );
      for (const p of parts) {
        if (p.kind === 'tool_result') {
          const kind = (p.result as { kind?: string } | null)?.kind;
          expect(['tool_data', 'tool_error']).toContain(kind);
        }
        if (p.kind === 'tool_call') {
          // The call's real SDK id JOINS a journaled tool step (the dispatch chokepoint fired).
          expect(journaledToolIds.has(p.toolCallId)).toBe(true);
          // ...and its result pairs up on the SAME id.
          const result = parts.find(
            (q) => q.kind === 'tool_result' && q.toolCallId === p.toolCallId,
          );
          expect(result?.kind).toBe('tool_result');
        }
      }

      // The dispatcher is the single tool-event authority: #tool_called == #journaled tool steps.
      const toolCalled = run.events.filter((e) => e.type === 'tool_called').length;
      expect(toolCalled).toBe(journaledToolIds.size);
    });
  }
});

describe('Tier 2 — recorded error scenario: the uniform fail-closed neutral shape held', () => {
  for (const backend of BACKENDS) {
    it(`${backend}: status='error', error:string, output:null, conversation:[]`, () => {
      const r = runFor(fixtures[backend], 'error').result;
      expect(r.status).toBe('error');
      expect(typeof r.error).toBe('string');
      expect(r.output).toBeNull();
      expect(r.conversation).toEqual([]);
    });
  }
});

describe('Tier 2 — recorded structured-output: native (openai/anthropic) vs emulated (pi) yield the SAME shape', () => {
  for (const backend of BACKENDS) {
    it(`${backend}: output is a non-null object with the schema fields (no LCD-collapse)`, () => {
      const r = runFor(fixtures[backend], 'structured-output').result;
      expect(r.status).toBe('completed');
      expect(typeof r.output).toBe('object');
      expect(r.output).not.toBeNull();
      const out = r.output as Record<string, unknown>;
      expect(typeof out.city).toBe('string');
      expect(typeof out.condition).toBe('string');
    });
  }
});
