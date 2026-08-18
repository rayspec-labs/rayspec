/**
 * The `workforce:` semantic lint — every cross-reference, structural and coherence rule the
 * grammar's shape cannot express, each a typed fail-closed `SpecError` with an exact JSON path.
 * Composed into `lintSpec`/`lintSpecWarnings` (lint.ts); both entry points no-op when the section
 * is absent, so a workforce-free document pays nothing.
 *
 * The rule set, in the order checked below: agent references resolve · exactly one orchestrator
 * seat (held by the named employee, reporting to nobody, belonging to nothing) · department
 * managers hold the manager role (or the orchestrator seat), stand outside their own members, and
 * manage the department they themselves belong to · every member/reportsTo/team reference
 * resolves · employee↔department membership coheres in BOTH directions · the EFFECTIVE reporting
 * graph (explicit `reportsTo`, else the department's manager) is acyclic and reaches the
 * orchestrator from every employee · ids are unique within and ACROSS employees/departments/teams
 * (delegation targets are `employee:<id>`/`department:<id>`/`team:<id>` strings; cross-section
 * ambiguity would make them unreadable) · decision roles demand native structured output of their
 * backend · review policies name a reviewer-or-manager reviewer and a non-empty selector ·
 * approval policies that escalate on timeout never cover the orchestrator seat · every
 * `requireWhen` policy label is HELD by some declared employee · department budgets
 * never out-rate the workforce ceiling · a usd ceiling requires the task budget its per-turn
 * estimate derives from · reserved ids and reserved native tool names are refused · teams fit
 * their declared size WHEN THEY DECLARE ONE, are LED BY A MANAGER, and hold neither their own lead
 * nor the orchestrator among their members · a workforce requires the durable worker that runs it.
 *
 * A recurring shape in the structural rules: every one of them exists because some RUNTIME path
 * keys on the declaration, and a declaration the runtime reads differently than a reader does is
 * the defect. A team's lead is who `team:<id>` resolves to; a manager's authority is their own
 * membership field; an approval's escalation target is the reporting edge. Where those disagree
 * with what the document appears to say, the rule is here rather than in a comment.
 */
import {
  type AgentSpec,
  type BackendId,
  isReservedWorkforceSegment,
  isReservedWorkforceToolSpelling,
  RESERVED_WORKFORCE_SEGMENTS,
  validateSpec,
} from '@rayspec/core';
import { type SpecError, type SpecWarning, specError } from './errors.js';
import type { RaySpec } from './grammar.js';
import type { WorkforceBudgetWindowName, WorkforceEmployeeSpec } from './workforce-grammar.js';

/**
 * Hours per calendar window — normalizes budget rates for the widening comparison. Ordering only,
 * never billing: the engine enforces per-window amounts against real UTC calendar buckets
 * (`windowStartFor`), this rule only ORDERS two declared rates against each other.
 *
 * `monthly` is 730 h — 8760/12, the exact average — and is NOMINAL by necessity: real calendar
 * months run 672–744 h, so no constant is exact and a comparison involving `monthly` is
 * approximate by construction. That is acceptable precisely because this table never decides an
 * amount; it decides whether one declared ceiling out-rates another.
 *
 * EXHAUSTIVE BY TYPE: keyed on `WorkforceBudgetWindowName`, so a window added to the grammar
 * without a normalization factor is a COMPILE error here — never a silent `?? 24` that would
 * compare a new window as if it were daily.
 */
const WINDOW_HOURS: Readonly<Record<WorkforceBudgetWindowName, number>> = {
  hourly: 1,
  daily: 24,
  weekly: 168,
  monthly: 730,
};

function windowHours(window: WorkforceBudgetWindowName | undefined): number {
  return WINDOW_HOURS[window ?? 'daily'];
}

/**
 * The EFFECTIVE reporting edge: explicit `reportsTo` wins; a department member without one reports
 * to the department's manager (a manager is not their own superior — their own edge must be
 * explicit or resolve through their OWN department field); anyone else has no superior, which is
 * legal only for the orchestrator.
 */
function effectiveReportsTo(
  employee: WorkforceEmployeeSpec,
  departmentManagerOf: ReadonlyMap<string, string>,
): string | null {
  if (employee.reportsTo !== undefined) return employee.reportsTo;
  if (employee.department !== undefined) {
    const manager = departmentManagerOf.get(employee.department);
    if (manager !== undefined && manager !== employee.id) return manager;
  }
  return null;
}

export function lintWorkforce(spec: RaySpec): SpecError[] {
  const workforce = spec.workforce;
  if (workforce === undefined) return [];
  const errors: SpecError[] = [];
  const path = (suffix: string) => `workforce.${suffix}`;

  const agentIds = new Set(spec.agents.map((a) => a.id));
  const employeeById = new Map(workforce.employees.map((e) => [e.id, e]));
  const departmentById = new Map(workforce.departments.map((d) => [d.id, d]));
  const departmentManagerOf = new Map(workforce.departments.map((d) => [d.id, d.manager]));

  // ---- RESERVED IDS ----------------------------------------------------------------------
  if (isReservedWorkforceSegment(workforce.id)) {
    errors.push(
      specError(
        'reserved_workforce_id',
        `workforce id '${workforce.id}' is a reserved path segment ` +
          `(${RESERVED_WORKFORCE_SEGMENTS.join(', ')}) — the HTTP surface spends those names on ` +
          'its own collections',
        path('id'),
      ),
    );
  }
  workforce.employees.forEach((employee, ei) => {
    if (employee.id === 'user') {
      errors.push(
        specError(
          'reserved_workforce_id',
          "employee id 'user' is reserved — it is the human-owner sentinel every task owner " +
            'column and the redeploy gate key on',
          path(`employees[${ei}].id`),
        ),
      );
    }
  });

  // ---- DUPLICATES (within each section, and ACROSS the three id namespaces) --------------
  const dupWithin = <T>(
    items: readonly T[],
    keyOf: (item: T) => string,
    section: string,
    pathOf: (index: number) => string,
  ): void => {
    const seen = new Set<string>();
    items.forEach((item, index) => {
      const key = keyOf(item);
      if (seen.has(key)) {
        errors.push(specError('duplicate_name', `duplicate ${section} '${key}'`, pathOf(index)));
      } else {
        seen.add(key);
      }
    });
  };
  dupWithin(
    workforce.employees,
    (e) => e.id,
    'employee id',
    (i) => path(`employees[${i}].id`),
  );
  dupWithin(
    workforce.departments,
    (d) => d.id,
    'department id',
    (i) => path(`departments[${i}].id`),
  );
  dupWithin(
    workforce.teams,
    (t) => t.id,
    'team id',
    (i) => path(`teams[${i}].id`),
  );
  dupWithin(
    workforce.reviewPolicies,
    (p) => p.id,
    'review policy id',
    (i) => path(`reviewPolicies[${i}].id`),
  );
  dupWithin(
    workforce.approvalPolicies,
    (a) => a.id,
    'approval policy id',
    (i) => path(`approvalPolicies[${i}].id`),
  );
  // Cross-section: a delegation target is written `employee:<id>` / `department:<id>` /
  // `team:<id>`; one id living in two sections makes every human-readable surface ambiguous.
  workforce.departments.forEach((department, di) => {
    if (employeeById.has(department.id)) {
      errors.push(
        specError(
          'duplicate_name',
          `id '${department.id}' is used by both an employee and a department — ids may not be ` +
            'shared across employees, departments and teams',
          path(`departments[${di}].id`),
        ),
      );
    }
  });
  workforce.teams.forEach((team, ti) => {
    if (employeeById.has(team.id) || departmentById.has(team.id)) {
      errors.push(
        specError(
          'duplicate_name',
          `id '${team.id}' is used by another section — ids may not be shared across employees, ` +
            'departments and teams',
          path(`teams[${ti}].id`),
        ),
      );
    }
  });

  // ---- AGENT REFERENCES + DECISION-ROLE CAPABILITY + RESERVED TOOL NAMES ------------------
  const toolById = new Map(spec.tooling.map((t) => [t.id, t]));
  workforce.employees.forEach((employee, ei) => {
    const agent = spec.agents.find((a) => a.id === employee.agent);
    if (!agentIds.has(employee.agent) || agent === undefined) {
      errors.push(
        specError(
          'dangling_ref',
          `employee '${employee.id}' references undeclared agent '${employee.agent}'`,
          path(`employees[${ei}].agent`),
        ),
      );
      return;
    }
    // The native workforce toolset is INJECTED at dispatch and composes with the agent's declared
    // tools — an agent-declared outputSchema would project into the structured-output slot and
    // short-circuit every tool call, natives included (the same structural rule that already
    // rejects tools+outputSchema, extended to the tools this employee is GUARANTEED to carry).
    if (agent.outputSchema) {
      const ai = spec.agents.findIndex((a) => a.id === agent.id);
      errors.push(
        specError(
          'agent_output_schema_shortcircuits_tools',
          `agent '${agent.id}' is bound to workforce employee '${employee.id}' and declares an ` +
            'outputSchema — the structured output short-circuits the injected native toolset and ' +
            'no tool (submit_result included) would ever be called',
          `agents[${ai}].outputSchema`,
        ),
      );
    }
    // Reserved native tool names — natives win at dispatch, so a colliding declared tool would be
    // silently shadowed. Scoped to agents a workforce employee actually runs.
    for (const toolId of agent.tools) {
      const tool = toolById.get(toolId);
      if (tool !== undefined && isReservedWorkforceToolSpelling(tool.name)) {
        const ti = spec.tooling.findIndex((t) => t.id === toolId);
        errors.push(
          specError(
            'reserved_tool_name',
            `tool '${tool.name}' (id '${toolId}') is declared by agent '${agent.id}', which runs ` +
              `workforce employee '${employee.id}' — that name belongs to a native workforce tool ` +
              'injected at dispatch and may not be redeclared',
            `tooling[${ti}].name`,
          ),
        );
      }
    }
    // Decision roles (orchestrator/manager/reviewer) emit typed contracts the runtime parses —
    // their backend must produce structured output NATIVELY. Enforced through the same core
    // validateSpec mechanism every agent capability check uses, with the demand turned on.
    if (employee.role !== 'worker') {
      const synthetic: AgentSpec = {
        name: agent.name,
        instructions: agent.instructions,
        model: agent.model,
        input: '',
        tools: [],
        maxTurns: agent.maxTurns,
        outputSchema: { name: 'workforce_decision', schema: { type: 'object' } },
      };
      const res = validateSpec(synthetic, agent.backend as BackendId, {
        requireNativeStructuredOutput: true,
      });
      if (!res.ok) {
        for (const violation of res.violations) {
          errors.push(
            specError(
              'capability_violation',
              `employee '${employee.id}' holds role '${employee.role}' but its agent ` +
                `'${agent.id}' (backend '${agent.backend}') cannot carry a decision role: ` +
                `${violation.message}`,
              path(`employees[${ei}].agent`),
            ),
          );
        }
      }
    }
  });

  // ---- THE ORCHESTRATOR SEAT ---------------------------------------------------------------
  const orchestrator = employeeById.get(workforce.orchestrator);
  if (orchestrator === undefined) {
    errors.push(
      specError(
        'dangling_ref',
        `orchestrator '${workforce.orchestrator}' names no declared employee`,
        path('orchestrator'),
      ),
    );
  } else if (orchestrator.role !== 'orchestrator') {
    errors.push(
      specError(
        'invalid_orchestrator',
        `orchestrator '${workforce.orchestrator}' holds role '${orchestrator.role}' — the entry ` +
          "point must hold role 'orchestrator'",
        path('orchestrator'),
      ),
    );
  }
  workforce.employees.forEach((employee, ei) => {
    if (employee.role === 'orchestrator' && employee.id !== workforce.orchestrator) {
      errors.push(
        specError(
          'invalid_orchestrator',
          `employee '${employee.id}' holds role 'orchestrator' but the workforce entry point is ` +
            `'${workforce.orchestrator}' — exactly one orchestrator seat exists`,
          path(`employees[${ei}].role`),
        ),
      );
    }
    if (employee.role === 'orchestrator' && employee.reportsTo !== undefined) {
      errors.push(
        specError(
          'invalid_orchestrator',
          `orchestrator '${employee.id}' declares reportsTo — the reporting chain roots AT the ` +
            'orchestrator',
          path(`employees[${ei}].reportsTo`),
        ),
      );
    }
    if (employee.role === 'orchestrator' && employee.department !== undefined) {
      errors.push(
        specError(
          'invalid_orchestrator',
          `orchestrator '${employee.id}' declares a department — the orchestrator sits above ` +
            'departments, and a membership would install that department manager as the ' +
            "orchestrator's superior",
          path(`employees[${ei}].department`),
        ),
      );
    }
  });

  // ---- DEPARTMENTS -------------------------------------------------------------------------
  workforce.departments.forEach((department, di) => {
    const manager = employeeById.get(department.manager);
    if (manager === undefined) {
      errors.push(
        specError(
          'dangling_ref',
          `department '${department.id}' manager '${department.manager}' names no declared employee`,
          path(`departments[${di}].manager`),
        ),
      );
    } else if (manager.role !== 'manager' && manager.id !== workforce.orchestrator) {
      errors.push(
        specError(
          'invalid_manager',
          `department '${department.id}' manager '${department.manager}' holds role ` +
            `'${manager.role}' — a manager holds role 'manager' (or the orchestrator seat)`,
          path(`departments[${di}].manager`),
        ),
      );
    }
    if (department.members.includes(department.manager)) {
      errors.push(
        specError(
          'manager_in_members',
          `department '${department.id}' lists its manager '${department.manager}' among its own ` +
            'members — a manager answers FOR the department, never inside it',
          path(`departments[${di}].members`),
        ),
      );
    }
    // A MANAGER'S AUTHORITY IS THEIR OWN MEMBERSHIP FIELD. Delegation scoping asks which department
    // the employee BELONGS to (`employee.department`), never which departments name them as
    // manager — so an employee managing B while declaring A re-keys the whole grant: they reach A's
    // members, whom they do not manage, and none of B's, whom they do. The orchestrator is exempt
    // because it declares no membership at all (its own rule below), so nothing can disagree.
    if (
      manager !== undefined &&
      manager.id !== workforce.orchestrator &&
      manager.department !== undefined &&
      manager.department !== department.id
    ) {
      errors.push(
        specError(
          'department_mismatch',
          `department '${department.id}' names manager '${department.manager}', whose own ` +
            `department is '${manager.department}' — delegation scoping keys on the manager's own ` +
            'membership, so this grants them authority over the wrong department and none over this one',
          path(`departments[${di}].manager`),
        ),
      );
    }
    department.members.forEach((member, mi) => {
      const employee = employeeById.get(member);
      if (employee === undefined) {
        errors.push(
          specError(
            'dangling_ref',
            `department '${department.id}' member '${member}' names no declared employee`,
            path(`departments[${di}].members[${mi}]`),
          ),
        );
        return;
      }
      if (employee.department !== department.id) {
        errors.push(
          specError(
            'department_mismatch',
            `department '${department.id}' lists member '${member}' whose own department field ` +
              `is ${employee.department === undefined ? 'absent' : `'${employee.department}'`}`,
            path(`departments[${di}].members[${mi}]`),
          ),
        );
      }
    });
  });
  workforce.employees.forEach((employee, ei) => {
    if (employee.department === undefined) return;
    const department = departmentById.get(employee.department);
    if (department === undefined) {
      errors.push(
        specError(
          'dangling_ref',
          `employee '${employee.id}' department '${employee.department}' names no declared department`,
          path(`employees[${ei}].department`),
        ),
      );
      return;
    }
    if (!department.members.includes(employee.id) && department.manager !== employee.id) {
      errors.push(
        specError(
          'department_mismatch',
          `employee '${employee.id}' declares department '${employee.department}' but is neither ` +
            'in its members nor its manager',
          path(`employees[${ei}].department`),
        ),
      );
    }
  });

  // ---- reportsTo RESOLUTION + THE EFFECTIVE REPORTING GRAPH --------------------------------
  workforce.employees.forEach((employee, ei) => {
    if (employee.reportsTo !== undefined && !employeeById.has(employee.reportsTo)) {
      errors.push(
        specError(
          'dangling_ref',
          `employee '${employee.id}' reportsTo '${employee.reportsTo}' names no declared employee`,
          path(`employees[${ei}].reportsTo`),
        ),
      );
    }
  });
  // Walk the effective edges only when every reference resolves (a dangling edge is already its
  // own error; walking it would duplicate noise).
  const edgesResolve = errors.every((e) => e.code !== 'dangling_ref');
  if (edgesResolve && orchestrator !== undefined) {
    workforce.employees.forEach((employee, ei) => {
      if (employee.id === workforce.orchestrator) return;
      const seen = new Set<string>([employee.id]);
      let current: string | null = effectiveReportsTo(employee, departmentManagerOf);
      if (current === null) {
        errors.push(
          specError(
            'orphan_employee',
            `employee '${employee.id}' has no effective superior (no reportsTo, and no department ` +
              'manager to fall back to) — every employee must reach the orchestrator',
            path(`employees[${ei}]`),
          ),
        );
        return;
      }
      while (current !== null) {
        if (current === workforce.orchestrator) return;
        if (seen.has(current)) {
          errors.push(
            specError(
              'reporting_cycle',
              `employee '${employee.id}' sits on a reporting cycle through '${current}' — the ` +
                'effective reporting graph must be acyclic',
              path(`employees[${ei}].reportsTo`),
            ),
          );
          return;
        }
        seen.add(current);
        const next = employeeById.get(current);
        current = next === undefined ? null : effectiveReportsTo(next, departmentManagerOf);
      }
      errors.push(
        specError(
          'orphan_employee',
          `employee '${employee.id}' has a reporting chain that never reaches the orchestrator`,
          path(`employees[${ei}]`),
        ),
      );
    });
  }

  // ---- TEAMS -------------------------------------------------------------------------------
  // A team is a DELEGATION TARGET: `team:<id>` resolves to its LEAD, and the lead is then expected
  // to fan the work out to the members on their own turn. Every rule here follows from that one
  // fact — a team whose lead cannot delegate, or whose lead is the delegator, is a declaration
  // that reads like an org chart and behaves like a dead end.
  workforce.teams.forEach((team, ti) => {
    const lead = employeeById.get(team.lead);
    if (lead === undefined) {
      errors.push(
        specError(
          'dangling_ref',
          `team '${team.id}' lead '${team.lead}' names no declared employee`,
          path(`teams[${ti}].lead`),
        ),
      );
    } else if (lead.role !== 'manager') {
      errors.push(
        specError(
          'invalid_manager',
          `team '${team.id}' lead '${team.lead}' holds role '${lead.role}' — a team lead holds ` +
            "role 'manager': 'team:' resolves to the lead, and a worker or reviewer lead carries " +
            'no delegation tool to fan the work out with, while the orchestrator seat would be ' +
            'resolving a team to itself',
          path(`teams[${ti}].lead`),
        ),
      );
    }
    if (team.members.includes(team.lead)) {
      errors.push(
        specError(
          'manager_in_members',
          `team '${team.id}' lists its lead '${team.lead}' among its own members — a lead answers ` +
            'FOR the team, never inside it (the same rule a department manager answers to)',
          path(`teams[${ti}].members`),
        ),
      );
    }
    team.members.forEach((member, mi) => {
      if (!employeeById.has(member)) {
        errors.push(
          specError(
            'dangling_ref',
            `team '${team.id}' member '${member}' names no declared employee`,
            path(`teams[${ti}].members[${mi}]`),
          ),
        );
        return;
      }
      if (member === workforce.orchestrator) {
        errors.push(
          specError(
            'invalid_orchestrator',
            `team '${team.id}' lists the orchestrator '${member}' among its members — the ` +
              'orchestrator sits above teams, and the membership would hand the team lead ' +
              'delegation authority over the entry-point seat',
            path(`teams[${ti}].members[${mi}]`),
          ),
        );
      }
    });
    // `maxSize` is OPTIONAL; an omitted cap declares no bound, so there is nothing to exceed.
    if (team.maxSize !== undefined && team.members.length > team.maxSize) {
      errors.push(
        specError(
          'schema_violation',
          `team '${team.id}' declares ${team.members.length} members over its maxSize ` +
            `${team.maxSize}`,
          path(`teams[${ti}].members`),
        ),
      );
    }
  });

  // ---- REVIEW POLICIES ---------------------------------------------------------------------
  workforce.reviewPolicies.forEach((policy, pi) => {
    if (policy.appliesTo.department === undefined && policy.appliesTo.employee === undefined) {
      errors.push(
        specError(
          'schema_violation',
          `review policy '${policy.id}' appliesTo names neither a department nor an employee — ` +
            'an unselectable rule can never fire',
          path(`reviewPolicies[${pi}].appliesTo`),
        ),
      );
    }
    if (
      policy.requireWhen.confidenceBelow === undefined &&
      policy.requireWhen.labels === undefined
    ) {
      errors.push(
        specError(
          'schema_violation',
          `review policy '${policy.id}' requireWhen names neither a confidence threshold nor a ` +
            'policy label — a rule that can never demand review is dead',
          path(`reviewPolicies[${pi}].requireWhen`),
        ),
      );
    }
    if (
      policy.appliesTo.department !== undefined &&
      !departmentById.has(policy.appliesTo.department)
    ) {
      errors.push(
        specError(
          'dangling_ref',
          `review policy '${policy.id}' applies to undeclared department '${policy.appliesTo.department}'`,
          path(`reviewPolicies[${pi}].appliesTo.department`),
        ),
      );
    }
    if (policy.appliesTo.employee !== undefined && !employeeById.has(policy.appliesTo.employee)) {
      errors.push(
        specError(
          'dangling_ref',
          `review policy '${policy.id}' applies to undeclared employee '${policy.appliesTo.employee}'`,
          path(`reviewPolicies[${pi}].appliesTo.employee`),
        ),
      );
    }
    const reviewer = employeeById.get(policy.reviewer);
    if (reviewer === undefined) {
      errors.push(
        specError(
          'dangling_ref',
          `review policy '${policy.id}' reviewer '${policy.reviewer}' names no declared employee`,
          path(`reviewPolicies[${pi}].reviewer`),
        ),
      );
    } else if (reviewer.role !== 'reviewer' && reviewer.role !== 'manager') {
      errors.push(
        specError(
          'invalid_reviewer',
          `review policy '${policy.id}' reviewer '${policy.reviewer}' holds role ` +
            `'${reviewer.role}' — a reviewer holds role 'reviewer' or 'manager'`,
          path(`reviewPolicies[${pi}].reviewer`),
        ),
      );
    }
  });

  // ---- APPROVAL RULES ----------------------------------------------------------------------
  // An `escalate` timeout fate must NAME its next approver, and the only supplier is the requesting
  // employee's reporting edge. The orchestrator has none by the rule above, so a rule that covers
  // that seat declares a fate the runtime cannot build: the toolset omits `escalateTo`, the
  // planner refuses the intent as `invalid_intent`, and the requeue re-runs the same deterministic
  // condition straight into permanent failure. One legal-looking document, one bricked task —
  // which is why this is a parse-time error rather than a runtime fallback nobody declared.
  if (orchestrator !== undefined) {
    workforce.approvalPolicies.forEach((approval, ai) => {
      if (approval.onTimeout !== 'escalate') return;
      const covers = approval.requireWhen.labels.filter((label) =>
        orchestrator.labels.includes(label),
      );
      if (covers.length === 0) return;
      errors.push(
        specError(
          'invalid_orchestrator',
          `approval policy '${approval.id}' escalates on timeout and covers the orchestrator seat ` +
            `'${orchestrator.id}' (label ${covers.map((c) => `'${c}'`).join(', ')}) — the ` +
            'orchestrator reports to nobody, so there is no approver to escalate to and every ' +
            "such request would fail deterministically. Declare onTimeout: 'fail' for this seat",
          path(`approvalPolicies[${ai}].onTimeout`),
        ),
      );
    });
  }

  // ---- POLICY LABELS ARE HELD -------------------------------------------------------------
  // A label NO declared employee holds makes the CLAUSE that names it dead: the matcher is exact
  // equality against `employees[].labels` (@rayspec/core review-policy.ts `requiresReview`;
  // workforce-tools review-policy.ts `matchApprovalRule`), and every holder is declared in THIS
  // document, so a redeploy is the only way a holder arrives — and a redeploy re-runs this lint.
  // That is why it is an ERROR rather than the advisory it used to be, whose "the label may arrive
  // later" premise was simply false.
  //
  // What the dead clause COSTS depends on what else the rule declares, and the message says which
  // case the author is in rather than asserting one of them for all three:
  //
  //   - an approval policy — `requireWhen` is `{ labels }` and nothing else, so the rule is dead
  //     outright and work that should park for a human silently does not;
  //   - a review policy naming ONLY `labels` — likewise dead, it can no longer demand review;
  //   - a review policy ALSO naming `confidenceBelow` — the rule still FIRES, because the two
  //     selectors combine with OR (core review-policy.ts `requiresReview`). This is the case worth
  //     being precise about: the labels branch is the ENFORCEMENT branch, firing unconditionally on
  //     a declared label, while `confidenceBelow` matches a number the SUBMITTING TURN wrote and is
  //     "a heuristic over self-report, not a control" (workforce-tools review-policy.ts). So an
  //     unheld label here does not disable a spare clause — it silently DOWNGRADES the rule from a
  //     control to a heuristic a turn can dodge by reporting high confidence. Refusing that is the
  //     point of the rule; claiming the rule "can never fire" would be false about that document.
  const heldLabels = new Set(workforce.employees.flatMap((e) => e.labels));
  const unheld = (label: string, where: string, consequence: string, at: string): void => {
    if (heldLabels.has(label)) return;
    errors.push(
      specError(
        'workforce_label_unheld',
        `${where} guards label '${label}', which no declared employee holds — this clause can ` +
          `never fire, ${consequence}. Add the label to the employees it should cover, or remove ` +
          'it from the rule',
        path(at),
      ),
    );
  };
  workforce.reviewPolicies.forEach((policy, pi) => {
    // The remainder of THIS rule once the labels clause is dead — read off the declaration, never
    // assumed, because `requireWhen` may legally name both selectors.
    const consequence =
      policy.requireWhen.confidenceBelow === undefined
        ? 'and it is the rule’s only selector, so the rule can no longer demand review at all'
        : 'leaving the rule with only its confidenceBelow heuristic, which matches a confidence ' +
          'the submitting turn writes itself and so is not the unconditional control this label was';
    (policy.requireWhen.labels ?? []).forEach((label, li) => {
      unheld(
        label,
        `review policy '${policy.id}'`,
        consequence,
        `reviewPolicies[${pi}].requireWhen.labels[${li}]`,
      );
    });
  });
  workforce.approvalPolicies.forEach((approval, ai) => {
    approval.requireWhen.labels.forEach((label, li) => {
      unheld(
        label,
        `approval policy '${approval.id}'`,
        // `requireWhen` on an approval policy is `{ labels }` and nothing else, so the dead clause
        // is the whole selector — no second branch exists to soften it.
        'and it is the policy’s only selector, so work that should park for a human silently ' +
          'would not',
        `approvalPolicies[${ai}].requireWhen.labels[${li}]`,
      );
    });
  });

  // ---- BUDGET COHERENCE --------------------------------------------------------------------
  const workforceUsd = workforce.budgets?.workforce;
  // EVERY usd tier counts, `subtree` included: the engine's own coherence refusal keys on the same
  // set (budget.ts's `declaresUsd`), so a tier missing here would derive a budgets object the
  // engine REFUSES at boot — a document that passed `doctor` and then stops the workforce.
  // Keyed on `.usd` at EVERY tier, never on the tier OBJECT. Today `budgets.workforce.usd` is
  // required, so `workforceUsd !== undefined` would be equivalent — but only by accident of that
  // requirement. Should a turns-only workforce ceiling ever be admitted (making `usd` optional),
  // an object-keyed test would demand a `task` budget for a declaration that names no money at
  // all. Written the way the rule MEANS, so that change stays additive.
  const anyUsdCeiling =
    workforceUsd?.usd !== undefined ||
    workforce.budgets?.subtree?.usd !== undefined ||
    workforce.departments.some((d) => d.budgets?.usd !== undefined);
  if (anyUsdCeiling && workforce.budgets?.task === undefined) {
    errors.push(
      specError(
        'schema_violation',
        'a usd ceiling is declared but budgets.task is absent — the engine reserves ' +
          'task.usd / task.turns per turn, and a usd ceiling without a per-turn estimate cannot ' +
          'bound concurrent dispatch. Declare budgets.task { usd, turns }. Fail-closed',
        path('budgets'),
      ),
    );
  }
  if (workforceUsd !== undefined) {
    const workforceRate = workforceUsd.usd / windowHours(workforceUsd.window);
    workforce.departments.forEach((department, di) => {
      const dept = department.budgets;
      if (dept?.usd === undefined) return;
      const deptRate = dept.usd / windowHours(dept.window);
      if (deptRate > workforceRate) {
        errors.push(
          specError(
            'budget_widening',
            `department '${department.id}' budget (${dept.usd} usd / ${dept.window ?? 'daily'}) ` +
              `out-rates the workforce ceiling (${workforceUsd.usd} usd / ` +
              `${workforceUsd.window ?? 'daily'}) — a child ceiling is only ever tighter`,
            path(`departments[${di}].budgets.usd`),
          ),
        );
      }
    });
  }

  // ---- THE DURABLE WORKER ------------------------------------------------------------------
  if (spec.deployment?.durableWorker !== true) {
    errors.push(
      specError(
        'schema_violation',
        'a workforce requires deployment.durableWorker: true — its tasks are dispatched by the ' +
          'durable worker, and without one every task is a stranded row. Fail-closed',
        path(''),
      ),
    );
  }

  return errors;
}

/**
 * The `workforce:` section raises NO advisories. It had exactly one —
 * `workforce_capability_unheld`, an unheld `requireWhen` label — and the pre-freeze grammar review
 * promoted it to the `workforce_label_unheld` ERROR in `lintWorkforce` above. Advisory treatment
 * rested on "the label may arrive later", which is false: holders are declared in the same
 * document, so a later arrival is a redeploy that re-runs this lint.
 *
 * Promoted for BOTH rule kinds, on two different grounds — worth keeping straight, because they are
 * not the same argument. On an approval policy (and on a review policy naming only `labels`) the
 * dead clause kills the rule outright. On a review policy that also names `confidenceBelow` the
 * rule still fires — the selectors combine with OR — but only through the branch a submitting turn
 * writes for itself, so the unheld label silently downgrades a control to a heuristic. Both deserve
 * a refusal; neither is described by "the rule can never fire", which is why the emitted message
 * reports the CLAUSE and names the remainder it leaves behind.
 *
 * The function stays because `lintSpecWarnings` composes it (lint.ts) and because the next
 * genuinely-heuristic workforce rule belongs here rather than in a new seam. Advisory means
 * "a heuristic that must never fail a deploy" — nothing in this section currently qualifies.
 */
export function lintWorkforceWarnings(spec: RaySpec): SpecWarning[] {
  void spec;
  return [];
}
