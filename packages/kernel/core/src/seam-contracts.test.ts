/**
 * The SEAM CONTRACT KIT, run against BOTH arms the open-core promise rests on:
 *
 *   (A) the SHIPPED DEFAULT of every seam — the deterministic behavior a deployment gets with no
 *       replacement installed, so "the default is always present" is a measured claim;
 *   (B) a FIXTURE implementation that decides differently — a decomposing strategy, a ranking
 *       selector, a recalling memory provider, a ticketing approval provider, an in-memory cost
 *       policy — so "a replacement satisfies the same contract" is a measured claim too.
 *
 * And the half that makes the other two mean something: (C) TEETH. Every property is driven by an
 * implementation that violates exactly that property, and the kit must report it as failed. A
 * conformance kit that passes everything proves nothing about the things it passed.
 *
 * The kit itself is framework-free (`seam-contracts.ts` imports no test runner) because the
 * out-of-tree sample under examples/workforce-extension runs this same suite from its own package.
 */
import { describe, expect, it } from 'vitest';
import { type ApprovalProvider, UnroutedApprovalProvider } from './approval-provider.js';
import type {
  BudgetScopeKind,
  CostPolicy,
  PolicyDecision,
  ProposedExecution,
  SettledExecution,
} from './cost-policy.js';
import {
  EmptyRecallMemoryProvider,
  type MemoryHit,
  type MemoryQuery,
  type WorkforceMemoryProvider,
} from './memory-provider.js';
import {
  type ExecutionPlan,
  type OrchestrationInput,
  type OrchestrationStrategy,
  SingleTaskPlanStrategy,
} from './orchestration-strategy.js';
import {
  approvalProviderContract,
  type ContractResult,
  contractFailures,
  costPolicyContract,
  memoryProviderContract,
  orchestrationStrategyContract,
  runSeamContracts,
  SEAM_MAX_PLAN_STEPS,
  SEAM_MAX_STEP_DEPENDENCIES,
  workerSelectorContract,
} from './seam-contracts.js';
import {
  CapabilityMatchSelector,
  type SelectionTask,
  type WorkerCandidate,
  type WorkerSelection,
  WorkerSelectionError,
  type WorkerSelector,
} from './worker-selector.js';

/** Property names the kit must report, asserted by name so a renamed check cannot silently vanish. */
const names = (results: readonly ContractResult[]): string[] => results.map((r) => r.name).sort();

/** The one assertion every conforming arm must satisfy. */
function expectConforms(results: readonly ContractResult[]): void {
  expect(contractFailures(results).map((r) => `${r.name}: ${r.detail}`)).toEqual([]);
  expect(results.length).toBeGreaterThan(0);
}

/** Exactly the named property failed, and nothing else did. */
function expectOnlyFailure(results: readonly ContractResult[], name: string): void {
  expect(contractFailures(results).map((r) => r.name)).toEqual([name]);
}

// ── (B) fixture implementations — a different decision, the same contract ────────────────────────

/** A decomposing strategy: three steps, a real dependency chain, a non-default owner on step 2. */
class ThreeStepFixtureStrategy implements OrchestrationStrategy {
  readonly id = 'fixture-three-step';
  plan(input: OrchestrationInput): Promise<ExecutionPlan> {
    return Promise.resolve({
      steps: [
        {
          title: 'Gather',
          goal: `Gather inputs for: ${input.goal}`.slice(0, 200),
          owner: input.defaultOwner,
          department: null,
          dependsOn: [],
        },
        {
          title: 'Draft',
          goal: `Draft: ${input.goal}`.slice(0, 200),
          owner: 'fixture-writer',
          department: 'fixture-dept',
          dependsOn: [0],
        },
        {
          title: 'Publish',
          goal: `Publish: ${input.goal}`.slice(0, 200),
          owner: input.defaultOwner,
          department: null,
          dependsOn: [0, 1],
        },
      ],
    });
  }
}

/** A selector that ranks by capability breadth instead of declaration order — still confined. */
class BroadestCapabilityFixtureSelector implements WorkerSelector {
  readonly id = 'fixture-broadest';
  select(task: SelectionTask, candidates: readonly WorkerCandidate[]): Promise<WorkerSelection> {
    const qualified = candidates.filter((c) =>
      task.requiredCapabilities.every((label) => c.capabilities.includes(label)),
    );
    const best = [...qualified].sort((a, b) => b.capabilities.length - a.capabilities.length)[0];
    if (!best) return Promise.reject(new WorkerSelectionError(task.taskId, 'fixture found nobody'));
    return Promise.resolve({
      employeeId: best.employeeId,
      reason: 'widest declared capability set',
    });
  }
}

/** A memory provider that actually recalls, honoring the query limit. */
class RecallingFixtureMemoryProvider implements WorkforceMemoryProvider {
  readonly id = 'fixture-recall';
  readonly #entries: string[] = ['a prior decision', 'a prior result', 'an older note'];
  search(query: MemoryQuery): Promise<readonly MemoryHit[]> {
    const hits = this.#entries.map((text, i) => ({ id: `fixture-${i}`, text, score: 1 - i / 10 }));
    return Promise.resolve(query.limit === undefined ? hits : hits.slice(0, query.limit));
  }
  remember(): Promise<void> {
    return Promise.resolve();
  }
}

/** An approval provider that issues real pending tickets. */
class TicketingFixtureApprovalProvider implements ApprovalProvider {
  readonly id = 'fixture-ticketing';
  #next = 0;
  request(): Promise<{ ticketId: string; status: 'pending'; requestedAt: string }> {
    this.#next += 1;
    return Promise.resolve({
      ticketId: `fixture-ticket-${this.#next}`,
      status: 'pending',
      requestedAt: new Date(0).toISOString(),
    });
  }
  cancel(): Promise<void> {
    return Promise.resolve();
  }
}

/** An in-memory cost policy: a real ceiling, a real settled total, a typed denial. */
class InMemoryFixtureCostPolicy implements CostPolicy {
  readonly id = 'fixture-in-memory';
  #spent = 0;
  constructor(private readonly ceilingUsd: number) {}
  authorize(proposed: ProposedExecution): Promise<PolicyDecision> {
    if (this.#spent + proposed.estimateUsd > this.ceilingUsd) {
      return Promise.resolve({
        allowed: false,
        denial: {
          scopeKind: 'workforce' satisfies BudgetScopeKind,
          scopeId: proposed.workforceId ?? 'unscoped',
          ceiling: { kind: 'usd', limit: this.ceilingUsd },
          consumed: this.#spent,
        },
      });
    }
    return Promise.resolve({ allowed: true });
  }
  settle(actual: SettledExecution): Promise<void> {
    this.#spent += actual.actualUsd;
    return Promise.resolve();
  }
}

// ── the suites ───────────────────────────────────────────────────────────────────────────────────

describe('OrchestrationStrategy contract', () => {
  it('the shipped default conforms', async () => {
    expectConforms(await orchestrationStrategyContract(new SingleTaskPlanStrategy()));
  });

  it('a decomposing fixture conforms', async () => {
    expectConforms(await orchestrationStrategyContract(new ThreeStepFixtureStrategy()));
  });

  it('checks every property it claims to', async () => {
    expect(names(await orchestrationStrategyContract(new SingleTaskPlanStrategy()))).toEqual([
      'plan-does-not-mutate-its-input',
      'plan-is-bounded',
      'plan-step-shape-is-creatable',
      'plan-yields-at-least-one-step',
      'step-dependencies-name-only-prior-steps',
    ]);
  });

  it('TEETH: an empty plan fails plan-yields-at-least-one-step', async () => {
    const empty: OrchestrationStrategy = { id: 'x', plan: () => Promise.resolve({ steps: [] }) };
    expectOnlyFailure(await orchestrationStrategyContract(empty), 'plan-yields-at-least-one-step');
  });

  it('TEETH: a FORWARD dependency fails step-dependencies-name-only-prior-steps', async () => {
    const forward: OrchestrationStrategy = {
      id: 'x',
      plan: () =>
        Promise.resolve({
          steps: [
            { title: 'a', goal: 'a', owner: 'o', department: null, dependsOn: [1] },
            { title: 'b', goal: 'b', owner: 'o', department: null, dependsOn: [] },
          ],
        }),
    };
    expectOnlyFailure(
      await orchestrationStrategyContract(forward),
      'step-dependencies-name-only-prior-steps',
    );
  });

  it('TEETH: a self dependency fails step-dependencies-name-only-prior-steps', async () => {
    const self: OrchestrationStrategy = {
      id: 'x',
      plan: () =>
        Promise.resolve({
          steps: [{ title: 'a', goal: 'a', owner: 'o', department: null, dependsOn: [0] }],
        }),
    };
    expectOnlyFailure(
      await orchestrationStrategyContract(self),
      'step-dependencies-name-only-prior-steps',
    );
  });

  it('TEETH: a non-integer dependency index fails step-dependencies-name-only-prior-steps', async () => {
    const fractional: OrchestrationStrategy = {
      id: 'x',
      plan: () =>
        Promise.resolve({
          steps: [
            { title: 'a', goal: 'a', owner: 'o', department: null, dependsOn: [] },
            { title: 'b', goal: 'b', owner: 'o', department: null, dependsOn: [0.5] },
          ],
        }),
    };
    expectOnlyFailure(
      await orchestrationStrategyContract(fractional),
      'step-dependencies-name-only-prior-steps',
    );
  });

  /**
   * The reviewer's probe G: a 64-step plan — inside the step ceiling — whose last step carries 150
   * dependencies, every index strictly prior. Repeating indices is what makes the row bound reachable
   * without exceeding the step bound. The kit used to pass this plan and the engine then refused it,
   * which is the one thing a conformance kit must never do.
   */
  it('TEETH: more dependencies than a row carries fails step-dependencies-name-only-prior-steps', async () => {
    const overDeps: OrchestrationStrategy = {
      id: 'x',
      plan: () =>
        Promise.resolve({
          steps: Array.from({ length: SEAM_MAX_PLAN_STEPS }, (_v, i) => ({
            title: `s${i}`,
            goal: `s${i}`,
            owner: 'o',
            department: null,
            dependsOn:
              i === SEAM_MAX_PLAN_STEPS - 1
                ? Array.from({ length: 150 }, () => 0)
                : ([] as number[]),
          })),
        }),
    };
    const results = await orchestrationStrategyContract(overDeps);
    expectOnlyFailure(results, 'step-dependencies-name-only-prior-steps');
    expect(contractFailures(results)[0]?.detail).toContain(
      `declares 150 dependencies (the row bound is ${SEAM_MAX_STEP_DEPENDENCIES})`,
    );
  });

  it('a plan AT the dependency bound conforms — the bound refuses excess, not fan-in', async () => {
    const atBound: OrchestrationStrategy = {
      id: 'x',
      plan: () =>
        Promise.resolve({
          steps: Array.from({ length: SEAM_MAX_PLAN_STEPS }, (_v, i) => ({
            title: `s${i}`,
            goal: `s${i}`,
            owner: 'o',
            department: null,
            dependsOn:
              i === SEAM_MAX_PLAN_STEPS - 1
                ? Array.from({ length: SEAM_MAX_STEP_DEPENDENCIES }, () => 0)
                : ([] as number[]),
          })),
        }),
    };
    expectConforms(await orchestrationStrategyContract(atBound));
  });

  it('TEETH: an unbounded plan fails plan-is-bounded', async () => {
    const flood: OrchestrationStrategy = {
      id: 'x',
      plan: () =>
        Promise.resolve({
          steps: Array.from({ length: SEAM_MAX_PLAN_STEPS + 1 }, (_v, i) => ({
            title: `s${i}`,
            goal: `s${i}`,
            owner: 'o',
            department: null,
            dependsOn: [],
          })),
        }),
    };
    expectOnlyFailure(await orchestrationStrategyContract(flood), 'plan-is-bounded');
  });

  it('TEETH: an empty title fails plan-step-shape-is-creatable', async () => {
    const blank: OrchestrationStrategy = {
      id: 'x',
      plan: () =>
        Promise.resolve({
          steps: [{ title: '', goal: 'a', owner: 'o', department: null, dependsOn: [] }],
        }),
    };
    expectOnlyFailure(await orchestrationStrategyContract(blank), 'plan-step-shape-is-creatable');
  });

  it('TEETH: a strategy that writes into its input fails plan-does-not-mutate-its-input', async () => {
    const mutator: OrchestrationStrategy = {
      id: 'x',
      plan: (input) => {
        try {
          (input as { defaultOwner: string }).defaultOwner = 'someone-else';
        } catch {
          // A frozen input throws in strict mode; the attempt is what the property measures.
          throw new Error('attempted to mutate the orchestration input');
        }
        return Promise.resolve({
          steps: [{ title: 'a', goal: 'a', owner: 'o', department: null, dependsOn: [] }],
        });
      },
    };
    expectOnlyFailure(
      await orchestrationStrategyContract(mutator),
      'plan-does-not-mutate-its-input',
    );
  });
});

describe('WorkerSelector contract', () => {
  it('the shipped default conforms', async () => {
    expectConforms(await workerSelectorContract(new CapabilityMatchSelector()));
  });

  it('a ranking fixture conforms', async () => {
    expectConforms(await workerSelectorContract(new BroadestCapabilityFixtureSelector()));
  });

  it('checks every property it claims to', async () => {
    expect(names(await workerSelectorContract(new CapabilityMatchSelector()))).toEqual([
      'an-empty-candidate-list-fails-closed',
      'no-qualified-candidate-fails-closed',
      'selection-does-not-mutate-the-candidate-set',
      'selection-holds-every-required-capability',
      'selection-names-a-given-candidate',
      'selection-reason-is-bounded-text',
    ]);
  });

  it('TEETH: a selector naming a non-candidate fails selection-names-a-given-candidate', async () => {
    const outsider: WorkerSelector = {
      id: 'x',
      select: () => Promise.resolve({ employeeId: 'nobody-declared-this-one', reason: 'because' }),
    };
    expect(contractFailures(await workerSelectorContract(outsider)).map((r) => r.name)).toContain(
      'selection-names-a-given-candidate',
    );
  });

  it('TEETH: a selector ignoring required capabilities fails selection-holds-every-required-capability', async () => {
    const grantor: WorkerSelector = {
      id: 'x',
      select: (_task, candidates) =>
        candidates.length === 0
          ? Promise.reject(new WorkerSelectionError('t', 'empty'))
          : Promise.resolve({
              // The LAST candidate is the one deliberately lacking the required label.
              employeeId: (candidates[candidates.length - 1] as WorkerCandidate).employeeId,
              reason: 'ignoring the requirement',
            }),
    };
    const failed = contractFailures(await workerSelectorContract(grantor)).map((r) => r.name);
    expect(failed).toContain('selection-holds-every-required-capability');
  });

  it('TEETH: a selector that answers on an empty list fails an-empty-candidate-list-fails-closed', async () => {
    const inventor: WorkerSelector = {
      id: 'x',
      select: (_task, candidates) =>
        Promise.resolve({
          employeeId: candidates[0]?.employeeId ?? 'invented-employee',
          reason: 'invented one',
        }),
    };
    expect(contractFailures(await workerSelectorContract(inventor)).map((r) => r.name)).toContain(
      'an-empty-candidate-list-fails-closed',
    );
  });
});

describe('WorkforceMemoryProvider contract', () => {
  it('the shipped default conforms', async () => {
    expectConforms(await memoryProviderContract(new EmptyRecallMemoryProvider()));
  });

  it('a recalling fixture conforms', async () => {
    expectConforms(await memoryProviderContract(new RecallingFixtureMemoryProvider()));
  });

  it('checks every property it claims to', async () => {
    expect(names(await memoryProviderContract(new EmptyRecallMemoryProvider()))).toEqual([
      'hits-are-well-formed',
      'remember-settles',
      'search-does-not-mutate-the-query',
      'search-honors-the-query-limit',
      'search-yields-a-bounded-list',
    ]);
  });

  it('TEETH: a provider exceeding the limit fails search-honors-the-query-limit', async () => {
    const flood: WorkforceMemoryProvider = {
      id: 'x',
      search: () =>
        Promise.resolve(
          Array.from({ length: 50 }, (_v, i) => ({ id: `h${i}`, text: 't', score: 1 })),
        ),
      remember: () => Promise.resolve(),
    };
    expect(contractFailures(await memoryProviderContract(flood)).map((r) => r.name)).toContain(
      'search-honors-the-query-limit',
    );
  });

  /**
   * The kit's whole promise is that it RETURNS a readable verdict list rather than throwing, and a
   * provider whose `search` does not answer with a list is precisely the state an out-of-tree author
   * is in while they are still getting it wrong. Each of these shapes used to escape as a raw
   * TypeError from the unguarded dereference of the search result.
   */
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a plain object', { hits: [] }],
    ['a number', 42],
    ['a string', 'lots of hits'],
  ])('REPORTS rather than throws when search yields %s', async (_label, value) => {
    const broken: WorkforceMemoryProvider = {
      id: 'x',
      search: () => Promise.resolve(value as unknown as readonly MemoryHit[]),
      remember: () => Promise.resolve(),
    };
    const results = await memoryProviderContract(broken);
    // Every property is still reported — a caller never has to guess whether a missing one passed.
    expect(names(results)).toEqual([
      'hits-are-well-formed',
      'remember-settles',
      'search-does-not-mutate-the-query',
      'search-honors-the-query-limit',
      'search-yields-a-bounded-list',
    ]);
    expect(contractFailures(results)).toHaveLength(5);
    expect(results[0]?.detail).toMatch(/not an array/);
  });

  it('REPORTS rather than throws when search REJECTS', async () => {
    const rejecting: WorkforceMemoryProvider = {
      id: 'x',
      search: () => Promise.reject(new Error('the index is offline')),
      remember: () => Promise.resolve(),
    };
    const results = await memoryProviderContract(rejecting);
    expect(contractFailures(results)).toHaveLength(5);
    expect(results[0]?.detail).toMatch(/rejected \(Error: the index is offline\)/);
  });

  it('TEETH: a malformed hit fails hits-are-well-formed', async () => {
    const malformed: WorkforceMemoryProvider = {
      id: 'x',
      search: () =>
        Promise.resolve([{ id: 'h', text: 'nan score', score: Number.NaN } as MemoryHit]),
      remember: () => Promise.resolve(),
    };
    expect(contractFailures(await memoryProviderContract(malformed)).map((r) => r.name)).toContain(
      'hits-are-well-formed',
    );
  });
});

describe('ApprovalProvider contract', () => {
  it('the shipped default conforms — a typed refusal IS conformance', async () => {
    expectConforms(await approvalProviderContract(new UnroutedApprovalProvider()));
  });

  it('a ticketing fixture conforms', async () => {
    expectConforms(await approvalProviderContract(new TicketingFixtureApprovalProvider()));
  });

  it('checks every property it claims to', async () => {
    expect(names(await approvalProviderContract(new UnroutedApprovalProvider()))).toEqual([
      'cancel-settles',
      'request-never-yields-a-decision',
      'ticket-is-well-formed',
    ]);
  });

  it('TEETH: a provider resolving a decision fails request-never-yields-a-decision', async () => {
    const decider: ApprovalProvider = {
      id: 'x',
      request: () =>
        Promise.resolve({
          ticketId: 't-1',
          // The whole point of the seam: a provider may never hand back an answer.
          status: 'approved' as unknown as 'pending',
          requestedAt: new Date(0).toISOString(),
        }),
      cancel: () => Promise.resolve(),
    };
    expect(contractFailures(await approvalProviderContract(decider)).map((r) => r.name)).toContain(
      'request-never-yields-a-decision',
    );
  });

  it('TEETH: an unparseable requestedAt fails ticket-is-well-formed', async () => {
    const sloppy: ApprovalProvider = {
      id: 'x',
      request: () =>
        Promise.resolve({ ticketId: 't-1', status: 'pending' as const, requestedAt: 'whenever' }),
      cancel: () => Promise.resolve(),
    };
    expect(contractFailures(await approvalProviderContract(sloppy)).map((r) => r.name)).toContain(
      'ticket-is-well-formed',
    );
  });
});

describe('CostPolicy contract', () => {
  it('an in-memory fixture conforms', async () => {
    expectConforms(await costPolicyContract(new InMemoryFixtureCostPolicy(100)));
  });

  it('a fixture that is already exhausted still conforms — a typed denial IS conformance', async () => {
    expectConforms(await costPolicyContract(new InMemoryFixtureCostPolicy(0)));
  });

  it('checks every property it claims to', async () => {
    expect(names(await costPolicyContract(new InMemoryFixtureCostPolicy(100)))).toEqual([
      'authorize-yields-a-well-formed-decision',
      'denial-names-a-known-scope-with-finite-numbers',
      'settle-settles',
    ]);
  });

  it('TEETH: a shapeless decision fails authorize-yields-a-well-formed-decision', async () => {
    const shapeless: CostPolicy = {
      id: 'x',
      authorize: () => Promise.resolve({ ok: true } as unknown as PolicyDecision),
      settle: () => Promise.resolve(),
    };
    expect(contractFailures(await costPolicyContract(shapeless)).map((r) => r.name)).toContain(
      'authorize-yields-a-well-formed-decision',
    );
  });

  it('TEETH: a denial naming an unknown scope fails denial-names-a-known-scope-with-finite-numbers', async () => {
    const bogus: CostPolicy = {
      id: 'x',
      authorize: () =>
        Promise.resolve({
          allowed: false,
          denial: {
            scopeKind: 'galaxy' as unknown as BudgetScopeKind,
            scopeId: 's',
            ceiling: { kind: 'usd', limit: 1 },
            consumed: 0,
          },
        }),
      settle: () => Promise.resolve(),
    };
    expect(contractFailures(await costPolicyContract(bogus)).map((r) => r.name)).toContain(
      'denial-names-a-known-scope-with-finite-numbers',
    );
  });
});

describe('runSeamContracts', () => {
  it('runs every supplied seam and tags each result with its seam name', async () => {
    const results = await runSeamContracts({
      orchestrationStrategy: new SingleTaskPlanStrategy(),
      workerSelector: new CapabilityMatchSelector(),
      memoryProvider: new EmptyRecallMemoryProvider(),
      approvalProvider: new UnroutedApprovalProvider(),
      costPolicy: new InMemoryFixtureCostPolicy(100),
    });
    expect([...new Set(results.map((r) => r.seam))].sort()).toEqual([
      'ApprovalProvider',
      'CostPolicy',
      'OrchestrationStrategy',
      'WorkerSelector',
      'WorkforceMemoryProvider',
    ]);
    expectConforms(results);
  });

  it('an absent seam contributes no results — it is never silently reported as passing', async () => {
    const results = await runSeamContracts({ workerSelector: new CapabilityMatchSelector() });
    expect([...new Set(results.map((r) => r.seam))]).toEqual(['WorkerSelector']);
  });

  it('refuses an empty subject set rather than reporting a vacuous pass', async () => {
    await expect(runSeamContracts({})).rejects.toThrow(/no seam/i);
  });
});
