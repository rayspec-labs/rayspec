/**
 * 5xx server-side logging (the `onError` chokepoint) — NO DB required.
 *
 * The 500 branch of `app.onError` used to be a SILENT swallow: a bare `{"code":"INTERNAL"}` with no
 * server-side log line. This asserts the fix's REAL invariant (fail-the-fix, not pass-the-shape):
 *
 *  - EVERY 5xx (unrecognized-error 500, plus any `ApiError` whose status ≥ 500 — UPSTREAM_ERROR 502,
 *    NOT_IMPLEMENTED 501) emits EXACTLY ONE server-side log line carrying the requestId + the code;
 *  - a DIRECTLY-RETURNED 5xx (the live sync-run 502/504 shape, `return c.json(..., 5xx)`, which never
 *    reaches `onError`) ALSO emits EXACTLY ONE line — the log lives in the OUTERMOST middleware (which
 *    sees the FINAL status), NOT in `onError`, so thrown and returned both log once and neither doubles;
 *  - a 4xx (the new CONFLICT 409 + a 401/404) emits NO 5xx log line;
 *  - the log line NEVER leaks the caller's bearer credential (server-side, status + requestId + code).
 *
 * Thrown errors are injected at the `authenticate` seam (`apiKeyStore.resolve` throws a sentinel per
 * bearer); returned 5xx are driven through probe routes that `return c.json(..., 5xx)` (registered on
 * the SAME app so the outermost 5xx-logging middleware wraps them) — no DB in either case.
 */
import { ApiError } from '@rayspec/auth-core';
import { StoreInputError } from '@rayspec/platform';
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

// Probe routes that DIRECTLY RETURN a 5xx (never throw) — the `runs.ts` sync-run 502/504 shape that
// bypasses `onError`. Registered on the SAME app AFTER the `app.use('*')` 5xx-logging middleware, so
// that middleware wraps them (it matches every path). No auth requirement → they run with no bearer.
app.get('/probe-returned-502', (c) => c.json({ error: { code: 'UPSTREAM_ERROR' } }, 502));
app.get('/probe-returned-504', (c) => c.json({ error: { code: 'GATEWAY_TIMEOUT' } }, 504));
app.get('/probe-returned-200', (c) => c.json({ ok: true }, 200));

// Probe routes that THROW: a store-facade input error (→ 400) vs a plain error (→ 500). Both carry the
// same internal-leak token in their detailed message; only the StoreInputError's GENERIC public message
// may reach the client.
const LEAK_TOKEN = 'secret_internal_column_detail';
app.get('/probe-throw-store-input', () => {
  throw new StoreInputError(
    `HandlerDb: insert names column '${LEAK_TOKEN}', which is not a declared column.`,
    'The request references a column that does not exist on the target store.',
  );
});
app.get('/probe-throw-plain', () => {
  throw new Error(`raw internal failure (${LEAK_TOKEN})`);
});

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

describe('a DIRECTLY-RETURNED 5xx (bypasses onError) still logs EXACTLY ONCE', () => {
  // Fail-the-fix: without the outermost response-level middleware — with the log left in onError only
  // (the pre-fix shape) — a RETURNED 502/504 never reaches onError, so `logError` would fire ZERO
  // times and each `toHaveBeenCalledTimes(1)` below would go RED. It is ALSO the no-double-log guard:
  // the thrown-500 cases above assert exactly ONE call, which fails if both middleware AND onError log.
  it('a returned 502 (the sync-run upstream_5xx shape) logs exactly one server-side line', async () => {
    const res = await app.request('/probe-returned-502', {
      method: 'GET',
      headers: { 'x-request-id': 'rid-ret502' },
    });
    expect(res.status).toBe(502);
    expect(logError).toHaveBeenCalledTimes(1);
    const [line] = logError.mock.calls[0]!;
    expect(line).toContain('rid-ret502'); // the requestId rides the line …
    expect(line).toContain('status=502'); // … and so does the returned status.
  });

  it('a returned 504 (the sync-run timeout shape) logs exactly one server-side line', async () => {
    const res = await app.request('/probe-returned-504', {
      method: 'GET',
      headers: { 'x-request-id': 'rid-ret504' },
    });
    expect(res.status).toBe(504);
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError.mock.calls[0]![0]).toContain('status=504');
    expect(logError.mock.calls[0]![0]).toContain('rid-ret504');
  });

  it('a returned 200 logs NOTHING (only a 5xx status triggers the line)', async () => {
    const res = await app.request('/probe-returned-200', { method: 'GET' });
    expect(res.status).toBe(200);
    expect(logError).not.toHaveBeenCalled();
  });
});

describe('onError — a store-facade input error is a 400 (not a 500) and leaks no internals', () => {
  it('a StoreInputError → 400 VALIDATION_ERROR carrying ONLY the generic public message', async () => {
    const res = await app.request('/probe-throw-store-input', {
      method: 'GET',
      headers: { 'x-request-id': 'rid-store-input' },
    });
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    // Fail-the-fix: WITHOUT the onError StoreInputError branch this error falls through to the 500
    // INTERNAL arm → status 500 / code INTERNAL, and these three assertions go RED.
    expect(res.status).toBe(400);
    expect(body.error?.code).toBe('VALIDATION_ERROR');
    expect(body.error?.message).toBe(
      'The request references a column that does not exist on the target store.',
    );
    // NO-LEAK: the detailed internal text (the facade prefix + the column name) never reaches the client.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain(LEAK_TOKEN);
    expect(raw).not.toContain('HandlerDb');
    // A 400 is not a 5xx → NO server-side error log line.
    expect(logError).not.toHaveBeenCalled();
  });

  it('a plain Error still → 500 INTERNAL (only a StoreInputError earns the 400), no leak', async () => {
    const res = await app.request('/probe-throw-plain', {
      method: 'GET',
      headers: { 'x-request-id': 'rid-plain-throw' },
    });
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(res.status).toBe(500);
    expect(body.error?.code).toBe('INTERNAL');
    expect(body.error?.message).toBe('Internal server error.');
    // The 500 envelope is the bare closed message — the internal detail never crosses to the client.
    expect(JSON.stringify(body)).not.toContain(LEAK_TOKEN);
  });
});
