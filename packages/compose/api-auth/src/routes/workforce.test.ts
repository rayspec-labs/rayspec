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
import { forTenant, schema } from '@rayspec/db';
import {
  applyTransition,
  applyTurnOutcome,
  createRootTask,
  ensureWorkforceRuntime,
  insertChildTask,
  workforceBudgetsSchema,
} from '@rayspec/tasks';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { WorkforceGoalIntake, WorkforceGoalOutcome } from '../app-context.js';
import { createHarness, type Harness, jsonRequest } from '../test-support/harness.js';

let h: Harness;
let kicks = 0;

/** The goals route's stub intake: records what the route derived, answers what a test set. The
 * REAL intake (strategy → rows) is the server composition's and is proven in its own DB suite —
 * here the subject is the ROUTE's mapping: strict body, server-derived tenant + actor, outcome
 * mapping, and the kick. */
let goalSubmissions: Array<Parameters<WorkforceGoalIntake['submitGoal']>[0]> = [];
const DEFAULT_GOAL_OUTCOME: WorkforceGoalOutcome = { outcome: 'created', tasks: [] };
let nextGoalOutcome: WorkforceGoalOutcome = DEFAULT_GOAL_OUTCOME;

const NO_BUDGETS = workforceBudgetsSchema.parse({});

/**
 * Provision a principal (registered user → org → switch → JWT) — the org creator is an owner.
 * `userId` comes back too because the decision doors compare the SERVER-DERIVED actor string
 * (`user:<userId>`, `actorFrom`) against the decider a row records.
 */
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
  const users = (await h.db.$client.unsafe(
    `SELECT id FROM users WHERE lower(email) = lower('${email}');`,
  )) as unknown as Array<{ id: string }>;
  const userId = (users[0] as { id: string }).id;
  return { orgId, token, userId, actor: `user:${userId}` };
}

/**
 * Demote a principal to `member` — the role that HOLDS `store:write` (so it decides ordinary rows)
 * but NOT `workforce:override`. `store:write` is sensitive, so the route re-reads the role live and
 * the still-owner JWT claim is not what answers.
 */
async function demoteToMember(userId: string, orgId: string): Promise<void> {
  await h.db.$client.unsafe(
    `UPDATE memberships SET role = 'member' WHERE user_id = '${userId}' AND org_id = '${orgId}';`,
  );
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

/** Drive a seeded task to `working` and end its turn with a pending approval addressed to `approver`. */
async function seedPendingApproval(orgId: string, approver = 'user') {
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
    // The claim carries the id the application below presents: a turn applies only over its own.
    turnId: 't1',
  });
  await applyTurnOutcome(tdb, {
    taskId: task.taskId,
    turnId: 't1',
    turnNumber: 1,
    intent: { kind: 'request_approval', question: 'Send it?', timeoutMs: 60_000, approver },
    budgets: NO_BUDGETS,
  });
  const approvals = await h.db.$client.unsafe(
    `SELECT id FROM workforce_approvals WHERE task_id = '${task.taskId}';`,
  );
  return { task, approvalId: (approvals[0] as { id: string }).id };
}

/**
 * Drive a seeded task to `working` and end its turn parked in review, addressed to `reviewer`.
 * The DEFAULT is the `'user'` sentinel — the deployment's human operator surface — because this
 * route IS the human verdict door: a review addressed to a named EMPLOYEE is answered by that
 * employee's dispatched review turn (apply-intents.ts re-checks `review.reviewer === task.owner`),
 * and the named-reviewer case at this door has its own tests below.
 */
async function seedPendingReview(orgId: string, reviewer = 'user') {
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
    // The claim carries the id the application below presents: a turn applies only over its own.
    turnId: 't1',
  });
  await applyTurnOutcome(tdb, {
    taskId: task.taskId,
    turnId: 't1',
    turnNumber: 1,
    intent: { kind: 'request_review', reviewer },
    budgets: NO_BUDGETS,
  });
  const reviews = await h.db.$client.unsafe(
    `SELECT id FROM workforce_reviews WHERE task_id = '${task.taskId}';`,
  );
  return { task, reviewId: (reviews[0] as { id: string }).id };
}

/** The task row's current optimistic-concurrency version — a transition applies over its own. */
async function versionOf(orgId: string, taskId: string): Promise<number> {
  const rows = (await forTenant(h.db, orgId)
    .select(schema.workforceTasks, { version: schema.workforceTasks.version })
    .where(eq(schema.workforceTasks.taskId, taskId))) as Array<{ version: number }>;
  return (rows[0] as { version: number }).version;
}

describe('/v1/workforce (the task-engine surface)', () => {
  beforeAll(async () => {
    h = await createHarness({
      workforce: {
        kick: () => {
          kicks++;
        },
      },
      workforceGoalIntake: {
        submitGoal: (input) => {
          goalSubmissions.push(input);
          return Promise.resolve(nextGoalOutcome);
        },
      },
      schema: 'rayspec_test_workforce',
    });
  });
  afterEach(async () => {
    kicks = 0;
    goalSubmissions = [];
    nextGoalOutcome = DEFAULT_GOAL_OUTCOME;
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

  it('a stale review decided from the inbox is a typed 409, not a 500', async () => {
    // The natural interleaving the binding check exists to refuse, driven through its own front
    // door: an abandoned review leaves its row undecided, so it still lists FIRST in the inbox
    // (oldest first) after the next round opened its own park. An operator clicks it. The engine
    // refuses — but the refusal was unmapped here and surfaced as a generic 500, which reads as a
    // broken server rather than as the conflict it is.
    const a = await principal('wf-stale-review@example.test', 'Org WF Stale Review');
    const { task, reviewId: staleId } = await seedPendingReview(a.orgId);
    const tdb = forTenant(h.db, a.orgId);
    // The reviewer never delivered: the park is released to a human, the row stays undecided.
    const released = await applyTransition(tdb, {
      taskId: task.taskId,
      expectedVersion: await versionOf(a.orgId, task.taskId),
      to: 'waiting_for_user',
      actor: 'system',
    });
    // The human sends it back, and a SECOND round opens its own park bound to its own review.
    const requeued = await applyTransition(tdb, {
      taskId: task.taskId,
      expectedVersion: released.version,
      to: 'queued',
      actor: 'user',
    });
    await applyTransition(tdb, {
      taskId: task.taskId,
      expectedVersion: requeued.version,
      to: 'working',
      actor: 'scheduler',
      turnId: 't2',
    });
    await applyTurnOutcome(tdb, {
      taskId: task.taskId,
      turnId: 't2',
      turnNumber: 2,
      intent: { kind: 'request_review', reviewer: 'reviewer-1' },
      budgets: NO_BUDGETS,
    });

    // The stale row is still the one the inbox offers first.
    const inbox = await jsonRequest(h.app, 'GET', '/v1/workforce/reviews', {
      headers: { authorization: `Bearer ${a.token}` },
    });
    const rows = (await inbox.json()) as Array<{ id: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]?.id).toBe(staleId);

    const res = await jsonRequest(h.app, 'POST', `/v1/workforce/reviews/${staleId}/verdict`, {
      body: { verdict: 'accept' },
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(res.status).toBe(409);
    // Nothing was written: round 2's park still holds its own reviewer's exit.
    const held = await h.db.$client.unsafe(
      `SELECT status, status_reason FROM workforce_tasks WHERE task_id = '${task.taskId}';`,
    );
    expect(held[0]).toMatchObject({
      status: 'waiting_for_review',
      status_reason: 'review_pending',
    });
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
    // A park an operator override legitimately answers: the ceiling is a lever they hold. (The
    // STRUCTURAL parks — `awaiting_children`, `escalated` — are answered by a child's terminal and
    // are pinned as declining below.)
    await applyTransition(tdb, {
      taskId: task.taskId,
      expectedVersion: working.version,
      to: 'blocked',
      reason: 'budget_exhausted',
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

  it('the route accepts OPERATOR kinds only — a mechanism kind is a typed 400', async () => {
    const a = await principal('wf-kinds@example.test', 'Org WF Kinds');
    const task = await seedRoot(a.orgId);
    // Each of these is written by the path that establishes the fact it reports. Accepting them
    // here would let a caller assert that fact by hand and release the park waiting to observe it.
    for (const kind of [
      'child_completed',
      'escalated',
      'review_verdict',
      'approval_decided',
      'cancel',
    ]) {
      const res = await jsonRequest(h.app, 'POST', `/v1/workforce/tasks/${task.taskId}/signal`, {
        body: { kind },
        headers: { authorization: `Bearer ${a.token}` },
      });
      expect(res.status, kind).toBe(400);
    }
    // The three an operator genuinely holds the lever for are still accepted.
    for (const kind of ['manual_unblock', 'budget_raised', 'user_reply']) {
      const res = await jsonRequest(h.app, 'POST', `/v1/workforce/tasks/${task.taskId}/signal`, {
        body: { kind, signalKey: `op-${kind}` },
        headers: { authorization: `Bearer ${a.token}` },
      });
      expect(res.status, kind).toBe(202);
    }
  });

  it('an operator override RECORDS but does not release a structural park, through the route', async () => {
    const a = await principal('wf-structural@example.test', 'Org WF Structural');
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
    // `escalated` waits on the escalation child's terminal, exactly as `awaiting_children` waits on
    // the fan-out's. An override answers no fact about that child and would erase the only exit.
    await applyTransition(tdb, {
      taskId: task.taskId,
      expectedVersion: working.version,
      to: 'blocked',
      reason: 'escalated',
      actor: 'coordinator',
    });

    const res = await jsonRequest(h.app, 'POST', `/v1/workforce/tasks/${task.taskId}/signal`, {
      body: { kind: 'manual_unblock', signalKey: 'op-structural' },
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(res.status).toBe(202); // the delivery is recorded — it simply wakes nothing
    expect(await res.json()).toEqual({ delivered: true, woke: false });
    const rows = await tdb
      .select(schema.workforceTasks, { status: schema.workforceTasks.status })
      .where(eq(schema.workforceTasks.taskId, task.taskId));
    expect(rows[0]).toMatchObject({ status: 'blocked' });
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

  it('cost --by department groups the LEDGER scope buckets; --by employee groups TASK rows and says its basis', async () => {
    const a = await principal('wf-cost-by@example.test', 'Org WF Cost By');
    const tdb = forTenant(h.db, a.orgId);
    // Ledger rows: two department buckets across two windows — the grouping sums per scope id.
    // (Read-side seeding; the WRITE invariants on these rows are the budget suite's.)
    const windowA = new Date('2026-08-15T00:00:00Z');
    const windowB = new Date('2026-08-15T01:00:00Z');
    for (const [scopeId, windowStart, settled, turns] of [
      ['eng', windowA, '0.30', 3],
      ['eng', windowB, '0.20', 2],
      ['growth', windowA, '0.10', 1],
    ] as const) {
      await tdb.insert(schema.workforceBudgetLedger, {
        scopeKind: 'department',
        scopeId,
        windowStart,
        reservedUsd: '0',
        settledUsd: settled,
        settledTurns: turns,
      });
    }
    const byDepartment = await jsonRequest(h.app, 'GET', '/v1/workforce/cost?by=department', {
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(byDepartment.status).toBe(200);
    expect(await byDepartment.json()).toEqual({
      window: '24h',
      by: 'department',
      basis: 'budget_ledger',
      groups: [
        { id: 'eng', settledUsd: 0.5, reservedUsd: 0, settledTurns: 5 },
        { id: 'growth', settledUsd: 0.1, reservedUsd: 0, settledTurns: 1 },
      ],
    });

    // Task rows for the employee grouping — settled cost lives on the rows the tree also reads.
    const first = await seedRoot(a.orgId, 'Owned by alpha');
    const second = await seedRoot(a.orgId, 'Also alpha');
    const third = await seedRoot(a.orgId, 'Owned by beta');
    await h.db.$client.unsafe(
      `UPDATE workforce_tasks SET cost_usd = '0.40', turns_used = 2, owner = 'alpha' WHERE task_id = '${first.taskId}';
       UPDATE workforce_tasks SET cost_usd = '0.10', turns_used = 1, owner = 'alpha' WHERE task_id = '${second.taskId}';
       UPDATE workforce_tasks SET cost_usd = '0.20', turns_used = 1, owner = 'beta' WHERE task_id = '${third.taskId}';`,
    );
    const byEmployee = await jsonRequest(h.app, 'GET', '/v1/workforce/cost?by=employee', {
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(byEmployee.status).toBe(200);
    expect(await byEmployee.json()).toEqual({
      window: '24h',
      by: 'employee',
      basis: 'task_rows',
      groups: [
        { id: 'alpha', settledUsd: 0.5, settledTurns: 3, tasks: 2 },
        { id: 'beta', settledUsd: 0.2, settledTurns: 1, tasks: 1 },
      ],
    });

    const unknown = await jsonRequest(h.app, 'GET', '/v1/workforce/cost?by=task-class', {
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error.details).toEqual({
      allowed: ['employee', 'department'],
    });

    // The ungrouped default is byte-unchanged by the new parameter.
    const plain = await jsonRequest(h.app, 'GET', '/v1/workforce/cost?window=24h', {
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(plain.status).toBe(200);
    expect(await plain.json()).toMatchObject({ window: '24h', totalSettledUsd: 0 });
  });

  it('the tree returns the whole subtree flat from ANY member id, with the per-task ceiling', async () => {
    const a = await principal('wf-tree@example.test', 'Org WF Tree');
    const tdb = forTenant(h.db, a.orgId);
    await ensureWorkforceRuntime(tdb, 'wf', {
      task: { usd: 2.5, turns: 20 },
      // A usd ceiling is only coherent with a positive per-turn estimate (the budgets schema's
      // own refinement) — the same pair a declared document derives.
      execution: { estimateUsdPerTurn: 0.05 },
    });
    const root = await seedRoot(a.orgId, 'Tree root');
    const childA = await insertChildTask(tdb, root, 1, 0, {
      title: 'Left stream',
      goal: 'Left half.',
      owner: 'worker-a',
    });
    const grandchild = await insertChildTask(tdb, childA, 1, 0, {
      title: 'Leaf',
      goal: 'Leaf work.',
      owner: 'worker-b',
    });
    await insertChildTask(tdb, root, 1, 1, {
      title: 'Right stream',
      goal: 'Right half.',
      owner: 'worker-c',
    });

    // Anchored on a GRANDCHILD: the read climbs to the root and returns the whole subtree.
    const res = await jsonRequest(h.app, 'GET', `/v1/workforce/tasks/${grandchild.taskId}/tree`, {
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Result-Truncated')).toBe('false');
    const body = (await res.json()) as {
      rootTaskId: string;
      tasks: Array<{ taskId: string }>;
      budgets: { taskUsd: number; taskTurns: number } | null;
    };
    expect(body.rootTaskId).toBe(root.taskId);
    expect(body.tasks).toHaveLength(4);
    expect(body.tasks.map((t) => t.taskId)).toEqual(
      [...body.tasks.map((t) => t.taskId)].sort(), // task_id asc — the deterministic order
    );
    expect(body.budgets).toEqual({ taskUsd: 2.5, taskTurns: 20 });
  });

  it('C4: the tree caps at 500 rows and the ROOT rides even when it sorts PAST the page (union branch)', async () => {
    const a = await principal('wf-tree-cap@example.test', 'Org WF Tree Cap');
    const tdb = forTenant(h.db, a.orgId);
    // The off-by-one this pins bites ONLY when the root sits INSIDE the +1 overflow probe at index
    // 500 — inside the probe (so the old membership check saw it and skipped the union) yet dropped
    // by the 500-row slice. That needs the root's id to sort at exactly position 500: 500 children
    // whose ids sort BELOW it, and at least one whose id sorts ABOVE it (so the probe fills to 501
    // and the root is its last, sliced-off row). A lexical-MAX root — every child below it — would
    // instead land the root OUTSIDE the probe, where even the old code unioned it back and the
    // assertion passed on the unfixed code. Ids are controlled directly here for that reason.
    const rootId = '88888888-8888-4888-8888-888888888888'; // sorts after the 500 below, before the 2 above
    const insertControlled = (taskId: string, title: string) =>
      tdb.insert(schema.workforceTasks, {
        taskId,
        workforceId: 'wf',
        parentTaskId: taskId === rootId ? null : rootId,
        rootTaskId: rootId,
        ancestryPath: taskId === rootId ? [] : [rootId],
        title,
        goal: 'Serve the route tests.',
        description: null,
        owner: taskId === rootId ? 'coordinator' : 'worker-swarm',
        requestedBy: taskId === rootId ? 'user' : 'coordinator',
        department: null,
        priority: 'normal',
        dependencies: [],
        status: 'planned',
      });
    await insertControlled(rootId, 'Runaway root');
    // 500 children that sort BELOW the root (prefix 00000000…): they fill the probe's first 500 slots.
    for (let slot = 0; slot < 500; slot += 1) {
      await insertControlled(
        `00000000-0000-4000-8000-${slot.toString().padStart(12, '0')}`,
        `Below ${slot}`,
      );
    }
    // 2 children that sort ABOVE the root (prefix ffffffff…): they push the root to probe index 500.
    await insertControlled('ffffffff-ffff-4fff-8fff-000000000001', 'Above 1');
    await insertControlled('ffffffff-ffff-4fff-8fff-000000000002', 'Above 2');
    const res = await jsonRequest(h.app, 'GET', `/v1/workforce/tasks/${rootId}/tree`, {
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Result-Truncated')).toBe('true');
    const body = (await res.json()) as {
      rootTaskId: string;
      tasks: Array<{ taskId: string }>;
      budgets: unknown;
    };
    expect(body.tasks).toHaveLength(500);
    // THE ROOT ALWAYS RIDES A TRUNCATED PAGE — checked against the SLICED page now, so it survives
    // even when it sorts last and the probe never held it.
    expect(body.tasks.some((t) => t.taskId === rootId)).toBe(true);
    expect(body.rootTaskId).toBe(rootId);
    expect(body.budgets).toBeNull(); // no runtime row was ever created for 'wf' here
  });

  it('the tree is tenant-scoped: a foreign task id is a uniform 404', async () => {
    const a = await principal('wf-tree-a@example.test', 'Org WF Tree A');
    const b = await principal('wf-tree-b@example.test', 'Org WF Tree B');
    const bTask = await seedRoot(b.orgId, 'Foreign tree');
    const res = await jsonRequest(h.app, 'GET', `/v1/workforce/tasks/${bTask.taskId}/tree`, {
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(res.status).toBe(404);
  });

  it('submits a goal: server-derived tenant + verified actor reach the intake, 202 lists the tasks, the dispatcher is kicked', async () => {
    const a = await principal('wf-goal@example.test', 'Org WF Goal');
    nextGoalOutcome = {
      outcome: 'created',
      tasks: [{ taskId: 'task_plan_1', owner: 'lead', title: 'Ship the release.' }],
    };
    const res = await jsonRequest(h.app, 'POST', '/v1/workforce/wf/goals', {
      body: { goal: 'Ship the release.', priority: 'high' },
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      workforceId: 'wf',
      tasks: [{ taskId: 'task_plan_1', owner: 'lead', title: 'Ship the release.' }],
    });
    expect(kicks).toBe(1);
    expect(goalSubmissions).toHaveLength(1);
    const seen = goalSubmissions[0] as (typeof goalSubmissions)[number];
    expect(seen.tenantId).toBe(a.orgId); // the middleware chain's tenant, never a body field
    expect(seen.workforceId).toBe('wf');
    expect(seen.goal).toBe('Ship the release.');
    expect(seen.priority).toBe('high');
    expect(seen.requestedBy).toMatch(/^user:/); // the VERIFIED principal, never client-asserted
  });

  it('maps intake outcomes: not_found → uniform 404, invalid_plan → the 500 naming the defect; neither kicks', async () => {
    const a = await principal('wf-goal-map@example.test', 'Org WF Goal Map');
    nextGoalOutcome = { outcome: 'not_found' };
    const missing = await jsonRequest(h.app, 'POST', '/v1/workforce/other/goals', {
      body: { goal: 'For a workforce this deployment does not declare.' },
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(missing.status).toBe(404);

    nextGoalOutcome = {
      outcome: 'invalid_plan',
      detail: "step 0 names owner 'ghost', which this workforce does not declare",
    };
    const refused = await jsonRequest(h.app, 'POST', '/v1/workforce/wf/goals', {
      body: { goal: 'A goal the deployed strategy mishandles.' },
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(refused.status).toBe(500);
    // R5: the 500 body is STATIC — it never echoes the deployment shape the detail names (employee
    // ids, department names, the strategy id). The detail stays server-side.
    const refusedBody = (await refused.json()).error.message as string;
    expect(refusedBody).not.toContain('ghost');
    expect(refusedBody).toContain('server-side');
    expect(kicks).toBe(0); // no outcome above created any work to dispatch
  });

  it('refuses a goal outside the strict schema, a reserved workforce id, and a read-only key', async () => {
    const a = await principal('wf-goal-refuse@example.test', 'Org WF Goal Refuse');
    const auth = { authorization: `Bearer ${a.token}` };
    const unknownKey = await jsonRequest(h.app, 'POST', '/v1/workforce/wf/goals', {
      body: { goal: 'x', requestedBy: 'lead' }, // identity is server-derived — the key is refused
      headers: auth,
    });
    expect(unknownKey.status).toBe(400);
    const missingGoal = await jsonRequest(h.app, 'POST', '/v1/workforce/wf/goals', {
      body: { priority: 'high' },
      headers: auth,
    });
    expect(missingGoal.status).toBe(400);
    const reserved = await jsonRequest(h.app, 'POST', '/v1/workforce/tasks/goals', {
      body: { goal: 'x' },
      headers: auth,
    });
    expect(reserved.status).toBe(400);

    // R7: the goal cap is in BYTES — a >16 KiB multibyte goal is refused at the schema edge (a char
    // cap would let it through and then brick the owner's dispatch).
    const overSizedGoal = await jsonRequest(h.app, 'POST', '/v1/workforce/wf/goals', {
      body: { goal: 'あ'.repeat(6_000) }, // 6000 × 3 bytes = 18_000 bytes > 16_384
      headers: auth,
    });
    expect(overSizedGoal.status).toBe(400);
    const overSizedDesc = await jsonRequest(h.app, 'POST', '/v1/workforce/wf/goals', {
      body: { goal: 'ok', description: 'x'.repeat(16_385) }, // 16_385 bytes > 16_384
      headers: auth,
    });
    expect(overSizedDesc.status).toBe(400);

    // R1: the goals route does not honor Idempotency-Key yet — a supplied key is REFUSED (400),
    // never silently ignored (which would double-bill on a retry after a lost 202).
    const withIdemKey = await jsonRequest(h.app, 'POST', '/v1/workforce/wf/goals', {
      body: { goal: 'Ship it.' },
      headers: { ...auth, 'idempotency-key': 'client-supplied-key-1' },
    });
    expect(withIdemKey.status).toBe(400);
    expect((await withIdemKey.json()).error.message).toContain('Idempotency-Key');

    expect(goalSubmissions).toHaveLength(0); // every refusal above precedes the seam

    const mint = await jsonRequest(h.app, 'POST', `/v1/orgs/${a.orgId}/api-keys`, {
      body: { name: 'read-only', scopes: ['store:read'] },
      headers: auth,
    });
    const key = (await mint.json()).plaintext as string;
    const write = await jsonRequest(h.app, 'POST', '/v1/workforce/wf/goals', {
      body: { goal: 'x' },
      headers: { authorization: `Bearer ${key}` },
    });
    expect(write.status).toBe(403);
    expect((await write.json()).error.details).toEqual({ missing_permission: 'store:write' });
  });

  it('C5: rate-limits repeated goal submissions of the SAME workforce (429 after the quota, before the intake)', async () => {
    const a = await principal('wf-goal-quota@example.test', 'Org WF Goal Quota');
    h.deps.rateLimiter.clearAll(); // deterministic: start the goal-submit bucket empty
    // The default goal-submit quota is 30 per (tenant, workforce) per window — every call mints a
    // fresh billed root run, the cost-DoS the two sibling routes throttle the same way.
    for (let i = 0; i < 30; i += 1) {
      const ok = await jsonRequest(h.app, 'POST', '/v1/workforce/wf/goals', {
        body: { goal: 'Ship it.' },
        headers: { authorization: `Bearer ${a.token}` },
      });
      expect(ok.status).toBe(202);
    }
    const blocked = await jsonRequest(h.app, 'POST', '/v1/workforce/wf/goals', {
      body: { goal: 'Ship it.' },
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).error.code).toBe('RATE_LIMITED');
    expect(goalSubmissions).toHaveLength(30); // the 31st never reached the intake
  });

  // ── the decision doors keep the authorization the engine writes ──────────────────────────────
  //
  // An approval's `approver` and a review's `reviewer` are accountability facts the engine
  // JOURNALS, and the timeout sweep MINTS one when it escalates a hung request to the requester's
  // declared superior. Before this arm, both doors authorized on tenant + `store:write` alone, so
  // any principal in the tenant could resolve a row addressed to someone else and `decided_by` was
  // free to contradict the trail. Every refusal below asserts THE ROW, not just the status code.

  it('a NAMED approver binds the door: the principal the row names decides it', async () => {
    const a = await principal('wf-named-ok@example.test', 'Org WF Named OK');
    // The row names this caller's own SERVER-DERIVED actor string — the only identity the door
    // ever compares against, and one no request body can assert.
    const { approvalId } = await seedPendingApproval(a.orgId, a.actor);
    const res = await jsonRequest(h.app, 'POST', `/v1/workforce/approvals/${approvalId}/decide`, {
      body: { decision: 'approve' },
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(res.status).toBe(200);
    const decided = await res.json();
    expect(decided).toMatchObject({ status: 'approved', decidedBy: a.actor });
  });

  it('a NAMED approver refuses a different principal — 403, and the row is untouched', async () => {
    const a = await principal('wf-named-deny@example.test', 'Org WF Named Deny');
    const { task, approvalId } = await seedPendingApproval(a.orgId, 'ops_lead');
    const res = await jsonRequest(h.app, 'POST', `/v1/workforce/approvals/${approvalId}/decide`, {
      body: { decision: 'approve' },
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
    expect(body.error.details).toMatchObject({ approver: 'ops_lead' });

    // THE ROW: nothing moved, nothing was signed, nothing was journaled, the task is still parked.
    const row = (await h.db.$client.unsafe(
      `SELECT status, decided_by, decided_at FROM workforce_approvals WHERE id = '${approvalId}';`,
    )) as unknown as Array<{ status: string; decided_by: string | null; decided_at: Date | null }>;
    expect(row[0]).toMatchObject({ status: 'pending', decided_by: null, decided_at: null });
    const events = (await h.db.$client.unsafe(
      `SELECT count(*)::int AS c FROM run_events WHERE run_id = '${task.taskId}' AND type = 'workforce.approval.decided';`,
    )) as unknown as Array<{ c: number }>;
    expect(events[0]?.c).toBe(0);
    const parked = (await h.db.$client.unsafe(
      `SELECT status FROM workforce_tasks WHERE task_id = '${task.taskId}';`,
    )) as unknown as Array<{ status: string }>;
    expect(parked[0]?.status).toBe('waiting_for_user');
    expect(kicks).toBe(0); // a refused decision does not nudge the dispatcher either
  });

  it("REGRESSION GUARD: an `approver: 'user'` row stays decidable by any store:write principal", async () => {
    // The shipped posture. `request_approval` hardcodes `approver: 'user'` and the declared grammar
    // admits nothing else, so this is the path every example takes — a user token AND an org-scoped
    // api-key must both keep working exactly as before.
    const a = await principal('wf-sentinel@example.test', 'Org WF Sentinel');
    const first = await seedPendingApproval(a.orgId); // defaults to the 'user' sentinel
    const byUser = await jsonRequest(
      h.app,
      'POST',
      `/v1/workforce/approvals/${first.approvalId}/decide`,
      { body: { decision: 'approve' }, headers: { authorization: `Bearer ${a.token}` } },
    );
    expect(byUser.status).toBe(200);

    const mint = await jsonRequest(h.app, 'POST', `/v1/orgs/${a.orgId}/api-keys`, {
      body: { name: 'writer', scopes: ['store:read', 'store:write'] },
      headers: { authorization: `Bearer ${a.token}` },
    });
    const key = (await mint.json()).plaintext as string;
    const second = await seedPendingApproval(a.orgId);
    const byKey = await jsonRequest(
      h.app,
      'POST',
      `/v1/workforce/approvals/${second.approvalId}/decide`,
      { body: { decision: 'approve' }, headers: { authorization: `Bearer ${key}` } },
    );
    expect(byKey.status).toBe(200);
    expect((await byKey.json()).decidedBy).toMatch(/^api-key:/);
  });

  it('break-glass needs BOTH the asked-for override and the permission — a member gets the named 403', async () => {
    const a = await principal('wf-glass-member@example.test', 'Org WF Glass Member');
    await demoteToMember(a.userId, a.orgId);
    const { approvalId } = await seedPendingApproval(a.orgId, 'ops_lead');
    const res = await jsonRequest(h.app, 'POST', `/v1/workforce/approvals/${approvalId}/decide`, {
      body: { decision: 'approve', override: true },
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(res.status).toBe(403);
    // The gap is named, exactly as the store:write gate names its own.
    expect((await res.json()).error.details).toEqual({
      missing_permission: 'workforce:override',
    });
    const row = (await h.db.$client.unsafe(
      `SELECT status, decided_by FROM workforce_approvals WHERE id = '${approvalId}';`,
    )) as unknown as Array<{ status: string; decided_by: string | null }>;
    expect(row[0]).toMatchObject({ status: 'pending', decided_by: null });
  });

  it('break-glass without ASKING is still refused — holding the permission never overrides silently', async () => {
    const a = await principal('wf-glass-silent@example.test', 'Org WF Glass Silent');
    const { approvalId } = await seedPendingApproval(a.orgId, 'ops_lead');
    // The org creator is an OWNER and so holds `workforce:override`; the request does not ask.
    const res = await jsonRequest(h.app, 'POST', `/v1/workforce/approvals/${approvalId}/decide`, {
      body: { decision: 'approve' },
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error.details).toMatchObject({ approver: 'ops_lead' });
  });

  it('break-glass decides the named row AND the journal records that an override happened', async () => {
    const a = await principal('wf-glass-ok@example.test', 'Org WF Glass OK');
    const { task, approvalId } = await seedPendingApproval(a.orgId, 'ops_lead');
    const res = await jsonRequest(h.app, 'POST', `/v1/workforce/approvals/${approvalId}/decide`, {
      body: {
        decision: 'approve',
        reason: 'ops_lead unreachable; incident bridge',
        override: true,
      },
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'approved', decidedBy: a.actor });
    const events = (await h.db.$client.unsafe(
      `SELECT data FROM run_events WHERE run_id = '${task.taskId}' AND type = 'workforce.approval.decided';`,
    )) as unknown as Array<{ data: Record<string, unknown> }>;
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toMatchObject({
      decidedBy: a.actor,
      overriddenApprover: 'ops_lead',
    });
  });

  it('a MATCHING id in another tenant is still refused — a uniform 404, and the row is untouched', async () => {
    const a = await principal('wf-xt-a@example.test', 'Org WF XT A');
    const b = await principal('wf-xt-b@example.test', 'Org WF XT B');
    // Tenant A's row names tenant B's principal by its exact actor string. Identity matching must
    // never reach across the tenant chokepoint: B gets the uniform not-found, never a decision.
    const { approvalId } = await seedPendingApproval(a.orgId, b.actor);
    const res = await jsonRequest(h.app, 'POST', `/v1/workforce/approvals/${approvalId}/decide`, {
      body: { decision: 'approve' },
      headers: { authorization: `Bearer ${b.token}` },
    });
    expect(res.status).toBe(404);
    // Not even with the override: break-glass is not a tenant escape either.
    const forced = await jsonRequest(
      h.app,
      'POST',
      `/v1/workforce/approvals/${approvalId}/decide`,
      {
        body: { decision: 'approve', override: true },
        headers: { authorization: `Bearer ${b.token}` },
      },
    );
    expect(forced.status).toBe(404);
    const row = (await h.db.$client.unsafe(
      `SELECT status, decided_by FROM workforce_approvals WHERE id = '${approvalId}';`,
    )) as unknown as Array<{ status: string; decided_by: string | null }>;
    expect(row[0]).toMatchObject({ status: 'pending', decided_by: null });
  });

  it('the review verdict door enforces the recorded reviewer the same way', async () => {
    const a = await principal('wf-rev-auth@example.test', 'Org WF Review Auth');

    // named reviewer, different principal → 403, review untouched
    const denied = await seedPendingReview(a.orgId, 'qa');
    const refusal = await jsonRequest(
      h.app,
      'POST',
      `/v1/workforce/reviews/${denied.reviewId}/verdict`,
      { body: { verdict: 'accept' }, headers: { authorization: `Bearer ${a.token}` } },
    );
    expect(refusal.status).toBe(403);
    expect((await refusal.json()).error.details).toMatchObject({ reviewer: 'qa' });
    const undecided = (await h.db.$client.unsafe(
      `SELECT verdict, decided_at FROM workforce_reviews WHERE id = '${denied.reviewId}';`,
    )) as unknown as Array<{ verdict: string | null; decided_at: Date | null }>;
    expect(undecided[0]).toMatchObject({ verdict: null, decided_at: null });
    const held = (await h.db.$client.unsafe(
      `SELECT status FROM workforce_tasks WHERE task_id = '${denied.task.taskId}';`,
    )) as unknown as Array<{ status: string }>;
    expect(held[0]?.status).toBe('waiting_for_review');

    // named reviewer, the principal it names → 200
    const matched = await seedPendingReview(a.orgId, a.actor);
    const ok = await jsonRequest(
      h.app,
      'POST',
      `/v1/workforce/reviews/${matched.reviewId}/verdict`,
      { body: { verdict: 'accept' }, headers: { authorization: `Bearer ${a.token}` } },
    );
    expect(ok.status).toBe(200);

    // break-glass → 200 and the journal says an override happened
    const glass = await seedPendingReview(a.orgId, 'qa');
    const overridden = await jsonRequest(
      h.app,
      'POST',
      `/v1/workforce/reviews/${glass.reviewId}/verdict`,
      {
        body: { verdict: 'accept', override: true },
        headers: { authorization: `Bearer ${a.token}` },
      },
    );
    expect(overridden.status).toBe(200);
    const events = (await h.db.$client.unsafe(
      `SELECT data FROM run_events WHERE run_id = '${glass.task.taskId}' AND type = 'workforce.review.decided';`,
    )) as unknown as Array<{ data: Record<string, unknown> }>;
    expect(events[0]?.data).toMatchObject({
      decidedBy: a.actor,
      reviewer: 'qa',
      overriddenReviewer: 'qa',
    });
  });

  it('a member may NOT break the glass on a review either, and a cross-tenant match is a 404', async () => {
    const a = await principal('wf-rev-member@example.test', 'Org WF Review Member');
    const b = await principal('wf-rev-xt@example.test', 'Org WF Review XT');
    const foreign = await seedPendingReview(a.orgId, b.actor);
    const crossTenant = await jsonRequest(
      h.app,
      'POST',
      `/v1/workforce/reviews/${foreign.reviewId}/verdict`,
      { body: { verdict: 'accept' }, headers: { authorization: `Bearer ${b.token}` } },
    );
    expect(crossTenant.status).toBe(404);

    await demoteToMember(a.userId, a.orgId);
    const named = await seedPendingReview(a.orgId, 'qa');
    const res = await jsonRequest(
      h.app,
      'POST',
      `/v1/workforce/reviews/${named.reviewId}/verdict`,
      {
        body: { verdict: 'accept', override: true },
        headers: { authorization: `Bearer ${a.token}` },
      },
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error.details).toEqual({ missing_permission: 'workforce:override' });
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
    const goals = await jsonRequest(hNo.app, 'POST', '/v1/workforce/wf/goals', {
      body: { goal: 'x' },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(goals.status).toBe(501);
  });
});

describe('/v1/workforce goals with a dispatcher but no declared workforce', () => {
  let hNoIntake: Harness;
  beforeAll(async () => {
    // The engine-only posture: a durable worker dispatches (the control seam is wired) but the
    // document declares no workforce, so no orchestrator seat exists to own a submitted goal.
    hNoIntake = await createHarness({
      workforce: { kick: () => {} },
      schema: 'rayspec_test_workforce_no_intake',
    });
  });
  afterAll(async () => {
    await hNoIntake.close();
  });

  it('fail-closes goal submission with the 501 naming the missing declared workforce', async () => {
    const reg = await jsonRequest(hNoIntake.app, 'POST', '/v1/auth/register', {
      body: { email: 'wf-no-intake@example.test', password: 'a-long-enough-password' },
    });
    const t0 = (await reg.json()).accessToken as string;
    const orgRes = await jsonRequest(hNoIntake.app, 'POST', '/v1/orgs', {
      body: { name: 'Org WF No Intake' },
      headers: { authorization: `Bearer ${t0}` },
    });
    const orgId = (await orgRes.json()).id as string;
    const switchRes = await jsonRequest(hNoIntake.app, 'POST', `/v1/orgs/${orgId}/switch`, {
      headers: { authorization: `Bearer ${t0}` },
    });
    const token = (await switchRes.json()).accessToken as string;
    const res = await jsonRequest(hNoIntake.app, 'POST', '/v1/workforce/wf/goals', {
      body: { goal: 'x' },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(501);
    expect((await res.json()).error.message).toContain('declared workforce');
  });
});
