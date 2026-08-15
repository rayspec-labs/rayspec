/**
 * THE FULL TURN CHAIN — scripted backend → the real `dispatchTool` chokepoint → the real toolset
 * handlers and collector → the real composition → the real engine, against real Postgres.
 *
 * This is the only suite that drives `buildWorkforceTurnHandlers` itself, and it exists because the
 * gap it covers is invisible one layer up OR one layer down. The toolset suites call handlers
 * directly, so they never exercise the chokepoint's validate-in; the engine suites hand
 * `applyTurnOutcome` an intent that a composition already chose, so they never ask WHICH intent a
 * turn's raw tool arguments become. Between those two, model-controlled bytes were reaching the
 * engine as a trusted turn intent:
 *
 *   `submit_result({kind:'complete', result:{…}})` — wrong arguments to the right tool — failed the
 *   toolset's schema, was recorded as a malformed ending, and the RAW value was forwarded. The
 *   engine then parsed a perfectly valid `complete` intent out of exactly those bytes, while the
 *   review-policy match (which keys on the intent the TOOLSET collected, and there was none) passed
 *   null. A mandatory review policy was skipped, and the task completed.
 *
 * Every assertion below reads durable rows.
 */
import type { AgentRegistry, AgentRegistryEntry } from '@rayspec/api-auth';
import type { Backend } from '@rayspec/core';
import { deriveWorkforceConfig, WorkforceSpec } from '@rayspec/spec';
import type { TaskRecord } from '@rayspec/tasks';
import {
  applyTransition,
  applyTurnOutcome,
  createRootTask,
  ensureWorkforceRuntime,
  workforceBudgetsSchema,
} from '@rayspec/tasks';
import { forTenant, makeTestDb, resetTaskSchema } from '@rayspec/tasks/test-support';
import { makeScriptedBackend, type TurnScript } from '@rayspec/workforce-tools/testing';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildWorkforceTurnHandlers } from './workforce-turn-handlers.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (requireDb && !hasDb) {
  throw new Error(
    'workforce-turn-validation.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — refusing to silently skip.',
  );
}

const TENANT = '00000000-0000-4000-8000-0000000000d1';
const NO_BUDGETS = workforceBudgetsSchema.parse({});

/** dev is covered by a review policy demanding review below 0.75 confidence. */
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
  reviewPolicies: [
    {
      id: 'eng_quality',
      appliesTo: { department: 'eng' },
      reviewer: 'qa',
      requireWhen: { confidenceBelow: 0.75 },
      onReject: 'rework',
      maxRounds: 2,
    },
  ],
});

const config = deriveWorkforceConfig(DECLARED);

describe.skipIf(!hasDb)('the turn chain: dispatch validate-in → composition → engine (db)', () => {
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
      'TRUNCATE workforce_tasks, workforce_task_transitions, workforce_task_signals, workforce_delegations, workforce_approvals, workforce_reviews, workforce_messages, workforce_budget_ledger, workforce_runtime, run_events, runs CASCADE;',
    );
    await db.$client.unsafe(
      `INSERT INTO orgs (id, name) VALUES ('${TENANT}', 'turn-validation-test') ON CONFLICT DO NOTHING;`,
    );
    await ensureWorkforceRuntime(forTenant(db, TENANT), 'helpdesk', {});
  });

  const tdb = () => forTenant(db, TENANT);
  const turnIdFor = (taskId: string, n: number) => `wf-task-turn:${taskId}:${n}`;

  /** A registry whose single agent runs on the scripted backend the test supplies. */
  function registryFor(backend: Backend): AgentRegistry {
    const entry: AgentRegistryEntry = {
      spec: { name: 'a', instructions: 'Do the work.', model: 'model-x', input: '', tools: [] },
      backend,
      tools: [],
    };
    return new Map<string, AgentRegistryEntry>([['a', entry]]) as unknown as AgentRegistry;
  }

  /** Run ONE turn of `task` through the real composition, then apply its outcome to the engine. */
  async function runTurn(task: TaskRecord, script: TurnScript) {
    const backend = makeScriptedBackend('openai', () => script);
    const resolve = buildWorkforceTurnHandlers({
      db,
      tenantId: TENANT,
      config,
      registry: () => registryFor(backend),
      backendForEmployee: () => backend,
    });
    const handler = resolve(task.owner);
    if (!handler) throw new Error(`no handler for owner '${task.owner}'`);
    const outcome = await handler({ task, childResults: null, signals: [], messages: [] });
    const applied = await applyTurnOutcome(tdb(), {
      taskId: task.taskId,
      turnId: turnIdFor(task.taskId, task.turnsUsed + 1),
      turnNumber: task.turnsUsed + 1,
      intent: outcome.intent,
      ...(outcome.messages ? { messages: outcome.messages } : {}),
      ...(outcome.createdChildren ? { createdChildren: outcome.createdChildren } : {}),
      ...(outcome.reviewPolicy ? { reviewPolicy: outcome.reviewPolicy } : {}),
      ...(outcome.classification ? { classification: outcome.classification } : {}),
      budgets: NO_BUDGETS,
    });
    return { outcome, applied };
  }

  /** The newest turn_ended journal payload for a task — where classification lands. */
  async function turnEndedPayload(taskId: string): Promise<Record<string, unknown>> {
    const rows = (await db.$client.unsafe(
      `SELECT data FROM run_events WHERE run_id = '${taskId}' AND type = 'workforce.task.turn_ended'
       ORDER BY seq::numeric DESC LIMIT 1;`,
    )) as unknown as Array<{ data: Record<string, unknown> }>;
    return (rows[0] as { data: Record<string, unknown> }).data;
  }

  async function workingTaskFor(owner: string): Promise<TaskRecord> {
    const root = await createRootTask(tdb(), {
      workforceId: 'helpdesk',
      title: 'Ship the slice',
      goal: 'Do the work.',
      owner,
      requestedBy: 'user',
      department: config.employees.get(owner)?.department ?? null,
    });
    const queued = await applyTransition(tdb(), {
      taskId: root.taskId,
      expectedVersion: root.version,
      to: 'queued',
      actor: 'scheduler',
    });
    return applyTransition(tdb(), {
      taskId: root.taskId,
      expectedVersion: queued.version,
      to: 'working',
      actor: 'scheduler',
      turnId: turnIdFor(root.taskId, 1),
    });
  }

  async function rowOf(taskId: string) {
    const rows = (await db.$client.unsafe(
      `SELECT status, status_reason, result FROM workforce_tasks WHERE task_id = '${taskId}';`,
    )) as unknown as { status: string; status_reason: string | null; result: unknown }[];
    return rows[0] as { status: string; status_reason: string | null; result: unknown };
  }

  it('wrong arguments to submit_result NEVER become a completion — the review policy is not skipped', async () => {
    const task = await workingTaskFor('dev');
    // The traced chain. These arguments are a valid `complete` INTENT and an invalid
    // `submit_result` ARGUMENT object — the whole point. The engine used to read the intent out of
    // them and complete the task, with no policy matched because the toolset collected nothing.
    const { outcome, applied } = await runTurn(task, [
      {
        name: 'submit_result',
        args: {
          kind: 'complete',
          result: { status: 'completed', summary: 'Slipped past review.', confidence: 0.1 },
        },
      },
    ]);
    // The engine never sees model bytes: the composition forwards the typed sentinel.
    expect(outcome.intent).toEqual({ kind: 'malformed_turn_ending' });
    expect(applied.plan?.kind).toBe('invalid_intent');
    const row = await rowOf(task.taskId);
    expect(row).toMatchObject({ status: 'queued', status_reason: 'tool_error' });
    expect(row.result).toBeNull();
    // Nothing completed, so nothing escaped review — and no review row was opened either.
    const reviews = await db.$client.unsafe(
      `SELECT count(*)::int AS c FROM workforce_reviews WHERE task_id = '${task.taskId}';`,
    );
    expect(reviews[0]?.c).toBe(0);
  });

  it('the SAME policy still intercepts a well-formed low-confidence submission', async () => {
    // The other half of the claim: the policy path is intact, so the test above is about the
    // bypass and not about a review mechanism that stopped firing.
    const task = await workingTaskFor('dev');
    const { outcome, applied } = await runTurn(task, [
      {
        name: 'submit_result',
        args: { status: 'completed', summary: 'Backend slice done.', confidence: 0.4 },
      },
    ]);
    expect(outcome.reviewPolicy).toMatchObject({ reviewer: 'qa', dispatchReviewer: true });
    expect(applied.plan?.kind).toBe('complete_with_review');
    expect(await rowOf(task.taskId)).toMatchObject({
      status: 'waiting_for_review',
      status_reason: 'review_pending',
    });
  });

  it('a high-confidence submission completes normally — the chain is not simply refusing', async () => {
    const task = await workingTaskFor('dev');
    const { applied } = await runTurn(task, [
      {
        name: 'submit_result',
        args: { status: 'completed', summary: 'Well above the bar.', confidence: 0.95 },
      },
    ]);
    expect(applied.plan?.kind).toBe('complete');
    expect(await rowOf(task.taskId)).toMatchObject({ status: 'completed' });
  });

  it('a forged escalateTo cannot ride in through the tool arguments', async () => {
    // `escalate.escalateTo` is documented as resolved by the trusted layer from the declared
    // reporting edge, "never a model-supplied guess". The extra key is refused at the chokepoint,
    // and the turn takes the fate rather than handing the engine a target the model chose.
    const task = await workingTaskFor('dev');
    const { outcome, applied } = await runTurn(task, [
      { name: 'escalate', args: { reason: 'risk', escalateTo: 'lead' } },
    ]);
    expect(outcome.intent).toEqual({ kind: 'malformed_turn_ending' });
    expect(applied.plan?.kind).toBe('invalid_intent');
    expect(await rowOf(task.taskId)).toMatchObject({
      status: 'queued',
      status_reason: 'tool_error',
    });
    // No escalation child was opened to a target the model named.
    const children = await db.$client.unsafe(
      `SELECT count(*)::int AS c FROM workforce_tasks WHERE parent_task_id = '${task.taskId}';`,
    );
    expect(children[0]?.c).toBe(0);
    // The well-formed call resolves the target from the declared edge instead.
    const second = await workingTaskFor('dev');
    const ok = await runTurn(second, [{ name: 'escalate', args: { reason: 'risk' } }]);
    expect(ok.applied.plan).toMatchObject({ kind: 'escalate', escalateTo: 'mgr' });
  });

  it('the SAME refusal takes the fate on an MCP-PREFIXED transcript (the Anthropic shape)', async () => {
    // The transcript check is the only record of an ending the chokepoint refused before the
    // handler — and the adapters do not agree on the name they record. OpenAI, Codex and pi report
    // the neutral name; the Anthropic adapter bridges the toolset as an in-process MCP server and
    // keeps `mcp__rayspec__<tool>` verbatim. Testing bare names alone left the fate open on exactly
    // the flagship adapter: the refused ending degraded to a yield, and the deterministic
    // free-retry loop the requeue-once-then-fail fate exists to bound ran unbounded.
    const task = await workingTaskFor('dev');
    const { outcome, applied } = await runTurn(task, [
      {
        name: 'submit_result',
        recordedName: 'mcp__rayspec__submit_result',
        args: {
          kind: 'complete',
          result: { status: 'completed', summary: 'Slipped past review.', confidence: 0.1 },
        },
      },
    ]);
    expect(outcome.intent).toEqual({ kind: 'malformed_turn_ending' });
    expect(applied.plan?.kind).toBe('invalid_intent');
    expect(await rowOf(task.taskId)).toMatchObject({
      status: 'queued',
      status_reason: 'tool_error',
    });
  });

  it('a PREFIXED read tool still yields — normalization did not make every call an ending', async () => {
    const task = await workingTaskFor('dev');
    const { outcome, applied } = await runTurn(task, [
      { name: 'get_task', recordedName: 'mcp__rayspec__get_task', args: {} },
    ]);
    expect(outcome.intent).toEqual({ kind: 'yield' });
    expect(applied.plan?.kind).toBe('yield');
  });

  it('a run that ends no turn still yields — the fate is for endings that were ATTEMPTED', async () => {
    const task = await workingTaskFor('dev');
    const { outcome, applied } = await runTurn(task, [{ name: 'get_task', args: {} }]);
    expect(outcome.intent).toEqual({ kind: 'yield' });
    expect(applied.plan?.kind).toBe('yield');
    expect(await rowOf(task.taskId)).toMatchObject({ status: 'queued' });
  });

  it('journals each decision class from the TYPED intent: direct, delegate, team, review, escalate', async () => {
    // Every class through the REAL chain — scripted call → chokepoint → toolset → composition →
    // engine — asserted on the turn_ended journal row, never on prose.
    const direct = await workingTaskFor('lead');
    await runTurn(direct, [
      {
        name: 'submit_result',
        args: { status: 'completed', summary: 'Answered directly.', confidence: 0.9 },
      },
    ]);
    expect(await turnEndedPayload(direct.taskId)).toMatchObject({
      outcome: 'complete',
      classification: 'direct',
    });

    const delegate = await workingTaskFor('lead');
    await runTurn(delegate, [
      {
        name: 'delegate_task',
        args: {
          tasks: [{ target: 'department:eng', title: 'Engineering stream', goal: 'Own it.' }],
        },
      },
    ]);
    expect(await turnEndedPayload(delegate.taskId)).toMatchObject({
      outcome: 'fan_out',
      classification: 'delegate',
    });

    const team = await workingTaskFor('lead');
    await runTurn(team, [
      {
        name: 'delegate_task',
        args: { tasks: [{ target: 'team:fix_team', title: 'Team stream', goal: 'Fix it.' }] },
      },
    ]);
    expect(await turnEndedPayload(team.taskId)).toMatchObject({
      outcome: 'fan_out',
      classification: 'team',
    });

    // The review class rides the MANAGER seat: the declared eng policy names 'qa' as a reviewer
    // the manager may reach (the orchestrator seat is covered by no policy and reports to no one).
    const review = await workingTaskFor('mgr');
    await runTurn(review, [{ name: 'request_review', args: { reviewer: 'qa' } }]);
    expect(await turnEndedPayload(review.taskId)).toMatchObject({
      outcome: 'request_review_dispatch',
      classification: 'review',
    });

    const escalate = await workingTaskFor('lead');
    await runTurn(escalate, [
      { name: 'request_approval', args: { question: 'May the announcement ship?' } },
    ]);
    expect(await turnEndedPayload(escalate.taskId)).toMatchObject({
      outcome: 'request_approval',
      classification: 'escalate',
    });
  });

  it('a worker completion journals NO classification — the field belongs to decision seats', async () => {
    const task = await workingTaskFor('dev');
    await runTurn(task, [
      {
        name: 'submit_result',
        args: { status: 'completed', summary: 'Just the work.', confidence: 0.95 },
      },
    ]);
    const payload = await turnEndedPayload(task.taskId);
    expect(payload).toMatchObject({ outcome: 'complete' });
    expect('classification' in payload).toBe(false);
  });

  it('POLICY OVERRIDES CLASSIFICATION: the journal records the direct decision AND the enforced review', async () => {
    // The manager decides `direct` (a completion); the declared rule fires anyway. The journal
    // carries both facts — what the seat chose, and that the engine routed it to review no
    // matter what the turn submitted.
    const task = await workingTaskFor('mgr');
    const { applied } = await runTurn(task, [
      {
        name: 'submit_result',
        args: { status: 'completed', summary: 'The department half.', confidence: 0.5 },
      },
    ]);
    expect(applied.plan?.kind).toBe('complete_with_review');
    expect(await rowOf(task.taskId)).toMatchObject({
      status: 'waiting_for_review',
      status_reason: 'review_pending',
    });
    expect(await turnEndedPayload(task.taskId)).toMatchObject({
      outcome: 'complete_with_review',
      classification: 'direct',
    });
  });

  it('a refused ending journals NO classification — model bytes never classify anything', async () => {
    const task = await workingTaskFor('lead');
    await runTurn(task, [
      { name: 'submit_result', args: { kind: 'complete', result: { summary: 'forged' } } },
    ]);
    const payload = await turnEndedPayload(task.taskId);
    expect(payload).toMatchObject({ outcome: 'invalid_intent' });
    expect('classification' in payload).toBe(false);
  });

  it('an unbounded hand-off goal is refused at the schema — the context-stuffing channel is capped', async () => {
    // The message-body rationale one channel over: a delegated goal renders verbatim (and
    // untrimmably) into the child's turn input, so the cap must hold at the hand-off itself.
    const task = await workingTaskFor('lead');
    const { outcome, applied } = await runTurn(task, [
      {
        name: 'delegate_task',
        args: {
          tasks: [{ target: 'department:eng', title: 'Stuffed', goal: 'g'.repeat(16_385) }],
        },
      },
    ]);
    expect(outcome.intent).toEqual({ kind: 'malformed_turn_ending' });
    expect(applied.plan?.kind).toBe('invalid_intent');
    const children = await db.$client.unsafe(
      `SELECT count(*)::int AS c FROM workforce_tasks WHERE parent_task_id = '${task.taskId}';`,
    );
    expect(children[0]?.c).toBe(0); // nothing was minted from the oversized hand-off
  });

  it('the ENGINE suppresses a classification beside an intent it refused — no caller can journal a decision that never was', async () => {
    const task = await workingTaskFor('lead');
    await applyTurnOutcome(tdb(), {
      taskId: task.taskId,
      turnId: turnIdFor(task.taskId, 1),
      turnNumber: 1,
      intent: { kind: 'complete', result: { forged: true } }, // fails the engine's own parse
      classification: 'direct', // a buggy embedder's channel — shipped compositions never do this
      budgets: NO_BUDGETS,
    });
    const payload = await turnEndedPayload(task.taskId);
    expect(payload).toMatchObject({ outcome: 'invalid_intent' });
    expect('classification' in payload).toBe(false);
  });

  it('assembles the sectioned turn input: facts as data, recall stamped, bounded bytes', async () => {
    // Seed PRIOR completed work for dev, then capture what the model would actually see.
    const prior = await workingTaskFor('dev');
    await runTurn(prior, [
      {
        name: 'submit_result',
        args: {
          status: 'completed',
          summary: 'Instrumented the onboarding funnel end to end.',
          confidence: 0.9,
        },
      },
    ]);

    const inputs: string[] = [];
    const backend = makeScriptedBackend('openai', (spec) => {
      inputs.push(spec.input);
      return [
        {
          name: 'submit_result',
          args: { status: 'completed', summary: 'Done.', confidence: 0.9 },
        },
      ];
    });
    const resolve = buildWorkforceTurnHandlers({
      db,
      tenantId: TENANT,
      config,
      registry: () => registryFor(backend),
      backendForEmployee: () => backend,
    });
    const task = await workingTaskFor('dev');
    const handler = resolve('dev');
    if (!handler) throw new Error('no handler');
    const outcome = await handler({
      task: { ...task, goal: 'Analyze the onboarding funnel.' },
      childResults: null,
      signals: [],
      messages: [],
    });
    expect(outcome.intent).toMatchObject({ kind: 'complete' });

    const rendered = inputs[0] as string;
    expect(rendered.startsWith("You are 'dev' (D), role 'worker'.")).toBe(true);
    expect(rendered).toContain('## 1. Identity');
    expect(rendered).toContain('## 3. Policies in force');
    // The declared review rule is stated as an enforced fact, through the same predicate the
    // engine matches with — the prompt can never contradict the policy.
    expect(rendered).toContain("eng_quality: reviewer 'qa'");
    expect(rendered).toContain('fires on a submitted confidence below 0.75');
    // Recall landed as section 7, stamped with the prior task's id and age.
    expect(rendered).toContain('## 7. Recall');
    expect(rendered).toContain(`[${prior.taskId} · <1h] Instrumented the onboarding funnel`);
    expect(Buffer.byteLength(rendered, 'utf8')).toBeLessThanOrEqual(65_536);

    // The orchestrator's frame states the workforce shape and its legal targets as facts.
    const leadTask = await workingTaskFor('lead');
    const leadHandler = resolve('lead');
    if (!leadHandler) throw new Error('no handler');
    await leadHandler({ task: leadTask, childResults: null, signals: [], messages: [] });
    const leadRendered = inputs[1] as string;
    expect(leadRendered).toContain('Workforce: Helpdesk.');
    expect(leadRendered).toContain('- eng (Engineering): Own it.');
    expect(leadRendered).toContain(
      'Legal delegation targets: department:eng, team:fix_team, employee:mgr, employee:dev, employee:qa.',
    );
  });
});
