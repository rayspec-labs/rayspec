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
