/**
 * The RUN-JOURNAL READ capability — the door a `{handler}` route reads the tenant's recorded steps
 * back through.
 *
 * The run journal is the platform's reliability primitive: one transactional, append-only,
 * tenant-scoped record per step, and the single source of truth for replay, cost and audit. Writing
 * to it is the platform's own affair (a handler contributes the work, the platform records the step);
 * READING it had no contract at all, so a handler that needed to serve back what its work produced had
 * to name the core's journal table and its column layout in a SQL string. That is an unversioned
 * dependency on a core internal expressed as text: a renamed column breaks it silently, and nothing in
 * a build can see the break. This door replaces the string with a type.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT IT IS SCOPED TO, AND WHAT IT IS NOT.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *  - THE RUN'S OWN TENANT, STRUCTURALLY. There is no tenant parameter: the reader is built from the
 *    same tenant-bound `TenantDb` chokepoint the store facade is built from, so the tenant predicate
 *    is AND-combined beneath every read and a handler has no way to name another tenant.
 *  - THE TENANT'S JOURNAL, NOT THE CALLER'S OWN SLICE OF IT. The journal is the tenant's single
 *    record of work, so a read sees every step recorded for that tenant — the deployment's own agent
 *    runs and any extension pack's contributions alike. Filter by `runId` to read one unit of work.
 *  - BOUNDED. Every read returns at most `limit` entries (clamped by the platform), so there is no
 *    unbounded drain of the journal through this door.
 *  - READ ONLY. There is no append here; a step is recorded by the platform for the work it ran.
 *  - THE NEUTRAL COLUMNS ONLY. The stored record also carries platform-owned accounting and
 *    provenance — which provider ran the step, how the run authenticated, which pricing entry
 *    computed the cost — and those are deliberately not part of this shape: they name vocabulary the
 *    caller neither supplies nor chooses. Treat an entry as OPEN: these fields are promised to be
 *    present and to mean this, never to be all of them.
 */

/** The kind of step recorded in the journal. */
export type HandlerJournalStepType = 'llm' | 'tool' | 'store';

/** How a step ended. A failed step is journaled, never dropped. */
export type HandlerJournalStatus = 'ok' | 'error';

/**
 * Token usage for a step. The three totals are always present; the remaining members are reported
 * only by providers that measure them, so absence means "not reported" rather than zero.
 */
export interface HandlerTokenUsage {
  /** Tokens in the request. */
  readonly inputTokens: number;
  /** Tokens in the response. */
  readonly outputTokens: number;
  /** The sum the provider reported. */
  readonly totalTokens: number;
  /** Cached input tokens read, where the provider reports caching. */
  readonly cacheReadTokens?: number;
  /** Input tokens written to the cache, where the provider reports caching. */
  readonly cacheCreationTokens?: number;
  /** Reasoning tokens, where the provider reports them separately. */
  readonly reasoningTokens?: number;
}

/**
 * ONE journal entry as a READ returns it — the recorded step plus the cursor naming its position in
 * the read order.
 *
 * The cursor belongs to the READ, not to the step: it is what a caller passes back as
 * `HandlerJournalQuery.after` to continue past this entry, and what an incremental response emits as
 * a frame `id` so a reconnecting client resumes rather than replays. OPAQUE — its encoding is the
 * platform's, and a caller neither parses nor orders nor constructs one.
 */
export interface HandlerJournalEntry {
  /** The step's own id. */
  readonly stepId: string;
  /** The run this step belongs to. */
  readonly runId: string;
  /** The tenant the run executed for — server-derived. */
  readonly tenantId: string;
  /** Which kind of step this is. */
  readonly type: HandlerJournalStepType;
  /** The replay key: identical `(runId, idempotencyKey)` returns the recorded output. */
  readonly idempotencyKey: string;
  /** A hash of the step input, for the replay lookup and for audit. */
  readonly inputHash: string;
  /** The step's output as recorded. Opaque data — its shape is the step's own concern. */
  readonly output: unknown;
  /** Token usage for the step. */
  readonly usage: HandlerTokenUsage;
  /** The computed cost of the step in USD. */
  readonly costUsd: number;
  /** Wall-clock duration of the step in milliseconds. */
  readonly latencyMs: number;
  /** Whether the step succeeded. */
  readonly status: HandlerJournalStatus;
  /** When the entry was recorded (ISO 8601, microsecond precision as stored). */
  readonly createdAt: string;
  /** This entry's OPAQUE position marker — pass it back as `after`, or emit it as a frame `id`. */
  readonly cursor: string;
}

/** What a journal read asks for. Every member is optional; `{}` reads the tenant's newest page. */
export interface HandlerJournalQuery {
  /** Read only the steps of this run. Absent ⇒ every run of the tenant. */
  readonly runId?: string;
  /**
   * Continue strictly AFTER this cursor (a cursor from an earlier entry of this same reader). Absent
   * ⇒ start at the oldest entry. A cursor the reader cannot parse is REFUSED — it rejects with an
   * `Error` whose `name` is `HandlerJournalCursorError` rather than silently reading from the
   * beginning, because a resume that quietly replays from zero re-delivers everything the client
   * already saw, which is the exact failure resumption exists to prevent.
   */
  readonly after?: string;
  /**
   * Maximum entries to return. CLAMPED by the platform to its own bound, so a caller can ask for more
   * and will not get it; absent ⇒ the platform default.
   */
  readonly limit?: number;
}

/** One bounded page of journal entries, oldest first. */
export interface HandlerJournalPage {
  /** The entries, in ascending recorded order. At most the effective `limit`. */
  readonly entries: readonly HandlerJournalEntry[];
  /**
   * The cursor to pass as `after` on the next read — the LAST entry's. ABSENT when `entries` is
   * empty (there is nothing to advance past, so a caller keeps the cursor it already had).
   */
  readonly nextCursor?: string;
  /**
   * TRUE when the read stopped at the effective `limit` and further entries were already waiting.
   * FALSE means the page reached the end of the journal AS OF THIS READ — never that no step will
   * ever be recorded again, because the journal is append-only and a later read may find more.
   */
  readonly hasMore: boolean;
}

/** The read door onto the run journal, bound to the invocation's server-derived tenant. */
export interface HandlerJournal {
  /** Read one bounded, ordered page of the tenant's journal entries. */
  read(query?: HandlerJournalQuery): Promise<HandlerJournalPage>;
}
