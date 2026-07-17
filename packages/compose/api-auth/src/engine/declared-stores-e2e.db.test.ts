/**
 * The DECLARED-STORES end-to-end on the COMPOSED stack.
 *
 * A NEW audio-triggered fixture product ("fieldlog" — audio is today's only real trigger event)
 * declares two typed `stores:` and a workflow whose ONLY business steps are the new
 * store_read → store_write pair. It deploys through the REAL `deploy()` pipeline (validate →
 * compose → migrate → roll out → drift) and runs on the REAL `DurableWorkflowEngine` + TenantDb
 * journal. Proves, ground-truth (the deliverable's five arms):
 *
 *  (a) the DECLARED stores MATERIALIZE: pg_catalog/information_schema end-state — declared business
 *      columns + the INJECTED tenancy/GDPR columns + the conflict key's REAL unique index;
 *  (b) store_write persists IDEMPOTENTLY: dual finalize + double drain → EXACTLY ONE durable run
 *      AND exactly one session_log row; the store.write NODE re-executed directly with the same key
 *      (the at-least-once law, node level) CONVERGES on the same single row (updated, never a 2nd);
 *  (c) store_read FEEDS the downstream write: the written jsonb snapshot IS the equality-filtered
 *      catalog row the read produced (not the unfiltered table);
 *  (d) fail-closed arms on this exact document: an undeclared target store and a filter column
 *      outside the store contract are REJECTED by the real parser (the same chain deploy() runs);
 *  (e) a store-sourced VIEW over a declared store compiles + serves through the REAL HTTP app —
 *      including the absent shape and the cross-tenant blindness;
 *  (f) SEC-TEN-2: a cross-tenant store.write COLLISION on the deployment-global conflict
 *      key fails TYPED for the second tenant (loud-not-silent), writes ZERO rows for it, leaves the
 *      first tenant's row byte-untouched — and the single-column-no-tenant_id index posture is
 *      pg_catalog-PINNED as the documented beta cut (the structural fix is a deferred capability);
 *  (g) the DO-NOTHING (ensure-exists, values ≡ key) store_write arm
 *      against the REAL facade's onConflictDoNothing + the REAL tenant-predicated verify-read — the
 * SpyDb unit fake cannot prove this contract (the lesson): first write INSERTS, a same-tenant
 *      re-execution converges to completed `wrote: 0` (the at-least-once convergence), and a
 *      foreign-tenant write of the SAME key is the TYPED `store_write_conflict` (zero B rows, A
 *      byte-untouched).
 *
 * Skips without DATABASE_URL — but HARD-FAILS when the DB is required (CI /
 * RAYSPEC_REQUIRE_DB_TESTS) yet absent (un-skippable ran-guard at the bottom).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { audioCapabilityStores } from '@rayspec/audio-runtime';
import { forTenant, generateProductSql } from '@rayspec/db';
import type {
  ArtifactRef,
  CapabilityInvocationContext,
  WorkflowInputEvent,
  WorkflowSpec,
} from '@rayspec/foundation';
import { makeFsBlobStoreFactory } from '@rayspec/platform';
import type { ComposedProductDeploy } from '@rayspec/product-yaml';
import { deriveConflictKeys, deriveProductStores } from '@rayspec/product-yaml';
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
    'declared-stores-e2e.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but ' +
      'absent — refusing to silently skip the declared-stores end-to-end.',
  );
}

const SCHEMA = 'rayspec_test_fieldlog_e2e';
const TENANT_A = '00000000-0000-4000-8000-0000000000f1';
const SESSION = 'fieldlog-rec-1';

/**
 * The fieldlog fixture product (a sibling of @rayspec/product-yaml's test-support FIELDLOG_YAML
 * — each is a self-contained test fixture, not a KEEP-IN-SYNC pair): two declared stores, a
 * store_read → store_write workflow, and a store-sourced view over the written store.
 */
const FIELDLOG_YAML = `
version: "1.0"
product:
  id: fieldlog
  name: Fieldlog
  description: A neutral field-recording log product proving the declared-store composition.
requires:
  capabilities: [audio_input]
capabilities:
  - id: audio_input
    tier: B
    status: available
    contracts: [audio_input.finalized_session]
contracts:
  fieldlog.catalog_rows:
    type: array
    items: { type: object }
  fieldlog.log_row:
    type: object
  fieldlog.log_response:
    type: object
    additional_properties: false
    properties:
      session_id: { type: string }
      status: { type: [string, "null"] }
    required: [session_id, status]
stores:
  - name: equipment_catalog
    description: Reference data the workflow reads (seeded by the deployment).
    columns:
      - { name: item_code, type: text }
      - { name: label, type: text, nullable: true }
    key: [item_code]
  - name: session_log
    columns:
      - { name: entry_ref, type: text }
      - { name: session_id, type: text }
      - { name: status, type: text }
      - { name: catalog_snapshot, type: jsonb, nullable: true }
    key: [entry_ref]
workflows:
  - id: log_session
    trigger:
      capability: audio_input
      event: session_finalized
      scope: session
    steps:
      - id: catalog
        type: store_read
        use: store.read
        store: equipment_catalog
        filter:
          item_code: { const: mic_kit }
        limit: 10
        outputs:
          catalog: fieldlog.catalog_rows
      - id: log
        type: store_write
        use: store.write
        store: session_log
        depends_on: [catalog]
        values:
          entry_ref: { event: session_id }
          session_id: { event: session_id }
          status: { const: processed }
          catalog_snapshot: { artifact: fieldlog.catalog_rows }
        outputs:
          log_row: fieldlog.log_row
      # arm (g): a KEY-ONLY (ensure-exists) write — values ≡ the conflict key, so the
      # facade takes the onConflictDoNothing arm and the node's verify-read disambiguates.
      - id: ensure
        type: store_write
        use: store.write
        store: equipment_catalog
        values:
          item_code: { event: session_id }
views:
  - id: session_log_view
    route:
      method: GET
      path: "/field-sessions/{session_id}/log"
    auth: bearer_tenant
    params:
      session_id: { in: path, shape: safe_id }
    source: { kind: store, ref: session_log }
    read:
      mode: single
      filter:
        session_id: { param: session_id }
      shape:
        fields:
          session_id: { kind: param, param: session_id }
          status: { kind: column, column: status, type: string }
      absent:
        fields:
          session_id: { kind: param, param: session_id }
          status: { kind: const, value: null }
    absent_state: empty_200
    response_contract: fieldlog.log_response
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

/** Record-then-drain enqueuer: the journal (not memory) is the dedup authority (durable-run e2e pattern). */
class DrainEnqueuer implements WorkflowEnqueuer {
  readonly calls: Array<{ workflowRunId: string; deduped: boolean }> = [];
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
    this.calls.push({ workflowRunId, deduped });
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

describe.skipIf(!hasDb)('declared stores + store steps e2e (the composed stack)', () => {
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

  const postChunk = (session: string, track: string, index: number, token: string) =>
    app.request(`/sessions/${session}/${track}/chunks/${index}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'audio/ogg' },
      body: new Uint8Array([1, 2, 3]),
    });

  const finalize = (session: string, track: string, token: string, totalChunks: number) =>
    jsonRequest(app, 'POST', `/sessions/${session}/${track}/finalize`, {
      body: { total_chunks: totalChunks },
      headers: { authorization: `Bearer ${token}` },
    });

  const get = (path: string, token?: string) =>
    app.request(path, {
      method: 'GET',
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  async function sessionLogRows(): Promise<Record<string, unknown>[]> {
    return (await h.db.$client.unsafe(
      'SELECT entry_ref, session_id, status, catalog_snapshot, tenant_id::text FROM session_log',
    )) as unknown as Record<string, unknown>[];
  }

  beforeAll(async () => {
    const parsed = parseProductSpec(FIELDLOG_YAML);
    if (!parsed.ok) {
      throw new Error(`fieldlog must validate:\n${JSON.stringify(parsed.errors, null, 2)}`);
    }
    spec = parsed.value;

    // The composed store surface EXACTLY as the boot path composes it: audio capability stores +
    // deriveProductStores (which now emits the two DECLARED stores).
    const derived = deriveProductStores(spec, new Set(['audio_sessions', 'audio_tracks']));
    const composedStores = [...audioCapabilityStores(), ...derived.stores];
    // The durable conflict keys (declared `key`: item_code/entry_ref + the audio `*_ref`
    // idiom) keep a SINGLE-column unique index; any other author unique is tenant-scoped compound.
    const conflictKeys = deriveConflictKeys(spec, composedStores);

    h = await createDeployHarness({ stores: composedStores, schema: SCHEMA, conflictKeys });
    await h.db.$client.unsafe(WORKFLOW_JOURNAL_DDL);
    await h.db.$client.unsafe(
      `INSERT INTO orgs (id, name, slug) VALUES ($1, 'Fieldlog', 'fieldlog')`,
      [TENANT_A],
    );

    blobDir = mkdtempSync(join(tmpdir(), 'rayspec-fieldlog-e2e-'));
    const blobFactory = makeFsBlobStoreFactory(blobDir);
    const media = createMediaTokenService('fieldlog-media-secret-at-least-32-bytes');

    result = await deploy<ReturnType<typeof createAuthApp>>({
      specSource: FIELDLOG_YAML,
      migrations: [
        {
          name: '0000_fieldlog.sql',
          sql: generateProductSql(composedStores, conflictKeys),
          allowlist: [],
        },
      ],
      target: h.target,
      rollout: {
        productTables: h.productTables,
        escapeHatchRoot: blobDir, // the doc declares no escape-hatch handlers; nothing loads
        // The composition root augments the engine with the byte-moving backends (the audio mount's
        // stream ingest/playback routes fail-close at boot without a blob backend).
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

    // Seed the REFERENCE store (two rows — the read's equality filter must select exactly one).
    await h.db.$client.unsafe(
      `INSERT INTO equipment_catalog (tenant_id, item_code, label)
       VALUES ($1, 'mic_kit', 'Field mic kit'), ($1, 'boom_arm', 'Boom arm')`,
      [TENANT_A],
    );

    const a = await registerUser('fieldlog-e2e-a@example.com');
    await h.db.$client.unsafe(
      `INSERT INTO memberships (org_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active')`,
      [TENANT_A, a.userId],
    );
    tokenA = await switchTo(TENANT_A, a.token);

    const b = await registerUser('fieldlog-e2e-b@example.com');
    const orgRes = await jsonRequest(app, 'POST', '/v1/orgs', {
      body: { name: 'NotFieldlog' },
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

  it('(a) the DECLARED stores MATERIALIZE: declared columns + injected tenancy/GDPR columns + the REAL key unique index (pg_catalog end-state)', async () => {
    testsRan += 1;
    expect(result.drift).toEqual([]); // the migrated live schema matches the composed spec

    const columns = (await h.db.$client.unsafe(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'session_log' ORDER BY column_name`,
      [SCHEMA],
    )) as unknown as Array<{ column_name: string; data_type: string; is_nullable: string }>;
    const byName = new Map(columns.map((c) => [c.column_name, c]));
    // Declared business columns, exact types + nullability.
    expect(byName.get('entry_ref')).toMatchObject({ data_type: 'text', is_nullable: 'NO' });
    expect(byName.get('session_id')).toMatchObject({ data_type: 'text', is_nullable: 'NO' });
    expect(byName.get('status')).toMatchObject({ data_type: 'text', is_nullable: 'NO' });
    expect(byName.get('catalog_snapshot')).toMatchObject({
      data_type: 'jsonb',
      is_nullable: 'YES',
    });
    // The INJECTED tenancy/GDPR columns arrived the same way collection stores get them.
    for (const injected of [
      'id',
      'tenant_id',
      'created_at',
      'deleted_at',
      'retention_days',
      'region',
    ]) {
      expect(byName.has(injected), `injected column '${injected}'`).toBe(true);
    }

    // The conflict key's backing UNIQUE index is REAL (both declared stores).
    const indexes = (await h.db.$client.unsafe(
      `SELECT tablename, indexname FROM pg_indexes WHERE schemaname = $1
       AND tablename IN ('session_log', 'equipment_catalog')`,
      [SCHEMA],
    )) as unknown as Array<{ tablename: string; indexname: string }>;
    const names = new Set(indexes.map((i) => i.indexname));
    expect(names.has('session_log_entry_ref_unique')).toBe(true);
    expect(names.has('equipment_catalog_item_code_unique')).toBe(true);
  });

  it('(b)+(c) finalize → ONE durable run; the read FEEDS the write; double drain + direct node re-execution converge on ONE row (at-least-once)', async () => {
    testsRan += 1;
    expect((await postChunk(SESSION, 'mic', 0, tokenA)).status).toBe(200);
    expect((await finalize(SESSION, 'mic', tokenA, 1)).status).toBe(200);
    // Re-finalize (idempotent 200) re-emits the SAME session-scoped event.
    expect((await finalize(SESSION, 'mic', tokenA, 1)).status).toBe(200);

    expect(enqueuer.calls).toHaveLength(2);
    expect(new Set(enqueuer.calls.map((c) => c.workflowRunId)).size).toBe(1);
    expect(enqueuer.calls.map((c) => c.deduped)).toEqual([false, true]);

    // Drain TWICE (a full redelivery): the JOURNAL is the run-level dedup authority.
    await enqueuer.drain();
    await enqueuer.drain();

    const runs = (await h.db.$client.unsafe(
      'SELECT status, tenant_id::text FROM workflow_runs',
    )) as unknown as Array<{ status: string; tenant_id: string }>;
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('completed');
    expect(runs[0]?.tenant_id).toBe(TENANT_A);

    // GROUND TRUTH (b): exactly ONE session_log row, keyed by the session.
    let rows = await sessionLogRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entry_ref: SESSION,
      session_id: SESSION,
      status: 'processed',
      tenant_id: TENANT_A,
    });
    // GROUND TRUTH (c): the write's jsonb snapshot IS the read's EQUALITY-FILTERED output — exactly
    // the ONE mic_kit row (never the unfiltered 2-row table), proving the rows artifact fed through.
    const snapshot = rows[0]?.catalog_snapshot as Array<Record<string, unknown>>;
    expect(Array.isArray(snapshot)).toBe(true);
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toMatchObject({ item_code: 'mic_kit', label: 'Field mic kit' });

    // The at-least-once law at NODE level: re-execute the store.write node DIRECTLY with the same
    // key (a mid-crash re-run does exactly this) — the upsert CONVERGES on the same single row
    // (updated in place; a second row would be the 23505-class failure the upsert law prevents).
    const product = result.product;
    if (!product) throw new Error('composed product missing');
    const wf = product.workflows.get('log_session');
    const step = wf?.steps.find((s) => s.id === 'log');
    if (!wf || !step) throw new Error('compiled store_write step missing');
    const tdb = forTenant(h.db, TENANT_A);
    const registry = product.buildNodeRegistry({
      tdb,
      productTables: h.productTables,
      tenantId: TENANT_A,
    });
    const rerunSnapshot: ArtifactRef = {
      id: 'catalog:fieldlog.catalog_rows:rerun',
      kind: 'fieldlog.catalog_rows',
      source_node_id: 'catalog',
      value: [{ item_code: 'mic_kit', label: 'Field mic kit', rerun: true }],
    };
    const ctx: CapabilityInvocationContext = {
      workflow: wf,
      step,
      input_event: {
        id: 'rerun-evt',
        type: 'audio_input.finalized_session',
        occurred_at: new Date().toISOString(),
        payload: { session_id: SESSION },
      },
      input: {},
      journal: {
        workflow_run_id: 'rerun',
        workflow_id: wf.id,
        idempotency_key: 'rerun',
        input_event: {
          id: 'rerun-evt',
          type: 'audio_input.finalized_session',
          occurred_at: new Date().toISOString(),
          payload: { session_id: SESSION },
        },
        status: 'running',
        node_states: [],
        artifact_refs: [],
        attempts: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      artifacts: [rerunSnapshot],
    };
    const rerun = await registry.get('store.write')(ctx);
    expect(rerun.status).toBe('completed');

    rows = await sessionLogRows();
    expect(rows).toHaveLength(1); // STILL one row — converged, not duplicated
    const updated = rows[0]?.catalog_snapshot as Array<Record<string, unknown>>;
    expect(updated[0]).toMatchObject({ rerun: true }); // the DO-UPDATE arm actually applied
  });

  it('(f) SEC-TEN-2: a CROSS-TENANT store.write collision on the deployment-global key fails TYPED for tenant B — zero B rows, A byte-untouched; the global-index posture is PINNED', async () => {
    testsRan += 1;

    // ── PIN the index decision explicitly (pg_catalog ground truth): the conflict key's unique
    // index is SINGLE-COLUMN — deliberately WITHOUT tenant_id. This is the conflict-key carve-out:
    // an author-declared `unique: true` column is TENANT-SCOPED compound `(tenant_id, col)`, but a
    // durable `ON CONFLICT` target (the store's `key` — here `entry_ref`) MUST stay single-column, or a
    // compound index would 42P10 the upsert. The tenant-scoped composite KEY (a single-column key that
    // is ALSO tenant-scoped) still needs frozen-surface StoreSpec vocabulary — a deferred capability.
    // Until that lands, a foreign-tenant key collision is a REAL, expected state, and the
    // runtime's job is to surface it LOUDLY (asserted below), never as a silent success. A naive
    // compound-all (forgetting the conflict-key carve-out) would break this upsert 42P10 — the guard.
    const indexCols = (await h.db.$client.unsafe(
      `SELECT i.indisunique AS is_unique, a.attname AS column_name, k.ord
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
        WHERE n.nspname = $1 AND c.relname = 'session_log_entry_ref_unique'
        ORDER BY k.ord`,
      [SCHEMA],
    )) as unknown as Array<{ is_unique: boolean; column_name: string; ord: string }>;
    expect(indexCols).toHaveLength(1); // SINGLE-column …
    expect(indexCols[0]?.is_unique).toBe(true); // … UNIQUE …
    expect(indexCols[0]?.column_name).toBe('entry_ref'); // … on the key column, WITHOUT tenant_id.

    // A's row (written by arm (b)) — full-row snapshot BEFORE B's colliding write.
    const before = (await h.db.$client.unsafe(
      'SELECT to_jsonb(t) AS row FROM session_log t WHERE tenant_id = $1',
      [TENANT_A],
    )) as unknown as Array<{ row: Record<string, unknown> }>;
    expect(before).toHaveLength(1);

    // Tenant B executes the SAME compiled store.write with the SAME key value (B's own registry —
    // the same direct node execution the at-least-once arm uses, tenant-bound to B).
    const product = result.product;
    if (!product) throw new Error('composed product missing');
    const wf = product.workflows.get('log_session');
    const step = wf?.steps.find((s) => s.id === 'log');
    if (!wf || !step) throw new Error('compiled store_write step missing');
    const registryB = product.buildNodeRegistry({
      tdb: forTenant(h.db, tenantB),
      productTables: h.productTables,
      tenantId: tenantB,
    });
    const snapshotB: ArtifactRef = {
      id: 'catalog:fieldlog.catalog_rows:tenant-b',
      kind: 'fieldlog.catalog_rows',
      source_node_id: 'catalog',
      value: [{ item_code: 'mic_kit', label: 'B catalog', tenant_b: true }],
    };
    const ctxB: CapabilityInvocationContext = {
      workflow: wf,
      step,
      input_event: {
        id: 'b-evt',
        type: 'audio_input.finalized_session',
        occurred_at: new Date().toISOString(),
        payload: { session_id: SESSION }, // the SAME key value tenant A already holds
      },
      input: {},
      journal: {
        workflow_run_id: 'b-run',
        workflow_id: wf.id,
        idempotency_key: 'b-run',
        input_event: {
          id: 'b-evt',
          type: 'audio_input.finalized_session',
          occurred_at: new Date().toISOString(),
          payload: { session_id: SESSION },
        },
        status: 'running',
        node_states: [],
        artifact_refs: [],
        attempts: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      artifacts: [snapshotB],
    };
    const bResult = await registryB.get('store.write')(ctxB);

    // LOUD, not silent: B gets the TYPED terminal failure — never 'completed'/wrote:0.
    expect(bResult.status).toBe('terminal_failure');
    if (bResult.status !== 'terminal_failure') throw new Error('unreachable');
    expect(bResult.error?.code).toBe('store_write_conflict');
    // Content-free re values: names the store + key COLUMN, never the key VALUE.
    expect(bResult.error?.message).toContain('session_log');
    expect(bResult.error?.message).toContain('entry_ref');
    expect(bResult.error?.message).not.toContain(SESSION);

    // ZERO rows for B in the store (the write was NOT applied anywhere).
    const bRows = (await h.db.$client.unsafe('SELECT 1 FROM session_log WHERE tenant_id = $1', [
      tenantB,
    ])) as unknown as unknown[];
    expect(bRows).toHaveLength(0);

    // A's row is BYTE-untouched (full to_jsonb row equality — the tenant-scoped DO-UPDATE matched
    // zero rows, so A's data was never overwritten).
    const after = (await h.db.$client.unsafe(
      'SELECT to_jsonb(t) AS row FROM session_log t WHERE tenant_id = $1',
      [TENANT_A],
    )) as unknown as Array<{ row: Record<string, unknown> }>;
    expect(after).toEqual(before);
  });

  it('(g) the DO-NOTHING (ensure-exists, values ≡ key) arm on the REAL facade — insert, same-tenant verify-read convergence (wrote:0), foreign-tenant TYPED conflict', async () => {
    testsRan += 1;
    const product = result.product;
    if (!product) throw new Error('composed product missing');
    const wf = product.workflows.get('log_session');
    const step = wf?.steps.find((s) => s.id === 'ensure');
    if (!wf || !step) throw new Error('compiled ensure (key-only store_write) step missing');

    // A FRESH key value — carried by no seed row and no drained-run row (the drain's ensure step
    // wrote item_code = SESSION), so step 1 below is a genuine INSERT.
    const KEY = 'ensure-key-x';
    const mkCtx = (runId: string): CapabilityInvocationContext => ({
      workflow: wf,
      step,
      input_event: {
        id: `${runId}-evt`,
        type: 'audio_input.finalized_session',
        occurred_at: new Date().toISOString(),
        payload: { session_id: KEY },
      },
      input: {},
      journal: {
        workflow_run_id: runId,
        workflow_id: wf.id,
        idempotency_key: runId,
        input_event: {
          id: `${runId}-evt`,
          type: 'audio_input.finalized_session',
          occurred_at: new Date().toISOString(),
          payload: { session_id: KEY },
        },
        status: 'running',
        node_states: [],
        artifact_refs: [],
        attempts: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      artifacts: [],
    });

    // 1) Tenant A's FIRST ensure-exists write INSERTS: completed, wrote: 1, the row is present.
    const registryA = product.buildNodeRegistry({
      tdb: forTenant(h.db, TENANT_A),
      productTables: h.productTables,
      tenantId: TENANT_A,
    });
    const first = await registryA.get('store.write')(mkCtx('ensure-a-1'));
    expect(first.status).toBe('completed');
    if (first.status !== 'completed') throw new Error('unreachable');
    expect(first.output).toMatchObject({ store: 'equipment_catalog', wrote: 1 });
    const rowsAfterFirst = (await h.db.$client.unsafe(
      'SELECT tenant_id::text FROM equipment_catalog WHERE item_code = $1',
      [KEY],
    )) as unknown as Array<{ tenant_id: string }>;
    expect(rowsAfterFirst).toEqual([{ tenant_id: TENANT_A }]);

    // 2) SAME-tenant RE-execution (the at-least-once law): the REAL facade's onConflictDoNothing
    // returns NO row → the node's REAL tenant-predicated verify-read finds A's row → completed
    // `wrote: 0` (the at-least-once convergence — never a duplicate, never a failure), STILL exactly one row.
    const rerun = await registryA.get('store.write')(mkCtx('ensure-a-2'));
    expect(rerun.status).toBe('completed');
    if (rerun.status !== 'completed') throw new Error('unreachable');
    expect(rerun.output).toMatchObject({ store: 'equipment_catalog', wrote: 0 });
    const rowsAfterRerun = (await h.db.$client.unsafe(
      'SELECT 1 FROM equipment_catalog WHERE item_code = $1',
      [KEY],
    )) as unknown as unknown[];
    expect(rowsAfterRerun).toHaveLength(1);

    // A's row snapshot BEFORE B's colliding write (the byte-untouched proof below).
    const before = (await h.db.$client.unsafe(
      'SELECT to_jsonb(t) AS row FROM equipment_catalog t WHERE item_code = $1',
      [KEY],
    )) as unknown as Array<{ row: Record<string, unknown> }>;
    expect(before).toHaveLength(1);

    // 3) Tenant B ensure-exists on the SAME key: DO-NOTHING no-ops on the deployment-global unique,
    // B's tenant-scoped verify-read sees NOTHING → the TYPED terminal failure (loud-not-silent).
    const registryB = product.buildNodeRegistry({
      tdb: forTenant(h.db, tenantB),
      productTables: h.productTables,
      tenantId: tenantB,
    });
    const bResult = await registryB.get('store.write')(mkCtx('ensure-b-1'));
    expect(bResult.status).toBe('terminal_failure');
    if (bResult.status !== 'terminal_failure') throw new Error('unreachable');
    expect(bResult.error?.code).toBe('store_write_conflict');
    // Content-free re values: names the store + key COLUMN, never the key VALUE.
    expect(bResult.error?.message).toContain('equipment_catalog');
    expect(bResult.error?.message).toContain('item_code');
    expect(bResult.error?.message).not.toContain(KEY);

    // ZERO equipment_catalog rows for B (the write was NOT applied anywhere) …
    const bRows = (await h.db.$client.unsafe(
      'SELECT 1 FROM equipment_catalog WHERE tenant_id = $1',
      [tenantB],
    )) as unknown as unknown[];
    expect(bRows).toHaveLength(0);
    // … and A's row is BYTE-untouched (DO-NOTHING never writes on conflict).
    const after = (await h.db.$client.unsafe(
      'SELECT to_jsonb(t) AS row FROM equipment_catalog t WHERE item_code = $1',
      [KEY],
    )) as unknown as Array<{ row: Record<string, unknown> }>;
    expect(after).toEqual(before);
  });

  it('(e) the store-sourced VIEW over the declared store serves through the REAL HTTP app (shape + absent + auth + cross-tenant)', async () => {
    testsRan += 1;
    // The composed view route mounted.
    expect(result.product?.viewRoutes).toEqual(['GET /field-sessions/{session_id}/log']);

    const res = await get(`/field-sessions/${SESSION}/log`, tokenA);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ session_id: SESSION, status: 'processed' });

    // The absent shape (empty_200) for a session that never ran.
    const absent = await get('/field-sessions/never-ran/log', tokenA);
    expect(absent.status).toBe(200);
    expect(await absent.json()).toEqual({ session_id: 'never-ran', status: null });

    // Unauthenticated → 401 (bearer_tenant).
    expect((await get(`/field-sessions/${SESSION}/log`)).status).toBe(401);

    // CROSS-TENANT: B sees the ABSENT shape for A's session (the tenant predicate is structural).
    const crossTenant = await get(`/field-sessions/${SESSION}/log`, tokenB);
    expect(crossTenant.status).toBe(200);
    expect(await crossTenant.json()).toEqual({ session_id: SESSION, status: null });
  });

  it('(d) fail-closed arms on THIS document: undeclared target store / filter column outside the contract are REJECTED by the real parse chain', () => {
    testsRan += 1;
    const undeclaredStore = parseProductSpec(
      FIELDLOG_YAML.replace('store: equipment_catalog', 'store: ghost_store'),
    );
    expect(undeclaredStore.ok).toBe(false);
    if (undeclaredStore.ok) throw new Error('unreachable');
    expect(
      undeclaredStore.errors.some(
        (e) => e.code === 'invalid_store' && /ghost_store/.test(e.message),
      ),
    ).toBe(true);

    const ghostColumn = parseProductSpec(
      FIELDLOG_YAML.replace('item_code: { const: mic_kit }', 'ghost_col: { const: mic_kit }'),
    );
    expect(ghostColumn.ok).toBe(false);
    if (ghostColumn.ok) throw new Error('unreachable');
    expect(
      ghostColumn.errors.some((e) => e.code === 'invalid_store' && /ghost_col/.test(e.message)),
    ).toBe(true);
  });
});

/**
 * Ran-guard: a SEPARATE, NON-skipped describe that fails when the DB is REQUIRED
 * (CI / RAYSPEC_REQUIRE_DB_TESTS) but the six e2e arms did not run.
 */
describe('declared-stores e2e — ran-guard (must not silently skip in CI)', () => {
  it('the e2e arms ACTUALLY RAN when the DB is required (CI / opt-in)', () => {
    if (requireDb) {
      expect(testsRan).toBe(6);
    } else {
      expect(requireDb).toBe(false);
    }
  });
});
