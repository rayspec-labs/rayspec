/**
 * The `requestId` middleware's incoming-value hygiene.
 *
 * A caller-supplied `x-request-id` is echoed back (into the error envelope) AND written to the audit
 * log, so accepting it raw is a log-injection vector: a value carrying a newline could forge or wrap a
 * log/audit line, and an unbounded value bloats every row. The middleware now echoes an incoming id
 * ONLY when it matches a short printable allow-list (`^[A-Za-z0-9._-]{1,128}$`), otherwise it mints a
 * fresh UUID.
 *
 * These drive the REAL middleware against a minimal context: the Fetch `Headers` API itself rejects a
 * header value containing a newline, so the injection case can only be exercised below the transport
 * (the full-app path in `app-error-logging.test.ts` already proves a well-formed id flows end-to-end
 * into the envelope + log line).
 */
import { describe, expect, it } from 'vitest';
import { requestId } from './middleware.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Run the middleware against a minimal context carrying `header`; return the resolved requestId. */
async function resolveRequestId(header: string | undefined): Promise<string> {
  const store = new Map<string, unknown>();
  const c = {
    req: { header: (name: string) => (name.toLowerCase() === 'x-request-id' ? header : undefined) },
    set: (k: string, v: unknown) => store.set(k, v),
    get: (k: string) => store.get(k),
  } as unknown as Parameters<typeof requestId>[0];

  let nextCalled = false;
  await requestId(c, async () => {
    nextCalled = true;
  });
  expect(nextCalled).toBe(true); // the middleware must always continue the chain
  return store.get('requestId') as string;
}

describe('requestId — echoes a well-formed incoming id', () => {
  it('accepts letters, digits, and . _ - (common UUID / trace / service-id shapes)', async () => {
    for (const id of ['rid-under-test', 'svc.req-1_2.3', '0a1b2c3d', 'A_B.C-D', 'x']) {
      expect(await resolveRequestId(id)).toBe(id);
    }
  });

  it('accepts a boundary-length (128-char) id verbatim', async () => {
    const at128 = 'a'.repeat(128);
    expect(await resolveRequestId(at128)).toBe(at128);
  });
});

describe('requestId — replaces an unsafe incoming id with a fresh UUID', () => {
  it('rejects a newline-injected value (log injection) — the forged text never becomes the id', async () => {
    const forged = 'rid-ok\nfake-audit-line event=cross_tenant_denied';
    const resolved = await resolveRequestId(forged);
    expect(resolved).not.toBe(forged);
    expect(resolved).toMatch(UUID_RE);
    expect(resolved).not.toContain('\n');
  });

  it('rejects other control characters (CR, tab, ESC)', async () => {
    for (const bad of ['a\rb', 'a\tb', 'a\x1b[31m']) {
      expect(await resolveRequestId(bad)).toMatch(UUID_RE);
    }
  });

  it('rejects an over-long value (> 128 chars)', async () => {
    expect(await resolveRequestId('a'.repeat(129))).toMatch(UUID_RE);
  });

  it('rejects disallowed printable characters (space, slash, colon, quote, non-ASCII)', async () => {
    for (const bad of ['has space', 'a/b', 'a:b', '"quote"', 'café']) {
      expect(await resolveRequestId(bad)).toMatch(UUID_RE);
    }
  });

  it('mints a UUID when the header is absent or empty', async () => {
    expect(await resolveRequestId(undefined)).toMatch(UUID_RE);
    expect(await resolveRequestId('')).toMatch(UUID_RE);
  });
});
