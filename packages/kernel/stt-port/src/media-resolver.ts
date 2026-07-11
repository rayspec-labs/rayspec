import type { SttFinalizedTrackRef } from './types.js';

/**
 * Provider-neutral media-resolution seam. The neutral `SttAdapter` request carries a
 * `media_artifact_ref` (an opaque tenant-bound reference), never raw bytes — a real provider adapter
 * needs the finalized/remuxed audio bytes to transcribe. Resolving `ref -> bytes` is a deployment
 * concern that belongs to the audio/media Tier B capability, NOT to the STT adapter. The adapter is
 * therefore constructed with a resolver, keeping it decoupled from blob storage while remaining
 * live-capable. This module makes NO network call and reads NO credentials.
 */

/** Resolved audio bytes for one finalized track, plus an optional content type for the upload. */
export interface SttMediaSource {
  readonly bytes: Uint8Array;
  /** Upload content type (e.g. `audio/ogg`, `audio/wav`). Advisory — providers sniff the container. */
  readonly contentType?: string;
}

/** Resolves a finalized track reference to its audio bytes. Implemented by the deployment. */
export interface SttMediaResolver {
  resolve(ref: SttFinalizedTrackRef): Promise<SttMediaSource>;
}

/** A resolver could not produce bytes for the requested track (unknown/unfinalized media). */
export class SttMediaResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SttMediaResolutionError';
  }
}

function mediaKey(ref: Pick<SttFinalizedTrackRef, 'session_id' | 'track'>): string {
  return `${ref.session_id}/${ref.track}`;
}

/**
 * Deterministic in-memory resolver for tests and offline harnesses. Maps `${session_id}/${track}`
 * to fixed bytes; throws `SttMediaResolutionError` for an unset track (fail-closed, never a network
 * fallback). This is NOT a production resolver — a deployment binds the real tenant-scoped blob store.
 */
export class StaticSttMediaResolver implements SttMediaResolver {
  private readonly sources = new Map<string, SttMediaSource>();

  set(sessionId: string, track: string, source: SttMediaSource): this {
    this.sources.set(mediaKey({ session_id: sessionId, track }), source);
    return this;
  }

  async resolve(ref: SttFinalizedTrackRef): Promise<SttMediaSource> {
    const source = this.sources.get(mediaKey(ref));
    if (!source) {
      throw new SttMediaResolutionError(
        `No media bytes registered for ${mediaKey(ref)} (fail-closed).`,
      );
    }
    return source;
  }
}
