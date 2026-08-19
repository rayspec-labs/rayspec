/**
 * WHO MAY DECIDE — the pure predicate behind both human decision doors. The matrix that matters is
 * the one an attacker probes: the open sentinel must stay open (the single-operator posture every
 * shipped example relies on), a NAMED decider must be matched exactly, and a near-miss spelling —
 * a longer id that merely starts with the named one, a scheme that merely ends in `user:`, the
 * unresolved-principal sentinel — must never satisfy a name.
 */
import { randomUUID } from 'node:crypto';
import { SAFE_IDENTIFIER_RE } from '@rayspec/spec';
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

  /**
   * B-017k / D-034 — THE DISJOINTNESS IS AN EMPIRICAL CLAIM, SO IT IS PROBED, NOT REASONED ABOUT.
   *
   * `workforce_escalation_unreachable` (@rayspec/spec workforce-lint.ts) is a rule built ON a claim
   * of impossibility: an approval the timeout sweep escalates names a declared EMPLOYEE as its
   * approver, and no principal an HTTP request can authenticate as can ever equal one. That claim
   * has to be executed rather than argued — this repo has been wrong about an impossibility before,
   * and the rule's message would inherit the error.
   *
   * The two namespaces, and why they cannot meet:
   *   - the named approver is an employee id, a `SafeIdentifier` — `SAFE_IDENTIFIER_RE` below is
   *     imported from the grammar rather than restated, so a widened identifier rule reddens this;
   *   - the actor is whatever api-auth's `actorFrom` derived: `user:<uuid>`, `api-key:<uuid>`, or
   *     the closed `principal:unresolved` sentinel. `users.id` / `api_keys.id` are Postgres `uuid`
   *     columns, and a uuid always renders `8-4-4-4-12` — hyphenated, which the identifier rule
   *     forbids.
   *
   * SCOPE, stated precisely because the lint message has to say the same thing: this is a statement
   * about AUTHENTICATED HTTP PRINCIPALS. In-engine callers journal the BARE employee id (the turn
   * path passes `task.owner`) and match by design — see the bare-match case above. The other half of
   * the gap (break-glass is a human-only route) is pinned in @rayspec/auth-core authz.test.ts,
   * `an api-key can NEVER break the glass on a named approver/reviewer, however it is scoped`.
   *
   * The uuids are minted at RUNTIME, never written as literals: this file has a history with the
   * secret scan, and `api-key:` beside a high-entropy body is exactly `generic-api-key`'s signature.
   */
  it('B-017k: no authenticated HTTP principal can satisfy a NAMED employee approver — probed over real uuids', () => {
    // Every shape a declared employee id can take, including both length edges of the rule.
    const employeeIds = ['ops_lead', 'orchestrator', 'a', 'x_9', '_edge', 'z'.repeat(63)];
    for (const id of employeeIds) {
      expect(SAFE_IDENTIFIER_RE.test(id), `${id} must be a legal employee id`).toBe(true);
    }

    let probed = 0;
    for (let i = 0; i < 500; i++) {
      const uuid = randomUUID();
      // The load-bearing fact, re-derived every iteration rather than assumed once.
      expect(SAFE_IDENTIFIER_RE.test(uuid), uuid).toBe(false);
      for (const actor of [`user:${uuid}`, `api-key:${uuid}`, 'principal:unresolved']) {
        for (const named of employeeIds) {
          expect(mayDecide(named, actor), `${actor} vs ${named}`).toBe(false);
          probed++;
        }
      }
    }
    // RAN-GUARD: a filtered or short-circuited loop must not read as a proof.
    expect(probed).toBe(500 * 3 * employeeIds.length);

    // …and the reason this is a NARROWED route rather than a broken one: the `user` sentinel that
    // every shipped example declares stays open to exactly those principals.
    expect(mayDecide(ANY_AUTHENTICATED_DECIDER, `user:${randomUUID()}`)).toBe(true);
    expect(mayDecide(ANY_AUTHENTICATED_DECIDER, `api-key:${randomUUID()}`)).toBe(true);
  });
});
