/**
 * The goal intake against real Postgres — `OrchestrationStrategy`'s production call site driven
 * end to end: submitted goal → plan → durable `planned` rows, with every refusal proven to leave
 * ZERO rows and every reconciliation proven to precede the strategy call.
 */

import type { ExecutionPlan, OrchestrationInput, OrchestrationStrategy } from '@rayspec/core';
import {
  SEAM_MAX_PLAN_STEPS,
  SEAM_MAX_STEP_DEPENDENCIES,
  SEAM_MAX_STEP_TITLE_CHARS,
} from '@rayspec/core';
import type { Db } from '@rayspec/db';
import { deriveWorkforceConfig, WorkforceSpec } from '@rayspec/spec';
import {
  ensureWorkforceRuntime,
  haltWorkforce,
  MAX_TASK_DEPENDENCIES,
  MAX_TASK_TITLE_CHARS,
  pauseWorkforce,
  resumeWorkforce,
  WorkforcePausedError,
} from '@rayspec/tasks';
import { forTenant, makeTestDb, resetTaskSchema } from '@rayspec/tasks/test-support';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildWorkforceGoalIntake } from './workforce-goal-intake.js';

/**
 * The seam contract kit tells an out-of-tree strategy author what title length is acceptable; the
 * task row is what actually refuses one. The two constants live in packages that cannot import each
 * other, so this pin is what keeps the kit from blessing a plan the engine would then reject. It is
 * here rather than in @rayspec/core because this is the only package that can see both.
 */
describe('the seam kit and the engine agree on the row bounds', () => {
  it('the contract kit’s step-title ceiling IS the engine’s task-title row bound', () => {
    expect(SEAM_MAX_STEP_TITLE_CHARS).toBe(MAX_TASK_TITLE_CHARS);
  });

  it('the contract kit’s dependency ceiling IS the engine’s task-dependency row bound', () => {
    expect(SEAM_MAX_STEP_DEPENDENCIES).toBe(MAX_TASK_DEPENDENCIES);
  });
});

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (requireDb && !hasDb) {
  throw new Error(
    'workforce-goal-intake.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — refusing to silently skip.',
  );
}

const TENANT = '00000000-0000-4000-8000-0000000000d1';

const DECLARED = WorkforceSpec.parse({
  id: 'intake_wf',
  name: 'Intake Workforce',
  orchestrator: 'lead',
  departments: [
    { id: 'eng', name: 'Engineering', manager: 'mgr', mission: 'Own it.', members: ['dev'] },
  ],
  employees: [
    { id: 'lead', agent: 'a', title: 'Lead', role: 'orchestrator' },
    { id: 'mgr', agent: 'a', title: 'M', department: 'eng', reportsTo: 'lead', role: 'manager' },
    { id: 'dev', agent: 'a', title: 'D', department: 'eng', role: 'worker' },
  ],
});
const config = deriveWorkforceConfig(DECLARED);

/** A strategy that records its input and answers a canned plan — the seam under observation. */
function scripted(plan: ExecutionPlan): {
  strategy: OrchestrationStrategy;
  inputs: OrchestrationInput[];
} {
  const inputs: OrchestrationInput[] = [];
  return {
    inputs,
    strategy: {
      id: 'scripted',
      plan: (input) => {
        inputs.push(input);
        return Promise.resolve(plan);
      },
    },
  };
}

describe.skipIf(!hasDb)('the goal intake (db)', () => {
  let db: ReturnType<typeof makeTestDb>;

  beforeAll(async () => {
    db = makeTestDb();
    await resetTaskSchema(db);
    return async () => {
      await db.$client.end();
    };
  });

  beforeEach(async () => {
    await db.$client.unsafe(
      `TRUNCATE workforce_tasks, workforce_task_transitions, workforce_task_signals,
       workforce_delegations, workforce_approvals, workforce_reviews, workforce_messages,
       workforce_budget_ledger, workforce_runtime, run_events CASCADE;
       INSERT INTO orgs (id, name) VALUES ('${TENANT}', 'Intake Org') ON CONFLICT DO NOTHING;`,
    );
  });

  async function taskRows(): Promise<
    Array<{ task_id: string; owner: string; title: string; goal: string; status: string }>
  > {
    return (await db.$client.unsafe(
      'SELECT task_id, owner, title, goal, status, department, dependencies, priority, description, workforce_id, requested_by FROM workforce_tasks ORDER BY created_at, task_id;',
    )) as never;
  }

  function intakeWith(strategy: OrchestrationStrategy) {
    return buildWorkforceGoalIntake({
      db: db as unknown as Db,
      tenantId: TENANT,
      config,
      strategy,
    });
  }

  it('the shipped default hands the whole goal to the declared orchestrator as ONE planned root, journaled', async () => {
    const { SingleTaskPlanStrategy } = await import('@rayspec/core');
    const intake = intakeWith(new SingleTaskPlanStrategy());
    const result = await intake.submitGoal({
      tenantId: TENANT,
      workforceId: 'intake_wf',
      goal: 'Analyze onboarding friction and draft the fix announcement.',
      requestedBy: 'api-key:k1',
      priority: 'high',
      description: 'Requester context for every step.',
    });
    expect(result.outcome).toBe('created');
    const rows = (await taskRows()) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      owner: 'lead',
      status: 'planned',
      goal: 'Analyze onboarding friction and draft the fix announcement.',
      title: 'Analyze onboarding friction and draft the fix announcement.',
      workforce_id: 'intake_wf',
      requested_by: 'api-key:k1',
      priority: 'high',
      description: 'Requester context for every step.',
      department: null,
    });
    const created = await db.$client.unsafe(
      `SELECT type FROM run_events WHERE run_id = '${(rows[0] as { task_id: string }).task_id}';`,
    );
    expect(created.map((r: { type: string }) => r.type)).toContain('workforce.task.created');
  });

  it('a multi-step plan lands atomically as sibling roots with dependsOn mapped onto dependencies and departments derived', async () => {
    const { strategy, inputs } = scripted({
      steps: [
        { title: 'Research', goal: 'Research it.', owner: 'dev', department: null, dependsOn: [] },
        { title: 'Draft', goal: 'Draft it.', owner: 'dev', department: 'eng', dependsOn: [0] },
        { title: 'Merge', goal: 'Merge both.', owner: 'lead', department: null, dependsOn: [0, 1] },
      ],
    });
    const result = await intakeWith(strategy).submitGoal({
      tenantId: TENANT,
      workforceId: 'intake_wf',
      goal: 'The umbrella goal.',
      requestedBy: 'user:u1',
    });
    expect(result.outcome).toBe('created');
    if (result.outcome !== 'created') throw new Error('unreachable');
    expect(result.tasks.map((t) => t.title)).toEqual(['Research', 'Draft', 'Merge']);

    // The strategy saw the verified facts, including the declared orchestrator as defaultOwner.
    expect(inputs).toEqual([
      {
        workforceId: 'intake_wf',
        goal: 'The umbrella goal.',
        requestedBy: 'user:u1',
        defaultOwner: 'lead',
      },
    ]);

    const rows = (await taskRows()) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(3);
    const byTitle = new Map(rows.map((r) => [r.title as string, r]));
    // A null step department resolves to the OWNER's declared department (ledger attribution).
    expect(byTitle.get('Research')).toMatchObject({ owner: 'dev', department: 'eng' });
    expect(byTitle.get('Draft')).toMatchObject({ owner: 'dev', department: 'eng' });
    expect(byTitle.get('Merge')).toMatchObject({ owner: 'lead', department: null });
    expect(byTitle.get('Draft')?.dependencies).toEqual([byTitle.get('Research')?.task_id]);
    expect(byTitle.get('Merge')?.dependencies).toEqual([
      byTitle.get('Research')?.task_id,
      byTitle.get('Draft')?.task_id,
    ]);
  });

  it('refuses an invalid plan typed, with ZERO rows: undeclared owner, foreign department, bad index', async () => {
    const cases: Array<{ plan: ExecutionPlan; detail: string }> = [
      {
        plan: {
          steps: [{ title: 'X', goal: 'x', owner: 'ghost', department: null, dependsOn: [] }],
        },
        detail: "owner 'ghost'",
      },
      {
        plan: {
          steps: [{ title: 'X', goal: 'x', owner: 'lead', department: 'eng', dependsOn: [] }],
        },
        detail: "books department 'eng'",
      },
      {
        plan: {
          steps: [
            { title: 'A', goal: 'a', owner: 'dev', department: null, dependsOn: [] },
            { title: 'B', goal: 'b', owner: 'dev', department: null, dependsOn: [1] },
          ],
        },
        detail: 'not a PRIOR step',
      },
      { plan: { steps: [] }, detail: 'no steps' },
    ];
    for (const { plan, detail } of cases) {
      const result = await intakeWith(scripted(plan).strategy).submitGoal({
        tenantId: TENANT,
        workforceId: 'intake_wf',
        goal: 'g',
        requestedBy: 'user:u1',
      });
      expect(result.outcome).toBe('invalid_plan');
      if (result.outcome !== 'invalid_plan') throw new Error('unreachable');
      expect(result.detail).toContain(detail);
      expect(result.detail).toContain("strategy 'scripted'");
    }
    expect(await taskRows()).toHaveLength(0); // every refusal preceded the first insert
  });

  /**
   * THE ADVERSARIAL MATRIX. The strategy is out-of-tree code, so every cell here is a plan a hostile
   * or merely broken implementation could return, enumerated so coverage is visible rather than
   * trusted. Each cell must be a typed refusal that leaves ZERO rows — the refusal runs before the
   * first insert and the whole plan is one transaction, so a half-born plan is not a possible
   * outcome to begin with.
   */
  it('refuses every over-reaching plan shape typed, with ZERO rows', async () => {
    const step = (over: Partial<ExecutionPlan['steps'][number]> = {}) => ({
      title: 'A',
      goal: 'a',
      owner: 'dev',
      department: null,
      dependsOn: [],
      ...over,
    });
    const cases: Array<{ label: string; plan: ExecutionPlan; detail: string }> = [
      {
        label: 'a step that depends on ITSELF',
        plan: { steps: [step({ dependsOn: [0] })] },
        detail: 'depends on index 0, which is not a PRIOR step',
      },
      {
        label: 'a FRACTIONAL dependency index',
        plan: { steps: [step(), step({ dependsOn: [0.5] })] },
        detail: 'depends on index 0.5, which is not a PRIOR step',
      },
      {
        label: 'a NEGATIVE dependency index',
        plan: { steps: [step(), step({ dependsOn: [-1] })] },
        detail: 'depends on index -1, which is not a PRIOR step',
      },
      {
        label: 'more dependencies than a row can carry',
        plan: {
          steps: [step(), step({ dependsOn: Array.from({ length: 101 }, () => 0) })],
        },
        detail: `declares 101 dependencies (the row bound is ${MAX_TASK_DEPENDENCIES})`,
      },
      {
        label: 'a title one character past the row bound',
        plan: { steps: [step({ title: 'T'.repeat(MAX_TASK_TITLE_CHARS + 1) })] },
        detail: `outside 1..${MAX_TASK_TITLE_CHARS} characters`,
      },
      {
        label: 'an EMPTY title',
        plan: { steps: [step({ title: '' })] },
        detail: `outside 1..${MAX_TASK_TITLE_CHARS} characters`,
      },
      { label: 'an EMPTY goal', plan: { steps: [step({ goal: '' })] }, detail: 'empty goal' },
      {
        label: 'a step booking a department its owner does not belong to',
        plan: { steps: [step({ owner: 'lead', department: 'eng' })] },
        detail: "books department 'eng'",
      },
      {
        label: 'a step naming an owner the workforce does not declare',
        plan: { steps: [step({ owner: 'ghost' })] },
        detail: "owner 'ghost'",
      },
      {
        label: 'an UNBOUNDED plan — one goal cannot become an unbounded write',
        plan: {
          steps: Array.from({ length: SEAM_MAX_PLAN_STEPS + 1 }, (_v, i) =>
            step({ title: `T${i}`, goal: `g${i}` }),
          ),
        },
        detail: `carries ${SEAM_MAX_PLAN_STEPS + 1} steps (the bound is ${SEAM_MAX_PLAN_STEPS})`,
      },
    ];
    for (const { label, plan, detail } of cases) {
      const result = await intakeWith(scripted(plan).strategy).submitGoal({
        tenantId: TENANT,
        workforceId: 'intake_wf',
        goal: 'g',
        requestedBy: 'user:u1',
      });
      expect(result.outcome, label).toBe('invalid_plan');
      if (result.outcome !== 'invalid_plan') throw new Error('unreachable');
      expect(result.detail, label).toContain(detail);
      expect(result.detail, label).toContain("strategy 'scripted'");
      expect(await taskRows(), label).toHaveLength(0);
    }
  });

  it('a plan AT the step bound is created — the bound refuses excess, not decomposition', async () => {
    const plan: ExecutionPlan = {
      steps: Array.from({ length: SEAM_MAX_PLAN_STEPS }, (_v, i) => ({
        title: `T${i}`,
        goal: `g${i}`,
        owner: 'dev',
        department: null,
        dependsOn: [],
      })),
    };
    const result = await intakeWith(scripted(plan).strategy).submitGoal({
      tenantId: TENANT,
      workforceId: 'intake_wf',
      goal: 'g',
      requestedBy: 'user:u1',
    });
    expect(result.outcome).toBe('created');
    expect(await taskRows()).toHaveLength(SEAM_MAX_PLAN_STEPS);
  });

  it('reconciles tenant and workforce BEFORE the strategy runs: a foreign pair is not_found and plans nothing', async () => {
    const { strategy, inputs } = scripted({ steps: [] });
    const intake = intakeWith(strategy);
    const foreignTenant = await intake.submitGoal({
      tenantId: '00000000-0000-4000-8000-0000000000d2',
      workforceId: 'intake_wf',
      goal: 'g',
      requestedBy: 'user:u1',
    });
    const foreignWorkforce = await intake.submitGoal({
      tenantId: TENANT,
      workforceId: 'someone_else',
      goal: 'g',
      requestedBy: 'user:u1',
    });
    expect(foreignTenant).toEqual({ outcome: 'not_found' });
    expect(foreignWorkforce).toEqual({ outcome: 'not_found' });
    expect(inputs).toHaveLength(0); // the strategy never saw either
    expect(await taskRows()).toHaveLength(0);
  });

  /**
   * OPERATOR CONTROL AT THE INTAKE DOOR.
   *
   * `pauseWorkforce` stops the reserve pass and makes `#claimTurn` refuse the claim, so a root born
   * into a paused workforce never RUNS. It is still wrong to create one: `haltWorkforce`'s
   * `affectedTaskCount` and its "every non-terminal task" claim become untrue for that row, and a
   * later resume starts work the operator believed they had stopped. These arms hold the door.
   *
   * The gate reads `paused`, NOT `halt_reason` — `resumeWorkforce` clears the former and never the
   * latter, so a `halt_reason` gate would shut intake forever after one halt. The resume arm is what
   * fails if anyone "tightens" the predicate that way; it is a guard on the fix, not a defect proof.
   */
  describe('a paused or halted workforce admits NO new roots', () => {
    const tdb = () => forTenant(db as unknown as Db, TENANT);

    /** The runtime row is truncated per test, so a workforce is un-paused unless an arm pauses it. */
    async function runtimeRow(): Promise<{ paused: boolean; halt_reason: string | null }> {
      const rows = (await db.$client.unsafe(
        `SELECT paused, halt_reason FROM workforce_runtime WHERE workforce_id = 'intake_wf';`,
      )) as unknown as Array<{ paused: boolean; halt_reason: string | null }>;
      const row = rows[0];
      if (!row) throw new Error('no runtime row for intake_wf');
      return row;
    }

    function oneStep(): OrchestrationStrategy {
      return scripted({
        steps: [{ title: 'A', goal: 'a', owner: 'dev', department: null, dependsOn: [] }],
      }).strategy;
    }

    it('refuses a goal submitted to a HALTED workforce, and creates ZERO rows', async () => {
      await haltWorkforce(tdb(), {
        workforceId: 'intake_wf',
        actor: 'user:op',
        reason: 'incident',
        drainTimeoutMs: 5_000,
      });
      expect(await runtimeRow()).toMatchObject({ paused: true, halt_reason: 'incident' });

      await expect(
        intakeWith(oneStep()).submitGoal({
          tenantId: TENANT,
          workforceId: 'intake_wf',
          goal: 'work the operator halted',
          requestedBy: 'user:u1',
        }),
      ).rejects.toBeInstanceOf(WorkforcePausedError);

      // The whole point: an operator who halted must not find new roots waiting on resume.
      expect(await taskRows()).toHaveLength(0);
    });

    it('refuses a goal submitted to a merely PAUSED workforce, and creates ZERO rows', async () => {
      await pauseWorkforce(tdb(), { workforceId: 'intake_wf', actor: 'user:op' });
      // A plain pause sets NO halt_reason — this is the arm a `halt_reason` gate would fail.
      expect(await runtimeRow()).toMatchObject({ paused: true, halt_reason: null });

      await expect(
        intakeWith(oneStep()).submitGoal({
          tenantId: TENANT,
          workforceId: 'intake_wf',
          goal: 'work while paused',
          requestedBy: 'user:u1',
        }),
      ).rejects.toBeInstanceOf(WorkforcePausedError);
      expect(await taskRows()).toHaveLength(0);
    });

    it('admits a goal again after RESUME, even though halt_reason still records the halt', async () => {
      await haltWorkforce(tdb(), {
        workforceId: 'intake_wf',
        actor: 'user:op',
        reason: 'incident',
        drainTimeoutMs: 5_000,
      });
      await resumeWorkforce(tdb(), { workforceId: 'intake_wf', actor: 'user:op' });
      // `resumeWorkforce` writes paused/paused_at/paused_by and NOTHING else: the halt's record
      // survives its own resume. A gate keyed on it would leave this workforce permanently shut.
      expect(await runtimeRow()).toMatchObject({ paused: false, halt_reason: 'incident' });

      const result = await intakeWith(oneStep()).submitGoal({
        tenantId: TENANT,
        workforceId: 'intake_wf',
        goal: 'work after the operator said go',
        requestedBy: 'user:u1',
      });
      expect(result.outcome).toBe('created');
      expect(await taskRows()).toHaveLength(1);
    });

    /**
     * THE LOCK, OBSERVED FROM THE DATABASE — not assumed from the fact that a helper was called.
     *
     * Every arm above stays green if the gate silently stops LOCKING: swap the upsert for a plain
     * read and a serial test still sees `paused = true`, because nothing in a serial test races.
     * The completeness argument is a LOCK argument, so it has to be pinned as one, the way #502
     * pinned the identical blind spot in `#claimTurn`.
     *
     * Construction, with real Postgres row locks and no injected seams:
     *
     *   T_hold (a held-open transaction):  UPDATE workforce_runtime SET paused = true    -- NOT committed
     *   main:                              submitGoal(...)  -- started, NOT awaited
     *                                        -> the gate's upsert BLOCKS on T_hold's row lock
     *   main:  poll pg_stat_activity until a backend is blocked BY T_HOLD'S OWN PID
     *          (pg_blocking_pids, so unrelated traffic cannot satisfy the wait)
     *   main:  while it is blocked, read pg_locks for that backend
     *   T_hold: COMMIT  ->  the gate re-reads under the lock, sees `paused`, refuses, zero rows
     *
     * Two independent facts fall out, and they fail for different reasons:
     *
     *   1. THE GATE TAKES THE LOCK. An unlocked read never blocks — it would read the pre-pause
     *      committed row, admit the goal and resolve. So a dropped lock cannot reach the assertions.
     *   2. THE RANK IS `workforce_runtime` -> `workforce_tasks`. While blocked on the runtime row
     *      the transaction must hold NO lock on `workforce_tasks` — a gate placed after the first
     *      insert would already hold `RowExclusiveLock` there, which is the inversion the lock-rank
     *      docblock in task-scheduler.ts forbids for the fourth composite transaction.
     *
     * NOT covered here, stated so the coverage is not overclaimed: moving the gate OUT of the
     * transaction entirely still blocks and still refuses in this construction, because the refusal
     * is serialized either way. That direction is a STATEMENT ORDERING and is pinned as one, in
     * `intake-pause-ordering.test.ts`.
     */
    it('TAKES the runtime row lock, and holds NO task lock while it waits', async () => {
      await ensureWorkforceRuntime(tdb(), 'intake_wf');

      let commitHolder!: () => void;
      const holderMayCommit = new Promise<void>((resolve) => {
        commitHolder = resolve;
      });
      let holderPid = 0;
      let signalHolderReady!: () => void;
      const holderReady = new Promise<void>((resolve) => {
        signalHolderReady = resolve;
      });

      // T_hold — pauses the workforce and sits on the runtime row's exclusive lock, uncommitted.
      const holder = db.$client.begin(async (tx) => {
        const [row] = (await tx.unsafe('SELECT pg_backend_pid() AS pid;')) as unknown as Array<{
          pid: number;
        }>;
        holderPid = Number(row?.pid);
        await tx.unsafe(
          "UPDATE workforce_runtime SET paused = true WHERE workforce_id = 'intake_wf';",
        );
        signalHolderReady();
        await holderMayCommit;
      });
      await holderReady;

      // FROM HERE THE HOLDER EXISTS, SO EVERY PATH MUST RELEASE IT. Its transaction sits on the
      // `workforce_runtime` row's exclusive lock; if this test throws without committing it, every
      // later arm in this file wedges on that row until its own timeout — noise that buries the
      // real failure. (Observed exactly that on the first R1 run.) `release` is idempotent, so the
      // happy path releases where it must — before awaiting the submission, which cannot settle
      // until the pause commits — and the `finally` is a backstop, not a second release.
      //
      // The `try` opens HERE, not after the submission is started: the pid assertion and the
      // `submitGoal(...)` construction both sit between the holder and the old `try`, and either
      // throwing there would have leaked the transaction. A probe that can wedge the suite for a
      // minute is worse than no probe.
      let released = false;
      const release = async (): Promise<void> => {
        if (released) return;
        released = true;
        commitHolder();
        await holder;
      };

      try {
        expect(holderPid, 'the holder must report a real backend pid').toBeGreaterThan(0);

        // Started, deliberately NOT awaited: it must be in flight and blocked while we inspect it.
        const settled = intakeWith(oneStep())
          .submitGoal({
            tenantId: TENANT,
            workforceId: 'intake_wf',
            goal: 'a goal racing a pause that has not committed yet',
            requestedBy: 'user:u1',
          })
          .then(
            (ok) => ({ kind: 'resolved' as const, ok }),
            (err: unknown) => ({ kind: 'rejected' as const, err }),
          );

        // Wait for a backend blocked BY THE HOLDER specifically.
        let blockedPid = 0;
        let taskLockModes: string[] = [];
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const rows = (await db.$client.unsafe(
            `SELECT pid FROM pg_stat_activity
               WHERE datname = current_database()
                 AND ${holderPid} = ANY(pg_blocking_pids(pid));`,
          )) as unknown as Array<{ pid: number }>;
          if (rows.length > 0) {
            blockedPid = Number(rows[0]?.pid);
            break;
          }
          await new Promise((r) => setTimeout(r, 25));
        }
        if (blockedPid > 0) {
          const rows = (await db.$client.unsafe(
            `SELECT l.mode FROM pg_locks l
               JOIN pg_class c ON c.oid = l.relation
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE l.pid = ${blockedPid}
                AND c.relname = 'workforce_tasks'
                AND n.nspname = 'rayspec_test_tasks';`,
          )) as unknown as Array<{ mode: string }>;
          taskLockModes = rows.map((l) => l.mode);
        }

        // The lock evidence is captured; let the pause commit so the blocked gate can decide.
        await release();

        expect(
          blockedPid,
          'THE GATE DID NOT BLOCK on the uncommitted pause, so it is NOT holding the runtime row ' +
            'lock. An unlocked read leaves the ordering half of the proof gone while every serial ' +
            'arm still passes — which is exactly the refactor this arm exists to catch.',
        ).toBeGreaterThan(0);

        // THE RANK: blocked on workforce_runtime, it must not already hold workforce_tasks.
        expect(
          taskLockModes,
          'THE LOCK RANK IS INVERTED: the intake already holds a lock on `workforce_tasks` while ' +
            'it waits for `workforce_runtime`. The gate must run BEFORE the first task write, so ' +
            'this transaction takes runtime -> tasks and stays a prefix of every path it can race.',
        ).toEqual([]);

        const outcome = await settled;
        expect(outcome.kind, 'the gate must refuse once the pause it waited for is committed').toBe(
          'rejected',
        );
        if (outcome.kind !== 'rejected') throw new Error('unreachable');
        expect(outcome.err).toBeInstanceOf(WorkforcePausedError);
        expect(await taskRows()).toHaveLength(0);
      } finally {
        await release();
      }
    });

    it('refuses a MULTI-STEP plan at the gate, leaving ZERO rows — not a half-born plan', async () => {
      await pauseWorkforce(tdb(), { workforceId: 'intake_wf', actor: 'user:op' });
      const { strategy } = scripted({
        steps: [
          { title: 'Research', goal: 'r', owner: 'dev', department: null, dependsOn: [] },
          { title: 'Draft', goal: 'd', owner: 'dev', department: null, dependsOn: [0] },
          { title: 'Merge', goal: 'm', owner: 'lead', department: null, dependsOn: [0, 1] },
        ],
      });
      await expect(
        intakeWith(strategy).submitGoal({
          tenantId: TENANT,
          workforceId: 'intake_wf',
          goal: 'a three-step plan into a paused workforce',
          requestedBy: 'user:u1',
        }),
      ).rejects.toBeInstanceOf(WorkforcePausedError);
      expect(await taskRows()).toHaveLength(0);
    });
  });
});
