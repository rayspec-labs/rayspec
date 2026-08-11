/**
 * The PRE-ENQUEUE run header + the fire OUTCOME surface — DB-backed (real Postgres isolated schema;
 * a capturing STUB executor, NO DBOS engine in this process).
 *
 * A fired AGENT action enqueues its off-request run under a DETERMINISTIC id (`cronRunId`), but until
 * #322 the caller never learned it, and — unlike the HTTP async path — the fire path wrote no
 * pre-enqueue run header, so even a caller who re-derived the id read `404` until the run's own
 * header committed (and forever, for a run that ends by throwing: the durable worker runs the agent
 * inside ONE transaction, so a thrown run's header rolls back). Ground truth this suite pins:
 *
 *  1. OUTCOME: `fireNowWithOutcome` on an agent-action trigger reports `{ fired: true, runId }` with
 *     the SAME deterministic id the enqueued job carries (`cronRunId(name, instant)`).
 *  2. HEADER BEFORE ENQUEUE: when the deployment injects `resolveRunHeaderIdentity`, the fire writes
 *     the run's `enqueued` header — tenant-stamped, carrying the resolved backend/agent/model —
 *     BEFORE the executor enqueue (the stub probes the table AT enqueue time), so the runId the fire
 *     surface hands back resolves immediately, exactly like the async-run 202's id.
 *  3. NO runId WHERE THERE IS NO RUN: a handler-action fire reports `{ fired: true }` with NO runId
 *     key and writes NO header; a deduped no-op reports `{ fired: false }` with NO runId key and
 *     enqueues nothing new (accept controls — today's shapes stay byte-identical).
 *  4. OPTIONAL SEAM: with NO `resolveRunHeaderIdentity` injected the fire still dispatches and
 *     writes NO header (the pre-#322 posture) — the write is driven by the seam, never a side effect
 *     a deployment cannot opt out of.
 *
 * Skips without DATABASE_URL; the un-skippable ran-guard hard-fails a REQUIRED run (CI / opt-in).
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeDbWithSchema } from '@rayspec/db/testing';
import {
  type DurableExecutor,
  type DurableExecutorIdentity,
  type EnqueueResult,
  invokeTriggerHandler,
  type ResolvedHandler,
  type RunJob,
  type TriggerDescriptor,
} from '@rayspec/platform';
import { config as loadDotenv } from 'dotenv';
import type { PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cronRunId, DbosCronScheduler } from './index.js';
import { buildSpineSchemaSql } from './test-support/schema-ddl.js';

const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, '..', '..', '..', '..', '.env');
if (existsSync(envPath)) loadDotenv({ path: envPath });

const PID = process.pid;
const APP_SCHEMA = `rayspec_test_dbos_cron_hdr_${PID}`;
const TENANT = '00000000-0000-0000-0000-0000000000ee';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
// Un-skippable ran-guard: this DB-backed suite proves the fire surface hands back a resolvable run —
// it must never silently self-skip to a false green. When the DB is REQUIRED but absent, hard-fail at
// collection rather than skip.
if (requireDb && !hasDb) {
  throw new Error(
    'cron-scheduler-run-header.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) ' +
      'but absent — refusing to silently skip the pre-enqueue-run-header proof.',
  );
}

/**
 * A capturing STUB DurableExecutor that ALSO probes the `runs` table AT enqueue time — the ordering
 * proof: the pre-enqueue header must be COMMITTED before the job exists anywhere, which is what keeps
 * the enqueue-path write off any run transaction's row lock (see @rayspec/platform run-header.ts).
 * It does not run runAgent (the off-request execution is proven against the REAL engine in
 * cron-scheduler.db.test.ts).
 */
class ProbingExecutor implements DurableExecutor {
  readonly enqueued: Array<{ tenantId: string; job: RunJob; headerRowsAtEnqueue: number }> = [];
  async enqueue(tenantId: string, job: RunJob): Promise<EnqueueResult> {
    this.enqueued.push({
      tenantId,
      job,
      headerRowsAtEnqueue: await countHeaderRows(job.runId),
    });
    return { jobId: job.runId };
  }
  async status(): Promise<'unknown'> {
    return 'unknown';
  }
  async cancel(): Promise<void> {}
  async start(): Promise<void> {}
  async shutdown(): Promise<void> {}
  identity(): DurableExecutorIdentity {
    return { executorId: 'stub-executor', applicationVersion: 'stub-version' };
  }
}

/** A stores-free trigger HANDLER — the handler-action arm needs no product table for this suite. */
const noopHandler: ResolvedHandler & { kind: 'trigger' } = {
  kind: 'trigger',
  fn: async () => {},
};

/** A MANUAL→agent descriptor — the on-demand fire whose dispatch enqueues an off-request run. */
function manualAgentDescriptor(name: string): TriggerDescriptor {
  return { name, kind: 'manual', action: { kind: 'agent', agentId: 'digest-agent' } };
}

/** A MANUAL→handler descriptor — dispatches in-process; there is never a run to follow. */
function manualHandlerDescriptor(name: string): TriggerDescriptor {
  return {
    name,
    kind: 'manual',
    action: { kind: 'handler', handlerId: 'noop_handler', handler: noopHandler },
  };
}

type DbHandle = ReturnType<typeof makeDbWithSchema>;
let db: DbHandle;
let stub: ProbingExecutor;

async function countHeaderRows(runId: string): Promise<number> {
  const rows = await db.$client.unsafe('SELECT 1 FROM runs WHERE run_id = $1', [runId]);
  return rows.length;
}

/** Read the one header row for `runId` — the columns the pre-enqueue write must have stamped. */
async function headerRow(
  runId: string,
): Promise<
  { tenant_id: string; backend: string; agent_name: string; model: string; status: string }[]
> {
  return (await db.$client.unsafe(
    'SELECT tenant_id, backend, agent_name, model, status FROM runs WHERE run_id = $1',
    [runId],
  )) as unknown as {
    tenant_id: string;
    backend: string;
    agent_name: string;
    model: string;
    status: string;
  }[];
}

/** Build a scheduler over the stub; `withResolver` toggles the pre-enqueue-header seam. */
function makeScheduler(withResolver: boolean): DbosCronScheduler {
  return new DbosCronScheduler(
    [manualAgentDescriptor('manual-agent'), manualHandlerDescriptor('manual-digest')],
    {
      db,
      tenantId: TENANT,
      executor: stub,
      productTables: new Map<string, PgTable>(),
      invokeTriggerHandler,
      tenantExists: async () => true,
      ...(withResolver
        ? {
            // The composition-root shape: resolve the identity off the agent registry; an unknown
            // agentId answers undefined (best-effort — the dispatch itself is never blocked on it).
            resolveRunHeaderIdentity: (agentId: string) =>
              agentId === 'digest-agent'
                ? { backend: 'openai', agentName: 'digest', model: 'gpt-4o-mini' }
                : undefined,
          }
        : {}),
    },
  );
}

describe.skipIf(!hasDb)(
  'the manual fire surfaces the enqueued runId + writes the header first',
  () => {
    beforeAll(async () => {
      const url = process.env.DATABASE_URL as string;
      db = makeDbWithSchema(url, APP_SCHEMA);
      await db.$client.unsafe(buildSpineSchemaSql(APP_SCHEMA));
      await db.$client.unsafe(`INSERT INTO orgs (id, name, slug) VALUES ($1, 'hdr', 'hdr')`, [
        TENANT,
      ]);
    }, 60_000);

    beforeEach(async () => {
      await db.$client.unsafe('TRUNCATE runs, idempotency_keys CASCADE');
      stub = new ProbingExecutor();
    });

    afterAll(async () => {
      await db.$client.unsafe(`DROP SCHEMA IF EXISTS ${APP_SCHEMA} CASCADE`);
      await db.$client.end();
    });

    it('AGENT action: the outcome carries the deterministic runId, and the header is committed BEFORE the enqueue', async () => {
      const scheduler = makeScheduler(true);
      const instant = new Date('2026-06-24T09:00:00.000Z');
      const runId = cronRunId('manual-agent', instant);

      const outcome = await scheduler.fireNowWithOutcome('manual-agent', instant);

      // The outcome names the run this fire enqueued — the id the job itself carries.
      expect(outcome).toEqual({ fired: true, runId });
      expect(stub.enqueued).toHaveLength(1);
      expect(stub.enqueued[0]?.job.runId).toBe(runId);

      // ORDERING (the #121 alignment): the header row was already committed when the enqueue ran, so
      // the id the fire surface hands back resolves from the first instant — and no worker can hold
      // this runId's header row inside its run transaction when the write runs.
      expect(stub.enqueued[0]?.headerRowsAtEnqueue).toBe(1);

      // The header carries the resolved identity, the `enqueued` status, and the firing tenant.
      const rows = await headerRow(runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({
        tenant_id: TENANT,
        backend: 'openai',
        agent_name: 'digest',
        model: 'gpt-4o-mini',
        status: 'enqueued',
      });
    });

    it('a deduped refire reports { fired: false } with NO runId key and enqueues nothing new', async () => {
      const scheduler = makeScheduler(true);
      const instant = new Date('2026-06-24T09:05:00.000Z');
      await scheduler.fireNowWithOutcome('manual-agent', instant);

      const second = await scheduler.fireNowWithOutcome('manual-agent', instant);

      // A deduped agent fire DOES have a deterministic id — but THIS call dispatched nothing, so the
      // outcome must not offer a run this call did not start (byte-identical to today's shape).
      expect(second).toEqual({ fired: false });
      expect('runId' in second).toBe(false);
      expect(stub.enqueued).toHaveLength(1); // still only the FIRST fire's job
      expect(await countHeaderRows(cronRunId('manual-agent', instant))).toBe(1); // still ONE header
    });

    it('HANDLER action: the outcome carries NO runId and writes NO header (there is no run to follow)', async () => {
      const scheduler = makeScheduler(true);
      const instant = new Date('2026-06-24T09:10:00.000Z');

      const outcome = await scheduler.fireNowWithOutcome('manual-digest', instant);

      expect(outcome).toEqual({ fired: true });
      expect('runId' in outcome).toBe(false);
      expect(stub.enqueued).toHaveLength(0); // a handler dispatch is not an enqueue
      const rows = await db.$client.unsafe('SELECT 1 FROM runs');
      expect(rows).toHaveLength(0);
    });

    it('with NO resolveRunHeaderIdentity injected the fire still dispatches but writes NO header (optional seam)', async () => {
      const scheduler = makeScheduler(false);
      const instant = new Date('2026-06-24T09:15:00.000Z');
      const runId = cronRunId('manual-agent', instant);

      const outcome = await scheduler.fireNowWithOutcome('manual-agent', instant);

      // The dispatch is unaffected — the header write is the injected deployment's alignment, not a
      // precondition of firing.
      expect(outcome).toEqual({ fired: true, runId });
      expect(stub.enqueued).toHaveLength(1);
      expect(stub.enqueued[0]?.headerRowsAtEnqueue).toBe(0);
      expect(await countHeaderRows(runId)).toBe(0);
    });

    it('fireNow keeps its plain boolean surface (the control seam callers are unchanged)', async () => {
      const scheduler = makeScheduler(true);
      const instant = new Date('2026-06-24T09:20:00.000Z');
      expect(await scheduler.fireNow('manual-agent', instant)).toBe(true);
      expect(await scheduler.fireNow('manual-agent', instant)).toBe(false);
    });
  },
);
