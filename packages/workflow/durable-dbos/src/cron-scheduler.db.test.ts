/**
 * The CRON triggers worker — DB-backed integration test.
 *
 * Drives the REAL DBOS engine (`DbosDurableExecutor`) + the `DbosCronScheduler` against a real
 * Postgres isolated schema + a throwaway DBOS SYSTEM database, and proves the firing runtime on GROUND
 * TRUTH (assert the WHOLE invariant, fail-the-fix, not pass-the-shape). The DEFAULT guarantee is
 * IDEMPOTENT, at-MOST-once-per-instant firing (it can never double-fire) — NOT at-least-once DELIVERY (a
 * crash between reserve-commit and dispatch-complete DROPS that instant; that crash-window caveat is
 * documented in cron-scheduler.ts and is reliability work, not asserted here). An opt-in CATCH-UP trigger
 * additionally makes up DOWNTIME-missed intervals (items 8–10):
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
 *     OFF-REQUEST (run header + journal + run_events persist). Asserted on the DURABLE, reserve/upsert-
 *     backed artifacts (one `run_started` reserve, one `runs` header, one `llm` step), NOT the fake's
 *     raw invocation count — the exactly-once guarantee is one real run PER FIRING KEY, and a raw count
 *     is blind to that reserve (an untainted safe re-execution re-invokes the backend yet still yields
 *     exactly one durable run).
 *  4. MANUAL: a declared `manual` trigger is fireable ON DEMAND via `fireNow` (NOT scheduled), through
 *     the SAME reserve→dispatch path — exactly-once per firing key. A webhook/event trigger stays
 *     RESERVED (neither scheduled NOR fired; a direct `fireNow` for it is fail-closed-rejected).
 *  5. CROSS-TENANT: the cron fires under the scheduler's tenant ONLY — a different tenant observes no
 *     reserve row / no cron_marks row (the reserve + dispatch are tenant-scoped structurally).
 *  6. EXACTLY-ONCE under a RECOVERY double-fire: a recovery re-execution of an already-completed
 *     cron→agent run (deterministically simulated by pre-seeding the run-level state) is a genuine
 *     NO-OP — the run-level guard (`run_started` reserve → the already-succeeded short-circuit) refuses
 *     the re-run (`realRunsFor(runId) === 0`), fail-the-fix. This exercises the run-level guard directly,
 *     BYPASSING the trigger reserve (layer 2) that would otherwise MASK a layer-3 regression.
 *  7. (see 6) The per-runId `realRunsFor` ledger is what makes the fake NON-BLIND to the reserve.
 *  8. CATCH-UP make-up: a scheduled REPLAY of a DOWNTIME-missed interval (driven via the deterministic
 *     `fireScheduled` seam) fires once (at-least-once) and a re-replay reuses the reserve → no-op
 *     (at-most-once). 9. CATCH-UP is BOUNDED: a replay older than the look-back window is reserved
 *     (consumed) but NOT dispatched (fail-the-fix). 10. an active-and-firing deployment is UNAFFECTED
 *     (a non-catch-up scheduled fire is never bounded; an active fire of a catch-up trigger dispatches).
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
import { type Db, forTenant, schema, TENANT_GUC } from '@rayspec/db';
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
  RUN_STARTED_BODY_HASH,
  RUN_STARTED_SCOPE,
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

/** A RESERVED webhook descriptor — the scheduler must neither schedule NOR fire it (per-kind reservation). */
function webhookDescriptor(name: string): TriggerDescriptor {
  return {
    name,
    kind: 'webhook',
    action: { kind: 'handler', handlerId: 'nightly_digest_handler', handler: cronHandlerFn },
  };
}

/** A RESERVED event descriptor — likewise neither scheduled NOR fired (per-kind reservation). */
function eventDescriptor(name: string): TriggerDescriptor {
  return {
    name,
    kind: 'event',
    event: 'thing.created',
    action: { kind: 'handler', handlerId: 'nightly_digest_handler', handler: cronHandlerFn },
  };
}

/** A MANUAL→handler descriptor — NOT scheduled, but fireable on demand via fireNow (writes cron_marks). */
function manualHandlerDescriptor(name: string): TriggerDescriptor {
  return {
    name,
    kind: 'manual',
    action: { kind: 'handler', handlerId: 'nightly_digest_handler', handler: cronHandlerFn },
  };
}

/** A MANUAL→agent descriptor — NOT scheduled, but fireable on demand (enqueues an off-request run). */
function manualAgentDescriptor(name: string): TriggerDescriptor {
  return {
    name,
    kind: 'manual',
    action: { kind: 'agent', agentId: 'echo-agent' },
  };
}

/**
 * A cron→handler descriptor that OPTS INTO catch-up (make-up missed intervals). The `nightly-digest`
 * shape — writes a `cron_marks` row on dispatch — so a make-up replay's dispatch is observable as a row.
 */
function handlerCatchUpDescriptor(name: string): TriggerDescriptor {
  return {
    name,
    kind: 'cron',
    schedule: '0 2 * * *',
    catchUp: true,
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

/** Count the `runs` header rows for a runId — the durable exactly-once artifact (idempotent upsert). */
async function countRunHeaders(runId: string): Promise<number> {
  const rows = await db.$client.unsafe('SELECT 1 FROM runs WHERE run_id = $1', [runId]);
  return rows.length;
}

/** Count the `llm` journal steps for a runId — the durable exactly-once artifact (idempotency-keyed). */
async function countLlmSteps(runId: string): Promise<number> {
  const rows = await db.$client.unsafe(
    "SELECT 1 FROM journal_steps WHERE run_id = $1 AND type = 'llm'",
    [runId],
  );
  return rows.length;
}

/** Count the per-run started-once reserve rows for a runId (the run-level exactly-once guard marker). */
async function countRunStartedMarkers(tenant: string, runId: string): Promise<number> {
  const rows = await db.$client.unsafe(
    'SELECT 1 FROM idempotency_keys WHERE tenant_id = $1 AND scope = $2 AND idem_key = $3',
    [tenant, RUN_STARTED_SCOPE, runId],
  );
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
      // wrapped db so the handler's GUC is observed. Construct it with a handler cron + an agent cron
      // (scheduled + fireable), a manual→handler + a manual→agent (fireable on demand, NOT scheduled),
      // and RESERVED webhook + event (neither scheduled nor fired — the per-kind reservation).
      scheduler = new DbosCronScheduler(
        [
          handlerDescriptor('nightly-digest'),
          agentDescriptor('agent-cron'),
          manualHandlerDescriptor('manual-digest'),
          manualAgentDescriptor('manual-agent'),
          webhookDescriptor('inbound-hook'),
          eventDescriptor('on-thing'),
        ],
        { db: wrapDb(db), tenantId: TENANT, executor, productTables, invokeTriggerHandler },
      );
      // Register the scheduled workflows in the executor's pre-launch window (exercises the boot ordering).
      executor.attachPreLaunchHook(() => scheduler.registerScheduledWorkflows());
      await executor.start();
    }, 60_000);

    beforeEach(async () => {
      backend.liveRuns = 0;
      backend.runInvocations.clear();
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

    it('the scheduler schedules ONLY cron triggers; manual is fireable-not-scheduled; webhook/event reserved', () => {
      // Only cron triggers are SCHEDULED — manual/webhook/event descriptors were passed but must NOT be
      // scheduled crons (per-kind reservation).
      expect(scheduler.cronTriggerNames.sort()).toEqual(['agent-cron', 'nightly-digest']);
      expect(scheduler.cronTriggerNames).not.toContain('manual-digest');
      expect(scheduler.cronTriggerNames).not.toContain('inbound-hook');
      // Manual triggers are separately FIREABLE on demand (not scheduled) — webhook/event are in NEITHER.
      expect(scheduler.manualTriggerNames.sort()).toEqual(['manual-agent', 'manual-digest']);
      expect(scheduler.manualTriggerNames).not.toContain('nightly-digest');
      expect(scheduler.manualTriggerNames).not.toContain('inbound-hook');
      expect(scheduler.manualTriggerNames).not.toContain('on-thing');
    });

    it('HEADLINE: a SECOND fire of the same (trigger, instant) dispatches ZERO additional — exactly ONE reserve row + ONE handler run', async () => {
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

      // The agent run ran OFF-REQUEST under the deterministic runId. Assert the DURABLE exactly-once
      // invariant on the reserve/upsert-backed artifacts — NOT the fake's raw invocation counter. The
      // guarantee the cron→agent path makes is exactly ONE real run PER FIRING KEY: one run-started
      // reserve, one `runs` header, one `llm` journal step (all keyed on the deterministic runId, so an
      // idempotent recovery re-execution cannot inflate them). Counting raw `backend.run()` calls would
      // be BLIND to that reserve — a legitimate untainted safe re-execution re-invokes the backend yet
      // still produces exactly ONE durable run, so the raw count is not the invariant.
      const status = await waitForTerminal(runId);
      expect(status).toBe('succeeded');
      expect(await countRunStartedMarkers(TENANT, runId)).toBe(1); // exactly one run-level reserve
      expect(await countRunHeaders(runId)).toBe(1); // exactly one durable run header
      expect(await countLlmSteps(runId)).toBe(1); // exactly one journaled llm step
      expect(backend.realRunsFor(runId)).toBe(1); // and, for this clean run, the backend ran once

      // A REFIRE of the same instant: the trigger reserve (layer 2) loses → `fireNow` returns false
      // BEFORE it reaches `enqueue`, so NO second job is enqueued. This asserts the LAYER-2 dedup (the
      // trigger reserve); the LAYER-3 run-level guard (a recovery re-execution of the SAME runId is a
      // genuine no-op) is exercised deterministically by the next test — layer 2 alone can never MASK a
      // layer-3 regression there, which is what made the old raw-count assertion here blind to it.
      const second = await scheduler.fireNow('agent-cron', instant);
      expect(second).toBe(false);
      await new Promise((r) => setTimeout(r, 200));
      expect(await countRunHeaders(runId)).toBe(1); // still exactly ONE durable run — no re-fire
      expect(await countLlmSteps(runId)).toBe(1);
    });

    it('EXACTLY-ONCE (recovery double-fire): a recovery re-execution of an already-completed cron→agent run is a genuine NO-OP (run-level guard; fail-the-fix)', async () => {
      // Deterministically simulate DBOS RE-DISPATCHING an already-completed cron→agent workflow (the
      // recovery double-fire — an intermittently-observed second run under recovery). Pre-seed the state
      // the FIRST attempt would have committed: the `run_started` reserve + a terminal-SUCCESS `runs`
      // header (untainted — no tool fired). Then fire the trigger: layer 2 (the trigger reserve) is WON
      // (first fire of this instant), so the run is enqueued and its body runs — but the run-level guard
      // (the lost `run_started` reserve → the already-succeeded short-circuit) makes it a genuine NO-OP.
      // This bypasses layer 2's masking (which is why the AGENT test above could not see a layer-3
      // regression): here the ONLY thing preventing a second real run is the run-level guard.
      const instant = new Date('2026-06-24T04:05:00.000Z');
      const runId = cronRunId('agent-cron', instant);

      // The FIRST attempt's durable footprint (as if it ran + completed, then DBOS re-dispatched it).
      await forTenant(db, TENANT)
        .insert(schema.idempotencyKeys, {
          scope: RUN_STARTED_SCOPE,
          idemKey: runId,
          bodyHash: RUN_STARTED_BODY_HASH,
          snapshot: { runId },
        })
        .onConflictDoNothing();
      await db.$client.unsafe(
        `INSERT INTO runs (run_id, tenant_id, backend, auth_mode, agent_name, model, status)
         VALUES ($1, $2, 'openai', 'api-key', 'echo', 'gpt-4.1-mini', 'completed')`,
        [runId, TENANT],
      );

      const fired = await scheduler.fireNow('agent-cron', instant);
      expect(fired).toBe(true); // the TRIGGER fired (won its reserve) — the run was enqueued
      const status = await waitForTerminal(runId);
      expect(status).toBe('succeeded'); // the recovery completed — as a no-op success, not a re-run

      // GROUND TRUTH — a genuine NO-OP: the backend was NEVER invoked for this runId (no second real
      // run), and the durable run is still the single pre-seeded header (no duplicate/second run). This
      // is FAIL-THE-FIX: without the run-level guard (the run_started reserve routing to the
      // already-succeeded short-circuit) the body would re-run runAgent → `realRunsFor(runId)` becomes 1
      // and a second `llm` step appears — the double-fire the guard exists to prevent.
      expect(backend.realRunsFor(runId)).toBe(0); // the run-level guard refused the re-execution
      expect(await countRunHeaders(runId)).toBe(1); // still exactly one durable run (the seeded one)
      expect(await countLlmSteps(runId)).toBe(0); // no journaled llm step — runAgent never re-ran
    });

    it('PER-KIND RESERVED: fireNow for a reserved (webhook OR event) trigger is fail-closed-rejected (never fired)', async () => {
      // webhook + event stay RESERVED — they are in NEITHER the schedule nor the fireable map, so a
      // direct fire is fail-closed (manual, by contrast, IS fireable — proven below).
      await expect(scheduler.fireNow('inbound-hook')).rejects.toThrow(
        /not a registered fireable trigger/i,
      );
      await expect(scheduler.fireNow('on-thing')).rejects.toThrow(
        /not a registered fireable trigger/i,
      );
      // fireNow for a wholly-unknown name is likewise fail-closed.
      await expect(scheduler.fireNow('does-not-exist')).rejects.toThrow(
        /not a registered fireable/i,
      );
    });

    it('MANUAL→handler: fireNow dispatches the handler once (GUC-populated tenant tx); a refire of the same instant dedups', async () => {
      const instant = new Date('2026-06-24T09:00:00.000Z');
      const key = firingKey('manual-digest', instant);

      // FAIL-THE-FIX: a manual trigger is fireable on demand THROUGH the SAME reserve→dispatch path a
      // cron uses. Without lifting the cron-only reservation, `fireNow('manual-digest')` would throw
      // "not a registered fireable trigger". The first fire WINS → the handler runs once in the tenant tx.
      const first = await scheduler.fireNow('manual-digest', instant);
      expect(first).toBe(true);
      expect(capturedGuc.value).toBe(TENANT); // the handler ran inside the GUC-populated tenant tx
      expect(await countFireMarkers(TENANT, key)).toBe(1);
      expect(await countCronMarks(TENANT)).toBe(1);

      // A SECOND fire of the SAME (trigger, instant) LOSES the reserve → ZERO additional dispatch.
      capturedGuc.value = null;
      const second = await scheduler.fireNow('manual-digest', instant);
      expect(second).toBe(false); // deduped no-op (exactly-once per firing key, identical to cron)
      expect(capturedGuc.value).toBeNull(); // the handler was NOT invoked again
      expect(await countFireMarkers(TENANT, key)).toBe(1); // still exactly ONE reserve row
      expect(await countCronMarks(TENANT)).toBe(1); // still exactly ONE handler row
    });

    it('MANUAL→agent: fireNow enqueues the off-request run once (deterministic runId); a refire enqueues nothing new', async () => {
      const instant = new Date('2026-06-24T09:05:00.000Z');
      const runId = cronRunId('manual-agent', instant);

      const first = await scheduler.fireNow('manual-agent', instant);
      expect(first).toBe(true);

      // The agent run ran OFF-REQUEST under the deterministic runId → run header + journal persist.
      // Assert on THIS runId's own rows (not the shared backend counter — a prior test's agent run may
      // still be settling on the shared DBOS queue, which would taint a global count).
      const status = await waitForTerminal(runId);
      expect(status).toBe('succeeded');
      const headers = await db.$client.unsafe('SELECT 1 FROM runs WHERE run_id = $1', [runId]);
      expect(headers).toHaveLength(1);
      const llmSteps = await db.$client.unsafe(
        "SELECT 1 FROM journal_steps WHERE run_id = $1 AND type = 'llm'",
        [runId],
      );
      expect(llmSteps).toHaveLength(1); // the agent executed EXACTLY once for this fire

      // A refire of the same instant loses the trigger reserve → no second enqueue; the run's own
      // journal still shows exactly ONE llm step (this run never re-executed).
      const second = await scheduler.fireNow('manual-agent', instant);
      expect(second).toBe(false);
      await new Promise((r) => setTimeout(r, 200));
      const llmStepsAfter = await db.$client.unsafe(
        "SELECT 1 FROM journal_steps WHERE run_id = $1 AND type = 'llm'",
        [runId],
      );
      expect(llmStepsAfter).toHaveLength(1);
    });

    it('MANUAL fires are per-instant like cron: a DIFFERENT instant is a DISTINCT key → it DOES dispatch', async () => {
      // Guards against an over-broad reserve that would dedup ALL manual fires forever. Two distinct
      // instants → two reserve rows → two handler rows (the dedup is per-instant, not per-trigger).
      const t1 = new Date('2026-06-24T09:00:00.000Z');
      const t2 = new Date('2026-06-25T09:00:00.000Z');
      expect(await scheduler.fireNow('manual-digest', t1)).toBe(true);
      expect(await scheduler.fireNow('manual-digest', t2)).toBe(true);
      expect(await countFireMarkers(TENANT, firingKey('manual-digest', t1))).toBe(1);
      expect(await countFireMarkers(TENANT, firingKey('manual-digest', t2))).toBe(1);
      expect(await countCronMarks(TENANT)).toBe(2); // two distinct instants both fired
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

    it('same-bucket cross-dedup: two fires a few ms apart in the SAME second cross-dedup → ONE row, ONE handler run', async () => {
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

    // ── CATCH-UP (opt-in make-up of intervals missed while the deployment was DOWN) ────────────────
    // DBOS's ExactlyOncePerInterval mode replays each missed interval on startup by calling the
    // scheduled-fire body (`fireScheduled`) once per missed slot; these tests drive that EXACT body with
    // a past instant to prove the make-up path deterministically (no wall-clock loop). The mode wiring —
    // that a catch-up trigger registers under ExactlyOncePerInterval so DBOS actually replays — is proven
    // by cron-scheduler-catchup.unit.test.ts (the make-up-work mode is what drives this in production).

    it('CATCH-UP: a make-up replay of a DOWNTIME-missed interval fires once; a re-replay reuses the reserve → no-op (at-least-once + at-most-once)', async () => {
      const catchUpScheduler = new DbosCronScheduler(
        [handlerCatchUpDescriptor('nightly-digest-catchup')],
        { db, tenantId: TENANT, executor, productTables, invokeTriggerHandler },
      );
      // An interval that SHOULD have fired 30 min ago but did not (the app was down) — no reserve exists.
      const missed = new Date(Date.now() - 30 * 60_000);
      const key = firingKey('nightly-digest-catchup', missed);
      expect(await countFireMarkers(TENANT, key)).toBe(0); // never fired — app down at its instant

      // AT-LEAST-ONCE: the make-up replay reserves + dispatches the missed interval (one cron_marks row).
      expect(await catchUpScheduler.fireScheduled('nightly-digest-catchup', missed)).toBe(true);
      expect(await countFireMarkers(TENANT, key)).toBe(1);
      expect(await countCronMarks(TENANT)).toBe(1);

      // AT-MOST-ONCE: a second make-up replay of the SAME interval reuses the reserve → deduped no-op.
      expect(await catchUpScheduler.fireScheduled('nightly-digest-catchup', missed)).toBe(false);
      expect(await countFireMarkers(TENANT, key)).toBe(1);
      expect(await countCronMarks(TENANT)).toBe(1); // still exactly one dispatch — no double
    });

    it('CATCH-UP is BOUNDED: a make-up replay OLDER than the look-back window is reserved (consumed) but NOT dispatched — unbounded history is not replayed (fail-the-fix)', async () => {
      // A deliberately small look-back window so a stale instant is deterministically "beyond" it.
      const catchUpScheduler = new DbosCronScheduler(
        [handlerCatchUpDescriptor('nightly-digest-catchup')],
        {
          db,
          tenantId: TENANT,
          executor,
          productTables,
          invokeTriggerHandler,
          catchUpLookbackMs: 60_000,
        },
      );

      // WITHIN the window (30s ago) → the make-up fires.
      const within = new Date(Date.now() - 30_000);
      expect(await catchUpScheduler.fireScheduled('nightly-digest-catchup', within)).toBe(true);
      expect(await countCronMarks(TENANT)).toBe(1);

      // BEYOND the window (10 min ago) → reserved (consumed) but NOT dispatched. FAIL-THE-FIX: without
      // the look-back bound this would dispatch → a SECOND cron_marks row. The reserve IS written (the
      // stale slot is consumed, so a later replay is a deduped no-op), but the dispatch is skipped.
      const beyond = new Date(Date.now() - 10 * 60_000);
      const beyondKey = firingKey('nightly-digest-catchup', beyond);
      expect(await catchUpScheduler.fireScheduled('nightly-digest-catchup', beyond)).toBe(false);
      expect(await countFireMarkers(TENANT, beyondKey)).toBe(1); // consumed (reserved)
      expect(await countCronMarks(TENANT)).toBe(1); // NOT dispatched — still just the within-window one
    });

    it('CATCH-UP leaves active firing UNAFFECTED: a non-catch-up scheduled fire is never look-back-bounded, and an active fire of a catch-up trigger dispatches', async () => {
      // A NON-catch-up trigger's scheduled fire is NEVER look-back-bounded — an active-and-firing
      // deployment behaves exactly as before: `fireScheduled` for the shared non-catch-up `nightly-digest`
      // with a weeks-old instant still dispatches (no make-up bound applies to a non-catch-up trigger).
      const staleForActive = new Date('2026-06-01T02:00:00.000Z');
      expect(await scheduler.fireScheduled('nightly-digest', staleForActive)).toBe(true);
      expect(await countCronMarks(TENANT)).toBe(1);

      // And an ACTIVE fire (instant ≈ now) of a catch-up trigger is within any window → dispatches.
      const catchUpScheduler = new DbosCronScheduler(
        [handlerCatchUpDescriptor('nightly-digest-catchup')],
        {
          db,
          tenantId: TENANT,
          executor,
          productTables,
          invokeTriggerHandler,
          catchUpLookbackMs: 60_000,
        },
      );
      expect(await catchUpScheduler.fireScheduled('nightly-digest-catchup', new Date())).toBe(true);
      expect(await countCronMarks(TENANT)).toBe(2); // both dispatched
    });
  },
);
