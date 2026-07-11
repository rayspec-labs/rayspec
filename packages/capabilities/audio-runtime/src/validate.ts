/**
 * Shared session/track parameter validation (one source for every capability operation). A session id
 * must match the configured shape AND must not be a path-traversal token (`.`/`..`) — defense-in-depth
 * on top of the fs blob store's own path jail, so a traversal-shaped id is a clean 400 at the capability
 * edge rather than only a fail-closed jail error deeper down. (Track ids are validated by the config's
 * track policy, whose default shape already excludes `.`/`..`.)
 */
import type { ResolvedAudioConfig } from './config.js';
import { type AudioCapabilityResult, err, ok } from './errors.js';
import type { SessionTrackParams } from './ports.js';

/** Path tokens that must never be accepted as a session id (they form a blob-key traversal segment). */
const TRAVERSAL_IDS = new Set(['.', '..']);

export interface ValidatedTarget {
  readonly session_id: string;
  readonly track: string;
}

export function validateSessionTrack(
  config: ResolvedAudioConfig,
  params: SessionTrackParams,
): AudioCapabilityResult<ValidatedTarget> {
  const sessionId = params.session_id;
  const track = params.track;
  if (!sessionId || TRAVERSAL_IDS.has(sessionId) || !config.sessionIdPattern.test(sessionId)) {
    return err(400, 'bad_request', 'session_id is missing or malformed.');
  }
  if (!track || !config.isAllowedTrack(track)) {
    return err(400, 'bad_request', 'track is missing or not an allowed track id.');
  }
  return ok({ session_id: sessionId, track });
}
