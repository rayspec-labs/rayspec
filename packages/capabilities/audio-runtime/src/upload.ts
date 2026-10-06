/**
 * The upload protocol core: idempotent, resumable chunk ingest + upload-status + track
 * finalize. Product-neutral: the 200-ack / 409-gap / 200-no-op contract, the watermark idempotency, and
 * the SAVEPOINT-scoped concurrent-first-chunk recovery are all enforced here; nothing here names a product.
 */
import type { StoreRow } from '@rayspec/handler-sdk';
import { parseProtocolVersion } from './config.js';
import { type AudioCapabilityResult, err, ok } from './errors.js';
import type { SessionFinalizedSink } from './events.js';
import { chunkKey, finalizedEventId, sessionRef, storageKeyPrefix, trackRef } from './keys.js';
import {
  AUDIO_SESSIONS_STORE,
  AUDIO_TRACKS_STORE,
  type AudioBlobContext,
  type AudioCoreContext,
  type HandlerDb,
  type SessionTrackParams,
} from './ports.js';
import type {
  ChunkAck,
  FinalizedSessionEvent,
  FinalizedTrackSummary,
  FinalizeResult,
  UploadStatus,
} from './types.js';
import { validateSessionTrack } from './validate.js';

/** True if a thrown DB error is a Postgres UNIQUE violation (SQLSTATE 23505). Walks the cause chain. */
function isUniqueViolation(errValue: unknown): boolean {
  let cur: unknown = errValue;
  for (let depth = 0; depth < 5 && cur != null; depth++) {
    if (typeof cur === 'object' && (cur as { code?: unknown }).code === '23505') return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * CREATE the per-(session, track) watermark row for a track the caller read as absent, within THIS
 * tenant, and return it (or the row a concurrent first chunk created). The parent session row is
 * upserted first (so the track FK resolves), then the track row is inserted at watermark 0. EACH
 * contending INSERT runs inside a NESTED `db.transaction()` SAVEPOINT so a concurrent first-chunk
 * race that collides on the tenant-namespaced UNIQUE rolls back ONLY that savepoint (not the outer
 * route tx): the session-row collision is re-read HERE; the track-row collision (23505) is thrown OUT
 * for the caller to catch + re-read — never a 500 on a poisoned outer tx.
 *
 * The session row is LOCKED (a no-op UPDATE, the one row lock `HandlerDb` offers) before the track
 * row is inserted, and `completeSessionIfAllTracksSealed` takes the same lock before it reads the
 * tracks. A new track and a finalize of the same session therefore run one after the other: either
 * the finalize sees this track and leaves the session `recording`, or this call sees the session the
 * finalize completed and reopens it. Lock order is session → track here and track → session on
 * finalize; neither path waits for a track row the other holds, so the two cannot deadlock.
 */
async function ensureTrackRow(
  db: HandlerDb,
  tenantId: string,
  sessionId: string,
  track: string,
  protocolVersion: number,
): Promise<StoreRow> {
  const sessions = await db.select(AUDIO_SESSIONS_STORE, { session_id: sessionId });
  if (!sessions[0]) {
    // The session INSERT runs inside a NESTED savepoint — a concurrent first-chunk for the SAME session
    // (different track / same track) collides on `session_ref`; the savepoint scopes that 23505 so the
    // loser carries on with the winner's now-visible row on the still-clean outer tx.
    try {
      await db.transaction(async (tx) => {
        await tx.insert(AUDIO_SESSIONS_STORE, {
          session_id: sessionId,
          session_ref: sessionRef(tenantId, sessionId),
          status: 'recording',
          protocol_version: protocolVersion,
        });
      });
    } catch (errValue) {
      if (!isUniqueViolation(errValue)) throw errValue;
    }
  }
  // Lock the session row and read it as it stands once any finalize holding it has committed.
  const [sessionRow] = await db.update(
    AUDIO_SESSIONS_STORE,
    { session_id: sessionId },
    { session_id: sessionId },
  );
  if (!sessionRow) {
    throw new Error('audio-runtime ingest: session row unresolved after upsert (fail-closed).');
  }
  const sessionPk = sessionRow.id;
  if (typeof sessionPk !== 'string') {
    throw new Error('audio-runtime ingest: session row missing its uuid id (fail-closed).');
  }

  // A concurrent first chunk of the same track that held the lock first has committed its row by now.
  const raced = await db.select(AUDIO_TRACKS_STORE, { session_id: sessionId, track });
  if (raced[0]) return raced[0];

  // The track INSERT likewise runs inside a NESTED savepoint — a collision on `track_ref` surfaces as a
  // 23505 the caller catches + re-reads.
  let trackRow: StoreRow | undefined;
  await db.transaction(async (tx) => {
    trackRow = await tx.insert(AUDIO_TRACKS_STORE, {
      session_pk: sessionPk,
      session_id: sessionId,
      track,
      status: 'recording',
      storage_key_prefix: storageKeyPrefix(sessionId, track),
      persisted_chunk_count: 0,
      committed_byte_len: 0,
      track_ref: trackRef(tenantId, sessionId, track),
    });
  });
  if (!trackRow) {
    throw new Error('audio-runtime ingest: track row unresolved after insert (fail-closed).');
  }
  // A track that starts on a session whose earlier tracks were all sealed puts the session back in
  // flight; that track's own finalize completes it again. Decided on the status read under the lock,
  // and only after this call's own insert succeeded: a first-chunk retry that finds the track already
  // there must not reopen a session that track's finalize completed.
  if (sessionRow.status === 'completed') {
    await db.update(AUDIO_SESSIONS_STORE, { session_id: sessionId }, { status: 'recording' });
  }
  return trackRow;
}

/**
 * Ingest one ordered chunk's bytes for (session, track). Returns a typed result the binding maps to a
 * raw Response: 200 ack (advance), 200 no-op (duplicate / sealed), or 409 gap. `contentType` is the
 * request's content type (advisory metadata on the stored blob). `chunkIndexRaw` is the server-parsed
 * path param (validated to a non-negative integer here).
 *
 * A REJECTED chunk writes nothing. Every rejection (400, 409 gap, 413) is decided from a plain read of
 * the track row; a track with no row has watermark 0 and no committed bytes, so only an accepted
 * index 0 creates the session row and the track row, and only after its bytes are stored.
 */
export async function ingestChunk(
  ctx: AudioBlobContext,
  params: SessionTrackParams & { chunk_index?: string; protocol_version?: string },
  bytes: Uint8Array,
  contentType?: string,
): Promise<AudioCapabilityResult<ChunkAck>> {
  const target = validateSessionTrack(ctx.config, params);
  if (!target.ok) return target;
  const { session_id: sessionId, track } = target.value;

  const indexRaw = params.chunk_index;
  if (!indexRaw) return err(400, 'bad_request', 'chunk_index is required.');
  const chunkIndex = Number(indexRaw);
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
    return err(400, 'bad_request', 'chunk_index must be a non-negative integer.');
  }

  const protocolVersion = parseProtocolVersion(
    params.protocol_version,
    ctx.config.defaultProtocolVersion,
  );

  // Resolve the current watermark WITHOUT creating anything: an absent track is at watermark 0.
  const found = await ctx.db.select(AUDIO_TRACKS_STORE, { session_id: sessionId, track });
  const existing = found[0];

  // A SEALED (finalized) track no-ops a late chunk retry (the upload is done — not an error).
  if (existing?.status === 'completed') {
    const sealedWatermark = Number(existing.persisted_chunk_count) || 0;
    return ok({ next_expected_index: sealedWatermark });
  }

  const watermark = existing ? Number(existing.persisted_chunk_count) : 0;
  const nextExpected = Number.isInteger(watermark) && watermark >= 0 ? watermark : 0;

  // index < next_expected → idempotent re-POST (no-op 200, do NOT re-advance).
  if (chunkIndex < nextExpected) {
    return ok({ next_expected_index: nextExpected });
  }
  // index > next_expected → a GAP (missing earlier chunk). 409, telling the client what to send next.
  if (chunkIndex > nextExpected) {
    return err(409, 'gap', 'a gap in the chunk sequence.', { next_expected_index: nextExpected });
  }

  // THE PER-TRACK CUMULATIVE BYTE CAP (cost-DoS bound): the chunk that would push this track's
  // committed total past the configured cap is a 413 BEFORE the blob put + watermark advance — so an
  // authenticated caller cannot accrue unbounded storage/memory across many individually-in-cap chunks.
  // A duplicate re-POST (index < next_expected, handled above) never reaches here, so a retry of an
  // already-counted chunk is never double-charged against the cap.
  const committedSoFar = existing ? Number(existing.committed_byte_len) || 0 : 0;
  if (committedSoFar + bytes.length > ctx.config.maxTrackBytes) {
    return err(
      413,
      'track_too_large',
      `this track's committed bytes would exceed the ${ctx.config.maxTrackBytes}-byte per-track cap.`,
      { next_expected_index: nextExpected },
    );
  }

  // index == next_expected → store the chunk. Put-by-index FIRST (idempotent — a crash before the
  // watermark advance is safe: a retry re-puts the same key), then advance the watermark transactionally
  // with a re-read guard against a concurrent same-index race. The put also precedes the creation of
  // a new track's rows, so a failed put leaves no row behind and the session row is not held locked
  // across the blob write.
  //
  // No row lock is held across the put, at any index. Two requests for the SAME index that both read
  // the same watermark both put; the first to commit counts its own length and the other no-ops at
  // that watermark, but its put may land last. With different bodies the later body is then stored
  // against the earlier length, so `committed_byte_len` (and with it the per-track cap) can
  // under-count by at most one chunk cap per such race. Only a client racing its own upload of one
  // index with different bytes reaches this.
  const key = chunkKey(sessionId, track, chunkIndex);
  await ctx.blob.put(key, bytes, contentType ? { contentType } : undefined);

  // The accepted first chunk of a new track creates its rows (a concurrent first-chunk race is
  // re-read; the advance below then settles on whatever watermark the winner reached).
  if (!existing) {
    try {
      await ensureTrackRow(ctx.db, ctx.tenantId, sessionId, track, protocolVersion);
    } catch (errValue) {
      if (!isUniqueViolation(errValue)) throw errValue;
      const reread = await ctx.db.select(AUDIO_TRACKS_STORE, { session_id: sessionId, track });
      if (!reread[0]) throw errValue;
    }
  }

  let advancedTo = chunkIndex + 1;
  await ctx.db.transaction(async (tx) => {
    const rows = await tx.select(AUDIO_TRACKS_STORE, { session_id: sessionId, track });
    const current = rows[0];
    if (!current) {
      throw new Error('audio-runtime ingest: track row vanished mid-transaction (fail-closed).');
    }
    const currentWatermark = Number(current.persisted_chunk_count) || 0;
    if (currentWatermark === chunkIndex) {
      const committed = Number(current.committed_byte_len) || 0;
      // The advance is guarded ATOMICALLY on `status='recording'` (in the WHERE, not a pre-read): a
      // concurrent finalize that seals the track between this re-read and the write drops the row from
      // the filter, so a completed track can never have its watermark pushed PAST its sealed total. Zero
      // rows updated == the seal won the race → treat this chunk as a post-seal late retry (no-op at the
      // sealed watermark), matching the canonical sealed-track semantics.
      const updated = await tx.update(
        AUDIO_TRACKS_STORE,
        { session_id: sessionId, track, status: 'recording' },
        {
          persisted_chunk_count: chunkIndex + 1,
          committed_byte_len: committed + bytes.length,
        },
      );
      if (updated.length === 0) {
        const sealed = await tx.select(AUDIO_TRACKS_STORE, { session_id: sessionId, track });
        advancedTo = Number(sealed[0]?.persisted_chunk_count) || 0;
      } else {
        advancedTo = chunkIndex + 1;
      }
    } else if (currentWatermark > chunkIndex) {
      // A concurrent POST already advanced past us (for index 0: the first chunk whose track row
      // this request found or collided with) — idempotent no-op. Both wrote the same blob key; the
      // winner's length is the one counted (see the note above the put).
      advancedTo = currentWatermark;
    } else {
      throw new Error(
        `audio-runtime ingest: watermark regressed to ${currentWatermark} below index ${chunkIndex} ` +
          '(fail-closed — refusing to create a gap).',
      );
    }
  });

  return ok({ next_expected_index: advancedTo });
}

/**
 * Report the resume watermark for one (session, track). A track never started (or not owned by this
 * tenant) is reported at watermark 0 / status 'absent' (a fresh-start 200 shape — NOT a 404).
 */
export async function readUploadStatus(
  ctx: AudioCoreContext,
  params: SessionTrackParams,
): Promise<AudioCapabilityResult<UploadStatus>> {
  const target = validateSessionTrack(ctx.config, params);
  if (!target.ok) return target;
  const { session_id: sessionId, track } = target.value;

  const rows = await ctx.db.select(AUDIO_TRACKS_STORE, { session_id: sessionId, track });
  const row = rows[0];
  if (!row) {
    return ok({
      session_id: sessionId,
      track,
      next_expected_index: 0,
      committed_byte_len: 0,
      status: 'absent',
    });
  }
  const watermark = Number(row.persisted_chunk_count);
  const committed = Number(row.committed_byte_len);
  return ok({
    session_id: sessionId,
    track,
    next_expected_index: Number.isInteger(watermark) && watermark >= 0 ? watermark : 0,
    committed_byte_len: Number.isInteger(committed) && committed >= 0 ? committed : 0,
    status: typeof row.status === 'string' ? (row.status as UploadStatus['status']) : 'absent',
  });
}

/** Read the finalized (completed) tracks of a session as event summaries (at emission time). */
async function finalizedTrackSummaries(
  ctx: AudioCoreContext,
  sessionId: string,
): Promise<FinalizedTrackSummary[]> {
  const rows = await ctx.db.select(AUDIO_TRACKS_STORE, {
    session_id: sessionId,
    status: 'completed',
  });
  return rows.map((r) => ({
    track: String(r.track),
    committed_byte_len: Number(r.committed_byte_len) || 0,
  }));
}

/**
 * Mark the session `completed` once every track it holds is sealed. Called on BOTH finalize paths, so
 * a re-finalize also settles a session that an earlier release left at `recording`. A session with a
 * track still in flight stays `recording`.
 *
 * The session row is LOCKED (a no-op UPDATE) before the tracks are read. Two tracks finalized at the
 * same time each seal their own track first; without the lock each would read the other as still
 * `recording` and neither would complete the session. With it the second finalize waits for the first
 * to commit and its read then sees every track sealed. `ensureTrackRow` takes the same lock before it
 * inserts a new track, so a track that starts during a finalize is either seen here or reopens the
 * session itself.
 */
async function completeSessionIfAllTracksSealed(
  ctx: AudioCoreContext,
  sessionId: string,
): Promise<void> {
  const [sessionRow] = await ctx.db.update(
    AUDIO_SESSIONS_STORE,
    { session_id: sessionId },
    { session_id: sessionId },
  );
  if (!sessionRow) return;
  const tracks = await ctx.db.select(AUDIO_TRACKS_STORE, { session_id: sessionId });
  if (tracks.length === 0 || tracks.some((t) => t.status !== 'completed')) return;
  await ctx.db.update(
    AUDIO_SESSIONS_STORE,
    { session_id: sessionId, status: 'recording' },
    { status: 'completed' },
  );
}

/**
 * Emit the session-scoped `session_finalized` event through the injected sink. Called on BOTH the
 * first-seal path AND the idempotent already-completed path (so a crash between seal and emit is
 * recovered by a retried finalize) — the sink dedupes by the session-scoped `event_id`, so a dual-track
 * finalize converges on ONE workflow. Returns the event_id.
 */
async function emitFinalizedSession(
  ctx: AudioCoreContext,
  sessionId: string,
  sink: SessionFinalizedSink,
): Promise<string> {
  const eventId = finalizedEventId(ctx.tenantId, sessionId);
  const event: FinalizedSessionEvent = {
    event_id: eventId,
    tenant_id: ctx.tenantId,
    session_id: sessionId,
    tracks: await finalizedTrackSummaries(ctx, sessionId),
    occurred_at: new Date().toISOString(),
    source_capability: 'audio_input',
  };
  await sink.emit(event);
  return eventId;
}

/**
 * Seal a track's upload (idempotent terminal). The client asserts how many chunks it sent
 * (`totalChunks`); a mismatch against the durable watermark is a 409 (resume from the watermark). On a
 * terminal completed seal the capability EMITS `session_finalized` through the injected sink (NOT a
 * durable agent run — that is Tier A's job). Sealing the last open track of a session also marks the
 * session row `completed`. Idempotent: re-finalizing a completed track with the same total re-emits
 * the (deduped) event and returns 200.
 */
export async function finalizeTrack(
  ctx: AudioCoreContext,
  params: SessionTrackParams,
  totalChunksRaw: unknown,
  sink: SessionFinalizedSink,
): Promise<AudioCapabilityResult<FinalizeResult>> {
  const target = validateSessionTrack(ctx.config, params);
  if (!target.ok) return target;
  const { session_id: sessionId, track } = target.value;

  if (totalChunksRaw === undefined || totalChunksRaw === null) {
    return err(400, 'bad_request', 'total_chunks is required.');
  }
  if (typeof totalChunksRaw !== 'number' && typeof totalChunksRaw !== 'string') {
    return err(400, 'bad_request', 'total_chunks must be a non-negative integer.');
  }
  const totalChunks = Number(totalChunksRaw);
  if (!Number.isInteger(totalChunks) || totalChunks < 0) {
    return err(400, 'bad_request', 'total_chunks must be a non-negative integer.');
  }

  const rows = await ctx.db.select(AUDIO_TRACKS_STORE, { session_id: sessionId, track });
  const row = rows[0];
  if (!row) {
    return err(404, 'not_found', 'no such track (never started under this tenant).');
  }
  const watermark = Number(row.persisted_chunk_count) || 0;
  const committed = Number(row.committed_byte_len) || 0;
  const status = typeof row.status === 'string' ? row.status : 'unknown';

  // The count gate BEFORE the idempotent-terminal check (a wrong-total re-finalize still 409s).
  if (totalChunks !== watermark) {
    return err(
      409,
      'chunk_count_mismatch',
      `client asserted ${totalChunks} chunks but ${watermark} are durably persisted.`,
      { next_expected_index: watermark },
    );
  }

  // Idempotent terminal: an already-completed track (matching total) re-emits the deduped event + 200.
  if (status === 'completed') {
    await completeSessionIfAllTracksSealed(ctx, sessionId);
    const eventId = await emitFinalizedSession(ctx, sessionId, sink);
    return ok({
      session_id: sessionId,
      track,
      status: 'completed',
      total_chunks: watermark,
      committed_byte_len: committed,
      finalized_event_id: eventId,
    });
  }

  // Seal the track (inside the engine's tenant transaction).
  await ctx.db.update(
    AUDIO_TRACKS_STORE,
    { session_id: sessionId, track },
    { status: 'completed' },
  );
  await completeSessionIfAllTracksSealed(ctx, sessionId);

  // Emit the session-scoped finalized event (dual-track finalize converges on ONE via the event_id).
  const eventId = await emitFinalizedSession(ctx, sessionId, sink);

  return ok({
    session_id: sessionId,
    track,
    status: 'completed',
    total_chunks: watermark,
    committed_byte_len: committed,
    finalized_event_id: eventId,
  });
}
