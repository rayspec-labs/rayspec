/**
 * WHERE THE INTAKE'S PAUSE GATE SITS INSIDE `submitGoal` — a static tripwire, not a comment.
 *
 * D-041 refuses a goal submitted to a paused or halted workforce. The refusal's completeness is a
 * LOCK argument, not a read: `assertWorkforceAcceptsWork` upserts the `workforce_runtime` row (a
 * real write, so a real exclusive lock) and the caller's task inserts commit in the SAME
 * transaction, so the gate and `pauseWorkforce` serialize on one row. Two positions carry that
 * argument, and both are load-bearing in a direction nothing else catches:
 *
 *   - OUTSIDE THE TRANSACTION (or taken on `tdb` rather than `tx`) and the refusal still WORKS
 *     while the ordering half is silently gone: the gate would commit and release the row, then a
 *     pause could commit, and only then the task rows — after a concurrent halt's roots scan had
 *     already run. That halt reports `affectedTaskCount` without the root it never saw, which is
 *     the original defect rather than a narrowing of it.
 *   - AFTER THE FIRST `createRootTask` and the transaction takes `workforce_tasks` BEFORE
 *     `workforce_runtime` — the inverted rank the lock-rank docblock in
 *     @rayspec/durable-dbos task-scheduler.ts forbids for the fourth composite runtime+tasks
 *     transaction, which is the only one outside that file and therefore the one with no
 *     kernel-side enforcer.
 *
 * WHY A SOURCE SCAN AND NOT ONLY A BEHAVIOURAL ARM, stated plainly. The db-backed arm
 * (`workforce-goal-intake.db.test.ts`, `TAKES the runtime row lock, and holds NO task lock while
 * it waits`) proves the lock is real and proves the rank, both from the database side via
 * `pg_blocking_pids` and `pg_locks`. It does NOT distinguish a gate moved OUT of the transaction:
 * that variant still blocks on the held pause and still refuses, because the refusal serializes
 * either way — only the COMMIT BOUNDARY moves, and a serial arm cannot see a commit boundary.
 * Reproducing that difference behaviourally needs an interleaving wedged between the gate's commit
 * and the inserts' commit, which is a timing race, not a test. The property under test IS an
 * ordering of statements inside one function, so it is asserted as one — the instrument
 * @rayspec/durable-dbos `claim-pause-ordering.test.ts` uses for the identical class of guarantee.
 *
 * FAIL-CLOSED: every marker must appear EXACTLY ONCE inside `submitGoal`, so a rename, a duplicate,
 * or a scan that stops finding the code turns this red rather than green.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = resolve(fileURLToPath(import.meta.url), '..');
const SOURCE = resolve(here, 'workforce-goal-intake.ts');

/** `submitGoal`'s body, sliced out so a marker elsewhere in the file cannot satisfy a scan. */
function submitGoalBody(): string {
  const src = readFileSync(SOURCE, 'utf8');
  const start = src.indexOf('async submitGoal(input): Promise<WorkforceGoalOutcome> {');
  expect(
    start,
    'the scan must find `submitGoal` — a rename must not read as a pass',
  ).toBeGreaterThan(-1);
  // The seam object's closing `},` then the factory's. Slice to end of file: `submitGoal` is the
  // last member, so an unbounded tail cannot pull in a DIFFERENT function's statements.
  return src.slice(start);
}

/** The offset of a marker that must occur exactly once — a duplicate is as bad as a rename. */
function onlyIndexOf(body: string, marker: string): number {
  const first = body.indexOf(marker);
  expect(first, `marker not found in submitGoal: ${marker}`).toBeGreaterThan(-1);
  expect(
    body.indexOf(marker, first + 1),
    `marker appears more than once in submitGoal, so its position is ambiguous: ${marker}`,
  ).toBe(-1);
  return first;
}

/** The transaction the whole plan commits in. */
const TRANSACTION_OPEN = 'const created = await tdb.transaction(async (tx) => {';
/** The gate, taken ON `tx` — the same transaction the inserts below commit in. */
const GATE_ON_TX = 'await assertWorkforceAcceptsWork(tx, deps.config.id);';
/** The first (and only) task write. */
const FIRST_TASK_WRITE = 'const task = await createRootTask(tx, {';

describe('submitGoal — the pause gate is positioned, not merely present', () => {
  it('is taken INSIDE the plan transaction, on `tx`, so the gate and the inserts commit together', () => {
    const body = submitGoalBody();
    const txOpen = onlyIndexOf(body, TRANSACTION_OPEN);
    const gate = onlyIndexOf(body, GATE_ON_TX);

    expect(
      gate,
      'THE PAUSE GATE LEFT THE TRANSACTION. Taken outside it (or on `tdb`), the gate commits and ' +
        'releases the workforce_runtime row BEFORE the task rows are written, so a pause can ' +
        'commit in between and a concurrent halt scans its roots without seeing the row this call ' +
        'is about to create. The refusal keeps working, which is why nothing else catches this.',
    ).toBeGreaterThan(txOpen);
  });

  it('is taken BEFORE the first task write, so this transaction takes runtime -> tasks', () => {
    const body = submitGoalBody();
    const gate = onlyIndexOf(body, GATE_ON_TX);
    const firstWrite = onlyIndexOf(body, FIRST_TASK_WRITE);

    expect(
      firstWrite,
      'THE PAUSE GATE MOVED BELOW THE FIRST TASK WRITE. This transaction would take ' +
        '`workforce_tasks` before `workforce_runtime` — the inverted rank. The goal intake is the ' +
        'FOURTH composite runtime+tasks transaction and the only one outside task-scheduler.ts, ' +
        'so this order is held by this call site and by nothing else.',
    ).toBeGreaterThan(gate);
  });
});
