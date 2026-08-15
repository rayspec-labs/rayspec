/**
 * `workforce tasks --tree` — the CLI half of the tree contract, over a stubbed HTTP surface: the
 * single-root auto-select (and its fail-closed refusals naming the options), the --root direct
 * read, the text rendering as the ONE non-JSON output in the group, and --json keeping the
 * machine shape. The rendering bytes themselves are pinned in workforce/render-tree.test.ts; the
 * real end-to-end bytes are the acceptance story's.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWorkforce, WorkforceCliError } from './workforce.js';

const FLAGS = ['--url', 'http://127.0.0.1:9', '--api-key', 'rk_test'];

type Route = { match: (url: string) => boolean; body: unknown; headers?: Record<string, string> };

function stubFetch(routes: Route[]): string[] {
  const seen: string[] = [];
  vi.stubGlobal('fetch', (async (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    const route = routes.find((candidate) => candidate.match(url));
    if (!route) throw new Error(`unstubbed fetch: ${url}`);
    return new Response(JSON.stringify(route.body), {
      status: 200,
      headers: { 'content-type': 'application/json', ...(route.headers ?? {}) },
    });
  }) as typeof fetch);
  return seen;
}

const treeBody = {
  rootTaskId: 'root-1',
  tasks: [
    {
      taskId: 'root-1',
      parentTaskId: null,
      title: 'The goal',
      owner: 'lead',
      status: 'completed',
      statusReason: null,
      confidence: '0.9',
      costUsd: '0.10',
      turnsUsed: 2,
    },
  ],
  budgets: { taskUsd: 2.5, taskTurns: 20 },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('workforce tasks --tree', () => {
  it('auto-selects the single root, fetches its subtree, and returns the TEXT rendering', async () => {
    const seen = stubFetch([
      {
        match: (url) => url.includes('/v1/workforce/tasks?limit=200'),
        body: [{ taskId: 'root-1', parentTaskId: null }],
      },
      {
        match: (url) => url.includes('/v1/workforce/tasks/root-1/tree'),
        body: treeBody,
        headers: { 'x-result-truncated': 'false' },
      },
    ]);
    const result = await runWorkforce(['tasks', '--tree', ...FLAGS]);
    expect(result.ok).toBe(true);
    expect(typeof result.rendering).toBe('string');
    expect(result.rendering as string).toContain(
      'Goal: The goal  (root-1 · $0.10 / $2.50 · 2 turns)',
    );
    expect(seen.some((url) => url.includes('/tree'))).toBe(true);
  });

  it('--root reads the subtree directly (no list walk); --json keeps the machine shape', async () => {
    const seen = stubFetch([
      {
        match: (url) => url.includes('/v1/workforce/tasks/root-1/tree'),
        body: treeBody,
        headers: { 'x-result-truncated': 'true' },
      },
    ]);
    const result = await runWorkforce(['tasks', '--tree', '--root', 'root-1', '--json', ...FLAGS]);
    expect(result).toMatchObject({
      ok: true,
      command: 'workforce tasks',
      budgets: { taskUsd: 2.5, taskTurns: 20 },
      truncated: true,
    });
    expect(result.rendering).toBeUndefined();
    expect(Array.isArray(result.tree)).toBe(true);
    expect(seen).toHaveLength(1); // the walk never ran
  });

  it('refuses zero roots, several roots (naming them), filters with --tree, and tree flags without --tree', async () => {
    stubFetch([{ match: (url) => url.includes('/v1/workforce/tasks?limit=200'), body: [] }]);
    await expect(runWorkforce(['tasks', '--tree', ...FLAGS])).rejects.toThrow(
      /no root task exists/,
    );
    vi.unstubAllGlobals();

    stubFetch([
      {
        match: (url) => url.includes('/v1/workforce/tasks?limit=200'),
        body: [
          { taskId: 'root-a', parentTaskId: null },
          { taskId: 'root-b', parentTaskId: null },
        ],
      },
    ]);
    await expect(runWorkforce(['tasks', '--tree', ...FLAGS])).rejects.toThrow(
      /several root tasks exist.*root-a, root-b/s,
    );

    await expect(runWorkforce(['tasks', '--tree', '--status', 'queued', ...FLAGS])).rejects.toThrow(
      WorkforceCliError,
    );
    await expect(runWorkforce(['tasks', '--root', 'root-a', ...FLAGS])).rejects.toThrow(
      /--root and --json belong to/,
    );
    await expect(runWorkforce(['tasks', '--json', ...FLAGS])).rejects.toThrow(
      /--root and --json belong to/,
    );
  });
});

describe('workforce cost --by', () => {
  it('refuses anything outside the closed pair as usage, before any request', async () => {
    stubFetch([]); // any fetch would throw 'unstubbed'
    await expect(runWorkforce(['cost', '--by', 'task-class', ...FLAGS])).rejects.toThrow(
      /--by takes 'employee' or 'department'/,
    );
  });

  it('passes a legal --by through as the query parameter', async () => {
    const seen = stubFetch([
      { match: (url) => url.includes('/v1/workforce/cost'), body: { groups: [] } },
    ]);
    const result = await runWorkforce(['cost', '--by', 'employee', ...FLAGS]);
    expect(result.ok).toBe(true);
    expect(seen[0]).toContain('/v1/workforce/cost?by=employee');
  });
});
