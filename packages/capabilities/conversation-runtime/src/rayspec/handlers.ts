/**
 * The RaySpec platform binding (the record/file `rayspec/handlers.ts` pattern) — the thin
 * adapter that turns the product-neutral capability core into `RouteHandler` functions running
 * behind RaySpec's real auth/tenancy chain. It imports `@rayspec/handler-sdk` TYPE-ONLY for
 * shapes (plus the `httpResponse` envelope helper), threading `init.db`/`init.tenantId`/
 * `init.params`/`init.body` straight into the core ports. The binding owns ONLY transport concerns
 * (status-code mapping, the sink-rejection 403); the contract lives in the core
 * (create.ts / submit-turn.ts / reply.ts).
 *
 * ── THE S3 TURN FLOW (the routeTx:'handler-managed' posture — THREE legs, one request) ─────────
 * The turn-submit handler ENTRY opts into handler-managed transactions (mount.ts sets the flag),
 * so the engine holds NO route transaction and this binding choreographs:
 *
 *   LEG 1 — INTAKE (its own short tx): `init.db.transaction` around the UNCHANGED S1 `submitTurn`
 *   core. Inside that real outer tx the core's nested insert tx is still a SAVEPOINT, so the
 *   concurrent-turn typed-409 law holds byte-identically. The tx COMMITS when the leg resolves — the intake
 *   (turn persist + event emit) is DURABLE before any model work (the intake-ordering law; a
 *   model fault can never roll it back).
 *   COMMIT-THEN-403 (preserved S2 semantics, pin-mandated): a sink's deliberate fail-closed
 *   `ConversationEventRejectedError` is caught INSIDE the tx callback and carried out as a
 *   sentinel — the persisted turn row COMMITS (persist-then-emit is the crash-recovery order; the
 *   e2e's honest-intermediate-state arm) and the binding maps it to the clean 403 AFTER the
 *   commit, with ZERO model work. A GENUINE sink fault still throws THROUGH the tx (leg 1 rolls
 *   back → the platform 500 → a client retry re-persists + re-emits — the same recovery the S2
 *   engine-tx shape had).
 *
 *   LEG 2+3 — THE REPLY (`ensureTurnReply`, reply.ts): runs with NO transaction held; the model
 *   leg is tx-free (run-core's streaming-persist law) and the reply persists in its own short tx.
 *   A reply-leg error NEVER unwinds the committed intake — it maps to the reply-leg error body
 *   CARRYING the intake facts + the deterministic run id, so the client knows the turn was
 *   accepted and retries the SAME message_id to converge (C10 — no second model call).
 *
 * The create handler is UNCHANGED (engine-tx posture — it runs no model).
 */
import {
  httpResponse,
  type RouteHandler,
  type RouteHandlerInit,
  type SseFrame,
  type SseProducer,
  sseResponse,
} from '@rayspec/handler-sdk';
import type { ResolvedConversationConfig } from '../config.js';
import { createConversation } from '../create.js';
import type { ConversationCapabilityError } from '../errors.js';
import { ConversationEventRejectedError, type TurnSubmittedSink } from '../events.js';
import type { ConversationCoreContext } from '../ports.js';
import { ensureTurnReply } from '../reply.js';
import type { ConversationTurnResponder, ConversationTurnResponderFactory } from '../responder.js';
import { submitTurn } from '../submit-turn.js';
import type {
  ConversationErrorBody,
  ConversationReplyErrorBody,
  TurnSubmitResult,
  TurnSubmitWithReplyResult,
} from '../types.js';

/** The wiring the capability handlers need (built by `mountConversationCapability`). */
export interface ConversationHandlersConfig {
  readonly resolved: ResolvedConversationConfig;
  /** The sink turn-submit (and its 409 heal) emits `turn_submitted` through — the event seam. */
  readonly turnSubmittedSink: TurnSubmittedSink;
  /**
   * The tenant-bound responder factory — invoked per request with the SERVER-DERIVED
   * `init.tenantId` (the blobFactory closure trust shape). REQUIRED: a submitted turn
   * produces a real reply; a deployment without a wired responder fails closed at compose.
   */
  readonly turnResponder: ConversationTurnResponderFactory;
}

/** Build the core context from a `{handler}` route init. */
function coreContext(
  init: RouteHandlerInit,
  config: ResolvedConversationConfig,
): ConversationCoreContext {
  return { tenantId: init.tenantId, db: init.db, config };
}

/** Render a typed capability error into its JSON body. */
function errorBody(result: ConversationCapabilityError): ConversationErrorBody {
  return { error: result.error, detail: result.detail };
}

/** The stable rejected-event 403 body (the record/file E2E posture). */
function rejectedBody(e: ConversationEventRejectedError): ConversationErrorBody {
  return {
    error: 'conversation_event_rejected',
    detail: `the turn_submitted event was rejected fail-closed (${e.reason}) — no workflow was started.`,
  };
}

/** The `conversation_input.create` handler route (idempotent client-keyed create; emits nothing). */
export function makeConversationCreateHandler(config: ConversationHandlersConfig): RouteHandler {
  return async (init: RouteHandlerInit) => {
    const ctx = coreContext(init, config.resolved);
    const result = await createConversation(ctx, init.params, init.body);
    if (result.ok) return result.value;
    return httpResponse({ status: result.status, body: errorBody(result) });
  };
}

/** Leg-1's discriminated outcome — carried OUT of the intake tx so the tx commits on every arm. */
type IntakeOutcome =
  | { readonly kind: 'ok'; readonly value: TurnSubmitResult }
  | { readonly kind: 'err'; readonly result: ConversationCapabilityError }
  | { readonly kind: 'rejected'; readonly rejection: ConversationEventRejectedError };

/**
 * The `conversation_input.submit_turn` handler route — the three-leg turn flow (module header),
 * CONTENT-NEGOTIATED for streaming. Registered with `routeTx: 'handler-managed'` (mount.ts),
 * so `init.db` is UN-transacted and every write here owns its transaction.
 *
 * ── CONTENT NEGOTIATION (the stream is a VIEW of a COMPLETE-INDEPENDENTLY operation) ─────────
 * LEG 1 (intake) commits FIRST regardless of representation — the intake-ordering law. A pre-stream
 * intake outcome (rejected/err) returns the JSON error envelope with its REAL status (a stream can
 * never carry a non-200 for it — the SSE headers would already be flushed). ONLY a COMMITTED intake
 * may stream. Then:
 *   - `Accept: text/event-stream` → an `sseResponse` whose producer runs leg 2+3 (`ensureTurnReply`)
 *     with a live `onEvent` that forwards the reply run's `text_delta` events ONLY as pass-through SSE
 *     frames (the SS-2 allowlist — tool/reasoning/lifecycle events stay durable in run_events, off the
 *     client stream), then emits ONE terminal `conversation_reply` (the guaranteed complete reply —
 *     load-bearing for a zero-delta backend) or `conversation_reply_error` frame. The reply PERSISTS
 *     server-side regardless of the client connection; a disconnected client reconnects by re-POSTing
 *     the SAME message_id (the C10 dedup path — reply.ts) and gets the identical persisted reply (the
 *     terminal frame and the re-POST JSON carry the SAME `{run_id,text,turn_seq}`).
 *   - any other / absent / MALFORMED Accept → the JSON path, BYTE-IDENTICAL (never a 500).
 */
export function makeTurnSubmitHandler(config: ConversationHandlersConfig): RouteHandler {
  return async (init: RouteHandlerInit) => {
    const ctx = coreContext(init, config.resolved);

    // ── LEG 1 — the intake, committed before any model work (the intake-ordering law). ─────────
    const intake: IntakeOutcome = await init.db.transaction(async (tx) => {
      const txCtx: ConversationCoreContext = { ...ctx, db: tx };
      try {
        const result = await submitTurn(txCtx, init.params, init.body, config.turnSubmittedSink);
        if (result.ok) return { kind: 'ok', value: result.value } as const;
        return { kind: 'err', result } as const;
      } catch (e) {
        // COMMIT-THEN-403 (module header): the deliberate fail-closed rejection is a sentinel, so
        // the persisted turn row COMMITS (nothing was enqueued — the S2 semantics, byte-preserved).
        // Any OTHER throw crosses the tx (leg 1 rolls back) and surfaces as the platform 500.
        if (e instanceof ConversationEventRejectedError) {
          return { kind: 'rejected', rejection: e } as const;
        }
        throw e;
      }
    });

    if (intake.kind === 'rejected') {
      // ZERO model work on a rejected event (pinned): the reply leg is never reached.
      return httpResponse({ status: 403, body: rejectedBody(intake.rejection) });
    }
    if (intake.kind === 'err') {
      return httpResponse({ status: intake.result.status, body: errorBody(intake.result) });
    }

    // ── LEG 2+3 — the reply. Content-negotiated: stream iff the client asked for SSE. ──────────
    const responder = config.turnResponder(init.tenantId);

    if (wantsEventStream(init.headers)) {
      // The intake is COMMITTED; the stream is a VIEW of the reply that completes independently.
      return sseResponse(makeTurnReplyProducer(ctx, responder, intake.value));
    }

    // JSON (the S3 path, byte-identical): no live sink; reply.ts owns its short txs + convergence.
    const reply = await ensureTurnReply(ctx, responder, intake.value);
    if (!reply.ok) {
      const body: ConversationReplyErrorBody = {
        error: reply.error,
        detail: reply.detail,
        intake: intake.value,
        run_id: reply.runId,
      };
      return httpResponse({ status: reply.status, body });
    }

    const result: TurnSubmitWithReplyResult = { ...intake.value, reply: reply.value };
    return result;
  };
}

/** The capability SSE `event:` names (the transport contract — NOT NeutralEvents, NOT in run_events). */
const INTAKE_FRAME_EVENT = 'conversation_intake';
const REPLY_FRAME_EVENT = 'conversation_reply';
const REPLY_ERROR_FRAME_EVENT = 'conversation_reply_error';

/**
 * True iff the client negotiated an SSE stream. FAIL-SAFE by construction: a non-string / absent /
 * malformed `Accept` is simply "not a stream" → the JSON path (never a throw, never a 500). The
 * header is the forwarded, lowercase-keyed `accept` (route-handlers.ts collectHeaders).
 *
 * q-value aware (minimally): a media range's `;q=0` is an EXPLICIT refusal, so
 * `text/event-stream;q=0` negotiates JSON (the substring form wrongly streamed it). A POSITIVE q
 * (or none) on `text/event-stream` accepts the stream — `application/json, text/event-stream;q=0.9`
 * streams (the client positively asked for SSE; a JSON-only client sends no event-stream range or
 * `;q=0`). Only the SSE media range's own q is consulted (a streaming endpoint streams iff the
 * client is willing to receive the stream); we do NOT rank it against other ranges' q. Anything we
 * cannot parse falls through to `false` (JSON) — never a throw.
 */
function wantsEventStream(headers: RouteHandlerInit['headers']): boolean {
  const accept = headers?.accept;
  if (typeof accept !== 'string') return false;
  try {
    for (const range of accept.toLowerCase().split(',')) {
      const [mediaType, ...params] = range.trim().split(';');
      if (mediaType?.trim() !== 'text/event-stream') continue;
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      if (q === undefined) return true; // no q ⇒ default q=1 ⇒ accepted.
      const value = Number.parseFloat(q.slice(2));
      // A parseable q≤0 is an explicit refusal → JSON; any other q (incl. an unparseable one on an
      // otherwise-present SSE range) is treated as a positive preference → stream.
      return !(Number.isFinite(value) && value <= 0);
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Build the SSE producer that streams ONE turn's reply. The engine drives it (route-handlers.ts):
 *  1. a leading `conversation_intake` frame — the COMMITTED intake facts (durable; leg 1 already ran);
 *  2. the reply run's `text_delta` events ONLY, forwarded as pass-through frames (id = seq, event =
 *     `text_delta`) — the SS-2 client-stream allowlist (neutralEventToFrame). Honest per-backend
 *     cardinality: Pi = token deltas, Anthropic/Codex = ONE whole-message delta, OpenAI = NONE. The
 *     streamed delta count is therefore a LOWER bound on the reply content (a zero-delta backend
 *     streams no text_delta at all); the AUTHORITATIVE whole reply is the terminal frame below, and
 *     real per-backend N is pinned by S5's live smoke, not by the delta count here (PBC-2/PBC-3).
 *  3. a terminal `conversation_reply` frame carrying the WHOLE reply (`run_id`/`text`/`turn_seq`/
 *     `usage?`) — built from `ensureTurnReply`'s RETURN (lifecycle-independent: it does NOT depend on
 *     seeing a `run_completed` event), so it is the guaranteed delivery even when zero deltas flowed —
 *     OR a `conversation_reply_error` frame carrying the run id (the SSE 200 is already flushed; the
 *     status cannot change — the donor honesty note).
 * `signal.aborted` (client disconnect) short-circuits EMITS only; `ensureTurnReply` STILL runs to
 * completion (the reply persists server-side — the stream is a view).
 *
 * The UNEXPECTED-THROW symmetry: the whole reply leg is wrapped, so an unexpected throw (an
 * infra/persist fault — NOT the `{ok:false}` Result path, which already emits the error frame) still
 * emits a `conversation_reply_error` terminal frame BEFORE the stream closes (carrying errorClass/
 * run_id when the throw exposes them). This restores parity with the JSON path (there an unexpected
 * throw becomes the platform 500); without it the stream would tear down silently (Hono's default
 * `run` only console.errors when no onError is wired — route-handlers.ts wires none).
 */
function makeTurnReplyProducer(
  ctx: ConversationCoreContext,
  responder: ConversationTurnResponder,
  intake: TurnSubmitResult,
): SseProducer {
  return async (emit, signal) => {
    if (!signal.aborted) {
      await emit({
        event: INTAKE_FRAME_EVENT,
        data: JSON.stringify({
          conversation_id: intake.conversation_id,
          message_id: intake.message_id,
          turn_seq: intake.turn_seq,
        }),
      });
    }

    let reply: Awaited<ReturnType<typeof ensureTurnReply>>;
    try {
      reply = await ensureTurnReply(ctx, responder, intake, {
        onEvent: async (event) => {
          if (signal.aborted) return;
          const frame = neutralEventToFrame(event);
          if (frame) await emit(frame);
        },
      });
    } catch (err) {
      // SS-3: an UNEXPECTED fault (the model leg or the persist threw outright). The SSE 200 headers
      // are already flushed, so this can never become a JSON 500 — emit the typed error frame the
      // asymmetry would otherwise hide, then close cleanly. The intake is DURABLE (leg 1 committed);
      // the client re-POSTs the SAME message_id to converge (C10). Best-effort errorClass/run_id.
      if (signal.aborted) return; // client already gone — nothing to deliver.
      await emit({
        event: REPLY_ERROR_FRAME_EVENT,
        data: JSON.stringify({
          error: 'conversation_reply_failed',
          detail:
            'the reply leg errored unexpectedly — the submitted turn IS persisted and its ' +
            'workflow event emitted; retry with the SAME message_id to converge on one reply.',
          ...(errorClassOf(err) ? { errorClass: errorClassOf(err) } : {}),
          ...(runIdOf(err) ? { run_id: runIdOf(err) } : {}),
          intake,
        }),
      });
      return;
    }

    if (signal.aborted) return; // client gone — the reply already persisted; nothing to deliver.

    if (reply.ok) {
      await emit({
        event: REPLY_FRAME_EVENT,
        data: JSON.stringify({
          run_id: reply.value.run_id,
          text: reply.value.message,
          turn_seq: reply.value.turn_seq,
          ...(reply.value.usage ? { usage: reply.value.usage } : {}),
        }),
      });
      return;
    }
    await emit({
      event: REPLY_ERROR_FRAME_EVENT,
      data: JSON.stringify({
        error: reply.error,
        detail: reply.detail,
        run_id: reply.runId,
        intake,
      }),
    });
  };
}

/** Best-effort neutral `errorClass` off an unknown thrown value (SS-3 — present when the throw carries one). */
function errorClassOf(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null) {
    const c = (err as { errorClass?: unknown }).errorClass;
    if (typeof c === 'string' && c.length > 0) return c;
  }
  return undefined;
}

/** Best-effort `runId` off an unknown thrown value (SS-3 — present when the throw carries one). */
function runIdOf(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null) {
    const r = (err as { runId?: unknown }).runId;
    if (typeof r === 'string' && r.length > 0) return r;
  }
  return undefined;
}

/**
 * The client-stream event allowlist (the external-exposure-safe posture): the generic NeutralEvent
 * forwarder emits ONLY `text_delta` frames to the conversation client. Every OTHER reply-run event —
 * `run_started`/`run_completed` lifecycle, `reasoning_delta`, and the `tool_called`/`tool_result`/
 * `tool_error` tool internals (args + results) — is NOT forwarded (it would leak model internals to a
 * chat client the moment a tool-using responder ships). Those events STILL persist durably in
 * run_events (run-core's persist-before-flush), so the GET/replay path keeps them; only the live
 * client stream is narrowed. The capability frames (`conversation_intake` + the terminal
 * `conversation_reply`/`conversation_reply_error`) are emitted EXPLICITLY by the producer, never via
 * this forwarder — the terminal reply is built from `ensureTurnReply`'s return, lifecycle-independent.
 */
const STREAMED_EVENT_TYPES: ReadonlySet<string> = new Set(['text_delta']);

/**
 * Map a reply-run NeutralEvent to a client-stream SSE frame, ALLOWLISTED: only a `text_delta`
 * event becomes a frame; everything else is OMITTED (durable in run_events, never on the client
 * stream). FAIL-CLOSED (the donor `toSseFrame` discipline): an event we cannot faithfully serialize —
 * or one lacking a string `type` — is OMITTED, never fabricated. Read STRUCTURALLY (no core-event
 * dependency) so the capability stays neutral; `data` is the whole (allowlisted) event so a client
 * reads its own `text`. The `id` = the run's DURABLE event `seq` — a cursor into the runs-events
 * REPLAY surface (`GET /v1/runs/{id}/events?lastEventId=`; the frame's `data.runId` names the run),
 * NOT a live-tail resume cursor on this turn route (reconnect is the idempotent re-POST;
 * informational, honest).
 */
function neutralEventToFrame(event: unknown): SseFrame | undefined {
  if (typeof event !== 'object' || event === null) return undefined;
  const e = event as { seq?: unknown; type?: unknown };
  if (typeof e.type !== 'string' || !STREAMED_EVENT_TYPES.has(e.type)) return undefined;
  try {
    return {
      ...(typeof e.seq === 'number' ? { id: String(e.seq) } : {}),
      event: e.type,
      data: JSON.stringify(event),
    };
  } catch {
    return undefined;
  }
}
