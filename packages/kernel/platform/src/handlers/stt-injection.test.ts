/**
 * STT capability INJECTION tests — the optional `init.stt` transcription capability reaches BOTH a
 * TOOL handler and a ROUTE handler by injection, carries the handler's bytes + plain options through
 * verbatim, and is ABSENT (fail-closed) when no provider is wired.
 *
 * FAIL-THE-FIX against a recording stand-in capability (this layer ROUTES the handle; the real
 * adapter-backed capability — provider selection, the bytes→ref resolver wrap, the deterministic fake —
 * is proven in @rayspec/server):
 *   - a tool / route handler receives an `init.stt` whose `transcribe(bytes, opts)` it can call;
 *   - the EXACT bytes + the plain option record reach the capability (serializable-shaped pass-through);
 *   - FAIL-CLOSED when nothing is wired: `init.stt` is ABSENT (not `undefined`) → the handler fail-closes.
 * MUTATING-TO-RED: drop the `stt` argument thread → `init.stt` is undefined when it SHOULD be present
 * → the assertions that read a transcript FAIL.
 */
import type { TenantDb } from '@rayspec/db';
import type {
  RouteHandler,
  RouteHandlerInit,
  SttCapability,
  SttTranscribeOptions,
  SttTranscriptionResult,
  ToolHandler,
  ToolHandlerInit,
} from '@rayspec/handler-sdk';
import type { RaySpec } from '@rayspec/spec';
import type { PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import type { ResolvedHandler } from './handler-runtime.js';
import { buildToolFactory } from './resolve-tools.js';
import { invokeRouteHandler, invokeRouteHandlerDetached } from './route-init.js';

const TENANT = '00000000-0000-0000-0000-0000000000aa';
const noTables: ReadonlyMap<string, PgTable> = new Map();

/**
 * A recording stand-in `SttCapability`: it echoes what it was handed into the transcript's
 * `full_text`, so an assertion sees the EXACT bytes + options that crossed the seam. The transcript
 * envelope is a sentinel (the neutral shape is the port's contract, exercised where the real adapters
 * are — here only the pass-through matters).
 */
function recordingStt(): SttCapability & {
  readonly calls: Array<{ bytes: Uint8Array; opts?: SttTranscribeOptions }>;
} {
  const calls: Array<{ bytes: Uint8Array; opts?: SttTranscribeOptions }> = [];
  return {
    calls,
    async transcribe(
      bytes: Uint8Array,
      opts?: SttTranscribeOptions,
    ): Promise<SttTranscriptionResult> {
      calls.push({ bytes, opts });
      return {
        status: 'completed',
        transcript: {
          full_text: `${bytes.length} bytes/${opts?.contentType ?? '-'}/${opts?.languageHint ?? '-'}`,
        },
      } as unknown as SttTranscriptionResult;
    },
  };
}

// A fake tenant-bound TenantDb — the stt handlers never touch init.db, so a shape stub suffices (the
// same pattern the fs-source/blob injection tests use). The engine-tx path needs a `transaction` that
// runs the callback with the same handle.
function fakeTdb(): TenantDb {
  const stub = {
    tenantId: TENANT,
    transaction: async <R>(cb: (tx: TenantDb) => Promise<R>): Promise<R> => cb(stub),
  };
  return stub as unknown as TenantDb;
}

const AUDIO = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02]);

// ── TOOL handler injection ──────────────────────────────────────────────────────────────────────

const sttToolFn: ToolHandler = async (args: unknown, init: ToolHandlerInit) => {
  if (!init.stt) throw new Error('tool fail-closed: init.stt is undefined (no STT provider wired)');
  const { hint } = args as { hint?: string };
  const result = await init.stt.transcribe(AUDIO, {
    contentType: 'audio/ogg',
    ...(hint ? { languageHint: hint } : {}),
  });
  return { status: result.status, text: result.transcript?.full_text };
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
        id: 'stttool',
        name: 'stt_tool',
        description: 'transcribe an audio clip',
        parameters: { type: 'object', properties: { hint: { type: 'string' } } },
        handler: 'stt_h',
        idempotent: true,
        timeoutMs: 3000,
      },
    ],
    triggers: [],
    handlers: [{ id: 'stt_h', module: './f.ts', export: 'f', kind: 'tool' }],
  } as RaySpec;
}
const toolHandlers = (): Map<string, ResolvedHandler> =>
  new Map([['stt_h', { kind: 'tool', fn: sttToolFn }]]);

describe('stt injection — TOOL handler', () => {
  const signal = new AbortController().signal;

  it('gives a tool an init.stt that transcribes the bytes it hands over', async () => {
    const stt = recordingStt();
    const tool = buildToolFactory(
      toolSpec(),
      toolHandlers(),
      noTables,
      ['stttool'],
      undefined,
      undefined,
      stt,
    )(fakeTdb())[0];
    expect(await tool?.handler({ hint: 'de' }, signal)).toEqual({
      status: 'completed',
      text: '6 bytes/audio/ogg/de',
    });
    // The EXACT bytes + the plain option record crossed the seam (serializable-shaped, unwrapped).
    expect(stt.calls).toHaveLength(1);
    expect([...(stt.calls[0]?.bytes ?? [])]).toEqual([...AUDIO]);
    expect(stt.calls[0]?.opts).toEqual({ contentType: 'audio/ogg', languageHint: 'de' });
  });

  it('FAILS CLOSED — init.stt is undefined when NO provider is wired (drop the capability)', async () => {
    const tool = buildToolFactory(toolSpec(), toolHandlers(), noTables, ['stttool'])(fakeTdb())[0];
    await expect(tool?.handler({}, signal)).rejects.toThrow(/init\.stt is undefined/);
  });

  it('omits init.stt entirely when no provider is wired (ABSENT, not undefined)', async () => {
    let hasStt = true;
    const probe: ToolHandler = async (_args: unknown, init: ToolHandlerInit) => {
      hasStt = 'stt' in (init as object);
      return null;
    };
    const tool = buildToolFactory(
      toolSpec(),
      new Map([['stt_h', { kind: 'tool', fn: probe }]]),
      noTables,
      ['stttool'],
    )(fakeTdb())[0];
    await tool?.handler({}, signal);
    expect(hasStt).toBe(false); // ABSENT, not undefined — the init shape stays exact
  });
});

// ── ROUTE handler injection ─────────────────────────────────────────────────────────────────────

const sttRouteFn: RouteHandler = async (init: RouteHandlerInit) => {
  if (!init.stt)
    throw new Error('route fail-closed: init.stt is undefined (no STT provider wired)');
  const result = await init.stt.transcribe(AUDIO, { contentType: 'audio/ogg' });
  return { status: result.status, text: result.transcript?.full_text };
};

describe('stt injection — ROUTE handler', () => {
  const params = { id: 'x' };

  it('engine-tx path (invokeRouteHandler) injects init.stt', async () => {
    const stt = recordingStt();
    const out = (await invokeRouteHandler(
      sttRouteFn,
      fakeTdb(),
      noTables,
      params,
      undefined, // blobFactory
      undefined, // mintPlayToken
      undefined, // enqueue
      undefined, // body
      undefined, // headers
      undefined, // createdByActor
      undefined, // fsSourceFactory
      undefined, // principal
      stt,
    )) as { status: string; text?: string };
    expect(out).toEqual({ status: 'completed', text: '6 bytes/audio/ogg/-' });
    expect(stt.calls).toHaveLength(1);
  });

  it('detached path (invokeRouteHandlerDetached) injects init.stt', async () => {
    const stt = recordingStt();
    const out = (await invokeRouteHandlerDetached(
      sttRouteFn,
      fakeTdb(),
      noTables,
      params,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      stt,
    )) as { status: string; text?: string };
    expect(out).toEqual({ status: 'completed', text: '6 bytes/audio/ogg/-' });
    expect(stt.calls).toHaveLength(1);
  });

  it('FAILS CLOSED — a route init has NO stt when no provider is wired', async () => {
    await expect(
      invokeRouteHandlerDetached(sttRouteFn, fakeTdb(), noTables, params),
    ).rejects.toThrow(/init\.stt is undefined/);
  });

  it('omits init.stt entirely when no provider is wired (ABSENT, not undefined)', async () => {
    let hasStt = true;
    const probe: RouteHandler = async (init: RouteHandlerInit) => {
      hasStt = 'stt' in (init as object);
      return null;
    };
    await invokeRouteHandler(probe, fakeTdb(), noTables, params);
    expect(hasStt).toBe(false); // ABSENT, not undefined — the init shape stays exact
  });
});
