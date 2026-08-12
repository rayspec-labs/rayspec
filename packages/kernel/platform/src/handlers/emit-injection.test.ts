/**
 * EVENT-BUS injection tests — WHERE `init.emit` reaches, and WHEN the events are written.
 *
 * The seam this layer owns is placement + timing, so that is what is asserted (the durable ordering
 * itself is proven against a real Postgres in @rayspec/db's event-bus.db.test.ts):
 *   - a ROUTE init and a TOOL init carry `emit`; a TRIGGER init does NOT (the same boundary
 *     `fsSource`/`stt`/`tts` draw), and neither builder invents one;
 *   - ABSENT, not undefined-valued, when no bus is wired: `'emit' in init === false`;
 *   - a ROUTE handler's emits are BUFFERED and written ONCE, as the last thing before the transaction
 *     ends — never one write per call, which would hold the tenant's counter lock across the handler;
 *   - a ROUTE handler that THROWS writes nothing (its buffer dies with the request);
 *   - a TOOL handler's emit is IMMEDIATE — it has no outer transaction to flush at.
 * MUTATING-TO-RED: drop the `eventBus` thread in either builder → the handler's fail-closed branch
 * fires and the assertions that read a written event FAIL.
 */
import type { TenantDb } from '@rayspec/db';
import type {
  RouteHandler,
  RouteHandlerInit,
  ToolHandler,
  ToolHandlerInit,
  TriggerHandler,
  TriggerHandlerInit,
} from '@rayspec/handler-sdk';
import type { RaySpec } from '@rayspec/spec';
import type { PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import type { TenantEventBus } from './event-bus.js';
import type { ResolvedHandler } from './handler-runtime.js';
import { buildToolFactory } from './resolve-tools.js';
import {
  invokeRouteHandler,
  invokeRouteHandlerDetached,
  invokeTriggerHandler,
} from './route-init.js';

const TENANT = '00000000-0000-0000-0000-0000000000aa';
const noTables: ReadonlyMap<string, PgTable> = new Map();

/** One recorded write: the batch a flush (or an immediate emit) handed to the database. */
interface Written {
  readonly tenantId: string;
  readonly topics: string[];
}

/**
 * A RECORDING stand-in bus with the REAL two-form shape. It records each WRITE (not each call), which
 * is what makes the buffering observable: three buffered emits must produce ONE write of three topics,
 * while three tool emits produce three writes of one.
 */
function recordingBus(): TenantEventBus & { readonly writes: Written[] } {
  const writes: Written[] = [];
  return {
    writes,
    buffered(tdb: TenantDb) {
      const pending: string[] = [];
      return {
        emit: async (topic: string): Promise<void> => {
          pending.push(topic);
        },
        flush: async (): Promise<void> => {
          if (pending.length === 0) return;
          writes.push({ tenantId: tdb.tenantId, topics: [...pending] });
          pending.length = 0;
        },
      };
    },
    immediate(tdb: TenantDb) {
      return async (topic: string): Promise<void> => {
        writes.push({ tenantId: tdb.tenantId, topics: [topic] });
      };
    },
  };
}

/**
 * A fake tenant-bound TenantDb — these handlers never touch `init.db`, so a shape stub suffices (the
 * pattern the fs-source/stt injection tests use). `transaction` runs the callback on the same handle
 * and then calls `onCommit`, which is what makes the flush-BEFORE-commit ordering observable.
 */
function fakeTdb(onCommit?: () => void): TenantDb {
  const stub = {
    tenantId: TENANT,
    transaction: async <R>(cb: (tx: TenantDb) => Promise<R>): Promise<R> => {
      const result = await cb(stub as unknown as TenantDb);
      onCommit?.();
      return result;
    },
  };
  return stub as unknown as TenantDb;
}

/** A route handler that emits `count` topics, then optionally throws. */
const emitRoute: RouteHandler = async (init: RouteHandlerInit): Promise<unknown> => {
  const i = init as RouteHandlerInit & { emit?: (t: string, p: unknown) => Promise<void> };
  if (!i.emit) throw new Error('route fail-closed: init.emit is undefined (no event bus wired)');
  const count = Number(init.params.count ?? '1');
  for (let n = 0; n < count; n += 1) await i.emit(`route.${n}`, { n });
  if (init.params.fail === 'yes') throw new Error('route: deliberate failure after emitting');
  return { emitted: count };
};

/** A route handler that reports the capability's PRESENCE with the `in` idiom (the absence contract). */
const probeRoute: RouteHandler = async (init: RouteHandlerInit): Promise<unknown> => ({
  present: 'emit' in init,
});

/** A trigger handler that reports the same thing — a trigger init must NOT carry the capability. */
const probeTrigger: TriggerHandler = async (init: TriggerHandlerInit): Promise<void> => {
  triggerSawEmit = 'emit' in init;
};
let triggerSawEmit: boolean | undefined;

/** A tool handler that emits once per call. */
const emitTool: ToolHandler = async (args: unknown, init: ToolHandlerInit): Promise<unknown> => {
  const i = init as ToolHandlerInit & { emit?: (t: string, p: unknown) => Promise<void> };
  if (!i.emit) throw new Error('tool fail-closed: init.emit is undefined (no event bus wired)');
  const { topic } = args as { topic: string };
  await i.emit(topic, { from: 'tool' });
  return { ok: true };
};

/** A minimal spec declaring one tool bound to the emitting handler. */
const toolSpec = {
  tooling: [
    {
      id: 'emit_tool',
      name: 'emit_tool',
      description: 'emits one event',
      handler: 'emit_tool_handler',
      parameters: { type: 'object', properties: { topic: { type: 'string' } } },
      idempotent: false,
      timeoutMs: 1000,
    },
  ],
} as unknown as RaySpec;
const toolHandlers = new Map<string, ResolvedHandler>([
  ['emit_tool_handler', { kind: 'tool', fn: emitTool }],
]);

describe('init.emit — ROUTE injection (buffered, flushed at the transaction boundary)', () => {
  it('three emits produce ONE write, carrying the topics in call order', async () => {
    const bus = recordingBus();
    const tdb = fakeTdb();
    const result = await invokeRouteHandler(
      emitRoute,
      tdb,
      noTables,
      { count: '3' },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      bus,
    );
    expect(result).toEqual({ emitted: 3 });
    // ONE write, not three: the calls buffered. Emitting at the call site would take the tenant's
    // counter lock on the first emit and hold it for the rest of the handler.
    expect(bus.writes).toEqual([{ tenantId: TENANT, topics: ['route.0', 'route.1', 'route.2'] }]);
  });

  it('the flush happens INSIDE the transaction, before it commits', async () => {
    const bus = recordingBus();
    let writesAtCommit = -1;
    // At the moment the transaction ends, the write must ALREADY have happened — that is what makes
    // the events atomic with the handler's own writes. Fail-the-fix: move the flush after the
    // transaction callback returns and this reads 0.
    const tdb = fakeTdb(() => {
      writesAtCommit = bus.writes.length;
    });
    await invokeRouteHandler(
      emitRoute,
      tdb,
      noTables,
      { count: '2' },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      bus,
    );
    expect(writesAtCommit).toBe(1);
  });

  it('a handler that THROWS writes nothing (the buffer dies with the request)', async () => {
    const bus = recordingBus();
    await expect(
      invokeRouteHandler(
        emitRoute,
        fakeTdb(),
        noTables,
        { count: '2', fail: 'yes' },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        bus,
      ),
    ).rejects.toThrow('deliberate failure');
    expect(bus.writes).toEqual([]);
  });

  it('the handler-managed (detached) posture gets the capability on the same terms', async () => {
    const bus = recordingBus();
    const result = await invokeRouteHandlerDetached(
      emitRoute,
      fakeTdb(),
      noTables,
      { count: '1' },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      bus,
    );
    expect(result).toEqual({ emitted: 1 });
    expect(bus.writes).toEqual([{ tenantId: TENANT, topics: ['route.0'] }]);
  });

  it('ABSENT (not undefined-valued) when no bus is wired: `emit` in init === false', async () => {
    const result = await invokeRouteHandler(probeRoute, fakeTdb(), noTables, {});
    expect(result).toEqual({ present: false });
  });

  it('PRESENT when a bus is wired', async () => {
    const result = await invokeRouteHandler(
      probeRoute,
      fakeTdb(),
      noTables,
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      recordingBus(),
    );
    expect(result).toEqual({ present: true });
  });
});

describe('init.emit — TOOL injection (immediate: a tool has no outer transaction)', () => {
  it('each tool emit is its OWN write, bound to the run tenant', async () => {
    const bus = recordingBus();
    const factory = buildToolFactory(
      toolSpec,
      toolHandlers,
      noTables,
      ['emit_tool'],
      undefined,
      undefined,
      undefined,
      undefined,
      bus,
    );
    const [tool] = factory(fakeTdb());
    await tool?.handler({ topic: 'tool.one' }, undefined as never);
    await tool?.handler({ topic: 'tool.two' }, undefined as never);
    expect(bus.writes).toEqual([
      { tenantId: TENANT, topics: ['tool.one'] },
      { tenantId: TENANT, topics: ['tool.two'] },
    ]);
  });

  it('ABSENT on a tool init when no bus is wired (the handler fail-closes loudly)', async () => {
    const factory = buildToolFactory(toolSpec, toolHandlers, noTables, ['emit_tool']);
    const [tool] = factory(fakeTdb());
    await expect(tool?.handler({ topic: 'x' }, undefined as never)).rejects.toThrow(
      'init.emit is undefined',
    );
  });
});

describe('init.emit — the TRIGGER boundary (deliberately not reached)', () => {
  it('a trigger init carries no `emit` — the same boundary fsSource/stt/tts already draw', async () => {
    triggerSawEmit = undefined;
    await invokeTriggerHandler(probeTrigger, fakeTdb(), noTables, 'nightly');
    expect(triggerSawEmit).toBe(false);
  });
});
