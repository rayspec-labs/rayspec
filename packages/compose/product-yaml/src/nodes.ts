/**
 * The Tier-A workflow NODE HANDLERS for a Product-YAML deployment.
 *
 * A bridge-compiled workflow step carries CONTRACT REFS (`step.input` maps input names to declared
 * contract ids; `step.output_artifact_refs` names the produced kinds) — not literal values. These
 * factories are the REF-RESOLVING adapters between the reviewed runtime packages
 * (stt-runtime / agent-runtime / grounding-runtime) and the durable engine's artifact threading
 * (`ctx.artifacts`): each node resolves its inputs by DECLARED contract ref from the upstream
 * artifacts (LAST producer wins — a grounded document supersedes the raw candidate of the same
 * contract), executes the reviewed primitive, and emits its outputs under the DECLARED refs.
 *
 * Which ref means what is derived from the DECLARATIONS, never hardcoded:
 *   - the span-set ref     = `grounding.source_span_contract`;
 *   - the candidate ref    = the agent's `required_output_shape.schema_ref`;
 *   - the artifact members = the `artifacts[]` derivations (see materialize.ts);
 *   - the scope id         = the trigger event payload's `${scope}_id` key (fail-closed when absent).
 *
 * Every node is RE-RUN SAFE (the durable engine's at-least-once law for a mid-crash node): the STT
 * node and the collection materializer write through tenant-namespaced UPSERT keys (`track_ref` /
 * `artifact_ref`); the typed-artifact store is content-addressed get-or-create; the agent node is the
 * deterministic declared-extraction executor (fake registry — the honest scope; live-LLM
 * extraction wiring is a later stage, see the honesty ledger).
 */

import { type AgentRuntimeRegistry, createAgentRuntimeHandler } from '@rayspec/agent-runtime';
import { AUDIO_TRACKS_STORE } from '@rayspec/audio-runtime';
import type {
  ArtifactRef,
  CapabilityInvocationContext,
  CapabilityInvocationResult,
  CapabilityNodeHandler,
  WorkflowRetryPolicy,
} from '@rayspec/foundation';
import {
  type ArtifactContent,
  type ArtifactStore,
  requiredPathValidationChecker,
} from '@rayspec/grounding-runtime';
import type { HandlerDb } from '@rayspec/handler-sdk';
import type { ProductSpec } from '@rayspec/spec';
import type { SttAdapter, SttTranscript, SttTranscriptSpan } from '@rayspec/stt-port';
import {
  applyGroundingPolicy,
  buildCollectionRows,
  declaredReconcileScope,
  deriveGroundedMembers,
  MaterializeError,
  persistCollectionRows,
  unwrapArtifactValue,
} from './materialize.js';

// ── shared helpers ───────────────────────────────────────────────────────────────────────────────

function fail(
  code: string,
  message: string,
  retryable = false,
): CapabilityInvocationResult & { status: 'terminal_failure' | 'retryable_failure' } {
  return {
    status: retryable ? 'retryable_failure' : 'terminal_failure',
    error: { code, message, retryable },
  };
}

/** Resolve the LAST upstream artifact of `kind` (a later producer supersedes an earlier one).
 *  Exported for the S2 store nodes (store-nodes.ts) — ONE resolution rule across all nodes. */
export function lastArtifactOfKind(
  ctx: CapabilityInvocationContext,
  kind: string,
): ArtifactRef | undefined {
  const artifacts = ctx.artifacts ?? [];
  for (let i = artifacts.length - 1; i >= 0; i -= 1) {
    if (artifacts[i]?.kind === kind) return artifacts[i];
  }
  return undefined;
}

/** The step's declared input contract refs (`step.input` values — strings by construction). */
function inputRefs(ctx: CapabilityInvocationContext): string[] {
  return Object.values(ctx.step.input ?? {}).filter((v): v is string => typeof v === 'string');
}

function eventScopeId(ctx: CapabilityInvocationContext, scopeKey: string): string | undefined {
  const value = ctx.input_event.payload[scopeKey];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

// ── stt.transcribe_session ──────────────────────────────────────────────────────────────────────

/**
 * A minimal operator-visible log sink for the media-prep failure paths (mirrors the platform's
 * `CleanupLogger` shape); defaults to `console`. A media-prep failure MUST be LOUD (
 * forbids a silent swallow). There are TWO failure paths and BOTH are logged:
 *   - a TYPED fail-soft error — `prepareTrackMedia` returns `err(500 media_prep_failed)` on a
 *     RemuxError (a broken/missing/hung ffmpeg) — is logged by the COMPOSE media-prep hook
 *     (`makeFailSoftMediaPrep`, compose.ts). That hook returns void, so this node NEVER sees it; it is
 *     the REAL ffmpeg-failure path (the throw-fake below does NOT reproduce it).
 *   - a genuine THROW (a non-RemuxError fault `prepareTrackMedia` re-raises, e.g. a DB/blob error) is
 *     caught + logged HERE in the STT node (defense-in-depth).
 * Either way the run proceeds and the operator can see WHY playback stayed not-ready.
 */
export interface MediaPrepLogger {
  error(message: string): void;
}

/** The default operator log sink (stderr JSON) shared by the STT node throw-path + the compose hook. */
export const CONSOLE_MEDIA_PREP_LOGGER: MediaPrepLogger = {
  error: (m) => console.error(m),
};

/**
 * The dual-track completeness wait bound (ms), measured from the CURRENT run execution's start
 * (`journal.created_at`, which the engine stamps fresh on each execute() — see the guard for the
 * crash-resume caveat). The `session_finalized` event fires as soon as ONE track seals; a sibling track
 * can still be mid-upload (`status='recording'`) at that instant. The STT node waits up to this long for
 * stragglers to seal (re-reading the store on each retry) before transcribing whatever sealed — long
 * enough to absorb a slow final-chunk upload, short enough that an ABANDONED track (one that never
 * seals) holds a worker only briefly.
 */
export const STT_INCOMPLETE_WAIT_MS = 60_000;

/**
 * The retry policy compose wires onto the `stt.transcribe_session` step so the completeness wait above
 * actually RE-INVOKES the node. The engine re-attempts a `retryable_failure` up to `max_attempts` times
 * with `backoff_ms` in-process backoff, re-reading the store each attempt. The window
 * `(max_attempts - 1) * backoff_ms` (= 90s here) MUST exceed STT_INCOMPLETE_WAIT_MS (60s) so the node's
 * own time-bound (proceed-with-whatever-sealed) — NOT retry exhaustion — decides the outcome: otherwise
 * an abandoned recording track would exhaust the retries and FAIL the run (the fail-closed default
 * failure policy) instead of transcribing the tracks that DID seal. Also gives the pre-existing
 * `stt_pending` retryable path real backoff (previously the compiled step carried no backoff).
 */
export const STT_TRANSCRIBE_RETRY_POLICY: WorkflowRetryPolicy = {
  max_attempts: 10,
  backoff_ms: 10_000,
};

export interface SttSessionNodeConfig {
  readonly spec: ProductSpec;
  readonly adapter: SttAdapter;
  /** Tenant-bound store facade (the structural tenant predicate underneath). */
  readonly db: HandlerDb;
  readonly tenantId: string;
  /** The bound transcript store (compose verified its columns). */
  readonly transcriptStore: string;
  /** The audio capability's track store (default: the capability's own). */
  readonly audioTracksStore?: string;
  /**
   * Optional media-prep hook (item 3): after persisting a track's transcript,
   * best-effort prepare its playable artifact (remux → registerPlayableArtifact). FAIL-SOFT — it
   * NEVER fails the STT node, so a broken ffmpeg cannot poison the transcript/extraction path
   * (play-token then stays the honest `not_ready_409`). The production hook (`makeFailSoftMediaPrep`,
   * compose.ts) returns void even on a typed `err(media_prep_failed)`, LOGGING that failure itself; a
   * genuine THROW (a non-RemuxError fault it re-raises) is caught + logged HERE (defense-in-depth).
   * Absent ⇒ no media prep (the deterministic CI composition path, which has no blob store / ffmpeg).
   */
  readonly mediaPrep?: (params: { session_id: string; track: string }) => Promise<void>;
  /** Where a media-prep hook THROW is logged (default `console`); the typed-err path logs in the hook. */
  readonly logger?: MediaPrepLogger;
  /** Wall-clock source (ms epoch) for the completeness bound; injectable for deterministic tests. Default `Date.now`. */
  readonly now?: () => number;
  /**
   * How long (ms, measured from the current run execution's start `journal.created_at`) to WAIT for a
   * still-recording sibling track to seal before transcribing whatever sealed. Bounds the dual-track
   * completeness wait so an abandoned recording track cannot stall the run forever. Default
   * STT_INCOMPLETE_WAIT_MS.
   */
  readonly incompleteWaitMs?: number;
}

/**
 * The `stt.transcribe_session` capability node: re-read the AUTHORITATIVE sealed tracks from the
 * audio capability's store (the finalized-session event is the trigger, not the track inventory —
 * its `tracks` list is whatever had sealed at emission time), transcribe them through the injected
 * neutral `SttAdapter`, apply the DECLARED attribution policy to the span speaker roles, persist the
 * per-track transcript rows (upsert by `track_ref` — re-run safe), and emit the transcript + span-set
 * artifacts under their declared contract refs.
 */
export function makeSttTranscribeSessionNode(cfg: SttSessionNodeConfig): CapabilityNodeHandler {
  const tracksStore = cfg.audioTracksStore ?? AUDIO_TRACKS_STORE;
  const spanRef = cfg.spec.grounding?.source_span_contract;
  const now = cfg.now ?? (() => Date.now());
  const waitMs = cfg.incompleteWaitMs ?? STT_INCOMPLETE_WAIT_MS;

  return async (ctx): Promise<CapabilityInvocationResult> => {
    const sessionId = eventScopeId(ctx, 'session_id');
    if (!sessionId) {
      return fail('stt_missing_session', 'trigger event payload carries no session_id.');
    }
    const declaredRefs = ctx.step.output_artifact_refs ?? [];
    const transcriptRef = declaredRefs.find((r) => r !== spanRef);
    if (!transcriptRef || !spanRef || !declaredRefs.includes(spanRef)) {
      return fail(
        'stt_outputs_undeclared',
        `step '${ctx.step.id}' must declare a transcript output ref and the grounding ` +
          `source-span contract ref ('${spanRef ?? '(no grounding.source_span_contract)'}').`,
      );
    }

    // Authoritative sealed tracks (tenant-bound read — the event is the trigger, not the inventory).
    const trackRows = await cfg.db.select(tracksStore, {
      session_id: sessionId,
      status: 'completed',
    });
    const tracks = trackRows
      .map((r) => (typeof r.track === 'string' ? r.track : ''))
      .filter((t) => t.length > 0)
      .sort();

    // Completeness guard (the dual-track finalize race): the `session_finalized` event fires as soon as
    // ONE track SEALS, but a multi-track session can still have a sibling track mid-upload
    // (`status='recording'`) at that instant. Transcribing the completed subset now would PERMANENTLY
    // drop the still-recording track. So while any track is still recording we WAIT (retryable): the
    // durable engine re-invokes this node (STT_TRANSCRIBE_RETRY_POLICY, wired in compose) and a later
    // attempt re-reads the now-complete set and transcribes ALL sealed tracks. The wait is BOUNDED from
    // the CURRENT run execution's start (`journal.created_at`, which the engine stamps fresh per
    // execute()), so an ABANDONED recording track (one that never seals — client crash / network drop)
    // can never stall the run forever: once the bound elapses we proceed with WHATEVER sealed.
    // The bound is STABLE across the in-process retry loop (one execute() reuses one journal object). It
    // does NOT survive a crash + journal-resume: a fresh execute() stamps a fresh created_at, so the
    // window RESTARTS from the resume instant. That reset is strictly SAFE-DIRECTION — it only ever
    // LENGTHENS the wait, never drops a straggler early and never yields a zero-run; and repeated-crash
    // divergence is bounded by the engine's max-recovery dead-letter, so it cannot loop forever.
    const stillRecording = await cfg.db.select(tracksStore, {
      session_id: sessionId,
      status: 'recording',
    });
    if (stillRecording.length > 0) {
      const startedAtMs = Date.parse(ctx.journal.created_at);
      const elapsedMs = Number.isFinite(startedAtMs)
        ? now() - startedAtMs
        : Number.POSITIVE_INFINITY;
      if (elapsedMs < waitMs) {
        return fail(
          'stt_tracks_incomplete',
          `session '${sessionId}' still has ${stillRecording.length} track(s) recording ` +
            `(${tracks.length} already sealed); waiting for completeness ` +
            `(${elapsedMs}ms of ${waitMs}ms) before transcribing.`,
          true,
        );
      }
      // Bound exceeded — a track never sealed. Proceed with whatever sealed (never stall forever), but
      // LOUD: an operator must see that a track was DROPPED from this session's transcription.
      (cfg.logger ?? CONSOLE_MEDIA_PREP_LOGGER).error(
        JSON.stringify({
          event: 'stt_session_incomplete_bound_exceeded',
          scope: 'stt.transcribe_session',
          tenant_id: cfg.tenantId,
          session_id: sessionId,
          sealed_tracks: tracks.length,
          still_recording: stillRecording.length,
          waited_ms: elapsedMs,
          bound_ms: waitMs,
        }),
      );
    }

    if (tracks.length === 0) {
      return fail(
        'stt_no_sealed_tracks',
        `session '${sessionId}' has no completed tracks to transcribe (finalize seals a track ` +
          'before the event fires — an empty set here is a genuine inconsistency).',
      );
    }

    let results: Awaited<ReturnType<SttAdapter['transcribeSession']>>;
    try {
      results = await cfg.adapter.transcribeSession({
        session_id: sessionId,
        tracks: tracks.map((track) => ({ session_id: sessionId, track })),
      });
    } catch (e) {
      return fail('stt_adapter_error', e instanceof Error ? e.message : String(e));
    }

    const transcripts: SttTranscript[] = [];
    for (const result of results) {
      if (result.status === 'failed') {
        return fail(
          `stt_${result.error.code}`,
          `transcription failed: ${result.error.message}`,
          result.error.retryable,
        );
      }
      if (result.status === 'pending') {
        return fail('stt_pending', 'transcription is still pending (retry later).', true);
      }
      transcripts.push(result.transcript);
    }

    // The DECLARED attribution policy is authoritative for span speaker roles (mic→local, …).
    const attribution = cfg.spec.grounding?.attribution_policy?.tracks;
    const mapRole = (track: string, fallback: SttTranscriptSpan['speaker_role']) => {
      if (!attribution) return fallback;
      const role = attribution[track];
      return role === 'local' || role === 'remote' || role === 'unknown' ? role : 'unknown';
    };
    const spans: SttTranscriptSpan[] = transcripts.flatMap((t) =>
      t.spans.map((s) => ({ ...s, speaker_role: mapRole(s.track, s.speaker_role) })),
    );

    // Persist per-track transcript rows (the transcript READ surface) — upsert by track_ref.
    for (const t of transcripts) {
      await cfg.db.upsert(cfg.transcriptStore, ['track_ref'], {
        session_id: sessionId,
        track: t.track,
        track_ref: `${cfg.tenantId}:${sessionId}:${t.track}`,
        status: t.status,
        model: t.model,
        detected_language: t.language,
        full_text: t.full_text,
        word_count: t.words.length,
        payload: {
          confidence: t.confidence,
          duration: t.duration_seconds,
          words: t.words.map((w) => ({
            // The PUNCTUATED-WORD PERSIST RULE: the persisted `word` IS the punctuated/smart-formatted
            // form (`punctuated_word || word`) — the raw token alone would visibly strip punctuation
            // from the client's transcript panel on real provider data. The read views serve this
            // value under BOTH `word` and `punctuated_word` (the transcript-get contract).
            word: w.punctuated_text || w.text,
            start: w.start,
            end: w.end,
            confidence: w.confidence ?? 0,
          })),
          segments: t.segments.map((s) => ({ start: s.start, end: s.end, text: s.text })),
        },
      });
    }

    // Media-prep, FAIL-SOFT + off-request: after the transcript rows are persisted,
    // best-effort remux each track's chunks into its playable artifact. A failure is LOGGED loudly
    // (the production hook logs its own typed err(media_prep_failed); a genuine throw is caught +
    // logged in the catch below) and the play-token honestly serves not_ready_409 — it MUST NOT fail
    // this node / poison the extraction downstream. Idempotent (registerPlayableArtifact = put-by-key).
    //
    // MP-2 (deliberate, NOT deduped): the STT adapter's media resolver already remuxed this track's
    // chunks to feed the transcription request, so the same `-c copy` remux runs twice per track. This
    // is left INTENTIONALLY. The two remuxes belong to DIFFERENT failure domains — the resolver's is on
    // the CRITICAL transcription path (a remux failure there correctly fails STT: no audio ⇒ no
    // transcript), this one is FAIL-SOFT (a failure only defers playback). Sharing one remux artifact
    // would either expose the neutral STT adapter's internal remux bytes back through its port (a
    // boundary violation, near the kill-set) or add cross-node mutable remux cache state that threatens
    // this durable node's re-run idempotency. The remux is a cheap container rewrite (`-c copy`, no
    // re-encode — seconds even for a 74-min recording) run off-request, so the duplicated work is a
    // bounded, correctness-neutral cost that is cheaper than the coupling a dedup would introduce.
    if (cfg.mediaPrep) {
      const logger = cfg.logger ?? CONSOLE_MEDIA_PREP_LOGGER;
      for (const t of transcripts) {
        try {
          await cfg.mediaPrep({ session_id: sessionId, track: t.track });
        } catch (e) {
          // Defense-in-depth: the production hook logs its OWN typed err(media_prep_failed) and
          // returns void, so this catch only fires on a genuine THROW (a non-RemuxError fault the hook
          // re-raised, e.g. a DB/blob error). Fail-soft (not_ready_409 is the honest play-token
          // surface) but NEVER silent — log loudly. Transcript + extraction still
          // complete; only playback stays not-ready for this track.
          logger.error(
            JSON.stringify({
              event: 'media_prep_failed',
              scope: 'stt.transcribe_session',
              tenant_id: cfg.tenantId,
              session_id: sessionId,
              track: t.track,
              error: e instanceof Error ? e.message : String(e),
            }),
          );
        }
      }
    }

    const artifact_refs: ArtifactRef[] = [
      {
        id: `${ctx.step.id}:${transcriptRef}:${sessionId}`,
        kind: transcriptRef,
        source_node_id: ctx.step.id,
        value: { session_id: sessionId, tracks: transcripts },
      },
      {
        id: `${ctx.step.id}:${spanRef}:${sessionId}`,
        kind: spanRef,
        source_node_id: ctx.step.id,
        value: spans,
      },
    ];
    return {
      status: 'completed',
      artifact_refs,
      output: {
        session_id: sessionId,
        tracks: transcripts.map((t) => ({
          track: t.track,
          status: t.status,
          word_count: t.words.length,
        })),
        span_count: spans.length,
      },
    };
  };
}

// ── agent.<declared id> ─────────────────────────────────────────────────────────────────────────

/**
 * The declared-agent extraction node: `@rayspec/agent-runtime`'s reviewed handler (registry-backed
 * deterministic executors honoring the compiled `agent_extraction` contract — required inputs,
 * output count/kind/schema matching, `required_output_shape` enforcement, neutrality leak scan),
 * adapted to the DURABLE engine's artifact threading: the durable engine hands upstream artifacts in
 * `ctx.artifacts` (its journal view is header-only), so we surface them through the journal's
 * `artifact_refs` slot the agent-runtime resolver reads.
 */
export function makeDeclaredAgentNode(registry: AgentRuntimeRegistry): CapabilityNodeHandler {
  const inner = createAgentRuntimeHandler({ handlers: registry });
  return (ctx) =>
    inner({
      ...ctx,
      journal: {
        ...ctx.journal,
        artifact_refs: [...ctx.journal.artifact_refs, ...(ctx.artifacts ?? [])],
      },
    });
}

// ── grounding.check (the DECLARED policy, executed) ─────────────────────────────────────────────

/**
 * The `grounding.check` validation node: resolve the candidate document + the closed span set by
 * their DECLARED refs, execute the declared policy (`on_invalid_citation: prune`,
 * `on_empty_evidence: drop`) via the materializer (which uses the Tier-B mechanical
 * `closedReferenceGroundingChecker` per member), and emit the GROUNDED document under the
 * candidate's own contract ref (last-producer-wins: downstream consumers now resolve the grounded
 * doc) plus the grounding result.
 */
export function makeGroundingPolicyNode(spec: ProductSpec): CapabilityNodeHandler {
  const spanRef = spec.grounding?.source_span_contract;
  return async (ctx): Promise<CapabilityInvocationResult> => {
    if (!spanRef) {
      return fail('grounding_unconfigured', 'grounding.source_span_contract is not declared.');
    }
    const refs = inputRefs(ctx);
    const candidateRefs = refs.filter((r) => r !== spanRef);
    if (!refs.includes(spanRef) || candidateRefs.length !== 1 || !candidateRefs[0]) {
      return fail(
        'grounding_inputs_undeclared',
        `step '${ctx.step.id}' must declare exactly the candidate ref and the span-set ref ` +
          `('${spanRef}') as inputs (got: ${refs.join(', ') || '(none)'}).`,
      );
    }
    const candidateRef = candidateRefs[0];

    const spansArtifact = lastArtifactOfKind(ctx, spanRef);
    const rawSpans = unwrapArtifactValue(spansArtifact?.value);
    if (!Array.isArray(rawSpans)) {
      return fail('grounding_spans_missing', `no upstream '${spanRef}' span-set artifact.`);
    }
    // Build the closed span set as id→text: the ids ARE the closed citation set (as before) and the
    // texts back grounding's opt-in quote-text verification. When any artifact declares a quote_field,
    // a span WITHOUT a string `text` is a fail-closed error (a textless span-set must never silently
    // degrade the quote check to id-only). With no quote_field, the text is not load-bearing
    // (default-off), so a missing text is tolerated as '' (never read).
    const quoteChecked = spec.artifacts.some((a) => a.provenance?.quote_field);
    const closed = new Map<string, string>();
    for (const s of rawSpans) {
      if (s === null || typeof s !== 'object') continue;
      const id = (s as Record<string, unknown>).id;
      if (typeof id !== 'string') continue;
      const text = (s as Record<string, unknown>).text;
      if (typeof text !== 'string') {
        if (quoteChecked) {
          return fail(
            'grounding_span_text_missing',
            `span '${id}' in the closed set '${spanRef}' has no string 'text', but an artifact ` +
              'declares a quote_field — refusing to silently id-only-check a declared quote (fail-closed).',
          );
        }
        closed.set(id, ''); // text not load-bearing (no quote_field) — never read
        continue;
      }
      closed.set(id, text);
    }

    const candidateArtifact = lastArtifactOfKind(ctx, candidateRef);
    const candidate = unwrapArtifactValue(candidateArtifact?.value);
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return fail(
        'grounding_candidate_missing',
        `no upstream '${candidateRef}' candidate artifact.`,
      );
    }

    let application: ReturnType<typeof applyGroundingPolicy>;
    try {
      application = applyGroundingPolicy(
        spec,
        candidate as Record<string, unknown>,
        candidateRef,
        closed,
      );
    } catch (e) {
      if (e instanceof MaterializeError) return fail('grounding_derivation', e.message);
      throw e;
    }

    const resultRef =
      (ctx.step.output_artifact_refs ?? []).find((r) => r !== candidateRef) ?? 'grounding.result';
    const summary = {
      verdict: 'grounded' as const, // post-gate BY CONSTRUCTION: zero out-of-set citation survives
      pruned_citations: application.prunedCitations,
      dropped_members: application.droppedMembers,
      unsupported_claims: application.unsupportedClaims, // declared-quote_field mismatches (0 default-off)
      kept_by_kind: Object.fromEntries(
        application.kinds.map((k) => [k.artifact.kind, k.members.length]),
      ),
    };
    return {
      status: 'completed',
      artifact_refs: [
        {
          id: `${ctx.step.id}:${resultRef}`,
          kind: resultRef,
          source_node_id: ctx.step.id,
          value: summary,
        },
        {
          id: `${ctx.step.id}:${candidateRef}:grounded`,
          kind: candidateRef,
          source_node_id: ctx.step.id,
          value: application.groundedDoc,
        },
      ],
      output: summary,
    };
  };
}

// ── validation.check (required_output_shape over the grounded doc) ──────────────────────────────

/**
 * The `validation.check` node: validate the (grounded) document against the DECLARED
 * `required_output_shape.required_paths` of the agent whose `schema_ref` is the document's contract
 * ref, via the Tier-B mechanical `requiredPathValidationChecker`. Invalid → terminal failure
 * (`validation_failed`) — the acceptance boundary is a hard gate, never advisory.
 */
export function makeShapeValidationNode(spec: ProductSpec): CapabilityNodeHandler {
  return async (ctx): Promise<CapabilityInvocationResult> => {
    const refs = inputRefs(ctx);
    if (refs.length !== 1 || !refs[0]) {
      return fail(
        'validation_inputs_undeclared',
        `step '${ctx.step.id}' must declare exactly one input ref (the document contract).`,
      );
    }
    const docRef = refs[0];
    const extractor = spec.extractors.find(
      (a) => a.extraction.required_output_shape.schema_ref === docRef,
    );
    if (!extractor) {
      return fail(
        'validation_shape_undeclared',
        `no declared extractor constrains '${docRef}' via required_output_shape.schema_ref — nothing ` +
          'declares what to validate (fail-closed).',
      );
    }
    const doc = unwrapArtifactValue(lastArtifactOfKind(ctx, docRef)?.value);
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
      return fail('validation_doc_missing', `no upstream '${docRef}' document artifact.`);
    }

    const result = requiredPathValidationChecker({
      artifact: { kind: docRef, content: doc as ArtifactContent },
      required_paths: extractor.extraction.required_output_shape.required_paths ?? [],
    });
    const resultRef = ctx.step.output_artifact_refs?.[0] ?? 'validation.result';
    const artifact_refs: ArtifactRef[] = [
      {
        id: `${ctx.step.id}:${resultRef}`,
        kind: resultRef,
        source_node_id: ctx.step.id,
        value: result,
      },
    ];
    if (result.verdict === 'invalid') {
      return {
        status: 'terminal_failure',
        error: {
          code: 'validation_failed',
          message: `validation node '${ctx.step.id}' failed: ${result.findings
            .map((f) => f.message)
            .join('; ')}`,
          retryable: false,
        },
        artifact_refs,
      };
    }
    return { status: 'completed', artifact_refs, output: result };
  };
}

// ── artifact.persist (typed artifact + the declared collection materialization) ─────────────────

export interface ArtifactPersistNodeConfig {
  readonly spec: ProductSpec;
  /** Tenant-bound store facade for the collection rows. */
  readonly db: HandlerDb;
  readonly tenantId: string;
  /** Declared `artifacts[].collection` → bound store (compose verified). */
  readonly collectionStores: ReadonlyMap<string, { readonly store: string }>;
  /** The Tier-B typed-artifact store (content-addressed get-or-create; tenant-bound). */
  readonly artifactStore: ArtifactStore;
}

/**
 * The `artifact.persist` node: resolve the grounded document by its declared ref, derive the
 * per-kind members (materialize.ts), persist the collection rows with the DECLARED lifecycle
 * (upsert by `artifact_ref`, human-edit preservation, stale reconciliation), persist the typed
 * document artifact through the Tier-B `ArtifactStore` (`materialization.persist_via:
 * artifact.persist`), and emit the handle under its declared ref.
 */
export function makeArtifactPersistNode(cfg: ArtifactPersistNodeConfig): CapabilityNodeHandler {
  return async (ctx): Promise<CapabilityInvocationResult> => {
    const refs = inputRefs(ctx);
    if (refs.length !== 1 || !refs[0]) {
      return fail(
        'persist_inputs_undeclared',
        `step '${ctx.step.id}' must declare exactly one input ref (the grounded document contract).`,
      );
    }
    const docRef = refs[0];
    const doc = unwrapArtifactValue(lastArtifactOfKind(ctx, docRef)?.value);
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
      return fail('persist_doc_missing', `no upstream '${docRef}' document artifact.`);
    }

    const persisting = cfg.spec.artifacts.filter((a) => a.lifecycle?.persist !== false);
    const scopes = [...new Set(persisting.map((a) => a.scope))];
    const scope = scopes[0];
    if (scopes.length !== 1 || typeof scope !== 'string' || scope.length === 0) {
      return fail(
        'persist_scope_undeclared',
        'every persisted artifact kind must declare the SAME non-empty scope (fail-closed).',
      );
    }
    const scopeColumn = `${scope}_id`;
    const scopeId = eventScopeId(ctx, scopeColumn);
    if (!scopeId) {
      return fail(
        'persist_scope_missing',
        `trigger event payload carries no '${scopeColumn}' — cannot scope the persisted artifacts.`,
      );
    }

    let outcome: Awaited<ReturnType<typeof persistCollectionRows>>;
    try {
      const kinds = deriveGroundedMembers(cfg.spec, doc as Record<string, unknown>, docRef);
      const rows = buildCollectionRows(kinds, {
        tenantId: cfg.tenantId,
        scopeColumn,
        scopeId,
        collectionStores: cfg.collectionStores,
      });
      outcome = await persistCollectionRows(
        cfg.db,
        rows,
        { column: scopeColumn, id: scopeId },
        // MAT-1: the reconcile scope is DECLARED (spec kinds + bound stores), never derived from
        // this run's rows — a re-extract yielding zero members of a kind still reconciles it.
        declaredReconcileScope(cfg.spec, cfg.collectionStores),
      );
    } catch (e) {
      if (e instanceof MaterializeError) return fail('persist_derivation', e.message);
      throw e;
    }

    // The typed document artifact (materialization.persist_via: artifact.persist) — content-addressed
    // get-or-create through the Tier-B store, so a re-run re-resolves the same handle.
    const stored = await cfg.artifactStore.persist({
      artifact: { kind: docRef, content: doc as ArtifactContent },
      namespace: cfg.spec.product.id,
      scope: scopeId,
    });

    const handleRef = ctx.step.output_artifact_refs?.[0] ?? 'artifact.handle';
    return {
      status: 'completed',
      artifact_refs: [
        {
          id: stored.handle.id,
          kind: handleRef,
          source_node_id: ctx.step.id,
          value: stored.handle,
        },
      ],
      output: { handle: stored.handle, ...outcome },
    };
  };
}
