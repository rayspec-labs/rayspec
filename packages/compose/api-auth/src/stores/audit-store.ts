/**
 * auth_audit store — append-only, OUT-OF-BAND committed.
 *
 * WHITELISTED global-table module: auth_audit is EXCLUDED from forTenant auto-scoping (it is
 * predicate-exempt) yet reads are gated per tenant at the read site. Writes go through a SEPARATE
 * committed unit of work (its own insert, not the request's transaction) so a 404/rollback of the
 * main request never drops the security event. Cross-tenant-denial rows record the ACTOR's
 * resolved tenant authoritatively + the attempted target as an opaque `target_hash` (never a
 * target-org FK the actor does not own). Hashes/metadata only.
 *
 * The full wiring on every auth event lands in; this is the store the routes call.
 */
import type { AuditEvent } from '@rayspec/auth-core';
import type { Db } from '@rayspec/db';
import { schema } from '@rayspec/db';
import { and, eq } from 'drizzle-orm';

export class AuditStore {
  constructor(private readonly db: Db) {}

  /**
   * Append ONE audit row in its OWN committed insert (out-of-band). `requestId` ties it to the
   * request. Never throws into the caller's path — an audit failure must not fail the request,
   * but it is logged. (A dropped audit is a known, bounded risk; a failed REQUEST due to audit is
   * worse for availability — the event is best-effort-durable via its own commit.)
   */
  async append(event: AuditEvent, requestId: string, ipHash?: string | null): Promise<void> {
    await this.db.insert(schema.authAudit).values({
      actorOrgId: event.actorOrgId ?? null,
      actorUserId: event.actorUserId ?? null,
      event: event.event,
      requestId,
      targetHash: event.targetHash ?? null,
      ipHash: ipHash ?? null,
      meta: { ...(event.meta ?? {}), ...(event.familyId ? { familyId: event.familyId } : {}) },
    });
  }

  /** Append many events out-of-band (each its own insert is overkill; one insert is atomic). */
  async appendMany(events: AuditEvent[], requestId: string, ipHash?: string | null): Promise<void> {
    if (events.length === 0) return;
    await this.db.insert(schema.authAudit).values(
      events.map((event) => ({
        actorOrgId: event.actorOrgId ?? null,
        actorUserId: event.actorUserId ?? null,
        event: event.event,
        requestId,
        targetHash: event.targetHash ?? null,
        ipHash: ipHash ?? null,
        meta: { ...(event.meta ?? {}), ...(event.familyId ? { familyId: event.familyId } : {}) },
      })),
    );
  }

  /**
   * append ONE out-of-band tenant-data-ERASURE record (its own committed insert). Erasure is
   * IRREVERSIBLE, so it MUST leave a durable record even if the seam that triggered it later fails;
   * the caller writes this BEFORE the deletes (the intent), so a record always precedes the action.
   *
   * The event name is a fixed literal — NOT an `AuthEventName` (that closed union is the auth surface;
   * a tenant data-erasure is a platform housekeeping action), so this inserts directly into the
   * `text` event column. `actorOrgId` is the erased org (the natural scope key — `readForTenant`
   * surfaces the record under that org). `meta` carries the per-table counts + mode + dry-run reason
   * (counts/flags only — NO PII). UNLIKE {@link append}, this DOES throw on a write failure: the
   * erasure caller treats a failed audit as a fail-closed abort (no irreversible delete without a log).
   */
  async appendErasure(record: {
    tenantId: string;
    requestId: string;
    meta: Record<string, unknown>;
  }): Promise<void> {
    await this.db.insert(schema.authAudit).values({
      actorOrgId: record.tenantId,
      actorUserId: null,
      event: 'tenant_data_erased',
      requestId: record.requestId,
      targetHash: null,
      ipHash: null,
      meta: record.meta,
    });
  }

  /**
   * append ONE out-of-band session-reprocess record (its own committed insert). A reprocess re-drives
   * a session's finalized workflow as a FRESH durable run (a cost-sensitive operational action), so it
   * leaves an immutable trail: the acting principal, the tenant scope, the session, the operator's
   * advisory reason, and the resulting run ids. Like {@link append} it is BEST-EFFORT and swallows a
   * write failure — the runs are ALREADY enqueued when this is called, so a failed audit must not turn
   * a successful reprocess into a 500 that a client would retry into MORE runs (the same availability
   * posture; the row is best-effort-durable via its own commit).
   *
   * The event name is a fixed literal — NOT an `AuthEventName` (a reprocess is a platform operational
   * action, not an auth-surface event), mirroring {@link appendErasure}'s `tenant_data_erased`.
   * `actorOrgId` is the SERVER-DERIVED tenant (the scope key `readForTenant` surfaces it under);
   * `meta` carries the session id, the resulting run ids, the advisory reason, and the actor tag —
   * ids/flags only, no secret.
   */
  async appendReprocess(record: {
    tenantId: string;
    actorUserId?: string | null;
    requestId: string;
    meta: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.db.insert(schema.authAudit).values({
        actorOrgId: record.tenantId,
        actorUserId: record.actorUserId ?? null,
        event: 'session_reprocessed',
        requestId: record.requestId,
        targetHash: null,
        ipHash: null,
        meta: record.meta,
      });
    } catch {
      // Best-effort: the runs are already enqueued; a failed audit must not fail the request.
    }
  }

  /**
   * Read audit rows for ONE tenant (read-gated). The actor_org_id IS the tenant scope here —
   * a tenant can only read rows where it is the authoritative actor org. NEVER returns another
   * tenant's rows.
   */
  async readForTenant(actorOrgId: string): Promise<(typeof schema.authAudit.$inferSelect)[]> {
    return this.db
      .select()
      .from(schema.authAudit)
      .where(eq(schema.authAudit.actorOrgId, actorOrgId));
  }

  /** Count rows for a (tenant, event) pair — used by tests/asserts. */
  async countForTenantEvent(actorOrgId: string, event: string): Promise<number> {
    const rows = await this.db
      .select()
      .from(schema.authAudit)
      .where(and(eq(schema.authAudit.actorOrgId, actorOrgId), eq(schema.authAudit.event, event)));
    return rows.length;
  }
}
