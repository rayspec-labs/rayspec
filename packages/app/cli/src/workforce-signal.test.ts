/**
 * `workforce signal` — the operator's release for a SIGNAL-PARKED task, over a stubbed HTTP
 * surface, plus the discoverability half that makes the verb findable.
 *
 * The gap this closes is not "a missing convenience". A review that spends its rounds parks its
 * task in `waiting_for_user` with `status_reason = NULL` and writes NO approval row
 * (kernel/tasks/src/apply-intents.ts, case `review_rounds_exhausted`), so
 * `rayspec workforce approvals list` — the documented inbox — shows the operator nothing at all,
 * while the task waits on a human forever. The HTTP route that releases it
 * (`POST /v1/workforce/tasks/:id/signal`) has existed all along; the console had no verb for it.
 *
 * What is asserted here:
 *   - the verb is WIRED (and the accept control proves the "unknown subcommand" matcher still
 *     fires on something, so the wiring assertion is not an absence proving itself);
 *   - it targets the right door with the right method and body — path, `kind`, `payload`,
 *     `signalKey`;
 *   - the closed operator-kind set is refused as USAGE, before any request leaves the process
 *     (the stub records zero calls) — the same narrowing `--priority` and `--by` already do, and
 *     never a local authorization decision;
 *   - a route refusal is relayed `ok:false` with the server's envelope untranslated;
 *   - `approvals list` points at the parked tasks it can no longer stay silent about, and says so
 *     LOUDLY when that advisory read is itself refused (a silently missing advisory is
 *     indistinguishable from "nothing is parked", which is the exact bug).
 *
 * The real end-to-end release against a real database is workforce-signal-e2e.db.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWorkforce } from './workforce.js';

const FLAGS = ['--url', 'http://127.0.0.1:9', '--api-key', 'rk_test'];

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

interface Route {
  readonly match: (url: string) => boolean;
  readonly body: unknown;
  readonly status?: number;
  readonly headers?: Record<string, string>;
}

/** Stub the global fetch and RECORD every call (url, method, parsed body) for assertion. */
function stubFetch(routes: Route[]): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    let body: unknown;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url, method: init?.method ?? 'GET', body });
    const route = routes.find((candidate) => candidate.match(url));
    if (!route) throw new Error(`unstubbed fetch: ${url}`);
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json', ...(route.headers ?? {}) },
    });
  }) as typeof fetch);
  return calls;
}

/** The route's own 202 answer. */
const DELIVERED = { delivered: true, woke: true };
const signalRoute: Route = {
  match: (url) => url.includes('/signal'),
  body: DELIVERED,
  status: 202,
};

const TASK = 'e0a1b2c3-0000-4000-8000-00000000dead';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('workforce signal — the verb exists and targets the right door', () => {
  it('is a recognised subcommand', async () => {
    stubFetch([signalRoute]);
    // The NEGATIVE pin: the group no longer answers `signal` with its unknown-subcommand refusal.
    // Proven against the accept control below, and re-proven by mutation M1 (deleting the switch
    // case must red exactly this).
    await expect(
      runWorkforce(['signal', TASK, '--kind', 'user_reply', ...FLAGS]),
    ).resolves.toMatchObject({ ok: true, command: 'workforce signal' });
  });

  it('the accept control: an invented subcommand is STILL refused as unknown', async () => {
    // Without this, the assertion above is satisfied by a matcher that fires on nothing.
    await expect(runWorkforce(['frobnicate', ...FLAGS])).rejects.toThrow(
      /unknown workforce subcommand/,
    );
  });

  it('POSTs the task id to /signal with the kind in the body', async () => {
    const calls = stubFetch([signalRoute]);
    const result = await runWorkforce(['signal', TASK, '--kind', 'user_reply', ...FLAGS]);
    expect(result).toMatchObject({ ok: true, command: 'workforce signal' });
    expect(result.result).toEqual(DELIVERED);
    expect(calls).toHaveLength(1);
    const call = calls[0] as Call;
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`http://127.0.0.1:9/v1/workforce/tasks/${TASK}/signal`);
    expect(call.body).toEqual({ kind: 'user_reply' });
  });

  it('--payload and --signal-key ride the body as payload / signalKey', async () => {
    const calls = stubFetch([signalRoute]);
    await runWorkforce([
      'signal',
      TASK,
      '--kind',
      'budget_raised',
      '--payload',
      '{"note":"ceiling raised to $50"}',
      '--signal-key',
      'op-release-1',
      ...FLAGS,
    ]);
    expect((calls[0] as Call).body).toEqual({
      kind: 'budget_raised',
      payload: { note: 'ceiling raised to $50' },
      signalKey: 'op-release-1',
    });
  });

  it('a task id is url-encoded into the path, never interpolated raw', async () => {
    const calls = stubFetch([signalRoute]);
    await runWorkforce(['signal', 'a/../b', '--kind', 'user_reply', ...FLAGS]);
    expect((calls[0] as Call).url).toBe('http://127.0.0.1:9/v1/workforce/tasks/a%2F..%2Fb/signal');
  });
});

describe('workforce signal — fail-closed usage, before anything leaves the process', () => {
  it('a kind outside the operator set is refused as usage and sends NO request', async () => {
    // `child_completed` is a MECHANISM kind: posting it would assert by hand the very fact a
    // fan-out join is parked waiting to observe. The route refuses it too — this is the CLI
    // naming the closed set in its own usage error, exactly as --priority and --by do. It can
    // only narrow what the route accepts, never widen it.
    const calls = stubFetch([signalRoute]);
    await expect(
      runWorkforce(['signal', TASK, '--kind', 'child_completed', ...FLAGS]),
    ).rejects.toThrow(/--kind takes 'manual_unblock', 'budget_raised' or 'user_reply'/);
    expect(calls, 'a refused kind still reached the network').toHaveLength(0);
  });

  it('a missing --kind is refused, naming the set', async () => {
    const calls = stubFetch([signalRoute]);
    await expect(runWorkforce(['signal', TASK, ...FLAGS])).rejects.toThrow(/missing --kind/);
    expect(calls).toHaveLength(0);
  });

  it('zero or two positionals are refused', async () => {
    stubFetch([signalRoute]);
    await expect(runWorkforce(['signal', '--kind', 'user_reply', ...FLAGS])).rejects.toThrow(
      /exactly one task id/,
    );
    await expect(
      runWorkforce(['signal', TASK, 'second', '--kind', 'user_reply', ...FLAGS]),
    ).rejects.toThrow(/exactly one task id/);
  });

  it('a --payload that is not a JSON OBJECT is refused before the request', async () => {
    const calls = stubFetch([signalRoute]);
    await expect(
      runWorkforce(['signal', TASK, '--kind', 'user_reply', '--payload', '{oops', ...FLAGS]),
    ).rejects.toThrow(/--payload is not valid JSON/);
    // A bare array/scalar parses as JSON but is not the record the route's schema takes; refusing
    // here turns a 400 round-trip into a local usage error naming the shape.
    await expect(
      runWorkforce(['signal', TASK, '--kind', 'user_reply', '--payload', '[1,2]', ...FLAGS]),
    ).rejects.toThrow(/--payload must be a JSON object/);
    expect(calls).toHaveLength(0);
  });

  it('a route refusal is relayed ok:false with the server envelope untranslated', async () => {
    // The CLI adds NO authorization of its own: a 403 is the route's 403, verbatim.
    stubFetch([
      {
        match: (url) => url.includes('/signal'),
        status: 403,
        body: { error: { code: 'forbidden', message: 'missing permission: store:write' } },
      },
    ]);
    const result = await runWorkforce(['signal', TASK, '--kind', 'user_reply', ...FLAGS]);
    expect(result).toEqual({
      ok: false,
      command: 'workforce signal',
      errors: [{ code: 'forbidden', message: 'missing permission: store:write' }],
    });
  });

  it('a 409 from a park the kind does not answer is relayed, not reinterpreted', async () => {
    stubFetch([
      {
        match: (url) => url.includes('/signal'),
        status: 409,
        body: { error: { code: 'signal_refused', message: 'no park answers user_reply' } },
      },
    ]);
    const result = await runWorkforce(['signal', TASK, '--kind', 'user_reply', ...FLAGS]);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      { code: 'signal_refused', message: 'no park answers user_reply' },
    ]);
  });
});

describe('workforce approvals list — the parked tasks it can no longer stay silent about', () => {
  const parkedRow = {
    taskId: TASK,
    parentTaskId: null,
    title: 'Produce the merged report',
    owner: 'lead',
    workforceId: 'wf',
    status: 'waiting_for_user',
    statusReason: null,
  };
  const approvalParkedRow = {
    taskId: 'f1111111-0000-4000-8000-000000000001',
    parentTaskId: null,
    title: 'Awaiting a decision',
    owner: 'lead',
    workforceId: 'wf',
    status: 'waiting_for_user',
    statusReason: 'approval_pending',
  };

  it('surfaces a signal-parked task with the exact command that releases it', async () => {
    stubFetch([
      { match: (url) => url.includes('/v1/workforce/approvals'), body: [] },
      {
        match: (url) => url.includes('/v1/workforce/tasks?'),
        // The approval-parked row must NOT be advertised: it has its own decision path, and
        // `user_reply` does not answer it (WAKES matches the REASONLESS park only).
        body: [parkedRow, approvalParkedRow],
      },
    ]);
    const result = await runWorkforce(['approvals', 'list', ...FLAGS]);
    expect(result.ok).toBe(true);
    expect(result.approvals).toEqual([]);
    expect(result.signalParked).toEqual([
      {
        taskId: TASK,
        title: 'Produce the merged report',
        owner: 'lead',
        workforceId: 'wf',
        release: `rayspec workforce signal ${TASK} --kind user_reply`,
      },
    ]);
  });

  it('asks the tasks route only for the waiting_for_user status', async () => {
    const calls = stubFetch([
      { match: (url) => url.includes('/v1/workforce/approvals'), body: [] },
      { match: (url) => url.includes('/v1/workforce/tasks?'), body: [] },
    ]);
    await runWorkforce(['approvals', 'list', ...FLAGS]);
    const taskCall = calls.find((c) => c.url.includes('/v1/workforce/tasks?')) as Call;
    expect(taskCall.url).toContain('status=waiting_for_user');
    expect(taskCall.method).toBe('GET');
  });

  it('the approvals array itself is untouched — the advisory is a SIBLING key', async () => {
    const approval = { id: 'ap-1', taskId: TASK, status: 'pending', question: 'Publish?' };
    stubFetch([
      { match: (url) => url.includes('/v1/workforce/approvals'), body: [approval] },
      { match: (url) => url.includes('/v1/workforce/tasks?'), body: [parkedRow] },
    ]);
    const result = await runWorkforce(['approvals', 'list', ...FLAGS]);
    expect(result.approvals).toEqual([approval]);
    expect((result.signalParked as unknown[]).length).toBe(1);
  });

  it('a refused advisory read is REPORTED, never silently dropped', async () => {
    // The whole defect is a surface that says nothing when something is waiting. An advisory that
    // vanishes on a 403 would reproduce it exactly: indistinguishable from "nothing is parked".
    stubFetch([
      { match: (url) => url.includes('/v1/workforce/approvals'), body: [] },
      {
        match: (url) => url.includes('/v1/workforce/tasks?'),
        status: 403,
        body: { error: { code: 'forbidden', message: 'missing permission: store:read' } },
      },
    ]);
    const result = await runWorkforce(['approvals', 'list', ...FLAGS]);
    // The command still succeeds — the approvals read worked — but the gap is NAMED.
    expect(result.ok).toBe(true);
    expect(result.signalParked).toBeUndefined();
    expect(result.signalParkedError).toEqual([
      { code: 'forbidden', message: 'missing permission: store:read' },
    ]);
  });

  it('no signal-parked task means an empty advisory, not a missing key', async () => {
    stubFetch([
      { match: (url) => url.includes('/v1/workforce/approvals'), body: [] },
      { match: (url) => url.includes('/v1/workforce/tasks?'), body: [approvalParkedRow] },
    ]);
    const result = await runWorkforce(['approvals', 'list', ...FLAGS]);
    expect(result.signalParked).toEqual([]);
    expect(result.signalParkedError).toBeUndefined();
    // Always present, never inferred from absence — see the truncation arms below.
    expect(result.signalParkedTruncated).toBe(false);
  });

  // ── the advisory must be COMPLETE, not merely non-empty ────────────────────────────────────
  // A partial list that looks complete is worse than no list: it ends the operator's search at the
  // wrong place. The first version of this advisory read ONE page and dropped the rest silently.

  it('follows the cursor across EVERY page — a second page is not left behind', async () => {
    const pageTwoRow = { ...parkedRow, taskId: 'p2-0000-4000-8000-000000000002' };
    const calls = stubFetch([
      { match: (url) => url.includes('/v1/workforce/approvals'), body: [] },
      {
        // page 2 — matched first, because the cursor query is the more specific URL
        match: (url) => url.includes('/v1/workforce/tasks?') && url.includes('cursor=c1'),
        body: [pageTwoRow],
      },
      {
        match: (url) => url.includes('/v1/workforce/tasks?'),
        body: [parkedRow],
        headers: { 'x-result-truncated': 'true', 'x-next-cursor': 'c1' },
      },
    ]);
    const result = await runWorkforce(['approvals', 'list', ...FLAGS]);
    const advertised = (result.signalParked as { taskId: string }[]).map((p) => p.taskId);
    expect(advertised, 'a page beyond the first was dropped').toEqual([TASK, pageTwoRow.taskId]);
    expect(result.signalParkedTruncated).toBe(false);
    expect(calls.filter((c) => c.url.includes('/v1/workforce/tasks?'))).toHaveLength(2);
  });

  it('a walk that hits its page ceiling SAYS SO rather than implying completeness', async () => {
    // The server never stops claiming there is more. The walk is bounded, so the answer is
    // honestly partial — and the reply has to admit it.
    const calls = stubFetch([
      { match: (url) => url.includes('/v1/workforce/approvals'), body: [] },
      {
        match: (url) => url.includes('/v1/workforce/tasks?'),
        body: [parkedRow],
        headers: { 'x-result-truncated': 'true', 'x-next-cursor': 'always-more' },
      },
    ]);
    const result = await runWorkforce(['approvals', 'list', ...FLAGS]);
    expect(result.signalParkedTruncated, 'a bounded-out walk reported itself complete').toBe(true);
    // The bound is real, not a runaway.
    expect(calls.filter((c) => c.url.includes('/v1/workforce/tasks?')).length).toBe(1000);
  });

  // ── the predicate must FAIL CLOSED ─────────────────────────────────────────────────────────
  // A wrong instruction is worse than none: advertising a park `user_reply` cannot answer sends
  // the operator to a command that will come back {delivered:true, woke:false}.

  it('a row with NO statusReason field is NOT advertised — absent is unknown, not reasonless', async () => {
    const { statusReason: _dropped, ...noReasonField } = parkedRow;
    stubFetch([
      { match: (url) => url.includes('/v1/workforce/approvals'), body: [] },
      { match: (url) => url.includes('/v1/workforce/tasks?'), body: [noReasonField] },
    ]);
    const result = await runWorkforce(['approvals', 'list', ...FLAGS]);
    expect(
      result.signalParked,
      'a row whose reason was never serialized was advertised as reasonless',
    ).toEqual([]);
  });

  it('a row whose status is not waiting_for_user is not advertised even if the server sent it', async () => {
    // The query already filters by status; this is the fail-closed re-check for a server that
    // ignored it. Without it, a filter regression one layer down becomes a wrong instruction here.
    stubFetch([
      { match: (url) => url.includes('/v1/workforce/approvals'), body: [] },
      {
        match: (url) => url.includes('/v1/workforce/tasks?'),
        body: [{ ...parkedRow, status: 'blocked', statusReason: null }],
      },
    ]);
    const result = await runWorkforce(['approvals', 'list', ...FLAGS]);
    expect(result.signalParked).toEqual([]);
  });
});

describe('workforce cancel — the lever for the parks a signal may NOT release', () => {
  const CASCADE = { cancelled: ['t-1', 't-2'], signalled: ['t-3'] };
  const cancelRoute: Route = {
    match: (url) => url.includes('/cancel'),
    body: CASCADE,
    status: 202,
  };

  it('is a recognised subcommand and POSTs the task id to /cancel', async () => {
    const calls = stubFetch([cancelRoute]);
    const result = await runWorkforce(['cancel', TASK, ...FLAGS]);
    expect(result).toMatchObject({ ok: true, command: 'workforce cancel' });
    expect(calls).toHaveLength(1);
    const call = calls[0] as Call;
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`http://127.0.0.1:9/v1/workforce/tasks/${TASK}/cancel`);
  });

  it('relays the cascade body untranslated — cancelled and signalled are different facts', async () => {
    // A `working` target absorbs the cancel at its own turn boundary rather than being killed, so
    // it lands in `signalled`. Collapsing the two lists would report stopped work that is running.
    stubFetch([cancelRoute]);
    const result = await runWorkforce(['cancel', TASK, ...FLAGS]);
    expect(result.result).toEqual(CASCADE);
  });

  it('--reason rides the body; absent means an empty object, not a null reason', async () => {
    const calls = stubFetch([cancelRoute]);
    await runWorkforce(['cancel', TASK, '--reason', 'superseded by the rework', ...FLAGS]);
    expect((calls[0] as Call).body).toEqual({ reason: 'superseded by the rework' });
    calls.length = 0;
    await runWorkforce(['cancel', TASK, ...FLAGS]);
    expect((calls[0] as Call).body).toEqual({});
  });

  it('an explicitly EMPTY --reason is usage, and sends nothing', async () => {
    const calls = stubFetch([cancelRoute]);
    await expect(runWorkforce(['cancel', TASK, '--reason', '', ...FLAGS])).rejects.toThrow(
      /--reason was given but empty/,
    );
    expect(calls).toHaveLength(0);
  });

  it('zero or two positionals are refused', async () => {
    stubFetch([cancelRoute]);
    await expect(runWorkforce(['cancel', ...FLAGS])).rejects.toThrow(/exactly one task id/);
    await expect(runWorkforce(['cancel', TASK, 'second', ...FLAGS])).rejects.toThrow(
      /exactly one task id/,
    );
  });

  it('a route refusal is relayed ok:false with the server envelope untranslated', async () => {
    stubFetch([
      {
        match: (url) => url.includes('/cancel'),
        status: 404,
        body: { error: { code: 'not_found', message: 'No such task.' } },
      },
    ]);
    const result = await runWorkforce(['cancel', TASK, ...FLAGS]);
    expect(result).toEqual({
      ok: false,
      command: 'workforce cancel',
      errors: [{ code: 'not_found', message: 'No such task.' }],
    });
  });
});
