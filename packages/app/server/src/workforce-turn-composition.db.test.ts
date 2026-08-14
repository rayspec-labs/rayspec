/**
 * The TOOLSET → ENGINE seam against real Postgres — the composition's own fate selection driven end
 * to end, without a backend.
 *
 * Every other toolset suite stops at the collector: it asserts which intent a handler recorded, or
 * which typed error it threw, and never asks what the ENGINE then does with that turn. That gap is
 * where a refusal can look correct at the resolver and still be wrong as a task outcome — a tool
 * that throws past the collector produces no intent at all, the composition yields, and the task
 * re-dispatches into the very same deterministic refusal with a fresh budget every turn.
 *
 * These tests take the real role toolset, call the real handlers, select the turn's intent EXACTLY
 * as `buildWorkforceTurnHandlers` does (the collected intent, else the raw malformed value, else a
 * yield), and hand it to the real `applyTurnOutcome`. The assertions are on durable rows.
 */
import { schema } from '@rayspec/db';
import { deriveWorkforceConfig, WorkforceSpec } from '@rayspec/spec';
import type { TaskRecord } from '@rayspec/tasks';
import {
  applyTransition,
  applyTurnOutcome,
  createRootTask,
  ensureWorkforceRuntime,
  insertChildTask,
  workforceBudgetsSchema,
} from '@rayspec/tasks';
import { forTenant, makeTestDb, resetTaskSchema } from '@rayspec/tasks/test-support';
import {
  buildRoleToolset,
  buildWorkforceSnapshot,
  ManagerTargetForbiddenError,
  TurnCollector,
} from '@rayspec/workforce-tools';
import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (requireDb && !hasDb) {
  throw new Error(
    'workforce-turn-composition.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — refusing to silently skip.',
  );
}

const TENANT = '00000000-0000-4000-8000-0000000000c1';
const NO_BUDGETS = workforceBudgetsSchema.parse({});

/** lead (orchestrator) → mgr (manager of eng, lead of fix_team) → dev, qa. */
const DECLARED = WorkforceSpec.parse({
  id: 'helpdesk',
  name: 'Helpdesk',
  orchestrator: 'lead',
  departments: [
    { id: 'eng', name: 'Engineering', manager: 'mgr', mission: 'Own it.', members: ['dev'] },
  ],
  employees: [
    { id: 'lead', agent: 'a', title: 'Lead', role: 'orchestrator' },
    { id: 'mgr', agent: 'a', title: 'M', department: 'eng', reportsTo: 'lead', role: 'manager' },
    { id: 'dev', agent: 'a', title: 'D', department: 'eng', role: 'worker' },
    { id: 'qa', agent: 'a', title: 'Q', reportsTo: 'lead', role: 'reviewer' },
  ],
  teams: [{ id: 'fix_team', lead: 'mgr', members: ['dev', 'qa'], maxSize: 3 }],
});

const config = deriveWorkforceConfig(DECLARED);

describe.skipIf(!hasDb)('the toolset → engine seam (db)', () => {
  let db: ReturnType<typeof makeTestDb>;

  beforeAll(async () => {
    db = makeTestDb();
    await resetTaskSchema(db);
    return async () => {
      await db.$client.end();
    };
  });

  beforeEach(async () => {
    await db.$client.unsafe(
      'TRUNCATE workforce_tasks, workforce_task_transitions, workforce_task_signals, workforce_delegations, workforce_approvals, workforce_reviews, workforce_messages, workforce_budget_ledger, workforce_runtime, run_events CASCADE;',
    );
    await db.$client.unsafe(
      `INSERT INTO orgs (id, name) VALUES ('${TENANT}', 'turn-composition-test') ON CONFLICT DO NOTHING;`,
    );
    // The orchestrator's snapshot reads the workforce runtime row (`get_workforce_state`), which
    // boot writes — the dispatcher never runs without it.
    await ensureWorkforceRuntime(tdb(), 'helpdesk', {});
  });

  const tdb = () => forTenant(db, TENANT);
  const turnIdFor = (taskId: string, turnNumber: number) => `wf-task-turn:${taskId}:${turnNumber}`;

  /** A root owned by `lead` with one child owned by `owner`, driven to `working`. */
  async function workingChildOf(owner: string): Promise<TaskRecord> {
    const root = await createRootTask(tdb(), {
      workforceId: 'helpdesk',
      title: 'Root',
      goal: 'Coordinate.',
      owner: 'lead',
      requestedBy: 'user',
    });
    const child = await tdb().transaction(async (tx) =>
      insertChildTask(tx, root, 1, 0, {
        title: 'Slice',
        goal: 'Handle the slice.',
        owner,
        department: config.employees.get(owner)?.department ?? null,
      }),
    );
    const queued = await applyTransition(tdb(), {
      taskId: child.taskId,
      expectedVersion: child.version,
      to: 'queued',
      actor: 'scheduler',
    });
    return applyTransition(tdb(), {
      taskId: child.taskId,
      expectedVersion: queued.version,
      to: 'working',
      actor: 'scheduler',
      turnId: turnIdFor(child.taskId, 1),
    });
  }

  /**
   * Run one turn: build the real toolset, invoke `call`, then apply the collected outcome the way
   * `buildWorkforceTurnHandlers` selects it — collected intent, else the raw malformed value, else
   * a yield. A handler throw is caught here exactly as the dispatch chokepoint catches it (the
   * model sees a tool error; the turn is never killed by it).
   */
  async function runTurn(
    task: TaskRecord,
    call: (invoke: (name: string, args: unknown) => unknown) => void,
  ) {
    const employee = config.employees.get(task.owner);
    if (!employee) throw new Error(`no declared employee '${task.owner}'`);
    const snapshot = await buildWorkforceSnapshot(tdb(), config, task, employee);
    const collector = new TurnCollector({
      tenantId: TENANT,
      taskId: task.taskId,
      turnNumber: task.turnsUsed + 1,
    });
    const tools = buildRoleToolset({ employee, config, task, snapshot, collector });
    const invoke = (name: string, args: unknown) => {
      const tool = tools.find((t) => t.spec.name === name);
      if (!tool) throw new Error(`tool '${name}' is not offered to '${employee.id}'`);
      return tool.handler(args, new AbortController().signal);
    };
    let thrown: unknown = null;
    try {
      call(invoke);
    } catch (err) {
      thrown = err;
    }
    const collected = collector.finish();
    const intent =
      collected.intent ??
      (collected.malformed !== null ? collected.malformed.raw : { kind: 'yield' });
    const outcome = await applyTurnOutcome(tdb(), {
      taskId: task.taskId,
      turnId: turnIdFor(task.taskId, task.turnsUsed + 1),
      turnNumber: task.turnsUsed + 1,
      intent,
      ...(collected.messages.length > 0 ? { messages: collected.messages } : {}),
      ...(collected.createdChildren.length > 0
        ? { createdChildren: collected.createdChildren }
        : {}),
      budgets: NO_BUDGETS,
    });
    return { outcome, thrown, collected };
  }

  async function rowsUnder(parentTaskId: string) {
    return db.$client.unsafe(
      `SELECT count(*)::int AS children,
              (SELECT count(*)::int FROM workforce_delegations WHERE parent_task_id = '${parentTaskId}') AS delegations
         FROM workforce_tasks WHERE parent_task_id = '${parentTaskId}';`,
    );
  }

  it('a manager’s `team:` delegation is refused at the tool and lands on the tool-error fate', async () => {
    const task = await workingChildOf('mgr');
    // `fix_team` is led BY mgr. This used to resolve to mgr themselves, reach the engine as a
    // fan_out, and be refused there as `self_delegation` — recording a REJECTED delegation row for
    // a child nobody asked for, and costing a turn to discover a refusal the resolver already knew.
    const { outcome, thrown } = await runTurn(task, (invoke) => {
      invoke('delegate_task', {
        tasks: [{ target: 'team:fix_team', title: 'Fix', goal: 'Fix it.' }],
      });
    });
    expect(thrown).toBeInstanceOf(ManagerTargetForbiddenError);
    expect(outcome.plan?.kind).toBe('invalid_intent');
    expect(outcome.task).toMatchObject({ status: 'queued', statusReason: 'tool_error' });
    expect((await rowsUnder(task.taskId))[0]).toEqual({ children: 0, delegations: 0 });
  });

  it('the ORCHESTRATOR’s `team:` delegation still opens one child owned by the team lead', async () => {
    const root = await createRootTask(tdb(), {
      workforceId: 'helpdesk',
      title: 'Root',
      goal: 'Coordinate.',
      owner: 'lead',
      requestedBy: 'user',
    });
    const queued = await applyTransition(tdb(), {
      taskId: root.taskId,
      expectedVersion: root.version,
      to: 'queued',
      actor: 'scheduler',
    });
    const working = await applyTransition(tdb(), {
      taskId: root.taskId,
      expectedVersion: queued.version,
      to: 'working',
      actor: 'scheduler',
      turnId: turnIdFor(root.taskId, 1),
    });
    const { outcome, thrown } = await runTurn(working, (invoke) => {
      invoke('delegate_task', {
        tasks: [{ target: 'team:fix_team', title: 'Fix', goal: 'Fix it.' }],
      });
    });
    expect(thrown).toBeNull();
    expect(outcome.plan?.kind).toBe('fan_out');
    expect(outcome.task).toMatchObject({ status: 'blocked', statusReason: 'awaiting_children' });
    const delegations = (await db.$client.unsafe(
      `SELECT delegated_to, resolved_owner, status FROM workforce_delegations WHERE parent_task_id = '${root.taskId}';`,
    )) as unknown as { delegated_to: string; resolved_owner: string; status: string }[];
    expect(delegations).toEqual([
      { delegated_to: 'team:fix_team', resolved_owner: 'mgr', status: 'accepted' },
    ]);
  });

  it('a manager’s delegation into another department is refused the same way', async () => {
    const task = await workingChildOf('mgr');
    const { outcome, thrown } = await runTurn(task, (invoke) => {
      invoke('delegate_task', {
        tasks: [{ target: 'employee:qa', title: 'Ask', goal: 'Ask qa.' }],
      });
    });
    // `qa` is a member of the team mgr LEADS, but this task is not that team's work — the
    // delegation chain records no `team:` target — so the grant does not exist here and the
    // refusal is the same one another department gets. Teams are cross-functional; an unscoped
    // led-team grant was unbounded cross-department delegation from any task at all.
    expect(thrown).toBeInstanceOf(ManagerTargetForbiddenError);
    expect(outcome.plan?.kind).toBe('invalid_intent');

    const other = await workingChildOf('mgr');
    const refused = await runTurn(other, (invoke) => {
      invoke('delegate_task', {
        tasks: [{ target: 'employee:lead', title: 'Up', goal: 'Hand upward.' }],
      });
    });
    expect(refused.thrown).toBeInstanceOf(ManagerTargetForbiddenError);
    expect(refused.outcome.task).toMatchObject({ status: 'queued', statusReason: 'tool_error' });
    expect((await rowsUnder(other.taskId))[0]).toEqual({ children: 0, delegations: 0 });
  });

  it('a review park does not corrupt a SIBLING owned by the same reviewer', async () => {
    // The parent parks on a review decided by `qa`. A sibling task under that same parent, also
    // owned by `qa`, is NOT the review child — and `pendingReview` used to be a "newest undecided
    // review for this parent" scan, which said it was: the sibling lost `request_review` entirely
    // and was offered `submit_review` against a review row that is not its own to decide.
    const root = await createRootTask(tdb(), {
      workforceId: 'helpdesk',
      title: 'Root',
      goal: 'Coordinate.',
      owner: 'lead',
      requestedBy: 'user',
    });
    const reviewed = await tdb().transaction(async (tx) =>
      insertChildTask(tx, root, 1, 0, { title: 'Reviewed', goal: 'G', owner: 'dev' }),
    );
    const queued = await applyTransition(tdb(), {
      taskId: reviewed.taskId,
      expectedVersion: reviewed.version,
      to: 'queued',
      actor: 'scheduler',
    });
    const working = await applyTransition(tdb(), {
      taskId: reviewed.taskId,
      expectedVersion: queued.version,
      to: 'working',
      actor: 'scheduler',
      turnId: turnIdFor(reviewed.taskId, 1),
    });
    await applyTurnOutcome(tdb(), {
      taskId: working.taskId,
      turnId: turnIdFor(working.taskId, 1),
      turnNumber: 1,
      intent: {
        kind: 'complete',
        result: { status: 'completed', summary: 'Done.', confidence: 0.6 },
      },
      reviewPolicy: { reviewer: 'qa', dispatchReviewer: true, maxRounds: 2 },
      budgets: NO_BUDGETS,
    });
    const children = (await db.$client.unsafe(
      `SELECT task_id, owner FROM workforce_tasks WHERE parent_task_id = '${working.taskId}';`,
    )) as unknown as { task_id: string; owner: string }[];
    const reviewChild = children.find((c) => c.owner === 'qa') as { task_id: string };

    // A SIBLING under the reviewed task, owned by the same reviewer, doing ordinary work.
    const sibling = await tdb().transaction(async (tx) =>
      insertChildTask(tx, working, 1, 5, { title: 'Sibling work', goal: 'G', owner: 'qa' }),
    );
    const qa = config.employees.get('qa');
    if (!qa) throw new Error('fixture');
    const siblingSnapshot = await buildWorkforceSnapshot(tdb(), config, sibling, qa);
    expect(siblingSnapshot.pendingReview).toBeNull();
    const siblingTools = buildRoleToolset({
      employee: qa,
      config,
      task: sibling,
      snapshot: siblingSnapshot,
      collector: new TurnCollector({
        tenantId: TENANT,
        taskId: sibling.taskId,
        turnNumber: 1,
      }),
    }).map((t) => t.spec.name);
    expect(siblingTools).toContain('request_review');
    // `submit_review` stays on the role table's terms, and refuses fail-closed: with no review
    // assigned to THIS task there is no reviewId to inject, and the sibling cannot reach the
    // reviewed task's park.
    const siblingCollector = new TurnCollector({
      tenantId: TENANT,
      taskId: sibling.taskId,
      turnNumber: 1,
    });
    const siblingSubmit = buildRoleToolset({
      employee: qa,
      config,
      task: sibling,
      snapshot: siblingSnapshot,
      collector: siblingCollector,
    }).find((t) => t.spec.name === 'submit_review');
    expect(() =>
      siblingSubmit?.handler({ verdict: 'accept' }, new AbortController().signal),
    ).toThrow(/no pending review targets this task/);
    expect(siblingCollector.finish().intent).toBeNull();

    // The REAL review child still sees its own review, by the binding.
    const reviewTask = (
      (await tdb()
        .select(schema.workforceTasks)
        .where(eq(schema.workforceTasks.taskId, reviewChild.task_id))) as TaskRecord[]
    )[0] as TaskRecord;
    const reviewSnapshot = await buildWorkforceSnapshot(tdb(), config, reviewTask, qa);
    expect(reviewSnapshot.pendingReview).not.toBeNull();
    const reviewTools = buildRoleToolset({
      employee: qa,
      config,
      task: reviewTask,
      snapshot: reviewSnapshot,
      collector: new TurnCollector({
        tenantId: TENANT,
        taskId: reviewTask.taskId,
        turnNumber: 1,
      }),
    }).map((t) => t.spec.name);
    expect(reviewTools).toContain('submit_review');
    expect(reviewTools).not.toContain('request_review');
    expect(reviewSnapshot.pendingReview?.round).toBe(1);
  });

  it('a manager’s buffered sub-task to an ancestor owner is refused by the engine as a cycle', async () => {
    // The toolset resolves `employee:dev` legally (own department), but the ENGINE sees that the
    // owner already owns an ancestor task — the check the buffered path used to skip entirely.
    const root = await createRootTask(tdb(), {
      workforceId: 'helpdesk',
      title: 'Root',
      goal: 'Coordinate.',
      owner: 'dev',
      requestedBy: 'user',
    });
    const child = await tdb().transaction(async (tx) =>
      insertChildTask(tx, root, 1, 0, { title: 'Slice', goal: 'Slice.', owner: 'mgr' }),
    );
    const queued = await applyTransition(tdb(), {
      taskId: child.taskId,
      expectedVersion: child.version,
      to: 'queued',
      actor: 'scheduler',
    });
    const working = await applyTransition(tdb(), {
      taskId: child.taskId,
      expectedVersion: queued.version,
      to: 'working',
      actor: 'scheduler',
      turnId: turnIdFor(child.taskId, 1),
    });
    const { outcome } = await runTurn(working, (invoke) => {
      invoke('create_subtask', { target: 'employee:dev', title: 'Back', goal: 'Back to dev.' });
      invoke('submit_result', {
        status: 'completed',
        summary: 'Handed back.',
        confidence: 0.9,
      });
    });
    expect(outcome.plan).toMatchObject({
      kind: 'delegation_rejected',
      reason: 'delegation_cycle',
    });
    expect((await rowsUnder(working.taskId))[0]).toEqual({ children: 0, delegations: 0 });
  });
});
