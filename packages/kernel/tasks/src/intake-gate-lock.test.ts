/**
 * `assertWorkforceAcceptsWork` READS THE RUNTIME ROW THROUGH THE LOCKING UPSERT — a static
 * tripwire, not a comment.
 *
 * The gate's completeness argument is a LOCK argument. `ensureWorkforceRuntime` is an
 * `INSERT … ON CONFLICT DO UPDATE` whose `set` is a REAL write, so it takes the
 * `workforce_runtime` row's exclusive lock and holds it until the caller's transaction commits —
 * and `pauseWorkforce` writes that same row. That is what gives the two a total order, and it is
 * the whole reason a submission that wins the race is guaranteed to be visible to a later halt's
 * roots scan.
 *
 * Swapping it for `readWorkforceRuntime` — a plain `SELECT`, right there in this same module and
 * returning the same record type — keeps the refusal working in every serial test while silently
 * dropping the lock. Nothing behavioural in a serial suite would say so. The db-backed arm in
 * @rayspec/server (`workforce-goal-intake.db.test.ts`, `TAKES the runtime row lock, and holds NO
 * task lock while it waits`) does catch it, from the database side via `pg_blocking_pids`; this
 * scan catches it in the package that OWNS the helper, in lane 1, without a database. Both, for
 * the same reason #502 pinned its identical blind spot twice: the behavioural arm needs a wedged
 * transaction and this is free.
 *
 * FAIL-CLOSED: the function must be found and each marker must appear exactly once inside it, so a
 * rename or a scan that stops finding the code turns this red rather than green.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = resolve(fileURLToPath(import.meta.url), '..');
const SOURCE = resolve(here, 'runtime.ts');

/** The helper's body, sliced out so a marker elsewhere in runtime.ts cannot satisfy the scan. */
function gateBody(): string {
  const src = readFileSync(SOURCE, 'utf8');
  const start = src.indexOf('export async function assertWorkforceAcceptsWork(');
  expect(
    start,
    'the scan must find `assertWorkforceAcceptsWork` — a rename must not read as a pass',
  ).toBeGreaterThan(-1);
  return src.slice(start);
}

function onlyIndexOf(body: string, marker: string): number {
  const first = body.indexOf(marker);
  expect(first, `marker not found in assertWorkforceAcceptsWork: ${marker}`).toBeGreaterThan(-1);
  expect(
    body.indexOf(marker, first + 1),
    `marker appears more than once, so its position is ambiguous: ${marker}`,
  ).toBe(-1);
  return first;
}

/** The LOCKING read — the upsert, taken on the caller's handle. */
const LOCKING_READ = 'const runtime = await ensureWorkforceRuntime(tdb, workforceId);';
/** The refusal, which must come after that read. */
const REFUSAL = 'if (runtime.paused) throw new WorkforcePausedError(workforceId);';

describe('assertWorkforceAcceptsWork — the gate LOCKS the row it reads', () => {
  it('reads through `ensureWorkforceRuntime`, whose upsert is what takes the row lock', () => {
    const body = gateBody();
    expect(
      body.indexOf(LOCKING_READ),
      'THE GATE STOPPED LOCKING. `assertWorkforceAcceptsWork` must read the runtime row through ' +
        "`ensureWorkforceRuntime` — its upsert's `set` is a real write, which is what holds the " +
        'workforce_runtime row until the caller commits. A plain `SELECT` (readWorkforceRuntime, ' +
        'in this same module) still sees `paused` in any serial test while dropping the ordering ' +
        'guarantee the refusal rests on.',
    ).toBeGreaterThan(-1);
    onlyIndexOf(body, LOCKING_READ);
  });

  it('refuses AFTER that read, so the value it branches on is the locked one', () => {
    const body = gateBody();
    const read = onlyIndexOf(body, LOCKING_READ);
    const refusal = onlyIndexOf(body, REFUSAL);
    expect(
      refusal,
      'the refusal must branch on the value read UNDER the lock, not on one read before it',
    ).toBeGreaterThan(read);
  });

  it('does NOT reach for the unlocked plain read', () => {
    const body = gateBody();
    // Negative assertion, so it carries its own control: the token it denies is a REAL exported
    // symbol of this module (asserted below), not a spelling that could never appear.
    expect(
      readFileSync(SOURCE, 'utf8').includes('export async function readWorkforceRuntime('),
      'control for the assertion below: `readWorkforceRuntime` must really exist in this module, ' +
        'or denying it proves nothing',
    ).toBe(true);
    expect(
      body.includes('readWorkforceRuntime('),
      'the gate must not fall back to the unlocked plain read — that is precisely the silent ' +
        'lock drop this file exists to catch',
    ).toBe(false);
  });
});
