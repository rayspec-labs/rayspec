/**
 * Join policy + the DETERMINISTIC merge. The load-bearing test is the 100-run identity: whatever
 * order the children "finish" in (and whatever order their rows arrive in), the merged bytes are
 * identical — nothing downstream can observe completion order.
 */
import { describe, expect, it } from 'vitest';
import type { TaskRecord } from './apply-transition.js';
import {
  fanOutJoinPolicySchema,
  isJoinSatisfied,
  joinPolicySchema,
  mergeChildResults,
} from './join.js';

function fakeChild(taskId: string, status: string, summary: string): TaskRecord {
  return {
    taskId,
    status,
    statusReason: null,
    result: { status: 'completed', summary, findings: [], confidence: 0.8 },
    confidence: '0.8',
    costUsd: '0.1',
    turnsUsed: 1,
  } as unknown as TaskRecord;
}

/** mulberry32 — deterministic shuffle source (the seed IS the case identity). */
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

function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const a = out[i] as T;
    out[i] = out[j] as T;
    out[j] = a;
  }
  return out;
}

describe('joinPolicySchema', () => {
  it('is a strict object over a closed enum', () => {
    expect(joinPolicySchema.safeParse({ policy: 'all' }).success).toBe(true);
    expect(joinPolicySchema.safeParse({ policy: 'any' }).success).toBe(false);
    expect(joinPolicySchema.safeParse({ policy: 'all', count: 2 }).success).toBe(false);
    expect(joinPolicySchema.safeParse('all').success).toBe(false);
  });

  it('carries the escalation binding on the column, but never on a fan-out intent', () => {
    expect(
      joinPolicySchema.safeParse({ policy: 'escalation', escalationTaskId: 'task_e' }).success,
    ).toBe(true);
    expect(
      fanOutJoinPolicySchema.safeParse({ policy: 'escalation', escalationTaskId: 'task_e' })
        .success,
    ).toBe(false);
  });
});

describe('isJoinSatisfied (escalation)', () => {
  it('only the bound child terminal counts — a terminal sibling never satisfies it', () => {
    const bound = { policy: 'escalation', escalationTaskId: 'c-esc' } as const;
    expect(isJoinSatisfied(bound, [fakeChild('c-sibling', 'completed', 'x')])).toBe(false);
    expect(isJoinSatisfied(bound, [fakeChild('c-esc', 'working', 'y')])).toBe(false);
    expect(isJoinSatisfied(bound, [fakeChild('c-esc', 'completed', 'y')])).toBe(true);
  });
});

describe('isJoinSatisfied (all)', () => {
  it('holds only when every BOUND child is terminal — failed and cancelled count as terminal', () => {
    const bound = { policy: 'all', childTaskIds: ['a', 'b'] } as const;
    const done = [fakeChild('a', 'completed', 'x'), fakeChild('b', 'failed', 'y')];
    expect(isJoinSatisfied(bound, done)).toBe(true);
    expect(isJoinSatisfied(bound, [...done, fakeChild('c', 'working', 'z')])).toBe(true);
    expect(
      isJoinSatisfied(bound, [fakeChild('a', 'completed', 'x'), fakeChild('b', 'working', 'y')]),
    ).toBe(false);
  });

  it('a binding-less park waits on nothing and is never satisfied — there is no whole-child reading', () => {
    // The compat fallback is deliberately gone: a second join semantic beside the real one is the
    // very bug the binding fixes, kept alive for rows that do not exist on this branch.
    expect(isJoinSatisfied({ policy: 'all' }, [])).toBe(false);
    expect(isJoinSatisfied({ policy: 'all' }, [fakeChild('a', 'completed', 'x')])).toBe(false);
  });

  it('a BOUND join waits on its own round and ignores every other child of the parent', () => {
    const bound = { policy: 'all', childTaskIds: ['a', 'b'] } as const;
    const detached = fakeChild('detached', 'blocked', 'a buffered fire-and-forget child');
    // The detached child never terminates; the round's own children do. Without the binding this
    // parent stays in `awaiting_children` — the one park no operator signal may release.
    expect(
      isJoinSatisfied(bound, [
        fakeChild('a', 'completed', 'x'),
        fakeChild('b', 'cancelled', 'y'),
        detached,
      ]),
    ).toBe(true);
    // A bound child that is missing or still running holds the join open, terminal siblings or not.
    expect(isJoinSatisfied(bound, [fakeChild('a', 'completed', 'x'), detached])).toBe(false);
    expect(
      isJoinSatisfied(bound, [fakeChild('a', 'completed', 'x'), fakeChild('b', 'working', 'y')]),
    ).toBe(false);
  });

  it('an empty binding satisfies nothing, exactly as an empty child set does', () => {
    expect(isJoinSatisfied({ policy: 'all', childTaskIds: [] }, [])).toBe(false);
    expect(
      isJoinSatisfied({ policy: 'all', childTaskIds: [] }, [fakeChild('a', 'completed', 'x')]),
    ).toBe(false);
  });
});

describe('mergeChildResults determinism', () => {
  const children = [
    fakeChild('c-delta', 'completed', 'fourth by id'),
    fakeChild('c-alpha', 'completed', 'first by id'),
    fakeChild('c-charlie', 'failed', 'third by id'),
    fakeChild('c-bravo', 'completed', 'second by id'),
  ];

  it('keys by child task id, never by order', () => {
    const { byChildId } = mergeChildResults(children);
    expect(Object.keys(byChildId)).toEqual(['c-alpha', 'c-bravo', 'c-charlie', 'c-delta']);
  });

  it('100 runs over shuffled completion orders produce byte-identical merged output', () => {
    const reference = mergeChildResults(children).canonicalJson;
    for (let run = 1; run <= 100; run++) {
      const rand = prng(run);
      const { canonicalJson } = mergeChildResults(shuffled(children, rand));
      expect(canonicalJson, `run ${run}`).toBe(reference);
    }
  });

  it('the canonical bytes are PINNED — self-consistency alone would pass a gutted serializer', () => {
    const child = {
      taskId: 'c-alpha',
      status: 'completed',
      statusReason: null,
      result: { status: 'completed', summary: 'first', findings: [], confidence: 0.8 },
      confidence: '0.8',
      costUsd: '0.1',
      turnsUsed: 1,
    } as unknown as TaskRecord;
    expect(mergeChildResults([child]).canonicalJson).toBe(
      '{"c-alpha":{"confidence":"0.8","costUsd":"0.1","result":{"confidence":0.8,"findings":[],' +
        '"status":"completed","summary":"first"},"status":"completed","statusReason":null,' +
        '"turnsUsed":1}}',
    );
  });

  it('canonicalization sorts nested result keys too', () => {
    const a = fakeChild('c1', 'completed', 's');
    const b = {
      ...a,
      result: { summary: 's', status: 'completed', confidence: 0.8, findings: [] },
    } as unknown as TaskRecord;
    expect(mergeChildResults([a]).canonicalJson).toBe(mergeChildResults([b]).canonicalJson);
  });
});
