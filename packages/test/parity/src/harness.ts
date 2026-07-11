/**
 * Live-run harness for the parity capture + smoke tests.
 *
 * Runs a REAL adapter `run()` with an IN-MEMORY journal and a RunContext wired EXACTLY as run-core
 * does (the single per-run seq authority + the central dispatchTool + resolved authMode), so the
 * captured RunResult/journal/events are the genuine neutral output — not a hand-built shape. No DB.
 */
import type {
  AuthMode,
  Backend,
  EventSink,
  JournalSink,
  NeutralEvent,
  NeutralEventInput,
  NeutralTool,
  RunContext,
  RunResult,
  StepReport,
} from '@rayspec/core';
import { assertRunResultKeyPresence, assertSpecValid } from '@rayspec/core';
import { makeDispatchTool } from '@rayspec/platform';
import type { CapturedRun } from './index.js';
import type { Scenario } from './scenarios.js';

/** An in-memory JournalSink mirroring the real per-step sink (no DB, no replay seeding). */
class MemJournal implements JournalSink {
  records: (StepReport & { authMode: AuthMode })[] = [];
  async lookup(): Promise<{ output: unknown } | null> {
    return null; // capture is always a fresh live run (never replay)
  }
  async lookupToolCache(): Promise<{ output: unknown } | null> {
    return null;
  }
  async record(step: StepReport & { authMode: AuthMode }): Promise<string> {
    this.records.push(step);
    return `step-${this.records.length}`;
  }
}

/**
 * Run a backend live against a scenario and capture the neutral RunResult + journal + event stream.
 * Wires the RunContext like run-core: single seq authority (stampSeq), central dispatchTool, the
 * resolved authMode threaded onto ctx. Returns a CapturedRun (serializable for a fixture).
 *
 * Mirrors the run-core GUARDS exactly — assertSpecValid(spec, backend.id, opts) BEFORE
 * backend.run (the fail-closed capability gate) and assertRunResultKeyPresence(result) AFTER (the
 * always-present-key contract). `requireNativeStructuredOutput` is DEFAULT-OFF here, so the
 * structured-output scenario's Pi EMULATED path is allowed — matching how run-core would gate it.
 */
export async function captureRun(
  backend: Backend,
  scenario: Scenario,
  opts: { requireNativeStructuredOutput?: boolean } = {},
): Promise<CapturedRun> {
  const journal = new MemJournal();
  const events: NeutralEvent[] = [];
  const runId = `parity-${backend.id}-${scenario.name}`;
  const tenantId = 'parity-tenant';

  // The SINGLE per-run seq authority (mirrors run-core stampSeq): re-stamp every event with a
  // contiguous monotonic seq. The converted adapters + the dispatcher emit seq-less; this wrapper is
  // what proves the single authority holds across all three backends. It accepts a seq-less input OR
  // a fully-formed event and ALWAYS overwrites the seq with the run counter (exactly run-core).
  let seqCounter = 0;
  const stampSeq = (e: NeutralEventInput | NeutralEvent): NeutralEvent =>
    ({ ...e, seq: seqCounter++ }) as NeutralEvent;
  const wrappedOnEvent = (e: NeutralEventInput | NeutralEvent): void => {
    events.push(stampSeq(e));
  };
  const onEvent = wrappedOnEvent as EventSink;

  // The run-core fail-closed capability gate runs BEFORE any model call (the error scenario uses
  // a bad MODEL id, not a capability the backend lacks, so this passes and the run fails downstream).
  assertSpecValid(scenario.spec, backend.id, {
    requireNativeStructuredOutput: opts.requireNativeStructuredOutput,
  });

  const authMode: AuthMode = await backend.resolveAuth();
  const tools: NeutralTool[] = scenario.tools ?? [];
  const dispatchTool =
    tools.length > 0
      ? makeDispatchTool({
          runId,
          tenantId,
          journal,
          tools,
          replay: false,
          authMode,
          onEvent: wrappedOnEvent,
        })
      : undefined;

  const ctx: RunContext = {
    runId,
    tenantId,
    onEvent,
    journal,
    replay: false,
    authMode,
    tools,
    dispatchTool,
  };

  const result: RunResult = await backend.run(scenario.spec, ctx);

  // The run-core key-presence contract — output + error are ALWAYS present (throws loudly otherwise).
  assertRunResultKeyPresence(result);

  return {
    scenario: scenario.name,
    backend: backend.id,
    result,
    journal: journal.records.map((s) => ({
      type: s.type,
      status: s.status,
      idempotencyKey: s.idempotencyKey,
    })),
    events: events.map((e) => ({ type: e.type, seq: e.seq })),
  };
}
