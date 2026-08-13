/**
 * The DBOS APPLICATION VERSION a durable worker boots with — the value that fences a deployment's
 * off-request queue to the work its OWN document enqueued.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY A VERSION AT ALL.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Two `rayspec-serve` processes on one `DATABASE_URL` derive the SAME DBOS system database
 * (`deriveDbosSystemUrl`) and register the SAME queue names, so they share one job pool. DBOS scopes
 * its dequeue by application version (`application_version IS NULL OR application_version = $3`). The
 * other column it could have discriminated on, `executor_id`, is no help: nothing here sets
 * `DBOSConfig.executorID`, so DBOS defaults it to the same constant in every process. The version is
 * the only discriminator available. Left to itself DBOS computes it as a hash over the registered workflow
 * functions' source plus the SDK version, and our registered functions are thin delegating wrappers
 * that carry nothing from the deployed document: every deployment of this platform produces the SAME
 * version, and a worker happily claims a job for a workflow it has never heard of.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THE DOCUMENT'S IDENTITY AND NOT ITS CONTENT.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A content hash would fence far more sharply — and would strand work on every edit, permanently. A
 * row whose `application_version` matches no running worker is inert in BOTH directions: an ENQUEUED
 * row is never selected, and a PENDING row is never recovered (`getPendingWorkflows` filters on the
 * same column). Nothing in this deployment rescues such a row. Resuming it does not reset the column,
 * DBOS's garbage collection explicitly excludes PENDING/ENQUEUED/DELAYED so it never ages out, and
 * every HTTP escape hatch lives on the admin server this platform deliberately disables. Deriving the
 * version from the document's IDENTITY instead keeps it stable across redeploys of the same document
 * — a redeploy comes back and consumes its own queued work — while two DIFFERENT documents on one
 * database stay fenced from each other, which is the failure that was measured.
 */
import { createHash } from 'node:crypto';

/**
 * Which boot profile named the identity. Two profiles can legitimately produce the same name (a
 * Product-YAML `product.id` and a backend spec's `metadata.name`), and they are different documents —
 * so the profile is part of the hashed input.
 */
export type DurableDocumentProfile = 'product' | 'backend';

/** The prefix every derived version carries, so an operator reading a DBOS log line knows its origin. */
export const DURABLE_APP_VERSION_PREFIX = 'doc-';

/**
 * How many hex characters of the digest the version keeps. TRUNCATION IS LOAD-BEARING, not cosmetic:
 * DBOS interpolates the version into the system pool's Postgres `application_name` as
 * `dbos_transact_${executorID}_${appVersion}`, and Postgres truncates that identifier at 63 bytes. A
 * full 64-hex digest would push it to 84. At 16 the whole name is 40 bytes.
 */
export const DURABLE_APP_VERSION_DIGEST_CHARS = 16;

/**
 * Derive the DBOS application version for a deployed document. Pure and deterministic: the same
 * `(profile, identity)` always yields the same string, and it depends on nothing but its arguments.
 *
 * The digest input is namespaced and versioned so the derivation can change later without a silent
 * collision with values already registered in a system database's `application_versions` table.
 */
export function deriveDbosApplicationVersion(
  profile: DurableDocumentProfile,
  documentIdentity: string,
): string {
  const digest = createHash('sha256')
    .update(`rayspec-durable-app-version:v1:${profile}:${documentIdentity}`)
    .digest('hex');
  return `${DURABLE_APP_VERSION_PREFIX}${digest.slice(0, DURABLE_APP_VERSION_DIGEST_CHARS)}`;
}
