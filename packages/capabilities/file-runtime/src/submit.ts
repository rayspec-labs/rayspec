/**
 * The `file_input.submit` core operation — seal the staged bytes + emit `file_submitted` (the
 * record `submit.ts` durability recipe over a byte-backed pointer row):
 *
 *  1. DETERMINISTIC TENANT-SCOPED EVENT ID — `submittedFileEventId(tenantId, fileId)`
 *     (= `${tenantId}:${fileId}`, the record/audio mirror).
 *  2. IDEMPOTENT RE-SUBMIT THAT RE-EMITS — a re-submit of a sealed file returns `deduped: true`
 *     AND re-emits the STORED authoritative event (client retry = redelivery; a crash between
 *     seal and emit is recovered by the retry). The sink/dispatcher dedups downstream (C10
 *     single-flight via `file_id:<id>`) — ONE durable run per file.
 *  3. THE EVENT IS BUILT FROM THE STORED ROW ONLY (row-event.ts) — never from a request; a
 *     deduped redelivery is byte-consistent with the first delivery. Bytes are NEVER in the
 *     payload (the blob key is the pointer).
 *  4. DIVERGENCE IS LOUD, NEVER A SILENT DEDUP — the submit body is a CLOSED shape
 *     (`{ sha256? }`): an OPTIONAL integrity assertion (the audio `total_chunks` precedent). An
 *     assertion that does not match the stored bytes is a 409 `file_conflict`; on a SEALED row
 *     that 409 carries the stored-event heal (best-effort — a generic transient sink fault
 *     is swallowed, the deterministic 409 stands; the fail-closed `FileEventRejectedError` family
 *     propagates to the binding's 403 — the record micro-fix pattern). Any OTHER body key
 *     is rejected 422 (`invalid_submit_body`) — the payload is server-derived only, so there is
 *     no spoof channel at all.
 *
 * EMIT-FAULT POSTURE (donor-faithful, the record decision tests): the FIRST-submit emit and the
 * IDENTICAL-re-submit re-emit are DELIBERATELY NOT best-effort — they are the crash-recovery
 * mechanism, so a transient sink fault SURFACES (500) to keep the client retrying until the file
 * is enqueued; swallowing it would re-open the silent zero-run. What a SURFACED first-submit
 * fault leaves behind (PINNED by the route wiring):
 *  - REAL-PLATFORM posture (proven by api-auth file-capability.db.test.ts): the submit route runs
 *    INSIDE the engine's tenant transaction (platform route-init.ts `invokeRouteHandler`), so a
 *    surfaced fault ROLLS THE SEAL BACK — the retry re-seals from `uploaded` and emits
 *    (`deduped: false`).
 *  - UNIT-FAKE posture (this package's tests only): the fake db auto-commits, so the seal PERSISTS
 *    and the retry lands on the re-submit path, which re-emits (`deduped: true`).
 * No silent zero-run either way. ONLY the divergent-409 heal is best-effort (the 409 is a
 * PERMANENT client condition — correct regardless of downstream health).
 *
 * A submit for a file this tenant never staged — including ANOTHER tenant's file id (tenant-
 * scoped reads make it invisible) — is the same non-disclosing 409 `file_not_uploaded`.
 */
import { err, type FileCapabilityResult, ok } from './errors.js';
import { FileEventRejectedError, type FileSubmittedSink } from './events.js';
import { fileRef } from './keys.js';
import type { FileCoreContext, FileParams } from './ports.js';
import { submittedFileEventFromRow } from './row-event.js';
import { FILE_UPLOADS_STORE } from './stores.js';
import type { FileSubmitResult } from './types.js';
import { validateFileId } from './validate.js';

/** The closed submit-body shape: the ONLY accepted key. */
const ALLOWED_SUBMIT_KEYS = new Set(['sha256']);

/** A sha256 hex assertion (64 lowercase/uppercase hex chars). */
const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;

/** Is the body a plain JSON object (not null / array / scalar)? */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Submit ONE staged file: validate the closed body shape → read the stored row (tenant-scoped) →
 * seal it (first submit) → EMIT the file-scoped `file_submitted` event from the authoritative
 * stored row. See the module header for the durability recipe. A sink's deliberate fail-closed
 * rejection (`FileEventRejectedError`) propagates — the route binding owns the 403 mapping.
 */
export async function submitFile(
  ctx: FileCoreContext,
  params: FileParams,
  body: unknown,
  sink: FileSubmittedSink,
): Promise<FileCapabilityResult<FileSubmitResult>> {
  const idResult = validateFileId(ctx.config, params);
  if (!idResult.ok) return idResult;
  const fileId = idResult.value;

  // The CLOSED body shape (requirement 4): absent or `{ sha256? }`, nothing else. There is no
  // merge into the event payload, so ANY unknown key is rejected — the whole-invariant spoof
  // guard (trust boundary: the payload stays server-derived).
  let assertedSha: string | undefined;
  if (body !== undefined) {
    if (!isPlainObject(body)) {
      return err(
        422,
        'invalid_submit_body',
        'the submit body must be absent or a JSON object of the closed shape { sha256? }.',
      );
    }
    const unknown = Object.keys(body).filter((k) => !ALLOWED_SUBMIT_KEYS.has(k));
    if (unknown.length > 0) {
      return err(
        422,
        'invalid_submit_body',
        `the submit body accepts only the optional integrity key 'sha256' — unknown key(s) ${unknown
          .map((k) => `'${k}'`)
          .join(', ')} (the file_submitted payload is server-derived; there is nothing to set).`,
      );
    }
    if (Object.hasOwn(body, 'sha256')) {
      const raw = body.sha256;
      if (typeof raw !== 'string' || !SHA256_HEX_RE.test(raw)) {
        return err(
          422,
          'invalid_submit_body',
          "the optional 'sha256' integrity assertion must be a 64-char hex sha256 of the uploaded bytes.",
        );
      }
      assertedSha = raw.toLowerCase();
    }
  }

  const ref = fileRef(ctx.tenantId, fileId);
  const existing = await ctx.db.select(FILE_UPLOADS_STORE, { file_ref: ref }, { limit: 1 });
  const found = existing[0];
  if (found === undefined) {
    // Nothing staged under THIS tenant — including a foreign tenant's file id (tenant-scoped
    // reads; the non-disclosing shape: indistinguishable from a genuinely-absent file).
    return err(
      409,
      'file_not_uploaded',
      `file '${fileId}' has no uploaded bytes to submit — PUT the bytes first, then submit.`,
    );
  }

  const sealed = found.state === 'submitted';

  // The integrity assertion (the audio total_chunks precedent): a mismatch is a LOUD 409 — the
  // client believes different bytes are staged than actually are.
  if (assertedSha !== undefined && assertedSha !== String(found.sha256).toLowerCase()) {
    if (sealed) {
      // THE STORED-EVENT HEAL (best-effort — the record heal rationale, see the module header): the
      // sealed row may be persisted-but-never-enqueued; re-emit its STORED event before the
      // permanent 409. Generic transient faults are swallowed; the fail-closed rejection family
      // propagates (403).
      try {
        await sink.emit(submittedFileEventFromRow(ctx.tenantId, found));
      } catch (e) {
        if (e instanceof FileEventRejectedError) throw e; // fail-closed cross-tenant → 403
        // Best-effort: swallow a transient sink/DBOS fault; the deterministic 409 stands.
      }
    }
    // On an UNSEALED row there is nothing enqueued to heal (the event only exists post-seal) —
    // plain 409, zero emit.
    return err(
      409,
      'file_conflict',
      `the sha256 assertion does not match the stored bytes of file '${fileId}' — the stored ` +
        'bytes are authoritative (no state was changed; no workflow was started for this request).',
    );
  }

  if (!sealed) {
    // FIRST SUBMIT: seal the row, then emit (tx posture: the module header's tx-posture note).
    await ctx.db.update(
      FILE_UPLOADS_STORE,
      { file_ref: ref },
      { state: 'submitted', submitted_at: new Date().toISOString() },
    );
  }

  // AUTHORITATIVE RE-READ: the emitted event is built from the STORED row as it now stands (the
  // record re-read posture) — never from this request's values.
  const stored = await ctx.db.select(FILE_UPLOADS_STORE, { file_ref: ref }, { limit: 1 });
  const row = stored[0];
  if (row === undefined) {
    throw new Error('file-runtime submit: pointer row vanished mid-submit (fail-closed).');
  }

  // THE RE-READ CONSISTENCY GUARD (the record re-read-divergence posture restored): this
  // request's decisions — the integrity 409-check and the seal itself — were made against
  // `found`. A DIVERGENT upload that replaced the still-staged bytes between that read and the
  // seal means the re-read row holds bytes this request NEVER verified; emitting them would
  // start a workflow on an unchecked payload. 409 instead, ZERO emit (the row is NOT rolled
  // back — the racer's bytes are legitimately stored; only THIS request's decision basis is
  // stale). NO heal-emit on THIS 409 (donor-deliberate, the record re-read arm's rationale):
  // the just-read row is still in flux — any later retry (submit OR divergent upload) lands on
  // the STABLE identical/divergent paths above, which emit/heal the stored event.
  if (row.state !== 'submitted' || row.sha256 !== found.sha256) {
    return err(
      409,
      'file_conflict',
      `file '${fileId}' changed concurrently during this submit — the stored bytes are ` +
        'authoritative and do not match the bytes this submit decided on (no workflow was ' +
        'started for this request).',
    );
  }

  // Emit on EVERY successful submit (first + re-submit): the re-emission is the redelivery a
  // crash-between-seal-and-emit needs; the sink/dispatcher dedups by the file-scoped key (C10).
  // NOT best-effort (the module-header decision): a transient fault SURFACES so the client keeps
  // retrying until the file is enqueued. A FileEventRejectedError propagates (fail-closed law —
  // nothing enqueued; the binding maps it to a clean 403).
  const event = submittedFileEventFromRow(ctx.tenantId, row);
  await sink.emit(event);

  return ok({ file_id: fileId, event_id: event.event_id, deduped: sealed });
}
