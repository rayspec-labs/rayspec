/**
 * NATIVE-VS-DECLARED TOOL PRECEDENCE — proven structurally, with both refusal doors stepped around.
 *
 * `workforce-ids.ts` states the rationale for the reserved-name set as a fact about dispatch: a
 * declared tool carrying a native's name "would be silently shadowed by the native at dispatch
 * (natives win, always)". Two doors make the collision unreachable before it can matter — the spec
 * lint at parse (`packages/kernel/spec/src/workforce-lint.ts`) and `assertNoReservedCollisions` at
 * composition (`workforce-turn-handlers.ts`, called before the tools are handed to `runAgent`) —
 * and both are tested (`toolset-semantics.test.ts:381`/`:404`,
 * `workforce-parse.negative.test.ts:423`/`:434`).
 *
 * What was NOT true is the fallback those doors are written against. `makeDispatchTool` indexes its
 * tool list into `new Map(deps.tools.map(t => [t.spec.name, t]))` (packages/kernel/platform/src/
 * dispatch.ts) — a later entry OVERWRITES an earlier one — and the composition used to pass
 * `[...nativeTools, ...agentTools]`, which puts the DECLARED tool last. Had a collision ever
 * reached dispatch, the declared tool would have won and a `submit_result` would have been the
 * agent pack's function rather than the runtime's turn ending. The doors were the only barrier
 * rather than the second one.
 *
 * THIS SUITE PROVES THE FALLBACK, which by definition means running with the doors bypassed:
 *
 *   (a) the INSTRUMENT control — the real `makeDispatchTool` resolves a duplicate name to the LAST
 *       entry. Everything else here is a claim about ordering, and ordering only means anything
 *       because of this; if `dispatch.ts` ever switched to first-wins, this arm REDs and the
 *       composition's spread order would have to flip with it.
 *   (b) the DOOR control — `assertNoReservedCollisions` still throws on the very tool list the
 *       property arm then dispatches. Without it, "the doors were removed" would be an assumption
 *       about this file rather than an observed fact about the code it bypasses.
 *   (c) THE PROPERTY — the list `composeTurnTools` builds dispatches a reserved name to the NATIVE
 *       handler. Not a hand-written array: the same function the composition calls.
 *
 * The composition's own use of it is covered one layer up, against real Postgres, in
 * `workforce-turn-validation.db.test.ts` ("the composition offers the NATIVE tools last") — which is
 * what keeps `composeTurnTools` from being a correct helper nobody has to call.
 *
 * Pure: no database, no network, no secret. The journal is an in-memory stub because nothing here
 * asks anything of the journal — this file is about which handler runs, not about what is recorded.
 */
import type { JournalSink, NeutralTool, StepReport } from '@rayspec/core';
import { RESERVED_WORKFORCE_TOOL_NAMES } from '@rayspec/core';
import { makeDispatchTool } from '@rayspec/platform';
import { assertNoReservedCollisions } from '@rayspec/workforce-tools';
import { describe, expect, it } from 'vitest';
import { composeTurnTools } from './workforce-turn-handlers.js';

/** The reserved native this suite forges a collision on — a TURN-ENDING one, the worst case. */
const COLLIDING_NAME = 'submit_result';

/** A minimal journal: dispatch records one step per call and this suite never reads them back. */
const journal: JournalSink = {
  lookup: async () => null,
  lookupToolCache: async () => null,
  record: async (_step: StepReport & { authMode: string }) => 'step-1',
};

/** A neutral tool that reports WHICH side of the composition it came from when it runs. */
function markerTool(name: string, side: 'native' | 'declared'): NeutralTool {
  return {
    spec: { name, description: `${side} ${name}`, parameters: { type: 'object' } },
    handler: () => ({ side }),
    timeoutMs: 1_000,
    idempotent: true,
  };
}

/** Dispatch `name` through the REAL chokepoint over `tools`, and return the handler's `side`. */
async function dispatchSide(tools: NeutralTool[], name: string): Promise<string> {
  const dispatch = makeDispatchTool({
    runId: 'run-precedence',
    tenantId: '00000000-0000-4000-8000-0000000000f1',
    journal,
    tools,
    replay: false,
    authMode: 'api-key',
    markRunTainted: async () => {},
  });
  const result = await dispatch(name, {}, 'call-1');
  if (result.kind !== 'tool_data') throw new Error(`dispatch failed: ${result.message}`);
  return (result.data as { side: string }).side;
}

describe('native tools cannot be shadowed by a declared tool, even past both refusal doors', () => {
  it('INSTRUMENT: the dispatcher resolves a duplicate name to the LAST entry in its tool list', () => {
    // The mechanism the whole finding turns on, asserted directly rather than assumed: `new Map`
    // over [name, tool] pairs keeps the last pair for a repeated key. Whichever side of the
    // composition is spread LAST is therefore the side that wins a collision.
    const first = markerTool(COLLIDING_NAME, 'declared');
    const last = markerTool(COLLIDING_NAME, 'native');
    return expect(dispatchSide([first, last], COLLIDING_NAME)).resolves.toBe('native');
  });

  it('INSTRUMENT (the other direction): the FIRST entry loses — so spread order is the decision', () => {
    // Without this arm the one above would also pass against a dispatcher that always picked the
    // native-looking tool for some other reason. Same two tools, swapped: the last one wins again.
    const first = markerTool(COLLIDING_NAME, 'native');
    const last = markerTool(COLLIDING_NAME, 'declared');
    return expect(dispatchSide([first, last], COLLIDING_NAME)).resolves.toBe('declared');
  });

  it('DOOR: the composition still REFUSES the colliding tool list this suite then dispatches', () => {
    // The doors are not being weakened or removed — they are being stepped around, deliberately, so
    // the barrier BEHIND them can be measured. This arm is the evidence that they still stand on
    // exactly the input the property arm below feeds past them.
    const declared = markerTool(COLLIDING_NAME, 'declared');
    expect(() => assertNoReservedCollisions([declared])).toThrow(/submit_result/);
    // …and the name really is one of the runtime's own, read off the frozen set rather than assumed.
    expect(RESERVED_WORKFORCE_TOOL_NAMES.has(COLLIDING_NAME)).toBe(true);
  });

  it('PROPERTY: composeTurnTools dispatches a reserved name to the NATIVE handler', async () => {
    // The list the composition actually builds, with the refusal doors bypassed. Before the spread
    // order was corrected this resolved to `declared`: the agent pack's function would have stood in
    // for the runtime's turn ending, and only the doors had prevented it.
    const nativeTools = [markerTool(COLLIDING_NAME, 'native')];
    const agentTools = [markerTool(COLLIDING_NAME, 'declared')];
    await expect(
      dispatchSide(composeTurnTools(nativeTools, agentTools), COLLIDING_NAME),
    ).resolves.toBe('native');
  });

  it('PROPERTY: a declared tool that collides with NOTHING is still reachable', () => {
    // Precedence must not become suppression. A pack's own tools are why the seat has an agent at
    // all; the rule is that natives win a NAME COLLISION, not that declared tools stop dispatching.
    const nativeTools = [markerTool(COLLIDING_NAME, 'native')];
    const agentTools = [markerTool('lookup_ticket', 'declared')];
    const composed = composeTurnTools(nativeTools, agentTools);
    expect(composed.map((t) => t.spec.name).sort()).toEqual(['lookup_ticket', COLLIDING_NAME]);
    return expect(dispatchSide(composed, 'lookup_ticket')).resolves.toBe('declared');
  });

  it('PROPERTY: every native survives composition — nothing is dropped by the reordering', () => {
    // The spread was reversed, not filtered. Both sides are present in full and the natives are the
    // TAIL, which is the ordering the dispatcher's last-wins resolution reads.
    const nativeTools = ['submit_result', 'delegate_task', 'send_message'].map((n) =>
      markerTool(n, 'native'),
    );
    const agentTools = ['lookup_ticket', 'search_kb'].map((n) => markerTool(n, 'declared'));
    const names = composeTurnTools(nativeTools, agentTools).map((t) => t.spec.name);
    expect(names).toEqual([
      'lookup_ticket',
      'search_kb',
      'submit_result',
      'delegate_task',
      'send_message',
    ]);
  });
});
