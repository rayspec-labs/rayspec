/**
 * DBOS wire-shape GOLDEN/CONTRACT test (doc-first against the INSTALLED @dbos-inc/dbos-sdk).
 *
 * The SDK API churns (functional vs decorator; `registerQueue` vs the deprecated `new WorkflowQueue`;
 * `createSchedule` vs `registerScheduled`). This test PINS the exact surface `executor.ts` depends on
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

  it('exposes registerScheduled — the cron scheduler pre-launch registration', () => {
    // The cron scheduler registers ONE scheduled workflow per cron trigger via the FUNCTIONAL path
    // `registerWorkflow(fn, {name})` → `registerScheduled(fn, {name, crontab})` BEFORE DBOS.launch().
    // A rename (registerScheduled → createSchedule/applySchedules) would make the cron SILENTLY never
    // fire; pin its existence so that breaks loudly here. (The `crontab` config key + the functional
    // signature are pinned at compile time in wire-shape-assertions.ts.)
    expect(typeof DBOS.registerScheduled).toBe('function');
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
