/**
 * The JOURNAL half of the contract — the entries a pack's work is recorded as.
 *
 * The run journal is the platform's reliability primitive: one transactional, append-only,
 * tenant-scoped record per step, and the single source of truth for replay, cost and audit. A pack
 * never inserts a row itself — it contributes the tool, store route or agent whose step the
 * platform journals on its behalf, under exactly the shape below. Naming the shape here is what
 * lets a pack read its own runs, correlate a step with the work that produced it, and assert on
 * both in its own tests without importing platform internals.
 *
 * IDEMPOTENCY IS THE LOAD-BEARING FIELD. `(runId, idempotencyKey)` is unique per tenant: a replay
 * of the same step returns the recorded output instead of re-running it. A contributed tool that
 * declares itself idempotent is promising exactly that, and the journal is where the promise is
 * kept — so a pack author reading a step is reading the replay decision, not a log line.
 *
 * WHAT THIS SURFACE PROMISES, AND WHAT IT DOES NOT. The fields below are the neutral ones: identity,
 * the step's own inputs and output, and its measured cost and latency. The stored record carries
 * further PLATFORM-OWNED accounting and provenance columns — which provider ran the step, how the
 * run authenticated, which pricing entry computed the cost — that are deliberately not part of this
 * contract: they name vocabulary a pack neither supplies nor chooses, and pinning a copy of it here
 * would freeze this surface to the platform's provider list. A reader must therefore treat the
 * record as OPEN: these fields are promised to be present and to mean this, never to be all of them.
 *
 * BOTH DIRECTIONS ARE CONTRACTED. The shapes above describe a value going IN — what a step is recorded
 * as. `PackJournalReader` below is the way back OUT: a typed, tenant-scoped, bounded page with a
 * stable cursor, handed to a route handler on its init. It exists because the alternative was a pack
 * naming the core's journal table and its column layout in a SQL string through the escape hatch —
 * an unversioned dependency on a core internal expressed as text, in the one package whose purpose is
 * that packs do not do this. What the read door is scoped to, and what it withholds, is stated on the
 * reader itself rather than left to be inferred from an absence.
 */

/** The kind of step recorded in the journal. */
export type PackJournalStepType = 'llm' | 'tool' | 'store';

/** How a step ended. A failed step is journaled, never dropped. */
export type PackJournalStatus = 'ok' | 'error';

/**
 * Token usage for a step. The three totals are always present; the remaining members are reported
 * only by providers that measure them, so a reader must treat their absence as "not reported"
 * rather than as zero.
 */
export interface PackTokenUsage {
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
 * One journal entry — the append-only record of a single step of a run. Every entry is tenant-scoped
 * by construction: the tenant is derived server-side, never supplied by the code that produced the
 * step.
 */
export interface PackJournalEntry {
  /** The step's own id. */
  readonly stepId: string;
  /** The run this step belongs to. */
  readonly runId: string;
  /** The tenant the run executed for — server-derived. */
  readonly tenantId: string;
  /** Which kind of step this is. */
  readonly type: PackJournalStepType;
  /** The replay key: identical `(runId, idempotencyKey)` returns the recorded output. */
  readonly idempotencyKey: string;
  /** A hash of the step input, for the replay lookup and for audit. */
  readonly inputHash: string;
  /** The step's output as recorded. Opaque data — its shape is the step's own concern. */
  readonly output: unknown;
  /** Token usage for the step. */
  readonly usage: PackTokenUsage;
  /** The computed cost of the step in USD. */
  readonly costUsd: number;
  /** Wall-clock duration of the step in milliseconds. */
  readonly latencyMs: number;
  /** Whether the step succeeded. */
  readonly status: PackJournalStatus;
  /** When the entry was recorded (ISO 8601). */
  readonly createdAt: string;
}

/**
 * ONE entry AS A READ RETURNS IT — the recorded entry plus the cursor naming its position in the read
 * order.
 *
 * The cursor belongs to the READ, not to the step, which is why it is added here rather than to
 * `PackJournalEntry`: that type stays exactly what the platform recorded, and a pack that constructs
 * one in its own tests is unaffected. OPAQUE — a pack passes it back as `PackJournalQuery.after`, or
 * emits it as the `id` of an incremental frame so a reconnecting client resumes from it, and never
 * parses, orders or constructs one.
 */
export interface PackJournalReadEntry extends PackJournalEntry {
  /** This entry's OPAQUE position marker. Pass it back as `after`, or emit it as a frame `id`. */
  readonly cursor: string;
}

/** What a journal read asks for. Every member is optional; `{}` reads the tenant's oldest page. */
export interface PackJournalQuery {
  /** Read only the steps of this run — the pack's own correlation id. Absent ⇒ every run. */
  readonly runId?: string;
  /**
   * Continue strictly AFTER this cursor (one an earlier entry of this same reader carried). Absent ⇒
   * start at the oldest entry. A cursor the reader cannot parse is REFUSED — the call rejects with an
   * `Error` whose `name` is `PackJournalCursorError` (the same typed-refusal idiom `PackDatabase`
   * uses) rather than silently reading from the beginning, because a resume that quietly replays from
   * zero re-delivers everything the client already saw, which is the exact failure resumption exists
   * to prevent.
   */
  readonly after?: string;
  /**
   * Maximum entries to return. CLAMPED by the deployment to its own bound, so a pack may ask for more
   * and will not get it; absent ⇒ the deployment's default.
   */
  readonly limit?: number;
}

/** One bounded page of journal entries, oldest first. */
export interface PackJournalPage {
  /** The entries, in ascending recorded order. At most the effective `limit`. */
  readonly entries: readonly PackJournalReadEntry[];
  /**
   * The cursor to pass as `after` on the next read — the LAST entry's. ABSENT when `entries` is empty
   * (there is nothing to advance past, so a pack keeps the cursor it already had).
   */
  readonly nextCursor?: string;
  /**
   * TRUE when the read stopped at the effective `limit` and further entries were already waiting.
   * FALSE means the page reached the end of the journal AS OF THIS READ — never that no step will
   * ever be recorded again, because the journal is append-only and a later read may find more.
   */
  readonly hasMore: boolean;
}

/**
 * The READ door onto the run journal — the counterpart of `PackJournalWriter`, and the reason a pack
 * no longer has to name a core table to read back what its work was recorded as.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT A PACK GETS HERE — AND, STATED RATHER THAN OMITTED, WHAT IT DOES NOT.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *  - ITS OWN TENANT, STRUCTURALLY. There is NO tenant parameter, for the same reason
 *    `PackJournalWriter` has none: the deployment builds the reader from the invocation's
 *    server-derived tenant and AND-combines that predicate beneath every read. A pack cannot name
 *    another tenant here, so there is nothing to get wrong.
 *  - THE TENANT'S JOURNAL, NOT A PER-PACK SLICE OF IT. The run journal is the tenant's single record
 *    of work, so a read sees every step recorded for that tenant — the deployment's own agent runs and
 *    another pack's contributions alike. This is a statement of what the journal IS, not an oversight:
 *    filter by `runId` (the correlation id a pack's own service wrote its steps under) to read back
 *    one unit of work rather than the tenant's whole history.
 *  - BOUNDED, ALWAYS. A read returns at most `limit` entries and `limit` is clamped by the deployment,
 *    so this door is not a drain: reading a long journal is a sequence of pages, each one asked for.
 *  - NO APPEND. There is no write verb here. A pack's own work reaches the journal through
 *    `PackJournalWriter` on a SERVICE context; a route handler records nothing itself.
 *  - THE NEUTRAL COLUMNS ONLY. The stored record carries further PLATFORM-OWNED accounting and
 *    provenance — which provider ran the step, how the run authenticated, which pricing entry computed
 *    the cost — that this contract deliberately does not name, exactly as this module's header already
 *    says of `PackJournalEntry`. Treat an entry as OPEN.
 */
export interface PackJournalReader {
  /** Read one bounded, ordered page of this tenant's journal entries. */
  read(query?: PackJournalQuery): Promise<PackJournalPage>;
}
