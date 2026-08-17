/**
 * THE ROUTE THAT READS THIS PACK'S OWN TABLE — the half of the seam that had no shipped consumer.
 *
 * The pack beside this file owns `fixture_pack_audit_events`: its own migration chain creates it, no
 * store name reaches it, and until `init.packDb` existed only a `services[]` module could read it. So
 * a pack could own platform tables AND contribute a route, and the route could not read a row the
 * pack itself had written. The sibling route (`list-turns.ts`) is deliberately database-free, because
 * what it witnesses is the route NAMESPACE; nothing witnessed the data path, which is exactly how the
 * gap stayed invisible.
 *
 * WHAT THIS ONE WITNESSES, and it is three things:
 *   · the door reaches a table this pack's OWN chain created, from a contributed route;
 *   · the statement runs inside the transaction the DEPLOYMENT opened around the request — so it is
 *     atomic with the route's own writes and cannot block on them from a second connection;
 *   · the tenant predicate is the PACK'S OWN JOB and is dischargeable here: `init.tenantId` is
 *     server-derived and nothing a caller sends reaches it. The door does not rewrite a pack's SQL —
 *     it is not a tenant filter, exactly as a service's door is not — so a pack that forgot the
 *     predicate would read across tenants. This route does not forget it, and the arm beside it
 *     plants another tenant's row to prove the predicate is what keeps it out.
 */
import type { PackRouteHandler } from '@rayspec/pack-sdk';

/** What the route answers: how many audit rows this tenant has, plus what proves WHERE it read. */
interface AuditCount {
  readonly tenantId: string;
  readonly events: number;
  /**
   * The deployment's transaction-local tenant GUC, as seen THROUGH this door.
   *
   * It exists because the count alone cannot tell a pinned mount from a pooled one: rows committed by
   * another connection read the same either way. `TenantDb.transaction` sets this with
   * `is_local := true`, so it is visible ONLY on the connection that request's transaction holds — a
   * pooled second connection sees the empty string. Answering it is therefore the one cheap
   * observable that distinguishes the two, which is exactly what a fixture pack is for.
   */
  readonly tenantGucSeen: string;
}

/**
 * `GET /ext/fixture-pack/audit/count` — count this tenant's rows in the pack's own table.
 *
 * `init.packDb` is OPTIONAL on the contract (a deployment older than it injects none, and one that
 * loaded no pack chain has no such tables), so this fail-closes loudly on `undefined` rather than
 * answering a zero that would read like an empty table.
 */
export const countAuditEvents: PackRouteHandler<AuditCount> = async (init) => {
  if (!init.packDb) {
    throw new Error(
      'fixture-pack: init.packDb is absent — this deployment did not hand this route the door onto ' +
        'the tables this pack’s own migration chain created. Refusing rather than answering 0, ' +
        'which a caller cannot tell from an empty table.',
    );
  }
  const rows = await init.packDb.query(
    `SELECT count(*)::int AS events,
            current_setting('app.current_tenant', true) AS tenant_guc
       FROM fixture_pack_audit_events
      WHERE tenant_id = $1`,
    [init.tenantId],
  );
  return {
    tenantId: init.tenantId,
    events: Number(rows[0]?.events ?? 0),
    tenantGucSeen: String(rows[0]?.tenant_guc ?? ''),
  };
};
