/**
 * NEGATIVE tests for the `workforce:` section — every case takes a spec that WOULD parse, injects
 * exactly one defect, and asserts the specific closed `SpecErrorCode`. The BASE below is a
 * known-good minimal-but-complete workforce (a sanity test proves it parses), so each rejection
 * isolates one rule. Parse-level rules live here beside the semantic lint battery; every rule in
 * the validation table has exactly one failing case.
 */
import { describe, expect, it } from 'vitest';
import type { SpecErrorCode } from './errors.js';
import { exportJsonSchema } from './export.js';
import { lintSpecWarnings } from './lint.js';
import { type ParseSpecOptions, parseSpec } from './parse.js';
import {
  MAX_DEPARTMENT_MISSION_LENGTH,
  MAX_EMPLOYEE_TITLE_LENGTH,
  MAX_WORKFORCE_NAME_LENGTH,
  WorkforceSpec,
} from './workforce-grammar.js';

const ON: ParseSpecOptions = { experimentalWorkforce: true };

/** A known-good base: one department, four employees (one per role), a team, a policy, an approval. */
const WORKFORCE_BASE = `
version: '1.0'
metadata:
  name: workforce-base
deployment:
  durableWorker: true
agents:
  - id: lead_agent
    name: lead_agent
    backend: openai
    model: gpt-4o-mini
    instructions: Coordinate the workforce.
  - id: mgr_agent
    name: mgr_agent
    backend: anthropic
    model: claude-sonnet-4-5
    instructions: Run the department.
  - id: dev_agent
    name: dev_agent
    backend: pi
    model: gpt-4o-mini
    instructions: Do the work.
  - id: qa_agent
    name: qa_agent
    backend: codex
    model: gpt-5-codex
    instructions: Review the work.
workforce:
  id: helpdesk
  name: Helpdesk
  orchestrator: lead
  budgets:
    workforce: { usd: 40 }
    task: { usd: 2.5, turns: 12 }
    delegation: { maxDepth: 4, maxPerTask: 12 }
  execution:
    maxConcurrentWorkers: 4
    maxTaskWallClock: 45m
    maxReviewRounds: 2
    onBudgetExhausted: block_and_escalate
  departments:
    - id: engineering
      name: Engineering
      manager: mgr
      mission: Own the fixes.
      members: [dev]
      budgets: { usd: 10 }
  employees:
    - id: lead
      agent: lead_agent
      title: Lead
      role: orchestrator
    - id: mgr
      agent: mgr_agent
      title: Manager
      department: engineering
      reportsTo: lead
      role: manager
    - id: dev
      agent: dev_agent
      title: Developer
      department: engineering
      reportsTo: mgr
      role: worker
      capabilities: [production_change]
    - id: qa
      agent: qa_agent
      title: Reviewer
      reportsTo: lead
      role: reviewer
  teams:
    - id: fix_team
      lead: mgr
      members: [dev, qa]
      maxSize: 3
  reviewPolicies:
    - id: eng_default
      appliesTo: { department: engineering }
      reviewer: qa
      requireWhen: { confidenceBelow: 0.75, capabilities: [production_change] }
      onReject: rework
      maxRounds: 2
  approvals:
    - id: public_statement
      requireWhen: { capabilities: [public_statement] }
      approver: user
      timeout: 72h
      onTimeout: escalate
`;

function expectRejection(yaml: string, code: SpecErrorCode, opts: ParseSpecOptions = ON): void {
  const res = parseSpec(yaml, opts);
  expect(res.ok).toBe(false);
  if (res.ok) return;
  expect(res.errors.map((e) => e.code)).toContain(code);
}

describe('the workforce base parses (each negative isolates ONE defect)', () => {
  it('parses clean under the opt-in', () => {
    const res = parseSpec(WORKFORCE_BASE, ON);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.workforce?.id).toBe('helpdesk');
      expect(res.value.workforce?.employees).toHaveLength(4);
    }
  });
});

describe('the experimental gate', () => {
  it('rejects a workforce section unless the caller opts in (fail-closed default)', () => {
    const res = parseSpec(WORKFORCE_BASE);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors).toEqual([
      expect.objectContaining({ code: 'experimental_section_disabled', path: 'workforce' }),
    ]);
  });

  it('an opted-in parse of a workforce-free spec is byte-identical to the default parse', () => {
    const minimal = "version: '1.0'\nmetadata:\n  name: plain\n";
    expect(parseSpec(minimal, ON)).toEqual(parseSpec(minimal));
  });
});

describe('grammar strictness under workforce:', () => {
  it('rejects an unknown key inside the workforce section (strict, fail-closed)', () => {
    expectRejection(
      WORKFORCE_BASE.replace('  name: Helpdesk\n', '  name: Helpdesk\n  mood: x\n'),
      'unknown_field',
    );
  });

  it('rejects an unknown key inside an employee', () => {
    expectRejection(
      WORKFORCE_BASE.replace(
        '      role: orchestrator\n',
        '      role: orchestrator\n      tools: [shell]\n',
      ),
      'unknown_field',
    );
  });

  it('rejects an unknown key inside a department, a team, a review policy and an approval', () => {
    expectRejection(
      WORKFORCE_BASE.replace('      members: [dev]\n', '      members: [dev]\n      lead: mgr\n'),
      'unknown_field',
    );
    expectRejection(
      WORKFORCE_BASE.replace('      maxSize: 3\n', '      maxSize: 3\n      dynamic: true\n'),
      'unknown_field',
    );
    expectRejection(
      WORKFORCE_BASE.replace('      maxRounds: 2\n', '      maxRounds: 2\n      onAccept: done\n'),
      'unknown_field',
    );
    expectRejection(
      WORKFORCE_BASE.replace(
        '      onTimeout: escalate\n',
        '      onTimeout: escalate\n      autoApprove: true\n',
      ),
      'unknown_field',
    );
  });

  it('a role outside the closed set is a schema violation', () => {
    expectRejection(WORKFORCE_BASE.replace('role: worker', 'role: intern'), 'schema_violation');
  });

  it('a malformed duration is a schema violation (closed pattern)', () => {
    expectRejection(
      WORKFORCE_BASE.replace('maxTaskWallClock: 45m', 'maxTaskWallClock: 45 minutes'),
      'schema_violation',
    );
    expectRejection(WORKFORCE_BASE.replace('timeout: 72h', 'timeout: soon'), 'schema_violation');
  });

  it('pins the WorkforceSpec key set (a surface change is a deliberate decision)', () => {
    expect(Object.keys(WorkforceSpec.shape).sort()).toEqual([
      'approvals',
      'budgets',
      'departments',
      'employees',
      'execution',
      'id',
      'name',
      'orchestrator',
      'reviewPolicies',
      'teams',
    ]);
  });
});

/**
 * BOUNDED CONTEXT — the deterministic bounded-context invariant, asserted at the declaration. These
 * three free-text fields render into the turn frame, which is byte-bounded per section
 * (`@rayspec/workforce-tools` context.ts: identity 1 024 B,
 * roleFrame 4 096 B, whole input 65 536 B). Unbounded, an oversized `mission` VALIDATES CLEAN and
 * then throws `ContextSectionOverflowError` at every dispatch for that department's seats — a late
 * failure the author never saw at `doctor`. The cap moves the refusal to validation, typed.
 *
 * The caps bound the fields; they are NOT a proof that a section always fits (the role frame renders
 * one line per department, so N departments still compose past the budget — `ContextSectionOverflow`
 * remains the aggregate guard, and it names the fix). Both halves are asserted: the boundary value
 * PARSES, one code unit more is refused at its exact path.
 */
describe('free-text fields are bounded for the byte-bounded turn frame', () => {
  const at = (n: number) => 'a'.repeat(n);
  const errorsFor = (yaml: string) => {
    const res = parseSpec(yaml, ON);
    expect(res.ok).toBe(false);
    return res.ok ? [] : res.errors;
  };

  it('accepts each field exactly AT its cap', () => {
    expect(
      parseSpec(
        WORKFORCE_BASE.replace('  name: Helpdesk\n', `  name: ${at(MAX_WORKFORCE_NAME_LENGTH)}\n`),
        ON,
      ).ok,
    ).toBe(true);
    expect(
      parseSpec(
        WORKFORCE_BASE.replace('title: Lead', `title: ${at(MAX_EMPLOYEE_TITLE_LENGTH)}`),
        ON,
      ).ok,
    ).toBe(true);
    expect(
      parseSpec(
        WORKFORCE_BASE.replace(
          'mission: Own the fixes.',
          `mission: ${at(MAX_DEPARTMENT_MISSION_LENGTH)}`,
        ),
        ON,
      ).ok,
    ).toBe(true);
  });

  it('refuses one code unit past the cap, at the exact path', () => {
    expect(
      errorsFor(
        WORKFORCE_BASE.replace(
          '  name: Helpdesk\n',
          `  name: ${at(MAX_WORKFORCE_NAME_LENGTH + 1)}\n`,
        ),
      ),
    ).toContainEqual(expect.objectContaining({ code: 'schema_violation', path: 'workforce.name' }));
    expect(
      errorsFor(
        WORKFORCE_BASE.replace('title: Lead', `title: ${at(MAX_EMPLOYEE_TITLE_LENGTH + 1)}`),
      ),
    ).toContainEqual(
      expect.objectContaining({ code: 'schema_violation', path: 'workforce.employees[0].title' }),
    );
    expect(
      errorsFor(
        WORKFORCE_BASE.replace(
          'mission: Own the fixes.',
          `mission: ${at(MAX_DEPARTMENT_MISSION_LENGTH + 1)}`,
        ),
      ),
    ).toContainEqual(
      expect.objectContaining({
        code: 'schema_violation',
        path: 'workforce.departments[0].mission',
      }),
    );
  });

  it('the caps fit the turn-frame sections they render into (worst case 3 bytes per code unit)', () => {
    // A UTF-16 code unit costs at most 3 utf-8 bytes (a 4-byte astral char spends TWO code units),
    // so these are the worst-case byte costs the frame must absorb. identity = 1 024 B carries the
    // title; roleFrame = 4 096 B carries the workforce name and one department mission line.
    expect(MAX_EMPLOYEE_TITLE_LENGTH * 3).toBeLessThan(1_024);
    expect((MAX_WORKFORCE_NAME_LENGTH + MAX_DEPARTMENT_MISSION_LENGTH) * 3).toBeLessThan(
      65_536, // the whole-input ceiling; the per-section aggregate stays guarded by ContextSectionOverflowError
    );
  });
});

/**
 * THE "AT LEAST ONE OF" RULE IS PART OF THE SHAPE, not only of the lint. Both selector objects used
 * to be plain `.strict()` objects with every member optional, so the EXPORTED JSON Schema carried
 * `required: []` and any third-party validator — an editor, a CI schema check, another language's
 * client — accepted `appliesTo: {}`: a rule that can never fire, silently. Expressing the rule as a
 * union of `.strict()` variants exports it as `anyOf` with real `required` arrays, so the schema
 * refuses exactly what the lint always refused. Tightening only.
 */
describe('review-policy selectors are closed shapes, not lint-only conventions', () => {
  const reviewPolicySchema = () => {
    const schema = exportJsonSchema() as Record<string, never>;
    const properties = (node: unknown): Record<string, unknown> =>
      (node as { properties: Record<string, unknown> }).properties;
    const workforce = properties(schema).workforce;
    const policies = properties(workforce).reviewPolicies as { items: unknown };
    return properties(policies.items);
  };

  it('the exported schema states the rule: anyOf with NON-EMPTY required arrays', () => {
    const policy = reviewPolicySchema();
    for (const key of ['appliesTo', 'requireWhen'] as const) {
      const node = policy[key] as { anyOf?: { required?: string[] }[] };
      expect(
        node.anyOf,
        `${key} exports no anyOf — the rule is invisible to schema consumers`,
      ).toBeDefined();
      const required = (node.anyOf ?? []).map((variant) => variant.required ?? []);
      expect(required.length).toBeGreaterThan(1);
      for (const names of required) {
        expect(names.length, `${key} exports a variant requiring nothing`).toBeGreaterThan(0);
      }
    }
  });

  it('every single-selector shape still parses (the rule is at-least-one, not exactly-one)', () => {
    for (const replacement of [
      'appliesTo: { department: engineering }',
      'appliesTo: { employee: dev }',
      'appliesTo: { department: engineering, employee: dev }',
    ]) {
      const res = parseSpec(
        WORKFORCE_BASE.replace('appliesTo: { department: engineering }', replacement),
        ON,
      );
      expect(res.ok, `${replacement} should parse`).toBe(true);
    }
    for (const replacement of [
      'requireWhen: { confidenceBelow: 0.75 }',
      'requireWhen: { capabilities: [production_change] }',
    ]) {
      const res = parseSpec(
        WORKFORCE_BASE.replace(
          'requireWhen: { confidenceBelow: 0.75, capabilities: [production_change] }',
          replacement,
        ),
        ON,
      );
      expect(res.ok, `${replacement} should parse`).toBe(true);
    }
  });

  it('the empty selector is refused at PARSE, with a message naming the rule', () => {
    const res = parseSpec(
      WORKFORCE_BASE.replace('appliesTo: { department: engineering }', 'appliesTo: {}'),
      ON,
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    const issue = res.errors.find((e) => e.path === 'workforce.reviewPolicies[0].appliesTo');
    expect(issue?.code).toBe('schema_violation');
    expect(issue?.message).toMatch(/at least one of/);
  });
});

describe('the reserved managed: section', () => {
  it('managed: is accepted, never interpreted, and round-trips byte-for-byte', () => {
    const doc = `${WORKFORCE_BASE}managed:\n  policyEditor:\n    revision: 42\n    labels: [a, b]\n`;
    const res = parseSpec(doc, ON);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.managed).toEqual({ policyEditor: { revision: 42, labels: ['a', 'b'] } });
    }
  });

  it('managed: is not gated by the experimental opt-in (it is a reservation, not a feature)', () => {
    const doc = "version: '1.0'\nmetadata:\n  name: plain\nmanaged:\n  anything: goes\n";
    const res = parseSpec(doc);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.managed).toEqual({ anything: 'goes' });
  });

  it('rejects a managed section that is not a mapping', () => {
    expectRejection(
      "version: '1.0'\nmetadata:\n  name: p\nmanaged: [1, 2]\n",
      'schema_violation',
      {},
    );
    expectRejection("version: '1.0'\nmetadata:\n  name: p\nmanaged: yes\n", 'schema_violation', {});
  });
});

describe('workforce semantic lint — references and the orchestrator seat', () => {
  it('rejects an employee whose agent id is not declared in agents[]', () => {
    expectRejection(
      WORKFORCE_BASE.replace('agent: dev_agent', 'agent: ghost_agent'),
      'dangling_ref',
    );
  });

  it('rejects an orchestrator naming an undeclared employee', () => {
    expectRejection(
      WORKFORCE_BASE.replace('orchestrator: lead', 'orchestrator: ceo'),
      'dangling_ref',
    );
  });

  it('rejects an orchestrator whose employee does not hold role orchestrator', () => {
    expectRejection(
      WORKFORCE_BASE.replace('orchestrator: lead', 'orchestrator: mgr'),
      'invalid_orchestrator',
    );
  });

  it('rejects a second orchestrator-role employee', () => {
    expectRejection(
      WORKFORCE_BASE.replace(
        '      reportsTo: lead\n      role: reviewer\n',
        '      reportsTo: lead\n      role: orchestrator\n',
      ),
      'invalid_orchestrator',
    );
  });

  it('rejects an orchestrator that reports to someone', () => {
    expectRejection(
      WORKFORCE_BASE.replace(
        '      title: Lead\n      role: orchestrator\n',
        '      title: Lead\n      reportsTo: mgr\n      role: orchestrator\n',
      ),
      'invalid_orchestrator',
    );
  });

  it('rejects an orchestrator declaring a department (the membership would install a superior)', () => {
    expectRejection(
      WORKFORCE_BASE.replace(
        '      title: Lead\n      role: orchestrator\n',
        '      title: Lead\n      department: engineering\n      role: orchestrator\n',
      ).replace('members: [dev]', 'members: [dev, lead]'),
      'invalid_orchestrator',
    );
  });
});

describe('workforce semantic lint — departments and membership', () => {
  it('rejects a department manager that is neither role manager nor the orchestrator', () => {
    expectRejection(WORKFORCE_BASE.replace('manager: mgr\n', 'manager: dev\n'), 'invalid_manager');
  });

  it('accepts the orchestrator as a department manager', () => {
    // The orchestrator is also the one seat exempt from the manager-authority rule below: it
    // declares no department of its own, so no membership can disagree with what it manages.
    const doc = WORKFORCE_BASE.replace('manager: mgr\n', 'manager: lead\n').replace(
      '      members: [dev]\n',
      '      members: [dev, mgr]\n',
    );
    const res = parseSpec(doc, ON);
    expect(res.ok).toBe(true);
  });

  it('rejects a department manager listed among its own members', () => {
    expectRejection(
      WORKFORCE_BASE.replace('members: [dev]', 'members: [dev, mgr]'),
      'manager_in_members',
    );
  });

  it('rejects a department member naming an undeclared employee', () => {
    expectRejection(
      WORKFORCE_BASE.replace('members: [dev]', 'members: [dev, phantom]'),
      'dangling_ref',
    );
  });

  it('rejects a reportsTo naming an undeclared employee', () => {
    expectRejection(WORKFORCE_BASE.replace('reportsTo: mgr', 'reportsTo: phantom'), 'dangling_ref');
  });

  it('rejects a team lead or member naming an undeclared employee', () => {
    expectRejection(WORKFORCE_BASE.replace('lead: mgr\n', 'lead: phantom\n'), 'dangling_ref');
    expectRejection(
      WORKFORCE_BASE.replace('members: [dev, qa]', 'members: [dev, phantom]'),
      'dangling_ref',
    );
  });

  it('rejects an employee whose declared department does not list them', () => {
    // dev declares engineering but the department's members no longer carry dev.
    expectRejection(WORKFORCE_BASE.replace('members: [dev]', 'members: []'), 'department_mismatch');
  });

  it('rejects a department member whose own department field is absent or different', () => {
    expectRejection(
      WORKFORCE_BASE.replace(
        '      title: Developer\n      department: engineering\n',
        '      title: Developer\n',
      ),
      'department_mismatch',
    );
  });

  it("rejects an employee's department naming an undeclared department", () => {
    expectRejection(
      WORKFORCE_BASE.replace(
        '      title: Developer\n      department: engineering\n',
        '      title: Developer\n      department: warehouse\n',
      ),
      'dangling_ref',
    );
  });
});

describe('workforce semantic lint — the effective reporting graph', () => {
  it('rejects a reporting cycle (a↔b)', () => {
    expectRejection(
      WORKFORCE_BASE.replace(
        '      department: engineering\n      reportsTo: lead\n      role: manager\n',
        '      department: engineering\n      reportsTo: dev\n      role: manager\n',
      ),
      'reporting_cycle',
    );
  });

  it('rejects a self-reporting employee', () => {
    expectRejection(WORKFORCE_BASE.replace('reportsTo: mgr', 'reportsTo: dev'), 'reporting_cycle');
  });

  it('rejects an employee whose reporting chain does not reach the orchestrator', () => {
    // qa loses its explicit edge and has no department to fall back to.
    expectRejection(
      WORKFORCE_BASE.replace(
        '      title: Reviewer\n      reportsTo: lead\n      role: reviewer\n',
        '      title: Reviewer\n      role: reviewer\n',
      ),
      'orphan_employee',
    );
  });

  it('a department member without an explicit reportsTo falls back to the department manager', () => {
    const res = parseSpec(
      WORKFORCE_BASE.replace(
        '      department: engineering\n      reportsTo: mgr\n      role: worker\n',
        '      department: engineering\n      role: worker\n',
      ),
      ON,
    );
    expect(res.ok).toBe(true);
  });
});

describe('workforce semantic lint — ids, duplicates, reserved names', () => {
  it('rejects two employees sharing an id', () => {
    expectRejection(WORKFORCE_BASE.replace('    - id: qa\n', '    - id: dev\n'), 'duplicate_name');
  });

  it('rejects an id shared between an employee and a team', () => {
    expectRejection(WORKFORCE_BASE.replace('- id: fix_team', '- id: dev'), 'duplicate_name');
  });

  it('rejects a workforce id from the reserved path-segment set', () => {
    for (const segment of ['tasks', 'approvals', 'reviews', 'cost']) {
      expectRejection(
        WORKFORCE_BASE.replace('id: helpdesk', `id: ${segment}`),
        'reserved_workforce_id',
      );
    }
  });

  it("rejects an employee id 'user' (the human-owner sentinel)", () => {
    expectRejection(
      WORKFORCE_BASE.replace('    - id: qa\n', '    - id: user\n').replace(
        'reviewer: qa',
        'reviewer: user',
      ),
      'reserved_workforce_id',
    );
  });

  it('rejects an employee agent tool named after a native workforce tool', () => {
    const doc = WORKFORCE_BASE.replace(
      'agents:\n',
      'tooling:\n  - id: my_submit\n    name: submit_result\n    description: shadows a native\n    parameters:\n      type: object\n    handler: submit_handler\n    idempotent: true\n    timeoutMs: 1000\nhandlers:\n  - id: submit_handler\n    kind: tool\n    module: handlers/submit.ts\n    export: run\nagents:\n',
    ).replace(
      '    instructions: Do the work.\n',
      '    instructions: Do the work.\n    tools: [my_submit]\n',
    );
    expectRejection(doc, 'reserved_tool_name');
  });

  it('rejects the BRIDGED spelling of a native tool name the same way', () => {
    // `mcp__<x>__submit_result` is what one adapter records for a bridged native — an agent tool
    // spelled that way would make a legal yield read as an attempted ending on the OTHER
    // adapters. The lint refuses it with the exact-name collision, through the same predicate
    // the dispatch composition uses.
    const doc = WORKFORCE_BASE.replace(
      'agents:\n',
      'tooling:\n  - id: my_submit\n    name: mcp__tracker__submit_result\n    description: bridged shadow\n    parameters:\n      type: object\n    handler: submit_handler\n    idempotent: true\n    timeoutMs: 1000\nhandlers:\n  - id: submit_handler\n    kind: tool\n    module: handlers/submit.ts\n    export: run\nagents:\n',
    ).replace(
      '    instructions: Do the work.\n',
      '    instructions: Do the work.\n    tools: [my_submit]\n',
    );
    expectRejection(doc, 'reserved_tool_name');
  });

  it('rejects a workforce employee agent that declares an outputSchema', () => {
    const doc = WORKFORCE_BASE.replace(
      '    instructions: Coordinate the workforce.\n',
      '    instructions: Coordinate the workforce.\n    outputSchema:\n      name: decision\n      schema:\n        type: object\n',
    );
    expectRejection(doc, 'agent_output_schema_shortcircuits_tools');
  });
});

describe('workforce semantic lint — decision roles need native structured output', () => {
  it('rejects a decision-role employee whose agent runs on a backend without native structured output', () => {
    // Bind the manager to the pi-backed agent: pi EMULATES structured output, decision roles demand native.
    expectRejection(
      WORKFORCE_BASE.replace(
        '    - id: mgr\n      agent: mgr_agent\n',
        '    - id: mgr\n      agent: dev_agent\n',
      ),
      'capability_violation',
    );
  });

  it('the same restriction binds orchestrators and reviewers', () => {
    expectRejection(
      WORKFORCE_BASE.replace(
        '    - id: lead\n      agent: lead_agent\n',
        '    - id: lead\n      agent: dev_agent\n',
      ),
      'capability_violation',
    );
    expectRejection(
      WORKFORCE_BASE.replace(
        '    - id: qa\n      agent: qa_agent\n',
        '    - id: qa\n      agent: dev_agent\n',
      ),
      'capability_violation',
    );
  });

  it('a pi-backed WORKER is legal (the unrestricted role)', () => {
    const res = parseSpec(WORKFORCE_BASE, ON);
    expect(res.ok).toBe(true);
  });
});

describe('workforce semantic lint — review policies', () => {
  it('rejects a review policy whose reviewer is a plain worker', () => {
    expectRejection(WORKFORCE_BASE.replace('reviewer: qa', 'reviewer: dev'), 'invalid_reviewer');
  });

  it('accepts a manager as a reviewer', () => {
    const res = parseSpec(WORKFORCE_BASE.replace('reviewer: qa', 'reviewer: mgr'), ON);
    expect(res.ok).toBe(true);
  });

  it('rejects a review policy whose appliesTo names neither a department nor an employee', () => {
    expectRejection(
      WORKFORCE_BASE.replace('appliesTo: { department: engineering }', 'appliesTo: {}'),
      'schema_violation',
    );
  });

  it('rejects a review policy whose requireWhen names no trigger at all', () => {
    expectRejection(
      WORKFORCE_BASE.replace(
        'requireWhen: { confidenceBelow: 0.75, capabilities: [production_change] }',
        'requireWhen: {}',
      ),
      'schema_violation',
    );
  });

  it('rejects a review policy applying to an undeclared department', () => {
    expectRejection(
      WORKFORCE_BASE.replace(
        'appliesTo: { department: engineering }',
        'appliesTo: { department: warehouse }',
      ),
      'dangling_ref',
    );
  });
});

describe('workforce semantic lint — budget coherence', () => {
  it('rejects a department budget wider than the workforce ceiling', () => {
    expectRejection(
      WORKFORCE_BASE.replace('budgets: { usd: 10 }', 'budgets: { usd: 50 }'),
      'budget_widening',
    );
  });

  it('normalizes differing windows to a per-hour rate before comparing', () => {
    // 3 usd HOURLY = 72 usd/day — wider than the workforce's 40 usd daily despite the smaller number.
    expectRejection(
      WORKFORCE_BASE.replace('budgets: { usd: 10 }', 'budgets: { usd: 3, window: hourly }'),
      'budget_widening',
    );
    // 60 usd WEEKLY ≈ 8.6 usd/day — tighter than 40 daily despite the larger number.
    const res = parseSpec(
      WORKFORCE_BASE.replace('budgets: { usd: 10 }', 'budgets: { usd: 60, window: weekly }'),
      ON,
    );
    expect(res.ok).toBe(true);
  });

  it('a department usd with no workforce ceiling is not a widening (nothing to widen)', () => {
    const res = parseSpec(WORKFORCE_BASE.replace('    workforce: { usd: 40 }\n', ''), ON);
    expect(res.ok).toBe(true);
  });

  it('rejects a usd ceiling without the task budget the per-turn estimate derives from', () => {
    expectRejection(
      WORKFORCE_BASE.replace('    task: { usd: 2.5, turns: 12 }\n', ''),
      'schema_violation',
    );
  });

  it('a SUBTREE usd ceiling also demands the task budget (the engine refuses the same set)', () => {
    // The engine's own coherence rule counts `subtree.usd` toward `declaresUsd` (budget.ts), so a
    // document this lint let through would derive a budgets object the ENGINE refuses at boot —
    // a spec that passed `doctor` and then stops the workforce.
    const subtreeOnly = WORKFORCE_BASE.replace(
      '    workforce: { usd: 40 }\n',
      '    subtree: { usd: 30 }\n',
    )
      .replace('    task: { usd: 2.5, turns: 12 }\n', '')
      .replace('      budgets: { usd: 10 }\n', '');
    expectRejection(subtreeOnly, 'schema_violation');
    // With the task tier present the same subtree ceiling is a legal declaration.
    const res = parseSpec(
      WORKFORCE_BASE.replace(
        '    task: { usd: 2.5, turns: 12 }\n',
        '    task: { usd: 2.5, turns: 12 }\n    subtree: { usd: 30, turns: 60 }\n',
      ),
      ON,
    );
    expect(res.ok).toBe(true);
  });

  it('a MONTHLY window normalizes through the same per-hour comparison', () => {
    // 10 usd DAILY ≈ 0.417 usd/h is wider than 40 usd MONTHLY ≈ 0.055 usd/h, despite 40 > 10.
    expectRejection(
      WORKFORCE_BASE.replace(
        '    workforce: { usd: 40 }\n',
        '    workforce: { usd: 40, window: monthly }\n',
      ),
      'budget_widening',
    );
    // 10 usd MONTHLY is tighter than the workforce's 40 usd daily — accepted.
    const res = parseSpec(
      WORKFORCE_BASE.replace('budgets: { usd: 10 }', 'budgets: { usd: 10, window: monthly }'),
      ON,
    );
    expect(res.ok).toBe(true);
  });
});

describe('workforce semantic lint — teams and the durable worker', () => {
  it('rejects a team whose members exceed its declared maxSize', () => {
    expectRejection(WORKFORCE_BASE.replace('maxSize: 3', 'maxSize: 1'), 'schema_violation');
  });

  it('rejects a team led by a worker — a worker carries no delegation tool, so it is a dead end', () => {
    expectRejection(
      WORKFORCE_BASE.replace('      lead: mgr\n', '      lead: dev\n'),
      'invalid_manager',
    );
  });

  it('rejects a team led by a reviewer, for the same reason', () => {
    expectRejection(
      WORKFORCE_BASE.replace('      lead: mgr\n', '      lead: qa\n'),
      'invalid_manager',
    );
  });

  it('rejects a team led by the orchestrator — `team:` would resolve to the delegator itself', () => {
    expectRejection(
      WORKFORCE_BASE.replace('      lead: mgr\n', '      lead: lead\n'),
      'invalid_manager',
    );
  });

  it('rejects a team that lists its own lead among its members', () => {
    expectRejection(
      WORKFORCE_BASE.replace('members: [dev, qa]', 'members: [dev, qa, mgr]'),
      'manager_in_members',
    );
  });

  it('rejects the orchestrator as a team member — the seat sits above teams', () => {
    expectRejection(
      WORKFORCE_BASE.replace('members: [dev, qa]', 'members: [dev, qa, lead]'),
      'invalid_orchestrator',
    );
  });

  it('rejects a workforce on a deployment without a durable worker', () => {
    expectRejection(
      WORKFORCE_BASE.replace('deployment:\n  durableWorker: true\n', ''),
      'schema_violation',
    );
  });
});

describe('workforce semantic lint — a manager’s authority is the department they belong to', () => {
  /** A second department managed by `mgr`, who declares `engineering` as their own. */
  const SECOND_DEPARTMENT = WORKFORCE_BASE.replace(
    '      budgets: { usd: 10 }\n',
    '      budgets: { usd: 10 }\n    - id: growth\n      name: Growth\n      manager: mgr\n      mission: Tell it.\n',
  );

  it('rejects a manager who manages one department while declaring a different one as their own', () => {
    // The delegation scoping keys on the MEMBERSHIP field (`employee.department`), never on which
    // departments name the employee as manager — so this spec grants authority over `engineering`
    // to the manager of `growth`, and none over `growth` at all. Neither half is what it reads as.
    expectRejection(SECOND_DEPARTMENT, 'department_mismatch');
  });

  it('a manager who declares no department at all is not re-keyed — nothing disagrees', () => {
    // Fail-closed rather than mis-keyed: with no membership field, the resolver's own-department
    // lookup finds nothing and the manager reaches nobody by department. (The orchestrator-as-
    // manager case is pinned beside the membership rules above.)
    const res = parseSpec(
      SECOND_DEPARTMENT.replace(
        '      department: engineering\n      reportsTo: lead\n',
        '      reportsTo: lead\n',
      ),
      ON,
    );
    expect(res.ok).toBe(true);
  });
});

describe('workforce semantic lint — approval rules', () => {
  it('rejects an escalating approval rule that covers the orchestrator seat', () => {
    // The orchestrator has no reportsTo by lint requirement, so no escalation target exists: the
    // toolset omits `escalateTo`, the planner refuses the intent, and the requeue re-runs the same
    // deterministic condition into permanent failure. One legal-looking spec, one bricked task.
    expectRejection(
      WORKFORCE_BASE.replace(
        '      title: Lead\n      role: orchestrator\n',
        '      title: Lead\n      role: orchestrator\n      capabilities: [public_statement]\n',
      ),
      'invalid_orchestrator',
    );
  });

  it('the same rule with onTimeout: fail is legal on that seat', () => {
    const res = parseSpec(
      WORKFORCE_BASE.replace(
        '      title: Lead\n      role: orchestrator\n',
        '      title: Lead\n      role: orchestrator\n      capabilities: [public_statement]\n',
      ).replace('      onTimeout: escalate', '      onTimeout: fail'),
      ON,
    );
    expect(res.ok).toBe(true);
  });

  it('an escalating rule covering only non-orchestrator seats stays legal', () => {
    const res = parseSpec(
      WORKFORCE_BASE.replace(
        'capabilities: [production_change]',
        'capabilities: [production_change, public_statement]',
      ),
      ON,
    );
    expect(res.ok).toBe(true);
  });
});

describe('workforce advisory warnings', () => {
  it('warns (advisory, never fails) on a requireWhen capability label no employee holds', () => {
    const doc = WORKFORCE_BASE.replace(
      'requireWhen: { confidenceBelow: 0.75, capabilities: [production_change] }',
      'requireWhen: { confidenceBelow: 0.75, capabilities: [prod_chnage] }',
    );
    const res = parseSpec(doc, ON);
    expect(res.ok).toBe(true); // an unheld label is NEVER an error — a policy may guard it early
    if (!res.ok) return;
    const warnings = lintSpecWarnings(res.value);
    expect(warnings).toContainEqual(
      expect.objectContaining({
        code: 'workforce_capability_unheld',
        path: 'workforce.reviewPolicies[0].requireWhen.capabilities[0]',
      }),
    );
    // The approval's label is unheld too (nobody holds public_statement in the base) — also advisory.
    expect(
      warnings.filter((w) => w.code === 'workforce_capability_unheld').length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('held labels warn nothing', () => {
    const res = parseSpec(
      WORKFORCE_BASE.replace(
        'capabilities: [production_change]\n    - id: qa',
        'capabilities: [production_change, public_statement]\n    - id: qa',
      ),
      ON,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(
      lintSpecWarnings(res.value).filter((w) => w.code === 'workforce_capability_unheld'),
    ).toEqual([]);
  });
});
