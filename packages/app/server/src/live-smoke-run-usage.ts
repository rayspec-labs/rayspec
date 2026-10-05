/**
 * The usage an agent run journaled, read once the run has ENDED.
 *
 * A durable agent run commits each statement as it is made, so what a run has written is visible
 * while it is still executing: a tool's effect (the row its handler wrote) and the tool's own journal
 * step — which carries no tokens — are both readable before the model's closing turn has returned.
 * An adapter that journals its model calls when the provider call returns (the OpenAI adapter writes
 * one `llm` step per model response after the SDK run resolves) has journaled NO usage at that point.
 * A tool's effect is therefore not a sign that the run is over; the run header is. This reads the
 * header until it is terminal and only then sums the run's own journal steps.
 *
 * Only counts and sums leave this module — never a step's output, the run's final text or its output
 * (all model I/O). The file is a pure helper with NO test-framework import, so it is safe if ever
 * emitted.
 */
import type postgres from 'postgres';

/** The run-header statuses a run can no longer leave. */
const ENDED_STATUSES: ReadonlySet<string> = new Set(['completed', 'error']);

/** What an ended agent run journaled: its header status and the sums over its own steps. */
export interface AgentRunUsage {
  /** The run header's terminal status (`completed` or `error`). */
  status: string;
  /** Every journaled step of the run, `llm` and `tool`. */
  steps: number;
  /** The `llm` steps — one per model response. */
  llmSteps: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** The computed cost, summed over the steps. */
  costUsd: number;
  /** The billed cost, summed over the steps (0 for a subscription run). */
  billedCostUsd: number;
}

export interface ReadEndedAgentRunUsageOptions {
  /** How long to wait for the run to end before giving up. Default 120 s. */
  timeoutMs?: number;
  /** The pause between two reads of the header. Default 250 ms. */
  pollMs?: number;
}

/**
 * Wait until the run `runId` has ended, then return the usage its journal steps carry. Rejects when
 * the header is not terminal within `timeoutMs`, naming the last status it read (or that no header
 * existed) — a run that never ends must not read as a run that used nothing.
 */
export async function readEndedAgentRunUsage(
  sql: postgres.Sql,
  runId: string,
  opts: ReadEndedAgentRunUsageOptions = {},
): Promise<AgentRunUsage> {
  const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
  const pollMs = opts.pollMs ?? 250;
  let status: string | undefined;
  for (;;) {
    const rows = (await sql.unsafe('SELECT status FROM runs WHERE run_id = $1', [
      runId,
    ])) as unknown as Array<{ status: string }>;
    status = rows[0]?.status;
    if (status !== undefined && ENDED_STATUSES.has(status)) break;
    if (Date.now() > deadline) {
      throw new Error(
        `run ${runId} did not end before the deadline (header status: ${status ?? '<no run row>'})`,
      );
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  const sums = (await sql.unsafe(
    `SELECT count(*)::int AS steps,
            count(*) FILTER (WHERE type = 'llm')::int AS llm_steps,
            coalesce(sum(input_tokens), 0)::float8 AS input_tokens,
            coalesce(sum(output_tokens), 0)::float8 AS output_tokens,
            coalesce(sum(total_tokens), 0)::float8 AS total_tokens,
            coalesce(sum(cost_usd), 0)::float8 AS cost_usd,
            coalesce(sum(billed_cost_usd), 0)::float8 AS billed_cost_usd
       FROM journal_steps WHERE run_id = $1`,
    [runId],
  )) as unknown as Array<{
    steps: number;
    llm_steps: number;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cost_usd: number;
    billed_cost_usd: number;
  }>;
  const s = sums[0];
  return {
    status,
    steps: s?.steps ?? 0,
    llmSteps: s?.llm_steps ?? 0,
    inputTokens: Number(s?.input_tokens ?? 0),
    outputTokens: Number(s?.output_tokens ?? 0),
    totalTokens: Number(s?.total_tokens ?? 0),
    costUsd: Number(s?.cost_usd ?? 0),
    billedCostUsd: Number(s?.billed_cost_usd ?? 0),
  };
}
