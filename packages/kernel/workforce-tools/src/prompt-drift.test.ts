/**
 * The PROMPT VOCABULARY is drift-locked onto the role tables it describes.
 *
 * `prompt.ts` holds two hand-written strings that name tools: the per-role guidance and the closing
 * turn-ending reminder. Both were maintained beside `roles.ts` by comment alone
 * ("Each names only tools the role's toolset actually carries"), enforced by nothing — so adding a
 * tool to the tables left the prompt stale, and a stale prompt is not a cosmetic defect: the seat
 * reaches for the endings it was TOLD about, so a tool the reminder omits is a tool that does not
 * exist as far as the model is concerned. That is exactly how a failure channel stays orphaned.
 *
 * Two rules, both one-directional on purpose:
 *   - the reminder must name EVERY turn-ending tool (a missing one is invisible to the model);
 *   - a role's guidance may name only tools that role actually carries (naming one it does not
 *     carry costs a turn to discover the refusal — the same reason `delegate_task`'s description
 *     advertises only reachable targets).
 * The converse of the second — "guidance must mention every tool the role carries" — is deliberately
 * NOT asserted: the guidance frames the DECISION a turn makes, and the read tools plus housekeeping
 * endings like `cancel_task` are legitimately left to the tool descriptions.
 */
import { describe, expect, it } from 'vitest';
import { ROLE_GUIDANCE, TURN_ENDING_REMINDER } from './prompt.js';
import { EMPLOYEE_ROLES, TOOLSETS_BY_ROLE, type ToolName, TURN_ENDING_TOOLS } from './roles.js';

/** Every native tool name, so a mention can be recognised without re-listing the vocabulary here. */
const ALL_TOOL_NAMES: readonly ToolName[] = [
  ...new Set(EMPLOYEE_ROLES.flatMap((role) => TOOLSETS_BY_ROLE[role])),
];

/** The native tool names a prose block mentions (word-bounded, so `submit_result` ≠ `submit_review`). */
function toolsNamedIn(text: string): Set<ToolName> {
  return new Set(ALL_TOOL_NAMES.filter((name) => new RegExp(`\\b${name}\\b`).test(text)));
}

describe('the turn-ending reminder', () => {
  it('names every member of TURN_ENDING_TOOLS', () => {
    expect(toolsNamedIn(TURN_ENDING_REMINDER)).toEqual(new Set(TURN_ENDING_TOOLS));
  });
});

describe('per-role guidance', () => {
  for (const role of EMPLOYEE_ROLES) {
    it(`names only tools the ${role} toolset carries`, () => {
      const carried = new Set<ToolName>(TOOLSETS_BY_ROLE[role]);
      const unreachable = [...toolsNamedIn(ROLE_GUIDANCE[role])].filter((n) => !carried.has(n));
      expect(unreachable, `${role} guidance names tools that role cannot call`).toEqual([]);
    });
  }

  it('tells every role that carries report_failure about it — the channel the seats could not see', () => {
    for (const role of EMPLOYEE_ROLES) {
      if (!TOOLSETS_BY_ROLE[role].includes('report_failure')) continue;
      expect(
        toolsNamedIn(ROLE_GUIDANCE[role]).has('report_failure'),
        `${role} guidance never mentions report_failure`,
      ).toBe(true);
    }
  });
});
