/**
 * The RECORD-NORMALIZER PORT — the injected, tenant-bound seam through which a submitted record is
 * transformed by a declared agent BEFORE it is persisted. PRODUCT- AND PLATFORM-NEUTRAL by design:
 * this package never imports the platform's agent-invocation machinery (Tier-B purity — the model /
 * backend / instructions are CONFIG-side); it exchanges only plain values. The LIVE implementation
 * (the real neutral agent path, structured output against the declared contract) lives OUTSIDE this
 * capability in the compose layer, wired by the deployment; tests inject a deterministic fake.
 *
 * TENANT LAW: the binding builds a normalizer per request via `factory(init.tenantId)` — the
 * SERVER-DERIVED tenant, never a client value (the sink/responder factory trust shape).
 *
 * IDEMPOTENCY: `submit` runs the normalizer ONLY on the FIRST persist of a record (see submit.ts).
 * The record's idempotency identity stays the RAW submitted input, so a re-submit converges on the
 * already-stored normalized value and NEVER re-invokes a (possibly non-deterministic) agent.
 */

/**
 * The outcome of ONE normalize invocation. `normalized` carries the transformed record (a plain JSON
 * object of business fields); `error` is a fail-closed rejection the submit path surfaces (persisting
 * nothing). The core additionally re-validates a `normalized` value against the record's structural
 * shape before storing it (a normalize step cannot produce an invalid stored row).
 */
export type RecordNormalizeOutcome =
  | { readonly status: 'normalized'; readonly record: Record<string, unknown> }
  | { readonly status: 'error'; readonly errorClass?: string; readonly message: string };

/**
 * A tenant-bound record normalizer. `normalize` receives the shape-validated raw record plus its
 * client-supplied `record_id` (DATA — never a tenant signal) and returns the outcome. It must be
 * SAFE TO CALL AGAIN for the same record (the live impl may attach to a completed run instead of
 * re-invoking the model — the crash-window convergence path).
 */
export interface RecordNormalizer {
  /** The normalizer's agent id (config-derived; the normalize run's agent name). */
  readonly agentId: string;
  normalize(args: {
    readonly record: Record<string, unknown>;
    readonly recordId: string;
  }): Promise<RecordNormalizeOutcome>;
}

/** Build a tenant-bound normalizer for one request (tenantId is SERVER-DERIVED — `init.tenantId`). */
export type RecordNormalizerFactory = (tenantId: string) => RecordNormalizer;
