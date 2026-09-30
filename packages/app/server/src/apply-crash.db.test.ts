/**
 * Apply after a crash, with REAL processes: each arm starts `__fixtures__/apply-crash/child.mts` as its
 * own process, lets it run an apply to a named point, kills it there with SIGKILL, and then restarts —
 * a new apply, or a boot's platform chain — in this process, which reconciles from the receipts and
 * the live state.
 *
 * WHAT THESE ARMS PROVE, on ground truth (receipt rows, probe rows, tables, a file):
 *  1. Killed after the intent and before any step: the restart closes the operation as interrupted,
 *     reports that no step had started, and applies.
 *  2. Killed after a step started and before its effect: the observer reads the state from before,
 *     so the step is closed as not applied, and the restart applies it once.
 *  3. Killed after a step's effect and before its finish receipt: the observer reads the expected
 *     state, so the step is closed as applied and is NOT run again.
 *  4. Killed after the product DDL's statements ran and before their transaction committed: the start
 *     receipt without a finish proves the rollback, the live schema shows no table, and the restart
 *     applies the DDL.
 *  5. Killed after the platform migration chain committed and before its finish receipt: a boot
 *     reconciles the step as applied from the live ledger.
 *  6. Killed after an effect nothing can read back: the restart is blocked with
 *     `RAY_RECONCILIATION_REQUIRED` (exit class 6), again on every attempt and on a boot's schema
 *     change (a boot with nothing to change warns and serves), and the effect is never repeated;
 *     once an operator records the outcome, applies run again.
 *
 * Skips without DATABASE_URL; the ran-guard hard-fails a REQUIRED run that did not run.
 */
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exitCodeFor } from '@rayspec/bundle-contract';
import { type Db, makeDb } from '@rayspec/db';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  control,
  liveRevision,
  markerStep,
  observers,
  probePlan,
  query,
} from './__fixtures__/apply-crash/scenario.mjs';
import {
  type ApplyStep,
  type ReconciledOperation,
  resolveInterruptedStep,
  runApply,
} from './apply-operation.js';
import { applyMigrations } from './composition-root.js';
import { DeployApply, RuntimeApplyError } from './deploy-apply.js';
import { readOperationReceipts } from './operation-lease.js';
import { readProductSchemaDigest, runtimePlatformHead } from './schema-head.js';

const here = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(here, '..');
const CHILD = join(here, '__fixtures__', 'apply-crash', 'child.mts');

const baseUrl = process.env.DATABASE_URL;
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (dbRequired && !baseUrl) {
  throw new Error(
    'apply-crash.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — ' +
      'refusing to silently skip this DB-backed suite.',
  );
}
let armsRan = 0;

const SUITE_DB = `rayspec_apply_crash_${process.pid}`;
/** Long enough for the child's lease (1.5 s) to expire and be taken over. */
const LEASE_WAIT_MS = 15_000;

function withDbName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

const key = () => randomBytes(12).toString('hex');

interface Killed {
  operationId: string;
  output: string;
}

describe.skipIf(!baseUrl)('apply after a crash', () => {
  let dbUrl = '';
  let sql: postgres.Sql;
  let dir = '';
  const handles: Db[] = [];
  function processDb(): Db {
    const db = makeDb(dbUrl, 3);
    handles.push(db);
    return db;
  }

  /**
   * Run the child until it prints the checkpoint, then SIGKILL it and wait for it to be gone, and for
   * its database sessions to end (a killed client's open transaction is rolled back then).
   */
  async function runAndKill(
    scenario: string,
    killAt: string,
    extra: Record<string, string> = {},
  ): Promise<Killed> {
    const operationId = randomUUID();
    const child = spawn(process.execPath, ['--import', 'tsx', CHILD], {
      cwd: PACKAGE_DIR,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        APPLY_DB_URL: dbUrl,
        APPLY_SCENARIO: scenario,
        APPLY_KILL_AT: killAt,
        APPLY_OPERATION_ID: operationId,
        APPLY_KEY: key(),
        ...extra,
      },
    });
    let output = '';
    child.stdout.on('data', (d: Buffer) => {
      output += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      output += d.toString();
    });
    const exited = new Promise<number | null>((res) => child.on('exit', (code) => res(code)));
    const deadline = Date.now() + 30_000;
    while (!output.includes(`CHECKPOINT ${killAt}`)) {
      if (child.exitCode !== null || Date.now() > deadline) {
        child.kill('SIGKILL');
        throw new Error(`the child never reached ${killAt}: ${output}`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    child.kill('SIGKILL');
    await exited;
    expect(child.signalCode).toBe('SIGKILL');
    // The server notices the dead client and ends its sessions, rolling back what was open.
    const until = Date.now() + 15_000;
    for (;;) {
      const [row] = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM pg_stat_activity
         WHERE datname = ${SUITE_DB} AND pid <> pg_backend_pid()
           AND application_name <> 'apply-crash-suite' AND state LIKE 'idle in transaction%'`;
      if (row?.n === '0' || Date.now() > until) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return { operationId, output };
  }

  /** The operation a legacy boot started (it chooses its own id): the latest to start `step`. */
  async function startedBy(step: string): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      SELECT operation_id::text AS id FROM runtime_control_receipts
       WHERE event = 'step-started' AND step = ${step} ORDER BY id DESC LIMIT 1`;
    return row?.id as string;
  }

  async function markers(): Promise<string[]> {
    return (await sql<{ marker: string }[]>`SELECT marker FROM apply_probe ORDER BY marker`).map(
      (r) => r.marker,
    );
  }

  async function restartApply(db: Db, steps: ApplyStep[]) {
    const reports: ReconciledOperation[] = [];
    const planDigest = await probePlan(db, 'probe');
    const result = await runApply({
      db,
      request: control(randomUUID(), planDigest, await liveRevision(db), key()),
      plan: { recompute: () => probePlan(db, 'probe') },
      steps,
      observers: observers(db),
      leaseWaitMs: LEASE_WAIT_MS,
      onReconciled: (ops) => reports.push(...ops),
    });
    return { result, reports };
  }

  async function events(operationId: string) {
    return (await readOperationReceipts(processDb(), operationId)).map((r) => ({
      event: r.event,
      step: r.step,
      outcome: r.outcome,
      detail: r.detail,
    }));
  }

  beforeAll(async () => {
    if (!baseUrl) return;
    dbUrl = withDbName(baseUrl, SUITE_DB);
    const admin = postgres(withDbName(baseUrl, 'postgres'), { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE "${SUITE_DB}"`);
    } finally {
      await admin.end();
    }
    await applyMigrations(processDb());
    sql = postgres(dbUrl, { max: 2, connection: { application_name: 'apply-crash-suite' } });
    await sql`CREATE TABLE apply_probe (marker text PRIMARY KEY)`;
    dir = mkdtempSync(join(tmpdir(), 'rayspec-apply-crash-'));
  }, 60_000);

  beforeEach(async () => {
    if (!baseUrl) return;
    await sql`DELETE FROM apply_probe`;
  });

  afterAll(async () => {
    for (const h of handles) await h.$client.end().catch(() => {});
    await sql?.end();
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
    if (!baseUrl) return;
    const admin = postgres(withDbName(baseUrl, 'postgres'), { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  });

  it('killed after the intent: the restart closes the operation as interrupted and applies', async () => {
    const killed = await runAndKill('marker', 'after-intent');
    expect(await markers()).toEqual([]);
    const db = processDb();
    const { result, reports } = await restartApply(db, [markerStep(db, 'restart')]);
    expect(result.errors).toEqual([]);
    expect(reports).toContainEqual({ operationId: killed.operationId, steps: [], settled: true });
    const record = await events(killed.operationId);
    expect(record.map((e) => e.event)).toEqual(['intent', 'outcome']);
    expect(record[1]).toMatchObject({ outcome: 'failed', detail: { interrupted: true } });
    expect(await markers()).toEqual(['restart']);
    armsRan += 1;
  }, 90_000);

  it('killed after a step started, before its effect: reconciled as not applied, then applied once', async () => {
    const killed = await runAndKill('marker', 'after-step-started');
    expect(await markers()).toEqual([]);
    const db = processDb();
    const { result, reports } = await restartApply(db, [markerStep(db, 'restart')]);
    expect(result.errors).toEqual([]);
    expect(reports).toContainEqual({
      operationId: killed.operationId,
      steps: [{ step: 'mark', observed: 'not-applied', state: '0' }],
      settled: true,
    });
    expect((await events(killed.operationId)).map((e) => [e.event, e.step])).toEqual([
      ['intent', null],
      ['step-started', 'mark'],
      ['step-skipped', 'mark'],
      ['outcome', null],
    ]);
    expect(result.data?.receipts).toEqual([
      expect.objectContaining({ step: 'mark', state: 'done' }),
    ]);
    expect(await markers()).toEqual(['restart']);
    armsRan += 1;
  }, 90_000);

  it('killed after a step took effect, before its receipt: reconciled as applied and not run again', async () => {
    const killed = await runAndKill('marker', 'after-step-effect');
    // The child's insert committed on its own connection before it was killed.
    expect(await markers()).toEqual(['child']);
    const db = processDb();
    const { result, reports } = await restartApply(db, [markerStep(db, 'restart')]);
    expect(result.errors).toEqual([]);
    expect(reports).toContainEqual({
      operationId: killed.operationId,
      steps: [{ step: 'mark', observed: 'applied', state: '1' }],
      settled: true,
    });
    const record = await events(killed.operationId);
    expect(record.map((e) => [e.event, e.step])).toEqual([
      ['intent', null],
      ['step-started', 'mark'],
      ['step-finished', 'mark'],
      ['outcome', null],
    ]);
    expect(record[2]?.detail).toMatchObject({
      observed: 'applied',
      reconciledBy: result.operationId,
    });
    expect(result.data?.receipts).toEqual([
      expect.objectContaining({ step: 'mark', state: 'skipped' }),
    ]);
    expect(await markers()).toEqual(['child']);
    armsRan += 1;
  }, 90_000);

  it('killed after the product DDL ran and before it committed: the schema is unchanged and the restart applies it', async () => {
    const db = processDb();
    const before = await readProductSchemaDigest(query(db));
    await runAndKill('legacy-product', 'after-step-effect');
    const killed = { operationId: await startedBy('product-ddl') };
    const [tables] = await sql<{ a: boolean; b: boolean }[]>`
      SELECT to_regclass('public.crash_a') IS NOT NULL AS a,
             to_regclass('public.crash_b') IS NOT NULL AS b`;
    expect(tables).toEqual({ a: false, b: false });
    expect(await readProductSchemaDigest(query(db))).toBe(before);

    // The restart is a boot: its platform chain has nothing to apply but reconciles first.
    const warnings: string[] = [];
    const boot = new DeployApply({
      db,
      migratePlatform: () => applyMigrations(db),
      specSource: 'apply-crash',
      warn: (line) => warnings.push(line),
    });
    await boot.platformChain();
    expect(warnings.join('\n')).toContain(`interrupted deploy operation ${killed.operationId}`);
    expect(warnings.join('\n')).toContain('product-ddl: not-applied');
    const record = await events(killed.operationId);
    expect(record.map((e) => [e.event, e.step])).toEqual([
      ['intent', null],
      ['step-started', 'product-ddl'],
      ['step-skipped', 'product-ddl'],
      ['outcome', null],
    ]);
    expect(record[2]?.detail).toMatchObject({ observed: 'not-applied', state: before });

    await boot.productMigration({
      name: '0000_product_stores.sql',
      sql: 'CREATE TABLE "crash_a" ("id" text PRIMARY KEY);',
    });
    const after = await readProductSchemaDigest(query(db));
    expect(after).not.toBe(before);
    const [state] = await sql<{ applied: string }[]>`
      SELECT applied_product_schema AS applied FROM runtime_control_state WHERE id = 1`;
    expect(state?.applied).toBe(after);
    await sql`DROP TABLE crash_a`;
    armsRan += 1;
  }, 90_000);

  it('killed after the platform chain committed and before its receipt: a boot reconciles it as applied', async () => {
    // One migration behind this runtime, as a database left by the previous release is.
    await sql`DROP TABLE runtime_control_processes`;
    await sql`DELETE FROM drizzle.__drizzle_migrations
               WHERE created_at = (SELECT max(created_at) FROM drizzle.__drizzle_migrations)`;
    await runAndKill('legacy-platform', 'after-step-effect');
    const killed = { operationId: await startedBy('platform-migrations') };
    const [ledger] = await sql<{ present: boolean }[]>`
      SELECT to_regclass('public.runtime_control_processes') IS NOT NULL AS present`;
    expect(ledger?.present).toBe(true);

    const db = processDb();
    const warnings: string[] = [];
    await new DeployApply({
      db,
      migratePlatform: () => applyMigrations(db),
      specSource: 'apply-crash',
      warn: (line) => warnings.push(line),
    }).platformChain();
    expect(warnings.join('\n')).toContain('platform-migrations: applied');
    const record = await events(killed.operationId);
    expect(record.map((e) => [e.event, e.step])).toEqual([
      ['intent', null],
      ['step-started', 'platform-migrations'],
      ['step-finished', 'platform-migrations'],
      ['outcome', null],
    ]);
    expect(record[1]?.detail).toMatchObject({ after: runtimePlatformHead() });
    expect(record[2]?.detail).toMatchObject({ observed: 'applied', state: runtimePlatformHead() });
    armsRan += 1;
  }, 90_000);

  it('an effect nothing can read back blocks every restart until an operator records it, and is never repeated', async () => {
    const file = join(dir, 'external.log');
    const killed = await runAndKill('external', 'after-step-effect', { APPLY_EXTERNAL_FILE: file });
    expect(readFileSync(file, 'utf8')).toBe('child\n');

    const db = processDb();
    const external: ApplyStep = {
      kind: 'effect',
      name: 'notify-external',
      run: async () => {
        throw new Error('a blocked apply must not run its steps');
      },
    };
    const first = await restartApply(db, [external]);
    expect(first.result.ok).toBe(false);
    expect(first.result.errors[0]).toMatchObject({
      code: 'RAY_RECONCILIATION_REQUIRED',
      retryable: false,
    });
    expect(first.result.errors[0]?.message).toContain(killed.operationId);
    expect(exitCodeFor(first.result.errors)).toBe(6);
    expect(first.reports).toContainEqual({
      operationId: killed.operationId,
      steps: [{ step: 'notify-external', observed: 'unknown', state: null }],
      settled: false,
    });

    // Still blocked on the next attempt. A boot with nothing to change warns and serves; its schema
    // change is refused with the same code and exit class.
    const second = await restartApply(db, [markerStep(db, 'blocked')]);
    expect(second.result.errors[0]).toMatchObject({ code: 'RAY_RECONCILIATION_REQUIRED' });
    // Two restarts with nothing to change: each warns, and neither writes a receipt or takes the lease.
    const written = async () =>
      await sql`SELECT (SELECT count(*)::int FROM runtime_control_receipts) AS receipts,
                       lease_epoch::int AS epoch, lease_operation_id::text AS holder,
                       environment_revision::int AS revision
                  FROM runtime_control_state WHERE id = 1`;
    const beforeRestarts = await written();
    const bootWarnings: string[] = [];
    let boot: DeployApply | undefined;
    for (let restart = 1; restart <= 2; restart += 1) {
      boot = new DeployApply({
        db,
        migratePlatform: () => applyMigrations(db),
        warn: (line) => bootWarnings.push(line),
      });
      await boot.platformChain();
      expect(await written(), `restart ${restart}`).toEqual(beforeRestarts);
      expect(bootWarnings.length, `restart ${restart}`).toBe(restart);
      expect(bootWarnings[restart - 1]).toContain('every schema change is refused');
      expect(bootWarnings[restart - 1]).toContain(killed.operationId);
    }
    if (boot === undefined) throw new Error('no restart ran');
    const refused = await boot
      .productMigration({ name: 'blocked.sql', sql: 'CREATE TABLE blocked_ddl (id int);' })
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(refused).toBeInstanceOf(RuntimeApplyError);
    expect(refused).toMatchObject({ code: 'RAY_RECONCILIATION_REQUIRED', exitCode: 6 });
    const [blockedTable] = await sql<{ present: boolean }[]>`
      SELECT to_regclass('public.blocked_ddl') IS NOT NULL AS present`;
    expect(blockedTable?.present).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe('child\n');
    expect(await markers()).toEqual([]);

    // The operator establishes the notification went out and records it.
    const resolved = await resolveInterruptedStep(db, {
      operationId: randomUUID(),
      actor: 'operator@example.test',
      interruptedOperationId: killed.operationId,
      step: 'notify-external',
      outcome: 'applied',
    });
    expect(resolved).toEqual({ ok: true, settled: true });
    const record = await events(killed.operationId);
    expect(record.map((e) => [e.event, e.step])).toEqual([
      ['intent', null],
      ['step-started', 'notify-external'],
      ['step-finished', 'notify-external'],
      ['outcome', null],
    ]);
    expect(record[2]?.detail).toMatchObject({ manual: true, observed: 'applied' });

    const unblocked = await restartApply(db, [markerStep(db, 'unblocked')]);
    expect(unblocked.result.errors).toEqual([]);
    expect(await markers()).toEqual(['unblocked']);
    expect(readFileSync(file, 'utf8')).toBe('child\n');
    expect(existsSync(file)).toBe(true);
    armsRan += 1;
  }, 90_000);
});

// The un-skippable ran-guard: a REQUIRED DB run that silently skipped is a false green.
it('DB-backed arms actually ran when the environment requires them', () => {
  if (dbRequired) expect(armsRan).toBe(6);
  else expect(true).toBe(true);
});
