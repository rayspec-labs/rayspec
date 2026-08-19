/**
 * The toolset's SEMANTIC rules, driven through the REAL handlers: exactly-one-turn-ending (the
 * second call is the typed already-ended error and the first intent stands), malformed turn-ending
 * arguments record the malformed marker (the engine's requeue-once-then-fail fate rides on it),
 * delegation-target resolution + the manager restriction, escalation target resolution from the
 * reporting edge, reviewId injection from the snapshot (never from arguments), buffered creates
 * returning deterministic ids, and read-tool visibility.
 */
import type { WorkforceConfig, WorkforceEmployeeConfig } from '@rayspec/spec';
import { deterministicChildTaskId, workerResultSchema } from '@rayspec/tasks';
import { describe, expect, it } from 'vitest';
import { TurnCollector } from './collector.js';
import {
  ApprovalAlreadyResolvedError,
  ApprovalEscalationTargetMissingError,
  DelegationTargetInvalidError,
  ManagerTargetForbiddenError,
  TaskNotVisibleError,
  TurnAlreadyEndedError,
  WorkforceToolError,
} from './errors.js';
import {
  assertManagerMayTarget,
  parseDelegationTarget,
  resolveDelegationTarget,
} from './resolve-target.js';
import { matchReviewPolicy } from './review-policy.js';
import { emptySnapshot, fixtureConfig, fixtureTask } from './test-support/fixtures.js';
import { assertNoReservedCollisions, buildRoleToolset } from './toolset.js';

const config = fixtureConfig();

function turnFor(employeeId: string, snapshotOver: Partial<Record<string, unknown>> = {}) {
  return turnWith(config, employeeId, snapshotOver);
}

function turnWith(
  config: WorkforceConfig,
  employeeId: string,
  snapshotOver: Partial<Record<string, unknown>> = {},
) {
  const employee = config.employees.get(employeeId);
  if (!employee) throw new Error(`fixture employee '${employeeId}' missing`);
  const task = fixtureTask({ owner: employeeId, department: employee.department });
  const collector = new TurnCollector({
    tenantId: task.tenantId,
    taskId: task.taskId,
    turnNumber: 1,
  });
  const snapshot = { ...emptySnapshot(task), ...snapshotOver };
  const tools = buildRoleToolset({
    employee,
    config,
    task,
    snapshot: snapshot as ReturnType<typeof emptySnapshot>,
    collector,
  });
  const call = (name: string, args: unknown) => {
    const tool = tools.find((t) => t.spec.name === name);
    if (!tool) throw new Error(`tool '${name}' not offered to '${employeeId}'`);
    return tool.handler(args, new AbortController().signal);
  };
  return { call, collector, task };
}

describe('exactly one turn-ending tool per turn', () => {
  it('the second turn-ending call throws the typed already-ended error; the first intent stands', () => {
    const { call, collector } = turnFor('dev');
    call('submit_result', { status: 'completed', summary: 'Done.', confidence: 0.9 });
    expect(() => call('escalate', { reason: 'risk' })).toThrow(TurnAlreadyEndedError);
    const finished = collector.finish();
    expect(finished.intent).toMatchObject({ kind: 'complete' });
    expect(finished.malformed).toBeNull();
  });

  it('malformed turn-ending arguments record the malformed marker and throw a typed tool error', () => {
    const { call, collector } = turnFor('dev');
    expect(() =>
      call('submit_result', { status: 'perfect', summary: 'Done.', confidence: 0.9 }),
    ).toThrow(WorkforceToolError);
    const finished = collector.finish();
    expect(finished.intent).toBeNull();
    expect(finished.malformed).not.toBeNull();
  });

  it('a valid ending after a malformed attempt clears the fate (in-run recovery)', () => {
    const { call, collector } = turnFor('dev');
    expect(() => call('submit_result', { summary: 'no status' })).toThrow(WorkforceToolError);
    call('submit_result', { status: 'completed', summary: 'Done.', confidence: 0.8 });
    const finished = collector.finish();
    expect(finished.intent).toMatchObject({ kind: 'complete' });
    expect(finished.malformed).toBeNull();
  });

  it('no turn-ending call leaves a null intent (the composition yields)', () => {
    const { call, collector } = turnFor('dev');
    call('get_task', {});
    expect(collector.finish().intent).toBeNull();
  });
});

describe('delegation targets and the manager restriction', () => {
  it('resolves employee:, department: (manager) and team: (lead) to their owners', () => {
    expect(resolveDelegationTarget(config, parseDelegationTarget('employee:dev'))).toMatchObject({
      owner: 'dev',
      delegatedTo: 'employee:dev',
    });
    expect(resolveDelegationTarget(config, parseDelegationTarget('department:eng'))).toMatchObject({
      owner: 'mgr',
      delegatedTo: 'department:eng',
    });
    expect(resolveDelegationTarget(config, parseDelegationTarget('team:fix_team'))).toMatchObject({
      owner: 'mgr',
      delegatedTo: 'team:fix_team',
    });
  });

  it('the orchestrator delegates anywhere; the fan_out carries resolved owners + original targets', () => {
    const { call, collector } = turnFor('lead');
    call('delegate_task', {
      tasks: [
        { target: 'department:eng', title: 'Fix', goal: 'Fix it.' },
        { target: 'department:growth', title: 'Tell', goal: 'Announce it.' },
      ],
    });
    expect(collector.finish().intent).toMatchObject({
      kind: 'fan_out',
      children: [
        { owner: 'mgr', delegatedTo: 'department:eng' },
        { owner: 'cmo', delegatedTo: 'department:growth' },
      ],
    });
  });

  it('a manager reaches own department members and led-team members — nothing else', () => {
    const mgr = config.employees.get('mgr');
    if (!mgr) throw new Error('fixture');
    const may = (raw: string) => {
      const target = parseDelegationTarget(raw);
      const resolved = resolveDelegationTarget(config, target);
      assertManagerMayTarget(config, mgr, target, resolved);
    };
    expect(() => may('employee:dev')).not.toThrow(); // own department member
    expect(() => may('employee:copy')).toThrow(ManagerTargetForbiddenError); // another department
    expect(() => may('department:growth')).toThrow(ManagerTargetForbiddenError);
    // `qa` is a member of the team mgr LEADS but sits outside mgr's department. Outside that
    // team's work the grant does not exist: teams are cross-functional, so an unscoped led-team
    // grant is unbounded cross-department delegation — and cross-department budget charging —
    // from a lint-clean document.
    expect(() => may('employee:qa')).toThrow(ManagerTargetForbiddenError);
  });

  it('the led-team grant exists exactly where the task IS that team’s work', () => {
    const mgr = config.employees.get('mgr');
    if (!mgr) throw new Error('fixture');
    const may = (raw: string, activeTeamIds: readonly string[]) => {
      const target = parseDelegationTarget(raw);
      const resolved = resolveDelegationTarget(config, target);
      assertManagerMayTarget(config, mgr, target, resolved, activeTeamIds);
    };
    // Inside the team's own subtree — the delegation chain records `team:fix_team` — the member is
    // reachable. `activeTeamIds` is read off that chain, never from anything the model says.
    expect(() => may('employee:qa', ['fix_team'])).not.toThrow();
    // A DIFFERENT team's work grants nothing, and neither does a team mgr does not lead.
    expect(() => may('employee:qa', ['other_team'])).toThrow(ManagerTargetForbiddenError);
    // Own-department members stay reachable everywhere, team work or not.
    expect(() => may('employee:dev', [])).not.toThrow();
    expect(() => may('employee:dev', ['fix_team'])).not.toThrow();
    // And team work never widens the grant beyond the team's own members.
    expect(() => may('employee:copy', ['fix_team'])).toThrow(ManagerTargetForbiddenError);
  });

  it('`team:` is the orchestrator seat’s move — a manager may not target one, led or not', () => {
    const mgr = config.employees.get('mgr');
    if (!mgr) throw new Error('fixture');
    const may = (raw: string) => {
      const target = parseDelegationTarget(raw);
      const resolved = resolveDelegationTarget(config, target);
      assertManagerMayTarget(config, mgr, target, resolved);
    };
    // `fix_team` is led BY mgr: it resolves to mgr, so this was the self-delegation the engine
    // refused two turns later. The refusal is now immediate, typed, and says what to do instead.
    expect(() => may('team:fix_team')).toThrow(ManagerTargetForbiddenError);
    expect(() => may('team:fix_team')).toThrow(/orchestrator seat/);
    // The orchestrator's own `team:` delegation still resolves to the lead and is unrestricted.
    const { call, collector } = turnFor('lead');
    call('delegate_task', {
      tasks: [{ target: 'team:fix_team', title: 'Fix', goal: 'Fix it.' }],
    });
    expect(collector.finish().intent).toMatchObject({
      kind: 'fan_out',
      children: [{ owner: 'mgr', delegatedTo: 'team:fix_team' }],
    });
  });

  it('the manager restriction binds inside the delegate_task handler too, on the declared fate', () => {
    const { call, collector } = turnFor('mgr');
    expect(() =>
      call('delegate_task', { tasks: [{ target: 'employee:copy', title: 'T', goal: 'G' }] }),
    ).toThrow(ManagerTargetForbiddenError);
    // The refusal is RECORDED: a forbidden delegation is a malformed ending, so the engine applies
    // the requeue-once-then-fail fate. Left unrecorded it read as "the turn never ended" and the
    // composition yielded — a deterministic refusal with a free retry every turn.
    const collected = collector.finish();
    expect(collected.intent).toBeNull();
    expect(collected.malformed).not.toBeNull();
  });

  it('an unresolvable delegation target is a recorded refusal too, not a silent yield', () => {
    const { call, collector } = turnFor('lead');
    expect(() =>
      call('delegate_task', { tasks: [{ target: 'employee:nobody', title: 'T', goal: 'G' }] }),
    ).toThrow(DelegationTargetInvalidError);
    expect(collector.finish().malformed).not.toBeNull();
  });
});

describe('escalation and reviews', () => {
  it('escalate resolves the target from the reporting edge — never from arguments', () => {
    const { call, collector } = turnFor('dev');
    call('escalate', { reason: 'capability_missing', detail: 'needs prod access' });
    expect(collector.finish().intent).toEqual({
      kind: 'escalate',
      reason: 'capability_missing',
      detail: 'needs prod access',
      escalateTo: 'mgr',
      escalateToDepartment: 'eng',
    });
  });

  it('submit_review takes its reviewId from the SNAPSHOT; without a pending review it refuses', () => {
    const withPending = turnFor('qa', { pendingReview: { reviewId: 'rev-1', round: 1 } });
    withPending.call('submit_review', { verdict: 'reject', reasons: ['thin'] });
    expect(withPending.collector.finish().intent).toMatchObject({
      kind: 'submit_review',
      reviewId: 'rev-1',
      verdict: 'reject',
    });

    const withoutPending = turnFor('qa');
    expect(() => withoutPending.call('submit_review', { verdict: 'accept' })).toThrow(
      WorkforceToolError,
    );
  });

  it('request_review defaults the reviewer from the covering declared policy', () => {
    const { call, collector } = turnFor('dev');
    call('request_review', {});
    expect(collector.finish().intent).toEqual({
      kind: 'request_review',
      reviewer: 'qa',
      dispatchReviewer: true,
    });
  });

  it('request_review accepts the caller superior when that superior holds a decision role', () => {
    const { call, collector } = turnFor('dev');
    call('request_review', { reviewer: 'mgr' });
    expect(collector.finish().intent).toEqual({
      kind: 'request_review',
      reviewer: 'mgr',
      dispatchReviewer: true,
    });
  });

  it('request_review refuses a reviewer outside the caller scope — no org-wide routing', () => {
    // cmo holds role manager, but manages an UNRELATED department: not a policy reviewer covering
    // dev and not dev's superior — exactly the destination delegate_task scoping would refuse.
    const { call, collector } = turnFor('dev');
    expect(() => call('request_review', { reviewer: 'cmo' })).toThrow(WorkforceToolError);
    expect(collector.finish().intent).toBeNull();
  });

  it('request_review never accepts the caller as their own reviewer', () => {
    const mgr = turnFor('mgr');
    expect(() => mgr.call('request_review', { reviewer: 'mgr' })).toThrow(WorkforceToolError);
    expect(mgr.collector.finish().intent).toBeNull();
    const qa = turnFor('qa');
    expect(() => qa.call('request_review', { reviewer: 'qa' })).toThrow(WorkforceToolError);
    expect(qa.collector.finish().intent).toBeNull();
  });

  it('a REVIEW task carries no request_review — a review decides, it does not commission', () => {
    const reviewing = turnFor('qa', { pendingReview: { reviewId: 'rev-1', round: 1 } });
    expect(() => reviewing.call('request_review', {})).toThrow(/not offered/);
    // The same reviewer on an ORDINARY task keeps the tool: the withholding is a property of the
    // task, not of the role. `reviewRoundsUsed` restarts at zero per task, so a review task that
    // could ask for review was an unbounded chain whenever no execution ceiling was declared.
    const ordinary = turnFor('qa');
    expect(() => ordinary.call('request_review', {})).not.toThrow();
  });

  it('an escalating approval rule on a seat with no superior is refused, not sent to the planner', () => {
    // The orchestrator has no `reportsTo` by lint requirement, so the toolset can name no
    // escalation target — the intent would be `invalid_intent` at the planner and the requeue would
    // re-run the same deterministic condition into permanent failure. The lint refuses such a
    // document; this is the defense for a configuration built in code.
    const topSeatCovered: WorkforceConfig = {
      ...config,
      employees: new Map(config.employees).set('lead', {
        ...(config.employees.get('lead') as WorkforceEmployeeConfig),
        labels: ['public_statement'],
      }),
    };
    const { call, collector } = turnWith(topSeatCovered, 'lead');
    expect(() => call('request_approval', { question: 'Ship it?' })).toThrow(
      ApprovalEscalationTargetMissingError,
    );
    const collected = collector.finish();
    expect(collected.intent).toBeNull();
    // Recorded, so the turn takes the declared tool-error fate rather than yielding into a retry
    // of the very same deterministic refusal.
    expect(collected.malformed).not.toBeNull();
  });

  it('request_approval pulls the declared window for the caller labels and names the escalation target', () => {
    const { call, collector } = turnFor('cmo');
    call('request_approval', { question: 'Publish the statement?' });
    expect(collector.finish().intent).toMatchObject({
      kind: 'request_approval',
      approver: 'user',
      timeoutMs: 72 * 3_600_000,
      onTimeout: 'escalate',
      escalateTo: 'lead',
    });
  });

  // ---- the re-request cap, model-facing half (finding L-1) ------------------------------------
  // The ENGINE's refusal is the authority (intent-applier.ts) and lands after the turn ended; this
  // arm exists so the seat learns inside the turn and can still end with a different tool instead
  // of burning it — and, on the next offence, failing its task.

  it('re-requesting a decision this task already carries is refused at the tool door', () => {
    const { call, collector } = turnFor('cmo', {
      resolvedApprovalQuestions: ['Publish the statement?'],
    });
    expect(() => call('request_approval', { question: 'Publish the statement?' })).toThrow(
      ApprovalAlreadyResolvedError,
    );
    expect(collector.finish().intent).toBeNull();
  });

  it('the refusal is RECORDED, so the turn takes the tool-error fate and is not a free yield', () => {
    // Distinct from the assertion above: `refuseEnding` both records AND throws. A bare `throw`
    // would still satisfy "it throws", while leaving the turn indistinguishable from one that
    // never ended — the composition yields, the task re-dispatches, and a deterministic refusal
    // loops for free. This is the assertion that pins the RECORD.
    const { call, collector } = turnFor('cmo', {
      resolvedApprovalQuestions: ['Publish the statement?'],
    });
    expect(() => call('request_approval', { question: 'Publish the statement?' })).toThrow(
      ApprovalAlreadyResolvedError,
    );
    expect(collector.finish().malformed).not.toBeNull();
  });

  it('a valid ending LATER in the same turn clears the refusal — routing around costs nothing', () => {
    const { call, collector } = turnFor('cmo', {
      resolvedApprovalQuestions: ['Publish the statement?'],
    });
    expect(() => call('request_approval', { question: 'Publish the statement?' })).toThrow(
      ApprovalAlreadyResolvedError,
    );
    call('submit_result', { status: 'completed', summary: 'Published.', confidence: 0.9 });
    const collected = collector.finish();
    expect(collected.intent).toMatchObject({ kind: 'complete' });
    expect(collected.malformed).toBeNull();
  });

  it.each([
    ['  Publish the statement?  '],
    ['PUBLISH THE STATEMENT?'],
    ['Publish   the\tstatement?'],
  ])('a re-ask differing only in whitespace/case is refused too: %s', (variant) => {
    const { call } = turnFor('cmo', { resolvedApprovalQuestions: ['Publish the statement?'] });
    expect(() => call('request_approval', { question: variant })).toThrow(
      ApprovalAlreadyResolvedError,
    );
  });

  it('the STORED side is normalized too, not only the asked side', () => {
    // REACHABLE, not hypothetical: the engine writes the question VERBATIM as the model wrote it
    // (`openApproval`), so a first request carrying stray spacing or shouting is what lands in the
    // row — and this arm is then the only thing standing between the seat and a re-ask the engine
    // would refuse a turn later. Normalizing only the asked side diverges in exactly the direction
    // the tool arm exists to prevent: the tool would wave the request through and the seat would
    // burn the turn discovering the engine's refusal.
    const { call } = turnFor('cmo', {
      resolvedApprovalQuestions: ['   PUBLISH   the\tstatement?  '],
    });
    expect(() => call('request_approval', { question: 'Publish the statement?' })).toThrow(
      ApprovalAlreadyResolvedError,
    );
  });

  it('a genuinely different decision passes the tool door untouched', () => {
    const { call, collector } = turnFor('cmo', {
      resolvedApprovalQuestions: ['Publish the statement?'],
    });
    call('request_approval', { question: 'Also notify legal?' });
    expect(collector.finish().intent).toMatchObject({
      kind: 'request_approval',
      question: 'Also notify legal?',
    });
  });

  it('the refusal names the decision the seat already holds', () => {
    const { call } = turnFor('cmo', { resolvedApprovalQuestions: ['Publish the statement?'] });
    expect(() => call('request_approval', { question: 'Publish the statement?' })).toThrow(
      /already decided 'Publish the statement\?'/,
    );
  });
});

describe('buffered creates and messages', () => {
  it('create_task returns the DETERMINISTIC child id its applied row will carry', () => {
    const { call, collector, task } = turnFor('lead');
    const first = call('create_task', { title: 'Plan A', goal: 'Own it.' }) as { taskId: string };
    const second = call('create_task', { title: 'Plan B', goal: 'Own it too.' }) as {
      taskId: string;
    };
    expect(first.taskId).toBe(deterministicChildTaskId(task.tenantId, task.taskId, 1, 0));
    expect(second.taskId).toBe(deterministicChildTaskId(task.tenantId, task.taskId, 1, 1));
    expect(collector.finish().createdChildren).toHaveLength(2);
  });

  it('buffering after the turn ended is refused (slot arithmetic stays stable)', () => {
    const { call } = turnFor('lead');
    call('submit_result', { status: 'completed', summary: 'Done.', confidence: 1 });
    expect(() => call('create_task', { title: 'Late', goal: 'Nope.' })).toThrow(WorkforceToolError);
    expect(() => call('send_message', { recipient: 'user', body: 'late note' })).toThrow(
      WorkforceToolError,
    );
  });

  it('send_message accepts declared employees and the user, refusing anything else', () => {
    const { call, collector } = turnFor('dev');
    call('send_message', { recipient: 'mgr', body: 'progress note' });
    call('send_message', { recipient: 'user', body: 'question coming' });
    expect(() => call('send_message', { recipient: 'stranger', body: 'hi' })).toThrow(
      WorkforceToolError,
    );
    expect(collector.finish().messages).toHaveLength(2);
  });
});

describe('read visibility', () => {
  it('a worker sees its own task and NOTHING else', () => {
    const { call } = turnFor('dev');
    expect(call('get_task', {})).toMatchObject({ taskId: 'task_a', owner: 'dev' });
    expect(() => call('get_task', { taskId: 'task_other' })).toThrow(TaskNotVisibleError);
  });

  it('a reviewer additionally sees the task under review (the snapshot parent)', () => {
    const parent = fixtureTask({ taskId: 'task_parent', owner: 'dev' });
    const { call } = turnFor('qa', { parentTask: parent });
    expect(call('get_task', { taskId: 'task_parent' })).toMatchObject({ taskId: 'task_parent' });
  });

  it('cancel_task refuses a target outside the snapshot subtree', () => {
    const { call } = turnFor('lead');
    expect(() => call('cancel_task', { taskId: 'task_foreign' })).toThrow(TaskNotVisibleError);
    expect(() => call('cancel_task', { taskId: 'task_a' })).toThrow(WorkforceToolError);
  });
});

describe('reserved-name collision defense', () => {
  it('a declared agent tool named after a native is refused at dispatch composition', () => {
    expect(() =>
      assertNoReservedCollisions([
        {
          spec: { name: 'submit_result', description: 'shadow', parameters: {} },
          handler: () => ({}),
          timeoutMs: 1000,
          idempotent: true,
        },
      ]),
    ).toThrow(/native workforce tool/);
    expect(() =>
      assertNoReservedCollisions([
        {
          spec: { name: 'lookup_weather', description: 'fine', parameters: {} },
          handler: () => ({}),
          timeoutMs: 1000,
          idempotent: true,
        },
      ]),
    ).not.toThrow();
  });

  it('the BRIDGED spelling of a native is refused too — a legal yield must never read as an attempted ending', () => {
    // `isTurnEndingToolName` strips `mcp__<x>__` on transcripts, so an agent tool with this name
    // would make a turn that legitimately yielded take the requeue-then-fail fate — and only on
    // the adapters that record the neutral name. Refused up front, uniformly with the lint.
    expect(() =>
      assertNoReservedCollisions([
        {
          spec: { name: 'mcp__tracker__submit_result', description: 'posts', parameters: {} },
          handler: () => ({}),
          timeoutMs: 1000,
          idempotent: true,
        },
      ]),
    ).toThrow(/native workforce tool/);
    expect(() =>
      assertNoReservedCollisions([
        {
          spec: { name: 'mcp__tracker__lookup_weather', description: 'fine', parameters: {} },
          handler: () => ({}),
          timeoutMs: 1000,
          idempotent: true,
        },
      ]),
    ).not.toThrow();
  });
});

describe('the declared-policy matcher never lets a submitter decide their own work', () => {
  const selfCovered = {
    ...fixtureConfig(),
    reviewPolicies: [
      {
        id: 'growth_self',
        appliesTo: { department: 'growth' },
        reviewer: 'cmo',
        requireWhen: { labels: ['public_statement'] },
        onReject: 'rework' as const,
        maxRounds: 2,
      },
    ],
  };
  const result = workerResultSchema.parse({
    status: 'completed',
    summary: 'Shipped.',
    confidence: 0.9,
  });

  it('falls back to the human when the matched reviewer IS the submitter', async () => {
    const cmo = selfCovered.employees.get('cmo');
    if (!cmo) throw new Error("fixture employee 'cmo' missing");
    await expect(
      matchReviewPolicy(selfCovered, { employee: cmo, taskId: 'task_x', result }),
    ).resolves.toEqual({ reviewer: 'user', dispatchReviewer: false, maxRounds: 2 });
  });

  it('still dispatches the declared reviewer for every OTHER covered submitter', async () => {
    const copy = selfCovered.employees.get('copy');
    if (!copy) throw new Error("fixture employee 'copy' missing");
    await expect(
      matchReviewPolicy(selfCovered, { employee: copy, taskId: 'task_y', result }),
    ).resolves.toEqual({ reviewer: 'cmo', dispatchReviewer: true, maxRounds: 2 });
  });
});
