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

/**
 * Add a user to an org by email (owner-only). `org_id`/`role`/`user_id` are NEVER body-bindable —
 * the org is the server-derived tenant and the added user always joins as a plain `member`. Only
 * the email is client-supplied; it is normalized server-side before any lookup/write.
 */
export const AddOrgMemberRequest = z.object({ email: emailField });
export type AddOrgMemberRequest = z.infer<typeof AddOrgMemberRequest>;

/** One member of an org (the id + email + role) — never a hash/secret. */
export const OrgMemberView = z.object({
  userId: z.string().uuid(),
  email: z.string(),
  role: Role,
});
export type OrgMemberView = z.infer<typeof OrgMemberView>;

/**
 * The add-member result. `oneTimePassword` is a DELIBERATE, single-shot secret-in-a-response — it
 * is populated ONLY when the added email had no existing user, so a fresh account is provisioned
 * with a random initial password the operator conveys out-of-band (core has no outbound mail). It
 * is shown EXACTLY ONCE, never stored in plaintext, and never returned again (precedent:
 * `MintApiKeyResponse.plaintext`). Absent when an existing user was added.
 */
export const AddOrgMemberResponse = z.object({
  userId: z.string().uuid(),
  email: z.string(),
  role: Role,
  oneTimePassword: z.string().optional(),
});
export type AddOrgMemberResponse = z.infer<typeof AddOrgMemberResponse>;

export const OrgMemberListResponse = z.object({ members: z.array(OrgMemberView) });
export type OrgMemberListResponse = z.infer<typeof OrgMemberListResponse>;

// ---- org invites (out-of-band invite-token flow) -------------------------------------------

/**
 * Issue an out-of-band org invite (owner-only). `org_id`/`tenant_id` are NEVER body-bindable — the
 * org is the server-derived tenant. `email` is normalized server-side. `role` defaults to `member`.
 * `expiresInSeconds` is an OPTIONAL requested lifetime clamped server-side to a floor/ceiling.
 *
 * The issue path deliberately does NOT look up whether the email has an account, so the response +
 * timing are IDENTICAL whether or not it does — no account-existence oracle (the account-existence
 * check happens only at redeem, performed by the invitee).
 */
export const IssueInviteRequest = z.object({
  email: emailField,
  role: Role.default('member'),
  expiresInSeconds: z.number().int().positive().optional(),
});
export type IssueInviteRequest = z.infer<typeof IssueInviteRequest>;

/**
 * The issued invite. `inviteToken` is a DELIBERATE, single-shot secret-in-a-response — the opaque
 * token is shown EXACTLY ONCE (the owner conveys it out-of-band; only its hash is stored), never
 * returned again (precedent: `MintApiKeyResponse.plaintext`). The response carries NO account-existence
 * signal (it is identical for any email).
 */
export const IssueInviteResponse = z.object({
  /** The opaque invite token, shown EXACTLY ONCE; never stored in plaintext, never returned again. */
  inviteToken: z.string(),
  email: z.string(),
  role: Role,
  /** The hard expiry (ISO 8601). */
  expiresAt: z.string(),
});
export type IssueInviteResponse = z.infer<typeof IssueInviteResponse>;

/**
 * Redeem an invite (the INVITEE acts, not the owner). The org is resolved FROM the token, never a URL.
 * `password` is REQUIRED only when the invited email has no account yet (the invitee sets their own
 * initial credential at accept); it is IGNORED when the email already has an account (the invitee must
 * instead be authenticated as that account — a token bearer can never set/reset an existing user's
 * password). `password` shares the register/login shape policy.
 */
export const AcceptInviteRequest = z.object({
  token: z.string().min(1),
  password: passwordField.optional(),
  deliverRefreshTokenInBody,
});
export type AcceptInviteRequest = z.infer<typeof AcceptInviteRequest>;

/**
 * The accept result — a token envelope scoped to the joined org (so the response is immediately
 * usable), plus the membership. `refreshToken` is the gated+opt-in body-delivered refresh secret,
 * present ONLY on the new-account provisioning path (the invitee is freshly logged in) when the
 * deployment enables it; an authenticated existing-account accept receives only a fresh org-scoped
 * access token (its refresh session is untouched).
 */
export const AcceptInviteResponse = z.object({
  accessToken: z.string(),
  tokenType: z.literal('Bearer'),
  expiresIn: z.number().int().positive(),
  activeOrgId: z.string().uuid(),
  userId: z.string().uuid(),
  role: Role,
  /** The rotated refresh secret — gated+opt-in, new-account path only (see the type doc above). */
  refreshToken: z.string().optional(),
});
export type AcceptInviteResponse = z.infer<typeof AcceptInviteResponse>;

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
 * non-secret metadata so a DB dump of the no-TTL snapshot column yields no usable `<prefix>.<secret>`
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
