/**
 * Declared-`api` route interpreter tests — DB-backed (real Postgres, isolated schema),
 * driving the THROWAWAY notebook backend's `api[]` through the REAL `createAuthApp` middleware chain.
 *
 * The platform stays PRODUCT-FREE: the `notebooks`/`entries` stores + their routes come from the
 * throwaway `examples/acme-notes-backend/rayspec.yaml`, materialized in a TEST FIXTURE (the harness'
 * `engineSpec` seam, mirroring how the cross-tenant gate feeds the throwaway).
 *
 * Asserts the REAL thing (fail-the-fix, not pass-the-shape):
 *  - store CRUD round-trip (create→get→update→delete) over a declared route, tenant-scoped;
 *  - CROSS-TENANT: org B cannot list/get/update/delete org A's rows (404/empty, no leak);
 *  - VALIDATION_ERROR (400) on a bad/unknown-field body; injected columns NOT client-settable;
 * the `{agent}` route reuses the run surface (a journaled run, RunResult shape);
 * `async:true` is FAIL-CLOSED-REJECTED (501);
 * the `{handler}` seam is a clean 501 (scope), not a silent 500;
 *  - A3 (headline): `current_setting('app.current_tenant')` equals the request tenant INSIDE the
 *    route-handler's OWN transaction — read back via the real tx (no proxy/blind assertion).
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Db, TENANT_GUC } from '@rayspec/db';
import type { DurableExecutor, EnqueueResult, RunJob } from '@rayspec/platform';
import { parseSpec, type RaySpec } from '@rayspec/spec';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRegistry, AgentRegistryEntry } from '../app-context.js';
import { FakeRunBackend } from '../test-support/fake-backend.js';
import { createHarness, type Harness, jsonRequest } from '../test-support/harness.js';
import { STORE_LIST_LIMIT } from './store-routes.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
// un-skippable ran-guard: this DB-backed suite carries the CROSS-TENANT (CI-blocking) route isolation
// + the {handler}-route boot-fail SECURITY assertions — it must never silently self-skip to a false
// green. When the DB is REQUIRED but absent, hard-fail at collection. For a local dev with no Postgres
// (no CI, no opt-in) the whole file skips cleanly via `describeDb` — never a vacuous pass, never a crash.
if (requireDb && !hasDb) {
  throw new Error(
    'declared-routes.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — ' +
      'refusing to silently skip a security-load-bearing suite.',
  );
}
const describeDb = hasDb ? describe : describe.skip;

// --- the throwaway spec (the test subject; product-free platform) ----------------------------
const here = dirname(fileURLToPath(import.meta.url));
// packages/api-auth/src/engine -> repo-root/examples/acme-notes-backend
const YAML_PATH = resolve(here, '../../../../../examples/acme-notes-backend/rayspec.yaml');

function loadThrowawaySpec(): RaySpec {
  const parsed = parseSpec(readFileSync(YAML_PATH, 'utf8'));
  if (!parsed.ok) throw new Error(`throwaway spec invalid: ${JSON.stringify(parsed.errors)}`);
  return parsed.value;
}

// The proven deterministic backend (journals via ctx.journal + drives run-core's persist pipeline,
// so a declared {agent} route REALLY journals a run header — ground truth, not a hand-rolled shape).
const summarizerBackend = new FakeRunBackend();

/** The agent registry the declared `{agent}` route resolves `summarizer` against. */
const agentRegistry: AgentRegistry = new Map<string, AgentRegistryEntry>([
  [
    'summarizer',
    {
      spec: {
        name: 'note-summarizer',
        instructions: 'summarize',
        model: 'gpt-4o-mini',
        input: '',
        tools: [],
        maxTurns: 6,
      },
      backend: summarizerBackend,
    },
  ],
]);

/**
 * A minimal in-memory STUB DurableExecutor (NO DBOS): records every enqueued (tenantId, job) so a test
 * can assert the neutral RunJob payload an async declared-route run enqueues. It does NOT run runAgent
 * (the off-request execution is proven against the REAL DBOS engine in @rayspec/durable-dbos).
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
}

let h: Harness;
let spec: RaySpec;

/** Provision a principal (register → org → switch → JWT) with the member role (store:read/write). */
async function principal(
  email: string,
  orgName: string,
): Promise<{ orgId: string; token: string }> {
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

/** Mint an org-scoped api-key (the owner of `orgId` mints it) with the given scopes; returns mk_… */
async function mintApiKey(orgId: string, ownerToken: string, scopes: string[]): Promise<string> {
  const res = await jsonRequest(h.app, 'POST', `/v1/orgs/${orgId}/api-keys`, {
    body: { name: 'test-key', scopes },
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  if (res.status !== 201) {
    throw new Error(`api-key mint failed: ${res.status} ${JSON.stringify(await res.json())}`);
  }
  return (await res.json()).plaintext as string;
}

beforeAll(async () => {
  if (!hasDb) return; // local dev with no Postgres → the whole file skips via describeDb; no harness.
  spec = loadThrowawaySpec();
  h = await createHarness({
    engineSpec: spec,
    agentRegistry,
    schema: 'rayspec_test_apiauth_declroutes',
  });
});
beforeEach(async () => {
  if (!hasDb) return;
  await h.reset();
  summarizerBackend.liveRuns = 0;
});
afterEach(async () => {
  if (!hasDb) return;
  await summarizerBackend.settle();
});
afterAll(async () => {
  if (!hasDb) return;
  await h.close();
});

describeDb('declared store routes — CRUD round-trip (tenant-scoped)', () => {
  it('create → get → update → delete over declared {store} routes', async () => {
    const { token } = await principal('crud@example.com', 'CrudOrg');
    const auth = { authorization: `Bearer ${token}` };

    // CREATE (POST /notebooks) — only business columns; server-controlled columns are injected.
    const created = await jsonRequest(h.app, 'POST', '/notebooks', {
      body: { title: 'Sprint planning', scheduledAt: '2026-07-01T09:00:00Z', completed: false },
      headers: auth,
    });
    expect(created.status).toBe(201);
    const notebook = await created.json();
    expect(notebook.title).toBe('Sprint planning');
    expect(notebook.completed).toBe(false);
    // Injected columns are present + server-set (snake_case wire shape).
    expect(typeof notebook.id).toBe('string');
    expect(notebook.region).toBe('eu');
    expect(notebook.created_at).toBeTruthy();
    const id = notebook.id as string;

    // GET (GET /notebooks/{id}).
    const got = await jsonRequest(h.app, 'GET', `/notebooks/${id}`, { headers: auth });
    expect(got.status).toBe(200);
    expect((await got.json()).id).toBe(id);

    // LIST (GET /notebooks) — tenant-scoped, sees exactly the one row.
    const listed = await jsonRequest(h.app, 'GET', '/notebooks', { headers: auth });
    expect(listed.status).toBe(200);
    const rows = await listed.json();
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(id);

    // UPDATE (PATCH /notebooks/{id}).
    const updated = await jsonRequest(h.app, 'PATCH', `/notebooks/${id}`, {
      body: { completed: true, subtitle: 'Room 4' },
      headers: auth,
    });
    expect(updated.status).toBe(200);
    const after = await updated.json();
    expect(after.completed).toBe(true);
    expect(after.subtitle).toBe('Room 4');

    // DELETE (DELETE /notebooks/{id}) → 204, then GET → 404.
    const del = await jsonRequest(h.app, 'DELETE', `/notebooks/${id}`, { headers: auth });
    expect(del.status).toBe(204);
    const gone = await jsonRequest(h.app, 'GET', `/notebooks/${id}`, { headers: auth });
    expect(gone.status).toBe(404);
  });
});

describeDb('declared store routes — cross-tenant isolation (CI-BLOCKING)', () => {
  it('org B cannot list/get/update/delete org A rows via the declared routes (404/empty, no leak)', async () => {
    const a = await principal('xt-store-a@example.com', 'XtStoreA');
    const b = await principal('xt-store-b@example.com', 'XtStoreB');
    const A_SECRET_TITLE = 'A-confidential-board-note';

    const created = await jsonRequest(h.app, 'POST', '/notebooks', {
      body: { title: A_SECRET_TITLE, scheduledAt: '2026-07-02T10:00:00Z', completed: false },
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(created.status).toBe(201);
    const id = (await created.json()).id as string;

    const bAuth = { authorization: `Bearer ${b.token}` };

    // B lists — sees NONE of A's rows (tenant predicate).
    const bList = await jsonRequest(h.app, 'GET', '/notebooks', { headers: bAuth });
    expect(bList.status).toBe(200);
    const bRows = await bList.json();
    expect(bRows).toHaveLength(0);
    expect(JSON.stringify(bRows)).not.toContain(A_SECRET_TITLE);

    // B GETs A's id — 404 (no existence leak, no title leak).
    const bGet = await jsonRequest(h.app, 'GET', `/notebooks/${id}`, { headers: bAuth });
    expect(bGet.status).toBe(404);
    expect(JSON.stringify(await bGet.json())).not.toContain(A_SECRET_TITLE);

    // B UPDATEs A's id — 404, and A's row is UNCHANGED.
    const bUpd = await jsonRequest(h.app, 'PATCH', `/notebooks/${id}`, {
      body: { title: 'hacked-by-B' },
      headers: bAuth,
    });
    expect(bUpd.status).toBe(404);

    // B DELETEs A's id — 404, A's row still present for A.
    const bDel = await jsonRequest(h.app, 'DELETE', `/notebooks/${id}`, { headers: bAuth });
    expect(bDel.status).toBe(404);

    // A still sees its unchanged row (no collateral damage).
    const aGet = await jsonRequest(h.app, 'GET', `/notebooks/${id}`, {
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(aGet.status).toBe(200);
    expect((await aGet.json()).title).toBe(A_SECRET_TITLE);
  });
});

describeDb('declared store routes — request validation (fail-closed)', () => {
  it('a missing required field → VALIDATION_ERROR (400)', async () => {
    const { token } = await principal('val-missing@example.com', 'ValMissing');
    // `title`, `scheduledAt`, `completed` are non-nullable required columns; omit them.
    const res = await jsonRequest(h.app, 'POST', '/notebooks', {
      body: { subtitle: 'Room 1' },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR');
  });

  it('an UNKNOWN field → VALIDATION_ERROR (strict) — no silent passthrough', async () => {
    const { token } = await principal('val-unknown@example.com', 'ValUnknown');
    const res = await jsonRequest(h.app, 'POST', '/notebooks', {
      body: { title: 'X', scheduledAt: '2026-07-01T09:00:00Z', completed: false, bogus: 1 },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR');
  });

  it('a server-controlled INJECTED column (id/tenant_id) is NOT client-settable (strict rejects it)', async () => {
    const { token } = await principal('val-injected@example.com', 'ValInjected');
    const attackTenant = '00000000-0000-0000-0000-0000000000ff';
    const res = await jsonRequest(h.app, 'POST', '/notebooks', {
      body: {
        title: 'X',
        scheduledAt: '2026-07-01T09:00:00Z',
        completed: false,
        tenant_id: attackTenant,
        id: '00000000-0000-0000-0000-0000000000aa',
      },
      headers: { authorization: `Bearer ${token}` },
    });
    // Strict body schema rejects the injected keys — a client can NEVER set its own tenant_id/id.
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR');
  });

  it('a bad-typed field (boolean as string) → VALIDATION_ERROR', async () => {
    const { token } = await principal('val-type@example.com', 'ValType');
    const res = await jsonRequest(h.app, 'POST', '/notebooks', {
      body: { title: 'X', scheduledAt: '2026-07-01T09:00:00Z', completed: 'nope' },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR');
  });

  it('an EMPTY PATCH body ({}) → VALIDATION_ERROR (400); the row is unchanged', async () => {
    const { token } = await principal('val-empty-patch@example.com', 'ValEmptyPatch');
    const auth = { authorization: `Bearer ${token}` };
    const created = await jsonRequest(h.app, 'POST', '/notebooks', {
      body: { title: 'Unchanged', scheduledAt: '2026-07-08T09:00:00Z', completed: false },
      headers: auth,
    });
    const id = (await created.json()).id as string;

    // {} → no fields to set → VALIDATION_ERROR (not a silent no-op success).
    const empty = await jsonRequest(h.app, 'PATCH', `/notebooks/${id}`, {
      body: {},
      headers: auth,
    });
    expect(empty.status).toBe(400);
    expect((await empty.json()).error.code).toBe('VALIDATION_ERROR');

    // ONLY-unknown-keys → strict rejects them, leaving no valid field → VALIDATION_ERROR.
    const onlyUnknown = await jsonRequest(h.app, 'PATCH', `/notebooks/${id}`, {
      body: { bogus: 1, nope: 'x' },
      headers: auth,
    });
    expect(onlyUnknown.status).toBe(400);
    expect((await onlyUnknown.json()).error.code).toBe('VALIDATION_ERROR');

    // The row is unchanged by either rejected PATCH.
    const got = await jsonRequest(h.app, 'GET', `/notebooks/${id}`, { headers: auth });
    const row = await got.json();
    expect(row.title).toBe('Unchanged');
    expect(row.completed).toBe(false);
  });
});

describeDb('declared store routes — non-uuid {id} is a uniform 404 (never a 500)', () => {
  it('a malformed (non-uuid) id on get/update/delete → 404 (same as an absent row)', async () => {
    const { token } = await principal('nonuuid@example.com', 'NonUuidOrg');
    const auth = { authorization: `Bearer ${token}` };
    const bad = 'not-a-uuid';

    const got = await jsonRequest(h.app, 'GET', `/notebooks/${bad}`, { headers: auth });
    expect(got.status).toBe(404);
    expect((await got.json()).error.code).toBe('NOT_FOUND');

    const upd = await jsonRequest(h.app, 'PATCH', `/notebooks/${bad}`, {
      body: { completed: true },
      headers: auth,
    });
    expect(upd.status).toBe(404);
    expect((await upd.json()).error.code).toBe('NOT_FOUND');

    const del = await jsonRequest(h.app, 'DELETE', `/notebooks/${bad}`, { headers: auth });
    expect(del.status).toBe(404);
    expect((await del.json()).error.code).toBe('NOT_FOUND');

    // A well-formed-but-absent uuid is the SAME uniform 404 (no observable difference).
    const absent = '00000000-0000-0000-0000-0000000000aa';
    const absentGet = await jsonRequest(h.app, 'GET', `/notebooks/${absent}`, { headers: auth });
    expect(absentGet.status).toBe(404);
    expect((await absentGet.json()).error.code).toBe('NOT_FOUND');
  });
});

describeDb('declared store routes — list cap honesty (X-Result-Truncated)', () => {
  it('a full page (rows === STORE_LIST_LIMIT) signals X-Result-Truncated: true; a short page does not', async () => {
    const { token } = await principal('truncate@example.com', 'TruncateOrg');
    const auth = { authorization: `Bearer ${token}` };

    // A small list (under the cap) → no truncation signal.
    await jsonRequest(h.app, 'POST', '/notebooks', {
      body: { title: 'one', scheduledAt: '2026-07-09T09:00:00Z', completed: false },
      headers: auth,
    });
    const small = await jsonRequest(h.app, 'GET', '/notebooks', { headers: auth });
    expect(small.status).toBe(200);
    expect(small.headers.get('X-Result-Truncated')).toBeNull();
    expect((await small.json()).length).toBe(1);

    // Fill exactly STORE_LIST_LIMIT rows → the page hits the cap → truncation signal present.
    // (We import the cap so the test tracks the real constant.)
    const inserts: Promise<Response>[] = [];
    for (let i = 1; i < STORE_LIST_LIMIT; i++) {
      inserts.push(
        jsonRequest(h.app, 'POST', '/notebooks', {
          body: { title: `m${i}`, scheduledAt: '2026-07-09T09:00:00Z', completed: false },
          headers: auth,
        }),
      );
    }
    await Promise.all(inserts);

    const full = await jsonRequest(h.app, 'GET', '/notebooks', { headers: auth });
    expect(full.status).toBe(200);
    expect((await full.json()).length).toBe(STORE_LIST_LIMIT);
    expect(full.headers.get('X-Result-Truncated')).toBe('true');
  });
});

describeDb(
  'declared store routes — store:write live-membership revocation closes the bypass',
  () => {
    it('a JWT user with store:write creates OK, then membership is revoked out-of-band → next write 403', async () => {
      // store:write is SENSITIVE: a mutation re-checks LIVE membership (never the stale JWT claim). A
      // user with a still-valid JWT whose membership was revoked must be denied every subsequent write.
      const { orgId, token } = await principal(
        'storewrite-revoke@example.com',
        'StoreWriteRevokeOrg',
      );
      const auth = { authorization: `Bearer ${token}` };

      // The live (member-role) user can create.
      const created = await jsonRequest(h.app, 'POST', '/notebooks', {
        body: { title: 'before-revoke', scheduledAt: '2026-07-10T09:00:00Z', completed: false },
        headers: auth,
      });
      expect(created.status).toBe(201);
      const id = (await created.json()).id as string;

      // Out-of-band: revoke the user's membership (an admin removed them). The JWT is STILL VALID.
      await h.db.$client.unsafe(
        `UPDATE rayspec_test_apiauth_declroutes.memberships SET status = 'revoked' WHERE org_id = $1`,
        [orgId],
      );

      // Every subsequent store:write (create/update/delete) on the SAME still-valid JWT → 403 (the live
      // recheck denies the revoked principal — the revocation-bypass-on-write hole is closed).
      const create2 = await jsonRequest(h.app, 'POST', '/notebooks', {
        body: { title: 'after-revoke', scheduledAt: '2026-07-10T10:00:00Z', completed: false },
        headers: auth,
      });
      expect(create2.status).toBe(403);
      const upd = await jsonRequest(h.app, 'PATCH', `/notebooks/${id}`, {
        body: { completed: true },
        headers: auth,
      });
      expect(upd.status).toBe(403);
      const del = await jsonRequest(h.app, 'DELETE', `/notebooks/${id}`, { headers: auth });
      expect(del.status).toBe(403);
    });
  },
);

describeDb('declared {agent} route — reuses the run surface', () => {
  it('POST /notebooks/{id}/summarize runs the declared agent (JSON RunResult, journaled)', async () => {
    const { token } = await principal('agent-route@example.com', 'AgentRouteOrg');
    const auth = { authorization: `Bearer ${token}`, accept: 'application/json' };

    // Create a notebook to summarize (the {id} is a path param; the run input is the body).
    const created = await jsonRequest(h.app, 'POST', '/notebooks', {
      body: { title: 'Retro', scheduledAt: '2026-07-03T11:00:00Z', completed: true },
      headers: { authorization: `Bearer ${token}` },
    });
    const id = (await created.json()).id as string;

    const res = await jsonRequest(h.app, 'POST', `/notebooks/${id}/summarize`, {
      body: { input: 'the note text' },
      headers: auth,
    });
    expect(res.status).toBe(200);
    const result = await res.json();
    expect(result.status).toBe('completed');
    // (path-param binding — FAIL-THE-FIX): the route's `{id}` param is now BOUND into the run
    // input as a trusted, clearly-delimited `Route parameters:` block PREPENDED before `body.input`.
    // The value is JSON-escaped (quoted) so a request-derived value can never break the framing.
    // The fake backend echoes `spec.input` into finalText, so the param value + the body BOTH appear —
    // proving the param reached the run. RED-first: WITHOUT the binding the finalText would be exactly
    // `echo: the note text` (the param absent), so this assertion fails if the binding regresses.
    expect(result.finalText).toBe(
      `echo: Route parameters:\n  id: ${JSON.stringify(id)}\n\nthe note text`,
    );
    // The bound input still ENDS WITH the original body.input verbatim (the body flows in unchanged).
    expect(result.finalText.endsWith('the note text')).toBe(true);
    expect(result.backend).toBe('openai');
    expect(summarizerBackend.liveRuns).toBe(1);

    // The run was journaled (a run header exists for this tenant).
    const runRows = await h.db.$client.unsafe('SELECT run_id FROM runs WHERE run_id = $1', [
      result.runId,
    ]);
    expect(runRows.length).toBe(1);
  });

  it('the path param REACHES the run for two DIFFERENT ids (distinct bound input → distinct runs)', async () => {
    // two calls to the SAME declared agent route with DIFFERENT `{id}` values produce DIFFERENT
    // bound inputs — each run echoes ITS OWN id, proving the param reached the run. RED-first: without
    // the binding both would echo `echo: same body` (the id absent).
    const { token } = await principal('agent-param-vary@example.com', 'AgentParamVaryOrg');
    const auth = { authorization: `Bearer ${token}`, accept: 'application/json' };
    const mk = async (title: string): Promise<string> =>
      (
        await (
          await jsonRequest(h.app, 'POST', '/notebooks', {
            body: { title, scheduledAt: '2026-07-12T09:00:00Z', completed: false },
            headers: { authorization: `Bearer ${token}` },
          })
        ).json()
      ).id as string;
    const idA = await mk('A');
    const idB = await mk('B');

    const ra = await jsonRequest(h.app, 'POST', `/notebooks/${idA}/summarize`, {
      body: { input: 'same body' },
      headers: auth,
    });
    const rb = await jsonRequest(h.app, 'POST', `/notebooks/${idB}/summarize`, {
      body: { input: 'same body' },
      headers: auth,
    });
    const resultA = await ra.json();
    const resultB = await rb.json();
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    // Each run's bound input carries ITS OWN id — the param reached the run (JSON-escaped value).
    expect(resultA.finalText).toContain(`id: ${JSON.stringify(idA)}`);
    expect(resultB.finalText).toContain(`id: ${JSON.stringify(idB)}`);
    expect(resultA.finalText).not.toContain(`id: ${JSON.stringify(idB)}`);
    // Two distinct runs.
    expect(resultA.runId).not.toBe(resultB.runId);
    expect(summarizerBackend.liveRuns).toBe(2);
  });

  it('the idempotency body-hash incorporates the BOUND path param (same key + same body, different {id} → 409)', async () => {
    // because the body-hash covers the route-param-BOUND input, a same-Idempotency-Key reuse
    // across two DIFFERENT path params is a body MISMATCH → IDEMPOTENCY_CONFLICT (409), NOT a silent
    // replay of the first run for the second id (which would have happened if the hash ignored the
    // param). RED-first: without the param in the hash, the second call would 200-replay the first
    // run's result (carrying idA) under idB — a cross-resource idempotency bug.
    const { token } = await principal('agent-param-idem@example.com', 'AgentParamIdemOrg');
    const auth = { authorization: `Bearer ${token}`, accept: 'application/json' };
    const mk = async (title: string): Promise<string> =>
      (
        await (
          await jsonRequest(h.app, 'POST', '/notebooks', {
            body: { title, scheduledAt: '2026-07-13T09:00:00Z', completed: false },
            headers: { authorization: `Bearer ${token}` },
          })
        ).json()
      ).id as string;
    const idA = await mk('A');
    const idB = await mk('B');
    const idem = { ...auth, 'idempotency-key': 'k-shared' };

    // First call under idA wins the reservation + runs.
    const ra = await jsonRequest(h.app, 'POST', `/notebooks/${idA}/summarize`, {
      body: { input: 'same body' },
      headers: idem,
    });
    expect(ra.status).toBe(200);
    expect((await ra.json()).finalText).toContain(`id: ${JSON.stringify(idA)}`);

    // Second call: SAME key, SAME body string, DIFFERENT {id} → the bound input differs → the hash
    // differs → a clean 409 conflict (never a replay of idA's result under idB).
    const rb = await jsonRequest(h.app, 'POST', `/notebooks/${idB}/summarize`, {
      body: { input: 'same body' },
      headers: idem,
    });
    expect(rb.status).toBe(409);
    expect((await rb.json()).error.code).toBe('IDEMPOTENCY_CONFLICT');
    // Only ONE run executed (the second was rejected before any run).
    expect(summarizerBackend.liveRuns).toBe(1);

    // And a same-key, SAME-{id}, same-body repeat REPLAYS idA's run (the dedup path still works).
    const raAgain = await jsonRequest(h.app, 'POST', `/notebooks/${idA}/summarize`, {
      body: { input: 'same body' },
      headers: idem,
    });
    expect(raAgain.status).toBe(200);
    expect((await raAgain.json()).finalText).toContain(`id: ${JSON.stringify(idA)}`);
    expect(summarizerBackend.liveRuns).toBe(1); // replayed, not re-run
  });

  it('async:true on a declared {agent} route is FAIL-CLOSED-REJECTED (501)', async () => {
    const { token } = await principal('agent-async@example.com', 'AgentAsyncOrg');
    const created = await jsonRequest(h.app, 'POST', '/notebooks', {
      body: { title: 'Async', scheduledAt: '2026-07-04T12:00:00Z', completed: false },
      headers: { authorization: `Bearer ${token}` },
    });
    const id = (await created.json()).id as string;

    const res = await jsonRequest(h.app, 'POST', `/notebooks/${id}/summarize`, {
      body: { input: 'x', async: true },
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    expect(res.status).toBe(501);
    expect((await res.json()).error.code).toBe('NOT_IMPLEMENTED');
    // The agent NEVER executed (fail-closed before any run).
    expect(summarizerBackend.liveRuns).toBe(0);
  });

  it('async:true on a declared {agent} route ENQUEUES the route-param-BOUND input (fail-the-fix)', async () => {
    // when a durable worker IS wired, an async declared-route run must enqueue the SAME bound
    // input the sync path runs (the `{id}` param reaches the off-request run too). RED-first: the
    // pre-fix async path enqueued `body.input` (the RAW input), dropping the route params — so the
    // enqueued job.input would be exactly `summarize async` (NO `Route parameters:` block), failing the
    // assertion below. The sync path used effectiveInput; this proves the async path now matches it.
    const stub = new StubExecutor();
    h.deps.durableExecutor = stub;
    try {
      const { token } = await principal('agent-async-bound@example.com', 'AgentAsyncBoundOrg');
      const created = await jsonRequest(h.app, 'POST', '/notebooks', {
        body: { title: 'AsyncBound', scheduledAt: '2026-07-14T12:00:00Z', completed: false },
        headers: { authorization: `Bearer ${token}` },
      });
      const id = (await created.json()).id as string;

      const res = await jsonRequest(h.app, 'POST', `/notebooks/${id}/summarize`, {
        body: { input: 'summarize async', async: true },
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      });
      expect(res.status).toBe(202);
      const accepted = await res.json();
      expect(accepted.status).toBe('enqueued');
      // EXACTLY ONE job enqueued, and its input is the ROUTE-PARAM-BOUND input (the `{id}` block is
      // prepended, JSON-escaped), NOT the raw body.input — proving the param reached the async run.
      expect(stub.enqueued).toHaveLength(1);
      const { job } = stub.enqueued[0]!;
      expect(job.runId).toBe(accepted.runId);
      expect(job.agentId).toBe('summarizer');
      expect(job.input).toBe(`Route parameters:\n  id: ${JSON.stringify(id)}\n\nsummarize async`);
      // The agent did NOT run in-request (async enqueue, not a synchronous fallback).
      expect(summarizerBackend.liveRuns).toBe(0);
    } finally {
      // Restore the default (no executor wired) so the fail-closed 501 test stays order-independent.
      h.deps.durableExecutor = undefined;
    }
  });
});

describeDb('declared routes — OpenAPI doc-emission at GET /v1/openapi.json', () => {
  it('the served document CONTAINS every declared route (method + path + params + a schema)', async () => {
    // (FAIL-THE-FIX): the served OpenAPI document must include the declared `api[]` routes. The
    // throwaway exercises {store} (5 ops) + an {agent} route. RED-first: a declared route NOT emitted
    // is absent from `paths`, so each of these assertions fails if the emission regresses.
    const res = await jsonRequest(h.app, 'GET', '/v1/openapi.json', {});
    expect(res.status).toBe(200);
    const doc = await res.json();
    expect(doc.openapi).toBe('3.1.0');
    // The info is DERIVED from the spec metadata (not hard-coded), proving product-agnostic emission.
    expect(doc.info.title).toBe(spec.metadata.name);
    expect(doc.info.version).toBe('1.0');

    // Every declared route appears under its declared OpenAPI-form path + lowercase method.
    for (const route of spec.api) {
      const item = doc.paths[route.path];
      expect(item, `path ${route.path} missing from doc`).toBeTruthy();
      const op = item[route.method.toLowerCase()];
      expect(op, `operation ${route.method} ${route.path} missing`).toBeTruthy();
      expect(typeof op.summary).toBe('string');
      // A path with a `{param}` must list it as a required path parameter.
      const declaredParams = (route.path.match(/\{([^}/]+)\}/g) ?? []).map((s) => s.slice(1, -1));
      if (declaredParams.length > 0) {
        const paramNames = (op.parameters ?? []).map((p: { name: string }) => p.name);
        for (const name of declaredParams) expect(paramNames).toContain(name);
      }
    }

    // The {store} CREATE route derives its request body from the StoreSpec columns (a declared
    // business column is present; the injected/server-controlled columns are NOT in the request body).
    const createOp = doc.paths['/notebooks'].post;
    const createProps = createOp.requestBody.content['application/json'].schema.properties;
    expect(Object.keys(createProps)).toContain('title');
    expect(createProps.tenant_id).toBeUndefined();
    expect(createProps.id).toBeUndefined();

    // The {store} GET route's 200 response row schema EXPOSES the injected columns (the wire shape).
    const getOp = doc.paths['/notebooks/{id}'].get;
    const rowProps = getOp.responses['200'].content['application/json'].schema.properties;
    expect(Object.keys(rowProps)).toContain('id');
    expect(Object.keys(rowProps)).toContain('tenant_id');
    expect(Object.keys(rowProps)).toContain('title');

    // The {agent} route documents the StartRunRequest body (the run surface's real contract).
    const agentOp = doc.paths['/notebooks/{id}/summarize'].post;
    const agentProps = agentOp.requestBody.content['application/json'].schema.properties;
    expect(Object.keys(agentProps)).toContain('input');
  });

  it('the openapi.json read is PUBLIC (no auth required) and lists the agent route params', async () => {
    // No Authorization header — the structural doc is a public, non-sensitive read.
    const res = await jsonRequest(h.app, 'GET', '/v1/openapi.json', {});
    expect(res.status).toBe(200);
    const doc = await res.json();
    const agentParams = (doc.paths['/notebooks/{id}/summarize'].post.parameters ?? []).map(
      (p: { name: string; in: string; required: boolean }) => p,
    );
    expect(agentParams).toContainEqual(
      expect.objectContaining({ name: 'id', in: 'path', required: true }),
    );
  });
});

describeDb('declared store routes — api-key principal (programmatic/agency consumer)', () => {
  it('an api-key WITH store:write scope can CREATE; with only store:read it is FORBIDDEN on write but can LIST', async () => {
    // The owner mints two org-scoped api-keys: one with store:read+store:write, one read-only.
    const { orgId, token } = await principal('apikey-store@example.com', 'ApiKeyStoreOrg');
    const writeKey = await mintApiKey(orgId, token, ['store:read', 'store:write']);
    const readKey = await mintApiKey(orgId, token, ['store:read']);

    // store:write api-key CAN create (the sensitive branch falls api-keys through to authorize();
    // the KEY is the live credential, the scope grants it). This is the headline PM correction.
    const created = await jsonRequest(h.app, 'POST', '/notebooks', {
      body: { title: 'Via-API-key', scheduledAt: '2026-07-07T09:00:00Z', completed: false },
      headers: { authorization: `Bearer ${writeKey}` },
    });
    expect(created.status).toBe(201);
    const id = (await created.json()).id as string;

    // read-only api-key is FORBIDDEN on create (403) — no store:write scope.
    const forbiddenCreate = await jsonRequest(h.app, 'POST', '/notebooks', {
      body: { title: 'NoWriteScope', scheduledAt: '2026-07-07T10:00:00Z', completed: false },
      headers: { authorization: `Bearer ${readKey}` },
    });
    expect(forbiddenCreate.status).toBe(403);

    // read-only api-key CAN list (store:read scope) and sees the row the write-key created (same org).
    const listed = await jsonRequest(h.app, 'GET', '/notebooks', {
      headers: { authorization: `Bearer ${readKey}` },
    });
    expect(listed.status).toBe(200);
    const rows = await listed.json();
    expect(rows.map((r: { id: string }) => r.id)).toContain(id);

    // read-only api-key is FORBIDDEN on update + delete (403) — fail-closed on every mutation.
    const upd = await jsonRequest(h.app, 'PATCH', `/notebooks/${id}`, {
      body: { completed: true },
      headers: { authorization: `Bearer ${readKey}` },
    });
    expect(upd.status).toBe(403);
    const del = await jsonRequest(h.app, 'DELETE', `/notebooks/${id}`, {
      headers: { authorization: `Bearer ${readKey}` },
    });
    expect(del.status).toBe(403);

    // store:write api-key CAN update + delete.
    const wUpd = await jsonRequest(h.app, 'PATCH', `/notebooks/${id}`, {
      body: { completed: true },
      headers: { authorization: `Bearer ${writeKey}` },
    });
    expect(wUpd.status).toBe(200);
    const wDel = await jsonRequest(h.app, 'DELETE', `/notebooks/${id}`, {
      headers: { authorization: `Bearer ${writeKey}` },
    });
    expect(wDel.status).toBe(204);
  });

  it('an api-key with NO store scope is FORBIDDEN on both read and write', async () => {
    const { orgId, token } = await principal('apikey-noscope@example.com', 'ApiKeyNoScopeOrg');
    const agentOnlyKey = await mintApiKey(orgId, token, ['agent:run']);
    const list = await jsonRequest(h.app, 'GET', '/notebooks', {
      headers: { authorization: `Bearer ${agentOnlyKey}` },
    });
    expect(list.status).toBe(403);
    const create = await jsonRequest(h.app, 'POST', '/notebooks', {
      body: { title: 'x', scheduledAt: '2026-07-07T09:00:00Z', completed: false },
      headers: { authorization: `Bearer ${agentOnlyKey}` },
    });
    expect(create.status).toBe(403);
  });

  it('a FORBIDDEN api-key store:write (sensitive op) writes an authz_denied audit row', async () => {
    const { orgId, token } = await principal('apikey-audit@example.com', 'ApiKeyAuditOrg');
    // A read-only key attempts a store:write create → 403 (no store:write scope).
    const readKey = await mintApiKey(orgId, token, ['store:read']);
    const create = await jsonRequest(h.app, 'POST', '/notebooks', {
      body: { title: 'denied', scheduledAt: '2026-07-11T09:00:00Z', completed: false },
      headers: { authorization: `Bearer ${readKey}` },
    });
    expect(create.status).toBe(403);

    // The deny is audited OUT-OF-BAND: an authz_denied row for store:write in this org exists.
    const rows = await h.db.$client.unsafe(
      `SELECT event, meta FROM rayspec_test_apiauth_declroutes.auth_audit
         WHERE event = 'authz_denied' AND actor_org_id = $1 AND meta->>'permission' = 'store:write'`,
      [orgId],
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});

/**
 * The `{handler}` route action — FAIL-CLOSED AT BOOT when no loaded handler is supplied (
 * superseded the 501 seam: a `{handler}` route is now WIRED, so a spec that declares one but
 * whose deployment did NOT load the handlers must abort the BOOT — never ship a route that 500s, and
 * never silently 501 a declared route the engine cannot run). The wired-handler END-TO-END behavior is
 * tested in declared-handler-model.db.test.ts (with real loaded handlers + backends).
 */
describeDb('declared {handler} route — fail-closed at boot when handlers are not loaded', () => {
  it('createAuthApp ABORTS the boot for a {handler} route with no loaded handler map', async () => {
    const base = loadThrowawaySpec();
    const handlerSpec: RaySpec = {
      ...base,
      handlers: [
        ...base.handlers,
        { id: 'custom_route', module: 'h.ts', export: 'h', kind: 'route' },
      ],
      api: [
        ...base.api,
        { method: 'POST', path: '/custom', action: { kind: 'handler', handler: 'custom_route' } },
      ],
    };
    // No `engineHandlers` supplied → the engine has no loaded handler for `custom_route`, so
    // registerDeclaredRoutes throws at BOOT (a deploy-wiring error), never a runtime 500/501.
    await expect(createHarnessBootOnly(handlerSpec)).rejects.toThrow(
      /references handler 'custom_route' but no loaded handler/,
    );
  });
});

/**
 * Boot-only harness probe: attempt to build the app for a spec WITHOUT loaded handlers, so the
 * `{handler}`-route boot-fail surfaces. It needs a DB to materialize the stores, then the route-wiring
 * throw fires. This runs ONLY under `describeDb` (a DB is present) — it does NOT synthesize the expected
 * error string for a no-DB run, so the boot-fail assertion passes ONLY when the REAL boot path throws
 * it (never a vacuous pass); the whole file skips cleanly without a DB, and hard-fails when a DB is required.
 */
async function createHarnessBootOnly(spec: RaySpec): Promise<void> {
  // Supply the direct `agentRegistry` so the throwaway's {agent} route ({/notebooks/{id}/summarize})
  // resolves — otherwise THAT boot-fail fires first and masks the {handler} boot-fail under test. With
  // the agent satisfied + NO engineHandlers, the {handler} route's missing-loaded-handler boot-fail is
  // the one that throws.
  const hh = await createHarness({
    engineSpec: spec,
    agentRegistry,
    schema: 'rayspec_test_handler_bootfail',
  });
  await hh.close();
}

describeDb('declared route authz + unknown route', () => {
  it('an unauthenticated store request → 401', async () => {
    const res = await jsonRequest(h.app, 'GET', '/notebooks', {});
    expect(res.status).toBe(401);
  });
  it('an undeclared path is still a uniform 404', async () => {
    const { token } = await principal('nf@example.com', 'NfOrg');
    const res = await jsonRequest(h.app, 'GET', '/not-a-declared-route', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });
});

/**
 * A3 (THE headline correctness item, correction A3): is the FIRST production consumer of
 * `TenantDb.transaction()` / the `app.current_tenant` GUC seam. This test asserts the GUC is REALLY
 * populated INSIDE the declared store-route handler's OWN transaction, reading it back via that exact
 * transaction handle — NOT a proxy/blind assertion.
 *
 * Mechanism (non-blind): a SECOND harness whose injected raw `db.transaction` is WRAPPED. The store
 * handler calls `forTenant(deps.db, tenantId).transaction(fn)` → TenantDb calls
 * `deps.db.transaction(inner)` where `inner` FIRST runs `set_config(app.current_tenant, …, true)`
 * then the handler body. Our wrapper runs `inner` and, on the SAME tx handle INSIDE the still-open
 * transaction, reads `current_setting('app.current_tenant')`. The captured value is therefore the GUC
 * of the handler's ACTUAL transaction, set by the handler's ACTUAL run. We assert it equals the
 * request's server-derived tenant — proving the RLS-ready seam (external-exposure hardening) is live for product data.
 */
describeDb('A3 — app.current_tenant GUC is populated INSIDE the store-handler transaction', () => {
  let ah: Harness;
  // Captured per request: the GUC value read INSIDE the handler's real transaction.
  const captured: { guc: string | null } = { guc: null };

  // Wrap the raw Db so `transaction(inner)` reads back the GUC inside the handler's own tx.
  function wrapDb(db: Db): Db {
    const realTransaction = db.transaction.bind(db);
    // Override ONLY transaction; everything else (the Drizzle query builder, $client) passes through.
    const wrapped = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'transaction') {
          return (inner: (tx: unknown) => Promise<unknown>, ...rest: unknown[]) =>
            realTransaction(
              async (tx: unknown) => {
                // Run the handler's inner tx body (TenantDb's set_config already ran as its 1st stmt).
                const result = await inner(tx);
                // Read the GUC on the SAME tx handle — still inside the handler's open transaction.
                const rows = (await (tx as Db).execute(
                  sql`select current_setting(${TENANT_GUC}, true) as tenant`,
                )) as unknown as Array<{ tenant: string | null }>;
                captured.guc = rows[0]?.tenant ?? null;
                return result;
              },
              ...(rest as []),
            ) as unknown;
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    return wrapped as Db;
  }

  beforeAll(async () => {
    ah = await createHarness({
      engineSpec: loadThrowawaySpec(),
      agentRegistry,
      schema: 'rayspec_test_a3_guc',
      wrapDb,
    });
  });
  beforeEach(async () => {
    await ah.reset();
    captured.guc = null;
  });
  afterAll(async () => {
    await ah.close();
  });

  it('a declared store CREATE runs inside a tx whose app.current_tenant == the request tenant', async () => {
    // Provision a principal on THIS harness, capturing the server-derived tenant (orgId).
    const reg = await jsonRequest(ah.app, 'POST', '/v1/auth/register', {
      body: { email: 'a3-guc@example.com', password: 'a-long-enough-password' },
    });
    const t0 = (await reg.json()).accessToken as string;
    const orgRes = await jsonRequest(ah.app, 'POST', '/v1/orgs', {
      body: { name: 'A3Org' },
      headers: { authorization: `Bearer ${t0}` },
    });
    const orgId = (await orgRes.json()).id as string;
    const sw = await jsonRequest(ah.app, 'POST', `/v1/orgs/${orgId}/switch`, {
      headers: { authorization: `Bearer ${t0}` },
    });
    const token = (await sw.json()).accessToken as string;

    // Drive the REAL declared store CREATE route — it runs inside forTenant(...).transaction(...).
    const created = await jsonRequest(ah.app, 'POST', '/notebooks', {
      body: { title: 'GUC', scheduledAt: '2026-07-05T10:00:00Z', completed: false },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(created.status).toBe(201);

    // THE A3 assertion: the GUC read INSIDE the handler's own transaction equals the request tenant.
    expect(captured.guc).toBe(orgId);
    // And it is a real uuid (the server-derived tenant), not empty/null.
    expect(captured.guc).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('a declared store GET (read path) ALSO runs inside a tx with the correct GUC', async () => {
    const reg = await jsonRequest(ah.app, 'POST', '/v1/auth/register', {
      body: { email: 'a3-guc-read@example.com', password: 'a-long-enough-password' },
    });
    const t0 = (await reg.json()).accessToken as string;
    const orgId = (
      await (
        await jsonRequest(ah.app, 'POST', '/v1/orgs', {
          body: { name: 'A3ReadOrg' },
          headers: { authorization: `Bearer ${t0}` },
        })
      ).json()
    ).id as string;
    const token = (
      await (
        await jsonRequest(ah.app, 'POST', `/v1/orgs/${orgId}/switch`, {
          headers: { authorization: `Bearer ${t0}` },
        })
      ).json()
    ).accessToken as string;
    const auth = { authorization: `Bearer ${token}` };

    const id = (
      await (
        await jsonRequest(ah.app, 'POST', '/notebooks', {
          body: { title: 'R', scheduledAt: '2026-07-06T10:00:00Z', completed: false },
          headers: auth,
        })
      ).json()
    ).id as string;
    captured.guc = null; // clear the value set by the create above

    const got = await jsonRequest(ah.app, 'GET', `/notebooks/${id}`, { headers: auth });
    expect(got.status).toBe(200);
    expect(captured.guc).toBe(orgId);
  });

  it('UPDATE, DELETE and LIST each ALSO run inside a tx with the correct GUC (all five store ops)', async () => {
    // Provision a principal on THIS harness.
    const reg = await jsonRequest(ah.app, 'POST', '/v1/auth/register', {
      body: { email: 'a3-guc-udl@example.com', password: 'a-long-enough-password' },
    });
    const t0 = (await reg.json()).accessToken as string;
    const orgId = (
      await (
        await jsonRequest(ah.app, 'POST', '/v1/orgs', {
          body: { name: 'A3UdlOrg' },
          headers: { authorization: `Bearer ${t0}` },
        })
      ).json()
    ).id as string;
    const token = (
      await (
        await jsonRequest(ah.app, 'POST', `/v1/orgs/${orgId}/switch`, {
          headers: { authorization: `Bearer ${t0}` },
        })
      ).json()
    ).accessToken as string;
    const auth = { authorization: `Bearer ${token}` };

    const id = (
      await (
        await jsonRequest(ah.app, 'POST', '/notebooks', {
          body: { title: 'UDL', scheduledAt: '2026-07-06T10:00:00Z', completed: false },
          headers: auth,
        })
      ).json()
    ).id as string;

    // LIST inside the GUC tx.
    captured.guc = null;
    const listed = await jsonRequest(ah.app, 'GET', '/notebooks', { headers: auth });
    expect(listed.status).toBe(200);
    expect(captured.guc).toBe(orgId);

    // UPDATE inside the GUC tx.
    captured.guc = null;
    const upd = await jsonRequest(ah.app, 'PATCH', `/notebooks/${id}`, {
      body: { completed: true },
      headers: auth,
    });
    expect(upd.status).toBe(200);
    expect(captured.guc).toBe(orgId);

    // DELETE inside the GUC tx.
    captured.guc = null;
    const del = await jsonRequest(ah.app, 'DELETE', `/notebooks/${id}`, { headers: auth });
    expect(del.status).toBe(204);
    expect(captured.guc).toBe(orgId);
  });
});
