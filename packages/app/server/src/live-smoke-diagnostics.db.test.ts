/**
 * DB-backed diagnostic proof (Lane 2 — needs DATABASE_URL): `logRedactedRunFailure` is
 * RUN-MODEL-AGNOSTIC and REDACTS across BOTH run models, exercised against a REAL throwaway DATABASE
 * (the platform migration chain), which the pure unit test cannot reach (the unit test never runs the
 * SQL). Two run models, one helper:
 *
 *   (a) WORKFLOW run — a failed `workflow_runs` header + a failed `workflow_node_states` node whose
 *       error `message` carries a PLANTED fake secret. The emitted line must name the WORKFLOW journal,
 *       surface the run status, and REDACT the planted secret.
 *   (b) AGENT run — a failed `runs` header (with model-I/O fields set) + `journal_steps`. The emitted
 *       line must name the AGENT journal, surface `runs.status` + a per-status step tally, and NEVER
 *       echo `runs.output` / `runs.final_text` / `journal_steps.output` (all model I/O).
 *   (c) A run absent from BOTH journals is reported explicitly (never a silent "no workflow row").
 *
 * This is the regression proof for the exact mis-wire it fixes: an `init.enqueue` agent run (the
 * lead-qualifier smoke) has a `randomUUID` run id stored in `runs`/`journal_steps` and is NEVER written
 * to `workflow_runs`, so the workflow-only diagnostic printed "no run row found" for every such failure.
 *
 * DB ISOLATION: a whole throwaway DATABASE (the migration chain materializes orgs + the platform run
 * journals). Un-skippable in CI (the ran-guard below).
 */
import { type Db, makeDb } from '@rayspec/db';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { applyMigrations } from './composition-root.js';
import { logRedactedRunFailure } from './live-smoke-diagnostics.js';

// A planted fake secret (single-line + inline gitleaks:allow — the secret-scan gate waves the
// intentionally realistic shape; it is never a real credential).
const PLANTED_WF_SECRET = 'sk-FAKEWORKFLOWKEY0123456789abcdefGHIJ'; // gitleaks:allow
// Marker strings for the model I/O that MUST NOT leak from the agent journal. Plain words (not
// secret-shaped), so no gitleaks concern; the point is they are stored on the run/step rows the
// diagnostic reads and must be ABSENT from its output.
const FINAL_TEXT_MARKER = 'MODEL_FINAL_TEXT_MUST_NOT_LEAK';
const RUN_OUTPUT_MARKER = 'MODEL_RUN_OUTPUT_MUST_NOT_LEAK';
const STEP_OUTPUT_MARKER = 'MODEL_STEP_OUTPUT_MUST_NOT_LEAK';

function adminUrl(url: string): string {
  const u = new URL(url);
  u.pathname = '/postgres';
  return u.toString();
}
function withDbName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

const SUITE_DB = `rayspec_live_diag_${process.pid}`;
const TENANT = '00000000-0000-4000-8000-0000000d1a90';
const WF_RUN = 'wf-run-diag-1';
// An agent run id has the randomUUID shape `init.enqueue` produces — NOT a workflow-run id.
const AGENT_RUN = '11111111-1111-4111-8111-111111111111';
const MISSING_RUN = 'no-such-run-anywhere';

// Ran-guard: a redaction/diagnostic proof must NEVER silently self-skip in CI (the false-green class).
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
let casesRan = 0;
const CASE_COUNT = 3;

describe('logRedactedRunFailure — run-model-agnostic redacted diagnostics (real DB)', () => {
  const baseUrl = process.env.DATABASE_URL;
  const maybe = baseUrl ? it : it.skip;
  let db: Db;
  let appDbUrl = '';

  beforeAll(async () => {
    if (!baseUrl) return;
    appDbUrl = withDbName(baseUrl, SUITE_DB);

    const admin = postgres(adminUrl(baseUrl), { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE "${SUITE_DB}"`);
    } finally {
      await admin.end();
    }

    db = makeDb(appDbUrl);
    await applyMigrations(db); // materialize orgs + the platform run journals (clean bootstrap)

    // The tenant (orgs row — the tenant_id FK target for every journal row below).
    await db.$client.unsafe('INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)', [
      TENANT,
      'DiagOrg',
      'diag-org',
    ]);

    // (a) WORKFLOW run: a terminal-failure header + a failed node whose error message carries a secret.
    await db.$client.unsafe(
      `INSERT INTO workflow_runs
         (workflow_run_id, tenant_id, workflow_id, idempotency_key, trigger_event, input_event, status, error)
       VALUES ($1, $2, 'wf', 'idem-1', 'test.event', $3::jsonb, 'terminal_failure', $4::jsonb)`,
      [
        WF_RUN,
        TENANT,
        JSON.stringify({ trigger: 'x' }),
        JSON.stringify({ code: 'workflow_failed', message: 'run aborted', retryable: false }),
      ],
    );
    await db.$client.unsafe(
      `INSERT INTO workflow_node_states
         (tenant_id, workflow_run_id, node_id, capability, operation, status, position, error)
       VALUES ($1, $2, 'extract', 'agent', 'run', 'terminal_failure', 0, $3::jsonb)`,
      [
        TENANT,
        WF_RUN,
        JSON.stringify({
          code: 'model_error',
          message: `upstream rejected key ${PLANTED_WF_SECRET}`,
          retryable: false,
        }),
      ],
    );

    // (b) AGENT run: a failed run header (model-I/O fields set) + two journal steps (output set).
    await db.$client.unsafe(
      `INSERT INTO runs
         (run_id, tenant_id, backend, auth_mode, agent_name, model, status, final_text, output)
       VALUES ($1, $2, 'openai', 'api_key', 'qualifier', 'gpt-5', 'error', $3, $4::jsonb)`,
      [AGENT_RUN, TENANT, FINAL_TEXT_MARKER, JSON.stringify({ verdict: RUN_OUTPUT_MARKER })],
    );
    await db.$client.unsafe(
      `INSERT INTO journal_steps
         (run_id, tenant_id, backend, type, idempotency_key, input_hash, status, auth_mode, output)
       VALUES ($1, $2, 'openai', 'agent_step', 'idem-step-1', 'hash-1', 'error', 'api_key', $3::jsonb)`,
      [AGENT_RUN, TENANT, JSON.stringify({ content: STEP_OUTPUT_MARKER })],
    );
    await db.$client.unsafe(
      `INSERT INTO journal_steps
         (run_id, tenant_id, backend, type, idempotency_key, input_hash, status, auth_mode, output)
       VALUES ($1, $2, 'openai', 'agent_step', 'idem-step-2', 'hash-2', 'completed', 'api_key', $3::jsonb)`,
      [AGENT_RUN, TENANT, JSON.stringify({ content: STEP_OUTPUT_MARKER })],
    );
  }, 120_000);

  afterAll(async () => {
    if (db) await db.$client.end();
    if (baseUrl) {
      const admin = postgres(adminUrl(baseUrl), { max: 1 });
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    }
  }, 60_000);

  /** Capture everything `logRedactedRunFailure` writes to stderr for one run id (read before restore). */
  async function capture(runId: string): Promise<string> {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await logRedactedRunFailure(db.$client, runId);
      return spy.mock.calls.map((c) => String(c[0])).join('');
    } finally {
      spy.mockRestore();
    }
  }

  maybe(
    'WORKFLOW run: names the workflow journal, surfaces the status, redacts the planted secret',
    async () => {
      const line = await capture(WF_RUN);
      // (i) the correct status; (ii) the correct journal.
      expect(line).toContain('journal=workflow');
      expect(line).toContain('status=terminal_failure');
      expect(line).toContain('code=model_error'); // the failed node's taxonomy code
      // (iii) the planted secret is gone, and the redaction marker is present.
      expect(line).not.toContain(PLANTED_WF_SECRET);
      expect(line).toContain('[REDACTED]');
      casesRan++;
    },
  );

  maybe(
    'AGENT run: names the agent journal, tallies steps by status, leaks NO model I/O',
    async () => {
      const line = await capture(AGENT_RUN);
      // (i) the correct status (from runs, not workflow_runs); (ii) the correct journal.
      expect(line).toContain('journal=agent');
      expect(line).toContain('status=error');
      // The per-status step tally (2 steps: one error, one completed).
      expect(line).toContain('completed:1');
      expect(line).toContain('error:1');
      // (iv) NONE of the model I/O stored on the run/steps leaks (runs.final_text/output, step.output).
      expect(line).not.toContain(FINAL_TEXT_MARKER);
      expect(line).not.toContain(RUN_OUTPUT_MARKER);
      expect(line).not.toContain(STEP_OUTPUT_MARKER);
      expect(line).not.toContain('final_text');
      casesRan++;
    },
  );

  maybe('a run absent from BOTH journals is reported explicitly', async () => {
    const line = await capture(MISSING_RUN);
    expect(line).toContain('journal=none');
    expect(line).toContain('no run row found in workflow or agent journal');
    casesRan++;
  });
});

/**
 * Ran-guard: a SEPARATE, non-skipped describe that FAILS the run when the DB is REQUIRED
 * (CI / RAYSPEC_REQUIRE_DB_TESTS) but the diagnostic cases did NOT run — a CI run that lost
 * DATABASE_URL would otherwise silently skip the redaction/run-model proof (the false-green class).
 * Local dev without a DB still skips ergonomically.
 */
describe('logRedactedRunFailure — ran-guard (the diagnostic proof must not silently skip in CI)', () => {
  it('the DB cases ACTUALLY RAN when the DB is required (CI / opt-in)', () => {
    if (dbRequired) {
      expect(casesRan).toBe(CASE_COUNT);
    } else {
      expect(dbRequired).toBe(false);
    }
  });
});
