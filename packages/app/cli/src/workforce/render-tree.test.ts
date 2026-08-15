/**
 * The tree rendering, byte-golden: the rendering IS the operator contract (the acceptance story
 * asserts the same bytes end to end), so these fixtures pin every formatting rule — glyphs,
 * ordering, annotations, alignment, the goal line's arithmetic, truncation, orphans — against a
 * literal expected string. A rendering change is a deliberate golden change, never a drift.
 */
import { describe, expect, it } from 'vitest';
import { renderTaskTree, type TreeTaskRow } from './render-tree.js';

function row(over: Partial<TreeTaskRow> & { taskId: string }): TreeTaskRow {
  return {
    parentTaskId: null,
    title: 'Untitled',
    owner: 'nobody',
    status: 'completed',
    statusReason: null,
    confidence: null,
    costUsd: '0',
    turnsUsed: 0,
    createdAt: '2020-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('renderTaskTree', () => {
  it('renders the canonical story tree byte-for-byte', () => {
    // Three levels, mixed states, driver-shaped numeric strings, a parked node with its reason,
    // confidence only where a result carries one.
    const rows: TreeTaskRow[] = [
      row({
        taskId: 't-00',
        owner: 'lead',
        title: 'Ship the release',
        status: 'working',
        costUsd: '0.05',
        turnsUsed: 1,
      }),
      row({
        taskId: 't-01',
        parentTaskId: 't-00',
        title: 'Engineering',
        status: 'working',
        costUsd: '0.91',
        turnsUsed: 2,
      }),
      row({
        taskId: 't-01-a',
        parentTaskId: 't-01',
        title: 'Principal work',
        status: 'completed',
        confidence: '0.82',
        costUsd: '0.31',
        turnsUsed: 1,
      }),
      row({
        taskId: 't-01-b',
        parentTaskId: 't-01',
        title: 'Release pipeline',
        status: 'blocked',
        statusReason: 'budget_exhausted',
        costUsd: '0.18',
        turnsUsed: 1,
      }),
      row({
        taskId: 't-02',
        parentTaskId: 't-00',
        title: 'Growth',
        status: 'completed',
        confidence: '0.77',
        costUsd: '0.62',
        turnsUsed: 2,
      }),
    ];
    expect(renderTaskTree(rows, { taskUsd: 2.5 }, false)).toBe(
      [
        'Goal: Ship the release  (t-00 · $2.07 / $2.50 · 7 turns)',
        '',
        'lead [working]                                      $0.05',
        '├─ Engineering [working]                            $0.91',
        '│  ├─ Principal work [completed] 0.82               $0.31',
        '│  └─ Release pipeline [blocked: budget_exhausted]  $0.18',
        '└─ Growth [completed] 0.77                          $0.62',
      ].join('\n'),
    );
  });

  it('renders a missing ceiling as a dash and $0.00 costs literally', () => {
    const rows = [row({ taskId: 'only', owner: 'solo', title: 'One task', status: 'queued' })];
    expect(renderTaskTree(rows, null, false)).toBe(
      ['Goal: One task  (only · $0.00 / — · 0 turns)', '', 'solo [queued]  $0.00'].join('\n'),
    );
  });

  it('keeps orphans as their own top-level subtrees and says when the read was truncated', () => {
    const rows = [
      row({ taskId: 'root', owner: 'lead', title: 'The goal', costUsd: '0.10' }),
      // An orphan: its parent fell outside the truncated read — rendered, never re-parented.
      row({
        taskId: 'stray-child',
        parentTaskId: 'gone-parent',
        title: 'Stray work',
        costUsd: '0.20',
      }),
      row({
        taskId: 'stray-grandchild',
        parentTaskId: 'stray-child',
        title: 'Stray leaf',
        costUsd: '0.05',
      }),
    ];
    const rendered = renderTaskTree(rows, { taskUsd: null }, true);
    expect(rendered).toBe(
      [
        'Goal: The goal  (root · $0.35 / — · 0 turns)',
        '',
        'lead [completed]           $0.10',
        'Stray work [completed]     $0.20',
        '└─ Stray leaf [completed]  $0.05',
        '… truncated at the server cap',
      ].join('\n'),
    );
  });

  it('orders siblings by (createdAt, title, taskId) and is byte-deterministic under any input order', () => {
    const rows = [
      row({ taskId: 'r', owner: 'lead', title: 'Root' }),
      row({ taskId: 'r-c', parentTaskId: 'r', title: 'Third' }),
      row({ taskId: 'r-a', parentTaskId: 'r', title: 'First' }),
      row({ taskId: 'r-b', parentTaskId: 'r', title: 'Second' }),
    ];
    const first = renderTaskTree(rows, null, false);
    const shuffled = renderTaskTree([...rows].reverse(), null, false);
    expect(shuffled).toBe(first);
    const a = first.indexOf('First');
    const b = first.indexOf('Second');
    const c = first.indexOf('Third');
    expect(a).toBeGreaterThan(-1);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
    expect(first).toContain('├─ First');
    expect(first).toContain('└─ Third');
  });

  // ── C9: createdAt is the PRIMARY sibling key (the real timeline across turns); a stable secondary
  // (title) breaks the same-fan-out tie, and the random-hash task id NEVER leaks into the order. ──
  it('C9: createdAt orders siblings before title, and the task id is only the final tiebreaker', () => {
    const rows = [
      row({ taskId: 'root', owner: 'lead', title: 'Root' }),
      // "Zeta" was created FIRST (earlier turn) → must render first, ahead of an alphabetically
      // earlier "Alpha" created later. A pure title (or id) sort would get this backwards.
      row({
        taskId: 'zzz',
        parentTaskId: 'root',
        title: 'Zeta',
        createdAt: '2020-01-01T00:00:01.000Z',
      }),
      row({
        taskId: 'aaa',
        parentTaskId: 'root',
        title: 'Alpha',
        createdAt: '2020-01-01T00:00:02.000Z',
      }),
    ];
    const rendered = renderTaskTree(rows, null, false);
    expect(rendered.indexOf('Zeta')).toBeLessThan(rendered.indexOf('Alpha'));
  });

  it('C9: a parallel fan-out (tied createdAt, random-order ids) renders byte-identically every time', () => {
    // Two departments fanned out in ONE transaction: identical createdAt, ids in NO meaningful order.
    // Whatever order the rows arrive in, the render is one fixed string — the flaky-proof, pinned.
    const fanOut = (engId: string, growthId: string): TreeTaskRow[] => [
      row({ taskId: 'root-id', owner: 'lead', title: 'Ship it', costUsd: '0.10' }),
      row({
        taskId: engId,
        parentTaskId: 'root-id',
        title: 'Engineering',
        costUsd: '0.08',
        confidence: '0.95',
      }),
      row({
        taskId: growthId,
        parentTaskId: 'root-id',
        title: 'Growth',
        costUsd: '0.12',
        confidence: '0.90',
      }),
    ];
    // The reviewer's live flake: Growth's hash sorted BEFORE Engineering's. Title breaks the tie so
    // Engineering is first regardless of which id happens to be smaller.
    const growthSmaller = renderTaskTree(fanOut('ffff', 'aaaa'), { taskUsd: 1 }, false);
    const engSmaller = renderTaskTree(fanOut('aaaa', 'ffff'), { taskUsd: 1 }, false);
    expect(engSmaller).toBe(growthSmaller); // id order must not change a single byte
    expect(growthSmaller).toMatch(/├─ Engineering \[completed\] 0\.95/);
    expect(growthSmaller).toMatch(/└─ Growth \[completed\] 0\.90/);
    // 20 renders over shuffled inputs: one canonical string.
    for (let i = 0; i < 20; i += 1) {
      const shuffled = [...fanOut('aaaa', 'ffff')].sort(() => (i % 2 === 0 ? 1 : -1));
      expect(renderTaskTree(shuffled, { taskUsd: 1 }, false)).toBe(growthSmaller);
    }
  });

  // ── C2: a model-authored title cannot inject a fabricated sibling line into the operator's view ──
  it('C2: strips CR/LF/ESC from a hostile title so it cannot forge a tree node', () => {
    const rows = [
      row({ taskId: 'root', owner: 'lead', title: 'Real goal' }),
      row({
        taskId: 'evil',
        parentTaskId: 'root',
        title: 'Benign\n└─ Injected [completed] 9.99                        $9.99\x1b[31m',
        costUsd: '0.01',
      }),
    ];
    const rendered = renderTaskTree(rows, null, false);
    // No standalone forged node line, no raw ESC anywhere.
    expect(
      rendered.split('\n').filter((l) => l.trimStart().startsWith('└─ Injected')),
    ).toHaveLength(0);
    expect(rendered).not.toContain('\x1b');
    expect(rendered).not.toContain('\n└─ Injected');
    // The (flattened) title bytes still appear on the node's own line — nothing is dropped.
    expect(rendered).toContain('Injected');
  });
});
