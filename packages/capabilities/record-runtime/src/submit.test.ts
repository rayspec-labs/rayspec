/**
 * The submit core — the audio durability recipe's four requirements + the payload contract,
 * proven against a fake that ENFORCES the real constraints (shared table, global unique on
 * `record_ref`, tenant-scoped DO-UPDATE — see test-support/fake-db.ts).
 */
import type { HandlerDb, StoreRow } from '@rayspec/handler-sdk';
import { describe, expect, it } from 'vitest';
import { canonicalJsonByteLength, recordPayloadHash } from './canonical-json.js';
import { type ResolvedRecordConfig, resolveRecordConfig } from './config.js';
import {
  createInMemoryRecordSubmittedSink,
  RecordEventRejectedError,
  type RecordSubmittedSink,
} from './events.js';
import type { RecordNormalizer } from './normalizer.js';
import type { RecordCoreContext } from './ports.js';
import { RECORD_SUBMISSIONS_STORE } from './stores.js';
import { submitRecord } from './submit.js';
import { makeFakeRecordDb, SharedRecordTable } from './test-support/fake-db.js';

const TENANT_A = 'tenant-aaaa';
const TENANT_B = 'tenant-bbbb';

function ctx(table: SharedRecordTable, tenantId = TENANT_A): RecordCoreContext {
  return { tenantId, db: makeFakeRecordDb(table, tenantId), config: resolveRecordConfig() };
}

/** A body of `depth` nested arrays (the HS-1 hostile shape: tiny bytes, huge recursion). */
function nestedArrays(depth: number): unknown {
  let v: unknown = 1;
  for (let i = 0; i < depth; i += 1) v = [v];
  return v;
}

/**
 * Wrap a fake db so the SECOND select (the authoritative re-read) returns a MUTATED row — the only
 * way to make the concurrent-divergent re-read branch (and the emit-stored-not-raw property)
 * OBSERVABLE in a unit test (TQ-1: every identical-body test leaves them indistinguishable).
 */
function divergeSecondSelect(inner: HandlerDb, mutate: (row: StoreRow) => StoreRow): HandlerDb {
  let selects = 0;
  return {
    ...inner,
    async select(store, filter, opts) {
      const rows = await inner.select(store, filter, opts);
      selects += 1;
      const first = rows[0];
      if (selects === 2 && first !== undefined) return [mutate({ ...first })];
      return rows;
    },
  };
}

describe('submitRecord — the durability recipe', () => {
  it('first submit PERSISTS the row (tenant-prefixed ref + canonical hash) and EMITS the record-scoped event', async () => {
    const table = new SharedRecordTable();
    const sink = createInMemoryRecordSubmittedSink();
    const body = { title: 'Fix the door', priority: 'high' };

    const result = await submitRecord(ctx(table), { record_id: 'rec-1' }, body, sink);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    // Deterministic tenant-scoped event id (requirement 1).
    expect(result.value).toEqual({
      record_id: 'rec-1',
      event_id: `${TENANT_A}:rec-1`,
      deduped: false,
    });

    // The capability-owned row: tenant-prefixed unique ref + the canonical payload hash.
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]).toMatchObject({
      record_id: 'rec-1',
      record_ref: `${TENANT_A}:rec-1`,
      payload_hash: recordPayloadHash(body),
      tenant_id: TENANT_A,
    });

    // The emitted event: envelope + the AUTHORITATIVE stored record.
    expect(sink.emitCount()).toBe(1);
    expect(sink.deliveredFor(`${TENANT_A}:rec-1`)).toMatchObject({
      event_id: `${TENANT_A}:rec-1`,
      tenant_id: TENANT_A,
      record_id: 'rec-1',
      record: body,
      source_capability: 'record_input',
    });
  });

  it('an IDENTICAL re-submit RE-EMITS the deduped event (redelivery) — one row, one delivered event (requirement 2)', async () => {
    const table = new SharedRecordTable();
    const sink = createInMemoryRecordSubmittedSink();
    const body = { title: 'Fix the door', priority: 'high' };

    const first = await submitRecord(ctx(table), { record_id: 'rec-1' }, body, sink);
    // Key-order difference is NOT a different payload (canonical hash).
    const reordered = { priority: 'high', title: 'Fix the door' };
    const second = await submitRecord(ctx(table), { record_id: 'rec-1' }, reordered, sink);

    expect(first.ok && !first.value.deduped).toBe(true);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('unreachable');
    expect(second.value.deduped).toBe(true);
    expect(second.value.event_id).toBe(`${TENANT_A}:rec-1`);

    expect(table.rows).toHaveLength(1); // ONE row (idempotent persist)
    expect(sink.emitCount()).toBe(2); // the re-submit RE-EMITTED …
    expect(sink.deliveredCount()).toBe(1); // … and the sink deduped to ONE delivery (C10)
  });

  it('a DIFFERENT payload for the same record key is a LOUD 409 — the STORED event is RE-EMITTED (the DUR-1 heal), the divergent payload never, stored row untouched (requirement 4)', async () => {
    const table = new SharedRecordTable();
    const sink = createInMemoryRecordSubmittedSink();

    await submitRecord(ctx(table), { record_id: 'rec-1' }, { title: 'v1' }, sink);
    const before = JSON.parse(JSON.stringify(table.rows));
    sink.clear();

    const divergent = await submitRecord(ctx(table), { record_id: 'rec-1' }, { title: 'v2' }, sink);
    expect(divergent.ok).toBe(false);
    if (divergent.ok) throw new Error('unreachable');
    expect(divergent.status).toBe(409);
    expect(divergent.error).toBe('record_conflict');

    // DUR-1: the 409 path re-emits the STORED authoritative event (heals a persisted-but-never-
    // enqueued record on ANY retry payload) — the losing request's payload is NEVER emitted.
    expect(sink.emitCount()).toBe(1);
    expect(sink.deliveredFor(`${TENANT_A}:rec-1`)).toMatchObject({ record: { title: 'v1' } });
    expect(JSON.parse(JSON.stringify(table.rows))).toEqual(before); // first write is authoritative
  });

  it('the tenant-prefixed ref keys PER TENANT: two tenants submit the SAME record_id and both succeed (requirement 3)', async () => {
    const table = new SharedRecordTable(); // ONE shared table = the real global unique
    const sinkA = createInMemoryRecordSubmittedSink();
    const sinkB = createInMemoryRecordSubmittedSink();

    const a = await submitRecord(ctx(table, TENANT_A), { record_id: 'rec-1' }, { v: 'a' }, sinkA);
    const b = await submitRecord(ctx(table, TENANT_B), { record_id: 'rec-1' }, { v: 'b' }, sinkB);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true); // NO cross-tenant collision (the prefix isolates — the audio pattern)
    expect(table.rows).toHaveLength(2);
    expect(new Set(table.rows.map((r) => r.record_ref))).toEqual(
      new Set([`${TENANT_A}:rec-1`, `${TENANT_B}:rec-1`]),
    );
    // Distinct tenant-scoped event ids — no shared single-flight key across tenants.
    if (!a.ok || !b.ok) throw new Error('unreachable');
    expect(a.value.event_id).not.toBe(b.value.event_id);
  });
});

describe('submitRecord — the payload contract (shape / reserved keys / size)', () => {
  it('rejects a non-object body (422 invalid_record) with zero persist + zero emit', async () => {
    const table = new SharedRecordTable();
    const sink = createInMemoryRecordSubmittedSink();
    for (const body of [null, 42, 'text', ['a']]) {
      const res = await submitRecord(ctx(table), { record_id: 'rec-1' }, body, sink);
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.status).toBe(422);
      expect(res.error).toBe('invalid_record');
    }
    expect(table.rows).toHaveLength(0);
    expect(sink.emitCount()).toBe(0);
  });

  it('rejects EVERY reserved envelope key (422 reserved_record_key, naming it) — the trust-boundary spoof guard', async () => {
    const table = new SharedRecordTable();
    const sink = createInMemoryRecordSubmittedSink();
    for (const key of ['record_id', 'tenant_id', 'source_capability']) {
      const res = await submitRecord(
        ctx(table),
        { record_id: 'rec-1' },
        { title: 'x', [key]: 'spoof' },
        sink,
      );
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.status).toBe(422);
      expect(res.error).toBe('reserved_record_key');
      expect(res.detail).toContain(`'${key}'`);
    }
    expect(table.rows).toHaveLength(0);
    expect(sink.emitCount()).toBe(0);
  });

  it('rejects an over-sized record (413 record_too_large) at the canonical-JSON byte bound', async () => {
    const table = new SharedRecordTable();
    const sink = createInMemoryRecordSubmittedSink();
    const big = { blob: 'x'.repeat(70_000) };
    const res = await submitRecord(ctx(table), { record_id: 'rec-1' }, big, sink);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.status).toBe(413);
    expect(res.error).toBe('record_too_large');
    expect(table.rows).toHaveLength(0);
    expect(sink.emitCount()).toBe(0);
  });

  it('rejects an invalid record_id shape (422 invalid_record_id)', async () => {
    const table = new SharedRecordTable();
    const sink = createInMemoryRecordSubmittedSink();
    for (const bad of ['', 'has space', 'a/b', 'x'.repeat(129)]) {
      const res = await submitRecord(ctx(table), { record_id: bad }, { t: 1 }, sink);
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.error).toBe('invalid_record_id');
    }
    expect(sink.emitCount()).toBe(0);
  });

  it('stores the record under the declared store name (fail-closed fake pins the name)', async () => {
    const table = new SharedRecordTable();
    const sink = createInMemoryRecordSubmittedSink();
    const res = await submitRecord(ctx(table), { record_id: 'rec-1' }, { t: 1 }, sink);
    expect(res.ok).toBe(true);
    expect(RECORD_SUBMISSIONS_STORE).toBe('record_submissions');
  });
});

describe('submitRecord — the nesting-depth bound (the trust boundary must not stack-overflow)', () => {
  it('a deeply-nested body (~3000 levels, ~6KB — far UNDER the byte cap) is the TYPED 422 record_too_deep, never a RangeError 500', async () => {
    const table = new SharedRecordTable();
    const sink = createInMemoryRecordSubmittedSink();
    const res = await submitRecord(
      ctx(table),
      { record_id: 'rec-1' },
      { deep: nestedArrays(3000) },
      sink,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.status).toBe(422);
    expect(res.error).toBe('record_too_deep');
    expect(table.rows).toHaveLength(0); // zero persist
    expect(sink.emitCount()).toBe(0); // zero emit
  });
});

describe('submitRecord — DUR-1: the divergent-409 heal (re-emit the STORED event; zero double-run)', () => {
  it('heals a persisted-but-NEVER-enqueued record: a divergent retry gets 409 AND the stored event reaches the sink', async () => {
    const table = new SharedRecordTable();
    const sink = createInMemoryRecordSubmittedSink();
    const storedPayload = { title: 'v1' };
    // The crash state DUR-1 names: the upsert committed, then the process died BEFORE the emit.
    table.rows.push({
      record_id: 'rec-1',
      record_ref: `${TENANT_A}:rec-1`,
      payload: storedPayload,
      payload_hash: recordPayloadHash(storedPayload),
      tenant_id: TENANT_A,
    });

    // The client retries with a CORRECTED (divergent) payload B — before the fix this was a 409
    // with ZERO emit, forever (a silent zero-run for a persisted record).
    const res = await submitRecord(ctx(table), { record_id: 'rec-1' }, { title: 'v2' }, sink);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.status).toBe(409);
    expect(res.error).toBe('record_conflict');

    // The heal: EXACTLY ONE emit, carrying the STORED payload A (never the request's B).
    expect(sink.emitCount()).toBe(1);
    expect(sink.deliveredFor(`${TENANT_A}:rec-1`)).toMatchObject({
      event_id: `${TENANT_A}:rec-1`,
      tenant_id: TENANT_A,
      record_id: 'rec-1',
      record: storedPayload,
      source_capability: 'record_input',
    });
    // The stored row is untouched (payload B did not win).
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]).toMatchObject({ payload_hash: recordPayloadHash(storedPayload) });
  });

  it('when the record WAS already enqueued, the heal re-emit DEDUPS to the same delivered event (zero double-run)', async () => {
    const table = new SharedRecordTable();
    const sink = createInMemoryRecordSubmittedSink();
    const stored = { title: 'v1' };

    const first = await submitRecord(ctx(table), { record_id: 'rec-1' }, stored, sink);
    expect(first.ok).toBe(true);
    expect(sink.deliveredCount()).toBe(1);

    const divergent = await submitRecord(ctx(table), { record_id: 'rec-1' }, { title: 'v2' }, sink);
    expect(divergent.ok).toBe(false);
    // TWO raw emits (first + heal), but the record-scoped event_id dedups to ONE delivered event —
    // the same single-flight the dispatcher's `record_id:<id>` → durableWorkflowRunId enforces.
    expect(sink.emitCount()).toBe(2);
    expect(sink.deliveredCount()).toBe(1);
    expect(sink.deliveredFor(`${TENANT_A}:rec-1`)?.record).toEqual(stored);
  });
});

describe('submitRecord — TQ-1: the authoritative re-read net (fake makes the SECOND select diverge)', () => {
  it('a concurrent DIVERGENT overwrite between upsert and re-read is a 409 record_conflict with ZERO emit', async () => {
    const table = new SharedRecordTable();
    const sink = createInMemoryRecordSubmittedSink();
    const db = divergeSecondSelect(makeFakeRecordDb(table, TENANT_A), (row) => ({
      ...row,
      payload: { hijacked: true },
      payload_hash: 'DIVERGENT-CONCURRENT-HASH',
    }));

    const res = await submitRecord(
      { tenantId: TENANT_A, db, config: resolveRecordConfig() },
      { record_id: 'rec-1' },
      { title: 'mine' },
      sink,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.status).toBe(409);
    expect(res.error).toBe('record_conflict');
    // This request's payload did not win — NOTHING is emitted for it (the winning racer emits its
    // own event on its own request path; a crashed racer is healed by the divergent-409 heal later).
    expect(sink.emitCount()).toBe(0);
  });

  it('the DELIVERED event carries the STORED row payload, never the raw request body', async () => {
    const table = new SharedRecordTable();
    const sink = createInMemoryRecordSubmittedSink();
    const storedPayload = { title: 'stored-wins' };
    // Same hash (the submit proceeds) but a DIFFERENT payload object on the re-read — the emit MUST
    // source the row (a regression to emitting the raw body is exactly what this catches).
    const db = divergeSecondSelect(makeFakeRecordDb(table, TENANT_A), (row) => ({
      ...row,
      payload: storedPayload,
    }));

    const res = await submitRecord(
      { tenantId: TENANT_A, db, config: resolveRecordConfig() },
      { record_id: 'rec-1' },
      { title: 'raw-request-body' },
      sink,
    );
    expect(res.ok).toBe(true);
    expect(sink.emitCount()).toBe(1);
    expect(sink.deliveredFor(`${TENANT_A}:rec-1`)?.record).toEqual(storedPayload);
  });
});

describe('submitRecord — TQ-2/TQ-3/HS-2 boundary + shape pins', () => {
  it('TQ-2: the size bound is the max ALLOWED — canonical length EXACTLY 65536 accepts; 65537 is the 413', async () => {
    // The cap semantics are deliberate: `maxRecordBytes` names the LARGEST accepted canonical
    // serialization ("capped at 64 KiB"; the 413 taxonomy is 'exceeds'), matching the manifest's
    // `max_record_bytes: 65536` — a record OF the cap size is legal, one byte more is not.
    const atCap = { b: 'x'.repeat(65536 - 8) }; // canonical `{"b":"…"}` = payload + 8 bytes
    expect(canonicalJsonByteLength(atCap)).toBe(65536);
    const overCap = { b: 'x'.repeat(65537 - 8) };
    expect(canonicalJsonByteLength(overCap)).toBe(65537);

    const table = new SharedRecordTable();
    const sink = createInMemoryRecordSubmittedSink();
    const ok = await submitRecord(ctx(table), { record_id: 'rec-max' }, atCap, sink);
    expect(ok.ok).toBe(true);

    const rejected = await submitRecord(ctx(table), { record_id: 'rec-over' }, overCap, sink);
    expect(rejected.ok).toBe(false);
    if (rejected.ok) throw new Error('unreachable');
    expect(rejected.status).toBe(413);
    expect(rejected.error).toBe('record_too_large');
  });

  it('TQ-3: an EMPTY body {} is a valid record — accepted, persisted, envelope-only event (deliberate: the neutral layer imposes no non-empty policy; emptiness is the product workflow’s concern)', async () => {
    const table = new SharedRecordTable();
    const sink = createInMemoryRecordSubmittedSink();
    const res = await submitRecord(ctx(table), { record_id: 'rec-empty' }, {}, sink);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.value.deduped).toBe(false);
    expect(table.rows).toHaveLength(1);
    expect(sink.deliveredFor(`${TENANT_A}:rec-empty`)).toMatchObject({
      record: {},
      record_id: 'rec-empty',
    });
  });

  it('TQ-3: a record_id of EXACTLY 128 chars accepts; a unicode record_id rejects (ASCII-only default shape)', async () => {
    const table = new SharedRecordTable();
    const sink = createInMemoryRecordSubmittedSink();

    const max = await submitRecord(ctx(table), { record_id: 'a'.repeat(128) }, { t: 1 }, sink);
    expect(max.ok).toBe(true);

    for (const unicodeId of ['rëc-1', 'レコード']) {
      const res = await submitRecord(ctx(table), { record_id: unicodeId }, { t: 1 }, sink);
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.status).toBe(422);
      expect(res.error).toBe('invalid_record_id');
    }
  });

  it("HS-2: a record_id containing ':' is rejected at the point of use EVEN IF a (resolver-bypassing) pattern admits it — the record_ref/event-id delimiter is structural", async () => {
    const table = new SharedRecordTable();
    const sink = createInMemoryRecordSubmittedSink();
    // A hand-built ResolvedRecordConfig bypasses resolveRecordConfig's construction-time validation
    // (which rejects such an override loudly) — the runtime belt must STILL hold.
    const config: ResolvedRecordConfig = {
      recordIdPattern: /^[a-z:-]{1,64}$/,
      maxRecordBytes: 65536,
    };
    const res = await submitRecord(
      { tenantId: TENANT_A, db: makeFakeRecordDb(table, TENANT_A), config },
      { record_id: 'a:b' },
      { t: 1 },
      sink,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.status).toBe(422);
    expect(res.error).toBe('invalid_record_id');
    expect(table.rows).toHaveLength(0);
    expect(sink.emitCount()).toBe(0);
  });
});

/**
 * A sink whose `emit` ALWAYS throws — models a downstream fault on a re-emit path. `toThrow` is
 * either a GENERIC transient fault (sink/DBOS unavailable) or a DELIBERATE fail-closed rejection
 * (`RecordEventRejectedError` / a subclass — the workflow bridge's cross-tenant assertion).
 */
class ThrowingSink implements RecordSubmittedSink {
  emitCount = 0;
  constructor(private readonly toThrow: Error) {}
  async emit(): Promise<void> {
    this.emitCount += 1;
    throw this.toThrow;
  }
}

/**
 * A local stand-in for the workflow bridge's `CrossTenantRecordEventError` (which
 * `extends RecordEventRejectedError`). record-runtime must NOT depend on record-workflow-bridge, so
 * we mirror the class relationship here to prove the `instanceof RecordEventRejectedError`
 * discriminator catches SUBCLASS instances too (a foreign-tenant divergent submit is a 403).
 */
class FakeCrossTenantError extends RecordEventRejectedError {
  constructor() {
    super('cross_tenant', 'the record_submitted event targets a foreign tenant (fail-closed).');
    this.name = 'FakeCrossTenantError';
  }
}

/** Seed the DUR-1 crash state: a row a prior submit persisted (upsert committed, process died
 * BEFORE the emit) — the deterministic way to reach the found-divergent 409 heal and the
 * identical-redelivery re-emit paths in a unit test. */
function seedRow(
  table: SharedRecordTable,
  payload: Record<string, unknown>,
  recordId = 'rec-1',
): void {
  table.rows.push({
    record_id: recordId,
    record_ref: `${TENANT_A}:${recordId}`,
    payload,
    payload_hash: recordPayloadHash(payload),
    tenant_id: TENANT_A,
  });
}

describe('submitRecord — REG-1: the divergent-409 heal re-emit is BEST-EFFORT (a transient sink fault must not turn the deterministic 409 into a 500; the fail-closed cross-tenant class STILL 403s)', () => {
  it('a divergent re-submit against a persisted record with a THROWING (generic transient) sink STILL returns 409 record_conflict — never a propagated 500', async () => {
    const table = new SharedRecordTable();
    seedRow(table, { title: 'v1' });
    const sink = new ThrowingSink(new Error('DBOS enqueue unavailable (transient)'));

    // Before the fix the unconditional `await sink.emit(...)` on the 409 path RETHROWS this generic
    // fault → the handler maps it to a 500 (a retrying client on a PERMANENT conflict → 500 storm).
    const res = await submitRecord(ctx(table), { record_id: 'rec-1' }, { title: 'v2' }, sink);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.status).toBe(409);
    expect(res.error).toBe('record_conflict');
    expect(sink.emitCount).toBe(1); // the heal WAS attempted (then swallowed best-effort)
  });

  it('PRESERVES fail-closed: a divergent re-submit whose sink throws RecordEventRejectedError PROPAGATES (the binding maps it to 403 — never a swallowed 409)', async () => {
    const table = new SharedRecordTable();
    seedRow(table, { title: 'v1' });
    const sink = new ThrowingSink(new RecordEventRejectedError('cross_tenant', 'foreign tenant'));

    await expect(
      submitRecord(ctx(table), { record_id: 'rec-1' }, { title: 'v2' }, sink),
    ).rejects.toBeInstanceOf(RecordEventRejectedError);
  });

  it('PRESERVES fail-closed for the SUBCLASS: a CrossTenantRecordEventError-shaped throw (extends RecordEventRejectedError) ALSO propagates on the 409 heal path (403, not a swallowed 409)', async () => {
    const table = new SharedRecordTable();
    seedRow(table, { title: 'v1' });
    const sink = new ThrowingSink(new FakeCrossTenantError());

    await expect(
      submitRecord(ctx(table), { record_id: 'rec-1' }, { title: 'v2' }, sink),
    ).rejects.toBeInstanceOf(RecordEventRejectedError);
  });

  it('DECISION (documented): the IDENTICAL-redelivery re-emit is DELIBERATELY NOT best-effort — it is the DUR-1 crash-recovery mechanism, so a transient sink fault SURFACES (propagates) to keep the client retrying until the record is enqueued (swallowing it would re-open the silent zero-run the heal exists to prevent)', async () => {
    const table = new SharedRecordTable();
    seedRow(table, { title: 'v1' });
    const sink = new ThrowingSink(new Error('DBOS enqueue unavailable (transient)'));

    await expect(
      submitRecord(ctx(table), { record_id: 'rec-1' }, { title: 'v1' }, sink),
    ).rejects.toThrow('DBOS enqueue unavailable');
  });

  it('the FIRST-submit (primary enqueue) emit is NOT best-effort either: a transient sink fault SURFACES so the client retries (the row persisted; the retry heals it)', async () => {
    const table = new SharedRecordTable();
    const sink = new ThrowingSink(new Error('DBOS enqueue unavailable (transient)'));

    await expect(
      submitRecord(ctx(table), { record_id: 'rec-new' }, { title: 'first' }, sink),
    ).rejects.toThrow('DBOS enqueue unavailable');
    expect(table.rows).toHaveLength(1); // the non-atomic persist committed; the retry re-emits
  });
});

/**
 * A deterministic fake normalizer that reproduces the REAL `RecordNormalizer` port contract (not a
 * stub that bypasses the path): it transforms the raw record and returns the neutral outcome the
 * binding threads. `upcaseNormalizer` upper-cases a `title` field + stamps `normalized: true`.
 */
function upcaseNormalizer(): RecordNormalizer {
  return {
    agentId: 'field_normalizer',
    async normalize({ record }) {
      const title = typeof record.title === 'string' ? record.title.toUpperCase() : record.title;
      return { status: 'normalized', record: { ...record, title, normalized: true } };
    },
  };
}

describe('submitRecord — the OPTIONAL declared input-normalize step', () => {
  it('transforms the record BEFORE persist: the STORED row AND the emitted event carry the NORMALIZED value, never the raw input', async () => {
    const table = new SharedRecordTable();
    const sink = createInMemoryRecordSubmittedSink();
    const raw = { title: 'fix the door', priority: 'high' };

    const result = await submitRecord(
      ctx(table),
      { record_id: 'rec-1' },
      raw,
      sink,
      upcaseNormalizer(),
    );
    expect(result.ok).toBe(true);

    const normalized = { title: 'FIX THE DOOR', priority: 'high', normalized: true };
    // The STORED payload is the NORMALIZED value (title upper-cased + the stamp) — NOT the raw body.
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]?.payload).toEqual(normalized);
    // payload_hash stays the RAW-input hash — the idempotency identity is the submitted input.
    expect(table.rows[0]?.payload_hash).toBe(recordPayloadHash(raw));
    // The emitted event sources the STORED (normalized) row (authoritative re-read).
    expect(sink.deliveredFor(`${TENANT_A}:rec-1`)?.record).toEqual(normalized);
  });

  it('a normalize step that returns an error REJECTS the submit fail-closed (502 record_normalize_failed) — nothing persisted, nothing emitted', async () => {
    const table = new SharedRecordTable();
    const sink = createInMemoryRecordSubmittedSink();
    const failing: RecordNormalizer = {
      agentId: 'x',
      async normalize() {
        return { status: 'error', errorClass: 'upstream_5xx', message: 'model unavailable' };
      },
    };

    const res = await submitRecord(
      ctx(table),
      { record_id: 'rec-1' },
      { title: 'x' },
      sink,
      failing,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.status).toBe(502);
    expect(res.error).toBe('record_normalize_failed');
    expect(res.detail).toContain('upstream_5xx');
    expect(table.rows).toHaveLength(0);
    expect(sink.emitCount()).toBe(0);
  });

  it('a normalize step that THROWS is caught fail-closed (502 record_normalize_failed) — nothing persisted, nothing emitted', async () => {
    const table = new SharedRecordTable();
    const sink = createInMemoryRecordSubmittedSink();
    const throwing: RecordNormalizer = {
      agentId: 'x',
      async normalize() {
        throw new Error('socket hang up');
      },
    };

    const res = await submitRecord(
      ctx(table),
      { record_id: 'rec-1' },
      { title: 'x' },
      sink,
      throwing,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.status).toBe(502);
    expect(res.error).toBe('record_normalize_failed');
    expect(table.rows).toHaveLength(0);
    expect(sink.emitCount()).toBe(0);
  });

  it('a normalize OUTPUT carrying a reserved envelope key is rejected (502 record_normalize_invalid_output, naming it) — nothing persisted', async () => {
    const table = new SharedRecordTable();
    const sink = createInMemoryRecordSubmittedSink();
    const spoofing: RecordNormalizer = {
      agentId: 'x',
      async normalize({ record }) {
        return { status: 'normalized', record: { ...record, tenant_id: 'spoof' } };
      },
    };

    const res = await submitRecord(
      ctx(table),
      { record_id: 'rec-1' },
      { title: 'x' },
      sink,
      spoofing,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.status).toBe(502);
    expect(res.error).toBe('record_normalize_invalid_output');
    expect(res.detail).toContain('tenant_id');
    expect(table.rows).toHaveLength(0);
    expect(sink.emitCount()).toBe(0);
  });

  it('a normalize OUTPUT that is a non-object OR exceeds the byte bound is rejected (502 record_normalize_invalid_output) — nothing persisted', async () => {
    const table = new SharedRecordTable();
    const sink = createInMemoryRecordSubmittedSink();

    const nonObject: RecordNormalizer = {
      agentId: 'x',
      async normalize() {
        return { status: 'normalized', record: ['not', 'an', 'object'] as never };
      },
    };
    const r1 = await submitRecord(ctx(table), { record_id: 'rec-1' }, { t: 1 }, sink, nonObject);
    expect(r1.ok).toBe(false);
    if (r1.ok) throw new Error('unreachable');
    expect(r1.status).toBe(502);
    expect(r1.error).toBe('record_normalize_invalid_output');

    const oversize: RecordNormalizer = {
      agentId: 'x',
      async normalize() {
        return { status: 'normalized', record: { blob: 'x'.repeat(70_000) } };
      },
    };
    const r2 = await submitRecord(ctx(table), { record_id: 'rec-2' }, { t: 1 }, sink, oversize);
    expect(r2.ok).toBe(false);
    if (r2.ok) throw new Error('unreachable');
    expect(r2.status).toBe(502);
    expect(r2.error).toBe('record_normalize_invalid_output');

    expect(table.rows).toHaveLength(0);
    expect(sink.emitCount()).toBe(0);
  });

  it('ADDITIVE: WITHOUT a normalizer the raw record is stored + emitted unchanged (byte-identical to no normalize)', async () => {
    const table = new SharedRecordTable();
    const sink = createInMemoryRecordSubmittedSink();
    const body = { title: 'fix the door', priority: 'high' };

    const res = await submitRecord(ctx(table), { record_id: 'rec-1' }, body, sink); // no normalizer
    expect(res.ok).toBe(true);
    expect(table.rows[0]?.payload).toEqual(body); // stored raw, not transformed
    expect(sink.deliveredFor(`${TENANT_A}:rec-1`)?.record).toEqual(body);
  });

  it('a re-submit does NOT re-run the (possibly non-deterministic) normalize step: it re-emits the ALREADY-normalized stored row (idempotency keys on the RAW input)', async () => {
    const table = new SharedRecordTable();
    const sink = createInMemoryRecordSubmittedSink();
    let calls = 0;
    // A NON-deterministic transform: it stamps the call ordinal, so a re-run WOULD diverge — the fake
    // reproduces the real hazard the first-persist-only design defends against.
    const counting: RecordNormalizer = {
      agentId: 'x',
      async normalize({ record }) {
        calls += 1;
        return { status: 'normalized', record: { ...record, run: calls } };
      },
    };
    const body = { title: 'fix' };

    const first = await submitRecord(ctx(table), { record_id: 'rec-1' }, body, sink, counting);
    expect(first.ok).toBe(true);
    const second = await submitRecord(ctx(table), { record_id: 'rec-1' }, body, sink, counting);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('unreachable');

    // Normalize ran EXACTLY ONCE — the re-submit converged on the found-path and skipped it.
    expect(calls).toBe(1);
    expect(second.value.deduped).toBe(true);
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]?.payload).toEqual({ title: 'fix', run: 1 }); // the first normalized value stands
    // ONE delivered event (redelivery), carrying the SAME stored normalized row.
    expect(sink.deliveredCount()).toBe(1);
    expect(sink.deliveredFor(`${TENANT_A}:rec-1`)?.record).toEqual({ title: 'fix', run: 1 });
  });
});
