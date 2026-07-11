/**
 * Idempotency store — the TENANT-SCOPED Idempotency-Key replay record.
 *
 * This is the ONE store that goes through the TenantDb CHOKEPOINT (forTenant), NOT the raw handle:
 * idempotency_keys is a tenant-scoped table (registered in TENANT_SCOPED_TABLES), so the lookup +
 * insert carry the tenant predicate STRUCTURALLY — a cross-tenant Idempotency-Key reuse can never
 * hit another tenant's record (the run-core lesson). Hence this file is NOT on the chokepoint
 * whitelist and must not name a raw handle or call unscoped().
 */

import type { Db } from '@rayspec/db';
import { forTenant, schema } from '@rayspec/db';
import { and, eq } from 'drizzle-orm';

export interface IdempotencyRecord {
  bodyHash: string;
  snapshot: unknown;
}

/**
 * The outcome of an atomic reserve (B1 reserve-before-execute):
 *  - `won: true`  → WE inserted the reservation row (no prior row existed); the caller owns the run
 *    and may execute the agent.
 *  - `won: false` → a row already existed (a concurrent/earlier caller won the UNIQUE(tenant,scope,
 *    key) race); `existing` is that prior record. The loser MUST NOT execute the agent — it replays
 *    the winner's run (same body) or 409s (different body / still-in-progress).
 */
export interface IdempotencyReservation {
  won: boolean;
  existing?: IdempotencyRecord;
}

export class IdempotencyStore {
  constructor(private readonly db: Db) {}

  /** Find a prior record for (tenant, scope, key) — tenant-scoped via forTenant. */
  async find(
    tenantId: string,
    scope: string,
    idemKey: string,
  ): Promise<IdempotencyRecord | undefined> {
    const tdb = forTenant(this.db, tenantId);
    const rows = await tdb
      .select(schema.idempotencyKeys)
      .where(
        and(eq(schema.idempotencyKeys.scope, scope), eq(schema.idempotencyKeys.idemKey, idemKey)),
      )
      .limit(1);
    const row = rows[0] as typeof schema.idempotencyKeys.$inferSelect | undefined;
    if (!row) return undefined;
    return { bodyHash: row.bodyHash, snapshot: row.snapshot };
  }

  /**
   * Atomically RESERVE (tenant, scope, key) with a body hash + initial snapshot (B1 reserve-before-
   * execute). A single `INSERT ... ON CONFLICT DO NOTHING RETURNING` is the atomicity primitive: the
   * UNIQUE(tenant,scope,key) index lets EXACTLY ONE of N concurrent callers insert; that caller gets a
   * RETURNING row (`won:true`) and owns the run, the rest get zero rows (`won:false`) and must not
   * execute. On a loss we re-read the prior record (the winner's row) so the caller can decide
   * replay-vs-409. tenant_id is auto-stamped by the chokepoint (cross-tenant key reuse can't collide).
   */
  async reserve(
    tenantId: string,
    scope: string,
    idemKey: string,
    bodyHash: string,
    snapshot: unknown,
  ): Promise<IdempotencyReservation> {
    const tdb = forTenant(this.db, tenantId);
    const inserted = (await tdb
      .insert(schema.idempotencyKeys, {
        scope,
        idemKey,
        bodyHash,
        snapshot: snapshot as Record<string, unknown>,
      })
      .onConflictDoNothing()
      .returning()) as Array<unknown>;
    if (inserted.length > 0) return { won: true };
    // We lost the race (or a prior reservation already exists) — return the existing record.
    const existing = await this.find(tenantId, scope, idemKey);
    return { won: false, existing };
  }

  /**
   * Overwrite the snapshot for an EXISTING reservation row we already won (B1): after the run
   * completes we replace the initial `{ runId }` reservation snapshot with itself (idempotent) — kept
   * as a method so a future caller can store a richer post-completion snapshot without a second insert
   * race. tenant-scoped + scope/key-bounded UPDATE (no cross-tenant write).
   */
  async updateSnapshot(
    tenantId: string,
    scope: string,
    idemKey: string,
    snapshot: unknown,
  ): Promise<void> {
    const tdb = forTenant(this.db, tenantId);
    await tdb
      .update(schema.idempotencyKeys, { snapshot: snapshot as Record<string, unknown> })
      .where(
        and(eq(schema.idempotencyKeys.scope, scope), eq(schema.idempotencyKeys.idemKey, idemKey)),
      );
  }

  /**
   * RELEASE (delete) a reservation we won but whose run did NOT complete successfully (B1): a thrown /
   * timed-out / errored fresh run must leave the key RE-RUNNABLE (a failed run is retryable), so we
   * remove the reservation row. tenant-scoped + scope/key-bounded DELETE (no cross-tenant write). A
   * no-op if the row is already gone. Only the winner that created the reservation calls this.
   */
  async release(tenantId: string, scope: string, idemKey: string): Promise<void> {
    const tdb = forTenant(this.db, tenantId);
    await tdb
      .delete(schema.idempotencyKeys)
      .where(
        and(eq(schema.idempotencyKeys.scope, scope), eq(schema.idempotencyKeys.idemKey, idemKey)),
      );
  }

  /** Record a snapshot for (tenant, scope, key). tenant_id is auto-stamped by the chokepoint. */
  async record(
    tenantId: string,
    scope: string,
    idemKey: string,
    bodyHash: string,
    snapshot: unknown,
  ): Promise<void> {
    const tdb = forTenant(this.db, tenantId);
    await tdb
      .insert(schema.idempotencyKeys, {
        scope,
        idemKey,
        bodyHash,
        snapshot: snapshot as Record<string, unknown>,
      })
      .onConflictDoNothing();
  }
}
