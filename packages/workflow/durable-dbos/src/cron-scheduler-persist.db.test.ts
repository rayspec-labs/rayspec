/**
 * The cron→agent output-persist WIRING — DB-backed (real Postgres isolated schema; a capturing STUB
 * executor, NO DBOS engine in this process).
 *
 * The spine test (executor.db.test.ts) proves the LAST hop — a RunJob carrying `persistTo` writes the
 * run output into the resolved store. This suite closes the hop BEFORE it: the cron scheduler must
 * THREAD a cron→agent descriptor's `action.persistTo` onto the RunJob it enqueues. That thread had zero
 * regression coverage — dropping the `persistTo` spread at the scheduler's `enqueue` call kept every
 * existing cron test green (none of them declares a persistTo).
 *
 * Ground truth: fire a cron→agent trigger whose action declares `persistTo` through the REAL `#fire`
 * path (the reserve runs against the real DB; the dispatch enqueues onto a stub that CAPTURES the
 * job) and assert the enqueued `RunJob` carries the exact `persistTo`. Verified fail-the-fix: dropping
 * the `persistTo` spread at the scheduler's `executor.enqueue(...)` call leaves the captured job
 * WITHOUT it → RED. Combined with executor.db.test.ts (RunJob.persistTo → store row), the whole
 * cron→store chain is covered.
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
  type RunJob,
  type TriggerDescriptor,
} from '@rayspec/platform';
import { config as loadDotenv } from 'dotenv';
import type { PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cronRunId, DbosCronScheduler, firingKey, TRIGGER_FIRE_SCOPE } from './index.js';
import { buildSpineSchemaSql } from './test-support/schema-ddl.js';

const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, '..', '..', '..', '..', '.env');
if (existsSync(envPath)) loadDotenv({ path: envPath });

const PID = process.pid;
const APP_SCHEMA = `rayspec_test_dbos_cron_persist_${PID}`;
const TENANT = '00000000-0000-0000-0000-0000000000aa';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
// Un-skippable ran-guard: this DB-backed suite proves the cron→agent persistTo wiring — it must never
// silently self-skip to a false green. When the DB is REQUIRED but absent, hard-fail at collection.
if (requireDb && !hasDb) {
  throw new Error(
    'cron-scheduler-persist.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but ' +
      'absent — refusing to silently skip the cron persistTo wiring proof.',
  );
}

/**
 * A capturing STUB DurableExecutor: records every enqueued (tenantId, job) so the test can assert the
 * WHOLE enqueued RunJob (the persistTo threaded onto it). It does NOT run runAgent — the off-request
 * execution + store-write is proven against the REAL DBOS engine in executor.db.test.ts. `status`/
 * `start`/`shutdown` are inert.
 */
class CapturingExecutor implements DurableExecutor {
  readonly enqueued: Array<{ tenantId: string; job: RunJob }> = [];
  async enqueue(tenantId: string, job: RunJob): Promise<EnqueueResult> {
    this.enqueued.push({ tenantId, job });
    return { jobId: job.runId };
  }
  async status(): Promise<'unknown'> {
    return 'unknown';
  }
  async start(): Promise<void> {}
  async shutdown(): Promise<void> {}
  identity(): DurableExecutorIdentity {
    return { executorId: 'stub-executor', applicationVersion: 'stub-version' };
  }
}

/** A cron→agent descriptor whose action declares an output-persist store. */
function agentPersistDescriptor(name: string): TriggerDescriptor {
  return {
    name,
    kind: 'cron',
    schedule: '0 3 * * *',
    action: { kind: 'agent', agentId: 'extractor-agent', persistTo: 'extracted_facts' },
  };
}

/** A cron→agent descriptor with NO persistTo (the additive-shape companion). */
function agentPlainDescriptor(name: string): TriggerDescriptor {
  return {
    name,
    kind: 'cron',
    schedule: '*/5 * * * *',
    action: { kind: 'agent', agentId: 'extractor-agent' },
  };
}

type DbHandle = ReturnType<typeof makeDbWithSchema>;
let db: DbHandle;
let stub: CapturingExecutor;
let scheduler: DbosCronScheduler;
let persistWiringRan = 0;

describe.skipIf(!hasDb)(
  'cron→agent output-persist wiring (scheduler threads action.persistTo)',
  () => {
    beforeAll(async () => {
      const url = process.env.DATABASE_URL as string;
      db = makeDbWithSchema(url, APP_SCHEMA);
      await db.$client.unsafe(buildSpineSchemaSql(APP_SCHEMA));
      await db.$client.unsafe(`INSERT INTO orgs (id, name, slug) VALUES ($1, 'cron', 'cron')`, [
        TENANT,
      ]);
    }, 60_000);

    beforeEach(async () => {
      await db.$client.unsafe('TRUNCATE idempotency_keys CASCADE');
      stub = new CapturingExecutor();
      // A fresh scheduler per test so a captured enqueue never bleeds across tests. Both descriptors are
      // registered so a single scheduler can drive both the persist and the plain (additive) assertions.
      scheduler = new DbosCronScheduler(
        [agentPersistDescriptor('nightly-extract'), agentPlainDescriptor('nightly-plain')],
        {
          db,
          tenantId: TENANT,
          executor: stub,
          // The cron→agent dispatch path uses neither productTables nor invokeTriggerHandler (those are
          // for the handler-action path), but the deps interface requires them.
          productTables: new Map<string, PgTable>(),
          invokeTriggerHandler,
        },
      );
    });

    afterAll(async () => {
      await db.$client.end();
    });

    it('a cron→agent fire threads the action persistTo onto the enqueued RunJob (the whole job payload)', async () => {
      persistWiringRan += 1;
      const instant = new Date('2026-06-24T03:00:00.000Z');

      const fired = await scheduler.fireNow('nightly-extract', instant);
      expect(fired).toBe(true);

      // GROUND TRUTH: exactly ONE job enqueued, carrying the threaded persistTo (the whole payload,
      // not just presence). Drop the persistTo spread at the scheduler's enqueue call → persistTo absent → RED.
      expect(stub.enqueued).toHaveLength(1);
      const { tenantId, job } = stub.enqueued[0]!;
      expect(tenantId).toBe(TENANT);
      expect(job.persistTo).toBe('extracted_facts');
      expect(job.agentId).toBe('extractor-agent');
      expect(job.tenantId).toBe(TENANT);
      // The deterministic-from-firing-key runId (the same id the engine dedups on).
      expect(job.runId).toBe(cronRunId('nightly-extract', instant));

      // The fire genuinely ran the REAL reserve path (not a stub shortcut): exactly ONE tenant-scoped
      // firing marker was committed under the firing key.
      const key = firingKey('nightly-extract', instant);
      const markers = await db.$client.unsafe(
        'SELECT 1 FROM idempotency_keys WHERE tenant_id = $1 AND scope = $2 AND idem_key = $3',
        [TENANT, TRIGGER_FIRE_SCOPE, key],
      );
      expect(markers).toHaveLength(1);
    });

    it('is ADDITIVE: a cron→agent fire WITHOUT persistTo enqueues a job with NO persistTo key', async () => {
      persistWiringRan += 1;
      const instant = new Date('2026-06-24T03:05:00.000Z');

      const fired = await scheduler.fireNow('nightly-plain', instant);
      expect(fired).toBe(true);
      expect(stub.enqueued).toHaveLength(1);
      const { job } = stub.enqueued[0]!;
      // The conditional spread means the key is ABSENT (never persistTo:undefined) for a plain action.
      expect('persistTo' in job).toBe(false);
      expect(job.agentId).toBe('extractor-agent');
    });
  },
);

/** Ran-guard: hard-fail a REQUIRED run (CI / opt-in) that silently skipped the wiring proof. */
describe('cron→agent persistTo wiring — ran-guard (no silent CI skip)', () => {
  it('ran the persistTo wiring proofs when the DB is required', () => {
    if (requireDb) expect(persistWiringRan).toBeGreaterThan(0);
    else expect(true).toBe(true);
  });
});
