/**
 * Apply against a throwaway database: the checks it makes before it runs anything, the receipts it
 * writes, idempotency, and two appliers at once. The crash arms, with real child processes killed at
 * each point, are in `apply-crash.db.test.ts`.
 *
 * WHAT THESE ARMS PROVE, on ground truth (receipt rows, probe rows, the state row):
 *  1. A fresh plan applies its steps with a receipt before and after each, raises the environment
 *     revision by one, and reports a result the contract's envelope schema accepts.
 *  2. The same idempotency key returns the recorded result and runs nothing again; the same key with
 *     another plan is `RAY_IDEMPOTENCY_CONFLICT`.
 *  3. A plan made stale by an unrelated schema change, by another revision or by its expiry is
 *     `RAY_PLAN_STALE`, and nothing is written — not even an intent.
 *  4. Blockers and a held fence are `RAY_POLICY_DENIED` with their reasons.
 *  5. Two appliers with the same plan, each its own pool: exactly one applies; the other is told the
 *     lease is held, or, when it waits, that its plan went stale.
 *  6. A step that fails inside its transaction is recorded as not applied, the apply reports it, and
 *     the next apply is not blocked by it.
 *  7. An apply interrupted before its outcome is continued under its own operation id by a retry with
 *     its key, also after another apply reconciled it as interrupted; two such retries at once run the
 *     step once.
 *
 * Skips without DATABASE_URL; the ran-guard hard-fails a REQUIRED run that did not run.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { bundleError, schemaValidator } from '@rayspec/bundle-contract';
import { type Db, makeDb } from '@rayspec/db';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  control,
  liveRevision,
  markerStep,
  observers,
  probePlan,
} from './__fixtures__/apply-crash/scenario.mjs';
import { type ApplyStep, runApply } from './apply-operation.js';
import { applyMigrations } from './composition-root.js';
import { acquireOperationLease } from './operation-lease.js';

const baseUrl = process.env.DATABASE_URL;
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (dbRequired && !baseUrl) {
  throw new Error(
    'apply-operation.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — ' +
      'refusing to silently skip this DB-backed suite.',
  );
}
let armsRan = 0;

const SUITE_DB = `rayspec_apply_ops_${process.pid}`;
const validEnvelope = schemaValidator('resultEnvelope');

function withDbName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

const key = () => randomBytes(12).toString('hex');

describe.skipIf(!baseUrl)('apply', () => {
  let dbUrl = '';
  let sql: postgres.Sql;
  const handles: Db[] = [];
  function processDb(): Db {
    const db = makeDb(dbUrl, 3);
    handles.push(db);
    return db;
  }
  async function receiptCount(): Promise<number> {
    const [row] = await sql<
      { n: string }[]
    >`SELECT count(*)::text AS n FROM runtime_control_receipts`;
    return Number(row?.n);
  }
  async function markers(): Promise<string[]> {
    return (await sql<{ marker: string }[]>`SELECT marker FROM apply_probe ORDER BY marker`).map(
      (r) => r.marker,
    );
  }
  async function freshApply(db: Db, steps: ApplyStep[], label = 'probe') {
    const planDigest = await probePlan(db, label);
    return runApply({
      db,
      request: control(randomUUID(), planDigest, await liveRevision(db), key()),
      plan: { recompute: () => probePlan(db, label) },
      steps,
      observers: observers(db),
    });
  }

  beforeAll(async () => {
    if (!baseUrl) return;
    dbUrl = withDbName(baseUrl, SUITE_DB);
    const admin = postgres(withDbName(baseUrl, 'postgres'), { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE "${SUITE_DB}"`);
    } finally {
      await admin.end();
    }
    await applyMigrations(processDb());
    sql = postgres(dbUrl, { max: 2 });
    await sql`CREATE TABLE apply_probe (marker text PRIMARY KEY)`;
  }, 60_000);

  beforeEach(async () => {
    if (!baseUrl) return;
    await sql`DELETE FROM apply_probe`;
    await sql`DROP TABLE IF EXISTS unrelated_change`;
    await sql`UPDATE runtime_control_state SET fence_state = 'open' WHERE id = 1`;
  });

  afterAll(async () => {
    for (const h of handles) await h.$client.end().catch(() => {});
    await sql?.end();
    if (!baseUrl) return;
    const admin = postgres(withDbName(baseUrl, 'postgres'), { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  });

  it('applies the steps with a receipt before and after each, and raises the revision by one', async () => {
    const db = processDb();
    const before = await liveRevision(db);
    const result = await freshApply(db, [markerStep(db, 'first')]);
    expect(result.errors).toEqual([]);
    expect(validEnvelope(result)).toBe(true);
    expect(result.data?.status).toBe('applied');
    expect(result.data?.environmentRevision).toBe(before + 1);
    expect(await liveRevision(db)).toBe(before + 1);
    expect(result.data?.receipts).toEqual([
      expect.objectContaining({ step: 'mark', state: 'done', digest: null }),
    ]);
    expect(await markers()).toEqual(['first']);
    const events = await sql<{ event: string; step: string | null; outcome: string | null }[]>`
      SELECT event, step, outcome FROM runtime_control_receipts
       WHERE operation_id = ${result.operationId} ORDER BY id`;
    expect(events.map((e) => [e.event, e.step, e.outcome])).toEqual([
      ['intent', null, null],
      ['step-started', 'mark', null],
      ['step-finished', 'mark', null],
      ['outcome', null, 'succeeded'],
    ]);

    // Nothing left to do: the step is recorded as skipped, and the revision does not move.
    const again = await freshApply(db, [markerStep(db, 'second')]);
    expect(again.data?.receipts).toEqual([
      expect.objectContaining({ step: 'mark', state: 'skipped' }),
    ]);
    expect(again.data?.environmentRevision).toBe(before + 1);
    expect(await markers()).toEqual(['first']);
    armsRan += 1;
  }, 60_000);

  it('returns the recorded result for a replayed idempotency key and refuses it for another plan', async () => {
    const db = processDb();
    const planDigest = await probePlan(db, 'probe');
    const revision = await liveRevision(db);
    const idempotencyKey = key();
    const request = control(randomUUID(), planDigest, revision, idempotencyKey);
    const run = (r = request) =>
      runApply({
        db,
        request: r,
        plan: { recompute: () => probePlan(db, 'probe') },
        steps: [markerStep(db, 'once')],
        observers: observers(db),
      });
    const first = await run();
    expect(first.data?.status).toBe('applied');
    const receipts = await receiptCount();

    // The plan is stale by now (the revision moved), yet the replay answers from the record.
    const replay = await run({ ...request, operationId: randomUUID() });
    expect(replay.ok).toBe(true);
    expect(replay.data).toEqual({ ...first.data, status: 'already-applied' });
    expect(validEnvelope(replay)).toBe(true);
    expect(await markers()).toEqual(['once']);
    expect(await receiptCount()).toBe(receipts);

    const conflict = await run({ ...request, planDigest: 'e'.repeat(64) });
    expect(conflict.errors[0]).toMatchObject({ code: 'RAY_IDEMPOTENCY_CONFLICT' });
    expect(await receiptCount()).toBe(receipts);
    armsRan += 1;
  }, 60_000);

  it('refuses a plan made stale by an unrelated schema change, another revision or expiry, writing nothing', async () => {
    const db = processDb();
    const planDigest = await probePlan(db, 'probe');
    const revision = await liveRevision(db);
    const receipts = await receiptCount();
    const attempt = (over: { revision?: number; expired?: boolean } = {}) =>
      runApply({
        db,
        request: control(randomUUID(), planDigest, over.revision ?? revision, key()),
        plan: {
          recompute: () => probePlan(db, 'probe'),
          ...(over.expired ? { expired: () => true } : {}),
        },
        steps: [markerStep(db, 'stale')],
        observers: observers(db),
      });

    const expired = await attempt({ expired: true });
    expect(expired.errors[0]).toMatchObject({ code: 'RAY_PLAN_STALE', retryable: false });
    const otherRevision = await attempt({ revision: revision + 5 });
    expect(otherRevision.errors[0]).toMatchObject({ code: 'RAY_PLAN_STALE' });

    // Someone adds a table outside apply: the plan no longer describes the environment.
    await sql`CREATE TABLE unrelated_change (id int)`;
    const changed = await attempt();
    expect(changed.errors[0]).toMatchObject({ code: 'RAY_PLAN_STALE' });
    expect(changed.errors[0]?.message).toMatch(/no longer matches/);
    expect(validEnvelope(changed)).toBe(true);

    expect(await markers()).toEqual([]);
    expect(await receiptCount()).toBe(receipts);
    armsRan += 1;
  }, 60_000);

  it('refuses a plan with blockers and a fenced environment', async () => {
    const db = processDb();
    const planDigest = await probePlan(db, 'probe');
    const revision = await liveRevision(db);
    const blocked = await runApply({
      db,
      request: control(randomUUID(), planDigest, revision, key()),
      plan: {
        recompute: () => probePlan(db, 'probe'),
        blockers: [bundleError('RAY_MIGRATION_REQUIRED', 'a delta needs review')],
      },
      steps: [markerStep(db, 'blocked')],
    });
    expect(blocked.errors[0]).toMatchObject({
      code: 'RAY_POLICY_DENIED',
      reason: 'plan-has-blockers',
    });

    await sql`UPDATE runtime_control_state SET fence_state = 'fenced' WHERE id = 1`;
    const fenced = await freshApply(db, [markerStep(db, 'fenced')]);
    expect(fenced.errors[0]).toMatchObject({ code: 'RAY_POLICY_DENIED', reason: 'fenced' });
    // An apply with no step to run only reconciles, and a fence does not stop that.
    const nothing = await freshApply(db, []);
    expect(nothing.ok).toBe(true);
    expect(await markers()).toEqual([]);
    armsRan += 1;
  }, 60_000);

  it('lets exactly one of two appliers with the same plan apply', async () => {
    const a = processDb();
    const b = processDb();
    const planDigest = await probePlan(a, 'probe');
    const revision = await liveRevision(a);
    const slowMarker = (db: Db, marker: string): ApplyStep => {
      const step = markerStep(db, marker);
      return {
        ...step,
        kind: 'effect',
        run: async () => {
          await new Promise((r) => setTimeout(r, 400));
          return (step as Extract<ApplyStep, { kind: 'effect' }>).run();
        },
      };
    };
    const apply = (db: Db, marker: string, leaseWaitMs = 0) =>
      runApply({
        db,
        request: control(randomUUID(), planDigest, revision, key()),
        plan: { recompute: () => probePlan(db, 'probe') },
        steps: [slowMarker(db, marker)],
        observers: observers(db),
        leaseWaitMs,
      });

    // Without waiting: the loser is told another operation holds the lease (retryable).
    const [ra, rb] = await Promise.all([apply(a, 'a'), apply(b, 'b')]);
    const winners = [ra, rb].filter((r) => r.ok);
    const losers = [ra, rb].filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers[0]?.errors[0]).toMatchObject({ code: 'RAY_LOCK_TIMEOUT', retryable: true });
    expect(await markers()).toHaveLength(1);

    // Waiting for the lease: the second one gets it, finds its plan stale and changes nothing.
    await sql`DELETE FROM apply_probe`;
    const plan2 = await probePlan(a, 'probe');
    const rev2 = await liveRevision(a);
    const again = (db: Db, marker: string) =>
      runApply({
        db,
        request: control(randomUUID(), plan2, rev2, key()),
        plan: { recompute: () => probePlan(db, 'probe') },
        steps: [slowMarker(db, marker)],
        observers: observers(db),
        leaseWaitMs: 10_000,
      });
    const results = await Promise.all([again(a, 'a'), again(b, 'b')]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)?.errors[0]).toMatchObject({ code: 'RAY_PLAN_STALE' });
    expect(await markers()).toHaveLength(1);
    armsRan += 1;
  }, 60_000);

  it('records a step that failed inside its transaction as not applied, and does not block on it', async () => {
    const db = processDb();
    const failing: ApplyStep = {
      kind: 'transaction',
      name: 'bad-ddl',
      schemaChange: true,
      run: async (tx) => {
        await tx.unsafe('CREATE TABLE half_done (id int)');
        await tx.unsafe('CREATE TABLE half_done (id int)');
        return {};
      },
    };
    const result = await freshApply(db, [failing]);
    expect(result.errors[0]).toMatchObject({ code: 'RAY_INTERNAL' });
    const [table] = await sql<{ present: boolean }[]>`
      SELECT to_regclass('public.half_done') IS NOT NULL AS present`;
    expect(table?.present).toBe(false);
    const rows = await sql<{ event: string; outcome: string | null }[]>`
      SELECT event, outcome FROM runtime_control_receipts
       WHERE operation_id = ${result.operationId} ORDER BY id`;
    expect(rows.map((r) => r.event)).toEqual(['intent', 'step-started', 'step-skipped', 'outcome']);
    expect(rows.at(-1)?.outcome).toBe('failed');

    const next = await freshApply(db, [markerStep(db, 'after-failure')]);
    expect(next.ok).toBe(true);
    expect(await markers()).toEqual(['after-failure']);

    // A step naming an observer the caller did not pass is refused before it starts.
    await sql`DELETE FROM apply_probe`;
    const unobserved = await freshApply(db, [{ ...markerStep(db, 'x'), observer: 'missing' }]);
    expect(unobserved.errors[0]).toMatchObject({ code: 'RAY_INTERNAL' });
    expect(unobserved.errors[0]?.message).toContain('no observer named missing');
    expect((await freshApply(db, [])).ok).toBe(true);
    armsRan += 1;
  }, 60_000);

  it('continues an interrupted apply under its own id when retried with its key, once, also after reconciliation', async () => {
    const db = processDb();
    /** An apply that took the lease with key `k` and died before any step: its lease then expires. */
    async function interrupted(k: string): Promise<{ operationId: string; planDigest: string }> {
      const planDigest = await probePlan(db, 'probe');
      const operationId = randomUUID();
      await acquireOperationLease(
        db,
        {
          operationId,
          actor: 'operator:apply-crash',
          kind: 'runtime.apply',
          inputsDigest: planDigest,
          idempotencyKey: k,
        },
        { ttlMs: 60_000 },
      );
      await sql`UPDATE runtime_control_state
                   SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = 1`;
      return { operationId, planDigest };
    }
    const retry = (k: string, planDigest: string, revision: number, other = db) =>
      runApply({
        db: other,
        request: control(randomUUID(), planDigest, revision, k),
        plan: { recompute: () => probePlan(other, 'probe') },
        steps: [markerStep(other, 'continued')],
        observers: observers(other),
      });

    // Reconciled by another apply first: closed as interrupted, and still continued by its own key.
    const k1 = key();
    const first = await interrupted(k1);
    const revision = await liveRevision(db);
    const reconciling = await freshApply(db, []);
    expect(reconciling.ok).toBe(true);
    const [closed] = await sql<{ detail: { interrupted?: boolean } }[]>`
      SELECT detail FROM runtime_control_receipts
       WHERE operation_id = ${first.operationId} AND event = 'outcome'`;
    expect(closed?.detail.interrupted).toBe(true);
    const continued = await retry(k1, first.planDigest, revision);
    expect(continued.errors).toEqual([]);
    expect(continued.data?.status).toBe('applied');
    expect(await markers()).toEqual(['continued']);
    const events = await sql<{ event: string; outcome: string | null }[]>`
      SELECT event, outcome FROM runtime_control_receipts
       WHERE operation_id = ${first.operationId} ORDER BY id`;
    expect(events.at(-1)).toEqual({ event: 'outcome', outcome: 'succeeded' });
    // Replayed once more: the continued operation's result.
    expect((await retry(k1, first.planDigest, revision)).data?.status).toBe('already-applied');

    // Two retries of one interrupted apply at once: one continues it, the other waits its turn.
    await sql`DELETE FROM apply_probe`;
    const k2 = key();
    const second = await interrupted(k2);
    const rev2 = await liveRevision(db);
    const results = await Promise.all([
      retry(k2, second.planDigest, rev2, processDb()),
      retry(k2, second.planDigest, rev2, processDb()),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)?.errors[0]).toMatchObject({ code: 'RAY_LOCK_TIMEOUT' });
    expect(await markers()).toEqual(['continued']);
    const starts = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM runtime_control_receipts
       WHERE operation_id = ${second.operationId} AND event = 'step-started'`;
    expect(starts[0]?.n).toBe('1');
    armsRan += 1;
  }, 60_000);
});

// The un-skippable ran-guard: a REQUIRED DB run that silently skipped is a false green.
it('DB-backed arms actually ran when the environment requires them', () => {
  if (dbRequired) expect(armsRan).toBe(7);
  else expect(true).toBe(true);
});
