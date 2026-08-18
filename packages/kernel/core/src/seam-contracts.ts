/**
 * The SEAM CONTRACT KIT — the executable definition of what every extension seam implementation
 * must satisfy, shipped alongside the interfaces it validates.
 *
 * WHY IT IS A RUNTIME MODULE AND NOT A TEST HELPER. An implementation of these seams is expected to
 * live OUT OF TREE: a deployment installs its own strategy, selector, memory provider, approval
 * provider or cost policy without patching the engine. "It conforms" therefore has to be checkable
 * from outside this repository, in whatever runner that author uses — so the kit imports no test
 * framework and returns DATA (`ContractResult[]`) that any assertion library can read.
 *
 * WHAT A PASS MEANS, AND WHAT IT DOES NOT. Each property below is a STRUCTURAL obligation the
 * engine relies on. Passing the kit says an implementation is well-formed at its own boundary; it
 * says nothing about whether the engine would accept the result, because several of the real
 * authority checks need facts this package cannot see — the DECLARED workforce (which owners and
 * departments exist) is checked by `planRefusal` in the goal intake, and the durable budget ledger
 * is checked by the engine's own authorization path. The kit is the seam-side half; the engine-side
 * half is separate and is not replaced by a green run here.
 *
 * SIDE EFFECTS. The kit exercises the WRITE halves of the interfaces (`remember`, `settle`,
 * `request`, `cancel`) because a contract that only reads proves half a seam. Run it against a
 * throwaway deployment, never a live one.
 */
import type { ApprovalProvider } from './approval-provider.js';
import type { CostPolicy, ProposedExecution, SettledExecution } from './cost-policy.js';
import type { MemoryQuery, WorkforceMemoryProvider } from './memory-provider.js';
import type {
  ExecutionPlan,
  OrchestrationInput,
  OrchestrationStrategy,
} from './orchestration-strategy.js';
import type { SelectionTask, WorkerCandidate, WorkerSelector } from './worker-selector.js';

export type SeamName =
  | 'ApprovalProvider'
  | 'CostPolicy'
  | 'OrchestrationStrategy'
  | 'WorkerSelector'
  | 'WorkforceMemoryProvider';

/** One checked property and what was observed. `detail` is always populated, pass or fail. */
export interface ContractResult {
  readonly seam: SeamName;
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

/**
 * The step-count ceiling on ONE submitted goal's plan. A plan lands as sibling roots inside a single
 * transaction, so an unbounded plan is an unbounded write. The shipped default emits exactly one
 * step, and decomposition past a handful of roots belongs to the orchestrator's own turns via
 * `delegate_task` — where per-task budgets, the join machinery and the dispatch boundary all apply
 * to each new task. This bound is the seam-side statement of that split.
 */
export const SEAM_MAX_PLAN_STEPS = 64;

/**
 * The step-title ceiling. It MIRRORS the engine's own `MAX_TASK_TITLE_CHARS` row bound so a plan
 * that passes the kit is not refused for a title the kit called acceptable. The two constants live
 * in different packages (this one may not import the task engine), so a drift pin holds them equal;
 * see `packages/app/server/src/workforce-goal-intake.db.test.ts`.
 */
export const SEAM_MAX_STEP_TITLE_CHARS = 200;

/** The selection rationale is journal/debug text; it is bounded so a seam cannot flood the journal. */
export const SEAM_MAX_SELECTION_REASON_CHARS = 512;

/** The recall hit ceiling a provider must respect even when the query names no limit. */
export const SEAM_MAX_MEMORY_HITS = 64;

/** The closed set of ledger scopes a denial may name. Mirrors `BudgetScopeKind`. */
const BUDGET_SCOPE_KINDS: readonly string[] = ['task', 'root', 'department', 'workforce'];

/** Every failed property, in the order the kit checked it. */
export function contractFailures(results: readonly ContractResult[]): ContractResult[] {
  return results.filter((r) => !r.passed);
}

function message(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/** Build one result. `problems` empty ⇒ passed, and `okDetail` records what was actually observed. */
function verdict(
  seam: SeamName,
  name: string,
  problems: readonly string[],
  okDetail: string,
): ContractResult {
  return problems.length === 0
    ? { seam, name, passed: true, detail: okDetail }
    : { seam, name, passed: false, detail: problems.join('; ') };
}

// ── OrchestrationStrategy ────────────────────────────────────────────────────────────────────────

const STRATEGY_PROBES: readonly OrchestrationInput[] = [
  {
    workforceId: 'wf-contract-probe',
    goal: 'Collect the open items and produce one summary',
    requestedBy: 'user',
    defaultOwner: 'probe-orchestrator',
  },
  {
    workforceId: 'wf-contract-probe',
    goal: 'g'.repeat(4096),
    requestedBy: 'api-key:contract-probe',
    defaultOwner: 'probe-orchestrator',
  },
  {
    workforceId: 'wf-contract-probe',
    goal: 'Ship it',
    requestedBy: 'trigger:contract-probe',
    defaultOwner: 'probe-orchestrator',
  },
];

/**
 * Run the `OrchestrationStrategy` contract. The properties are the ones the goal intake's own
 * refusal path cannot recover from cheaply: shape, boundedness, dependency direction, and that the
 * strategy treats its input as read-only.
 */
export async function orchestrationStrategyContract(
  strategy: OrchestrationStrategy,
): Promise<ContractResult[]> {
  const plans: { input: OrchestrationInput; plan: ExecutionPlan }[] = [];
  const planErrors: string[] = [];
  for (const probe of STRATEGY_PROBES) {
    try {
      plans.push({ input: probe, plan: await strategy.plan({ ...probe }) });
    } catch (err) {
      planErrors.push(`goal '${probe.goal.slice(0, 32)}': ${message(err)}`);
    }
  }

  const seam: SeamName = 'OrchestrationStrategy';
  const results: ContractResult[] = [];

  const emptyPlans = plans.filter(({ plan }) => plan.steps.length === 0);
  results.push(
    verdict(
      seam,
      'plan-yields-at-least-one-step',
      [
        ...planErrors.map((e) => `plan() rejected for a probe (${e})`),
        ...emptyPlans.map(
          ({ input }) => `the plan for goal '${input.goal.slice(0, 32)}' has 0 steps`,
        ),
      ],
      `${plans.length} probe(s) each planned 1..${SEAM_MAX_PLAN_STEPS} steps`,
    ),
  );

  results.push(
    verdict(
      seam,
      'plan-is-bounded',
      plans
        .filter(({ plan }) => plan.steps.length > SEAM_MAX_PLAN_STEPS)
        .map(
          ({ plan }) =>
            `a plan carries ${plan.steps.length} steps (the bound is ${SEAM_MAX_PLAN_STEPS})`,
        ),
      `the widest plan carried ${Math.max(0, ...plans.map(({ plan }) => plan.steps.length))} step(s)`,
    ),
  );

  const shapeProblems: string[] = [];
  for (const { plan } of plans) {
    for (const [index, step] of plan.steps.entries()) {
      if (typeof step.title !== 'string' || step.title.length === 0) {
        shapeProblems.push(`step ${index} has an empty or non-string title`);
      } else if (step.title.length > SEAM_MAX_STEP_TITLE_CHARS) {
        shapeProblems.push(
          `step ${index} has a ${step.title.length}-character title (the row bound is ${SEAM_MAX_STEP_TITLE_CHARS})`,
        );
      }
      if (typeof step.goal !== 'string' || step.goal.length === 0) {
        shapeProblems.push(`step ${index} has an empty or non-string goal`);
      }
      if (typeof step.owner !== 'string' || step.owner.length === 0) {
        shapeProblems.push(`step ${index} names no owner`);
      }
      if (
        step.department !== null &&
        (typeof step.department !== 'string' || step.department.length === 0)
      ) {
        shapeProblems.push(`step ${index} books an empty department (use null for none)`);
      }
    }
  }
  results.push(
    verdict(
      seam,
      'plan-step-shape-is-creatable',
      shapeProblems,
      `every step of ${plans.length} probe plan(s) carries a creatable title, goal, owner and department`,
    ),
  );

  const depProblems: string[] = [];
  for (const { plan } of plans) {
    for (const [index, step] of plan.steps.entries()) {
      if (!Array.isArray(step.dependsOn)) {
        depProblems.push(`step ${index} has a non-array dependsOn`);
        continue;
      }
      for (const dep of step.dependsOn) {
        if (!Number.isInteger(dep) || dep < 0 || dep >= index) {
          depProblems.push(
            `step ${index} depends on index ${String(dep)}, which is not a PRIOR step`,
          );
        }
      }
    }
  }
  results.push(
    verdict(
      seam,
      'step-dependencies-name-only-prior-steps',
      depProblems,
      'every dependency index is an integer naming a strictly earlier step of the same plan',
    ),
  );

  // A strategy receives FACTS, never a handle. It must neither rewrite them nor need them writable:
  // an implementation that only works on a mutable input would break the moment the caller froze it.
  const probe = STRATEGY_PROBES[0] as OrchestrationInput;
  const mutable: OrchestrationInput = { ...probe };
  const before = JSON.stringify(mutable);
  let mutableRejected: string | null = null;
  try {
    await strategy.plan(mutable);
  } catch (err) {
    mutableRejected = message(err);
  }
  const after = JSON.stringify(mutable);
  let frozenRejected: string | null = null;
  try {
    await strategy.plan(Object.freeze({ ...probe }));
  } catch (err) {
    frozenRejected = message(err);
  }
  const mutationProblems: string[] = [];
  if (before !== after)
    mutationProblems.push(`plan() rewrote its input: ${before} became ${after}`);
  if (mutableRejected === null && frozenRejected !== null) {
    mutationProblems.push(
      `plan() rejected on a FROZEN input while accepting a mutable one (${frozenRejected})`,
    );
  }
  results.push(
    verdict(
      seam,
      'plan-does-not-mutate-its-input',
      mutationProblems,
      'the input was byte-identical after planning, and a frozen input behaved the same as a mutable one',
    ),
  );

  return results;
}

// ── WorkerSelector ───────────────────────────────────────────────────────────────────────────────

const SELECTOR_CANDIDATES: readonly WorkerCandidate[] = [
  {
    employeeId: 'probe-alpha',
    role: 'worker',
    department: 'probe-dept',
    capabilities: ['probe.write', 'probe.review'],
  },
  { employeeId: 'probe-beta', role: 'worker', department: null, capabilities: ['probe.write'] },
  { employeeId: 'probe-gamma', role: 'reviewer', department: 'probe-dept', capabilities: [] },
];

const SELECTOR_PROBES: readonly SelectionTask[] = [
  { taskId: 'probe-task-1', requiredCapabilities: ['probe.write'], department: null },
  { taskId: 'probe-task-2', requiredCapabilities: ['probe.write'], department: 'probe-dept' },
  { taskId: 'probe-task-3', requiredCapabilities: [], department: null },
];

/**
 * Run the `WorkerSelector` contract. The two load-bearing properties are membership (a selector may
 * only narrow the set it was handed) and capability coverage (a selector may not hand a task to
 * someone who does not declare what the task requires — that would be granting a capability).
 */
export async function workerSelectorContract(selector: WorkerSelector): Promise<ContractResult[]> {
  const seam: SeamName = 'WorkerSelector';
  const results: ContractResult[] = [];
  const declared = new Map(SELECTOR_CANDIDATES.map((c) => [c.employeeId, c]));

  const picks: { task: SelectionTask; employeeId: string; reason: string }[] = [];
  const selectErrors: string[] = [];
  for (const task of SELECTOR_PROBES) {
    try {
      const selection = await selector.select(task, SELECTOR_CANDIDATES);
      picks.push({ task, employeeId: selection.employeeId, reason: selection.reason });
    } catch (err) {
      selectErrors.push(`task '${task.taskId}': ${message(err)}`);
    }
  }

  results.push(
    verdict(
      seam,
      'selection-names-a-given-candidate',
      [
        ...selectErrors.map((e) => `select() rejected for a qualifiable probe (${e})`),
        ...picks
          .filter((p) => !declared.has(p.employeeId))
          .map((p) => `selected '${p.employeeId}', who is not in the candidate list`),
      ],
      `${picks.length} selection(s), each naming a candidate the caller supplied`,
    ),
  );

  results.push(
    verdict(
      seam,
      'selection-holds-every-required-capability',
      picks
        .filter((p) => {
          const candidate = declared.get(p.employeeId);
          return (
            candidate !== undefined &&
            !p.task.requiredCapabilities.every((label) => candidate.capabilities.includes(label))
          );
        })
        .map(
          (p) =>
            `task '${p.task.taskId}' requires [${p.task.requiredCapabilities.join(', ')}] but '${p.employeeId}' declares [${declared.get(p.employeeId)?.capabilities.join(', ') ?? ''}]`,
        ),
      'every selection declares every capability its task required',
    ),
  );

  results.push(
    verdict(
      seam,
      'selection-reason-is-bounded-text',
      picks
        .filter(
          (p) =>
            typeof p.reason !== 'string' ||
            p.reason.length === 0 ||
            p.reason.length > SEAM_MAX_SELECTION_REASON_CHARS,
        )
        .map(
          (p) =>
            `the reason for '${p.employeeId}' is not 1..${SEAM_MAX_SELECTION_REASON_CHARS} characters`,
        ),
      `every rationale is 1..${SEAM_MAX_SELECTION_REASON_CHARS} characters`,
    ),
  );

  // Fail-closed, both ways it can arise: nobody at all, and nobody who qualifies. Guessing here is
  // a silent misassignment, which is strictly worse than a typed refusal the caller can park on.
  let emptyOutcome = 'rejected';
  try {
    const selection = await selector.select(
      { taskId: 'probe-empty', requiredCapabilities: [], department: null },
      [],
    );
    emptyOutcome = `resolved '${selection.employeeId}'`;
  } catch {
    // A rejection is the contract.
  }
  results.push(
    verdict(
      seam,
      'an-empty-candidate-list-fails-closed',
      emptyOutcome === 'rejected'
        ? []
        : [`select() with NO candidates ${emptyOutcome} instead of rejecting`],
      'select() with no candidates rejected, as the contract requires',
    ),
  );

  let unqualifiedOutcome = 'rejected';
  try {
    const selection = await selector.select(
      {
        taskId: 'probe-unqualified',
        requiredCapabilities: ['probe.nobody-declares-this'],
        department: null,
      },
      SELECTOR_CANDIDATES,
    );
    unqualifiedOutcome = `resolved '${selection.employeeId}'`;
  } catch {
    // A rejection is the contract.
  }
  results.push(
    verdict(
      seam,
      'no-qualified-candidate-fails-closed',
      unqualifiedOutcome === 'rejected'
        ? []
        : [`select() for an unheld capability ${unqualifiedOutcome} instead of rejecting`],
      'select() rejected when no candidate held the required capability',
    ),
  );

  const frozenCandidates = Object.freeze(SELECTOR_CANDIDATES.map((c) => Object.freeze({ ...c })));
  const candidatesBefore = JSON.stringify(frozenCandidates);
  let frozenFailure: string | null = null;
  try {
    await selector.select(SELECTOR_PROBES[0] as SelectionTask, frozenCandidates);
  } catch (err) {
    frozenFailure = message(err);
  }
  const candidatesAfter = JSON.stringify(frozenCandidates);
  results.push(
    verdict(
      seam,
      'selection-does-not-mutate-the-candidate-set',
      [
        ...(candidatesBefore === candidatesAfter
          ? []
          : ['select() rewrote the candidate list it was handed']),
        ...(frozenFailure !== null && selectErrors.length === 0
          ? [`select() rejected on a FROZEN candidate list (${frozenFailure})`]
          : []),
      ],
      'the candidate list was byte-identical after selection, frozen or not',
    ),
  );

  return results;
}

// ── WorkforceMemoryProvider ──────────────────────────────────────────────────────────────────────

/**
 * Run the `WorkforceMemoryProvider` contract. Recall is rendered into a later turn's context as
 * bounded, neutralized DATA by the caller, so the properties here are about SIZE and SHAPE: a
 * provider that ignores the limit it was given hands the caller a bill it did not agree to.
 */
export async function memoryProviderContract(
  provider: WorkforceMemoryProvider,
): Promise<ContractResult[]> {
  const seam: SeamName = 'WorkforceMemoryProvider';
  const results: ContractResult[] = [];

  const unlimited = await provider.search({ text: 'contract probe' });
  const limited = await provider.search({ text: 'contract probe', limit: 3 });
  const scoped = await provider.search({
    text: 'contract probe',
    workforceId: 'wf-contract-probe',
    limit: 1,
  });

  results.push(
    verdict(
      seam,
      'search-yields-a-bounded-list',
      [
        ...(Array.isArray(unlimited) ? [] : ['search() did not yield an array']),
        ...(Array.isArray(unlimited) && unlimited.length > SEAM_MAX_MEMORY_HITS
          ? [
              `a limit-free search yielded ${unlimited.length} hits (the bound is ${SEAM_MAX_MEMORY_HITS})`,
            ]
          : []),
      ],
      `a limit-free search yielded ${Array.isArray(unlimited) ? unlimited.length : 0} hit(s)`,
    ),
  );

  results.push(
    verdict(
      seam,
      'search-honors-the-query-limit',
      [
        ...(limited.length > 3 ? [`limit 3 yielded ${limited.length} hits`] : []),
        ...(scoped.length > 1 ? [`limit 1 yielded ${scoped.length} hits`] : []),
      ],
      `limit 3 yielded ${limited.length} hit(s); limit 1 yielded ${scoped.length} hit(s)`,
    ),
  );

  const hitProblems: string[] = [];
  for (const hit of [...unlimited, ...limited, ...scoped]) {
    if (typeof hit?.id !== 'string' || hit.id.length === 0) hitProblems.push('a hit carries no id');
    if (typeof hit?.text !== 'string') hitProblems.push('a hit carries non-string text');
    if (typeof hit?.score !== 'number' || !Number.isFinite(hit.score)) {
      hitProblems.push(`a hit carries a non-finite score (${String(hit?.score)})`);
    }
  }
  results.push(
    verdict(
      seam,
      'hits-are-well-formed',
      hitProblems,
      `${unlimited.length + limited.length + scoped.length} hit(s) each carry an id, text and a finite score`,
    ),
  );

  const query: MemoryQuery = { text: 'contract probe', limit: 2 };
  const queryBefore = JSON.stringify(query);
  await provider.search(query);
  results.push(
    verdict(
      seam,
      'search-does-not-mutate-the-query',
      JSON.stringify(query) === queryBefore ? [] : ['search() rewrote the query it was handed'],
      'the query was byte-identical after the search',
    ),
  );

  let rememberFailure: string | null = null;
  try {
    await provider.remember({ text: 'a contract-probe entry', tags: ['contract-probe'] });
  } catch (err) {
    rememberFailure = message(err);
  }
  results.push(
    verdict(
      seam,
      'remember-settles',
      rememberFailure === null
        ? []
        : [
            `remember() rejected (${rememberFailure}); a provider that retains nothing must still resolve`,
          ],
      'remember() resolved',
    ),
  );

  return results;
}

// ── ApprovalProvider ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the `ApprovalProvider` contract. The one property everything else rests on: `request` returns
 * a PENDING ticket or refuses — never a decision. A provider that could answer would collapse the
 * asynchronous park the engine's design depends on into a blocking call.
 */
export async function approvalProviderContract(
  provider: ApprovalProvider,
): Promise<ContractResult[]> {
  const seam: SeamName = 'ApprovalProvider';
  const results: ContractResult[] = [];

  let ticket: { ticketId: string; status: string; requestedAt: string } | null = null;
  let requestFailure: string | null = null;
  try {
    ticket = await provider.request({
      taskId: 'probe-task',
      requestedBy: 'probe-employee',
      approver: 'user',
      reason: 'a contract probe',
      timeoutMs: 60_000,
      onTimeout: 'fail',
    });
  } catch (err) {
    requestFailure = message(err);
  }

  results.push(
    verdict(
      seam,
      'request-never-yields-a-decision',
      ticket !== null && ticket.status !== 'pending'
        ? [
            `request() yielded status '${ticket.status}' — a provider may only ever return a pending ticket`,
          ]
        : [],
      ticket === null
        ? `request() refused (${requestFailure ?? 'no ticket'}), which is a conforming outcome`
        : "request() yielded a ticket with status 'pending'",
    ),
  );

  const ticketProblems: string[] = [];
  if (ticket !== null) {
    if (typeof ticket.ticketId !== 'string' || ticket.ticketId.length === 0) {
      ticketProblems.push('the ticket carries no ticketId');
    } else if (ticket.ticketId.length > 200) {
      ticketProblems.push(`the ticketId is ${ticket.ticketId.length} characters`);
    }
    if (typeof ticket.requestedAt !== 'string' || Number.isNaN(Date.parse(ticket.requestedAt))) {
      ticketProblems.push(`requestedAt '${String(ticket.requestedAt)}' is not a parseable instant`);
    }
  }
  results.push(
    verdict(
      seam,
      'ticket-is-well-formed',
      ticketProblems,
      ticket === null
        ? 'no ticket was issued, so there was no ticket to check'
        : 'the ticket carries a bounded id and a parseable requestedAt',
    ),
  );

  let cancelSettled = true;
  let cancelDetail = 'cancel() resolved';
  try {
    await provider.cancel(ticket?.ticketId ?? 'probe-ticket', 'the contract probe is done');
  } catch (err) {
    cancelSettled = err instanceof Error;
    cancelDetail = `cancel() rejected with ${message(err)}, which is a conforming outcome`;
  }
  results.push(
    verdict(
      seam,
      'cancel-settles',
      cancelSettled ? [] : ['cancel() rejected with a non-Error value'],
      cancelDetail,
    ),
  );

  return results;
}

// ── CostPolicy ───────────────────────────────────────────────────────────────────────────────────

const COST_PROBES: readonly ProposedExecution[] = [
  {
    taskId: 'probe-task',
    rootTaskId: 'probe-root',
    workforceId: 'wf-contract-probe',
    department: null,
    estimateUsd: 0.01,
  },
  {
    taskId: 'probe-task-dept',
    rootTaskId: 'probe-root',
    workforceId: 'wf-contract-probe',
    department: 'probe-dept',
    estimateUsd: 1_000_000,
  },
];

/**
 * Run the `CostPolicy` contract. Note what is NOT here: whether the decision is CORRECT. Only the
 * durable ledger knows that, and the confinement in `seam-confinement.ts` is what keeps an injected
 * opinion from widening a ceiling. This kit checks that the answer is a well-formed, typed decision
 * a caller can act on — an unreadable decision is a park the engine cannot explain.
 */
export async function costPolicyContract(policy: CostPolicy): Promise<ContractResult[]> {
  const seam: SeamName = 'CostPolicy';
  const results: ContractResult[] = [];

  const decisions: { proposed: ProposedExecution; decision: unknown }[] = [];
  const authorizeErrors: string[] = [];
  for (const proposed of COST_PROBES) {
    try {
      decisions.push({ proposed, decision: await policy.authorize(proposed) });
    } catch (err) {
      authorizeErrors.push(`task '${proposed.taskId}': ${message(err)}`);
    }
  }

  const shapeProblems = [...authorizeErrors.map((e) => `authorize() rejected (${e})`)];
  for (const { decision } of decisions) {
    const d = decision as { allowed?: unknown; denial?: unknown };
    if (typeof d?.allowed !== 'boolean') {
      shapeProblems.push(
        `a decision carries allowed='${String(d?.allowed)}' rather than a boolean`,
      );
    } else if (d.allowed === false && (typeof d.denial !== 'object' || d.denial === null)) {
      shapeProblems.push('a denial carries no denial detail');
    }
  }
  results.push(
    verdict(
      seam,
      'authorize-yields-a-well-formed-decision',
      shapeProblems,
      `${decisions.length} decision(s), each a typed allow or a denial carrying its detail`,
    ),
  );

  const denials = decisions
    .map(({ decision }) => decision as { allowed: boolean; denial?: Record<string, unknown> })
    .filter((d) => d?.allowed === false && typeof d.denial === 'object')
    .map((d) => d.denial as Record<string, unknown>);
  const denialProblems: string[] = [];
  for (const denial of denials) {
    if (typeof denial.scopeKind !== 'string' || !BUDGET_SCOPE_KINDS.includes(denial.scopeKind)) {
      denialProblems.push(
        `a denial names scope kind '${String(denial.scopeKind)}', outside [${BUDGET_SCOPE_KINDS.join(', ')}]`,
      );
    }
    if (typeof denial.scopeId !== 'string' || denial.scopeId.length === 0) {
      denialProblems.push('a denial names no scope id');
    }
    const ceiling = denial.ceiling as { kind?: unknown; limit?: unknown } | undefined;
    if (ceiling?.kind !== 'usd' && ceiling?.kind !== 'turns') {
      denialProblems.push(
        `a denial names ceiling kind '${String(ceiling?.kind)}', outside [usd, turns]`,
      );
    }
    if (
      typeof ceiling?.limit !== 'number' ||
      !Number.isFinite(ceiling.limit) ||
      ceiling.limit < 0
    ) {
      denialProblems.push(
        `a denial carries a non-finite or negative ceiling (${String(ceiling?.limit)})`,
      );
    }
    if (
      typeof denial.consumed !== 'number' ||
      !Number.isFinite(denial.consumed) ||
      denial.consumed < 0
    ) {
      denialProblems.push(
        `a denial carries a non-finite or negative consumed total (${String(denial.consumed)})`,
      );
    }
  }
  results.push(
    verdict(
      seam,
      'denial-names-a-known-scope-with-finite-numbers',
      denialProblems,
      denials.length === 0
        ? 'no probe was denied, so there was no denial to check'
        : `${denials.length} denial(s) each name a known scope with finite, non-negative numbers`,
    ),
  );

  const settled: SettledExecution = { ...(COST_PROBES[0] as ProposedExecution), actualUsd: 0.02 };
  let settleFailure: string | null = null;
  try {
    await policy.settle(settled);
  } catch (err) {
    settleFailure = message(err);
  }
  results.push(
    verdict(
      seam,
      'settle-settles',
      settleFailure === null ? [] : [`settle() rejected (${settleFailure})`],
      'settle() resolved',
    ),
  );

  return results;
}

// ── the aggregate ────────────────────────────────────────────────────────────────────────────────

export interface SeamContractSubjects {
  readonly orchestrationStrategy?: OrchestrationStrategy;
  readonly workerSelector?: WorkerSelector;
  readonly memoryProvider?: WorkforceMemoryProvider;
  readonly approvalProvider?: ApprovalProvider;
  readonly costPolicy?: CostPolicy;
}

/**
 * Run every supplied seam's contract. An ABSENT seam contributes NO results rather than a pass —
 * a kit that reported "all green" for a subject it never received would be the one failure mode a
 * conformance kit must not have. An empty subject set therefore throws instead of returning [].
 */
export async function runSeamContracts(subjects: SeamContractSubjects): Promise<ContractResult[]> {
  const results: ContractResult[] = [];
  if (subjects.orchestrationStrategy !== undefined) {
    results.push(...(await orchestrationStrategyContract(subjects.orchestrationStrategy)));
  }
  if (subjects.workerSelector !== undefined) {
    results.push(...(await workerSelectorContract(subjects.workerSelector)));
  }
  if (subjects.memoryProvider !== undefined) {
    results.push(...(await memoryProviderContract(subjects.memoryProvider)));
  }
  if (subjects.approvalProvider !== undefined) {
    results.push(...(await approvalProviderContract(subjects.approvalProvider)));
  }
  if (subjects.costPolicy !== undefined) {
    results.push(...(await costPolicyContract(subjects.costPolicy)));
  }
  if (results.length === 0) {
    throw new Error(
      'runSeamContracts was given no seam to check — an empty run would report a vacuous pass. ' +
        'Supply at least one implementation.',
    );
  }
  return results;
}
