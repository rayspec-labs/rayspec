/**
 * The LIVE conversation turn responder (the `live-agent-node` sibling for the
 * conversational reply): the `ConversationTurnResponder` implementation that runs the reply
 * through the platform's REAL `runAgent` path, so a real turn journals per-step usage/cost under
 * the run's tenant and persists its run_events (free — run-core mechanics). PRODUCT-NEUTRAL: the
 * instructions/model/backend come from the deployment's `<agent_id>.responder.json` (boot-side,
 * the extractor.json precedent) — no product or model name lives here.
 *
 * ── THE DETERMINISTIC REPLY RUN ID (C10 — the convergence anchor), ATTEMPT-SCOPED ──────
 * `replyAttemptRunId(turnRef, n)` derives a UUID-shaped id from the turn's TENANT-PREFIXED ledger
 * `turn_ref` plus the ATTEMPT ordinal (the `agentSubRunId` recipe; attempt 0 is byte-
 * compatible with the original `replyRunId(turnRef)`): every converging retry of one turn WALKS
 * the same deterministic id chain (tenant-disjoint by the embedded tenant), which is what makes
 * the ATTACH below possible.
 *
 * ── ATTACH-OR-ADVANCE BEFORE RUN (the crash-window convergence, attempt-scoped) ────────
 * Before invoking the model, walk the deterministic attempt ids (0, 1, …, bounded by
 * `REPLY_RUN_MAX_ATTEMPTS`) and read each header:
 *   - COMPLETED (any attempt) → ATTACH: reconstruct the reply from the persisted `final_text`
 *     WITHOUT re-invoking the model (never a double-bill on the crashed-after-model-before-
 *     persist window; usage is honestly absent — the header stores no token counts);
 *   - terminal-FAILED → ADVANCE to the next attempt id: run-core's header insert is
 *     `onConflictDoNothing`, so re-running under a failed id would pin the header at 'error'
 *     forever and dedupe the retry's events against the failed attempt's seqs (journal mixing) —
 *     a fresh attempt id gives the retry its OWN clean header + journal, and the persisted reply
 *     row records the attempt that SUCCEEDED;
 *   - ABSENT → run fresh under THIS attempt id.
 * The walk is BOUNDED: at `REPLY_RUN_MAX_ATTEMPTS` consecutive terminally-failed headers the
 * responder returns the TYPED `reply_attempts_exhausted` error (carrying the last attempt id)
 * instead of deriving ids forever — an operator signal, not a silent loop.
 *
 * ── EXECUTION SHAPE ─────────────────────────────────────────────────────────────────────────────
 * tools: [] (scope cut 3 — the extraction-node posture), maxTurns: 1, NO outputSchema (a chat
 * reply is free text — `finalText`); the -framed input arrives ASSEMBLED from the capability
 * (assemble.ts owns the jail); `instructions` are TRUSTED deployer-authored config. The optional
 * `onEvent` (the live-sink seam) threads straight into `runAgent`'s live sink.
 */
import { createHash } from 'node:crypto';
import type {
  ConversationStoreContextRead,
  ConversationTurnResponder,
  ConversationTurnResponderFactory,
  ResponderHistoryWindow,
  TurnReplyOutcome,
} from '@rayspec/conversation-runtime';
import type { AgentSpec, Backend, EventSink, RunResult } from '@rayspec/core';
import { schema, type TenantDb } from '@rayspec/db';
import { runAgent } from '@rayspec/platform';
import { eq } from 'drizzle-orm';

/** What the boot bakes into the live responder (constant across a deployment's requests). */
export interface LiveTurnResponderConfig {
  /** The responder agent id (the config filename stem; the reply run's `agentName`). */
  readonly agentId: string;
  /** The neutral backend instance (boot-constructed via the backend factory — config-side choice). */
  readonly backend: Backend;
  /** The reply model (config-side — never named in the capability package). */
  readonly model: string;
  /** The TRUSTED deployer-authored responder instructions (the system channel). */
  readonly instructions: string;
  /** The bounded history window (config-side; the capability clamps it to its own bounds). */
  readonly historyWindow: ResponderHistoryWindow;
  /** The optional bounded store-context read declaration (compose validates the store exists). */
  readonly storeContext?: ConversationStoreContextRead;
  /** Build the tenant-bound chokepoint handle (the boot passes `(t) => forTenant(db, t)`). */
  readonly tdbFor: (tenantId: string) => TenantDb;
}

/** Shape a sha256 hex digest into the v5-shaped UUID (the `agentSubRunId` recipe). */
function uuidShaped(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * A deterministic, UUID-shaped reply run id from the tenant-prefixed ledger turn_ref (the
 * `agentSubRunId` recipe — sha256, v5-shaped). Tenant-disjoint by the embedded tenant.
 * This is ATTEMPT 0 of the attempt-id chain (`replyAttemptRunId(turnRef, 0)`).
 */
export function replyRunId(turnRef: string): string {
  return uuidShaped(createHash('sha256').update(`conversation-reply:${turnRef}`).digest('hex'));
}

/**
 * The deterministic id of reply ATTEMPT `attempt` for one turn. Attempt 0 is byte-
 * compatible with `replyRunId` (the pre-fix derivation — the e2e's independent oracle and any
 * persisted reply row stay valid); attempt n ≥ 1 appends the ordinal to the hash input.
 */
export function replyAttemptRunId(turnRef: string, attempt: number): string {
  if (attempt === 0) return replyRunId(turnRef);
  return uuidShaped(
    createHash('sha256').update(`conversation-reply:${turnRef}:attempt:${attempt}`).digest('hex'),
  );
}

/**
 * The bounded cap on the deterministic attempt-id walk. Reaching it means
 * REPLY_RUN_MAX_ATTEMPTS retries of ONE turn each ran the model and terminally FAILED — a
 * persistent upstream/config fault the operator must inspect (the typed error names the cap),
 * not something more derived ids would fix.
 */
export const REPLY_RUN_MAX_ATTEMPTS = 5;

/** The transient error classes worth naming to the client (align with the run surface). */
function classOf(result: RunResult): string {
  return result.errorClass ?? 'error';
}

/**
 * Build the live responder factory the compose mount consumes
 * (`rollout.conversation.responder`). The factory is invoked per request with the SERVER-DERIVED
 * tenant (the binding passes `init.tenantId` — the blobFactory closure trust shape); the closure
 * holds no per-tenant state.
 */
export function makeLiveTurnResponder(
  cfg: LiveTurnResponderConfig,
): ConversationTurnResponderFactory {
  return (tenantId: string): ConversationTurnResponder => ({
    agentId: cfg.agentId,
    historyWindow: cfg.historyWindow,
    ...(cfg.storeContext ? { storeContext: cfg.storeContext } : {}),
    async respond({ input, turnRef, onEvent }): Promise<TurnReplyOutcome> {
      const tdb = cfg.tdbFor(tenantId);

      // ATTACH-OR-ADVANCE (module header): walk the deterministic attempt chain — attach
      // to a COMPLETED header (any attempt, no model call), advance past a terminally-FAILED one
      // (fresh header + clean journal for the retry), run fresh at the first ABSENT slot.
      let runId: string | undefined;
      for (let attempt = 0; attempt < REPLY_RUN_MAX_ATTEMPTS; attempt += 1) {
        const candidate = replyAttemptRunId(turnRef, attempt);
        const header = await loadReplyHeader(tdb, candidate);
        if (header === undefined) {
          runId = candidate;
          break;
        }
        if (header.status === 'completed') {
          return { status: 'completed', runId: candidate, text: header.finalText ?? '' };
        }
        // Terminal non-completed header — this attempt is spent; walk on.
      }
      if (runId === undefined) {
        const lastAttempt = replyAttemptRunId(turnRef, REPLY_RUN_MAX_ATTEMPTS - 1);
        return {
          status: 'error',
          runId: lastAttempt,
          errorClass: 'reply_attempts_exhausted',
          message:
            `all ${REPLY_RUN_MAX_ATTEMPTS} deterministic reply attempts for this turn have ` +
            'terminally FAILED run headers — refusing to derive further attempt ids (the bounded ' +
            'terminal-failure walk). Inspect the failed runs under this turn_ref’s attempt-id chain; ' +
            'the fault is persistent (upstream/config), not retry-shaped.',
        };
      }

      const spec: AgentSpec = {
        name: cfg.agentId,
        instructions: cfg.instructions,
        model: cfg.model,
        input,
        tools: [],
        maxTurns: 1,
      };

      let result: RunResult;
      try {
        result = await runAgent(tdb, cfg.backend, spec, {
          runId,
          // The live-sink seam: forward the live sink verbatim when the caller supplies one.
          ...(onEvent ? { onEvent: onEvent as EventSink } : {}),
        });
      } catch (e) {
        return {
          status: 'error',
          runId,
          message: e instanceof Error ? e.message : String(e),
        };
      }

      if (result.status !== 'completed') {
        return {
          status: 'error',
          runId,
          errorClass: classOf(result),
          message: result.error ?? `reply run failed (${classOf(result)})`,
        };
      }
      return { status: 'completed', runId, text: result.finalText, usage: result.usage };
    },
  });
}

/**
 * Read one deterministic reply attempt's run header (tenant-scoped chokepoint): `undefined` when
 * no header exists (the attempt slot is FREE — run fresh there), else the persisted status +
 * final_text (the attempt-id walk attaches on 'completed', advances on a terminal failure). Mirrors
 * `loadCompletedSubRun` (live-agent-node.ts) with the free-text column instead of the structured
 * output.
 */
async function loadReplyHeader(
  tdb: TenantDb,
  runId: string,
): Promise<{ status: string; finalText: string | null } | undefined> {
  const rows = (await tdb
    .select(schema.runs, { status: schema.runs.status, finalText: schema.runs.finalText })
    .where(eq(schema.runs.runId, runId))
    .limit(1)) as Array<{ status: string; finalText: string | null }>;
  return rows[0];
}
