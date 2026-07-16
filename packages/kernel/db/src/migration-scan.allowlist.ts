/**
 * Reviewed destructive-migration allowlist.
 *
 * Every entry clears ONE destructive finding (kind + the FULL collapsed statement) in a specific
 * migration file, with a reviewer reason. The home-grown scan BLOCKS unless every destructive
 * finding has a matching entry here — so a destructive change can never silently pass; it has to
 * be acknowledged in a reviewed code change.
 *
 * The exact-equality rule: `match` must equal the ENTIRE collapsed statement (trailing `;` optional), not an
 * unanchored substring — so an entry clears exactly the one statement it reviewed and cannot
 * accidentally clear a different, unreviewed statement that merely contains the same characters.
 */
import type { AllowlistEntry } from './migration-scan.js';

/** Allowlist keyed by migration filename (basename). */
export const MIGRATION_ALLOWLIST: Record<string, AllowlistEntry[]> = {
  '0000_identity_and_run_retrofit.sql': [
    {
      kind: 'truncate',
      match: 'TRUNCATE TABLE "journal_steps", "conversation_items", "runs";',
      reason:
        'Early-spike journal rows used arbitrary text tenant_ids with no backing orgs; throwaway ' +
        'per the retrofit review. TRUNCATE before the text->uuid cast so the new orgs FK cannot fail.',
    },
    {
      kind: 'using-cast',
      match:
        'ALTER TABLE "journal_steps" ALTER COLUMN "tenant_id" TYPE uuid USING "tenant_id"::uuid;',
      reason: 'journal_steps.tenant_id text->uuid; tables truncated above, so no rows to cast.',
    },
    {
      kind: 'using-cast',
      match:
        'ALTER TABLE "conversation_items" ALTER COLUMN "tenant_id" TYPE uuid USING "tenant_id"::uuid;',
      reason: 'conversation_items.tenant_id text->uuid; tables truncated above.',
    },
    {
      kind: 'using-cast',
      match: 'ALTER TABLE "runs" ALTER COLUMN "tenant_id" TYPE uuid USING "tenant_id"::uuid;',
      reason: 'runs.tenant_id text->uuid; tables truncated above.',
    },
    {
      kind: 'drop-index',
      match: 'DROP INDEX IF EXISTS "journal_idem_idx";',
      reason:
        'Drop the old (run_id, idempotency_key) replay index; re-created as a UNIQUE index keyed ' +
        'on (tenant_id, run_id, idempotency_key) at the end of this migration.',
    },
  ],
};
