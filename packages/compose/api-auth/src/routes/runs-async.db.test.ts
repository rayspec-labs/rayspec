/**
 * Async (off-request) run-path HTTP tests — DB-backed (real Postgres, isolated schema),
 * with a STUB neutral `DurableExecutor` (NO DBOS in this process — the REAL DBOS engine is proven in
 * @rayspec/durable-dbos's executor.db.test.ts). These assert the RUN-SURFACE contract end-to-end on
 * ground truth (fail-the-fix, not pass-the-shape):
 *
 *  - `async:true` with NO durable executor wired → fail-closed 501 (never a silent sync fallback).
 *  - `async:true` with an executor wired → 202 + { runId, status:'enqueued', events } IMMEDIATELY,
 *    and EXACTLY ONE job enqueued carrying the right neutral RunJob payload.
 *  - the runId returned is RESERVED (an idempotency_keys row exists under it) — reserve-before-enqueue.
 *  - IDEMPOTENCY: two async POSTs with the SAME Idempotency-Key enqueue EXACTLY ONE job (the whole
 *    invariant: one job, one runId — not merely "a job exists"); same key + different body → 409.
 *  - HASH-EXCLUDES-ASYNC: a SYNC then an ASYNC POST of the same logical input under one key share ONE
 *    slot (the async-vs-sync retry does NOT split the idempotency reservation).
 */
import type { NeutralTool } from '@rayspec/core';
import type { DurableExecutor, EnqueueResult, RunJob } from '@rayspec/platform';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRegistry, AgentRegistryEntry } from '../app-context.js';
import { FakeRunBackend } from '../test-support/fake-backend.js';
import { createHarness, type Harness, jsonRequest } from '../test-support/harness.js';

/** A deterministic tool so the synchronous path produces a real journaled run (the hash-share test). */
const lookupTool: NeutralTool = {
  spec: {
    name: 'lookup',
    description: 'a deterministic lookup',
    parameters: { type: 'object', properties: { q: { type: 'string' } } },
  },
  handler: (args) => ({ found: (args as { q?: string }).q ?? '' }),
  timeoutMs: 1000,
  idempotent: true,
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
        tools: [lookupTool.spec],
        maxTurns: 4,
      },
      backend,
      tools: [lookupTool],
    },
  ],
]);

/**
 * An in-memory STUB DurableExecutor: records every enqueued (tenantId, job) so a test can assert the
 * WHOLE idempotency invariant (exactly one job, one runId). It does NOT run runAgent — the off-request
 * execution is proven against the REAL DBOS engine in @rayspec/durable-dbos. `start`/`shutdown` are
 * no-ops.
 *
 * Two enqueue-failure modes model the two real shapes (fix C):
 *  - `failNext` = a PRE-persist failure: enqueue throws WITHOUT recording the job, and `status(runId)`
 *    stays 'unknown' (the job was never durably created) → the run surface MAY release the reservation.
 *  - `failNextAfterPersist` = a POST-persist failure: enqueue RECORDS the job (durably created) and
 *    THEN throws → `status(runId)` returns a non-'unknown' state, so the run surface must KEEP the
 *    reservation (a same-key retry must not mint a second runId / second job).
 */
class StubExecutor implements DurableExecutor {
  readonly enqueued: Array<{ tenantId: string; job: RunJob }> = [];
  /** When set, enqueue throws BEFORE recording (the job never durably exists → status stays unknown). */
  failNext = false;
  /** When set, enqueue RECORDS the job (durably persisted) and THEN throws (post-persist failure). */
  failNextAfterPersist = false;
  async enqueue(tenantId: string, job: RunJob): Promise<EnqueueResult> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('stub enqueue failure (pre-persist)');
    }
    if (this.failNextAfterPersist) {
      this.failNextAfterPersist = false;
      // Persist FIRST (the job is durably created), THEN throw — exactly DBOS startWorkflow's order.
      this.enqueued.push({ tenantId, job });
      throw new Error('stub enqueue failure (post-persist — job already durably created)');
    }
    this.enqueued.push({ tenantId, job });
    return { jobId: job.runId };
  }
  /** A recorded job is 'enqueued' (durably created); anything else is 'unknown' (never created). */
  async status(jobId: string): Promise<'enqueued' | 'unknown'> {
    return this.enqueued.some((e) => e.job.runId === jobId) ? 'enqueued' : 'unknown';
  }
  async start(): Promise<void> {}
  async shutdown(): Promise<void> {}
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

beforeAll(async () => {
  h = await createHarness({ agentRegistry: registry, schema: 'rayspec_test_apiauth_async' });
});
beforeEach(async () => {
  await h.reset();
  backend.liveRuns = 0;
  stub = new StubExecutor();
  // Default: NO executor wired (the 501 case). A test that needs one sets h.deps.durableExecutor.
  h.deps.durableExecutor = undefined;
});
afterEach(async () => {
  await backend.settle();
});
afterAll(async () => {
  await h.close();
});

describe('POST /v1/agents/:id/runs (async:true) — fail-closed 501 with NO durable worker', () => {
  it('returns 501 when no durable executor is wired (never a silent sync fallback)', async () => {
    const { token } = await principal('async501@example.com', 'Async501');
    const res = await jsonRequest(h.app, 'POST', '/v1/agents/echo-agent/runs', {
      body: { input: 'hello', async: true },
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    expect(res.status).toBe(501);
    // The run did NOT execute synchronously (fail-closed, not a fallback).
    expect(backend.liveRuns).toBe(0);
  });
});

describe('POST /v1/agents/:id/runs (async:true) — 202 + enqueue with a durable worker', () => {
  it('returns 202 + {runId,status:enqueued,events} immediately and enqueues exactly ONE job', async () => {
    h.deps.durableExecutor = stub;
    const { token } = await principal('async202@example.com', 'Async202');
    const res = await jsonRequest(h.app, 'POST', '/v1/agents/echo-agent/runs', {
      body: { input: 'summarize this', async: true, maxTurns: 3 },
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.status).toBe('enqueued');
    expect(typeof body.runId).toBe('string');
    expect(body.events).toBe(`/v1/runs/${body.runId}/events`);
    // The run did NOT block the request (no synchronous execution).
    expect(backend.liveRuns).toBe(0);
    // EXACTLY ONE job enqueued, carrying the right neutral RunJob payload (the whole invariant).
    expect(stub.enqueued).toHaveLength(1);
    const { job } = stub.enqueued[0]!;
    expect(job.runId).toBe(body.runId);
    expect(job.agentId).toBe('echo-agent');
    expect(job.input).toBe('summarize this');
    expect(job.maxTurns).toBe(3);
  });

  it('reserves the returned runId (reserve-before-enqueue) when an Idempotency-Key is supplied', async () => {
    h.deps.durableExecutor = stub;
    const { orgId, token } = await principal('asyncresv@example.com', 'AsyncResv');
    const res = await jsonRequest(h.app, 'POST', '/v1/agents/echo-agent/runs', {
      body: { input: 'reserve me', async: true },
      headers: {
        authorization: `Bearer ${token}`,
        'idempotency-key': 'k-resv',
        accept: 'application/json',
      },
    });
    expect(res.status).toBe(202);
    const { runId } = await res.json();
    // The idempotency row exists under the reserved runId scope='agent_run' (reserve-before-enqueue).
    const rows = await h.db.$client.unsafe(
      "SELECT snapshot FROM idempotency_keys WHERE tenant_id = $1 AND scope = 'agent_run' AND idem_key = 'k-resv'",
      [orgId],
    );
    expect(rows).toHaveLength(1);
    expect((rows[0] as { snapshot: { runId?: string } }).snapshot.runId).toBe(runId);
  });
});

describe('async idempotency — exactly ONE job per Idempotency-Key (the whole invariant)', () => {
  it('two async POSTs with the SAME key enqueue exactly ONE job (one runId)', async () => {
    h.deps.durableExecutor = stub;
    const { token } = await principal('asyncidem@example.com', 'AsyncIdem');
    const headers = {
      authorization: `Bearer ${token}`,
      'idempotency-key': 'k-async-1',
      accept: 'application/json',
    };
    const first = await jsonRequest(h.app, 'POST', '/v1/agents/echo-agent/runs', {
      body: { input: 'once', async: true },
      headers,
    });
    const second = await jsonRequest(h.app, 'POST', '/v1/agents/echo-agent/runs', {
      body: { input: 'once', async: true },
      headers,
    });
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const r1 = await first.json();
    const r2 = await second.json();
    // SAME runId returned to both callers — AND exactly ONE job enqueued (not two).
    expect(r2.runId).toBe(r1.runId);
    expect(stub.enqueued).toHaveLength(1);
    expect(stub.enqueued[0]!.job.runId).toBe(r1.runId);
  });

  it('same key + DIFFERENT body → 409 (and no second enqueue)', async () => {
    h.deps.durableExecutor = stub;
    const { token } = await principal('asyncconf@example.com', 'AsyncConf');
    const headers = {
      authorization: `Bearer ${token}`,
      'idempotency-key': 'k-async-2',
      accept: 'application/json',
    };
    const first = await jsonRequest(h.app, 'POST', '/v1/agents/echo-agent/runs', {
      body: { input: 'alpha', async: true },
      headers,
    });
    expect(first.status).toBe(202);
    const second = await jsonRequest(h.app, 'POST', '/v1/agents/echo-agent/runs', {
      body: { input: 'beta', async: true },
      headers,
    });
    expect(second.status).toBe(409);
    expect(stub.enqueued).toHaveLength(1);
  });

  it('the idempotency hash EXCLUDES async: a SYNC then ASYNC POST of the same input share ONE slot', async () => {
    h.deps.durableExecutor = stub;
    const { token } = await principal('asynchash@example.com', 'AsyncHash');
    const headers = {
      authorization: `Bearer ${token}`,
      'idempotency-key': 'k-mixed',
      accept: 'application/json',
    };
    // 1) A SYNC run under the key → runs in-request, keeps its reservation (completed run).
    const sync = await jsonRequest(h.app, 'POST', '/v1/agents/echo-agent/runs', {
      body: { input: 'mixed' },
      headers,
    });
    expect(sync.status).toBe(200);
    const syncRunId = (await sync.json()).runId as string;
    expect(backend.liveRuns).toBe(1);

    // 2) An ASYNC POST of the SAME logical input under the SAME key. Because the hash EXCLUDES async,
    //    the body-hash MATCHES the sync reservation → the loser path replays the prior run, NOT a 409
    //    (which is what a DIFFERENT hash would have produced) and NOT a second enqueue.
    const async = await jsonRequest(h.app, 'POST', '/v1/agents/echo-agent/runs', {
      body: { input: 'mixed', async: true },
      headers,
    });
    // Same slot ⇒ 202 with the SAME runId, and NO new job enqueued (the prior run owns the key).
    expect(async.status).toBe(202);
    const loserJson = await async.json();
    expect(loserJson.runId).toBe(syncRunId);
    expect(stub.enqueued).toHaveLength(0);
    // Fix E (loser-path status honesty): the prior run already COMPLETED (the sync 200 above), so the
    // loser body must NOT claim status:'enqueued' (a lie). It omits status entirely; the caller reads
    // the real, current state from GET /v1/runs/{id}. It still points at the runId + its event stream.
    expect(loserJson.status).toBeUndefined();
    expect(loserJson.events).toBe(`/v1/runs/${syncRunId}/events`);
  });
});

describe('async enqueue failure releases the reservation (retryable)', () => {
  it('a PRE-persist failed enqueue releases the key so a retry can re-enqueue', async () => {
    h.deps.durableExecutor = stub;
    stub.failNext = true; // throws before recording → status(runId) === 'unknown' → safe to release
    const { token } = await principal('asyncfail@example.com', 'AsyncFail');
    const headers = {
      authorization: `Bearer ${token}`,
      'idempotency-key': 'k-fail',
      accept: 'application/json',
    };
    const failed = await jsonRequest(h.app, 'POST', '/v1/agents/echo-agent/runs', {
      body: { input: 'will fail', async: true },
      headers,
    });
    expect(failed.status).toBe(500); // the enqueue throw propagates → global onError → 500
    // The reservation was RELEASED (no leftover row), so a retry can re-enqueue under a fresh runId.
    const retry = await jsonRequest(h.app, 'POST', '/v1/agents/echo-agent/runs', {
      body: { input: 'will fail', async: true },
      headers,
    });
    expect(retry.status).toBe(202);
    expect(stub.enqueued).toHaveLength(1);
  });

  it('a POST-persist enqueue throw KEEPS the reservation — a same-key retry does NOT double-fire (fix C, fail-the-fix)', async () => {
    h.deps.durableExecutor = stub;
    stub.failNextAfterPersist = true; // records the job (durably created) THEN throws
    const { token } = await principal('asyncpostfail@example.com', 'AsyncPostFail');
    const headers = {
      authorization: `Bearer ${token}`,
      'idempotency-key': 'k-postfail',
      accept: 'application/json',
    };
    // 1) The first POST: enqueue persists the job, then throws → 500. The job IS durably created.
    const failed = await jsonRequest(h.app, 'POST', '/v1/agents/echo-agent/runs', {
      body: { input: 'will partially fail', async: true },
      headers,
    });
    expect(failed.status).toBe(500);
    // Exactly ONE job was durably recorded (the post-persist write happened before the throw).
    expect(stub.enqueued).toHaveLength(1);
    const firstRunId = stub.enqueued[0]!.job.runId;

    // 2) A same-key retry MUST NOT mint a second runId / enqueue a second job. Because the
    //    reservation was KEPT (status(runId) !== 'unknown' on the throw), the retry hits the loser
    //    path and returns the EXISTING runId — never a double-fire. If fix C regressed (blanket
    //    release), the retry would win a fresh reservation, mint a new runId, and enqueue a 2nd job.
    const retry = await jsonRequest(h.app, 'POST', '/v1/agents/echo-agent/runs', {
      body: { input: 'will partially fail', async: true },
      headers,
    });
    expect(retry.status).toBe(202);
    expect((await retry.json()).runId).toBe(firstRunId); // the SAME durable run, replayed
    expect(stub.enqueued).toHaveLength(1); // NO second job enqueued (no double-fire)
  });
});
