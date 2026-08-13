/**
 * Join policy + the DETERMINISTIC merge. The load-bearing test is the 100-run identity: whatever
 * order the children "finish" in (and whatever order their rows arrive in), the merged bytes are
 * identical — nothing downstream can observe completion order.
 */
import { describe, expect, it } from 'vitest';
import type { TaskRecord } from './apply-transition.js';
import { isJoinSatisfied, joinPolicySchema, mergeChildResults } from './join.js';

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
});

describe('isJoinSatisfied (all)', () => {
  it('holds only when every child is terminal — failed and cancelled count as terminal', () => {
    const done = [fakeChild('a', 'completed', 'x'), fakeChild('b', 'failed', 'y')];
    expect(isJoinSatisfied({ policy: 'all' }, done)).toBe(true);
    expect(isJoinSatisfied({ policy: 'all' }, [...done, fakeChild('c', 'working', 'z')])).toBe(
      false,
    );
  });

  it('an empty child set satisfies nothing', () => {
    expect(isJoinSatisfied({ policy: 'all' }, [])).toBe(false);
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

  it('canonicalization sorts nested result keys too', () => {
    const a = fakeChild('c1', 'completed', 's');
    const b = {
      ...a,
      result: { summary: 's', status: 'completed', confidence: 0.8, findings: [] },
    } as unknown as TaskRecord;
    expect(mergeChildResults([a]).canonicalJson).toBe(mergeChildResults([b]).canonicalJson);
  });
});
