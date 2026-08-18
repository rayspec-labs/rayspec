/**
 * WHO MAY DECIDE — the pure predicate behind both human decision doors. The matrix that matters is
 * the one an attacker probes: the open sentinel must stay open (the single-operator posture every
 * shipped example relies on), a NAMED decider must be matched exactly, and a near-miss spelling —
 * a longer id that merely starts with the named one, a scheme that merely ends in `user:`, the
 * unresolved-principal sentinel — must never satisfy a name.
 */
import { describe, expect, it } from 'vitest';
import { ANY_AUTHENTICATED_DECIDER, mayDecide } from './decision-authority.js';

describe('mayDecide', () => {
  it("the 'user' sentinel is OPEN — any authenticated principal decides (the shipped posture)", () => {
    expect(ANY_AUTHENTICATED_DECIDER).toBe('user');
    for (const actor of [
      'user',
      // ZERO-PADDED SYNTHETIC IDS, the same shape `test-support/test-db.ts` uses for its tenants.
      // A realistic-looking random UUID here reads to a secret scanner as a credential — the
      // `api-key:` half is literally the keyword `generic-api-key` looks for, and a high-entropy
      // body next to it is the whole signature. These carry the identical actor SHAPE (the point of
      // the row is the scheme prefix the peeler strips), with none of the entropy.
      'user:00000000-0000-4000-8000-000000000001',
      'api-key:00000000-0000-4000-8000-000000000002',
      'ops_lead',
      'scheduler',
    ]) {
      expect(mayDecide(ANY_AUTHENTICATED_DECIDER, actor), actor).toBe(true);
    }
  });

  it('a NAMED decider is matched bare (an in-engine caller journals the bare employee id)', () => {
    expect(mayDecide('ops_lead', 'ops_lead')).toBe(true);
  });

  it("a NAMED decider is matched through the HTTP door's two scheme spellings", () => {
    expect(mayDecide('ops_lead', 'user:ops_lead')).toBe(true);
    expect(mayDecide('ops_lead', 'api-key:ops_lead')).toBe(true);
  });

  it('a DIFFERENT principal never satisfies a named decider', () => {
    for (const actor of [
      'someone_else',
      'user:someone_else',
      'api-key:someone_else',
      'user:00000000-0000-4000-8000-000000000001',
      'scheduler',
      'system',
    ]) {
      expect(mayDecide('ops_lead', actor), actor).toBe(false);
    }
  });

  it('a near-miss spelling is refused: prefixes, suffixes and an unknown scheme are not matches', () => {
    // The identity half must be the WHOLE remainder, not a prefix of it.
    expect(mayDecide('ops_lead', 'user:ops_leader')).toBe(false);
    expect(mayDecide('ops_lead', 'ops_leader')).toBe(false);
    expect(mayDecide('ops_leader', 'user:ops_lead')).toBe(false);
    // The scheme set is CLOSED: only the two spellings `actorFrom` mints are peeled.
    expect(mayDecide('ops_lead', 'notuser:ops_lead')).toBe(false);
    expect(mayDecide('ops_lead', 'principal:ops_lead')).toBe(false);
    // Nesting a scheme does not strip twice.
    expect(mayDecide('ops_lead', 'user:user:ops_lead')).toBe(false);
  });

  it('the unresolved-principal sentinel satisfies no named decider (defense behind requireAuth)', () => {
    expect(mayDecide('ops_lead', 'principal:unresolved')).toBe(false);
    expect(mayDecide('unresolved', 'principal:unresolved')).toBe(false);
  });

  it('an empty actor decides nothing named', () => {
    expect(mayDecide('ops_lead', '')).toBe(false);
    expect(mayDecide('ops_lead', 'user:')).toBe(false);
  });
});
