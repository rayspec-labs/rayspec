/**
 * The spec→engine budgets DRIFT LOCK. The spec package derives a structural twin of this engine's
 * declared-budgets shape (it cannot import this package — the dependency edge runs the other way),
 * so this test closes the loop from THIS side.
 *
 * IT ASSERTS COVERAGE, NOT MERELY PARSEABILITY. Parseability alone is a hole: a ceiling tier the
 * grammar cannot express derives nothing, parses clean under a schema whose members are all
 * optional, and silently enforces NOTHING — which is exactly how `budgets.subtree` (the `root`
 * ledger scope, budget.ts:195-200) sat undeclarable while the docs promised four budget scopes.
 * So the three assertions below are, in order:
 *
 *   1. EXPRESSIBILITY — a document declaring every ceiling the engine ledgers PARSES. A tier the
 *      grammar has no key for fails here, naming the key.
 *   2. COVERAGE — every key path the engine's schema accepts is PRESENT in the derived object,
 *      except one documented exclusion. A key the grammar can express but the derivation drops
 *      fails here, naming the path.
 *   3. COHERENCE — the derived object parses under the engine's STRICT schema with a positive
 *      per-turn estimate wherever a usd ceiling exists, so the engine's own coherence refusal can
 *      never fire on a derived object.
 *
 * Plus the calendar-window VOCABULARY pin, which only this side can make: the spec package pins its
 * own enum against a literal, but nothing else compares the two packages' window sets to each other.
 */
import {
  deriveWorkforceBudgets,
  WorkforceBudgetWindow,
  WorkforceSpec,
  type WorkforceSpec as WorkforceSpecType,
} from '@rayspec/spec';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BUDGET_WINDOWS, ledgerScopesFor, workforceBudgetsSchema } from './budget.js';

/**
 * The ONE key path the engine accepts that a document may NOT declare: `declaredAt` is the
 * redeploy gate's declaration MARKER, stamped by boot and explicitly "carried, never enforced"
 * (budget.ts:66-79). Every other path below is a ceiling, and a ceiling the grammar cannot reach
 * is a no-op. Adding to this list is the review finding this test exists to cause.
 */
const NOT_AUTHOR_DECLARABLE = ['declaredAt'];

/** A maximal declaration: EVERY ceiling key the engine ledgers, declared at once. */
const MAXIMAL_DOCUMENT = {
  id: 'wf',
  name: 'WF',
  orchestrator: 'lead',
  budgets: {
    workforce: { usd: 40, turns: 100, window: 'daily' },
    task: { usd: 2.5, turns: 12 },
    subtree: { usd: 30, turns: 60 },
  },
  execution: {
    maxConcurrentWorkers: 6,
    maxTaskWallClock: '45m',
    maxReviewRounds: 2,
    onBudgetExhausted: 'block_and_escalate',
    delegation: { maxDepth: 4, maxPerTask: 12 },
  },
  departments: [
    {
      id: 'eng',
      name: 'Engineering',
      manager: 'mgr',
      mission: 'Own it.',
      members: ['dev'],
      budgets: { usd: 15, turns: 40, window: 'daily' },
      execution: { maxConcurrentWorkers: 2 },
    },
  ],
  employees: [
    { id: 'lead', agent: 'a', title: 'Lead', role: 'orchestrator' },
    { id: 'mgr', agent: 'a', title: 'M', department: 'eng', reportsTo: 'lead', role: 'manager' },
    { id: 'dev', agent: 'a', title: 'D', department: 'eng', role: 'worker' },
  ],
};

type JsonSchemaNode = {
  properties?: Record<string, JsonSchemaNode>;
  additionalProperties?: boolean | JsonSchemaNode;
};

/**
 * Every LEAF key path the engine's declared-budgets schema accepts, dotted. A record map (the
 * `departments` object, keyed by department id) contributes its VALUE shape under `<id>` so the
 * comparison is about keys, never about which department a fixture happens to name.
 */
function engineKeyPaths(node: JsonSchemaNode, prefix = ''): string[] {
  const out: string[] = [];
  for (const [key, child] of Object.entries(node.properties ?? {})) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    const nested = engineKeyPaths(child, path);
    out.push(...(nested.length > 0 ? nested : [path]));
  }
  const values = node.additionalProperties;
  if (typeof values === 'object' && values !== null) {
    out.push(...engineKeyPaths(values, prefix === '' ? '<id>' : `${prefix}.<id>`));
  }
  return out;
}

/** The same dotted leaf paths, read off a derived object; record keys normalize to `<id>`. */
function derivedKeyPaths(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [prefix];
  const out: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out.push(...derivedKeyPaths(child, prefix === '' ? key : `${prefix}.${key}`));
  }
  return out;
}

const normalizeRecordKeys = (path: string): string =>
  path.replace(/^departments\.[^.]+\./, 'departments.<id>.');

describe('spec-derived budgets COVER the engine schema (drift lock)', () => {
  it('the grammar can EXPRESS every ceiling the engine ledgers', () => {
    const parsed = WorkforceSpec.safeParse(MAXIMAL_DOCUMENT);
    const rejected = parsed.success
      ? []
      : parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    expect(
      rejected,
      'a budget key the ENGINE ledgers has no grammar key — that tier enforces NOTHING on every ' +
        'declared document. Add it to workforce-grammar.ts (and carry it through workforce-config.ts)',
    ).toEqual([]);
  });

  it('the derivation CARRIES every key path the engine accepts (coverage, not parseability)', () => {
    const declared = WorkforceSpec.parse(MAXIMAL_DOCUMENT);
    const engine = engineKeyPaths(
      z.toJSONSchema(workforceBudgetsSchema, { io: 'input' }) as JsonSchemaNode,
    );
    const derived = new Set(
      derivedKeyPaths(deriveWorkforceBudgets(declared)).map(normalizeRecordKeys),
    );
    const uncovered = engine.filter((path) => !derived.has(path)).sort();
    expect(
      uncovered,
      'the engine accepts these budget key paths but nothing a document declares reaches them — ' +
        'each is a ceiling that silently enforces nothing. Either carry it through ' +
        '`deriveWorkforceBudgets`, or justify it in NOT_AUTHOR_DECLARABLE',
    ).toEqual([...NOT_AUTHOR_DECLARABLE].sort());
  });

  it('a maximal declared section round-trips strictly with a derived positive estimate', () => {
    const declared = WorkforceSpec.parse(MAXIMAL_DOCUMENT);
    const parsed = workforceBudgetsSchema.parse(deriveWorkforceBudgets(declared));
    expect(parsed.execution.estimateUsdPerTurn).toBeGreaterThan(0);
    expect(parsed.workforce?.usd).toBe(40);
    expect(parsed.workforce?.turns).toBe(100);
    expect(parsed.subtree?.usd).toBe(30);
    expect(parsed.subtree?.turns).toBe(60);
    expect(parsed.departments?.eng?.maxConcurrentWorkers).toBe(2);
    expect(parsed.execution.maxTaskWallClockMs).toBe(2_700_000);
  });

  it('an undeclared budgets section parses as the engine defaults (nothing invented)', () => {
    const declared = WorkforceSpec.parse({
      id: 'wf',
      name: 'WF',
      orchestrator: 'lead',
      employees: [{ id: 'lead', agent: 'a', title: 'Lead', role: 'orchestrator' }],
    });
    const parsed = workforceBudgetsSchema.parse(deriveWorkforceBudgets(declared));
    expect(parsed.workforce).toBeUndefined();
    expect(parsed.subtree).toBeUndefined();
    expect(parsed.execution.onBudgetExhausted).toBe('block');
    expect(parsed.execution.estimateUsdPerTurn).toBe(0);
  });

  it('the two packages agree on the calendar-window vocabulary', () => {
    expect([...WorkforceBudgetWindow.options]).toEqual([...BUDGET_WINDOWS]);
  });
});

/**
 * THE ENFORCEMENT PROOF, pure half. A ledger row's ceiling is what makes `authorizeTurn` able to
 * deny; before `budgets.subtree` existed in the grammar, the `root` scope of every DECLARED
 * document carried `ceilingUsd: null` and denied nothing. The control arm is the point: the same
 * document minus the tier still yields the un-enforcing row.
 */
describe('a declared subtree ceiling reaches the root ledger scope', () => {
  const proposal = {
    taskId: 'child-1',
    rootTaskId: 'root-1',
    workforceId: 'wf',
    department: null,
    estimateUsd: 0.1,
  };
  const now = new Date('2026-08-14T13:00:00Z');
  const rootScopeOf = (doc: unknown) => {
    const declared = WorkforceSpec.parse(doc) as WorkforceSpecType;
    const budgets = workforceBudgetsSchema.parse(deriveWorkforceBudgets(declared));
    return ledgerScopesFor(proposal, budgets, now).find((s) => s.scopeKind === 'root');
  };
  const base = {
    id: 'wf',
    name: 'WF',
    orchestrator: 'lead',
    employees: [{ id: 'lead', agent: 'a', title: 'Lead', role: 'orchestrator' }],
  };

  it('CONTROL: without the tier the root scope enforces nothing', () => {
    const root = rootScopeOf({ ...base, budgets: { task: { usd: 1, turns: 10 } } });
    expect(root).toMatchObject({ scopeId: 'root-1', ceilingUsd: null, ceilingTurns: null });
  });

  it('with the tier declared the root scope carries the ceiling the engine checks', () => {
    const root = rootScopeOf({
      ...base,
      budgets: { task: { usd: 1, turns: 10 }, subtree: { usd: 0.15, turns: 3 } },
    });
    expect(root).toMatchObject({ scopeId: 'root-1', ceilingUsd: 0.15, ceilingTurns: 3 });
  });
});
