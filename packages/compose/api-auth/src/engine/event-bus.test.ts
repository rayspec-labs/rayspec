/**
 * `makeTenantEventBus` — the capability's own contract, unit-level (no DB, no HTTP).
 *
 * What this pins is everything that happens BEFORE the statement: the refusals, the buffering, and
 * the tenant binding. The statement itself — ordering, gap-freeness, retention — is proven against a
 * real Postgres in @rayspec/db's event-bus.db.test.ts, and the end-to-end route seam in
 * route-handler-emit.db.test.ts.
 *
 *   - a mis-call in the shape the sibling `init.enqueue` takes is REFUSED, naming the positional form;
 *   - a payload that cannot be JSON-serialized is refused AT THE CALL, not later inside the engine —
 *     BOTH of `JSON.stringify`'s failure modes: the one that throws (circular, BigInt) and the one
 *     that silently returns `undefined` (a function, a symbol, a `toJSON()` returning undefined);
 *   - a route handler's emits BUFFER: N calls, ONE write, in call order;
 *   - an emit AFTER the flush (a streaming producer, which runs once the transaction is gone) is
 *     refused rather than dropped — a lost event may not be this capability's own failure mode;
 *   - a tool's emit is IMMEDIATE (one write per call);
 *   - every write goes to the TenantDb handed in — the capability has no tenant argument at all.
 */
import { ApiError } from '@rayspec/auth-core';
import type { TenantDb, TenantEventAppendResult, TenantEventInput } from '@rayspec/db';
import { describe, expect, it } from 'vitest';
import { makeTenantEventBus } from './event-bus.js';

const TENANT = '00000000-0000-0000-0000-0000000000aa';

/** A TenantDb stub that records the batches `appendEvents` was called with. */
function fakeTdb(tenantId = TENANT): TenantDb & { readonly batches: TenantEventInput[][] } {
  const batches: TenantEventInput[][] = [];
  const stub = {
    tenantId,
    batches,
    appendEvents: async (
      events: readonly TenantEventInput[],
    ): Promise<TenantEventAppendResult | undefined> => {
      batches.push([...events]);
      return { firstSeq: 1, lastSeq: events.length };
    },
  };
  return stub as unknown as TenantDb & { readonly batches: TenantEventInput[][] };
}

describe('init.emit — the fail-closed refusals', () => {
  it('an object where the topic belongs is refused, naming the positional form and the enqueue confusion', async () => {
    const tdb = fakeTdb();
    const { emit } = makeTenantEventBus().buffered(tdb);
    const call = (emit as unknown as (...args: unknown[]) => Promise<void>)({
      topic: 'note.created',
      payload: { id: 1 },
    });
    await expect(call).rejects.toBeInstanceOf(ApiError);
    await expect(call).rejects.toMatchObject({ code: 'INTERNAL' });
    const err = await call.catch((e: ApiError) => e);
    expect(err.message).toContain('init.emit');
    expect(err.message).toContain('emit(topic, payload)');
    expect(err.message).toContain('init.enqueue');
    // Fail-the-fix: unguarded, the object would stringify into the topic column and the stream would
    // fill with `[object Object]` rows — nothing written here at all.
    expect(tdb.batches).toEqual([]);
  });

  it('an empty or whitespace-only topic is refused (nothing can subscribe to it)', async () => {
    const tdb = fakeTdb();
    const { emit } = makeTenantEventBus().buffered(tdb);
    await expect(emit('', {})).rejects.toBeInstanceOf(ApiError);
    await expect(emit('   ', {})).rejects.toBeInstanceOf(ApiError);
    expect(tdb.batches).toEqual([]);
  });

  it('a topic carrying a LINE BREAK is refused — a subscriber could never be sent it', async () => {
    // Fail-the-fix: a subscriber receives the topic as the SSE `event:` field, whose grammar has no
    // representation for a line break. Stored, such a row cannot be written as a frame at all — the
    // stream dies on it, and every reconnect resuming from the cursor in front of it dies on it
    // again, so ONE row would silence that tenant permanently. It is also the only place an author's
    // data could write SSE FIELDS rather than a field value.
    const tdb = fakeTdb();
    const { emit } = makeTenantEventBus().buffered(tdb);
    for (const topic of ['note\ncreated', 'note\r\ncreated', 'x\nid: forged\ndata: forged']) {
      const err = await emit(topic, { id: 1 }).catch((e: ApiError) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err.message).toContain('WITHOUT a line break');
    }
    expect(tdb.batches).toEqual([]);
  });

  it('a payload that cannot be JSON-serialized is refused AT THE CALL, not inside the engine later', async () => {
    const tdb = fakeTdb();
    const { emit, flush } = makeTenantEventBus().buffered(tdb);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const err = await emit('note.created', circular).catch((e: ApiError) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toContain('JSON-serializable payload');
    // The refusal happened at the handler's call site, so the flush has nothing to fail on.
    await flush();
    expect(tdb.batches).toEqual([]);
  });

  it('a payload whose JSON form is `undefined` (function / symbol / toJSON→undefined) is refused too', async () => {
    // The SILENT half of the same fault, and the one a `try { JSON.stringify(p) } catch` guard misses
    // entirely: `JSON.stringify(() => {})` returns `undefined` WITHOUT throwing. Fail-the-fix — accept
    // any of these and the engine's batch omits the payload key, `payload jsonb NOT NULL` rejects the
    // row inside the flush, and the whole route transaction (the handler's own writes included) rolls
    // back as an anonymous 500: exactly the outcome this guard exists to prevent.
    const noJsonForm: readonly [string, unknown][] = [
      ['function', () => 'not serializable'],
      ['symbol', Symbol('nope')],
      ['toJSON→undefined', { toJSON: () => undefined }],
    ];
    for (const [label, payload] of noJsonForm) {
      const tdb = fakeTdb();
      const { emit, flush } = makeTenantEventBus().buffered(tdb);
      const err = await emit(`note.created.${label}`, payload).catch((e: ApiError) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).message).toContain('init.emit');
      expect((err as ApiError).message).toContain('JSON-serializable payload');
      expect((err as ApiError).message).toContain('no JSON form');
      await flush();
      // The topic names the case, so a regression points at the payload class that got through.
      expect({ [label]: tdb.batches }).toEqual({ [label]: [] });
    }
  });
});

describe('init.emit — the BUFFERED (route) form', () => {
  it('three calls become ONE write, in call order, on the handle it was built from', async () => {
    const tdb = fakeTdb();
    const { emit, flush } = makeTenantEventBus().buffered(tdb);
    await emit('one', { i: 1 });
    await emit('two', { i: 2 });
    await emit('three', { i: 3 });
    // Nothing written yet — the events are held until the transaction boundary.
    expect(tdb.batches).toEqual([]);
    await flush();
    expect(tdb.batches).toEqual([
      [
        { topic: 'one', payload: { i: 1 } },
        { topic: 'two', payload: { i: 2 } },
        { topic: 'three', payload: { i: 3 } },
      ],
    ]);
  });

  it('a flush with nothing buffered writes nothing (an emit-free request must not touch the counter)', async () => {
    const tdb = fakeTdb();
    const { flush } = makeTenantEventBus().buffered(tdb);
    await flush();
    expect(tdb.batches).toEqual([]);
  });

  it('an emit AFTER the flush is REFUSED — a streaming producer runs once the transaction is gone', async () => {
    const tdb = fakeTdb();
    const { emit, flush } = makeTenantEventBus().buffered(tdb);
    await emit('before', {});
    await flush();
    const err = await emit('after', {}).catch((e: ApiError) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toContain('after this request');
    expect(err.message).toContain('sseResponse');
    // Exactly one write, carrying only what was emitted before the boundary — and the late event was
    // announced as a failure rather than accepted into a buffer nobody will flush.
    expect(tdb.batches).toEqual([[{ topic: 'before', payload: {} }]]);
  });

  it('a one-argument emit is a topic-only event, stored as JSON null (not a mis-call)', async () => {
    const tdb = fakeTdb();
    const { emit, flush } = makeTenantEventBus().buffered(tdb);
    // The RUNTIME half: a topic-only emit is stored as a topic-only row rather than treated as a
    // mis-call. It cannot also assert the TYPE — vitest strips types, and every package `tsconfig`
    // excludes `**/*.test.ts`, so this file would keep passing if `payload` became required. That
    // compile-time guarantee lives in `handler-sdk/src/emit-contract-typepin.ts`, which `tsc -b`
    // does compile.
    await emit('heartbeat');
    await flush();
    expect(tdb.batches).toEqual([[{ topic: 'heartbeat', payload: undefined }]]);
  });
});

describe('init.emit — the IMMEDIATE (tool) form', () => {
  it('each call is its OWN write — a tool has no outer transaction to flush at', async () => {
    const tdb = fakeTdb();
    const emit = makeTenantEventBus().immediate(tdb);
    await emit('tool.one', { i: 1 });
    await emit('tool.two', { i: 2 });
    expect(tdb.batches).toEqual([
      [{ topic: 'tool.one', payload: { i: 1 } }],
      [{ topic: 'tool.two', payload: { i: 2 } }],
    ]);
  });

  it('the same refusals apply (nothing is written on a mis-call)', async () => {
    const tdb = fakeTdb();
    const emit = makeTenantEventBus().immediate(tdb);
    await expect(
      (emit as unknown as (...args: unknown[]) => Promise<void>)({ topic: 'x' }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(tdb.batches).toEqual([]);
  });
});

describe('init.emit — the tenant is the handle, never an argument', () => {
  it('two handles write to their OWN tenants, and the capability exposes no tenant parameter', async () => {
    const a = fakeTdb('00000000-0000-0000-0000-0000000000a1');
    const b = fakeTdb('00000000-0000-0000-0000-0000000000b1');
    const bus = makeTenantEventBus();
    const busA = bus.buffered(a);
    const busB = bus.buffered(b);
    await busA.emit('a.one', {});
    await busB.emit('b.one', {});
    await busA.flush();
    await busB.flush();
    expect(a.batches).toEqual([[{ topic: 'a.one', payload: {} }]]);
    expect(b.batches).toEqual([[{ topic: 'b.one', payload: {} }]]);
    // A THIRD argument (a tenant) is not part of the call: the capability's arity is (topic, payload),
    // and a handler that passes one anyway has it ignored — there is no path to another tenant. A
    // FRESH handle on A, because A's earlier one has already flushed (its request is over).
    const busA2 = bus.buffered(a);
    await (busA2.emit as unknown as (...args: unknown[]) => Promise<void>)(
      'a.two',
      {},
      '00000000-0000-0000-0000-0000000000b1',
    );
    await busA2.flush();
    expect(a.batches).toEqual([
      [{ topic: 'a.one', payload: {} }],
      [{ topic: 'a.two', payload: {} }],
    ]);
    // B is untouched: the extra argument reached nothing.
    expect(b.batches).toEqual([[{ topic: 'b.one', payload: {} }]]);
  });
});
