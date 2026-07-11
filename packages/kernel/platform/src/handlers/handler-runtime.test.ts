/**
 * HandlerRuntime SEAM-WORKS acceptance — the load-bearing design.
 *
 * The per-tenant sandbox is reserved as ONE indirection: every handler invocation funnels
 * through `getHandlerRuntime().invoke*`. This test PROVES that single-call-site property by installing
 * a SECOND `HandlerRuntime` (a counting no-op) and asserting that a TOOL invocation (via the
 * resolver's NeutralTool handler) AND a ROUTE + TRIGGER invocation (via the route/trigger init
 * helpers) ALL route through that one runtime — so a future isolate impl swaps in by installing ONE object,
 * with zero handler/spec change. FAIL-THE-FIX: a call site that bypasses the runtime (calls the
 * handler fn directly) would NOT increment the counter → a test fails.
 */
import type { NeutralTool } from '@rayspec/core';
import type { TenantDb } from '@rayspec/db';
import type {
  HandlerInit,
  RouteHandler,
  RouteHandlerInit,
  ToolHandler,
  ToolHandlerInit,
  TriggerHandler,
  TriggerHandlerInit,
} from '@rayspec/handler-sdk';
import type { PgTable } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getHandlerRuntime,
  type HandlerRuntime,
  InProcessHandlerRuntime,
  setHandlerRuntime,
} from './handler-runtime.js';
import { buildToolFactory } from './resolve-tools.js';
import { invokeRouteHandler, invokeTriggerHandler } from './route-init.js';

/** A counting HandlerRuntime that DELEGATES to the in-process impl but tallies every invocation. */
class CountingRuntime implements HandlerRuntime {
  tool = 0;
  route = 0;
  trigger = 0;
  private readonly inner = new InProcessHandlerRuntime();
  async invokeTool(fn: ToolHandler, args: unknown, init: ToolHandlerInit): Promise<unknown> {
    this.tool++;
    return this.inner.invokeTool(fn, args, init);
  }
  async invokeRoute(fn: RouteHandler, init: RouteHandlerInit): Promise<unknown> {
    this.route++;
    return this.inner.invokeRoute(fn, init);
  }
  async invokeTrigger(fn: TriggerHandler, init: TriggerHandlerInit): Promise<void> {
    this.trigger++;
    return this.inner.invokeTrigger(fn, init);
  }
}

// A fake TenantDb whose transaction() just runs the callback with itself (no real DB) — the seam test
// does not touch a store; it only proves invocation routing. tenantId is a valid uuid shape.
const FAKE_TENANT = '11111111-1111-1111-1111-111111111111';
const fakeTdb = {
  tenantId: FAKE_TENANT,
  async transaction<R>(fn: (tx: unknown) => Promise<R>): Promise<R> {
    return fn(fakeTdb);
  },
} as unknown as TenantDb;
const noTables: ReadonlyMap<string, PgTable> = new Map();

afterEach(() => {
  // Always restore the default in-process runtime so a leaked install cannot bleed across tests.
  setHandlerRuntime(new InProcessHandlerRuntime());
});

describe('HandlerRuntime — the single-call-site seam (deliverable d)', () => {
  it('defaults to the in-process runtime', () => {
    expect(getHandlerRuntime()).toBeInstanceOf(InProcessHandlerRuntime);
  });

  it('routes a TOOL invocation through the installed runtime (exactly one call site)', async () => {
    const counting = new CountingRuntime();
    const restore = setHandlerRuntime(counting);
    try {
      const toolFn: ToolHandler = async (args, init: HandlerInit) => ({
        echoed: args,
        tenant: init.tenantId,
      });
      const factory = buildToolFactory(
        {
          version: '1.0',
          metadata: { name: 't' },
          stores: [],
          api: [],
          agents: [],
          tooling: [
            {
              id: 'echo',
              name: 'echo',
              description: 'echo',
              parameters: { type: 'object', properties: {} },
              handler: 'echo_h',
              idempotent: true,
              timeoutMs: 1000,
            },
          ],
          triggers: [],
          handlers: [{ id: 'echo_h', module: './e.ts', export: 'e', kind: 'tool' }],
        },
        new Map([['echo_h', { kind: 'tool', fn: toolFn }]]),
        noTables,
        ['echo'],
      );
      const tools: NeutralTool[] = factory(fakeTdb);
      expect(tools).toHaveLength(1);
      // dispatchTool calls tool.handler(rawArgs, signal); we simulate that direct call.
      const out = await tools[0]?.handler({ a: 1 }, new AbortController().signal);
      expect(out).toEqual({ echoed: { a: 1 }, tenant: FAKE_TENANT });
      // The invocation funneled through the SINGLE indirection (not a direct fn call).
      expect(counting.tool).toBe(1);
      expect(counting.route).toBe(0);
      expect(counting.trigger).toBe(0);
    } finally {
      restore();
    }
  });

  it('routes a ROUTE invocation through the installed runtime', async () => {
    const counting = new CountingRuntime();
    const restore = setHandlerRuntime(counting);
    try {
      const routeFn: RouteHandler = async (init: RouteHandlerInit) => ({ ok: init.params.id });
      const body = await invokeRouteHandler(routeFn, fakeTdb, noTables, { id: 'abc' });
      expect(body).toEqual({ ok: 'abc' });
      expect(counting.route).toBe(1);
      expect(counting.tool).toBe(0);
    } finally {
      restore();
    }
  });

  it('wires init.blob bound to the run tenant when a blobFactory is injected', async () => {
    // The blobFactory is called with the run's SERVER-DERIVED tenant (txTdb.tenantId), proving the
    // blob handle is tenant-bound BY CONSTRUCTION (a handler cannot supply/override the tenant).
    let factoryTenant: string | undefined;
    const sentinelBlob = { __sentinel: 'blob' };
    const blobFactory = (tenantId: string) => {
      factoryTenant = tenantId;
      return sentinelBlob as never; // a sentinel BlobStore — identity-checked, not exercised
    };
    let seenBlob: unknown;
    let seenTenant: string | undefined;
    const routeFn: RouteHandler = async (init: RouteHandlerInit) => {
      seenBlob = (init as { blob?: unknown }).blob;
      seenTenant = init.tenantId;
      return { ok: true };
    };
    await invokeRouteHandler(routeFn, fakeTdb, noTables, { id: 'x' }, blobFactory);
    expect(factoryTenant).toBe(FAKE_TENANT); // built from the run's tenant
    expect(seenTenant).toBe(FAKE_TENANT);
    expect(seenBlob).toBe(sentinelBlob); // the exact tenant-bound handle reached the handler
  });

  it('omits init.blob when no blobFactory is injected (existing {handler} routes — unchanged)', async () => {
    let hasBlob = true;
    const routeFn: RouteHandler = async (init: RouteHandlerInit) => {
      hasBlob = 'blob' in (init as object);
      return null;
    };
    await invokeRouteHandler(routeFn, fakeTdb, noTables, { id: 'x' });
    expect(hasBlob).toBe(false); // ABSENT, not undefined — the init shape stays exact
  });

  it('wires init.headers when the api interpreter passes them, and omits the field otherwise', async () => {
    // With headers: the exact lowercase-keyed map reaches the handler as DATA.
    let seenHeaders: unknown;
    const readingFn: RouteHandler = async (init: RouteHandlerInit) => {
      seenHeaders = init.headers;
      return null;
    };
    await invokeRouteHandler(
      readingFn,
      fakeTdb,
      noTables,
      { id: 'x' },
      undefined,
      undefined,
      undefined,
      undefined,
      { 'if-none-match': '"abc"' },
    );
    expect(seenHeaders).toEqual({ 'if-none-match': '"abc"' });

    // Without headers: the field is ABSENT (not undefined) — every existing caller is unchanged.
    let hasHeaders = true;
    const absentFn: RouteHandler = async (init: RouteHandlerInit) => {
      hasHeaders = 'headers' in (init as object);
      return null;
    };
    await invokeRouteHandler(absentFn, fakeTdb, noTables, { id: 'x' });
    expect(hasHeaders).toBe(false);
  });

  it('routes a TRIGGER invocation through the installed runtime', async () => {
    const counting = new CountingRuntime();
    const restore = setHandlerRuntime(counting);
    try {
      let ran = false;
      const triggerFn: TriggerHandler = async (init: TriggerHandlerInit) => {
        ran = init.triggerName === 'nightly';
      };
      await invokeTriggerHandler(triggerFn, fakeTdb, noTables, 'nightly');
      expect(ran).toBe(true);
      expect(counting.trigger).toBe(1);
    } finally {
      restore();
    }
  });

  it('setHandlerRuntime restore() puts the in-process default back', () => {
    const restore = setHandlerRuntime(new CountingRuntime());
    expect(getHandlerRuntime()).toBeInstanceOf(CountingRuntime);
    restore();
    expect(getHandlerRuntime()).toBeInstanceOf(InProcessHandlerRuntime);
  });
});
