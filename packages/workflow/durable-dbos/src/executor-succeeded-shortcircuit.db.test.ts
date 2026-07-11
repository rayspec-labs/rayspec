/**
 * The WORKER already-succeeded SHORT-CIRCUIT contract test (DB-backed, REAL DBOS engine).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE HAZARD (TEST-FLAKE-2 — the double-MODEL-BILL window) + THE SHORT-CIRCUIT (RED-FIRST).
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Durability is WHOLE-RUN re-execution. run-core commits the `runs` header (`status='completed'`) at
 * the END of the first `runAgent`, yet DBOS can still RE-DISPATCH the (already-succeeded) workflow — a
 * step-outcome checkpoint lost under load. This is the observed cron-scheduler flake
 * (`cron-scheduler.db.test.ts` "enqueues runAgentJob exactly once" intermittently saw `liveRuns === 2`).
 * On that re-dispatch the run reserves the `run_started` marker, finds it already exists, reads taint =
 * UNTAINTED, and — WITHOUT the fix — FALLS THROUGH and re-invokes `runAgent` for a result that is
 * ALREADY DURABLE → the model is BILLED A SECOND TIME.
 *
 * THE FIX (`executor.ts` `#runAgentJobBody`): after the taint check confirms UNTAINTED and BEFORE the
 * fall-through re-run, read the `runs` header; if it is already terminal-SUCCESS ('completed') complete
 * the step as a NO-OP (`readRunSucceededWithBoundedRetry` → `return`). A genuinely-interrupted untainted
 * run (no completed header) STILL re-runs (the unchanged safe automated retry), and a TAINTED run is
 * STILL quarantined (the taint check runs first) — the short-circuit keys on DURABLE SUCCESS, never on
 * "any recovery".
 *
 * SIMULATING A RECOVERY RE-EXECUTION (the honest, deterministic technique — same as the taint file).
 * DBOS recovery re-invokes an incomplete workflow BODY; a same-workflowID re-enqueue, by contrast, just
 * returns the cached terminal status (the workflow-id idempotency law). We therefore drive the body by
 * PRE-SEEDING the markers a crashed/re-dispatched first attempt would have committed (`run_started`
 * [+ `run_taint`] via the tenant-scoped raw factory) AND, for the succeeded case, the `runs` HEADER (and
 * DELIBERATELY NOT the journal — seeding only the header isolates THIS executor short-circuit as the
 * thing under test; a journal is unnecessary because the executor path NEVER passes `replayRunId`, so
 * `replay = Boolean(opts.replayRunId)` (run-core.ts:237) is always false here and `backend.run` is
 * UNCONDITIONAL regardless of any journal — the `runs` header is the SOLE gate this short-circuit reads),
 * then enqueueing under that runId: the body re-runs and the header decides re-run-vs-skip.
 *
 * RED-FIRST: test #1 (short-circuit fires) is RED on the pre-fix substrate (no header short-circuit →
 * the untainted fall-through re-runs → `liveRuns` increments to 1 = the double-bill reproduces). The
 * fix makes it GREEN (`liveRuns` stays 0). Tests #2-#4 are the fail-the-fix guards: #2 proves the
 * short-circuit does NOT fire on a genuine interruption (no completed header → still re-runs), #3
 * proves it does NOT bypass the taint quarantine (a tainted run with a completed header STILL
 * quarantines), and #4 proves the short-circuit keys STRICTLY on status==='completed' — an 'error'
 * header does NOT short-circuit (still re-runs), so it isn't "any header present".
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentSpec } from '@rayspec/core';
import { forTenant, schema } from '@rayspec/db';
import { makeDbWithSchema } from '@rayspec/db/testing';
import { RUN_TAINT_SCOPE, type RunJob } from '@rayspec/platform';
import { config as loadDotenv } from 'dotenv';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DbosDurableExecutor,
  type DbosExecutorDeps,
  type ResolvedRun,
  RUN_STARTED_SCOPE,
} from './executor.js';
import { FakeSpineBackend } from './test-support/fake-backend.js';
import { buildSpineSchemaSql } from './test-support/schema-ddl.js';

const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, '..', '..', '..', '..', '.env');
if (existsSync(envPath)) loadDotenv({ path: envPath });

// File-unique (pid-suffixed) names + a DISTINCT token from every other DB file so a fork of another
// file can NEVER collide on the same sys DB / app schema (the cross-file false-green hazard).
const PID = process.pid;
const APP_SCHEMA = `rayspec_test_dbos_shortcircuit_${PID}`;
const DBOS_SYS_DB = `rayspec_dbos_shortcircuit_${PID}_sys`;
const TENANT = '00000000-0000-0000-0000-0000000000cc';

const backend = new FakeSpineBackend();

const baseSpec: AgentSpec = {
  name: 'echo',
  instructions: 'echo the input',
  model: 'gpt-4.1-mini',
  input: 'placeholder',
  tools: [],
  maxTurns: 4,
};

type DbHandle = ReturnType<typeof makeDbWithSchema>;
let db: DbHandle;
let executor: DbosDurableExecutor;
let dbosSystemUrl: string;
let appBaseUrl: string;

function withDbName(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

/**
 * Drop a sys DB WITHOUT `WITH (FORCE)`: a FORCE drop terminates a still-live engine's pool/notification
 * clients and can corrupt DBOS global state for the next-ordered file. We call this only when no live
 * engine should be attached (before launch / after a clean shutdown), with a short retry.
 */
async function dropSysDbSafely(baseUrl: string, sysDb: string): Promise<void> {
  const admin = postgres(withDbName(baseUrl, 'postgres'), { max: 1 });
  try {
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${sysDb}"`);
        return;
      } catch (e) {
        if (attempt === 5) throw e;
        await new Promise((r) => setTimeout(r, 200 * attempt));
      }
    }
  } finally {
    await admin.end();
  }
}

/**
 * The security-shaped ran-guard: this DB file must NOT be skippable-as-green. Each `it` bumps this at
 * its top; the LAST describe (no beforeAll dependency) asserts it reached the expected count, so a
 * beforeAll throw that skipped these tests can never read as a passing (green) file.
 */
let testsRan = 0;

async function waitForTerminal(jobId: string, ms = 30_000): Promise<string> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const s = await executor.status(jobId);
    if (s === 'succeeded' || s === 'failed' || s === 'cancelled') return s;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`workflow ${jobId} did not reach a terminal status within ${ms}ms`);
}

/** Pre-seed a `run_started` marker for `runId` (as a crashed/re-dispatched first attempt committed). */
async function seedRunStarted(runId: string): Promise<void> {
  await forTenant(db, TENANT)
    .insert(schema.idempotencyKeys, {
      scope: RUN_STARTED_SCOPE,
      idemKey: runId,
      bodyHash: runId,
      snapshot: { runId },
    })
    .onConflictDoNothing();
}

/** Pre-seed a `run_taint` marker for `runId` (as a crashed-after-non-idempotent-tool run would have). */
async function seedRunTaint(runId: string): Promise<void> {
  await forTenant(db, TENANT)
    .insert(schema.idempotencyKeys, {
      scope: RUN_TAINT_SCOPE,
      idemKey: runId,
      bodyHash: 'run_taint_marker',
      snapshot: { runId },
    })
    .onConflictDoNothing();
}

/**
 * Pre-seed a minimal valid `runs` HEADER at the given `status` for `runId` — as the first attempt's
 * run-core commit would have left it. tenantId is auto-stamped by the tenant-scoped insert.
 * DELIBERATELY seeds ONLY the header (no journal_steps / run_events) so the short-circuit under test —
 * not run-core's journal replay — is what a re-dispatch keys on (see the file banner's SIMULATING note).
 */
async function seedRunHeader(runId: string, status: 'completed' | 'error'): Promise<void> {
  await forTenant(db, TENANT)
    .insert(schema.runs, {
      runId,
      backend: 'openai',
      authMode: 'api-key',
      agentName: baseSpec.name,
      model: baseSpec.model,
      status,
      finalText: `echo: ${runId}`,
    })
    .onConflictDoNothing();
}

/** Pre-seed a terminal-SUCCESS ('completed') `runs` header — the short-circuit-eligible case. */
async function seedRunSucceeded(runId: string): Promise<void> {
  await seedRunHeader(runId, 'completed');
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url)
    throw new Error('DATABASE_URL required for the durable-dbos succeeded-short-circuit test');
  appBaseUrl = url;
  dbosSystemUrl = withDbName(url, DBOS_SYS_DB);

  // No live engine yet (we have not launched) — a plain drop of any leftover sys DB suffices.
  await dropSysDbSafely(url, DBOS_SYS_DB);

  db = makeDbWithSchema(url, APP_SCHEMA);
  await db.$client.unsafe(buildSpineSchemaSql(APP_SCHEMA));
  await db.$client.unsafe(`INSERT INTO orgs (id, name, slug) VALUES ($1, 'sc', 'sc')`, [TENANT]);

  const deps: DbosExecutorDeps = {
    db,
    resolveRun: (job: RunJob): ResolvedRun => {
      if (job.agentId === 'echo-agent') {
        return { backend, spec: baseSpec };
      }
      throw new Error(`unknown agent '${job.agentId}'`);
    },
  };
  executor = new DbosDurableExecutor(deps, {
    name: `rayspec-shortcircuit-${PID}`,
    systemDatabaseUrl: dbosSystemUrl,
  });
  await executor.start();
}, 60_000);

beforeEach(async () => {
  backend.liveRuns = 0;
  backend.throwMidRunTimes = 0;
  backend.fireToolBeforeProceeding = false;
  await db.$client.unsafe(
    'TRUNCATE run_events, journal_steps, conversation_items, runs, idempotency_keys CASCADE',
  );
});

afterAll(async () => {
  try {
    await executor.shutdown();
  } finally {
    await db.$client.end();
    await dropSysDbSafely(appBaseUrl, DBOS_SYS_DB);
  }
}, 30_000);

describe('DBOS worker already-succeeded short-circuit (TEST-FLAKE-2)', () => {
  it('SHORT-CIRCUITS a re-dispatch of an already-completed UNTAINTED run: runAgent is NOT re-invoked (no double model bill)', async () => {
    testsRan += 1;
    // Seed the durable artifacts a succeeded first attempt left behind: the run_started marker + a
    // terminal-SUCCESS `runs` header (NO taint, NO journal). A re-dispatch under this runId must
    // detect the completed header and complete as a no-op — never re-running the backend.
    const runId = randomUUID();
    await seedRunStarted(runId);
    await seedRunSucceeded(runId);
    const job: RunJob = { runId, tenantId: TENANT, agentId: 'echo-agent', input: 'retry-me' };

    const recovery = await executor.enqueue(TENANT, job);
    expect(await waitForTerminal(recovery.jobId)).toBe('succeeded');
    // RED-FIRST tell: WITHOUT the fix this is 1 (the untainted fall-through re-ran runAgent = the
    // double bill). WITH the fix the completed-header short-circuit keeps it 0 (no re-run, no re-bill).
    expect(backend.liveRuns).toBe(0);
  });

  it('does NOT short-circuit a GENUINE interruption (run_started only, no completed header): the untainted run STILL re-runs (safe automated retry)', async () => {
    testsRan += 1;
    // Pre-seed ONLY a run_started marker (an interrupted-but-untainted run that started but never
    // committed a completed header). The short-circuit keys on DURABLE SUCCESS, not on "any recovery",
    // so this MUST fall through and re-run — proving the fix did not blunt the safe-class retry.
    const runId = randomUUID();
    await seedRunStarted(runId);
    const job: RunJob = { runId, tenantId: TENANT, agentId: 'echo-agent', input: 'genuine' };

    const recovery = await executor.enqueue(TENANT, job);
    expect(await waitForTerminal(recovery.jobId)).toBe('succeeded');
    expect(backend.liveRuns).toBe(1); // RE-RAN — the untainted safe-class automated retry is unchanged.
  });

  it('does NOT bypass the TAINT quarantine even with a completed header: a tainted run re-dispatch is STILL REFUSED', async () => {
    testsRan += 1;
    // The taint check runs BEFORE the succeeded short-circuit. Seed run_started + run_taint + a
    // completed header: the re-dispatch must QUARANTINE (terminal-failed), NOT short-circuit-to-success
    // off the header — proving the ordering (taint-first) and that the short-circuit never re-fires a
    // side effect by "resurrecting" a tainted-but-header-completed run.
    const runId = randomUUID();
    await seedRunStarted(runId);
    await seedRunTaint(runId);
    await seedRunSucceeded(runId);
    const job: RunJob = { runId, tenantId: TENANT, agentId: 'echo-agent', input: 'tainted' };

    const recovery = await executor.enqueue(TENANT, job);
    expect(await waitForTerminal(recovery.jobId)).toBe('failed'); // DurableRunNotRetriedError quarantine
    await new Promise((r) => setTimeout(r, 200));
    expect(backend.liveRuns).toBe(0); // never re-ran — the taint quarantine held ahead of the header.
  });

  it('does NOT short-circuit an "error" header: the short-circuit keys STRICTLY on status===\'completed\', not on "any header present"', async () => {
    testsRan += 1;
    // Seed run_started + a `runs` header at status='error' (NOT 'completed') for an UNTAINTED runId —
    // as a genuinely-failed first attempt would have left it. The short-circuit reads MUST reject this
    // (RUN_STATUS_SUCCEEDED === 'completed' only), so the re-dispatch STILL re-runs — proving the fix
    // does not treat "a header exists" as "already succeeded".
    const runId = randomUUID();
    await seedRunStarted(runId);
    await seedRunHeader(runId, 'error');
    const job: RunJob = { runId, tenantId: TENANT, agentId: 'echo-agent', input: 'errored-header' };

    const recovery = await executor.enqueue(TENANT, job);
    expect(await waitForTerminal(recovery.jobId)).toBe('succeeded');
    expect(backend.liveRuns).toBe(1); // RE-RAN — an 'error' header does NOT short-circuit.
  });
});

// The ran-guard: registered LAST + no beforeAll dependency, so even if the main describe's beforeAll
// throws-and-skips its tests, `testsRan` stays 0 and THIS test FAILS the run — a skipped file can never
// read as a passing (green) file.
describe('DBOS worker already-succeeded short-circuit — ran-guard (not skippable-as-green)', () => {
  it('the short-circuit tests ACTUALLY RAN (all four)', () => {
    expect(testsRan).toBe(4);
  });
});
