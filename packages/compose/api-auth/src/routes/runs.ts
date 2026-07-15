/**
 * Agent-run HTTP/SSE routes (REST+SSE) — the thin sync-streamed run surface.
 *
 * Mounted on the SAME createAuthApp middleware chain as every other route
 * (requestId → securityHeaders → authenticate → resolveTenant → requirePermission), so:
 *  - the tenant is SERVER-DERIVED via resolveTenant (NEVER a client-supplied tenant/org), and
 *  - run_events / runs / journal_steps / conversation_items are read+written tenant-scoped via
 *    forTenant (the TenantDb chokepoint) — a foreign/absent runId is a uniform 404, no leak.
 *
 * Endpoints:
 *  - POST   /v1/agents/{id}/runs        — start a run. Idempotency-Key → run-level idempotency.
 *                                         Content-negotiated: Accept: text/event-stream → SSE stream
 *                                         of NeutralEvents; else → the JSON RunResult. The SDK call
 *                                         is held IN-REQUEST (sync-but-streamed) with an AbortSignal
 *                                         timeout. Agent resolved from the injected (minimal) registry.
 *  - GET    /v1/runs/{id}               — reconstruct the neutral RunResult from the journal +
 *                                         conversation store for THIS tenant (404 on foreign/absent).
 *  - GET    /v1/runs/{id}/events        — REPLAY run_events as SSE (id: = seq), ONE-SHOT (not a live
 *                                         tail): it streams the durable rows with seq > lastEventId and
 *                                         then ENDS. A client resumes / pulls newly-persisted events for
 *                                         an in-flight async run by RE-REQUESTING from Last-Event-ID /
 *                                         lastEventId (reconnect-and-replay; a live server-push tail
 * is not built).
 *
 * the SYNC run executes in-request; an `async:true` run is ENQUEUED onto the durable
 * worker (the neutral `deps.durableExecutor`) and returns 202 + the runId — the client streams
 * completion via the EXISTING GET /v1/runs/{id}/events (reconnect-and-replay; run_events persists
 * off-request). With no durable worker wired, `async:true` is a clean fail-closed 501. The agent
 * registry is a MINIMAL seam — the full declarative engine is.
 *
 * a persisted/served event `data` is the already-NEUTRALIZED NeutralEvent (tool results are
 * the opaque tool_data dispatchTool produced) — there is no raw path here. The Idempotency-Key
 * snapshot stores ONLY the runId + a body hash (never secrets / the run output).
 */

import { createHash, randomUUID } from 'node:crypto';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { ApiError, errorEnvelope } from '@rayspec/auth-core';
import type { AgentSpec, ConvTurn, ErrorClass, RunResult, Usage } from '@rayspec/core';
import { assertSpecValid, classifyUpstreamError, isErrorClass, NeutralEvent } from '@rayspec/core';
import { forTenant, schema, type TenantDb } from '@rayspec/db';
import { isRunTainted, rehydrateConversation, runAgent } from '@rayspec/platform';
import { and, asc, eq, gt } from 'drizzle-orm';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { AgentRegistryEntry, AppDeps, AppEnv } from '../app-context.js';
import { requireAuth, requirePermission, resolveTenant } from '../http/middleware.js';

/** The HTTP status codes the sync run endpoint maps an errorClass to (Hono's c.json status arg). */
type HttpStatusCode = 200 | 429 | 502 | 504;

/** The Idempotency-Key scope for run-level idempotency (distinct from the step-level journal key). */
const RUN_IDEM_SCOPE = 'agent_run';

/** Default in-request run timeout (ms): the SDK call is held open; this bounds it (risk). */
const DEFAULT_RUN_TIMEOUT_MS = 120_000;

/**
 * The request body for POST /agents/{id}/runs. The `input` is required; a small set of allowed
 * overrides may tune the base registry spec (NEVER the tenant — that is server-derived). Strict so
 * an unknown field is rejected (no silent passthrough of attacker-controlled spec fields).
 */
export const StartRunRequest = z
  .object({
    input: z.string().min(1),
    /** Optional per-run override of the base spec's instructions (e.g. a prompt variant). */
    instructions: z.string().optional(),
    /** Optional per-run override of maxTurns (bounded). */
    maxTurns: z.number().int().positive().max(50).optional(),
    /**
     * Request an ASYNC (job-queued, off-request) run.: when a durable worker is wired
     * (`deps.durableExecutor` + `deployment.durableWorker:true`), `async:true` ENQUEUES the run and
     * returns 202 + the runId immediately (the client streams completion via GET /v1/runs/{id}/events
     * ). With NO durable worker wired it is a clean fail-closed 501 (never a silent sync fallback
     * that would violate the async-execution constraint — long runs must not block a sync HTTP request).
     */
    async: z.boolean().optional(),
  })
  .strict();

/** What GET /runs/{id} reconstructs — the neutral RunResult (always-present output/error). */
type ReconstructedRun = RunResult;

export function registerRunsRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps): void {
  // POST /v1/agents/:id/runs — start a run (agent:run; non-sensitive but tenant + Bearer/api-key).
  app.post(
    '/v1/agents/:id/runs',
    requireAuth(),
    resolveTenant(deps),
    requirePermission(deps, 'agent:run'),
    async (c) => executeAgentRun(c, deps, c.req.param('id')),
  );

  // GET /v1/runs/:id — reconstruct the neutral RunResult from the journal + conversation store.
  registerRunReadRoutes(app, deps);
}

/**
 * Execute an agent run end-to-end — the SHARED run surface the `POST /v1/agents/:id/runs` route AND
 * the declared-`api` `{ kind:'agent' }` route both call (so a declared agent-route reuses this
 * machinery VERBATIM — idempotency, sync/SSE content-negotiation, the run timeout, run-level
 * reserve-before-execute — rather than a parallel run path). The caller has ALREADY passed the SAME
 * middleware chain (requireAuth → resolveTenant → requirePermission), so the tenant is server-derived
 * and the authz checked identically. `agentId` is the route's agent (the `:id` param for the run
 * surface; the declared route's fixed `action.agent`).
 *
 * (path-param binding): a declared agent route like `/meetings/{id}/summarize` matches the
 * `{id}` path param via Hono's router, but those params were NOT threaded into the run (only
 * `body.input` flowed in). `routeParams` carries them so the binding is EXPRESSIBLE without touching
 * the neutral `AgentSpec`/`RunResult` types. It is OPTIONAL and absent for the bare run surface
 * (`POST /v1/agents/{id}/runs` — its `{id}` is the AGENT id, not run data, so it is NOT bound); a
 * declared route with NO path params passes `{}` and behaves EXACTLY as before. The contract for HOW
 * the params reach the run is documented at `bindRouteParams`.
 *
 * an `async:true` request is ENQUEUED onto the durable worker (202 + runId) when one is
 * wired, else fail-closed-501 (see `enqueueAsyncRun`).
 */
export async function executeAgentRun(
  c: Context<AppEnv>,
  deps: AppDeps,
  agentId: string | undefined,
  routeParams: Record<string, string> = {},
  persistTo?: string,
): Promise<Response> {
  const tenantId = c.get('tenantId');
  if (!tenantId) throw new ApiError('NOT_FOUND', 'Not found.');
  if (!agentId) throw new ApiError('NOT_FOUND', 'Not found.');
  // Output persistence (opt-in per-action `persistTo`): the run's validated output is written into this
  // declared store after a successful run. The runtime store table comes from the declarative engine's
  // product tables; both are threaded into `runAgent` (sync) and the enqueued job (async/durable).
  const productTables = deps.engine?.productTables;
  const persistOpts =
    persistTo !== undefined && productTables !== undefined ? { persistTo, productTables } : {};

  // Resolve the agent from the MINIMAL registry (full engine =). Unknown id → uniform 404
  // (no existence leak; an attacker cannot enumerate registered agents).
  const entry = deps.agentRegistry?.get(agentId);
  if (!entry) throw new ApiError('NOT_FOUND', 'Not found.');

  const rawBody = await c.req.json().catch(() => ({}));
  const body = StartRunRequest.parse(rawBody);

  // bind the declared route's path params into the run input as a clearly-delimited, trusted
  // context block PREPENDED before `body.input` (see `bindRouteParams` for the exact, documented
  // contract). A route with no path params yields `body.input` UNCHANGED, so the bare run surface and
  // a param-less declared route behave EXACTLY as today.
  const effectiveInput = bindRouteParams(routeParams, body.input);

  // the idempotency body-hash covers the LOGICAL run inputs ONLY — agentId + input +
  // instructions + maxTurns — and EXCLUDES `async`. So a sync-vs-async retry of the SAME logical
  // input shares ONE idempotency slot (it does NOT split into two reservations / two runs). The
  // run still executes off-request iff async:true; the slot is the same either way.
  // the hash covers the BOUND input (`effectiveInput`), so two calls to the SAME declared
  // agent route with DIFFERENT path params (e.g. `/meetings/A/summarize` vs `/meetings/B/summarize`)
  // do NOT collide on one idempotency slot — they are logically distinct runs.
  const bodyHash = hashBody({
    agentId,
    input: effectiveInput,
    instructions: body.instructions,
    maxTurns: body.maxTurns,
  });

  // Build the effective neutral spec: base registry spec + the allowed per-run overrides + the
  // route-param-bound input.
  const spec: AgentSpec = {
    ...entry.spec,
    input: effectiveInput,
    ...(body.instructions !== undefined ? { instructions: body.instructions } : {}),
    ...(body.maxTurns !== undefined ? { maxTurns: body.maxTurns } : {}),
  };
  // Fail-closed capability gate BEFORE any model call (run-core asserts again; this gives a clean
  // 400 instead of a 500 if a registered spec is incompatible with its backend).
  try {
    assertSpecValid(spec, entry.backend.id);
  } catch (e) {
    throw new ApiError('VALIDATION_ERROR', `Agent spec is invalid for its backend: ${String(e)}`);
  }

  // ---- RUN-LEVEL IDEMPOTENCY — RESERVE-BEFORE-EXECUTE (B1) ----------------------------------
  // The previous find→execute→record was non-atomic: two concurrent same-key POSTs both passed
  // the `find` (no row yet) and BOTH executed the agent — the loser's run orphaned, callers got
  // different runIds. We now CLOSE that race by reserving the idempotency row FIRST, under a
  // PRE-MINTED runId, using a single atomic `INSERT ... ON CONFLICT DO NOTHING RETURNING`:
  //   - EXACTLY ONE concurrent caller wins the UNIQUE(tenant,scope,key) insert → it executes the
  //     agent with that reserved runId (threaded as opts.runId — a FRESH run, NOT a replay).
  //   - every loser MUST NOT execute. Same body → replay the winner's run if it is reconstructable,
  //     else (winner still mid-run) a clean 409 "run already in progress". Different body → 409.
  // The reservation snapshot stores ONLY { runId } — NEVER output/secret (redaction lesson). A
  // run that THROWS (timeout/exception, no RunResult) RELEASES its reservation so a retry can re-run
  // (failed runs are re-runnable). For a RETURNED RunResult (HTTP-1, BOTH the JSON and SSE paths): a
  // COMPLETED run and a NON-transient error (model_refusal / upstream_4xx / internal) are KEPT under
  // the key and replayed on a same-key repeat; a TRANSIENT error (rate_limited / upstream_5xx /
  // timeout) RELEASES the reservation so a same-key retry RE-RUNS (consistent with the Retry-After
  // advice + the live 429/502/504 mapping).
  const idemKey = c.req.header('idempotency-key');
  const wantsSse = acceptsEventStream(c);
  const tdb = forTenant(deps.db, tenantId);

  // Pre-mint the runId we will reserve + (if we win) execute (or, for async, enqueue) under.
  const reservedRunId = randomUUID();

  // ASYNC (off-request) RUN PATH (501 → 202) -------
  // `async:true` enqueues the run onto the durable worker and returns 202 + the runId IMMEDIATELY
  // (not blocking on completion); the client streams completion via the EXISTING
  // GET /v1/runs/{id}/events?lastEventId= (run_events persists off-request — reconnect-and-replay,
  // zero new delivery code). Fail-closed: with NO durable executor wired, `async:true` is a clean 501
  // (async requires deployment.durableWorker:true + a configured worker), never a silent sync fallback
  // that would violate the async-execution constraint (long runs must not block a sync HTTP request).
  if (body.async === true) {
    return enqueueAsyncRun(c, deps, {
      agentId,
      tenantId,
      tdb,
      idemKey,
      bodyHash,
      reservedRunId,
      // enqueue the route-param-BOUND input (`effectiveInput`), so an async declared-route run
      // gets the SAME bound input the sync path runs (the param reaches the off-request run too). The
      // idempotency body-hash already covers `effectiveInput`, so this stays consistent with dedup.
      input: effectiveInput,
      instructions: body.instructions,
      maxTurns: body.maxTurns,
      persistTo,
    });
  }

  if (idemKey) {
    const reservation = await deps.idempotency.reserve(
      tenantId,
      RUN_IDEM_SCOPE,
      idemKey,
      bodyHash,
      {
        runId: reservedRunId,
      },
    );
    if (!reservation.won) {
      // We LOST the reserve (a prior/concurrent caller owns this key) — we MUST NOT execute.
      const existing = reservation.existing;
      if (existing && existing.bodyHash !== bodyHash) {
        throw new ApiError(
          'IDEMPOTENCY_CONFLICT',
          'Idempotency-Key reused with a different agent/body.',
        );
      }
      const priorRunId = (existing?.snapshot as { runId?: string } | undefined)?.runId;
      if (priorRunId) {
        // Same body: replay the winner's run if it has completed (its header is written). If it
        // is NOT yet reconstructable, the winner is STILL EXECUTING (a true concurrent collision)
        // → a clean 409; the loser never executes the agent.
        if (wantsSse) {
          const ownership = await tdb.runHeaderOwnership(priorRunId);
          if (ownership === 'owned') return replayEventsAsSse(c, tdb, priorRunId, -1);
        } else {
          const prior = await reconstructRun(tdb, priorRunId);
          if (prior) {
            // HTTP-1: replay at the SAME HTTP status the LIVE run would have produced for this class
            // (no 429-vs-200 divergence). Transient classes release their reservation (above) so only
            // non-transient runs reach here — `statusForErrorClass` returns 200 for those — but applying
            // the mapping keeps the replay self-consistent with the live mapping regardless.
            return c.json(prior as unknown as Record<string, unknown>, statusForErrorClass(prior));
          }
        }
      }
      throw new ApiError(
        'IDEMPOTENCY_CONFLICT',
        'A run is already in progress for this Idempotency-Key.',
      );
    }
    // reservation.won === true → fall through and execute under reservedRunId.
  }

  // ---- EXECUTE THE RUN (sync-but-streamed; the SDK call is held IN-REQUEST) ------------------
  //
  // CONCURRENCY / TIMEOUT TRADE-OFF (risk, documented honestly): the SDK call is held
  // open inside this request, so concurrency is capped at the HTTP-worker count and the run is
  // exposed to proxy/idle timeouts. `withTimeout` bounds the WALL-CLOCK of the held request/stream
  // (a slow/stuck SDK call rejects after DEFAULT_RUN_TIMEOUT_MS) — but note that run-core does NOT
  // yet propagate cancellation INTO the SDK call, so the server-side run may continue until it
  // finishes naturally; the timeout frees the REQUEST, not necessarily the SDK work. The
  // async worker/queue that decouples the SDK call from the request is the valve — the
  // run_events table + run-core are the reserved seam it attaches to. Not built here.
  const timeoutMs = deps.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  // build the run's tools. A DECLARED agent (engine-built registry entry) sets
  // `toolFactory` — its tools are per-RUN, TENANT-bound (each escape-hatch handler gets a HandlerInit
  // whose HandlerDb closes over THIS tenant's TenantDb — A2). A static-tools entry sets `tools`.
  // Prefer the tenant-bound factory when present; else the static list. Built from the SAME `tdb`
  // (forTenant) the idempotency reservation already uses, so no extra tenant resolution.
  const runTools = entry.toolFactory ? entry.toolFactory(tdb) : entry.tools;
  // B1: when we hold a reservation, run under the reserved runId (NOT a replay). With no idemKey
  // the runId is run-core-assigned (undefined → randomUUID inside runAgent).
  const freshRunId = idemKey ? reservedRunId : undefined;

  if (wantsSse) {
    // SSE: stream NeutralEvents as they are produced. run-core's pipeline PERSISTS each event to
    // run_events BEFORE flushing it to this sink (persist-before-flush), so a reconnect resumes
    // losslessly. SSE id: = seq, event: = type, data: = the JSON NeutralEvent (1:1, fail-closed).
    //
    // HONESTY NOTE: the errorClass → HTTP-status mapping (429/502/504) applies ONLY to
    // the JSON (non-streamed) response. For SSE the 200 response headers are ALREADY flushed by the
    // time the run errors, so the HTTP status CANNOT be changed — instead the neutral errorClass is
    // carried in the terminal `error` event payload (and is durably re-readable, with the classified
    // class, via GET /v1/runs/{id}). A streaming client reads errorClass from the event body, not the
    // status line.
    return streamSSE(c, async (stream) => {
      try {
        const sseResult = await withTimeout(
          runAgent(tdb, entry.backend, spec, {
            tools: runTools,
            runId: freshRunId,
            ...persistOpts,
            onEvent: async (event) => {
              // 1:1 NeutralEvent → SSE frame, fail-closed: a frame we cannot faithfully
              // serialize is OMITTED (never fabricated). seq is the resume cursor (Last-Event-ID).
              const frame = toSseFrame(event);
              if (frame) await stream.writeSSE(frame);
            },
          }),
          timeoutMs,
        );
        // HTTP1-IDEMP-1: mirror the JSON path's transient-release on a RETURNED status:'error'. An
        // adapter that RETURNS (does NOT throw) a transient-class error — exactly the Pi
        // no-throw path — would otherwise keep its reservation under SSE (the SSE branch only released
        // in its catch, a THROW), so a same-key retry replayed the cached error instead of re-running.
        // RELEASE the reservation for a transient class so a same-key SSE retry actually RE-RUNS,
        // consistent with the JSON path + the Retry-After advice. The terminal event behaviour is
        // unchanged (errorClass still rides the run_completed/error event; the durable run_events log is
        // already persisted). A COMPLETED run or a NON-transient error keeps its reservation (replayed).
        // (QUARANTINE): the release is now TAINT-AWARE — a run that fired a non-idempotent
        // tool is NOT released (a same-key retry would re-fire the side effect). See releaseIfUntainted.
        if (
          idemKey &&
          sseResult.status === 'error' &&
          isTransientErrorClass(sseResult.errorClass)
        ) {
          await releaseIfUntainted(deps, tdb, tenantId, idemKey, freshRunId);
        }
        // Otherwise: the reservation snapshot already holds { runId } (set at reserve time) — the run
        // is reconstructable + replayable. No record() needed (reserve-before-execute owns it).
      } catch (err) {
        // The run THREW (failed / timed out mid-stream). Surface a terminal error frame carrying the
        // neutral errorClass (the status line cannot change mid-stream — see the note above). The
        // durable run_events log holds whatever was persisted before the failure. RELEASE the
        // reservation so a retry can re-run (a thrown run produced no completed RunResult) — but
        // TAINT-AWARE: a run that fired a non-idempotent tool then threw (e.g. from the post-completion
        // persist write) must NOT be released, or a same-key retry re-fires the side effect.
        if (idemKey) {
          await releaseIfUntainted(deps, tdb, tenantId, idemKey, freshRunId);
        }
        // A held-request timeout is the neutral `timeout` class; any other throw → classify it.
        const { errorClass, message } =
          err instanceof RunTimeoutError
            ? { errorClass: 'timeout' as ErrorClass, message: err.message }
            : classifyUpstreamError(err);
        await stream
          .writeSSE({ event: 'error', data: JSON.stringify({ message, errorClass }) })
          .catch(() => {});
      }
    });
  }

  // JSON: run to completion and return the RunResult; withTimeout bounds the held request. A throw
  // RELEASES the reservation (retryable); a returned RunResult (completed OR status:error) keeps it.
  let result: RunResult;
  try {
    result = await withTimeout(
      runAgent(tdb, entry.backend, spec, { tools: runTools, runId: freshRunId, ...persistOpts }),
      timeoutMs,
    );
  } catch (err) {
    // RELEASE the reservation so a retry can re-run (a thrown run produced no completed RunResult) —
    // but TAINT-AWARE: a run that fired a non-idempotent tool then threw (e.g. from the post-completion
    // persist write) must NOT be released, or a same-key retry re-fires the side effect.
    if (idemKey) {
      await releaseIfUntainted(deps, tdb, tenantId, idemKey, freshRunId);
    }
    // (HTTP-2): a held-request TIMEOUT is honestly a 504 Gateway Timeout (not the
    // generic 500 the global onError gives a bare Error). HTTP-2: emit the STANDARD closed-ErrorCode
    // envelope so the 504 body carries a real `code` (GATEWAY_TIMEOUT) like every other non-2xx
    // response — the closed enum was extended ADDITIVELY (auth-core/errors.ts) rather than leaving a
    // contract-breaking ad-hoc body. The neutral 'timeout' class rides in `details.errorClass` so no
    // information is lost. Other throws propagate unchanged → onError → 500.
    if (err instanceof RunTimeoutError) {
      return c.json(
        errorEnvelope('GATEWAY_TIMEOUT', err.message, c.get('requestId') ?? 'unknown', {
          errorClass: 'timeout' as ErrorClass,
        }),
        504,
      );
    }
    throw err;
  }
  // HTTP-1: a TRANSIENT failure (rate_limited / upstream_5xx / timeout) is retry-worthy — the
  // Retry-After advises a retry. So even though the run RETURNED a RunResult (status:'error', not a
  // throw), RELEASE the idempotency reservation for a transient class so a same-key retry actually
  // RE-RUNS (consistent with the live 429/502/504 + the Retry-After advice). A NON-transient error
  // (model_refusal / upstream_4xx / internal) is a real, repeatable outcome — keep it under the key
  // and replay it (see the reservation replay path above, which now applies the same status mapping).
  // (QUARANTINE): the release is now TAINT-AWARE — a run that fired a non-idempotent tool is
  // NOT released (a same-key retry would re-fire the side effect). See releaseIfUntainted.
  if (idemKey && result.status === 'error' && isTransientErrorClass(result.errorClass)) {
    await releaseIfUntainted(deps, tdb, tenantId, idemKey, freshRunId);
  }
  // map the neutral errorClass → HTTP status (429/502/504; else 200). On a 429,
  // surface a Retry-After header when the adapter captured one (read back from the failing journal
  // step — the RunResult stays exactly errorClass-additive, so cross-backend parity is unaffected).
  const httpStatus = statusForErrorClass(result);
  if (httpStatus === 429) {
    const retryAfter = await retryAfterForRun(tdb, result.runId);
    if (retryAfter !== undefined) c.header('Retry-After', String(retryAfter));
  }
  return c.json(result as unknown as Record<string, unknown>, httpStatus);
}

/** The inputs the async enqueue path needs (assembled by executeAgentRun after validation). */
interface AsyncEnqueueInput {
  agentId: string;
  tenantId: string;
  tdb: TenantDb;
  idemKey: string | undefined;
  bodyHash: string;
  reservedRunId: string;
  input: string;
  instructions?: string;
  maxTurns?: number;
  /** The agent action's optional output-persist store (threaded onto the durable job). */
  persistTo?: string;
}

/**
 * The tenant-bound durable-enqueue inputs `enqueueAgentRun` operates on. ASSEMBLED by a caller that
 * has ALREADY established the server-derived `tenantId` (the run surface via its middleware chain; the
 * `init.enqueue` route-handler capability via the engine's per-request tenant binding) — there is NO
 * tenant parameter a caller can override, so an enqueue is tenant-scoped BY CONSTRUCTION.
 */
interface EnqueueAgentRunInput {
  /** The server-derived tenant the run executes under (NEVER caller-supplied — see the doc above). */
  tenantId: string;
  /** The declared agent id — resolved against `deps.agentRegistry` (registry-bound; fail-closed). */
  agentId: string;
  /** The agent's run input. */
  input: string;
  /** Optional per-run override of the base spec's instructions. */
  instructions?: string;
  /** Optional per-run override of maxTurns. */
  maxTurns?: number;
  /** The Idempotency-Key (run-level dedup); undefined ⇒ no dedup (each call is a distinct job). */
  idemKey: string | undefined;
  /** The body hash the idempotency reservation stores (the logical-input hash). */
  bodyHash: string;
  /** The PRE-MINTED runId reserved + used as the durable workflow id (reserve-before-execute). */
  reservedRunId: string;
  /**
   * The agent action's optional output-persist store name — carried onto the durable `RunJob` so the
   * off-request run writes its validated output into the declared store. Undefined ⇒ no output persist.
   */
  persistTo?: string;
}

/** The neutral outcome of `enqueueAgentRun` — the effective runId + whether it was a same-key dedupe. */
interface EnqueueAgentRunResult {
  /** The runId the run executes under (the reserved one when won, or the PRIOR run's id on a dedupe). */
  runId: string;
  /** True when a same-key, same-body reservation already existed (no NEW job was enqueued — a dedupe). */
  deduped: boolean;
}

/**
 * The SHARED, TENANT-BOUND core that reserves + enqueues a durable agent run
 * onto `deps.durableExecutor`. BOTH the HTTP async run surface (`enqueueAsyncRun`, which wraps this in
 * the 202/409 Response envelope) AND the pack-facing `init.enqueue` route-handler capability (which
 * returns `{ runId }`) call THIS — so there is ONE reserve-before-enqueue + post-persist-throw release
 * path, not two divergent copies.
 *
 * Security invariants (the review attacks these):
 *  - TENANT-SCOPED BY CONSTRUCTION: `inp.tenantId` is the caller's SERVER-DERIVED tenant; there is no
 *    tenant parameter a pack/closure can override, so an enqueue can never cross tenants.
 *  - REGISTRY-BOUND: the `agentId` MUST resolve against `deps.agentRegistry` (the deployed registry) —
 *    an undeclared/foreign agent id is a fail-closed `NOT_FOUND` (a pack can only enqueue a DECLARED
 *    agent; no silent/dangling enqueue). (The HTTP run surface also pre-resolves the agent in
 *    `executeAgentRun`; the closure path has no such pre-check, so the gate lives HERE to cover both.)
 *  - FAIL-CLOSED WHEN UNWIRED: no `deps.durableExecutor` ⇒ a fail-closed 501 (never a silent no-op).
 *
 * Idempotency (unchanged from the async path): with an Idempotency-Key it RESERVES the runId first
 * (reserve-before-execute), so the durable workflowID = the reserved runId. A same-key, same-body
 * re-call is idempotent (returns the prior runId, `deduped:true`, NO second job). A different body →
 * 409. ON AN ENQUEUE THROW the reservation is released ONLY when the engine confirms the job was never
 * durably created (status 'unknown') — a post-persist throw KEEPS the reservation so a same-key retry
 * cannot mint a SECOND runId / SECOND job (a double-fire of a non-idempotent tool).
 */
async function enqueueAgentRun(
  deps: AppDeps,
  inp: EnqueueAgentRunInput,
): Promise<EnqueueAgentRunResult> {
  // FAIL-CLOSED: a durable worker is required to enqueue an off-request run.
  if (!deps.durableExecutor) {
    throw new ApiError(
      'NOT_IMPLEMENTED',
      'Async runs require a configured durable worker (deployment.durableWorker:true). ' +
        'No durable executor is wired on this deployment.',
    );
  }

  // REGISTRY-BOUND: the agent MUST be in the deployed registry. An unknown/foreign id is a
  // uniform NOT_FOUND (no existence leak; no silent/dangling enqueue) — the SAME registry the sync run
  // surface resolves against (deps.agentRegistry = the engine-built ⊕ injected map). This is what stops
  // a pack's init.enqueue from enqueueing an undeclared agent.
  if (!deps.agentRegistry?.has(inp.agentId)) {
    throw new ApiError('NOT_FOUND', 'Not found.');
  }

  const runId = inp.reservedRunId;
  if (inp.idemKey) {
    const reservation = await deps.idempotency.reserve(
      inp.tenantId,
      RUN_IDEM_SCOPE,
      inp.idemKey,
      inp.bodyHash,
      { runId: inp.reservedRunId },
    );
    if (!reservation.won) {
      // A prior/concurrent caller owns this key — we MUST NOT enqueue a second job.
      const existing = reservation.existing;
      if (existing && existing.bodyHash !== inp.bodyHash) {
        throw new ApiError(
          'IDEMPOTENCY_CONFLICT',
          'Idempotency-Key reused with a different agent/body.',
        );
      }
      const priorRunId = (existing?.snapshot as { runId?: string } | undefined)?.runId;
      if (priorRunId) {
        // Same body, same key: idempotent — DEDUPE to the prior runId (the job already exists / ran).
        // NO second enqueue.
        return { runId: priorRunId, deduped: true };
      }
      throw new ApiError(
        'IDEMPOTENCY_CONFLICT',
        'A run is already in progress for this Idempotency-Key.',
      );
    }
    // reservation.won === true → runId is reservedRunId; fall through to enqueue.
  }

  // Enqueue the neutral RunJob onto the durable worker (the durable workflowID = runId). The worker
  // resolves agentId → { backend, spec, tools } at fire time and runs the EXISTING runAgent
  // off-request inside forTenant(db, tenantId).transaction(). The reservation is KEPT (in-flight).
  try {
    await deps.durableExecutor.enqueue(inp.tenantId, {
      runId,
      tenantId: inp.tenantId,
      agentId: inp.agentId,
      input: inp.input,
      ...(inp.instructions !== undefined ? { instructions: inp.instructions } : {}),
      ...(inp.maxTurns !== undefined ? { maxTurns: inp.maxTurns } : {}),
      ...(inp.persistTo !== undefined ? { persistTo: inp.persistTo } : {}),
    });
  } catch (err) {
    // Enqueue THREW — but the throw does NOT prove the job did not start. The durable engine persists
    // the workflow status BEFORE `enqueue` resolves (DBOS `startWorkflow` writes the row first), so a
    // throw AFTER that persist means the workflow WILL still run on the worker / via crash recovery.
    // Blindly releasing the reservation here would let a same-key retry mint a NEW runId and enqueue a
    // SECOND job → runAgent runs twice → a non-idempotent tool fires twice (the exact hazard this
    // slice prevents). So: probe the engine for the runId's status and RELEASE the reservation ONLY
    // when the job is provably ABSENT (status 'unknown' — never durably created); if it EXISTS in any
    // state, KEEP the reservation (the durable run owns the key; a same-key retry hits the loser path
    // and returns the existing runId, not a second run). The status read is fail-CLOSED: if it throws,
    // we do NOT release (treat the job as possibly-live), so a re-fire is never enabled by a release.
    if (inp.idemKey) {
      let jobAbsent = false;
      try {
        jobAbsent = (await deps.durableExecutor.status(runId)) === 'unknown';
      } catch {
        jobAbsent = false; // status unreadable ⇒ assume the job may exist ⇒ KEEP the reservation
      }
      if (jobAbsent) {
        await deps.idempotency.release(inp.tenantId, RUN_IDEM_SCOPE, inp.idemKey).catch(() => {});
      }
    }
    throw err;
  }

  return { runId, deduped: false };
}

/**
 * enqueue an `async:true` run onto the durable worker and return 202 + the runId. Thin HTTP
 * wrapper over the shared `enqueueAgentRun` core: it maps the core's `{ runId, deduped }` outcome onto
 * the 202 Response envelope (a fresh enqueue → `acceptedBody`; a same-key dedupe → `loserBody`, which
 * OMITS `status` per fix E since the prior run may already be COMPLETED/FAILED). The registry-bound +
 * fail-closed-501 + reserve-before-enqueue invariants all live in the shared core.
 */
async function enqueueAsyncRun(
  c: Context<AppEnv>,
  deps: AppDeps,
  inp: AsyncEnqueueInput,
): Promise<Response> {
  const { runId, deduped } = await enqueueAgentRun(deps, {
    tenantId: inp.tenantId,
    agentId: inp.agentId,
    input: inp.input,
    ...(inp.instructions !== undefined ? { instructions: inp.instructions } : {}),
    ...(inp.maxTurns !== undefined ? { maxTurns: inp.maxTurns } : {}),
    idemKey: inp.idemKey,
    bodyHash: inp.bodyHash,
    reservedRunId: inp.reservedRunId,
    ...(inp.persistTo !== undefined ? { persistTo: inp.persistTo } : {}),
  });
  // A same-key dedupe → the loser body (omits `status`: the prior run may already be COMPLETED/FAILED,
  // so echoing 'enqueued' would be a lie — the caller reads the real state from GET /v1/runs/{id}). A
  // fresh enqueue → the accepted body.
  return c.json(deduped ? loserBody(runId) : acceptedBody(runId), 202);
}

/** The 202 ACCEPTED body for a FRESHLY enqueued async run: the runId + where to stream. */
function acceptedBody(runId: string): Record<string, unknown> {
  return { runId, status: 'enqueued', events: `/v1/runs/${runId}/events` };
}

/**
 * The 202 body for the idempotency LOSER (a same-key, same-body re-POST). It OMITS `status` (fix E)
 * because the prior run is NOT necessarily still 'enqueued' — it may have COMPLETED or FAILED (the
 * hash-excludes-async sync-then-async path reaches here). The caller reads the authoritative state
 * from GET /v1/runs/{id}; this body only re-points it at the existing runId + its event stream.
 */
function loserBody(runId: string): Record<string, unknown> {
  return { runId, events: `/v1/runs/${runId}/events` };
}

/**
 * HTTP-1: the TRANSIENT error classes — an upstream throttle / 5xx / timeout that a same-key retry
 * SHOULD be allowed to re-run (the Retry-After advises it). A non-transient class (model_refusal /
 * upstream_4xx / internal / null) is a stable, repeatable outcome that stays cached under the key.
 */
function isTransientErrorClass(errorClass: ErrorClass | null): boolean {
  return errorClass === 'rate_limited' || errorClass === 'upstream_5xx' || errorClass === 'timeout';
}

/**
 * the NON-IDEMPOTENT-TAINT QUARANTINE applied to an in-request reservation release.
 *
 * A release frees the `agent_run` reservation so a same-Idempotency-Key retry RE-RUNS `runAgent` FRESH.
 * That is SAFE only when the failed run did NOT fire a non-idempotent (side-effecting) tool: a fresh
 * re-run re-fires the side effect (the `dispatch.ts` non-idempotent guard blocks only on
 * `replay===true`), so a tainted run must NOT be released. This makes the release TAINT-AWARE:
 *  - the run is QUARANTINED (a non-idempotent tool fired ⇒ the chokepoint wrote the run-taint marker)
 *    → KEEP the reservation. A same-key retry then hits the loser path (it replays the cached terminal
 *    error / 409s, NEVER re-runs), so the side effect fires EXACTLY ONCE. The taint marker stays as the
 * durable evidence the run needs manual review (it is never auto-retried).
 *  - the run is UNTAINTED (idempotent / no-tool) → RELEASE (the legitimately-retryable case;
 *    over-quarantining would break the correct release for those runs).
 *
 * TWO callers gate through this, each having established its OWN precondition for release:
 *  - the RETURNED-error path (a completed-but-errored RunResult with a TRANSIENT `errorClass`), and
 *  - the THROW path (`runAgent` threw — a timeout / mid-run fault — which produced no completed
 *    RunResult and is therefore retry-worthy). BEFORE `persistTo`, a throw always meant the run did not
 *    complete; a `persistTo` write now runs AFTER the tools fired, so a fully-completed, tool-firing,
 *    billed run can throw from the persist write — a blanket throw-release would then re-fire the side
 *    effect on a same-key retry. Routing the throw-path release through this taint gate closes that.
 *
 * `runId` is the runId the run executed under (the reserved runId when there is an Idempotency-Key — the
 * same id the chokepoint keyed the marker on). The taint read is tenant-scoped via the supplied
 * TenantDb. FAIL-CLOSED: if the taint read throws we do NOT release (treat the run as possibly tainted),
 * so a re-fire is never enabled by a failed marker read.
 */
async function releaseIfUntainted(
  deps: AppDeps,
  tdb: TenantDb,
  tenantId: string,
  idemKey: string,
  runId: string | undefined,
): Promise<void> {
  // No runId means no Idempotency-Key reservation was taken under a reserved id (runId is run-core-
  // assigned); there is nothing keyed to quarantine, and there is no reservation to release. (Guarded
  // by the idemKey check at the call site too; this keeps the helper self-contained.)
  if (!runId) {
    await deps.idempotency.release(tenantId, RUN_IDEM_SCOPE, idemKey).catch(() => {});
    return;
  }
  let tainted: boolean;
  try {
    tainted = await isRunTainted(tdb, runId);
  } catch {
    tainted = true; // fail-closed: a marker read failure must NOT enable a silent re-fire.
  }
  if (tainted) return; // QUARANTINED — keep the reservation; a retry never silently re-runs.
  await deps.idempotency.release(tenantId, RUN_IDEM_SCOPE, idemKey).catch(() => {});
}

/**
 * read the Retry-After (seconds) the adapter recorded on the failing journal step for a
 * rate-limited run (the adapter wrote `{ error, errorClass, retryAfter }` into the step output). The
 * read is tenant-scoped via the supplied TenantDb. Returns undefined when none was captured.
 */
async function retryAfterForRun(tdb: TenantDb, runId: string): Promise<number | undefined> {
  const steps = (await tdb
    .select(schema.journalSteps)
    .where(eq(schema.journalSteps.runId, runId))) as Array<{ status: string; output: unknown }>;
  // pick the failing LLM step (the one carrying an errorClass) — NOT a trailing tool-error
  // step, which never holds a Retry-After. Same selection as deriveErrorFromJournal so they agree.
  const failing = pickFailingStep(steps);
  const out = (failing?.output ?? null) as Record<string, unknown> | null;
  const ra = out?.retryAfter;
  return typeof ra === 'number' && Number.isFinite(ra) && ra >= 0 ? ra : undefined;
}

/**
 * select the journal step that represents the run's FAILURE, robust to a tool-error step
 * that lands AFTER the failing LLM step. The LLM/model failure step carries an `errorClass` in its
 * output jsonb (a tool-error step does not), so we prefer the LAST error step WHOSE OUTPUT CARRIES AN
 * `errorClass`; only if none does (e.g. a tool-only failure) do we fall back to the last error step.
 * This stops a trailing tool-error step from masking the real upstream class (falling back to internal)
 * and from dropping the Retry-After.
 */
function pickFailingStep<T extends { status: string; output: unknown }>(steps: T[]): T | undefined {
  const errorSteps = steps.filter((s) => s.status === 'error');
  const withClass = errorSteps.filter((s) =>
    isErrorClass((s.output as Record<string, unknown> | null)?.errorClass),
  );
  if (withClass.length > 0) return withClass[withClass.length - 1];
  return errorSteps[errorSteps.length - 1];
}

/**
 * The api-auth-side shape of the `init.enqueue` capability. Structurally IDENTICAL to
 * the handler-sdk `EnqueueAgentRun` type (the public contract a handler writes against) — defined here
 * inline (like `mintPlayToken`'s inline shape in route-handlers.ts) so api-auth needs no dependency on
 * the type-only SDK package; the structural identity is what makes the closure assignable to
 * `RouteHandlerInit.enqueue` when route-init builds the init.
 */
export type EnqueueAgentRunCapability = (req: {
  agentId: string;
  input: string;
  idempotencyKey?: string;
  runId?: string;
}) => Promise<{ runId: string }>;

/**
 * build the TENANT-BOUND `init.enqueue` capability a declared ROUTE handler
 * receives — a closure that enqueues a durable agent run for THIS request's SERVER-DERIVED tenant.
 *
 * The `tenantId` is captured here from the caller (the route interpreter passes the request's
 * server-derived tenant) and CLOSED OVER — the returned closure exposes NO tenant parameter, so a pack
 * handler can NEVER enqueue cross-tenant (the tenant-scoped-by-construction invariant). The closure
 * delegates to the SHARED `enqueueAgentRun` core, so the registry-bound check (an undeclared agentId →
 * fail-closed NOT_FOUND), the reserve-before-enqueue idempotency, and the fail-closed-when-unwired (501)
 * behaviour are IDENTICAL to the HTTP `async:true` path. Returns ONLY the durable run's `{ runId }`.
 *
 * Returns `undefined` when no durable worker is wired (`deps.durableExecutor` absent) — the route
 * interpreter then OMITS `init.enqueue` (mirrors `blob`/`mintPlayToken`), so a handler fail-closes
 * loudly on `undefined` rather than the engine forcing a worker onto every deployment.
 */
export function makeEnqueueAgentRunCapability(
  deps: AppDeps,
  tenantId: string,
): EnqueueAgentRunCapability | undefined {
  // No durable worker ⇒ omit the capability (a handler that needs it fail-closes on undefined). The
  // core ALSO 501s on a missing executor, but omitting the slot is the cleaner contract (the handler
  // sees the absence, not a runtime throw it must catch).
  if (!deps.durableExecutor) return undefined;
  return async (req: {
    agentId: string;
    input: string;
    idempotencyKey?: string;
    runId?: string;
  }): Promise<{ runId: string }> => {
    // The body hash covers ONLY the logical run inputs (agentId + input) — symmetric with the HTTP
    // path's hash (which also excludes `async`), so a closure-enqueue and a sync/async run of the same
    // {agentId,input} share ONE idempotency slot under the same key. The closure does not take
    // instructions/maxTurns overrides (the pack uses the agent's declared spec), so they are absent here.
    const bodyHash = hashBody({ agentId: req.agentId, input: req.input });
    // The reserved/durable runId. A caller-PINNED `runId` is TENANT-NAMESPACED (derived from the
    // CLOSED-OVER server-derived tenant + the pinned value) so it is exactly-once WITHIN this tenant yet
    // tenant-disjoint BY CONSTRUCTION — two tenants pinning the SAME string get DIFFERENT durable ids and
    // cannot collide on the GLOBAL DBOS workflow-id namespace. Absent a pin → a fresh random uuid. The
    // tenant is ALWAYS the closed-over server-derived tenant — NEVER from `req` (there is no such field).
    const reservedRunId = req.runId ? deterministicTenantRunId(tenantId, req.runId) : randomUUID();
    const { runId } = await enqueueAgentRun(deps, {
      tenantId,
      agentId: req.agentId,
      input: req.input,
      idemKey: req.idempotencyKey,
      bodyHash,
      reservedRunId,
    });
    return { runId };
  };
}

/** Register the run-READ routes (GET run + GET events) on the shared middleware chain. */
function registerRunReadRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps): void {
  // GET /v1/runs/:id — reconstruct the neutral RunResult from the journal + conversation store.
  app.get(
    '/v1/runs/:id',
    requireAuth(),
    resolveTenant(deps),
    requirePermission(deps, 'agent:read'),
    async (c) => {
      const tenantId = c.get('tenantId');
      if (!tenantId) throw new ApiError('NOT_FOUND', 'Not found.');
      const runId = c.req.param('id');
      const tdb = forTenant(deps.db, tenantId);
      const result = await reconstructRun(tdb, runId);
      // Foreign/absent runId → 404, no cross-tenant leak (the header read is tenant-scoped).
      if (!result) throw new ApiError('NOT_FOUND', 'Not found.');
      return c.json(result as unknown as Record<string, unknown>, 200);
    },
  );

  // GET /v1/runs/:id/events?lastEventId= — replay-then-tail run_events as SSE.
  app.get(
    '/v1/runs/:id/events',
    requireAuth(),
    resolveTenant(deps),
    requirePermission(deps, 'agent:read'),
    async (c) => {
      const tenantId = c.get('tenantId');
      if (!tenantId) throw new ApiError('NOT_FOUND', 'Not found.');
      const runId = c.req.param('id');
      const tdb = forTenant(deps.db, tenantId);

      // Tenant-scoped ownership check: a foreign/absent runId → 404 (no leak), BEFORE streaming.
      const ownership = await tdb.runHeaderOwnership(runId);
      if (ownership !== 'owned') throw new ApiError('NOT_FOUND', 'Not found.');

      // Resume cursor: the SSE Last-Event-ID header (reconnect) or the ?lastEventId= query (initial).
      const lastEventId = resolveLastEventId(c);
      return replayEventsAsSse(c, tdb, runId, lastEventId);
    },
  );
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** True if the client requested an SSE stream (Accept: text/event-stream). */
function acceptsEventStream(c: Context): boolean {
  const accept = c.req.header('accept') ?? '';
  return accept.toLowerCase().includes('text/event-stream');
}

/**
 * A distinguishable in-request timeout: the wall-clock deadline expired before the
 * held run settled. The JSON sync endpoint maps THIS to HTTP 504 (not the generic 500 the global
 * onError gives a bare Error) so a timed-out request is honestly a Gateway Timeout.
 */
class RunTimeoutError extends Error {
  constructor(ms: number) {
    super(`run exceeded ${ms}ms in-request timeout`);
    this.name = 'RunTimeoutError';
  }
}

/**
 * Bound a held in-request promise by a wall-clock deadline. Rejects with a RunTimeoutError if `p` does
 * not settle within `ms` (the request/stream is freed). NOTE: this does NOT cancel the underlying
 * SDK work (run-core does not yet propagate cancellation) — it bounds the REQUEST, the documented
 * limitation whose proper fix is the async worker.
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RunTimeoutError(ms)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/**
 * map a completed-but-errored RunResult's neutral errorClass → an HTTP status for the
 * LIVE (non-streamed) sync run endpoint. `rate_limited`→429, `upstream_5xx`→502, `timeout`→504; every
 * other class (`model_refusal`, `upstream_4xx`, `internal`) AND a completed run stay 200 — the run
 * executed and the body carries `status`/`errorClass`. (GET /v1/runs/{id} is a durable re-read and is
 * ALWAYS 200 — this mapping is only for the live run.)
 */
function statusForErrorClass(result: RunResult): HttpStatusCode {
  if (result.status !== 'error') return 200;
  switch (result.errorClass) {
    case 'rate_limited':
      return 429;
    case 'upstream_5xx':
      return 502;
    case 'timeout':
      return 504;
    default:
      // model_refusal / upstream_4xx / internal / null: the run executed; 200 with the body's class.
      return 200;
  }
}

/** Resolve the resume cursor: Last-Event-ID header takes precedence over ?lastEventId=. */
function resolveLastEventId(c: Context): number {
  const header = c.req.header('last-event-id');
  const query = c.req.query('lastEventId');
  const raw = header ?? query;
  if (raw === undefined) return -1; // -1 ⇒ replay from seq 0 (seq > -1)
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : -1;
}

/**
 * Map ONE NeutralEvent to an SSE frame, FAIL-CLOSED: id = seq, event = type, data = JSON of the
 * event. Returns undefined (the frame is OMITTED) if the event cannot be faithfully serialized —
 * never a fabricated frame.
 */
function toSseFrame(event: {
  seq: number;
  type: string;
}): { id: string; event: string; data: string } | undefined {
  try {
    return { id: String(event.seq), event: event.type, data: JSON.stringify(event) };
  } catch {
    return undefined;
  }
}

/**
 * REPLAY a run's events from run_events as SSE — ONE-SHOT, not a live tail. It streams the durable
 * rows with `seq > afterSeq` (ordered by seq) and then ENDS the stream; it does NOT subscribe to or
 * poll for events persisted after this read. For a SYNC run the run is already complete by the
 * time anyone reads /events, so this returns the whole stream. For a ASYNC (off-request) run the
 * run may still be in flight: the client pulls newly-persisted events by RE-REQUESTING from the last
 * seq it saw (reconnect-and-replay) — a live server-push tail is intentionally not built (the
 * durable run_events table makes resume a real read path). Tenant-scoped via the supplied TenantDb;
 * `id:` = seq so the client resumes from Last-Event-ID.
 */
function replayEventsAsSse(c: Context, tdb: TenantDb, runId: string, afterSeq: number): Response {
  return streamSSE(c, async (stream) => {
    const rows = await tdb
      .select(schema.runEvents)
      .where(and(eq(schema.runEvents.runId, runId), gt(schema.runEvents.seq, String(afterSeq))))
      .orderBy(asc(schema.runEvents.seq));
    for (const row of rows as Array<{ seq: string; type: string; data: unknown }>) {
      if (stream.aborted) break;
      // C1 (re-validate-on-read): a stored jsonb `data` is attacker-/corruption-reachable, so
      // exactly like rehydrateConversation re-validates conversation_items.payload — we re-parse it as
      // a neutral NeutralEvent and DROP (omit) any row whose data does not match the neutral shape
      // (fail-closed: never serve an unvalidated stored frame). The validated value (not the raw row)
      // is what we serialize, so a poisoned row cannot leak a non-neutral payload to the client.
      const data = serializeEventData(row.data);
      if (data === undefined) continue; // omit a non-neutral / unserializable row, never fabricate
      await stream.writeSSE({ id: String(row.seq), event: row.type, data });
    }
  });
}

/**
 * Re-validate a stored run_events.data jsonb against the neutral NeutralEvent schema (read-path
 * re-validation) and serialize the VALIDATED value to an SSE data string. Returns undefined (the row
 * is dropped) if the data is a string that is not JSON, or does not parse as a neutral event — so a
 * poisoned / corrupted row is fail-closed dropped, never served verbatim.
 */
function serializeEventData(data: unknown): string | undefined {
  let candidate: unknown = data;
  if (typeof data === 'string') {
    try {
      candidate = JSON.parse(data);
    } catch {
      return undefined; // a stored string that is not JSON cannot be a neutral event — drop it
    }
  }
  const parsed = NeutralEvent.safeParse(candidate);
  if (!parsed.success) return undefined; // not a neutral event — drop (fail-closed), do not serve
  try {
    return JSON.stringify(parsed.data);
  } catch {
    return undefined;
  }
}

/**
 * Reconstruct the neutral RunResult for `runId` from the tenant-scoped run header + journal +
 * conversation store. Returns null if there is no run header for THIS tenant (foreign/absent →
 * the caller maps to 404, no leak). The conversation is re-derived via the read-path
 * (rehydrateConversation: tenant-scoped + per-part re-validation). Usage/cost/stepCount are
 * aggregated from the journal — the journal is the single source of truth.
 */
async function reconstructRun(tdb: TenantDb, runId: string): Promise<ReconstructedRun | null> {
  // Tenant-scoped header read (the chokepoint AND-combines the tenant predicate): a foreign/absent
  // runId yields zero rows ⇒ the caller returns 404 (no cross-tenant leak).
  const headerRows = (await tdb.select(schema.runs).where(eq(schema.runs.runId, runId))) as Array<{
    runId: string;
    backend: string;
    authMode: string;
    status: string;
    finalText: string | null;
    output: unknown;
    costUsd: string;
  }>;
  const header = headerRows[0];
  if (!header) return null;

  const steps = (await tdb
    .select(schema.journalSteps)
    .where(eq(schema.journalSteps.runId, runId))) as Array<{
    inputTokens: string;
    outputTokens: string;
    totalTokens: string;
    status: string;
    output: unknown;
  }>;

  const usage: Usage = steps.reduce<Usage>(
    (acc, s) => ({
      inputTokens: acc.inputTokens + Number(s.inputTokens),
      outputTokens: acc.outputTokens + Number(s.outputTokens),
      totalTokens: acc.totalTokens + Number(s.totalTokens),
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  );

  const conversation: ConvTurn[] = await rehydrateConversation(tdb, runId);

  // on an error run, DERIVE the real error + neutral errorClass from the failing
  // journal step (status='error') whose output jsonb the adapter wrote as { error, errorClass }
  // (no runs.error column; the journal is the source of truth). Falls back to the
  // generic string + `internal` if a legacy step lacks the fields (no leak, fail-closed). On a
  // completed run both are null. GET ALWAYS returns 200 — the status mapping below is for the
  // LIVE run endpoint, not this durable re-read.
  const { error, errorClass } = deriveErrorFromJournal(header.status, steps);

  return {
    runId: header.runId,
    backend: header.backend as RunResult['backend'],
    authMode: header.authMode as RunResult['authMode'],
    status: header.status as RunResult['status'],
    finalText: header.finalText ?? '',
    // always-present: output is the stored structured output (or null).
    output: header.output ?? null,
    error,
    errorClass,
    conversation,
    usage,
    costUsd: Number(header.costUsd),
    stepCount: steps.length,
  };
}

/**
 * derive { error, errorClass } for a reconstructed run from the failing journal step.
 * On a non-error run both are null. On an error run, read the LAST step with status='error' and
 * pull `{ error, errorClass }` from its output jsonb (the shape every adapter writes on the failing
 * step). A missing/legacy field falls back to the generic message + `internal` (fail-closed: a real
 * error is never silently dropped, and an unvalidated stored class is never trusted — only a value in
 * the neutral enum survives, via isErrorClass).
 */
function deriveErrorFromJournal(
  runStatus: string,
  steps: Array<{ status: string; output: unknown }>,
): { error: string | null; errorClass: ErrorClass | null } {
  if (runStatus !== 'error') return { error: null, errorClass: null };
  // prefer the failing step that actually carries an errorClass (the LLM/model failure)
  // over a trailing tool-error step — else a tool-error step lands last and masks the real class.
  const failing = pickFailingStep(steps);
  const out = (failing?.output ?? null) as Record<string, unknown> | null;
  const storedMessage = typeof out?.error === 'string' ? out.error : null;
  const storedClass = isErrorClass(out?.errorClass) ? out.errorClass : null;
  return {
    error: storedMessage ?? 'run completed with an error',
    errorClass: storedClass ?? 'internal',
  };
}

/**
 * bind a declared route's path params into the agent run input.
 *
 * CONTRACT (deliberate + minimal): the params are PREPENDED to `body.input` as a clearly-delimited,
 * trusted CONTEXT block:
 *
 *   Route parameters:
 *     <name>: <JSON-escaped value>
 *     …
 *
 *   <body.input>
 *
 * Rationale + safety:
 *  - The route PATH is deployment-authored (the param NAMES come from the declared `api[]` path, a
 *    trusted spec), so the keys are trusted; the VALUES are request-derived, so they are framed as
 * DATA inside an explicit, labelled block — never as instructions — keeping the
 *    untrusted-content discipline (the run sees them as a data section it can read, not as commands).
 *  - Each VALUE is JSON-escaped (`JSON.stringify`) so it stays on EXACTLY ONE line and can NEVER break
 *    the `Route parameters:` framing: a value containing a newline (e.g. a Hono-decoded `%0A`) or a
 *    forged `\n\nRoute parameters:\n  evil: true` would otherwise escape the labelled block into an
 *    unframed position before `body.input` — a prompt-injection vector. `JSON.stringify` escapes `\n`/
 *    `\r`/control chars + quotes the string, so the injected text stays INERT inside the value and the
 * output carries exactly ONE `Route parameters:` block (the invariant). It is also fully
 *    DETERMINISTIC, so the idempotency body-hash over `effectiveInput` stays stable.
 * This binds the params WITHOUT moving the neutral `AgentSpec`/`RunResult` types: the params
 *    land inside the existing `input` string, so no neutral field is added and every backend/adapter
 *    sees them identically with zero new wiring (no LCD-collapse, no per-backend branch).
 *  - ADDITIVE: with NO path params (the bare `POST /v1/agents/{id}/runs` surface, or a declared route
 *    whose path has no `{param}`) this returns `body.input` UNCHANGED — byte-for-byte the prior
 *    behaviour, so nothing existing is perturbed.
 *  - Params are emitted in a DETERMINISTIC (key-sorted) order so the bound input — and therefore the
 *    idempotency body-hash — is stable regardless of Hono's param iteration order.
 */
export function bindRouteParams(params: Record<string, string>, input: string): string {
  const names = Object.keys(params).sort();
  if (names.length === 0) return input;
  // JSON-escape each VALUE so it cannot break the labelled-block framing: a newline/control
  // char in a request-derived value stays escaped INSIDE the value (one line), so a forged value can
  // never open a second `Route parameters:` block or escape into an unframed position. Deterministic →
  // a stable idempotency body-hash.
  const lines = names.map((name) => `  ${name}: ${JSON.stringify(params[name])}`);
  return `Route parameters:\n${lines.join('\n')}\n\n${input}`;
}

/** Stable hash of the idempotency-relevant request shape (agent id + validated body). */
function hashBody(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value ?? {}))
    .digest('hex');
}

/**
 * Derive a DETERMINISTIC, TENANT-DISJOINT runId (UUID text) from a caller-PINNED runId.
 *
 * A pack handler may pin `req.runId` so a crash-retry of the same trigger reconciles to ONE run. But the
 * durable workflow-id namespace is GLOBAL (the executor uses the bare runId as the DBOS workflowID), so a
 * raw pinned string would let two DISTINCT tenants pinning the SAME value collide on one workflow id — the
 * second tenant's enqueue would silently dedup onto the first tenant's workflow (its job never runs). Not a
 * confidentiality leak (run rows are tenant-scoped → cross-tenant GET 404), but a real tenant-isolation/
 * availability defect (one tenant can drop another's durable job).
 *
 * Namespacing the pinned value by the SERVER-DERIVED tenant makes the durable id tenant-disjoint BY
 * CONSTRUCTION: SAME `(tenantId, pinned)` → SAME runId (exactly-once + crash reconciliation preserved
 * WITHIN a tenant); DIFFERENT tenant, SAME `pinned` → DIFFERENT runId (a cross-tenant collision is
 * impossible). Formatted as a v5-shaped UUID over a SHA-256 of `${tenantId}:${pinned}` (mirrors
 * cron-scheduler's `cronRunId`): `runs.run_id` (text) keeps the familiar UUID shape while staying a pure
 * function of the inputs. NOT security-sensitive — just a stable, collision-resistant, tenant-disjoint id.
 */
function deterministicTenantRunId(tenantId: string, pinned: string): string {
  const h = createHash('sha256').update(`${tenantId}:${pinned}`).digest('hex');
  // Lay the first 32 hex chars out as a UUID (8-4-4-4-12). Set the version nibble to 5 and the variant
  // nibble to 8 so it is a well-formed v5-shaped UUID (cosmetic — determinism + disjointness is the
  // contract, not RFC-4122 namespace semantics).
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Re-export so a consumer that only wants the entry type does not pull the whole module. */
export type { AgentRegistryEntry };
