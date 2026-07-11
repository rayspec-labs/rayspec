import {
  type CapabilityInvocationResult,
  CapabilityRegistry,
  type WorkflowInputEvent,
  type WorkflowSpec,
  type WorkflowStepSpec,
} from '@rayspec/foundation';
import { beforeEach, describe, expect, it } from 'vitest';
import { DurableWorkflowEngine } from './engine.js';
import { FakeWorkflowJournalStore } from './test-support/fake-journal-store.js';
import type { RepairHandler, WorkflowRunFinalizePatch } from './types.js';

const TENANT = '00000000-0000-0000-0000-0000000000aa';
const CLOCK = '2026-07-02T00:00:00.000Z';

function event(overrides: Partial<WorkflowInputEvent> = {}): WorkflowInputEvent {
  return {
    id: 'evt-1',
    type: 'audio_input.finalized_session',
    occurred_at: CLOCK,
    payload: { session_id: 's1' },
    ...overrides,
  };
}

function workflow(steps: WorkflowStepSpec[], overrides: Partial<WorkflowSpec> = {}): WorkflowSpec {
  return {
    id: 'wf',
    tier: 'A',
    status: 'foundation_only',
    trigger: { event: 'audio_input.finalized_session' },
    idempotency_key: 'session:s1:finalized',
    steps,
    ...overrides,
  };
}

function step(overrides: Partial<WorkflowStepSpec> & { id: string }): WorkflowStepSpec {
  return { capability: 'test', operation: 'op', ...overrides };
}

function completed(artifactId?: string): CapabilityInvocationResult {
  return {
    status: 'completed',
    ...(artifactId
      ? {
          artifact_refs: [
            { id: artifactId, kind: 'test.artifact', source_node_id: 'x', value: { ok: true } },
          ],
        }
      : {}),
    output: { ok: true },
  };
}

describe('DurableWorkflowEngine', () => {
  let registry: CapabilityRegistry;
  let store: FakeWorkflowJournalStore;

  beforeEach(() => {
    registry = new CapabilityRegistry();
    store = new FakeWorkflowJournalStore(TENANT);
  });

  function engine(repairers?: Map<string, RepairHandler>) {
    return new DurableWorkflowEngine({
      journal: store,
      registry,
      tenantId: TENANT,
      clock: () => CLOCK,
      ...(repairers ? { repairers } : {}),
    });
  }

  it('runs a two-node workflow to completion, journaling both nodes tenant-scoped', async () => {
    registry.register('test.a', () => completed('art-a'));
    registry.register('test.b', () => completed('art-b'));
    const view = await engine().execute({
      workflow: workflow([
        step({ id: 'a', capability: 'test', operation: 'a' }),
        step({ id: 'b', capability: 'test', operation: 'b', depends_on: ['a'] }),
      ]),
      event: event(),
    });

    expect(view.run.status).toBe('completed');
    expect(view.nodes.map((n) => [n.nodeId, n.status])).toEqual([
      ['a', 'completed'],
      ['b', 'completed'],
    ]);
    expect(view.run.workflowRunId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("threads a completed node's artifacts to a dependent node (artifact passing)", async () => {
    let seenByB: unknown;
    registry.register('test.a', () => completed('art-a'));
    registry.register('test.b', (ctx) => {
      seenByB = ctx.artifacts;
      return completed('art-b');
    });
    await engine().execute({
      workflow: workflow([
        step({ id: 'a', capability: 'test', operation: 'a' }),
        step({ id: 'b', capability: 'test', operation: 'b', depends_on: ['a'] }),
      ]),
      event: event(),
    });
    expect(Array.isArray(seenByB)).toBe(true);
    expect((seenByB as Array<{ id: string }>).map((a) => a.id)).toEqual(['art-a']);
  });

  it('retries a retryable_failure within the policy, then completes (attempts recorded)', async () => {
    let calls = 0;
    registry.register('test.flaky', () => {
      calls += 1;
      return calls < 2
        ? ({
            status: 'retryable_failure',
            error: { code: 'temporary', message: 'try later', retryable: true },
          } as const)
        : completed();
    });
    const view = await engine().execute({
      workflow: workflow([
        step({
          id: 'flaky',
          capability: 'test',
          operation: 'flaky',
          retry_policy: { max_attempts: 3 },
        }),
      ]),
      event: event(),
    });
    expect(view.run.status).toBe('completed');
    expect(view.nodes[0]?.status).toBe('completed');
    expect(view.nodes[0]?.attemptCount).toBe(2);
    expect(calls).toBe(2);
  });

  it('FAIL (default policy): exhausted retryable → run terminal/retryable, downstream skipped', async () => {
    // A retryable failure that NEVER recovers exhausts the retry policy; with the default `fail` policy
    // the node stays retryable_failure (a worker may retry the whole run) and the run STOPS invoking new
    // work — so its dependent is skipped via the run-halt (`workflow_already_stopped`), which takes
    // precedence over the dependency gate (both reasons are true; the halt fires first).
    registry.register('test.always', () => ({
      status: 'retryable_failure',
      error: { code: 'temporary', message: 'nope', retryable: true },
    }));
    registry.register('test.b', () => completed());
    const view = await engine().execute({
      workflow: workflow([
        step({
          id: 'a',
          capability: 'test',
          operation: 'always',
          retry_policy: { max_attempts: 2 },
        }),
        step({ id: 'b', capability: 'test', operation: 'b', depends_on: ['a'] }),
      ]),
      event: event(),
    });
    expect(view.nodes[0]?.status).toBe('retryable_failure');
    expect(view.nodes[0]?.attemptCount).toBe(2);
    expect(view.nodes[1]?.status).toBe('skipped');
    expect(view.nodes[1]?.skippedReason).toBe('workflow_already_stopped');
    expect(view.run.status).toBe('retryable_failure');
  });

  it('a retry-exhausted FAIL node halts an INDEPENDENT not-yet-started node (no side effect)', async () => {
    // A `fail`-policy node that exhausts its retries ends `retryable_failure`. The documented
    // contract is that `fail` STOPS the run from invoking new work — but a downstream INDEPENDENT node
    // (no depends_on) must ALSO be halted, else its side effect fires after the run has failed.
    let bRan = 0;
    registry.register('test.always', () => ({
      status: 'retryable_failure',
      error: { code: 'temporary', message: 'nope', retryable: true },
    }));
    registry.register('test.b', () => {
      bRan += 1;
      return completed();
    });
    const view = await engine().execute({
      workflow: workflow([
        step({
          id: 'a',
          capability: 'test',
          operation: 'always',
          retry_policy: { max_attempts: 2 },
        }),
        // B is INDEPENDENT (no depends_on) — nothing links it to A's failure except the run halting.
        step({ id: 'b', capability: 'test', operation: 'b' }),
      ]),
      event: event(),
    });
    expect(view.nodes[0]?.status).toBe('retryable_failure');
    expect(view.nodes[1]?.status).toBe('skipped');
    expect(view.nodes[1]?.skippedReason).toBe('workflow_already_stopped');
    expect(bRan).toBe(0); // the independent node's side effect NEVER fired
    expect(view.run.status).toBe('retryable_failure');
  });

  it('a non-retryable terminal_failure stops the run and skips downstream', async () => {
    registry.register('test.bad', () => ({
      status: 'terminal_failure',
      error: { code: 'bad_input', message: 'stop', retryable: false },
    }));
    registry.register('test.b', () => completed());
    const view = await engine().execute({
      workflow: workflow([
        step({ id: 'a', capability: 'test', operation: 'bad' }),
        step({ id: 'b', capability: 'test', operation: 'b', depends_on: ['a'] }),
      ]),
      event: event(),
    });
    expect(view.nodes[0]?.status).toBe('terminal_failure');
    expect(view.nodes[1]?.status).toBe('skipped');
    expect(view.run.status).toBe('terminal_failure');
  });

  it('DROP policy: the node is journaled dropped and the run continues on an INDEPENDENT branch', async () => {
    registry.register('test.bad', () => ({
      status: 'terminal_failure',
      error: { code: 'bad', message: 'x', retryable: false },
    }));
    registry.register('test.indep', () => completed());
    const view = await engine().execute({
      workflow: workflow([
        step({ id: 'a', capability: 'test', operation: 'bad', failure_policy: 'drop' }),
        // b does NOT depend on a — the run continues where the graph allows.
        step({ id: 'b', capability: 'test', operation: 'indep' }),
      ]),
      event: event(),
    });
    expect(view.nodes[0]?.status).toBe('dropped');
    expect(view.nodes[1]?.status).toBe('completed');
    // A dropped node does not fail the run; the run completes (the drop was tolerated).
    expect(view.run.status).toBe('completed');
  });

  it('DROP policy: a node depending on a dropped node is still skipped (no phantom output)', async () => {
    registry.register('test.bad', () => ({
      status: 'terminal_failure',
      error: { code: 'bad', message: 'x', retryable: false },
    }));
    registry.register('test.dep', () => completed());
    const view = await engine().execute({
      workflow: workflow([
        step({ id: 'a', capability: 'test', operation: 'bad', failure_policy: 'drop' }),
        step({ id: 'b', capability: 'test', operation: 'dep', depends_on: ['a'] }),
      ]),
      event: event(),
    });
    expect(view.nodes[0]?.status).toBe('dropped');
    expect(view.nodes[1]?.status).toBe('skipped');
    expect(view.nodes[1]?.skippedReason).toBe('dependency_failure');
  });

  it('QUARANTINE policy: node + dependents parked, run quarantined + resumable', async () => {
    registry.register('test.bad', () => ({
      status: 'terminal_failure',
      error: { code: 'bad', message: 'x', retryable: false },
    }));
    registry.register('test.dep', () => completed());
    const view = await engine().execute({
      workflow: workflow([
        step({ id: 'a', capability: 'test', operation: 'bad', failure_policy: 'quarantine' }),
        step({ id: 'b', capability: 'test', operation: 'dep', depends_on: ['a'] }),
      ]),
      event: event(),
    });
    expect(view.nodes[0]?.status).toBe('quarantined');
    expect(view.nodes[1]?.status).toBe('skipped');
    expect(view.nodes[1]?.skippedReason).toBe('quarantined_upstream');
    expect(view.run.status).toBe('quarantined');
    expect(view.run.resumable).toBe(true);
  });

  it('REPAIR policy (wired): a repairer that completes rescues the node', async () => {
    registry.register('test.bad', () => ({
      status: 'terminal_failure',
      error: { code: 'bad', message: 'x', retryable: false },
    }));
    const repairers = new Map<string, RepairHandler>([['fix', () => completed('repaired')]]);
    const view = await engine(repairers).execute({
      workflow: workflow([
        step({
          id: 'a',
          capability: 'test',
          operation: 'bad',
          failure_policy: 'repair',
          repair: { ref: 'fix' },
        }),
      ]),
      event: event(),
    });
    expect(view.nodes[0]?.status).toBe('completed');
    expect(view.run.status).toBe('completed');
    expect(view.nodes[0]?.artifactRefs.map((a) => a.id)).toEqual(['repaired']);
  });

  it('REPAIR policy (NOT wired): a declared-but-inert repair hook fails LOUD (repair_not_wired)', async () => {
    registry.register('test.bad', () => ({
      status: 'terminal_failure',
      error: { code: 'bad', message: 'x', retryable: false },
    }));
    // No repairer registered for ref 'missing'.
    const view = await engine(new Map()).execute({
      workflow: workflow([
        step({
          id: 'a',
          capability: 'test',
          operation: 'bad',
          failure_policy: 'repair',
          repair: { ref: 'missing' },
        }),
      ]),
      event: event(),
    });
    expect(view.nodes[0]?.status).toBe('terminal_failure');
    expect(view.nodes[0]?.error?.code).toBe('repair_not_wired');
    expect(view.run.status).toBe('terminal_failure');
  });

  it('a missing capability is capability_unavailable and skips its dependents (fail-closed)', async () => {
    registry.register('test.b', () => completed());
    const view = await engine().execute({
      workflow: workflow([
        step({ id: 'a', capability: 'missing', operation: 'op' }),
        step({ id: 'b', capability: 'test', operation: 'b', depends_on: ['a'] }),
      ]),
      event: event(),
    });
    expect(view.nodes[0]?.status).toBe('capability_unavailable');
    expect(view.nodes[1]?.status).toBe('skipped');
    expect(view.run.status).toBe('terminal_failure');
  });

  it('rejects a forward/cyclic depends_on at RUN time before creating a run', async () => {
    registry.register('test.op', () => completed());
    await expect(
      engine().execute({
        workflow: workflow([
          step({ id: 'first', capability: 'test', operation: 'op', depends_on: ['second'] }),
          step({ id: 'second', capability: 'test', operation: 'op' }),
        ]),
        event: event(),
      }),
    ).rejects.toThrow(/forward reference/i);
    // No run header was created (validation threw before ensureRun).
    expect(await store.loadRun(await anyRunId())).toBeUndefined();
  });

  it('rejects an unknown depends_on at RUN time', async () => {
    registry.register('test.op', () => completed());
    await expect(
      engine().execute({
        workflow: workflow([
          step({ id: 'a', capability: 'test', operation: 'op', depends_on: ['typo'] }),
        ]),
        event: event(),
      }),
    ).rejects.toThrow(/unknown step 'typo'/);
  });

  it('rejects a trigger/event type mismatch at RUN time', async () => {
    registry.register('test.op', () => completed());
    await expect(
      engine().execute({
        workflow: workflow([step({ id: 'a', capability: 'test', operation: 'op' })]),
        event: event({ type: 'wrong.event' }),
      }),
    ).rejects.toThrow(/expects event/);
  });

  it('DEDUP: re-executing the same (workflow, idempotency) does NOT re-run nodes', async () => {
    let calls = 0;
    registry.register('test.op', () => {
      calls += 1;
      return completed();
    });
    const wf = workflow([step({ id: 'a', capability: 'test', operation: 'op' })]);
    const first = await engine().execute({ workflow: wf, event: event() });
    const second = await engine().execute({ workflow: wf, event: event() });
    expect(first.run.workflowRunId).toBe(second.run.workflowRunId);
    expect(second.run.status).toBe('completed');
    expect(calls).toBe(1); // the node ran EXACTLY once across both executes (single-flight dedup)
  });

  it('RESUME: a crashed run (status running, node a completed) resumes at b WITHOUT re-running a', async () => {
    let aCalls = 0;
    let bCalls = 0;
    registry.register('test.a', () => {
      aCalls += 1;
      return completed('art-a');
    });
    registry.register('test.b', () => {
      bCalls += 1;
      return completed('art-b');
    });
    const wf = workflow([
      step({ id: 'a', capability: 'test', operation: 'a' }),
      step({ id: 'b', capability: 'test', operation: 'b', depends_on: ['a'] }),
    ]);

    // Pre-seed a CRASHED run: header 'running' + node a completed, node b absent (as if the process
    // died after a committed but before b). ensureRun matches the deterministic run id.
    const seededId = await seedCrashedRun(store, wf, TENANT);

    const view = await engine().execute({ workflow: wf, event: event() });
    expect(view.run.workflowRunId).toBe(seededId);
    expect(view.run.status).toBe('completed');
    expect(aCalls).toBe(0); // a was NOT re-run (resumed from journal)
    expect(bCalls).toBe(1); // b ran on resume
  });

  it('a run-halted INDEPENDENT node re-runs on resume once the fail-policy upstream recovers (never left skipped in a completed run)', async () => {
    // Pass 1: node `a` (default `fail` policy, no retry) fails once → retryable_failure → the run HALTS,
    // so the INDEPENDENT node `b` is journaled skipped/`workflow_already_stopped`. The process then CRASHES
    // before the header settles (finalizeRun throws), leaving the header `running`. On RESUME, `a` is
    // re-run and SUCCEEDS this pass → the run is no longer stopped, so `b` MUST run: a `workflow_already_
    // stopped` skip is a TRANSIENT run-halt mark, not a terminal outcome. On the UNFIXED engine `b` stays
    // skipped yet the run reports `completed` — silent missing work in a completed run.
    let aCalls = 0;
    let bRan = 0;
    registry.register('test.a', () => {
      aCalls += 1;
      return aCalls < 2
        ? ({
            status: 'retryable_failure',
            error: { code: 'temporary', message: 'nope', retryable: true },
          } as const)
        : completed('art-a');
    });
    registry.register('test.b', () => {
      bRan += 1;
      return completed('art-b');
    });
    const wf = workflow([
      step({ id: 'a', capability: 'test', operation: 'a' }),
      // b is INDEPENDENT (no depends_on) — only the run-halt links it to a's pass-1 failure.
      step({ id: 'b', capability: 'test', operation: 'b' }),
    ]);

    // Pass 1 CRASHES before finalize: the header is left `running` (a real crash window — a's + b's rows
    // are journaled but the run header never settled).
    const crashingStore = new CrashOnceOnFinalizeStore(TENANT);
    const crashEngine = new DurableWorkflowEngine({
      journal: crashingStore,
      registry,
      tenantId: TENANT,
      clock: () => CLOCK,
    });
    await expect(crashEngine.execute({ workflow: wf, event: event() })).rejects.toThrow(
      /simulated crash/,
    );

    // Ground the pass-1 crash state: a failed (retryable_failure), b skipped by the run-halt, header running.
    const crashedId = await anyRunId();
    const crashedView = await crashingStore.loadRun(crashedId);
    expect(crashedView?.run.status).toBe('running');
    expect(crashedView?.nodes.find((n) => n.nodeId === 'a')?.status).toBe('retryable_failure');
    const bAfterCrash = crashedView?.nodes.find((n) => n.nodeId === 'b');
    expect(bAfterCrash?.status).toBe('skipped');
    expect(bAfterCrash?.skippedReason).toBe('workflow_already_stopped');
    expect(bRan).toBe(0);

    // RESUME on the SAME store (the crash is one-shot): a re-runs + succeeds, and b must now RUN.
    const resumeEngine = new DurableWorkflowEngine({
      journal: crashingStore,
      registry,
      tenantId: TENANT,
      clock: () => CLOCK,
    });
    const view = await resumeEngine.execute({ workflow: wf, event: event() });

    expect(view.run.workflowRunId).toBe(crashedId);
    expect(bRan).toBe(1); // the independent node's work is now present (silently skipped before the fix)
    expect(view.nodes.find((n) => n.nodeId === 'a')?.status).toBe('completed');
    const bFinal = view.nodes.find((n) => n.nodeId === 'b');
    // The superseded skip row is OVERWRITTEN in place (the one-row-per-node upsert model) — no stale skip.
    expect(bFinal?.status).toBe('completed');
    expect(bFinal?.skippedReason).toBeUndefined();
    expect(view.run.status).toBe('completed');
  });

  async function anyRunId(): Promise<string> {
    // Derive the deterministic id the engine would have used (matches durableWorkflowRunId).
    const { durableWorkflowRunId } = await import('./ids.js');
    return durableWorkflowRunId(TENANT, 'wf', 'session:s1:finalized');
  }
});

/**
 * A `FakeWorkflowJournalStore` that THROWS on its first `finalizeRun` (a crash BEFORE the header settles),
 * then behaves normally — so a subsequent `execute()` finds the header still `running` and RESUMES. All
 * node rows persisted before the finalize survive (the crash window this exercises).
 */
class CrashOnceOnFinalizeStore extends FakeWorkflowJournalStore {
  #finalizeCalls = 0;
  override async finalizeRun(
    workflowRunId: string,
    patch: WorkflowRunFinalizePatch,
  ): Promise<void> {
    this.#finalizeCalls += 1;
    if (this.#finalizeCalls === 1) throw new Error('simulated crash before finalize');
    return super.finalizeRun(workflowRunId, patch);
  }
}

/** Seed a CRASHED run into the fake store: header 'running' + node `a` completed, `b` absent. */
async function seedCrashedRun(
  store: FakeWorkflowJournalStore,
  wf: WorkflowSpec,
  tenantId: string,
): Promise<string> {
  const { durableWorkflowRunId } = await import('./ids.js');
  const workflowRunId = durableWorkflowRunId(tenantId, wf.id, wf.idempotency_key);
  await store.ensureRun({
    workflowRunId,
    workflowId: wf.id,
    idempotencyKey: wf.idempotency_key,
    triggerEvent: wf.trigger.event,
    inputEvent: {
      id: 'evt-1',
      type: wf.trigger.event,
      occurred_at: CLOCK,
      payload: { session_id: 's1' },
    },
  });
  await store.upsertNodeState(workflowRunId, {
    nodeId: 'a',
    position: 0,
    capability: 'test',
    operation: 'a',
    status: 'completed',
    attempts: [{ attempt: 1, started_at: CLOCK, completed_at: CLOCK, status: 'completed' }],
    attemptCount: 1,
    artifactRefs: [
      { id: 'art-a', kind: 'test.artifact', source_node_id: 'a', value: { ok: true } },
    ],
    output: { ok: true },
    costUsd: 0,
  });
  // Leave the header in 'running' (a crash mid-run) — do NOT finalize.
  return workflowRunId;
}
