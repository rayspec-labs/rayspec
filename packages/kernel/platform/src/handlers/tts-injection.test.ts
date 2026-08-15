/**
 * TTS capability INJECTION tests — the optional `init.tts` speech-synthesis capability reaches a TOOL
 * handler, a ROUTE handler and a TRIGGER handler by injection, carries the handler's text + plain
 * options through verbatim, and is ABSENT (fail-closed) when no provider is wired.
 *
 * FAIL-THE-FIX against a recording stand-in capability (this layer ROUTES the handle; the real
 * adapter-backed capability — provider selection, the request policy, the deterministic fake — is
 * proven in @rayspec/server's `tts-capability.unit.test.ts`):
 *   - a tool / route / trigger handler receives an `init.tts` whose `synthesize(text, opts)` it can call;
 *   - the EXACT text + the plain option record reach the capability (serializable-shaped pass-through);
 *   - FAIL-CLOSED when nothing is wired: `init.tts` is ABSENT (not `undefined`) → the handler fail-closes.
 * MUTATING-TO-RED: drop the `tts` argument thread → `init.tts` is undefined when it SHOULD be present
 * → the assertions that read the audio FAIL.
 */
import type { TenantDb } from '@rayspec/db';
import type {
  RouteHandler,
  RouteHandlerInit,
  ToolHandler,
  ToolHandlerInit,
  TriggerHandler,
  TriggerHandlerInit,
  TtsCapability,
  TtsSynthesisResult,
  TtsSynthesizeOptions,
} from '@rayspec/handler-sdk';
import type { RaySpec } from '@rayspec/spec';
import type { PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import type { ResolvedHandler } from './handler-runtime.js';
import { buildToolFactory } from './resolve-tools.js';
import {
  invokeRouteHandler,
  invokeRouteHandlerDetached,
  invokeTriggerHandler,
} from './route-init.js';

const TENANT = '00000000-0000-0000-0000-0000000000aa';
const noTables: ReadonlyMap<string, PgTable> = new Map();

/**
 * A recording stand-in `TtsCapability`: it encodes what it was handed into the returned bytes, so an
 * assertion sees the EXACT text + options that crossed the seam. The result envelope is the port's
 * real shape (no cast) — here only the pass-through matters; the real adapters are exercised where
 * they are built.
 */
function recordingTts(): TtsCapability & {
  readonly calls: Array<{ text: string; opts?: TtsSynthesizeOptions }>;
} {
  const calls: Array<{ text: string; opts?: TtsSynthesizeOptions }> = [];
  return {
    calls,
    async synthesize(text: string, opts?: TtsSynthesizeOptions): Promise<TtsSynthesisResult> {
      calls.push({ text, opts });
      return {
        bytes: new TextEncoder().encode(
          `${text}/${opts?.voice ?? '-'}/${opts?.speed ?? '-'}/${opts?.format ?? '-'}`,
        ),
        contentType: 'audio/wav',
        durationSeconds: 1,
      };
    },
  };
}

// A fake tenant-bound TenantDb — the tts handlers never touch init.db, so a shape stub suffices (the
// same pattern the fs-source/blob/stt injection tests use). The engine-tx path needs a `transaction`
// that runs the callback with the same handle.
function fakeTdb(): TenantDb {
  const stub = {
    tenantId: TENANT,
    transaction: async <R>(cb: (tx: TenantDb) => Promise<R>): Promise<R> => cb(stub),
  };
  return stub as unknown as TenantDb;
}

const TEXT = 'Guten Morgen.';

// ── TOOL handler injection ──────────────────────────────────────────────────────────────────────

const ttsToolFn: ToolHandler = async (args: unknown, init: ToolHandlerInit) => {
  if (!init.tts) throw new Error('tool fail-closed: init.tts is undefined (no TTS provider wired)');
  const { voice } = args as { voice?: string };
  const result = await init.tts.synthesize(TEXT, {
    format: 'wav',
    ...(voice ? { voice } : {}),
  });
  return { audio: new TextDecoder().decode(result.bytes), contentType: result.contentType };
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
        id: 'ttstool',
        name: 'tts_tool',
        description: 'speak a line',
        parameters: { type: 'object', properties: { voice: { type: 'string' } } },
        handler: 'tts_h',
        idempotent: true,
        timeoutMs: 3000,
      },
    ],
    triggers: [],
    handlers: [{ id: 'tts_h', module: './f.ts', export: 'f', kind: 'tool' }],
  } as RaySpec;
}
const toolHandlers = (): Map<string, ResolvedHandler> =>
  new Map([['tts_h', { kind: 'tool', fn: ttsToolFn }]]);

describe('tts injection — TOOL handler', () => {
  const signal = new AbortController().signal;

  it('gives a tool an init.tts that synthesizes the text it hands over', async () => {
    const tts = recordingTts();
    const tool = buildToolFactory(
      toolSpec(),
      toolHandlers(),
      noTables,
      ['ttstool'],
      undefined,
      undefined,
      undefined,
      tts,
    )(fakeTdb())[0];
    expect(await tool?.handler({ voice: 'onyx' }, signal)).toEqual({
      audio: 'Guten Morgen./onyx/-/wav',
      contentType: 'audio/wav',
    });
    // The EXACT text + the plain option record crossed the seam (serializable-shaped, unwrapped).
    expect(tts.calls).toHaveLength(1);
    expect(tts.calls[0]?.text).toBe(TEXT);
    expect(tts.calls[0]?.opts).toEqual({ format: 'wav', voice: 'onyx' });
  });

  it('FAILS CLOSED — init.tts is undefined when NO provider is wired (drop the capability)', async () => {
    const tool = buildToolFactory(toolSpec(), toolHandlers(), noTables, ['ttstool'])(fakeTdb())[0];
    await expect(tool?.handler({}, signal)).rejects.toThrow(/init\.tts is undefined/);
  });

  it('omits init.tts entirely when no provider is wired (ABSENT, not undefined)', async () => {
    let hasTts = true;
    const probe: ToolHandler = async (_args: unknown, init: ToolHandlerInit) => {
      hasTts = 'tts' in (init as object);
      return null;
    };
    const tool = buildToolFactory(
      toolSpec(),
      new Map([['tts_h', { kind: 'tool', fn: probe }]]),
      noTables,
      ['ttstool'],
    )(fakeTdb())[0];
    await tool?.handler({}, signal);
    expect(hasTts).toBe(false); // ABSENT, not undefined — the init shape stays exact
  });
});

// ── ROUTE handler injection ─────────────────────────────────────────────────────────────────────

const ttsRouteFn: RouteHandler = async (init: RouteHandlerInit) => {
  if (!init.tts)
    throw new Error('route fail-closed: init.tts is undefined (no TTS provider wired)');
  const result = await init.tts.synthesize(TEXT, { format: 'wav' });
  return { audio: new TextDecoder().decode(result.bytes), contentType: result.contentType };
};

describe('tts injection — ROUTE handler', () => {
  const params = { id: 'x' };

  it('engine-tx path (invokeRouteHandler) injects init.tts', async () => {
    const tts = recordingTts();
    const out = (await invokeRouteHandler(
      ttsRouteFn,
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
      undefined, // stt
      tts,
    )) as { audio: string; contentType: string };
    expect(out).toEqual({ audio: 'Guten Morgen./-/-/wav', contentType: 'audio/wav' });
    expect(tts.calls).toHaveLength(1);
  });

  it('detached path (invokeRouteHandlerDetached) injects init.tts', async () => {
    const tts = recordingTts();
    const out = (await invokeRouteHandlerDetached(
      ttsRouteFn,
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
      undefined,
      tts,
    )) as { audio: string; contentType: string };
    expect(out).toEqual({ audio: 'Guten Morgen./-/-/wav', contentType: 'audio/wav' });
    expect(tts.calls).toHaveLength(1);
  });

  it('FAILS CLOSED — a route init has NO tts when no provider is wired', async () => {
    await expect(
      invokeRouteHandlerDetached(ttsRouteFn, fakeTdb(), noTables, params),
    ).rejects.toThrow(/init\.tts is undefined/);
  });

  it('omits init.tts entirely when no provider is wired (ABSENT, not undefined)', async () => {
    let hasTts = true;
    const probe: RouteHandler = async (init: RouteHandlerInit) => {
      hasTts = 'tts' in (init as object);
      return null;
    };
    await invokeRouteHandler(probe, fakeTdb(), noTables, params);
    expect(hasTts).toBe(false); // ABSENT, not undefined — the init shape stays exact
  });
});

// ── TRIGGER handler injection ───────────────────────────────────────────────────────────────────

let triggerAudio: string | undefined;

const ttsTriggerFn: TriggerHandler = async (init: TriggerHandlerInit) => {
  if (!init.tts)
    throw new Error('trigger fail-closed: init.tts is undefined (no TTS provider wired)');
  const result = await init.tts.synthesize(TEXT, { format: 'wav' });
  triggerAudio = new TextDecoder().decode(result.bytes);
};

describe('tts injection — TRIGGER handler', () => {
  it('injects the SAME init.tts a route handler receives', async () => {
    const tts = recordingTts();
    triggerAudio = undefined;
    await invokeTriggerHandler(
      ttsTriggerFn,
      fakeTdb(),
      noTables,
      'nightly',
      undefined, // fsSourceFactory
      undefined, // stt
      tts,
    );
    expect(triggerAudio).toBe('Guten Morgen./-/-/wav');
    // The EXACT text + the plain option record crossed the seam (serializable-shaped, unwrapped).
    expect(tts.calls).toHaveLength(1);
    expect(tts.calls[0]?.text).toBe(TEXT);
    expect(tts.calls[0]?.opts).toEqual({ format: 'wav' });
  });

  it('FAILS CLOSED — a trigger init has NO tts when no provider is wired', async () => {
    await expect(
      invokeTriggerHandler(ttsTriggerFn, fakeTdb(), noTables, 'nightly'),
    ).rejects.toThrow(/init\.tts is undefined/);
  });

  it('omits init.tts entirely when no provider is wired (ABSENT, not undefined)', async () => {
    let hasTts = true;
    const probe: TriggerHandler = async (init: TriggerHandlerInit) => {
      hasTts = 'tts' in (init as object);
    };
    await invokeTriggerHandler(probe, fakeTdb(), noTables, 'nightly');
    expect(hasTts).toBe(false); // ABSENT, not undefined — the init shape stays exact
  });
});
