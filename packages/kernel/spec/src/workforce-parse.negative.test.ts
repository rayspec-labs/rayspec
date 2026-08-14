/**
 * NEGATIVE tests for the `workforce:` section — every case takes a spec that WOULD parse, injects
 * exactly one defect, and asserts the specific closed `SpecErrorCode`. The BASE below is a
 * known-good minimal-but-complete workforce (a sanity test proves it parses), so each rejection
 * isolates one rule. Parse-level rules live here beside the semantic lint battery; every rule in
 * the validation table has exactly one failing case.
 */
import { describe, expect, it } from 'vitest';
import type { SpecErrorCode } from './errors.js';
import { type ParseSpecOptions, parseSpec } from './parse.js';
import { WorkforceSpec } from './workforce-grammar.js';

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
