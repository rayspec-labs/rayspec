/**
 * PRIVILEGE NON-AGGREGATION — the load-bearing property of the whole toolset layer: the tools a
 * turn carries are a function of the TASK's role and NOTHING else. Exact sorted name lists per
 * role (never subset checks — an extra tool is exactly the bug), no role's set contains another's
 * submit tools, and the resolver keyed on the task owner means a delegation can never carry a
 * capability along.
 */
import type { WorkforceEmployeeConfig } from '@rayspec/spec';
import { describe, expect, it } from 'vitest';
import { TurnCollector } from './collector.js';
import {
  EMPLOYEE_ROLES,
  isTurnEndingToolName,
  TOOLSETS_BY_ROLE,
  TURN_ENDING_TOOLS,
} from './roles.js';
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
        'report_failure',
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
        'report_failure',
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
        'report_failure',
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
        'report_failure',
        'request_clarification',
        'request_review',
        'escalate',
        'send_message',
        'submit_review',
      ].sort(),
    );
  });
});

describe('a description never advertises what the seat cannot reach', () => {
  it('no tool description names a native tool that role does not carry', () => {
    // The `delegate_task` rule, generalized into a guard. Its docblock records the cost of the
    // instance: the manager arm advertised `department:<id>`, which a lint-clean document makes
    // unreachable from a manager, and discovering the refusal cost a turn. A description is
    // model-facing text about what to do next, so naming an ending the caller cannot call is the
    // same defect wearing a different tool's name. The `report_failure` description is the reason
    // this guard exists now: it contrasts itself with `escalate`, which the orchestrator lacks.
    const allNames = [...new Set(EMPLOYEE_ROLES.flatMap((r) => TOOLSETS_BY_ROLE[r]))];
    for (const role of EMPLOYEE_ROLES) {
      const employee = {
        ...(fixtureConfig().employees.get('dev') as WorkforceEmployeeConfig),
        role,
      };
      const task = fixtureTask({ owner: employee.id });
      const tools = buildRoleToolset({
        employee,
        config: fixtureConfig(),
        task,
        snapshot: emptySnapshot(task),
        collector: new TurnCollector({
          tenantId: task.tenantId,
          taskId: task.taskId,
          turnNumber: 1,
        }),
      });
      const carried = new Set(tools.map((t) => t.spec.name));
      for (const tool of tools) {
        const named = allNames.filter(
          (n) => n !== tool.spec.name && new RegExp(`\\b${n}\\b`).test(tool.spec.description ?? ''),
        );
        expect(
          named.filter((n) => !carried.has(n)),
          `${role}/${tool.spec.name} points at a tool this seat cannot call`,
        ).toEqual([]);
      }
    }
  });
});

describe('the dispatch chokepoint validates every native tool arguments', () => {
  it('every tool a role carries sets inputSchema, and it IS the schema the model was shown', () => {
    // `dispatchTool` guards its Ajv validate-in on `if (tool.inputSchema)`. A tool that declares
    // only `spec.parameters` is therefore dispatched with its arguments UNVALIDATED — and the
    // adapters are deliberately permissive, so nothing else would catch them before the handler.
    for (const role of EMPLOYEE_ROLES) {
      const employee = {
        ...(fixtureConfig().employees.get('dev') as WorkforceEmployeeConfig),
        role,
      };
      const task = fixtureTask({ owner: employee.id });
      const tools = buildRoleToolset({
        employee,
        config: fixtureConfig(),
        task,
        snapshot: emptySnapshot(task),
        collector: new TurnCollector({
          tenantId: task.tenantId,
          taskId: task.taskId,
          turnNumber: 1,
        }),
      });
      expect(tools.length, role).toBeGreaterThan(0);
      for (const tool of tools) {
        expect(tool.inputSchema, `${role}/${tool.spec.name}`).toBeDefined();
        expect(tool.inputSchema, `${role}/${tool.spec.name}`).toEqual(tool.spec.parameters);
      }
    }
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

  it('the transcript classifier reads both recorded forms and widens neither', () => {
    // A backend records the name the MODEL called: neutral on OpenAI/Codex/pi, the bridged
    // `mcp__<server>__<tool>` on Anthropic. Both name the same tool and must classify the same.
    for (const name of TURN_ENDING_TOOLS) {
      expect(isTurnEndingToolName(name)).toBe(true);
      expect(isTurnEndingToolName(`mcp__rayspec__${name}`)).toBe(true);
    }
    // And the strip is not a licence: a read tool ends no turn in either form, and a name that
    // merely CONTAINS an ending's is not one.
    for (const name of ['get_task', 'mcp__rayspec__get_task', 'send_message']) {
      expect(isTurnEndingToolName(name)).toBe(false);
    }
    expect(isTurnEndingToolName('not_submit_result')).toBe(false);
    // The SERVER half is not pinned on purpose: an adapter that bridges this toolset under another
    // server name still dispatched through the same chokepoint, and the transcript carries only
    // sanctioned tools. Reading it as an ending is the safe direction — the fate, not a free retry.
    expect(isTurnEndingToolName('mcp__other__submit_result')).toBe(true);
  });
});
