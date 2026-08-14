/**
 * Task-engine route tests — DB-backed (real Postgres, isolated schema via the harness) with a stub
 * dispatcher seam whose `kick()` records the nudge. Assert the REAL thing:
 *  - the whole surface is tenant-scoped through the chokepoint (tenant B neither lists nor reads
 *    nor mutates tenant A's tasks — uniform 404, no existence leak);
 *  - reads carry `store:read`, mutations `store:write` (a read-only key gets the 403 naming the
 *    missing permission);
 *  - the list is keyset-paginated (X-Next-Cursor / X-Result-Truncated, bare-array body);
 *  - a decision resolves a pending approval ONCE (the rerun is a 409), wakes the task, and kicks
 *    the dispatcher;
 *  - the per-task events route replays the journal as SSE and 404s a foreign task BEFORE streaming;
 *  - pause/resume/halt work the runtime row; a body outside the strict schema is a 400;
 *  - the whole surface fail-closes 501 when no dispatcher seam is wired.
 */
import { forTenant } from '@rayspec/db';
import {
  applyTransition,
  applyTurnOutcome,
  createRootTask,
  ensureWorkforceRuntime,
  workforceBudgetsSchema,
} from '@rayspec/tasks';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness, jsonRequest } from '../test-support/harness.js';

let h: Harness;
let kicks = 0;

const NO_BUDGETS = workforceBudgetsSchema.parse({});

/** Provision a principal (registered user → org → switch → JWT) — the org creator is an owner. */
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

async function seedRoot(orgId: string, title = 'A durable task') {
  return createRootTask(forTenant(h.db, orgId), {
    workforceId: 'wf',
    title,
    goal: 'Serve the route tests.',
    owner: 'coordinator',
    requestedBy: 'user',
  });
}

/** Drive a seeded task to `working` and end its turn with a pending approval. */
async function seedPendingApproval(orgId: string) {
  const tdb = forTenant(h.db, orgId);
  const task = await seedRoot(orgId, 'Approval subject');
  const queued = await applyTransition(tdb, {
    taskId: task.taskId,
    expectedVersion: task.version,
    to: 'queued',
    actor: 'scheduler',
  });
  await applyTransition(tdb, {
    taskId: task.taskId,
    expectedVersion: queued.version,
    to: 'working',
    actor: 'scheduler',
  });
  await applyTurnOutcome(tdb, {
    taskId: task.taskId,
    turnId: 't1',
    turnNumber: 1,
    intent: { kind: 'request_approval', question: 'Send it?', timeoutMs: 60_000 },
    budgets: NO_BUDGETS,
  });
  const approvals = await h.db.$client.unsafe(
    `SELECT id FROM workforce_approvals WHERE task_id = '${task.taskId}';`,
  );
  return { task, approvalId: (approvals[0] as { id: string }).id };
}

/** Drive a seeded task to `working` and end its turn parked in review. */
async function seedPendingReview(orgId: string) {
  const tdb = forTenant(h.db, orgId);
  const task = await seedRoot(orgId, 'Review subject');
  const queued = await applyTransition(tdb, {
    taskId: task.taskId,
    expectedVersion: task.version,
    to: 'queued',
    actor: 'scheduler',
  });
  await applyTransition(tdb, {
    taskId: task.taskId,
    expectedVersion: queued.version,
    to: 'working',
    actor: 'scheduler',
  });
  await applyTurnOutcome(tdb, {
    taskId: task.taskId,
    turnId: 't1',
    turnNumber: 1,
    intent: { kind: 'request_review', reviewer: 'reviewer-1' },
    budgets: NO_BUDGETS,
  });
  const reviews = await h.db.$client.unsafe(
    `SELECT id FROM workforce_reviews WHERE task_id = '${task.taskId}';`,
  );
  return { task, reviewId: (reviews[0] as { id: string }).id };
}

describe('/v1/workforce (the task-engine surface)', () => {
  beforeAll(async () => {
    h = await createHarness({
      workforce: {
        kick: () => {
          kicks++;
        },
      },
      schema: 'rayspec_test_workforce',
    });
  });
  afterEach(async () => {
    kicks = 0;
    await h.reset();
  });
  afterAll(async () => {
    await h.close();
  });

  it('lists ONLY the caller tenant, keyset-paginated with the header contract', async () => {
    const a = await principal('wf-a@example.test', 'Org WF A');
    const b = await principal('wf-b@example.test', 'Org WF B');
    for (let i = 1; i <= 3; i++) await seedRoot(a.orgId, `Task ${i}`);
    await seedRoot(b.orgId, 'Foreign task');

    const page1 = await jsonRequest(h.app, 'GET', '/v1/workforce/tasks?limit=2', {
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(page1.status).toBe(200);
    const rows1 = (await page1.json()) as Array<{ title: string }>;
    expect(rows1).toHaveLength(2);
    expect(page1.headers.get('X-Result-Truncated')).toBe('true');
    const cursor = page1.headers.get('X-Next-Cursor');
    expect(cursor).not.toBeNull();

    const page2 = await jsonRequest(h.app, 'GET', `/v1/workforce/tasks?limit=2&cursor=${cursor}`, {
      headers: { authorization: `Bearer ${a.token}` },
    });
    const rows2 = (await page2.json()) as Array<{ title: string }>;
    expect(rows2).toHaveLength(1);
    const seen = [...rows1, ...rows2].map((r) => r.title).sort();
    expect(seen).toEqual(['Task 1', 'Task 2', 'Task 3']); // and NEVER the foreign task
  });

  it('a status filter outside the closed set is a 400; a foreign task read is a uniform 404', async () => {
    const a = await principal('wf-filter@example.test', 'Org WF Filter');
    const b = await principal('wf-foreign@example.test', 'Org WF Foreign');
    const bTask = await seedRoot(b.orgId);
    const bad = await jsonRequest(h.app, 'GET', '/v1/workforce/tasks?status=paused', {
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(bad.status).toBe(400);
    const foreign = await jsonRequest(h.app, 'GET', `/v1/workforce/tasks/${bTask.taskId}`, {
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(foreign.status).toBe(404);
  });

  it('mutations demand store:write: a read-only API key gets the 403 naming the gap', async () => {
    const a = await principal('wf-perm@example.test', 'Org WF Perm');
    const task = await seedRoot(a.orgId);
    const mint = await jsonRequest(h.app, 'POST', `/v1/orgs/${a.orgId}/api-keys`, {
      body: { name: 'read-only', scopes: ['store:read'] },
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(mint.status).toBe(201);
    const key = (await mint.json()).plaintext as string;

    const read = await jsonRequest(h.app, 'GET', '/v1/workforce/tasks', {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(read.status).toBe(200);

    const write = await jsonRequest(h.app, 'POST', `/v1/workforce/tasks/${task.taskId}/cancel`, {
      body: {},
      headers: { authorization: `Bearer ${key}` },
    });
    expect(write.status).toBe(403);
    expect((await write.json()).error.details).toEqual({ missing_permission: 'store:write' });
  });

  it('decides a pending approval once (409 on the rerun), wakes the task, kicks the dispatcher', async () => {
    const a = await principal('wf-approve@example.test', 'Org WF Approve');
    const { task, approvalId } = await seedPendingApproval(a.orgId);

    const res = await jsonRequest(h.app, 'POST', `/v1/workforce/approvals/${approvalId}/decide`, {
      body: { decision: 'approve' },
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(res.status).toBe(200);
    const decided = await res.json();
    expect(decided.status).toBe('approved');
    // Attribution is SERVER-derived from the verified principal — a body-asserted identity is
    // rejected by the strict schema, so nobody can sign a decision as someone else.
    expect(decided.decidedBy).toMatch(/^user:/);
    expect(kicks).toBe(1);
    const row = await h.db.$client.unsafe(
      `SELECT status FROM workforce_tasks WHERE task_id = '${task.taskId}';`,
    );
    expect(row[0]?.status).toBe('queued');

    const rerun = await jsonRequest(h.app, 'POST', `/v1/workforce/approvals/${approvalId}/decide`, {
      body: { decision: 'reject' },
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(rerun.status).toBe(409);

    const impersonation = await jsonRequest(
      h.app,
      'POST',
      `/v1/workforce/approvals/${approvalId}/decide`,
      {
        body: { decision: 'approve', decidedBy: 'someone-else' },
        headers: { authorization: `Bearer ${a.token}` },
      },
    );
    expect(impersonation.status).toBe(400);
  });

  it('a review verdict resolves a parked review once (409 on the rerun) and the inbox is tenant-scoped', async () => {
    const a = await principal('wf-review@example.test', 'Org WF Review');
    const b = await principal('wf-review-b@example.test', 'Org WF Review B');
    const { task, reviewId } = await seedPendingReview(a.orgId);
    await seedPendingReview(b.orgId);

    // The undecided-review inbox mirrors the approvals inbox: caller tenant only.
    const inbox = await jsonRequest(h.app, 'GET', '/v1/workforce/reviews', {
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(inbox.status).toBe(200);
    const rows = (await inbox.json()) as Array<{ id: string; taskId: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(reviewId);

    const res = await jsonRequest(h.app, 'POST', `/v1/workforce/reviews/${reviewId}/verdict`, {
      body: { verdict: 'accept' },
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ reviewId, taskStatus: 'completed' });
    expect(kicks).toBe(1);
    const row = await h.db.$client.unsafe(
      `SELECT status FROM workforce_tasks WHERE task_id = '${task.taskId}';`,
    );
    expect(row[0]?.status).toBe('completed');

    const rerun = await jsonRequest(h.app, 'POST', `/v1/workforce/reviews/${reviewId}/verdict`, {
      body: { verdict: 'reject', reasons: ['too late'] },
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(rerun.status).toBe(409);

    // A foreign verdict is a uniform 404 — tenant B cannot even learn the review exists.
    const foreign = await jsonRequest(h.app, 'POST', `/v1/workforce/reviews/${reviewId}/verdict`, {
      body: { verdict: 'accept' },
      headers: { authorization: `Bearer ${b.token}` },
    });
    expect(foreign.status).toBe(404);
  });

  it('a reject verdict re-queues the task for rework through the one door', async () => {
    const a = await principal('wf-rework@example.test', 'Org WF Rework');
    const { task, reviewId } = await seedPendingReview(a.orgId);
    const res = await jsonRequest(h.app, 'POST', `/v1/workforce/reviews/${reviewId}/verdict`, {
      body: { verdict: 'reject', reasons: ['missing tests'], requiredChanges: ['add coverage'] },
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).taskStatus).toBe('queued');
    const row = await h.db.$client.unsafe(
      `SELECT status FROM workforce_tasks WHERE task_id = '${task.taskId}';`,
    );
    expect(row[0]?.status).toBe('queued');
  });

  it('the approvals inbox lists pending rows for the caller tenant only', async () => {
    const a = await principal('wf-inbox@example.test', 'Org WF Inbox');
    const b = await principal('wf-inbox-b@example.test', 'Org WF Inbox B');
    await seedPendingApproval(a.orgId);
    await seedPendingApproval(b.orgId);
    const res = await jsonRequest(h.app, 'GET', '/v1/workforce/approvals', {
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ status: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('pending');
  });

  it('replays the task journal as SSE (v:1 frames) and 404s a foreign task before streaming', async () => {
    const a = await principal('wf-events@example.test', 'Org WF Events');
    const b = await principal('wf-events-b@example.test', 'Org WF Events B');
    const task = await seedRoot(a.orgId);
    const res = await jsonRequest(h.app, 'GET', `/v1/workforce/tasks/${task.taskId}/events`, {
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('event: workforce.task.created');
    expect(text).toContain('"v":1');

    const foreign = await jsonRequest(h.app, 'GET', `/v1/workforce/tasks/${task.taskId}/events`, {
      headers: { authorization: `Bearer ${b.token}` },
    });
    expect(foreign.status).toBe(404);
  });

  it('signal delivery is strict-bodied and idempotent under a supplied key', async () => {
    const a = await principal('wf-signal@example.test', 'Org WF Signal');
    const tdb = forTenant(h.db, a.orgId);
    const task = await seedRoot(a.orgId);
    const queued = await applyTransition(tdb, {
      taskId: task.taskId,
      expectedVersion: task.version,
      to: 'queued',
      actor: 'scheduler',
    });
    const working = await applyTransition(tdb, {
      taskId: task.taskId,
      expectedVersion: queued.version,
      to: 'working',
      actor: 'scheduler',
    });
    await applyTransition(tdb, {
      taskId: task.taskId,
      expectedVersion: working.version,
      to: 'blocked',
      reason: 'escalated',
      actor: 'coordinator',
    });

    const bad = await jsonRequest(h.app, 'POST', `/v1/workforce/tasks/${task.taskId}/signal`, {
      body: { kind: 'nudge' },
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(bad.status).toBe(400); // outside the closed signal set

    const first = await jsonRequest(h.app, 'POST', `/v1/workforce/tasks/${task.taskId}/signal`, {
      body: { kind: 'manual_unblock', signalKey: 'op-1' },
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ delivered: true, woke: true });
    expect(kicks).toBe(1);

    const dup = await jsonRequest(h.app, 'POST', `/v1/workforce/tasks/${task.taskId}/signal`, {
      body: { kind: 'manual_unblock', signalKey: 'op-1' },
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(await dup.json()).toEqual({ delivered: false, woke: false });
  });

  it('pause/resume/halt work the runtime row; halt demands its reason (strict 400 without)', async () => {
    const a = await principal('wf-control@example.test', 'Org WF Control');
    await seedRoot(a.orgId);

    const pause = await jsonRequest(h.app, 'POST', '/v1/workforce/wf/pause', {
      body: {},
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(pause.status).toBe(200);
    expect(await pause.json()).toEqual({ workforceId: 'wf', paused: true });

    const resume = await jsonRequest(h.app, 'POST', '/v1/workforce/wf/resume', {
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(resume.status).toBe(200);
    expect((await resume.json()).paused).toBe(false);

    const noReason = await jsonRequest(h.app, 'POST', '/v1/workforce/wf/halt', {
      body: {},
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(noReason.status).toBe(400);

    const halt = await jsonRequest(h.app, 'POST', '/v1/workforce/wf/halt', {
      body: { reason: 'maintenance' },
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(halt.status).toBe(200);
    const cancelled = await h.db.$client.unsafe(
      "SELECT count(*)::int AS c FROM workforce_tasks WHERE status = 'cancelled';",
    );
    expect(cancelled[0]?.c).toBeGreaterThanOrEqual(1);
  });

  it('the status view reports control state, counts, queue depth, and budget headroom', async () => {
    const a = await principal('wf-status@example.test', 'Org WF Status');
    const tdb = forTenant(h.db, a.orgId);
    await ensureWorkforceRuntime(tdb, 'wf', {
      workforce: { usd: 10 },
      execution: { estimateUsdPerTurn: 0.5 },
    });
    const task = await seedRoot(a.orgId);
    await applyTransition(tdb, {
      taskId: task.taskId,
      expectedVersion: task.version,
      to: 'queued',
      actor: 'scheduler',
    });
    const res = await jsonRequest(h.app, 'GET', '/v1/workforce/wf/status', {
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      workforceId: 'wf',
      paused: false,
      queueDepth: 1,
      tasks: { queued: 1 },
      budget: { ceilingUsd: 10, consumedUsd: 0, headroomUsd: 10 },
    });
    // An uninitialized workforce id is a uniform 404 (nothing was ever declared for it).
    const unknown = await jsonRequest(h.app, 'GET', '/v1/workforce/nope/status', {
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(unknown.status).toBe(404);
  });

  it('a fixed collection segment is reserved, and it does not shadow a workforce id or a task id', async () => {
    const a = await principal('wf-reserved@example.test', 'Org WF Reserved');
    const task = await seedRoot(a.orgId, 'Not shadowed');
    const auth = { authorization: `Bearer ${a.token}` };

    // `/v1/workforce/tasks/status` matches BOTH the workforce status route and the task-get route.
    // The status route is registered first and names the collision, instead of quietly answering
    // as a task lookup for a task called 'status'.
    const collision = await jsonRequest(h.app, 'GET', '/v1/workforce/tasks/status', {
      headers: auth,
    });
    expect(collision.status).toBe(400);
    expect((await collision.json()).error?.details?.reserved).toEqual([
      'tasks',
      'approvals',
      'reviews',
      'cost',
    ]);
    // The same refusal on the mutations, so a reserved id is never half-addressable.
    const paused = await jsonRequest(h.app, 'POST', '/v1/workforce/cost/pause', {
      body: {},
      headers: auth,
    });
    expect(paused.status).toBe(400);

    // …and both real routes still resolve.
    const real = await jsonRequest(h.app, 'GET', `/v1/workforce/${task.taskId}/status`, {
      headers: auth,
    });
    expect(real.status).toBe(404); // a task id is not a workforce id — uniform, not a crash
    const byId = await jsonRequest(h.app, 'GET', `/v1/workforce/tasks/${task.taskId}`, {
      headers: auth,
    });
    expect(byId.status).toBe(200);
    expect((await byId.json()).taskId).toBe(task.taskId);
  });

  it('the cost view rolls the ledger up per scope and refuses a malformed window', async () => {
    const a = await principal('wf-cost@example.test', 'Org WF Cost');
    const bad = await jsonRequest(h.app, 'GET', '/v1/workforce/cost?window=fortnight', {
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(bad.status).toBe(400);
    const ok = await jsonRequest(h.app, 'GET', '/v1/workforce/cost?window=24h', {
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ window: '24h', totalSettledUsd: 0, scopes: [] });
  });

  it('requires auth on every route', async () => {
    const res = await jsonRequest(h.app, 'GET', '/v1/workforce/tasks', {});
    expect(res.status).toBe(401);
  });
});

describe('/v1/workforce without a wired dispatcher', () => {
  let hNo: Harness;
  beforeAll(async () => {
    hNo = await createHarness({ schema: 'rayspec_test_workforce_off' });
  });
  afterAll(async () => {
    await hNo.close();
  });

  it('fail-closes the whole surface with a clean 501', async () => {
    const reg = await jsonRequest(hNo.app, 'POST', '/v1/auth/register', {
      body: { email: 'wf-off@example.test', password: 'a-long-enough-password' },
    });
    const t0 = (await reg.json()).accessToken as string;
    const orgRes = await jsonRequest(hNo.app, 'POST', '/v1/orgs', {
      body: { name: 'Org WF Off' },
      headers: { authorization: `Bearer ${t0}` },
    });
    const orgId = (await orgRes.json()).id as string;
    const switchRes = await jsonRequest(hNo.app, 'POST', `/v1/orgs/${orgId}/switch`, {
      headers: { authorization: `Bearer ${t0}` },
    });
    const token = (await switchRes.json()).accessToken as string;
    const res = await jsonRequest(hNo.app, 'GET', '/v1/workforce/tasks', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(501);
  });
});
