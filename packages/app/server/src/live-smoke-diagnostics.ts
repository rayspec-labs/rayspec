/**
 * Redacted failure diagnostics for the live smokes.
 *
 * When a live smoke's durable run fails or times out, the bare assertion ("did not complete" / "did
 * not reach a terminal status") hides WHY. This surfaces the run's terminal status and error taxonomy
 * code — plus the first non-completed node's status, code and skip reason — as ONE line on stderr, so
 * a hand-triggered live run is triageable from its log alone.
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
 * echo — `Bearer <token>` / `Token <key>` auth headers (scheme kept, value masked), `sk-…` keys — and
 * the generic ≥20-char base64/hex/token run catches any other raw API key or JWT-like blob (real keys
 * are long). Masking runs BEFORE truncation so a secret can never survive by sitting past the cut, and
 * newlines/tabs are collapsed so the result stays a single log line.
 */
export function redact(value: unknown): string {
  let s = typeof value === 'string' ? value : String(value ?? '');
  s = s
    .replace(/[\r\n\t]+/g, ' ')
    // `Bearer <token>` / `Token <key>` auth headers — keep the scheme word, mask the credential.
    .replace(/\b(Bearer|Token)\s+[A-Za-z0-9._+/=-]{8,}/gi, '$1 [REDACTED]')
    // OpenAI-style prefixed keys (`sk-…`, `sk-proj-…`).
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/gi, '[REDACTED]')
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
    parts.push(`status=${run.status}`, `code=${codeOf(run.error)}`);
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

/**
 * Read the failed run + its non-completed node states for `runId` and write ONE redacted diagnostic
 * line to stderr. Best-effort: a diagnostic must never mask the real failure, so a query error here is
 * itself noted (redacted) and swallowed — the caller's original throw/assert is what surfaces.
 */
export async function logRedactedRunFailure(sql: postgres.Sql, runId: string): Promise<void> {
  try {
    const runRows = (await sql.unsafe(
      'SELECT status, error FROM workflow_runs WHERE workflow_run_id = $1',
      [runId],
    )) as unknown as RunFailureRow[];
    const nodeRows = (await sql.unsafe(
      'SELECT node_id, status, error, skipped_reason FROM workflow_node_states ' +
        "WHERE workflow_run_id = $1 AND status <> 'completed' ORDER BY position ASC",
      [runId],
    )) as unknown as NodeFailureRow[];
    process.stderr.write(`${formatRedactedRunFailure(runId, runRows[0], nodeRows)}\n`);
  } catch (err) {
    process.stderr.write(
      `[live-run-diagnostic] run=${runId}: could not read run diagnostics: ${redact(
        err instanceof Error ? err.message : String(err),
      )}\n`,
    );
  }
}
