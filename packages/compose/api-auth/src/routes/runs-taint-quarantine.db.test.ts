/**
 * the NON-IDEMPOTENT-TAINT QUARANTINE contract test (the in-request surface).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE HAZARD THIS PROVES (RED-FIRST).
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * / shipped an in-request TRANSIENT-class idempotency-reservation RELEASE on the sync
 * run path (`runs.ts`): when a run fails with a transient `errorClass` (rate_limited / upstream_5xx /
 * timeout) the `agent_run` reservation is RELEASED so a same-Idempotency-Key client retry RE-RUNS
 * `runAgent` FRESH (`replay=false`). That is SAFE for an idempotent / no-tool run (the existing
 * runs.test.ts proves the safe-release case). It is UNSAFE for a run that already fired a NON-idempotent
 * (`idempotent:false`) tool (e.g. `charge_card`): the retry re-runs fresh, the `dispatch.ts` non-idempotent
 * guard only blocks on `replay===true`, so the side effect FIRES AGAIN — a double-charge.
 *
 * The QUARANTINE (this slice) makes the transient-release TAINT-AWARE: a run that has fired a
 * non-idempotent tool is marked (`idempotency_keys(scope='run_taint', key=runId)`) by the chokepoint
 * BEFORE the side effect; the transient-release consults the marker and does NOT release the reservation
 * for a tainted run, so a same-key retry is a no-op replay (the side effect fires EXACTLY ONCE).
 *
 * RED-FIRST DISCIPLINE: with the quarantine NOT wired into runs.ts, the second POST RE-RUNS and the
 * non-idempotent tool's side-effect counter reaches 2 — RED. With the quarantine wired it stays 1 — GREEN.
 * The companion safe-release test (an IDEMPOTENT-tool run still re-runs on a transient retry) guards
 * against OVER-quarantine (the fix must not freeze legitimately-retryable runs).
 *
 * Asserted as the WHOLE invariant (the side effect fires EXACTLY ONCE across the retry), not a shape.
 */

import type { NeutralTool } from '@rayspec/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRegistry, AgentRegistryEntry } from '../app-context.js';
import { FakeRunBackend } from '../test-support/fake-backend.js';
import { createHarness, type Harness, jsonRequest } from '../test-support/harness.js';

/**
 * A SIDE-EFFECT counter the non-idempotent tool's handler increments on every real fire — the ground
 * truth for "did the side effect happen twice?". Reset per test.
 */
const sideEffects = { count: 0 };

/** A NON-idempotent tool (a `charge_card`-shaped side effect). Its handler bumps the counter. */
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

/** An IDEMPOTENT tool (a safe read) — the over-quarantine guard's agent uses this. */
const lookupTool: NeutralTool = {
  spec: {
    name: 'lookup',
    description: 'a deterministic idempotent lookup',
    parameters: { type: 'object', properties: { q: { type: 'string' } } },
  },
  handler: (args) => {
    sideEffects.count += 1;
    return { found: (args as { q?: string }).q ?? '' };
  },
  timeoutMs: 1000,
  idempotent: true,
};

const backend = new FakeRunBackend();

const registry: AgentRegistry = new Map<string, AgentRegistryEntry>([
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
  [
    'lookup-agent',
    {
      spec: {
        name: 'looker',
        instructions: 'look up then maybe fail',
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

beforeAll(async () => {
  h = await createHarness({ agentRegistry: registry, schema: 'rayspec_test_apiauth_taint' });
});
beforeEach(async () => {
  await h.reset();
  backend.liveRuns = 0;
  backend.gate = undefined;
  backend.fireToolBeforeError = false;
  backend.errorDetail = undefined;
  backend.errorClass = 'internal';
  backend.retryAfterSeconds = undefined;
  sideEffects.count = 0;
});
afterEach(async () => {
  await backend.settle();
});
afterAll(async () => {
  await h.close();
});

describe('in-request transient-retry quarantine (JSON)', () => {
  it('a transient-failed run that FIRED a NON-idempotent tool is QUARANTINED — a same-key retry does NOT re-fire the side effect (fires EXACTLY ONCE)', async () => {
    const { token } = await principal('taintj@example.com', 'TaintJOrg');
    const headers = {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'idempotency-key': 'taint-transient-json',
    };
    // The run fires charge_card (the side effect + the run-taint marker), then returns a TRANSIENT
    // rate_limited error.
    backend.fireToolBeforeError = true;
    backend.errorDetail = 'rate limited after charging';
    backend.errorClass = 'rate_limited';

    const first = await jsonRequest(h.app, 'POST', '/v1/agents/charge-agent/runs', {
      body: { input: 'order-42' },
      headers,
    });
    expect(first.status).toBe(429);
    expect(backend.liveRuns).toBe(1);
    expect(sideEffects.count).toBe(1); // charged once

    // Same Idempotency-Key retry. WITHOUT the quarantine the transient-release frees the reservation →
    // the agent RE-RUNS fresh → charge_card fires AGAIN (count → 2, RED). WITH the quarantine the
    // tainted run keeps its reservation → the retry is a no-op replay → the side effect fires EXACTLY
    // ONCE (count stays 1, GREEN).
    const second = await jsonRequest(h.app, 'POST', '/v1/agents/charge-agent/runs', {
      body: { input: 'order-42' },
      headers,
    });
    // The WHOLE invariant: the non-idempotent side effect fired EXACTLY ONCE across the retry.
    expect(sideEffects.count).toBe(1);
    // The retry did NOT execute a second live run of the agent.
    expect(backend.liveRuns).toBe(1);
    // A quarantined retry is surfaced (not a silent success); it does not 2xx as if it re-ran cleanly.
    expect(second.status).not.toBe(200);
  });

  it('OVER-QUARANTINE GUARD: a transient-failed run with ONLY an IDEMPOTENT tool still RE-RUNS on a same-key retry (it is NOT quarantined)', async () => {
    const { token } = await principal('taintok@example.com', 'TaintOkOrg');
    const headers = {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'idempotency-key': 'taint-transient-idempotent',
    };
    // The run fires the IDEMPOTENT lookup tool (no taint marker), then returns a transient error.
    backend.fireToolBeforeError = true;
    backend.errorDetail = 'rate limited after a safe lookup';
    backend.errorClass = 'rate_limited';

    const first = await jsonRequest(h.app, 'POST', '/v1/agents/lookup-agent/runs', {
      body: { input: 'safe-1' },
      headers,
    });
    expect(first.status).toBe(429);
    expect(backend.liveRuns).toBe(1);
    expect(sideEffects.count).toBe(1);

    // An idempotent-only run is safely re-runnable: the transient-release frees the reservation and a
    // same-key retry RE-RUNS (liveRuns → 2). The quarantine must NOT freeze this legitimately-retryable
    // run (over-quarantine would break the shipped, correct transient-release for idempotent runs).
    const second = await jsonRequest(h.app, 'POST', '/v1/agents/lookup-agent/runs', {
      body: { input: 'safe-1' },
      headers,
    });
    expect(backend.liveRuns).toBe(2);
    expect(second.status).toBe(429);
  });
});

describe('in-request THROW-path quarantine (JSON) — a post-side-effect throw', () => {
  it('a run that FIRED a NON-idempotent tool then THREW (e.g. the persist write failed) is QUARANTINED — a same-key retry does NOT re-fire the side effect (fires EXACTLY ONCE)', async () => {
    const { token } = await principal('taintthrow@example.com', 'TaintThrowOrg');
    const headers = {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'idempotency-key': 'taint-throw-json',
    };
    // The run fires charge_card (the side effect + the run-taint marker) on the success path, THEN the
    // backend's gate REJECTS — modelling a throw AFTER the side effect fired. A completed, tool-firing,
    // billed run throwing from its post-completion output-persist write is the motivating instance:
    // runAgent throws → the JSON catch runs the reservation release. BEFORE the taint-aware throw-release
    // this was a BLANKET release (safe pre-persist, when a throw meant the run never completed); now it
    // must consult the taint marker so a tainted thrown run keeps its reservation.
    backend.gate = () =>
      Promise.reject(new Error('post-side-effect throw (e.g. persist write failed)'));

    const first = await jsonRequest(h.app, 'POST', '/v1/agents/charge-agent/runs', {
      body: { input: 'order-throw' },
      headers,
    });
    // The throw surfaces non-2xx (a generic 500); the side effect fired exactly once.
    expect(first.status).not.toBe(200);
    expect(backend.liveRuns).toBe(1);
    expect(sideEffects.count).toBe(1);

    // Clear the gate so a retry COULD complete cleanly — the ONLY thing that must stop a re-fire is the
    // taint-aware throw-release keeping the reservation on the tainted run.
    backend.gate = undefined;

    // Same Idempotency-Key retry. WITHOUT the taint-aware throw-release, the blanket release freed the
    // reservation → the agent RE-RUNS fresh → charge_card fires AGAIN (count → 2, RED). WITH it, the
    // tainted run keeps its reservation → the retry hits the loser path (the thrown run wrote no run
    // header → 409) → the side effect fires EXACTLY ONCE (count stays 1, GREEN).
    const second = await jsonRequest(h.app, 'POST', '/v1/agents/charge-agent/runs', {
      body: { input: 'order-throw' },
      headers,
    });
    // The WHOLE invariant: the non-idempotent side effect fired EXACTLY ONCE across the retry.
    expect(sideEffects.count).toBe(1);
    // The retry did NOT execute a second live run of the agent.
    expect(backend.liveRuns).toBe(1);
    // The quarantined thrown run is surfaced loudly (the loser path 409s a still-reserved, header-less run).
    expect(second.status).toBe(409);
  });

  it('OVER-QUARANTINE GUARD (throw path): an IDEMPOTENT-only run that THREW still RE-RUNS on a same-key retry (it is NOT quarantined)', async () => {
    const { token } = await principal('taintthrowok@example.com', 'TaintThrowOkOrg');
    const headers = {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'idempotency-key': 'taint-throw-idempotent',
    };
    // The run fires the IDEMPOTENT lookup tool (NO taint marker), then throws.
    backend.gate = () => Promise.reject(new Error('transient throw after a safe lookup'));
    const first = await jsonRequest(h.app, 'POST', '/v1/agents/lookup-agent/runs', {
      body: { input: 'safe-throw' },
      headers,
    });
    expect(first.status).not.toBe(200);
    expect(backend.liveRuns).toBe(1);
    expect(sideEffects.count).toBe(1);

    // With the gate cleared, an UNTAINTED thrown run is legitimately re-runnable: the taint-aware release
    // must NOT over-quarantine it — it releases, so the same-key retry RE-RUNS (liveRuns → 2). A wrong
    // fix that froze ALL thrown runs would keep this at 1 (RED); the shipped correct behaviour is a re-run.
    backend.gate = undefined;
    const second = await jsonRequest(h.app, 'POST', '/v1/agents/lookup-agent/runs', {
      body: { input: 'safe-throw' },
      headers,
    });
    expect(backend.liveRuns).toBe(2);
    expect(second.status).toBe(200);
  });
});

describe('in-request transient-retry quarantine (SSE)', () => {
  it('SSE: a transient-failed run that FIRED a NON-idempotent tool is QUARANTINED — a same-key SSE retry does NOT re-fire the side effect', async () => {
    const { token } = await principal('taintsse@example.com', 'TaintSseOrg');
    const headers = {
      authorization: `Bearer ${token}`,
      accept: 'text/event-stream',
      'content-type': 'application/json',
      'idempotency-key': 'taint-transient-sse',
    };
    const body = JSON.stringify({ input: 'order-sse' });
    backend.fireToolBeforeError = true;
    backend.errorDetail = 'rate limited after charging';
    backend.errorClass = 'rate_limited';

    // First SSE run: fires charge_card (taint), returns the transient error.
    const firstRes = await h.app.request('/v1/agents/charge-agent/runs', {
      method: 'POST',
      headers,
      body,
    });
    await firstRes.text();
    expect(backend.liveRuns).toBe(1);
    expect(sideEffects.count).toBe(1);

    // Same-key SSE retry. The shipped SSE transient-release (runs.ts:299-305) would re-run fresh →
    // charge_card fires again (count → 2, RED) unless it is taint-aware (count stays 1, GREEN).
    const secondRes = await h.app.request('/v1/agents/charge-agent/runs', {
      method: 'POST',
      headers,
      body,
    });
    await secondRes.text();
    expect(sideEffects.count).toBe(1);
    expect(backend.liveRuns).toBe(1);
  });
});
