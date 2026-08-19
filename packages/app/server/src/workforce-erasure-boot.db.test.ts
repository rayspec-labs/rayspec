/**
 * TENANT ERASURE ON A STORE-LESS WORKFORCE DEPLOYMENT — the boot-shape oracle.
 *
 * The task engine put subject content in the database on a deployment shape that declares NO product
 * stores: both shipped workforce examples (`examples/workforce-starter`, `examples/workforce-maintainers`)
 * declare zero `stores:`, while their databases hold task titles/goals/descriptions/results, message
 * bodies, approval questions and free-text reasons, review reasons, delegation goals — and the whole
 * `run_events` journal under BOTH workforce namespaces (`run_id = <taskId>` and
 * `run_id = workforce:<id>`). The erasure control seam is what an operator reaches that data through,
 * so it must be WIRED on exactly this shape.
 *
 * This boots the REAL composition root (`assembleServer`) against a throwaway DATABASE with a
 * store-less workforce document — the canonical shape, `durableWorker: true` and a deployment task
 * tenant — and asserts on ground truth:
 *
 *   1. ACCEPT CONTROL — the boot really IS store-less (`deployMode: 'auth-only'`, zero declared
 *      routes). Without this arm, arm 2 could pass on a boot that quietly carried a store.
 *   2. THE SEAM IS WIRED — `server.eraseTenantNow` is defined. This is the arm that goes RED against
 *      a composition root that gates the seam on product stores alone.
 *   3. THE BANNER IS HONEST — it reports the resolved gate posture (DRY-RUN here, since
 *      RAYSPEC_ERASURE_ENABLED is deliberately unset) and never NOT WIRED, which would tell an
 *      operator this deployment holds nothing to erase.
 *   4. THE SEAM REACHES THE WORKFORCE ROWS — with the operator gate OFF, a call previews
 *      (`mode:'dry-run'`, `dryRunReason:'gate-disabled'`) and reports NON-ZERO counts for all nine
 *      workforce tables and for the workforce-shaped journal rows, while deleting nothing. Counts
 *      come from the seeded rows, so a seam wired to an empty enumeration cannot pass.
 *
 * WHY THE REAL ERASE IS NOT DRIVEN HERE. This boot launches the live task scheduler, whose passes scan
 * `queued` / `planned` / `blocked` / `working` rows. The fixture is therefore seeded in TERMINAL and
 * decided states so no pass can mutate it mid-assertion, and the gate stays OFF so the suite never
 * races a delete against a running dispatcher. The gate-ON erasure of the same nine tables is proven
 * on ground truth, with a cross-tenant witness, in `erase-tenant.db.test.ts`.
 *
 * THE EXPERIMENTAL FLAG is set BY THIS SUITE around its own boot and restored afterwards — never
 * exported around a whole test run, which would corrupt the suites that assert flag-UNSET behaviour
 * off the ambient environment.
 *
 * DB ISOLATION: a whole throwaway DATABASE plus the derived `<appdb>_dbos_sys` DBOS system database,
 * both dropped on teardown — the same posture as `durable-worker-boot.db.test.ts`.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentSpec, Backend, BackendId, RunContext, RunResult } from '@rayspec/core';
import { type Db, forTenant, makeDb, schema } from '@rayspec/db';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { bootBanner } from './banner.js';
import {
  applyMigrations,
  assembleServer,
  type BootedServer,
  deriveDbosSystemUrl,
  loadServerConfig,
} from './composition-root.js';

/** The deployment task tenant — RAYSPEC_CRON_TENANT_ID, the org the workforce runs under. */
const TASK_TENANT = '00000000-0000-4000-8000-0000000000e1';

/**
 * A network-free Backend wired as `openai` so the declared employee's agent resolves and the durable
 * worker comes up. No boot here reaches a run, so `run()` is never called.
 */
class InertBackend implements Backend {
  readonly id = 'openai' as const;
  async resolveAuth() {
    return 'api-key' as const;
  }
  async run(_spec: AgentSpec, _ctx: RunContext): Promise<RunResult> {
    throw new Error('InertBackend.run must never be called — this suite dispatches no turn.');
  }
}

/**
 * The document under test: a workforce and NOT ONE product store — the shape both shipped workforce
 * examples have. `durableWorker: true` + the task tenant is what wires the engine at all.
 */
const SPEC_YAML = `
version: '1.0'
metadata:
  name: workforce-erasure-boot
  description: store-less workforce deployment - the shape the erasure seam must still be wired on
deployment:
  durableWorker: true
agents:
  - id: lead_agent
    name: lead_agent
    backend: openai
    model: gpt-4o-mini
    instructions: Coordinate.
workforce:
  id: helpdesk
  name: Helpdesk
  orchestrator: lead
  employees:
    - id: lead
      agent: lead_agent
      title: Lead
      role: orchestrator
`;

function adminUrl(url: string): string {
  const u = new URL(url);
  u.pathname = '/postgres';
  return u.toString();
}
function withDbName(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

const SUITE_DB = `rayspec_wf_erase_${process.pid}`;
const BASE = 'http://127.0.0.1:8080';

/** The nine task-engine tables, by SQL name — the set tenant erasure must reach on this boot. */
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

/** The task id the seeded journal rows use as their per-task stream (`run_id = <taskId>`). */
const SEEDED_TASK_ID = 'task-erase-boot-0';
/** The workforce control stream (`run_id = workforce:<workforceId>`). */
const SEEDED_CONTROL_STREAM = 'workforce:helpdesk';

const baseUrl = process.env.DATABASE_URL;
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
// Un-skippable ran-guard (fires at collection): a data-protection boot proof must never silently
// self-skip to a false green.
if (requireDb && !baseUrl) {
  throw new Error(
    'workforce-erasure-boot.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but ' +
      'absent — refusing to silently skip this DB-backed suite.',
  );
}
let armsRan = 0;
const ARM_COUNT = 4;

describe('store-less workforce boot — the tenant-erasure seam is wired and reaches the task engine', () => {
  const maybe = baseUrl ? it : it.skip;

  let server: BootedServer | undefined;
  let db: Db | undefined;
  let appDbUrl = '';
  let dbosSysDb = '';
  let tmpDir = '';
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    'RAYSPEC_JWT_SIGNING_KEY',
    'RAYSPEC_API_KEY_PEPPER',
    'DATABASE_URL',
    'ALLOWED_ORIGINS',
    'PORT',
    'RAYSPEC_SPEC_PATH',
    'DBOS_SYSTEM_DATABASE_URL',
    'RAYSPEC_CRON_TENANT_ID',
    'RAYSPEC_EXPERIMENTAL_WORKFORCE',
    'RAYSPEC_ERASURE_ENABLED',
  ] as const;

  beforeAll(async () => {
    if (!baseUrl) return;
    appDbUrl = withDbName(baseUrl, SUITE_DB);
    dbosSysDb = `${SUITE_DB}_dbos_sys`;

    const admin = postgres(adminUrl(baseUrl), { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${dbosSysDb}" WITH (FORCE)`);
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE "${SUITE_DB}"`);
    } finally {
      await admin.end();
    }

    // Materialize the platform BEFORE the boot so the task tenant's org row exists: the boot's
    // declared-workforce runtime upsert carries `tenant_id -> orgs(id)`, which FK-violates against an
    // absent org. `assembleServer` re-runs the same chain idempotently.
    db = makeDb(appDbUrl);
    await applyMigrations(db);
    await db.$client.unsafe('INSERT INTO orgs (id, name, slug) VALUES ($1,$2,$3)', [
      TASK_TENANT,
      'Workforce Erasure Co',
      'wf-erase',
    ]);

    tmpDir = mkdtempSync(join(tmpdir(), 'rayspec-wf-erase-boot-'));
    const specPath = join(tmpDir, 'rayspec.yaml');
    writeFileSync(specPath, SPEC_YAML, 'utf8');

    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    process.env.RAYSPEC_JWT_SIGNING_KEY = await exportPKCS8(privateKey);
    process.env.RAYSPEC_API_KEY_PEPPER = 'wf-erase-boot-pepper-only';
    process.env.DATABASE_URL = appDbUrl;
    delete process.env.ALLOWED_ORIGINS;
    process.env.PORT = '8809';
    process.env.RAYSPEC_SPEC_PATH = specPath;
    delete process.env.DBOS_SYSTEM_DATABASE_URL; // exercise the derived <appdb>_dbos_sys path
    process.env.RAYSPEC_CRON_TENANT_ID = TASK_TENANT;
    // Set HERE, not around the run: suites that assert the flag-UNSET refusal read the ambient value.
    process.env.RAYSPEC_EXPERIMENTAL_WORKFORCE = '1';
    // Deliberately UNSET — the gate-off (preview) posture every arm below is written against.
    delete process.env.RAYSPEC_ERASURE_ENABLED;

    const config = loadServerConfig();
    expect(config.erasureEnabled).toBe(false); // the arms below assert the DRY-RUN posture
    expect(deriveDbosSystemUrl(appDbUrl)).toBe(withDbName(baseUrl, dbosSysDb));

    server = await assembleServer(config, {
      agentBackendsFactory: (): ReadonlyMap<BackendId, Backend> =>
        new Map<BackendId, Backend>([['openai', new InertBackend()]]),
    });
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    if (db) await db.$client.end();
    for (const k of ENV_KEYS) {
      const v = savedEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    if (baseUrl) {
      const admin = postgres(adminUrl(baseUrl), { max: 1 });
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${dbosSysDb}" WITH (FORCE)`);
        await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    }
  }, 120_000);

  /**
   * Seed one row into each of the nine task-engine tables plus BOTH workforce journal namespaces, all
   * in TERMINAL / decided states so no scheduler pass (the `queued` reserve scan, the `planned`
   * promotion, the `blocked` wake, the `working` reap, the pending-approval timeout sweep) can touch
   * them while the arms read. `workforce_runtime` already carries the row the boot's own declared-
   * workforce upsert wrote, so it is counted rather than re-inserted (its unique
   * `(tenant_id, workforce_id)` would collide).
   */
  async function seedWorkforceRows(tenantId: string): Promise<void> {
    const tdb = forTenant(db as Db, tenantId);
    await tdb.insert(schema.workforceTasks as never, {
      taskId: SEEDED_TASK_ID,
      workforceId: 'helpdesk',
      rootTaskId: SEEDED_TASK_ID,
      title: 'Subject content in the title',
      goal: 'Subject content in the goal',
      description: 'Subject content in the description',
      owner: 'lead',
      requestedBy: 'user',
      status: 'completed',
      result: { text: 'subject content in the result' },
      artifacts: [{ kind: 'text', value: 'subject content in an artifact' }],
    });
    await tdb.insert(schema.workforceTaskTransitions as never, {
      taskId: SEEDED_TASK_ID,
      fromStatus: 'working',
      toStatus: 'completed',
      actor: 'lead',
    });
    await tdb.insert(schema.workforceTaskSignals as never, {
      taskId: SEEDED_TASK_ID,
      kind: 'child_completed',
      signalKey: 'child:erase-boot-0',
      consumedAt: new Date(),
    });
    await tdb.insert(schema.workforceDelegations as never, {
      workforceId: 'helpdesk',
      parentTaskId: SEEDED_TASK_ID,
      childTaskId: 'task-erase-boot-child',
      delegatedBy: 'lead',
      delegatedTo: 'lead',
      resolvedOwner: 'lead',
      goal: 'Subject content in the delegated goal',
      // NOT subject content — every production writer is the engine's own 'worker_result'
      // literal, so the scrub deliberately keeps this column. Seeded only to satisfy NOT NULL.
      expectedOutput: 'worker_result',
      depth: 1,
      status: 'completed',
    });
    await tdb.insert(schema.workforceApprovals as never, {
      taskId: SEEDED_TASK_ID,
      question: 'Subject content in the approval question',
      approver: 'user',
      status: 'approved',
      decision: 'approve',
      decidedBy: 'user',
      reason: 'Subject content in the decision reason',
      onTimeout: 'fail',
      decidedAt: new Date(),
    });
    await tdb.insert(schema.workforceReviews as never, {
      taskId: SEEDED_TASK_ID,
      reviewer: 'lead',
      round: 1,
      verdict: 'accept',
      reasons: ['Subject content in a review reason'],
      requiredChanges: [],
      decidedAt: new Date(),
    });
    await tdb.insert(schema.workforceMessages as never, {
      taskId: SEEDED_TASK_ID,
      sender: 'lead',
      recipient: 'user',
      body: 'Subject content in a message body',
    });
    await tdb.insert(schema.workforceBudgetLedger as never, {
      scopeKind: 'task',
      scopeId: SEEDED_TASK_ID,
      windowStart: new Date(0),
      reservedUsd: '0.5000',
      settledUsd: '0.2500',
      settledTurns: 1,
    });
    // BOTH journal namespaces: the per-task stream and the workforce control stream. The agent-run
    // streams that share this table are the shape the erasure suite already covered; these two are
    // the workforce-shaped rows nothing asserted on.
    await tdb.insert(schema.runEvents as never, [
      {
        runId: SEEDED_TASK_ID,
        seq: '1',
        type: 'workforce.task.completed',
        data: { v: 1, type: 'workforce.task.completed' },
      },
      {
        runId: SEEDED_CONTROL_STREAM,
        seq: '1',
        type: 'workforce.budget.settled',
        data: { v: 1, type: 'workforce.budget.settled' },
      },
    ]);
  }

  /** Ground-truth count of the workforce-shaped journal rows for one tenant (both namespaces). */
  async function workforceJournalCount(tenantId: string): Promise<number> {
    const rows = (await (db as Db).$client.unsafe(
      "SELECT count(*)::int AS n FROM run_events WHERE tenant_id = $1 AND (run_id = $2 OR run_id LIKE 'workforce:%')",
      [tenantId, SEEDED_TASK_ID],
    )) as unknown as { n: number }[];
    return rows[0].n;
  }

  maybe('1. accept control — this boot really did deploy ZERO product stores', () => {
    expect(server?.deployMode).toBe('auth-only');
    expect(server?.declaredRoutes).toEqual([]);
    // The workforce IS deployed: the declared-workforce upsert wrote the runtime row.
    expect(server?.declaredAgents.map((a) => a.id)).toEqual(['lead_agent']);
    armsRan++;
  });

  maybe('2. the tenant-erasure control seam is WIRED on a store-less workforce boot', () => {
    expect(server?.eraseTenantNow).toBeDefined();
    armsRan++;
  });

  maybe('3. the banner reports the resolved gate posture — never NOT WIRED', () => {
    const banner = bootBanner(server as BootedServer, BASE);
    expect(banner).toContain('Tenant data erasure:   DRY-RUN');
    expect(banner).not.toContain('Tenant data erasure:   NOT WIRED');
    expect(banner).toContain('RAYSPEC_ERASURE_ENABLED');
    armsRan++;
  });

  maybe(
    '4. a gate-off call PREVIEWS the workforce rows — non-zero counts, zero deletes',
    async () => {
      await seedWorkforceRows(TASK_TENANT);
      const seededJournal = await workforceJournalCount(TASK_TENANT);
      expect(seededJournal).toBe(2); // the seed is real, so the counts below cannot be vacuously 0

      const res = await (server as BootedServer).eraseTenantNow?.(TASK_TENANT);
      expect(res).toBeDefined();
      expect(res?.mode).toBe('dry-run');
      expect(res?.dryRunReason).toBe('gate-disabled');

      // Every one of the nine reports a NON-ZERO would-delete count — the seam reaches the whole
      // task engine, not merely the tables that happen to be named in the delete order.
      for (const name of WORKFORCE_TABLES) {
        expect(res?.coreTables[name]).toBeGreaterThan(0);
      }
      // The journal half: both workforce namespaces are inside the `run_events` count.
      expect(res?.coreTables.run_events).toBeGreaterThanOrEqual(2);

      // A PREVIEW MUTATES NOTHING — the rows are all still there afterwards.
      expect(await workforceJournalCount(TASK_TENANT)).toBe(seededJournal);
      const tasks = await forTenant(db as Db, TASK_TENANT)
        .select(schema.workforceTasks as never)
        .all();
      expect(tasks.length).toBeGreaterThan(0);
      armsRan++;
    },
  );
});

/**
 * FIXTURE FIDELITY — the premise this whole suite rests on, asserted against the SHIPPED documents
 * rather than assumed. The fixture above is hand-written (a boot needs a temp spec path), so nothing
 * otherwise ties it to the deployments it claims to stand for. These two examples ARE the canonical
 * open-core workforce deployments; if either ever grows a `stores:` section, the store-less path stops
 * being the shape they have and this suite's relevance has to be re-argued rather than silently
 * assumed. Needs no database — it reads two files.
 */
describe('the shipped workforce examples are the store-less shape this suite fixtures', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, '..', '..', '..', '..');
  for (const name of ['workforce-starter', 'workforce-maintainers']) {
    it(`examples/${name} declares a workforce and NO product stores`, () => {
      const doc = parseYaml(
        readFileSync(join(repoRoot, 'examples', name, 'rayspec.yaml'), 'utf8'),
      ) as Record<string, unknown>;
      expect(doc.workforce).toBeDefined();
      expect(doc.stores).toBeUndefined();
    });
  }
});

/**
 * Ran-guard: a SEPARATE, NON-skipped describe that FAILS the run when the DB is REQUIRED
 * (CI / RAYSPEC_REQUIRE_DB_TESTS) but the arms did NOT run — a CI run that lost DATABASE_URL would
 * otherwise silently skip the proof that a workforce deployment can erase a tenant at all.
 */
describe('store-less workforce erasure boot — ran-guard', () => {
  it('the boot arms ACTUALLY RAN when the DB is required (CI / opt-in)', () => {
    if (requireDb) {
      expect(armsRan).toBe(ARM_COUNT);
    } else {
      expect(requireDb).toBe(false);
    }
  });
});
