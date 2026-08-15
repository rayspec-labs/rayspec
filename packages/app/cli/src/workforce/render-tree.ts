/**
 * The task-tree TEXT RENDERING — a pure, byte-deterministic function from task rows to the
 * operator's console view: one goal line (title, root id, subtree cost against the per-task
 * ceiling, turns), then every node with its status, its reason when parked, its confidence when
 * it carries one, and its settled cost in an aligned column. This rendering IS the contract the
 * acceptance story pins byte-for-byte, so every formatting rule lives HERE and nowhere else:
 *
 *   - node order: children by task id ascending — DETERMINISTIC, not creation order (task ids
 *     are random/hash UUIDs, so id order carries no timeline);
 *   - labels: the root renders its OWNER (the seat the goal entered through), every other node
 *     its TITLE (what the delegation named the work);
 *   - annotations: `[status]`, or `[status: reason]` when a reason is set; then the confidence
 *     to two decimals when the row carries one; then the aligned `$` column;
 *   - numbers: `Number(...).toFixed(2)` only — driver numerics arrive as strings, and no locale
 *     may reorder or reformat anything;
 *   - orphans (rows whose parent fell outside a TRUNCATED read) render as extra top-level
 *     subtrees after the root — never dropped, never re-parented;
 *   - a truncated read says so on its last line, because a tree that silently misses nodes reads
 *     as a workforce that did less work.
 */

export interface TreeTaskRow {
  readonly taskId: string;
  readonly parentTaskId: string | null;
  readonly title: string;
  readonly owner: string;
  readonly status: string;
  readonly statusReason: string | null;
  readonly confidence: string | number | null;
  readonly costUsd: string | number;
  readonly turnsUsed: number;
}

export interface TreeBudgets {
  readonly taskUsd: number | null;
}

const usd = (value: string | number): string => `$${Number(value).toFixed(2)}`;

interface Line {
  readonly prefix: string;
  readonly cost: string;
}

function annotate(row: TreeTaskRow, label: string): string {
  const reason = row.statusReason !== null ? `: ${row.statusReason}` : '';
  const confidence = row.confidence !== null ? ` ${Number(row.confidence).toFixed(2)}` : '';
  return `${label} [${row.status}${reason}]${confidence}`;
}

/** Render one subtree depth-first; `stem` accumulates the ancestor glyph columns. */
function renderNode(
  row: TreeTaskRow,
  childrenOf: ReadonlyMap<string, readonly TreeTaskRow[]>,
  stem: string,
  lines: Line[],
): void {
  const children = childrenOf.get(row.taskId) ?? [];
  children.forEach((child, index) => {
    const last = index === children.length - 1;
    lines.push({
      prefix: `${stem}${last ? '└─ ' : '├─ '}${annotate(child, child.title)}`,
      cost: usd(child.costUsd),
    });
    renderNode(child, childrenOf, `${stem}${last ? '   ' : '│  '}`, lines);
  });
}

export function renderTaskTree(
  rows: readonly TreeTaskRow[],
  budgets: TreeBudgets | null,
  truncated: boolean,
): string {
  const byId = new Set(rows.map((row) => row.taskId));
  const sorted = [...rows].sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
  const childrenOf = new Map<string, TreeTaskRow[]>();
  const topLevel: TreeTaskRow[] = [];
  for (const row of sorted) {
    if (row.parentTaskId !== null && byId.has(row.parentTaskId)) {
      const siblings = childrenOf.get(row.parentTaskId) ?? [];
      siblings.push(row);
      childrenOf.set(row.parentTaskId, siblings);
    } else {
      // The root — or an orphan whose parent fell outside a truncated read. Kept as its own
      // top-level subtree, never dropped, never re-parented.
      topLevel.push(row);
    }
  }
  const root = topLevel.find((row) => row.parentTaskId === null) ?? topLevel[0];
  if (root === undefined)
    return truncated ? '(no tasks)\n… truncated at the server cap' : '(no tasks)';

  const subtreeCost = rows.reduce((sum, row) => sum + Number(row.costUsd), 0);
  const subtreeTurns = rows.reduce((sum, row) => sum + row.turnsUsed, 0);
  const ceiling = budgets?.taskUsd != null ? usd(budgets.taskUsd) : '—';
  const header = `Goal: ${root.title}  (${root.taskId} · ${usd(subtreeCost)} / ${ceiling} · ${subtreeTurns} turns)`;

  const lines: Line[] = [];
  lines.push({ prefix: annotate(root, root.owner), cost: usd(root.costUsd) });
  renderNode(root, childrenOf, '', lines);
  for (const orphan of topLevel.filter((row) => row !== root)) {
    lines.push({ prefix: annotate(orphan, orphan.title), cost: usd(orphan.costUsd) });
    renderNode(orphan, childrenOf, '', lines);
  }

  const width = Math.max(...lines.map((line) => line.prefix.length)) + 2;
  const body = lines.map((line) => `${line.prefix.padEnd(width)}${line.cost}`);
  return [header, '', ...body, ...(truncated ? ['… truncated at the server cap'] : [])].join('\n');
}
