/**
 * WORKFORCE TOOLSET PARITY — the native toolsets an employee's turn carries are BYTE-IDENTICAL
 * whichever backend the employee's agent declares. The toolset layer is neutral by construction
 * (it never reads a backend), and this suite is the tripwire that KEEPS it so: four otherwise
 * identical declarations, one per backend, must produce identical tool specs, identical
 * turn-ending classification, and identical role tables — with `pi` participating in its one
 * legal shape (workers) and its decision-role exclusion asserted as a VALIDATION rejection, not a
 * runtime difference.
 */
import { deriveWorkforceConfig, parseSpec } from '@rayspec/spec';
import type { TaskRecord } from '@rayspec/tasks';
import {
  buildRoleToolset,
  TOOLSETS_BY_ROLE,
  TURN_ENDING_TOOLS,
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
  name: parity-${backend}-${workerBackend}
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

/** The projection compared across backends: everything the MODEL sees plus the replay contract. */
function toolsetShape(backend: string, workerBackend: string, employeeId: string) {
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
    subtreeTasks: [],
    departmentTasks: [],
    workforceState: null,
    pendingReview: null,
  };
  const tools = buildRoleToolset({
    employee,
    config,
    task,
    snapshot,
    collector: new TurnCollector({ tenantId: task.tenantId, taskId: task.taskId, turnNumber: 1 }),
  });
  return tools.map((tool) => ({
    name: tool.spec.name,
    description: tool.spec.description,
    parameters: tool.spec.parameters,
    timeoutMs: tool.timeoutMs,
    idempotent: tool.idempotent,
    turnEnding: TURN_ENDING_TOOLS.has(tool.spec.name as never),
  }));
}

describe('the injected toolsets are byte-identical across backends', () => {
  for (const employeeId of ['lead', 'mgr', 'qa'] as const) {
    it(`the ${employeeId} toolset is identical on every native backend`, () => {
      const reference = toolsetShape('openai', 'pi', employeeId);
      for (const backend of NATIVE_BACKENDS) {
        expect(JSON.stringify(toolsetShape(backend, 'pi', employeeId))).toBe(
          JSON.stringify(reference),
        );
      }
    });
  }

  it("pi's WORKER toolset is byte-identical to every other backend's worker toolset", () => {
    const reference = toolsetShape('openai', 'openai', 'dev');
    for (const workerBackend of ALL_BACKENDS) {
      expect(JSON.stringify(toolsetShape('openai', workerBackend, 'dev'))).toBe(
        JSON.stringify(reference),
      );
    }
  });

  it('the turn-ending classification is identical per role across backends', () => {
    for (const employeeId of ['lead', 'mgr', 'dev', 'qa'] as const) {
      const reference = toolsetShape('openai', 'pi', employeeId).map((t) => ({
        name: t.name,
        turnEnding: t.turnEnding,
      }));
      for (const backend of NATIVE_BACKENDS) {
        expect(
          toolsetShape(backend, 'pi', employeeId).map((t) => ({
            name: t.name,
            turnEnding: t.turnEnding,
          })),
        ).toEqual(reference);
      }
    }
  });

  it('the role tables themselves are the single source the built sets mirror', () => {
    for (const [role, employeeId] of [
      ['orchestrator', 'lead'],
      ['manager', 'mgr'],
      ['worker', 'dev'],
      ['reviewer', 'qa'],
    ] as const) {
      expect(toolsetShape('openai', 'pi', employeeId).map((t) => t.name)).toEqual([
        ...TOOLSETS_BY_ROLE[role],
      ]);
    }
  });
});

describe('the pi decision-role exclusion is a VALIDATION rejection, never a runtime difference', () => {
  it('binding the decision agent to pi rejects at parse with capability_violation', () => {
    const res = parseSpec(specFor('pi', 'pi'), { experimentalWorkforce: true });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    const codes = res.errors.map((e) => e.code);
    expect(codes).toContain('capability_violation');
  });
});
