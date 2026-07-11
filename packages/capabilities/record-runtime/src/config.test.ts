/**
 * Config resolution invariants — HS-2: the `record_ref`/event-id delimiter law. `recordRef` and
 * `submittedEventId` join `${tenantId}:${recordId}` on ':', so a record id that can carry ':' would
 * make two distinct (tenant, record) pairs collide on one ref/key (a narrow but real correctness
 * bug). The DEFAULT pattern excludes ':' by construction; an OVERRIDE that admits it is rejected
 * fail-closed at construction (deploy-time loud), and submit.ts carries a point-of-use belt for a
 * hand-built config that bypasses the resolver.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_RECORD_ID_RE, resolveRecordConfig } from './config.js';

describe('resolveRecordConfig — the record_ref delimiter law (HS-2)', () => {
  it("the DEFAULT record-id pattern excludes ':' (the tenant:record ref delimiter)", () => {
    for (const probe of [':', 'a:b', ':a', 'a:']) {
      expect(DEFAULT_RECORD_ID_RE.test(probe), `probe '${probe}'`).toBe(false);
    }
  });

  it("REJECTS at construction a recordIdPattern override that admits ':' — fail-closed, never a corrupt ref", () => {
    for (const pattern of [/^[a-z:]{1,64}$/, /^.{1,64}$/, /^[\x20-\x7e]{1,64}$/]) {
      expect(() => resolveRecordConfig({ recordIdPattern: pattern }), String(pattern)).toThrow(
        /':'/,
      );
    }
  });

  it('accepts a narrowing override that cannot admit the delimiter', () => {
    const resolved = resolveRecordConfig({ recordIdPattern: /^[a-z]{1,32}$/ });
    expect(resolved.recordIdPattern.test('abc')).toBe(true);
    expect(resolved.recordIdPattern.test('a:b')).toBe(false);
  });
});
