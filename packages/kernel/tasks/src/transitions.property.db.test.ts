/**
 * Property suite over the ENGINE — randomized transition sequences driven through the real
 * `applyTransition` against real Postgres.
 *
 * Its sibling `transitions.property.test.ts` walks the transition TABLE, and derives its successor
 * function FROM the table it is testing (`successors()` reads `ALLOWED_TRANSITIONS`), so by
 * construction it can only find graph-shape defects: a dead end, a non-absorbing terminal, a second
 * door into `working`. It never calls `applyTransition`, never touches a row, never exercises
 * `REASON_RULES`, and never randomizes reasons — so an ENGINE defect (a validation call dropped, a
 * refusal that half-writes, a version that moves twice) is invisible to it. This suite closes that:
 * the same seeded walk, but every step is a real transaction against a real row, and the invariants
 * are asserted on the DURABLE artifacts.
 *
 * Each step draws one of three moves and asserts the engine's answer:
 *
 *   1. a LEGAL (from, to) with a legal reason (or none) — ACCEPTED: the row carries the new status
 *      and reason, the version moves by exactly one, and exactly one transition-log row appears;
 *   2. a LEGAL (from, to) with a reason `REASON_RULES` does not permit there, or free text —
 *      REFUSED with `StatusReasonInvalidError`, mutating nothing;
 *   3. an ILLEGAL (from, to) — REFUSED with `TaskTransitionIllegalError`, mutating nothing.
 *
 * And per walk: terminal is entered at most once and absorbs everything afterwards (the ENGINE-level
 * proof, not the table's), every `working` entry in the log departed from `queued`, and the log
 * length equals the number of accepted moves — a refusal that appended an audit row would be a
 * receipt the engine cannot honour.
 *
 * DETERMINISM. The PRNG is seeded and the seed IS the test case identity: it appears in every
 * assertion message, the failing seed and its path are printed on the way out, and
 * `RAYSPEC_TRANSITION_SEED=<n>` re-runs exactly that one walk. A red run here is reproducible.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyTransition } from './apply-transition.js';
import { createRootTask } from './create-task.js';
import {
  ALLOWED_TRANSITIONS,
  isTerminalStatus,
  REASON_RULES,
  STATUS_REASONS,
  type StatusReason,
  StatusReasonInvalidError,
  TASK_STATUSES,
  type TaskStatus,
  TaskTransitionIllegalError,
} from './status.js';
import {
  forTenant,
  makeTestDb,
  resetTaskSchema,
  seedOrgs,
  TENANT_A,
} from './test-support/test-db.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (requireDb && !hasDb) {
  throw new Error(
    'transitions.property.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — refusing to silently skip a correctness-load-bearing suite.',
  );
}

/** mulberry32 — the same tiny deterministic PRNG the pure property suite uses. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)] as T;
}

const legalTargets = (from: TaskStatus): TaskStatus[] =>
  TASK_STATUSES.filter((to) => ALLOWED_TRANSITIONS[from][to]);
const illegalTargets = (from: TaskStatus): TaskStatus[] =>
  TASK_STATUSES.filter((to) => !ALLOWED_TRANSITIONS[from][to]);
const legalReasons = (to: TaskStatus): StatusReason[] =>
  STATUS_REASONS.filter((reason) => REASON_RULES[reason].includes(to));
const illegalReasons = (to: TaskStatus): StatusReason[] =>
  STATUS_REASONS.filter((reason) => !REASON_RULES[reason].includes(to));

/** A reason that is not in the closed set at all — operators grep reasons; model prose is not one. */
const FREE_TEXT_REASON = 'the model said it was blocked on something';

/** How many terminal-row refusals to try before a walk stops (terminal is absorbing, so it stops). */
const TERMINAL_PROBES = 3;

// Sized to the lane, not to a wish: every step is a real transaction, so the budget is wall-clock.
// 64 x 20 lands around 4 s locally, well inside the package's 30 s `testTimeout`.
const SEEDS = 64;
const MAX_STEPS = 20;
const PINNED = process.env.RAYSPEC_TRANSITION_SEED;
const SEED_LIST = PINNED ? [Number(PINNED)] : Array.from({ length: SEEDS }, (_unused, i) => i + 1);

describe.skipIf(!hasDb)('randomized transition sequences through applyTransition (db)', () => {
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
      'TRUNCATE workforce_tasks, workforce_task_transitions, run_events CASCADE;',
    );
    await seedOrgs(db);
  });

  const tdb = () => forTenant(db, TENANT_A);

  /** The row as the database holds it — what a refusal must leave byte-identical. */
  async function rowOf(taskId: string) {
    const rows = await db.$client.unsafe(
      `SELECT status, status_reason, version FROM workforce_tasks WHERE task_id = '${taskId}';`,
    );
    return rows[0] as { status: string; status_reason: string | null; version: number };
  }

  it('every seeded walk: refusals mutate nothing, acceptances move exactly one version and log exactly one row', async () => {
    for (const seed of SEED_LIST) {
      const rand = prng(seed);
      const task = await createRootTask(tdb(), {
        workforceId: 'wf',
        title: `Walk ${seed}`,
        goal: 'Drive a randomized transition sequence through the engine.',
        owner: 'worker',
        requestedBy: 'user',
      });
      const path: string[] = ['planned'];
      let accepted = 0;
      let status: TaskStatus = 'planned';
      let version = task.version;

      try {
        for (let step = 0; step < MAX_STEPS; step++) {
          const where = `seed ${seed} step ${step} (from '${status}')`;

          // TERMINAL IS ABSORBING, at the engine and not merely in the table: from here every one of
          // the nine targets is refused, and the walk is over.
          if (isTerminalStatus(status)) {
            for (let probe = 0; probe < TERMINAL_PROBES; probe++) {
              const to = pick(rand, TASK_STATUSES);
              await expect(
                applyTransition(tdb(), {
                  taskId: task.taskId,
                  expectedVersion: version,
                  to,
                  actor: 'system',
                }),
                `${where}: terminal must refuse -> '${to}'`,
              ).rejects.toBeInstanceOf(TaskTransitionIllegalError);
              path.push(`(refused ${to})`);
            }
            break;
          }

          const before = await rowOf(task.taskId);
          const illegal = illegalTargets(status);
          // ~30% of steps probe an ILLEGAL pair; the rest advance the walk.
          if (rand() < 0.3 && illegal.length > 0) {
            const to = pick(rand, illegal);
            await expect(
              applyTransition(tdb(), {
                taskId: task.taskId,
                expectedVersion: version,
                to,
                actor: 'system',
              }),
              `${where}: illegal pair -> '${to}' must be a typed refusal`,
            ).rejects.toBeInstanceOf(TaskTransitionIllegalError);
            expect(await rowOf(task.taskId), `${where}: illegal pair mutated the row`).toEqual(
              before,
            );
            path.push(`(refused ${to})`);
            continue;
          }

          const to = pick(rand, legalTargets(status));
          const badReasons = illegalReasons(to);
          // ~30% of the remaining steps probe an OFF-VOCABULARY reason on a LEGAL pair — the arm the
          // pure suite cannot reach at all, because it never randomizes reasons.
          if (rand() < 0.3) {
            const reason =
              badReasons.length > 0 && rand() < 0.7
                ? (pick(rand, badReasons) as string)
                : FREE_TEXT_REASON;
            await expect(
              applyTransition(tdb(), {
                taskId: task.taskId,
                expectedVersion: version,
                to,
                reason,
                actor: 'system',
              }),
              `${where}: reason '${reason}' is not legal for '${to}' and must be refused`,
            ).rejects.toBeInstanceOf(StatusReasonInvalidError);
            expect(await rowOf(task.taskId), `${where}: bad reason mutated the row`).toEqual(
              before,
            );
            path.push(`(refused ${to}/${reason})`);
            continue;
          }

          // The accepted move: a legal pair with a legal reason, or none.
          const good = legalReasons(to);
          const reason =
            good.length > 0 && rand() < 0.6 ? (pick(rand, good) as StatusReason) : null;
          const moved = await applyTransition(tdb(), {
            taskId: task.taskId,
            expectedVersion: version,
            to,
            reason,
            actor: 'system',
          });
          expect(moved.status, `${where}: accepted -> '${to}' must land`).toBe(to);
          expect(moved.statusReason, `${where}: stored reason for '${to}'`).toBe(reason);
          expect(moved.version, `${where}: version must move by exactly one`).toBe(version + 1);
          accepted++;
          status = to;
          version = moved.version;
          path.push(reason === null ? to : `${to}(${reason})`);
        }

        // ── whole-walk invariants, on the durable artifacts ──────────────────────────────────────
        const log = (await db.$client.unsafe(
          `SELECT from_status, to_status FROM workforce_task_transitions WHERE task_id = '${task.taskId}' ORDER BY created_at, id;`,
        )) as unknown as { from_status: string; to_status: string }[];
        // A refusal appends NOTHING: the audit spine has exactly one row per accepted move.
        expect(log.length, `seed ${seed}: one log row per accepted move`).toBe(accepted);
        // Every re-entry into execution departed from `queued` — asserted on the WRITTEN log, so a
        // second door would have to survive the engine, not just the table.
        for (const entry of log) {
          if (entry.to_status === 'working') {
            expect(
              entry.from_status,
              `seed ${seed}: working entered from '${entry.from_status}'`,
            ).toBe('queued');
          }
        }
        // Terminal at most once: nothing leaves a terminal row, so nothing can re-enter one.
        const terminalEntries = log.filter((e) => isTerminalStatus(e.to_status as TaskStatus));
        expect(
          terminalEntries.length,
          `seed ${seed}: terminal entered more than once`,
        ).toBeLessThanOrEqual(1);
        // The journal agrees with the log: one `transitioned` event per accepted move.
        const journalled = await db.$client.unsafe(
          `SELECT count(*)::int AS c FROM run_events WHERE run_id = '${task.taskId}' AND type = 'workforce.task.transitioned';`,
        );
        expect(journalled[0]?.c, `seed ${seed}: one transitioned event per accepted move`).toBe(
          accepted,
        );
      } catch (err) {
        // The seed IS the test case: this is the one line a red CI run needs to reproduce locally.
        console.error(
          `[transitions.property.db] FAILING SEED = ${seed} — reproduce with ` +
            `RAYSPEC_TRANSITION_SEED=${seed}. Path: ${path.join(' -> ')}`,
        );
        throw err;
      }
    }
  });
});
