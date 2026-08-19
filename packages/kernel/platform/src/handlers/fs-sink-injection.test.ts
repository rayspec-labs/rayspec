/**
 * fs-sink capability INJECTION tests — the WRITE-ONLY `init.fsSink` reaches a TOOL handler by
 * injection, jailed and bounded by construction, is ABSENT (fail-closed) when no output root is wired,
 * and NEVER reaches a ROUTE or TRIGGER handler.
 *
 * FAIL-THE-FIX against a REAL fs sink (the load-bearing path jail + bounds, not a re-implementation):
 *   - a tool handler receives an `init.fsSink` whose write lands REAL BYTES ON DISK, asserted by
 *     reading the file back with `node:fs` rather than by believing the return value;
 *   - a jail escape through it is REFUSED, and the out-of-root file is asserted UNCHANGED;
 *   - a bound is REFUSED and nothing is written;
 *   - FAIL-CLOSED when no factory is wired: `init.fsSink` is undefined → the handler fail-closes.
 *
 * THE ACCEPT CONTROL is the arm that makes the others mean anything: a tool that always answered
 * "present" would satisfy every positive arm. `reports the capability ABSENT when unwired` is what
 * turns them into a measurement of the INJECTION rather than of the tool's own optimism.
 *
 * MUTATING-TO-RED: drop the `fsSinkFactory` argument in the positive arms → `init.fsSink` is undefined
 * where it SHOULD be present → every write assertion fails.
 *
 * WHY THERE IS NO ROUTE ARM HERE, and why its absence is asserted rather than merely left out: the
 * write capability is deliberately populated on TOOL inits ONLY. `fsSource` reaches route and trigger
 * inits; `fsSink` does not, because an HTTP route's authorization ceiling is "a credential the network
 * can carry" and a capability that CREATES files behind that ceiling is a materially larger authority
 * than a read one. The last describe block pins that asymmetry so it cannot be "fixed" by accident.
 */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TenantDb } from '@rayspec/db';
import type {
  RouteHandler,
  RouteHandlerInit,
  ToolHandler,
  ToolHandlerInit,
} from '@rayspec/handler-sdk';
import type { RaySpec } from '@rayspec/spec';
import type { PgTable } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeFsSinkFactory } from '../fs-sink/fs-sink.js';
import type { ResolvedHandler } from './handler-runtime.js';
import { buildToolFactory } from './resolve-tools.js';
import { invokeRouteHandler } from './route-init.js';

const TENANT = '00000000-0000-0000-0000-0000000000bb';
const noTables: ReadonlyMap<string, PgTable> = new Map();
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

let sandbox: string;
let root: string;
let outsideDir: string;
const OUTSIDE_BODY = 'a file OUTSIDE the output root that no tool may touch';

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'rayspec-inject-sink-'));
  root = join(sandbox, 'out');
  outsideDir = join(sandbox, 'outside');
  mkdirSync(root, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });
  writeFileSync(join(outsideDir, 'secret.txt'), OUTSIDE_BODY, 'utf8');
});
afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

/** A fake tenant-bound TenantDb — the fs-sink handlers never touch init.db, so a shape stub suffices. */
function fakeTdb(): TenantDb {
  const stub = {
    tenantId: TENANT,
    transaction: async <R>(cb: (tx: TenantDb) => Promise<R>): Promise<R> => cb(stub),
  };
  return stub as unknown as TenantDb;
}

/**
 * The tool under test. `op: 'probe'` is what the ACCEPT CONTROL uses: it REPORTS presence instead of
 * throwing, so "absent" is an observable value rather than only an exception.
 */
const sinkToolFn: ToolHandler = async (args: unknown, init: ToolHandlerInit) => {
  const { op, path, body } = args as { op: string; path?: string; body?: string };
  if (op === 'probe') return { present: init.fsSink !== undefined };
  if (!init.fsSink)
    throw new Error('tool fail-closed: init.fsSink is undefined (no output root wired)');
  if (op === 'quota') return init.fsSink.quota();
  return await init.fsSink.write(path ?? 'note.txt', enc(body ?? 'written by a tool'));
};

function toolSpec(): RaySpec {
  return {
    version: '1.0',
    metadata: { name: 't' },
    stores: [],
    api: [],
    agents: [],
    tooling: [
      {
        id: 'sinktool',
        name: 'sink_tool',
        description: 'write a file under the output root',
        parameters: { type: 'object', properties: { op: { type: 'string' } } },
        handler: 'sink_h',
        // The replay-safety declaration this whole design turns on: a workforce turn re-executes on
        // recovery, and the composition refuses any declared tool that is not idempotent. A whole-file
        // write is honestly `true`; an append would not be, and would be refused at the turn.
        idempotent: true,
        timeoutMs: 3000,
      },
    ],
    triggers: [],
    handlers: [{ id: 'sink_h', module: './f.ts', export: 'f', kind: 'tool' }],
  } as RaySpec;
}
const toolHandlers = (): Map<string, ResolvedHandler> =>
  new Map([['sink_h', { kind: 'tool', fn: sinkToolFn }]]);

/** Build the tool WITH the sink wired. `fsSinkFactory` is the LAST positional argument. */
function wiredTool(quota?: {
  maxBytesPerFile?: number;
  maxTotalBytes?: number;
  maxFiles?: number;
}) {
  return buildToolFactory(
    toolSpec(),
    toolHandlers(),
    noTables,
    ['sinktool'],
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    makeFsSinkFactory(root, quota),
  )(fakeTdb())[0];
}

/** Build the SAME tool with NOTHING wired — the accept control. */
function unwiredTool() {
  return buildToolFactory(toolSpec(), toolHandlers(), noTables, ['sinktool'])(fakeTdb())[0];
}

/** A spec declaring TWO sink-using tools, for the "one run, one budget" arm. */
function twoToolSpec(): RaySpec {
  const base = toolSpec();
  return {
    ...base,
    tooling: [
      ...base.tooling,
      {
        id: 'sinktool2',
        name: 'sink_tool_2',
        description: 'a SECOND tool that writes under the same output root',
        parameters: { type: 'object', properties: { op: { type: 'string' } } },
        handler: 'sink_h2',
        idempotent: true,
        timeoutMs: 3000,
      },
    ],
    handlers: [...base.handlers, { id: 'sink_h2', module: './f.ts', export: 'f', kind: 'tool' }],
  } as RaySpec;
}
const twoToolHandlers = (): Map<string, ResolvedHandler> =>
  new Map([
    ['sink_h', { kind: 'tool', fn: sinkToolFn }],
    ['sink_h2', { kind: 'tool', fn: sinkToolFn }],
  ]);

describe('fs-sink injection — TOOL handler', () => {
  const signal = new AbortController().signal;

  it('gives a tool an init.fsSink whose write lands REAL BYTES on disk', async () => {
    const tool = wiredTool();
    const result = await tool?.handler(
      { op: 'write', path: 'reports/summary.md', body: 'the tool wrote this' },
      signal,
    );
    expect(result).toEqual({ path: 'reports/summary.md', bytesWritten: 19, created: true });
    // GROUND TRUTH: read it off the filesystem, never trust the tool's own return value.
    expect(readFileSync(join(root, 'reports/summary.md'), 'utf8')).toBe('the tool wrote this');
  });

  it('the tool CANNOT escape the output root through init.fsSink', async () => {
    const tool = wiredTool();
    // Asserted on the error's NAME, not its message: `dispatchTool` renders a thrown handler error as
    // `handler error: ${String(e)}`, and `String(e)` on an Error is `${name}: ${message}` — so the
    // class name is literally the code the seat reads back through the tool-error channel.
    await expect(
      tool?.handler({ op: 'write', path: '../outside/secret.txt', body: 'pwned' }, signal),
    ).rejects.toThrow(expect.objectContaining({ name: 'FsSinkJailError' }));
    // GROUND TRUTH again: the out-of-root file is byte-identical to how the fixture left it.
    expect(readFileSync(join(outsideDir, 'secret.txt'), 'utf8')).toBe(OUTSIDE_BODY);
  });

  it('the tool CANNOT exceed the deployment-declared byte bound, and writes nothing when refused', async () => {
    const tool = wiredTool({ maxBytesPerFile: 8 });
    await expect(
      tool?.handler({ op: 'write', path: 'big.txt', body: 'far too long for the bound' }, signal),
    ).rejects.toThrow(expect.objectContaining({ name: 'FsSinkQuotaError' }));
    expect(() => readFileSync(join(root, 'big.txt'))).toThrow();
  });

  it("the bounds the tool observes are the DEPLOYMENT's, not the tool's", async () => {
    const tool = wiredTool({ maxBytesPerFile: 11, maxTotalBytes: 22, maxFiles: 3 });
    expect(await tool?.handler({ op: 'quota' }, signal)).toEqual({
      maxBytesPerFile: 11,
      maxTotalBytes: 22,
      maxFiles: 3,
      bytesWritten: 0,
      filesWritten: 0,
    });
  });

  it('ACCEPT CONTROL: the SAME tool reports the capability ABSENT when nothing is wired', async () => {
    // Without this arm, a tool that always answered "present" would satisfy every arm above and they
    // would be measuring the tool's optimism rather than the injection.
    expect(await unwiredTool()?.handler({ op: 'probe' }, signal)).toEqual({ present: false });
    expect(await wiredTool()?.handler({ op: 'probe' }, signal)).toEqual({ present: true });
  });

  it('FAILS CLOSED — a tool that needs init.fsSink throws loudly when no output root is wired', async () => {
    await expect(unwiredTool()?.handler({ op: 'write' }, signal)).rejects.toThrow(
      /init\.fsSink is undefined/,
    );
  });

  it('THE BUDGET BINDS ACROSS CALLS — one sink per RUN, not per call (×200 amplification regression)', async () => {
    // REGRESSION, and the defect this arm replaces was mine. The first version of this wiring minted
    // the sink inside the PER-CALL handler closure, so every call started with a fresh budget: a
    // declared 10-byte total admitted 2 KB across 200 calls, and `maxBytesPerFile` was the only bound
    // that capped anything. A limit that says "run" and behaves "call" is not a limit.
    //
    // This is the amplification attempt run in full: 200 calls, each individually under the per-file
    // cap, against a 10-byte TOTAL budget. Ground truth is measured off the FILESYSTEM, never from the
    // tool's own replies — a sink that reported refusals while still writing would pass otherwise.
    const tool = wiredTool({ maxBytesPerFile: 10, maxTotalBytes: 10, maxFiles: 1 });
    let accepted = 0;
    let refused = 0;
    for (let i = 0; i < 200; i++) {
      try {
        await tool?.handler({ op: 'write', path: `f${i}.txt`, body: '0123456789' }, signal);
        accepted++;
      } catch {
        refused++;
      }
    }
    expect(accepted).toBe(1);
    expect(refused).toBe(199);
    expect(readdirSync(root)).toEqual(['f0.txt']);
    expect(statSync(join(root, 'f0.txt')).size).toBe(10);
  });

  it('two tools OF THE SAME RUN share one budget — declaring more tools does not multiply it', async () => {
    // The sink is built once per run and handed to every tool in it, so a second tool is not a second
    // budget. Without this, an agent declaring N tools would get N times the allowance.
    const tools = buildToolFactory(
      twoToolSpec(),
      twoToolHandlers(),
      noTables,
      ['sinktool', 'sinktool2'],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      makeFsSinkFactory(root, { maxBytesPerFile: 10, maxTotalBytes: 10, maxFiles: 2 }),
    )(fakeTdb());
    expect(tools).toHaveLength(2);
    await expect(
      tools[0]?.handler({ op: 'write', path: 'first.txt', body: '0123456789' }, signal),
    ).resolves.toMatchObject({ bytesWritten: 10 });
    // The SECOND tool sees the budget the FIRST already spent.
    await expect(
      tools[1]?.handler({ op: 'write', path: 'second.txt', body: '0123456789' }, signal),
    ).rejects.toThrow(expect.objectContaining({ name: 'FsSinkQuotaError' }));
    expect(readdirSync(root)).toEqual(['first.txt']);
  });

  it('a DIFFERENT run gets a FRESH budget — per run must not mean per process', async () => {
    // The other half of "per run": scoping the budget to a run must not leak it between runs, or a
    // long-lived deployment would refuse every write after the first run exhausted the allowance.
    const factory = makeFsSinkFactory(root, { maxTotalBytes: 10 });
    const runFactory = buildToolFactory(
      toolSpec(),
      toolHandlers(),
      noTables,
      ['sinktool'],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      factory,
    );
    await expect(
      runFactory(fakeTdb())[0]?.handler({ op: 'write', path: 'a.txt', body: '0123456789' }, signal),
    ).resolves.toMatchObject({ bytesWritten: 10 });
    // A second run through the SAME factory starts clean.
    await expect(
      runFactory(fakeTdb())[0]?.handler({ op: 'write', path: 'b.txt', body: '0123456789' }, signal),
    ).resolves.toMatchObject({ bytesWritten: 10 });
  });
});

describe('fs-sink injection — the ROUTE arm does NOT exist, and that is the design', () => {
  // Pinned, not merely omitted. `fsSource` reaches route inits; `fsSink` deliberately does not, because
  // a route is reachable with a credential the network can carry and a write capability behind that
  // ceiling is a larger authority than this seam was opened for. If someone later threads the sink into
  // `buildRouteHandlerInit`, this arm fails and the decision gets re-made deliberately.
  const routeFn: RouteHandler = async (init: RouteHandlerInit) => ({
    // biome-ignore lint/suspicious/noExplicitAny: probing a member the route init must NOT carry.
    present: (init as any).fsSink !== undefined,
  });

  it('a ROUTE handler never receives init.fsSink — the builder has no slot to thread one through', async () => {
    // `invokeRouteHandler` takes its capabilities POSITIONALLY and there is no fs-sink position at all:
    // that is the structural half of the guarantee (a caller cannot pass one even by mistake). This arm
    // is the observable half — the init a route handler actually receives carries no such key.
    const out = (await invokeRouteHandler(
      routeFn,
      fakeTdb(),
      noTables,
      {},
      undefined, // blobFactory
      undefined, // mintPlayToken
      undefined, // enqueue
      undefined, // body
      undefined, // headers
      undefined, // createdByActor
      undefined, // fsSourceFactory — the READ twin DOES have a slot here; the write one does not
    )) as { present: boolean };
    expect(out).toEqual({ present: false });
  });
});
