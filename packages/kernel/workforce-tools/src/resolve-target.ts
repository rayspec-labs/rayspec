/**
 * Delegation-target resolution — `employee:<id>` / `department:<id>` / `team:<id>` to the ONE
 * employee who answers for the work. Resolution picks the OWNER only: a department resolves to its
 * manager (the delegator never needs to know the department's internals), a team resolves to its
 * lead (the lead fans out to the members with the `all` join on its own later turn and takes the
 * synthesis turn when the join wakes it) — resolution never expands a team into N children itself.
 *
 * `team:` IS THEREFORE ORCHESTRATOR-ONLY, and that is the semantic rather than an omission. A team
 * resolves to its lead, and the lint requires that lead to hold role `manager` — so the only seat
 * that can address a team without naming its own owner is the one above every manager. A manager
 * targeting a team they lead resolved to THEMSELVES and the engine refused the result as
 * `self_delegation`; a manager targeting a team they do not lead was already forbidden. Both arms
 * failed, so nothing legal is being taken away — what changes is that the refusal is now typed,
 * immediate, and says why, instead of costing a turn and a requeue to discover.
 *
 * The manager restriction lives HERE, in the trusted layer the model's tool call passes through:
 * a manager's legal targets are the members of their own department and the members of the teams
 * they LEAD. The kernel cannot re-check this (it is roster-free by design), which is why the
 * resolver is the enforcement point and the tests pin it per role. The team-member grant is bounded
 * by the lint that certified the team: a lead holds role `manager`, is not among their own members,
 * and the orchestrator is a member of nothing.
 */
import type { WorkforceConfig, WorkforceEmployeeConfig } from '@rayspec/spec';
import { DelegationTargetInvalidError, ManagerTargetForbiddenError } from './errors.js';

export type DelegationTarget =
  | { readonly kind: 'employee'; readonly id: string }
  | { readonly kind: 'department'; readonly id: string }
  | { readonly kind: 'team'; readonly id: string };

const TARGET_RE = /^(employee|department|team):([a-z_][a-z0-9_]*)$/;

/** Parse the target grammar. A bare id (no prefix) is treated as `employee:<id>`. */
export function parseDelegationTarget(raw: string): DelegationTarget {
  const match = TARGET_RE.exec(raw);
  if (match) {
    return { kind: match[1] as DelegationTarget['kind'], id: match[2] as string };
  }
  if (/^[a-z_][a-z0-9_]*$/.test(raw)) return { kind: 'employee', id: raw };
  throw new DelegationTargetInvalidError(
    raw,
    "expected 'employee:<id>', 'department:<id>', 'team:<id>' or a bare employee id",
  );
}

export interface ResolvedTarget {
  /** The employee who OWNS the child task. */
  readonly owner: string;
  /** The owner's department (ledger attribution), when they have one. */
  readonly department: string | null;
  /** The ORIGINAL target string — lands on the delegation record beside the resolution. */
  readonly delegatedTo: string;
}

export function resolveDelegationTarget(
  config: WorkforceConfig,
  target: DelegationTarget,
): ResolvedTarget {
  const raw = `${target.kind}:${target.id}`;
  if (target.kind === 'employee') {
    const employee = config.employees.get(target.id);
    if (!employee) {
      throw new DelegationTargetInvalidError(raw, 'no such employee is declared');
    }
    return { owner: employee.id, department: employee.department, delegatedTo: raw };
  }
  if (target.kind === 'department') {
    const department = config.departments.get(target.id);
    if (!department) {
      throw new DelegationTargetInvalidError(raw, 'no such department is declared');
    }
    const manager = config.employees.get(department.manager);
    if (!manager) {
      throw new DelegationTargetInvalidError(raw, 'the department manager is not declared');
    }
    return { owner: manager.id, department: manager.department, delegatedTo: raw };
  }
  const team = config.teams.get(target.id);
  if (!team) {
    throw new DelegationTargetInvalidError(raw, 'no such team is declared');
  }
  const lead = config.employees.get(team.lead);
  if (!lead) {
    throw new DelegationTargetInvalidError(raw, 'the team lead is not declared');
  }
  return { owner: lead.id, department: lead.department, delegatedTo: raw };
}

/**
 * The manager restriction. Throws unless the RESOLVED owner is a member of the manager's own
 * department, or a member of a team the manager leads AND THIS TASK IS THAT TEAM'S WORK.
 *
 * `activeTeamIds` carries the second condition, read from the delegation chain (snapshot.ts): the
 * teams whose `team:` delegation opened this task or an ancestor. Without it the led-team grant was
 * unbounded — a manager who leads a cross-functional team could delegate to any of its members from
 * ANY task, on any subject, and charge it to that member's department. Teams are deliberately
 * cross-functional, so the fix is not to force members to share a department; it is to let the
 * grant exist only where the team is why the work is happening. Outside team work a manager
 * targets their own department, exactly as the description says.
 *
 * A `team:` target is refused outright — see the module header: it resolves to the team's lead,
 * which is the manager themselves for a team they lead (self-delegation) and a forbidden owner for
 * one they do not. (Orchestrators are unrestricted; workers and reviewers carry no delegation tool
 * at all, so this is never consulted for them.)
 */
export function assertManagerMayTarget(
  config: WorkforceConfig,
  manager: WorkforceEmployeeConfig,
  target: DelegationTarget,
  resolved: ResolvedTarget,
  activeTeamIds: readonly string[] = [],
): void {
  if (target.kind === 'team') {
    throw new ManagerTargetForbiddenError(
      manager.id,
      resolved.delegatedTo,
      'a team resolves to its lead, so addressing one is the orchestrator seat’s move — name the ' +
        'team members you need (employee:<id>), or hand the whole team’s work to its lead',
    );
  }
  const ownDepartment =
    manager.department !== null ? config.departments.get(manager.department) : undefined;
  if (ownDepartment?.members.includes(resolved.owner)) return;
  const ledTeamsOnThisWork = [...config.teams.entries()].filter(
    ([teamId, team]) => team.lead === manager.id && activeTeamIds.includes(teamId),
  );
  if (ledTeamsOnThisWork.some(([, team]) => team.members.includes(resolved.owner))) return;
  throw new ManagerTargetForbiddenError(manager.id, resolved.delegatedTo);
}
