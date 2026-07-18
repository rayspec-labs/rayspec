/**
 * the durable-enqueue route-handler seam, DB-backed, end-to-end through the REAL
 * createAuthApp + declared-route interpreter, with a STUB neutral `DurableExecutor` (NO DBOS in this
 * process — the REAL DBOS engine is proven in @rayspec/durable-dbos's executor.db.test.ts).
 *
 * These assert the contract on GROUND TRUTH (fail-the-fix, not pass-the-shape): a declared
 * ROUTE handler that calls `init.enqueue(...)` enqueues a durable agent run for THIS REQUEST'S
 * SERVER-DERIVED tenant, registry-bound, fail-closed when unwired — and the security invariants go RED
 * on the obvious mutation (drop the registry check / drop the tenant binding).
 *
 *  (1) ENQUEUES + RUNS OFF-REQUEST FOR THE SAME TENANT — the handler enqueues an agent run; exactly one
 *      job is enqueued under the REQUEST tenant + the reserved runId, carrying the right neutral RunJob.
 *  (2) TENANT-SCOPED BY CONSTRUCTION — a handler invoked in tenant A's request enqueues a job whose
 *      `tenantId === A` (and the closure has NO tenant parameter — asserted structurally + behaviourally
 *      across two distinct tenants).
 *  (3) REGISTRY-BOUND — `init.enqueue({ agentId:'no-such-agent' })` fail-closes (NOT_FOUND); no job.
 *  (4) FAIL-CLOSED WHEN UNWIRED — with no durable executor, `init.enqueue` is ABSENT (the handler
 *      fail-closes loudly on `undefined`); no silent no-op.
 *
 * Skips when DATABASE_URL is absent.
 */
import type { NeutralTool } from '@rayspec/core';
import type {
  DurableExecutor,
  DurableExecutorIdentity,
  EnqueueResult,
  ResolvedHandler,
  RunJob,
} from '@rayspec/platform';
import { parseSpec, type RaySpec } from '@rayspec/spec';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRegistry, AgentRegistryEntry } from '../app-context.js';
import { FakeRunBackend } from '../test-support/fake-backend.js';
import { createHarness, type Harness, jsonRequest } from '../test-support/harness.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
// un-skippable ran-guard: this DB-backed suite proves the tenant-scoped durable-enqueue seam — it must
// never silently self-skip to a false green. When the DB is REQUIRED but absent, hard-fail at collection.
if (requireDb && !hasDb) {
  throw new Error(
    'route-handler-enqueue.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but ' +
      'absent — refusing to silently skip a security-load-bearing suite.',
  );
}

/**
 * A STUB DurableExecutor recording every enqueued (tenantId, job) — so a test asserts the WHOLE
 * invariant (exactly one job, the right tenant, the reserved runId). It does NOT run runAgent (proven
 * against the REAL DBOS engine in @rayspec/durable-dbos). `start`/`shutdown`/`status` are minimal.
 */
class StubExecutor implements DurableExecutor {
  readonly enqueued: Array<{ tenantId: string; job: RunJob }> = [];
  async enqueue(tenantId: string, job: RunJob): Promise<EnqueueResult> {
    this.enqueued.push({ tenantId, job });
    return { jobId: job.runId };
  }
  async status(jobId: string): Promise<'enqueued' | 'unknown'> {
    return this.enqueued.some((e) => e.job.runId === jobId) ? 'enqueued' : 'unknown';
  }
  async start(): Promise<void> {}
  async shutdown(): Promise<void> {}
  identity(): DurableExecutorIdentity {
    return { executorId: 'stub-executor', applicationVersion: 'stub-version' };
  }
}

/** A deterministic no-tool agent the enqueue resolves against (registry-bound). */
const echoTool: NeutralTool = {
  spec: {
    name: 'lookup',
    description: 'a deterministic lookup',
    parameters: { type: 'object', properties: { q: { type: 'string' } } },
  },
  handler: (args) => ({ found: (args as { q?: string }).q ?? '' }),
  timeoutMs: 1000,
  idempotent: true,
};

function buildRegistry(backend: FakeRunBackend): AgentRegistry {
  return new Map<string, AgentRegistryEntry>([
    [
      'transcribe-agent',
      {
        spec: {
          name: 'transcribe',
          instructions: 'transcribe',
          model: 'gpt-4.1-mini',
          input: '',
          tools: [echoTool.spec],
          maxTurns: 4,
        },
        backend,
        tools: [echoTool],
      },
    ],
  ]);
}

/**
 * A throwaway spec declaring a `notes` store + a single `{handler}` route POST /finalize → the
 * `finalize_handler` (kind route). The handler is injected directly (engineHandlers) — its fn calls
 * `init.enqueue`, driven by route params so each test exercises a different case.
 */
const SPEC_YAML = `
version: '1.0'
metadata:
  name: enqueue-seam-backend
  description: A throwaway backend with a {handler} route that calls init.enqueue.
stores:
  - name: notes
    columns:
      - name: title
        type: text
handlers:
  - id: finalize_handler
    module: handlers/finalize.ts
    export: finalize
    kind: route
api:
  - method: POST
    path: /finalize/{agent_id}
    action:
      kind: handler
      handler: finalize_handler
`;

function buildSpec(): RaySpec {
  const parsed = parseSpec(SPEC_YAML);
  if (!parsed.ok) throw new Error(`spec invalid: ${JSON.stringify(parsed.errors)}`);
  return parsed.value;
}

/**
 * The finalize route handler (the pack-side consumer of `init.enqueue`). It reads the agent id from the
 * path param + an optional idempotency key / pinned runId from the query, then ENQUEUES a durable run.
 * Fail-closes loudly if `init.enqueue` is absent (no durable worker wired) — never a silent no-op.
 *
 * Authored against the SAME contract a real pack writes against; injected here as a ResolvedHandler so
 * the test does not need a path-jailed examples/ pack (the loadExtensions path is exercised by the
 * agent-pack suite).
 */
const finalizeHandler: ResolvedHandler = {
  kind: 'route',
  fn: async (init): Promise<unknown> => {
    const i = init as {
      params: Record<string, string>;
      enqueue?: (req: {
        agentId: string;
        input: string;
        idempotencyKey?: string;
        runId?: string;
      }) => Promise<{ runId: string }>;
    };
    if (!i.enqueue) {
      // Fail-closed: no durable worker wired → the capability is absent. Never a silent no-op.
      throw new Error(
        'finalize: init.enqueue is not available (no durable worker wired). Fail-closed.',
      );
    }
    const agentId = i.params.agent_id ?? 'transcribe-agent';
    const idempotencyKey = i.params.idem;
    const pinnedRunId = i.params.run_id;
    const { runId } = await i.enqueue({
      agentId,
      input: 'transcribe this recording',
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(pinnedRunId ? { runId: pinnedRunId } : {}),
    });
    return { enqueued: true, runId };
  },
};

describe.skipIf(!hasDb)('route-handler init.enqueue durable seam', () => {
  let h: Harness;
  let stub: StubExecutor;
  let backend: FakeRunBackend;
  const SCHEMA = 'rayspec_test_route_handler_enqueue';

  beforeAll(async () => {
    backend = new FakeRunBackend();
    h = await createHarness({
      engineSpec: buildSpec(),
      engineHandlers: new Map<string, ResolvedHandler>([['finalize_handler', finalizeHandler]]),
      agentRegistry: buildRegistry(backend),
      schema: SCHEMA,
    });
  });
  beforeEach(async () => {
    await h.reset();
    await backend.settle();
    backend.liveRuns = 0;
    stub = new StubExecutor();
    // Default: a durable worker IS wired (the enqueue cases). The fail-closed test clears it.
    h.deps.durableExecutor = stub;
  });
  afterAll(async () => {
    await backend.settle();
    await h.close();
  });

  /** Register → org → switch → JWT (member role: store:read/write + agent:run). */
  async function principal(
    email: string,
    orgName: string,
  ): Promise<{ orgId: string; token: string }> {
    const reg = await jsonRequest(h.app, 'POST', '/v1/auth/register', {
      body: { email, password: 'a-long-enough-password' },
    });
    const t0 = (await reg.json()).accessToken as string;
    const orgId = (
      await (
        await jsonRequest(h.app, 'POST', '/v1/orgs', {
          body: { name: orgName },
          headers: { authorization: `Bearer ${t0}` },
        })
      ).json()
    ).id as string;
    const token = (
      await (
        await jsonRequest(h.app, 'POST', `/v1/orgs/${orgId}/switch`, {
          headers: { authorization: `Bearer ${t0}` },
        })
      ).json()
    ).accessToken as string;
    return { orgId, token };
  }

  it('(1) the handler enqueues a durable agent run for THIS tenant (one job, the reserved runId, the right RunJob)', async () => {
    const { orgId, token } = await principal('enq@example.com', 'EnqOrg');
    const res = await jsonRequest(h.app, 'POST', '/finalize/transcribe-agent', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enqueued: boolean; runId: string };
    expect(body.enqueued).toBe(true);
    expect(typeof body.runId).toBe('string');

    // EXACTLY ONE job enqueued, under THIS request's tenant, the runId the handler got back.
    expect(stub.enqueued).toHaveLength(1);
    const { tenantId, job } = stub.enqueued[0]!;
    expect(tenantId).toBe(orgId); // SERVER-DERIVED tenant — the request's org
    expect(job.tenantId).toBe(orgId); // the RunJob payload's tenant matches (tenant-scoped by construction)
    expect(job.runId).toBe(body.runId); // the runId the handler received == the enqueued job's runId
    expect(job.agentId).toBe('transcribe-agent');
    expect(job.input).toBe('transcribe this recording');
    // The run did NOT execute in-request (off-request: no synchronous backend run).
    expect(backend.liveRuns).toBe(0);
  });

  it('(2) TENANT-SCOPED BY CONSTRUCTION: tenant A and tenant B each enqueue ONLY their OWN tenant (no cross-tenant)', async () => {
    const a = await principal('tenantA@example.com', 'TenantA');
    const b = await principal('tenantB@example.com', 'TenantB');
    expect(a.orgId).not.toBe(b.orgId);

    // Tenant A's request → the closure was built bound to A's server-derived tenant.
    await jsonRequest(h.app, 'POST', '/finalize/transcribe-agent', {
      headers: { authorization: `Bearer ${a.token}` },
    });
    // Tenant B's request → bound to B's tenant. The pack passes NO tenant (there is no such parameter).
    await jsonRequest(h.app, 'POST', '/finalize/transcribe-agent', {
      headers: { authorization: `Bearer ${b.token}` },
    });

    expect(stub.enqueued).toHaveLength(2);
    const tenants = stub.enqueued.map((e) => e.tenantId).sort();
    expect(tenants).toEqual([a.orgId, b.orgId].sort());
    // Each job's payload tenant matches its enqueue tenant (the closure has no path to the OTHER tenant).
    for (const e of stub.enqueued) expect(e.job.tenantId).toBe(e.tenantId);
    // Neither tenant's job carries the other's id — a cross-tenant enqueue is structurally impossible.
    const jobTenants = new Set(stub.enqueued.map((e) => e.job.tenantId));
    expect(jobTenants.has(a.orgId)).toBe(true);
    expect(jobTenants.has(b.orgId)).toBe(true);
  });

  it('(3) REGISTRY-BOUND: enqueueing an UNDECLARED agent fail-closes (NOT_FOUND); no job enqueued', async () => {
    const { token } = await principal('undeclared@example.com', 'UndeclaredOrg');
    const res = await jsonRequest(h.app, 'POST', '/finalize/no-such-agent', {
      headers: { authorization: `Bearer ${token}` },
    });
    // The ApiError('NOT_FOUND') from the shared core propagates through onError → 404 (no existence leak).
    expect(res.status).toBe(404);
    // NOTHING was enqueued — a pack can never enqueue an undeclared/foreign agent (no dangling enqueue).
    expect(stub.enqueued).toHaveLength(0);
  });

  it('(4) FAIL-CLOSED WHEN UNWIRED: with no durable executor, init.enqueue is absent (handler fail-closes), no job', async () => {
    h.deps.durableExecutor = undefined; // no durable worker wired
    const { token } = await principal('unwired@example.com', 'UnwiredOrg');
    const res = await jsonRequest(h.app, 'POST', '/finalize/transcribe-agent', {
      headers: { authorization: `Bearer ${token}` },
    });
    // The handler throws on the absent capability → global onError → 500 (a loud fail-closed, NOT a
    // silent no-op). The capability being ABSENT (not a throwing closure) is the contract.
    expect(res.status).toBe(500);
    expect(stub.enqueued).toHaveLength(0);
    expect(backend.liveRuns).toBe(0);
  });

  it('PINNED runId is TENANT-NAMESPACED: two tenants pinning the SAME runId enqueue DIFFERENT durable ids (no cross-tenant collision)', async () => {
    // Two DISTINCT tenants each pin the SAME `run_id` string (NO idempotencyKey → the reserve block is
    // skipped; the pinned runId is the durable workflow id directly). The pinned value MUST be
    // tenant-namespaced server-side, else both land on ONE global DBOS workflow id and the second
    // tenant's job is silently dropped (a tenant-isolation/availability defect). Fail-the-fix: revert
    // the seam to `req.runId ?? randomUUID()` (verbatim) → the two job.runIds become EQUAL → this REDs.
    const a = await principal('pinA@example.com', 'PinA');
    const b = await principal('pinB@example.com', 'PinB');
    expect(a.orgId).not.toBe(b.orgId);

    await jsonRequest(h.app, 'POST', '/finalize/transcribe-agent?run_id=shared-pin', {
      headers: { authorization: `Bearer ${a.token}` },
    });
    await jsonRequest(h.app, 'POST', '/finalize/transcribe-agent?run_id=shared-pin', {
      headers: { authorization: `Bearer ${b.token}` },
    });

    expect(stub.enqueued).toHaveLength(2);
    // The whole point: same pinned string, DIFFERENT tenant → tenant-disjoint durable ids.
    expect(stub.enqueued[0]!.job.runId).not.toBe(stub.enqueued[1]!.job.runId);
    // Each job's durable id is bound to ITS OWN tenant (no collision onto the other's workflow).
    expect(stub.enqueued[0]!.tenantId).not.toBe(stub.enqueued[1]!.tenantId);
    // Neither runId is the bare pinned string (it is the tenant-namespaced derivation).
    for (const e of stub.enqueued) expect(e.job.runId).not.toBe('shared-pin');
  });

  it('PINNED runId is DETERMINISTIC within a tenant: the SAME (tenant, runId) derives the SAME durable id both calls', async () => {
    // Exactly-once / crash-reconcile preserved WITHIN a tenant: pinning the same value twice (same tenant)
    // derives the SAME durable runId, and the handler's returned runId echoes that derived value.
    const { orgId, token } = await principal('pindet@example.com', 'PinDet');
    const headers = { authorization: `Bearer ${token}` };
    const first = await jsonRequest(h.app, 'POST', '/finalize/transcribe-agent?run_id=p', {
      headers,
    });
    const second = await jsonRequest(h.app, 'POST', '/finalize/transcribe-agent?run_id=p', {
      headers,
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const r1 = (await first.json()) as { runId: string };
    const r2 = (await second.json()) as { runId: string };
    // SAME derived runId both times (deterministic) — and the returned runId is the derived value, NOT
    // the bare pin (so a crash-retry of the trigger reconciles to one run).
    expect(r2.runId).toBe(r1.runId);
    expect(r1.runId).not.toBe('p');
    // Both enqueued jobs carry that derived runId, under THIS tenant.
    expect(stub.enqueued).toHaveLength(2);
    for (const e of stub.enqueued) {
      expect(e.tenantId).toBe(orgId);
      expect(e.job.runId).toBe(r1.runId);
    }
  });

  it('IDEMPOTENCY: two POSTs with the SAME idempotency key enqueue exactly ONE job (same runId)', async () => {
    const { orgId, token } = await principal('idem@example.com', 'IdemOrg');
    const headers = { authorization: `Bearer ${token}` };
    const first = await jsonRequest(h.app, 'POST', '/finalize/transcribe-agent?idem=track-42', {
      headers,
    });
    const second = await jsonRequest(h.app, 'POST', '/finalize/transcribe-agent?idem=track-42', {
      headers,
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const r1 = (await first.json()) as { runId: string };
    const r2 = (await second.json()) as { runId: string };
    // SAME runId returned (the reserve dedupes) — and EXACTLY ONE job enqueued (not two).
    expect(r2.runId).toBe(r1.runId);
    expect(stub.enqueued).toHaveLength(1);
    expect(stub.enqueued[0]!.tenantId).toBe(orgId);
    expect(stub.enqueued[0]!.job.runId).toBe(r1.runId);
  });
});
