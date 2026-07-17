/**
 * The CRON triggers worker — DB-backed integration test.
 *
 * Drives the REAL DBOS engine (`DbosDurableExecutor`) + the `DbosCronScheduler` against a real
 * Postgres isolated schema + a throwaway DBOS SYSTEM database, and proves the firing runtime on GROUND
 * TRUTH (assert the WHOLE invariant, fail-the-fix, not pass-the-shape). The guarantee under test
 * is IDEMPOTENT, at-MOST-once-per-instant firing (it can never double-fire) — NOT at-least-once
 * DELIVERY (a crash between reserve-commit and dispatch-complete DROPS that instant; that crash-window
 * caveat is documented in cron-scheduler.ts and is reliability work, not asserted here):
 *
 *  1. THE HEADLINE — exactly-once-per-instant: a SECOND `fireNow(name, T)` for the
 *     SAME instant dispatches ZERO additional work. Asserted as the WHOLE invariant: exactly ONE
 *     `idempotency_keys(scope='trigger')` row, exactly ONE handler invocation / ONE runAgentJob — NOT
 *     merely "a dispatch happened". The first call returns true (won), the second false (deduped).
 *  2. HANDLER action (the `nightly-digest` shape): firing a cron→handler trigger runs
 *     `invokeTriggerHandler` exactly once INSIDE `forTenant(db,tenantId).transaction()` with the
 *     `app.current_tenant` GUC POPULATED (read-back) — proven by the handler writing
 *     a `cron_marks` row (tenant-stamped) AND the captured GUC. A refire is a no-op (one row, not two).
 *  3. AGENT action: firing a cron→agent trigger enqueues `runAgentJob` exactly once → it runs
 *     OFF-REQUEST (run header + journal + run_events persist). A refire enqueues NOTHING new (the runId
 *     is deterministic from the firing key → the engine dedups too).
 *  4. PER-KIND RESERVED: a declared webhook/event/manual trigger is NOT fired (the scheduler does not
 *     schedule it; a direct `fireNow` for it is fail-closed-rejected).
 *  5. CROSS-TENANT: the cron fires under the scheduler's tenant ONLY — a different tenant observes no
 *     reserve row / no cron_marks row (the reserve + dispatch are tenant-scoped structurally).
 *
 * HONEST SCOPE: like the spine test, this drives the firing path via the DETERMINISTIC
 * `fireNow` seam (the SAME reserve→dispatch path as a scheduled fire — production fires on the crontab,
 * tests fire deterministically). The DBOS scheduled-workflow REGISTRATION (`registerScheduled`) is
 * doc-verified (the wire-shape golden + the source-read in cron-scheduler.ts) + exercised through the
 * executor's pre-launch hook; we do NOT wait for a real 2am wall-clock tick (non-deterministic). The
 * firing-key/reserve invariant — the load-bearing exactly-once property — IS behaviorally proven here.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentSpec } from '@rayspec/core';
import { type Db, forTenant, TENANT_GUC } from '@rayspec/db';
import { buildProductTables, makeDbWithSchema, registerScopedTables } from '@rayspec/db/testing';
import {
  invokeTriggerHandler,
  type ResolvedHandler,
  type RunJob,
  type TriggerDescriptor,
} from '@rayspec/platform';
import type { StoreSpec } from '@rayspec/spec';
import { config as loadDotenv } from 'dotenv';
import { sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  cronRunId,
  DbosCronScheduler,
  DbosDurableExecutor,
  type DbosExecutorDeps,
  firingKey,
  type ResolvedRun,
  TRIGGER_FIRE_SCOPE,
} from './index.js';
import { FakeSpineBackend } from './test-support/fake-backend.js';
import { buildCronProductSchemaSql, buildSpineSchemaSql } from './test-support/schema-ddl.js';

const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, '..', '..', '..', '..', '.env');
if (existsSync(envPath)) loadDotenv({ path: envPath });

// File-unique (pid-suffixed) names so a parallel fork of another file can never collide on the same
// sys DB / app schema (fix A — the cross-file false-green hazard).
const PID = process.pid;
const APP_SCHEMA = `rayspec_test_dbos_cron_${PID}`;
const DBOS_SYS_DB = `rayspec_dbos_cron_${PID}_sys`;
const TENANT = '00000000-0000-0000-0000-0000000000aa';
const OTHER_TENANT = '00000000-0000-0000-0000-0000000000bb';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
// un-skippable ran-guard: this DB-backed suite proves the exactly-once cron firing + cross-tenant
// invariants over a REAL DBOS engine — it must never silently self-skip to a false green. When the DB
// is REQUIRED but absent, hard-fail at collection rather than skip.
if (requireDb && !hasDb) {
  throw new Error(
    'cron-scheduler.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — ' +
      'refusing to silently skip a security-load-bearing suite.',
  );
}

const backend = new FakeSpineBackend();

/** The base spec the resolver returns for the single declared cron→agent test agent. */
const baseSpec: AgentSpec = {
  name: 'echo',
  instructions: 'echo the input',
  model: 'gpt-4.1-mini',
  input: 'placeholder',
  tools: [],
  maxTurns: 4,
};

/** A throwaway product store the trigger HANDLER writes to (proves the handler ran in the tenant tx). */
const cronMarksStore: StoreSpec = {
  name: 'cron_marks',
  columns: [{ name: 'note', type: 'text', nullable: false, unique: false }],
  foreignKeys: [],
};

type DbHandle = ReturnType<typeof makeDbWithSchema>;
let db: DbHandle;
let executor: DbosDurableExecutor;
let scheduler: DbosCronScheduler;
let productTables: Map<string, PgTable>;
let unregister: () => void;
let appBaseUrl: string;

/** Captures the GUC read INSIDE the handler's own tdb.transaction() (the GUC read-back). */
const capturedGuc: { value: string | null } = { value: null };

/**
 * A trigger HANDLER (the `nightly-digest` shape): write a `cron_marks` row via the facade (proving it
 * ran inside the tenant-scoped tx with the GUC set), AND read back the GUC on the transactional handle
 * so the test asserts the GUC was populated (not merely that the handler ran). The handler receives a
 * `HandlerDb` whose `transaction` nests onto the engine-opened tenant tx.
 */
const cronHandlerFn: ResolvedHandler & { kind: 'trigger' } = {
  kind: 'trigger',
  fn: async (init) => {
    await init.db.insert('cron_marks', { note: `fired:${init.triggerName}` });
  },
};

function handlerDescriptor(name: string): TriggerDescriptor {
  return {
    name,
    kind: 'cron',
    schedule: '0 2 * * *',
    action: { kind: 'handler', handlerId: 'nightly_digest_handler', handler: cronHandlerFn },
  };
}

function agentDescriptor(name: string): TriggerDescriptor {
  return {
    name,
    kind: 'cron',
    schedule: '*/5 * * * *',
    action: { kind: 'agent', agentId: 'echo-agent' },
  };
}

/** A RESERVED (non-cron) descriptor — the scheduler must NOT fire it (per-kind reservation). */
function webhookDescriptor(name: string): TriggerDescriptor {
  return {
    name,
    kind: 'webhook',
    action: { kind: 'handler', handlerId: 'nightly_digest_handler', handler: cronHandlerFn },
  };
}

/**
 * Wrap the raw Db so the GUC inside the handler's own tdb.transaction() is OBSERVED — invokeTriggerHandler
 * opens forTenant(db,tenantId).transaction(), and this proxy reads current_setting on that same tx handle
 * AFTER the handler body runs (the GUC read-back pattern). Proves the handler ran in the GUC-populated tx.
 */
function wrapDb(raw: Db): Db {
  const realTransaction = raw.transaction.bind(raw);
  return new Proxy(raw, {
    get(target, prop, receiver) {
      if (prop === 'transaction') {
        return (inner: (tx: unknown) => Promise<unknown>, ...rest: unknown[]) =>
          realTransaction(
            async (tx: unknown) => {
              const r = await inner(tx);
              const rows = (await (tx as Db).execute(
                sql`select current_setting(${TENANT_GUC}, true) as tenant`,
              )) as unknown as Array<{ tenant: string | null }>;
              capturedGuc.value = rows[0]?.tenant ?? null;
              return r;
            },
            ...(rest as []),
          ) as unknown;
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as Db;
}

function withDbName(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

/**
 * Drop a sys DB WITHOUT `WITH (FORCE)` (fix A): a FORCE drop terminates a still-live engine's
 * pool/notification clients and can corrupt DBOS global state for the next-ordered file. Called only
 * when no live engine should be attached (before launch / after a clean shutdown), with a short retry.
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

async function waitForTerminal(jobId: string, ms = 30_000): Promise<string> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const s = await executor.status(jobId);
    if (s === 'succeeded' || s === 'failed' || s === 'cancelled') return s;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`workflow ${jobId} did not reach a terminal status within ${ms}ms`);
}

/** Count the firing-marker rows for (tenant, trigger, instant) — the whole-invariant reserve assertion. */
async function countFireMarkers(tenant: string, key: string): Promise<number> {
  const rows = await db.$client.unsafe(
    'SELECT 1 FROM idempotency_keys WHERE tenant_id = $1 AND scope = $2 AND idem_key = $3',
    [tenant, TRIGGER_FIRE_SCOPE, key],
  );
  return rows.length;
}

async function countCronMarks(tenant: string): Promise<number> {
  const rows = await db.$client.unsafe('SELECT 1 FROM cron_marks WHERE tenant_id = $1', [tenant]);
  return rows.length;
}

describe.skipIf(!hasDb)(
  'DBOS cron triggers worker — idempotent, at-MOST-once-per-instant firing',
  () => {
    beforeAll(async () => {
      const url = process.env.DATABASE_URL as string;
      appBaseUrl = url;

      // Fresh throwaway DBOS system DB (no live engine yet — a plain drop suffices).
      await dropSysDbSafely(url, DBOS_SYS_DB);

      db = makeDbWithSchema(url, APP_SCHEMA);
      await db.$client.unsafe(buildSpineSchemaSql(APP_SCHEMA));
      await db.$client.unsafe(buildCronProductSchemaSql(APP_SCHEMA));
      await db.$client.unsafe(
        `INSERT INTO orgs (id, name, slug) VALUES ($1, 'cron', 'cron'), ($2, 'other', 'other')`,
        [TENANT, OTHER_TENANT],
      );

      // The product table (cron_marks) the handler writes to, registered in the deny-by-default Set.
      productTables = buildProductTables([cronMarksStore]);
      unregister = registerScopedTables([...productTables.values()]);

      const deps: DbosExecutorDeps = {
        db: wrapDb(db),
        resolveRun: (job: RunJob): ResolvedRun => {
          if (job.agentId !== 'echo-agent') throw new Error(`unknown agent '${job.agentId}'`);
          return { backend, spec: baseSpec };
        },
      };
      executor = new DbosDurableExecutor(deps, {
        name: `rayspec-cron-${PID}`,
        systemDatabaseUrl: withDbName(url, DBOS_SYS_DB),
      });

      // The scheduler over the SAME tenant (single-deployment LOCAL posture). It dispatches off the
      // wrapped db so the handler's GUC is observed. Construct it with BOTH a handler cron + an agent
      // cron + a RESERVED webhook (proving the per-kind reservation: webhook is NOT scheduled).
      scheduler = new DbosCronScheduler(
        [
          handlerDescriptor('nightly-digest'),
          agentDescriptor('agent-cron'),
          webhookDescriptor('inbound-hook'),
        ],
        { db: wrapDb(db), tenantId: TENANT, executor, productTables, invokeTriggerHandler },
      );
      // Register the scheduled workflows in the executor's pre-launch window (exercises the boot ordering).
      executor.attachPreLaunchHook(() => scheduler.registerScheduledWorkflows());
      await executor.start();
    }, 60_000);

    beforeEach(async () => {
      backend.liveRuns = 0;
      capturedGuc.value = null;
      await db.$client.unsafe(
        'TRUNCATE run_events, journal_steps, conversation_items, runs, idempotency_keys, cron_marks CASCADE',
      );
    });

    afterAll(async () => {
      unregister?.();
      // AWAIT the engine shutdown BEFORE dropping the sys DB (the engine is then down — no FORCE needed).
      try {
        await executor.shutdown();
      } finally {
        await db.$client.end();
        await dropSysDbSafely(appBaseUrl, DBOS_SYS_DB);
      }
    }, 30_000);

    it('the scheduler schedules ONLY cron triggers (webhook reserved per-kind, not scheduled)', () => {
      // The webhook descriptor was passed but must NOT be a scheduled cron (per-kind reservation).
      expect(scheduler.cronTriggerNames.sort()).toEqual(['agent-cron', 'nightly-digest']);
      expect(scheduler.cronTriggerNames).not.toContain('inbound-hook');
    });

    it('HEADLINE (exit-gate #2): a SECOND fire of the same (trigger, instant) dispatches ZERO additional — exactly ONE reserve row + ONE handler run', async () => {
      const instant = new Date('2026-06-24T02:00:00.000Z');
      const key = firingKey('nightly-digest', instant);

      // First fire WINS the reserve → dispatches the handler exactly once.
      const first = await scheduler.fireNow('nightly-digest', instant);
      expect(first).toBe(true);
      expect(capturedGuc.value).toBe(TENANT); // the handler ran inside the GUC-populated tenant tx
      expect(await countFireMarkers(TENANT, key)).toBe(1);
      expect(await countCronMarks(TENANT)).toBe(1); // exactly one handler invocation wrote one row

      // SECOND fire of the SAME instant LOSES the reserve → ZERO additional dispatch (the whole invariant).
      capturedGuc.value = null;
      const second = await scheduler.fireNow('nightly-digest', instant);
      expect(second).toBe(false); // deduped no-op
      expect(capturedGuc.value).toBeNull(); // the handler was NOT invoked again (no tx opened)
      expect(await countFireMarkers(TENANT, key)).toBe(1); // still exactly ONE reserve row
      expect(await countCronMarks(TENANT)).toBe(1); // still exactly ONE handler row — no re-fire
    });

    it('AGENT action: a cron→agent fire enqueues runAgentJob exactly once (off-request) → header+journal persist; a refire enqueues nothing new', async () => {
      const instant = new Date('2026-06-24T00:05:00.000Z');
      const runId = cronRunId('agent-cron', instant);

      const first = await scheduler.fireNow('agent-cron', instant);
      expect(first).toBe(true);

      // The agent run ran OFF-REQUEST under the deterministic runId → header + journal persist.
      const status = await waitForTerminal(runId);
      expect(status).toBe('succeeded');
      expect(backend.liveRuns).toBe(1);
      const headers = await db.$client.unsafe('SELECT 1 FROM runs WHERE run_id = $1', [runId]);
      expect(headers).toHaveLength(1);
      const steps = await db.$client.unsafe(
        "SELECT 1 FROM journal_steps WHERE run_id = $1 AND type = 'llm'",
        [runId],
      );
      expect(steps).toHaveLength(1);

      // A REFIRE of the same instant: the trigger reserve (layer 2) loses → `fireNow` returns false
      // BEFORE it reaches `enqueue`, so NO second job is enqueued. NOTE (honesty): this asserts the
      // LAYER-2 dedup (the trigger reserve) only — layer 3 (the deterministic runId + the
      // run_started guard deduping the RUN even if a second job WERE enqueued) is NOT exercised here
      // (no second enqueue happens), it is proven directly in executor.db.test.ts ("the started-once
      // safety guard"). The `liveRuns===1` below is the trigger-reserve dedup, not the run-level guard.
      const second = await scheduler.fireNow('agent-cron', instant);
      expect(second).toBe(false);
      await new Promise((r) => setTimeout(r, 200));
      expect(backend.liveRuns).toBe(1); // runAgent ran exactly once (the trigger reserve blocked the 2nd fire)
    });

    it('PER-KIND RESERVED: fireNow for a reserved (webhook) trigger is fail-closed-rejected (never fired)', async () => {
      await expect(scheduler.fireNow('inbound-hook')).rejects.toThrow(
        /not a registered cron trigger/i,
      );
      // fireNow for a wholly-unknown name is likewise fail-closed.
      await expect(scheduler.fireNow('does-not-exist')).rejects.toThrow(/not a registered cron/i);
    });

    it('CROSS-TENANT: the cron fires under the scheduler tenant ONLY — the other tenant sees no reserve / no row', async () => {
      const instant = new Date('2026-06-24T02:00:00.000Z');
      const key = firingKey('nightly-digest', instant);

      const fired = await scheduler.fireNow('nightly-digest', instant);
      expect(fired).toBe(true);

      // The scheduler's tenant has the reserve + the handler row; the OTHER tenant has NEITHER.
      expect(await countFireMarkers(TENANT, key)).toBe(1);
      expect(await countCronMarks(TENANT)).toBe(1);
      expect(await countFireMarkers(OTHER_TENANT, key)).toBe(0);
      expect(await countCronMarks(OTHER_TENANT)).toBe(0);

      // And a tenant-scoped read of cron_marks from the OTHER tenant sees zero rows (structural predicate).
      const otherRows = await forTenant(db, OTHER_TENANT)
        .select(productTables.get('cron_marks') as PgTable)
        .all();
      expect(otherRows).toHaveLength(0);
    });

    it('fix #5 (same-bucket cross-dedup): two fires a few ms apart in the SAME second cross-dedup → ONE row, ONE handler run', async () => {
      // The scheduler's second-aligned tick and a `fireNow` a few ms later are the SAME logical instant
      // (truncated to whole seconds). They MUST produce the same firing key and dedup — a sub-second
      // difference must NOT slip a second dispatch through.
      const tick = new Date('2026-06-24T02:00:00.000Z');
      const fewMsLater = new Date('2026-06-24T02:00:00.742Z');
      const key = firingKey('nightly-digest', tick);
      expect(firingKey('nightly-digest', fewMsLater)).toBe(key); // same bucket by construction

      const first = await scheduler.fireNow('nightly-digest', tick);
      expect(first).toBe(true);
      const second = await scheduler.fireNow('nightly-digest', fewMsLater);
      expect(second).toBe(false); // deduped despite the 742ms wall-clock gap (same truncation bucket)
      expect(await countFireMarkers(TENANT, key)).toBe(1); // exactly ONE reserve row
      expect(await countCronMarks(TENANT)).toBe(1); // exactly ONE handler run across both fires
    });

    it('fail-the-fix: a DIFFERENT instant is a DISTINCT firing key → it DOES dispatch (the dedup is per-instant, not per-trigger)', async () => {
      // Guards against an over-broad reserve that would dedup ALL fires of a trigger forever. Two
      // distinct instants → two reserve rows → two handler rows.
      const t1 = new Date('2026-06-24T02:00:00.000Z');
      const t2 = new Date('2026-06-25T02:00:00.000Z');
      expect(await scheduler.fireNow('nightly-digest', t1)).toBe(true);
      expect(await scheduler.fireNow('nightly-digest', t2)).toBe(true);
      expect(await countFireMarkers(TENANT, firingKey('nightly-digest', t1))).toBe(1);
      expect(await countFireMarkers(TENANT, firingKey('nightly-digest', t2))).toBe(1);
      expect(await countCronMarks(TENANT)).toBe(2); // two distinct instants both fired
    });
  },
);
