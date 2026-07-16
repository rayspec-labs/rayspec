/**
 * Unit tests for the api-auth bounded-body helpers — the mapping of the shared reader's outcome to a
 * 413 `ApiError` and the preserved JSON-parse fallback semantics. Driven with a minimal fake Hono
 * context (no app / DB), so the byte-bound contract is pinned fast and framework-free.
 */
import { ApiError } from '@rayspec/auth-core';
import type { Context } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../app-context.js';
import { readBoundedJson, readBoundedRequestBytes } from './bounded-body.js';

/** A minimal fake context exposing only what the helpers read: `req.header` + `req.raw`. */
function fakeCtx(body: BodyInit | null): Context<AppEnv> {
  const raw = new Request(
    'http://api.local/x',
    body === null ? { method: 'POST' } : { method: 'POST', body },
  );
  return {
    req: {
      header: (name: string) => raw.headers.get(name) ?? undefined,
      raw,
    },
  } as unknown as Context<AppEnv>;
}

describe('readBoundedRequestBytes', () => {
  it('returns the raw bytes for an in-cap body', async () => {
    const bytes = await readBoundedRequestBytes(fakeCtx('hello'), 1024);
    expect(new TextDecoder().decode(bytes)).toBe('hello');
  });

  it('throws a 413 PAYLOAD_TOO_LARGE for an over-cap body', async () => {
    const err = await readBoundedRequestBytes(fakeCtx('x'.repeat(50)), 10).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('readBoundedJson — bounded read + fallback semantics', () => {
  it('parses an in-cap JSON body', async () => {
    const value = await readBoundedJson(fakeCtx(JSON.stringify({ a: 1 })), 1024, {});
    expect(value).toEqual({ a: 1 });
  });

  it('returns the fallback for an EMPTY body', async () => {
    expect(await readBoundedJson(fakeCtx(null), 1024, {})).toEqual({});
    expect(await readBoundedJson(fakeCtx(null), 1024, undefined)).toBeUndefined();
  });

  it('returns the fallback for an UNPARSEABLE body (never throws on bad JSON)', async () => {
    expect(await readBoundedJson(fakeCtx('not-json{'), 1024, {})).toEqual({});
  });

  it('an over-cap body throws the 413 — it is NEVER swallowed into the fallback', async () => {
    const err = await readBoundedJson(fakeCtx('y'.repeat(50)), 10, {}).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('falls back to the 1 MiB default cap when maxBytes is undefined', async () => {
    // An 11-byte body is well under 1 MiB → parsed, not rejected.
    const value = await readBoundedJson(fakeCtx(JSON.stringify({ ok: true })), undefined, {});
    expect(value).toEqual({ ok: true });
  });
});
