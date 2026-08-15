/**
 * The recall provider against real Postgres — relevance, scoping, bounds and TENANCY, on rows the
 * engine wrote. Results are seeded through the engine's own path (createRootTask → transitions →
 * applyTurnOutcome — the sworn only writers); journaled decision rows ride the same application
 * (a review verdict journals `workforce.review.decided` through the engine, not test-side).
 *
 * THE ADVERSARIAL ARM: a second org carries an IDENTICAL workforce id, employee ids and
 * keyword-rich results — the provider bound to the first tenant must return none of it. The
 * TenantDb chokepoint is the only mechanism between the two, and this suite pins it.
 */
import type { Db } from '@rayspec/db';
import {
  applyTransition,
  applyTurnOutcome,
  createRootTask,
  type TaskRecord,
  workforceBudgetsSchema,
} from '@rayspec/tasks';
import { forTenant, makeTestDb, resetTaskSchema } from '@rayspec/tasks/test-support';
import { RECALL_MAX_HITS, TaskHistoryMemoryProvider } from '@rayspec/workforce-tools';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (requireDb && !hasDb) {
  throw new Error(
    'workforce-recall.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — refusing to silently skip.',
  );
}

const TENANT_A = '00000000-0000-4000-8000-0000000000e5';
const TENANT_B = '00000000-0000-4000-8000-0000000000e6';
const NO_BUDGETS = workforceBudgetsSchema.parse({});
const NOW = new Date('2026-08-15T12:00:00Z');

describe.skipIf(!hasDb)('the task-history recall provider (db)', () => {
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
       INSERT INTO orgs (id, name) VALUES ('${TENANT_A}', 'Org A'), ('${TENANT_B}', 'Org B')
       ON CONFLICT DO NOTHING;`,
    );
  });

  /** Complete one task through the engine and (optionally) age its completion timestamp. */
  async function seedCompleted(
    tenant: string,
    input: {
      owner: string;
      department?: string | null;
      title: string;
      goal: string;
      summary: string;
      agedDays?: number;
      workforceId?: string;
    },
  ): Promise<TaskRecord> {
    const tdb = forTenant(db as unknown as Db, tenant);
    const task = await createRootTask(tdb, {
      workforceId: input.workforceId ?? 'recall_wf',
      title: input.title,
      goal: input.goal,
      owner: input.owner,
      requestedBy: 'user',
      department: input.department ?? null,
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
      to: 'working',
      actor: 'scheduler',
      turnId: 't1',
    });
    await applyTurnOutcome(tdb, {
      taskId: task.taskId,
      turnId: 't1',
      turnNumber: 1,
      intent: {
        kind: 'complete',
        result: { status: 'completed', summary: input.summary, confidence: 0.9 },
      },
      budgets: NO_BUDGETS,
    });
    if (input.agedDays !== undefined) {
      // Age the durable stamps (completion + journal) relative to the injected clock — the test
      // controls TIME through timestamps, exactly as the provider consumes them.
      await db.$client.unsafe(
        `UPDATE workforce_tasks SET completed_at = '${new Date(
          NOW.getTime() - input.agedDays * 86_400_000,
        ).toISOString()}' WHERE task_id = '${task.taskId}';
         UPDATE run_events SET created_at = '${new Date(
           NOW.getTime() - input.agedDays * 86_400_000,
         ).toISOString()}' WHERE run_id = '${task.taskId}';`,
      );
    }
    return task;
  }

  function providerFor(
    tenant: string,
    scope: { employeeId: string; department?: string | null; currentRootTaskId?: string } = {
      employeeId: 'dev',
    },
  ) {
    return new TaskHistoryMemoryProvider(forTenant(db as unknown as Db, tenant), {
      workforceId: 'recall_wf',
      employeeId: scope.employeeId,
      department: scope.department === undefined ? 'eng' : scope.department,
      currentRootTaskId: scope.currentRootTaskId ?? 'task_current_root',
      now: NOW,
    });
  }

  it('ranks by keyword over recency, and by recency among equal matches', async () => {
    await seedCompleted(TENANT_A, {
      owner: 'dev',
      department: 'eng',
      title: 'Pipeline redesign',
      goal: 'Redesign the release pipeline.',
      summary: 'The release pipeline now builds in one pass.',
      agedDays: 20,
    });
    await seedCompleted(TENANT_A, {
      owner: 'dev',
      department: 'eng',
      title: 'Unrelated chores',
      goal: 'Tidy the backlog.',
      summary: 'Closed stale issues.',
      agedDays: 1,
    });
    const freshMatch = await seedCompleted(TENANT_A, {
      owner: 'dev',
      department: 'eng',
      title: 'Pipeline docs',
      goal: 'Document the release pipeline.',
      summary: 'Documented the release pipeline stages.',
      agedDays: 2,
    });

    const hits = await providerFor(TENANT_A).search({ text: 'release pipeline' });
    expect(hits.length).toBeGreaterThanOrEqual(3);
    expect((hits[0] as { id: string }).id).toBe(freshMatch.taskId); // recency breaks the tie…
    // …and BOTH keyword matches outrank the fresher non-match, which ranks last.
    const choresRank = hits.findIndex((h) => h.text.includes('Closed stale issues'));
    expect(choresRank).toBe(2);
    // Every hit is stamped with its task id and age.
    for (const recalled of hits) {
      expect(recalled.text).toMatch(/^\[[^\]]+ · (?:<1h|\d+h|\d+d)\] /);
    }
  });

  it('recalls journaled decisions through the reviewed task, scoped like everything else', async () => {
    // A real review verdict, through the engine: complete under a matched policy, dispatch the
    // reviewer, reject — the journal rows this writes are what the provider reads.
    const tdb = forTenant(db as unknown as Db, TENANT_A);
    const task = await createRootTask(tdb, {
      workforceId: 'recall_wf',
      title: 'Risky work',
      goal: 'Ship the risky half.',
      owner: 'dev',
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
      to: 'working',
      actor: 'scheduler',
      turnId: 't1',
    });
    await applyTurnOutcome(tdb, {
      taskId: task.taskId,
      turnId: 't1',
      turnNumber: 1,
      intent: {
        kind: 'complete',
        result: { status: 'completed', summary: 'First attempt.', confidence: 0.4 },
      },
      reviewPolicy: { reviewer: 'qa', dispatchReviewer: true, maxRounds: 2 },
      budgets: NO_BUDGETS,
    });
    const parked = (await db.$client.unsafe(
      `SELECT task_id FROM workforce_tasks WHERE parent_task_id = '${task.taskId}';`,
    )) as unknown as Array<{ task_id: string }>;
    const reviewTaskId = (parked[0] as { task_id: string }).task_id;
    const reviewRow = (await db.$client.unsafe(
      `SELECT id FROM workforce_reviews WHERE task_id = '${task.taskId}';`,
    )) as unknown as Array<{ id: string }>;
    const { applyReviewVerdict } = await import('@rayspec/tasks');
    // Drive the review task to working so the verdict can settle it (the reviewer's own turn).
    const reviewQueued = await db.$client.unsafe(
      `SELECT version, status FROM workforce_tasks WHERE task_id = '${reviewTaskId}';`,
    );
    let version = Number((reviewQueued[0] as { version: number }).version);
    if ((reviewQueued[0] as { status: string }).status === 'planned') {
      version = (
        await applyTransition(tdb, {
          taskId: reviewTaskId,
          expectedVersion: version,
          to: 'queued',
          actor: 'scheduler',
        })
      ).version;
    }
    await applyTransition(tdb, {
      taskId: reviewTaskId,
      expectedVersion: version,
      to: 'working',
      actor: 'scheduler',
      turnId: 'rt1',
    });
    await applyReviewVerdict(tdb, NO_BUDGETS, {
      reviewId: (reviewRow[0] as { id: string }).id,
      verdict: 'reject',
      reasons: ['Confidence is too low for the stated scope.'],
      requiredChanges: ['Address the notes.'],
      actor: 'qa',
    });

    const hits = await providerFor(TENANT_A).search({ text: 'risky' });
    const decision = hits.find((h) => h.text.includes('review reject'));
    expect(decision).toBeDefined();
    expect(decision?.text).toContain("by 'qa'");
    expect(decision?.text).toContain('Confidence is too low');

    // The SAME decision is invisible to a seat outside its reach.
    const foreignSeat = await providerFor(TENANT_A, {
      employeeId: 'copy',
      department: 'growth',
    }).search({ text: 'risky' });
    expect(foreignSeat.find((h) => h.text.includes('review reject'))).toBeUndefined();
  });

  it('scopes to the employee and their department, and never mirrors the current root', async () => {
    const own = await seedCompleted(TENANT_A, {
      owner: 'dev',
      department: 'eng',
      title: 'Own prior work',
      goal: 'The dev did this.',
      summary: 'Own work summary.',
    });
    const colleague = await seedCompleted(TENANT_A, {
      owner: 'colleague',
      department: 'eng',
      title: 'Department prior work',
      goal: 'A colleague did this.',
      summary: 'Department work summary.',
    });
    const foreign = await seedCompleted(TENANT_A, {
      owner: 'copy',
      department: 'growth',
      title: 'Foreign department work',
      goal: 'Growth did this.',
      summary: 'Growth summary.',
    });
    const current = await seedCompleted(TENANT_A, {
      owner: 'dev',
      department: 'eng',
      title: 'The current root itself',
      goal: 'This is the work in flight.',
      summary: 'Should never be recalled into its own turns.',
    });

    const hits = await providerFor(TENANT_A, {
      employeeId: 'dev',
      department: 'eng',
      currentRootTaskId: current.taskId,
    }).search({ text: 'work', limit: 10 });
    const ids = hits.map((h) => h.id);
    expect(ids).toContain(own.taskId);
    expect(ids).toContain(colleague.taskId);
    expect(ids).not.toContain(foreign.taskId);
    expect(ids).not.toContain(current.taskId);

    // A department-less seat recalls only its own rows.
    const solo = await providerFor(TENANT_A, {
      employeeId: 'dev',
      department: null,
      currentRootTaskId: current.taskId,
    }).search({ text: 'work', limit: 10 });
    expect(solo.map((h) => h.id)).toEqual([own.taskId]);
  });

  it('holds every bound: the age window, the hit cap, the text cap, and the workforce pin', async () => {
    await seedCompleted(TENANT_A, {
      owner: 'dev',
      department: 'eng',
      title: 'Ancient matching work',
      goal: 'ancient keyword treasure',
      summary: 'ancient keyword treasure',
      agedDays: 40, // outside the 30-day window
    });
    for (let index = 0; index < 12; index += 1) {
      await seedCompleted(TENANT_A, {
        owner: 'dev',
        department: 'eng',
        title: `Fresh work ${index}`,
        goal: 'keyword treasure',
        summary: `keyword treasure ${index} — ${'x'.repeat(400)}`,
        agedDays: 1,
      });
    }

    const hits = await providerFor(TENANT_A).search({ text: 'keyword treasure', limit: 50 });
    expect(hits.length).toBeLessThanOrEqual(RECALL_MAX_HITS); // the cap holds past a greedy limit
    expect(hits.every((h) => h.text.length <= 300)).toBe(true);
    expect(hits.every((h) => !h.text.includes('ancient'))).toBe(true);

    // A query pinned to a DIFFERENT workforce id returns nothing — fail-closed, never relabeled.
    const foreignPin = await providerFor(TENANT_A).search({
      text: 'keyword treasure',
      workforceId: 'someone_else',
    });
    expect(foreignPin).toEqual([]);
  });

  it('ADVERSARIAL: an identical twin workforce in another tenant leaks nothing', async () => {
    // Tenant B: same workforce id, same employee ids, keyword-saturated bait.
    await seedCompleted(TENANT_B, {
      owner: 'dev',
      department: 'eng',
      title: 'Secret roadmap',
      goal: 'secret roadmap pricing customers',
      summary: 'SECRET tenant-B pricing and customer list.',
    });
    await seedCompleted(TENANT_A, {
      owner: 'dev',
      department: 'eng',
      title: 'Tenant A work',
      goal: 'ordinary work',
      summary: 'Ordinary tenant-A summary.',
    });

    const hits = await providerFor(TENANT_A).search({
      text: 'secret roadmap pricing customers',
      limit: 10,
    });
    expect(hits.some((h) => h.text.toLowerCase().includes('secret'))).toBe(false);
    expect(hits.some((h) => h.text.includes('tenant-B'))).toBe(false);
    // …and tenant B's own seat sees its own rows, so the empty result above is scoping, not luck.
    const twin = await providerFor(TENANT_B).search({ text: 'secret roadmap', limit: 10 });
    expect(twin.some((h) => h.text.includes('tenant-B'))).toBe(true);
  });
});
