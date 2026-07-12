/**
 * 5xx server-side logging (the `onError` chokepoint) — NO DB required.
 *
 * The 500 branch of `app.onError` used to be a SILENT swallow: a bare `{"code":"INTERNAL"}` with no
 * server-side log line. This asserts the fix's REAL invariant (fail-the-fix, not pass-the-shape):
 *
 *  - EVERY 5xx (unrecognized-error 500, plus any `ApiError` whose status ≥ 500 — UPSTREAM_ERROR 502,
 *    NOT_IMPLEMENTED 501) emits EXACTLY ONE server-side log line carrying the requestId + the code;
 *  - a 4xx (the new CONFLICT 409 + a 401/404) emits NO 5xx log line;
 *  - the log line NEVER leaks the caller's bearer credential (server-side, code + requestId + message).
 *
 * The errors are injected at the `authenticate` seam (`apiKeyStore.resolve` throws a sentinel per
 * bearer), so every branch of `onError` is reached deterministically with no DB — the SAME `onError`
 * the store-route 409 and any real 500 flow through.
 */
import { ApiError } from '@rayspec/auth-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuthApp } from './app.js';
import type { AppDeps } from './app-context.js';

// assertBootSecrets only checks PRESENCE (it does not validate the key material). Set placeholders
// ONLY when unset, so a real PEM another suite installed in this worker is never clobbered.
process.env.RAYSPEC_JWT_SIGNING_KEY ||= 'boot-secret-presence-only-not-a-real-key';
process.env.RAYSPEC_API_KEY_PEPPER ||= 'boot-pepper-presence-only';

/** Sentinel bearers → the error each makes `authenticate`'s `apiKeyStore.resolve` throw. */
const BEARER_RAW_500 = 'mk_raw500.x'; // raw Error → unrecognized → INTERNAL 500 (logs)
const BEARER_UPSTREAM_502 = 'mk_upstream502.x'; // ApiError UPSTREAM_ERROR (502, logs)
const BEARER_NOTIMPL_501 = 'mk_notimpl501.x'; // ApiError NOT_IMPLEMENTED (501, logs)
const BEARER_CONFLICT_409 = 'mk_conflict409.x'; // ApiError CONFLICT (409, does NOT log)

const logError = vi.fn<(line: string, detail?: unknown) => void>();

function buildApp(): ReturnType<typeof createAuthApp> {
  const apiKeyStore = {
    resolve: async (bearer: string) => {
      if (bearer === BEARER_RAW_500) throw new Error('injected raw failure (simulated 500)');
      if (bearer === BEARER_UPSTREAM_502) throw new ApiError('UPSTREAM_ERROR', 'upstream boom');
      if (bearer === BEARER_NOTIMPL_501) throw new ApiError('NOT_IMPLEMENTED', 'not implemented');
      if (bearer === BEARER_CONFLICT_409) {
        throw new ApiError('CONFLICT', "A record with this 'sku' already exists.");
      }
      return undefined; // no principal → the route decides (a protected route 401s; unknown 404s)
    },
  };
  // Minimal deps: only `apiKeyStore` (the injection seam), `allowedOrigins` (empty ⇒ no CORS),
  // `bodyRefreshEnabled`, and the `logError` spy are exercised — every request throws inside
  // `authenticate` before any route handler dereferences a store. Route REGISTRATION only builds
  // closures, so the stubbed stores are never called.
  const deps = {
    apiKeyStore,
    allowedOrigins: [],
    bodyRefreshEnabled: false,
    logError,
  } as unknown as AppDeps;
  return createAuthApp(deps);
}

const app = buildApp();

/** Drive a request with the sentinel bearer + a known request id; returns the parsed envelope. */
async function drive(
  bearer: string | undefined,
  requestId = 'rid-under-test',
): Promise<{ status: number; body: { error?: { code?: string; requestId?: string } } }> {
  const headers: Record<string, string> = { 'x-request-id': requestId };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await app.request('/probe-any-path', { method: 'GET', headers });
  return { status: res.status, body: (await res.json()) as { error?: { code?: string } } };
}

beforeEach(() => {
  logError.mockClear();
});

describe('onError — every 5xx emits ONE server-side log line (requestId + code)', () => {
  it('an unrecognized error (500 INTERNAL) logs exactly once, carrying the requestId + code', async () => {
    const { status, body } = await drive(BEARER_RAW_500, 'rid-500');
    expect(status).toBe(500);
    expect(body.error?.code).toBe('INTERNAL');
    expect(body.error?.requestId).toBe('rid-500');

    expect(logError).toHaveBeenCalledTimes(1);
    const [line] = logError.mock.calls[0]!;
    expect(line).toContain('rid-500'); // the requestId is in the log line …
    expect(line).toContain('code=INTERNAL'); // … and so is the closed error code.
    // The response requestId and the LOGGED requestId are the SAME (correlation, not divergence).
    expect(line).toContain(body.error?.requestId ?? 'MISSING');
  });

  it('an ApiError whose status ≥ 500 (UPSTREAM_ERROR 502) logs exactly once', async () => {
    const { status, body } = await drive(BEARER_UPSTREAM_502, 'rid-502');
    expect(status).toBe(502);
    expect(body.error?.code).toBe('UPSTREAM_ERROR');
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError.mock.calls[0]![0]).toContain('code=UPSTREAM_ERROR');
    expect(logError.mock.calls[0]![0]).toContain('rid-502');
  });

  it('a NOT_IMPLEMENTED (501) ApiError logs exactly once (501 is a 5xx)', async () => {
    const { status, body } = await drive(BEARER_NOTIMPL_501, 'rid-501');
    expect(status).toBe(501);
    expect(body.error?.code).toBe('NOT_IMPLEMENTED');
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError.mock.calls[0]![0]).toContain('code=NOT_IMPLEMENTED');
  });

  it('the 5xx log line NEVER contains the caller bearer credential (server-side, no secret leak)', async () => {
    await drive(BEARER_RAW_500, 'rid-nosecret');
    const [line, detail] = logError.mock.calls[0]!;
    expect(line).not.toContain('mk_raw500'); // the credential must not ride the log line …
    expect(String(detail ?? '')).not.toContain('mk_raw500'); // … nor the stack detail.
  });
});

describe('onError — a 4xx emits NO 5xx log line', () => {
  it('a CONFLICT (409) does NOT log — the new store-conflict path is not a 5xx', async () => {
    const { status, body } = await drive(BEARER_CONFLICT_409, 'rid-409');
    expect(status).toBe(409);
    expect(body.error?.code).toBe('CONFLICT');
    expect(logError).not.toHaveBeenCalled();
  });

  it('an unauthenticated request that 404s (no route) does NOT log a 5xx line', async () => {
    // No bearer → no principal → no route matches `/probe-any-path` → uniform 404 (a 4xx).
    const { status } = await drive(undefined, 'rid-404');
    expect(status).toBe(404);
    expect(logError).not.toHaveBeenCalled();
  });
});
