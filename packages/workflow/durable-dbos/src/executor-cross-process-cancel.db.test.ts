/**
 * Cancelling a run that a SECOND, REAL WORKER PROCESS is executing — DB-backed, the real DBOS engine
 * in the child, the real database for both.
 *
 * The child (`test-support/worker-process.ts`) launches its own `DbosDurableExecutor`, enqueues one
 * run and executes it; the run's provider call is held until the run's signal aborts it. This process
 * does what the cancel surface of ANOTHER process does — it writes the cancellation marker and the
 * terminal record on its own connection — and never signals the child. So whatever ends the run in
 * the child came through the database.
 *
 *  - MANAGED POSTURE: the child runs with `RAYSPEC_HOSTING_POSTURE=managed`, so its run re-reads its
 *    cancellation record every 2000 ms. The run ends within that interval plus a margin, its call is
 *    aborted, the workflow completes as accounted for, and the record states `call-aborted` — refined
 *    by the child over the `outcome-unknown` this side wrote, because only the child saw the call stop.
 *    The step the run journaled before it was ended is kept.
 *  - PAIRED CONTROL: without the posture or an interval the same marker does not end the child's run.
 *
 * This file never skips: it throws without DATABASE_URL, and the ran-guard fails a file that did not
 * run its arms.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forTenant } from '@rayspec/db';
import { makeDbWithSchema } from '@rayspec/db/testing';
import { markRunCancelled, recordRunCancelled } from '@rayspec/platform';
import { config as loadDotenv } from 'dotenv';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildSpineSchemaSql } from './test-support/schema-ddl.js';
import type { WorkerProcessConfig } from './test-support/worker-process.js';

const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, '..', '..', '..', '..', '.env');
if (existsSync(envPath)) loadDotenv({ path: envPath });

const PID = process.pid;
const APP_SCHEMA = `rayspec_test_dbos_xproc_${PID}`;
const TENANT = '00000000-0000-0000-0000-0000000000c7';
const CHILD_PATH = join(here, 'test-support', 'worker-process.ts');
/** The managed posture's default poll interval: the deadline a cancellation must meet, plus a margin. */
const MANAGED_POLL_MS = 2_000;
const MARGIN_MS = 2_500;

type DbHandle = ReturnType<typeof makeDbWithSchema>;
let db: DbHandle;
let appBaseUrl: string;
let testsRan = 0;
const children: ChildProcess[] = [];
const sysDbs: string[] = [];

function withDbName(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

async function dropSysDb(sysDb: string): Promise<void> {
  const admin = postgres(withDbName(appBaseUrl, 'postgres'), { max: 1 });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${sysDb}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

interface ChildArm {
  readonly inCall: Promise<void>;
  readonly done: Promise<{ status: string; sawAbort: boolean }>;
}

/** Spawn the worker process for one run, with `env` added to (and the posture variables removed from) this process's environment. */
function spawnWorker(runId: string, sysDb: string, env: Record<string, string>): ChildArm {
  const cfg: WorkerProcessConfig = {
    appUrl: appBaseUrl,
    appSchema: APP_SCHEMA,
    systemDatabaseUrl: withDbName(appBaseUrl, sysDb),
    name: `rayspec-xproc-${PID}-${sysDb}`,
    tenantId: TENANT,
    runId,
  };
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv.RAYSPEC_HOSTING_POSTURE;
  delete childEnv.RAYSPEC_RUN_CANCEL_POLL_MS;
  Object.assign(childEnv, env);
  const child = spawn(process.execPath, ['--import', 'tsx', CHILD_PATH, JSON.stringify(cfg)], {
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let resolveInCall: () => void = () => {};
  let rejectAll: (e: Error) => void = () => {};
  let resolveDone: (v: { status: string; sawAbort: boolean }) => void = () => {};
  const inCall = new Promise<void>((res, rej) => {
    resolveInCall = res;
    rejectAll = rej;
  });
  let rejectDone: (e: Error) => void = () => {};
  const done = new Promise<{ status: string; sawAbort: boolean }>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });
  let buffered = '';
  let stderr = '';
  let settled = false;
  child.stderr?.on('data', (c: Buffer) => {
    stderr += c.toString();
  });
  child.stdout?.on('data', (c: Buffer) => {
    buffered += c.toString();
    let nl = buffered.indexOf('\n');
    while (nl >= 0) {
      const line = buffered.slice(0, nl).trim();
      buffered = buffered.slice(nl + 1);
      if (line.startsWith('{')) {
        const msg = JSON.parse(line) as Record<string, unknown>;
        if (msg.phase === 'in-call') resolveInCall();
        if (msg.phase === 'done') {
          settled = true;
          resolveDone(msg as unknown as { status: string; sawAbort: boolean });
        }
        if (msg.phase === 'crashed') {
          const err = new Error(`worker crashed: ${String(msg.message)}`);
          rejectAll(err);
          rejectDone(err);
        }
      }
      nl = buffered.indexOf('\n');
    }
  });
  child.on('exit', (code) => {
    if (settled) return;
    const err = new Error(
      `worker exited (code ${String(code)}) before reporting; stderr:\n${stderr}`,
    );
    rejectAll(err);
    rejectDone(err);
  });
  return { inCall, done };
}

/** What the cancel surface of another process does: the marker, then the terminal record. */
async function cancelFromHere(runId: string): Promise<void> {
  const tdb = forTenant(db, TENANT);
  await markRunCancelled(tdb, runId);
  await recordRunCancelled(tdb, runId, { phase: 'outcome-unknown' });
}

async function steps(runId: string): Promise<Array<{ type: string; phase: string | null }>> {
  return (await db.$client.unsafe(
    "SELECT type, output->>'phase' AS phase FROM journal_steps WHERE run_id = $1 ORDER BY type",
    [runId],
  )) as unknown as Array<{ type: string; phase: string | null }>;
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required for the cross-process cancellation test');
  if (!existsSync(CHILD_PATH)) throw new Error(`worker fixture missing at ${CHILD_PATH}`);
  appBaseUrl = url;
  db = makeDbWithSchema(url, APP_SCHEMA);
  await db.$client.unsafe(buildSpineSchemaSql(APP_SCHEMA));
  await db.$client.unsafe(`INSERT INTO orgs (id, name, slug) VALUES ($1, 'xp', 'xp')`, [TENANT]);
}, 60_000);

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

afterAll(async () => {
  for (const sysDb of sysDbs) await dropSysDb(sysDb).catch(() => {});
  const admin = postgres(appBaseUrl, { max: 1 });
  try {
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${APP_SCHEMA}" CASCADE`);
  } finally {
    await admin.end();
  }
  await db.$client.end();
}, 60_000);

describe('cancelling a run executing in a second worker process', () => {
  it('MANAGED POSTURE: the run ends within the poll interval, its call is aborted, and the record says so', async () => {
    testsRan += 1;
    const runId = randomUUID();
    const sysDb = `rayspec_dbos_xproc_${PID}_managed`;
    sysDbs.push(sysDb);
    await dropSysDb(sysDb);
    const worker = spawnWorker(runId, sysDb, { RAYSPEC_HOSTING_POSTURE: 'managed' });
    await worker.inCall;

    const cancelledAt = Date.now();
    await cancelFromHere(runId);
    const outcome = await worker.done;
    const tookMs = Date.now() - cancelledAt;

    // The child's provider call was told to stop, through the database alone, within the deadline.
    expect(outcome.sawAbort).toBe(true);
    expect(tookMs).toBeLessThan(MANAGED_POLL_MS + MARGIN_MS);
    // The workflow completed as accounted for: a cancelled run is not an engine failure.
    expect(outcome.status).toBe('succeeded');
    const header = (await db.$client.unsafe('SELECT status FROM runs WHERE run_id = $1', [
      runId,
    ])) as unknown as Array<{ status: string }>;
    expect(header[0]?.status).toBe('error');
    // The step the run journaled before it was ended is kept, and the cancellation states what the
    // EXECUTING process saw: the call was aborted (this side could only say `outcome-unknown`).
    expect(await steps(runId)).toEqual([
      { type: 'cancel', phase: 'call-aborted' },
      { type: 'llm', phase: null },
    ]);
  }, 90_000);

  it('PAIRED CONTROL: without the posture or an interval the same marker does not end the run', async () => {
    testsRan += 1;
    const runId = randomUUID();
    const sysDb = `rayspec_dbos_xproc_${PID}_local`;
    sysDbs.push(sysDb);
    await dropSysDb(sysDb);
    const worker = spawnWorker(runId, sysDb, {});
    await worker.inCall;
    await cancelFromHere(runId);
    const outcome = await Promise.race([
      worker.done.then(() => 'ended' as const),
      new Promise<'still running'>((r) =>
        setTimeout(() => r('still running'), MANAGED_POLL_MS + MARGIN_MS),
      ),
    ]);
    expect(outcome).toBe('still running');
    // This side's record stands, and says only what this side could know.
    expect(await steps(runId)).toEqual([
      { type: 'cancel', phase: 'outcome-unknown' },
      { type: 'llm', phase: null },
    ]);
  }, 90_000);
});

describe('cross-process cancellation — ran-guard', () => {
  it('both arms ACTUALLY RAN', () => {
    expect(testsRan).toBe(2);
  });
});
