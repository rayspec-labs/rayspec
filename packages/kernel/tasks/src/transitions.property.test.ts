/**
 * Property suite over the transition GRAPH: random transition sequences (a seeded, deterministic
 * PRNG — reproducible in CI, no randomness in the verdict) plus the static graph facts the walks
 * rest on. The three properties, stated once:
 *
 *   1. No sequence reaches a terminal status twice — terminal rows are absorbing, so once a walk
 *      terminates it can take no further step.
 *   2. No sequence leaves a task with no path to terminal — every status reachable from `planned`
 *      retains a path to a terminal status (no dead ends, no live-lock pocket).
 *   3. Every re-entry into execution goes through `queued` — any step that lands on `working`
 *      departed from `queued`, in every walk and statically in the table.
 *
 * SCOPE, stated so nobody reads more into a green run than is there: `successors()` below is derived
 * FROM the table under test, so this suite finds graph-shape defects and nothing else. It never
 * calls `applyTransition`, never touches a row, and never randomizes REASONS. The engine-level half
 * — the same seeded walk driven through the real `applyTransition` against real Postgres, with
 * randomized `statusReason` values checked against `REASON_RULES` — is `transitions.property.db.test.ts`.
 * This file stays pure so it keeps running in the no-database lane.
 */
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_TRANSITIONS,
  isTerminalStatus,
  TASK_STATUSES,
  type TaskStatus,
  TERMINAL_STATUSES,
} from './status.js';

/** mulberry32 — a tiny deterministic PRNG; the seed IS the test case identity. */
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

function successors(from: TaskStatus): TaskStatus[] {
  return TASK_STATUSES.filter((to) => ALLOWED_TRANSITIONS[from][to]);
}

/** Statuses reachable from `start` by following the table. */
function reachableFrom(start: TaskStatus): Set<TaskStatus> {
  const seen = new Set<TaskStatus>([start]);
  const queue: TaskStatus[] = [start];
  for (let head = queue.shift(); head !== undefined; head = queue.shift()) {
    for (const next of successors(head)) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

describe('static graph facts', () => {
  it('every status is reachable from planned (no orphaned status)', () => {
    expect([...reachableFrom('planned')].sort()).toEqual([...TASK_STATUSES].sort());
  });

  it('every non-terminal status retains a path to a terminal one (no dead end)', () => {
    for (const status of TASK_STATUSES) {
      if (isTerminalStatus(status)) continue;
      const reach = reachableFrom(status);
      const terminates = TERMINAL_STATUSES.some((t) => reach.has(t));
      expect(terminates, `'${status}' can still terminate`).toBe(true);
    }
  });

  it('terminal statuses are absorbing (zero successors)', () => {
    for (const t of TERMINAL_STATUSES) expect(successors(t)).toEqual([]);
  });

  it("'working' has exactly one predecessor: 'queued'", () => {
    const preds = TASK_STATUSES.filter((from) => ALLOWED_TRANSITIONS[from].working);
    expect(preds).toEqual(['queued']);
  });
});

describe('random transition sequences (seeded)', () => {
  const SEEDS = 250;
  const MAX_STEPS = 64;

  it('across all seeds: terminal at most once, never left; every working-entry from queued', () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const rand = prng(seed);
      let status: TaskStatus = 'planned';
      let terminalEntries = 0;
      const path: TaskStatus[] = [status];
      for (let step = 0; step < MAX_STEPS; step++) {
        const next = successors(status);
        // Property 1 (absorbing terminals): once terminal, the table offers NO further step —
        // a walk cannot reach a terminal status twice because it cannot move at all.
        if (next.length === 0) {
          expect(isTerminalStatus(status), `seed ${seed}: stuck non-terminal at '${status}'`).toBe(
            true,
          );
          break;
        }
        const to = next[Math.floor(rand() * next.length)] as TaskStatus;
        // Property 3: an entry into execution departed from `queued`.
        if (to === 'working') {
          expect(status, `seed ${seed}: working entered from '${status}'`).toBe('queued');
        }
        if (isTerminalStatus(to)) terminalEntries++;
        status = to;
        path.push(status);
      }
      expect(
        terminalEntries,
        `seed ${seed}: terminal entered more than once (${path.join(' -> ')})`,
      ).toBeLessThanOrEqual(1);
      // Property 2: wherever the walk stopped, termination is still reachable.
      const reach = reachableFrom(status);
      expect(
        isTerminalStatus(status) || TERMINAL_STATUSES.some((t) => reach.has(t)),
        `seed ${seed}: no path to terminal from '${status}'`,
      ).toBe(true);
    }
  });
});
