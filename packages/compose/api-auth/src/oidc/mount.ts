/**
 * Mount oidc-provider (a Koa-based OpenID-certified provider) under a Hono app.
 *
 * THE RISK (Risks): oidc-provider speaks the raw Node `(req, res)` handler protocol
 * (it exposes `provider.callback()`, a standard Node `http.RequestListener`), while our HTTP
 * surface is Hono. A mis-bridged request — Hono consuming the body, a path-prefix mismatch —
 * silently breaks the token endpoint. We do NOT try to translate between Hono's `Request`/
 * `Response` and Koa's `ctx`. Instead we hand the UNTOUCHED raw Node objects straight to the
 * provider's callback and tell Hono the response was already sent.
 *
 * Mechanism (verified doc-first 2026-06-22 against @hono/node-server 2.0.6 + oidc-provider 9.8.5):
 *   - `@hono/node-server`'s `HttpBindings` exposes the raw `c.env.incoming` (IncomingMessage)
 *     and `c.env.outgoing` (ServerResponse). Hono has NOT read the body at this point (no
 *     middleware consumed it), so the stream is intact for the provider to parse.
 *   - `RESPONSE_ALREADY_SENT` (from `@hono/node-server/utils/response`) is returned so Hono does
 *     not also try to write a response.
 *   - `provider.callback()` is itself a `(req, res) => void` Node handler; we just invoke it.
 *
 * PATH HANDLING — the subtle, load-bearing bit (verified against oidc-provider 9.8.5 source,
 * `lib/helpers/oidc_context.js` `urlFor` + `lib/initialize_app.js`):
 *   - The provider is constructed with the FULL external issuer (`<baseUrl>/oidc`), so its
 *     emitted discovery/JWKS/token URLs are under `/oidc/...` (good — that is what clients call).
 *   - BUT its internal Koa `@koa/router` registers routes WITHOUT the mount prefix (`/auth`,
 *     `/token`, `/jwks`, ...). It expects the host framework to strip the prefix — exactly what
 *     `expressApp.use('/oidc', provider.callback())` does (Express sets `req.url='/auth'` +
 *     `req.baseUrl='/oidc'`). With the raw `incoming.url` still `/oidc/auth`, the router matches
 *     nothing → 404 (the spike's first failure).
 *   - The provider reconstructs its mountPath as
 *     `originalUrl.substring(0, originalUrl.indexOf(request.url))`. So the contract is: set
 *     `req.originalUrl` to the FULL path (`/oidc/auth?...`) and `req.url` to the prefix-STRIPPED
 *     path (`/auth?...`). Then Koa's `request.url` is `/auth?...`, the router matches, and the
 *     mountPath recomputes to `/oidc` so emitted URLs stay correct.
 *
 * We do NOT translate Hono's Request/Response to Koa's ctx — we hand the raw Node objects to
 * `provider.callback()` (a `(req,res)` http handler) after this one URL rewrite, and return
 * RESPONSE_ALREADY_SENT so Hono does not double-respond.
 */
import type { IncomingMessage } from 'node:http';
import type { HttpBindings } from '@hono/node-server';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import { Hono } from 'hono';
import type Provider from 'oidc-provider';

export const OIDC_MOUNT_PATH = '/oidc';

/**
 * Returns a Hono sub-app that forwards every request under it to the oidc-provider Node
 * callback. Mount it with `app.route('/oidc', mountOidc(provider))`.
 */
export function mountOidc(
  provider: Provider,
  mountPath = OIDC_MOUNT_PATH,
): Hono<{ Bindings: HttpBindings }> {
  const sub = new Hono<{ Bindings: HttpBindings }>();
  // The provider's own router handles ALL methods + sub-paths (discovery, jwks, auth, token,
  // interaction, userinfo). A single catch-all hands the raw req/res straight through.
  const callback = provider.callback();
  sub.all('/*', (c) => {
    const incoming = c.env.incoming as IncomingMessage & { originalUrl?: string };
    const { outgoing } = c.env;
    const fullUrl = incoming.url ?? mountPath;
    // Preserve the full path for the provider's mountPath reconstruction, then strip the prefix
    // so the internal (un-prefixed) router matches.
    incoming.originalUrl = fullUrl;
    if (fullUrl.startsWith(mountPath)) {
      const stripped = fullUrl.slice(mountPath.length);
      // A request to exactly `/oidc` (no trailing slash) maps to the provider root `/`.
      incoming.url = stripped.length === 0 ? '/' : stripped;
    }
    callback(incoming, outgoing);
    return RESPONSE_ALREADY_SENT;
  });
  return sub;
}
