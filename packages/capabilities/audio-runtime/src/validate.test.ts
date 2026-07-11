import { describe, expect, it } from 'vitest';
import { resolveConfig } from './config.js';
import { validateSessionTrack } from './validate.js';

const config = resolveConfig({ allowedTracks: ['mic', 'system'] });

describe('validateSessionTrack', () => {
  it('accepts a valid (session, track)', () => {
    const r = validateSessionTrack(config, { session_id: 'session-short', track: 'mic' });
    expect(r).toEqual({ ok: true, value: { session_id: 'session-short', track: 'mic' } });
  });

  it('rejects a path-traversal session id (`.`/`..`) with a 400 (defense-in-depth over the blob jail)', () => {
    for (const bad of ['.', '..']) {
      const r = validateSessionTrack(config, { session_id: bad, track: 'mic' });
      expect(!r.ok && r.status).toBe(400);
    }
  });

  it('rejects a malformed session id + a disallowed track', () => {
    expect(!validateSessionTrack(config, { session_id: 'has space', track: 'mic' }).ok).toBe(true);
    expect(!validateSessionTrack(config, { session_id: 's1', track: 'nope' }).ok).toBe(true);
    expect(!validateSessionTrack(config, { track: 'mic' }).ok).toBe(true);
    expect(!validateSessionTrack(config, { session_id: 's1' }).ok).toBe(true);
  });
});
