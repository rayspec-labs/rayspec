/**
 * Run-core — the stateless orchestration around a neutral Backend.
 *
 * Responsibilities:
 *  - assign a runId, scope everything by tenantId
 *  - provide the Postgres-backed JournalSink (per-step journal + replay cache)
 *  - persist the run header + re-derived conversation
 *  - return the neutral RunResult unchanged from the adapter
 *
 * It knows NOTHING about any SDK — only the neutral Backend interface.
 *
 * CRITICAL: run-core holds ONLY a TenantDb (forTenant(db, tenantId)), never the
 * raw Drizzle handle. The replay-cache read, the run-header read, the header upsert and the
 * conversation persist therefore carry the tenant predicate STRUCTURALLY — the predicate
 * is the wrapper's job, and the CI grep gate forbids importing the
 * raw db handle anywhere under packages/platform/src.
 */
import { randomUUID } from 'node:crypto';
import type {
  AgentSpec,
  AuthMode,
  Backend,
  EventSink,
  JournalSink,
  NeutralEvent,
  NeutralEventInput,
  NeutralTool,
  RunContext,
  RunResult,
  StepReport,
} from '@rayspec/core';
import {
  assertRunResultKeyPresence,
  assertSpecValid,
  computeCost,
  reconcileCost,
} from '@rayspec/core';
import { schema, type TenantDb } from '@rayspec/db';
import { and, desc, eq, sql } from 'drizzle-orm';
import { makeDispatchTool } from './dispatch.js';
import { EventPipeline } from './event-pipeline.js';
import { rehydrateConversation } from './rehydrate.js';
import { markRunTainted } from './run-taint.js';

export interface RunOptions {
  /**
   * Optional LIVE event sink (the HTTP/SSE client). Events are routed through a bounded
   * back-pressure EventPipeline that persists each event to run_events FIRST (durable) and only THEN
   * flushes it to THIS sink (persist-before-flush) — so a frame the client sees is already durable
   * and an SSE reconnect is a lossless replay. The sink is flushed in seq order. A coalesced
   * text_delta (shed under back-pressure) is intentionally not delivered here.
   */
  onEvent?: EventSink;
  /** Replay an existing runId: cached steps are returned, the model is NOT re-called. */
  replayRunId?: string;
  /**
   * B1 (reserve-before-execute): a caller-supplied runId for a FRESH (live) run — DISTINCT from
   * replayRunId. The runs route pre-mints a runId and reserves the idempotency row under it BEFORE
   * executing, so two concurrent same-key POSTs cannot both run the agent. This is NOT a replay:
   * `replay` stays false, the model runs, the header/conversation/events are persisted under this id.
   * Resolution precedence below is `replayRunId ?? runId ?? randomUUID()`.
   */
  runId?: string;
  /**
   * Neutral tools available to this run. run-core wires them onto the RunContext + builds the
   * central dispatchTool; the OpenAI adapter marshals every SDK tool-call into it.
   */
  tools?: NeutralTool[];
  /**
   * Demand NATIVE structured output (C1, fail-closed): when true, a spec with an outputSchema is
   * rejected up front (before any model call) on a backend that lacks native structured output
   * (pi emulates, so it is rejected; openai/anthropic accept). Threaded into assertSpecValid.
   */
  requireNativeStructuredOutput?: boolean;
  /**
   * Bound on the in-memory event pipeline queue (back-pressure). When full under a slow
   * SSE consumer, text_delta/reasoning_delta are coalesced (oldest shed); structural/terminal frames
   * are NEVER dropped (the producer blocks instead). Default DEFAULT_MAX_QUEUE.
   */
  maxEventQueue?: number;
  /**
   * An AUTONOMOUS-COMMIT TenantDb for the non-idempotent-taint marker. The
   * chokepoint writes the `run_taint` marker BEFORE a non-idempotent tool fires; that write MUST commit
   * INDEPENDENTLY of the run's own transaction, so it SURVIVES a crash that rolls the run back (else a
   * crashed-after-side-effect run would lose its taint and be wrongly re-runnable-as-untainted — the
   * exact double-fire hazard). The OFF-REQUEST WORKER runs `runAgent` inside `tdb.transaction()`, so it
   * supplies a SEPARATE non-transactional `forTenant(db, tenantId)` here (an independent connection that
   * commits the marker immediately). The SYNC HTTP path runs `runAgent` OUTSIDE any transaction, so its
   * `tdb` already commits immediately — it omits this and run-core falls back to `tdb` (sound there).
   * Tenant-scoped via the TenantDb chokepoint either way.
   */
  taintDb?: TenantDb;
}

/**
 * The auth mode that draws a subscription (no per-token API billing) — Decision #7: a step run under
 * it records billed_cost_usd = 0 (the attributed computed/provider cost is still recorded as a value
 * metric). Single source of truth so the journal sink + the rollup agree.
 */
export const SUBSCRIPTION_AUTH_MODE = 'subscription-oauth-official-harness';

/**
 * The OpenAI/ChatGPT **Codex** subscription auth mode. A run on it draws the ChatGPT
 * subscription (no per-token API billing), exactly like the Anthropic official-harness path — so
 * isSubscriptionBilling treats it as billed=$0 too. A SECOND named constant (the existing one is NOT
 * mutated) so the journal sink + the rollup agree on a single source of truth for both subscription
 * paths.
 */
export const CODEX_SUBSCRIPTION_AUTH_MODE = 'codex-subscription-oauth';

/** True iff a run/step on this auth mode is NOT billed per-token (Decision #7 subscription path). */
export function isSubscriptionBilling(authMode: AuthMode): boolean {
  return authMode === SUBSCRIPTION_AUTH_MODE || authMode === CODEX_SUBSCRIPTION_AUTH_MODE;
}

/** Cost context the journal sink needs to compute + reconcile a step's cost at record() time. */
export interface CostContext {
  /** The run's model (the effective-price lookup key). A step may override via StepReport.model. */
  model: string;
  /** The run's effective instant (ISO) — the price-as-of date, so all steps cost consistently. */
  at: string;
}

/**
 * Postgres-backed journal sink with idempotent replay lookups. Bound to a TenantDb so the
 * lookup predicate (tenant_id) and the record insert (tenant_id auto-stamp) are structural.
 *
 * `record()` is the SINGLE place per-step cost is finalized (the journal is the source
 * of truth). It RE-COMPUTES the computed cost from the effective-dated pricing registry at the
 * run's instant (not the adapter's pre-computed number), reconciles it against the provider-reported
 * cost (drift flag), applies the Decision-#7 subscription billed=0 rule, and records the pricing
 * provenance (pricing_version: `<model>@<effectiveFrom>` or 'FALLBACK') + the SDK provenance
 * (produced_by) — so a stale/fabricated adapter cost can never become the ledger's authoritative cost,
 * and a fallback-priced step is DISTINGUISHABLE in the ledger (auditability is the point).
 *
 * Exported for the predicate-presence regression test (run-core lives in packages/platform,
 * outside a routes-only grep, so the tenant predicate is guarded behaviourally here).
 */
export function makeJournalSink(
  tdb: TenantDb,
  runId: string,
  backendId: string,
  replay: boolean,
  cost?: CostContext,
): JournalSink {
  return {
    async lookup(idempotencyKey: string) {
      if (!replay) return null;
      // The tenant predicate is injected by tdb.select(); we add the run-scoped filters as a
      // single combined extra (the chokepoint AND-combines it with the tenant predicate).
      const rows = await tdb
        .select(schema.journalSteps, { output: schema.journalSteps.output })
        .where(
          and(
            eq(schema.journalSteps.runId, runId),
            eq(schema.journalSteps.idempotencyKey, idempotencyKey),
            eq(schema.journalSteps.status, 'ok'),
          ),
        )
        .limit(1);
      const ok = rows.length > 0 ? rows[0] : undefined;
      return ok ? { output: ok.output ?? null } : null;
    },
    /**
     * Idempotent-tool replay cache (A1): a tool step's idempotency_key column holds the per-call
     * callId (unique per call), so the args-keyed replay cache matches on input_hash instead. Match
     * the LATEST OK `tool` step with this args hash in the run (newest wins on a same-args repeat).
     */
    async lookupToolCache(inputHash: string) {
      if (!replay) return null;
      const rows = await tdb
        .select(schema.journalSteps, { output: schema.journalSteps.output })
        .where(
          and(
            eq(schema.journalSteps.runId, runId),
            eq(schema.journalSteps.type, 'tool'),
            eq(schema.journalSteps.inputHash, inputHash),
            eq(schema.journalSteps.status, 'ok'),
          ),
        )
        .orderBy(desc(schema.journalSteps.createdAt))
        .limit(1);
      const ok = rows.length > 0 ? rows[0] : undefined;
      return ok ? { output: ok.output ?? null } : null;
    },
    async record(step: StepReport & { authMode: AuthMode }) {
      const stepId = randomUUID();
      // Finalize cost HERE (the journal is the single source of truth):
      //  1. COMPUTED cost = the effective-dated registry priced at the run's instant, for the step's
      //     model (a tool step's all-zero usage costs ~0). We DERIVE it, never trust step.costUsd.
      //  2. RECONCILE against the provider-reported cost (Anthropic total_cost_usd, Pi usage.cost.total;
      //     null for OpenAI) → the cost_drift flag (never fabricate a provider cost).
      //  3. BILLED cost (Decision #7): 0 for a subscription run, else the computed cost — the value
      //     metric (computed/provider) is STILL recorded.
      const model = step.model ?? cost?.model ?? 'unknown-model';
      const at = cost?.at ?? new Date().toISOString();
      const computed = computeCost(model, step.usage, at);
      const providerCost = step.providerCostUsd ?? null;
      const recon = reconcileCost(computed.costUsd, providerCost);
      const billed = isSubscriptionBilling(step.authMode) ? 0 : computed.costUsd;
      const values = {
        stepId,
        runId,
        // tenantId is auto-stamped by the chokepoint.
        backend: backendId,
        type: step.type,
        idempotencyKey: step.idempotencyKey,
        inputHash: step.inputHash,
        output: step.output,
        inputTokens: String(step.usage.inputTokens),
        outputTokens: String(step.usage.outputTokens),
        totalTokens: String(step.usage.totalTokens),
        costUsd: String(computed.costUsd),
        providerCostUsd: recon.providerCostUsd === null ? null : String(recon.providerCostUsd),
        billedCostUsd: String(billed),
        costDrift: recon.costDrift,
        producedBy: step.producedBy ?? null,
        // Pricing provenance (S1): the EXACT effective-dated entry that computed this step's cost
        // (`<model>@<effectiveFrom>`), or 'FALLBACK' when the model/date had no registry entry — so a
        // fallback-priced step is distinguishable in the ledger, not silently indistinguishable.
        pricingVersion: computed.pricingVersion,
        latencyMs: String(step.latencyMs),
        status: step.status,
        authMode: step.authMode,
      };
      // Heal a previously-FAILED attempt at this step. A step's idempotencyKey occupies exactly one
      // slot in the (tenant_id, run_id, idempotency_key) unique index. A `status='error'` row from a
      // transient failure (e.g. a 429) must NOT permanently reserve that slot: a re-run that reaches
      // the same step re-executes it and records again under the same key — a plain insert would then
      // collide (unique_violation) and abort the whole run, discarding the successful output.
      //
      // So record() is a CONDITIONAL upsert on that index: on conflict, REPLACE the row ONLY when the
      // existing row is an error (the `setWhere` predicate references the pre-update target row's
      // status). An existing `status='ok'` row is authoritative — the `setWhere` is false for it, so
      // the write is a no-op and a completed step's output can never be clobbered by a later attempt.
      // This keeps the ok-replay path intact (a succeeded step is still returned verbatim on re-run)
      // while letting a failed attempt be superseded (error→ok heal, or the later of two errors wins).
      // Column values are refreshed from the winning attempt; createdAt is reset so the healed row
      // reflects when it actually succeeded.
      await tdb.insert(schema.journalSteps, values).onConflictDoUpdate({
        target: [
          schema.journalSteps.tenantId,
          schema.journalSteps.runId,
          schema.journalSteps.idempotencyKey,
        ],
        set: {
          stepId: values.stepId,
          backend: values.backend,
          type: values.type,
          inputHash: values.inputHash,
          output: values.output,
          inputTokens: values.inputTokens,
          outputTokens: values.outputTokens,
          totalTokens: values.totalTokens,
          costUsd: values.costUsd,
          providerCostUsd: values.providerCostUsd,
          billedCostUsd: values.billedCostUsd,
          costDrift: values.costDrift,
          producedBy: values.producedBy,
          pricingVersion: values.pricingVersion,
          latencyMs: values.latencyMs,
          status: values.status,
          authMode: values.authMode,
          createdAt: sql`now()`,
        },
        setWhere: eq(schema.journalSteps.status, 'error'),
      });
      return stepId;
    },
  };
}

export async function runAgent(
  tdb: TenantDb,
  backend: Backend,
  spec: AgentSpec,
  opts: RunOptions,
): Promise<RunResult> {
  const replay = Boolean(opts.replayRunId);
  // B1: a replay reuses replayRunId; a FRESH run uses the caller's pre-minted runId (reserve-before-
  // execute) if supplied, else a new uuid. opts.runId is a fresh-run id, NOT a replay (replay stays
  // false), so the header/conversation/events are persisted under it as a normal live run.
  const runId = opts.replayRunId ?? opts.runId ?? randomUUID();

  // CRITICAL — run-HEADER cross-tenant check BEFORE the model runs.
  //
  // runs.runId is the PK and the header upsert below uses onConflictDoNothing, while
  // conversation persistence is gated on not-replay. An adapter (e.g. Pi) falls through to a
  // LIVE re-run when lookup() returns null on replay. So a B-context replay of A's runId
  // would run the model, silently no-op its header upsert against A's row, persist NO
  // conversation, and leave A's header authoritative for any later read of that runId — a
  // stored cross-tenant read leak through the runs table that the lookup() predicate alone
  // does NOT close.
  //
  // The ownership probe is intentionally a cross-tenant read (it must see whether the PK
  // belongs to ANOTHER tenant), so it is encapsulated inside the db boundary
  // (tdb.runHeaderOwnership) rather than reaching for unscoped() here. A 'foreign' runId is
  // rejected as a cache-miss WITHOUT ever calling backend.run.
  if (replay) {
    const ownership = await tdb.runHeaderOwnership(runId);
    if (ownership === 'foreign') {
      await opts.onEvent?.({
        type: 'run_completed',
        runId,
        seq: 0,
        status: 'error',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      });
      // D1D9-1: route this early-return literal through the same key-presence validator the main
      // return path uses (line ~391). Correct-by-literal today, but the validator makes it
      // fail-LOUDLY if a future field is added to RunResult and forgotten here (no latent drift).
      return assertRunResultKeyPresence({
        runId,
        backend: backend.id,
        authMode: 'unauthenticated',
        status: 'error',
        finalText: '',
        // Key-presence: output + error are ALWAYS present.
        output: null,
        error: 'replay run not found for tenant',
        // This is a PLATFORM-side rejection (a cross-tenant replay miss), not an upstream
        // model error — so the neutral class is `internal`, never a fabricated upstream class.
        errorClass: 'internal',
        conversation: [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        costUsd: 0,
        stepCount: 0,
      });
    }
  }

  // C1 (fail-closed capability gate): reject a spec that needs a capability this backend lacks,
  // BEFORE any model call. validateSpec/assertSpecValid had been defined but never called; this is
  // where the gate actually runs. requireNativeStructuredOutput threads through so a caller can
  // DEMAND native structured output (pi rejected, openai/anthropic accepted).
  assertSpecValid(spec, backend.id, {
    requireNativeStructuredOutput: opts.requireNativeStructuredOutput,
  });

  // The run's effective instant — every journaled step is priced as-of THIS timestamp from
  // the effective-dated registry, so all steps in a run cost consistently. Runs are
  // priced as-of EXECUTION TIME (now) — `runAt` is the wall clock at this live run. There is NO
  // historical re-cost wired today: a replay short-circuits before record() (no new steps are priced),
  // and the live registry is single-entry per model, so as-of-now and as-of-creation coincide. If a
  // historical re-cost is ever needed it would read runs.created_at here instead. spec.model is the key.
  const runAt = new Date().toISOString();
  const journal = makeJournalSink(tdb, runId, backend.id, replay, { model: spec.model, at: runAt });

  // C2 — THE SINGLE PER-RUN SEQ AUTHORITY. One monotonic counter for the whole run: every event
  // that passes through ctx.onEvent (from the adapter AND from dispatchTool) is re-stamped with a
  // contiguous seq (0,1,2,...) by THIS one wrapper, so the run's event stream is one coherent
  // ordering. The wrapper accepts a seq-less event input (the converted OpenAI adapter + the
  // dispatcher emit seq-less) OR a fully-formed event (the not-yet-converted Pi/Anthropic adapters
  // still self-assign a seq via their own makeEventIngest) and ALWAYS overwrites the seq with the
  // run-core counter — so even a self-stamped seq is normalized to the single authority.
  //
  // THE seq CONSUMER: the seq-stamped event is routed through a bounded back-pressure
  // EventPipeline that PERSISTS each event to run_events FIRST (durable, tenant-scoped, idempotent)
  // and only THEN flushes it to the optional live SSE sink (persist-before-flush). The single seq is
  // the run_events `seq` column + the SSE `id:` — so an SSE reconnect resumes from Last-Event-ID via
  // a `seq > lastEventId` read of run_events. The pipeline ALWAYS persists (even with no live sink),
  // making GET /runs/{id}/events a real durable read path regardless of whether anyone streamed live.
  // (This finalizes C2: dispatchTool + the adapters all flow through this one pipeline.)
  let seqCounter = 0;
  const stampSeq = (event: NeutralEventInput | NeutralEvent): NeutralEvent =>
    ({ ...event, seq: seqCounter++ }) as NeutralEvent;

  const pipeline = new EventPipeline({
    // Durable persist (run_events): tenant-scoped via the chokepoint; the UNIQUE(tenant,run,seq)
    // index makes a re-emit of the same seq a no-op (onConflictDoNothing) — idempotent persist.
    persist: async (event: NeutralEvent) => {
      await tdb
        .insert(schema.runEvents, {
          runId,
          seq: String(event.seq),
          type: event.type,
          // The event is the already-NEUTRALIZED NeutralEvent (opaque tool_data for tools).
          data: event as unknown as Record<string, unknown>,
        })
        .onConflictDoNothing();
    },
    live: opts.onEvent ? (event) => opts.onEvent?.(event) : undefined,
    maxQueue: opts.maxEventQueue,
  });

  // The adapter + dispatchTool emit through this wrapped sink: stamp the single seq, then hand to the
  // pipeline (persist-before-flush). We AWAIT emit so the producer feels back-pressure when the queue
  // is full of non-droppable frames (the back-pressure contract).
  const wrappedOnEvent = (event: NeutralEventInput | NeutralEvent): Promise<void> =>
    pipeline.emit(stampSeq(event));

  // Resolve the run's REAL authMode ONCE, here, and attribute BOTH
  // the central dispatchTool's `tool` steps AND (via ctx.authMode) the adapter's `llm` steps to it
  // — instead of a hard-coded literal scattered across the tool path. resolveAuth() is the
  // backend's own auth resolution (OpenAI = api-key; it also validates disallowed combos and
  // fail-closed throws). The adapter calls resolveAuth() again inside run() to apply any SDK side
  // effects (e.g. setDefaultOpenAIKey); it is idempotent.
  const authMode = await backend.resolveAuth();

  // Build the central tool dispatcher and wire it (+ the tools) onto the context (carry-in #5). The
  // OpenAI adapter marshals every SDK tool-call into ctx.dispatchTool — the ONLY
  // sanctioned tool path; it holds no handlers. Tool steps are attributed to the run's REAL
  // authMode resolved above. dispatchTool's events flow through the SAME wrapped (seq-stamping)
  // sink as the adapter's, so tool events share the run's single seq order (C2).
  const tools = opts.tools ?? [];
  const dispatchTool =
    tools.length > 0
      ? makeDispatchTool({
          runId,
          tenantId: tdb.tenantId,
          journal,
          tools,
          replay,
          authMode,
          onEvent: wrappedOnEvent,
          // The chokepoint writes the run-taint marker BEFORE a non-idempotent
          // tool fires (fail-closed), so an automated re-run can be REFUSED. Bound to runId + an
          // AUTONOMOUS-COMMIT TenantDb (`opts.taintDb`) so the marker SURVIVES a crash that rolls the
          // run back: the off-request worker runs `runAgent` inside `tdb.transaction()` and supplies a
          // separate non-transactional handle here, so the marker commits on its OWN connection BEFORE
          // the side effect (a crash mid-run leaves the run visibly tainted, never re-runnable-as-
          // untainted). The sync HTTP path runs OUTSIDE a tx, so its `tdb` already commits immediately —
          // it omits `taintDb` and we fall back to `tdb` (sound there). On a replay no non-idempotent
          // tool can fire (dispatch fail-closes it earlier), so this is only invoked on a fresh, live call.
          markRunTainted: () => markRunTainted(opts.taintDb ?? tdb, runId),
        })
      : undefined;
  const ctx: RunContext = {
    runId,
    tenantId: tdb.tenantId,
    // The adapter emits through this wrapped sink; run-core stamps the single monotonic seq (C2) and
    // routes through the persist-before-flush pipeline. Always present so run_events is
    // durably populated even when no live SSE client is attached.
    onEvent: wrappedOnEvent as EventSink,
    journal,
    replay,
    authMode,
    tools,
    dispatchTool,
    // Replay reconstruction source (carry-in #6): on replay, the adapter rebuilds the neutral
    // transcript from the ConversationStore via the trust-boundary read-path (tenant-scoped, per-part
    // re-validation) WITHOUT calling the model — never from the SDK RunState.
    rehydrate: () => rehydrateConversation(tdb, runId),
  };
  // The pipeline worker persists run_events ASYNCHRONOUSLY. If
  // backend.run THROWS, we must STILL await the pipeline so no run_events INSERT is left in flight on
  // a pooled connection after runAgent rejects — an unawaited straggler races later work (e.g. a
  // subsequent TRUNCATE/insert) into a `deadlock detected` and can land a row AFTER its tenant row is
  // gone (FK violation). So drain in a `finally`: on success the tail is flushed before we return the
  // RunResult (GET /runs/{id}/events sees the complete log, no race); on a throw the in-flight frames
  // are settled before we rethrow. A drain rejection on the SUCCESS path is fail-closed (the durable
  // log is incomplete → propagate); on the THROW path the original backend error takes precedence and
  // any drain rejection is swallowed (we never mask the real failure, but we DO wait for quiescence).
  let result: RunResult;
  try {
    // The EFFECTIVE run spec must carry the run's RESOLVED per-run tool specs so a REAL model is
    // OFFERED the tools. A declared agent's `baseAgentSpec` sets `spec.tools: []` (its per-run tools
    // live only in the separate toolFactory → `opts.tools` → the RunContext above), so the spec the
    // adapter reads would otherwise have NO tools. The fake backend dispatches via `ctx.dispatchTool`
    // directly (so it never noticed the gap), but a real adapter builds its SDK tool LIST from
    // `spec.tools` (e.g. OpenAI: `spec.tools.map(...)`) — `ctx.tools` and `spec.tools` MUST agree.
    // Execution still routes through `ctx.dispatchTool` by name (unchanged); this only feeds the
    // adapter's model-facing tool LIST. For a direct-AgentSpec path `opts.tools` derives from
    // `spec.tools`, so `tools.map(t.spec)` reproduces the existing `spec.tools` (parity-gate-verified).
    result = await backend.run({ ...spec, tools: tools.map((t) => t.spec) }, ctx);
  } catch (runErr) {
    await pipeline.drain().catch(() => {});
    throw runErr;
  }
  // Flush the tail so EVERY emitted event is durably in run_events BEFORE we return the RunResult.
  // Rejects (fail-closed) if a persist failed — the caller learns the durable log is incomplete.
  await pipeline.drain();

  // Enforce the always-present-key contract at runtime before we trust/persist the result. A
  // backend that forgets to set `output`/`error` fails LOUDLY here (presence, not truthiness —
  // null is a valid value) rather than silently weakening the "identical RunResult shape" claim.
  assertRunResultKeyPresence(result);

  // RUN→tenant cost roll-up: aggregate the run's per-step ledger
  // (tenant-scoped via TenantDb, not the adapter's RunResult.costUsd) so the run header's cost is the
  // truthful sum of the journal — the single source of truth. On a replay no new steps were
  // recorded, so the rollup reflects the steps that ARE journaled; the upsert is no-op anyway.
  const rollup = await rollupRunCost(tdb, runId);

  // Persist run header (idempotent on replay — upsert by runId; tenant_id auto-stamped).
  // output is ALWAYS-PRESENT and may be null; persist it verbatim.
  await tdb
    .insert(schema.runs, {
      runId,
      backend: result.backend,
      authMode: result.authMode,
      agentName: spec.name,
      model: spec.model,
      status: result.status,
      finalText: result.finalText,
      output: result.output ?? null,
      // The COMPUTED cost is the journal roll-up (not the adapter's number); + the reconciliation roll-up.
      costUsd: String(rollup.computedCostUsd),
      providerCostUsd: rollup.providerCostUsd === null ? null : String(rollup.providerCostUsd),
      billedCostUsd: String(rollup.billedCostUsd),
      costDrift: rollup.costDrift,
    })
    .onConflictDoNothing();

  // Persist the re-derived neutral conversation as ConvTurn/ConvPart rows (only on the first,
  // live run). ONE ROW PER PART: a global monotonic `seq` orders parts across all turns, the row
  // carries its turn (`turnIndex` + trusted `role`), part `kind`, the `toolCallId` correlation id
  // (for tool parts), and the FULL neutral ConvPart as the `payload` jsonb — the attacker-controlled
  // data that rehydrateConversation re-validates ON READ. The legacy text columns are left
  // null (deprecated).
  if (!replay && result.conversation.length > 0) {
    const rows = flattenConversationToRows(runId, result.conversation);
    if (rows.length > 0) {
      await tdb.insert(schema.conversationItems, rows as unknown as Record<string, unknown>[]);
    }
  }

  return result;
}

/** One persistable ConvPart row (tenantId is auto-stamped by the chokepoint). */
interface ConvPartRow {
  runId: string;
  seq: string;
  turnIndex: string;
  role: string;
  kind: string;
  toolCallId: string | null;
  payload: unknown;
}

/**
 * Flatten a ConvTurn[] into one persistable row per ConvPart, assigning a global monotonic `seq`.
 * The `payload` is the full neutral ConvPart (validated on read); `role` is the trusted turn role.
 */
function flattenConversationToRows(
  runId: string,
  conversation: RunResult['conversation'],
): ConvPartRow[] {
  const rows: ConvPartRow[] = [];
  let seq = 0;
  for (const turn of conversation) {
    for (const part of turn.parts) {
      rows.push({
        runId,
        seq: String(seq++),
        turnIndex: String(turn.index),
        role: turn.role,
        kind: part.kind,
        toolCallId:
          part.kind === 'tool_call' || part.kind === 'tool_result' ? part.toolCallId : null,
        payload: part,
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------------------
// Cost roll-ups — pure journal aggregation, tenant-scoped.
// ---------------------------------------------------------------------------------------

/** The aggregate cost figures for a run or a tenant, summed from the per-step journal. */
export interface CostRollup {
  /** Sum of the COMPUTED cost (effective-dated registry). */
  computedCostUsd: number;
  /**
   * Sum of the PROVIDER-reported cost. NULL iff NO step in scope reported a provider cost (e.g. an
   * OpenAI-only scope) — a null roll-up faithfully means "no provider cost was ever reported", not 0.
   */
  providerCostUsd: number | null;
  /** Sum of the BILLED cost (Decision #7: subscription steps contribute 0). */
  billedCostUsd: number;
  /** True iff ANY step in scope drifted (computed vs provider beyond the threshold). */
  costDrift: boolean;
}

/** The cost columns selected for a roll-up (numeric columns come back as strings via postgres-js). */
interface CostRow {
  costUsd: string | number | null;
  providerCostUsd: string | number | null;
  billedCostUsd: string | number | null;
  costDrift: boolean | null;
}

/** Sum the cost columns of a set of journal rows into a CostRollup (provider null when none reported). */
function aggregateCost(rows: CostRow[]): CostRollup {
  let computed = 0;
  let billed = 0;
  let provider = 0;
  let anyProvider = false;
  let drift = false;
  for (const r of rows) {
    computed += toNum(r.costUsd);
    billed += toNum(r.billedCostUsd);
    if (r.providerCostUsd !== null && r.providerCostUsd !== undefined) {
      provider += toNum(r.providerCostUsd);
      anyProvider = true;
    }
    if (r.costDrift === true) drift = true;
  }
  return {
    computedCostUsd: computed,
    providerCostUsd: anyProvider ? provider : null,
    billedCostUsd: billed,
    costDrift: drift,
  };
}

function toNum(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Roll up ONE run's cost from its journal steps (tenant-scoped via TenantDb — the predicate is
 * structural). Pure aggregation over the per-step ledger: the run header cost is DERIVED from the
 * journal, not from the adapter's RunResult.costUsd.
 */
export async function rollupRunCost(tdb: TenantDb, runId: string): Promise<CostRollup> {
  const rows = await tdb
    .select(schema.journalSteps, {
      costUsd: schema.journalSteps.costUsd,
      providerCostUsd: schema.journalSteps.providerCostUsd,
      billedCostUsd: schema.journalSteps.billedCostUsd,
      costDrift: schema.journalSteps.costDrift,
    })
    .where(eq(schema.journalSteps.runId, runId));
  return aggregateCost(rows as unknown as CostRow[]);
}

/**
 * Roll up a WHOLE tenant's cost across all its journal steps (deliverable A4 — per-tenant cost).
 * Tenant-scoped via TenantDb (the predicate is auto-injected), so a caller can NEVER read another
 * tenant's cost. Returns the computed + provider + billed totals + a drift flag. This is the value-
 * metric surface (computed/attributed) AND the billing surface (billed) over the journal.
 */
export async function rollupTenantCost(tdb: TenantDb): Promise<CostRollup> {
  const rows = await tdb
    .select(schema.journalSteps, {
      costUsd: schema.journalSteps.costUsd,
      providerCostUsd: schema.journalSteps.providerCostUsd,
      billedCostUsd: schema.journalSteps.billedCostUsd,
      costDrift: schema.journalSteps.costDrift,
    })
    .all();
  return aggregateCost(rows as unknown as CostRow[]);
}
