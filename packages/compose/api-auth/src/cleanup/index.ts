/**
 * The scheduled-cleanup ORCHESTRATOR — the platform housekeeping run.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Two platform housekeeping jobs that exist as store capabilities but were never SCHEDULED, now wired
 * onto ONE daily run (the `SystemCleanupScheduler` in `@rayspec/durable-dbos` invokes this via an
 * injected `runCleanup()` callback so that engine package stays api-auth-free):
 *
 *   1. OIDC PRUNE — LIVE, no gate. Hard-delete EXPIRED `oidc_models` rows (`pruneExpired`). Already-
 *      expired OAuth artifacts: no PII, no irreversibility beyond the token's own expiry → always runs.
 *
 *   2. GDPR HARD-DELETE PURGE — BUILT but DISABLED-BY-DEFAULT / operator-gated (a LOCKED design
 *      decision: the irreversible PII erasure NEVER auto-runs). The soft-delete already tombstones a
 *      user/membership (`deleted_at`); this purges the tombstone once it is older than retention.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE GATE — operator-only, fail-closed, lives HERE (not in a store, not in a spec).
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The gate is `gdprPurgeEnabled` (resolved by the composition root from the env var
 * `RAYSPEC_GDPR_PURGE_ENABLED`, which is `true` ONLY for the exact string `"true"` — anything else,
 * including unset, is DISABLED). It is an OPERATOR control, never a product-spec flag — a spec author must
 * never be able to enable irreversible PII deletion. When DISABLED (the default) the purge runs as a
 * DRY-RUN: it COUNTS what it WOULD delete (so an operator can see the backlog) but performs ZERO deletes.
 * When ENABLED it performs the deletes. The gate is checked ONCE, here, and decides which half of each
 * reaper (count vs delete) runs — a store method never decides policy.
 *
 * The result is STRUCTURED (not a log scrape) so a test asserts on it robustly: `gdpr.mode` is
 * 'disabled'|'enabled', `gdpr.users`/`gdpr.memberships` are the purged-OR-would-purge counts, and
 * `gdpr.oldestTombstoneAgeDays` is the age of the oldest eligible tombstone. The scheduler logs one clear
 * line from this result on every run.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * IDEMPOTENCY (why the system job needs NO reserve marker — unlike the cron scheduler).
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Every op deletes ALREADY-eligible rows (expired tokens / past-retention tombstones). Re-running deletes
 * the same set (now empty) → a duplicate or replayed tick is a HARMLESS no-op. So this job needs NO
 * tenant-scoped `idempotency_keys` reserve (the DBOS scheduled-workflow id already gives at-most-once-per-
 * instant; the ops being naturally idempotent makes even a duplicate body invocation safe). This is the
 * deliberate difference from `DbosCronScheduler`, whose handler/agent dispatch is NOT idempotent and so
 * needs the firing-instant reserve.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * / tenancy reconciliation (HONEST).
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * This is PLATFORM-WIDE housekeeping across global tables (oidc_models / users / memberships — none carry
 * a tenant_id), so it runs via the WHITELISTED global-table-module pattern (the stores' raw injected `db`,
 * the SAME seam the soft-delete `deleteUser`/`removeMember` use), NOT `forTenant`. There is no tenant
 * predicate because there is no tenant column on these global tables — the membership reaper instead
 * predicates per-row on each membership's OWN org (the per-org retention join). It is NOT a tenant cron
 * (it does not use `RAYSPEC_CRON_TENANT_ID`); the OIDC + user purge are global, the membership purge
 * iterates orgs for per-org retention via its join.
 */

import type { Db } from '@rayspec/db';
import { IdentityStore } from '../stores/identity-store.js';
import { DrizzleOidcAdapter } from '../stores/oidc-store.js';
import { OrgStore } from '../stores/org-store.js';
import { retentionCutoff } from './retention.js';

/** The default retention window (days) when an org has no `retention_days` override and no env override. */
export const DEFAULT_GDPR_RETENTION_DAYS = 30;

/** The operator gate + the resolved retention default the orchestrator runs under. */
export interface CleanupConfig {
  /**
   * The GDPR hard-delete gate. `false` (the default) ⇒ DRY-RUN (count only, ZERO deletes). `true` ⇒
   * perform the irreversible deletes. The composition root sets this from `RAYSPEC_GDPR_PURGE_ENABLED ===
   * 'true'` — operator-only, fail-closed (any other value, including unset, is `false`).
   */
  readonly gdprPurgeEnabled: boolean;
  /**
   * The flat retention default (days) for tombstones with no per-org override. USER tombstones always use
   * this (a user has no single org); MEMBERSHIP tombstones use their org's `retention_days` if set, else
   * this. Defaults to {@link DEFAULT_GDPR_RETENTION_DAYS}.
   */
  readonly gdprRetentionDays: number;
}

/** The GDPR-purge half of the structured cleanup result. */
export interface GdprCleanupResult {
  /** 'disabled' ⇒ the counts are WOULD-delete (dry-run, zero deletes); 'enabled' ⇒ they were deleted. */
  readonly mode: 'disabled' | 'enabled';
  /** USER tombstones deleted (enabled) OR that WOULD be deleted (disabled). */
  readonly users: number;
  /** MEMBERSHIP tombstones deleted (enabled) OR that WOULD be deleted (disabled). */
  readonly memberships: number;
  /** The age (whole days) of the OLDEST eligible tombstone across users+memberships (0 when none). */
  readonly oldestTombstoneAgeDays: number;
}

/** The structured result the scheduler logs + the tests assert on (robust, not log-spying). */
export interface CleanupResult {
  /** Expired `oidc_models` rows hard-deleted (LIVE — always performed). */
  readonly oidcPruned: number;
  /** The gated GDPR purge outcome (dry-run counts when disabled, delete counts when enabled). */
  readonly gdpr: GdprCleanupResult;
}

/** What `runScheduledCleanup` needs: the raw Db (composition root) + the gate/retention config. */
export interface CleanupDeps {
  /**
   * The raw Db handle (the composition root's makeDb / worker pool). The global-table stores are
   * constructed over it — the SAME sanctioned global-table seam the soft-delete path uses. The
   * orchestrator does NOT take a `forTenant` handle: these are tenant-LESS global tables (see header).
   */
  readonly db: Db;
  readonly config: CleanupConfig;
  /** Injectable clock (default `() => new Date()`) so a test can pin "now" for deterministic retention. */
  readonly now?: () => Date;
}

/**
 * Run ONE platform-housekeeping cleanup pass: prune expired OIDC rows (LIVE), then the gated GDPR purge
 * (dry-run counts when the gate is OFF — the default; deletes when ON). Returns the STRUCTURED result.
 *
 * Naturally idempotent (see header): every op targets already-eligible rows, so a re-run deletes the same
 * (now-empty) set. Safe to call from the scheduled-workflow body, the on-demand `runCleanupNow()` seam,
 * and the tests through the EXACT same path.
 */
export async function runScheduledCleanup(deps: CleanupDeps): Promise<CleanupResult> {
  const now = (deps.now ?? (() => new Date()))();
  const { db, config } = deps;

  // ── 1. OIDC prune — LIVE (no gate). One model-agnostic DELETE of every expired row. ──────────────
  // pruneExpired carries no `model` filter, so a single adapter instance prunes ALL expired artifacts.
  const oidcPruned = await new DrizzleOidcAdapter(db, 'Session').pruneExpired(now);

  // ── 2. GDPR purge — operator-gated. The cutoff(s) derive from ONE `now` so count==delete by construction.
  const identity = new IdentityStore(db);
  const orgs = new OrgStore(db);
  const userCutoff = retentionCutoff(now, config.gdprRetentionDays);

  let users: number;
  let memberships: number;
  let oldestTombstoneAgeDays: number;

  if (config.gdprPurgeEnabled) {
    // ENABLED: the irreversible deletes. Read the dry-run counts FIRST (for the oldest-age + the "what we
    // are about to erase" figure in the result), THEN delete. The counts are read on the same `now`/cutoff
    // the deletes use, so the reported figure IS what gets erased (a tombstone that crosses the cutoff
    // between read and delete cannot — the cutoff is a fixed instant, not "now at delete time").
    const userCount = await identity.countPurgeableUserTombstones(userCutoff, now);
    const memCount = await orgs.countPurgeableMembershipTombstones(now, config.gdprRetentionDays);
    oldestTombstoneAgeDays = Math.max(userCount.oldestAgeDays, memCount.oldestAgeDays);
    users = await identity.hardDeletePurgeableUserTombstones(userCutoff);
    memberships = await orgs.hardDeletePurgeableMembershipTombstones(now, config.gdprRetentionDays);
  } else {
    // DISABLED (the default): DRY-RUN only — count what we WOULD delete, perform ZERO deletes.
    const userCount = await identity.countPurgeableUserTombstones(userCutoff, now);
    const memCount = await orgs.countPurgeableMembershipTombstones(now, config.gdprRetentionDays);
    users = userCount.count;
    memberships = memCount.count;
    oldestTombstoneAgeDays = Math.max(userCount.oldestAgeDays, memCount.oldestAgeDays);
  }

  return {
    oidcPruned,
    gdpr: {
      mode: config.gdprPurgeEnabled ? 'enabled' : 'disabled',
      users,
      memberships,
      oldestTombstoneAgeDays,
    },
  };
}

/**
 * Format the one-line summary the scheduler logs on every run (count + oldest age + mode). Pure (the
 * scheduler does the actual logging) so it is testable and the engine package needs no formatting logic.
 */
export function formatCleanupLogLine(result: CleanupResult): string {
  const { oidcPruned, gdpr } = result;
  const verb = gdpr.mode === 'enabled' ? 'purged' : 'would purge (DRY-RUN, gate OFF)';
  return (
    `[cleanup] oidc: pruned ${oidcPruned} expired token row(s); ` +
    `gdpr[${gdpr.mode}]: ${verb} ${gdpr.users} user + ${gdpr.memberships} membership tombstone(s), ` +
    `oldest ${gdpr.oldestTombstoneAgeDays} day(s) old`
  );
}
