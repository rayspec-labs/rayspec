/**
 * PRIVILEGE NON-AGGREGATION — the load-bearing property of the whole toolset layer: the tools a
 * turn carries are a function of the TASK's role and NOTHING else. Exact sorted name lists per
 * role (never subset checks — an extra tool is exactly the bug), no role's set contains another's
 * submit tools, and the resolver keyed on the task owner means a delegation can never carry a
 * capability along.
 */
import { describe, expect, it } from 'vitest';
import { TurnCollector } from './collector.js';
import { TOOLSETS_BY_ROLE, TURN_ENDING_TOOLS } from './roles.js';
import { emptySnapshot, fixtureConfig, fixtureTask } from './test-support/fixtures.js';
import { buildRoleToolset } from './toolset.js';

const config = fixtureConfig();

function toolNamesFor(employeeId: string): string[] {
  const employee = config.employees.get(employeeId);
  if (!employee) throw new Error(`fixture employee '${employeeId}' missing`);
  const task = fixtureTask({ owner: employeeId, department: employee.department });
  const tools = buildRoleToolset({
    employee,
    config,
    task,
    snapshot: emptySnapshot(task),
    collector: new TurnCollector({ tenantId: task.tenantId, taskId: task.taskId, turnNumber: 1 }),
  });
  return tools.map((t) => t.spec.name).sort();
}

describe('the exact toolset per role', () => {
  it('an orchestrator turn carries exactly the orchestrator set', () => {
    expect(toolNamesFor('lead')).toEqual(
      [
        'create_task',
        'delegate_task',
        'request_review',
        'request_approval',
        'submit_result',
        'cancel_task',
        'get_workforce_state',
        'get_task',
        'list_open_tasks',
        'send_message',
      ].sort(),
    );
  });

  it('a manager turn carries exactly the manager set', () => {
    expect(toolNamesFor('mgr')).toEqual(
      [
        'get_task',
        'create_subtask',
        'delegate_task',
        'request_review',
        'request_approval',
        'submit_result',
        'escalate',
        'list_department_tasks',
        'send_message',
        'submit_review',
      ].sort(),
    );
  });

  it('a worker turn carries exactly the worker set', () => {
    expect(toolNamesFor('dev')).toEqual(
      [
        'get_task',
        'submit_result',
        'request_clarification',
        'request_review',
        'escalate',
        'send_message',
      ].sort(),
    );
  });

  it('a reviewer turn carries exactly the worker set plus submit_review', () => {
    expect(toolNamesFor('qa')).toEqual(
      [
        'get_task',
        'submit_result',
        'request_clarification',
        'request_review',
        'escalate',
        'send_message',
        'submit_review',
      ].sort(),
    );
  });
});

describe('non-aggregation', () => {
  it('a manager is never offered the worker-only clarification tool, nor a worker any manager tool', () => {
    expect(toolNamesFor('mgr')).not.toContain('request_clarification');
    for (const managerOnly of ['create_subtask', 'delegate_task', 'list_department_tasks']) {
      expect(toolNamesFor('dev')).not.toContain(managerOnly);
    }
    for (const orchestratorOnly of ['create_task', 'cancel_task', 'get_workforce_state']) {
      expect(toolNamesFor('mgr')).not.toContain(orchestratorOnly);
      expect(toolNamesFor('dev')).not.toContain(orchestratorOnly);
    }
  });

  it('the toolset is a function of the TASK owner alone — two roles never blend', () => {
    // The same builder invoked for two employees yields the two canonical sets — nothing about a
    // prior invocation (a delegating manager, say) leaks into the next (the worker's child task).
    const manager = toolNamesFor('mgr');
    const worker = toolNamesFor('dev');
    expect(manager).not.toEqual(worker);
    expect(worker.every((name) => manager.includes(name) || name === 'request_clarification')).toBe(
      true,
    );
    expect(toolNamesFor('dev')).toEqual(worker); // stable and reproducible
  });

  it('the declared role tables and the turn-ending classification agree with the built tools', () => {
    for (const [role, names] of Object.entries(TOOLSETS_BY_ROLE)) {
      const employeeId = { orchestrator: 'lead', manager: 'mgr', worker: 'dev', reviewer: 'qa' }[
        role
      ] as string;
      expect(toolNamesFor(employeeId)).toEqual([...names].sort());
    }
    // Every turn-ending name appears in some role's set; read/buffer tools never claim to end.
    for (const name of TURN_ENDING_TOOLS) {
      expect(Object.values(TOOLSETS_BY_ROLE).flat()).toContain(name);
    }
  });
});
