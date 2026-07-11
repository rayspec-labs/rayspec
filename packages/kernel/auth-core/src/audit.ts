/**
 * Neutral auth-audit EVENT shape (the DB write is api-auth's audit-store).
 *
 * Services return a list of AuditEvents describing what happened; the route layer commits them
 * OUT-OF-BAND (their own unit of work) so a 404/rollback of the main request never drops a
 * security event. Cross-tenant-denial events record the ACTOR's resolved tenant
 * authoritatively + the attempted target as an opaque `targetHash` (never a target-org FK the
 * actor does not own). Hashes/metadata only — no raw secrets/PII.
 */

/** The closed set of audited auth events. */
export type AuthEventName =
  | 'register'
  | 'login'
  | 'login_failed'
  | 'refresh'
  | 'refresh_reuse_detected'
  | 'logout'
  | 'org_create'
  | 'org_switch'
  | 'org_member_change'
  | 'apikey_mint'
  | 'apikey_revoke'
  | 'apikey_auth_failed'
  | 'cross_tenant_denied'
  | 'authz_denied';

/** One audit event a service emits for the route to commit out-of-band. */
export interface AuditEvent {
  event: AuthEventName;
  /** The actor's resolved tenant (authoritative; null when pre-org). */
  actorOrgId?: string | null;
  /** The actor's user id (null for fully anonymous failures). */
  actorUserId?: string | null;
  /** Refresh family id, when relevant. */
  familyId?: string | null;
  /** Opaque hash of an attempted cross-tenant target (NEVER a target-org FK). */
  targetHash?: string | null;
  /** Extra non-PII metadata (hashes/flags only). */
  meta?: Record<string, unknown>;
}
