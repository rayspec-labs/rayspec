/**
 * WHERE THE PAUSE REFUSAL SITS INSIDE `#claimTurn` — a static tripwire, not a comment.
 *
 * B-015e closes the drain's blind spot by refusing a claim whose workforce is paused. That refusal
 * is deliberately scoped to the `queued -> working` CLAIM and must stay BELOW the recovery branch,
 * and the position is load-bearing in both directions:
 *
 *   - TOO LOW (below the compare-and-swap) and the window re-opens: the row would go `working`
 *     after the drain had already returned. That direction is caught behaviourally — the
 *     dispatched-but-unclaimed arm in task-scheduler.db.test.ts reddens.
 *   - TOO HIGH (above the recovery branch) and a re-execution of a turn that ALREADY claimed would
 *     no-op instead of finishing. Its reservation is taken and its `turn_started` is journaled, so
 *     the row would sit `working` with nobody left to apply it — and the drain, which waits for
 *     exactly that row to leave `working`, would hang to its timeout and then throw. **That
 *     direction is caught by nothing else**, which is why this file exists: a reviewer's mutation
 *     moved the refusal above the recovery branch and the entire behavioural suite stayed green,
 *     23/23.
 *
 * WHY THIS IS A SOURCE SCAN RATHER THAN A BEHAVIOURAL ARM, stated plainly. Entering the recovery
 * branch requires a SECOND execution of the same workflow body — which is DBOS recovery, and the
 * SDK exposes `recoverPendingWorkflows` only on its internal executor, not on the `DBOS` facade.
 * A same-id `startWorkflow` dedupes rather than re-executing, and the reserve pass only ever pages
 * `queued` rows, so no public seam reaches a `working` row's claim path. Reaching into SDK
 * internals would pin the SDK's recovery machinery as much as this engine's ordering. The property
 * under test IS an ordering of statements inside one private method, so it is asserted as one —
 * the same instrument `terminal-fan-in.test.ts` uses for the same class of guarantee.
 *
 * FAIL-CLOSED: every marker must appear EXACTLY ONCE inside the method, so a rename, a duplicate,
 * or a scan that stops finding the code turns this red rather than green.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = resolve(fileURLToPath(import.meta.url), '..');
const SOURCE = resolve(here, 'task-scheduler.ts');

/** The claim transaction's body, sliced out so a marker elsewhere in the file cannot satisfy a scan. */
function claimTurnBody(): string {
  const src = readFileSync(SOURCE, 'utf8');
  const start = src.indexOf('async #claimTurn(');
  const end = src.indexOf('async #parkDenied(');
  expect(
    start,
    'the scan must find `#claimTurn` — a rename must not read as a pass',
  ).toBeGreaterThan(-1);
  expect(
    end,
    'the scan must find the method that FOLLOWS `#claimTurn`, or the slice is unbounded',
  ).toBeGreaterThan(start);
  return src.slice(start, end);
}

/** The offset of a marker that must occur exactly once — a duplicate is as bad as a rename. */
function onlyIndexOf(body: string, marker: string): number {
  const first = body.indexOf(marker);
  expect(first, `marker not found in #claimTurn: ${marker}`).toBeGreaterThan(-1);
  expect(
    body.indexOf(marker, first + 1),
    `marker appears more than once in #claimTurn, so its position is ambiguous: ${marker}`,
  ).toBe(-1);
  return first;
}

const RECOVERY_BRANCH = "if (task.status === 'working') {";
const RECOVERY_RETURNS_CLAIMED = "return { kind: 'claimed' as const, task, budgets };";
const QUEUED_GUARD = "if (task.status !== 'queued') return { kind: 'noop' as const };";
const PAUSE_REFUSAL = "if (runtime?.paused === true) return { kind: 'noop' as const };";
const CLAIM_CAS = "to: 'working',";
const RUNTIME_READ = 'await ensureWorkforceRuntime(tx, task.workforceId)';

describe('#claimTurn — the pause refusal is positioned, not merely present', () => {
  it('sits BELOW the recovery branch, so a turn that already claimed still finishes', () => {
    const body = claimTurnBody();
    const recovery = onlyIndexOf(body, RECOVERY_BRANCH);
    const recoveryClaimed = onlyIndexOf(body, RECOVERY_RETURNS_CLAIMED);
    const refusal = onlyIndexOf(body, PAUSE_REFUSAL);

    // The recovery branch must still RETURN CLAIMED — a refusal moved above it would make this
    // unreachable, and a recovery that no-ops strands its row `working` with the reservation taken.
    expect(
      recoveryClaimed,
      'the recovery branch must still return `claimed`, or a re-executed turn can never finish',
    ).toBeGreaterThan(recovery);
    expect(
      refusal,
      'THE PAUSE REFUSAL MOVED ABOVE THE RECOVERY BRANCH. A re-execution of a turn that already ' +
        'claimed would now no-op: its reservation is taken and its turn_started is journaled, so ' +
        "the row sits `working` with nobody left to apply it — and `pauseWorkforce`'s drain, which " +
        'waits for that row to leave `working`, hangs to its timeout and throws. Keep the refusal ' +
        'on the queued->working claim only.',
    ).toBeGreaterThan(recoveryClaimed);
  });

  it('sits ABOVE the compare-and-swap and below the `queued` guard, so it can still refuse', () => {
    const body = claimTurnBody();
    const queuedGuard = onlyIndexOf(body, QUEUED_GUARD);
    const refusal = onlyIndexOf(body, PAUSE_REFUSAL);
    const cas = onlyIndexOf(body, CLAIM_CAS);

    expect(refusal, 'the refusal belongs after the `queued` guard').toBeGreaterThan(queuedGuard);
    expect(
      cas,
      'THE PAUSE REFUSAL MOVED BELOW THE COMPARE-AND-SWAP — the row would reach `working` after a ' +
        'completed drain, which is the whole defect B-015e closes.',
    ).toBeGreaterThan(refusal);
  });

  it('reads the runtime row INSIDE the claim transaction, which is what closes the window', () => {
    // The completeness argument is a LOCK argument: `ensureWorkforceRuntime`'s upsert is a real
    // write, so taking it on `tx` holds the workforce_runtime row until this transaction commits,
    // and `pauseWorkforce` writes that same row before its drain polls. Reading it off `tdb` (its
    // own autocommit transaction) keeps the refusal working while silently dropping the lock — the
    // ordering half of the proof would be gone and nothing would say so. Pinned here as well as
    // behaviourally, because the behavioural arm needs a wedged claim and this is free.
    const body = claimTurnBody();
    const runtimeRead = onlyIndexOf(body, RUNTIME_READ);
    const cas = onlyIndexOf(body, CLAIM_CAS);
    expect(
      cas,
      'the runtime row must be read, on `tx`, BEFORE the compare-and-swap — same transaction, or ' +
        'the pause and the claim no longer serialize on one row',
    ).toBeGreaterThan(runtimeRead);
  });
});
