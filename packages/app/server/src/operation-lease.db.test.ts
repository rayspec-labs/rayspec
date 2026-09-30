/**
 * The operation lease and its receipts, on GROUND TRUTH against a throwaway database.
 *
 * WHAT THESE ARMS PROVE. Two operations started at once against one environment get exactly one
 * lease; the loser is told to retry and leaves no receipt. A holder whose lease expired and was taken
 * over cannot write when it wakes up late — not a receipt, not a row of its own — because every write
 * re-checks the epoch in its own transaction. The takeover names the previous holder, and a step that
 * holder started and never finished is visible to the next one. The receipts are append-only in the
 * database itself, and an idempotency key names one operation only.
 *
 * Every arm uses separate connection pools for the two "processes", so the only thing they share is
 * the database — as two real runtime processes would.
 *
 * Skips without DATABASE_URL; the un-skippable ran-guard hard-fails a REQUIRED run that did not run.
 */
import { randomUUID } from 'node:crypto';
import { type Db, makeDb } from '@rayspec/db';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from './composition-root.js';
import {
  acquireOperationLease,
  findIntentByIdempotencyKey,
  type OperationIdentity,
  OperationLeaseError,
  readOperationReceipts,
  unfinishedSteps,
} from './operation-lease.js';

const baseUrl = process.env.DATABASE_URL;
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
let armsRan = 0;

const SUITE_DB = `rayspec_operation_lease_${process.pid}`;
const DIGEST = 'd'.repeat(64);

function withDbName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

function identity(kind: OperationIdentity['kind'] = 'runtime.apply'): OperationIdentity {
  return { operationId: randomUUID(), actor: 'operator@example.test', kind, inputsDigest: DIGEST };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!baseUrl)('the operation lease', () => {
  let dbUrl = '';
  const handles: Db[] = [];
  /** A fresh pool, as a separate process would hold. */
  function processDb(): Db {
    const db = makeDb(dbUrl, 2);
    handles.push(db);
    return db;
  }
  async function rows<T>(sqlText: string, params: unknown[] = []): Promise<T[]> {
    const client = postgres(dbUrl, { max: 1 });
    try {
      return (await client.unsafe(sqlText, params as never)) as unknown as T[];
    } finally {
      await client.end();
    }
  }
  async function probeRows(): Promise<string[]> {
    return (await rows<{ holder: string }>('SELECT holder FROM lease_probe ORDER BY holder')).map(
      (r) => r.holder,
    );
  }
  /** Force the current lease to have expired, as the passage of its lifetime would. */
  async function expireLease(): Promise<void> {
    await rows(
      "UPDATE runtime_control_state SET lease_expires_at = clock_timestamp() - interval '1 second'",
    );
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
    const setup = processDb();
    await applyMigrations(setup);
    // A table the arms write through the lease, standing in for an operation's own effect.
    await setup.$client.unsafe('CREATE TABLE lease_probe (holder text PRIMARY KEY)');
  }, 120_000);

  afterAll(async () => {
    for (const db of handles) await db.$client.end().catch(() => {});
    if (!baseUrl) return;
    const admin = postgres(withDbName(baseUrl, 'postgres'), { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  }, 60_000);

  it('two operations started at once: exactly one gets the lease, the other is told to retry', async () => {
    const a = identity();
    const b = identity();
    const results = await Promise.allSettled([
      acquireOperationLease(processDb(), a, { ttlMs: 60_000 }),
      acquireOperationLease(processDb(), b, { ttlMs: 60_000 }),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    const reason = (lost[0] as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(OperationLeaseError);
    expect(reason).toMatchObject({ code: 'RAY_LOCK_TIMEOUT', retryable: true });

    const winner = (
      won[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof acquireOperationLease>>>
    ).value;
    const loser = winner.identity.operationId === a.operationId ? b : a;
    // The intent is durable before any effect; the loser left nothing behind.
    expect(
      (await readOperationReceipts(processDb(), winner.identity.operationId)).map((r) => r.event),
    ).toEqual(['intent']);
    expect(await readOperationReceipts(processDb(), loser.operationId)).toEqual([]);
    await winner.release('succeeded');
    const events = (await readOperationReceipts(processDb(), winner.identity.operationId)).map(
      (r) => [r.event, r.outcome],
    );
    expect(events).toEqual([
      ['intent', null],
      ['outcome', 'succeeded'],
    ]);
    // Released: the next operation takes the lease at a higher epoch without a takeover.
    const next = await acquireOperationLease(processDb(), identity(), { ttlMs: 60_000 });
    expect(next.epoch).toBe(winner.epoch + 1);
    expect(next.takenOver).toBeNull();
    await next.release('succeeded');
    armsRan += 1;
  }, 60_000);

  it('a holder whose lease expired and was taken over cannot write when it wakes up late', async () => {
    const first = await acquireOperationLease(processDb(), identity(), { ttlMs: 60_000 });
    await first.mutate(async (tx) => {
      await tx.unsafe('INSERT INTO lease_probe (holder) VALUES ($1)', ['first-before-expiry']);
    });
    // A step the first holder starts and never finishes: its effect is unknown.
    await first.record({ event: 'step-started', step: 'stage-bundle' });

    // The first holder stalls past its lease; a second operation takes over.
    await expireLease();
    const second = await acquireOperationLease(processDb(), identity(), { ttlMs: 60_000 });
    expect(second.epoch).toBe(first.epoch + 1);
    expect(second.takenOver).toEqual({
      operationId: first.identity.operationId,
      kind: 'runtime.apply',
      leaseEpoch: first.epoch,
      expired: true,
    });
    const firstReceipts = await readOperationReceipts(processDb(), first.identity.operationId);
    expect(unfinishedSteps(firstReceipts)).toEqual(['stage-bundle']);
    const takeover = (await readOperationReceipts(processDb(), second.identity.operationId)).find(
      (r) => r.event === 'lease-taken-over',
    );
    expect(takeover?.detail).toMatchObject({ operationId: first.identity.operationId });

    // The first holder wakes up: every kind of write it attempts is refused, and none lands.
    const stale = { code: 'RAY_FENCE_MISMATCH', retryable: false };
    await expect(
      first.mutate(async (tx) => {
        await tx.unsafe('INSERT INTO lease_probe (holder) VALUES ($1)', ['first-after-expiry']);
      }),
    ).rejects.toMatchObject(stale);
    await expect(
      first.record({ event: 'step-finished', step: 'stage-bundle' }),
    ).rejects.toMatchObject(stale);
    await expect(first.renew(60_000)).rejects.toMatchObject(stale);
    await expect(first.release('succeeded')).rejects.toMatchObject(stale);
    expect(await probeRows()).toEqual(['first-before-expiry']);
    expect(
      unfinishedSteps(await readOperationReceipts(processDb(), first.identity.operationId)),
    ).toEqual(['stage-bundle']);

    // The current holder writes normally.
    await second.mutate(async (tx) => {
      await tx.unsafe('INSERT INTO lease_probe (holder) VALUES ($1)', ['second']);
    });
    expect(await probeRows()).toEqual(['first-before-expiry', 'second']);
    await second.release('succeeded');
    armsRan += 1;
  }, 60_000);

  it('a write that was already checking the epoch finishes before a takeover, never after it', async () => {
    const holder = await acquireOperationLease(processDb(), identity(), { ttlMs: 60_000 });
    // The holder's transaction has checked the lease and holds the state row while it writes slowly.
    let takeoverSettled = false;
    const slowWrite = holder.mutate(async (tx) => {
      await tx.unsafe('INSERT INTO lease_probe (holder) VALUES ($1)', ['slow-write']);
      // The lease runs out while the write is still in flight.
      await tx.unsafe(
        "UPDATE runtime_control_state SET lease_expires_at = clock_timestamp() - interval '1 second'",
      );
      await sleep(300);
    });
    // The takeover must wait for the in-flight write to commit: the write holds the state row.
    await sleep(50);
    const takeover = acquireOperationLease(processDb(), identity(), { ttlMs: 60_000 }).then((l) => {
      takeoverSettled = true;
      return l;
    });
    await sleep(100);
    expect(takeoverSettled).toBe(false);
    await slowWrite;
    const next = await takeover;
    expect(next.takenOver?.operationId).toBe(holder.identity.operationId);
    expect((await probeRows()).includes('slow-write')).toBe(true);
    await next.release('succeeded');
    armsRan += 1;
  }, 60_000);

  it('the same operation retried while its lease is live takes it over at a new epoch', async () => {
    const id = identity();
    const crashed = await acquireOperationLease(processDb(), id, { ttlMs: 60_000 });
    const retried = await acquireOperationLease(processDb(), id, { ttlMs: 60_000 });
    expect(retried.epoch).toBe(crashed.epoch + 1);
    expect(retried.takenOver).toMatchObject({ operationId: id.operationId, expired: false });
    await expect(crashed.mutate(async () => undefined)).rejects.toMatchObject({
      code: 'RAY_FENCE_MISMATCH',
    });
    await retried.release('succeeded');
    armsRan += 1;
  }, 60_000);

  it('a step writes a receipt before and after, and a failed step leaves only the start', async () => {
    const lease = await acquireOperationLease(processDb(), identity(), { ttlMs: 60_000 });
    const staged = await lease.step('stage-bundle', async () => ({ value: 'ok', digest: DIGEST }));
    expect(staged).toBe('ok');
    await expect(
      lease.step('apply-product-delta', async () => {
        throw new Error('the database refused the statement');
      }),
    ).rejects.toThrow('the database refused the statement');
    const receipts = await readOperationReceipts(processDb(), lease.identity.operationId);
    expect(receipts.map((r) => [r.event, r.step, r.digest])).toEqual([
      ['intent', null, null],
      ['step-started', 'stage-bundle', null],
      ['step-finished', 'stage-bundle', DIGEST],
      ['step-started', 'apply-product-delta', null],
    ]);
    for (const r of receipts) {
      expect(r).toMatchObject({
        actor: 'operator@example.test',
        operationKind: 'runtime.apply',
        leaseEpoch: lease.epoch,
        inputsDigest: DIGEST,
      });
      expect(r.recordedAt).toBeInstanceOf(Date);
    }
    expect(unfinishedSteps(receipts)).toEqual(['apply-product-delta']);
    await lease.release('failed', { step: 'apply-product-delta' });
    armsRan += 1;
  }, 60_000);

  it('a revision bump increases the environment revision in the transaction of the write', async () => {
    const before = Number(
      (
        await rows<{ r: string }>(
          'SELECT environment_revision::text AS r FROM runtime_control_state',
        )
      )[0]?.r,
    );
    const lease = await acquireOperationLease(processDb(), identity(), { ttlMs: 60_000 });
    const { environmentRevision } = await lease.mutate(async () => undefined, {
      bumpRevision: true,
    });
    expect(environmentRevision).toBe(before + 1);
    // A write that throws rolls its bump back with it.
    await expect(
      lease.mutate(
        async () => {
          throw new Error('refused');
        },
        { bumpRevision: true },
      ),
    ).rejects.toThrow('refused');
    const after = await rows<{ r: string }>(
      'SELECT environment_revision::text AS r FROM runtime_control_state',
    );
    expect(Number(after[0]?.r)).toBe(before + 1);
    await lease.release('succeeded');
    armsRan += 1;
  }, 60_000);

  it('receipts are append-only in the database, and an idempotency key names one intent', async () => {
    await expect(
      rows("UPDATE runtime_control_receipts SET actor = 'someone-else'"),
    ).rejects.toThrow(/append-only/);
    await expect(rows('DELETE FROM runtime_control_receipts')).rejects.toThrow(/append-only/);
    await expect(rows('TRUNCATE runtime_control_receipts')).rejects.toThrow(/append-only/);

    const key = 'deploy-2026-09-30-a';
    const first = await acquireOperationLease(
      processDb(),
      { ...identity(), idempotencyKey: key },
      { ttlMs: 60_000 },
    );
    expect((await findIntentByIdempotencyKey(processDb(), key))?.operationId).toBe(
      first.identity.operationId,
    );
    await first.release('succeeded');
    await expect(
      acquireOperationLease(processDb(), { ...identity(), idempotencyKey: key }, { ttlMs: 60_000 }),
    ).rejects.toThrow(/runtime_control_receipts_idempotency_idx/);
    // The refused intent rolled back with its lease: the lease is free.
    const after = await acquireOperationLease(processDb(), identity(), { ttlMs: 60_000 });
    expect(after.takenOver).toBeNull();
    await after.release('succeeded');
    armsRan += 1;
  }, 60_000);

  it('refuses malformed identities and lifetimes before touching the database', async () => {
    const db = processDb();
    await expect(
      acquireOperationLease(db, { ...identity(), operationId: 'not-a-uuid' }, { ttlMs: 1000 }),
    ).rejects.toThrow(RangeError);
    await expect(
      acquireOperationLease(db, { ...identity(), inputsDigest: 'x' }, { ttlMs: 1000 }),
    ).rejects.toThrow(RangeError);
    await expect(
      acquireOperationLease(db, { ...identity(), idempotencyKey: 'short' }, { ttlMs: 1000 }),
    ).rejects.toThrow(RangeError);
    await expect(acquireOperationLease(db, identity(), { ttlMs: 0 })).rejects.toThrow(RangeError);
    armsRan += 1;
  });
});

// The un-skippable ran-guard: a REQUIRED DB run that silently skipped is a false green.
it('DB-backed arms actually ran when the environment requires them', () => {
  if (dbRequired) expect(armsRan).toBe(8);
  else expect(true).toBe(true);
});
