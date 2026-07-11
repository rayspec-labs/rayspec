/**
 * OAuth-surface routes that are NOT the oidc-provider mount: the public JWKS (jose, kid-based)
 * and the WorkOS SSO stub (501, NO partial auth). The OAuth token endpoint + discovery are served
 * by the mounted oidc-provider under /oidc; this file exposes the first-party JWKS at
 * /v1/oauth/jwks so resource servers can verify our short access tokens.
 */

import type { OpenAPIHono } from '@hono/zod-openapi';
import { ApiError } from '@rayspec/auth-core';
import type { AppDeps, AppEnv } from '../app-context.js';

export function registerOAuthRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps): void {
  // GET /v1/oauth/jwks — the first-party public JWKS (kid-based; documented rotation overlap).
  app.get('/v1/oauth/jwks', (c) => {
    c.header('Cache-Control', 'public, max-age=300');
    return c.json(deps.jwks.toJwks(), 200);
  });

  // POST /v1/oauth/sso/:provider — reserved WorkOS SSO/SCIM seam. Returns 501, NO partial auth.
  app.post('/v1/oauth/sso/:provider', () => {
    throw new ApiError('NOT_IMPLEMENTED', 'SSO is not implemented.');
  });
}
