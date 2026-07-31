/**
 * `POST /v1/runs/{id}/cancel` — the run-cancellation surface, DB-backed (real Postgres, isolated
 * schema), with the deterministic FakeRunBackend and a STUB `DurableExecutor` (no DBOS in this
 * process — the real engine's half is proven in @rayspec/durable-dbos's executor-cancel.db.test.ts).
 *
 * What is asserted here, as ground truth rather than shape:
 *  - TENANT ISOLATION: a foreign runId and an absent runId each answer 404 and change NOTHING
 *    observable (no marker row, no header move, no signal delivered).
 *  - The terminal outcome is JOURNALED like any other outcome: the run reads back through
 *    `GET /v1/runs/{id}` as `status:'error'` with the neutral `errorClass:'cancelled'`.
 *  - An ENQUEUED durable run is cancelled BEFORE it starts: the engine is asked to cancel the job and
 *    the persisted cancellation marker is what stops a later dispatch.
 *  - An EXECUTING in-request run receives the SIGNAL: the held request is freed because the run was
 *    aborted, not because the request timed out.
 *  - TAINT: cancelling a run whose non-idempotent tool already fired lands in the quarantine — the
 *    Idempotency-Key reservation is KEPT, so a same-key retry never silently re-runs it.
 *  - UNSET: with no cancel involved, a run behaves exactly as it did before this surface existed.
 */

import type { NeutralTool } from '@rayspec/core';
import type {
  DurableExecutor,
  DurableExecutorIdentity,
  EnqueueResult,
  RunJob,
} from '@rayspec/platform';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRegistry, AgentRegistryEntry } from '../app-context.js';
import { FakeRunBackend } from '../test-support/fake-backend.js';
import { createHarness, type Harness, jsonRequest } from '../test-support/harness.js';

/** A SIDE-EFFECT counter the non-idempotent tool bumps on every real fire (the taint ground truth). */
const sideEffects = { count: 0 };

/** A NON-idempotent tool (a `charge_card`-shaped side effect) — firing it taints its run. */
const chargeTool: NeutralTool = {
  spec: {
    name: 'charge_card',
    description: 'a non-idempotent side effect (charge a card)',
    parameters: { type: 'object', properties: { q: { type: 'string' } } },
  },
  handler: (args) => {
    sideEffects.count += 1;
    return { charged: (args as { q?: string }).q ?? '' };
  },
  timeoutMs: 1000,
  idempotent: false,
};

const backend = new FakeRunBackend();

const registry: AgentRegistry = new Map<string, AgentRegistryEntry>([
  [
    'echo-agent',
    {
      spec: {
        name: 'echo',
        instructions: 'echo the input',
        model: 'gpt-4.1-mini',
        input: '',
        tools: [],
        maxTurns: 4,
      },
      backend,
    },
  ],
  [
    'charge-agent',
    {
      spec: {
        name: 'charger',
        instructions: 'charge then maybe fail',
        model: 'gpt-4.1-mini',
        input: '',
        tools: [chargeTool.spec],
        maxTurns: 4,
      },
      backend,
      tools: [chargeTool],
    },
  ],
]);

/**
 * An in-memory STUB DurableExecutor that RECORDS every cancel it is asked for, so the route's durable
 * half is observable without booting an engine. It never runs `runAgent` (that half is the durable
 * package's own test).
 */
class StubExecutor implements DurableExecutor {
  readonly enqueued: Array<{ tenantId: string; job: RunJob }> = [];
  readonly cancelled: string[] = [];
  /** When set, `cancel` throws — the route must still answer, the marker being the durable record. */
  failCancel = false;
  async enqueue(tenantId: string, job: RunJob): Promise<EnqueueResult> {
    this.enqueued.push({ tenantId, job });
    return { jobId: job.runId };
  }
  async status(jobId: string): Promise<'enqueued' | 'cancelled' | 'unknown'> {
    if (this.cancelled.includes(jobId)) return 'cancelled';
    return this.enqueued.some((e) => e.job.runId === jobId) ? 'enqueued' : 'unknown';
  }
  async cancel(jobId: string): Promise<void> {
    if (this.failCancel) throw new Error('stub cancel failure');
    this.cancelled.push(jobId);
  }
  async start(): Promise<void> {}
  async shutdown(): Promise<void> {}
  identity(): DurableExecutorIdentity {
    return { executorId: 'stub-executor', applicationVersion: 'stub-version' };
  }
}

let h: Harness;
let stub: StubExecutor;

async function principal(email: string, orgName: string) {
  const reg = await jsonRequest(h.app, 'POST', '/v1/auth/register', {
    body: { email, password: 'a-long-enough-password' },
  });
  const t0 = (await reg.json()).accessToken as string;
  const orgRes = await jsonRequest(h.app, 'POST', '/v1/orgs', {
    body: { name: orgName },
    headers: { authorization: `Bearer ${t0}` },
  });
  const orgId = (await orgRes.json()).id as string;
  const switchRes = await jsonRequest(h.app, 'POST', `/v1/orgs/${orgId}/switch`, {
    headers: { authorization: `Bearer ${t0}` },
  });
  const token = (await switchRes.json()).accessToken as string;
  return { orgId, token };
}

/** Every `runs` row for a tenant — the header ground truth (read on the pool, committed rows only). */
async function runHeaders(orgId: string): Promise<Array<{ run_id: string; status: string }>> {
  return (await h.db.$client.unsafe(
    'SELECT run_id, status FROM runs WHERE tenant_id = $1 ORDER BY created_at',
    [orgId],
  )) as unknown as Array<{ run_id: string; status: string }>;
}

/** How many `run_cancelled` marker rows exist for a runId (the durable never-re-dispatch record). */
async function cancelMarkers(runId: string): Promise<number> {
  const rows = (await h.db.$client.unsafe(
    "SELECT count(*)::int AS n FROM idempotency_keys WHERE scope = 'run_cancelled' AND idem_key = $1",
    [runId],
  )) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

/** Poll the `runs` header until a row for this tenant reaches `status` (bounded — never a bare sleep). */
async function waitForHeader(orgId: string, status: string, capMs = 4000): Promise<string> {
  const deadline = Date.now() + capMs;
  while (Date.now() < deadline) {
    const rows = await runHeaders(orgId);
    const hit = rows.find((r) => r.status === status);
    if (hit) return hit.run_id;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`no run header reached status '${status}' within ${capMs}ms`);
}

beforeAll(async () => {
  h = await createHarness({ agentRegistry: registry, schema: 'rayspec_test_apiauth_cancel' });
});
beforeEach(async () => {
  await h.reset();
  backend.liveRuns = 0;
  backend.gate = undefined;
  backend.errorDetail = undefined;
  backend.errorClass = 'internal';
  backend.fireToolBeforeError = false;
  sideEffects.count = 0;
  stub = new StubExecutor();
  h.deps.durableExecutor = stub;
});
afterEach(async () => {
  await backend.settle();
});
afterAll(async () => {
  await h.close();
});

describe('POST /v1/runs/:id/cancel — tenant isolation (fail-closed 404, zero effect)', () => {
  it('a FOREIGN runId answers 404 and cancels nothing (no marker, the owner’s run untouched)', async () => {
    const owner = await principal('cancelowner@example.com', 'CancelOwnerOrg');
    const stranger = await principal('cancelstranger@example.com', 'CancelStrangerOrg');

    // The owner enqueues a durable run; its 202 hands back the runId.
    const enq = await jsonRequest(h.app, 'POST', '/v1/agents/echo-agent/runs', {
      body: { input: 'owned work', async: true },
      headers: { authorization: `Bearer ${owner.token}`, accept: 'application/json' },
    });
    expect(enq.status).toBe(202);
    const runId = (await enq.json()).runId as string;

    // The stranger names the SAME runId. It is another tenant's run: uniform 404, no leak.
    const res = await jsonRequest(h.app, 'POST', `/v1/runs/${runId}/cancel`, {
      headers: { authorization: `Bearer ${stranger.token}`, accept: 'application/json' },
    });
    expect(res.status).toBe(404);

    // ZERO effect: no cancellation marker, the engine was never asked, the header did not move.
    expect(await cancelMarkers(runId)).toBe(0);
    expect(stub.cancelled).toEqual([]);
    expect((await runHeaders(owner.orgId))[0]?.status).toBe('enqueued');
  });

  it('an ABSENT runId answers 404 and writes no marker', async () => {
    const { token } = await principal('cancelabsent@example.com', 'CancelAbsentOrg');
    const res = await jsonRequest(
      h.app,
      'POST',
      '/v1/runs/00000000-0000-4000-8000-00000000dead/cancel',
      { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } },
    );
    expect(res.status).toBe(404);
    expect(await cancelMarkers('00000000-0000-4000-8000-00000000dead')).toBe(0);
    expect(stub.cancelled).toEqual([]);
  });
});

describe('POST /v1/runs/:id/cancel — a durable run that has not started', () => {
  it('ends the enqueued run before it executes: the engine is asked to cancel it and the marker is persisted', async () => {
    const { token, orgId } = await principal('cancelenq@example.com', 'CancelEnqOrg');
    const enq = await jsonRequest(h.app, 'POST', '/v1/agents/echo-agent/runs', {
      body: { input: 'never runs', async: true },
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    const runId = (await enq.json()).runId as string;

    const res = await jsonRequest(h.app, 'POST', `/v1/runs/${runId}/cancel`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ runId, cancelled: true });

    // The engine was asked to end the not-yet-started job …
    expect(stub.cancelled).toEqual([runId]);
    // … and the persisted marker is what makes a later dispatch (or a recovery re-dispatch) refuse.
    expect(await cancelMarkers(runId)).toBe(1);
    // The agent never executed.
    expect(backend.liveRuns).toBe(0);
    expect((await runHeaders(orgId))[0]?.status).toBe('error');
  });

  it('journals the terminal outcome: GET /v1/runs/{id} reads back error + errorClass `cancelled`', async () => {
    const { token } = await principal('canceljournal@example.com', 'CancelJournalOrg');
    const enq = await jsonRequest(h.app, 'POST', '/v1/agents/echo-agent/runs', {
      body: { input: 'cancel me', async: true },
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    const runId = (await enq.json()).runId as string;

    await jsonRequest(h.app, 'POST', `/v1/runs/${runId}/cancel`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });

    const read = await jsonRequest(h.app, 'GET', `/v1/runs/${runId}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    expect(read.status).toBe(200);
    const body = (await read.json()) as {
      status: string;
      errorClass: string | null;
      error: string;
    };
    // The outcome is journaled like any other outcome — the neutral class is what a client reads.
    expect(body.status).toBe('error');
    expect(body.errorClass).toBe('cancelled');
    expect(body.error).toContain('cancel');
  });

  it('a repeated cancel is idempotent: the second call reports the run was already terminal', async () => {
    const { token } = await principal('cancelrepeat@example.com', 'CancelRepeatOrg');
    const enq = await jsonRequest(h.app, 'POST', '/v1/agents/echo-agent/runs', {
      body: { input: 'twice', async: true },
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    const runId = (await enq.json()).runId as string;
    const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };

    const first = await jsonRequest(h.app, 'POST', `/v1/runs/${runId}/cancel`, { headers });
    expect((await first.json()).cancelled).toBe(true);
    const second = await jsonRequest(h.app, 'POST', `/v1/runs/${runId}/cancel`, { headers });
    expect(second.status).toBe(200);
    // The run was already terminal — this call changed nothing; it did not re-journal an outcome.
    expect((await second.json()).cancelled).toBe(false);
    expect(await cancelMarkers(runId)).toBe(1);
  });

  it('answers even when the engine cancel throws — the persisted marker is the durable record', async () => {
    const { token } = await principal('cancelenginefail@example.com', 'CancelEngineFailOrg');
    const enq = await jsonRequest(h.app, 'POST', '/v1/agents/echo-agent/runs', {
      body: { input: 'engine will fail', async: true },
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    const runId = (await enq.json()).runId as string;
    stub.failCancel = true;

    const res = await jsonRequest(h.app, 'POST', `/v1/runs/${runId}/cancel`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    expect(res.status).toBe(200);
    // The engine call failed, but the run is still recorded cancelled — a dispatch consults the marker.
    expect(await cancelMarkers(runId)).toBe(1);
  });
});

describe('POST /v1/runs/:id/cancel — an EXECUTING run receives the signal', () => {
  it('frees the held work, not merely the request: the in-flight run is aborted and reads back cancelled', async () => {
    const { token, orgId } = await principal('cancelexec@example.com', 'CancelExecOrg');
    // Hold the run open mid-flight (the deterministic barrier — no fixed sleeps).
    const armed = backend.arm();

    const held = jsonRequest(h.app, 'POST', '/v1/agents/echo-agent/runs', {
      body: { input: 'long work' },
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    await armed.arrived;
    // The sync run publishes its `running` header as execution starts — that is how the id is known.
    const runId = await waitForHeader(orgId, 'running');

    const res = await jsonRequest(h.app, 'POST', `/v1/runs/${runId}/cancel`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    expect(res.status).toBe(200);

    // The held request settles WITHOUT the gate ever being released: the run itself was aborted.
    const heldRes = await held;
    expect(heldRes.status).toBe(409);
    expect(armed.release).toBeTypeOf('function');

    // The run's terminal outcome is the cancellation.
    const read = await jsonRequest(h.app, 'GET', `/v1/runs/${runId}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    const body = (await read.json()) as { status: string; errorClass: string | null };
    expect(body.status).toBe('error');
    expect(body.errorClass).toBe('cancelled');
  });
});

describe('POST /v1/runs/:id/cancel — the non-idempotent-taint quarantine', () => {
  it('a cancelled run that already fired a non-idempotent tool is QUARANTINED — a same-key retry never re-fires it', async () => {
    const { token, orgId } = await principal('canceltaint@example.com', 'CancelTaintOrg');
    const headers = {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'idempotency-key': 'cancel-taint-1',
    };
    // The run fires charge_card (the side effect + the run-taint marker) and then blocks at the gate.
    backend.fireToolBeforeError = true;
    backend.errorDetail = 'held after charging';
    backend.errorClass = 'internal';
    const armed = backend.arm();

    const held = jsonRequest(h.app, 'POST', '/v1/agents/charge-agent/runs', {
      body: { input: 'order-cancel' },
      headers,
    });
    await armed.arrived;
    expect(sideEffects.count).toBe(1); // charged exactly once, before the cancel

    const runId = await waitForHeader(orgId, 'running');
    await jsonRequest(h.app, 'POST', `/v1/runs/${runId}/cancel`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    await held;

    // A same-Idempotency-Key retry must NOT re-run the cancelled run: cancelling is never a silent
    // re-run, and this run fired an irreversible side effect, so it is quarantined under its key.
    const retry = await jsonRequest(h.app, 'POST', '/v1/agents/charge-agent/runs', {
      body: { input: 'order-cancel' },
      headers,
    });
    // The WHOLE invariant: the side effect fired EXACTLY ONCE across the cancel + retry.
    expect(sideEffects.count).toBe(1);
    expect(backend.liveRuns).toBe(1);
    // The retry REPLAYS the cancelled run rather than executing a second one — same runId, and the
    // terminal class says why it ended. (`cancelled` is a terminal class, so the replay is a 200
    // carrying the outcome, exactly like every other terminal class.)
    const replayed = (await retry.json()) as { runId: string; errorClass: string | null };
    expect(replayed.runId).toBe(runId);
    expect(replayed.errorClass).toBe('cancelled');
  });
});

describe('UNSET — with no cancel involved, a run behaves exactly as before', () => {
  it('an ordinary sync run completes, is not marked, and reports no error class', async () => {
    const { token } = await principal('cancelunset@example.com', 'CancelUnsetOrg');
    const res = await jsonRequest(h.app, 'POST', '/v1/agents/echo-agent/runs', {
      body: { input: 'hello' },
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runId: string; status: string; errorClass: null };
    expect(body.status).toBe('completed');
    expect(body.errorClass).toBeNull();
    expect(await cancelMarkers(body.runId)).toBe(0);
    expect(backend.liveRuns).toBe(1);
  });
});
