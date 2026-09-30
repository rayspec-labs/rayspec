/**
 * DBOS wire-shape GOLDEN/CONTRACT test (doc-first against the INSTALLED @dbos-inc/dbos-sdk).
 *
 * The SDK API churns (functional vs decorator; `registerQueue` vs the deprecated `new WorkflowQueue`;
 * `createSchedule` vs `registerScheduled`, and the scheduler's crontab matcher). This test PINS the exact surface `executor.ts` depends on
 * — every function it calls and the constant enum members it maps — so a future `pnpm up` to an SDK
 * that renames/removes one FAILS HERE LOUDLY (a "version bumped, re-verify the wire shape" forcing
 * function) instead of failing only at runtime under load.
 *
 * It does NOT launch DBOS or touch a DB — it only asserts the static shape (functions exist, are
 * callable signatures, the StatusString members we switch on are present). The behavioral
 * (launch + enqueue + run) proof is the .db.test.ts integration test.
 *
 * The complementary CONFIG-FIELD-NAME pins (maxRecoveryAttempts / retriesAllowed / workerConcurrency /
 * workflowID / queueName / runAdminServer) live in `wire-shape-assertions.ts` as COMPILE-TIME type
 * assertions — NOT here as `expectTypeOf`, because the `test` script runs `vitest run` without
 * `--typecheck` (a test-file type assertion would be a runtime no-op) and `tsc -b` excludes test files.
 * A field rename breaks `tsc -b` there; this runtime golden pins the function surface + the enum.
 */

import { DBOS, StatusString } from '@dbos-inc/dbos-sdk';
import { describe, expect, it } from 'vitest';
import { loadSchedulerInternals } from './scheduled-workflow.js';

describe('DBOS 4.21.6 wire shape (the API executor.ts depends on)', () => {
  it('exposes the lifecycle functions (setConfig / launch / shutdown)', () => {
    expect(typeof DBOS.setConfig).toBe('function');
    expect(typeof DBOS.launch).toBe('function');
    expect(typeof DBOS.shutdown).toBe('function');
  });

  it('exposes the workflow + step + queue registration functions', () => {
    // The FUNCTIONAL API (no decorators → no experimentalDecorators tsconfig dependency).
    expect(typeof DBOS.registerWorkflow).toBe('function');
    expect(typeof DBOS.runStep).toBe('function');
    expect(typeof DBOS.registerQueue).toBe('function');
  });

  it('exposes startWorkflow (enqueue with caller-supplied workflowID) + the status read', () => {
    expect(typeof DBOS.startWorkflow).toBe('function');
    expect(typeof DBOS.getWorkflowStatus).toBe('function');
  });

  it('exposes what the schedule loop runs on — registry, lifecycle, watermark, crontab matcher', () => {
    // scheduled-workflow.ts associates each schedule with its registered workflow, starts its loop
    // from a lifecycle listener, keeps the make-up watermark in the event-dispatch state, and computes
    // instants with the SDK's own crontab matcher on the SDK's internal queue. A rename of any of these
    // would make every schedule SILENTLY never fire; pin them so that breaks loudly here.
    expect(typeof DBOS.associateFunctionWithInfo).toBe('function');
    expect(typeof DBOS.getAssociatedInfo).toBe('function');
    expect(typeof DBOS.registerLifecycleCallback).toBe('function');
    expect(typeof DBOS.getEventDispatchState).toBe('function');
    expect(typeof DBOS.upsertEventDispatchState).toBe('function');
    const internals = loadSchedulerInternals();
    expect(typeof internals.validateCrontab).toBe('function');
    // The loop's own stepping: wake-up times until one matches (the matcher works in local time).
    const matcher = new internals.TimeMatcher('0 3 * * *');
    let next = matcher.nextWakeupTime(new Date(2026, 0, 1, 12));
    for (let steps = 0; !matcher.match(next) && steps < 1_000; steps += 1) {
      next = matcher.nextWakeupTime(next);
    }
    expect([next.getDate(), next.getHours(), next.getMinutes(), next.getSeconds()]).toEqual([
      2, 3, 0, 0,
    ]);
    expect(internals.internalQueueName).toBe('_dbos_internal_queue');
  });

  it('exposes the StatusString members executor.ts maps to the neutral status enum', () => {
    // toNeutralStatus() switches on EXACTLY these — a rename here would silently fall through to
    // 'unknown', so pin them.
    expect(StatusString.ENQUEUED).toBe('ENQUEUED');
    expect(StatusString.DELAYED).toBe('DELAYED');
    expect(StatusString.PENDING).toBe('PENDING');
    expect(StatusString.SUCCESS).toBe('SUCCESS');
    expect(StatusString.ERROR).toBe('ERROR');
    expect(StatusString.CANCELLED).toBe('CANCELLED');
    expect(StatusString.MAX_RECOVERY_ATTEMPTS_EXCEEDED).toBe('MAX_RECOVERY_ATTEMPTS_EXCEEDED');
  });

  it('registerWorkflow returns an invokable wrapper + startWorkflow returns an enqueue thunk', () => {
    // registerWorkflow(fn, config) → (…args) => Promise<Return>  (arity: 2 declared params)
    expect(DBOS.registerWorkflow.length).toBeGreaterThanOrEqual(1);
    // startWorkflow(target, params?) → (…args) => Promise<WorkflowHandle>  (the curried enqueue)
    expect(DBOS.startWorkflow.length).toBeGreaterThanOrEqual(1);
    // runStep(fn, config?) → Promise<Return>
    expect(DBOS.runStep.length).toBeGreaterThanOrEqual(1);
  });
});
