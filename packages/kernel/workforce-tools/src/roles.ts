/**
 * The role → native-toolset table — WHICH tools an employee's turn carries is a function of the
 * TASK's role, resolved at dispatch, never inherited through a delegation (privilege
 * non-aggregation is this table plus the resolver keying on the task owner alone). The name
 * vocabulary is the reserved set in @rayspec/core (spec validation refuses collisions with it).
 */
import { BRIDGED_TOOL_NAME_SOURCE, RESERVED_WORKFORCE_TOOL_NAMES } from '@rayspec/core';

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

/**
 * The model-facing form an in-process MCP bridge gives a neutral tool: `mcp__<server>__<tool>`.
 * Anchored and narrow on purpose — it matches the bridged form and nothing else, so a name that
 * never went through a bridge cannot be mangled by it.
 *
 * This is the SAME predicate `isReservedWorkforceToolSpelling` (@rayspec/core) uses to refuse a
 * bridged collision at parse: widening one alone (e.g. to accept `mcp_` with one underscore) would
 * make the collision check and this turn-ending detector disagree, reopening exactly the bridged-
 * spelling gap the PR closes. There is no cross-package regex identity, so the copy is pinned to the
 * canonical source at module load — the same drift assert this file uses for the reserved set below.
 */
const MCP_BRIDGED_TOOL_NAME = /^mcp__[a-z0-9-]+__(?<tool>.+)$/;
if (MCP_BRIDGED_TOOL_NAME.source !== BRIDGED_TOOL_NAME_SOURCE) {
  throw new Error(
    `the bridged-tool-name pattern drifted: roles.ts has '${MCP_BRIDGED_TOOL_NAME.source}' but ` +
      `@rayspec/core's canonical source is '${BRIDGED_TOOL_NAME_SOURCE}'. One predicate, two ` +
      'consumers — keep them byte-identical. Fail-closed.',
  );
}

/**
 * Does a tool name AS A BACKEND RECORDED IT on the transcript name a turn-ending tool?
 *
 * Adapters do not agree on the recorded form. OpenAI, Codex and pi report the neutral name the
 * toolset dispatched under; the Anthropic adapter bridges the toolset as an in-process MCP server
 * and keeps the model-facing `mcp__rayspec__<tool>` verbatim in its re-derived transcript. Reading
 * the transcript is how the composition learns that an ending was ATTEMPTED and refused before the
 * handler ran, so a check that knew only the neutral form silently degraded that fate to a yield on
 * the one adapter that prefixes.
 *
 * The NEUTRAL SUFFIX is what both forms share, so match on that. This is deliberately a READ-SIDE
 * normalization rather than a change to what the Anthropic adapter records: the transcript is the
 * source of record and the prefixed name is what the model actually called, and no other adapter
 * can be affected by a strip that is the identity on every name without the bridged prefix.
 */
export function isTurnEndingToolName(recordedName: string): boolean {
  const neutral = MCP_BRIDGED_TOOL_NAME.exec(recordedName)?.groups?.tool ?? recordedName;
  return TURN_ENDING_TOOLS.has(neutral as ToolName);
}

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
