/**
 * Tenant DATA-ERASURE — the platform-generic, operator-gated, fail-closed right-to-erasure.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Given a tenant (org id), hard-delete that tenant's data, with an out-of-band audit record:
 *   (a) ALL of its PRODUCT-store rows (across every deployed declared store), AND
 *   (b) ALL of its CORE tenant-scoped run-journal/transcript rows — the platform tables that hold the
 *       tenant's raw run history + PII transcript: `runs`, `journal_steps`, `conversation_items` (the
 * RAW PII transcript), `run_events`, `idempotency_keys`, and the workflow journal
 *       (`workflow_runs`, `workflow_node_states`, `workflow_artifacts`) — the whole
 *       `CORE_TENANT_SCOPED_TABLES` set, AND
 *   (c) its blobs (recordings/media).
 * Both row classes go through the SAME `forTenant(db, tenantId)` chokepoint (they are all tenant-scoped),
 * so a delete can only ever touch THIS tenant's rows.
 *
 * WHAT IT DOES NOT ERASE (by design — these are a SEPARATE path / out of scope):
 * the GLOBAL `users` / `memberships` TOMBSTONES — reaped by the GDPR purge (`runScheduledCleanup`),
 *     not here (users/memberships are tenant-agnostic, no `tenant_id` — a different deletion path).
 *   - the `orgs` row ITSELF — the tenant SHELL remains; only its DATA is erased. (A full account erasure
 * = the tombstone purge + this product+core+blob data erasure; dropping the org shell is a
 *     separate, cascade-bearing decision.)
 *   - GLOBAL/auth tables (sessions / api_keys / auth_audit / the OIDC store) — predicate-exempt, not
 *     tenant-scoped via the chokepoint; their lifecycle is the auth/cleanup surface, not data-erasure.
 *
 * It is OPERATOR-triggered (an on-demand control seam — `BootedServer.eraseTenantNow`), NOT a
 * tenant self-service HTTP route (that is a later, external-exposure hardening-adjacent decision). Pre-external-exposure hardening / LOCAL.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE INVARIANTS (the security-critical guarantees).
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *  - NEVER CROSS-TENANT. Every product-row delete goes through the `forTenant(db, tenantId)` CHOKEPOINT
 *    (`TenantDb.delete` auto-injects `eq(tenant_id, tenantId)`), so a delete can only ever touch THIS
 *    tenant's rows. The blob erasure uses a handle bound to THIS tenant whose `deleteTenant` refuses a
 *    mismatched id. There is no code path that names another tenant.
 *  - FAIL-CLOSED INPUT. `tenantId` must be a UUID (the `forTenant` constructor throws otherwise) AND
 *    the org must exist (an absent org aborts — no partial delete). A soft-deleted/tombstoned org IS
 *    erasable (erasing a tombstoned tenant's leftover product data is legitimate), so the existence
 *    probe does NOT require `deleted_at IS NULL`.
 *  - FK-SAFE ORDER. Product→product FKs are deleted CHILDREN-FIRST (derived from the spec's
 *    `foreignKeys`), so a parent+child fixture erases with no FK violation under ANY ON DELETE policy
 *    (restrict / cascade / set null) AND the per-table counts stay accurate (no row is cascade-deleted
 *    out from under its own count). The CORE tables delete `runs` LAST (the run-family `run_id` is a
 *    plain text column — NOT an enforced FK in v0.1, so order cannot FK-violate either way — but the
 *    children-first discipline is held defensively + keeps counts exact should a real FK ever be added).
 *  - ATOMIC. ALL row deletes (product + core) run inside ONE `forTenant(db,tenantId).transaction(...)`,
 *    so a mid-loop failure ROLLS BACK the whole DB-half — never a partially-erased DB. The fs blob
 *    erasure stays OUTSIDE the tx (a filesystem cannot join a DB tx) and is idempotent.
 * GATED + IRREVERSIBLE-CAUTION (mirrors the GDPR purge). The actual hard-delete requires the
 *    operator gate `enabled === true`; unset/false ⇒ DRY-RUN (counts only, ZERO deletes). The gate is
 *    an OPERATOR env control (`RAYSPEC_ERASURE_ENABLED`), resolved at the composition root — NEVER a
 *    spec flag (a spec author must not be able to enable irreversible deletion). `dryRun:true` forces a
 *    preview even when the gate is on.
 *  - AUDITED — STRUCTURALLY MANDATORY. A real (gate-on, non-dry-run) erasure REQUIRES an audit store:
 *    `eraseTenant` fail-closes (throws) at the top of the delete path when `audit` is absent — there is
 *    NO code path that performs an irreversible delete without a durable record. The audit record is
 *    written BEFORE the deletes (intent), and a failed audit write ABORTS the erasure too.
 *  - IDEMPOTENT. A re-run deletes 0 rows / removes no blobs (already gone) — no error.
 */

import { randomUUID } from 'node:crypto';
import type { Db, TenantDb } from '@rayspec/db';
import { CORE_TENANT_SCOPED_TABLES, forTenant } from '@rayspec/db';
import type { BlobStore } from '@rayspec/platform';
import type { StoreSpec } from '@rayspec/spec';
import { getTableName } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { AuditStore } from '../stores/audit-store.js';

/** A fail-closed erasure abort (a non-existent org / a failed pre-delete audit). */
export class TenantEraseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantEraseError';
  }
}

/** Why an erasure ran as a dry-run (only set when `mode === 'dry-run'`). */
export type EraseDryRunReason = 'gate-disabled' | 'dry-run-requested';

/** The blob outcome of an erasure. */
export type EraseBlobOutcome =
  /** A blob backend was wired and the tenant subtree was removed. */
  | 'deleted'
  /** A blob backend was wired; a dry-run would have removed the subtree (nothing removed). */
  | 'dry-run'
  /** No blob backend was wired (a stores/api-only deploy) — there are no blobs to erase. */
  | 'no-backend';

/** The structured outcome — robust for tests + an operator preview (not a log scrape). */
export interface EraseResult {
  /** 'deleted' ⇒ the hard delete was performed; 'dry-run' ⇒ counts only, ZERO deletes. */
  readonly mode: 'deleted' | 'dry-run';
  /** Only set when `mode === 'dry-run'` — the gate was off, or a dry-run was explicitly requested. */
  readonly dryRunReason?: EraseDryRunReason;
  /** Per PRODUCT-store table (name → rows deleted, or rows that WOULD be deleted in a dry-run). */
  readonly tables: Record<string, number>;
  /** Total PRODUCT rows across every product table (deleted, or would-delete). */
  readonly totalRows: number;
  /**
   * Per CORE tenant-scoped table (name → rows deleted / would-delete), kept DISTINCT from `tables` so a
   * caller/operator sees the platform run-journal/transcript erasure separately from the product stores.
   * Keys are the SQL table names in `CORE_TENANT_SCOPED_TABLES`: `runs`, `journal_steps`,
   * `conversation_items`, `run_events`, `idempotency_keys`, and the workflow journal
   * `workflow_runs`, `workflow_node_states`, `workflow_artifacts`.
   */
  readonly coreTables: Record<string, number>;
  /** Total CORE rows across every core tenant-scoped table (deleted, or would-delete). */
  readonly coreTotalRows: number;
  /** The blob erasure outcome. */
  readonly blobs: EraseBlobOutcome;
  /** Echo of the erased tenant id (for the operator log / audit cross-check). */
  readonly tenantId: string;
}

/** What `eraseTenant` needs. The composition root threads these from the deployed spec + wired deps. */
export interface EraseTenantOpts {
  /** The raw Db handle (composition root). Product deletes go through `forTenant(db, tenantId)`. */
  readonly db: Db;
  /** The tenant (org id) to erase. MUST be a UUID + an existing org, else the erasure aborts. */
  readonly tenantId: string;
  /**
   * The deployed product tables (name → PgTable, from `buildProductTables(spec.stores)`). Each is
   * deleted tenant-scoped via the chokepoint; an empty map erases zero product rows.
   */
  readonly productTables: ReadonlyMap<string, PgTable>;
  /**
   * The tenant-bound BlobStore (built via `blobFactory(tenantId)`) — present iff the deploy wired a
   * blob backend (a stream-route spec). Absent ⇒ `blobs:'no-backend'`. Its `deleteTenant(tenantId)`
   * is called with the SAME id it is bound to (the bound-tenant equality holds).
   */
  readonly blob?: BlobStore;
  /**
   * The out-of-band audit store. When present, an erasure record is written BEFORE the deletes and a
   * failed audit ABORTS the erasure (no irreversible delete without a durable log). Absent ⇒ no audit
   * (the composition root always supplies one; absence is for a direct/test call).
   */
  readonly audit?: AuditStore;
  /**
   * The operator gate (resolved at the composition root from `RAYSPEC_ERASURE_ENABLED === 'true'`).
   * `true` ⇒ perform the irreversible deletes; `false`/default ⇒ DRY-RUN (count only, ZERO deletes).
   * NEVER a spec flag.
   */
  readonly enabled: boolean;
  /** Force a preview even when the gate is on (count only, ZERO deletes). Default false. */
  readonly dryRun?: boolean;
  /**
   * The deployed stores (for FK-safe ordering — children before parents). STRONGLY RECOMMENDED: with
   * it, deletion order + per-table counts are exact under any ON DELETE policy. Absent ⇒ deletion falls
   * back to `productTables` iteration order and relies on the deployed ON DELETE policy (default
   * cascade) to avoid an FK violation; counts may then under-report a cascade-deleted child.
   */
  readonly stores?: readonly StoreSpec[];
  /** Injectable clock for the audit timestamp (default `() => new Date()`). */
  readonly now?: () => Date;
}

/**
 * Order the product tables CHILDREN-FIRST: a table that is REFERENCED by another (a parent) is deleted
 * AFTER its referrers (its children). Derived from the spec's product→product `foreignKeys`. Acyclic
 * by topological peeling; a cycle (mutual / self FK — rare in v0.1) falls back to appending the rest in
 * iteration order (the deployed ON DELETE policy then carries it). Returns only tables present in
 * `productTables`.
 */
export function orderTablesChildrenFirst(
  productTables: ReadonlyMap<string, PgTable>,
  stores?: readonly StoreSpec[],
): { name: string; table: PgTable }[] {
  const names = [...productTables.keys()];
  const resolve = (ordered: string[]): { name: string; table: PgTable }[] =>
    ordered
      .map((n) => ({ name: n, table: productTables.get(n) }))
      .filter((x): x is { name: string; table: PgTable } => x.table !== undefined);

  if (!stores || stores.length === 0) {
    // No FK info → rely on the deployed ON DELETE policy; iteration (declared) order.
    return resolve(names);
  }

  // parent name → set of child names that reference it (a child has an FK → parent).
  const referencedBy = new Map<string, Set<string>>();
  for (const s of stores) {
    for (const fk of s.foreignKeys) {
      if (fk.references === s.name) continue; // self-ref: handled by the deployed ON DELETE policy.
      if (!referencedBy.has(fk.references)) referencedBy.set(fk.references, new Set());
      referencedBy.get(fk.references)?.add(s.name);
    }
  }

  const remaining = new Set(names);
  const ordered: string[] = [];
  while (remaining.size > 0) {
    // A table is deletable NOW iff no STILL-REMAINING table references it (it is not a parent of any
    // remaining child). Leaf children peel first; their parents become deletable next.
    const deletable = [...remaining].filter((n) => {
      const children = referencedBy.get(n);
      if (!children) return true;
      for (const c of children) if (remaining.has(c)) return false;
      return true;
    });
    if (deletable.length === 0) {
      // Cycle / unresolvable — append the rest in iteration order (ON DELETE policy best-effort).
      for (const n of remaining) ordered.push(n);
      break;
    }
    for (const n of deletable) {
      ordered.push(n);
      remaining.delete(n);
    }
  }
  return resolve(ordered);
}

/**
 * Order the CORE tenant-scoped tables (`CORE_TENANT_SCOPED_TABLES` from @rayspec/db) for deletion,
 * `runs` LAST. The run-family tables (`journal_steps`/`conversation_items`/`run_events`) carry a logical
 * `run_id` that points at `runs.run_id`; `idempotency_keys` and the workflow journal
 * (`workflow_runs`/`workflow_node_states`/`workflow_artifacts`, whose `workflow_run_id` is its own logical
 * key, not `runs.run_id`) are independent of the run family. In
 * v0.1 the `run_id` link is a plain `text` column — NOT an enforced FK — so the only FK on these tables
 * is `tenant_id → orgs(id) ON DELETE CASCADE`; we are NOT deleting the org, so NO inter-core delete can
 * FK-violate regardless of order. We still delete `runs` LAST (children-first discipline) so the order is
 * correct + the per-table counts stay exact should a real `run_id` FK ever be introduced. Names are the
 * SQL table names via drizzle `getTableName`, so they cannot drift from the schema.
 */
export function orderCoreTablesChildrenFirst(): { name: string; table: PgTable }[] {
  const entries = CORE_TENANT_SCOPED_TABLES.map((t) => ({
    name: getTableName(t as PgTable),
    table: t as PgTable,
  }));
  const children = entries.filter((e) => e.name !== 'runs');
  const parent = entries.filter((e) => e.name === 'runs');
  return [...children, ...parent];
}

/**
 * The chokepoint's `select`/`delete` are typed against the NARROW committed `TENANT_SCOPED_TABLES`
 * union; a DEPLOYED product store is a runtime-built generic `PgTable`, so we cast at the call boundary
 * — the SAME pattern the deploy verify-probe + the cross-tenant CI gate use (composition-root.ts). The
 * runtime chokepoint STILL injects `eq(tenant_id, tenantId)` (it keys on the table's `tenantId` column,
 * not the static type), so the tenant predicate is unchanged — this cast only satisfies tsc.
 */
async function scopedSelectCount(tdb: TenantDb, table: PgTable): Promise<number> {
  const rows = await (tdb.select as unknown as (t: PgTable) => { all: () => Promise<unknown[]> })(
    table,
  ).all();
  return rows.length;
}
async function scopedDeleteReturningCount(tdb: TenantDb, table: PgTable): Promise<number> {
  const rows = await (
    tdb.delete as unknown as (t: PgTable) => {
      where: () => { returning: () => Promise<unknown[]> };
    }
  )(table)
    .where()
    .returning();
  return rows.length;
}

/**
 * Erase one tenant's product data + core run-journal/transcript rows + blobs. See the file header for
 * the invariants. Returns the structured {@link EraseResult} (deleted counts when the gate is on,
 * would-delete counts on a dry-run).
 */
export async function eraseTenant(opts: EraseTenantOpts): Promise<EraseResult> {
  const { db, tenantId, productTables, blob, audit, enabled } = opts;
  const dryRun = opts.dryRun ?? false;
  const now = (opts.now ?? (() => new Date()))();

  // ── FAIL-CLOSED INPUT VALIDATION ─────────────────────────────────────────────────────────────
  // (1) SHAPE: forTenant's constructor THROWS "tenantId must be a UUID (fail-closed)" for a malformed
  //     id (and on empty). Build the scoped handle up front — it is the ONLY way we touch rows.
  const tdb = forTenant(db, tenantId);
  // (2) EXISTENCE: the org must exist. A well-formed-but-nonexistent tenant ABORTS (no partial delete).
  //     A soft-deleted/tombstoned org is STILL erasable (we do NOT require deleted_at IS NULL). The
  //     probe is parameterized ($1) — the tenantId is already UUID-validated, no injection seam.
  const orgRows = (await db.$client.unsafe('SELECT 1 FROM orgs WHERE id = $1 LIMIT 1', [
    tenantId,
  ])) as unknown as unknown[];
  if (orgRows.length === 0) {
    throw new TenantEraseError(
      `eraseTenant: no org '${tenantId}' exists — refusing erasure (fail-closed; no partial delete).`,
    );
  }

  const order = orderTablesChildrenFirst(productTables, opts.stores);
  const coreOrder = orderCoreTablesChildrenFirst();
  const actuallyDelete = enabled && !dryRun;
  const mode: EraseResult['mode'] = actuallyDelete ? 'deleted' : 'dry-run';
  const dryRunReason: EraseDryRunReason | undefined = actuallyDelete
    ? undefined
    : enabled
      ? 'dry-run-requested'
      : 'gate-disabled';

  // STRUCTURAL AUDIT-REQUIRED: a real (gate-on, non-dry-run) erasure MUST have an audit
  // store — there is no code path that performs an irreversible delete without a durable record. Fail
  // closed BEFORE any read/delete. A dry-run (no deletes) needs no audit.
  if (actuallyDelete && !audit) {
    throw new TenantEraseError(
      'eraseTenant: an enabled (real) erasure requires an audit store — refusing (fail-closed; no ' +
        'irreversible delete without a durable record).',
    );
  }

  const sum = (counts: Record<string, number>): number =>
    Object.values(counts).reduce((a, b) => a + b, 0);

  const tables: Record<string, number> = {};
  const coreTables: Record<string, number> = {};
  let blobs: EraseBlobOutcome;

  if (actuallyDelete) {
    // AUDIT-BEFORE-DELETE: read the intent counts FIRST (tenant-scoped SELECT — product + core), write
    // the durable audit record, THEN perform the irreversible deletes. A failed audit aborts BEFORE any
    // delete. The intent reads are outside the tx (counts for the log); the deletes' own RETURNING is
    // the ground-truth result.
    const intentCounts: Record<string, number> = {};
    for (const { name, table } of order) {
      intentCounts[name] = await scopedSelectCount(tdb, table);
    }
    const intentCoreCounts: Record<string, number> = {};
    for (const { name, table } of coreOrder) {
      intentCoreCounts[name] = await scopedSelectCount(tdb, table);
    }
    const intentTotal = sum(intentCounts);
    const intentCoreTotal = sum(intentCoreCounts);
    const requestId = randomUUID();
    // `audit` is guaranteed present here (the structural guard above threw otherwise); the `if` keeps
    // tsc happy without a non-null assertion.
    if (audit) {
      try {
        await audit.appendErasure({
          tenantId,
          requestId,
          meta: {
            mode,
            tables: intentCounts,
            totalRows: intentTotal,
            coreTables: intentCoreCounts,
            coreTotalRows: intentCoreTotal,
            blobs: blob ? 'deleted' : 'no-backend',
            at: now.toISOString(),
          },
        });
      } catch (err) {
        throw new TenantEraseError(
          `eraseTenant: the pre-delete audit write failed for tenant '${tenantId}' — refusing the ` +
            `irreversible erasure (no delete without a durable record). Cause: ${(err as Error).message}`,
        );
      }
    }

    // The irreversible row deletes, ATOMIC: product + core in ONE tenant transaction, so a
    // mid-loop failure rolls back the whole DB-half (never a partial DB erasure). CHILDREN-FIRST in each
    // class. The chokepoint scopes every delete to THIS tenant; the deleted-row count is ground truth
    // from RETURNING. The fs blob erasure is OUTSIDE the tx (a filesystem cannot join a DB tx).
    await tdb.transaction(async (ttx) => {
      for (const { name, table } of order) {
        tables[name] = await scopedDeleteReturningCount(ttx, table);
      }
      for (const { name, table } of coreOrder) {
        coreTables[name] = await scopedDeleteReturningCount(ttx, table);
      }
    });

    // Blob erasure — the handle is already bound to THIS tenant; deleteTenant(tenantId) passes its
    // bound-tenant equality check. Idempotent (no blobs ⇒ no-op). Outside the DB tx (committed above).
    if (blob) {
      await blob.deleteTenant(tenantId);
      blobs = 'deleted';
    } else {
      blobs = 'no-backend';
    }
  } else {
    // DRY-RUN: count what WOULD be deleted (tenant-scoped SELECT — product + core), delete NOTHING (rows
    // + blobs intact).
    for (const { name, table } of order) {
      tables[name] = await scopedSelectCount(tdb, table);
    }
    for (const { name, table } of coreOrder) {
      coreTables[name] = await scopedSelectCount(tdb, table);
    }
    blobs = blob ? 'dry-run' : 'no-backend';
  }

  return {
    mode,
    ...(dryRunReason ? { dryRunReason } : {}),
    tables,
    totalRows: sum(tables),
    coreTables,
    coreTotalRows: sum(coreTables),
    blobs,
    tenantId,
  };
}
