/**
 * `init.fsSink` reaches a DECLARED AGENT's tool through the REAL registry composition — the
 * cross-package arm.
 *
 * WHY THIS SUITE EXISTS, and why the platform-side injection test is not enough. The capability is
 * threaded `buildAgentRegistry` → `buildToolFactory` → `buildNeutralTool` → the per-call
 * `ToolHandlerInit`, and `buildToolFactory` takes TEN positional arguments. The platform's own
 * `fs-sink-injection.test.ts` calls `buildToolFactory` DIRECTLY, so it proves the factory works — it
 * cannot prove that api-auth ever passes the factory, or passes it in the right position. A dropped or
 * transposed argument there would leave every declared agent's tools without the capability while every
 * platform test stayed green. That is precisely the gap the sibling
 * `agent-tool-capability-arms.db.test.ts` was written for on the read side.
 *
 * It is also the battery's CROSS-PACKAGE arm. Workspace packages resolve siblings through `dist`, so
 * mutating platform source and running these tests exercises the OLD BUILT platform unless a rebuild
 * happens in between — a mutation runner without that step reports a confident, meaningless green. This
 * suite is what would catch such an inert battery.
 *
 * Deliberately NOT a `.db.test.ts`: it drives the registry composition directly with a stub TenantDb,
 * so it runs in the no-DB lane where a missing capability fails fast and cheaply.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Backend, BackendId } from '@rayspec/core';
import type { TenantDb } from '@rayspec/db';
import type { ToolHandler, ToolHandlerInit } from '@rayspec/handler-sdk';
import { makeFsSinkFactory, type ResolvedHandler } from '@rayspec/platform';
import type { RaySpec } from '@rayspec/spec';
import type { PgTable } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAgentRegistry } from './build-agent-registry.js';

const TENANT = '00000000-0000-0000-0000-0000000000cc';
const noTables: ReadonlyMap<string, PgTable> = new Map();
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rayspec-registry-sink-'));
  mkdirSync(root, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function fakeTdb(): TenantDb {
  const stub = {
    tenantId: TENANT,
    transaction: async <R>(cb: (tx: TenantDb) => Promise<R>): Promise<R> => cb(stub),
  };
  return stub as unknown as TenantDb;
}

/** Reports presence rather than throwing, so ABSENT is an observable value (the accept control). */
const sinkToolFn: ToolHandler = async (args: unknown, init: ToolHandlerInit) => {
  const { op } = args as { op: string };
  if (op === 'probe') return { present: init.fsSink !== undefined };
  if (!init.fsSink) throw new Error('tool fail-closed: init.fsSink is undefined');
  return await init.fsSink.write('from-a-declared-agent.md', enc('the seat proposed this'));
};

function spec(): RaySpec {
  return {
    version: '1.0',
    metadata: { name: 'registry-sink' },
    stores: [],
    api: [],
    agents: [{ id: 'writer', backend: 'fake' as BackendId, model: 'm', tools: ['sinktool'] }],
    tooling: [
      {
        id: 'sinktool',
        name: 'write_file',
        description: 'write a whole file under the deployment output root',
        parameters: { type: 'object', properties: { op: { type: 'string' } } },
        handler: 'sink_h',
        idempotent: true,
        timeoutMs: 3000,
      },
    ],
    triggers: [],
    handlers: [{ id: 'sink_h', module: './f.ts', export: 'f', kind: 'tool' }],
  } as unknown as RaySpec;
}

const handlers = (): Map<string, ResolvedHandler> =>
  new Map([['sink_h', { kind: 'tool', fn: sinkToolFn }]]);
const backends = (): Map<BackendId, Backend> =>
  new Map([['fake' as BackendId, { id: 'fake' } as unknown as Backend]]);

/** Build the registry and pull the one declared agent's one tool out of it. */
function toolFrom(withSink: boolean) {
  const registry = buildAgentRegistry({
    spec: spec(),
    agentBackends: backends(),
    handlers: handlers(),
    productTables: noTables,
    ...(withSink ? { fsSinkFactory: makeFsSinkFactory(root) } : {}),
  });
  const entry = registry.get('writer');
  expect(entry).toBeDefined();
  expect(entry?.toolFactory).toBeDefined();
  return entry?.toolFactory?.(fakeTdb())[0];
}

describe('init.fsSink reaches a declared agent tool through the real registry composition', () => {
  const signal = new AbortController().signal;

  it('the registry threads the fs-sink factory, and the tool writes REAL BYTES under the output root', async () => {
    const tool = toolFrom(true);
    const result = await tool?.handler({ op: 'write' }, signal);
    expect(result).toEqual({
      path: 'from-a-declared-agent.md',
      bytesWritten: 22,
      created: true,
    });
    // GROUND TRUTH off the filesystem — never the tool's own return value.
    expect(readFileSync(join(root, 'from-a-declared-agent.md'), 'utf8')).toBe(
      'the seat proposed this',
    );
  });

  it('ACCEPT CONTROL: the SAME registry, the SAME agent, the SAME tool reports it ABSENT when unwired', async () => {
    // Without this, a tool that always answered "present" would satisfy the arm above and the suite
    // would be measuring the tool rather than the threading.
    expect(await toolFrom(false)?.handler({ op: 'probe' }, signal)).toEqual({ present: false });
    expect(await toolFrom(true)?.handler({ op: 'probe' }, signal)).toEqual({ present: true });
  });

  it('FAILS CLOSED: a declared tool that needs the sink throws loudly when the deployment wired none', async () => {
    await expect(toolFrom(false)?.handler({ op: 'write' }, signal)).rejects.toThrow(
      /init\.fsSink is undefined/,
    );
  });

  it('the jail travels with the capability — a declared agent cannot escape the output root either', async () => {
    const escaping: ToolHandler = async (_args: unknown, init: ToolHandlerInit) => {
      if (!init.fsSink) throw new Error('unwired');
      return await init.fsSink.write('../escaped.md', enc('pwned'));
    };
    const registry = buildAgentRegistry({
      spec: spec(),
      agentBackends: backends(),
      handlers: new Map([['sink_h', { kind: 'tool', fn: escaping }]]),
      productTables: noTables,
      fsSinkFactory: makeFsSinkFactory(root),
    });
    const tool = registry.get('writer')?.toolFactory?.(fakeTdb())[0];
    await expect(tool?.handler({}, signal)).rejects.toThrow(
      expect.objectContaining({ name: 'FsSinkJailError' }),
    );
  });
});
