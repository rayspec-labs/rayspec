/**
 * The recall provider's PURE pieces: the tokenizer, the score arithmetic (keyword dominance over
 * recency), and the age stamp. The provider's reads — scoping, bounds, tenancy — are proven
 * against real rows in the server package's recall suite (the engine's only insert site lives
 * there; this package may not import it).
 */
import { describe, expect, it } from 'vitest';
import {
  formatRecallAge,
  RECALL_MAX_AGE_MS,
  scoreRecallCandidate,
  tokenizeRecallQuery,
} from './memory.js';

describe('tokenizeRecallQuery', () => {
  it('lowercases, splits on non-word runs, drops short tokens, dedupes, and caps at eight', () => {
    expect(tokenizeRecallQuery('Fix the Release-Notes pipeline, THE pipeline!')).toEqual([
      'fix',
      'the',
      'release',
      'notes',
      'pipeline',
    ]);
    expect(tokenizeRecallQuery('a an to of in at')).toEqual([]);
    expect(
      tokenizeRecallQuery('one two three four five six seven eight nine ten eleven'),
    ).toHaveLength(8);
  });
});

describe('scoreRecallCandidate', () => {
  it('lets ONE keyword match outweigh any recency difference', () => {
    const tokens = tokenizeRecallQuery('release notes');
    const freshMiss = scoreRecallCandidate({ tokens, haystack: 'unrelated work', ageMs: 0 });
    const staleHit = scoreRecallCandidate({
      tokens,
      haystack: 'drafted the release announcement',
      ageMs: RECALL_MAX_AGE_MS - 1,
    });
    expect(staleHit).toBeGreaterThan(freshMiss);
  });

  it('orders equal keyword matches by recency, decaying linearly to zero at the age window', () => {
    const tokens = tokenizeRecallQuery('release');
    const fresh = scoreRecallCandidate({ tokens, haystack: 'the release', ageMs: 0 });
    const mid = scoreRecallCandidate({
      tokens,
      haystack: 'the release',
      ageMs: RECALL_MAX_AGE_MS / 2,
    });
    const stale = scoreRecallCandidate({
      tokens,
      haystack: 'the release',
      ageMs: RECALL_MAX_AGE_MS,
    });
    expect(fresh).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(stale);
    expect(stale).toBe(10); // one match, zero recency — the decay floor
  });

  it('matches case-insensitively against the haystack', () => {
    const tokens = tokenizeRecallQuery('ONBOARDING');
    expect(
      scoreRecallCandidate({ tokens, haystack: 'Measured Onboarding friction', ageMs: 0 }),
    ).toBeGreaterThan(10);
  });
});

describe('formatRecallAge', () => {
  it('stamps <1h, whole hours under two days, then whole days', () => {
    expect(formatRecallAge(59 * 60_000)).toBe('<1h');
    expect(formatRecallAge(3_600_000)).toBe('1h');
    expect(formatRecallAge(47 * 3_600_000)).toBe('47h');
    expect(formatRecallAge(48 * 3_600_000)).toBe('2d');
    expect(formatRecallAge(29 * 24 * 3_600_000)).toBe('29d');
  });
});
