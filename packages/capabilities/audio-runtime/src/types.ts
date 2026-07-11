/**
 * Product-neutral Audio/Media session model. These shapes carry ZERO product meaning:
 * no product vocabulary. A track is an ordered audio lane inside a session; a
 * session is a tenant-scoped container of tracks. The names, storage keys, and upload watermark are
 * owned by this Tier B capability; a Product YAML may name track-attribution policy but never owns a
 * blob key or a watermark.
 */

/** A session's lifecycle status. `recording` → `finalizing` → `completed` (or `failed`). */
export type AudioSessionStatus = 'recording' | 'finalizing' | 'completed' | 'failed';

/**
 * A track's upload status. `absent` is the reported status when no track row exists yet (a fresh-start
 * resume shape — never a 404), never a persisted value.
 */
export type AudioTrackStatus = 'absent' | 'recording' | 'completed' | 'failed';

/** A track id. Common values are `mic`/`system`; the capability accepts any config-valid id. */
export type AudioTrackId = string;

/** A tenant-scoped recording/session container (the `audio_input.session` contract). */
export interface AudioSession {
  /** Product-visible safe id (config-validated; the tenant is never derived from it). */
  readonly session_id: string;
  /** The upload protocol version the client declared (stored as readable DATA; no behavior branches on it). */
  readonly protocol_version: number;
  readonly status: AudioSessionStatus;
}

/** One ordered audio stream within a session (the `audio_input.track` contract). */
export interface AudioTrackState {
  readonly session_id: string;
  readonly track: AudioTrackId;
  readonly status: AudioTrackStatus;
  /** The ordered upload watermark = the next expected chunk index (0-based; the persisted chunk count). */
  readonly next_expected_index: number;
  /** Total durably-accepted byte length across accepted chunks. */
  readonly committed_byte_len: number;
}

/** The resume watermark shape returned by upload-status (the `audio_input.upload_status` contract). */
export interface UploadStatus {
  readonly session_id: string;
  readonly track: AudioTrackId;
  readonly next_expected_index: number;
  readonly committed_byte_len: number;
  readonly status: AudioTrackStatus;
}

/** The result of a chunk ingest — the ack telling the client the next index to send. */
export interface ChunkAck {
  readonly next_expected_index: number;
}

/** The result of sealing a track (the `audio_input.finalize_track` contract, terminal + idempotent). */
export interface FinalizeResult {
  readonly session_id: string;
  readonly track: AudioTrackId;
  readonly status: 'completed';
  readonly total_chunks: number;
  readonly committed_byte_len: number;
  /**
   * The idempotency key of the `session_finalized` event this seal emitted downstream (session-scoped,
   * so a dual-track finalize converges on ONE event / one workflow).
   */
  readonly finalized_event_id: string;
}

/** One finalized track summary carried by the `session_finalized` event. */
export interface FinalizedTrackSummary {
  readonly track: AudioTrackId;
  readonly committed_byte_len: number;
}

/**
 * The `audio_input.finalized_session` event — the workflow trigger shape. It does NOT
 * call STT, persist artifacts, or run agents; those are later Tier A workflow nodes. The `event_id` is
 * the SESSION-scoped idempotency key so a dual-track finalize (both tracks) converges on ONE workflow.
 * The `tracks` list is the set finalized at emission time; a consuming Tier A workflow re-reads the
 * authoritative track state for the session (the event is the trigger, not the full inventory).
 */
export interface FinalizedSessionEvent {
  /** Idempotency key for workflow consumption (= `${tenant_id}:${session_id}`). */
  readonly event_id: string;
  /** Server-derived tenant boundary (never client-supplied). */
  readonly tenant_id: string;
  readonly session_id: string;
  readonly tracks: readonly FinalizedTrackSummary[];
  /** Server timestamp (ISO-8601). */
  readonly occurred_at: string;
  /** The emitting capability id — always `audio_input`. */
  readonly source_capability: 'audio_input';
}

/** The short-lived playback token result (the `media_playback.token` contract). */
export interface PlaybackTokenResult {
  /** A relative playback URL with the media token already appended as `?token=`. */
  readonly url: string;
  /** Absolute expiry (ISO-8601), derived from the TTL. */
  readonly expires_at: string;
  readonly ttl_seconds: number;
}

/** A typed error body a capability route returns (mapped to the proper HTTP status by the binding). */
export interface AudioErrorBody {
  readonly error: string;
  readonly detail: string;
  /** Present on a `gap` / `chunk_count_mismatch` — the resume watermark. */
  readonly next_expected_index?: number;
}
