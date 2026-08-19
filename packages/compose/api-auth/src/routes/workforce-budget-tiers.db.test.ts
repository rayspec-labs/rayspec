/**
 * `GET /v1/workforce/:workforceId/status` — the budget summary must not read greener than the
 * workforce actually is.
 *
 * THE DEFECT THIS SUITE EXISTS FOR (finding L2-1, second live acceptance run). The status view
 * reported budget headroom for the WORKFORCE TIER ONLY. The engine meters four scopes
 * (`ledgerScopesFor`, @rayspec/tasks budget.ts) — task, root, department, workforce — and a
 * workforce completely stalled on an exhausted DEPARTMENT ceiling read as 99.86 % open, because
 * the route asked one ceiling and one ledger row. The fact was legible in `workforce events`; the
 * summary an operator actually looks at was not. Both halves of the fix are asserted here:
 *
 *   1. `budgetTiers` — every ENFORCING tier this route can BOUND (workforce + each DECLARED
 *      department ceiling), each with its own consumed/headroom/exhausted. The control arm is a
 *      workforce with no department ceiling: it must emit NO department row, so the assertion
 *      cannot pass by an emitter that lists every department unconditionally.
 *      It sits BESIDE `budget`, not inside it, because `budget` is null whenever no whole-workforce
 *      usd ceiling is declared — nesting the enumeration there would hide an exhausted department
 *      on a document declaring department ceilings only, which is this exact defect one level down.
 *   2. `blockedOnBudget` — the CONSEQUENCE signal: tasks parked `blocked(budget_exhausted)` right
 *      now, whichever tier denied them. It exists because tier enumeration structurally cannot
 *      cover the `task` and `root` scopes (one ledger row per task / per submitted goal — this
 *      route may not materialize the tenant's task partition to summarize itself). Its control arm
 *      is a task blocked for a NON-budget reason, which must not inflate the count.
 *
 * Neither half is redundant. Enumeration alone leaves a workforce stalled on an exhausted
 * `subtree` ceiling reading green. The consequence signal alone reads a clean zero for a
 * department whose ceiling is fully spent with an empty queue — a denial fires only at the NEXT
 * dispatch — while the next submitted goal is already doomed.
 *
 * FINDING L2-3, pinned in the same file because it is the same operator lie from the other side.
 * `settled_usd` CAN exceed the ceiling, by one turn's actual, BY DESIGN: the denial fires when the
 * next dispatch would exceed, so the turn already in flight settles above the line and is never
 * aborted (budget.ts, `settleTurn`). *A ceiling bounds what may be DISPATCHED, not what may be
 * SETTLED.* The over-settlement is reproduced deterministically below (2 admitted turns settle
 * $0.0012234 against a $0.0012 department ceiling — the exact live figure), and the status view is
 * asserted to let an operator SEE it: `consumedUsd` is emitted UNCLAMPED beside `ceilingUsd`.
 * `headroomUsd` stays clamped at zero and so cannot carry the overrun on its own.
 *
 * AND THE OTHER SIDE OF THE SAME COIN — a ceiling also stops admitting BEFORE it is spent. The
 * engine admits at `consumed + estimate <= ceiling`, so the last `estimateUsdPerTurn` of every usd
 * ceiling is unspendable, and a scope sits in that band showing unspent ceiling while refusing
 * everything. `headroomUsd` is therefore UNSPENT CEILING, **not** "what may still be dispatched" —
 * an earlier revision of this very file said the latter, which was false. `exhausted` mirrors the
 * engine's admission rule and is the field that answers dispatchability; `estimateUsdPerTurn` is on
 * the response so the gap is computable. That band is the ORDINARY end state, because the estimate
 * is an upper bound on average turn cost, and it is asserted below against the real engine.
 *
 * The engine is NOT driven through a stub here: `authorizeTurn`/`settleTurn` run against the real
 * ledger, and the denial that ends the sequence is asserted with its typed scope before the route
 * is ever called. A fixture that never actually exhausts anything would make every assertion below
 * vacuous.
 */
import { forTenant } from '@rayspec/db';
import {
  applyTransition,
  authorizeTurn,
  createRootTask,
  ensureWorkforceRuntime,
  settleTurn,
  type WorkforceBudgets,
  workforceBudgetsSchema,
} from '@rayspec/tasks';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness, jsonRequest } from '../test-support/harness.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
// Un-skippable ran-guard: this suite is the proof for an operator-facing truthfulness finding. A
// self-skip without DATABASE_URL would be a false green on exactly the claim that matters.
if (requireDb && !hasDb) {
  throw new Error(
    'workforce-budget-tiers.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but ' +
      'absent — refusing to silently skip the budget-reporting truth suite.',
  );
}

let h: Harness;

/**
 * The numbers are the live acceptance run's, not invented: a `$0.0012` department ceiling, turns
 * that actually cost `$0.0006117`, and a `$0.0005` per-turn reservation estimate. That triple is
 * chosen so the sequence below is FORCED:
 *
 *   turn 1  0.0000000 + 0.0005 = 0.0005000 <= 0.0012  ADMIT   -> settled 0.0006117
 *   turn 2  0.0006117 + 0.0005 = 0.0011117 <= 0.0012  ADMIT   -> settled 0.0012234  (OVER the line)
 *   turn 3  0.0012234 + 0.0005 = 0.0017234  > 0.0012  DENY    (scopeKind 'department')
 *
 * The whole-workforce ceiling is $2, so after all of it the workforce tier is 99.94 % open — which
 * is precisely the reading the old status view returned while every engineering task was dead.
 */
const DEPARTMENT_CEILING_USD = 0.0012;
const WORKFORCE_CEILING_USD = 2;
const ESTIMATE_USD = 0.0005;
const ACTUAL_USD = 0.0006117;

/**
 * `ops` is the CEILING-LESS DEPARTMENT and it is not decoration. A department declaring only
 * `execution:` (no `budgets:`) lands on the runtime row as `{ maxConcurrentWorkers }` with no
 * `usd` and no `turns` — see `deriveWorkforceBudgets` in @rayspec/spec, which contributes an
 * entry for EITHER authored block. Such a department enforces no money ceiling and can never
 * exhaust, so it must not appear among the tiers. Without it in this fixture the "declared
 * ceiling only" filter is never executed at all, and a mutant that drops the filter survives —
 * which is exactly what happened on the first mutation run (M2), before `ops` existed.
 */
const RAW_BUDGETS = {
  workforce: { usd: WORKFORCE_CEILING_USD, window: 'daily' },
  departments: {
    eng: { usd: DEPARTMENT_CEILING_USD, window: 'daily' },
    ops: { maxConcurrentWorkers: 2 },
  },
  execution: { estimateUsdPerTurn: ESTIMATE_USD },
} as const;

/** The SAME declaration minus the department ceiling — the control the emitter must not pad. */
const RAW_BUDGETS_NO_DEPARTMENT_CEILING = {
  workforce: { usd: WORKFORCE_CEILING_USD, window: 'daily' },
  departments: { ops: { maxConcurrentWorkers: 2 } },
  execution: { estimateUsdPerTurn: ESTIMATE_USD },
} as const;

const BUDGETS: WorkforceBudgets = workforceBudgetsSchema.parse(RAW_BUDGETS);

interface StatusBudgetTier {
  scopeKind: string;
  scopeId: string;
  window: string | null;
  windowStart: string;
  ceilingUsd: number | null;
  consumedUsd: number;
  headroomUsd: number | null;
  ceilingTurns: number | null;
  consumedTurns: number;
  exhausted: boolean;
}

interface StatusBody {
  workforceId: string;
  paused: boolean;
  tasks: Record<string, number>;
  queueDepth: number;
  budgetExhausted: boolean;
  blockedOnBudget: number;
  estimateUsdPerTurn: number;
  budget: { ceilingUsd: number; consumedUsd: number; headroomUsd: number } | null;
  budgetTiers: StatusBudgetTier[];
}

/** Register a principal, create an org, switch into it — the org creator is an owner. */
async function principal(email: string, orgName: string) {
  const reg = await jsonRequest(h.app, 'POST', '/v1/auth/register', {
    body: { email, password: 'a-long-enough-password' },
  });
  const t0 = (await reg.json()).accessToken as string;
  const orgRes = await jsonRequest(h.app, 'POST', '/v1/orgs', {
    body: { name: orgName },
    headers: { authorization: `Bearer ${t0}` },
  });
  const orgId = (await orgRes.json()).id as string;
  const switchRes = await jsonRequest(h.app, 'POST', `/v1/orgs/${orgId}/switch`, {
    headers: { authorization: `Bearer ${t0}` },
  });
  return { orgId, token: (await switchRes.json()).accessToken as string };
}

async function readStatus(token: string, workforceId = 'wf'): Promise<StatusBody> {
  const res = await jsonRequest(h.app, 'GET', `/v1/workforce/${workforceId}/status`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as StatusBody;
}

/**
 * Spend the `eng` department ceiling down through the REAL ledger and return the typed denial.
 * Nothing here is stubbed: two turns are authorized and settled, and the third is refused by
 * `authorizeTurn` itself.
 */
async function exhaustEngDepartment(orgId: string) {
  const tdb = forTenant(h.db, orgId);
  await ensureWorkforceRuntime(tdb, 'wf', RAW_BUDGETS);
  const task = await createRootTask(tdb, {
    workforceId: 'wf',
    title: 'Engineering work',
    goal: 'Ship the release.',
    owner: 'principal_eng',
    requestedBy: 'user',
    department: 'eng',
  });
  const proposed = {
    taskId: task.taskId,
    rootTaskId: task.taskId,
    workforceId: 'wf',
    department: 'eng',
    estimateUsd: ESTIMATE_USD,
  };
  for (let turn = 1; turn <= 2; turn++) {
    const decision = await authorizeTurn(tdb, BUDGETS, proposed);
    expect(decision.allowed, `turn ${turn} must be ADMITTED for the fixture to mean anything`).toBe(
      true,
    );
    await tdb.transaction((tx) => settleTurn(tx, BUDGETS, { ...proposed, actualUsd: ACTUAL_USD }));
  }
  const denied = await authorizeTurn(tdb, BUDGETS, proposed);
  return { tdb, task, denied };
}

describe.skipIf(!hasDb)('/v1/workforce status — budget reporting truth', () => {
  beforeAll(async () => {
    h = await createHarness({
      workforce: { kick: () => {} },
      schema: 'rayspec_test_wf_budget_tiers',
    });
  });
  afterEach(async () => {
    await h.reset();
  });
  afterAll(async () => {
    await h.close();
  });

  it('the fixture really exhausts the DEPARTMENT ceiling — the denial is typed and its scope is the department', async () => {
    const a = await principal('wf-bt-denial@example.test', 'Org WF BT Denial');
    const { denied } = await exhaustEngDepartment(a.orgId);
    expect(denied.allowed).toBe(false);
    if (denied.allowed) throw new Error('unreachable — asserted above');
    expect(denied.denial).toMatchObject({
      scopeKind: 'department',
      scopeId: 'eng',
      ceiling: { kind: 'usd', limit: DEPARTMENT_CEILING_USD },
    });
    // The workforce tier is NOT what refused — that is the whole point of the finding.
    expect(denied.denial.consumed).toBeGreaterThan(DEPARTMENT_CEILING_USD);
  });

  it('L2-3: settled EXCEEDS the ceiling by one turn — a ceiling bounds DISPATCH, not settlement', async () => {
    const a = await principal('wf-bt-oversettle@example.test', 'Org WF BT Oversettle');
    await exhaustEngDepartment(a.orgId);
    const rows = (await h.db.$client.unsafe(
      `SELECT settled_usd, settled_turns FROM workforce_budget_ledger
        WHERE scope_kind = 'department' AND scope_id = 'eng';`,
    )) as unknown as Array<{ settled_usd: string; settled_turns: number }>;
    expect(rows).toHaveLength(1);
    const settled = Number((rows[0] as { settled_usd: string }).settled_usd);
    // The exact live figure: two turns at $0.0006117 against a $0.0012 ceiling.
    expect(settled).toBeCloseTo(2 * ACTUAL_USD, 10);
    expect(
      settled,
      'over-settlement by one turn is BY DESIGN — a turn that already fired is never aborted. ' +
        'If this ever reads <= the ceiling, the docs that say so must change too, not this line.',
    ).toBeGreaterThan(DEPARTMENT_CEILING_USD);
  });

  it('status reports EVERY enforcing tier it can bound — the exhausted department is present and marked', async () => {
    const a = await principal('wf-bt-tiers@example.test', 'Org WF BT Tiers');
    await exhaustEngDepartment(a.orgId);
    const body = await readStatus(a.token);

    // The workforce tier still reads wide open — TRUE, and exactly why it must not be the whole
    // answer. Asserted rather than hidden: this is the number that lied.
    expect(body.budget?.ceilingUsd).toBe(WORKFORCE_CEILING_USD);
    expect(body.budget?.headroomUsd ?? 0).toBeGreaterThan(WORKFORCE_CEILING_USD * 0.99);

    const tiers = body.budgetTiers;
    const dept = tiers.find((t) => t.scopeKind === 'department' && t.scopeId === 'eng');
    expect(
      dept,
      'the summary omits the tier that actually stopped the work — an operator reads a green ' +
        'workforce headroom while every engineering task is dead',
    ).toBeDefined();
    const engTier = dept as StatusBudgetTier;
    expect(engTier.ceilingUsd).toBe(DEPARTMENT_CEILING_USD);
    expect(engTier.exhausted).toBe(true);
    expect(engTier.window).toBe('daily');
    expect(engTier.consumedTurns).toBe(2);
    // UNCLAMPED — this is the field that carries the L2-3 overrun onto the operator surface.
    expect(engTier.consumedUsd).toBeGreaterThan(DEPARTMENT_CEILING_USD);
    // …while headroom stays clamped, which is right for "what may still be dispatched" and is
    // precisely why it cannot express the overrun on its own.
    expect(engTier.headroomUsd).toBe(0);

    const wf = tiers.find((t) => t.scopeKind === 'workforce');
    expect(wf, 'the workforce tier must appear in the enumeration too').toBeDefined();
    expect((wf as StatusBudgetTier).exhausted).toBe(false);
    expect((wf as StatusBudgetTier).scopeId).toBe('wf');

    // EXACTLY these two, in this order. `ops` declares `maxConcurrentWorkers` and no money
    // ceiling: it enforces no spend, can never exhaust, and a row for it would be a permanent
    // `exhausted: false` with a null ceiling — noise in the one summary that must stay readable.
    expect(tiers.map((t) => `${t.scopeKind}/${t.scopeId}`)).toEqual([
      'workforce/wf',
      'department/eng',
    ]);
  });

  it('CONTROL: a workforce declaring NO department ceiling emits NO department tier', async () => {
    const a = await principal('wf-bt-control@example.test', 'Org WF BT Control');
    const tdb = forTenant(h.db, a.orgId);
    await ensureWorkforceRuntime(tdb, 'wf', RAW_BUDGETS_NO_DEPARTMENT_CEILING);
    const noCeiling = workforceBudgetsSchema.parse(RAW_BUDGETS_NO_DEPARTMENT_CEILING);
    const task = await createRootTask(tdb, {
      workforceId: 'wf',
      title: 'Engineering work',
      goal: 'Ship the release.',
      owner: 'principal_eng',
      requestedBy: 'user',
      department: 'eng',
    });
    const proposed = {
      taskId: task.taskId,
      rootTaskId: task.taskId,
      workforceId: 'wf',
      department: 'eng',
      estimateUsd: ESTIMATE_USD,
    };
    // The department SPENDS — it just declares no ceiling. A ledger row exists (spend visibility is
    // not conditional on enforcement), so an emitter that walked LEDGER ROWS instead of DECLARED
    // ceilings would happily invent a headroom-less row here.
    const decision = await authorizeTurn(tdb, noCeiling, proposed);
    expect(decision.allowed).toBe(true);
    await tdb.transaction((tx) =>
      settleTurn(tx, noCeiling, { ...proposed, actualUsd: ACTUAL_USD }),
    );

    const body = await readStatus(a.token);
    const tiers = body.budgetTiers;
    expect(tiers.map((t) => t.scopeKind)).toEqual(['workforce']);
    expect(tiers.some((t) => t.scopeKind === 'department')).toBe(false);
  });

  /**
   * THE BOUNDARY, on both axes. A scope consumed to EXACTLY its ceiling admits nothing further —
   * `authorizeTurn` denies at `consumed + estimate > ceiling` and at `settledTurns + 1 > turns` —
   * so it is exhausted AT the line, not one turn past it. The arms above all over-settle, where
   * `>` and `>=` agree; without this test a `>` reports `exhausted: false` for a scope that is
   * dead, which is finding L2-1 rebuilt inside its own fix. The TURNS axis is not an afterthought:
   * turns are counted one integer at a time, so landing exactly on a turns ceiling is the ORDINARY
   * case, not the corner one. Each tier's verdict is cross-checked against a real `authorizeTurn`
   * denial in the same test, so `exhausted` is a fact about the engine and not a label.
   */
  it('a tier consumed to EXACTLY its ceiling reads exhausted — usd and turns alike', async () => {
    const a = await principal('wf-bt-boundary@example.test', 'Org WF BT Boundary');
    const tdb = forTenant(h.db, a.orgId);
    const raw = {
      workforce: { usd: 5, window: 'daily' },
      departments: {
        edgeturns: { turns: 1, window: 'daily' },
        edgeusd: { usd: 0.001, window: 'daily' },
      },
      execution: { estimateUsdPerTurn: 0.0005 },
    } as const;
    const budgets = workforceBudgetsSchema.parse(raw);
    await ensureWorkforceRuntime(tdb, 'wf', raw);

    for (const [department, actualUsd] of [
      ['edgeusd', 0.001],
      ['edgeturns', 0.0001],
    ] as const) {
      const task = await createRootTask(tdb, {
        workforceId: 'wf',
        title: `Work for ${department}`,
        goal: 'Land exactly on the line.',
        owner: 'principal_eng',
        requestedBy: 'user',
        department,
      });
      const proposed = {
        taskId: task.taskId,
        rootTaskId: task.taskId,
        workforceId: 'wf',
        department,
        estimateUsd: 0.0005,
      };
      expect((await authorizeTurn(tdb, budgets, proposed)).allowed).toBe(true);
      await tdb.transaction((tx) => settleTurn(tx, budgets, { ...proposed, actualUsd }));
      // The engine's own verdict on the same scope: nothing further may be dispatched.
      const next = await authorizeTurn(tdb, budgets, proposed);
      expect(next.allowed, `${department} must admit nothing once it sits ON its ceiling`).toBe(
        false,
      );
    }

    const tiers = await readStatus(a.token).then((b) => b.budgetTiers);
    const usdEdge = tiers.find((t) => t.scopeId === 'edgeusd') as StatusBudgetTier;
    const turnsEdge = tiers.find((t) => t.scopeId === 'edgeturns') as StatusBudgetTier;
    expect(usdEdge.consumedUsd).toBe(0.001);
    expect(usdEdge.headroomUsd).toBe(0);
    expect(usdEdge.exhausted, 'consumed === ceiling admits nothing, so it IS exhausted').toBe(true);
    expect(turnsEdge.ceilingTurns).toBe(1);
    expect(turnsEdge.consumedTurns).toBe(1);
    expect(turnsEdge.ceilingUsd).toBeNull();
    expect(
      turnsEdge.exhausted,
      'a turns ceiling reached exactly is exhausted — and it has no usd ceiling at all, so the ' +
        'verdict cannot be coming from the money axis',
    ).toBe(true);
  });

  /**
   * THE HEADLINE, and the reason this suite exists at all. The L2-1 defect was never that the fact
   * was unavailable — `workforce events` carried the denying scope, its ceiling and its consumption
   * the whole time. It was that the SUMMARY said 99.86 % open. A fix that answers "is this
   * workforce stalled on money" only to a reader who iterates `budgetTiers` and compares two
   * numbers has reproduced the defect at a smaller radius. `budgetExhausted` is therefore a scalar
   * sitting beside `paused`, and these three arms pin BOTH halves of its disjunction as
   * load-bearing — each half is the only thing that answers one real scenario.
   */
  describe('budgetExhausted — the one field an operator must not have to look for', () => {
    it('is TRUE when a subordinate ceiling is spent, even with NOTHING parked yet', async () => {
      const a = await principal('wf-bt-headline-a@example.test', 'Org WF BT Headline A');
      await exhaustEngDepartment(a.orgId);
      const body = await readStatus(a.token);
      // The doomed-but-not-yet-dead case. No task has been denied a dispatch and parked, so the
      // consequence signal is CORRECTLY zero — and the workforce tier is 99.9 % open. The tier
      // half of the disjunction is the only thing that can answer here.
      expect(body.blockedOnBudget).toBe(0);
      expect(body.budget?.headroomUsd ?? 0).toBeGreaterThan(WORKFORCE_CEILING_USD * 0.99);
      expect(
        body.budgetExhausted,
        'a spent department ceiling with an empty queue reads healthy — the next goal submitted ' +
          'into eng is already refused and the summary says nothing',
      ).toBe(true);
    });

    it('is TRUE when a task is parked on budget by a tier the enumeration cannot reach', async () => {
      const a = await principal('wf-bt-headline-b@example.test', 'Org WF BT Headline B');
      const tdb = forTenant(h.db, a.orgId);
      // A TASK-tier ceiling: one ledger row per task, so `budgetTiers` never lists it — by design
      // (this route may not materialize the tenant's task partition). Nothing here declares a
      // department or workforce ceiling that can exhaust, so `budgetTiers` is all-clear and the
      // parked-task half of the disjunction is the only thing that can answer.
      const raw = {
        workforce: { usd: 100, window: 'daily' },
        task: { usd: 0.01, turns: 20 },
        execution: { estimateUsdPerTurn: 0.0005 },
      } as const;
      await ensureWorkforceRuntime(tdb, 'wf', raw);
      const task = await createRootTask(tdb, {
        workforceId: 'wf',
        title: 'Denied at its own task ceiling',
        goal: 'Ship the release.',
        owner: 'principal_eng',
        requestedBy: 'user',
      });
      const queued = await applyTransition(tdb, {
        taskId: task.taskId,
        expectedVersion: task.version,
        to: 'queued',
        actor: 'scheduler',
      });
      await applyTransition(tdb, {
        taskId: task.taskId,
        expectedVersion: queued.version,
        to: 'blocked',
        reason: 'budget_exhausted',
        actor: 'scheduler',
      });
      const body = await readStatus(a.token);
      expect(
        body.budgetTiers.some((t) => t.exhausted),
        'no ENUMERATED tier is exhausted here — that is the point of this arm',
      ).toBe(false);
      expect(body.blockedOnBudget).toBe(1);
      expect(
        body.budgetExhausted,
        'work is parked on money and the headline calls the workforce healthy',
      ).toBe(true);
    });

    it('CONTROL: is FALSE on a workforce whose declared ceilings are all untouched', async () => {
      const a = await principal('wf-bt-headline-c@example.test', 'Org WF BT Headline C');
      const tdb = forTenant(h.db, a.orgId);
      await ensureWorkforceRuntime(tdb, 'wf', RAW_BUDGETS);
      const task = await createRootTask(tdb, {
        workforceId: 'wf',
        title: 'Perfectly ordinary work',
        goal: 'Ship the release.',
        owner: 'principal_eng',
        requestedBy: 'user',
        department: 'eng',
      });
      await applyTransition(tdb, {
        taskId: task.taskId,
        expectedVersion: task.version,
        to: 'queued',
        actor: 'scheduler',
      });
      const body = await readStatus(a.token);
      // Real declared ceilings ARE present and enumerated — the flag is false because nothing is
      // spent, not because there is nothing to be spent.
      expect(body.budgetTiers.length).toBe(2);
      expect(
        body.budgetExhausted,
        'a constant-true flag is worse than no flag: it trains an operator to ignore it',
      ).toBe(false);
    });
  });

  /**
   * THE RESERVATION BAND — a scope that refuses every dispatch while its ceiling is NOT yet spent.
   *
   * The engine admits at `consumed + estimate <= ceiling` (`authorizeTurn`), so a scope stops
   * admitting once `consumed > ceiling - estimate`. Between that point and the ceiling itself there
   * is a band, one estimate wide, in which the ledger still shows unspent ceiling and the engine
   * refuses everything.
   *
   * THIS IS THE ORDINARY CASE, NOT A CORNER. The estimate is derived as `task.usd / task.turns` —
   * an UPPER bound on average turn cost — so real consumption normally halts SHORT of the ceiling
   * and lands in this band. The earlier arms all over-settled PAST the ceiling, which is the
   * overshoot regime the live-acceptance run happened to produce, and that is precisely why no arm
   * saw this: every fixture agreed with every other one.
   *
   * A `consumed >= ceiling` predicate reports `exhausted: false` here — a workforce refusing every
   * dispatch, reading open. That is finding L2-1 for the third time, inside its own fix.
   *
   * Numbers are the reviewer's, reproduced exactly: ceiling $1, estimate $0.05 (a document's
   * `task: { usd: 5, turns: 100 }`), turns costing $0.06, 16 admitted, the 17th refused, ledger at
   * $0.96 with $0.04 of ceiling unspent — and $0.04 buys nothing, because a turn reserves $0.05.
   */
  it('a scope inside the RESERVATION BAND reads exhausted — unspent ceiling is not dispatchable headroom', async () => {
    const a = await principal('wf-bt-band@example.test', 'Org WF BT Band');
    const tdb = forTenant(h.db, a.orgId);
    const raw = {
      workforce: { usd: 10, window: 'daily' },
      departments: { eng: { usd: 1, window: 'daily' } },
      task: { usd: 5, turns: 100 },
      execution: { estimateUsdPerTurn: 0.05 },
    } as const;
    const budgets = workforceBudgetsSchema.parse(raw);
    await ensureWorkforceRuntime(tdb, 'wf', raw);
    const task = await createRootTask(tdb, {
      workforceId: 'wf',
      title: 'Ordinary engineering work',
      goal: 'Ship the release.',
      owner: 'principal_eng',
      requestedBy: 'user',
      department: 'eng',
    });
    const proposed = {
      taskId: task.taskId,
      rootTaskId: task.taskId,
      workforceId: 'wf',
      department: 'eng',
      estimateUsd: 0.05,
    };
    let admitted = 0;
    for (let turn = 1; turn <= 40; turn++) {
      const decision = await authorizeTurn(tdb, budgets, proposed);
      if (!decision.allowed) {
        // The engine itself says the department admits nothing further.
        expect(decision.denial.scopeKind).toBe('department');
        expect(decision.denial.scopeId).toBe('eng');
        break;
      }
      admitted += 1;
      await tdb.transaction((tx) => settleTurn(tx, budgets, { ...proposed, actualUsd: 0.06 }));
    }
    expect(admitted, 'the reviewer observed 16 admitted turns on these numbers').toBe(16);

    const body = await readStatus(a.token);
    const eng = body.budgetTiers.find((t) => t.scopeId === 'eng') as StatusBudgetTier;

    // THE BAND, asserted as facts before the verdict — so a later reader can see that the ceiling
    // really is unspent and the engine really has stopped.
    expect(eng.ceilingUsd).toBe(1);
    expect(eng.consumedUsd).toBeCloseTo(0.96, 10);
    expect(eng.headroomUsd, 'ceiling is NOT spent — 4 cents of it are unconsumed').toBeCloseTo(
      0.04,
      10,
    );
    // THE VERDICT FIRST — this is the defect, and it must be the assertion that goes red.
    expect(
      eng.exhausted,
      'the department refuses every dispatch and the summary calls it healthy — L2-1 rebuilt ' +
        'inside its own fix, on the ordinary (under-shoot) path rather than the over-settled one',
    ).toBe(true);
    expect(
      body.budgetExhausted,
      'nothing is parked yet (no dispatch has been attempted through the scheduler), so the tier ' +
        'half of the disjunction is the ONLY thing that can answer here',
    ).toBe(true);
    expect(body.blockedOnBudget).toBe(0);

    // …and the QUANTITY, so a client can tell unspent ceiling from dispatchable headroom itself
    // rather than reconstructing the engine's admission rule from the docs.
    expect(body.estimateUsdPerTurn).toBe(0.05);
    expect(
      eng.headroomUsd ?? 0,
      'those 4 cents buy nothing: a turn reserves 5. Unspent ceiling is not dispatchable headroom, ' +
        'and the response must let a client see the difference.',
    ).toBeLessThan(body.estimateUsdPerTurn);
  });

  /**
   * THE OTHER EDGE OF THE BAND — a scope with EXACTLY one turn left is NOT exhausted.
   *
   * The failure mode opposite to the band: crying wolf. The engine admits at
   * `consumed + estimate <= ceiling`, so a scope whose unspent ceiling is exactly one estimate
   * still admits one more turn. A predicate using `>=` instead of `>` would call it dead a turn
   * early — an operator raising a ceiling that did not need raising, and a `budgetExhausted` that
   * fires on a healthy workforce.
   *
   * The engine is asked to agree, in the same test and AFTER the status read, so the verdict is
   * checked against the real admission rule rather than against my arithmetic.
   */
  it('a scope with EXACTLY one turn of ceiling left is NOT exhausted — the band has two edges', async () => {
    const a = await principal('wf-bt-lastturn@example.test', 'Org WF BT LastTurn');
    const tdb = forTenant(h.db, a.orgId);
    const raw = {
      departments: { eng: { usd: 0.001, window: 'daily' } },
      task: { usd: 5, turns: 100 },
      execution: { estimateUsdPerTurn: 0.0005 },
    } as const;
    const budgets = workforceBudgetsSchema.parse(raw);
    await ensureWorkforceRuntime(tdb, 'wf', raw);
    const task = await createRootTask(tdb, {
      workforceId: 'wf',
      title: 'One turn left',
      goal: 'Ship the release.',
      owner: 'principal_eng',
      requestedBy: 'user',
      department: 'eng',
    });
    const proposed = {
      taskId: task.taskId,
      rootTaskId: task.taskId,
      workforceId: 'wf',
      department: 'eng',
      estimateUsd: 0.0005,
    };
    expect((await authorizeTurn(tdb, budgets, proposed)).allowed).toBe(true);
    await tdb.transaction((tx) => settleTurn(tx, budgets, { ...proposed, actualUsd: 0.0005 }));

    const body = await readStatus(a.token);
    const eng = body.budgetTiers.find((t) => t.scopeId === 'eng') as StatusBudgetTier;
    expect(eng.consumedUsd).toBeCloseTo(0.0005, 10);
    expect(eng.headroomUsd, 'unspent ceiling is exactly one turn').toBeCloseTo(0.0005, 10);
    expect(
      eng.exhausted,
      'a scope that can still run one turn is not exhausted — calling it dead a turn early sends ' +
        'an operator to raise a ceiling that is fine, and fires budgetExhausted on a healthy run',
    ).toBe(false);
    expect(body.budgetExhausted).toBe(false);

    // THE ENGINE AGREES, asked after the fact so the flag is checked against the real rule.
    expect(
      (await authorizeTurn(tdb, budgets, proposed)).allowed,
      'the engine admits exactly here — `consumed + estimate <= ceiling` holds with equality',
    ).toBe(true);
  });

  /**
   * A DEPARTMENTS-ONLY document — the case top-level `budgetTiers` exists for.
   *
   * `budget` is null exactly when no whole-workforce usd ceiling is declared, which is why the
   * enumeration is a SIBLING of it rather than nested inside. Until this arm existed that reasoning
   * was untested: every fixture declared `workforce: { usd: … }`, so a `budgetTiers` gated on the
   * workforce ceiling would have passed all ten tests while hiding an exhausted department on
   * exactly the documents the placement was chosen for. The fixtures agreed with each other, so the
   * case the design exists for went unexercised.
   */
  it('a DEPARTMENTS-ONLY document still enumerates its tiers, with budget null', async () => {
    const a = await principal('wf-bt-deptonly@example.test', 'Org WF BT DeptOnly');
    const tdb = forTenant(h.db, a.orgId);
    const raw = {
      departments: { eng: { usd: 0.0012, window: 'daily' } },
      task: { usd: 5, turns: 100 },
      execution: { estimateUsdPerTurn: ESTIMATE_USD },
    } as const;
    const budgets = workforceBudgetsSchema.parse(raw);
    await ensureWorkforceRuntime(tdb, 'wf', raw);
    const task = await createRootTask(tdb, {
      workforceId: 'wf',
      title: 'Engineering work',
      goal: 'Ship the release.',
      owner: 'principal_eng',
      requestedBy: 'user',
      department: 'eng',
    });
    const proposed = {
      taskId: task.taskId,
      rootTaskId: task.taskId,
      workforceId: 'wf',
      department: 'eng',
      estimateUsd: ESTIMATE_USD,
    };
    for (let turn = 1; turn <= 2; turn++) {
      expect((await authorizeTurn(tdb, budgets, proposed)).allowed).toBe(true);
      await tdb.transaction((tx) =>
        settleTurn(tx, budgets, { ...proposed, actualUsd: ACTUAL_USD }),
      );
    }
    expect((await authorizeTurn(tdb, budgets, proposed)).allowed).toBe(false);

    const body = await readStatus(a.token);
    // The legacy block is null — there is no whole-workforce usd ceiling to report.
    expect(body.budget).toBeNull();
    // …and the enumeration still answers, which is the whole reason it is not nested in it.
    expect(body.budgetTiers.map((t) => `${t.scopeKind}/${t.scopeId}`)).toEqual(['department/eng']);
    expect((body.budgetTiers[0] as StatusBudgetTier).exhausted).toBe(true);
    expect(
      body.budgetExhausted,
      'a departments-only document is where nesting the enumeration inside `budget` would have ' +
        'hidden the exhaustion completely',
    ).toBe(true);
  });

  it('status carries blockedOnBudget — the parks a tier enumeration can never see', async () => {
    const a = await principal('wf-bt-blocked@example.test', 'Org WF BT Blocked');
    const tdb = forTenant(h.db, a.orgId);
    await ensureWorkforceRuntime(tdb, 'wf', RAW_BUDGETS);

    // Two tasks parked on budget…
    for (const title of ['Denied A', 'Denied B']) {
      const task = await createRootTask(tdb, {
        workforceId: 'wf',
        title,
        goal: 'Ship the release.',
        owner: 'principal_eng',
        requestedBy: 'user',
        department: 'eng',
      });
      const queued = await applyTransition(tdb, {
        taskId: task.taskId,
        expectedVersion: task.version,
        to: 'queued',
        actor: 'scheduler',
      });
      await applyTransition(tdb, {
        taskId: task.taskId,
        expectedVersion: queued.version,
        to: 'blocked',
        reason: 'budget_exhausted',
        actor: 'scheduler',
      });
    }
    // …and one parked for a reason that has nothing to do with money. THE CONTROL: a count that is
    // really `blocked` would read 3 here and tell an operator to raise a ceiling that is fine.
    const other = await createRootTask(tdb, {
      workforceId: 'wf',
      title: 'Waiting on children',
      goal: 'Ship the release.',
      owner: 'lead',
      requestedBy: 'user',
    });
    const otherQueued = await applyTransition(tdb, {
      taskId: other.taskId,
      expectedVersion: other.version,
      to: 'queued',
      actor: 'scheduler',
    });
    await applyTransition(tdb, {
      taskId: other.taskId,
      expectedVersion: otherQueued.version,
      to: 'blocked',
      reason: 'awaiting_children',
      actor: 'scheduler',
    });

    const body = await readStatus(a.token);
    expect(body.tasks.blocked, 'three tasks are blocked in total').toBe(3);
    expect(
      body.blockedOnBudget,
      'the exhaustion signal must count budget parks ONLY — a review or join park is not a ' +
        'reason to raise a ceiling',
    ).toBe(2);
  });

  it('blockedOnBudget is 0 on a workforce whose work is merely queued', async () => {
    const a = await principal('wf-bt-zero@example.test', 'Org WF BT Zero');
    const tdb = forTenant(h.db, a.orgId);
    await ensureWorkforceRuntime(tdb, 'wf', RAW_BUDGETS);
    const task = await createRootTask(tdb, {
      workforceId: 'wf',
      title: 'Nothing wrong here',
      goal: 'Ship the release.',
      owner: 'principal_eng',
      requestedBy: 'user',
      department: 'eng',
    });
    await applyTransition(tdb, {
      taskId: task.taskId,
      expectedVersion: task.version,
      to: 'queued',
      actor: 'scheduler',
    });
    const body = await readStatus(a.token);
    expect(body.blockedOnBudget).toBe(0);
    expect(body.queueDepth).toBe(1);
    // The declared department ceiling is still enumerated, unexhausted — a ceiling that has not
    // bitten yet is exactly what an operator wants to see BEFORE it does.
    const tiers = body.budgetTiers;
    const engTier = tiers.find((t) => t.scopeId === 'eng');
    expect(engTier).toBeDefined();
    expect((engTier as StatusBudgetTier).exhausted).toBe(false);
    expect((engTier as StatusBudgetTier).consumedUsd).toBe(0);
  });
});
