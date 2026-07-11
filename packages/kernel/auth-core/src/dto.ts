/**
 * RaySpec HTTP DTOs (Zod) — the ONLY shapes that cross the public HTTP boundary. No
 * node-oidc-provider / jose / argon2 / Drizzle type appears here; handlers translate to/from
 * these. Mass-assignment defense: org_id / role / tenant_id are NEVER body-bindable — they are
 * server-derived. password_hash / key_hash / token_hash NEVER appear in any response DTO.
 *
 * The ONE deliberate, gated secret-in-a-response exception is `TokenResponse.refreshToken`
 * — the rotated refresh secret, returned to a NON-browser client ONLY on the
 * operator-gated + per-request opt-in path so it can store it in OS-secure storage (precedent:
 * `MintApiKeyResponse.plaintext`). It is never returned to a browser flow and never logged/audited.
 */
import { z } from 'zod';
import { API_KEY_GRANTABLE } from './authz.js';

/** Membership roles (owner|admin|member). */
export const Role = z.enum(['owner', 'admin', 'member']);
export type Role = z.infer<typeof Role>;

/** Email + password are validated for SHAPE here; normalization happens in the service. */
const passwordField = z.string().min(8).max(1024);
const emailField = z.string().min(3).max(254);

// ---- auth ----------------------------------------------------------------------------------

/**
 * A NON-browser client (desktop/CLI) opts in to receiving the rotated refresh
 * secret in the JSON response body (so it can store it in OS-secure storage and refresh without the
 * httpOnly cookie). Absent/false ⇒ today's behavior. Only honored when the deployment ALSO enables
 * the operator gate (`bodyRefreshEnabled`); a browser flow never sets it. Shared by register/login/
 * refresh.
 */
const deliverRefreshTokenInBody = z.boolean().optional();

export const RegisterRequest = z.object({
  email: emailField,
  password: passwordField,
  /** Optional: auto-create an org + owner membership for the new user. */
  orgName: z.string().min(1).max(200).optional(),
  deliverRefreshTokenInBody,
});
export type RegisterRequest = z.infer<typeof RegisterRequest>;

export const LoginRequest = z.object({
  email: emailField,
  password: passwordField,
  deliverRefreshTokenInBody,
});
export type LoginRequest = z.infer<typeof LoginRequest>;

/**
 * The access-token + (optional) active-org envelope returned by login / refresh / switch.
 *
 * `refreshToken` is a DELIBERATE, GATED exception to the "no secret in a response DTO" rule
 * — populated ONLY when the deployment enables `RAYSPEC_BODY_REFRESH_ENABLED`
 * AND the request opted in (`deliverRefreshTokenInBody`), i.e. a non-browser client storing the
 * secret in OS-secure storage. Precedent: `MintApiKeyResponse.plaintext` (a secret returned once
 * to the client by design). The secret is short-lived, rotates every refresh, and is
 * family-revocable; a browser flow never receives it (it never opts in), and it is never logged.
 */
export const TokenResponse = z.object({
  accessToken: z.string(),
  tokenType: z.literal('Bearer'),
  expiresIn: z.number().int().positive(),
  activeOrgId: z.string().uuid().nullable(),
  /** The rotated refresh secret — gated+opt-in only (see the type doc above). Absent otherwise. */
  refreshToken: z.string().optional(),
});
export type TokenResponse = z.infer<typeof TokenResponse>;

/** Refresh may carry the secret in the body (desktop/CLI) instead of the cookie. */
export const RefreshRequest = z.object({
  refreshToken: z.string().min(1).optional(),
  deliverRefreshTokenInBody,
});
export type RefreshRequest = z.infer<typeof RefreshRequest>;

export const MembershipView = z.object({
  orgId: z.string().uuid(),
  role: Role,
});
export type MembershipView = z.infer<typeof MembershipView>;

export const MeResponse = z.object({
  userId: z.string().uuid(),
  email: z.string(),
  emailVerified: z.boolean(),
  memberships: z.array(MembershipView),
  activeOrgId: z.string().uuid().nullable(),
});
export type MeResponse = z.infer<typeof MeResponse>;

// ---- orgs ----------------------------------------------------------------------------------

export const CreateOrgRequest = z.object({
  name: z.string().min(1).max(200),
  /** Optional slug; defaults to a normalized form of name. Lowercased + uniqueness server-side. */
  slug: z.string().min(1).max(200).optional(),
});
export type CreateOrgRequest = z.infer<typeof CreateOrgRequest>;

export const OrgView = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  role: Role,
});
export type OrgView = z.infer<typeof OrgView>;

export const OrgListResponse = z.object({ orgs: z.array(OrgView) });
export type OrgListResponse = z.infer<typeof OrgListResponse>;

/** Change a member's role within an org (owner|admin only; last-owner demotion is blocked). */
export const ChangeMemberRoleRequest = z.object({ role: Role });
export type ChangeMemberRoleRequest = z.infer<typeof ChangeMemberRoleRequest>;

// ---- api keys ------------------------------------------------------------------------------

/**
 * The known api-key scopes (closed set; intersected with requested on mint). `store:read`/
 * `store:write` let a programmatic/agency consumer (a desktop app / automation) READ
 * and WRITE declared-store data via an org-scoped api-key — the deployer grants the write scope
 * EXPLICITLY at mint (it is not implicit).
 *
 * DERIVED from `API_KEY_GRANTABLE` (authz.ts) — the SINGLE source of truth shared with `authorize()`.
 * This is not a parallel literal that can silently drift from the runtime gate: a scope minted here
 * that authorize() would never grant (or vice-versa) is structurally impossible, because both read
 * the same array. (The authz.test.ts derived-invariant test additionally pins the equality.)
 */
export const ApiKeyScope = z.enum(
  API_KEY_GRANTABLE as unknown as [string, ...string[]],
) as z.ZodEnum<{ [K in (typeof API_KEY_GRANTABLE)[number]]: K }>;
export type ApiKeyScope = z.infer<typeof ApiKeyScope>;

export const MintApiKeyRequest = z.object({
  name: z.string().min(1).max(200).optional(),
  scopes: z.array(ApiKeyScope).max(32).default([]),
});
export type MintApiKeyRequest = z.infer<typeof MintApiKeyRequest>;

/** The mint response is the ONLY place plaintext is returned — ONCE. */
export const MintApiKeyResponse = z.object({
  id: z.string().uuid(),
  keyPrefix: z.string(),
  /** The full plaintext key, shown EXACTLY ONCE; never stored, never returned again. */
  plaintext: z.string(),
  scopes: z.array(ApiKeyScope),
});
export type MintApiKeyResponse = z.infer<typeof MintApiKeyResponse>;

/**
 * The REDACTED mint snapshot — the ONLY shape persisted in idempotency_keys.snapshot and the
 * shape returned on an Idempotency-Key REPLAY. It NEVER carries
 * `plaintext`: the secret is shown EXACTLY ONCE on the original mint; a retry returns only the
 * non-secret metadata so a DB dump of the no-TTL snapshot column yields no usable `mk_prefix.secret`
 * credential. `replayed: true` signals the caller that the plaintext is not available again.
 */
export const MintApiKeyReplay = z.object({
  id: z.string().uuid(),
  keyPrefix: z.string(),
  scopes: z.array(ApiKeyScope),
  replayed: z.literal(true),
});
export type MintApiKeyReplay = z.infer<typeof MintApiKeyReplay>;

/** Listing never includes plaintext or the hash. */
export const ApiKeyView = z.object({
  id: z.string().uuid(),
  keyPrefix: z.string(),
  scopes: z.array(z.string()),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type ApiKeyView = z.infer<typeof ApiKeyView>;

export const ApiKeyListResponse = z.object({ keys: z.array(ApiKeyView) });
export type ApiKeyListResponse = z.infer<typeof ApiKeyListResponse>;
