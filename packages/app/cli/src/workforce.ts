/**
 * The `workforce` command group — the operator's console for the durable task engine, speaking to a
 * RUNNING deployment over its authenticated HTTP API. Unlike the spec-oriented diagnostic floor,
 * every command here reads or mutates LIVE tenant state; the transport resolution, credential and
 * tenant rules live in ./workforce/transport.ts and are fail-closed throughout (no localhost guess,
 * no unauthenticated fallback, no local authorization — a permission gap is the route's own 403,
 * surfaced verbatim).
 *
 * Commands (JSON on stdout, exit 0 ok / 1 not-ok / 2 usage):
 *   workforce status --workforce <id>          control state, task counts, queue depth, headroom
 *   workforce tasks [--status] [--owner] [--tree]   list tasks (--tree nests by parent)
 *   workforce task <id>                        one task
 *   workforce approvals list                   the pending inbox
 *   workforce approvals approve <id> [--reason]
 *   workforce approvals reject <id> --reason <text>
 *   workforce cost [--window 24h]              per-scope settled/reserved roll-up
 *   workforce events <task-id>                 the task's journal replay (parsed SSE frames)
 *   workforce pause [--drain] --workforce <id>
 *   workforce resume --workforce <id>
 *   workforce halt --reason <text> --workforce <id>
 * Shared flags on every command: --url, --api-key, --deployment, --tenant.
 */
import { parseArgs } from 'node:util';
import {
  errorsFrom,
  resolveTransport,
  type WorkforceApiResult,
  WorkforceCliError,
  type WorkforceTransport,
  workforceRequest,
} from './workforce/transport.js';

export { WorkforceCliError };

export interface WorkforceResult {
  readonly ok: boolean;
  readonly command: string;
  readonly [key: string]: unknown;
}

/** The transport flags every subcommand shares. */
const TRANSPORT_OPTIONS = {
  url: { type: 'string' },
  'api-key': { type: 'string' },
  deployment: { type: 'string' },
  tenant: { type: 'string' },
} as const;

type ParsedCommon = {
  positionals: string[];
  values: Record<string, string | boolean | undefined>;
};

function parse(
  args: readonly string[],
  extra: Record<string, { type: 'string' | 'boolean' }> = {},
  allowPositionals = false,
): ParsedCommon {
  try {
    const { positionals, values } = parseArgs({
      args: [...args],
      allowPositionals,
      strict: true,
      options: { ...TRANSPORT_OPTIONS, ...extra },
    });
    return { positionals, values: values as ParsedCommon['values'] };
  } catch (e) {
    throw new WorkforceCliError(`invalid arguments: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function transportFrom(values: ParsedCommon['values']): Promise<WorkforceTransport> {
  return resolveTransport({
    ...(typeof values.url === 'string' ? { url: values.url } : {}),
    ...(typeof values['api-key'] === 'string' ? { apiKey: values['api-key'] } : {}),
    ...(typeof values.deployment === 'string' ? { deployment: values.deployment } : {}),
    ...(typeof values.tenant === 'string' ? { tenant: values.tenant } : {}),
  });
}

function requireWorkforceId(values: ParsedCommon['values']): string {
  const id = values.workforce;
  if (typeof id !== 'string' || id.length === 0) {
    throw new WorkforceCliError(
      'missing --workforce <id> (this deployment surface addresses a workforce by its id)',
    );
  }
  return id;
}

/** A 2xx becomes `{ok:true, command, ...payload}`; anything else relays the route's envelope. */
function outcome(
  command: string,
  res: WorkforceApiResult,
  payload: Record<string, unknown>,
): WorkforceResult {
  if (res.status >= 200 && res.status < 300) return { ok: true, command, ...payload };
  return { ok: false, command, errors: errorsFrom(res) };
}

export async function runWorkforce(args: readonly string[]): Promise<WorkforceResult> {
  const sub = args[0];
  const rest = args.slice(1);
  if (sub === undefined) {
    throw new WorkforceCliError(
      'missing workforce subcommand (expected `status`, `tasks`, `task`, `approvals`, `cost`, `events`, `pause`, `resume`, or `halt`)',
    );
  }
  switch (sub) {
    case 'status':
      return runStatus(rest);
    case 'tasks':
      return runTasks(rest);
    case 'task':
      return runTask(rest);
    case 'approvals':
      return runApprovals(rest);
    case 'cost':
      return runCost(rest);
    case 'events':
      return runEvents(rest);
    case 'pause':
      return runPause(rest);
    case 'resume':
      return runResume(rest);
    case 'halt':
      return runHalt(rest);
    default:
      throw new WorkforceCliError(
        `unknown workforce subcommand ${JSON.stringify(sub)} (expected \`status\`, \`tasks\`, \`task\`, \`approvals\`, \`cost\`, \`events\`, \`pause\`, \`resume\`, or \`halt\`)`,
      );
  }
}

async function runStatus(args: readonly string[]): Promise<WorkforceResult> {
  const { values } = parse(args, { workforce: { type: 'string' } });
  const workforceId = requireWorkforceId(values);
  const t = await transportFrom(values);
  const res = await workforceRequest(
    t,
    'GET',
    `/v1/workforce/${encodeURIComponent(workforceId)}/status`,
  );
  return outcome('workforce status', res, { status: res.body });
}

interface TaskNode {
  readonly taskId: string;
  readonly parentTaskId: string | null;
  children?: TaskNode[];
  [key: string]: unknown;
}

/** The most pages one `tasks` walk may pull (bounded memory; 200 rows/page = 200k tasks). */
const MAX_TASK_PAGES = 1000;

/**
 * Walk the task list by FOLLOWING the server's X-Next-Cursor header — the cursor is the server's
 * opaque contract, never re-derived client-side (a re-derived cursor goes stale the day the
 * server changes its encoding). Bounded: past MAX_TASK_PAGES the walk stops and says so.
 */
async function listAllTasks(
  t: WorkforceTransport,
  query: string,
): Promise<{ rows: TaskNode[]; truncated: boolean; error?: WorkforceApiResult }> {
  const rows: TaskNode[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_TASK_PAGES; page++) {
    const path = `/v1/workforce/tasks?limit=200${query}${cursor !== undefined ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await workforceRequest(t, 'GET', path);
    if (res.status < 200 || res.status >= 300) return { rows, truncated: false, error: res };
    rows.push(...(res.body as TaskNode[]));
    const next = res.headers['x-next-cursor'];
    if (res.headers['x-result-truncated'] !== 'true' || next === undefined) {
      return { rows, truncated: false };
    }
    cursor = next;
  }
  return { rows, truncated: true };
}

async function runTasks(args: readonly string[]): Promise<WorkforceResult> {
  const { values } = parse(args, {
    status: { type: 'string' },
    owner: { type: 'string' },
    workforce: { type: 'string' },
    tree: { type: 'boolean' },
  });
  const t = await transportFrom(values);
  let query = '';
  if (typeof values.status === 'string') query += `&status=${encodeURIComponent(values.status)}`;
  if (typeof values.owner === 'string') query += `&owner=${encodeURIComponent(values.owner)}`;
  if (typeof values.workforce === 'string') {
    query += `&workforceId=${encodeURIComponent(values.workforce)}`;
  }
  const { rows, truncated, error } = await listAllTasks(t, query);
  if (error) return outcome('workforce tasks', error, {});
  if (values.tree !== true) {
    return { ok: true, command: 'workforce tasks', tasks: rows, truncated };
  }

  // --tree: nest by parentTaskId. A child whose parent fell outside the filter stays a root of its
  // own subtree (never dropped, never re-parented).
  const byId = new Map<string, TaskNode>(rows.map((r) => [r.taskId, { ...r, children: [] }]));
  const roots: TaskNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentTaskId !== null ? byId.get(node.parentTaskId) : undefined;
    if (parent) (parent.children as TaskNode[]).push(node);
    else roots.push(node);
  }
  return { ok: true, command: 'workforce tasks', tree: roots, truncated };
}

async function runTask(args: readonly string[]): Promise<WorkforceResult> {
  const { values, positionals } = parse(args, {}, true);
  const taskId = positionals[0];
  if (taskId === undefined || positionals.length !== 1) {
    throw new WorkforceCliError('expected exactly one task id: `workforce task <id>`');
  }
  const t = await transportFrom(values);
  const res = await workforceRequest(t, 'GET', `/v1/workforce/tasks/${encodeURIComponent(taskId)}`);
  return outcome('workforce task', res, { task: res.body });
}

async function runApprovals(args: readonly string[]): Promise<WorkforceResult> {
  const action = args[0];
  const rest = args.slice(1);
  if (action === 'list' || action === undefined) {
    const { values } = parse(rest);
    const t = await transportFrom(values);
    const res = await workforceRequest(t, 'GET', '/v1/workforce/approvals?status=pending');
    return outcome('workforce approvals list', res, { approvals: res.body });
  }
  if (action === 'approve' || action === 'reject') {
    const { values, positionals } = parse(rest, { reason: { type: 'string' } }, true);
    const approvalId = positionals[0];
    if (approvalId === undefined || positionals.length !== 1) {
      throw new WorkforceCliError(
        `expected exactly one approval id: \`workforce approvals ${action} <id>\``,
      );
    }
    if (action === 'reject' && typeof values.reason !== 'string') {
      throw new WorkforceCliError(
        'a rejection carries its reason: `workforce approvals reject <id> --reason <text>`',
      );
    }
    const t = await transportFrom(values);
    const res = await workforceRequest(
      t,
      'POST',
      `/v1/workforce/approvals/${encodeURIComponent(approvalId)}/decide`,
      {
        decision: action === 'approve' ? 'approve' : 'reject',
        ...(typeof values.reason === 'string' ? { reason: values.reason } : {}),
      },
    );
    return outcome(`workforce approvals ${action}`, res, { approval: res.body });
  }
  throw new WorkforceCliError(
    `unknown approvals action ${JSON.stringify(action)} (expected \`list\`, \`approve\`, or \`reject\`)`,
  );
}

async function runCost(args: readonly string[]): Promise<WorkforceResult> {
  const { values } = parse(args, { window: { type: 'string' } });
  const t = await transportFrom(values);
  const query =
    typeof values.window === 'string' ? `?window=${encodeURIComponent(values.window)}` : '';
  const res = await workforceRequest(t, 'GET', `/v1/workforce/cost${query}`);
  return outcome('workforce cost', res, { cost: res.body });
}

async function runEvents(args: readonly string[]): Promise<WorkforceResult> {
  const { values, positionals } = parse(args, {}, true);
  const taskId = positionals[0];
  if (taskId === undefined || positionals.length !== 1) {
    throw new WorkforceCliError('expected exactly one task id: `workforce events <task-id>`');
  }
  const t = await transportFrom(values);
  const res = await workforceRequest(
    t,
    'GET',
    `/v1/workforce/tasks/${encodeURIComponent(taskId)}/events`,
  );
  if (res.status < 200 || res.status >= 300) return outcome('workforce events', res, {});
  // The route replays SSE one-shot; parse the frames into plain JSON events for the console.
  const frames =
    typeof res.body === 'string'
      ? res.body
          .split('\n\n')
          .map((frame) => {
            const data = frame
              .split('\n')
              .find((line) => line.startsWith('data:'))
              ?.slice(5)
              .trim();
            if (data === undefined) return undefined;
            try {
              return JSON.parse(data) as unknown;
            } catch {
              return undefined;
            }
          })
          .filter((f) => f !== undefined)
      : [];
  return { ok: true, command: 'workforce events', taskId, events: frames };
}

async function runPause(args: readonly string[]): Promise<WorkforceResult> {
  const { values } = parse(args, { workforce: { type: 'string' }, drain: { type: 'boolean' } });
  const workforceId = requireWorkforceId(values);
  const t = await transportFrom(values);
  const res = await workforceRequest(
    t,
    'POST',
    `/v1/workforce/${encodeURIComponent(workforceId)}/pause`,
    { drain: values.drain === true },
  );
  return outcome('workforce pause', res, { result: res.body });
}

async function runResume(args: readonly string[]): Promise<WorkforceResult> {
  const { values } = parse(args, { workforce: { type: 'string' } });
  const workforceId = requireWorkforceId(values);
  const t = await transportFrom(values);
  const res = await workforceRequest(
    t,
    'POST',
    `/v1/workforce/${encodeURIComponent(workforceId)}/resume`,
  );
  return outcome('workforce resume', res, { result: res.body });
}

async function runHalt(args: readonly string[]): Promise<WorkforceResult> {
  const { values } = parse(args, { workforce: { type: 'string' }, reason: { type: 'string' } });
  const workforceId = requireWorkforceId(values);
  if (typeof values.reason !== 'string' || values.reason.length === 0) {
    throw new WorkforceCliError(
      'a halt carries its reason: `workforce halt --reason <text> --workforce <id>`',
    );
  }
  const t = await transportFrom(values);
  const res = await workforceRequest(
    t,
    'POST',
    `/v1/workforce/${encodeURIComponent(workforceId)}/halt`,
    { reason: values.reason },
  );
  return outcome('workforce halt', res, { result: res.body });
}
