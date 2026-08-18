/**
 * WORKFORCE INTENT PARITY — an INJECTION-LEVEL tripwire on the intent layer's backend-neutrality,
 * and a byte-exact transcript pin on the intents themselves.
 *
 * Scripted tool-call sequences run through the REAL handlers and the REAL turn collector, and each
 * scenario's full observable shape (every call's return value or thrown error, then the collected
 * turn) is compared as JSON bytes across four backend spellings. TWO different things are being
 * measured, and only one of them is about backends:
 *
 *   - THE TRANSCRIPTS ARE REAL. Delegation resolution, deterministic child ids, escalation targets,
 *     reviewId injection, the typed tool errors — each is pinned byte for byte, and a change to any
 *     of them fails here. This is the load-bearing half.
 *   - THE CROSS-BACKEND COMPARISON IS AN ERASURE CHECK, not an adapter measurement. No adapter is
 *     loaded; the backend appears only as a YAML scalar that `deriveWorkforceConfig` discards
 *     (`WorkforceEmployeeConfig` has no backend field), and the handlers are invoked directly
 *     rather than through a `Backend` or `ctx.dispatchTool`. The four arms are therefore identical
 *     by construction — which is exactly the property worth a tripwire, and is not the same claim
 *     as "these four providers behave alike".
 *
 * Real adapter-level parity for these flows needs a backend an employee's declaration can select,
 * which the grammar has no field for yet; it stays on the list rather than being implied here.
 */
import { deriveWorkforceConfig, parseSpec } from '@rayspec/spec';
import type { TaskRecord } from '@rayspec/tasks';
import {
  buildRoleToolset,
  TurnCollector,
  type WorkforceReadSnapshot,
} from '@rayspec/workforce-tools';
import { describe, expect, it } from 'vitest';

const NATIVE_BACKENDS = ['openai', 'anthropic', 'codex'] as const;
const ALL_BACKENDS = [...NATIVE_BACKENDS, 'pi'] as const;

/** One declaration per backend: decision roles ride `backend`; the worker rides `workerBackend`. */
function specFor(backend: string, workerBackend: string): string {
  return `
version: '1.0'
metadata:
  name: intent-parity-${backend}-${workerBackend}
deployment:
  durableWorker: true
agents:
  - id: decision_agent
    name: decision_agent
    backend: ${backend}
    model: model-x
    instructions: Decide.
  - id: worker_agent
    name: worker_agent
    backend: ${workerBackend}
    model: model-x
    instructions: Work.
workforce:
  id: parity_wf
  name: Parity
  orchestrator: lead
  departments:
    - id: eng
      name: Engineering
      manager: mgr
      mission: Own it.
      members: [dev]
  employees:
    - id: lead
      agent: decision_agent
      title: Lead
      role: orchestrator
    - id: mgr
      agent: decision_agent
      title: Manager
      department: eng
      reportsTo: lead
      role: manager
      labels: [public_statement]
    - id: dev
      agent: worker_agent
      title: Developer
      department: eng
      reportsTo: mgr
      role: worker
    - id: qa
      agent: decision_agent
      title: Reviewer
      reportsTo: lead
      role: reviewer
  reviewPolicies:
    - id: dev_review
      appliesTo: { employee: dev }
      reviewer: qa
      requireWhen: { confidenceBelow: 0.8 }
      onReject: rework
      maxReviewRounds: 2
  approvalPolicies:
    - id: statement_approval
      requireWhen: { labels: [public_statement] }
      approver: user
      timeout: 24h
      onTimeout: escalate
`;
}

function taskFor(owner: string, department: string | null): TaskRecord {
  return {
    taskId: 'task_parity',
    tenantId: '00000000-0000-4000-8000-00000000000a',
    workforceId: 'parity_wf',
    parentTaskId: null,
    rootTaskId: 'task_parity',
    ancestryPath: [],
    title: 'Parity task',
    goal: 'Hold still.',
    description: null,
    owner,
    requestedBy: 'user',
    department,
    status: 'working',
    statusReason: null,
    priority: 'normal',
    dependencies: [],
    joinPolicy: null,
    artifacts: [],
    result: null,
    confidence: null,
    costUsd: '0',
    tokenUsage: {},
    turnsUsed: 0,
    lastEventSeq: 0,
    deadlineAt: null,
    createdAt: new Date(0),
    queuedAt: null,
    startedAt: null,
    completedAt: null,
    version: 1,
  } as TaskRecord;
}

interface SnapshotOverrides {
  readonly pendingReview?: WorkforceReadSnapshot['pendingReview'];
  readonly subtreeTasks?: WorkforceReadSnapshot['subtreeTasks'];
}

/** A scripted call: the tool name plus the exact arguments the model would send. */
type Call = readonly [tool: string, args: unknown];

/**
 * Run one scripted sequence through the REAL collector for one backend binding and project every
 * observable: per-call results/typed errors, then the collected turn.
 */
function runScript(
  backend: string,
  workerBackend: string,
  employeeId: string,
  calls: readonly Call[],
  overrides: SnapshotOverrides = {},
) {
  const parsed = parseSpec(specFor(backend, workerBackend), { experimentalWorkforce: true });
  if (!parsed.ok) throw new Error(`parity spec did not parse: ${JSON.stringify(parsed.errors)}`);
  const workforce = parsed.value.workforce;
  if (!workforce) throw new Error('parity spec lost its workforce');
  const config = deriveWorkforceConfig(workforce);
  const employee = config.employees.get(employeeId);
  if (!employee) throw new Error(`employee ${employeeId} missing`);
  const task = taskFor(employeeId, employee.department);
  const snapshot: WorkforceReadSnapshot = {
    task,
    parentTask: null,
    subtreeTasks: overrides.subtreeTasks ?? [],
    departmentTasks: [],
    workforceState: null,
    pendingReview: overrides.pendingReview ?? null,
  };
  const collector = new TurnCollector({
    tenantId: task.tenantId,
    taskId: task.taskId,
    turnNumber: 1,
  });
  const tools = buildRoleToolset({ employee, config, task, snapshot, collector });

  const transcript: unknown[] = [];
  for (const [name, args] of calls) {
    const tool = tools.find((candidate) => candidate.spec.name === name);
    if (tool === undefined) {
      transcript.push({ tool: name, absent: true });
      continue;
    }
    try {
      transcript.push({ tool: name, ok: tool.handler(args) });
    } catch (err) {
      const error = err as Error;
      transcript.push({ tool: name, error: { name: error.name, message: error.message } });
    }
  }
  return { transcript, collected: collector.finish() };
}

/** Assert one scenario's full observable shape is byte-identical across the given backends. */
function assertParity(
  backends: readonly string[],
  employeeId: string,
  calls: readonly Call[],
  overrides: SnapshotOverrides = {},
): ReturnType<typeof runScript> {
  const isWorker = employeeId === 'dev';
  const run = (backend: string) =>
    isWorker
      ? runScript('openai', backend, employeeId, calls, overrides)
      : runScript(backend, 'pi', employeeId, calls, overrides);
  const reference = run(backends[0] as string);
  for (const backend of backends) {
    expect(JSON.stringify(run(backend))).toBe(JSON.stringify(reference));
  }
  return reference;
}

describe('scripted sequences produce byte-identical intents across backends', () => {
  it('plural delegation with a buffered message resolves the same owners everywhere', () => {
    const { collected } = assertParity(NATIVE_BACKENDS, 'lead', [
      ['send_message', { recipient: 'mgr', body: 'Two streams incoming.' }],
      [
        'delegate_task',
        {
          tasks: [
            { target: 'department:eng', title: 'Stream one', goal: 'Ship it.' },
            { target: 'employee:dev', title: 'Stream two', goal: 'Verify it.', priority: 'high' },
          ],
        },
      ],
    ]);
    expect(collected.intent).toMatchObject({ kind: 'fan_out' });
    if (collected.intent?.kind !== 'fan_out') return;
    expect(collected.intent.children.map((child) => child.owner)).toEqual(['mgr', 'dev']);
    expect(collected.messages).toHaveLength(1);
  });

  it('a buffered create returns the same deterministic child id everywhere', () => {
    const { transcript, collected } = assertParity(NATIVE_BACKENDS, 'lead', [
      ['create_task', { title: 'Prep work', goal: 'Lay the ground.' }],
      ['submit_result', { status: 'completed', summary: 'Planned and prepped.', confidence: 0.9 }],
    ]);
    expect(transcript[0]).toMatchObject({
      tool: 'create_task',
      ok: { taskId: expect.any(String) },
    });
    expect(collected.createdChildren).toHaveLength(1);
    expect(collected.intent).toMatchObject({ kind: 'complete' });
  });

  it('escalate carries the reporting edge identically on all four worker backends', () => {
    const { collected } = assertParity(ALL_BACKENDS, 'dev', [
      ['escalate', { reason: 'insufficient_context', detail: 'The goal names no target system.' }],
    ]);
    expect(collected.intent).toEqual({
      kind: 'escalate',
      reason: 'insufficient_context',
      detail: 'The goal names no target system.',
      escalateTo: 'mgr',
      escalateToDepartment: 'eng',
    });
  });

  it('request_clarification is identical on all four worker backends', () => {
    const { collected } = assertParity(ALL_BACKENDS, 'dev', [
      ['request_clarification', { question: 'Which environment counts?' }],
    ]);
    expect(collected.intent).toEqual({
      kind: 'request_clarification',
      question: 'Which environment counts?',
    });
  });

  it('request_review resolves the declared default reviewer identically everywhere', () => {
    const { collected } = assertParity(ALL_BACKENDS, 'dev', [['request_review', {}]]);
    expect(collected.intent).toEqual({
      kind: 'request_review',
      reviewer: 'qa',
      dispatchReviewer: true,
    });
  });

  it('request_approval derives the declared rule fate identically everywhere', () => {
    const { collected } = assertParity(NATIVE_BACKENDS, 'mgr', [
      ['request_approval', { question: 'Publish the statement?', options: ['yes', 'no'] }],
    ]);
    expect(collected.intent).toEqual({
      kind: 'request_approval',
      question: 'Publish the statement?',
      options: ['yes', 'no'],
      approver: 'user',
      timeoutMs: 86_400_000,
      onTimeout: 'escalate',
      escalateTo: 'lead',
    });
  });

  it('submit_review accept and reject both take the reviewId from the snapshot identically', () => {
    for (const verdict of ['accept', 'reject'] as const) {
      const { collected } = assertParity(
        NATIVE_BACKENDS,
        'qa',
        [['submit_review', { verdict, reasons: ['Checked against the goal.'] }]],
        { pendingReview: { reviewId: 'review_0000000000000001', round: 1 } },
      );
      expect(collected.intent).toEqual({
        kind: 'submit_review',
        reviewId: 'review_0000000000000001',
        verdict,
        reasons: ['Checked against the goal.'],
        requiredChanges: [],
      });
    }
  });

  it('cancel_task targets a visible subtree task identically everywhere', () => {
    const child = {
      taskId: 'task_child',
      title: 'Doomed work',
      status: 'working',
      statusReason: null,
      owner: 'dev',
      department: 'eng',
      priority: 'normal',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const { collected } = assertParity(
      NATIVE_BACKENDS,
      'lead',
      [['cancel_task', { taskId: 'task_child', detail: 'Superseded by stream two.' }]],
      { subtreeTasks: [child] },
    );
    expect(collected.intent).toEqual({
      kind: 'cancel_task',
      taskId: 'task_child',
      detail: 'Superseded by stream two.',
    });
  });
});

describe('typed tool errors are byte-identical across backends', () => {
  it('a second turn-ending call fails with the same payload and the first intent stands', () => {
    const { transcript, collected } = assertParity(ALL_BACKENDS, 'dev', [
      ['submit_result', { status: 'completed', summary: 'Done.', confidence: 0.9 }],
      ['request_clarification', { question: 'Too late?' }],
    ]);
    expect(transcript[1]).toMatchObject({
      error: { name: 'TurnAlreadyEndedError', message: expect.stringContaining('complete') },
    });
    expect(collected.intent).toMatchObject({ kind: 'complete' });
  });

  it('schema-invalid turn-ending arguments record the same malformed marker', () => {
    const { transcript, collected } = assertParity(ALL_BACKENDS, 'dev', [
      ['submit_result', { status: 'completed', summary: 'No confidence given.' }],
    ]);
    expect(transcript[0]).toMatchObject({
      error: { name: 'WorkforceToolError', message: expect.stringContaining('invalid arguments') },
    });
    expect(collected.intent).toBeNull();
    expect(collected.malformed).not.toBeNull();
  });

  it('a tool outside the role set is absent identically on every backend', () => {
    const { transcript } = assertParity(ALL_BACKENDS, 'dev', [
      ['delegate_task', { tasks: [{ target: 'employee:dev', title: 'X', goal: 'Y' }] }],
      ['cancel_task', { taskId: 'task_parity' }],
    ]);
    expect(transcript).toEqual([
      { tool: 'delegate_task', absent: true },
      { tool: 'cancel_task', absent: true },
    ]);
  });

  it('an undeclared message recipient fails with the same payload everywhere', () => {
    const { transcript, collected } = assertParity(ALL_BACKENDS, 'dev', [
      ['send_message', { recipient: 'ghost', body: 'Anyone there?' }],
    ]);
    expect(transcript[0]).toMatchObject({
      error: { name: 'WorkforceToolError', message: expect.stringContaining('ghost') },
    });
    expect(collected.messages).toHaveLength(0);
  });
});
