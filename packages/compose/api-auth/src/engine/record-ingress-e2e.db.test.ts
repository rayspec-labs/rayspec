/**
 * The RECORD SUBMIT-INGRESS end-to-end on the COMPOSED stack.
 *
 * A NEW record-triggered fixture product ("intake") declares the `record_input` capability and a
 * workflow whose ONLY business step is a store_write sourcing BOTH an envelope key (`record_id`)
 * AND a MERGED top-level business field (`title`) from the trigger payload. It deploys through the
 * REAL `deploy()` pipeline (validate → compose → migrate → roll out → drift) and runs on the REAL
 * `DurableWorkflowEngine` + TenantDb journal. Proves, ground-truth:
 *
 *  (a) the CONDITIONAL capability mount MATERIALIZES: `record_submissions` (capability-owned) +
 *      `intake_requests` (declared) with the injected tenancy/GDPR columns + the REAL unique
 *      indexes (pg_catalog end-state), drift-clean;
 *  (b) POST submit → the workflow runs: ONE durable run, the store row carries the MERGED
 *      business field (title) — the payload contract live end-to-end;
 *  (c) an IDENTICAL re-submit (different key ORDER) RE-EMITS the deduped event: deduped:true over
 *      HTTP, the SAME run id `deduped:true` at the enqueuer, and after a double drain STILL ONE
 *      workflow_runs row + ONE intake row + ONE record_submissions row (client retry =
 *      redelivery);
 *  (d) a DIFFERENT payload for the same record key is a LOUD 409 `record_conflict`: the STORED
 *      authoritative event is RE-EMITTED (the heal — a persisted-but-never-enqueued record
 *      is recovered by ANY retry payload) and DEDUPS to the SAME durable run (zero double-run);
 *      stored rows byte-untouched (never a silent dedup onto different data);
 *  (e) the store-sourced VIEW serves through the REAL HTTP app (shape + absent + 401 +
 *      cross-tenant blindness);
 *  (f) a CROSS-TENANT submit (tenant B against the A-bound deployment) is the clean deliberate
 *      403 `record_event_rejected` with ZERO enqueue + ZERO workflow_runs + ZERO intake rows for
 *      B — while B's OWN capability-owned submission row persists under B's tenant (the audio
 *      seal-persists-then-emit-rejects posture, mirrored + pinned), and the tenant-PREFIXED
 *      `record_ref` values prove the per-tenant keying (pg_catalog index posture pinned);
 *  (g) the payload bounds live over HTTP: reserved envelope key → 422; oversized record → 413;
 *      non-object body → 422; each with zero enqueue + zero rows;
 *  (h) an unauthenticated submit is 401 (the standard bearer chain owns the route).
 *
 * Skips without DATABASE_URL — but HARD-FAILS when the DB is required (CI /
 * RAYSPEC_REQUIRE_DB_TESTS) yet absent (un-skippable ran-guard at the bottom).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forTenant, generateProductSql } from '@rayspec/db';
import type { WorkflowInputEvent, WorkflowSpec } from '@rayspec/foundation';
import { makeFsBlobStoreFactory } from '@rayspec/platform';
import type { ComposedProductDeploy } from '@rayspec/product-yaml';
import {
  composeCapabilityStores,
  deriveConflictKeys,
  deriveProductStores,
} from '@rayspec/product-yaml';
import { type ProductSpec, parseProductSpec } from '@rayspec/spec';
import {
  DurableWorkflowEngine,
  durableWorkflowRunId,
  TenantDbWorkflowJournalStore,
  type WorkflowEnqueuer,
} from '@rayspec/workflow-durable';
import type { PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthApp } from '../app.js';
import { createMediaTokenService } from '../media/media-token.js';
import { createDeployHarness, type DeployHarness, jsonRequest } from '../test-support/harness.js';
import { type DeployResult, deploy } from './deploy.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (requireDb && !hasDb) {
  throw new Error(
    'record-ingress-e2e.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but ' +
      'absent — refusing to silently skip the record-ingress end-to-end.',
  );
}

const SCHEMA = 'rayspec_test_intake_e2e';
const TENANT_A = '00000000-0000-4000-8000-0000000000f2';
const RECORD = 'intake-req-1';

/**
 * The intake fixture product (a self-contained sibling of @rayspec/product-yaml's test-support
 * INTAKE_YAML — each is a test fixture, not a KEEP-IN-SYNC pair): the record_input capability, ONE
 * declared store, a record-triggered store_write workflow, a store-sourced view.
 */
const INTAKE_YAML = `
version: "1.0"
product:
  id: intake
  name: Intake
  description: A neutral submit-ingress product proving the record_input composition end-to-end.
requires:
  capabilities: [record_input]
capabilities:
  - id: record_input
    tier: B
    status: available
    contracts: [record_input.record_submitted]
contracts:
  intake.request_row:
    type: object
  intake.status_response:
    type: object
    additional_properties: false
    properties:
      record_id: { type: string }
      title: { type: [string, "null"] }
      status: { type: [string, "null"] }
    required: [record_id, title, status]
stores:
  - name: intake_requests
    columns:
      - { name: request_ref, type: text }
      - { name: record_id, type: text }
      - { name: title, type: text }
      - { name: status, type: text }
    key: [request_ref]
workflows:
  - id: log_request
    trigger:
      capability: record_input
      event: record_submitted
      scope: record
    steps:
      - id: log
        type: store_write
        use: store.write
        store: intake_requests
        values:
          request_ref: { event: record_id }
          record_id: { event: record_id }
          title: { event: title }
          status: { const: received }
        outputs:
          row: intake.request_row
views:
  - id: request_status_view
    route:
      method: GET
      path: "/intake/{record_id}/status"
    auth: bearer_tenant
    params:
      record_id: { in: path, shape: safe_id }
    source: { kind: store, ref: intake_requests }
    read:
      mode: single
      filter:
        record_id: { param: record_id }
      shape:
        fields:
          record_id: { kind: param, param: record_id }
          title: { kind: column, column: title, type: string }
          status: { kind: column, column: status, type: string }
      absent:
        fields:
          record_id: { kind: param, param: record_id }
          title: { kind: const, value: null }
          status: { kind: const, value: null }
    absent_state: empty_200
    response_contract: intake.status_response
`;

/** The workflow journal tables (the api-auth core DDL predates them; the engine needs them). */
const WORKFLOW_JOURNAL_DDL = `
  CREATE TABLE IF NOT EXISTS workflow_runs (
    workflow_run_id text PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    workflow_id text NOT NULL, idempotency_key text NOT NULL, trigger_event text NOT NULL,
    input_event jsonb NOT NULL, status text NOT NULL, resumable boolean NOT NULL DEFAULT false,
    error jsonb, attempts numeric NOT NULL DEFAULT '0',
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS workflow_runs_tenant_wf_idem_idx
    ON workflow_runs (tenant_id, workflow_id, idempotency_key);
  CREATE TABLE IF NOT EXISTS workflow_node_states (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    workflow_run_id text NOT NULL, node_id text NOT NULL, position numeric NOT NULL DEFAULT '0',
    capability text NOT NULL, operation text NOT NULL, status text NOT NULL,
    attempts jsonb NOT NULL DEFAULT '[]'::jsonb, attempt_count numeric NOT NULL DEFAULT '0',
    artifact_refs jsonb NOT NULL DEFAULT '[]'::jsonb, output jsonb, error jsonb,
    skipped_reason text, produced_by text, cost_usd numeric NOT NULL DEFAULT '0',
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS workflow_node_states_run_node_idx
    ON workflow_node_states (tenant_id, workflow_run_id, node_id);
  CREATE TABLE IF NOT EXISTS workflow_artifacts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    artifact_id text NOT NULL, workflow_run_id text, kind text NOT NULL,
    namespace text NOT NULL, scope text NOT NULL, content_hash text NOT NULL,
    version numeric NOT NULL DEFAULT '1', content jsonb NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS workflow_artifacts_tenant_artifact_idx
    ON workflow_artifacts (tenant_id, artifact_id);
`;

/** Record-then-drain enqueuer: the journal (not memory) is the dedup authority. */
class DrainEnqueuer implements WorkflowEnqueuer {
  readonly calls: Array<{ workflowRunId: string; deduped: boolean; idempotencyKey: string }> = [];
  readonly #jobs: Array<{
    tenantId: string;
    workflow: WorkflowSpec;
    event: WorkflowInputEvent;
    idempotencyKey: string;
  }> = [];
  readonly #seen = new Set<string>();
  #db?: DeployHarness['db'];
  #product?: ComposedProductDeploy;
  #productTables?: ReadonlyMap<string, PgTable>;

  bind(
    db: DeployHarness['db'],
    product: ComposedProductDeploy,
    productTables: ReadonlyMap<string, PgTable>,
  ): void {
    this.#db = db;
    this.#product = product;
    this.#productTables = productTables;
  }

  async enqueueWorkflowRun(input: {
    tenantId: string;
    workflow: WorkflowSpec;
    event: WorkflowInputEvent;
    idempotencyKey: string;
  }): Promise<{ workflowRunId: string; deduped: boolean }> {
    const workflowRunId = durableWorkflowRunId(
      input.tenantId,
      input.workflow.id,
      input.idempotencyKey,
    );
    const deduped = this.#seen.has(workflowRunId);
    this.#seen.add(workflowRunId);
    this.#jobs.push(input);
    this.calls.push({ workflowRunId, deduped, idempotencyKey: input.idempotencyKey });
    return { workflowRunId, deduped };
  }

  /** Execute EVERY recorded job (redeliveries included) on the REAL engine over the REAL journal. */
  async drain(): Promise<void> {
    if (!this.#db || !this.#product || !this.#productTables) throw new Error('drain before bind');
    for (const job of this.#jobs) {
      const tdb = forTenant(this.#db, job.tenantId);
      const engine = new DurableWorkflowEngine({
        journal: new TenantDbWorkflowJournalStore(tdb),
        registry: this.#product.buildNodeRegistry({
          tdb,
          productTables: this.#productTables,
          tenantId: job.tenantId,
        }),
        tenantId: job.tenantId,
      });
      await engine.execute({
        workflow: job.workflow,
        event: job.event,
        idempotencyKey: job.idempotencyKey,
      });
    }
  }
}

let testsRan = 0;

describe.skipIf(!hasDb)('record submit-ingress e2e (the composed stack)', () => {
  let h: DeployHarness;
  let result: DeployResult<ReturnType<typeof createAuthApp>>;
  let app: ReturnType<typeof createAuthApp>;
  let spec: ProductSpec;
  let tokenA: string;
  let tokenB: string;
  let tenantB: string;
  let blobDir: string;
  const enqueuer = new DrainEnqueuer();

  async function registerUser(email: string): Promise<{ token: string; userId: string }> {
    const reg = await jsonRequest(app, 'POST', '/v1/auth/register', {
      body: { email, password: 'a-long-enough-password' },
    });
    expect([200, 201]).toContain(reg.status);
    const token = (await reg.json()).accessToken as string;
    const rows = (await h.db.$client.unsafe('SELECT id FROM users WHERE email = $1', [
      email,
    ])) as unknown as Array<{ id: string }>;
    const userId = rows[0]?.id;
    if (!userId) throw new Error('registered user row missing');
    return { token, userId };
  }

  async function switchTo(orgId: string, baseToken: string): Promise<string> {
    const res = await jsonRequest(app, 'POST', `/v1/orgs/${orgId}/switch`, {
      headers: { authorization: `Bearer ${baseToken}` },
    });
    expect(res.status).toBe(200);
    return (await res.json()).accessToken as string;
  }

  const submit = (recordId: string, body: unknown, token?: string) =>
    jsonRequest(app, 'POST', `/records/${recordId}/submit`, {
      body,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  const get = (path: string, token?: string) =>
    app.request(path, {
      method: 'GET',
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  async function intakeRows(): Promise<Record<string, unknown>[]> {
    return (await h.db.$client.unsafe(
      'SELECT request_ref, record_id, title, status, tenant_id::text FROM intake_requests',
    )) as unknown as Record<string, unknown>[];
  }

  async function submissionRows(): Promise<Record<string, unknown>[]> {
    return (await h.db.$client.unsafe(
      'SELECT record_id, record_ref, payload, payload_hash, tenant_id::text FROM record_submissions',
    )) as unknown as Record<string, unknown>[];
  }

  beforeAll(async () => {
    const parsed = parseProductSpec(INTAKE_YAML);
    if (!parsed.ok) {
      throw new Error(`intake must validate:\n${JSON.stringify(parsed.errors, null, 2)}`);
    }
    spec = parsed.value;

    // The composed store surface EXACTLY as the boot path composes it: the SHARED spec-aware
    // capability-store helper (BOTH capabilities conditional-by-declaration — this doc declares
    // ONLY record_input, so record_submissions joins and NO audio store does) + deriveProductStores.
    const capability = composeCapabilityStores(spec);
    const derived = deriveProductStores(spec, capability.names);
    const composedStores = [...capability.stores, ...derived.stores];
    // The capability `*_ref` durable conflict keys (record_ref/request_ref) keep a
    // SINGLE-column unique index (a compound one would 42P10 the upsert + break the pin below).
    const conflictKeys = deriveConflictKeys(spec, composedStores);

    h = await createDeployHarness({ stores: composedStores, schema: SCHEMA, conflictKeys });
    await h.db.$client.unsafe(WORKFLOW_JOURNAL_DDL);
    await h.db.$client.unsafe(`INSERT INTO orgs (id, name, slug) VALUES ($1, 'Intake', 'intake')`, [
      TENANT_A,
    ]);

    blobDir = mkdtempSync(join(tmpdir(), 'rayspec-intake-e2e-'));
    const blobFactory = makeFsBlobStoreFactory(blobDir);
    // The audio capability still mounts unconditionally — fake its env like every
    // composed-stack test does; nothing in THIS suite drives the audio surface.
    const media = createMediaTokenService('s3-intake-media-secret-at-least-32-bytes');

    result = await deploy<ReturnType<typeof createAuthApp>>({
      specSource: INTAKE_YAML,
      migrations: [
        {
          name: '0000_intake.sql',
          sql: generateProductSql(composedStores, conflictKeys),
          allowlist: [],
        },
      ],
      target: h.target,
      rollout: {
        productTables: h.productTables,
        escapeHatchRoot: blobDir, // the doc declares no escape-hatch handlers; nothing loads
        buildApp: (engine) =>
          createAuthApp({
            ...h.deps,
            engine: { ...engine, blobFactory, mediaTokenService: media },
          }),
        productYaml: {
          tenantId: TENANT_A,
          enqueuer,
          stores: derived.stores,
          artifactCollections: derived.artifactCollections,
        },
      },
    });
    app = result.app;
    if (!result.product) throw new Error('deploy() returned no composed product runtime');
    enqueuer.bind(h.db, result.product, h.productTables);

    const a = await registerUser('intake-e2e-a@example.com');
    await h.db.$client.unsafe(
      `INSERT INTO memberships (org_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active')`,
      [TENANT_A, a.userId],
    );
    tokenA = await switchTo(TENANT_A, a.token);

    const b = await registerUser('intake-e2e-b@example.com');
    const orgRes = await jsonRequest(app, 'POST', '/v1/orgs', {
      body: { name: 'NotIntake' },
      headers: { authorization: `Bearer ${b.token}` },
    });
    expect([200, 201]).toContain(orgRes.status);
    tenantB = (await orgRes.json()).id as string;
    tokenB = await switchTo(tenantB, b.token);
  }, 120_000);

  afterAll(async () => {
    await h?.close();
    if (blobDir) rmSync(blobDir, { recursive: true, force: true });
  });

  it('(a) the CONDITIONAL mount MATERIALIZES: capability + declared stores, injected columns, REAL unique indexes, drift-clean', async () => {
    testsRan += 1;
    expect(result.drift).toEqual([]); // the migrated live schema matches the composed spec

    const columns = (await h.db.$client.unsafe(
      `SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns
       WHERE table_schema = $1 AND table_name IN ('record_submissions', 'intake_requests')
       ORDER BY table_name, column_name`,
      [SCHEMA],
    )) as unknown as Array<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>;
    const byName = new Map(columns.map((c) => [`${c.table_name}.${c.column_name}`, c]));
    // The capability-owned store: business columns, exact types + nullability.
    expect(byName.get('record_submissions.record_id')).toMatchObject({
      data_type: 'text',
      is_nullable: 'NO',
    });
    expect(byName.get('record_submissions.record_ref')).toMatchObject({
      data_type: 'text',
      is_nullable: 'NO',
    });
    expect(byName.get('record_submissions.payload')).toMatchObject({
      data_type: 'jsonb',
      is_nullable: 'NO',
    });
    expect(byName.get('record_submissions.payload_hash')).toMatchObject({
      data_type: 'text',
      is_nullable: 'NO',
    });
    // The INJECTED tenancy/GDPR columns arrived on BOTH stores.
    for (const table of ['record_submissions', 'intake_requests']) {
      for (const injected of [
        'id',
        'tenant_id',
        'created_at',
        'deleted_at',
        'retention_days',
        'region',
      ]) {
        expect(byName.has(`${table}.${injected}`), `injected '${table}.${injected}'`).toBe(true);
      }
    }

    // The unique indexes are REAL. The record_ref index is SINGLE-COLUMN like every generated
    // unique — but its VALUE embeds the server-derived tenant (`${tenant}:${record_id}`, keys.ts),
    // so the capability-owned store is PER-TENANT-KEYED BY CONSTRUCTION (the audio session_ref
    // pattern — NOT the declared-store deployment-global caveat; arm (f) proves it live).
    const indexes = (await h.db.$client.unsafe(
      `SELECT tablename, indexname FROM pg_indexes WHERE schemaname = $1
       AND tablename IN ('record_submissions', 'intake_requests')`,
      [SCHEMA],
    )) as unknown as Array<{ tablename: string; indexname: string }>;
    const names = new Set(indexes.map((i) => i.indexname));
    expect(names.has('record_submissions_record_ref_unique')).toBe(true);
    expect(names.has('intake_requests_request_ref_unique')).toBe(true);
  });

  it('(b) POST submit → ONE durable run; the store row carries the MERGED business field (the payload contract, live)', async () => {
    testsRan += 1;
    const res = await submit(RECORD, { title: 'Fix the door', priority: 'high' }, tokenA);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      record_id: RECORD,
      event_id: `${TENANT_A}:${RECORD}`,
      deduped: false,
    });

    expect(enqueuer.calls).toHaveLength(1);
    expect(enqueuer.calls[0]?.deduped).toBe(false);
    // The generic descriptor-derived key (never the audio ':finalized' legacy format).
    expect(enqueuer.calls[0]?.idempotencyKey).toBe(`record_id:${RECORD}`);

    await enqueuer.drain();

    const runs = (await h.db.$client.unsafe(
      'SELECT status, tenant_id::text FROM workflow_runs',
    )) as unknown as Array<{ status: string; tenant_id: string }>;
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('completed');
    expect(runs[0]?.tenant_id).toBe(TENANT_A);

    // GROUND TRUTH: the intake row exists, keyed by the envelope's record_id, carrying the MERGED
    // top-level business field — the store_write { event: title } source resolved the submitted
    // record field (the whole point of the top-level merge).
    const rows = await intakeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      request_ref: RECORD,
      record_id: RECORD,
      title: 'Fix the door',
      status: 'received',
      tenant_id: TENANT_A,
    });
  });

  it('(c) an IDENTICAL re-submit (different key ORDER) RE-EMITS the deduped event → same run id, ONE run, ONE row each', async () => {
    testsRan += 1;
    const res = await submit(RECORD, { priority: 'high', title: 'Fix the door' }, tokenA);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      record_id: RECORD,
      event_id: `${TENANT_A}:${RECORD}`,
      deduped: true,
    });

    // The re-submit RE-EMITTED (redelivery) and the enqueue DEDUPED onto the SAME run id.
    expect(enqueuer.calls).toHaveLength(2);
    expect(enqueuer.calls.map((c) => c.deduped)).toEqual([false, true]);
    expect(new Set(enqueuer.calls.map((c) => c.workflowRunId)).size).toBe(1);

    // Drain TWICE (a full redelivery): the JOURNAL is the run-level dedup authority.
    await enqueuer.drain();
    await enqueuer.drain();

    const runs = (await h.db.$client.unsafe('SELECT 1 FROM workflow_runs')) as unknown as unknown[];
    expect(runs).toHaveLength(1); // STILL one durable run
    expect(await intakeRows()).toHaveLength(1); // STILL one written row (upsert convergence)
    expect(await submissionRows()).toHaveLength(1); // STILL one capability-owned row
  });

  it('(d) a DIFFERENT payload for the same record key is a LOUD 409 — the STORED event re-emits (heal) and DEDUPS to the SAME run; rows byte-untouched', async () => {
    testsRan += 1;
    const before = {
      calls: enqueuer.calls.length,
      intake: await intakeRows(),
      submissions: await submissionRows(),
    };
    const priorRunIds = new Set(enqueuer.calls.map((c) => c.workflowRunId));

    const res = await submit(RECORD, { title: 'REPLACED', priority: 'low' }, tokenA);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('record_conflict');

    // The 409 path re-emitted the STORED authoritative event — so a record persisted by a
    // submit that crashed before its emit is healed by ANY retry payload, and the enqueue DEDUPS
    // onto the SAME durable run id (the `record_id:<id>` key → durableWorkflowRunId — zero
    // double-run for an already-enqueued record).
    expect(enqueuer.calls).toHaveLength(before.calls + 1);
    const heal = enqueuer.calls.at(-1);
    expect(heal?.deduped).toBe(true);
    expect(heal?.idempotencyKey).toBe(`record_id:${RECORD}`);
    expect(priorRunIds.has(heal?.workflowRunId ?? '')).toBe(true);

    // A full drain (the heal redelivery included) still yields ONE durable run + untouched rows.
    await enqueuer.drain();
    const runs = (await h.db.$client.unsafe('SELECT 1 FROM workflow_runs')) as unknown as unknown[];
    expect(runs).toHaveLength(1); // STILL one durable run
    expect(await intakeRows()).toEqual(before.intake); // the workflow surface is untouched
    expect(await submissionRows()).toEqual(before.submissions); // first write stays authoritative
  });

  it('(e) the store-sourced VIEW serves through the REAL HTTP app (shape + absent + 401 + cross-tenant blindness)', async () => {
    testsRan += 1;
    expect(result.product?.viewRoutes).toEqual(['GET /intake/{record_id}/status']);

    const res = await get(`/intake/${RECORD}/status`, tokenA);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      record_id: RECORD,
      title: 'Fix the door',
      status: 'received',
    });

    const absent = await get('/intake/never-submitted/status', tokenA);
    expect(absent.status).toBe(200);
    expect(await absent.json()).toEqual({
      record_id: 'never-submitted',
      title: null,
      status: null,
    });

    expect((await get(`/intake/${RECORD}/status`)).status).toBe(401);

    // CROSS-TENANT: B sees the ABSENT shape for A's record (the tenant predicate is structural).
    const crossTenant = await get(`/intake/${RECORD}/status`, tokenB);
    expect(crossTenant.status).toBe(200);
    expect(await crossTenant.json()).toEqual({ record_id: RECORD, title: null, status: null });
  });

  it('(f) a CROSS-TENANT submit is the clean deliberate 403: ZERO enqueue, ZERO B runs/rows — and the tenant-PREFIXED refs prove per-tenant keying', async () => {
    testsRan += 1;
    const beforeCalls = enqueuer.calls.length;

    // Tenant B submits its OWN record id (which equals A's) against the A-bound deployment. The
    // dispatcher/sink are tenant-bound to A; B's server-derived tenant mismatches → the record
    // bridge's fail-closed rejection maps to the deliberate 403 (never a 500, never an enqueue).
    const res = await submit(RECORD, { title: 'B data' }, tokenB);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('record_event_rejected');
    expect(body.detail).toContain('cross_tenant');

    expect(enqueuer.calls).toHaveLength(beforeCalls); // ZERO enqueue
    const bRuns = (await h.db.$client.unsafe('SELECT 1 FROM workflow_runs WHERE tenant_id = $1', [
      tenantB,
    ])) as unknown as unknown[];
    expect(bRuns).toHaveLength(0); // ZERO durable runs for B
    const bIntake = (await h.db.$client.unsafe(
      'SELECT 1 FROM intake_requests WHERE tenant_id = $1',
      [tenantB],
    )) as unknown as unknown[];
    expect(bIntake).toHaveLength(0); // ZERO workflow-written rows for B

    // HONEST POSTURE PIN (the audio mirror): B's OWN capability-owned submission row DID persist
    // under B's tenant BEFORE the event was rejected (exactly like an audio session's rows persist
    // before its finalize event rejects). No cross-tenant data crossed anywhere: the row is B's
    // data under B's tenant — and the tenant-PREFIXED record_ref values prove the per-tenant
    // keying live (two tenants, same record_id, both rows present, refs distinct).
    const rows = await submissionRows();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.record_ref))).toEqual(
      new Set([`${TENANT_A}:${RECORD}`, `${tenantB}:${RECORD}`]),
    );
    const bRow = rows.find((r) => r.tenant_id === tenantB);
    expect(bRow).toMatchObject({ record_id: RECORD, record_ref: `${tenantB}:${RECORD}` });

    // The index posture, pg_catalog-pinned: record_ref's unique is SINGLE-COLUMN (no tenant_id
    // column in the index) — the isolation lives in the tenant-prefixed VALUE (keys.ts), which the
    // two coexisting rows above just proved.
    const indexCols = (await h.db.$client.unsafe(
      `SELECT i.indisunique AS is_unique, a.attname AS column_name
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
        WHERE n.nspname = $1 AND c.relname = 'record_submissions_record_ref_unique'
        ORDER BY k.ord`,
      [SCHEMA],
    )) as unknown as Array<{ is_unique: boolean; column_name: string }>;
    expect(indexCols).toHaveLength(1);
    expect(indexCols[0]?.is_unique).toBe(true);
    expect(indexCols[0]?.column_name).toBe('record_ref');
  });

  it('(g) the payload bounds live over HTTP: reserved key 422 / oversized 413 / non-object 422 — zero enqueue, zero rows', async () => {
    testsRan += 1;
    const beforeCalls = enqueuer.calls.length;
    const beforeSubmissions = (await submissionRows()).length;

    const reserved = await submit('bound-check-1', { tenant_id: 'spoof', t: 1 }, tokenA);
    expect(reserved.status).toBe(422);
    expect((await reserved.json()).error).toBe('reserved_record_key');

    const oversized = await submit('bound-check-2', { blob: 'x'.repeat(70_000) }, tokenA);
    expect(oversized.status).toBe(413);
    expect((await oversized.json()).error).toBe('record_too_large');

    const nonObject = await submit('bound-check-3', [1, 2, 3], tokenA);
    expect(nonObject.status).toBe(422);
    expect((await nonObject.json()).error).toBe('invalid_record');

    expect(enqueuer.calls).toHaveLength(beforeCalls);
    expect((await submissionRows()).length).toBe(beforeSubmissions);
  });

  it('(h) an unauthenticated submit is 401 (the standard bearer chain owns the mounted route)', async () => {
    testsRan += 1;
    const res = await submit('no-auth-check', { t: 1 });
    expect(res.status).toBe(401);
  });
});

/**
 * Ran-guard: a SEPARATE, NON-skipped describe that fails when the DB is REQUIRED
 * (CI / RAYSPEC_REQUIRE_DB_TESTS) but the eight e2e arms did not run.
 */
describe('record-ingress e2e — ran-guard (must not silently skip in CI)', () => {
  it('the e2e arms ACTUALLY RAN when the DB is required (CI / opt-in)', () => {
    if (requireDb) {
      expect(testsRan).toBe(8);
    } else {
      expect(requireDb).toBe(false);
    }
  });
});
