/**
 * DB-backed: the SUBSCRIBER'S read — `readTenantEventPage` — against a real Postgres.
 *
 * This function exists because the obvious implementation of a resume protocol is wrong in a way that
 * no unit test finds: read the retention floor, decide the cursor is fine, then read the rows. The
 * sweep runs between the two reads, and the subscriber is told everything is well while receiving a
 * stream with a hole in it — no error, no signal, nothing to retry. So the floor and the rows must
 * come from ONE statement, and that is what is measured here rather than asserted in a comment.
 *
 *   1. R1 — ONE SNAPSHOT, UNDER A LIVE SWEEP. A reader loops while retention repeatedly deletes and
 *      raises the floor underneath it. On EVERY observation the first surviving row is exactly
 *      `truncatedThrough + 1`. A two-read implementation produces an observation where the floor says
 *      0 and the rows start at 21 — the reproduced silent-hole path — and this assertion catches it.
 *   2. R1, THE HELD-TRANSACTION VIEW: with a sweep open but uncommitted, a page read sees NEITHER the
 *      delete nor the floor; after it commits, it sees BOTH. There is no window showing one alone.
 *   3. THE FILTERED CURSOR ADVANCES. A topic filter reports how far it SCANNED, not just what it
 *      delivered — otherwise a subscriber filtering a quiet topic re-scans the same window forever.
 *   4. AN OMITTED FILTER MEANS EVERY TOPIC, and an EMPTY one is refused rather than served as a
 *      permanently silent stream.
 *   5. THE HEAD PROBE reads the counter row without moving any rows across the wire.
 *   6. CROSS-TENANT: a page read is bound to its tenant and cannot return another's rows.
 *
 * Isolated per-suite schema — never `public`. Skips without DATABASE_URL; HARD-FAILS when the DB is
 * required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from './client.js';
import {
  appendTenantEvents,
  eventRetentionCutoff,
  readTenantEventPage,
  sweepTenantEvents,
} from './event-bus.js';
import { makeDbWithSchema } from './testing.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (requireDb && !hasDb) {
  throw new Error(
    'event-bus-read.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — ' +
      'refusing to silently skip the one-snapshot resume proofs.',
  );
}
const describeDb = hasDb ? describe : describe.skip;

const SCHEMA = 'rayspec_test_event_bus_read';
const TENANT_A = '00000000-0000-0000-0000-0000000000a2';
const TENANT_B = '00000000-0000-0000-0000-0000000000b2';

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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Append `n` events on `topic`, one per call, so each takes its own seq. */
async function seed(tenantId: string, n: number, topic = 'seeded'): Promise<void> {
  await appendTenantEvents(
    db,
    tenantId,
    Array.from({ length: n }, (_, i) => ({ topic, payload: { i: i + 1 } })),
  );
}

/** Age everything at or below `throughSeq` past the retention window (the append stamps now()). */
async function age(tenantId: string, throughSeq: number): Promise<void> {
  await db.$client.unsafe(
    "UPDATE tenant_events SET at = now() - interval '48 hours' WHERE tenant_id = $1 AND seq <= $2",
    [tenantId, String(throughSeq)],
  );
}

describeDb('tenant event bus — the subscriber read is ONE snapshot', () => {
  beforeAll(async () => {
    if (!hasDb) return;
    // Wide enough that "concurrent" means concurrent CONNECTIONS, not queued work on one.
    db = makeDbWithSchema(process.env.DATABASE_URL as string, SCHEMA, 8);
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

  it('(1) R1: under a LIVE sweep, the floor and the rows never disagree', async () => {
    testsRan += 1;
    await seed(TENANT_A, 40);

    // Retention, running for real and repeatedly, WHILE the reader below is mid-flight: four rounds,
    // each aging ten more events and sweeping them with the same statement the cleanup arm drives.
    let sweeping = true;
    const sweeper = (async () => {
      for (const through of [10, 20, 30, 35]) {
        await age(TENANT_A, through);
        await sweepTenantEvents(db, { cutoff: eventRetentionCutoff(new Date(), 24) });
        await sleep(15);
      }
      sweeping = false;
    })();

    const floorsSeen = new Set<number>();
    let violation: string | undefined;
    let observations = 0;
    while (sweeping || observations < 40) {
      const page = await readTenantEventPage(db, TENANT_A, { after: 0, limit: 100 });
      observations += 1;
      floorsSeen.add(page.truncatedThrough);
      // THE INVARIANT. The stream is gap-free, so from cursor 0 the FIRST surviving row is always the
      // one just above the floor. If the floor and the rows came from different snapshots, an
      // observation would report a floor of 0 alongside rows starting at 21 — "your cursor is fine"
      // about events that are already gone.
      const first = page.events[0]?.seq;
      if (first !== undefined && first !== page.truncatedThrough + 1) {
        violation = `floor=${page.truncatedThrough} but the first surviving row is ${first}`;
        break;
      }
      // The head is never below the floor either — both come off the same counter row.
      if (page.lastSeq < page.truncatedThrough) {
        violation = `head=${page.lastSeq} is below floor=${page.truncatedThrough}`;
        break;
      }
    }
    await sweeper;

    expect(violation).toBeUndefined();
    // …and the race was real: the reader observed the floor at several different values, so these
    // observations genuinely straddled the sweeps rather than all landing before or after them.
    expect(floorsSeen.size).toBeGreaterThan(1);
    expect(Math.max(...floorsSeen)).toBe(35);
  });

  it('(2) R1: with a sweep OPEN but uncommitted, a page read sees NEITHER the delete NOR the floor', async () => {
    testsRan += 1;
    await seed(TENANT_A, 5);
    await age(TENANT_A, 3);

    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let swept = false;
    const sweeping = db
      .transaction(async (tx) => {
        await sweepTenantEvents(tx as unknown as Db, {
          cutoff: eventRetentionCutoff(new Date(), 24),
        });
        await held;
      })
      .then(() => {
        swept = true;
      });

    await sleep(150);
    expect(swept).toBe(false);
    // From outside the open transaction: the pre-sweep world, whole and self-consistent.
    const during = await readTenantEventPage(db, TENANT_A, { after: 0, limit: 100 });
    expect(during.truncatedThrough).toBe(0);
    expect(during.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);

    release();
    await sweeping;

    // …and afterwards, BOTH halves at once. There was never a view carrying one without the other.
    const after = await readTenantEventPage(db, TENANT_A, { after: 0, limit: 100 });
    expect(after.truncatedThrough).toBe(3);
    expect(after.events.map((e) => e.seq)).toEqual([4, 5]);
    expect(after.lastSeq).toBe(5);
  });

  it('(3) a topic filter reports how far it SCANNED, not just what it delivered', async () => {
    testsRan += 1;
    await appendTenantEvents(db, TENANT_A, [
      { topic: 'wanted', payload: 1 },
      { topic: 'noise', payload: 2 },
      { topic: 'noise', payload: 3 },
      { topic: 'noise', payload: 4 },
    ]);

    // A window of 3 rows of which only the first matches: the cursor must still advance to 3, or a
    // subscriber filtering a quiet topic would re-read this same window until the stream closed.
    const page = await readTenantEventPage(db, TENANT_A, {
      after: 0,
      limit: 3,
      topics: ['wanted'],
    });
    expect(page.events.map((e) => e.seq)).toEqual([1]);
    expect(page.scannedThrough).toBe(3);
    expect(page.lastSeq).toBe(4);

    // A window with NO match at all still advances — the case where the naive implementation stalls.
    const none = await readTenantEventPage(db, TENANT_A, {
      after: 1,
      limit: 3,
      topics: ['wanted'],
    });
    expect(none.events).toEqual([]);
    expect(none.scannedThrough).toBe(4);
  });

  it('(4) an OMITTED filter means every topic; an EMPTY one is refused', async () => {
    testsRan += 1;
    await appendTenantEvents(db, TENANT_A, [
      { topic: 'alpha', payload: 1 },
      { topic: 'beta', payload: 2 },
    ]);

    const all = await readTenantEventPage(db, TENANT_A, { after: 0, limit: 10 });
    expect(all.events.map((e) => e.topic)).toEqual(['alpha', 'beta']);

    const some = await readTenantEventPage(db, TENANT_A, {
      after: 0,
      limit: 10,
      topics: ['beta'],
    });
    expect(some.events.map((e) => e.topic)).toEqual(['beta']);

    // An empty filter can only ever match nothing, which is indistinguishable from a healthy quiet
    // stream. Refused here rather than served (the HTTP surface refuses it as a 400 before this).
    await expect(
      readTenantEventPage(db, TENANT_A, { after: 0, limit: 10, topics: [] }),
    ).rejects.toThrow(/EMPTY array/);
  });

  it('(5) the head probe reports the counter row without moving rows', async () => {
    testsRan += 1;
    await seed(TENANT_A, 7);
    const head = await readTenantEventPage(db, TENANT_A, { after: 0, limit: 0 });
    expect(head.lastSeq).toBe(7);
    expect(head.truncatedThrough).toBe(0);
    expect(head.events).toEqual([]);

    // A tenant that has never emitted has no counter row: reported as the truth (nothing issued,
    // nothing truncated), never a fabricated floor.
    const virgin = await readTenantEventPage(db, TENANT_B, { after: 0, limit: 10 });
    expect(virgin).toEqual({ lastSeq: 0, truncatedThrough: 0, scannedThrough: 0, events: [] });
  });

  it('(6) a page read is bound to its tenant — another tenant’s rows are unreachable', async () => {
    testsRan += 1;
    await appendTenantEvents(db, TENANT_A, [{ topic: 'a.private', payload: { owner: 'A' } }]);
    await appendTenantEvents(db, TENANT_B, [{ topic: 'b.private', payload: { owner: 'B' } }]);

    const a = await readTenantEventPage(db, TENANT_A, { after: 0, limit: 100 });
    const b = await readTenantEventPage(db, TENANT_B, { after: 0, limit: 100 });
    expect(a.events.map((e) => e.topic)).toEqual(['a.private']);
    expect(b.events.map((e) => e.topic)).toEqual(['b.private']);
    // Both streams count from 1 — the sequences are per-tenant, so a cursor is meaningless without
    // the tenant it belongs to (which is why the HTTP cursor carries one).
    expect(a.events[0]?.seq).toBe(1);
    expect(b.events[0]?.seq).toBe(1);
  });
});

/**
 * ran-guard: a SEPARATE, non-skipped describe that fails a REQUIRED run in which the suite above did
 * not execute — a lost DATABASE_URL would otherwise turn these proofs into a silent green.
 */
describe('event-bus-read.db ran-guard', () => {
  it('the DB-backed proofs ran when the database was required', () => {
    if (requireDb) {
      expect(testsRan).toBe(6);
    } else {
      expect(requireDb).toBe(false);
    }
  });
});
