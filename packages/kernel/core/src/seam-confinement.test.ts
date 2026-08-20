/**
 * THE ADVERSARIAL HALF. For each confinable seam this drives an implementation that tries to take
 * authority the seam does not have — a selector naming someone outside the candidate set, a
 * selector handing a task to someone who lacks the capability it requires, a cost policy allowing
 * what the ledger denied, an approval provider answering its own question, a memory provider
 * flooding the recall section — and proves the confinement refuses it.
 *
 * Two shapes of refusal, and the split is deliberate:
 *   - AUTHORITY is refused. An identity, a decision, an approval status: wrong means typed refusal.
 *   - SIZE is clamped. A rationale string, a hit count: too big means bounded, because converting a
 *     size problem into an availability problem hands the extension a denial-of-service it did not
 *     otherwise have.
 *
 * Every conforming implementation must pass through unchanged, which is the control that keeps the
 * confinement from being a blanket refusal wearing a guard's clothes.
 */
import { describe, expect, it } from 'vitest';
import { type ApprovalProvider, UnroutedApprovalProvider } from './approval-provider.js';
import type { CostPolicy, PolicyDecision, ProposedExecution } from './cost-policy.js';
import {
  EmptyRecallMemoryProvider,
  type MemoryHit,
  type WorkforceMemoryProvider,
} from './memory-provider.js';
import {
  confineApprovalProvider,
  confineCostPolicy,
  confineMemoryProvider,
  confineWorkerSelector,
  SeamConfinementError,
} from './seam-confinement.js';
import { SEAM_MAX_MEMORY_HITS, SEAM_MAX_SELECTION_REASON_CHARS } from './seam-contracts.js';
import {
  CapabilityMatchSelector,
  type SelectionTask,
  type WorkerCandidate,
  WorkerSelectionError,
  type WorkerSelector,
} from './worker-selector.js';

const CANDIDATES: readonly WorkerCandidate[] = [
  { employeeId: 'alpha', role: 'worker', department: 'eng', capabilities: ['write', 'review'] },
  { employeeId: 'beta', role: 'worker', department: null, capabilities: ['write'] },
  { employeeId: 'gamma', role: 'reviewer', department: 'eng', capabilities: [] },
];
const TASK: SelectionTask = { taskId: 't-1', requiredCapabilities: ['write'], department: null };

const PROPOSED: ProposedExecution = {
  taskId: 't-1',
  rootTaskId: 'r-1',
  workforceId: 'wf-1',
  department: null,
  estimateUsd: 0.5,
};

/** A baseline that always denies — the durable ledger's answer, in miniature. */
const denyingBaseline: CostPolicy = {
  id: 'denying-baseline',
  authorize: () =>
    Promise.resolve({
      allowed: false,
      denial: {
        scopeKind: 'workforce',
        scopeId: 'wf-1',
        ceiling: { kind: 'usd', limit: 10 },
        consumed: 10,
      },
    }),
  settle: () => Promise.resolve(),
};

/** A baseline that always allows, recording whether its settlement ran. */
function allowingBaseline(): CostPolicy & { settled: string[] } {
  const settled: string[] = [];
  return {
    id: 'allowing-baseline',
    settled,
    authorize: () => Promise.resolve({ allowed: true }),
    settle: (actual) => {
      settled.push(actual.taskId);
      return Promise.resolve();
    },
  };
}

describe('confineWorkerSelector', () => {
  it('a conforming selector passes through unchanged', async () => {
    const confined = confineWorkerSelector(new CapabilityMatchSelector());
    const selection = await confined.select(TASK, CANDIDATES);
    expect(selection.employeeId).toBe('alpha');
    expect(selection.reason).toContain('declaration order');
  });

  it('REFUSES a selection naming someone outside the candidate set', async () => {
    const outsider: WorkerSelector = {
      id: 'outsider',
      select: () => Promise.resolve({ employeeId: 'delta', reason: 'my own pick' }),
    };
    await expect(confineWorkerSelector(outsider).select(TASK, CANDIDATES)).rejects.toBeInstanceOf(
      SeamConfinementError,
    );
    await expect(confineWorkerSelector(outsider).select(TASK, CANDIDATES)).rejects.toThrow(
      /'delta'.*not among the candidates/,
    );
  });

  it('REFUSES a selection lacking a capability the task requires — a seam cannot grant one', async () => {
    const grantor: WorkerSelector = {
      id: 'grantor',
      select: () => Promise.resolve({ employeeId: 'gamma', reason: 'promoted them' }),
    };
    await expect(confineWorkerSelector(grantor).select(TASK, CANDIDATES)).rejects.toThrow(
      /does not declare \[write\]/,
    );
  });

  it('REFUSES a selection with a non-string employee id', async () => {
    const shapeless: WorkerSelector = {
      id: 'shapeless',
      select: () =>
        Promise.resolve({ employeeId: 42 as unknown as string, reason: 'a number will do' }),
    };
    await expect(confineWorkerSelector(shapeless).select(TASK, CANDIDATES)).rejects.toBeInstanceOf(
      SeamConfinementError,
    );
  });

  it('CLAMPS an over-long rationale instead of refusing — the reason carries no authority', async () => {
    const chatty: WorkerSelector = {
      id: 'chatty',
      select: () => Promise.resolve({ employeeId: 'alpha', reason: 'w'.repeat(10_000) }),
    };
    const selection = await confineWorkerSelector(chatty).select(TASK, CANDIDATES);
    expect(selection.employeeId).toBe('alpha');
    expect(selection.reason.length).toBe(SEAM_MAX_SELECTION_REASON_CHARS);
  });

  it('clamps an ASTRAL rationale without leaving a lone surrogate — the arm above is pure ASCII', async () => {
    // The clamp above uses `'w'.repeat(10_000)`: every character is ONE UTF-16 code unit, so its
    // cut can never land inside a surrogate pair. This rationale is extension-authored text and an
    // extension is free to emit emoji, so the cut position is not something the engine controls.
    // The surrogate must sit at the LAST KEPT index, not one past it — an off-by-one here yields a
    // fixture that is still astral, still passes a naive "surrogate near the cut" check, and never
    // exercises the guard. Named rather than inlined for exactly that reason.
    const lastKept = SEAM_MAX_SELECTION_REASON_CHARS - 1;
    const astral = `${'w'.repeat(lastKept)}${'\u{1F600}'.repeat(100)}`;
    // The fixture proves itself BEFORE anything else is asserted.
    expect(astral.length).toBeGreaterThan(SEAM_MAX_SELECTION_REASON_CHARS);
    expect(astral.charCodeAt(lastKept)).toBeGreaterThanOrEqual(0xd800);
    expect(astral.charCodeAt(lastKept)).toBeLessThanOrEqual(0xdbff);

    const emoji: WorkerSelector = {
      id: 'emoji',
      select: () => Promise.resolve({ employeeId: 'alpha', reason: astral }),
    };
    const selection = await confineWorkerSelector(emoji).select(TASK, CANDIDATES);
    expect(selection.reason.isWellFormed()).toBe(true);
    // One SHORTER than the cap: the guard gave the orphaned high surrogate back. Seeing the
    // shorter length is the evidence that the cut really landed inside a pair.
    expect(selection.reason.length).toBe(SEAM_MAX_SELECTION_REASON_CHARS - 1);
    expect(astral.startsWith(selection.reason)).toBe(true);
  });

  it("passes the inner selector's typed refusal through unchanged", async () => {
    // A non-empty list, so the wrapper's own empty-list pre-check cannot be what refuses: the
    // rejection has to come from the inner selector, and has to arrive with its own type intact.
    const confined = confineWorkerSelector(new CapabilityMatchSelector());
    await expect(
      confined.select(
        { taskId: 't-2', requiredCapabilities: ['nobody-declares-this'], department: null },
        CANDIDATES,
      ),
    ).rejects.toBeInstanceOf(WorkerSelectionError);
  });

  it('REFUSES an empty candidate list before the inner selector can answer at all', async () => {
    const inventor: WorkerSelector = {
      id: 'inventor',
      select: () => Promise.resolve({ employeeId: 'invented', reason: 'from nowhere' }),
    };
    await expect(confineWorkerSelector(inventor).select(TASK, [])).rejects.toBeInstanceOf(
      SeamConfinementError,
    );
  });
});

describe('confineCostPolicy', () => {
  it('an extension may DENY what the baseline allowed', async () => {
    const stricter: CostPolicy = {
      id: 'stricter',
      authorize: () =>
        Promise.resolve({
          allowed: false,
          denial: {
            scopeKind: 'department',
            scopeId: 'eng',
            ceiling: { kind: 'turns', limit: 3 },
            consumed: 3,
          },
        }),
      settle: () => Promise.resolve(),
    };
    const decision = await confineCostPolicy(allowingBaseline(), stricter).authorize(PROPOSED);
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.denial.scopeId).toBe('eng');
  });

  it('an extension may NOT allow what the baseline denied — the denial is what survives', async () => {
    const permissive: CostPolicy = {
      id: 'permissive',
      authorize: () => Promise.resolve({ allowed: true }),
      settle: () => Promise.resolve(),
    };
    const decision = await confineCostPolicy(denyingBaseline, permissive).authorize(PROPOSED);
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.denial.ceiling).toEqual({
      kind: 'usd',
      limit: 10,
    });
  });

  it('a widened ceiling in the extension changes nothing — the baseline denial is returned verbatim', async () => {
    const widener: CostPolicy = {
      id: 'widener',
      authorize: () =>
        Promise.resolve({
          allowed: false,
          denial: {
            scopeKind: 'workforce',
            scopeId: 'wf-1',
            // A ceiling a thousand times the declared one, reported as if it were the truth.
            ceiling: { kind: 'usd', limit: 10_000 },
            consumed: 0,
          },
        }),
      settle: () => Promise.resolve(),
    };
    const decision = await confineCostPolicy(denyingBaseline, widener).authorize(PROPOSED);
    expect(decision.allowed === false && decision.denial.ceiling).toEqual({
      kind: 'usd',
      limit: 10,
    });
  });

  it('the extension is never consulted once the baseline has denied', async () => {
    let consulted = 0;
    const counting: CostPolicy = {
      id: 'counting',
      authorize: () => {
        consulted += 1;
        return Promise.resolve({ allowed: true });
      },
      settle: () => Promise.resolve(),
    };
    await confineCostPolicy(denyingBaseline, counting).authorize(PROPOSED);
    expect(consulted).toBe(0);
  });

  it('SETTLEMENT reaches the baseline FIRST and the extension after — a stateful policy can accumulate', async () => {
    const baseline = allowingBaseline();
    const order: string[] = [];
    const extension: CostPolicy = {
      id: 'extension',
      authorize: () => Promise.resolve({ allowed: true }),
      settle: () => {
        order.push('extension');
        return Promise.resolve();
      },
    };
    const confined = confineCostPolicy(
      {
        ...baseline,
        settle: (actual) => {
          order.push('baseline');
          return baseline.settle(actual);
        },
      },
      extension,
    );
    await confined.settle({ ...PROPOSED, actualUsd: 0.6 });
    expect(order).toEqual(['baseline', 'extension']);
    expect(baseline.settled).toEqual(['t-1']);
  });

  it("a THROWING extension settlement does not undo the baseline's ledger write", async () => {
    const baseline = allowingBaseline();
    const exploding: CostPolicy = {
      id: 'exploding',
      authorize: () => Promise.resolve({ allowed: true }),
      settle: () => Promise.reject(new Error('the extension ledger is offline')),
    };
    await expect(
      confineCostPolicy(baseline, exploding).settle({ ...PROPOSED, actualUsd: 0.6 }),
    ).resolves.toBeUndefined();
    expect(baseline.settled).toEqual(['t-1']);
  });

  it("a FAILING baseline settlement surfaces — it is the turn's real settlement", async () => {
    const failing: CostPolicy = {
      id: 'failing-baseline',
      authorize: () => Promise.resolve({ allowed: true }),
      settle: () => Promise.reject(new Error('the ledger write failed')),
    };
    let extensionSettled = 0;
    const extension: CostPolicy = {
      id: 'extension',
      authorize: () => Promise.resolve({ allowed: true }),
      settle: () => {
        extensionSettled += 1;
        return Promise.resolve();
      },
    };
    await expect(
      confineCostPolicy(failing, extension).settle({ ...PROPOSED, actualUsd: 0.6 }),
    ).rejects.toThrow(/the ledger write failed/);
    expect(extensionSettled).toBe(0);
  });

  it('an accumulating extension still cannot outvote the baseline once it has spent its own ceiling', async () => {
    // The whole point of restoring settlement: a ceiling that accumulates. After settling 0.6 against
    // a 1.0 ceiling, the extension denies the next 0.6 turn that the baseline would have allowed.
    let spent = 0;
    const accumulating: CostPolicy = {
      id: 'accumulating',
      authorize: (proposed) =>
        Promise.resolve(
          spent + proposed.estimateUsd <= 1
            ? { allowed: true }
            : {
                allowed: false,
                denial: {
                  scopeKind: 'department',
                  scopeId: 'eng',
                  ceiling: { kind: 'usd', limit: 1 },
                  consumed: spent,
                },
              },
        ),
      settle: (actual) => {
        spent += actual.actualUsd;
        return Promise.resolve();
      },
    };
    const confined = confineCostPolicy(allowingBaseline(), accumulating);
    await expect(confined.authorize(PROPOSED)).resolves.toEqual({ allowed: true });
    await confined.settle({ ...PROPOSED, actualUsd: 0.6 });
    const second = await confined.authorize(PROPOSED);
    expect(second.allowed).toBe(false);
    expect(second.allowed === false && second.denial.consumed).toBe(0.6);
  });

  it('REFUSES a malformed extension decision rather than reading it as an allow', async () => {
    const shapeless: CostPolicy = {
      id: 'shapeless',
      authorize: () => Promise.resolve({ maybe: 'sure' } as unknown as PolicyDecision),
      settle: () => Promise.resolve(),
    };
    await expect(
      confineCostPolicy(allowingBaseline(), shapeless).authorize(PROPOSED),
    ).rejects.toBeInstanceOf(SeamConfinementError);
  });

  it('REFUSES an extension denial naming a scope kind outside the closed set', async () => {
    const bogus: CostPolicy = {
      id: 'bogus',
      authorize: () =>
        Promise.resolve({
          allowed: false,
          denial: {
            scopeKind: 'galaxy' as unknown as 'task',
            scopeId: 's',
            ceiling: { kind: 'usd', limit: 1 },
            consumed: 0,
          },
        }),
      settle: () => Promise.resolve(),
    };
    await expect(
      confineCostPolicy(allowingBaseline(), bogus).authorize(PROPOSED),
    ).rejects.toBeInstanceOf(SeamConfinementError);
  });

  it('a throwing extension fails CLOSED — the spend is not authorized', async () => {
    const thrower: CostPolicy = {
      id: 'thrower',
      authorize: () => Promise.reject(new Error('extension exploded')),
      settle: () => Promise.resolve(),
    };
    await expect(
      confineCostPolicy(allowingBaseline(), thrower).authorize(PROPOSED),
    ).rejects.toThrow(/extension exploded/);
  });
});

describe('confineApprovalProvider', () => {
  it('a conforming provider passes through unchanged', async () => {
    const ticketing: ApprovalProvider = {
      id: 'ticketing',
      request: () =>
        Promise.resolve({
          ticketId: 'tk-1',
          status: 'pending' as const,
          requestedAt: new Date(0).toISOString(),
        }),
      cancel: () => Promise.resolve(),
    };
    const ticket = await confineApprovalProvider(ticketing).request({
      taskId: 't',
      requestedBy: 'e',
      approver: 'user',
      reason: 'r',
      timeoutMs: null,
      onTimeout: 'fail',
    });
    expect(ticket).toEqual({
      ticketId: 'tk-1',
      status: 'pending',
      requestedAt: new Date(0).toISOString(),
    });
  });

  it('REFUSES a provider that answers its own question', async () => {
    const decider: ApprovalProvider = {
      id: 'decider',
      request: () =>
        Promise.resolve({
          ticketId: 'tk-1',
          status: 'approved' as unknown as 'pending',
          requestedAt: new Date(0).toISOString(),
        }),
      cancel: () => Promise.resolve(),
    };
    await expect(
      confineApprovalProvider(decider).request({
        taskId: 't',
        requestedBy: 'e',
        approver: 'user',
        reason: 'r',
        timeoutMs: null,
        onTimeout: 'escalate',
      }),
    ).rejects.toThrow(/status 'approved'/);
  });

  it('REFUSES an unparseable requestedAt', async () => {
    const sloppy: ApprovalProvider = {
      id: 'sloppy',
      request: () =>
        Promise.resolve({ ticketId: 'tk-1', status: 'pending' as const, requestedAt: 'whenever' }),
      cancel: () => Promise.resolve(),
    };
    await expect(
      confineApprovalProvider(sloppy).request({
        taskId: 't',
        requestedBy: 'e',
        approver: 'user',
        reason: 'r',
        timeoutMs: null,
        onTimeout: 'fail',
      }),
    ).rejects.toBeInstanceOf(SeamConfinementError);
  });

  it("passes the shipped default's typed refusal through unchanged", async () => {
    await expect(
      confineApprovalProvider(new UnroutedApprovalProvider()).request({
        taskId: 't',
        requestedBy: 'e',
        approver: 'user',
        reason: 'r',
        timeoutMs: null,
        onTimeout: 'fail',
      }),
    ).rejects.toThrow(/no bound decision surface/);
  });
});

describe('confineMemoryProvider', () => {
  it('the shipped default passes through unchanged', async () => {
    await expect(
      confineMemoryProvider(new EmptyRecallMemoryProvider()).search({ text: 'anything' }),
    ).resolves.toEqual([]);
  });

  it('CLAMPS a flood to the seam ceiling when the query names no limit', async () => {
    const flood: WorkforceMemoryProvider = {
      id: 'flood',
      search: () =>
        Promise.resolve(
          Array.from({ length: 100_000 }, (_v, i) => ({ id: `h${i}`, text: 'x', score: 1 })),
        ),
      remember: () => Promise.resolve(),
    };
    const hits = await confineMemoryProvider(flood).search({ text: 'anything' });
    expect(hits.length).toBe(SEAM_MAX_MEMORY_HITS);
  });

  it("CLAMPS to the caller's own limit when it is narrower", async () => {
    const flood: WorkforceMemoryProvider = {
      id: 'flood',
      search: () =>
        Promise.resolve(
          Array.from({ length: 500 }, (_v, i) => ({ id: `h${i}`, text: 'x', score: 1 })),
        ),
      remember: () => Promise.resolve(),
    };
    const hits = await confineMemoryProvider(flood).search({ text: 'anything', limit: 5 });
    expect(hits.length).toBe(5);
  });

  it('REFUSES a malformed hit — a size problem is clamped, an unusable value is not', async () => {
    const malformed: WorkforceMemoryProvider = {
      id: 'malformed',
      search: () => Promise.resolve([{ id: 'h', text: 'x', score: Number.NaN } as MemoryHit]),
      remember: () => Promise.resolve(),
    };
    await expect(
      confineMemoryProvider(malformed).search({ text: 'anything' }),
    ).rejects.toBeInstanceOf(SeamConfinementError);
  });

  it('REFUSES a non-array search result', async () => {
    const shapeless: WorkforceMemoryProvider = {
      id: 'shapeless',
      search: () => Promise.resolve('lots of hits' as unknown as readonly MemoryHit[]),
      remember: () => Promise.resolve(),
    };
    await expect(
      confineMemoryProvider(shapeless).search({ text: 'anything' }),
    ).rejects.toBeInstanceOf(SeamConfinementError);
  });

  it('keeps the highest-ranked hits when it clamps', async () => {
    const ranked: WorkforceMemoryProvider = {
      id: 'ranked',
      search: () =>
        Promise.resolve([
          { id: 'top', text: 'top', score: 9 },
          { id: 'mid', text: 'mid', score: 5 },
          { id: 'low', text: 'low', score: 1 },
        ]),
      remember: () => Promise.resolve(),
    };
    const hits = await confineMemoryProvider(ranked).search({ text: 'anything', limit: 2 });
    expect(hits.map((h) => h.id)).toEqual(['top', 'mid']);
  });
});

describe('the confinement identity', () => {
  it('each confined seam reports an id naming what it wraps', () => {
    expect(confineWorkerSelector(new CapabilityMatchSelector()).id).toBe(
      'confined(capability-match)',
    );
    expect(confineMemoryProvider(new EmptyRecallMemoryProvider()).id).toBe(
      'confined(empty-recall)',
    );
    expect(confineApprovalProvider(new UnroutedApprovalProvider()).id).toBe('confined(unrouted)');
    expect(confineCostPolicy(denyingBaseline, denyingBaseline).id).toBe(
      'confined(denying-baseline+denying-baseline)',
    );
  });

  it('a SeamConfinementError names the seam and the property that refused', async () => {
    const outsider: WorkerSelector = {
      id: 'outsider',
      select: () => Promise.resolve({ employeeId: 'delta', reason: 'mine' }),
    };
    const err = await confineWorkerSelector(outsider)
      .select(TASK, CANDIDATES)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SeamConfinementError);
    expect((err as SeamConfinementError).seam).toBe('WorkerSelector');
    expect((err as SeamConfinementError).property).toBe('selection-names-a-given-candidate');
  });
});
