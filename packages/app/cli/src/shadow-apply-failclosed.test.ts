/**
 * The connect/admin boundary is STRUCTURALLY fail-closed by region (RED-first proof).
 *
 * The sanitizer must NOT rely on an enumerated error-code allowlist to decide whether a failure is
 * connect-class: a connection failure whose code is OUTSIDE the old set (EHOSTUNREACH, ENETUNREACH,
 * TLS codes, …) — and whose message embeds a BARE `host:port` with no `@` authority, or NO host:port at
 * all — must still collapse to the fixed generic message, never echoing host/port/credentials. This
 * test mocks `postgres` so the ADMIN connect region throws such an error, and asserts the returned
 * `error === GENERIC_CONNECT_ERROR` with no host/port substring. It goes RED if the region split is
 * reverted to a code-allowlist-only model (the EHOSTUNREACH code is not in CONNECT_AUTH_CODES, and the
 * no-host:port arm is not rescued by the regex backstop either — only the structural phase split catches
 * it).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock the postgres default export: the ADMIN connection's `.unsafe('CREATE DATABASE …')` throws the
// injected connect-region error (controllable per test). `.end()` is a no-op. The admin connect region
// is the FIRST thing shadowApply touches, so this drives its outer catch (phase:'connect').
const adminError = { value: undefined as unknown };
vi.mock('postgres', () => {
  return {
    default: () => ({
      unsafe: () => {
        throw adminError.value;
      },
      end: async () => {},
    }),
  };
});

const { shadowApply } = await import('./shadow-apply.js');

const GENERIC = 'could not connect to / authenticate against the shadow database';

afterEach(() => {
  adminError.value = undefined;
});

describe('connect region is fail-closed regardless of error code', () => {
  it('an out-of-set code with a BARE host:port message → generic, no host/port leak', async () => {
    // EHOSTUNREACH is NOT in CONNECT_AUTH_CODES; the message embeds a bare `10.0.0.5:5432` (no `@`).
    // Under the old code-allowlist-only model this verbatim message would leak the host:port.
    const e = Object.assign(new Error('connect EHOSTUNREACH 10.0.0.5:5432'), {
      code: 'EHOSTUNREACH',
    });
    adminError.value = e;
    const r = await shadowApply(
      'postgres://u:secretpass@db.internal:5432/rayspec_shadow',
      'CREATE TABLE "x" ( "id" uuid PRIMARY KEY );',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe(GENERIC);
      expect(r.error).not.toContain('10.0.0.5');
      expect(r.error).not.toContain('5432');
      expect(r.error).not.toContain('db.internal');
      expect(r.error).not.toContain('secretpass');
    }
  });

  it('an out-of-set code with NO host:port in the message → generic (PURELY structural — no regex rescue)', async () => {
    // No host:port substring at all → the broadened regex backstop CANNOT catch this; only the
    // structural connect-region split returns generic. This is the load-bearing fail-the-fix arm:
    // revert the phase split to the code-allowlist model and this goes RED (the verbatim message leaks).
    const e = Object.assign(new Error('write CONNECTION terminated unexpectedly'), {
      code: 'ENETUNREACH',
    });
    adminError.value = e;
    const r = await shadowApply(
      'postgres://u:secretpass@db.internal:5432/rayspec_shadow',
      'CREATE TABLE "x" ( "id" uuid PRIMARY KEY );',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe(GENERIC);
      // The verbatim message would have been surfaced under the code-allowlist model — assert it is NOT.
      expect(r.error).not.toContain('terminated unexpectedly');
    }
  });
});
