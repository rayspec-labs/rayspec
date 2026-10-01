/**
 * `withoutCredentials` — the request a stream handler is handed: the caller's request minus the
 * credential headers (and minus a query parameter the route authenticated with), with everything a
 * handler legitimately reads kept: the other headers, the body, the method and the abort signal.
 */
import { describe, expect, it } from 'vitest';
import { CREDENTIAL_REQUEST_HEADERS, withoutCredentials } from './handler-request.js';

describe('withoutCredentials', () => {
  it('drops authorization, proxy-authorization and cookie, whatever their case', () => {
    const req = new Request('http://localhost/upload/1', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer secret-jwt',
        'Proxy-Authorization': 'Basic c2VjcmV0',
        Cookie: '__Host-rayspec_rt=secret-refresh',
        'content-type': 'application/octet-stream',
        'x-upload-name': 'a.wav',
      },
      body: 'bytes',
    });
    const seen = withoutCredentials(req);
    for (const name of CREDENTIAL_REQUEST_HEADERS) expect(seen.headers.has(name)).toBe(false);
    expect(seen.headers.get('content-type')).toBe('application/octet-stream');
    expect(seen.headers.get('x-upload-name')).toBe('a.wav');
    // The caller's request itself is untouched (the middleware chain already read it).
    expect(req.headers.get('authorization')).toBe('Bearer secret-jwt');
  });

  it('keeps the method and streams the body through', async () => {
    const req = new Request('http://localhost/upload/1', {
      method: 'PUT',
      headers: { authorization: 'Bearer x' },
      body: 'the-body',
    });
    const seen = withoutCredentials(req);
    expect(seen.method).toBe('PUT');
    expect(await seen.text()).toBe('the-body');
  });

  it('carries no body for GET and HEAD', () => {
    for (const method of ['GET', 'HEAD']) {
      const seen = withoutCredentials(new Request('http://localhost/x', { method }));
      expect(seen.body).toBeNull();
    }
  });

  it('removes a named query parameter and keeps the others', () => {
    const req = new Request('http://localhost/play/1?token=media-secret&variant=hi&token=again');
    const seen = withoutCredentials(req, { dropQueryParams: ['token'] });
    const url = new URL(seen.url);
    expect(url.searchParams.has('token')).toBe(false);
    expect(url.searchParams.get('variant')).toBe('hi');
    expect(seen.url).not.toContain('media-secret');
  });

  it('leaves the URL spelled exactly as it was when the parameter is absent', () => {
    const raw = 'http://localhost/play/1?q=a%20b&x=1';
    expect(withoutCredentials(new Request(raw), { dropQueryParams: ['token'] }).url).toBe(raw);
  });

  it('follows the caller abort signal', () => {
    const controller = new AbortController();
    const seen = withoutCredentials(
      new Request('http://localhost/x', { signal: controller.signal }),
    );
    expect(seen.signal.aborted).toBe(false);
    controller.abort();
    expect(seen.signal.aborted).toBe(true);
  });
});
