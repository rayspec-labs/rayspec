/**
 * The validator for the `auditing:` section this pack claims — the pack's OWN grammar for the one
 * top-level key it owns.
 *
 * It is written by hand, against no validation library at all, because that is the contract the
 * platform actually promises a pack: `sectionValidatorFrom` admits a default export on the structural
 * evidence that it has a `safeParse` method, so that a pack authored in its own repository can
 * validate with whatever it already depends on. Writing this one with zod would have proven the
 * easier half — that the repository's own zod satisfies its own adapter — and left the half a real
 * pack depends on unmeasured. So: an object literal with a `safeParse`, and a rejection shaped like
 * the issue list the adapter reads (`path` + `message`, plus `code`/`keys` where they carry meaning).
 *
 * THE GRAMMAR, deliberately small — the point is the seam, not the section:
 *   auditing:
 *     retentionDays: <integer ≥ 1>     REQUIRED
 *     redactPayloads: <boolean>        optional (default false)
 * and nothing else: an unknown key inside the section is rejected, which is what makes the section's
 * own `.strict()`-equivalent refusal — reported as `unknown_field` at `auditing.<key>`, by the same
 * mapper a core section's unknown key goes through — observable from a command.
 */

/** The validated shape of an `auditing:` section (what a consumer of the parse receives back). */
export interface AuditingSection {
  readonly retentionDays: number;
  readonly redactPayloads: boolean;
}

/** One rejection detail, in the issue shape the platform's section adapter reads. */
interface Issue {
  readonly code?: string;
  readonly path: readonly string[];
  readonly message: string;
  readonly keys?: readonly string[];
}

/** The keys this section grammar declares — everything else is refused. */
const DECLARED_KEYS = ['retentionDays', 'redactPayloads'];

/**
 * The pack's section grammar. `safeParse` returns `{success:true, data}` for a node this pack accepts
 * and `{success:false, error:{issues}}` for one it does not — the whole violation list in one pass,
 * never just the first, so an operator fixing the section reads every problem it has.
 */
const AuditingSchema = {
  safeParse(
    value: unknown,
  ): { success: true; data: AuditingSection } | { success: false; error: { issues: Issue[] } } {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return {
        success: false,
        error: {
          issues: [{ path: [], message: 'the auditing section must be a mapping' }],
        },
      };
    }
    const node = value as Record<string, unknown>;
    const issues: Issue[] = [];

    const unknown = Object.keys(node).filter((key) => !DECLARED_KEYS.includes(key));
    if (unknown.length > 0) {
      issues.push({
        code: 'unrecognized_keys',
        path: [],
        message: `unrecognized keys: ${unknown.join(', ')}`,
        keys: unknown,
      });
    }

    const retentionDays = node.retentionDays;
    if (
      !(typeof retentionDays === 'number' && Number.isInteger(retentionDays) && retentionDays >= 1)
    ) {
      issues.push({
        path: ['retentionDays'],
        message:
          'retentionDays must be an integer of at least 1 (the audit retention window in days)',
      });
    }

    const redactPayloads = node.redactPayloads;
    if (redactPayloads !== undefined && typeof redactPayloads !== 'boolean') {
      issues.push({ path: ['redactPayloads'], message: 'redactPayloads must be a boolean' });
    }

    if (issues.length > 0) return { success: false, error: { issues } };
    return {
      success: true,
      data: {
        retentionDays: retentionDays as number,
        redactPayloads: redactPayloads === true,
      },
    };
  },
};

export default AuditingSchema;
