/**
 * Fix C — the worker taint-READ is RETRYABLE, not collapsed-to-terminal-quarantine (fast, no DBOS/PG).
 *
 * The worker's quarantine decision (executor.ts) reads the run's taint status for an already-started
 * run. A TRANSIENT read error (a momentary DB blip) must NOT permanently dead-letter a SAFE (untainted)
 * run as a "quarantine" — it must RETRY the READ a bounded number of times and only escalate (rethrow
 * the ORIGINAL DB error) if every attempt fails, NEVER proceeding to a silent re-run on an uncertain
 * taint. These unit-test `readTaintWithBoundedRetry` directly against a fake TenantDb whose query chain
 * throws a controllable number of times (no engine, no Postgres — deterministic + fast).
 *
 * Fail-the-fix: the pre-fix code did `try { isRunTainted } catch { tainted = true }` — a single transient
 * throw collapsed to tainted=true → terminal quarantine. Test (b) FAILS against that code (the helper
 * would not exist / a single throw would not be retried into a successful false read).
 */

import type { TenantDb } from '@rayspec/db';
import { describe, expect, it } from 'vitest';
import { readTaintWithBoundedRetry, TAINT_READ_MAX_ATTEMPTS } from './executor.js';

/**
 * A minimal fake of the `TenantDb` query surface `isRunTainted` uses: `tdb.select(table).where(..).
 * limit(1)`. The terminal `limit()` resolves to the row array. `failFirst` throws on the FIRST
 * `failFirst` calls to `select` (simulating a transient DB blip), then returns `rows`.
 */
function fakeTdb(opts: { failFirst: number; rows: unknown[] }): TenantDb {
  let calls = 0;
  const builder = {
    where() {
      return this;
    },
    limit(_n: number) {
      return Promise.resolve(opts.rows);
    },
  };
  const tdb = {
    select(_table: unknown) {
      calls += 1;
      if (calls <= opts.failFirst) {
        throw new Error(`transient DB blip on taint read (call ${calls})`);
      }
      return builder;
    },
  };
  return tdb as unknown as TenantDb;
}

describe('readTaintWithBoundedRetry (fix C — transient read error is retried, not terminal)', () => {
  it('a SUCCESSFUL read returns the value (tainted=true → quarantine signal)', async () => {
    const tainted = await readTaintWithBoundedRetry(
      fakeTdb({ failFirst: 0, rows: [{ id: 'x' }] }),
      'r1',
    );
    expect(tainted).toBe(true);
  });

  it('a SUCCESSFUL read returns false when no taint row exists (safe re-run signal)', async () => {
    const tainted = await readTaintWithBoundedRetry(fakeTdb({ failFirst: 0, rows: [] }), 'r1');
    expect(tainted).toBe(false);
  });

  it('a TRANSIENT read error is RETRIED, then a recovered read returns false (NOT collapsed to tainted=true)', async () => {
    // Fail the first 2 reads (transient), then the 3rd succeeds returning NO taint row. The pre-fix code
    // would have collapsed the first throw to tainted=true → terminal quarantine of a SAFE run. Here the
    // read recovers and correctly reports UNTAINTED (false) → the run is allowed to re-run.
    const tainted = await readTaintWithBoundedRetry(fakeTdb({ failFirst: 2, rows: [] }), 'r1');
    expect(tainted).toBe(false);
  });

  it('a transient error that recovers to a TAINTED row still reports tainted=true (quarantine preserved)', async () => {
    const tainted = await readTaintWithBoundedRetry(
      fakeTdb({ failFirst: TAINT_READ_MAX_ATTEMPTS - 1, rows: [{ id: 'x' }] }),
      'r1',
    );
    expect(tainted).toBe(true);
  });

  it('a PERSISTENT read failure (all attempts fail) RETHROWS the original DB error (terminal-failed, NOT a silent re-run)', async () => {
    // Every attempt throws → the helper rethrows the ORIGINAL DB error. The caller does NOT proceed to
    // re-run (the safety direction: never run on an uncertain taint) — and the error is the diagnosable
    // DB blip, not a misleading DurableRunNotRetriedError "quarantine".
    await expect(
      readTaintWithBoundedRetry(fakeTdb({ failFirst: TAINT_READ_MAX_ATTEMPTS, rows: [] }), 'r1'),
    ).rejects.toThrow(/transient DB blip on taint read/);
  });
});
