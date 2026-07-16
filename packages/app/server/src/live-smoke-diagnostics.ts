/**
 * Redacted failure diagnostics for the live smokes.
 *
 * When a live smoke's durable run fails or times out, the bare assertion ("did not complete" / "did
 * not reach a terminal status") hides WHY. This surfaces the run's terminal status and error taxonomy
 * code — plus the first non-completed node's status, code and skip reason — as ONE line on stderr, so
 * a hand-triggered live run is triageable from its log alone. It is RUN-MODEL-AGNOSTIC: a declarative
 * workflow run is read from `workflow_runs` + `workflow_node_states`; an `init.enqueue` AGENT run
 * (a `runs` header + `journal_steps`, never a `workflow_runs` row) is read from that journal instead,
 * reporting the run status + a compact per-status step tally.
 *
 * Redaction is the whole point. A run/node error MESSAGE is a free-form provider string that can echo
 * a credential, so every message is passed through {@link redact} (credential-shaped masking + a
 * bounded length) before it is printed, and NOTHING else is ever logged — never a node output, an
 * attempts payload, the input event, or any prompt/model I/O. Only the safe taxonomy `code` (a short
 * platform enum) and a redacted `message` leave this module.
 *
 * The file is a pure helper with NO test-framework import, so it is safe if ever emitted.
 */
import type postgres from 'postgres';

/** The upper bound for any logged message; anything longer is truncated (after masking, never before). */
const MAX_MESSAGE_LEN = 300;

/** The neutral `{ code, message, retryable }` error shape stored on a run / node row (all fields loose). */
export interface RunErrorLike {
  code?: unknown;
  message?: unknown;
  retryable?: unknown;
}

/** The subset of a `workflow_runs` row this diagnostic reads. */
export interface RunFailureRow {
  status: string;
  error: RunErrorLike | null;
}

/** The subset of a `workflow_node_states` row this diagnostic reads. */
export interface NodeFailureRow {
  node_id: string;
  status: string;
  error: RunErrorLike | null;
  skipped_reason: string | null;
}

/**
 * Mask credential- and secret-shaped substrings in a free-form string, then bound its length. Applied
 * to EVERY message before it is logged. The explicit patterns cover the shapes a provider error can
 * echo — `Bearer <token>` / `Token <key>` auth headers (scheme kept, value masked), `sk-…` keys, a
 * `scheme://user:password@host` connection-string password (a DB connect error can echo the full DSN),
 * and a `Basic <base64>` auth header — and the generic ≥20-char base64/hex/token run catches any other
 * raw API key or JWT-like blob (real keys are long). The DSN and Basic patterns run BEFORE the generic
 * run precisely because those secrets are often SHORT or dotted (`:`/`@`/`.` break every run under the
 * 20-char floor), so the generic catch-all would miss them. Masking runs BEFORE truncation so a secret
 * can never survive by sitting past the cut, and newlines/tabs are collapsed so the result stays a
 * single log line.
 */
export function redact(value: unknown): string {
  let s = typeof value === 'string' ? value : String(value ?? '');
  s = s
    .replace(/[\r\n\t]+/g, ' ')
    // `Bearer <token>` / `Token <key>` auth headers — keep the scheme word, mask the credential.
    .replace(/\b(Bearer|Token)\s+[A-Za-z0-9._+/=-]{8,}/gi, '$1 [REDACTED]')
    // OpenAI-style prefixed keys (`sk-…`, `sk-proj-…`).
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/gi, '[REDACTED]')
    // Connection-string credentials (`scheme://user:PASSWORD@host`): mask ONLY the password, keeping
    // scheme/user/host visible for diagnostic value. The password is often short/dotted and slips
    // under the generic ≥20-char run, so this must run first.
    .replace(/(\/\/[^\s:/@]+:)[^\s@/]+(@)/g, '$1[REDACTED]$2')
    // `Basic <base64>` auth headers — keep the scheme word, mask the (possibly short) credential.
    .replace(/\b(Basic)\s+[A-Za-z0-9+/=]{4,}/gi, '$1 [REDACTED]')
    // Generic catch-all: any long base64 / hex / token run (raw keys, JWTs) is credential-shaped.
    .replace(/[A-Za-z0-9_+/=-]{20,}/g, '[REDACTED]');
  if (s.length > MAX_MESSAGE_LEN) s = `${s.slice(0, MAX_MESSAGE_LEN)}…[truncated]`;
  return s;
}

/** Coerce a taxonomy code to a short, single-line, un-redacted string (codes are safe platform enums). */
function codeOf(err: RunErrorLike | null | undefined): string {
  if (!err || err.code === undefined || err.code === null) return '<none>';
  return String(err.code)
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 80);
}

/**
 * Build the ONE-line, fully redacted diagnostic for a failed/timed-out run: the run status, its error
 * `code` and a redacted error `message`, and — for the first non-completed node — its id, status,
 * code, redacted message and skip reason. A `run` of `undefined` (the deadline hit before any run row
 * existed) is reported as such. This function is PURE (no I/O), which is what the unit test exercises.
 */
export function formatRedactedRunFailure(
  runId: string,
  run: RunFailureRow | undefined,
  nodes: readonly NodeFailureRow[],
): string {
  const parts: string[] = [`[live-run-diagnostic] run=${runId}`];
  if (!run) {
    parts.push('status=<no run row found>');
  } else {
    parts.push('journal=workflow', `status=${run.status}`, `code=${codeOf(run.error)}`);
    parts.push(`message="${run.error ? redact(run.error.message) : ''}"`);
  }
  const node = nodes.find((n) => n.status !== 'completed');
  if (node) {
    parts.push(
      `| node id=${node.node_id} status=${node.status} code=${codeOf(node.error)} ` +
        `message="${node.error ? redact(node.error.message) : ''}" ` +
        `skippedReason=${node.skipped_reason ?? '<none>'}`,
    );
  }
  return parts.join(' ');
}

/** A per-status count of a run's journal steps (`SELECT status, count(*) … GROUP BY status`). */
export interface StepStatusCount {
  status: string;
  n: number;
}

/**
 * Build the ONE-line diagnostic for a failed AGENT run — a run whose state lives in the `runs` header +
 * the `journal_steps` journal (an `init.enqueue` agent run has a `randomUUID` run id and is NEVER
 * written to `workflow_runs`). Only the safe run `status` (a platform enum) and a COMPACT per-status
 * step tally leave this helper — NEVER `runs.output` / `runs.final_text` / `journal_steps.output`
 * (all MODEL I/O). PURE (no I/O), which is what the unit test exercises.
 */
export function formatRedactedAgentRunFailure(
  runId: string,
  status: string,
  steps: readonly StepStatusCount[],
): string {
  const tally = steps.length
    ? steps.map((s) => `${codeOf({ code: s.status })}:${s.n}`).join(', ')
    : '<none>';
  return `[live-run-diagnostic] run=${runId} journal=agent status=${status} steps=${tally}`;
}

/**
 * Read the failed run for `runId` and write ONE redacted diagnostic line to stderr — RUN-MODEL-AGNOSTIC.
 * A declarative workflow run lives in `workflow_runs` + `workflow_node_states`; an `init.enqueue` AGENT
 * run lives in `runs` + `journal_steps` and is NEVER written to `workflow_runs`. So this queries the
 * workflow journal first and, only if there is no workflow header, FALLS BACK to the agent journal (the
 * run status + a compact per-status step tally) — never printing model I/O from either journal. If the
 * run is in neither journal, that is said explicitly. Best-effort: a diagnostic must never mask the
 * real failure, so a query error here is itself noted (redacted) and swallowed — the caller's original
 * throw/assert is what surfaces.
 */
export async function logRedactedRunFailure(sql: postgres.Sql, runId: string): Promise<void> {
  try {
    const runRows = (await sql.unsafe(
      'SELECT status, error FROM workflow_runs WHERE workflow_run_id = $1',
      [runId],
    )) as unknown as RunFailureRow[];
    if (runRows[0]) {
      const nodeRows = (await sql.unsafe(
        'SELECT node_id, status, error, skipped_reason FROM workflow_node_states ' +
          "WHERE workflow_run_id = $1 AND status <> 'completed' ORDER BY position ASC",
        [runId],
      )) as unknown as NodeFailureRow[];
      process.stderr.write(`${formatRedactedRunFailure(runId, runRows[0], nodeRows)}\n`);
      return;
    }
    // No workflow header → this is an AGENT run. Its state lives in the run header + journal steps.
    // Log ONLY the safe status + a per-status step tally — NEVER runs.output/final_text or step.output.
    const agentRows = (await sql.unsafe('SELECT status FROM runs WHERE run_id = $1', [
      runId,
    ])) as unknown as Array<{ status: string }>;
    if (agentRows[0]) {
      const stepRows = (await sql.unsafe(
        'SELECT status, count(*)::int AS n FROM journal_steps WHERE run_id = $1 GROUP BY status ORDER BY status ASC',
        [runId],
      )) as unknown as StepStatusCount[];
      process.stderr.write(
        `${formatRedactedAgentRunFailure(runId, agentRows[0].status, stepRows)}\n`,
      );
      return;
    }
    // The run is in neither journal — say so explicitly (never a silent "no workflow row" for an
    // agent run that WAS present).
    process.stderr.write(
      `[live-run-diagnostic] run=${runId} journal=none status=<no run row found in workflow or agent journal>\n`,
    );
  } catch (err) {
    process.stderr.write(
      `[live-run-diagnostic] run=${runId}: could not read run diagnostics: ${redact(
        err instanceof Error ? err.message : String(err),
      )}\n`,
    );
  }
}
