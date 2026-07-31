/**
 * LATE-BOUND cron tenant — DB-backed (real Postgres isolated schema; a capturing STUB executor, NO
 * DBOS engine in this process).
 *
 * A deployment may be configured with the org id its cron triggers fire under BEFORE the `orgs` row
 * carrying that id exists — and, the other way round, that row may be soft-deleted while the
 * deployment keeps running.
 * The scheduler therefore has to answer the existence question PER FIRING rather than once at wiring
 * time, and it must answer it fail-closed: a firing whose deployment tenant is not (yet) an existing
 * org DISPATCHES NOTHING.
 *
 * Ground truth this suite pins, over the REAL `#fire` path (the reserve runs against the real DB):
 *
 *  1. TENANT ABSENT ⇒ SKIP: `fireNow` returns false, the stub executor received NOTHING, and NO
 *     firing marker was written — so the instant was NOT consumed.
 *  2. EXACTLY ONE LOG LINE per skipped firing (not a stack, not a repeated block), naming the trigger,
 *     the firing instant and the tenant so an operator can act on it.
 *  3. THE SKIPPED INSTANT STILL FIRES once the org appears — the SAME scheduler instance, the SAME
 *     firing instant, no re-construction and no restart. This is the observable consequence of (1)'s
 *     "no marker written": had the skip consumed the marker, this fire would dedup to a no-op forever.
 *  4. The existence question is asked ON EVERY FIRING (the probe call count rises with each fire), so
 *     an org that appears at 03:00 is picked up at 03:00 — nothing is cached from wiring time.
 *  5. FAIL-THE-FIX CONTROL: with the org present from the start the fire dispatches normally and logs
 *     NOTHING, so the skip is driven by the missing org and not by the mere presence of the probe.
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
import { DbosCronScheduler, firingInstantIso, firingKey, TRIGGER_FIRE_SCOPE } from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, '..', '..', '..', '..', '.env');
if (existsSync(envPath)) loadDotenv({ path: envPath });

const PID = process.pid;
const APP_SCHEMA = `rayspec_test_dbos_cron_late_${PID}`;
/** The tenant whose org EXISTS from the start (the control arm). */
const PRESENT_TENANT = '00000000-0000-0000-0000-0000000000aa';
/** The tenant whose org does NOT exist yet — created MID-SUITE to prove the late binding. */
const LATE_TENANT = '00000000-0000-0000-0000-0000000000dd';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
// Un-skippable ran-guard: this DB-backed suite proves that nothing dispatches under an unknown
// tenant — it must never silently self-skip to a false green. When the DB is REQUIRED but absent,
// hard-fail at collection rather than skip.
if (requireDb && !hasDb) {
  throw new Error(
    'cron-scheduler-late-binding.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) ' +
      'but absent — refusing to silently skip the late-bound-tenant fail-closed proof.',
  );
}

/**
 * A capturing STUB DurableExecutor: records every enqueued job so a SKIPPED firing can be asserted to
 * have dispatched literally nothing. It does not run runAgent (the off-request execution is proven
 * against the REAL engine in executor.db.test.ts).
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

/** A cron→agent descriptor (the dispatch is an enqueue, so the stub observes it whole). */
function agentDescriptor(name: string): TriggerDescriptor {
  return {
    name,
    kind: 'cron',
    schedule: '0 3 * * *',
    action: { kind: 'agent', agentId: 'digest-agent' },
  };
}

/** A manual descriptor — the on-demand fire path is covered by the SAME rule. */
function manualDescriptor(name: string): TriggerDescriptor {
  return { name, kind: 'manual', action: { kind: 'agent', agentId: 'digest-agent' } };
}

type DbHandle = ReturnType<typeof makeDbWithSchema>;
let db: DbHandle;
let stub: CapturingExecutor;
let logged: string[];
let probeCalls: number;

/** Count the firing markers for (tenant, key) — zero proves the skipped instant was not consumed. */
async function countFireMarkers(tenant: string, key: string): Promise<number> {
  const rows = await db.$client.unsafe(
    'SELECT 1 FROM idempotency_keys WHERE tenant_id = $1 AND scope = $2 AND idem_key = $3',
    [tenant, TRIGGER_FIRE_SCOPE, key],
  );
  return rows.length;
}

/**
 * The existence probe the deployment injects — the same question the composition root's
 * `cronTenantExists` asks (an org row that is not soft-deleted). Counted so the suite can prove it is
 * asked per firing rather than cached.
 */
function tenantExistsProbe(tenantId: string): () => Promise<boolean> {
  return async () => {
    probeCalls += 1;
    const rows = await db.$client.unsafe(
      'SELECT 1 FROM orgs WHERE id = $1 AND deleted_at IS NULL LIMIT 1',
      [tenantId],
    );
    return rows.length > 0;
  };
}

/** Build a scheduler over `tenantId` with the counting probe + a capturing log sink. */
function makeScheduler(tenantId: string): DbosCronScheduler {
  return new DbosCronScheduler([agentDescriptor('nightly-digest'), manualDescriptor('kick-off')], {
    db,
    tenantId,
    executor: stub,
    // The cron→agent dispatch path uses neither of these (they serve the handler-action path), but
    // the deps interface requires them.
    productTables: new Map<string, PgTable>(),
    invokeTriggerHandler,
    tenantExists: tenantExistsProbe(tenantId),
    logger: { warn: (m: string) => logged.push(m) },
  });
}

describe.skipIf(!hasDb)('cron firing under a LATE-BOUND deployment tenant', () => {
  beforeAll(async () => {
    const url = process.env.DATABASE_URL as string;
    db = makeDbWithSchema(url, APP_SCHEMA);
    // A minimal spine: the firing marker table plus its orgs FK target (the whole point of the suite
    // is which org rows exist, so orgs is seeded with ONLY the control tenant).
    await db.$client.unsafe(`
      DROP SCHEMA IF EXISTS ${APP_SCHEMA} CASCADE;
      CREATE SCHEMA ${APP_SCHEMA};
      CREATE TABLE orgs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL, slug text NOT NULL,
        region text NOT NULL DEFAULT 'eu', retention_days integer, external_idp_id text,
        created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
      );
      CREATE TABLE idempotency_keys (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        scope text NOT NULL, idem_key text NOT NULL, body_hash text NOT NULL, snapshot jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX idem_tenant_scope_key_idx ON idempotency_keys (tenant_id, scope, idem_key);
    `);
    await db.$client.unsafe(`INSERT INTO orgs (id, name, slug) VALUES ($1, 'present', 'present')`, [
      PRESENT_TENANT,
    ]);
  }, 60_000);

  beforeEach(async () => {
    await db.$client.unsafe('TRUNCATE idempotency_keys CASCADE');
    await db.$client.unsafe('DELETE FROM orgs WHERE id = $1', [LATE_TENANT]);
    stub = new CapturingExecutor();
    logged = [];
    probeCalls = 0;
  });

  afterAll(async () => {
    await db.$client.unsafe(`DROP SCHEMA IF EXISTS ${APP_SCHEMA} CASCADE`);
    await db.$client.end();
  });

  it('a firing whose tenant org does NOT exist yet dispatches NOTHING and consumes NO firing instant', async () => {
    const scheduler = makeScheduler(LATE_TENANT);
    const instant = new Date('2026-06-24T03:00:00.000Z');

    const fired = await scheduler.fireNow('nightly-digest', instant);

    // Fail-closed: no dispatch, and the call reports that it did not fire.
    expect(fired).toBe(false);
    expect(stub.enqueued).toHaveLength(0);
    // The instant was NOT consumed — no marker row exists, so the slot can still fire later.
    expect(await countFireMarkers(LATE_TENANT, firingKey('nightly-digest', instant))).toBe(0);
  });

  it('a skipped firing logs EXACTLY ONE line, naming the trigger, the instant and the tenant', async () => {
    const scheduler = makeScheduler(LATE_TENANT);
    const instant = new Date('2026-06-24T03:00:00.000Z');

    await scheduler.fireNow('nightly-digest', instant);

    expect(logged).toHaveLength(1);
    const line = logged[0] as string;
    expect(line).not.toContain('\n'); // ONE line — never a stack or a multi-line block
    expect(line).toContain('nightly-digest');
    expect(line).toContain(firingInstantIso(instant));
    expect(line).toContain(LATE_TENANT);
  });

  it('the SAME instant fires once the org appears — no re-wiring, no restart', async () => {
    const scheduler = makeScheduler(LATE_TENANT);
    const instant = new Date('2026-06-24T03:00:00.000Z');
    const key = firingKey('nightly-digest', instant);

    // Before: skipped (nothing dispatched, nothing consumed).
    expect(await scheduler.fireNow('nightly-digest', instant)).toBe(false);
    const probesAfterSkip = probeCalls;

    // The org is registered against the running application — no boot, no re-construction.
    await db.$client.unsafe(`INSERT INTO orgs (id, name, slug) VALUES ($1, 'late', 'late')`, [
      LATE_TENANT,
    ]);

    // After: the SAME scheduler instance fires the SAME instant, because the skip never burned it.
    expect(await scheduler.fireNow('nightly-digest', instant)).toBe(true);
    expect(stub.enqueued).toHaveLength(1);
    expect(stub.enqueued[0]?.tenantId).toBe(LATE_TENANT);
    expect(await countFireMarkers(LATE_TENANT, key)).toBe(1);
    // The existence question was asked AGAIN for the second firing (not cached at wiring time) —
    // which is exactly why the org appearing mid-life needs no restart.
    expect(probeCalls).toBeGreaterThan(probesAfterSkip);
    // The at-most-once invariant is untouched: a third fire of that instant is a deduped no-op.
    expect(await scheduler.fireNow('nightly-digest', instant)).toBe(false);
    expect(stub.enqueued).toHaveLength(1);
  });

  it('the ON-DEMAND (manual) fire path is covered by the same rule — it neither fires nor reports success', async () => {
    const scheduler = makeScheduler(LATE_TENANT);
    const instant = new Date('2026-06-24T03:05:00.000Z');

    const fired = await scheduler.fireNow('kick-off', instant);

    expect(fired).toBe(false);
    expect(stub.enqueued).toHaveLength(0);
    expect(await countFireMarkers(LATE_TENANT, firingKey('kick-off', instant))).toBe(0);
    expect(logged).toHaveLength(1);
  });

  it('FAIL-THE-FIX CONTROL: with the org present the fire dispatches normally and logs nothing', async () => {
    const scheduler = makeScheduler(PRESENT_TENANT);
    const instant = new Date('2026-06-24T03:00:00.000Z');

    expect(await scheduler.fireNow('nightly-digest', instant)).toBe(true);
    expect(stub.enqueued).toHaveLength(1);
    expect(await countFireMarkers(PRESENT_TENANT, firingKey('nightly-digest', instant))).toBe(1);
    expect(logged).toEqual([]); // the skip line belongs to the missing org, not to every firing
  });
});
