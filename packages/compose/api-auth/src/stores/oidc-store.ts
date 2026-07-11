/**
 * Drizzle-backed node-oidc-provider adapter (the OIDC model store).
 *
 * WHITELISTED global-table module (Risks): the OIDC store is GLOBAL / predicate
 * exempt by DESIGN — OAuth artifacts are isolated by token audience + the client's org-bound
 * payload, not a tenant_id column. The raw Db handle is injected; this file is on the chokepoint
 * whitelist precisely because it is a reviewed global-table module.
 *
 * Implements the canonical oidc-provider Adapter contract (verified doc-first 2026-06-22 against
 * oidc-provider 9.8.5's lib/adapters/memory_adapter.js):
 *   upsert(id, payload, expiresIn) / find(id) / findByUserCode(userCode) / findByUid(uid) /
 *   consume(id) / destroy(id) / revokeByGrantId(grantId)
 * with the grant/userCode/uid index maintenance the memory adapter performs — here as real
 * indexed columns instead of side keys. `consume` stamps `consumed` (epoch) into the payload, as
 * the provider reads `payload.consumed` to enforce one-time use.
 */
import type { Db } from '@rayspec/db';
import { schema } from '@rayspec/db';
import { and, eq, lte } from 'drizzle-orm';
import type { Adapter, AdapterPayload } from 'oidc-provider';

/** Models that carry a grantId (mirrors oidc-provider's `grantable` set). */
const GRANTABLE = new Set([
  'AccessToken',
  'AuthorizationCode',
  'RefreshToken',
  'DeviceCode',
  'BackchannelAuthenticationRequest',
]);

export class DrizzleOidcAdapter implements Adapter {
  constructor(
    private readonly db: Db,
    private readonly model: string,
  ) {}

  /** A factory matching oidc-provider's `adapter: (name) => Adapter` config shape. */
  static factory(db: Db): (name: string) => Adapter {
    return (name: string) => new DrizzleOidcAdapter(db, name);
  }

  async upsert(id: string, payload: AdapterPayload, expiresIn: number): Promise<void> {
    const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;
    const grantId = GRANTABLE.has(this.model) ? (payload.grantId ?? null) : null;
    const userCode = payload.userCode ?? null;
    const uid = payload.uid ?? null;
    await this.db
      .insert(schema.oidcModels)
      .values({
        model: this.model,
        id,
        payload: payload as unknown as Record<string, unknown>,
        grantId,
        userCode,
        uid,
        expiresAt,
      })
      .onConflictDoUpdate({
        target: [schema.oidcModels.model, schema.oidcModels.id],
        set: {
          payload: payload as unknown as Record<string, unknown>,
          grantId,
          userCode,
          uid,
          expiresAt,
        },
      });
  }

  async find(id: string): Promise<AdapterPayload | undefined> {
    const rows = await this.db
      .select()
      .from(schema.oidcModels)
      .where(and(eq(schema.oidcModels.model, this.model), eq(schema.oidcModels.id, id)))
      .limit(1);
    return this.materialize(rows[0]);
  }

  async findByUserCode(userCode: string): Promise<AdapterPayload | undefined> {
    const rows = await this.db
      .select()
      .from(schema.oidcModels)
      .where(and(eq(schema.oidcModels.model, this.model), eq(schema.oidcModels.userCode, userCode)))
      .limit(1);
    return this.materialize(rows[0]);
  }

  async findByUid(uid: string): Promise<AdapterPayload | undefined> {
    const rows = await this.db
      .select()
      .from(schema.oidcModels)
      .where(and(eq(schema.oidcModels.model, this.model), eq(schema.oidcModels.uid, uid)))
      .limit(1);
    return this.materialize(rows[0]);
  }

  async consume(id: string): Promise<void> {
    // The provider reads payload.consumed (epoch seconds) to enforce one-time use.
    const rows = await this.db
      .select()
      .from(schema.oidcModels)
      .where(and(eq(schema.oidcModels.model, this.model), eq(schema.oidcModels.id, id)))
      .limit(1);
    const row = rows[0];
    if (!row) return;
    const payload = {
      ...(row.payload as Record<string, unknown>),
      consumed: Math.floor(Date.now() / 1000),
    };
    await this.db
      .update(schema.oidcModels)
      .set({ payload, consumedAt: new Date() })
      .where(and(eq(schema.oidcModels.model, this.model), eq(schema.oidcModels.id, id)));
  }

  async destroy(id: string): Promise<void> {
    await this.db
      .delete(schema.oidcModels)
      .where(and(eq(schema.oidcModels.model, this.model), eq(schema.oidcModels.id, id)));
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    // Revoke EVERY artifact sharing this grant (across all grantable models, like the memory
    // adapter's grant index). The DELETE is by grant_id only — model-agnostic per the contract.
    await this.db.delete(schema.oidcModels).where(eq(schema.oidcModels.grantId, grantId));
  }

  /** Map a stored row back to the provider's AdapterPayload, honoring expiry. */
  private materialize(
    row: typeof schema.oidcModels.$inferSelect | undefined,
  ): AdapterPayload | undefined {
    if (!row) return undefined;
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return undefined;
    return row.payload as unknown as AdapterPayload;
  }

  /**
   * Housekeeping: hard-delete EXPIRED token rows across ALL models (now scheduled on the
   * system cleanup cron). Deletes every row whose `expires_at <= now` (model-AGNOSTIC: the DELETE carries
   * no `model` filter, so one call prunes every grantable/non-grantable expired artifact). A row with a
   * NULL `expires_at` is NEVER pruned (a non-expiring artifact stays) — `expires_at <= now` is FALSE for
   * NULL, so the predicate already excludes it; this preserves the documented OIDC store semantics.
   * Returns the number of rows hard-deleted (for the cleanup orchestrator's structured result + log).
   *
   * SAFE / no-gate (unlike the GDPR purge): it deletes only ALREADY-EXPIRED OAuth artifacts — no PII, no
   * irreversibility beyond what the token's own expiry already mandated — so it runs LIVE on every tick.
   *
   * `now` is injectable (default the real wall-clock) so the cleanup orchestrator passes ONE shared clock
   * across the whole pass (deterministic + testable); production omits it.
   */
  async pruneExpired(now: Date = new Date()): Promise<number> {
    const deleted = await this.db
      .delete(schema.oidcModels)
      .where(lte(schema.oidcModels.expiresAt, now))
      .returning({ model: schema.oidcModels.model, id: schema.oidcModels.id });
    return deleted.length;
  }
}
