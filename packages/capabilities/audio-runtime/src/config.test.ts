import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_CHUNK_BYTES,
  DEFAULT_MAX_TRACK_BYTES,
  DEFAULT_TTL_POLICY,
  parseProtocolVersion,
  resolveConfig,
} from './config.js';

describe('resolveConfig — track policy', () => {
  it('the default track policy admits safe lowercase ids (mic/system) and rejects unsafe ones', () => {
    const c = resolveConfig();
    expect(c.isAllowedTrack('mic')).toBe(true);
    expect(c.isAllowedTrack('system')).toBe(true);
    expect(c.isAllowedTrack('speaker_2')).toBe(true);
    expect(c.isAllowedTrack('Mic')).toBe(false); // uppercase
    expect(c.isAllowedTrack('1track')).toBe(false); // leading digit
    expect(c.isAllowedTrack('a'.repeat(40))).toBe(false); // too long
    expect(c.isAllowedTrack('a b')).toBe(false); // space
  });

  it('an explicit allowlist narrows the accepted tracks', () => {
    const c = resolveConfig({ allowedTracks: ['mic', 'system'] });
    expect(c.isAllowedTrack('mic')).toBe(true);
    expect(c.isAllowedTrack('speaker_2')).toBe(false); // not in the allowlist
  });

  it('a predicate policy is honored', () => {
    const c = resolveConfig({ allowedTracks: (t) => t.startsWith('lane_') });
    expect(c.isAllowedTrack('lane_1')).toBe(true);
    expect(c.isAllowedTrack('mic')).toBe(false);
  });
});

describe('resolveConfig — session pattern + TTL defaults', () => {
  it('the default session pattern accepts safe ASCII ids', () => {
    const c = resolveConfig();
    expect(c.sessionIdPattern.test('session-short')).toBe(true);
    expect(c.sessionIdPattern.test('bad id!')).toBe(false);
    expect(c.sessionIdPattern.test('a'.repeat(129))).toBe(false);
  });

  it('the default TTL policy is the frozen golden values', () => {
    expect(resolveConfig().ttlPolicy).toEqual(DEFAULT_TTL_POLICY);
    expect(DEFAULT_TTL_POLICY).toEqual({
      floorSeconds: 900,
      slackSeconds: 60,
      ceilingSeconds: 86400,
    });
  });
});

describe('resolveConfig — byte caps (per-chunk + per-track)', () => {
  it('applies the frozen default byte caps when the product configures none', () => {
    const c = resolveConfig();
    expect(c.maxChunkBytes).toBe(DEFAULT_MAX_CHUNK_BYTES);
    expect(c.maxTrackBytes).toBe(DEFAULT_MAX_TRACK_BYTES);
  });

  it('honors explicit product overrides for both caps', () => {
    const c = resolveConfig({ maxChunkBytes: 1024, maxTrackBytes: 4096 });
    expect(c.maxChunkBytes).toBe(1024);
    expect(c.maxTrackBytes).toBe(4096);
  });
});

describe('parseProtocolVersion — accept-the-client', () => {
  it('parses a positive integer; falls back on absent/malformed', () => {
    expect(parseProtocolVersion('3', 2)).toBe(3);
    expect(parseProtocolVersion(undefined, 2)).toBe(2);
    expect(parseProtocolVersion('', 2)).toBe(2);
    expect(parseProtocolVersion('nope', 2)).toBe(2);
    expect(parseProtocolVersion('-1', 2)).toBe(2);
  });
});
