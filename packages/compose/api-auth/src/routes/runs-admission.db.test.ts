/**
 * Run admission on the HTTP run surface — DB-backed (real Postgres, isolated schema), no model call.
 *
 *  - IN-REQUEST: with `inRequestRunGate` wired, a run past the bound is refused with 429
 *    RATE_LIMITED, a `Retry-After`, and `details.reason: 'queue-full'` — before anything is recorded
 *    for it (no header; its Idempotency-Key reservation is given back, so the same key runs later). The
 *    slot is held until the run SETTLES, and given back then.
 *  - QUEUED (`async:true`): an executor that refuses the enqueue with `RunAdmissionRefusedError` is
 *    answered the same way, and the header and reservation the surface recorded are undone.
 *  - CANCEL: the cancel surface states what can be said of the provider call — `before-call` for a
 *    run still `enqueued`.
 */
import {
  type DurableExecutor,
  type DurableExecutorIdentity,
  type EnqueueResult,
  InRequestRunGate,
  RunAdmissionRefusedError,
  type RunJob,
} from '@rayspec/platform';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRegistry, AgentRegistryEntry } from '../app-context.js';
import { FakeRunBackend } from '../test-support/fake-backend.js';
import { createHarness, type Harness, jsonRequest } from '../test-support/harness.js';

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
]);

/** An executor whose queue is full: every enqueue is refused, nothing is recorded. */
class FullQueueExecutor implements DurableExecutor {
  enqueueCalls = 0;
  async enqueue(_tenantId: string, _job: RunJob): Promise<EnqueueResult> {
    this.enqueueCalls += 1;
    throw new RunAdmissionRefusedError('tenant', 3);
  }
  async status(): Promise<'unknown'> {
    return 'unknown';
  }
  async cancel(): Promise<void> {}
  async start(): Promise<void> {}
  async shutdown(): Promise<void> {}
  identity(): DurableExecutorIdentity {
    return { executorId: 'stub', applicationVersion: 'stub' };
  }
}

/** An executor that accepts every job and runs none (the job stays `enqueued`). */
class AcceptingExecutor extends FullQueueExecutor {
  override async enqueue(_tenantId: string, job: RunJob): Promise<EnqueueResult> {
    this.enqueueCalls += 1;
    return { jobId: job.runId };
  }
}

let h: Harness;

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
  return { orgId, token: (await switchRes.json()).accessToken as string };
}

async function countRows(sql: string, params: unknown[]): Promise<number> {
  const rows = (await h.db.$client.unsafe(sql, params as never[])) as unknown as Array<{
    n: number;
  }>;
  return rows[0]?.n ?? 0;
}

beforeAll(async () => {
  h = await createHarness({ agentRegistry: registry, schema: 'rayspec_test_apiauth_admission' });
});
beforeEach(async () => {
  await h.reset();
  backend.liveRuns = 0;
  h.deps.durableExecutor = undefined;
  h.deps.inRequestRunGate = undefined;
});
afterEach(async () => {
  await backend.settle();
});
afterAll(async () => {
  await h.close();
});

describe('in-request admission (RAYSPEC_AGENT_SYNC_RUNS_MAX)', () => {
  it('a run past the bound is refused with 429 + Retry-After before anything is recorded, and the slot comes back when the run settles', async () => {
    const gate = new InRequestRunGate(1);
    h.deps.inRequestRunGate = gate;
    const { token } = await principal('admit-sync@example.com', 'AdmitSync');
    const held = backend.arm();
    const first = jsonRequest(h.app, 'POST', '/v1/agents/echo-agent/runs', {
      body: { input: 'first' },
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    await held.arrived;
    expect(gate.active).toBe(1);

    const refused = await jsonRequest(h.app, 'POST', '/v1/agents/echo-agent/runs', {
      body: { input: 'second' },
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'idempotency-key': 'admit-key-1',
      },
    });
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('5');
    const body = await refused.json();
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.message).toContain('RAYSPEC_AGENT_SYNC_RUNS_MAX');
    expect(body.error.details).toMatchObject({
      reason: 'queue-full',
      scope: 'in-request',
      limit: 1,
    });
    // The refused run never started, and its reservation was given back.
    expect(backend.liveRuns).toBe(1);
    expect(
      await countRows(
        "SELECT count(*)::int AS n FROM idempotency_keys WHERE scope = 'agent_run' AND idem_key = $1",
        ['admit-key-1'],
      ),
    ).toBe(0);

    // The held run settles; its slot comes back, and the same key now runs.
    held.release();
    expect((await first).status).toBe(200);
    await backend.settle();
    expect(gate.active).toBe(0);
    const retried = await jsonRequest(h.app, 'POST', '/v1/agents/echo-agent/runs', {
      body: { input: 'second' },
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'idempotency-key': 'admit-key-1',
      },
    });
    expect(retried.status).toBe(200);
    expect(gate.active).toBe(0);
  });

  it('without the gate wired, runs are not counted (the behaviour without the bound)', async () => {
    const { token } = await principal('admit-off@example.com', 'AdmitOff');
    const held = backend.arm();
    const first = jsonRequest(h.app, 'POST', '/v1/agents/echo-agent/runs', {
      body: { input: 'first' },
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    await held.arrived;
    backend.gate = undefined;
    const second = await jsonRequest(h.app, 'POST', '/v1/agents/echo-agent/runs', {
      body: { input: 'second' },
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    expect(second.status).toBe(200);
    held.release();
    expect((await first).status).toBe(200);
  });
});

describe('queue admission on async:true', () => {
  it('a refused enqueue answers 429 + Retry-After and undoes the header and the reservation', async () => {
    const executor = new FullQueueExecutor();
    h.deps.durableExecutor = executor;
    const { token } = await principal('admit-async@example.com', 'AdmitAsync');
    const res = await jsonRequest(h.app, 'POST', '/v1/agents/echo-agent/runs', {
      body: { input: 'queued', async: true },
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'idempotency-key': 'admit-async-key',
      },
    });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('5');
    const body = await res.json();
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.details).toMatchObject({ reason: 'queue-full', scope: 'tenant', limit: 3 });
    expect(executor.enqueueCalls).toBe(1);
    // Nothing is left for a run that was never queued: no header, no reservation.
    expect(await countRows('SELECT count(*)::int AS n FROM runs', [])).toBe(0);
    expect(
      await countRows(
        "SELECT count(*)::int AS n FROM idempotency_keys WHERE scope = 'agent_run'",
        [],
      ),
    ).toBe(0);
  });
});

describe('the cancel surface states what can be said of the provider call', () => {
  it('a run still enqueued is recorded cancelled `before-call`', async () => {
    h.deps.durableExecutor = new AcceptingExecutor();
    const { token } = await principal('cancel-phase@example.com', 'CancelPhase');
    const enq = await jsonRequest(h.app, 'POST', '/v1/agents/echo-agent/runs', {
      body: { input: 'never runs', async: true },
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    expect(enq.status).toBe(202);
    const { runId } = (await enq.json()) as { runId: string };
    const cancel = await jsonRequest(h.app, 'POST', `/v1/runs/${runId}/cancel`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(cancel.status).toBe(200);
    const rows = (await h.db.$client.unsafe(
      "SELECT output->>'phase' AS phase, output->>'error' AS error FROM journal_steps WHERE run_id = $1 AND type = 'cancel'",
      [runId],
    )) as unknown as Array<{ phase: string; error: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.phase).toBe('before-call');
    expect(rows[0]?.error).toContain('before its provider call started');
  });
});
