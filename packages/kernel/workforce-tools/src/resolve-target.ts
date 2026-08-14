/**
 * Delegation-target resolution — `employee:<id>` / `department:<id>` / `team:<id>` to the ONE
 * employee who answers for the work. Resolution picks the OWNER only: a department resolves to its
 * manager (the delegator never needs to know the department's internals), a team resolves to its
 * lead (the lead fans out to the members with the `all` join on its own later turn and takes the
 * synthesis turn when the join wakes it) — resolution never expands a team into N children itself.
 *
 * The manager restriction lives HERE, in the trusted layer the model's tool call passes through:
 * a manager's legal targets are the members of their own department, the teams they LEAD, and the
 * members of those teams. The kernel cannot re-check this (it is roster-free by design), which is
 * why the resolver is the enforcement point and the tests pin it per role.
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
 * department, or the target is a team the manager leads, or the owner is a member of a team the
 * manager leads. (Orchestrators are unrestricted; workers and reviewers carry no delegation tool
 * at all, so this is never consulted for them.)
 */
export function assertManagerMayTarget(
  config: WorkforceConfig,
  manager: WorkforceEmployeeConfig,
  target: DelegationTarget,
  resolved: ResolvedTarget,
): void {
  const ledTeams = [...config.teams.entries()].filter(([, team]) => team.lead === manager.id);
  if (target.kind === 'team') {
    if (ledTeams.some(([teamId]) => teamId === target.id)) return;
    throw new ManagerTargetForbiddenError(manager.id, resolved.delegatedTo);
  }
  const ownDepartment =
    manager.department !== null ? config.departments.get(manager.department) : undefined;
  if (ownDepartment?.members.includes(resolved.owner)) return;
  if (ledTeams.some(([, team]) => team.members.includes(resolved.owner))) return;
  throw new ManagerTargetForbiddenError(manager.id, resolved.delegatedTo);
}
