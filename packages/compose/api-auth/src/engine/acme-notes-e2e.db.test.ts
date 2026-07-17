/**
 * The neutral acme-notes FAKE-PROVIDER END-TO-END through the REAL deploy path: a single
 * self-contained compose e2e, no second stack to diff.
 *
 * The neutral `examples/acme-notes/acme-notes.product.yaml` deploys through the REAL `deploy()`
 * pipeline (validate → compose → diff → lint/gate → migrate → roll out → drift), then the WHOLE
 * product flow runs deterministically:
 *
 *   real audio routes (chunk upload, dual-track) → finalize → the REAL trigger wiring (bridge sink →
 *   tenant-bound dispatcher → enqueuer) → EXACTLY ONE durable workflow run executed on the
 *   REAL DurableWorkflowEngine + TenantDb journal → fake STT adapter (deterministic fixture) →
 *   deterministic declared-contract extraction (honoring required_output_shape) → the REAL grounding
 *   gate (the DECLARED prune/drop policy over the closed span set) → persisted grounded artifacts
 *   (collection rows + typed handle) → the DECLARED views serve session-list / transcript / notes /
 *   playback-token over REAL Postgres rows through REAL HTTP requests.
 *
 * The grounding oracle is loaded from `examples/acme-notes/fixtures/acme-notes-grounding-session.json`
 * (candidate note-set + closed span set + expected counts) — a LIVE, non-blind oracle.
 *
 * WHOLE-invariant assertions (fail-the-fix, not pass-the-shape):
 *  1. EXACTLY-ONE durable run per session across dual-track finalize + re-finalize + double drain
 *     (ground truth: the workflow_runs table + the extractor invocation count).
 *  2. The grounding policy is LOAD-BEARING: the served notes visibly reflect the prune (an out-of-set
 *     citation removed) and the drop (a fully-ungrounded item + an empty-evidence query absent) — exact
 *     DTO equality including evidence spans and the asymmetric counts (query = 0).
 *  3. CROSS-TENANT (CI-blocking): tenant B never reads tenant A's data through ANY declared view, and
 *     B's finalize can NEVER enqueue into A's tenant-bound dispatcher (fail-closed).
 *  4. The playback-token view is capability-DELEGATED: the 409-not-ready contract before media prep,
 *     a real token + a real streamed byte read after.
 *  5. DELETE the org CASCADES away all product rows (audio_* / track_transcripts / note_artifacts) —
 *     tenancy cleanup at runtime, not just the source-scan gate.
 *
 * Skips when DATABASE_URL is absent — but HARD-FAILS when the DB is required (CI /
 * RAYSPEC_REQUIRE_DB_TESTS) yet absent (un-skippable ran-guard at the bottom).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryAgentHandlerRegistry } from '@rayspec/agent-runtime';
import {
  audioCapabilityStores,
  registerPlayableArtifact,
  resolveConfig,
} from '@rayspec/audio-runtime';
import { type Db, forTenant, generateProductSql } from '@rayspec/db';
import type { WorkflowInputEvent, WorkflowSpec } from '@rayspec/foundation';
import { makeFsBlobStoreFactory, makeHandlerDb } from '@rayspec/platform';
import type { ComposedProductDeploy } from '@rayspec/product-yaml';
import { parseProductSpec, type StoreSpec } from '@rayspec/spec';
import { FakeSttAdapter, type SttDualTrackFixture } from '@rayspec/stt-port';
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
    'acme-notes-e2e.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but ' +
      'absent — refusing to silently skip the acme-notes end-to-end.',
  );
}

const here = dirname(fileURLToPath(import.meta.url));
// packages/api-auth/src/engine → repo-root/examples/acme-notes/acme-notes.product.yaml.
const ACME_YAML_PATH = resolve(here, '../../../../../examples/acme-notes/acme-notes.product.yaml');
const GROUNDING_FIXTURE_PATH = resolve(
  here,
  '../../../../../examples/acme-notes/fixtures/acme-notes-grounding-session.json',
);

/** The grounding oracle (candidate note-set + closed span set + expected counts). */
interface GroundingFixture {
  session_id: string;
  closed_span_set: string[];
  transcripts: Array<{ track: string; status: string; segments: Array<{ text: string }> }>;
  candidate_notes: Record<string, unknown>;
  expected_persisted: {
    artifact_count: number;
    counts: Record<string, number>;
    artifacts: Array<{ artifact_kind: string; text?: string; evidence_span_ids: string[] }>;
  };
  expected_read_model: {
    digest_present: boolean;
    items: number;
    pointers: number;
    queries: number;
    labels: number;
    counts: Record<string, number>;
  };
}
const ORACLE = JSON.parse(readFileSync(GROUNDING_FIXTURE_PATH, 'utf8')) as GroundingFixture;

const SCHEMA = 'rayspec_test_acme_e2e';
/** The deployment tenant (single-node posture) — pre-created so the dispatcher binds to it at deploy. */
const TENANT_A = '00000000-0000-4000-8000-0000000000a1';
const SESSION = 'e2e-sess-1';
const MEDIA_SECRET = 'acme-e2e-media-secret-at-least-32-bytes';

/** The deployment's Tier-A product stores (transcript sink + artifact collection — spec-shaped). */
const PRODUCT_STORES: StoreSpec[] = [
  {
    name: 'track_transcripts',
    columns: [
      { name: 'session_id', type: 'text', nullable: false, unique: false },
      { name: 'track', type: 'text', nullable: false, unique: false },
      { name: 'track_ref', type: 'text', nullable: false, unique: true },
      { name: 'status', type: 'text', nullable: false, unique: false },
      { name: 'model', type: 'text', nullable: true, unique: false },
      { name: 'detected_language', type: 'text', nullable: true, unique: false },
      { name: 'full_text', type: 'text', nullable: true, unique: false },
      { name: 'word_count', type: 'integer', nullable: true, unique: false },
      { name: 'payload', type: 'jsonb', nullable: true, unique: false },
    ],
    foreignKeys: [],
  },
  {
    name: 'note_artifacts',
    columns: [
      { name: 'session_id', type: 'text', nullable: false, unique: false },
      { name: 'artifact_kind', type: 'text', nullable: false, unique: false },
      { name: 'payload', type: 'jsonb', nullable: false, unique: false },
      { name: 'human_edited', type: 'boolean', nullable: false, unique: false },
      { name: 'dismissed', type: 'boolean', nullable: false, unique: false },
      { name: 'artifact_ref', type: 'text', nullable: false, unique: true },
    ],
    foreignKeys: [],
  },
];

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

/** The deterministic dual-track STT fixture — span ids are the CLOSED evidence set (from the oracle). */
const STT_FIXTURE: SttDualTrackFixture = {
  fixture_id: 'acme-e2e',
  session_id: SESSION,
  tracks: ORACLE.transcripts.map((t) => ({
    track: t.track,
    status: t.status,
    segments: t.segments.map((seg, i) => ({ span_id: `${t.track}:s${i}`, text: seg.text })),
  })),
};
/** The mic full_text the transcript view must serve (segment texts joined, the FakeSttAdapter law). */
const MIC_FULL_TEXT = (ORACLE.transcripts.find((t) => t.track === 'mic')?.segments ?? [])
  .map((s) => s.text)
  .join(' ');
const MIC_SEGMENTS = (ORACLE.transcripts.find((t) => t.track === 'mic')?.segments ?? []).map(
  (s, i) => ({ start: i * 5, end: (i + 1) * 5, text: s.text }),
);

/**
 * The deterministic declared-contract extractor: reads its typed inputs/outputs from the DECLARED
 * extraction contract (never hardcodes the wiring), honors required_output_shape (all 8 required
 * top-level paths, no extras), and emits the oracle's candidate note-set (which plants the grounding
 * probes: one fully-ungrounded item + one empty-evidence query — both DROPPED; one item citing an
 * out-of-set span — PRUNED to the valid one; one mention — grounded-not-persisted).
 */
function makeCountingExtractor(counter: { invocations: number }) {
  const registry = new InMemoryAgentHandlerRegistry();
  registry.register('agent.note_extractor', (input) => {
    counter.invocations += 1;
    const output = input.artifact_outputs.find((a) => a.schema_ref === 'acme.notes');
    if (!output) throw new Error('declared output artifact missing');
    const spans = input.artifact_inputs.find((a) => a.ref === 'stt.transcript_span')?.value;
    if (!Array.isArray(spans) || spans.length === 0) {
      throw new Error('the declared span-set input did not reach the extractor');
    }
    return [{ ...output, value: structuredClone(ORACLE.candidate_notes) }];
  });
  return registry;
}

/**
 * A record-then-drain `WorkflowEnqueuer`: enqueue records the job (like the DBOS queue) and derives
 * the REAL tenant-namespaced durable run id; `drain()` executes EVERY recorded job — including
 * redeliveries — on the REAL `DurableWorkflowEngine` over the REAL TenantDb journal, so the
 * exactly-once proof is the JOURNAL's single-flight, not an in-memory shortcut.
 */
class DrainEnqueuer implements WorkflowEnqueuer {
  readonly calls: Array<{ workflowRunId: string; deduped: boolean }> = [];
  readonly #jobs: Array<{
    workflowRunId: string;
    tenantId: string;
    workflow: WorkflowSpec;
    event: WorkflowInputEvent;
    idempotencyKey: string;
  }> = [];
  readonly #seen = new Set<string>();
  #db?: Db;
  #product?: ComposedProductDeploy;
  #productTables?: ReadonlyMap<string, PgTable>;

  bind(db: Db, product: ComposedProductDeploy, productTables: ReadonlyMap<string, PgTable>): void {
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
    this.#jobs.push({ workflowRunId, ...input });
    this.calls.push({ workflowRunId, deduped });
    return { workflowRunId, deduped };
  }

  /** Execute EVERY recorded job (redeliveries included) — the journal is the dedup authority. */
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

describe.skipIf(!hasDb)('acme-notes fake-provider e2e through the REAL deploy path', () => {
  let h: DeployHarness;
  let result: DeployResult<ReturnType<typeof createAuthApp>>;
  let app: ReturnType<typeof createAuthApp>;
  let blobDir: string;
  let blobFactory: ReturnType<typeof makeFsBlobStoreFactory>;
  let tokenA: string;
  let tokenB: string;
  const enqueuer = new DrainEnqueuer();
  const extractorCounter = { invocations: 0 };
  const composedStores = [...audioCapabilityStores(), ...PRODUCT_STORES];
  // Every store here is durable (the audio `*_ref` idiom + the note_artifacts collection's
  // artifact_ref) — each unique column is an ON CONFLICT target → keep its unique index SINGLE-column
  // (a compound one would 42P10 the upsert).
  const conflictKeys = new Map(
    composedStores.map((s) => [
      s.name,
      new Set(s.columns.filter((c) => c.unique).map((c) => c.name)),
    ]),
  );

  /** Register a fresh user and return its bearer + user id (looked up by email, server truth). */
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

  const postChunk = (
    session: string,
    track: string,
    index: number,
    token: string,
    bytes: Uint8Array,
  ) =>
    app.request(`/sessions/${session}/${track}/chunks/${index}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'audio/ogg' },
      body: bytes,
    });

  const finalize = (session: string, track: string, token: string, totalChunks: number) =>
    jsonRequest(app, 'POST', `/sessions/${session}/${track}/finalize`, {
      body: { total_chunks: totalChunks },
      headers: { authorization: `Bearer ${token}` },
    });

  const get = (path: string, token?: string, headers?: Record<string, string>) =>
    app.request(path, {
      method: 'GET',
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(headers ?? {}) },
    });

  async function workflowRunRows(): Promise<Array<{ status: string; tenant_id: string }>> {
    return (await h.db.$client.unsafe(
      'SELECT status, tenant_id FROM workflow_runs',
    )) as unknown as Array<{ status: string; tenant_id: string }>;
  }

  beforeAll(async () => {
    const yamlSource = readFileSync(ACME_YAML_PATH, 'utf8');
    // The REAL parser/lint chain admits the document with ZERO errors.
    const parsed = parseProductSpec(yamlSource);
    if (!parsed.ok) {
      throw new Error(
        `acme-notes.product.yaml must validate:\n${JSON.stringify(parsed.errors, null, 2)}`,
      );
    }

    h = await createDeployHarness({ stores: composedStores, schema: SCHEMA, conflictKeys });
    await h.db.$client.unsafe(WORKFLOW_JOURNAL_DDL);
    // The deployment tenant exists BEFORE deploy (the dispatcher/sink bind to it at compose time).
    await h.db.$client.unsafe(`INSERT INTO orgs (id, name, slug) VALUES ($1, 'Acme', 'acme')`, [
      TENANT_A,
    ]);

    blobDir = mkdtempSync(join(tmpdir(), 'rayspec-acme-e2e-'));
    blobFactory = makeFsBlobStoreFactory(blobDir);
    const media = createMediaTokenService(MEDIA_SECRET);

    // THE DEPLOY: the real GitOps pipeline over the acme-notes.product.yaml + the product rollout.
    result = await deploy<ReturnType<typeof createAuthApp>>({
      specSource: yamlSource,
      migrations: [
        {
          name: '0000_acme.sql',
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
          stores: PRODUCT_STORES,
          artifactCollections: new Map([['note_artifacts', { store: 'note_artifacts' }]]),
          transcripts: { store: 'track_transcripts' },
          stt: { adapter: new FakeSttAdapter({ fixtures: [STT_FIXTURE] }) },
          agents: makeCountingExtractor(extractorCounter),
        },
      },
    });
    app = result.app;
    if (!result.product) throw new Error('deploy() returned no composed product runtime');
    enqueuer.bind(h.db, result.product, h.productTables);

    // Principal A on the PRE-CREATED deployment tenant (membership seeded server-side).
    const a = await registerUser('acme-e2e-a@example.com');
    await h.db.$client.unsafe(
      `INSERT INTO memberships (org_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active')`,
      [TENANT_A, a.userId],
    );
    tokenA = await switchTo(TENANT_A, a.token);

    // Principal B in its OWN org (created through the normal API).
    const b = await registerUser('acme-e2e-b@example.com');
    const orgRes = await jsonRequest(app, 'POST', '/v1/orgs', {
      body: { name: 'NotAcme' },
      headers: { authorization: `Bearer ${b.token}` },
    });
    expect([200, 201]).toContain(orgRes.status);
    const orgB = (await orgRes.json()).id as string;
    tokenB = await switchTo(orgB, b.token);
  }, 120_000);

  afterAll(async () => {
    await h?.close();
    if (blobDir) rmSync(blobDir, { recursive: true, force: true });
  });

  it('deploy() MOUNTED the product document (composed runtime + migration + no drift)', () => {
    testsRan += 1;
    expect(result.product).toBeTruthy();
    expect([...(result.product?.workflows.keys() ?? [])]).toEqual(['process_session']);
    expect(result.product?.triggerEvents).toEqual(['audio_input.finalized_session']);
    expect(result.product?.viewRoutes).toHaveLength(4);
    expect(result.gateResults.map((g) => g.pass)).toEqual([true]);
    expect(result.drift).toEqual([]); // the migrated live schema matches the composed spec
    const storeNames = result.spec.stores.map((s) => s.name);
    expect(storeNames).toEqual(
      expect.arrayContaining([
        'audio_sessions',
        'audio_tracks',
        'track_transcripts',
        'note_artifacts',
      ]),
    );
  });

  it('upload → dual-track finalize → EXACTLY ONE durable run, executed to completion', async () => {
    testsRan += 1;
    expect((await postChunk(SESSION, 'mic', 0, tokenA, new Uint8Array([1, 2]))).status).toBe(200);
    expect((await postChunk(SESSION, 'mic', 1, tokenA, new Uint8Array([3]))).status).toBe(200);
    expect((await postChunk(SESSION, 'system', 0, tokenA, new Uint8Array([4, 5, 6]))).status).toBe(
      200,
    );
    expect((await finalize(SESSION, 'mic', tokenA, 2)).status).toBe(200);
    expect((await finalize(SESSION, 'system', tokenA, 1)).status).toBe(200);
    // Re-finalize (idempotent 200) re-emits the SAME session-scoped event.
    expect((await finalize(SESSION, 'mic', tokenA, 2)).status).toBe(200);

    // THREE emits (first seal, second seal, re-finalize) → ONE durable run id (the single-flight key law).
    expect(enqueuer.calls).toHaveLength(3);
    expect(new Set(enqueuer.calls.map((c) => c.workflowRunId)).size).toBe(1);
    expect(enqueuer.calls.map((c) => c.deduped)).toEqual([false, true, true]);

    // Drain TWICE (every recorded job, then a full redelivery): the JOURNAL is the dedup authority.
    await enqueuer.drain();
    await enqueuer.drain();

    const runs = await workflowRunRows();
    expect(runs).toHaveLength(1); // ground truth: EXACTLY ONE run row
    expect(runs[0]?.status).toBe('completed');
    expect(runs[0]?.tenant_id).toBe(TENANT_A);
    expect(extractorCounter.invocations).toBe(1); // the extraction fired EXACTLY once

    const nodes = (await h.db.$client.unsafe(
      'SELECT node_id, status FROM workflow_node_states ORDER BY position',
    )) as unknown as Array<{ node_id: string; status: string }>;
    expect(nodes.map((n) => [n.node_id, n.status])).toEqual([
      ['transcribe', 'completed'],
      ['extract', 'completed'],
      ['ground', 'completed'],
      ['validate', 'completed'],
      ['persist', 'completed'],
    ]);
  }, 60_000);

  it('the transcript view serves the REAL persisted transcript (goldens + 304 + absent + 400)', async () => {
    testsRan += 1;
    const res = await get(`/sessions/${SESSION}/mic/transcript`, tokenA);
    expect(res.status).toBe(200);
    const etag = res.headers.get('etag');
    expect(etag).toBeTruthy();
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.session_id).toBe(SESSION);
    expect(body.track).toBe('mic');
    expect(body.status).toBe('completed');
    expect(body.model).toBe('fake-model');
    expect(body.detected_language).toBeNull();
    expect(body.full_text).toBe(MIC_FULL_TEXT);
    expect(body.confidence).toBe(0.99);
    expect(body.billed_duration_seconds).toBe(MIC_SEGMENTS.length * 5); // segments × 5s (fixture law)
    expect(body.segments).toEqual(MIC_SEGMENTS);
    const words = body.words as Array<Record<string, unknown>>;
    expect(body.word_count).toBe(words.length);

    // REAL conditional read: If-None-Match with the served ETag → bodyless 304, same ETag.
    const cached = await get(`/sessions/${SESSION}/mic/transcript`, tokenA, {
      'if-none-match': etag as string,
    });
    expect(cached.status).toBe(304);
    expect(cached.headers.get('etag')).toBe(etag);
    expect(await cached.text()).toBe('');

    // The ABSENT-transcript 200 (never a 404) for a never-processed session.
    const absent = await get('/sessions/never-processed/mic/transcript', tokenA);
    expect(absent.status).toBe(200);
    const absentBody = (await absent.json()) as Record<string, unknown>;
    expect(absentBody.status).toBe('absent');
    expect(absentBody.word_count).toBe(0);
    expect(absentBody.words).toEqual([]);

    // The specified 400 contract (an out-of-enum track).
    const bad = await get(`/sessions/${SESSION}/other/transcript`, tokenA);
    expect(bad.status).toBe(400);
  });

  it('the notes view serves the GROUNDED artifacts — prune + drop are VISIBLE (exact DTO)', async () => {
    testsRan += 1;
    const res = await get(`/sessions/${SESSION}/notes`, tokenA);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    // The asymmetric counts oracle (query = 0) — the fail-the-fix grounding proof.
    expect(body.counts).toEqual(ORACLE.expected_persisted.counts);
    expect(body.session_id).toBe(SESSION);

    // The digest projected from the candidate top level (evidence-exempt).
    expect(body.digest).toEqual({
      headline: (ORACLE.candidate_notes as Record<string, unknown>).headline,
      detail: (ORACLE.candidate_notes as Record<string, unknown>).detail,
      output_language: (ORACLE.candidate_notes as Record<string, unknown>).output_language,
    });

    // Every evidence-required kind: exactly the oracle's KEPT members, with pruned evidence.
    const expectedByKind = (kind: string) =>
      ORACLE.expected_persisted.artifacts
        .filter((a) => a.artifact_kind === kind)
        .map((a) => ({
          text: a.text,
          evidence: a.evidence_span_ids,
          evidence_span_ids: a.evidence_span_ids,
        }));
    expect(body.items).toEqual(expectedByKind('item')); // 2 kept: one PRUNED to ['mic:s0'], one to ['mic:s1']; the ghost DROPPED
    expect(body.pointers).toEqual(expectedByKind('pointer'));
    expect(body.queries).toEqual([]); // the empty-evidence query was DROPPED
    expect(body.labels).toEqual(expectedByKind('label'));

    // The never-processed session: the zeroed shape (the specified absent contract).
    const absent = await get('/sessions/never-processed/notes', tokenA);
    expect(absent.status).toBe(200);
    expect(await absent.json()).toEqual({
      session_id: 'never-processed',
      digest: null,
      items: [],
      pointers: [],
      queries: [],
      labels: [],
      counts: { item: 0, pointer: 0, query: 0, label: 0, digest: 0, total: 0 },
    });
  });

  it('the session-list view serves the composed read surface (tracks, transcripts, counts)', async () => {
    testsRan += 1;
    const res = await get('/sessions', tokenA);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.total).toBe(1);
    expect(body.next_offset).toBeNull();
    const sessions = body.sessions as Array<Record<string, unknown>>;
    expect(sessions).toHaveLength(1);
    const s = sessions[0] as Record<string, unknown>;
    expect(s.id).toBe(SESSION);
    expect(s.status).toBe('recording');
    expect(s.protocol_version).toBe(2);
    expect(typeof s.started_at).toBe('string');
    expect(s.ended_at).toBeNull();
    expect(s.artifacts).toEqual([]);
    expect(s.note_counts).toEqual(ORACLE.expected_persisted.counts);
    const tracks = s.tracks as Array<Record<string, unknown>>;
    expect(tracks.map((t) => t.track)).toEqual(['mic', 'system']); // declared order_by track
    expect(tracks[0]).toMatchObject({
      track: 'mic',
      status: 'completed',
      bytes_written: 3,
      chunks_written: 2,
      transcript_status: 'completed',
      transcript_language: null,
      sample_rate: null,
      ended_at: null,
    });
    expect(tracks[1]).toMatchObject({
      track: 'system',
      bytes_written: 3,
      chunks_written: 1,
      transcript_status: 'completed',
    });
    expect(typeof tracks[0]?.transcript_word_count).toBe('number');

    // The declared pagination params work over the real route.
    const page = (await (await get('/sessions?limit=1&offset=1', tokenA)).json()) as Record<
      string,
      unknown
    >;
    expect(page.sessions).toEqual([]);
    expect(page.total).toBe(1);
  });

  it('the playback-token view is capability-DELEGATED: 409 before media prep, token + bytes after', async () => {
    testsRan += 1;
    const notReady = await jsonRequest(app, 'POST', `/sessions/${SESSION}/mic/play-token`, {
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(notReady.status).toBe(409); // the declared not_ready_409 contract, served by capability code

    // Media prep (the Tier-B registration path — remux/prep pipelines are out of scope here).
    const prep = await registerPlayableArtifact(
      {
        tenantId: TENANT_A,
        db: makeHandlerDb(forTenant(h.db, TENANT_A), h.productTables),
        config: resolveConfig(),
        blob: blobFactory(TENANT_A),
      },
      { session_id: SESSION, track: 'mic' },
      {
        bytes: new TextEncoder().encode('AUDIOBYTES'),
        contentType: 'audio/ogg',
        durationSeconds: 10,
      },
    );
    expect(prep.ok).toBe(true);

    const minted = await jsonRequest(app, 'POST', `/sessions/${SESSION}/mic/play-token`, {
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(minted.status).toBe(200);
    const token = (await minted.json()) as {
      url: string;
      expires_at: string;
      ttl_seconds: number;
    };
    expect(token.url).toContain(`/sessions/${SESSION}/mic/playback?token=`);
    expect(typeof token.expires_at).toBe('string');
    expect(token.ttl_seconds).toBeGreaterThan(0);

    // ... and the minted URL actually STREAMS the registered bytes through the audio stream route.
    const stream = await get(token.url, tokenA);
    expect([200, 206]).toContain(stream.status);
    expect(await stream.text()).toBe('AUDIOBYTES');
  });

  it('CROSS-TENANT: B never reads A through ANY view; B can NEVER enqueue into A’s dispatcher', async () => {
    testsRan += 1;
    // B has its own upload (a session row exists for B) …
    expect((await postChunk('b-sess', 'mic', 0, tokenB, new Uint8Array([9]))).status).toBe(200);

    // 1. session-list: B sees EXACTLY its own session — zero of A's.
    const bList = (await (await get('/sessions', tokenB)).json()) as Record<string, unknown>;
    expect((bList.sessions as Array<{ id: string }>).map((s) => s.id)).toEqual(['b-sess']);
    expect(bList.total).toBe(1);

    // 2. transcript: A's completed transcript is INVISIBLE to B (absent shape, not A's data).
    const bTx = (await (await get(`/sessions/${SESSION}/mic/transcript`, tokenB)).json()) as Record<
      string,
      unknown
    >;
    expect(bTx.status).toBe('absent');
    expect(bTx.full_text).toBeNull();

    // 3. notes: A's grounded artifacts are INVISIBLE to B (zeroed).
    const bNotes = (await (await get(`/sessions/${SESSION}/notes`, tokenB)).json()) as Record<
      string,
      unknown
    >;
    expect(bNotes.digest).toBeNull();
    expect((bNotes.counts as Record<string, number>).total).toBe(0);

    // 4. B's finalize can NEVER enqueue into A's tenant-bound dispatcher: the bridge sink rejects
    //    the cross-tenant event fail-closed (single-deployment posture) — the route maps the
    //    rejection to a CLEAN deliberate 403, and NO new enqueue and NO new workflow run exist.
    const callsBefore = enqueuer.calls.length;
    const bFinalize = await finalize('b-sess', 'mic', tokenB, 1);
    expect(bFinalize.status).toBe(403); // fail-closed AND deliberate — never an unhandled 500
    expect(await bFinalize.json()).toEqual({
      error: 'session_event_rejected',
      detail:
        'the session_finalized event was rejected fail-closed (cross_tenant) — no workflow was started.',
    });
    expect(enqueuer.calls.length).toBe(callsBefore);
    const runs = await workflowRunRows();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.tenant_id).toBe(TENANT_A);

    // 5. … and A still sees exactly A's data (the predicate cuts both ways).
    const aList = (await (await get('/sessions', tokenA)).json()) as Record<string, unknown>;
    expect((aList.sessions as Array<{ id: string }>).map((s) => s.id)).toEqual([SESSION]);
  });

  it('DELETE the org CASCADES away every product row (audio_* / track_transcripts / note_artifacts)', async () => {
    testsRan += 1;
    const countRows = async (table: string, tenant: string): Promise<number> => {
      const rows = (await h.db.$client.unsafe(
        `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`,
        [tenant],
      )) as unknown as Array<{ n: number }>;
      return rows[0]?.n ?? 0;
    };

    // Ground truth BEFORE: tenant A owns audio + transcript + note-artifact rows.
    expect(await countRows('audio_sessions', TENANT_A)).toBeGreaterThan(0);
    expect(await countRows('track_transcripts', TENANT_A)).toBeGreaterThan(0);
    expect(await countRows('note_artifacts', TENANT_A)).toBe(
      ORACLE.expected_persisted.counts.total,
    );

    // DELETE the org — the injected tenant FK (ON DELETE CASCADE) removes every product row.
    await h.db.$client.unsafe('DELETE FROM orgs WHERE id = $1', [TENANT_A]);

    expect(await countRows('audio_sessions', TENANT_A)).toBe(0);
    expect(await countRows('audio_tracks', TENANT_A)).toBe(0);
    expect(await countRows('track_transcripts', TENANT_A)).toBe(0);
    expect(await countRows('note_artifacts', TENANT_A)).toBe(0);
    expect(await countRows('workflow_runs', TENANT_A)).toBe(0);
  });
});

/**
 * Un-skippable ran-guard: FAILS a DB-required run (CI / RAYSPEC_REQUIRE_DB_TESTS) that lost
 * DATABASE_URL and silently skipped the acme-notes end-to-end proof above.
 */
describe('acme-notes e2e (DB) — ran-guard', () => {
  it('the acme-notes e2e tests ACTUALLY RAN when the DB is required (CI / opt-in)', () => {
    if (requireDb) {
      expect(testsRan).toBe(8); // the 8 e2e stages above
    } else {
      expect(requireDb).toBe(false);
    }
  });
});
