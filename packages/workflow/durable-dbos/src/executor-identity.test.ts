/**
 * `DbosDurableExecutor.identity()` — the LIVE executor-identity read the /recovery-scope readiness
 * probe consumes. DB-FREE and deterministic: it constructs the executor but NEVER launches DBOS, so it
 * pins the SOURCE-OF-TRUTH for the probe's fail-closed arm — a not-yet-launched engine.
 *
 * DBOS facts (installed 4.21.6): `DBOS.executorID` defaults to a short constant even before launch,
 * but `DBOS.applicationVersion` is EMPTY ('') until `DBOS.launch()` sets or computes it. So a
 * not-yet-launched executor reports an empty `applicationVersion` — which the probe reads as NOT ready
 * (a consumer requiring "both fields present + non-empty, else fail-closed" fails closed against it).
 *
 * This suite runs in its OWN forked process (vitest `pool:'forks'`, `fileParallelism:false`) and never
 * launches DBOS, so the global identity stays at its pre-launch default here. It is fail-the-fix: make
 * `identity()` fabricate a non-empty `applicationVersion` and the mirror assertion goes RED; the
 * launched-engine (both-non-empty) arm is proven end-to-end in @rayspec/server's
 * durable-worker-boot.db.test.ts.
 */
import { DBOS } from '@dbos-inc/dbos-sdk';
import { describe, expect, it } from 'vitest';
import { DbosDurableExecutor } from './executor.js';

describe('DbosDurableExecutor.identity() — the not-yet-launched fail-closed source-of-truth', () => {
  it('reads the live DBOS identity; pre-launch applicationVersion is EMPTY (→ probe fails closed)', () => {
    // Precondition: DBOS has NOT been launched in this process, so its application version is empty.
    expect(DBOS.applicationVersion).toBe('');
    expect(typeof DBOS.executorID).toBe('string');
    expect(DBOS.executorID.length).toBeGreaterThan(0);

    const executor = new DbosDurableExecutor(
      {
        // A bare stub Db — identity() never touches the DB (it reads the DBOS statics only).
        db: {} as never,
        resolveRun: () => {
          throw new Error('resolveRun must not be called in this identity-only test');
        },
      },
      {
        name: 'rayspec-identity-test',
        systemDatabaseUrl: 'postgresql://localhost:5433/never_connected_dbos_sys',
      },
    );

    const id = executor.identity();
    // It MIRRORS the live DBOS statics (no fabrication) — camelCase field names.
    expect(id.executorId).toBe(DBOS.executorID);
    expect(id.applicationVersion).toBe(DBOS.applicationVersion);
    // The fail-closed signal: an empty applicationVersion on a not-yet-launched engine.
    expect(id.applicationVersion).toBe('');
    expect(id.executorId.length).toBeGreaterThan(0);

    // A readiness consumer requiring BOTH fields non-empty therefore fails closed against it.
    const bothNonEmpty = id.executorId.length > 0 && id.applicationVersion.length > 0;
    expect(bothNonEmpty).toBe(false);
  });
});
