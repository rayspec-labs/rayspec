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
 * Read (or lazily CREATE) the per-(session, track) watermark row within THIS tenant. On a brand-new
 * (session, track) the parent session row is upserted first (so the track FK resolves), then the track
 * row is inserted at watermark 0. EACH contending INSERT runs inside a NESTED `db.transaction()`
 * SAVEPOINT so a concurrent first-chunk race that collides on the tenant-namespaced UNIQUE rolls back
 * ONLY that savepoint (not the outer route tx): the session-row collision is re-read HERE; the
 * track-row collision (23505) is thrown OUT for the caller to catch + re-read — never a 500 on a
 * poisoned outer tx.
 */
async function ensureTrackRow(
  db: HandlerDb,
  tenantId: string,
  sessionId: string,
  track: string,
  protocolVersion: number,
): Promise<StoreRow> {
  const existing = await db.select(AUDIO_TRACKS_STORE, { session_id: sessionId, track });
  if (existing[0]) return existing[0];

  const sessions = await db.select(AUDIO_SESSIONS_STORE, { session_id: sessionId });
  let sessionRow = sessions[0];
  if (!sessionRow) {
    // The session INSERT runs inside a NESTED savepoint — a concurrent first-chunk for the SAME session
    // (different track / same track) collides on `session_ref`; the savepoint scopes that 23505 so the
    // loser re-reads the winner's now-visible row on the still-clean outer tx.
    try {
      await db.transaction(async (tx) => {
        sessionRow = await tx.insert(AUDIO_SESSIONS_STORE, {
          session_id: sessionId,
          session_ref: sessionRef(tenantId, sessionId),
          status: 'recording',
          protocol_version: protocolVersion,
        });
      });
    } catch (errValue) {
      if (!isUniqueViolation(errValue)) throw errValue;
      const reread = await db.select(AUDIO_SESSIONS_STORE, { session_id: sessionId });
      if (!reread[0]) throw errValue;
      sessionRow = reread[0];
    }
  }
  if (!sessionRow) {
    throw new Error('audio-runtime ingest: session row unresolved after upsert (fail-closed).');
  }
  const sessionPk = sessionRow.id;
  if (typeof sessionPk !== 'string') {
    throw new Error('audio-runtime ingest: session row missing its uuid id (fail-closed).');
  }

  // The track INSERT likewise runs inside a NESTED savepoint — the concurrent first-chunk race for the
  // SAME (session, track) collides on `track_ref`; the caller catches the surfaced 23505 + re-reads.
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
  return trackRow;
}

/**
 * Ingest one ordered chunk's bytes for (session, track). Returns a typed result the binding maps to a
 * raw Response: 200 ack (advance), 200 no-op (duplicate / sealed), or 409 gap. `contentType` is the
 * request's content type (advisory metadata on the stored blob). `chunkIndexRaw` is the server-parsed
 * path param (validated to a non-negative integer here).
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

  // Resolve the current watermark (create the row lazily; a concurrent first-chunk race is re-read).
  let trackRow: StoreRow;
  try {
    trackRow = await ensureTrackRow(ctx.db, ctx.tenantId, sessionId, track, protocolVersion);
  } catch (errValue) {
    if (isUniqueViolation(errValue)) {
      const reread = await ctx.db.select(AUDIO_TRACKS_STORE, { session_id: sessionId, track });
      if (!reread[0]) throw errValue;
      trackRow = reread[0];
    } else {
      throw errValue;
    }
  }

  // A SEALED (finalized) track no-ops a late chunk retry (the upload is done — not an error).
  if (trackRow.status === 'completed') {
    const sealedWatermark = Number(trackRow.persisted_chunk_count) || 0;
    return ok({ next_expected_index: sealedWatermark });
  }

  const watermark = Number(trackRow.persisted_chunk_count);
  const nextExpected = Number.isInteger(watermark) && watermark >= 0 ? watermark : 0;

  // index < next_expected → idempotent re-POST (no-op 200, do NOT re-advance).
  if (chunkIndex < nextExpected) {
    return ok({ next_expected_index: nextExpected });
  }
  // index > next_expected → a GAP (missing earlier chunk). 409, telling the client what to send next.
  if (chunkIndex > nextExpected) {
    return err(409, 'gap', 'a gap in the chunk sequence.', { next_expected_index: nextExpected });
  }

  // index == next_expected → store the chunk. Put-by-index FIRST (idempotent — a crash before the
  // watermark advance is safe: a retry re-puts the same key), then advance the watermark transactionally
  // with a re-read guard against a concurrent same-index race.
  const key = chunkKey(sessionId, track, chunkIndex);
  await ctx.blob.put(key, bytes, contentType ? { contentType } : undefined);

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
      // sealed watermark), matching the donor's sealed-track semantics.
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
      // A concurrent POST already advanced past us — idempotent no-op (same key the winner wrote).
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
 * durable agent run — that is Tier A's job). Idempotent: re-finalizing a completed track with the same
 * total re-emits the (deduped) event and returns 200.
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
