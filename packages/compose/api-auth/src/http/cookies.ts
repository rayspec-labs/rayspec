/**
 * Refresh-cookie + CSRF helpers.
 *
 * The refresh secret rides in a HOST-PREFIXED cookie: `__Host-rayspec_refresh`. The `__Host-`
 * prefix is a browser-enforced contract — the cookie MUST be Secure, Path=/, and have NO Domain
 * attribute, which pins it to the exact origin (no subdomain injection). Combined with HttpOnly
 * (no JS access) + SameSite=Strict (not sent on cross-site requests) this is the session-
 * fixation + CSRF baseline. The access token is a Bearer JWT (never a cookie), so mutations
 * require a header a cross-site form cannot set.
 *
 * CSRF model: mutating /v1 endpoints require a Bearer token (cookie alone cannot mutate).
 * Cookie-authenticated endpoints (refresh, logout) additionally enforce an Origin /
 * Sec-Fetch-Site allowlist so a cross-site form POST that DOES carry the cookie is still rejected.
 */

export const REFRESH_COOKIE_NAME = '__Host-rayspec_refresh';

/** Serialize the host-prefixed refresh cookie (Set-Cookie value). */
export function refreshCookie(secret: string, maxAgeSeconds: number): string {
  // __Host- requires: Secure, Path=/, NO Domain. HttpOnly + SameSite=Strict harden it further.
  return (
    `${REFRESH_COOKIE_NAME}=${secret}; Path=/; Secure; HttpOnly; SameSite=Strict; ` +
    `Max-Age=${maxAgeSeconds}`
  );
}

/** Serialize a cookie that CLEARS the refresh cookie (logout). */
export function clearRefreshCookie(): string {
  return `${REFRESH_COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
}

/** Parse the refresh secret out of a Cookie header (no external dep). */
export function readRefreshCookie(cookieHeader: string | null | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (name === REFRESH_COOKIE_NAME) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/**
 * CSRF check for a COOKIE-authenticated endpoint (refresh/logout): accept the request only if its
 * Origin is in the allowlist OR Sec-Fetch-Site is `same-origin`/`none` (a direct navigation/
 * non-browser client). A cross-site form POST sets `Sec-Fetch-Site: cross-site` and an Origin not
 * in the allowlist → rejected. Non-browser clients (CLI/desktop) that send neither header and use
 * the BODY refresh path are allowed (they are not subject to ambient cookie CSRF).
 */
export function isCsrfSafeForCookieEndpoint(
  headers: { origin?: string | null; secFetchSite?: string | null },
  allowedOrigins: string[],
): boolean {
  const site = headers.secFetchSite?.toLowerCase();
  if (site === 'same-origin' || site === 'none') return true;
  if (site === 'cross-site' || site === 'same-site') {
    // A browser cross/same-site request: require the Origin to be explicitly allowlisted.
    return headers.origin != null && allowedOrigins.includes(headers.origin);
  }
  // No Sec-Fetch-Site header (older browser / non-browser client): fall back to Origin allowlist.
  // If no Origin either, it is a non-browser client (no ambient cookies) → safe.
  if (headers.origin == null) return true;
  return allowedOrigins.includes(headers.origin);
}
