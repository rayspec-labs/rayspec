/**
 * dispatchTool pipeline unit tests.
 *
 * These assert the REAL pipeline behavior in isolation (a fake in-memory JournalSink, no DB):
 *  - validate-in rejects bad args (one journal step, status=error, tool_error result);
 *  - the timeout fires and aborts a slow handler;
 *  - validate-out rejects a bad handler output;
 *  - a successful call opaque-wraps as { kind:'tool_data', ... } and records EXACTLY ONE step;
 *  - idempotent replay returns the CACHED output WITHOUT re-running the handler;
 *  - non-idempotent replay surfaces a tool_error (never re-fires, never fabricates a success);
 *  - one journal step per live call.
 */
import type { JournalSink, NeutralTool, StepReport } from '@rayspec/core';
import { hashJson } from '@rayspec/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type DispatchDeps, makeDispatchTool, Semaphore } from './dispatch.js';

/**
 * A fake JournalSink that mirrors the REAL Postgres sink's behavior so a blind array-push fake
 * cannot mask the same-args double-fire crash:
 *  - record() ENFORCES the UNIQUE (tenantId, runId, idempotencyKey) constraint (throws a
 *    unique_violation on a duplicate idempotencyKey, exactly like journal_idem_idx + a plain
 *    insert). This is what would crash a same-args double-fire under the OLD (args-hash) key.
 *  - lookup() matches by the idempotencyKey COLUMN (the LLM-step replay path).
 *  - lookupToolCache() matches the latest OK `tool` step by inputHash (the args-keyed replay
 *    cache, since a tool step's idempotency_key now holds the per-call callId).
 */
class FakeJournal implements JournalSink {
  records: (StepReport & { authMode: string })[] = [];
  constructor(
    private readonly scope: { tenantId: string; runId: string } = {
      tenantId: 't1',
      runId: 'r1',
    },
  ) {}

  async lookup(idempotencyKey: string): Promise<{ output: unknown } | null> {
    const hit = this.records.find((r) => r.idempotencyKey === idempotencyKey && r.status === 'ok');
    return hit ? { output: hit.output } : null;
  }
  async lookupToolCache(inputHash: string): Promise<{ output: unknown } | null> {
    // Latest OK tool step with this args hash (newest wins) — mirrors the real sink's ORDER BY.
    const hits = this.records.filter(
      (r) => r.type === 'tool' && r.inputHash === inputHash && r.status === 'ok',
    );
    const hit = hits.length > 0 ? hits[hits.length - 1] : undefined;
    return hit ? { output: hit.output } : null;
  }
  async record(step: StepReport & { authMode: string }): Promise<string> {
    // Enforce UNIQUE (tenantId, runId, idempotencyKey) like journal_idem_idx + a plain insert.
    const dup = this.records.some((r) => r.idempotencyKey === step.idempotencyKey);
    if (dup) {
      throw new Error(
        `duplicate key value violates unique constraint "journal_idem_idx" ` +
          `(${this.scope.tenantId}, ${this.scope.runId}, ${step.idempotencyKey})`,
      );
    }
    this.records.push(step);
    return `step-${this.records.length}`;
  }
  /** Seed an OK tool step directly into the journal as if a prior live run had recorded it. */
  seedToolStep(over: Partial<StepReport & { authMode: string }>): void {
    this.records.push({
      type: 'tool',
      idempotencyKey: 'seed-callid',
      inputHash: 'seed',
      output: null,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      costUsd: 0,
      latencyMs: 0,
      status: 'ok',
      authMode: 'api-key',
      ...over,
    });
  }
}

function deps(overrides: Partial<DispatchDeps> & { tools: NeutralTool[] }): DispatchDeps {
  return {
    runId: 'r1',
    tenantId: 't1',
    journal: new FakeJournal(),
    replay: false,
    authMode: 'api-key',
    // run-core ALWAYS wires a markRunTainted writer (the structural fail-closed contract in dispatch.ts
    // requires one for a non-idempotent tool to fire). Default it to a no-op here so the general tests
    // exercise the handler path; the dedicated "structural fail-closed" test builds deps WITHOUT this
    // default to prove the refuse-to-fire behavior when no writer is configured.
    markRunTainted: async () => {},
    ...overrides,
  };
}

const echoTool = (over: Partial<NeutralTool> = {}): NeutralTool => ({
  spec: { name: 'echo', description: 'echo', parameters: { type: 'object' } },
  handler: (args: unknown) => ({ echoed: args }),
  timeoutMs: 1000,
  idempotent: true,
  ...over,
});

describe('dispatchTool validate-in', () => {
  it('rejects bad input, returns tool_error, and records ONE error step (handler NOT run)', async () => {
    const journal = new FakeJournal();
    const handler = vi.fn();
    const d = deps({
      journal,
      tools: [
        echoTool({
          handler,
          inputSchema: {
            type: 'object',
            required: ['n'],
            properties: { n: { type: 'number' } },
            additionalProperties: false,
          },
        }),
      ],
    });
    const dispatch = makeDispatchTool(d);
    const res = await dispatch('echo', { n: 'not-a-number' });

    expect(res.kind).toBe('tool_error');
    if (res.kind === 'tool_error') expect(res.message).toMatch(/input validation failed/);
    expect(handler).not.toHaveBeenCalled();
    expect(journal.records).toHaveLength(1);
    expect(journal.records[0]?.status).toBe('error');
    expect(journal.records[0]?.type).toBe('tool');
  });
});

describe('dispatchTool timeout', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires the timeout, aborts the handler, returns tool_error, records one error step', async () => {
    const journal = new FakeJournal();
    let aborted = false;
    const d = deps({
      journal,
      tools: [
        echoTool({
          timeoutMs: 50,
          handler: (_args: unknown, signal: AbortSignal) =>
            new Promise((resolve) => {
              signal.addEventListener('abort', () => {
                aborted = true;
              });
              // never resolves on its own -> the timeout must win
              setTimeout(resolve, 10_000);
            }),
        }),
      ],
    });
    const dispatch = makeDispatchTool(d);
    const p = dispatch('echo', { x: 1 });
    await vi.advanceTimersByTimeAsync(60);
    const res = await p;

    expect(res.kind).toBe('tool_error');
    if (res.kind === 'tool_error') expect(res.message).toMatch(/timed out/);
    expect(aborted).toBe(true);
    expect(journal.records).toHaveLength(1);
    expect(journal.records[0]?.status).toBe('error');
  });
});

describe('dispatchTool validate-out', () => {
  it('rejects a handler output that violates outputSchema -> tool_error, one error step', async () => {
    const journal = new FakeJournal();
    const d = deps({
      journal,
      tools: [
        echoTool({
          handler: () => ({ wrong: true }),
          outputSchema: {
            type: 'object',
            required: ['result'],
            properties: { result: { type: 'string' } },
            additionalProperties: false,
          },
        }),
      ],
    });
    const dispatch = makeDispatchTool(d);
    const res = await dispatch('echo', {});
    expect(res.kind).toBe('tool_error');
    if (res.kind === 'tool_error') expect(res.message).toMatch(/output validation failed/);
    expect(journal.records).toHaveLength(1);
    expect(journal.records[0]?.status).toBe('error');
  });
});

describe('dispatchTool success path', () => {
  it('opaque-wraps as { kind:"tool_data" } and records EXACTLY ONE ok step keyed by the REAL callId', async () => {
    const journal = new FakeJournal();
    const d = deps({ journal, tools: [echoTool()] });
    const dispatch = makeDispatchTool(d);
    const res = await dispatch('echo', { a: 1 }, 'call_REAL_123');

    expect(res.kind).toBe('tool_data');
    if (res.kind === 'tool_data') {
      expect(res.name).toBe('echo');
      // The result carries the REAL SDK callId (not the args-hash) so the journal step and
      // the transcript tool_call/tool_result parts join on the same id.
      expect(res.toolCallId).toBe('call_REAL_123');
      expect(res.data).toEqual({ echoed: { a: 1 } });
    }
    expect(journal.records).toHaveLength(1);
    expect(journal.records[0]?.status).toBe('ok');
    // The journal step's UNIQUENESS key (idempotencyKey column) is the REAL per-call callId.
    expect(journal.records[0]?.idempotencyKey).toBe('call_REAL_123');
    // The args-hash lives in inputHash (audit + replay-cache basis), NOT the journal key.
    expect(journal.records[0]?.inputHash).not.toBe('call_REAL_123');
    // The JOURNALED output is the opaque wrapper, never the raw handler output.
    expect((journal.records[0]?.output as { kind?: string })?.kind).toBe('tool_data');
  });

  it('TWO byte-identical-args calls in ONE run BOTH fire + record TWO distinct journal rows (no unique_violation)', async () => {
    // The exact crash the real-callId journal key fixes: under the old args-hash journal key, a same-args 2nd call hit the
    // UNIQUE index AFTER the side effect ran -> the run crashed. With the REAL callId as the key,
    // two identical-args calls get DISTINCT rows and BOTH fire. The FakeJournal here ENFORCES the
    // unique constraint, so a regression would throw (the array-push fake masked this).
    const journal = new FakeJournal();
    let fires = 0;
    // A NON-idempotent (side-effecting) tool: it MUST fire on every call, never be deduped.
    const sideEffect = echoTool({
      spec: { name: 'charge_card', description: 'charge', parameters: { type: 'object' } },
      idempotent: false,
      handler: (args: unknown) => {
        fires++;
        return { charged: args };
      },
    });
    const dispatch = makeDispatchTool(deps({ journal, tools: [sideEffect] }));

    const r1 = await dispatch('charge_card', { amt: 100 }, 'call_AAA');
    const r2 = await dispatch('charge_card', { amt: 100 }, 'call_BBB'); // identical args, distinct callId

    expect(r1.kind).toBe('tool_data');
    expect(r2.kind).toBe('tool_data');
    // The non-idempotent handler fired BOTH times (the 2nd was NOT short-circuited).
    expect(fires).toBe(2);
    // TWO distinct journal rows, keyed by the two distinct real callIds (no unique_violation).
    expect(journal.records).toHaveLength(2);
    expect(journal.records.map((r) => r.idempotencyKey)).toEqual(['call_AAA', 'call_BBB']);
    // Both rows carry the SAME args inputHash (proving the args really were byte-identical).
    expect(journal.records[0]?.inputHash).toBe(journal.records[1]?.inputHash);
  });

  it('an absent callId still records distinct rows (uuid fallback never collides)', async () => {
    const journal = new FakeJournal();
    const dispatch = makeDispatchTool(deps({ journal, tools: [echoTool({ idempotent: false })] }));
    await dispatch('echo', { a: 1 }); // no callId -> uuid fallback
    await dispatch('echo', { a: 1 }); // same args, no callId -> a DIFFERENT uuid
    expect(journal.records).toHaveLength(2);
    expect(journal.records[0]?.idempotencyKey).not.toBe(journal.records[1]?.idempotencyKey);
  });

  it('emits tool_called then tool_result events', async () => {
    const events: { type: string }[] = [];
    const d = deps({
      tools: [echoTool()],
      onEvent: (e) => {
        events.push(e);
      },
    });
    const dispatch = makeDispatchTool(d);
    await dispatch('echo', { a: 1 });
    expect(events.map((e) => e.type)).toEqual(['tool_called', 'tool_result']);
  });

  it('returns a fail-closed tool_error for an unknown tool (no step recorded — nothing ran)', async () => {
    const journal = new FakeJournal();
    const d = deps({ journal, tools: [echoTool()] });
    const dispatch = makeDispatchTool(d);
    const res = await dispatch('nope', {});
    expect(res.kind).toBe('tool_error');
    if (res.kind === 'tool_error') expect(res.message).toMatch(/unknown tool/);
    expect(journal.records).toHaveLength(0);
  });
});

describe('dispatchTool replay contract', () => {
  it('IDEMPOTENT replay returns the CACHED output (matched by args inputHash) WITHOUT re-running the handler', async () => {
    const journal = new FakeJournal();
    const handler = vi.fn(() => ({ fresh: true }));
    const inputHash = hashJson({ a: 1 });
    // Seed a prior OK tool step as the live run would have recorded it: keyed by a (now distinct)
    // callId in idempotency_key, with the args inputHash for the replay-cache match.
    journal.seedToolStep({
      idempotencyKey: 'call_LIVE_xyz',
      inputHash,
      output: { kind: 'tool_data', name: 'echo', toolCallId: 'call_LIVE_xyz', data: { cached: 7 } },
    });
    const d = deps({ journal, replay: true, tools: [echoTool({ handler, idempotent: true })] });
    const dispatch = makeDispatchTool(d);

    const res = await dispatch('echo', { a: 1 }, 'call_REPLAY_new');
    expect(res.kind).toBe('tool_data');
    if (res.kind === 'tool_data') {
      expect(res.data).toEqual({ cached: 7 });
      // The replayed result carries the CURRENT call's id (correlation), not the cached one.
      expect(res.toolCallId).toBe('call_REPLAY_new');
    }
    // The handler was NOT re-run on replay.
    expect(handler).not.toHaveBeenCalled();
    // No NEW step recorded on a cache hit (replay short-circuit): still just the 1 seeded step.
    expect(journal.records).toHaveLength(1);
  });

  it('NON-IDEMPOTENT replay surfaces a tool_error and NEVER re-fires the side effect (cached)', async () => {
    const journal = new FakeJournal();
    const handler = vi.fn(() => ({ charged: true }));
    journal.seedToolStep({
      idempotencyKey: 'call_LIVE_charge',
      inputHash: hashJson({ amt: 100 }),
      output: {
        kind: 'tool_data',
        name: 'charge_card',
        toolCallId: 'call_LIVE_charge',
        data: { charged: true },
      },
    });
    const d = deps({
      journal,
      replay: true,
      tools: [
        echoTool({
          spec: { name: 'charge_card', description: 'charge', parameters: { type: 'object' } },
          handler,
          idempotent: false,
        }),
      ],
    });
    const dispatch = makeDispatchTool(d);

    const res = await dispatch('charge_card', { amt: 100 });
    expect(res.kind).toBe('tool_error');
    if (res.kind === 'tool_error') expect(res.message).toMatch(/non-idempotent/);
    // The side effect was NOT re-fired and the cached output was NOT returned as if re-run.
    expect(handler).not.toHaveBeenCalled();
  });

  it('NON-IDEMPOTENT replay with NO cache also fails closed (never re-runs a side effect)', async () => {
    const journal = new FakeJournal();
    const handler = vi.fn(() => ({ charged: true }));
    const d = deps({
      journal,
      replay: true,
      tools: [
        echoTool({
          spec: { name: 'send_email', description: 'send', parameters: { type: 'object' } },
          handler,
          idempotent: false,
        }),
      ],
    });
    const dispatch = makeDispatchTool(d);
    const res = await dispatch('send_email', { to: 'x' });
    expect(res.kind).toBe('tool_error');
    expect(handler).not.toHaveBeenCalled();
  });

  it('an IDEMPOTENT replay cache-hit RE-VALIDATES the cached payload against outputSchema (fail-closed)', async () => {
    // A cached jsonb payload is attacker-controllable on read. Seed a SCHEMA-VIOLATING cached
    // output, then replay: the cache hit must re-run validate-out and FAIL CLOSED to tool_error,
    // never hand back the unvalidated cached output as if freshly produced.
    const journal = new FakeJournal();
    const handler = vi.fn(() => ({ result: 'ok' }));
    journal.seedToolStep({
      idempotencyKey: 'call_LIVE_bad',
      inputHash: hashJson({ a: 1 }),
      // VIOLATES the outputSchema below (missing required `result`, wrong shape).
      output: { kind: 'tool_data', name: 'echo', toolCallId: 'call_LIVE_bad', data: { wrong: 1 } },
    });
    const d = deps({
      journal,
      replay: true,
      tools: [
        echoTool({
          handler,
          idempotent: true,
          outputSchema: {
            type: 'object',
            required: ['result'],
            properties: { result: { type: 'string' } },
            additionalProperties: false,
          },
        }),
      ],
    });
    const dispatch = makeDispatchTool(d);
    const res = await dispatch('echo', { a: 1 }, 'call_REPLAY');
    expect(res.kind).toBe('tool_error');
    if (res.kind === 'tool_error')
      expect(res.message).toMatch(/cached output failed re-validation/);
    // The handler was NOT re-run (replay short-circuit), the bad cache was NOT returned as success.
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('dispatchTool journaling cardinality', () => {
  it('records EXACTLY ONE journal step per LIVE call (three calls -> three steps)', async () => {
    const journal = new FakeJournal();
    const d = deps({ journal, tools: [echoTool()] });
    const dispatch = makeDispatchTool(d);
    await dispatch('echo', { a: 1 });
    await dispatch('echo', { a: 2 });
    await dispatch('echo', { a: 3 });
    expect(journal.records).toHaveLength(3);
    expect(journal.records.every((r) => r.status === 'ok' && r.type === 'tool')).toBe(true);
  });
});

describe('dispatchTool concurrency cap', () => {
  it('runs at most `maxConcurrency` tool HANDLERS at once (5 calls, cap 2 => peak 2)', async () => {
    // Each handler blocks on a gate it never resolves itself; we observe the peak number of handlers
    // running CONCURRENTLY. With cap=2, no more than 2 may be in-flight at any instant.
    let inFlight = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    const blockingTool = echoTool({
      idempotent: false,
      handler: () =>
        new Promise((resolve) => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          release.push(() => {
            inFlight--;
            resolve({ ok: true });
          });
        }),
    });
    const dispatch = makeDispatchTool(
      deps({ journal: new FakeJournal(), tools: [blockingTool], maxConcurrency: 2 }),
    );

    // Fire 5 calls (distinct callIds so they all record) WITHOUT awaiting.
    const calls = [0, 1, 2, 3, 4].map((i) => dispatch('echo', { i }, `call_${i}`));
    // Let the event loop schedule the acquired handlers.
    await new Promise((r) => setTimeout(r, 5));
    // With the cap=2, exactly 2 handlers acquired a slot and are blocking; the other 3 wait.
    expect(peak).toBe(2);
    expect(inFlight).toBe(2);

    // Release all handlers; the waiters get their slots FIFO and all 5 complete.
    while (release.length > 0) {
      release.shift()?.();
      await new Promise((r) => setTimeout(r, 1));
    }
    const results = await Promise.all(calls);
    expect(results.every((r) => r.kind === 'tool_data')).toBe(true);
    // The cap never let more than 2 run at once across the whole burst.
    expect(peak).toBe(2);
  });

  it('Semaphore is FIFO and never exceeds its permits', async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];
    const r1 = await sem.acquire(); // holds the only permit
    expect(sem.freePermits).toBe(0);
    const p2 = sem.acquire().then((rel) => {
      order.push(2);
      return rel;
    });
    const p3 = sem.acquire().then((rel) => {
      order.push(3);
      return rel;
    });
    // Neither waiter resolves while the permit is held.
    await new Promise((r) => setTimeout(r, 5));
    expect(order).toEqual([]);
    r1(); // release -> hands the permit to waiter #2 (FIFO)
    (await p2)();
    (await p3)();
    expect(order).toEqual([2, 3]);
  });
});

describe('dispatchTool non-idempotent-taint marker', () => {
  it('writes the taint marker BEFORE a NON-idempotent tool runs (ordering: mark precedes the side effect)', async () => {
    const journal = new FakeJournal();
    const order: string[] = [];
    const markRunTainted = vi.fn(async () => {
      order.push('mark');
    });
    const handler = vi.fn(() => {
      order.push('side-effect');
      return { ok: true };
    });
    const d = deps({
      journal,
      markRunTainted,
      tools: [echoTool({ idempotent: false, handler })],
    });
    const res = await makeDispatchTool(d)('echo', { x: 1 }, 'call-1');

    expect(res.kind).toBe('tool_data');
    expect(markRunTainted).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
    // The WHOLE invariant: the marker is written BEFORE the side effect (so a crash between them
    // leaves the run visibly tainted, never re-runnable-as-untainted).
    expect(order).toEqual(['mark', 'side-effect']);
  });

  it('FAIL-CLOSED: if the taint-marker write throws, the NON-idempotent handler is NOT run (a tool_error, no side effect)', async () => {
    const journal = new FakeJournal();
    const handler = vi.fn(() => ({ ok: true }));
    const markRunTainted = vi.fn(async () => {
      throw new Error('marker db down');
    });
    const d = deps({
      journal,
      markRunTainted,
      tools: [echoTool({ idempotent: false, handler })],
    });
    const res = await makeDispatchTool(d)('echo', { x: 1 }, 'call-1');

    expect(res.kind).toBe('tool_error');
    if (res.kind === 'tool_error') expect(res.message).toMatch(/non-idempotent-taint marker/);
    // The side effect NEVER fired (the marker is the gate that precedes it) — the core safety property.
    expect(handler).not.toHaveBeenCalled();
    // The fail-closed error is journaled as ONE error step (no double-record).
    expect(journal.records).toHaveLength(1);
    expect(journal.records[0]?.status).toBe('error');
  });

  it('does NOT mark an IDEMPOTENT tool (only side-effecting tools are tainted; over-quarantine guard)', async () => {
    const journal = new FakeJournal();
    const markRunTainted = vi.fn(async () => {});
    const d = deps({
      journal,
      markRunTainted,
      tools: [echoTool({ idempotent: true })], // idempotent — safely re-runnable, never tainted
    });
    const res = await makeDispatchTool(d)('echo', { x: 1 }, 'call-1');

    expect(res.kind).toBe('tool_data');
    expect(markRunTainted).not.toHaveBeenCalled();
  });

  it('STRUCTURAL fail-closed: a NON-idempotent tool with NO markRunTainted writer is REFUSED (tool_error, handler NOT run)', async () => {
    // Defense-in-depth: today run-core always wires the writer, but a FUTURE caller that constructs
    // dispatch WITHOUT one must not be able to fire an un-quarantinable side effect. Build the deps
    // DIRECTLY (NOT via the deps() helper, whose default no-op writer would mask this) so markRunTainted
    // is genuinely undefined. Fail-the-fix: deleting the structural guard in dispatch.ts makes this RED
    // (the handler would run and the side effect would fire un-quarantinable).
    const journal = new FakeJournal();
    const handler = vi.fn(() => ({ ok: true }));
    const d: DispatchDeps = {
      runId: 'r1',
      tenantId: 't1',
      journal,
      replay: false,
      authMode: 'api-key',
      // markRunTainted intentionally OMITTED (undefined).
      tools: [echoTool({ idempotent: false, handler })],
    };
    const res = await makeDispatchTool(d)('echo', { x: 1 }, 'call-1');

    expect(res.kind).toBe('tool_error');
    if (res.kind === 'tool_error') {
      expect(res.message).toMatch(/non-idempotent-taint writer not configured/);
    }
    // The side effect NEVER fired — the structural gate refused it.
    expect(handler).not.toHaveBeenCalled();
    // The refusal is journaled as ONE error step.
    expect(journal.records).toHaveLength(1);
    expect(journal.records[0]?.status).toBe('error');
  });

  it('a run with NO non-idempotent tool runs fine WITHOUT a markRunTainted writer (idempotent tool, writer undefined)', async () => {
    // The writer is only REQUIRED for a non-idempotent tool fire; an idempotent (or tool-free) run must
    // proceed normally with no writer configured. Build deps DIRECTLY so markRunTainted is undefined.
    const journal = new FakeJournal();
    const handler = vi.fn(() => ({ echoed: true }));
    const d: DispatchDeps = {
      runId: 'r1',
      tenantId: 't1',
      journal,
      replay: false,
      authMode: 'api-key',
      // markRunTainted intentionally OMITTED (undefined).
      tools: [echoTool({ idempotent: true, handler })],
    };
    const res = await makeDispatchTool(d)('echo', { x: 1 }, 'call-1');

    expect(res.kind).toBe('tool_data');
    expect(handler).toHaveBeenCalledTimes(1); // the idempotent handler ran — no writer needed
    expect(journal.records).toHaveLength(1);
    expect(journal.records[0]?.status).toBe('ok');
  });
});
