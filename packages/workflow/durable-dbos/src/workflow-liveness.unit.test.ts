/**
 * DUR-HONESTY-2 — pure-unit tests for `reconcileWorkflowLiveness`. No DB / no DBOS: they pin the honest
 * DEAD-LETTER visibility rule (a workflow whose JOURNAL header is stuck `running` while DBOS has stopped
 * owning it — after `maxRecoveryAttempts` — is `stalled`, not forever-live). The DB/DBOS-backed executor
 * `liveness()` that fetches both inputs is exercised in workflow-executor.db.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { reconcileWorkflowLiveness } from './index.js';

describe('reconcileWorkflowLiveness (DUR-HONESTY-2)', () => {
  it('absent journal header ⇒ absent', () => {
    expect(reconcileWorkflowLiveness('absent', 'unknown')).toBe('absent');
    expect(reconcileWorkflowLiveness('absent', 'succeeded')).toBe('absent');
  });

  it('a settled journal header ⇒ terminal (no reconciliation needed)', () => {
    for (const s of [
      'completed',
      'terminal_failure',
      'retryable_failure',
      'paused',
      'quarantined',
    ] as const) {
      expect(reconcileWorkflowLiveness(s, 'succeeded')).toBe('terminal');
    }
  });

  it('header running + DBOS still owns it ⇒ active', () => {
    expect(reconcileWorkflowLiveness('running', 'enqueued')).toBe('active');
    expect(reconcileWorkflowLiveness('running', 'running')).toBe('active');
  });

  it('header running but DBOS no longer active/queued ⇒ stalled (dead-lettered)', () => {
    // The exact dead-letter case: DBOS exhausted maxRecoveryAttempts (failed) but engine.execute never
    // reached finalizeRun, so the header is stuck 'running'. Also the ambiguous unknown / a succeeded-
    // without-finalize race are surfaced as stalled — an operator must reconcile, never assume live.
    for (const d of ['failed', 'cancelled', 'unknown', 'succeeded'] as const) {
      expect(reconcileWorkflowLiveness('running', d)).toBe('stalled');
    }
  });
});
