/**
 * BACKUP AND RESTORE, over a database holding live workforce work.
 *
 * The core ships no backup tool and this suite does not pretend otherwise — `deploy.ts:67-77` says
 * "Backup/PITR is deferred", and `docs/ARCHITECTURE.md` → "Restore and key rotation" is guidance
 * about EXTERNALLY produced dumps. What a self-hoster actually runs is stock Postgres:
 * `pg_dump -Fc` into a file, `pg_restore` into a fresh database. So what has to be proven is not a
 * feature but a PROPERTY: that the shipped schema and the shipped engine survive that round trip
 * intact and RESUME, rather than merely being present.
 *
 * The distinction matters, because the two things a restore can silently lose are not rows.
 *
 *   1. `workforce_tasks.version` — the optimistic CAS token `applyTransition` compare-and-swaps on.
 *      Lose it and every row is still there while no parked task can ever be claimed again.
 *   2. `workforce_tasks.last_event_seq` / `workforce_runtime.last_event_seq` — the journal sequence
 *      HEADs. Allocation rides the owning row's own counter (events.ts:125-134, :147-158) and
 *      `run_events` carries UNIQUE(tenant_id, run_id, seq) (0004_run_events.sql:36), so a restore
 *      that reset a counter would not fail at restore time. It would fail on the very NEXT append,
 *      as a duplicate key, which is the last place an operator would look.
 *
 * Both are counters, both compare equal to "the table has the right number of rows", and both are
 * asserted here on their own terms rather than left to a deep-equal to imply.
 *
 * THE FIXTURE IS WRITTEN BY THE SHIPPED ENGINE WRITERS, never by hand-rolled INSERTs — the approach
 * the flag-off preservation proof established next door (`serve-workforce-flag.db.test.ts`). Rows
 * invented by a test can drift from what the engine emits, and a restore proof over rows the engine
 * would never produce proves nothing about the engine.
 *
 * The negative arms are IN the suite rather than a one-off manual mutation: each restores the same
 * dump into a third, sabotage-only database, breaks exactly one of the two counters (or deletes a
 * table's rows), and asserts the oracle function reports it. Teeth that live in the suite cannot rot
 * out of it.
 *
 * WHAT THIS SUITE DOES NOT CLAIM: nothing here is point-in-time recovery, WAL archiving, or a
 * scheduled backup. It is one dump, one restore, and the engine coming up on the result. The DBOS
 * SYSTEM database is a SEPARATE database (executor.ts:119-124) and is deliberately NOT in the dump —
 * the restored deployment gets a fresh one, which is exactly why the resume has to work off the
 * application rows alone.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forTenant, makeDb } from '@rayspec/db';
import {
  DbosDurableExecutor,
  DbosTaskScheduler,
  type ReservePassOutcome,
  type TaskTurnHandler,
  taskTurnWorkflowId,
} from '@rayspec/durable-dbos';
import {
  appendTaskEvents,
  appendWorkforceEvents,
  applyTransition,
  applyTurnOutcome,
  cancelTaskCascade,
  createRootTask,
  deliverSignal,
  ensureWorkforceRuntime,
  type TaskRecord,
  workforceBudgetsSchema,
} from '@rayspec/tasks';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from './composition-root.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (requireDb && !hasDb) {
  throw new Error(
    'backup-restore.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — refusing to silently skip.',
  );
}

/**
 * The two binaries the whole criterion is about. They are NOT a repo dependency — they are the
 * operator's Postgres client tools — so their absence is reported as a hard failure under the same
 * rule that governs a missing database: a required run may not silently become a pass. CI lane 2
 * already invokes `psql` on the runner host (`.github/workflows/ci.yml`, "Create shadow DB"), and
 * pg_dump/pg_restore ship in the same postgresql-client package.
 */
function toolVersion(bin: string): string | null {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
  return r.status === 0 ? (r.stdout ?? '').trim() : null;
}
const PG_DUMP_VERSION = hasDb ? toolVersion('pg_dump') : null;
const PG_RESTORE_VERSION = hasDb ? toolVersion('pg_restore') : null;
if (hasDb && requireDb && (PG_DUMP_VERSION === null || PG_RESTORE_VERSION === null)) {
  throw new Error(
    'backup-restore.db.test: pg_dump and pg_restore must be on PATH (CI / RAYSPEC_REQUIRE_DB_TESTS) — ' +
      'this suite IS the backup/restore criterion and cannot be proven without them. ' +
      `pg_dump=${String(PG_DUMP_VERSION)} pg_restore=${String(PG_RESTORE_VERSION)}`,
  );
}
const canRun = hasDb && PG_DUMP_VERSION !== null && PG_RESTORE_VERSION !== null;

const PID = process.pid;
const SRC_DB = `rayspec_backup_src_${PID}`;
const RESTORED_DB = `rayspec_backup_restored_${PID}`;
const SABOTAGE_DB = `rayspec_backup_sabotage_${PID}`;
const DBOS_SYS_DB = `rayspec_backup_restored_${PID}_sys`;
/** Obviously synthetic — a plausible-looking id in a fixture is what trips the secret scanner. */
const TENANT = '00000000-0000-4000-8000-0000000000b7';
const WORKFORCE_ID = 'helpdesk';
/** A crontab that cannot fire inside a run: every pass here is driven explicitly. */
const NEVER = '0 0 0 1 1 *';

/** The nine tables migration 0012 creates — the whole tenant task graph. */
const WORKFORCE_TABLES = [
  'workforce_tasks',
  'workforce_task_transitions',
  'workforce_task_signals',
  'workforce_delegations',
  'workforce_approvals',
  'workforce_reviews',
  'workforce_messages',
  'workforce_budget_ledger',
  'workforce_runtime',
] as const;

const BUDGETS = {
  workforce: { usd: 40 },
  task: { usd: 2.5, turns: 12 },
  departments: { eng: { usd: 10 } },
  // maxConcurrentWorkers: 2 makes the post-restore dispatch DETERMINISTIC. The restored graph
  // already holds ONE `working` row (the turn that was in flight when the dump was taken), so the
  // cap leaves exactly one free slot; the urgent priority on the queued task decides who takes it,
  // and the fan-out children — promoted by the same pass — decline it.
  execution: { estimateUsdPerTurn: 0.2, maxConcurrentWorkers: 2 },
} as const;

type Client = ReturnType<typeof makeDb>['$client'];

/** Per-stream `count(*)` plus an md5 over the ORDERED full row text — "equal" means byte-equal. */
interface Census {
  readonly counts: Record<string, number>;
  readonly digests: Record<string, string>;
  /** The applied-migration count: equal on both sides is what makes a restored boot a no-op. */
  readonly migrations: number;
}

/** The two counters a restore can lose without losing a single row. */
interface Counters {
  readonly tasks: Record<string, { version: number; lastEventSeq: number; turnsUsed: number }>;
  readonly runtime: Record<string, number>;
}

function withDbName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}
function adminUrl(url: string): string {
  return withDbName(url, 'postgres');
}

async function census(client: Client): Promise<Census> {
  const counts: Record<string, number> = {};
  const digests: Record<string, string> = {};
  for (const table of WORKFORCE_TABLES) {
    const rows = (await client.unsafe(
      `SELECT count(*)::int AS c,
              md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS d
         FROM ${table} t WHERE t.tenant_id = '${TENANT}'`,
    )) as unknown as { c: number; d: string }[];
    counts[table] = rows[0]?.c ?? -1;
    digests[table] = rows[0]?.d ?? '';
  }
  // The journal, split by the two run_id namespaces the engine writes under (`<taskId>` for task
  // events, `workforce:<id>` for control events — events.ts:96-98). A census of the nine tables
  // alone would call a restore that lost the journal a success.
  for (const [key, predicate] of [
    ['run_events.task', "run_id NOT LIKE 'workforce:%'"],
    ['run_events.workforce', "run_id LIKE 'workforce:%'"],
  ] as const) {
    const rows = (await client.unsafe(
      `SELECT count(*)::int AS c,
              md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS d
         FROM run_events t WHERE t.tenant_id = '${TENANT}' AND ${predicate}`,
    )) as unknown as { c: number; d: string }[];
    counts[key] = rows[0]?.c ?? -1;
    digests[key] = rows[0]?.d ?? '';
  }
  const mig = (await client.unsafe(
    'SELECT count(*)::int AS c FROM drizzle.__drizzle_migrations',
  )) as unknown as { c: number }[];
  return { counts, digests, migrations: mig[0]?.c ?? -1 };
}

async function counters(client: Client): Promise<Counters> {
  const taskRows = (await client.unsafe(
    `SELECT task_id, version, last_event_seq, turns_used FROM workforce_tasks
      WHERE tenant_id = '${TENANT}' ORDER BY task_id`,
  )) as unknown as {
    task_id: string;
    version: number;
    last_event_seq: number;
    turns_used: number;
  }[];
  const tasks: Record<string, { version: number; lastEventSeq: number; turnsUsed: number }> = {};
  for (const r of taskRows) {
    tasks[r.task_id] = {
      version: Number(r.version),
      lastEventSeq: Number(r.last_event_seq),
      turnsUsed: Number(r.turns_used),
    };
  }
  const runtimeRows = (await client.unsafe(
    `SELECT workforce_id, last_event_seq FROM workforce_runtime
      WHERE tenant_id = '${TENANT}' ORDER BY workforce_id`,
  )) as unknown as { workforce_id: string; last_event_seq: number }[];
  const runtime: Record<string, number> = {};
  for (const r of runtimeRows) runtime[r.workforce_id] = Number(r.last_event_seq);
  return { tasks, runtime };
}

/** One row's full text, hashed — the "this row was not touched" oracle for a terminal task. */
async function rowDigest(client: Client, taskId: string): Promise<string> {
  const rows = (await client.unsafe(
    `SELECT md5(t::text) AS d FROM workforce_tasks t WHERE t.task_id = '${taskId}'`,
  )) as unknown as { d: string }[];
  return rows[0]?.d ?? '';
}

function run(bin: string, args: readonly string[]): { status: number | null; err: string } {
  const r = spawnSync(bin, [...args], { encoding: 'utf8', timeout: 300_000 });
  return { status: r.status, err: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describe.skipIf(!canRun)(
  'backup and restore — pg_dump/pg_restore over live workforce state',
  () => {
    let base = '';
    let dumpDir = '';
    let dumpFile = '';
    let srcDb: ReturnType<typeof makeDb> | undefined;
    let restoredDb: ReturnType<typeof makeDb> | undefined;
    let sabotageDb: ReturnType<typeof makeDb> | undefined;
    let executor: DbosDurableExecutor | undefined;
    let scheduler: DbosTaskScheduler | undefined;

    /** The graph, by shape — the ids every later phase asserts against. */
    const ids: {
      queued?: string;
      approvalPark?: string;
      structuralPark?: string;
      reviewPark?: string;
      midTurn?: string;
      completed?: string;
      failed?: string;
      cancelled?: string;
    } = {};
    let srcCensus: Census | undefined;
    let srcCounters: Counters | undefined;
    let armsRan = 0;

    async function admin<T>(fn: (c: ReturnType<typeof postgres>) => Promise<T>): Promise<T> {
      const c = postgres(adminUrl(base), { max: 1, onnotice: () => {} });
      try {
        return await fn(c);
      } finally {
        await c.end();
      }
    }

    async function dropAll(): Promise<void> {
      await admin(async (c) => {
        for (const name of [DBOS_SYS_DB, SABOTAGE_DB, RESTORED_DB, SRC_DB]) {
          await c.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
        }
      });
    }

    /** `pg_restore` the one dump into a FRESH database and hand back a pool bound to it. */
    async function restoreInto(name: string): Promise<ReturnType<typeof makeDb>> {
      await admin(async (c) => {
        await c.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
        await c.unsafe(`CREATE DATABASE "${name}"`);
      });
      const target = withDbName(base, name);
      const r = run('pg_restore', [
        '--exit-on-error',
        '--no-owner',
        '--no-privileges',
        '-d',
        target,
        dumpFile,
      ]);
      expect(r.status, `pg_restore into ${name} failed: ${r.err}`).toBe(0);
      return makeDb(target, 4);
    }

    beforeAll(async () => {
      if (!canRun) return;
      base = process.env.DATABASE_URL as string;
      dumpDir = mkdtempSync(join(tmpdir(), 'rayspec-backup-'));
      dumpFile = join(dumpDir, 'workforce.dump');
      await dropAll();
      await admin((c) => c.unsafe(`CREATE DATABASE "${SRC_DB}"`));
      srcDb = makeDb(withDbName(base, SRC_DB), 4);
      // The REAL programmatic migrator, so what gets dumped is the database an operator has.
      await applyMigrations(srcDb);
      await srcDb.$client.unsafe(
        `INSERT INTO orgs (id, name, slug) VALUES ('${TENANT}', 'Backup', 'backup')`,
      );
    }, 240_000);

    afterAll(async () => {
      try {
        await executor?.shutdown();
      } catch {
        // a shutdown failure must not mask the assertion that already ran
      }
      await srcDb?.$client.end();
      await restoredDb?.$client.end();
      await sabotageDb?.$client.end();
      if (!canRun) return;
      await dropAll();
      if (dumpDir) rmSync(dumpDir, { recursive: true, force: true });
    }, 180_000);

    it('phase 1 — live workforce state in every interesting shape, written by the shipped writers', async () => {
      const db = srcDb as ReturnType<typeof makeDb>;
      const tdb = forTenant(db, TENANT);
      const budgets = workforceBudgetsSchema.parse(BUDGETS);
      await ensureWorkforceRuntime(tdb, WORKFORCE_ID, BUDGETS);

      const turnIdFor = (taskId: string, n: number) => `wf-task-turn:${taskId}:${n}`;
      const newRoot = (over: Record<string, unknown>) =>
        createRootTask(tdb, {
          workforceId: WORKFORCE_ID,
          title: 'Work',
          goal: 'Do it',
          owner: 'dev',
          requestedBy: 'user',
          department: 'eng',
          ...over,
        });
      const toQueued = (task: TaskRecord) =>
        applyTransition(tdb, {
          taskId: task.taskId,
          expectedVersion: task.version,
          to: 'queued',
          actor: 'scheduler',
        });
      const toWorking = async (task: TaskRecord, n = 1) => {
        const queued = await toQueued(task);
        return applyTransition(tdb, {
          taskId: task.taskId,
          expectedVersion: queued.version,
          to: 'working',
          actor: 'scheduler',
          turnId: turnIdFor(task.taskId, n),
        });
      };
      const turn = (taskId: string, n: number, intent: unknown, extra: object = {}) =>
        applyTurnOutcome(tdb, {
          taskId,
          turnId: turnIdFor(taskId, n),
          turnNumber: n,
          intent,
          budgets,
          actualUsd: 0.05,
          ...extra,
        });

      // THE DISPATCH SUBJECT: a `queued` task that has never taken a turn. `urgent` so the
      // post-restore pass's single dispatch slot is deterministically this one.
      const queued = await newRoot({ title: 'Queued work', priority: 'urgent' });
      const queuedRow = await toQueued(queued);
      expect(queuedRow.status).toBe('queued');
      ids.queued = queued.taskId;

      // A turn that was IN FLIGHT when the dump was taken. This is the one shape a dump cannot carry
      // whole: the claim is an application row and travels, but the workflow behind it lives in the
      // DBOS SYSTEM database, which is a different database and is NOT in this dump
      // (executor.ts:119-124). The claim id is minted with the shipped `taskTurnWorkflowId` so the
      // reaper in the last phase is judging a real claim, not a made-up string.
      const midTurn = await newRoot({ title: 'Mid-turn work' });
      const midQueued = await toQueued(midTurn);
      await applyTransition(tdb, {
        taskId: midTurn.taskId,
        expectedVersion: midQueued.version,
        to: 'working',
        actor: 'scheduler',
        turnId: taskTurnWorkflowId(midTurn.taskId, 1, midQueued.version),
      });
      ids.midTurn = midTurn.taskId;

      // An APPROVAL park — the row an operator comes back to.
      const approval = await newRoot({ title: 'Approval park' });
      await toWorking(approval);
      const approvalOut = await turn(approval.taskId, 1, {
        kind: 'request_approval',
        question: 'Ship the fix to production?',
        options: ['yes', 'no'],
        approver: 'user',
        timeoutMs: 3_600_000,
        onTimeout: 'fail',
      });
      expect(approvalOut.task?.statusReason).toBe('approval_pending');
      ids.approvalPark = approval.taskId;

      // A STRUCTURAL park — blocked(awaiting_children). Its exit is its children reaching terminal,
      // so no operator signal can dissolve it; only the join can. Also the delegation row.
      const fan = await newRoot({ title: 'Fan out', owner: 'lead' });
      await toWorking(fan);
      const fanOut = await turn(fan.taskId, 1, {
        kind: 'fan_out',
        children: [
          { title: 'Part one', goal: 'Do part one.', owner: 'mgr', delegatedTo: 'department:eng' },
          { title: 'Part two', goal: 'Do part two.', owner: 'mgr' },
        ],
      });
      expect(fanOut.task?.statusReason).toBe('awaiting_children');
      ids.structuralPark = fan.taskId;

      // A review park.
      const review = await newRoot({ title: 'Under review' });
      await toWorking(review);
      const reviewOut = await turn(review.taskId, 1, { kind: 'request_review', reviewer: 'mgr' });
      expect(reviewOut.task?.status).toBe('waiting_for_review');
      ids.reviewPark = review.taskId;

      // The three terminal shapes. `completed` also carries a task-scoped message.
      const done = await newRoot({ title: 'Closed work' });
      await toWorking(done);
      const doneOut = await turn(
        done.taskId,
        1,
        { kind: 'complete', result: { status: 'completed', summary: 'Done.', confidence: 0.9 } },
        { messages: [{ recipient: 'lead', body: 'Closing out.' }] },
      );
      expect(doneOut.task?.status).toBe('completed');
      ids.completed = done.taskId;

      const failed = await newRoot({ title: 'Failed work' });
      await toWorking(failed);
      const failedOut = await turn(failed.taskId, 1, {
        kind: 'fail',
        message: 'The upstream API is gone.',
      });
      expect(failedOut.task?.status).toBe('failed');
      ids.failed = failed.taskId;

      const cancelled = await newRoot({ title: 'Cancelled work' });
      await toQueued(cancelled);
      const cascade = await cancelTaskCascade(tdb, {
        taskId: cancelled.taskId,
        actor: 'user',
        reason: 'The customer withdrew the request.',
      });
      expect(cascade.cancelled).toContain(cancelled.taskId);
      ids.cancelled = cancelled.taskId;

      // An UNCONSUMED operator signal, and a journal event in the workforce CONTROL namespace.
      await deliverSignal(tdb, {
        taskId: fan.taskId,
        kind: 'manual_unblock',
        signalKey: 'operator-unblock-1',
        actor: 'user',
      });
      await appendWorkforceEvents(tdb, WORKFORCE_ID, [
        { type: 'workforce.control.paused', payload: { by: 'user' } },
      ]);

      srcCensus = await census(db.$client);
      srcCounters = await counters(db.$client);

      // ANTI-VACUITY. Eleven zeroes compare equal after ANY restore — including a restore of nothing.
      // Every table and BOTH journal namespaces must carry rows before the dump is taken.
      for (const [key, count] of Object.entries(srcCensus.counts)) {
        expect(
          count,
          `${key} was never seeded — the restore oracle would be vacuous`,
        ).toBeGreaterThan(0);
      }
      expect(srcCensus.migrations).toBeGreaterThan(0);

      // …and the graph really is in all the shapes the criterion names.
      const shapes = (await db.$client.unsafe(
        `SELECT DISTINCT status, coalesce(status_reason, '') AS reason FROM workforce_tasks
        WHERE tenant_id = '${TENANT}' ORDER BY 1, 2`,
      )) as unknown as { status: string; reason: string }[];
      expect(shapes.map((s) => `${s.status}(${s.reason})`)).toEqual([
        'blocked(awaiting_children)',
        'cancelled(cancelled_by_user)',
        'completed()',
        'failed()',
        'planned()',
        'queued()',
        'waiting_for_review(review_pending)',
        'waiting_for_user(approval_pending)',
        'working()',
      ]);
      armsRan += 1;
    }, 240_000);

    it('phase 2 — pg_dump -Fc, a fresh database, pg_restore: every row and BOTH journal namespaces are byte-identical', async () => {
      expect(srcCensus, 'phase 1 did not run').toBeDefined();
      // THE BACKUP. The custom format (-Fc) is the one an operator takes: compressed, and restorable
      // selectively. Nothing in the repo produces it — this is stock Postgres, on purpose.
      const dump = run('pg_dump', ['-Fc', '-d', withDbName(base, SRC_DB), '-f', dumpFile]);
      expect(dump.status, `pg_dump failed: ${dump.err}`).toBe(0);
      expect(statSync(dumpFile).size).toBeGreaterThan(0);

      // THE RESTORE, into a database that did not exist a moment ago.
      restoredDb = await restoreInto(RESTORED_DB);

      // ORACLE 1 — byte-for-byte, not merely equinumerous: the digest is an md5 over the ordered full
      // row text of every column, so a rewritten timestamp, a re-numbered seq or a reset counter fails
      // it. The migration count travels too, which is what makes the boot in phase 4 a no-op.
      const after = await census(restoredDb.$client);
      expect(after).toEqual(srcCensus);
      // Stated separately as well, because "no table was dropped on the floor" is the sentence a
      // restore actually promises and a reader should not have to derive it from a deep-equal.
      for (const key of Object.keys((srcCensus as Census).counts)) {
        expect(after.counts[key], `${key} did not survive the restore`).toBe(
          (srcCensus as Census).counts[key],
        );
      }
      armsRan += 1;
    }, 240_000);

    it('phase 3 — the CAS token and both journal seq HEADs are preserved exactly, and the journal head still matches the rows', async () => {
      expect(srcCounters, 'phase 1 did not run').toBeDefined();
      const client = (restoredDb as ReturnType<typeof makeDb>).$client;

      // ORACLE 2a — the two values that make resume correct, compared on their own terms.
      const after = await counters(client);
      expect(after).toEqual(srcCounters);
      const src = srcCounters as Counters;
      expect(Object.keys(after.tasks).length).toBe(Object.keys(src.tasks).length);
      for (const [taskId, expected] of Object.entries(src.tasks)) {
        expect(after.tasks[taskId]?.version, `${taskId} lost its CAS version`).toBe(
          expected.version,
        );
        expect(after.tasks[taskId]?.lastEventSeq, `${taskId} lost its journal head`).toBe(
          expected.lastEventSeq,
        );
      }
      expect(after.runtime[WORKFORCE_ID], 'the control stream lost its journal head').toBe(
        src.runtime[WORKFORCE_ID],
      );
      // A counter that is preserved but wrong is worth nothing, so at least one task must actually
      // carry a non-trivial version and journal head — otherwise this compares 1 to 1 forever.
      expect(Math.max(...Object.values(after.tasks).map((t) => t.version))).toBeGreaterThan(1);
      expect(Math.max(...Object.values(after.tasks).map((t) => t.lastEventSeq))).toBeGreaterThan(1);

      // ORACLE 2b — the STRUCTURAL invariant the next append depends on: for every stream the stored
      // head equals the highest seq actually present. This is the property that makes phase 4's first
      // append safe, and it is checked against the restored rows rather than assumed from equality.
      const drift = (await client.unsafe(
        `SELECT t.task_id, t.last_event_seq::int AS head,
              coalesce(max(e.seq)::int, 0) AS max_seq
         FROM workforce_tasks t
         LEFT JOIN run_events e ON e.tenant_id = t.tenant_id AND e.run_id = t.task_id
        WHERE t.tenant_id = '${TENANT}'
        GROUP BY t.task_id, t.last_event_seq
       HAVING t.last_event_seq::int <> coalesce(max(e.seq)::int, 0)`,
      )) as unknown as { task_id: string; head: number; max_seq: number }[];
      expect(drift, 'a restored task row disagrees with its own journal about the head').toEqual(
        [],
      );

      const wfDrift = (await client.unsafe(
        `SELECT r.workforce_id, r.last_event_seq::int AS head,
              coalesce(max(e.seq)::int, 0) AS max_seq
         FROM workforce_runtime r
         LEFT JOIN run_events e
                ON e.tenant_id = r.tenant_id AND e.run_id = 'workforce:' || r.workforce_id
        WHERE r.tenant_id = '${TENANT}'
        GROUP BY r.workforce_id, r.last_event_seq
       HAVING r.last_event_seq::int <> coalesce(max(e.seq)::int, 0)`,
      )) as unknown as { workforce_id: string }[];
      expect(
        wfDrift,
        'the restored runtime row disagrees with its control stream about the head',
      ).toEqual([]);
      armsRan += 1;
    }, 120_000);

    it('phase 4 — the first post-restore append allocates a FRESH seq, never a duplicate', async () => {
      expect(srcCounters, 'phase 1 did not run').toBeDefined();
      const db = restoredDb as ReturnType<typeof makeDb>;
      const tdb = forTenant(db, TENANT);
      const head = (srcCounters as Counters).runtime[WORKFORCE_ID] as number;

      // ORACLE 4a — the control stream. If the restore had lost `workforce_runtime.last_event_seq`,
      // this call would not return a wrong number; it would throw 23505 on
      // run_events_tenant_run_seq_idx, because the seq it allocated is already on disk.
      const alloc = await appendWorkforceEvents(tdb, WORKFORCE_ID, [
        { type: 'workforce.control.resumed', payload: { by: 'operator' } },
      ]);
      expect(alloc?.firstSeq).toBe(head + 1);
      expect(alloc?.lastSeq).toBe(head + 1);

      const seqs = (await db.$client.unsafe(
        `SELECT seq::int AS s FROM run_events
        WHERE tenant_id = '${TENANT}' AND run_id = 'workforce:${WORKFORCE_ID}'
        ORDER BY seq::numeric`,
      )) as unknown as { s: number }[];
      // Gap-free, duplicate-free, and one longer than it was: one journal, one sequence, across a
      // restore boundary.
      expect(seqs.map((r) => r.s)).toEqual(Array.from({ length: head + 1 }, (_, i) => i + 1));
      armsRan += 1;
    }, 120_000);

    it('phase 5 — the engine boots on the restored database: the queued task dispatches, the parks stay parked, the terminal rows are untouched', async () => {
      expect(ids.queued, 'phase 1 did not run').toBeDefined();
      const db = restoredDb as ReturnType<typeof makeDb>;

      // The real boot's migration step, against a database that is already at the head of the chain.
      // A restore that carried `drizzle.__drizzle_migrations` makes this a no-op; one that did not
      // would try to re-apply the whole chain here and die on an existing object.
      const before = await census(db.$client);
      await applyMigrations(db);
      const afterMigrate = await census(db.$client);
      expect(afterMigrate.migrations).toBe(before.migrations);

      // Snapshots to hold the post-dispatch assertions against.
      const parkedBefore = (await db.$client.unsafe(
        `SELECT task_id, status, coalesce(status_reason,'') AS reason, version FROM workforce_tasks
        WHERE task_id IN ('${ids.approvalPark}', '${ids.structuralPark}', '${ids.reviewPark}')
        ORDER BY task_id`,
      )) as unknown as { task_id: string; status: string; reason: string; version: number }[];
      const terminalDigests: Record<string, string> = {};
      for (const id of [ids.completed, ids.failed, ids.cancelled] as string[]) {
        terminalDigests[id] = await rowDigest(db.$client, id);
      }
      const queuedHeadBefore = (srcCounters as Counters).tasks[ids.queued as string]
        ?.lastEventSeq as number;

      // The SHIPPED dispatcher over a real DBOS engine — not a re-implementation of the reserve pass.
      // The DBOS SYSTEM database is separate and was NOT in the dump: this engine comes up on a fresh
      // one, so everything it resumes it resumes from the restored application rows alone.
      const workerParks: TaskTurnHandler = async () => ({
        intent: { kind: 'request_clarification', question: 'Which quarter does this cover?' },
      });
      const queuedCompletes: TaskTurnHandler = async () => ({
        intent: { kind: 'complete', result: { status: 'completed', summary: 'ok', confidence: 1 } },
        actualUsd: 0.05,
      });
      executor = new DbosDurableExecutor(
        {
          db,
          resolveRun: () => {
            throw new Error('this suite dispatches no agent runs');
          },
        },
        { name: `rayspec-backup-restore-${PID}`, systemDatabaseUrl: withDbName(base, DBOS_SYS_DB) },
      );
      scheduler = new DbosTaskScheduler({
        db,
        tenantId: TENANT,
        tenantExists: async () => true,
        resolveTurnHandler: (owner) => (owner === 'dev' ? queuedCompletes : workerParks),
        reserveSchedule: NEVER,
        sweepSchedule: NEVER,
      });
      const sched = scheduler;
      executor.attachPreLaunchHook(() => sched.registerScheduledWorkflows());
      await executor.start();
      await sched.registerQueue();

      // ORACLE 3a — ONE pass, and it starts exactly one turn: the restored `queued` task. The two
      // fan-out children are promoted in the same pass (proof the pass is really working the restored
      // graph) and then decline the single worker slot.
      const pass: ReservePassOutcome = await sched.runReservePass();
      expect(pass.dispatched).toEqual([{ taskId: ids.queued, turnNumber: 1 }]);
      expect(pass.promoted.length, 'the pass promoted no restored planned row').toBeGreaterThan(0);
      expect(pass.saturated).toBeGreaterThan(0);
      expect(pass.expired).toEqual([]);

      const status = async (taskId: string) =>
        (
          (await db.$client.unsafe(
            `SELECT status FROM workforce_tasks WHERE task_id = '${taskId}'`,
          )) as unknown as { status: string }[]
        )[0]?.status;
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline && (await status(ids.queued as string)) !== 'completed') {
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(await status(ids.queued as string)).toBe('completed');

      // ORACLE 4b — the dispatched turn is the FIRST writer on this task's journal since the restore,
      // and it wrote through the restored counter. Contiguous from 1, no duplicate, strictly past the
      // head the dump carried. A reset counter would have made this dispatch die on the unique index.
      const seqs = (await db.$client.unsafe(
        `SELECT seq::int AS s FROM run_events
        WHERE tenant_id = '${TENANT}' AND run_id = '${ids.queued}' ORDER BY seq::numeric`,
      )) as unknown as { s: number }[];
      expect(seqs.length).toBeGreaterThan(queuedHeadBefore);
      expect(seqs.map((r) => r.s)).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));

      // ORACLE 3b — the parks are still the parks they were, at the versions they were parked at. The
      // structural one is the load-bearing case: `awaiting_children` has no operator exit at all, and
      // its children park rather than complete, so the join stays unsatisfied.
      const parkedAfter = (await db.$client.unsafe(
        `SELECT task_id, status, coalesce(status_reason,'') AS reason, version FROM workforce_tasks
        WHERE task_id IN ('${ids.approvalPark}', '${ids.structuralPark}', '${ids.reviewPark}')
        ORDER BY task_id`,
      )) as unknown as { task_id: string; status: string; reason: string; version: number }[];
      expect(parkedAfter).toEqual(parkedBefore);
      expect(parkedAfter.find((r) => r.task_id === ids.structuralPark)).toMatchObject({
        status: 'blocked',
        reason: 'awaiting_children',
      });

      // ORACLE 3c — the terminal rows, whole: an md5 over the entire row, so a touched timestamp or a
      // bumped version is a failure and not a rounding error.
      for (const id of [ids.completed, ids.failed, ids.cancelled] as string[]) {
        expect(await rowDigest(db.$client, id), `terminal task ${id} was rewritten`).toBe(
          terminalDigests[id],
        );
      }
      armsRan += 1;
    }, 400_000);

    it('phase 6 — the turn that was in flight when the dump was taken is REAPED and re-queued, not stranded', async () => {
      expect(ids.midTurn, 'phase 1 did not run').toBeDefined();
      const db = restoredDb as ReturnType<typeof makeDb>;
      const sched = scheduler as DbosTaskScheduler;

      // The restored deployment's DBOS system database is brand new, so the claim's workflow id is
      // ABSENT rather than dead. The sweep asks the engine (task-scheduler.ts:934-937) and treats an
      // absent workflow the same as a dead one: re-queue through the one door, release the claim's
      // reservation. This is the whole reason a self-hoster does not have to back up the DBOS system
      // database to get a usable restore — and the whole reason a restored `working` row is a
      // transient, not a leak.
      const beforeSweep = (await db.$client.unsafe(
        `SELECT status FROM workforce_tasks WHERE task_id = '${ids.midTurn}'`,
      )) as unknown as { status: string }[];
      expect(beforeSweep[0]?.status).toBe('working');

      const sweep = await sched.runSweep();
      expect(sweep.reaped).toEqual([ids.midTurn]);
      // The approval park is NOT overdue (its window is an hour), so the same sweep must leave it
      // alone — a sweep that failed every approval would also "pass" the line above.
      expect(sweep.failed).toEqual([]);
      expect(sweep.escalated).toEqual([]);

      const after = (await db.$client.unsafe(
        `SELECT status, coalesce(status_reason,'') AS reason FROM workforce_tasks WHERE task_id = '${ids.midTurn}'`,
      )) as unknown as { status: string; reason: string }[];
      expect(after[0]?.status).toBe('queued');
      expect(after[0]?.reason).toBe('tool_error');
      // …and the re-queue is journaled with WHY, on the same restored stream, so the restore is
      // legible after the fact rather than a status that silently changed.
      const requeue = (await db.$client.unsafe(
        `SELECT data->>'queueReason' AS why FROM run_events
        WHERE tenant_id = '${TENANT}' AND run_id = '${ids.midTurn}'
          AND type = 'workforce.task.queued'
        ORDER BY seq::numeric DESC LIMIT 1`,
      )) as unknown as { why: string }[];
      expect(requeue[0]?.why).toBe('turn_reaped');
      armsRan += 1;
    }, 240_000);

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    // The negative arms. Each restores the SAME dump into a sabotage-only database, breaks exactly
    // one thing, and asserts the oracle above reports it. Without these the oracles are assertions
    // that have never been observed to fail.
    // ─────────────────────────────────────────────────────────────────────────────────────────────

    it('fail-the-fix: a restore that reset the CAS version is caught by the counter oracle AND by the census', async () => {
      expect(srcCounters, 'phase 1 did not run').toBeDefined();
      sabotageDb = await restoreInto(SABOTAGE_DB);
      const client = sabotageDb.$client;
      // The clean restore agrees first — so the arm below is measuring the sabotage, not the setup.
      expect(await counters(client)).toEqual(srcCounters);

      await client.unsafe(`UPDATE workforce_tasks SET version = 1 WHERE tenant_id = '${TENANT}'`);
      expect(await counters(client)).not.toEqual(srcCounters);
      const broken = await census(client);
      expect(broken.counts.workforce_tasks).toBe((srcCensus as Census).counts.workforce_tasks);
      expect(
        broken.digests.workforce_tasks,
        'the census cannot see a reset CAS token — it is not byte-level',
      ).not.toBe((srcCensus as Census).digests.workforce_tasks);
      armsRan += 1;
    }, 240_000);

    it('fail-the-fix: a restore that lost `last_event_seq` collides on the very next append (23505 on the journal unique index)', async () => {
      const db = sabotageDb as ReturnType<typeof makeDb>;
      const tdb = forTenant(db, TENANT);
      const victim = ids.completed as string;

      await db.$client.unsafe(
        `UPDATE workforce_tasks SET last_event_seq = 0 WHERE task_id = '${victim}'`,
      );
      let caught: unknown;
      try {
        await appendTaskEvents(tdb, victim, [
          { type: 'workforce.task.queued', payload: { by: 'scheduler' } },
        ]);
      } catch (err) {
        caught = err;
      }
      expect(
        caught,
        'a lost journal head appended silently — the unique index is not the guard',
      ).toBeDefined();
      const text = `${String(caught)} ${JSON.stringify(caught, Object.getOwnPropertyNames(Object(caught)))}`;
      expect(text).toMatch(/23505|duplicate key value/);
      expect(text).toContain('run_events_tenant_run_seq_idx');
      armsRan += 1;
    }, 180_000);

    it('fail-the-fix: a restore that dropped a table on the floor is caught by the census', async () => {
      const db = sabotageDb as ReturnType<typeof makeDb>;
      await db.$client.unsafe(`DELETE FROM workforce_messages WHERE tenant_id = '${TENANT}'`);
      const broken = await census(db.$client);
      expect(broken.counts.workforce_messages).toBe(0);
      expect(broken.counts.workforce_messages).not.toBe(
        (srcCensus as Census).counts.workforce_messages,
      );
      expect(broken.digests.workforce_messages).not.toBe(
        (srcCensus as Census).digests.workforce_messages,
      );
      armsRan += 1;
    }, 180_000);

    it('ran-guard: every phase and every negative arm ran (a required DB run may not silently skip)', () => {
      expect(armsRan).toBe(9);
    });
  },
);
