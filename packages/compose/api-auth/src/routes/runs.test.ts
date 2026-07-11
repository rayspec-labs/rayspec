/**
 * Agent-run HTTP/SSE route tests — DB-backed (real Postgres, isolated schema via the
 * harness), FAKE deterministic backend (no live model call). Assert the REAL thing:
 *  - POST /agents/{id}/runs (Accept: application/json) returns a valid RunResult; the run is
 *    journaled + its events are in run_events;
 *  - run-level idempotency: same key+body → SAME runId (not re-executed); same key+diff body → 409;
 *  - SSE: the stream is the run's NeutralEvents in seq order with id: = seq; run_started…run_completed
 *    present + ordered; GET /runs/{id}/events?lastEventId=N replays only seq > N (resume);
 *  - GET /runs/{id} reconstructs the RunResult tenant-scoped;
 *  - cross-tenant: B reading A's runId → 404 (incl. /events), no leak.
 */

import { computeCost, type NeutralTool } from '@rayspec/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRegistry, AgentRegistryEntry } from '../app-context.js';
import { FakeRunBackend } from '../test-support/fake-backend.js';
import { createHarness, type Harness, jsonRequest } from '../test-support/harness.js';

// A platform-registered neutral tool (trusted TS handler behind dispatchTool). Deterministic.
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

let h: Harness;

/** Provision a principal (registered user → org → switch → JWT) with the agent scopes. */
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

/** Parse an SSE response body into ordered frames ({ id, event, data }). */
async function parseSse(
  res: Response,
): Promise<Array<{ id?: string; event?: string; data: string }>> {
  const text = await res.text();
  const frames: Array<{ id?: string; event?: string; data: string }> = [];
  for (const block of text.split('\n\n')) {
    if (!block.trim()) continue;
    const frame: { id?: string; event?: string; data: string } = { data: '' };
    for (const line of block.split('\n')) {
      if (line.startsWith('id:')) frame.id = line.slice(3).trim();
      else if (line.startsWith('event:')) frame.event = line.slice(6).trim();
      else if (line.startsWith('data:')) frame.data = line.slice(5).trim();
    }
    frames.push(frame);
  }
  return frames;
}

/**
 * Deterministic quiescence barrier for the HTTP-2 throw-path test: poll the tenant-scoped `runs`
 * header until the background runAgent (which outlived the held-request timeout) has written it (its
 * LAST durable write) — so no straggler write races the next test's TRUNCATE. Bounded; the pool's
 * startup search_path resolves the unqualified table to this suite's schema.
 */
async function waitForRunHeader(harness: Harness, tenantId: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await harness.db.$client.unsafe(
      `SELECT 1 FROM runs WHERE tenant_id = '${tenantId}' LIMIT 1;`,
    );
    if (rows.length > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeAll(async () => {
  h = await createHarness({ agentRegistry: registry, schema: 'rayspec_test_apiauth_runs' });
});
beforeEach(async () => {
  await h.reset();
  backend.liveRuns = 0;
  backend.gate = undefined;
  backend.trailingToolError = false;
});
// Test-isolation guard: NEVER let a test leak a gated/hanging backend.run that holds a pooled DB
// connection (a leak poisons the shared postgres-js pool → every later test times out at 30s). If a
// test set a gate and an assertion failed before releasing it, settle() releases the gate AND awaits
// every in-flight run to quiescence — so its trailing run-core writes finish before the next test's
// TRUNCATE (no cross-test write race), and its pooled connection is freed (no cascade).
afterEach(async () => {
  await backend.settle();
});
afterAll(async () => {
  await h.close();
});

describe('POST /v1/agents/:id/runs (JSON)', () => {
  it('returns a valid RunResult; the run is journaled + its events are in run_events', async () => {
    const { token } = await principal('json@example.com', 'JsonOrg');
    const res = await jsonRequest(h.app, 'POST', '/v1/agents/echo-agent/runs', {
      body: { input: 'hello' },
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    expect(res.status).toBe(200);
    const result = await res.json();
    // Valid RunResult shape (always-present output/error).
    expect(result.status).toBe('completed');
    expect(result.finalText).toBe('echo: hello');
    expect(result.backend).toBe('openai');
    expect(Object.hasOwn(result, 'output')).toBe(true);
    expect(Object.hasOwn(result, 'error')).toBe(true);
    expect(result.error).toBeNull();
    // The tool ran through dispatchTool → opaque tool_data surfaced into output.
    expect(result.output).toEqual({ tool: { found: 'hello' } });
    expect(backend.liveRuns).toBe(1);

    // The run is journaled (>=1 llm step + 1 tool step) and its events are in run_events, ordered.
    // The harness connection already has search_path set to the isolated schema (makeDbWithSchema),
    // so a single-command parameterized query resolves to the right tables.
    const runId = result.runId as string;
    const events = await h.db.$client.unsafe(
      'SELECT seq::int AS seq, type FROM run_events WHERE run_id = $1 ORDER BY seq',
      [runId],
    );
    const types = events.map((e: { type: string }) => e.type);
    expect(types[0]).toBe('run_started');
    expect(types).toContain('tool_called');
    expect(types).toContain('tool_result');
    expect(types[types.length - 1]).toBe('run_completed');

    const steps = await h.db.$client.unsafe('SELECT type FROM journal_steps WHERE run_id = $1', [
      runId,
    ]);
    expect(steps.some((s: { type: string }) => s.type === 'tool')).toBe(true);
    expect(steps.some((s: { type: string }) => s.type === 'llm')).toBe(true);
  });

  it('404 for an unknown agent id (no existence leak)', async () => {
    const { token } = await principal('unknown@example.com', 'UnknownOrg');
    const res = await jsonRequest(h.app, 'POST', '/v1/agents/no-such-agent/runs', {
      body: { input: 'hi' },
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    expect(res.status).toBe(404);
  });

  it('401 without a credential', async () => {
    const res = await jsonRequest(h.app, 'POST', '/v1/agents/echo-agent/runs', {
      body: { input: 'hi' },
      headers: { accept: 'application/json' },
    });
    expect(res.status).toBe(401);
  });
});

describe('sync JSON endpoint maps errorClass → HTTP status', () => {
  // A status:'error' RunResult's neutral errorClass maps to a distinct HTTP status on the live JSON
  // run endpoint. The body is still the RunResult (the run executed). GET stays 200 always.
  // Each case sets the fake's class, POSTs, and asserts the status + that the body carries the class.
  async function runWithClass(
    email: string,
    org: string,
    errorClass:
      | 'rate_limited'
      | 'upstream_5xx'
      | 'upstream_4xx'
      | 'timeout'
      | 'model_refusal'
      | 'internal',
    retryAfterSeconds?: number,
  ): Promise<Response> {
    const { token } = await principal(email, org);
    backend.errorDetail = `upstream failure (${errorClass})`;
    backend.errorClass = errorClass;
    backend.retryAfterSeconds = retryAfterSeconds;
    try {
      return await jsonRequest(h.app, 'POST', '/v1/agents/echo-agent/runs', {
        body: { input: 'boom' },
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      });
    } finally {
      backend.errorDetail = undefined;
      backend.errorClass = 'internal';
      backend.retryAfterSeconds = undefined;
    }
  }

  it('rate_limited → 429 + a Retry-After header (when the adapter captured one)', async () => {
    const res = await runWithClass('rl@example.com', 'RlOrg', 'rate_limited', 42);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('42');
    const body = await res.json();
    expect(body.status).toBe('error');
    expect(body.errorClass).toBe('rate_limited');
  });

  it('upstream_5xx → 502', async () => {
    const res = await runWithClass('u5@example.com', 'U5Org', 'upstream_5xx');
    expect(res.status).toBe(502);
    expect((await res.json()).errorClass).toBe('upstream_5xx');
  });

  it('timeout → 504', async () => {
    const res = await runWithClass('to@example.com', 'ToOrg', 'timeout');
    expect(res.status).toBe(504);
    expect((await res.json()).errorClass).toBe('timeout');
  });

  it('model_refusal → 200 (the run executed; the body carries the class)', async () => {
    const res = await runWithClass('mr@example.com', 'MrOrg', 'model_refusal');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('error');
    expect(body.errorClass).toBe('model_refusal');
  });

  it('upstream_4xx + internal → 200 (no remap; the body carries the class)', async () => {
    const r4 = await runWithClass('u4@example.com', 'U4Org', 'upstream_4xx');
    expect(r4.status).toBe(200);
    expect((await r4.json()).errorClass).toBe('upstream_4xx');
    const ri = await runWithClass('in@example.com', 'InOrg', 'internal');
    expect(ri.status).toBe(200);
    expect((await ri.json()).errorClass).toBe('internal');
  });

  it('a COMPLETED run is 200 with errorClass:null (no remap on success)', async () => {
    const { token } = await principal('okrun@example.com', 'OkRunOrg');
    const res = await jsonRequest(h.app, 'POST', '/v1/agents/echo-agent/runs', {
      body: { input: 'fine' },
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('completed');
    expect(body.errorClass).toBeNull();
  });

  it('HTTP-2: a held-request TIMEOUT (throw path) → 504 with error.code === GATEWAY_TIMEOUT (closed envelope)', async () => {
    const { orgId, token } = await principal('to504@example.com', 'To504Org');
    // Exercise the THROW path DETERMINISTICALLY: arm a PRE-gate (the run blocks at the TOP, before any
    // event/journal/DB write) + a tiny in-request timeout so `withTimeout` reliably rejects with
    // RunTimeoutError while the run has ZERO durable work in flight. FAIL-THE-FIX: pre-HTTP-2 the 504
    // body was an ad-hoc { error: { message, requestId, errorClass } } with NO `code` — breaking the
    // closed-envelope contract. The fix emits the standard envelope. `arrived` proves the run is parked.
    const { release, arrived } = backend.armPre();
    h.deps.runTimeoutMs = 30;
    try {
      const res = await jsonRequest(h.app, 'POST', '/v1/agents/echo-agent/runs', {
        body: { input: 'slow' },
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      });
      expect(res.status).toBe(504);
      const body = await res.json();
      // The closed-envelope contract: every non-2xx carries error.code.
      expect(body.error.code).toBe('GATEWAY_TIMEOUT');
      expect(body.error.requestId).toBeDefined();
      // The neutral class rides in details (no info loss).
      expect(body.error.details.errorClass).toBe('timeout');
      await arrived; // the run is provably parked at the pre-gate (no durable work yet)
    } finally {
      release();
      h.deps.runTimeoutMs = undefined;
      // The held-request timeout freed the REQUEST, but the background runAgent KEEPS RUNNING to natural
      // completion (documented limitation — withTimeout does not cancel the SDK call) and only THEN
      // upserts the `runs` header (its LAST write). settle() awaits backend.runImpl, but run-core's
      // post-run continuation (cost rollup + header upsert + conversation insert) is NOT part of that
      // promise — so we must DETERMINISTICALLY wait for the durable header to appear before the next
      // test's TRUNCATE, else the straggler write races it → a flaky `deadlock detected` (the /
      // false-green hazard). Polling the tenant-scoped runs row is the real quiescence barrier.
      await backend.settle();
      await waitForRunHeader(h, orgId);
    }
  });

  it('HTTP-2: a RETURNED timeout-class RunResult → 504 with the RunResult body (the run executed)', async () => {
    const { token } = await principal('to504r@example.com', 'To504ROrg');
    backend.errorDetail = 'upstream timeout';
    backend.errorClass = 'timeout';
    try {
      const res = await jsonRequest(h.app, 'POST', '/v1/agents/echo-agent/runs', {
        body: { input: 'slow' },
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      });
      expect(res.status).toBe(504);
      const body = await res.json();
      // This is the RunResult body (the run RAN and returned status:error) — distinct from the
      // throw-path envelope above. It carries status/errorClass, not an error.code.
      expect(body.status).toBe('error');
      expect(body.errorClass).toBe('timeout');
    } finally {
      backend.errorDetail = undefined;
      backend.errorClass = 'internal';
    }
  });

  describe('GET /runs/{id} surfaces the LLM failure class, not a trailing tool-error step', () => {
    it('a tool-error step AFTER the failing llm step does NOT mask the real rate_limited class + Retry-After', async () => {
      const { token } = await principal('getderive@example.com', 'GetDeriveOrg');
      // The run fails at the LLM layer with rate_limited (+ Retry-After 33), THEN records a trailing
      // tool-error step (no errorClass). FAIL-THE-FIX: the old "last error step" derivation would pick
      // the tool step → errorClass internal + no Retry-After.
      backend.errorDetail = 'HTTP 429 rate limited';
      backend.errorClass = 'rate_limited';
      backend.retryAfterSeconds = 33;
      backend.trailingToolError = true;
      let runId: string;
      try {
        const post = await jsonRequest(h.app, 'POST', '/v1/agents/echo-agent/runs', {
          body: { input: 'derive' },
          headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        });
        // Live: the rate_limited run maps to 429 + Retry-After (read from the LLM step, not the tool).
        expect(post.status).toBe(429);
        expect(post.headers.get('retry-after')).toBe('33');
        runId = (await post.json()).runId as string;
      } finally {
        backend.errorDetail = undefined;
        backend.errorClass = 'internal';
        backend.retryAfterSeconds = undefined;
        backend.trailingToolError = false;
      }
      // GET (always 200) must surface the LLM step's real class — NOT internal from the tool step.
      const get = await jsonRequest(h.app, 'GET', `/v1/runs/${runId}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(get.status).toBe(200);
      const body = await get.json();
      expect(body.status).toBe('error');
      expect(body.errorClass).toBe('rate_limited');
    });
  });

  describe('HTTP-1: idempotency replay consistency for transient vs non-transient error classes', () => {
    it('a TRANSIENT class (rate_limited) RELEASES its reservation → a same-key retry RE-RUNS', async () => {
      const { token } = await principal('http1t@example.com', 'Http1TOrg');
      const headers = {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'idempotency-key': 'http1-transient',
      };
      backend.errorDetail = 'rate limited';
      backend.errorClass = 'rate_limited';
      backend.retryAfterSeconds = 5;
      try {
        const first = await jsonRequest(h.app, 'POST', '/v1/agents/echo-agent/runs', {
          body: { input: 'retry-me' },
          headers,
        });
        expect(first.status).toBe(429);
        expect(backend.liveRuns).toBe(1);
        // FAIL-THE-FIX: pre-fix the reservation was KEPT → the second POST replayed at 200 (no re-run).
        const second = await jsonRequest(h.app, 'POST', '/v1/agents/echo-agent/runs', {
          body: { input: 'retry-me' },
          headers,
        });
        // The transient reservation was released → the agent RE-RAN (liveRuns incremented), still 429.
        expect(backend.liveRuns).toBe(2);
        expect(second.status).toBe(429);
      } finally {
        backend.errorDetail = undefined;
        backend.errorClass = 'internal';
        backend.retryAfterSeconds = undefined;
      }
    });

    it('HTTP1-IDEMP-1 (SSE): a TRANSIENT class (rate_limited) RELEASES its reservation → a same-key SSE retry RE-RUNS', async () => {
      // The Pi no-throw path RETURNS a status:'error' RunResult (it does NOT throw) — the
      // FakeRunBackend reproduces this via `errorDetail` set. Pre-fix the SSE branch discarded the
      // return value and released only in its catch (a THROW), so a RETURNED transient error kept its
      // reservation → a same-key SSE retry replayed the cached error instead of re-running. FAIL-THE-FIX.
      const { token } = await principal('http1tsse@example.com', 'Http1TSseOrg');
      const headers = {
        authorization: `Bearer ${token}`,
        accept: 'text/event-stream',
        'content-type': 'application/json',
        'idempotency-key': 'http1-transient-sse',
      };
      const body = JSON.stringify({ input: 'retry-me-sse' });
      backend.errorDetail = 'rate limited';
      backend.errorClass = 'rate_limited';
      backend.retryAfterSeconds = 5;
      try {
        const first = await parseSse(
          await h.app.request('/v1/agents/echo-agent/runs', { method: 'POST', headers, body }),
        );
        expect(backend.liveRuns).toBe(1);
        // The terminal frame still carries the neutral errorClass (the SSE status line cannot change).
        expect(first.at(-1)?.event).toBe('run_completed');
        const second = await parseSse(
          await h.app.request('/v1/agents/echo-agent/runs', { method: 'POST', headers, body }),
        );
        // The transient reservation was RELEASED → the agent RE-RAN (a SECOND live run), not a replay.
        expect(backend.liveRuns).toBe(2);
        expect(second.at(-1)?.event).toBe('run_completed');
      } finally {
        backend.errorDetail = undefined;
        backend.errorClass = 'internal';
        backend.retryAfterSeconds = undefined;
      }
    });

    it('a NON-transient class (model_refusal) is CACHED → a same-key retry replays at the SAME status (200), NOT re-run', async () => {
      const { token } = await principal('http1nt@example.com', 'Http1NtOrg');
      const headers = {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'idempotency-key': 'http1-nontransient',
      };
      backend.errorDetail = 'the model refused this request';
      backend.errorClass = 'model_refusal';
      try {
        const first = await jsonRequest(h.app, 'POST', '/v1/agents/echo-agent/runs', {
          body: { input: 'refuse-me' },
          headers,
        });
        expect(first.status).toBe(200); // model_refusal stays 200 (the run executed)
        expect(backend.liveRuns).toBe(1);
        const firstBody = await first.json();
        const second = await jsonRequest(h.app, 'POST', '/v1/agents/echo-agent/runs', {
          body: { input: 'refuse-me' },
          headers,
        });
        // NOT re-run (replay), and the replay status MATCHES the live status (HTTP-1: statusForErrorClass
        // on the replay path — no 200-vs-other divergence).
        expect(backend.liveRuns).toBe(1);
        expect(second.status).toBe(first.status);
        const secondBody = await second.json();
        expect(secondBody.runId).toBe(firstBody.runId);
        expect(secondBody.errorClass).toBe('model_refusal');
      } finally {
        backend.errorDetail = undefined;
        backend.errorClass = 'internal';
      }
    });
  });
});

describe('POST /v1/agents/:id/runs run-level idempotency', () => {
  it('same Idempotency-Key + body → the SAME runId (run NOT re-executed)', async () => {
    const { token } = await principal('idem@example.com', 'IdemOrg');
    const headers = {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'idempotency-key': 'run-key-1',
    };
    const first = await (
      await jsonRequest(h.app, 'POST', '/v1/agents/echo-agent/runs', {
        body: { input: 'x' },
        headers,
      })
    ).json();
    expect(backend.liveRuns).toBe(1);
    const second = await (
      await jsonRequest(h.app, 'POST', '/v1/agents/echo-agent/runs', {
        body: { input: 'x' },
        headers,
      })
    ).json();
    // SAME runId returned; the backend live path ran exactly ONCE (replay, not re-execute).
    expect(second.runId).toBe(first.runId);
    expect(backend.liveRuns).toBe(1);
  });

  it('B1: two CONCURRENT same-key+body POSTs → the agent executes EXACTLY ONCE (reserve-before-execute)', async () => {
    const { token } = await principal('idem-conc@example.com', 'IdemConcOrg');
    const headers = {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'idempotency-key': 'run-key-conc',
    };
    // Arm a leak-proof BARRIER gate: the WINNER (the one that wins the atomic reserve) reaches the gate
    // and blocks; `arrived` resolves the moment it does — a DETERMINISTIC signal (no fixed sleep) that
    // the winner is gated AND has held the in-flight window open. The gate has a hard auto-release cap
    // and is tracked for afterEach, so even if an assertion below fails the gated run can NEVER hang
    // and leak its pooled DB connection (the cascade-timeout failure mode).
    const { release, arrived } = backend.arm();

    const p1 = jsonRequest(h.app, 'POST', '/v1/agents/echo-agent/runs', {
      body: { input: 'conc' },
      headers,
    });
    const p2 = jsonRequest(h.app, 'POST', '/v1/agents/echo-agent/runs', {
      body: { input: 'conc' },
      headers,
    });

    // Wait until the winner has ARRIVED at the gate (it won the reserve; the loser — racing the SAME
    // single atomic reserve statement — has therefore already lost). This holds the run-in-flight
    // window open deterministically, so the loser MUST take the not-yet-reconstructable path.
    await arrived;
    // Now release the winner and collect both responses.
    release();
    const [r1, r2] = await Promise.all([p1, p2]);

    // The agent ran EXACTLY ONCE — the loser was prevented from executing (the core B1 guarantee that
    // reserve-before-execute provides; reserve atomicity is proven directly by the 50× stress test).
    expect(backend.liveRuns).toBe(1);

    const statuses = [r1.status, r2.status].sort();
    const bodies = await Promise.all([r1.json(), r2.json()]);
    // Both callers get a coherent answer: the winner a 200 RunResult; the loser EITHER a 200 replay of
    // the SAME run OR a clean 409 "in progress" — never a second, orphaned run with a different runId.
    const runIds = bodies.filter((b) => typeof b.runId === 'string').map((b) => b.runId);
    expect(runIds.length).toBeGreaterThanOrEqual(1);
    for (const id of runIds) expect(id).toBe(runIds[0]); // no duplicate/divergent runId
    expect(statuses.includes(200)).toBe(true); // at least one 200
    expect(statuses.every((s) => s === 200 || s === 409)).toBe(true);
    // Exactly one run header exists for this key's run.
    const runRows = await h.db.$client.unsafe('SELECT run_id FROM runs WHERE run_id = $1', [
      runIds[0],
    ]);
    expect(runRows.length).toBe(1);
  });

  it('B1 (stress): 50 CONCURRENT reserves on the SAME key → EXACTLY ONE wins, every time (atomicity)', async () => {
    const { orgId } = await principal('idem-stress@example.com', 'IdemStressOrg');
    // The reserve is a single INSERT ... ON CONFLICT DO NOTHING RETURNING — the UNIQUE(tenant,scope,key)
    // index lets EXACTLY ONE of N concurrent callers get a RETURNING row. Fire 50 at once on the same
    // key and assert exactly one win + 49 losses, and that all 49 losers see the SAME reserved snapshot
    // (the winner's runId) — no TOCTOU window, no double-win.
    const N = 50;
    const reservations = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        h.deps.idempotency.reserve(orgId, 'agent_run', 'stress-key', 'body-hash-x', {
          runId: `candidate-${i}`,
        }),
      ),
    );
    const wins = reservations.filter((r) => r.won);
    const losses = reservations.filter((r) => !r.won);
    expect(wins.length).toBe(1); // EXACTLY ONE win across 50 concurrent attempts
    expect(losses.length).toBe(N - 1);
    // Every loser sees the SAME committed reservation (one of the candidate runIds), never divergent.
    const loserRunIds = new Set(
      losses.map((r) => (r.existing?.snapshot as { runId?: string } | undefined)?.runId),
    );
    expect(loserRunIds.size).toBe(1);
    // Exactly one row physically exists.
    const rows = await h.db.$client.unsafe(
      "SELECT id FROM idempotency_keys WHERE scope = 'agent_run' AND idem_key = 'stress-key'",
    );
    expect(rows.length).toBe(1);
  });

  it('C3: the agent_run idempotency snapshot is EXACTLY { runId } — no finalText/output/secret', async () => {
    const { token } = await principal('idem-snap@example.com', 'IdemSnapOrg');
    const created = await (
      await jsonRequest(h.app, 'POST', '/v1/agents/echo-agent/runs', {
        body: { input: 'snapshot-me' },
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          'idempotency-key': 'snap-key',
        },
      })
    ).json();

    // The persisted reservation snapshot must carry ONLY { runId } (mirrors the apikey:mint
    // no-secrets regression): no finalText, no output, no secret — the column has no TTL.
    const rows = (await h.db.$client.unsafe(
      "SELECT snapshot FROM idempotency_keys WHERE scope = 'agent_run'",
    )) as unknown as { snapshot: Record<string, unknown> }[];
    expect(rows.length).toBe(1);
    expect(rows[0]?.snapshot).toEqual({ runId: created.runId });
  });

  it('same key + DIFFERENT body → 409 IDEMPOTENCY_CONFLICT', async () => {
    const { token } = await principal('idem2@example.com', 'Idem2Org');
    const headers = {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'idempotency-key': 'run-key-2',
    };
    await jsonRequest(h.app, 'POST', '/v1/agents/echo-agent/runs', {
      body: { input: 'a' },
      headers,
    });
    const conflict = await jsonRequest(h.app, 'POST', '/v1/agents/echo-agent/runs', {
      body: { input: 'DIFFERENT' },
      headers,
    });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('SSE: same key+body → REPLAYS the same run from seq 0 (run_started included), not re-executed', async () => {
    const { token } = await principal('idem-sse@example.com', 'IdemSseOrg');
    const headers = {
      authorization: `Bearer ${token}`,
      accept: 'text/event-stream',
      'content-type': 'application/json',
      'idempotency-key': 'sse-key-1',
    };
    const body = JSON.stringify({ input: 'sse-idem' });
    const first = await parseSse(
      await h.app.request('/v1/agents/echo-agent/runs', { method: 'POST', headers, body }),
    );
    expect(backend.liveRuns).toBe(1);
    const replay = await parseSse(
      await h.app.request('/v1/agents/echo-agent/runs', { method: 'POST', headers, body }),
    );
    // NOT re-executed (live path ran once); the replay includes seq 0 (run_started) — the -1 cursor.
    expect(backend.liveRuns).toBe(1);
    expect(replay[0]?.event).toBe('run_started');
    expect(replay[0]?.id).toBe('0');
    expect(replay.at(-1)?.event).toBe('run_completed');
    expect(replay.map((f) => f.id)).toEqual(first.map((f) => f.id));
  });
});

describe('POST /v1/agents/:id/runs (SSE)', () => {
  it('streams the run NeutralEvents in seq order with id: = seq; run_started…run_completed ordered', async () => {
    const { token } = await principal('sse@example.com', 'SseOrg');
    const res = await h.app.request('/v1/agents/echo-agent/runs', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ input: 'streamed' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const frames = await parseSse(res);
    // id: = seq, contiguous from 0; event: = type. First run_started, last run_completed.
    const ids = frames.map((f) => Number(f.id));
    expect(ids).toEqual(ids.slice().sort((a, b) => a - b)); // monotonic
    expect(ids[0]).toBe(0);
    expect(frames[0]?.event).toBe('run_started');
    expect(frames.at(-1)?.event).toBe('run_completed');
    const events = frames.map((f) => f.event);
    expect(events).toContain('tool_called');
    expect(events).toContain('tool_result');
    // Each frame's data is the JSON NeutralEvent with the matching seq.
    const parsed = frames.map((f) => JSON.parse(f.data));
    expect(parsed[0].type).toBe('run_started');
    expect(parsed.every((e, i) => e.seq === Number(frames[i]?.id))).toBe(true);
  });

  it('GET /runs/{id}/events?lastEventId=N replays ONLY seq > N (resume from the durable log)', async () => {
    const { token } = await principal('resume@example.com', 'ResumeOrg');
    // First run it (JSON) so run_events is durably populated.
    const result = await (
      await jsonRequest(h.app, 'POST', '/v1/agents/echo-agent/runs', {
        body: { input: 'resume-me' },
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      })
    ).json();
    const runId = result.runId as string;

    // Full replay (lastEventId omitted ⇒ from seq 0).
    const fullRes = await h.app.request(`/v1/runs/${runId}/events`, {
      headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
    });
    const full = await parseSse(fullRes);
    expect(full[0]?.event).toBe('run_started');
    expect(full.at(-1)?.event).toBe('run_completed');
    const maxSeq = Math.max(...full.map((f) => Number(f.id)));

    // Resume from seq 1 ⇒ only seq > 1 frames.
    const resumeRes = await h.app.request(`/v1/runs/${runId}/events?lastEventId=1`, {
      headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
    });
    const resumed = await parseSse(resumeRes);
    expect(resumed.every((f) => Number(f.id) > 1)).toBe(true);
    expect(resumed.length).toBe(full.length - 2); // dropped seq 0 and 1
    expect(Math.max(...resumed.map((f) => Number(f.id)))).toBe(maxSeq);

    // Resume via the Last-Event-ID header (the SSE reconnect mechanism) behaves identically.
    const headerResume = await h.app.request(`/v1/runs/${runId}/events`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'text/event-stream',
        'last-event-id': '1',
      },
    });
    const headerResumed = await parseSse(headerResume);
    expect(headerResumed.map((f) => f.id)).toEqual(resumed.map((f) => f.id));
  });

  it('C1: a POISONED run_events.data row (not a neutral event) is DROPPED on read (re-validate-on-read)', async () => {
    const { token } = await principal('poison@example.com', 'PoisonOrg');
    const result = await (
      await jsonRequest(h.app, 'POST', '/v1/agents/echo-agent/runs', {
        body: { input: 'poison-me' },
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      })
    ).json();
    const runId = result.runId as string;

    // The clean replay first (baseline) — every frame is a neutral event.
    const cleanRes = await h.app.request(`/v1/runs/${runId}/events`, {
      headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
    });
    const clean = await parseSse(cleanRes);
    const cleanSeqs = clean.map((f) => f.id);

    // Inject a POISONED row: valid jsonb but NOT a neutral NeutralEvent (e.g. a leaked secret blob),
    // at a high seq, under the SAME tenant + run. A verbatim-serve would expose it; re-validate drops it.
    const SECRET = 'leaked-non-neutral-secret-zzz';
    await h.db.$client.unsafe(
      `INSERT INTO run_events (run_id, tenant_id, seq, type, data)
       SELECT $1, tenant_id, 9999, 'text_delta', $2::jsonb FROM runs WHERE run_id = $1`,
      [runId, JSON.stringify({ not: 'a-neutral-event', secret: SECRET })],
    );

    // Re-read: the poisoned row must be ABSENT (dropped, fail-closed) — same frames as the clean read,
    // and the secret never appears in the served stream.
    const afterRes = await h.app.request(`/v1/runs/${runId}/events`, {
      headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
    });
    const afterText = await afterRes.text();
    expect(afterText).not.toContain(SECRET);
    expect(afterText).not.toContain('9999');
    const after = afterText
      .split('\n\n')
      .filter((b) => b.trim())
      .map((b) => {
        const id = b.split('\n').find((l) => l.startsWith('id:'));
        return id ? id.slice(3).trim() : '';
      });
    // The neutral frames still all serve; only the poisoned seq 9999 is dropped.
    expect(after).toEqual(cleanSeqs);
  });

  it('C4: a backend that THROWS mid-run ends the SSE with an event:error frame; run_events keeps what was persisted', async () => {
    const { token } = await principal('sse-err@example.com', 'SseErrOrg');
    // Make the SHARED backend throw mid-run via its gate (after run_started has emitted + persisted).
    backend.gate = () => Promise.reject(new Error('mid-run-explosion'));
    try {
      const res = await h.app.request('/v1/agents/echo-agent/runs', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'text/event-stream',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ input: 'will-throw' }),
      });
      const frames = await parseSse(res);
      // The stream ends with a terminal event:error frame (the run failed mid-stream).
      expect(frames.at(-1)?.event).toBe('error');
      // run_events still holds whatever was persisted BEFORE the throw (persist-before-flush durability
      // on the LIVE path) — at least run_started (seq 0), asserted at the route layer via a SELECT.
      const runStartedRows = await h.db.$client.unsafe(
        "SELECT seq::int AS seq FROM run_events WHERE type = 'run_started' ORDER BY seq LIMIT 1",
      );
      expect(runStartedRows.length).toBe(1);
      expect((runStartedRows[0] as { seq: number }).seq).toBe(0);
    } finally {
      backend.gate = undefined;
    }
  });
});

describe('GET /v1/runs/:id', () => {
  it('reconstructs the RunResult tenant-scoped (journal + conversation)', async () => {
    const { token } = await principal('get@example.com', 'GetOrg');
    const created = await (
      await jsonRequest(h.app, 'POST', '/v1/agents/echo-agent/runs', {
        body: { input: 'reconstruct' },
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      })
    ).json();
    const got = await jsonRequest(h.app, 'GET', `/v1/runs/${created.runId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(got.status).toBe(200);
    const result = await got.json();
    expect(result.runId).toBe(created.runId);
    expect(result.status).toBe('completed');
    expect(result.finalText).toBe('echo: reconstruct');
    // Conversation re-derived from the store (user + assistant turns), tenant-scoped.
    expect(result.conversation.length).toBeGreaterThanOrEqual(2);
    expect(result.stepCount).toBeGreaterThanOrEqual(1);
    expect(Object.hasOwn(result, 'output')).toBe(true);
    expect(Object.hasOwn(result, 'error')).toBe(true);
  });

  it('404 for an absent runId', async () => {
    const { token } = await principal('absent@example.com', 'AbsentOrg');
    const got = await jsonRequest(h.app, 'GET', '/v1/runs/no-such-run', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(got.status).toBe(404);
  });

  it('reconstructs an ERROR run — status:error + DERIVED error + neutral errorClass (from the failing journal step) + usage/cost/stepCount', async () => {
    const { token } = await principal('err-recon@example.com', 'ErrReconOrg');
    // The run returns status:'error' with a real adapter detail + a neutral class (rate_limited).
    // / REPLACES the old GENERICIZED GET error string: GET /v1/runs/{id} now DERIVES the
    // real preserved cause + errorClass from the failing journal step's output jsonb (the adapter wrote
    // { error, errorClass } there). The detail is surfaced to the OWNING tenant only — cross-tenant
    // isolation (a foreign runId → 404) is unchanged and is asserted by the cross-tenant suite below.
    const DETAIL = 'upstream throttled: 429 Too Many Requests';
    backend.errorDetail = DETAIL;
    backend.errorClass = 'rate_limited';
    const created = await (
      await jsonRequest(h.app, 'POST', '/v1/agents/echo-agent/runs', {
        body: { input: 'boom' },
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      })
    ).json();
    backend.errorDetail = undefined;
    backend.errorClass = 'internal';
    expect(created.status).toBe('error');

    const got = await jsonRequest(h.app, 'GET', `/v1/runs/${created.runId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    // GET is ALWAYS 200 (a durable re-read of a stored run — the status mapping is only for the live run).
    expect(got.status).toBe(200);
    const result = await got.json();

    // the DERIVED cause + neutral class are surfaced, not the old generic string.
    expect(result.status).toBe('error');
    expect(result.error).toBe(DETAIL);
    expect(result.errorClass).toBe('rate_limited');

    // usage / costUsd / stepCount are reconstructed from the REAL journal values.: the
    // journaled cost is RE-COMPUTED by run-core from the effective-dated pricing registry (the
    // single source of truth) — NOT the adapter's claimed 0.001. The error run journaled ONE
    // step (usage 7/3/10 on the echo-agent's model 'gpt-4.1-mini'), so the reconstructed cost is the
    // registry cost for that usage.
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 3, totalTokens: 10 });
    const expectedCost = computeCost('gpt-4.1-mini', { inputTokens: 7, outputTokens: 3 }).costUsd;
    expect(result.costUsd).toBe(expectedCost);
    expect(result.stepCount).toBe(1);
  });

  it('B2: an idempotent JSON replay body IS the same reconstruction GET /runs/{id} returns (self-consistent, no drift)', async () => {
    const { token } = await principal('replay-fidelity@example.com', 'ReplayFidelityOrg');
    const headers = {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'idempotency-key': 'replay-fidelity-key',
    };
    const first = await (
      await jsonRequest(h.app, 'POST', '/v1/agents/echo-agent/runs', {
        body: { input: 'reconstruct-me' },
        headers,
      })
    ).json();
    expect(backend.liveRuns).toBe(1);

    // The canonical reconstruction of this run (the journal-derived view GET returns).
    const canonical = await (
      await jsonRequest(h.app, 'GET', `/v1/runs/${first.runId}`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json();

    // Second same-key+body POST → the replayed JSON body is produced via the SAME reconstructRun path
    // (NOT a re-execution). It must be byte-for-byte the canonical reconstruction — self-consistent.
    const replay = await (
      await jsonRequest(h.app, 'POST', '/v1/agents/echo-agent/runs', {
        body: { input: 'reconstruct-me' },
        headers,
      })
    ).json();
    expect(backend.liveRuns).toBe(1);
    expect(replay.runId).toBe(first.runId);
    expect(replay).toEqual(canonical);
    expect(Object.hasOwn(replay, 'output')).toBe(true);
    expect(Object.hasOwn(replay, 'error')).toBe(true);
  });
});

describe('cross-tenant isolation (CI-BLOCKING for the runs surface)', () => {
  it('B cannot read A’s run via GET /runs/{id} (404, no leak)', async () => {
    const a = await principal('xt-a@example.com', 'XtAOrg');
    const b = await principal('xt-b@example.com', 'XtBOrg');
    const created = await (
      await jsonRequest(h.app, 'POST', '/v1/agents/echo-agent/runs', {
        body: { input: 'A-secret-input' },
        headers: { authorization: `Bearer ${a.token}`, accept: 'application/json' },
      })
    ).json();
    const runId = created.runId as string;

    // B (token scoped to orgB) reads A's runId → 404, no body leak.
    const bGet = await jsonRequest(h.app, 'GET', `/v1/runs/${runId}`, {
      headers: { authorization: `Bearer ${b.token}` },
    });
    expect(bGet.status).toBe(404);
    expect(JSON.stringify(await bGet.json())).not.toContain('A-secret-input');

    // B reads A's run events → 404 (no run_events leak).
    const bEvents = await h.app.request(`/v1/runs/${runId}/events`, {
      headers: { authorization: `Bearer ${b.token}`, accept: 'text/event-stream' },
    });
    expect(bEvents.status).toBe(404);

    // A can still read its own run (no collateral damage).
    const aGet = await jsonRequest(h.app, 'GET', `/v1/runs/${runId}`, {
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(aGet.status).toBe(200);
  });
});
