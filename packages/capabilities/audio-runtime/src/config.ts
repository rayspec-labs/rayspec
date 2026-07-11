/**
 * Capability configuration + validation policy. Everything a product might want to constrain (the
 * accepted session-id shape, the accepted track ids, the playback token TTL policy) is CONFIG here so
 * the capability itself stays product-neutral. The defaults are session id
 * `/^[A-Za-z0-9_.-]{1,128}$/` and TTL `max(900, ceil(duration)+60)` clamped to 24h. A product narrows
 * `allowedTracks` to its lanes; nothing here names a product.
 */

/** The default session-id shape (safe ASCII, up to 128 chars). */
export const DEFAULT_SESSION_ID_RE = /^[A-Za-z0-9_.-]{1,128}$/;

/**
 * The default track-id shape: a lowercase safe identifier (letters/digits/underscore, 1..32 chars). This
 * is product-neutral — it admits `mic`/`system` (the default lanes) AND any future catalog-defined lane,
 * without the capability hardcoding a fixed two-lane assumption. A product may pass an explicit allowlist.
 */
export const DEFAULT_TRACK_ID_RE = /^[a-z][a-z0-9_]{0,31}$/;

/** The default playback-token TTL policy (the frozen golden values). */
export const DEFAULT_TTL_POLICY = {
  /** Floor: enough for a short/silent recording's whole playback. */
  floorSeconds: 900,
  /** Slack added on top of the media duration (seek/buffering headroom). */
  slackSeconds: 60,
  /** Ceiling — a leaked media URL's blast radius is bounded (mirrors MEDIA_TOKEN_MAX_TTL_SECONDS). */
  ceilingSeconds: 24 * 60 * 60,
} as const;

/** The default content type served for a playable media artifact when none was recorded on it. */
export const DEFAULT_MEDIA_CONTENT_TYPE = 'application/octet-stream';

/** The default upload protocol version stored on a session when the client sends none. */
export const DEFAULT_PROTOCOL_VERSION = 2;

/** A track-id policy: either an explicit allowlist (Set/array) or a validator predicate. */
export type TrackPolicy = readonly string[] | ((track: string) => boolean);

export interface AudioCapabilityConfig {
  /** Override the accepted session-id shape (default `DEFAULT_SESSION_ID_RE`). */
  readonly sessionIdPattern?: RegExp;
  /** Override the accepted track ids (default: `DEFAULT_TRACK_ID_RE`). */
  readonly allowedTracks?: TrackPolicy;
  /** Override the playback-token TTL policy (default: `DEFAULT_TTL_POLICY`). */
  readonly ttlPolicy?: { floorSeconds: number; slackSeconds: number; ceilingSeconds: number };
  /** The default protocol version stamped on a new session when the client sends none. */
  readonly defaultProtocolVersion?: number;
  /** The content type served when a playable artifact recorded none (default octet-stream). */
  readonly defaultMediaContentType?: string;
}

/** The fully-resolved config (all defaults applied) the core logic reads. */
export interface ResolvedAudioConfig {
  readonly sessionIdPattern: RegExp;
  readonly isAllowedTrack: (track: string) => boolean;
  readonly ttlPolicy: { floorSeconds: number; slackSeconds: number; ceilingSeconds: number };
  readonly defaultProtocolVersion: number;
  readonly defaultMediaContentType: string;
}

function toTrackPredicate(policy: TrackPolicy | undefined): (track: string) => boolean {
  if (policy === undefined) return (track) => DEFAULT_TRACK_ID_RE.test(track);
  if (typeof policy === 'function') return policy;
  const allow = new Set(policy);
  return (track) => allow.has(track);
}

export function resolveConfig(config: AudioCapabilityConfig = {}): ResolvedAudioConfig {
  return {
    sessionIdPattern: config.sessionIdPattern ?? DEFAULT_SESSION_ID_RE,
    isAllowedTrack: toTrackPredicate(config.allowedTracks),
    ttlPolicy: config.ttlPolicy ?? DEFAULT_TTL_POLICY,
    defaultProtocolVersion: config.defaultProtocolVersion ?? DEFAULT_PROTOCOL_VERSION,
    defaultMediaContentType: config.defaultMediaContentType ?? DEFAULT_MEDIA_CONTENT_TYPE,
  };
}

/** Parse a client-supplied `protocol_version` (accept-the-client — a malformed/absent value → default). */
export function parseProtocolVersion(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
