/**
 * The role → native-toolset table — WHICH tools an employee's turn carries is a function of the
 * TASK's role, resolved at dispatch, never inherited through a delegation (privilege
 * non-aggregation is this table plus the resolver keying on the task owner alone). The name
 * vocabulary is the reserved set in @rayspec/core (spec validation refuses collisions with it).
 */
import { RESERVED_WORKFORCE_TOOL_NAMES } from '@rayspec/core';

export const EMPLOYEE_ROLES = ['orchestrator', 'manager', 'worker', 'reviewer'] as const;
export type EmployeeRole = (typeof EMPLOYEE_ROLES)[number];

export type ToolName =
  | 'cancel_task'
  | 'create_subtask'
  | 'create_task'
  | 'delegate_task'
  | 'escalate'
  | 'get_task'
  | 'get_workforce_state'
  | 'list_department_tasks'
  | 'list_open_tasks'
  | 'request_approval'
  | 'request_clarification'
  | 'request_review'
  | 'send_message'
  | 'submit_result'
  | 'submit_review';

/** The tools that END a turn by recording the one turn-ending intent. Everything else reads or
 *  buffers and the run continues. */
export const TURN_ENDING_TOOLS: ReadonlySet<ToolName> = new Set([
  'cancel_task',
  'delegate_task',
  'escalate',
  'request_approval',
  'request_clarification',
  'request_review',
  'submit_result',
  'submit_review',
]);

export const TOOLSETS_BY_ROLE: Readonly<Record<EmployeeRole, readonly ToolName[]>> = Object.freeze({
  orchestrator: [
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
  ],
  manager: [
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
  ],
  worker: [
    'get_task',
    'submit_result',
    'request_clarification',
    'request_review',
    'escalate',
    'send_message',
  ],
  reviewer: [
    'get_task',
    'submit_result',
    'request_clarification',
    'request_review',
    'escalate',
    'send_message',
    'submit_review',
  ],
});

// Every toolset name is a member of the reserved vocabulary — asserted at module load so the two
// sets cannot drift (the reserved set is what spec validation refuses collisions against).
for (const tools of Object.values(TOOLSETS_BY_ROLE)) {
  for (const name of tools) {
    if (!RESERVED_WORKFORCE_TOOL_NAMES.has(name)) {
      throw new Error(
        `native tool '${name}' is missing from RESERVED_WORKFORCE_TOOL_NAMES — the reserved set ` +
          'and the toolsets must cover each other. Fail-closed.',
      );
    }
  }
}
