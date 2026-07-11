/**
 * The WORKER taint-aware quarantine contract test (DB-backed, REAL DBOS engine).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE HAZARD + THE QUARANTINE (RED-FIRST).
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Durability is WHOLE-RUN re-execution: a crashed `runAgentJob` re-runs the whole `runAgent`
 * fresh, re-firing any non-idempotent (`idempotent:false`) tool — a kill-class double-fire. A blunt
 * `run_started` guard would make EVERY interrupted run terminal-not-retried (safe but too coarse). The
 * worker's quarantine is instead TAINT-AWARE:
 *  - a TAINTED run (a non-idempotent tool fired ⇒ the chokepoint wrote the `run_taint` marker on its OWN
 *    autonomous connection, so it SURVIVES the crash) stays QUARANTINED — a recovery re-execution is
 *    REFUSED (no silent side-effect re-fire). [SAFETY — held]
 *  - an UNTAINTED run (idempotent / no tools) is now ALLOWED to re-run on a recovery re-execution
 *    (automated retry for the safe class), so a transient crash no longer permanently dead-letters a
 *    tool-light run. [NEW]
 *
 * SIMULATING A RECOVERY RE-EXECUTION (the honest, deterministic technique — same as the
 * `started-once` test). DBOS recovery re-invokes an incomplete workflow BODY; a same-workflowID
 * re-enqueue, by contrast, just returns the cached terminal status (the workflow-id idempotency law) —
 * so it does NOT re-drive the body. We therefore drive the body by PRE-SEEDING the `run_started` marker
 * (as a crashed first attempt would have committed) and enqueueing under that runId: the body re-runs,
 * loses the `run_started` reserve, and the TAINT marker decides quarantine-vs-retry.
 *
 * RED-FIRST: the UNTAINTED-retry test is RED on today's substrate (the blunt guard throws
 * DurableRunNotRetriedError → terminal-failed, `runAgent` never re-entered → `liveRuns` 0). The
 * taint-aware change makes it GREEN (the untainted run re-runs and completes → `liveRuns` 1). The
 * TAINTED-quarantine test asserts the safety property is NOT regressed.
 *
 * It also proves the LOAD-BEARING ordering fix: the taint marker must commit on an AUTONOMOUS connection
 * so it SURVIVES the run's rolled-back transaction (a fail-the-fix the worker path uniquely exercises —
 * the sync path runs runAgent outside a tx, so it would not catch a tx-bound marker).
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentSpec, NeutralTool } from '@rayspec/core';
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

// File-unique (pid-suffixed) names so a parallel fork of another file can NEVER collide on the same
// sys DB / app schema (fix A — the cross-file false-green hazard). This is the SECURITY file (the worker
// taint-aware quarantine proof); its determinism is load-bearing.
const PID = process.pid;
const APP_SCHEMA = `rayspec_test_dbos_taint_${PID}`;
const DBOS_SYS_DB = `rayspec_dbos_taint_${PID}_sys`;
const TENANT = '00000000-0000-0000-0000-0000000000bb';

const backend = new FakeSpineBackend();

/** A SIDE-EFFECT counter the non-idempotent tool bumps on every real fire (the ground truth). */
const sideEffects = { count: 0 };

const chargeTool: NeutralTool = {
  spec: {
    name: 'charge_card',
    description: 'a non-idempotent side effect',
    parameters: { type: 'object', properties: { q: { type: 'string' } } },
  },
  handler: (args) => {
    sideEffects.count += 1;
    return { charged: (args as { q?: string }).q ?? '' };
  },
  timeoutMs: 1000,
  idempotent: false,
};

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
 * Drop a sys DB WITHOUT `WITH (FORCE)` (fix A): a FORCE drop terminates a still-live engine's
 * pool/notification clients and can corrupt DBOS global state for the next-ordered file. We call this
 * only when no live engine should be attached (before launch / after a clean shutdown), with a short
 * retry to absorb a connection that is still closing.
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
 * Fix A — the security file must NOT be skippable-as-green: a CI assertion that the worker
 * taint-aware quarantine tests ACTUALLY RAN (incremented at the top of each it). A `beforeAll` throw
 * that skipped these (the prior harness bug) would leave this 0 → the meta-test FAILS the run, so a
 * skipped security file can never read as a passing (green) file.
 */
let securityTestsRan = 0;

async function waitForTerminal(jobId: string, ms = 30_000): Promise<string> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const s = await executor.status(jobId);
    if (s === 'succeeded' || s === 'failed' || s === 'cancelled') return s;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`workflow ${jobId} did not reach a terminal status within ${ms}ms`);
}

/** Pre-seed a `run_started` marker for `runId` (as a crashed first attempt would have committed). */
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

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required for the durable-dbos taint test');
  appBaseUrl = url;
  dbosSystemUrl = withDbName(url, DBOS_SYS_DB);

  // No live engine yet (we have not launched) — a plain drop of any leftover sys DB suffices.
  await dropSysDbSafely(url, DBOS_SYS_DB);

  db = makeDbWithSchema(url, APP_SCHEMA);
  await db.$client.unsafe(buildSpineSchemaSql(APP_SCHEMA));
  await db.$client.unsafe(`INSERT INTO orgs (id, name, slug) VALUES ($1, 'taint', 'taint')`, [
    TENANT,
  ]);

  const deps: DbosExecutorDeps = {
    db,
    resolveRun: (job: RunJob): ResolvedRun => {
      if (job.agentId === 'charge-agent') {
        return { backend, spec: baseSpec, tools: [chargeTool] };
      }
      if (job.agentId === 'echo-agent') {
        return { backend, spec: baseSpec };
      }
      throw new Error(`unknown agent '${job.agentId}'`);
    },
  };
  executor = new DbosDurableExecutor(deps, {
    name: `rayspec-taint-${PID}`,
    systemDatabaseUrl: dbosSystemUrl,
  });
  await executor.start();
}, 60_000);

beforeEach(async () => {
  backend.liveRuns = 0;
  backend.throwMidRunTimes = 0;
  backend.fireToolBeforeProceeding = false;
  sideEffects.count = 0;
  await db.$client.unsafe(
    'TRUNCATE run_events, journal_steps, conversation_items, runs, idempotency_keys CASCADE',
  );
});

afterAll(async () => {
  // AWAIT the engine shutdown (DBOS quiesces its pool/notification clients) BEFORE dropping the sys DB,
  // and drop WITHOUT WITH (FORCE) — the engine is already down, so there is no live backend to terminate.
  try {
    await executor.shutdown();
  } finally {
    await db.$client.end();
    await dropSysDbSafely(appBaseUrl, DBOS_SYS_DB);
  }
}, 30_000);

describe('DBOS worker taint-aware quarantine', () => {
  it('AUTONOMOUS-MARKER + TAINTED quarantine: a non-idempotent tool fires (writing the taint marker on its OWN connection that SURVIVES the run-tx rollback), and a recovery re-execution is REFUSED (the side effect fires EXACTLY ONCE)', async () => {
    securityTestsRan += 1; // fix A: prove this security test actually RAN (not skipped-as-green).
    // First run: fire charge_card (the side effect + the run-taint marker, written on the autonomous
    // taintDb), then crash mid-run. The crash rolls back runAgent's tx — but the taint marker (and the
    // run_started marker) committed OUTSIDE it, so both SURVIVE. This is the fail-the-fix for the
    // autonomous-commit fix: a tx-bound taint marker would be GONE here and the quarantine would miss.
    const runId = randomUUID();
    backend.fireToolBeforeProceeding = true;
    backend.throwMidRunTimes = 1;
    const job: RunJob = { runId, tenantId: TENANT, agentId: 'charge-agent', input: 'order-1' };

    const first = await executor.enqueue(TENANT, job);
    expect(await waitForTerminal(first.jobId)).toBe('failed');
    expect(sideEffects.count).toBe(1); // charged once, then crashed

    // The taint marker SURVIVED the rolled-back run tx (it committed on the autonomous connection).
    const taint = await db.$client.unsafe(
      'SELECT 1 FROM idempotency_keys WHERE tenant_id = $1 AND scope = $2 AND idem_key = $3',
      [TENANT, RUN_TAINT_SCOPE, runId],
    );
    expect(taint).toHaveLength(1);

    // Simulate a RECOVERY re-execution under a FRESH runId carrying the SAME (pre-seeded) markers — the
    // body re-runs, loses the run_started reserve, sees the run is TAINTED, and REFUSES to re-run.
    const recoveredRunId = randomUUID();
    await seedRunStarted(recoveredRunId);
    await seedRunTaint(recoveredRunId);
    backend.throwMidRunTimes = 0; // a re-run WOULD complete — proving the refusal is the taint guard
    const recovery = await executor.enqueue(TENANT, {
      runId: recoveredRunId,
      tenantId: TENANT,
      agentId: 'charge-agent',
      input: 'order-1',
    });
    expect(await waitForTerminal(recovery.jobId)).toBe('failed');
    await new Promise((r) => setTimeout(r, 200));
    // EXACTLY ONCE: the quarantine refused the re-run, so charge_card did NOT fire on the recovery.
    expect(sideEffects.count).toBe(1);
  });

  it('UNTAINTED retry allowed: a recovery re-execution of a run with NO taint marker IS re-run (automated retry for the safe class)', async () => {
    securityTestsRan += 1; // fix A: prove this security test actually RAN (not skipped-as-green).
    // Pre-seed ONLY a run_started marker (an interrupted run that started but is UNTAINTED — no
    // non-idempotent tool fired). On today's substrate the blunt guard throws → terminal-failed,
    // runAgent never re-entered (liveRuns 0) → RED. The taint-aware guard ALLOWS the re-run for the
    // untainted class → runAgent runs (liveRuns 1) and completes (succeeded).
    const runId = randomUUID();
    await seedRunStarted(runId); // started once, NO taint marker
    const job: RunJob = { runId, tenantId: TENANT, agentId: 'echo-agent', input: 'retry-me' };

    const recovery = await executor.enqueue(TENANT, job);
    expect(await waitForTerminal(recovery.jobId)).toBe('succeeded');
    expect(backend.liveRuns).toBe(1); // RE-RAN — automated retry for the safe (untainted) class
  });
});

// Fix A — the CI assertion that the security tests above ACTUALLY RAN. This is its OWN top-level describe
// (NO beforeAll dependency) registered LAST, so even if the main describe's beforeAll throws-and-skips its
// tests (the prior harness bug that hid a false-green on the quarantine invariant), `securityTestsRan`
// stays 0 and THIS test FAILS the run — a skipped security file can never read as a passing (green) file.
describe('DBOS worker taint-aware quarantine — ran-guard (fix A: not skippable-as-green)', () => {
  it('the worker taint-aware quarantine tests ACTUALLY RAN (both of them)', () => {
    expect(securityTestsRan).toBe(2);
  });
});
