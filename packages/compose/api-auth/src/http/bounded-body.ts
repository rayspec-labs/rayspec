/**
 * The api-auth adapter over the shared `@rayspec/core` bounded body reader — maps the reader's typed
 * outcome to an `ApiError` and preserves each route's existing JSON-parse fallback semantics.
 *
 * The declared `{handler}` + store CRUD routes, the auth register/login routes, and the reprocess
 * route previously read the whole request body via `c.req.json()` with NO byte cap — an authenticated
 * caller could stream an unbounded body straight into memory. These helpers replace that read with a
 * DRAIN-BOUNDED one: a body over the cap is a 413 `PAYLOAD_TOO_LARGE` BEFORE any parse or side effect.
 *
 * Lenient on an absent/chunked Content-Length (the drain-time bound already caps memory), so an empty
 * or streaming body is unaffected — only the byte total is bounded.
 */
import { ApiError } from '@rayspec/auth-core';
import { readBoundedBody } from '@rayspec/core';
import type { Context } from 'hono';
import type { AppEnv } from '../app-context.js';

/** The default per-request JSON/body byte cap (1 MiB) — generous for a JSON API body. */
export const DEFAULT_MAX_JSON_BODY_BYTES = 1024 * 1024;

/**
 * Drain the raw request body under `maxBytes` (default `DEFAULT_MAX_JSON_BODY_BYTES`), returning the
 * bytes. A body over the cap throws `ApiError('PAYLOAD_TOO_LARGE')` (413) BEFORE any parse/side effect.
 */
export async function readBoundedRequestBytes(
  c: Context<AppEnv>,
  maxBytes: number | undefined = DEFAULT_MAX_JSON_BODY_BYTES,
): Promise<Uint8Array> {
  const outcome = await readBoundedBody(
    { contentLength: c.req.header('content-length'), body: c.req.raw.body },
    { maxBytes: maxBytes ?? DEFAULT_MAX_JSON_BODY_BYTES },
  );
  if (!outcome.ok) {
    throw new ApiError('PAYLOAD_TOO_LARGE', 'Request body is too large.');
  }
  return outcome.bytes;
}

/**
 * Read a bounded JSON body, returning the parsed value — or `fallback` on an empty OR unparseable body
 * (the `c.req.json().catch(() => fallback)` semantics the CRUD / `{handler}` interpreters rely on). An
 * over-cap body still throws the 413 (it is NEVER silently swallowed into the fallback). `fallback`
 * lets a caller choose `{}` (store create/update, reprocess) or `undefined` (the `{handler}` route).
 */
export async function readBoundedJson<F>(
  c: Context<AppEnv>,
  maxBytes: number | undefined,
  fallback: F,
): Promise<unknown | F> {
  const bytes = await readBoundedRequestBytes(c, maxBytes);
  if (bytes.byteLength === 0) return fallback;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return fallback;
  }
}
