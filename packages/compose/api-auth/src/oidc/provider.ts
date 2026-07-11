/**
 * node-oidc-provider configuration — minimal, scoped to the seams (Risks):
 * client_credentials (grant ENABLED, RFC-9068 JWT — but stamps NO org_id claim; the live M2M
 * path is the api-key m2m_client, and OIDC org-binding is a tracked deferral, not shipped in),
 *   authorization_code + PKCE (RFC 8252 loopback), refresh_token, discovery, JWKS. We do NOT wire
 *   the full model store surface beyond what these grants need (keeps the slice from ballooning —
 *   Risks: scope creep). (DRIFT-6)
 *
 * The provider uses the DrizzleOidcAdapter (global/predicate-exempt store) and its OWN signing
 * JWKS (independent of the first-party access-token signer; the provider mints RFC-9068 tokens
 * with `format: 'jwt'`). Mounted under /oidc via mountOidc (the interop-spike-proven bridge).
 *
 * Verified doc-first against oidc-provider 9.8.5: `new Provider(issuer, { adapter, clients, jwks,
 * pkce, scopes, features:{ clientCredentials, resourceIndicators }, ... })`, `provider.callback()`.
 */
import type { Db } from '@rayspec/db';
import type { JSONWebKeySet } from 'jose';
import Provider, { type Configuration } from 'oidc-provider';
import { DrizzleOidcAdapter } from '../stores/oidc-store.js';

export interface OidcProviderOptions {
  /** External issuer (e.g. https://api.example.com/oidc). Drives emitted URLs. */
  issuer: string;
  /** The raw Db for the adapter (global store). */
  db: Db;
  /** The provider's signing key set (private JWK(s)) — used to sign issued JWT access tokens. */
  jwks: JSONWebKeySet;
  /** Statically configured OAuth clients (M2M + desktop PKCE). */
  clients: Configuration['clients'];
  /** True behind a TLS-terminating proxy / for local http dev. */
  proxy?: boolean;
}

/** Build a minimally-configured oidc-provider for the OAuth seams. */
export function createOidcProvider(opts: OidcProviderOptions): Provider {
  const configuration: Configuration = {
    adapter: DrizzleOidcAdapter.factory(opts.db),
    clients: opts.clients,
    jwks: opts.jwks,
    // PKCE required for public/authorization_code clients (RFC 8252 desktop loopback).
    pkce: { required: () => true },
    scopes: ['openid', 'offline_access', 'agent:run', 'agent:read', 'org:read'],
    features: {
      // M2M client-credentials grant — enabled, but stamps NO org_id: a CC token is not
      // org-bound; org scoping is established elsewhere, not by the grant.
      clientCredentials: { enabled: true },
      // Issue stateless RFC-9068 JWT access tokens (verifiable by resource servers).
      resourceIndicators: {
        enabled: true,
        defaultResource: () => opts.issuer,
        getResourceServerInfo: () => ({
          scope: 'agent:run agent:read org:read',
          accessTokenFormat: 'jwt',
        }),
      },
      // No dev interaction UI in production; the first-party login path is our own register/login.
      devInteractions: { enabled: false },
    },
    // No cross-origin browser access to the provider endpoints (M2M + desktop loopback only).
    // NOTE: the rate-limit + input-size cap (OAuth body + scope length) are NOT here — they are a
    // pre-mount Hono guard on the /oidc prefix in app.ts (gated to the token path via
    // isOidcTokenPath, which covers the trailing-slash/case variants the provider also serves),
    // enforced BEFORE the raw req reaches the provider.
    clientBasedCORS: () => false,
    ttl: {
      AccessToken: 60 * 60,
      ClientCredentials: 60 * 60,
      AuthorizationCode: 600,
      RefreshToken: 14 * 24 * 60 * 60,
    },
  };

  const provider = new Provider(opts.issuer, configuration);
  if (opts.proxy) provider.proxy = true;
  return provider;
}
