/**
 * The `workforce` command group — the operator's console for the durable task engine, speaking to a
 * RUNNING deployment over its authenticated HTTP API. Unlike the spec-oriented diagnostic floor,
 * every command here reads or mutates LIVE tenant state; the transport resolution, credential and
 * tenant rules live in ./workforce/transport.ts and are fail-closed throughout (no localhost guess,
 * no unauthenticated fallback, no local authorization — a permission gap is the route's own 403,
 * surfaced verbatim).
 *
 * Commands (JSON on stdout — except `tasks --tree`, which renders TEXT unless --json;
 * exit 0 ok / 1 not-ok / 2 usage):
 *   workforce status --workforce <id>          control state, task counts, queue depth,
 *                                              budgetExhausted + every declared ceiling's headroom
 *   workforce submit --workforce <id> --goal <text> [--description <text>] [--priority <p>]
 *                                               submit a goal; the strategy shapes it into tasks
 *   workforce tasks [--status] [--owner]       flat task list
 *   workforce tasks --tree [--root <task-id>] [--json]   render one whole subtree as text
 *   workforce task <id>                        one task
 *   workforce approvals list                   the pending inbox, plus the SIGNAL-PARKED tasks
 *                                               that carry no approval row (see runApprovals)
 *   workforce approvals approve <id> [--reason] [--override]
 *   workforce approvals reject <id> --reason <text> [--override]
 *   workforce signal <task-id> --kind <manual_unblock|budget_raised|user_reply>
 *                              [--payload <json>] [--signal-key <key>]
 *                                               release a task parked on a human
 *   workforce cancel <task-id> [--reason <text>]  cancel a task and its subtree — the
 *                                              lever for parks a signal may NOT release
 *   workforce cost [--window 24h] [--by employee|department]   settled/reserved roll-up
 *   workforce events <task-id>                 the task's journal replay (parsed SSE frames)
 *   workforce pause [--drain] --workforce <id>
 *   workforce resume --workforce <id>
 *   workforce halt --reason <text> --workforce <id>
 * Shared flags on every command: --url, --api-key, --deployment, --tenant.
 */
import { parseArgs } from 'node:util';
import { renderTaskTree, type TreeTaskRow } from './workforce/render-tree.js';
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
      'missing workforce subcommand (expected `status`, `submit`, `tasks`, `task`, `approvals`, `signal`, `cancel`, `cost`, `events`, `pause`, `resume`, or `halt`)',
    );
  }
  switch (sub) {
    case 'status':
      return runStatus(rest);
    case 'submit':
      return runSubmit(rest);
    case 'tasks':
      return runTasks(rest);
    case 'task':
      return runTask(rest);
    case 'approvals':
      return runApprovals(rest);
    case 'signal':
      return runSignal(rest);
    case 'cancel':
      return runCancel(rest);
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
        `unknown workforce subcommand ${JSON.stringify(sub)} (expected \`status\`, \`submit\`, \`tasks\`, \`task\`, \`approvals\`, \`signal\`, \`cancel\`, \`cost\`, \`events\`, \`pause\`, \`resume\`, or \`halt\`)`,
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

/** Submit one goal to a declared workforce; the deployment's strategy shapes it into tasks. */
async function runSubmit(args: readonly string[]): Promise<WorkforceResult> {
  const { values } = parse(args, {
    workforce: { type: 'string' },
    goal: { type: 'string' },
    description: { type: 'string' },
    priority: { type: 'string' },
  });
  const workforceId = requireWorkforceId(values);
  if (typeof values.goal !== 'string' || values.goal.length === 0) {
    throw new WorkforceCliError(
      'missing --goal <text> (the goal is what the workforce is asked to do)',
    );
  }
  if (
    typeof values.priority === 'string' &&
    !['low', 'normal', 'high', 'urgent'].includes(values.priority)
  ) {
    throw new WorkforceCliError("--priority takes 'low', 'normal', 'high' or 'urgent'");
  }
  const t = await transportFrom(values);
  const res = await workforceRequest(
    t,
    'POST',
    `/v1/workforce/${encodeURIComponent(workforceId)}/goals`,
    {
      goal: values.goal,
      ...(typeof values.description === 'string' ? { description: values.description } : {}),
      ...(typeof values.priority === 'string' ? { priority: values.priority } : {}),
    },
  );
  return outcome('workforce submit', res, res.body as Record<string, unknown>);
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
    root: { type: 'string' },
    json: { type: 'boolean' },
  });
  if (values.tree !== true && (typeof values.root === 'string' || values.json === true)) {
    throw new WorkforceCliError('--root and --json belong to `workforce tasks --tree`');
  }
  const t = await transportFrom(values);

  if (values.tree !== true) {
    let query = '';
    if (typeof values.status === 'string') query += `&status=${encodeURIComponent(values.status)}`;
    if (typeof values.owner === 'string') query += `&owner=${encodeURIComponent(values.owner)}`;
    if (typeof values.workforce === 'string') {
      query += `&workforceId=${encodeURIComponent(values.workforce)}`;
    }
    const { rows, truncated, error } = await listAllTasks(t, query);
    if (error) return outcome('workforce tasks', error, {});
    return { ok: true, command: 'workforce tasks', tasks: rows, truncated };
  }

  // --tree renders ONE WHOLE SUBTREE as text (the exception to the one-JSON-object contract;
  // --json keeps the machine shape). Status/owner filters belong to the flat list — a filtered
  // tree would render holes as work that never happened.
  if (typeof values.status === 'string' || typeof values.owner === 'string') {
    throw new WorkforceCliError(
      '--tree renders one whole subtree; --status and --owner filters belong to the flat list',
    );
  }
  let rootId = typeof values.root === 'string' ? values.root : undefined;
  if (rootId === undefined) {
    // No --root: exactly one root task is the unambiguous pick (the transport's own
    // one-candidate rule); anything else is a fail-closed error naming the options.
    let query = '';
    if (typeof values.workforce === 'string') {
      query += `&workforceId=${encodeURIComponent(values.workforce)}`;
    }
    const { rows, error } = await listAllTasks(t, query);
    if (error) return outcome('workforce tasks', error, {});
    const roots = rows.filter((row) => row.parentTaskId === null);
    const first = roots[0];
    if (roots.length !== 1 || first === undefined) {
      throw new WorkforceCliError(
        roots.length === 0
          ? 'no root task exists to render — submit a goal first, or pass --root <task-id>'
          : `several root tasks exist — pass --root <task-id>. Roots: ${roots
              .slice(0, 20)
              .map((row) => row.taskId)
              .join(', ')}${roots.length > 20 ? ', …' : ''}`,
      );
    }
    rootId = first.taskId;
  }
  const res = await workforceRequest(
    t,
    'GET',
    `/v1/workforce/tasks/${encodeURIComponent(rootId)}/tree`,
  );
  if (res.status < 200 || res.status >= 300) return outcome('workforce tasks', res, {});
  const body = res.body as {
    rootTaskId: string;
    tasks: TreeTaskRow[];
    budgets: { taskUsd: number | null; taskTurns: number | null } | null;
  };
  const truncated = res.headers['x-result-truncated'] === 'true';
  if (values.json === true) {
    return {
      ok: true,
      command: 'workforce tasks',
      tree: body.tasks,
      budgets: body.budgets,
      truncated,
    };
  }
  return {
    ok: true,
    command: 'workforce tasks',
    rendering: renderTaskTree(body.tasks, body.budgets, truncated),
  };
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

/**
 * The signal kinds an OPERATOR may post, mirroring `OPERATOR_SIGNAL_KINDS` (@rayspec/tasks) — the
 * same closed set the route's own body schema enforces. Repeated here as a USAGE check only, in
 * the idiom `--priority` and `--by` already use: it can NARROW what the route accepts, never
 * widen it, and it is not a local authorization decision (the CLI makes none). The rest of the
 * engine's signal kinds are MECHANISM kinds — `child_completed` is written by the fan-in,
 * `escalated` by the escalation reply — and posting one by hand would assert the very fact the
 * park it releases is waiting to observe. That is refused at the route; refusing it here too just
 * turns a 400 round-trip into a local error that names the set.
 */
const OPERATOR_SIGNAL_KINDS = ['manual_unblock', 'budget_raised', 'user_reply'] as const;

/**
 * The status a task parked ON A HUMAN sits in. Paired with a NULL `statusReason` this is the
 * reasonless park — review rounds spent, an escalated budget — whose exit is a `user_reply`
 * signal and which writes NO approval row, so it appears nowhere in the approvals inbox. A
 * `waiting_for_user` row that DOES carry a reason (`approval_pending`) has its own decision path
 * and is deliberately not advertised here: `user_reply` does not answer it.
 */
const SIGNAL_PARK_STATUS = 'waiting_for_user';

/**
 * Is this row the REASONLESS `waiting_for_user` park — the one `user_reply` answers?
 *
 * Both halves fail CLOSED, because the cost of a false positive here is not a missing row but a
 * WRONG INSTRUCTION: the advisory would hand the operator `--kind user_reply` for a park that kind
 * does not answer, and a confidently wrong next step is worse than none — which is the whole lesson
 * of this item.
 *
 *   - `statusReason` must be EXPLICITLY `null`. A row that does not carry the field at all is
 *     ABSENT, which is *unknown*, not *reasonless*; treating the two alike would advertise every
 *     `waiting_for_user` row, `approval_pending` ones included, the moment the field stopped being
 *     serialized.
 *   - `status` is re-checked even though the query already filters on it, so a server that ignored
 *     the `status=` parameter cannot get unrelated rows advertised.
 *
 * The predicate is exactly `WAKES.user_reply`'s own (`@rayspec/tasks` signals.ts): status
 * `waiting_for_user`, reason `null`. That is what makes the emitted `release:` command correct for
 * EVERY producer of this park — the two rounds-exhausted paths, the budget escalation, and the
 * failed review task — and not just for the one a test happens to reproduce.
 */
function isSignalParked(row: Record<string, unknown>): boolean {
  return row.status === SIGNAL_PARK_STATUS && row.statusReason === null;
}

interface SignalParkedTask {
  readonly taskId: string;
  readonly title: unknown;
  readonly owner: unknown;
  readonly workforceId: unknown;
  /** The exact command that releases this task — the half of the fix that makes the verb findable. */
  readonly release: string;
}

/**
 * The signal-parked tasks the approvals inbox structurally cannot show. Reads the EXISTING task
 * list route (no new surface, no contract change) and filters client-side on `isSignalParked`.
 *
 * It walks EVERY page through `listAllTasks`, following the server's own `X-Next-Cursor` contract.
 * A single-page read was the first version and it was wrong in the worst available way: past one
 * page the operator got a present, non-empty, PARTIAL advisory with nothing saying so — a list that
 * looks complete and is not is worse than no list, because it ends the search. `truncated` (only
 * true past `MAX_TASK_PAGES`) rides out so even the bounded extreme is stated rather than implied.
 *
 * A refusal is RETURNED, never swallowed. An advisory that vanishes when its read is refused is
 * indistinguishable from "nothing is parked" — which is precisely the silence this command exists
 * to break.
 */
async function signalParkedAdvisory(
  t: WorkforceTransport,
): Promise<{ parked: SignalParkedTask[]; truncated: boolean } | { error: WorkforceApiResult }> {
  const { rows, truncated, error } = await listAllTasks(
    t,
    `&status=${encodeURIComponent(SIGNAL_PARK_STATUS)}`,
  );
  if (error) return { error };
  const parked = rows
    .filter((row) => isSignalParked(row as unknown as Record<string, unknown>))
    .map((row) => ({
      taskId: String(row.taskId),
      title: row.title,
      owner: row.owner,
      workforceId: row.workforceId,
      release: `rayspec workforce signal ${String(row.taskId)} --kind user_reply`,
    }));
  return { parked, truncated };
}

async function runApprovals(args: readonly string[]): Promise<WorkforceResult> {
  const action = args[0];
  const rest = args.slice(1);
  if (action === 'list' || action === undefined) {
    const { values } = parse(rest);
    const t = await transportFrom(values);
    const res = await workforceRequest(t, 'GET', '/v1/workforce/approvals?status=pending');
    if (res.status < 200 || res.status >= 300) {
      return outcome('workforce approvals list', res, {});
    }
    // The inbox alone is a HALF-TRUTH: a review that spends its rounds parks its task on a human
    // and writes no approval row, so this list is empty while a task waits forever. The advisory
    // rides alongside — a SIBLING key, so the `approvals` array keeps the exact shape
    // `approvals approve <id>` consumes; an id from it must never be one that command cannot act on.
    const advisory = await signalParkedAdvisory(t);
    return {
      ok: true,
      command: 'workforce approvals list',
      approvals: res.body,
      ...('parked' in advisory
        ? // `signalParkedTruncated` is ALWAYS present, like `tasks`' own `truncated`: an absent
          // key cannot be told apart from `false`, and "is this list complete?" is exactly the
          // question a partial advisory must not leave the operator guessing at.
          { signalParked: advisory.parked, signalParkedTruncated: advisory.truncated }
        : { signalParkedError: errorsFrom(advisory.error) }),
    };
  }
  if (action === 'approve' || action === 'reject') {
    // `--override` is the BREAK-GLASS ask. It carries no authority of its own: the route ANDs it
    // with the `workforce:override` permission, and a credential without that permission gets the
    // route's 403 verbatim (the CLI adds no local authorization logic — two implementations is one
    // too many). Needed only for an approval the engine addressed to a NAMED approver, which is
    // what the timeout sweep writes when it escalates to the requester's declared superior.
    const { values, positionals } = parse(
      rest,
      { reason: { type: 'string' }, override: { type: 'boolean' } },
      true,
    );
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
        ...(values.override === true ? { override: true } : {}),
      },
    );
    return outcome(`workforce approvals ${action}`, res, { approval: res.body });
  }
  throw new WorkforceCliError(
    `unknown approvals action ${JSON.stringify(action)} (expected \`list\`, \`approve\`, or \`reject\`)`,
  );
}

/**
 * Deliver ONE operator wake signal to a parked task — the console's release for a task waiting on
 * a human that carries no approval to decide (review rounds spent, an escalated budget). It is the
 * same door `POST /v1/workforce/tasks/:id/signal` has always been: the engine still decides whether
 * the kind ANSWERS the park the task actually sits in, so a structural park (a fan-out join, an
 * escalation waiting on its child) is refused there exactly as it is on every internal door. This
 * verb adds no new authority — it types an existing one.
 *
 * `--signal-key` is the delivery's idempotency key: the engine dedupes on (task, key), so a
 * re-send under the same key collapses. Absent, the route mints a fresh key and each call is its
 * own delivery.
 */
async function runSignal(args: readonly string[]): Promise<WorkforceResult> {
  const { values, positionals } = parse(
    args,
    { kind: { type: 'string' }, payload: { type: 'string' }, 'signal-key': { type: 'string' } },
    true,
  );
  const taskId = positionals[0];
  if (taskId === undefined || positionals.length !== 1) {
    throw new WorkforceCliError(
      'expected exactly one task id: `workforce signal <task-id> --kind <kind>`',
    );
  }
  if (typeof values.kind !== 'string' || values.kind.length === 0) {
    throw new WorkforceCliError(
      "missing --kind (an operator signal names what it answers: 'manual_unblock', " +
        "'budget_raised' or 'user_reply'; a task parked on a human with no approval to decide " +
        'is released by user_reply)',
    );
  }
  if (!(OPERATOR_SIGNAL_KINDS as readonly string[]).includes(values.kind)) {
    throw new WorkforceCliError(
      "--kind takes 'manual_unblock', 'budget_raised' or 'user_reply'. The engine's other signal " +
        'kinds are written by the mechanism that establishes the fact they report (the fan-in, the ' +
        'escalation reply, the verdict route) and are refused on this door.',
    );
  }
  // Parsed and shape-checked HERE, so a typo is a usage error naming the shape rather than a
  // round-trip that spends a request to learn the same thing.
  let payload: Record<string, unknown> | undefined;
  if (typeof values.payload === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(values.payload);
    } catch (e) {
      throw new WorkforceCliError(
        `--payload is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new WorkforceCliError('--payload must be a JSON object (e.g. \'{"note":"…"}\')');
    }
    payload = parsed as Record<string, unknown>;
  }
  const t = await transportFrom(values);
  const res = await workforceRequest(
    t,
    'POST',
    `/v1/workforce/tasks/${encodeURIComponent(taskId)}/signal`,
    {
      kind: values.kind,
      ...(payload !== undefined ? { payload } : {}),
      ...(typeof values['signal-key'] === 'string' ? { signalKey: values['signal-key'] } : {}),
    },
  );
  return outcome('workforce signal', res, { result: res.body });
}

/**
 * Cancel a task and its subtree — the lever for the parks a signal deliberately CANNOT release.
 *
 * `signal` above answers a park; this answers the ones no operator signal may. A fan-out join and
 * an escalation both wait on a CHILD TASK's terminal, which an override does not change (invariant
 * 4.10, `@rayspec/tasks` signals.ts): the only sound lever is to cancel the child, so its terminal
 * satisfies the park through the park's OWN path rather than erasing the exit. It is likewise the
 * documented rescue for a `deadline_exceeded` block, which `manual_unblock` refuses because an
 * unblock there re-parks against the same instant on the very next pass.
 *
 * A working turn is NEVER killed mid-flight: the engine delivers a `cancel` signal the target
 * absorbs at its own turn boundary. That is why the reply has two lists — `cancelled` (rows moved
 * now) and `signalled` (rows that will absorb it) — and both are relayed exactly as the cascade
 * reported them, because "it is scheduled to stop" and "it has stopped" are different facts.
 *
 * `--reason` is OPTIONAL here, mirroring the route's own schema. `halt` requires one because the
 * halt ROUTE requires one; requiring it here would be the CLI inventing policy the door does not
 * have. An explicitly empty `--reason` is still refused — the route's `min(1)` would reject it, so
 * naming it locally beats spending a round trip to learn the same thing.
 */
async function runCancel(args: readonly string[]): Promise<WorkforceResult> {
  const { values, positionals } = parse(args, { reason: { type: 'string' } }, true);
  const taskId = positionals[0];
  if (taskId === undefined || positionals.length !== 1) {
    throw new WorkforceCliError('expected exactly one task id: `workforce cancel <task-id>`');
  }
  if (typeof values.reason === 'string' && values.reason.length === 0) {
    throw new WorkforceCliError(
      '--reason was given but empty: drop the flag, or give the cancellation a reason worth journalling',
    );
  }
  const t = await transportFrom(values);
  const res = await workforceRequest(
    t,
    'POST',
    `/v1/workforce/tasks/${encodeURIComponent(taskId)}/cancel`,
    { ...(typeof values.reason === 'string' ? { reason: values.reason } : {}) },
  );
  return outcome('workforce cancel', res, { result: res.body });
}

async function runCost(args: readonly string[]): Promise<WorkforceResult> {
  const { values } = parse(args, { window: { type: 'string' }, by: { type: 'string' } });
  if (typeof values.by === 'string' && values.by !== 'employee' && values.by !== 'department') {
    throw new WorkforceCliError("--by takes 'employee' or 'department'");
  }
  const t = await transportFrom(values);
  const params = [
    ...(typeof values.window === 'string' ? [`window=${encodeURIComponent(values.window)}`] : []),
    ...(typeof values.by === 'string' ? [`by=${encodeURIComponent(values.by)}`] : []),
  ];
  const query = params.length > 0 ? `?${params.join('&')}` : '';
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
