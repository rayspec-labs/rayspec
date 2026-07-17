/**
 * The `record_input.submit` core operation — the AUDIO DURABILITY RECIPE,
 * adopted deliberately (the four requirements below):
 *
 *  1. DETERMINISTIC TENANT-SCOPED EVENT ID — `submittedEventId(tenantId, recordId)`
 *     (= `${tenantId}:${recordId}`, the audio `finalizedEventId` mirror).
 *  2. IDEMPOTENT RE-SUBMIT THAT RE-EMITS — submit persists the capability-owned row first (upsert
 *     on the tenant-prefixed `record_ref`), then EMITS on BOTH the first-persist path AND the
 *     identical-re-submit path (client retry = redelivery; a crash between persist and emit is
 *     recovered by the retry). The sink/dispatcher dedups downstream (single-flight) — ONE
 *     durable run per record.
 *  3. PER-TENANT CAPABILITY-STORE KEYING — the `record_ref` unique embeds the server-derived
 *     tenant (stores.ts/keys.ts; the audio `session_ref` pattern — NOT the global-key caveat).
 *  4. DIFFERENT-PAYLOAD-SAME-KEY IS LOUD, NEVER A SILENT DEDUP — a re-submit whose canonical
 *     payload hash differs from the stored row is a 409 `record_conflict` with ZERO row change and
 *     ZERO emit OF THE REQUEST'S PAYLOAD (first-write-wins would silently dedup a workflow onto
 *     data the client believes replaced; the 409 makes the divergence the CLIENT's explicit
 *     problem). The STORED authoritative event IS re-emitted on this path (the stored-event heal below).
 *     The emitted payload is always the AUTHORITATIVE stored row, never the raw request body.
 *
 * THE STORED-EVENT HEAL (liveness): the persist (tenant-db, auto-commit) and the enqueue (the sink → the
 * SEPARATE DBOS system DB) are non-atomic — a crash between them leaves a persisted row with NO
 * workflow run. The identical-re-submit re-emit (requirement 2) recovers that ONLY for a retry
 * with the IDENTICAL payload; a client retrying with a CORRECTED payload would hit the 409 forever
 * while the stored record silently never runs. So the divergent-409 path RE-EMITS the STORED
 * authoritative event before returning 409: the emit is idempotent end-to-end (the record-scoped
 * `event_id` → the dispatcher's `record_id:<id>` key → the tenant-namespaced durableWorkflowRunId
 * — an already-enqueued record dedups to the SAME run, single-flight), so the heal can never double-run,
 * and "a crash between persist and emit is recovered by the retry" holds for ANY retry payload.
 *
 * TRUST BOUNDARY: the body is UNTRUSTED CALLER DATA — validated for SHAPE (object, nesting depth, size,
 * reserved keys) and stored/forwarded as a plain value; no tenant signal (the tenant is server-derived).
 * The depth bound is what keeps the size/hash computation itself from being a stack-overflow DoS — see
 * canonical-json.ts.
 *
 * OPTIONAL INPUT-NORMALIZE (config-declared; default OFF): a product may declare an agent that
 * NORMALIZES the submitted record before it is persisted. When a `normalizer` is supplied, the raw
 * shape-validated record is transformed by that agent AFTER validation and BEFORE persist, and the
 * NORMALIZED value is re-validated (structural shape), stored, and emitted. The normalize runs ONLY on
 * the FIRST persist and the record's idempotency identity stays the RAW input (so a re-submit converges
 * on the stored normalized value and never re-invokes a possibly-non-deterministic agent). Fail-closed:
 * a normalize failure REJECTS the submit and persists nothing. Absent ⇒ byte-identical to no normalize.
 */
import {
  CanonicalJsonDepthError,
  canonicalJsonByteLength,
  MAX_CANONICAL_JSON_DEPTH,
  recordPayloadHash,
} from './canonical-json.js';
import type { ResolvedRecordConfig } from './config.js';
import { err, ok, type RecordCapabilityError, type RecordCapabilityResult } from './errors.js';
import { RecordEventRejectedError, type RecordSubmittedSink } from './events.js';
import { recordRef, submittedEventId } from './keys.js';
import type { RecordNormalizeOutcome, RecordNormalizer } from './normalizer.js';
import type { RecordCoreContext, RecordParams } from './ports.js';
import { RECORD_SUBMISSIONS_STORE } from './stores.js';
import {
  RECORD_EVENT_ENVELOPE_KEYS,
  type RecordSubmitResult,
  type SubmittedRecordEvent,
} from './types.js';

/** Is the body a plain JSON object (not null / array / scalar)? */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Build the record-scoped `record_submitted` event from a STORED payload (the ONE construction
 * both emit sites use — the success path and the divergent-409 heal). `occurred_at` is
 * per-delivery (like the audio capability's redelivery); the identity + payload are what the
 * downstream dedup keys on.
 */
function submittedEvent(
  tenantId: string,
  recordId: string,
  storedPayload: Record<string, unknown>,
): SubmittedRecordEvent {
  return {
    event_id: submittedEventId(tenantId, recordId),
    tenant_id: tenantId,
    record_id: recordId,
    record: storedPayload,
    occurred_at: new Date().toISOString(),
    source_capability: 'record_input',
  };
}

/**
 * Re-validate a NORMALIZED record against the record's STRUCTURAL shape before it is stored: a plain
 * JSON object, carrying no reserved envelope key, within the depth + byte bounds. A normalize step
 * cannot produce an invalid stored row, so every violation is a fail-closed 502 (an upstream transform
 * produced an unusable response) — persisting nothing. `undefined` ⇒ the value is store-safe.
 */
function validateNormalizedShape(
  candidate: unknown,
  config: ResolvedRecordConfig,
): RecordCapabilityError | undefined {
  if (!isPlainObject(candidate)) {
    return err(
      502,
      'record_normalize_invalid_output',
      'the input-normalize step produced a non-object record — no record was stored.',
    );
  }
  const reserved = RECORD_EVENT_ENVELOPE_KEYS.filter((k) => Object.hasOwn(candidate, k));
  if (reserved.length > 0) {
    return err(
      502,
      'record_normalize_invalid_output',
      `the input-normalize step produced a record carrying the reserved envelope key(s) ${reserved
        .map((k) => `'${k}'`)
        .join(', ')} — no record was stored.`,
    );
  }
  let bytes: number;
  try {
    bytes = canonicalJsonByteLength(candidate);
  } catch (e) {
    if (e instanceof CanonicalJsonDepthError) {
      return err(
        502,
        'record_normalize_invalid_output',
        `the input-normalize step produced a record exceeding the ${MAX_CANONICAL_JSON_DEPTH}-level ` +
          'nesting bound — no record was stored.',
      );
    }
    throw e;
  }
  if (bytes > config.maxRecordBytes) {
    return err(
      502,
      'record_normalize_invalid_output',
      `the input-normalize step produced a record exceeding the ${config.maxRecordBytes}-byte ` +
        'bound — no record was stored.',
    );
  }
  return undefined;
}

/**
 * Run the declared input-normalize step over the shape-validated raw record. Fail-CLOSED: a thrown
 * normalizer, a returned `error` outcome, and an output that fails structural re-validation ALL become
 * a typed 502 (nothing is persisted). On success the validated normalized record is returned to be
 * stored + emitted in place of the raw input.
 *
 * NO-LEAK: the client-facing 502 `detail` is GENERIC. The underlying agent/provider/DB text (an
 * upstream 429 carrying an org id / model / quota, or a raw Postgres error) is UNTRUSTED to expose and
 * NEVER reaches the HTTP body — only the NEUTRALIZED error CLASS (a closed vocabulary that carries no
 * raw provider text) is surfaced, so a caller learns the failure class without the leaky detail. The
 * raw text stays server-side (no logger is threaded into the neutral core — the platform
 * sink/dispatcher owns observability). The self-authored `record_normalize_invalid_output` messages
 * (validateNormalizedShape) are already neutral and describe the shape violation, so they are kept.
 */
async function runNormalize(
  normalizer: RecordNormalizer,
  raw: Record<string, unknown>,
  recordId: string,
  config: ResolvedRecordConfig,
): Promise<
  { readonly ok: true; readonly record: Record<string, unknown> } | RecordCapabilityError
> {
  let outcome: RecordNormalizeOutcome;
  try {
    outcome = await normalizer.normalize({ record: raw, recordId });
  } catch {
    // The thrown text is dropped from the client body (no-leak) — a generic, actionable 502.
    return err(
      502,
      'record_normalize_failed',
      'the input-normalize step failed — no record was stored.',
    );
  }
  if (outcome.status === 'error') {
    // `outcome.message` is the RAW upstream text (the classifier preserves it) and is dropped from the
    // client body; only the neutralized `errorClass` (never raw provider text) is surfaced.
    return err(
      502,
      'record_normalize_failed',
      `the input-normalize step failed${outcome.errorClass ? ` (${outcome.errorClass})` : ''} — ` +
        'no record was stored.',
    );
  }
  const shapeError = validateNormalizedShape(outcome.record, config);
  if (shapeError) return shapeError;
  return { ok: true, record: outcome.record };
}

/**
 * Submit ONE record: validate shape → (optionally) NORMALIZE via the declared agent → persist
 * idempotently (upsert on the tenant-prefixed ref) → EMIT the record-scoped `record_submitted` event
 * from the authoritative stored row. See the module header for the durability recipe + the optional
 * input-normalize step. A sink's deliberate fail-closed rejection (`RecordEventRejectedError`)
 * propagates — the route binding owns the 403 mapping.
 *
 * `normalizer` (OPTIONAL): when supplied, the shape-validated raw record is transformed by it on the
 * FIRST persist (absent ⇒ behaviour is byte-identical to no normalize).
 */
export async function submitRecord(
  ctx: RecordCoreContext,
  params: RecordParams,
  body: unknown,
  sink: RecordSubmittedSink,
  normalizer?: RecordNormalizer,
): Promise<RecordCapabilityResult<RecordSubmitResult>> {
  const recordId = params.record_id ?? '';
  if (!ctx.config.recordIdPattern.test(recordId)) {
    return err(
      422,
      'invalid_record_id',
      'record_id must match the configured safe-id shape (default: 1..128 ASCII letters/digits/._-).',
    );
  }
  // The point-of-use belt: ':' is the STRUCTURAL delimiter of `record_ref`/`event_id`
  // (`${tenantId}:${recordId}`) — a record id carrying it would let two distinct (tenant, record)
  // pairs collide on one ref/idempotency key. resolveRecordConfig already rejects an override
  // pattern that admits ':' at construction; this check holds even for a hand-built config.
  if (recordId.includes(':')) {
    return err(
      422,
      'invalid_record_id',
      "record_id must not contain ':' — it is the reserved tenant/record delimiter of the " +
        'record ref and the event idempotency key.',
    );
  }
  if (!isPlainObject(body)) {
    return err(
      422,
      'invalid_record',
      'the request body must be a single JSON object of business fields (DATA).',
    );
  }
  // RESERVED-ENVELOPE-KEY REJECTION (trust boundary): the submitted fields merge TOP-LEVEL into the trigger
  // payload alongside the fixed envelope, so a body carrying an envelope key could spoof the
  // server-derived identity fields downstream. Reject loudly, naming the key.
  const reserved = RECORD_EVENT_ENVELOPE_KEYS.filter((k) => Object.hasOwn(body, k));
  if (reserved.length > 0) {
    return err(
      422,
      'reserved_record_key',
      `the record body must not carry the reserved envelope key(s) ${reserved
        .map((k) => `'${k}'`)
        .join(', ')} — these are server-derived event fields.`,
    );
  }
  // Canonicalization (the size measure AND the hash) recurses per container level, so it is
  // depth-bounded fail-closed — a hostile deeply-nested body (tiny bytes, huge recursion) is the
  // TYPED 422 here, never a stack-overflow escaping as a 500 at the trust boundary. One guarded
  // block covers both computations (once one canonicalization of `body` passes, all do).
  let canonicalBytes: number;
  let hash: string;
  try {
    canonicalBytes = canonicalJsonByteLength(body);
    hash = recordPayloadHash(body);
  } catch (e) {
    if (e instanceof CanonicalJsonDepthError) {
      return err(
        422,
        'record_too_deep',
        `the record's JSON nesting exceeds the ${MAX_CANONICAL_JSON_DEPTH}-level bound ` +
          '(this capability ingests form-grade business records; a deeper body cannot be ' +
          'canonicalized safely).',
      );
    }
    throw e;
  }
  if (canonicalBytes > ctx.config.maxRecordBytes) {
    return err(
      413,
      'record_too_large',
      `the record's canonical JSON serialization exceeds the ${ctx.config.maxRecordBytes}-byte ` +
        'bound (this capability ingests form-grade business records, not documents).',
    );
  }

  const ref = recordRef(ctx.tenantId, recordId);

  // Existing row? (Tenant-scoped by construction: the facade is tenant-bound AND the ref embeds
  // the tenant.) An identical re-submit is a redelivery; a divergent one is a loud 409.
  const existing = await ctx.db.select(RECORD_SUBMISSIONS_STORE, { record_ref: ref }, { limit: 1 });
  const found = existing[0];
  let deduped = false;
  if (found !== undefined) {
    if (found.payload_hash !== hash) {
      // THE STORED-EVENT HEAL (see the module header): before the loud 409, RE-EMIT the STORED
      // authoritative event — if a prior submit crashed between its persist and its emit, THIS is
      // the only path a corrected-payload retry ever reaches, and without the re-emit the
      // persisted record would silently never get its workflow run. The emit is idempotent
      // downstream (record-scoped event_id → `record_id:<id>` → the same durableWorkflowRunId), so
      // an already-enqueued record dedups to its existing run — zero double-run. The emitted
      // payload is the STORED row's (authoritative), NEVER this request's divergent body.
      //
      // The heal is BEST-EFFORT. The 409 record_conflict is the DETERMINISTIC, CORRECT
      // answer regardless of downstream health — the divergent payload conflicts either way, and
      // this is a PERMANENT client condition (a retry never resolves it). The heal is an
      // OPPORTUNISTIC self-heal riding on that terminal 409; a TRANSIENT sink/DBOS fault must NOT
      // turn the clean 409 into a 500 (a naive client retrying the conflict → a 500 storm), so we
      // SWALLOW it — if the record really was persisted-but-never-enqueued, the NEXT retry heals it.
      // BUT a `RecordEventRejectedError` (its `CrossTenantRecordEventError` subclass = the workflow
      // bridge's DELIBERATE tenant assertion) is fail-closed LAW, not a transient fault: it MUST
      // propagate so the binding maps it to a 403 (a foreign-tenant divergent submit is a 403, never
      // a swallowed 409). We swallow ONLY faults OUTSIDE that fail-closed family. (Contrast the
      // success-path emit below, which is DELIBERATELY NOT best-effort — it is the crash-recovery
      // re-emit and must surface to keep the client retrying until the record is enqueued.)
      try {
        await sink.emit(
          submittedEvent(ctx.tenantId, recordId, found.payload as Record<string, unknown>),
        );
      } catch (e) {
        if (e instanceof RecordEventRejectedError) throw e; // fail-closed cross-tenant → 403
        // Best-effort: swallow a transient sink/DBOS fault; the deterministic 409 stands. (No
        // logger is threaded into the neutral core — the platform sink/dispatcher owns observability.)
      }
      return err(
        409,
        'record_conflict',
        `record '${recordId}' was already submitted with a DIFFERENT payload — a re-submit must ` +
          'carry the identical record (the stored payload is authoritative and was NOT changed; ' +
          'no workflow was started for this request). Submit a new record_id for new data.',
      );
    }
    deduped = true;
  } else {
    // First persist: run the OPTIONAL declared input-normalize step (absent ⇒ this branch is
    // byte-identical to today), then ATOMIC upsert on the tenant-prefixed unique ref (db.upsert ONLY —
    // never insert-and-recover; the single-flight 25P02 law). A concurrent identical first-submit
    // converges here.
    //
    // NORMALIZE RUNS ONLY ON FIRST PERSIST and the idempotency identity stays the RAW submitted input
    // (`payload_hash` = hash of the raw body): a re-submit of the same record hits the found-path above
    // and re-emits the ALREADY-normalized stored row, so a re-submit never re-runs a (possibly
    // non-deterministic) agent and can never spuriously conflict against a fresh normalize. The
    // NORMALIZED value is what gets stored (and, via the authoritative re-read below, emitted).
    let toStore: Record<string, unknown> = body;
    if (normalizer !== undefined) {
      const normalized = await runNormalize(normalizer, body, recordId, ctx.config);
      if (!normalized.ok) return normalized; // fail-closed: nothing persisted, nothing emitted
      toStore = normalized.record;
    }
    await ctx.db.upsert(RECORD_SUBMISSIONS_STORE, ['record_ref'], {
      record_id: recordId,
      record_ref: ref,
      payload: toStore as never,
      payload_hash: hash,
    });
  }

  // AUTHORITATIVE RE-READ: the emitted payload is the STORED row, never the raw request body — a
  // redelivered event is byte-consistent with the first delivery. A concurrent DIVERGENT racer
  // that overwrote between our upsert and this read surfaces as a hash mismatch → the loud 409
  // (this request's payload did not win; nothing is emitted for it).
  const stored = await ctx.db.select(RECORD_SUBMISSIONS_STORE, { record_ref: ref }, { limit: 1 });
  const row = stored[0];
  if (row === undefined || row.payload_hash !== hash) {
    // NO heal-emit on THIS 409 (unlike the found-divergent path above — deliberate): the racer
    // that won the overwrite is mid-request and emits its own stored event on its own path; if it
    // crashes before that emit, any later retry of EITHER client lands on the found-divergent
    // path, which heals. Emitting the just-read row here would be racing a row still in flux.
    return err(
      409,
      'record_conflict',
      `record '${recordId}' changed concurrently during this submit — the stored payload is ` +
        'authoritative and does not match this request (no workflow was started for this request).',
    );
  }

  const event = submittedEvent(ctx.tenantId, recordId, row.payload as Record<string, unknown>);
  // Emit on EVERY successful submit (first + identical re-submit): the re-emission is the
  // redelivery a crash-between-persist-and-emit needs; the sink/dispatcher dedups by the
  // record-scoped key (single-flight). A RecordEventRejectedError from the sink propagates (fail-closed law
  // — nothing enqueued; the binding maps it to a clean 403).
  await sink.emit(event);

  return ok({ record_id: recordId, event_id: event.event_id, deduped });
}
