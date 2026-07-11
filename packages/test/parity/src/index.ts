/**
 * Cross-backend shape-parity — the anti-collapse proof surface.
 *
 * The exit-gate claim is: the SAME neutral AgentSpec produces an IDENTICAL RaySpec-owned RunResult
 * SHAPE across backends (openai, anthropic, pi), over multi-turn / tool-call / error / no-output.
 * "Identical shape" = the structural KEYS + their value TYPES + the set of ConvPart kinds + the
 * event-type vocabulary + the journal step types — NOT the model's text content (which legitimately
 * differs) and NOT `backend`/`authMode` (which differ BY DEFINITION).
 *
 * This module is the single source of truth for HOW shape is extracted, so the deterministic
 * fixture suite and the live smoke tests compare the EXACT same projection.
 */
import type { ConvTurn, JournalStep, NeutralEvent, RunResult, StepReport } from '@rayspec/core';

/** The backends a fixture stamps a recorded SDK version for. (+ codex — the 4th backend.) */
export type ParityBackend = 'openai' | 'anthropic' | 'pi' | 'codex';

/**
 * A committed parity fixture: the recorded runs PLUS the pinned SDK version they were captured
 * against. `sdkVersion` is THIS fixture's backend's version; `sdkVersions` carries all
 * three (the version-bump-re-record RULE asserts each == the INSTALLED pinned version). Older fixtures
 * (older) may omit these — the version-bump test treats a missing stamp as a FAILURE (re-record).
 */
export interface ParityFixture {
  capturedAt: string;
  sdkVersion?: string;
  sdkVersions?: Partial<Record<ParityBackend, string>>;
  runs: CapturedRun[];
}

/** A captured live (or fixture) run: the neutral RunResult + the journal steps + the event stream. */
export interface CapturedRun {
  /** Which scenario produced this (multi-turn-tool | error | no-output). */
  scenario: string;
  /** The backend that produced it. */
  backend: RunResult['backend'];
  /** The full neutral RunResult. */
  result: RunResult;
  /** The journal steps recorded for the run (type + status only matter for shape). */
  journal: Array<Pick<StepReport, 'type' | 'status'> & { idempotencyKey: string }>;
  /** The neutral event stream emitted (type + seq matter for shape/ordering). */
  events: Array<Pick<NeutralEvent, 'type' | 'seq'>>;
}

/**
 * The STRUCTURAL shape of a RunResult — the keys + the runtime typeof of each value. Content is
 * deliberately discarded; only the SHAPE is compared. `backend`/`authMode` are EXCLUDED (they
 * differ by definition). status is normalized to its type (string), not its value, since an error
 * scenario yields status='error' on every backend (same shape) but the value parity is asserted
 * separately per-scenario.
 */
export interface RunResultShape {
  /** Sorted list of own keys present on the RunResult (key-presence parity). */
  keys: string[];
  /** Per-key runtime type tag (typeof, or 'null' / 'array'), so output:null vs output:{} both => presence. */
  types: Record<string, string>;
}

/** The full structural fingerprint compared across backends for ONE scenario. */
export interface ScenarioShape {
  result: RunResultShape;
  /** The SET of ConvPart kinds present in the transcript (sorted, deduped). */
  convPartKinds: string[];
  /** The SET of ConvTurn roles present (sorted, deduped). */
  convRoles: string[];
  /** The SET of journal step types present (sorted, deduped). */
  journalStepTypes: string[];
  /** The SET of event types present (sorted, deduped). */
  eventTypes: string[];
  /** Whether the run had >1 journal step (real per-step ledger; kill stepCount=1). */
  multiStep: boolean;
  /** Whether the event seq is a contiguous 0..n-1 monotonic sequence (single seq authority). */
  seqContiguous: boolean;
}

/** typeof-style tag that treats null + arrays distinctly (so presence-of-key parity is precise). */
function typeTag(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** Extract the structural shape of a RunResult (keys + per-key type), excluding backend/authMode. */
export function runResultShape(r: RunResult): RunResultShape {
  const EXCLUDE = new Set(['backend', 'authMode']);
  const keys = Object.keys(r)
    .filter((k) => !EXCLUDE.has(k))
    .sort();
  const types: Record<string, string> = {};
  for (const k of keys) types[k] = typeTag((r as Record<string, unknown>)[k]);
  return { keys, types };
}

function uniqSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

/** ConvPart kinds present across the transcript. */
export function convPartKinds(conversation: ConvTurn[]): string[] {
  return uniqSorted(conversation.flatMap((t) => t.parts.map((p) => p.kind)));
}

/** ConvTurn roles present across the transcript. */
export function convRoles(conversation: ConvTurn[]): string[] {
  return uniqSorted(conversation.map((t) => t.role));
}

/** True iff seqs are exactly 0,1,2,...,n-1 in emission order (the single per-run seq authority). */
export function seqIsContiguous(events: Array<{ seq: number }>): boolean {
  return events.every((e, i) => e.seq === i);
}

/** Build the full ScenarioShape fingerprint from a captured run. */
export function scenarioShape(run: CapturedRun): ScenarioShape {
  return {
    result: runResultShape(run.result),
    convPartKinds: convPartKinds(run.result.conversation),
    convRoles: convRoles(run.result.conversation),
    journalStepTypes: uniqSorted(run.journal.map((s) => s.type)),
    eventTypes: uniqSorted(run.events.map((e) => e.type)),
    multiStep: run.result.stepCount > 1,
    seqContiguous: seqIsContiguous(run.events),
  };
}

/** Re-export the neutral JournalStep type alias for fixture typing convenience. */
export type { JournalStep };
