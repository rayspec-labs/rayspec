/**
 * DB-backed: the tenant event bus's three statements, against a real Postgres — because every
 * property this feature sells is a property of what the database does under concurrency, and no
 * in-process fake can stand in for it.
 *
 *   1. ORDERING IS THE LOCK, NOT LUCK — while one transaction holds an unfinished append, a SECOND
 *      append for the SAME tenant cannot obtain the next number: it BLOCKS until the first commits.
 *      That is what makes allocation order equal commit order, and it is asserted directly (the
 *      second append is still pending after a wait, and completes only once the first commits).
 *   2. A CONCURRENT READER NEVER SEES A HOLE — 40 genuinely concurrent appends, with a cursor reader
 *      polling `seq > cursor` throughout: every batch it reads is CONTIGUOUS with its cursor, and it
 *      ends having seen all 40 in order. This is the resume protocol's whole invariant. Fail-the-fix:
 *      swap the counter for a `bigserial` (which hands out numbers BEFORE commit) and the reader
 *      steps over a not-yet-committed row and loses it permanently.
 *   3. GAP-FREE — a rolled-back append RETURNS its number: the next append is issued the same seq, so
 *      a hole in the visible sequence is only ever retention, never a lost write.
 *   4. CROSS-TENANT — two tenants have independent counters; neither can be advanced or read by the
 *      other, and the append has no tenant argument to point elsewhere with.
 *   5. RETENTION IS ONE TRANSACTION — with the sweep BLOCKED mid-statement, a third connection sees
 *      NEITHER the delete NOR the floor; when it completes, it sees BOTH. There is no window in which
 *      a subscriber could read "your cursor is fine" about rows that are already gone.
 *
 * Isolated per-suite schema — never `public`. Skips without DATABASE_URL; HARD-FAILS when the DB is
 * required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from './client.js';
import {
  appendTenantEvents,
  eventRetentionCutoff,
  readTenantEventStream,
  sweepTenantEvents,
} from './event-bus.js';
import { makeDbWithSchema } from './testing.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (requireDb && !hasDb) {
  throw new Error(
    'event-bus.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — ' +
      'refusing to silently skip the ordering/gap-freeness/retention proofs.',
  );
}
const describeDb = hasDb ? describe : describe.skip;

const SCHEMA = 'rayspec_test_event_bus';
const TENANT_A = '00000000-0000-0000-0000-0000000000a1';
const TENANT_B = '00000000-0000-0000-0000-0000000000b1';

/** The schema DDL — orgs (the cascade root) + the event-bus pair, mirroring migration 0011. */
const DDL = `
DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;
CREATE SCHEMA ${SCHEMA};

CREATE TABLE orgs (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant_event_streams (
  tenant_id uuid PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  last_seq bigint NOT NULL DEFAULT 0,
  truncated_through bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant_events (
  tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  seq bigint NOT NULL,
  topic text NOT NULL,
  payload jsonb NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_events_tenant_id_seq_pk PRIMARY KEY (tenant_id, seq)
);
CREATE INDEX tenant_events_at_idx ON tenant_events (at);

INSERT INTO orgs (id, name) VALUES ('${TENANT_A}', 'TenantA'), ('${TENANT_B}', 'TenantB');
`;

let db: Db;
let testsRan = 0;

/** Read one tenant's seqs in stream order (ground truth). */
async function seqsOf(tenantId: string): Promise<number[]> {
  const rows = (await db.$client.unsafe(
    'SELECT seq FROM tenant_events WHERE tenant_id = $1 ORDER BY seq',
    [tenantId],
  )) as unknown as { seq: string }[];
  return rows.map((r) => Number(r.seq));
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describeDb('tenant event bus — ordering, gap-freeness, tenancy, retention', () => {
  beforeAll(async () => {
    if (!hasDb) return;
    // A pool wide enough that "concurrent" means concurrent CONNECTIONS, not queued work on one.
    db = makeDbWithSchema(process.env.DATABASE_URL as string, SCHEMA, 12);
    await db.$client.unsafe(DDL);
  });
  beforeEach(async () => {
    if (!hasDb) return;
    await db.$client.unsafe('TRUNCATE tenant_events, tenant_event_streams');
  });
  afterAll(async () => {
    if (!hasDb) return;
    await db.$client.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await db.$client.end();
  });

  it('(1) an unfinished append BLOCKS the next one: the counter lock is held to COMMIT', async () => {
    testsRan += 1;
    // Transaction 1 appends and then WAITS — holding the counter row lock, uncommitted.
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((r) => {
      releaseFirst = r;
    });
    let firstSeq = 0;
    const first = db.transaction(async (tx) => {
      const res = await appendTenantEvents(tx as unknown as Db, TENANT_A, [
        { topic: 'first', payload: { n: 1 } },
      ]);
      firstSeq = res?.lastSeq ?? 0;
      await firstHeld;
    });

    // Wait until transaction 1 has actually allocated (it reports its seq), then start transaction 2.
    while (firstSeq === 0) await sleep(5);
    expect(firstSeq).toBe(1);

    let secondDone = false;
    const second = db
      .transaction(async (tx) =>
        appendTenantEvents(tx as unknown as Db, TENANT_A, [{ topic: 'second', payload: { n: 2 } }]),
      )
      .then((res) => {
        secondDone = true;
        return res;
      });

    // THE PROPERTY: the second append cannot take seq 2 while the holder of seq 1 is in flight. If it
    // could (a bigserial, or an allocation that did not hold a row lock), it would finish here and be
    // able to COMMIT FIRST — and a reader at cursor 0 would see 2, advance past 1, and lose it.
    await sleep(300);
    expect(secondDone).toBe(false);
    // Nothing is visible from outside either — the first transaction has not committed.
    expect(await seqsOf(TENANT_A)).toEqual([]);

    releaseFirst();
    await first;
    const secondRes = await second;
    expect(secondRes?.lastSeq).toBe(2);
    // Committed in the order the numbers were issued.
    expect(await seqsOf(TENANT_A)).toEqual([1, 2]);
  });

  it('(2) a cursor reader polling `seq > cursor` through 40 concurrent appends never sees a hole', async () => {
    testsRan += 1;
    const WAVES = 8;
    const PER_WAVE = 5;
    const TOTAL = WAVES * PER_WAVE;
    let writing = true;
    const seen: number[] = [];
    let batches = 0;
    let gapFound: string | undefined;

    // The reader: exactly what a subscriber does — read everything above its cursor, in seq order,
    // and advance. Every batch must be CONTIGUOUS with the cursor; a hole here is a frame a real
    // subscriber would never get back.
    const reader = (async () => {
      let cursor = 0;
      while (writing || cursor < TOTAL) {
        const rows = (await db.$client.unsafe(
          'SELECT seq FROM tenant_events WHERE tenant_id = $1 AND seq > $2 ORDER BY seq',
          [TENANT_A, cursor],
        )) as unknown as { seq: string }[];
        if (rows.length > 0) batches += 1;
        for (const r of rows) {
          const seq = Number(r.seq);
          if (seq !== cursor + 1) {
            gapFound ??= `read seq ${seq} at cursor ${cursor} — the reader stepped over ${cursor + 1}`;
          }
          cursor = seq;
          seen.push(seq);
        }
        await sleep(2);
      }
    })();

    // The writers: WAVES of PER_WAVE genuinely concurrent transactions, all for the SAME tenant, with
    // a small gap between waves. The concurrency inside a wave is what contends for the counter; the
    // gaps are what make the reader observe the stream INCREMENTALLY (a reader that only ever read
    // once, after everything had committed, would find no hole no matter how the numbers were issued
    // — the non-vacuity assertion below pins that).
    for (let wave = 0; wave < WAVES; wave += 1) {
      await Promise.all(
        Array.from({ length: PER_WAVE }, (_unused, i) =>
          db.transaction(async (tx) =>
            appendTenantEvents(tx as unknown as Db, TENANT_A, [
              { topic: 'load', payload: { wave, writer: i } },
            ]),
          ),
        ),
      );
      await sleep(4);
    }
    writing = false;
    await reader;

    expect(gapFound).toBeUndefined();
    // NON-VACUOUS: the reader really did follow the stream as it grew, not read it once at the end.
    expect(batches).toBeGreaterThan(1);
    // The stream is exactly 1..40 — no gap (every number was used) and no duplicate (the composite
    // primary key would have refused one, and the reader saw each exactly once).
    expect(await seqsOf(TENANT_A)).toEqual(Array.from({ length: TOTAL }, (_u, i) => i + 1));
    expect(seen).toEqual(Array.from({ length: TOTAL }, (_u, i) => i + 1));
  });

  it('(3) GAP-FREE: a rolled-back append returns its number, and the next append is issued the same seq', async () => {
    testsRan += 1;
    await db.transaction(async (tx) =>
      appendTenantEvents(tx as unknown as Db, TENANT_A, [{ topic: 'kept', payload: {} }]),
    );

    // An append inside a transaction that then FAILS.
    await expect(
      db.transaction(async (tx) => {
        await appendTenantEvents(tx as unknown as Db, TENANT_A, [{ topic: 'doomed', payload: {} }]);
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');

    const after = await db.transaction(async (tx) =>
      appendTenantEvents(tx as unknown as Db, TENANT_A, [{ topic: 'next', payload: {} }]),
    );
    // seq 2 was allocated by the doomed transaction and RETURNED — this one gets 2, not 3.
    expect(after?.lastSeq).toBe(2);
    expect(await seqsOf(TENANT_A)).toEqual([1, 2]);
    const rows = (await db.$client.unsafe(
      'SELECT topic FROM tenant_events WHERE tenant_id = $1 ORDER BY seq',
      [TENANT_A],
    )) as unknown as { topic: string }[];
    expect(rows.map((r) => r.topic)).toEqual(['kept', 'next']);
    // The counter agrees with the stream — the rollback took the bump with it.
    expect(await readTenantEventStream(db, TENANT_A)).toEqual({ lastSeq: 2, truncatedThrough: 0 });
  });

  it('(4) CROSS-TENANT: the counters are independent, and one tenant reads none of the other', async () => {
    testsRan += 1;
    await appendTenantEvents(db, TENANT_A, [
      { topic: 'a.one', payload: { t: 'a' } },
      { topic: 'a.two', payload: { t: 'a' } },
    ]);
    await appendTenantEvents(db, TENANT_B, [{ topic: 'b.one', payload: { t: 'b' } }]);

    expect(await seqsOf(TENANT_A)).toEqual([1, 2]);
    expect(await seqsOf(TENANT_B)).toEqual([1]);
    expect(await readTenantEventStream(db, TENANT_A)).toEqual({ lastSeq: 2, truncatedThrough: 0 });
    expect(await readTenantEventStream(db, TENANT_B)).toEqual({ lastSeq: 1, truncatedThrough: 0 });

    // A tenant that never emitted reports the truth (nothing issued, nothing truncated) rather than a
    // fabricated floor — the difference between "no history" and "your history is gone".
    const unknownTenant = '00000000-0000-0000-0000-0000000000c1';
    expect(await readTenantEventStream(db, unknownTenant)).toEqual({
      lastSeq: 0,
      truncatedThrough: 0,
    });
  });

  it('(5) RETENTION: the delete and the floor write are ONE transaction — no window shows one without the other', async () => {
    testsRan += 1;
    await appendTenantEvents(db, TENANT_A, [
      { topic: 'old.1', payload: {} },
      { topic: 'old.2', payload: {} },
      { topic: 'fresh', payload: {} },
    ]);
    // Age the first two rows deterministically (the append always stamps `at` with now()).
    await db.$client.unsafe(
      "UPDATE tenant_events SET at = now() - interval '48 hours' WHERE tenant_id = $1 AND seq <= 2",
      [TENANT_A],
    );

    // Hold the tenant's counter row so the sweep's statement cannot finish. It has already done its
    // DELETE inside that statement — so if the two halves were separate transactions, a reader would
    // now see the rows gone with the floor still at 0.
    let releaseLock!: () => void;
    const locked = new Promise<void>((r) => {
      releaseLock = r;
    });
    let lockHeld!: () => void;
    const lockAcquired = new Promise<void>((r) => {
      lockHeld = r;
    });
    const holder = db.transaction(async (tx) => {
      await tx.execute(
        sql`select 1 from tenant_event_streams where tenant_id = ${TENANT_A}::uuid for update`,
      );
      lockHeld();
      await locked;
    });
    await lockAcquired;

    let sweepDone = false;
    const sweep = sweepTenantEvents(db, {
      cutoff: eventRetentionCutoff(new Date(), 24),
    }).then((r) => {
      sweepDone = true;
      return r;
    });

    // A THIRD connection, mid-sweep: the world is unchanged. Both halves are still invisible.
    await sleep(300);
    expect(sweepDone).toBe(false);
    expect(await seqsOf(TENANT_A)).toEqual([1, 2, 3]);
    expect(await readTenantEventStream(db, TENANT_A)).toEqual({ lastSeq: 3, truncatedThrough: 0 });

    releaseLock();
    await holder;
    const result = await sweep;

    // Now BOTH: the aged rows are gone AND the floor names exactly how far the deletion reached.
    expect(result).toEqual({ deleted: 2, tenants: 1 });
    expect(await seqsOf(TENANT_A)).toEqual([3]);
    expect(await readTenantEventStream(db, TENANT_A)).toEqual({ lastSeq: 3, truncatedThrough: 2 });

    // A subscriber cursor BELOW the floor is detectable as a truncation; one at or above it is not.
    const { truncatedThrough } = await readTenantEventStream(db, TENANT_A);
    expect(0 < truncatedThrough).toBe(true);
    expect(2 < truncatedThrough).toBe(false);
  });

  it('(5b) RETENTION: the floor only moves FORWARD, and a second sweep with nothing to do reports nothing', async () => {
    testsRan += 1;
    await appendTenantEvents(db, TENANT_A, [{ topic: 'old', payload: {} }]);
    await db.$client.unsafe(
      "UPDATE tenant_events SET at = now() - interval '48 hours' WHERE tenant_id = $1",
      [TENANT_A],
    );
    await sweepTenantEvents(db, { cutoff: eventRetentionCutoff(new Date(), 24) });
    expect(await readTenantEventStream(db, TENANT_A)).toEqual({ lastSeq: 1, truncatedThrough: 1 });

    // A fresh event, then another sweep: nothing has aged out, so nothing is deleted and the floor
    // stays where it was (a floor that could be rewound would re-serve rows that no longer exist).
    await appendTenantEvents(db, TENANT_A, [{ topic: 'fresh', payload: {} }]);
    const second = await sweepTenantEvents(db, { cutoff: eventRetentionCutoff(new Date(), 24) });
    expect(second).toEqual({ deleted: 0, tenants: 0 });
    expect(await readTenantEventStream(db, TENANT_A)).toEqual({ lastSeq: 2, truncatedThrough: 1 });
    expect(await seqsOf(TENANT_A)).toEqual([2]);
  });

  it('(6) the batch keeps CALL ORDER and stores the payload verbatim (one statement, several rows)', async () => {
    testsRan += 1;
    const res = await appendTenantEvents(db, TENANT_A, [
      { topic: 'one', payload: { i: 1, nested: { ok: true } } },
      { topic: 'two', payload: [1, 2, 3] },
      { topic: 'three', payload: null },
    ]);
    expect(res).toEqual({ firstSeq: 1, lastSeq: 3 });
    const rows = (await db.$client.unsafe(
      'SELECT seq, topic, payload FROM tenant_events WHERE tenant_id = $1 ORDER BY seq',
      [TENANT_A],
    )) as unknown as { seq: string; topic: string; payload: unknown }[];
    expect(rows.map((r) => [Number(r.seq), r.topic])).toEqual([
      [1, 'one'],
      [2, 'two'],
      [3, 'three'],
    ]);
    expect(rows[0]?.payload).toEqual({ i: 1, nested: { ok: true } });
    expect(rows[1]?.payload).toEqual([1, 2, 3]);
    expect(rows[2]?.payload).toBeNull();
  });

  it('(7) an EMPTY batch touches nothing — an emit-free request must not advance the counter', async () => {
    testsRan += 1;
    expect(await appendTenantEvents(db, TENANT_A, [])).toBeUndefined();
    expect(await readTenantEventStream(db, TENANT_A)).toEqual({ lastSeq: 0, truncatedThrough: 0 });
  });
});

/**
 * ran-guard: a SEPARATE, non-skipped describe that fails a REQUIRED run in which the suite above did
 * not execute — a lost DATABASE_URL would otherwise turn these proofs into a silent green.
 */
describe('event-bus.db ran-guard', () => {
  it('the DB-backed proofs ran when the database was required', () => {
    if (requireDb) {
      expect(testsRan).toBe(8);
    } else {
      expect(requireDb).toBe(false);
    }
  });
});
