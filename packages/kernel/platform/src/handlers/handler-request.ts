/**
 * The request a stream handler sees: the caller's request with its credentials removed.
 *
 * A stream handler is the one handler kind that receives the Web `Request` itself (it moves raw bytes
 * and reads Range and upload headers), so it would otherwise see the credential the caller
 * authenticated with. Authentication happened before the handler runs; the handler has no use for
 * the credential and must not be able to read, log or forward it. This keeps every header and the
 * body a handler legitimately reads, and drops:
 *
 *  - `authorization`, `proxy-authorization` and `cookie` (the bearer token, an API key, the refresh
 *    session cookie);
 *  - any query parameter the route authenticated with (`dropQueryParams` — the playback route's
 *    media token travels as `?token=`).
 *
 * It is a view, not a sandbox: a handler runs in the runtime process, so this narrows what it is
 * handed, not what it could reach by other means.
 */

/** The request headers that carry a credential and never reach handler code. */
export const CREDENTIAL_REQUEST_HEADERS: readonly string[] = Object.freeze([
  'authorization',
  'proxy-authorization',
  'cookie',
]);

/** Build the credential-free copy of `request` a handler receives. */
export function withoutCredentials(
  request: Request,
  opts: { readonly dropQueryParams?: readonly string[] } = {},
): Request {
  const headers = new Headers(request.headers);
  for (const name of CREDENTIAL_REQUEST_HEADERS) headers.delete(name);

  let url = request.url;
  const drop = opts.dropQueryParams ?? [];
  if (drop.length > 0) {
    const parsed = new URL(request.url);
    // Rewritten only when a named parameter is present, so an unaffected URL keeps its exact spelling.
    if (drop.some((name) => parsed.searchParams.has(name))) {
      for (const name of drop) parsed.searchParams.delete(name);
      url = parsed.toString();
    }
  }

  const method = request.method.toUpperCase();
  const carriesBody = method !== 'GET' && method !== 'HEAD' && request.body !== null;
  // `duplex: 'half'` is what Node requires to hand a streamed body to a new Request; it is not in the
  // DOM `RequestInit` type, hence the widened init.
  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers,
    signal: request.signal,
    ...(carriesBody ? { body: request.body, duplex: 'half' as const } : {}),
  };
  return new Request(url, init);
}
