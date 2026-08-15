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

  it('orders siblings by task id and is byte-deterministic across runs', () => {
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
});
