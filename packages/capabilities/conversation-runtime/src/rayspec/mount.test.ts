/**
 * The mount fragment: the `MountedAudioCapability`-shaped fragments compose consumes — BOTH
 * capability-owned stores, TWO routes as WHOLE tuples (the PUT `{kind:'handler'}` create + the
 * POST `{kind:'handler'}` turn submit), the resolved handler map INCLUDING the tx-posture flag
 * (turn submit = `routeTx: 'handler-managed'`, create = default) — plus the HTTP-facing behavior
 * of the bound handlers: the turn flow (intake + REAL reply in one request), `httpResponse`
 * status mapping incl. the sink-rejection 403 with ZERO model work, reply-leg errors carrying the
 * committed intake facts, genuine faults rethrown.
 */
import type { httpResponse } from '@rayspec/handler-sdk';
import { describe, expect, it } from 'vitest';
import type { ConversationCapabilityConfig } from '../config.js';
import type { TurnSubmittedSink } from '../events.js';
import { ConversationEventRejectedError, createInMemoryTurnSubmittedSink } from '../events.js';
import { replyMessageId } from '../reply.js';
import { conversationCapabilityStores } from '../stores.js';
import { makeFakeConversationDb, SharedConversationTables } from '../test-support/fake-db.js';
import { FakeTurnResponder } from '../test-support/fake-responder.js';
import {
  DEFAULT_CONVERSATION_BASE_PATH,
  DEFAULT_CONVERSATION_HANDLER_IDS,
  type MountedConversationCapability,
  mountConversationCapability,
} from './mount.js';

const TENANT = 'tenant-aaaa';

interface Harness {
  tables: SharedConversationTables;
  mounted: MountedConversationCapability;
  responder: FakeTurnResponder;
}

function harness(sink: TurnSubmittedSink, capability?: ConversationCapabilityConfig): Harness {
  const responder = new FakeTurnResponder();
  return {
    tables: new SharedConversationTables(),
    responder,
    mounted: mountConversationCapability({
      turnSubmittedSink: sink,
      turnResponder: () => responder,
      // An optional capability override (threaded into `mountConversationCapability`, which
      // resolves it via `resolveConversationConfig`) — the framing arms below pass a PERMISSIVE
      // `messageIdPattern` so a hostile message_id can be driven through the intake/error builders.
      ...(capability !== undefined ? { capability } : {}),
    }),
  };
}

/**
 * A permissive `messageIdPattern` that ADMITS raw CR/LF (so hostile framing bytes can ride the
 * `message_id` into the SSE frame builders whose payloads are otherwise all safe-id/number fields),
 * while STILL excluding ':' (the ref/idempotency-key delimiter) and the reserved 'reply~' namespace —
 * so it passes `resolveConversationConfig`'s construction probe belts (config.ts). `[\w\s]` covers the
 * hostile ids below (word chars + whitespace incl. \n and \r) and rejects both reserved chars.
 */
const CRLF_ADMITTING_MESSAGE_ID_PATTERN = /^[\w\s]+$/;

/**
 * A hostile message_id engineered to break a naive `data: <text>` frame: an LF, a blank line,
 * forged `event`/`data`-shaped tokens, and a CRLF. It carries NO ':' on purpose — the point-of-use
 * ':' belt (validate.ts) 422s any colon in a message_id BEFORE a frame is built, so this isolates the
 * FRAMING defense (JSON.stringify newline-escaping) rather than the delimiter belt. Not a live vuln
 * (the default pattern blocks CR/LF); this pins the framing invariant on the two builders that drove
 * only benign content through — the intake builder and the conversation_reply_error builder.
 */
const HOSTILE_MESSAGE_ID = 'm1\n\nevent forged\ndata pwned\r\n\r\nevent forged2 done';

async function driveCreate(h: Harness, conversationId: string, body?: unknown): Promise<unknown> {
  const fn = h.mounted.handlers.get(DEFAULT_CONVERSATION_HANDLER_IDS.conversationCreate)?.fn;
  if (!fn) throw new Error('create handler missing');
  const init = {
    tenantId: TENANT,
    db: makeFakeConversationDb(h.tables, TENANT),
    params: { conversation_id: conversationId },
    ...(body !== undefined ? { body } : {}),
  };
  return fn(init as never);
}

async function driveTurn(
  h: Harness,
  conversationId: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<unknown> {
  const fn = h.mounted.handlers.get(DEFAULT_CONVERSATION_HANDLER_IDS.turnSubmit)?.fn;
  if (!fn) throw new Error('turn handler missing');
  const init = {
    tenantId: TENANT,
    db: makeFakeConversationDb(h.tables, TENANT),
    params: { conversation_id: conversationId },
    ...(body !== undefined ? { body } : {}),
    ...(headers !== undefined ? { headers } : {}),
  };
  return fn(init as never);
}

/** One captured SSE frame (what the engine would writeSSE). */
interface CapturedFrame {
  id?: string;
  event?: string;
  data: string;
}

/**
 * Drive an `sseResponse` handler return: run its producer to completion, collecting every emitted
 * frame (the engine's role). `aborted` lets a test simulate a mid-stream client disconnect.
 */
async function collectSse(res: unknown, aborted = false): Promise<CapturedFrame[]> {
  const sse = (res as { sse?: unknown }).sse;
  if (typeof sse !== 'function') throw new Error('expected an sseResponse (a producer under .sse)');
  const frames: CapturedFrame[] = [];
  await (
    sse as (emit: (f: CapturedFrame) => Promise<void>, s: { aborted: boolean }) => Promise<void>
  )(async (f) => void frames.push(f), { aborted });
  return frames;
}

/**
 * Encode captured frames to the SSE wire EXACTLY as the engine's Hono `streamSSE.writeSSE` does
 * (verified against hono@4.12.26 `helper/streaming/sse.js`): `data` is split on `\r\n|\r|\n` and
 * EVERY line is re-prefixed `data: ` (so a raw newline in `data` becomes extra `data:` lines, never a
 * new `event:`/frame boundary), then `event`/`id` are appended and the frame is `\n\n`-terminated.
 * The trust-boundary framing test wire-encodes with THIS + re-parses to prove no forged event can materialize.
 */
function encodeHonoWire(frames: CapturedFrame[]): string {
  return frames
    .map((f) => {
      const dataLines = f.data
        .split(/\r\n|\r|\n/)
        .map((line) => `data: ${line}`)
        .join('\n');
      const head = [f.event && `event: ${f.event}`, dataLines, f.id && `id: ${f.id}`]
        .filter(Boolean)
        .join('\n');
      return `${head}\n\n`;
    })
    .join('');
}

/** Spec-parse the wire back into `{event?, data}` events (multiple `data:` lines join with `\n`). */
function parseWireEvents(wire: string): Array<{ event?: string; data: string }> {
  const out: Array<{ event?: string; data: string }> = [];
  for (const block of wire.split('\n\n')) {
    if (!block.trim()) continue;
    let event: string | undefined;
    const dataParts: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataParts.push(line.slice(5).replace(/^ /, ''));
    }
    out.push({ ...(event ? { event } : {}), data: dataParts.join('\n') });
  }
  return out;
}

const SSE_HEADERS = { accept: 'text/event-stream' };

describe('mountConversationCapability — the composable fragments', () => {
  it('returns BOTH stores, BOTH routes as whole tuples, and the route-kind handler map', () => {
    const mounted = mountConversationCapability({
      turnSubmittedSink: createInMemoryTurnSubmittedSink(),
      turnResponder: () => new FakeTurnResponder(),
    });
    expect(mounted.basePath).toBe(DEFAULT_CONVERSATION_BASE_PATH);
    // The mount's stores equal the store-schema function (single source).
    expect(mounted.stores).toEqual(conversationCapabilityStores());
    // WHOLE-TUPLE route assertions (the gate law: never just "a route exists").
    expect(mounted.api).toEqual([
      {
        method: 'PUT',
        path: '/conversations/{conversation_id}',
        action: { kind: 'handler', handler: 'conversation_input_create' },
      },
      {
        method: 'POST',
        path: '/conversations/{conversation_id}/turns',
        action: { kind: 'handler', handler: 'conversation_input_turn_submit' },
      },
    ]);
    expect([...mounted.handlers.keys()].sort()).toEqual(
      ['conversation_input_create', 'conversation_input_turn_submit'].sort(),
    );
    expect(mounted.handlers.get('conversation_input_create')?.kind).toBe('route');
    expect(mounted.handlers.get('conversation_input_turn_submit')?.kind).toBe('route');
    // THE TX-POSTURE TUPLE (whole-invariant): the TURN entry runs handler-managed (the engine
    // opens no route tx — the three-leg law); the CREATE entry stays on the engine-tx default.
    expect(mounted.handlers.get('conversation_input_turn_submit')?.routeTx).toBe('handler-managed');
    expect(mounted.handlers.get('conversation_input_create')?.routeTx).toBeUndefined();
  });

  it('honors a basePath override in BOTH mounted routes', () => {
    const mounted = mountConversationCapability({
      turnSubmittedSink: createInMemoryTurnSubmittedSink(),
      turnResponder: () => new FakeTurnResponder(),
      basePath: '/chats/',
    });
    expect(mounted.api[0]?.path).toBe('/chats/{conversation_id}');
    expect(mounted.api[1]?.path).toBe('/chats/{conversation_id}/turns');
  });
});

describe('mountConversationCapability — the bound handlers (create → turn → REAL reply)', () => {
  it('creates then submits a turn: the response = intake facts + the reply block; assistant row persisted; ONE event', async () => {
    const sink = createInMemoryTurnSubmittedSink();
    const h = harness(sink);

    const created = await driveCreate(h, 'c-1', { title: 'Support' });
    expect(created).toEqual({ conversation_id: 'c-1', state: 'open', deduped: false });

    const turn = (await driveTurn(h, 'c-1', { message_id: 'm-1', text: 'hello there' })) as Record<
      string,
      unknown
    >;
    // The intake facts survive as a SUPERSET (arm-compat: existing consumers keep working).
    expect(turn).toMatchObject({
      conversation_id: 'c-1',
      message_id: 'm-1',
      turn_seq: 1,
      event_id: `${TENANT}:c-1:m-1`,
      deduped: false,
    });
    // The reply block: a REAL reply produced in the same request (the fake derives it from the
    // received input — the input reached the responder trust-boundary-framed).
    const reply = turn.reply as { message: string; turn_seq: number; run_id: string };
    expect(reply.turn_seq).toBe(2);
    expect(reply.run_id).toBe('run-m-1');
    expect(reply.message).toContain('hello there'); // the echo proves the turn reached the model input.
    // The ledger: user row + assistant row; the reply row carries the derived reply refs.
    expect(h.tables.turns).toHaveLength(2);
    const assistant = h.tables.turns.find((r) => r.role === 'assistant');
    expect(assistant).toMatchObject({
      message_id: replyMessageId('m-1'),
      state: 'replied',
      run_id: 'run-m-1',
      turn_seq: 2,
    });
    // EXACTLY ONE delivered event — the assistant reply row emits NOTHING.
    expect(sink.deliveredCount()).toBe(1);
    expect(sink.deliveredFor(`${TENANT}:c-1:m-1`)).toMatchObject({
      conversation_id: 'c-1',
      message: 'hello there',
    });
    expect(h.responder.calls).toHaveLength(1);
  });

  it('an IDENTICAL re-POST dedups the intake AND returns the persisted reply with ZERO new model calls', async () => {
    const sink = createInMemoryTurnSubmittedSink();
    const h = harness(sink);
    await driveCreate(h, 'c-1');
    const first = (await driveTurn(h, 'c-1', { message_id: 'm-1', text: 'hi' })) as {
      reply: { message: string; run_id: string };
    };
    expect(h.responder.calls).toHaveLength(1);

    const again = (await driveTurn(h, 'c-1', { message_id: 'm-1', text: 'hi' })) as {
      deduped: boolean;
      reply: { message: string; run_id: string; usage?: unknown };
    };
    expect(again.deduped).toBe(true);
    // C10: the SAME persisted reply, ZERO additional responder/model invocations.
    expect(again.reply.message).toBe(first.reply.message);
    expect(again.reply.run_id).toBe(first.reply.run_id);
    expect(again.reply.usage).toBeUndefined(); // ledger-served — no fresh usage (honest).
    expect(h.responder.calls).toHaveLength(1);
    // Still exactly one assistant row + one delivered event (the re-POST re-emitted the stored
    // event for redelivery; the sink dedupes by event_id).
    expect(h.tables.turns.filter((r) => r.role === 'assistant')).toHaveLength(1);
    expect(sink.deliveredCount()).toBe(1);
  });

  it('maps the typed errors via httpResponse: create divergence 409; turn-body 422; oversize 413; missing conversation 409 — ZERO model work on each', async () => {
    const h = harness(createInMemoryTurnSubmittedSink());
    await driveCreate(h, 'c-1', { title: 'A' });

    const conflict = (await driveCreate(h, 'c-1', { title: 'B' })) as ReturnType<
      typeof httpResponse
    >;
    expect(conflict).toMatchObject({ status: 409, body: { error: 'conversation_conflict' } });

    const badBody = (await driveTurn(h, 'c-1', { message_id: 'm-1' })) as ReturnType<
      typeof httpResponse
    >;
    expect(badBody).toMatchObject({ status: 422, body: { error: 'invalid_turn_body' } });

    const oversize = (await driveTurn(h, 'c-1', {
      message_id: 'm-1',
      text: 'x'.repeat(32 * 1024 + 1),
    })) as ReturnType<typeof httpResponse>;
    expect(oversize).toMatchObject({ status: 413, body: { error: 'message_too_large' } });

    const missing = (await driveTurn(h, 'c-none', {
      message_id: 'm-1',
      text: 'x',
    })) as ReturnType<typeof httpResponse>;
    expect(missing).toMatchObject({ status: 409, body: { error: 'conversation_not_created' } });

    // No intake succeeded → the reply leg was never reached (zero model work).
    expect(h.responder.calls).toHaveLength(0);
  });

  it('a reply-leg failure returns the typed 502 CARRYING the committed intake facts + run_id (intake survives)', async () => {
    const sink = createInMemoryTurnSubmittedSink();
    const h = harness(sink);
    h.responder.outcome = () => ({
      status: 'error',
      runId: 'run-broken',
      errorClass: 'upstream_5xx',
      message: 'model exploded',
    });
    await driveCreate(h, 'c-1');
    const res = (await driveTurn(h, 'c-1', { message_id: 'm-1', text: 'hi' })) as ReturnType<
      typeof httpResponse
    > & { body: { intake?: unknown; run_id?: string } };
    expect(res).toMatchObject({
      status: 502,
      body: {
        error: 'conversation_reply_failed',
        run_id: 'run-broken',
        intake: {
          conversation_id: 'c-1',
          message_id: 'm-1',
          turn_seq: 1,
          deduped: false,
        },
      },
    });
    // THE INTAKE-ORDERING LAW: the model fault did NOT unwind the committed intake — the user turn
    // row is persisted and its event delivered (the async rails saw the turn).
    expect(h.tables.turns).toHaveLength(1);
    expect(h.tables.turns[0]?.role).toBe('user');
    expect(sink.deliveredCount()).toBe(1);
  });

  it('maps a sink ConversationEventRejectedError to the clean 403 with ZERO model work (commit-then-403)', async () => {
    const rejecting: TurnSubmittedSink = {
      emit: async () => {
        throw new ConversationEventRejectedError('cross_tenant', 'rejected fail-closed (test)');
      },
    };
    const h = harness(rejecting);
    await driveCreate(h, 'c-1');
    const res = (await driveTurn(h, 'c-1', { message_id: 'm-1', text: 'x' })) as ReturnType<
      typeof httpResponse
    >;
    expect(res).toMatchObject({ status: 403, body: { error: 'conversation_event_rejected' } });
    expect(JSON.stringify(res)).toContain('cross_tenant');
    // COMMIT-THEN-403 (the fail-closed semantics): the turn row COMMITTED (persist-then-emit is
    // the crash-recovery order) — and the reply leg was NEVER reached (zero model work).
    expect(h.tables.turns).toHaveLength(1);
    expect(h.responder.calls).toHaveLength(0);
  });

  it('a GENUINE sink fault still surfaces (rethrow → the platform 500) and ROLLS BACK the intake tx', async () => {
    const faulty: TurnSubmittedSink = {
      emit: async () => {
        throw new Error('genuine fault');
      },
    };
    const h = harness(faulty);
    await driveCreate(h, 'c-1');
    await expect(driveTurn(h, 'c-1', { message_id: 'm-1', text: 'x' })).rejects.toThrow(
      'genuine fault',
    );
    // Leg-1 owns a REAL tx now: the throw crossed it, so the un-emitted turn row rolled back (the
    // client retry re-persists + re-emits — the same recovery the engine-tx shape had).
    expect(h.tables.turns).toHaveLength(0);
    expect(h.responder.calls).toHaveLength(0);
  });
});

describe('mountConversationCapability — the SSE streaming egress (content-negotiated)', () => {
  it('Accept: text/event-stream → an sseResponse whose stream carries intake, deltas, and a terminal reply', async () => {
    const sink = createInMemoryTurnSubmittedSink();
    const h = harness(sink);
    // Model a token-streaming backend (Pi/Anthropic-Codex): two text_delta events flow through onEvent.
    h.responder.emit = [
      { type: 'text_delta', seq: 0, runId: 'run-m-1', text: 'hel' },
      { type: 'text_delta', seq: 1, runId: 'run-m-1', text: 'lo' },
    ];
    await driveCreate(h, 'c-1');

    const res = await driveTurn(h, 'c-1', { message_id: 'm-1', text: 'hello there' }, SSE_HEADERS);
    const frames = await collectSse(res);

    // The responder was driven WITH a live sink (the streaming thread), exactly once.
    expect(h.responder.receivedOnEvent).toBe(true);
    expect(h.responder.calls).toHaveLength(1);

    // Frame 0: the intake confirmation (durable — leg1 committed before the stream).
    expect(frames[0]?.event).toBe('conversation_intake');
    expect(JSON.parse(frames[0]?.data ?? '{}')).toMatchObject({
      conversation_id: 'c-1',
      message_id: 'm-1',
      turn_seq: 1,
    });
    // The middle frames are the pass-through NeutralEvent deltas (id = seq, event = type, honest).
    const deltas = frames.filter((f) => f.event === 'text_delta');
    expect(deltas.map((f) => JSON.parse(f.data).text)).toEqual(['hel', 'lo']);
    expect(deltas.map((f) => f.id)).toEqual(['0', '1']);
    // The terminal frame: the guaranteed COMPLETE reply (run_id + full text + the reply row's seq).
    const terminal = frames.at(-1);
    expect(terminal?.event).toBe('conversation_reply');
    const terminalBody = JSON.parse(terminal?.data ?? '{}');
    expect(terminalBody).toMatchObject({ run_id: 'run-m-1', turn_seq: 2 });
    // The fake echoes the trust-boundary-assembled input — the terminal carries the whole reply text.
    expect(terminalBody.text).toContain('hello there');

    // The reply is DURABLE regardless of the stream (leg3): the assistant row persisted; ONE event.
    expect(h.tables.turns.filter((r) => r.role === 'assistant')).toHaveLength(1);
    expect(sink.deliveredCount()).toBe(1);
  });

  it('ZERO-DELTA backend (OpenAI): no stream text — the terminal frame still carries the whole reply', async () => {
    const h = harness(createInMemoryTurnSubmittedSink());
    h.responder.emit = []; // OpenAI emits nothing through onEvent (verified non-streaming overload).
    await driveCreate(h, 'c-1');

    const frames = await collectSse(
      await driveTurn(h, 'c-1', { message_id: 'm-1', text: 'ping-zzz' }, SSE_HEADERS),
    );

    // No text_delta frames at all — but the reply is fully delivered in the terminal frame.
    expect(frames.some((f) => f.event === 'text_delta')).toBe(false);
    const terminal = frames.at(-1);
    expect(terminal?.event).toBe('conversation_reply');
    const body = JSON.parse(terminal?.data ?? '{}');
    expect(body).toMatchObject({ run_id: 'run-m-1' });
    expect(body.text).toContain('ping-zzz');
  });

  it('TERMINAL ⟷ RE-POST consistency: the stream terminal frame equals the C10 re-POST JSON reply (run_id, text, turn_seq)', async () => {
    const h = harness(createInMemoryTurnSubmittedSink());
    await driveCreate(h, 'c-1');

    // Stream the turn; capture the terminal reply fields.
    const frames = await collectSse(
      await driveTurn(h, 'c-1', { message_id: 'm-1', text: 'hi' }, SSE_HEADERS),
    );
    const streamed = JSON.parse(frames.at(-1)?.data ?? '{}');

    // Re-POST the SAME message_id as JSON (the C10 reconnect path) — the persisted reply, verbatim.
    const reposted = (await driveTurn(h, 'c-1', { message_id: 'm-1', text: 'hi' })) as {
      reply: { run_id: string; message: string; turn_seq: number };
    };
    expect({ run_id: streamed.run_id, text: streamed.text, turn_seq: streamed.turn_seq }).toEqual({
      run_id: reposted.reply.run_id,
      text: reposted.reply.message,
      turn_seq: reposted.reply.turn_seq,
    });
    // ONE model call across BOTH the stream and the re-POST (the stream ran it; the re-POST deduped).
    expect(h.responder.calls).toHaveLength(1);
  });

  it('a reply-leg FAILURE streams a terminal conversation_reply_error carrying the run_id (status already 200)', async () => {
    const h = harness(createInMemoryTurnSubmittedSink());
    h.responder.outcome = () => ({
      status: 'error',
      runId: 'run-broken',
      errorClass: 'upstream_5xx',
      message: 'model exploded',
    });
    await driveCreate(h, 'c-1');

    const frames = await collectSse(
      await driveTurn(h, 'c-1', { message_id: 'm-1', text: 'hi' }, SSE_HEADERS),
    );
    const terminal = frames.at(-1);
    expect(terminal?.event).toBe('conversation_reply_error');
    expect(JSON.parse(terminal?.data ?? '{}')).toMatchObject({
      error: 'conversation_reply_failed',
      run_id: 'run-broken',
    });
    // Intake still committed (the ordering law) — the user row persisted despite the reply failure.
    expect(h.tables.turns.filter((r) => r.role === 'user')).toHaveLength(1);
  });

  it('a mid-stream client disconnect (aborted) does NOT block the reply persist (leg3 completes server-side)', async () => {
    const h = harness(createInMemoryTurnSubmittedSink());
    await driveCreate(h, 'c-1');

    // Drive the producer with aborted=true from the start (client already gone).
    const frames = await collectSse(
      await driveTurn(h, 'c-1', { message_id: 'm-1', text: 'hi' }, SSE_HEADERS),
      true,
    );
    // No frames are emitted to a gone client (the producer short-circuits emits on abort)...
    expect(frames).toHaveLength(0);
    // ...but the reply STILL persisted server-side — the stream was only a VIEW.
    expect(h.tables.turns.filter((r) => r.role === 'assistant')).toHaveLength(1);
    expect(h.responder.calls).toHaveLength(1);
  });

  it('content-negotiation JSON path: no Accept → the JSON result (byte-identical); a malformed Accept ALSO → JSON (never a stream)', async () => {
    const h = harness(createInMemoryTurnSubmittedSink());
    await driveCreate(h, 'c-1');

    // No Accept header → the plain JSON result object (NOT an sseResponse).
    const jsonRes = (await driveTurn(h, 'c-1', { message_id: 'm-1', text: 'json-aaa' })) as Record<
      string,
      unknown
    >;
    expect((jsonRes as { sse?: unknown }).sse).toBeUndefined();
    expect(jsonRes).toMatchObject({ conversation_id: 'c-1', message_id: 'm-1', turn_seq: 1 });
    expect((jsonRes.reply as { message: string }).message).toContain('json-aaa');

    // A malformed / non-SSE Accept → still the JSON path, never a 500, never a stream.
    const garbageRes = (await driveTurn(
      h,
      'c-1',
      { message_id: 'm-2', text: 'json-bbb' },
      { accept: 'application/json, */*;q=0.1 nonsense' },
    )) as Record<string, unknown>;
    expect((garbageRes as { sse?: unknown }).sse).toBeUndefined();
    expect((garbageRes.reply as { message: string }).message).toContain('json-bbb');
  });

  it('TRUST-BOUNDARY SSE FRAMING: a hostile reply/delta cannot forge a second SSE event — every data payload is a single JSON-escaped line that round-trips the hostile text intact', async () => {
    const h = harness(createInMemoryTurnSubmittedSink());
    // A payload engineered to break out of a naive `data: <text>` frame: blank lines + forged
    // `event:`/`data:` line-starts, both LF and CRLF framing separators.
    const HOSTILE =
      'a\n\nevent: forged\ndata: {"pwned":true}\r\n\r\nevent: forged2\ndata: {"pwned":2}';
    h.responder.emit = [{ type: 'text_delta', seq: 0, runId: 'run-m-1', text: HOSTILE }];
    h.responder.outcome = () => ({
      status: 'completed',
      runId: 'run-m-1',
      text: HOSTILE,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
    await driveCreate(h, 'c-1');
    const frames = await collectSse(
      await driveTurn(h, 'c-1', { message_id: 'm-1', text: 'x' }, SSE_HEADERS),
    );

    // (1) THE PRODUCER FRAMING CONTRACT (the defense): EVERY data payload is a SINGLE line — no raw
    // CR/LF can reach the wire to open a new `event:`/`data:` line — and no frame is itself a forgery.
    // (RED if any frame builder emits raw text instead of JSON.stringify.)
    for (const f of frames) {
      expect(f.data.includes('\n')).toBe(false);
      expect(f.data.includes('\r')).toBe(false);
      expect(f.event).not.toBe('forged');
      expect(f.event).not.toBe('forged2');
    }
    // (2) the hostile text ROUND-TRIPS intact inside the JSON-escaped `data` of the legit frames.
    const delta = frames.find((f) => f.event === 'text_delta');
    expect(JSON.parse(delta?.data ?? '{}').text).toBe(HOSTILE);
    const terminal = frames.at(-1);
    expect(terminal?.event).toBe('conversation_reply');
    expect(JSON.parse(terminal?.data ?? '{}').text).toBe(HOSTILE);

    // (3) DEFENSE IN DEPTH — faithfully wire-encode (the Hono writeSSE per-line rule) + spec-parse:
    // NO forged event materializes anywhere in the stream; only the legit event names appear.
    const events = parseWireEvents(encodeHonoWire(frames));
    const eventNames = events.map((e) => e.event);
    expect(eventNames).not.toContain('forged');
    expect(eventNames).not.toContain('forged2');
    expect(eventNames).toEqual(['conversation_intake', 'text_delta', 'conversation_reply']);
  });

  it('TRUST-BOUNDARY INTAKE-FRAME FRAMING: a hostile message_id (raw CR/LF) cannot break the conversation_intake frame — its data stays one JSON-escaped line that round-trips the id intact', async () => {
    // The permissive pattern is the ONLY way to drive hostile bytes through the INTAKE builder — its
    // payload is otherwise all safe-id/number fields, so the earlier reply-text framing arm never
    // covered it (the framing gap). A BENIGN terminal reply keeps this arm isolated to the intake builder.
    const h = harness(createInMemoryTurnSubmittedSink(), {
      messageIdPattern: CRLF_ADMITTING_MESSAGE_ID_PATTERN,
    });
    h.responder.outcome = () => ({
      status: 'completed',
      runId: 'run-benign',
      text: 'benign reply',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
    await driveCreate(h, 'c-1');
    const frames = await collectSse(
      await driveTurn(h, 'c-1', { message_id: HOSTILE_MESSAGE_ID, text: 'x' }, SSE_HEADERS),
    );

    // THE FRAMING CONTRACT on the intake builder: the intake frame carries the hostile message_id yet
    // its data stays a SINGLE line — no raw CR/LF reaches the wire to open a new event:/data: line.
    // (RED if the intake builder emits raw text instead of JSON.stringify.)
    const intake = frames.find((f) => f.event === 'conversation_intake');
    expect(intake).toBeDefined();
    expect(intake?.data.includes('\n')).toBe(false);
    expect(intake?.data.includes('\r')).toBe(false);
    // ...and the hostile id ROUND-TRIPS intact inside the JSON-escaped `data`.
    expect(JSON.parse(intake?.data ?? '{}').message_id).toBe(HOSTILE_MESSAGE_ID);

    // EVERY frame stays single-line + is a legit event name (no builder emits a forgery).
    for (const f of frames) {
      expect(f.data.includes('\n')).toBe(false);
      expect(f.data.includes('\r')).toBe(false);
      expect(f.event).not.toBe('forged');
      expect(f.event).not.toBe('forged2');
    }
    // DEFENSE IN DEPTH — wire-encode (the Hono per-line rule) + spec-parse: no forged event anywhere.
    const eventNames = parseWireEvents(encodeHonoWire(frames)).map((e) => e.event);
    expect(eventNames).not.toContain('forged');
    expect(eventNames).not.toContain('forged2');
  });

  it('TRUST-BOUNDARY ERROR-FRAME FRAMING: an unexpected reply-leg throw + a hostile message_id cannot break the conversation_reply_error frame — its data stays one JSON-escaped line', async () => {
    const h = harness(createInMemoryTurnSubmittedSink(), {
      messageIdPattern: CRLF_ADMITTING_MESSAGE_ID_PATTERN,
    });
    // An unexpected throw → the producer emits a terminal conversation_reply_error frame CARRYING
    // the committed intake, whose message_id is hostile — driving hostile bytes through the ERROR
    // builder (the earlier arm only ever asserted BENIGN content there — the second half of the framing gap).
    h.responder.throwError = Object.assign(new Error('persist exploded'), {
      errorClass: 'internal',
    });
    await driveCreate(h, 'c-1');
    const frames = await collectSse(
      await driveTurn(h, 'c-1', { message_id: HOSTILE_MESSAGE_ID, text: 'x' }, SSE_HEADERS),
    );

    // THE FRAMING CONTRACT on the error builder: the error frame's data stays a SINGLE line despite
    // the hostile message_id riding in its `intake`. (RED if the error builder emits raw text instead
    // of JSON.stringify.)
    const errFrame = frames.find((f) => f.event === 'conversation_reply_error');
    expect(errFrame).toBeDefined();
    expect(errFrame?.data.includes('\n')).toBe(false);
    expect(errFrame?.data.includes('\r')).toBe(false);
    // ...and the hostile id ROUND-TRIPS intact inside the JSON-escaped intake block.
    expect(JSON.parse(errFrame?.data ?? '{}').intake.message_id).toBe(HOSTILE_MESSAGE_ID);

    // EVERY frame single-line + a legit event (BOTH the intake AND the error frame carry the id).
    for (const f of frames) {
      expect(f.data.includes('\n')).toBe(false);
      expect(f.data.includes('\r')).toBe(false);
      expect(f.event).not.toBe('forged');
      expect(f.event).not.toBe('forged2');
    }
    const eventNames = parseWireEvents(encodeHonoWire(frames)).map((e) => e.event);
    expect(eventNames).not.toContain('forged');
    expect(eventNames).not.toContain('forged2');
  });

  it('the client-stream forwarder is text_delta-ONLY: tool/reasoning/lifecycle events NEVER reach the client (they stay durable in run_events)', async () => {
    const h = harness(createInMemoryTurnSubmittedSink());
    // A tool-using responder of the future emits the FULL NeutralEvent vocabulary through onEvent.
    h.responder.emit = [
      { type: 'run_started', seq: 0, runId: 'run-m-1' },
      { type: 'reasoning_delta', seq: 1, runId: 'run-m-1', text: 'thinking privately' },
      {
        type: 'tool_called',
        seq: 2,
        runId: 'run-m-1',
        toolCallId: 't1',
        name: 'search',
        args: { q: 'SECRET-INTERNAL-ARG' },
      },
      {
        type: 'tool_result',
        seq: 3,
        runId: 'run-m-1',
        toolCallId: 't1',
        name: 'search',
        result: { hit: 'SECRET-INTERNAL-RESULT' },
      },
      { type: 'text_delta', seq: 4, runId: 'run-m-1', text: 'answer' },
      {
        type: 'run_completed',
        seq: 5,
        runId: 'run-m-1',
        status: 'ok',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      },
    ];
    await driveCreate(h, 'c-1');
    const frames = await collectSse(
      await driveTurn(h, 'c-1', { message_id: 'm-1', text: 'x' }, SSE_HEADERS),
    );

    // ONLY: the capability intake frame, the single text_delta, and the terminal conversation_reply.
    expect(frames.map((f) => f.event)).toEqual([
      'conversation_intake',
      'text_delta',
      'conversation_reply',
    ]);
    // The tool internals + reasoning + run lifecycle never crossed the client boundary — no leak of
    // tool args/results/reasoning onto the chat stream.
    expect(
      frames.some((f) =>
        ['run_started', 'reasoning_delta', 'tool_called', 'tool_result', 'run_completed'].includes(
          f.event ?? '',
        ),
      ),
    ).toBe(false);
    const wire = JSON.stringify(frames);
    expect(wire).not.toContain('SECRET-INTERNAL-ARG');
    expect(wire).not.toContain('SECRET-INTERNAL-RESULT');
    expect(wire).not.toContain('thinking privately');
    // ...yet the terminal reply is STILL built (lifecycle-independent — from ensureTurnReply's return,
    // NOT from seeing run_completed).
    expect(frames.at(-1)?.event).toBe('conversation_reply');
    expect(JSON.parse(frames.at(-1)?.data ?? '{}').text).toContain('x');
  });

  it('terminal-frame usage: a FRESH streamed reply carries usage EQUAL to the fresh JSON path; a ledger-served re-POST has NO usage in EITHER representation', async () => {
    const h = harness(createInMemoryTurnSubmittedSink());
    await driveCreate(h, 'c-1');

    // (a) a FRESH streamed reply → the terminal frame carries the run's usage.
    const streamFrames = await collectSse(
      await driveTurn(h, 'c-1', { message_id: 'm-1', text: 'hi' }, SSE_HEADERS),
    );
    const streamedTerminal = JSON.parse(streamFrames.at(-1)?.data ?? '{}');
    expect(streamedTerminal.usage).toEqual({ inputTokens: 1, outputTokens: 1, totalTokens: 2 });
    // ...and it EQUALS a FRESH JSON reply's usage (a sibling turn, same responder outcome — the two
    // distinct emit sites agree on the usage cherry-pick). (RED if the terminal drops the cherry-pick.)
    const jsonFresh = (await driveTurn(h, 'c-1', { message_id: 'm-2', text: 'hi2' })) as {
      reply: { usage?: unknown };
    };
    expect(jsonFresh.reply.usage).toEqual(streamedTerminal.usage);

    // (b) a LEDGER-SERVED reply (C10 re-POST) reports NO usage — consistently in BOTH the JSON reply
    // AND the terminal frame (a known residual: the run header stores no token counts to re-derive).
    const jsonRepost = (await driveTurn(h, 'c-1', { message_id: 'm-1', text: 'hi' })) as {
      reply: { usage?: unknown };
    };
    expect(jsonRepost.reply.usage).toBeUndefined();
    const streamRepost = await collectSse(
      await driveTurn(h, 'c-1', { message_id: 'm-1', text: 'hi' }, SSE_HEADERS),
    );
    expect('usage' in JSON.parse(streamRepost.at(-1)?.data ?? '{}')).toBe(false);
  });

  it('an UNEXPECTED reply-leg throw still streams a terminal conversation_reply_error (JSON-500 symmetry) — the stream closes cleanly, no hang', async () => {
    const sink = createInMemoryTurnSubmittedSink();
    const h = harness(sink);
    // Emit two deltas, THEN throw an unexpected fault (NOT the {ok:false} Result path) mid-stream.
    h.responder.emit = [{ type: 'text_delta', seq: 0, runId: 'run-m-1', text: 'par' }];
    h.responder.throwError = Object.assign(new Error('persist exploded'), {
      errorClass: 'internal',
    });
    await driveCreate(h, 'c-1');

    // The producer must NOT throw out (that would tear the stream down silently); it emits the frame.
    const frames = await collectSse(
      await driveTurn(h, 'c-1', { message_id: 'm-1', text: 'x' }, SSE_HEADERS),
    );
    const terminal = frames.at(-1);
    expect(terminal?.event).toBe('conversation_reply_error');
    const body = JSON.parse(terminal?.data ?? '{}');
    expect(body.error).toBe('conversation_reply_failed');
    expect(body.errorClass).toBe('internal'); // best-effort extraction off the thrown value.
    expect(body.intake).toMatchObject({ conversation_id: 'c-1', message_id: 'm-1', turn_seq: 1 });
    // THE INTAKE-ORDERING LAW held despite the throw: the user turn committed + its event delivered.
    expect(h.tables.turns.filter((r) => r.role === 'user')).toHaveLength(1);
    expect(sink.deliveredCount()).toBe(1);
    // No assistant reply row (the reply leg threw before persisting) — the client re-POSTs to converge.
    expect(h.tables.turns.filter((r) => r.role === 'assistant')).toHaveLength(0);
  });

  it('content-negotiation honors q-values: text/event-stream;q=0 → JSON; a positive-q SSE range → stream; malformed → JSON (never a 500)', async () => {
    const h = harness(createInMemoryTurnSubmittedSink());
    await driveCreate(h, 'c-1');

    // q=0 is an EXPLICIT refusal of streaming → the JSON path (the substring form wrongly streamed it).
    const refused = (await driveTurn(
      h,
      'c-1',
      { message_id: 'm-1', text: 'x' },
      { accept: 'text/event-stream;q=0' },
    )) as Record<string, unknown>;
    expect((refused as { sse?: unknown }).sse).toBeUndefined();
    expect(refused.reply).toBeDefined();

    // a POSITIVE q on the SSE range → the stream (the client positively asked for SSE).
    const streamed = await driveTurn(
      h,
      'c-1',
      { message_id: 'm-2', text: 'x' },
      { accept: 'application/json, text/event-stream;q=0.9' },
    );
    expect((streamed as { sse?: unknown }).sse).toBeDefined();

    // a MALFORMED Accept still defaults to JSON (never a throw / 500).
    const malformed = (await driveTurn(
      h,
      'c-1',
      { message_id: 'm-3', text: 'x' },
      { accept: '=;;;q' },
    )) as Record<string, unknown>;
    expect((malformed as { sse?: unknown }).sse).toBeUndefined();
    expect(malformed.reply).toBeDefined();
  });
});
