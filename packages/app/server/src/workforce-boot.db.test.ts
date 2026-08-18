/**
 * The workforce boot wiring against real Postgres: the REDEPLOY GATE (live non-terminal state
 * pins the declarations it references; pure additions always deploy) and the derived-budget
 * persistence onto the runtime row. Uses the task engine's own test schema helpers — the gate
 * reads exactly the rows the engine writes.
 */
import { deriveWorkforceBudgets, parseSpec, WorkforceSpec } from '@rayspec/spec';
import { createRootTask, ensureWorkforceRuntime, resolveWorkforceBudgets } from '@rayspec/tasks';
import { forTenant, makeTestDb, resetTaskSchema } from '@rayspec/tasks/test-support';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assertWorkforceSpecCompatible,
  ensureDeclaredWorkforceRuntime,
  parseDelegatedTo,
  releaseDepartedWorkforceDeclarations,
  WorkforceSpecChangeError,
} from './workforce-boot.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (requireDb && !hasDb) {
  throw new Error(
    'workforce-boot.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — refusing to silently skip.',
  );
}

const TENANT = '00000000-0000-4000-8000-0000000000b1';

const DECLARED = WorkforceSpec.parse({
  id: 'helpdesk',
  name: 'Helpdesk',
  orchestrator: 'lead',
  budgets: {
    workforce: { usd: 40 },
    task: { usd: 2.5, turns: 12 },
  },
  execution: { maxTaskWallClock: '45m' },
  departments: [
    {
      id: 'eng',
      name: 'Engineering',
      manager: 'mgr',
      mission: 'Own it.',
      members: ['dev'],
      budgets: { usd: 10 },
    },
  ],
  employees: [
    { id: 'lead', agent: 'a', title: 'Lead', role: 'orchestrator' },
    { id: 'mgr', agent: 'a', title: 'M', department: 'eng', reportsTo: 'lead', role: 'manager' },
    { id: 'dev', agent: 'a', title: 'D', department: 'eng', role: 'worker' },
  ],
  teams: [{ id: 'fix_team', lead: 'mgr', members: ['dev'], maxSize: 2 }],
});

describe.skipIf(!hasDb)('workforce boot wiring (db)', () => {
  // The task engine's dedicated test schema (its DDL mirrors the committed migration).
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
      'TRUNCATE workforce_tasks, workforce_task_transitions, workforce_task_signals, workforce_delegations, workforce_approvals, workforce_reviews, workforce_messages, workforce_budget_ledger, workforce_runtime, run_events CASCADE;',
    );
    await db.$client.unsafe(
      `INSERT INTO orgs (id, name) VALUES ('${TENANT}', 'boot-test') ON CONFLICT DO NOTHING;`,
    );
  });

  const tdb = () => forTenant(db, TENANT);

  it('an empty database (the first deploy) passes trivially', async () => {
    await expect(assertWorkforceSpecCompatible(tdb(), DECLARED)).resolves.toBeUndefined();
  });

  it('pure additions always deploy — live tasks on still-declared owners never refuse', async () => {
    await createRootTask(tdb(), {
      workforceId: 'helpdesk',
      title: 'Live work',
      goal: 'G',
      owner: 'dev',
      requestedBy: 'user',
      department: 'eng',
    });
    await expect(assertWorkforceSpecCompatible(tdb(), DECLARED)).resolves.toBeUndefined();
  });

  it('refuses a redeploy that removes an employee with a non-terminal task, naming the task ids', async () => {
    const task = await createRootTask(tdb(), {
      workforceId: 'helpdesk',
      title: 'Live work',
      goal: 'G',
      owner: 'dev',
      requestedBy: 'user',
      department: 'eng',
    });
    const withoutDev = WorkforceSpec.parse({
      ...JSON.parse(JSON.stringify(DECLARED)),
      employees: DECLARED.employees.filter((e) => e.id !== 'dev'),
      departments: [{ ...DECLARED.departments[0], members: [] }],
      teams: [{ id: 'fix_team', lead: 'mgr', members: ['mgr'], maxSize: 2 }],
    });
    const refusal = assertWorkforceSpecCompatible(tdb(), withoutDev);
    await expect(refusal).rejects.toBeInstanceOf(WorkforceSpecChangeError);
    await expect(refusal).rejects.toMatchObject({ taskIds: [task.taskId] });
    await expect(assertWorkforceSpecCompatible(tdb(), withoutDev)).rejects.toThrow(task.taskId);
  });

  describe('a declaration is a fact on the row — the marker, and what it does and does not gate', () => {
    async function liveTask(workforceId: string) {
      return createRootTask(tdb(), {
        workforceId,
        title: 'Live work',
        goal: 'G',
        owner: 'dev',
        requestedBy: 'user',
        department: 'eng',
      });
    }

    /** What a prior boot of a declaring document leaves behind: the stamped runtime row. */
    async function priorDeclaringBoot(workforce = DECLARED): Promise<void> {
      await ensureDeclaredWorkforceRuntime(tdb(), workforce);
    }

    async function markerOf(workforceId: string): Promise<string | null> {
      const rows = (await db.$client.unsafe(
        `SELECT budgets->>'declaredAt' AS declared_at FROM workforce_runtime WHERE workforce_id = '${workforceId}';`,
      )) as unknown as { declared_at: string | null }[];
      return rows[0]?.declared_at ?? null;
    }

    it('a declaring boot stamps the marker; the ceilings it stores still parse', async () => {
      await priorDeclaringBoot();
      expect(await markerOf('helpdesk')).not.toBeNull();
      // The marker rides the SAME strict payload the engine parses at every dispatch, so the
      // load-bearing assertion is that adding it did not make that payload unreadable.
      const rows = (await db.$client.unsafe(
        `SELECT budgets FROM workforce_runtime WHERE workforce_id = 'helpdesk';`,
      )) as unknown as { budgets: unknown }[];
      const budgets = resolveWorkforceBudgets(rows[0]?.budgets, 'helpdesk');
      expect(budgets.workforce?.usd).toBe(40);
      expect(budgets.execution.maxTaskWallClockMs).toBe(2_700_000);
    });

    it('refuses a redeploy that DROPS the workforce section while live work runs under it', async () => {
      await priorDeclaringBoot();
      const task = await liveTask('helpdesk');
      // The maximal removal. The marker is what makes it decidable: this id was declared by a
      // document, so live work under it is stranded rather than merely engine-owned.
      const refusal = assertWorkforceSpecCompatible(tdb(), undefined);
      await expect(refusal).rejects.toBeInstanceOf(WorkforceSpecChangeError);
      await expect(refusal).rejects.toMatchObject({ taskIds: [task.taskId] });
      await expect(assertWorkforceSpecCompatible(tdb(), undefined)).rejects.toThrow(
        "workforce 'helpdesk'",
      );
      await expect(assertWorkforceSpecCompatible(tdb(), undefined)).rejects.toThrow(task.taskId);
    });

    it('the ENGINE-ONLY posture stays ungated — an unstamped id is nobody’s declaration', async () => {
      // No declaring boot ever ran: `workforce_id` here is the task engine's own scoping, set by
      // whoever created the task, and `/v1/workforce` serves exactly this deployment. Without a
      // marker there is no declaration to have been removed, so the boot proceeds.
      await liveTask('helpdesk');
      expect(await markerOf('helpdesk')).toBeNull();
      await expect(assertWorkforceSpecCompatible(tdb(), undefined)).resolves.toBeUndefined();
      // And it stays ungated for a document that declares a DIFFERENT workforce, too: unmarked
      // live work is not this document's to strand.
      const other = WorkforceSpec.parse({
        ...JSON.parse(JSON.stringify(DECLARED)),
        id: 'helpdesk_v2',
      });
      await expect(assertWorkforceSpecCompatible(tdb(), other)).resolves.toBeUndefined();
    });

    it('refuses a redeploy that RENAMES the workforce id out from under live work', async () => {
      await priorDeclaringBoot();
      const task = await liveTask('helpdesk');
      // A rename is a removal of the old id. Every gate query used to filter on the NEW id, so it
      // matched zero rows and passed trivially while the live tasks kept dispatching under the old
      // one, against a runtime row nothing would refresh again.
      const renamed = WorkforceSpec.parse({
        ...JSON.parse(JSON.stringify(DECLARED)),
        id: 'helpdesk_v2',
      });
      const refusal = assertWorkforceSpecCompatible(tdb(), renamed);
      await expect(refusal).rejects.toBeInstanceOf(WorkforceSpecChangeError);
      await expect(refusal).rejects.toMatchObject({ taskIds: [task.taskId] });
      await expect(assertWorkforceSpecCompatible(tdb(), renamed)).rejects.toThrow(
        "workforce 'helpdesk'",
      );
    });

    it('a marked workforce with only TERMINAL work deploys, and the stale marker is released', async () => {
      await priorDeclaringBoot();
      const done = await liveTask('helpdesk');
      await db.$client.unsafe(
        `UPDATE workforce_tasks SET status = 'completed' WHERE task_id = '${done.taskId}';`,
      );
      await expect(assertWorkforceSpecCompatible(tdb(), undefined)).resolves.toBeUndefined();
      // Nothing live depended on the declaration, so the retirement is clean and the marker goes:
      // leaving it would make a LATER engine-only boot refuse over tasks created after the
      // workforce was legitimately retired.
      await releaseDepartedWorkforceDeclarations(tdb(), undefined);
      expect(await markerOf('helpdesk')).toBeNull();
      await liveTask('helpdesk');
      await expect(assertWorkforceSpecCompatible(tdb(), undefined)).resolves.toBeUndefined();
    });

    it('a still-declared workforce keeps its marker when the release runs', async () => {
      await priorDeclaringBoot();
      await releaseDepartedWorkforceDeclarations(tdb(), DECLARED);
      expect(await markerOf('helpdesk')).not.toBeNull();
    });

    it('a bare platform task carries no workforce id and is never a workforce declaration', async () => {
      await createRootTask(tdb(), {
        title: 'Bare platform task',
        goal: 'G',
        owner: 'user',
        requestedBy: 'user',
      });
      await expect(assertWorkforceSpecCompatible(tdb(), undefined)).resolves.toBeUndefined();
    });

    /**
     * THE TRANSITIONAL WINDOW, stated as behaviour rather than as a comment (module header, :45-49).
     *
     * A workforce declared by a boot that ran BEFORE the marker existed carries a runtime row with
     * REAL budgets and NO `declaredAt`. That row is byte-indistinguishable from the one the scheduler
     * creates for an engine-only deployment, so the gate cannot tell "declared, then removed" from
     * "never declared" — and a removal in that window is not caught. Real for any database whose rows
     * predate the marker.
     *
     * WHY THIS IS PINNED AND NOT BACKFILLED. A backfill could only ever stamp rows the CURRENT
     * document declares — and `ensureDeclaredWorkforceRuntime` already stamps exactly those, on every
     * declaring boot, which is what the second arm shows. Stamping any OTHER row would not be a
     * backfill but a fabrication: for a row this document does not declare, no boot has the evidence
     * to say which of the two histories produced it, and guessing "declared" would make a legitimate
     * engine-only deployment refuse to boot over tasks nobody ever declared — the exact false positive
     * `releaseDepartedWorkforceDeclarations` exists to prevent. So the window is irreducible at boot
     * time; it belongs in the upgrade notes (docs/workforce-architecture.md → "Upgrade and rollback
     * notes"), and these two arms are what would go red if someone changed it by accident.
     */
    it('PRE-MARKER WINDOW: an unmarked runtime row lets a removal through — the documented limitation', async () => {
      // Exactly what the pre-marker code wrote: the derived ceilings, and nothing else.
      await ensureWorkforceRuntime(tdb(), 'helpdesk', {
        ...(deriveWorkforceBudgets(DECLARED) as Readonly<Record<string, unknown>>),
      });
      const task = await liveTask('helpdesk');
      expect(await markerOf('helpdesk')).toBeNull();

      // The removal ESCAPES. This is the limitation, not an aspiration — and the arm below is what
      // makes it a bounded one.
      await expect(assertWorkforceSpecCompatible(tdb(), undefined)).resolves.toBeUndefined();
      // …and the live task really is live, so the pass is not an artefact of an empty scan.
      const rows = (await db.$client.unsafe(
        `SELECT status FROM workforce_tasks WHERE task_id = '${task.taskId}';`,
      )) as unknown as { status: string }[];
      expect(rows[0]?.status).toBe('planned');
    });

    it('the window CLOSES at the next declaring boot: the same removal then refuses', async () => {
      await ensureWorkforceRuntime(tdb(), 'helpdesk', {
        ...(deriveWorkforceBudgets(DECLARED) as Readonly<Record<string, unknown>>),
      });
      const task = await liveTask('helpdesk');
      expect(await markerOf('helpdesk')).toBeNull();

      // One boot that still declares the workforce — the only backfill that is sound, and the one
      // the shipped code already performs on every declaring boot.
      await ensureDeclaredWorkforceRuntime(tdb(), DECLARED);
      expect(await markerOf('helpdesk')).not.toBeNull();

      const refusal = assertWorkforceSpecCompatible(tdb(), undefined);
      await expect(refusal).rejects.toBeInstanceOf(WorkforceSpecChangeError);
      await expect(refusal).rejects.toMatchObject({ taskIds: [task.taskId] });
    });
  });

  it("terminal tasks referencing removed owners do not refuse, and 'user'-owned tasks never do", async () => {
    const done = await createRootTask(tdb(), {
      workforceId: 'helpdesk',
      title: 'Finished work',
      goal: 'G',
      owner: 'departed',
      requestedBy: 'user',
    });
    await db.$client.unsafe(
      `UPDATE workforce_tasks SET status = 'completed' WHERE task_id = '${done.taskId}';`,
    );
    await createRootTask(tdb(), {
      workforceId: 'helpdesk',
      title: 'Human-owned',
      goal: 'G',
      owner: 'user',
      requestedBy: 'user',
    });
    await expect(assertWorkforceSpecCompatible(tdb(), DECLARED)).resolves.toBeUndefined();
  });

  it('refuses a redeploy that removes a team referenced by a live delegation target', async () => {
    const parent = await createRootTask(tdb(), {
      workforceId: 'helpdesk',
      title: 'Parent',
      goal: 'G',
      owner: 'lead',
      requestedBy: 'user',
    });
    const child = await createRootTask(tdb(), {
      workforceId: 'helpdesk',
      title: 'Team-carried',
      goal: 'G',
      owner: 'mgr',
      requestedBy: 'lead',
    });
    await db.$client.unsafe(
      `INSERT INTO workforce_delegations (tenant_id, workforce_id, parent_task_id, child_task_id, delegated_by, delegated_to, resolved_owner, goal, expected_output, depth, status)
       VALUES ('${TENANT}', 'helpdesk', '${parent.taskId}', '${child.taskId}', 'lead', 'team:fix_team', 'mgr', 'G', 'worker_result', 1, 'accepted');`,
    );
    const withoutTeam = WorkforceSpec.parse({
      ...JSON.parse(JSON.stringify(DECLARED)),
      teams: [],
    });
    await expect(assertWorkforceSpecCompatible(tdb(), withoutTeam)).rejects.toBeInstanceOf(
      WorkforceSpecChangeError,
    );
    // The same declaration WITH the team stays deployable.
    await expect(assertWorkforceSpecCompatible(tdb(), DECLARED)).resolves.toBeUndefined();
  });

  it('boot persists the declared budgets onto workforce_runtime and the engine parses them back', async () => {
    await ensureDeclaredWorkforceRuntime(tdb(), DECLARED);
    const rows = (await db.$client.unsafe(
      `SELECT budgets FROM workforce_runtime WHERE workforce_id = 'helpdesk';`,
    )) as unknown as { budgets: Record<string, unknown> }[];
    expect(rows).toHaveLength(1);
    const resolved = resolveWorkforceBudgets(rows[0]?.budgets, 'helpdesk');
    expect(resolved.workforce?.usd).toBe(40);
    expect(resolved.execution.estimateUsdPerTurn).toBeCloseTo(2.5 / 12, 10);
    expect(resolved.execution.maxTaskWallClockMs).toBe(2_700_000);
    expect(resolved.departments?.eng?.usd).toBe(10);
  });
});

describe('the delegated_to parser', () => {
  it('parses the three prefixes and treats a bare value as an employee id', () => {
    expect(parseDelegatedTo('employee:dev')).toEqual({ kind: 'employee', id: 'dev' });
    expect(parseDelegatedTo('department:eng')).toEqual({ kind: 'department', id: 'eng' });
    expect(parseDelegatedTo('team:fix_team')).toEqual({ kind: 'team', id: 'fix_team' });
    expect(parseDelegatedTo('dev')).toEqual({ kind: 'employee', id: 'dev' });
  });
});

/**
 * The gate and the marker writer are guarded ASYMMETRICALLY in the composition root: the gate (and
 * the release beside it) run on `config.cronTenantId` alone, while `ensureDeclaredWorkforceRuntime`
 * — the marker's only writer — additionally requires the wired durable worker. A configuration that
 * satisfied the first and never the second would DECLARE a workforce whose declaration is never
 * recorded, and the next boot could then drop or rename it unseen: the maximal removals the marker
 * exists to make decidable.
 *
 * It is unreachable, and by a rule rather than by a convention: a document that declares
 * `workforce:` is a lint ERROR without `deployment.durableWorker: true`, so no document can arm the
 * gate without also arming the marker writer. This pins that linkage on the boot side — a later
 * change that relaxes the rule fails here, where the consequence lives.
 */
describe('the redeploy gate and the declaration marker cannot be configured apart', () => {
  const DECLARING_SPEC = `
version: '1.0'
metadata:
  name: workforce-boot-linkage
deployment:
  durableWorker: true
agents:
  - id: lead_agent
    name: lead_agent
    backend: openai
    model: gpt-4o-mini
    instructions: Coordinate the workforce.
workforce:
  id: helpdesk
  name: Helpdesk
  orchestrator: lead
  employees:
    - id: lead
      agent: lead_agent
      title: Lead
      role: orchestrator
`;

  it('a document that declares a workforce cannot deploy without the durable worker', () => {
    const withWorker = parseSpec(DECLARING_SPEC, { experimentalWorkforce: true });
    expect(withWorker.ok).toBe(true);

    const withoutWorker = parseSpec(
      DECLARING_SPEC.replace('deployment:\n  durableWorker: true\n', ''),
      { experimentalWorkforce: true },
    );
    expect(withoutWorker.ok).toBe(false);
    if (withoutWorker.ok) return;
    expect(withoutWorker.errors.map((e) => e.message).join('\n')).toContain(
      'deployment.durableWorker: true',
    );
  });
});
