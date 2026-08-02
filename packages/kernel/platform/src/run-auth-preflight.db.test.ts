/**
 * The context-aware auth preflight, end-to-end through run-core (real Postgres, fake backends, no LLM).
 *
 * `resolveAuth()` is answered BEFORE the run identity exists, which is fine for a local adapter and
 * impossible for a remote one: with no runId, no tenantId and no agent identity it can only report a
 * mode it has not yet BOUND. The optional preflight is the seam that gives a backend that identity at
 * the one pre-run resolution point, and this suite proves what that buys and what it must never cost:
 *
 *  - AUTHORITATIVE. A preflight-bound mode is the run's pre-run mode for every consumer run-core
 *    threads it into — the `running` header WHILE the run is in flight, the platform-stamped tool
 *    step, the adapter-journaled llm step, and the billing rule that reads it.
 *  - UNCHANGED. A backend that implements only `resolveAuth()` runs exactly as it always did, whether
 *    it omits the property or carries an explicit `preflightAuth: undefined`.
 *  - FAIL-CLOSED. A preflight that throws, or that answers outside the neutral `AuthMode` vocabulary,
 *    ends the run before the header transition, before the cancellation controller is armed and
 *    before `backend.run()` — so the refusal writes nothing of its own. On the synchronous run
 *    surface that leaves no `runs` row, no `journal_steps` row and no `run_events` row at all; where
 *    the API enqueue already wrote an `enqueued` header, that row stays exactly as the enqueue left
 *    it.
 *  - OPAQUE. The credential-binding reference the deployment hands in reaches the backend byte-for-
 *    byte and reaches storage nowhere.
 */
import type {
  AgentSpec,
  AuthMode,
  Backend,
  NeutralTool,
  RunAuthPreflight,
  RunContext,
  RunResult,
} from '@rayspec/core';
import { schema } from '@rayspec/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runAgent } from './run-core.js';
import { insertEnqueuedRunHeader, RUN_STATUS_ENQUEUED, RUN_STATUS_RUNNING } from './run-header.js';
import {
  forTenant,
  makeTestDb,
  resetRunSchema,
  seedOrgs,
  TENANT_A,
} from './test-support/test-db.js';

const db = makeTestDb();

/** The mode the pre-identity `resolveAuth()` can honestly report: nothing is bound yet. */
const PRE_IDENTITY_MODE: AuthMode = 'unauthenticated';
/** The mode the preflight BINDS once it has the run identity. A subscription mode on purpose: it is
 *  the one the billing rule treats differently, so the ledger proves the mode was really carried. */
const BOUND_MODE: AuthMode = 'subscription-oauth-official-harness';

const spec: AgentSpec = {
  name: 'preflight_agent',
  instructions: 'answer',
  model: 'gpt-4.1-mini',
  input: 'a question',
  tools: [probeTool().spec],
  maxTurns: 4,
};

/** A read-only probe so the run produces a PLATFORM-stamped tool step next to the adapter's llm step. */
function probeTool(): NeutralTool {
  const parameters = {
    type: 'object',
    properties: { q: { type: 'string' } },
    required: ['q'],
    additionalProperties: false,
  };
  return {
    spec: { name: 'probe', description: 'A read-only probe (no side effect).', parameters },
    handler: () => ({ ok: true }),
    inputSchema: parameters,
    timeoutMs: 1000,
    idempotent: true,
  };
}

const USAGE = { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 };

/**
 * What every fake backend here does inside `run()`, exactly as a real adapter does: marshal one tool
 * call into the central dispatcher (which stamps run-core's authMode itself) and journal one llm step
 * attributed to the mode run-core threaded onto the context.
 */
async function executeRun(agentSpec: AgentSpec, ctx: RunContext): Promise<RunResult> {
  const authMode: AuthMode = ctx.authMode ?? 'unauthenticated';
  await ctx.dispatchTool?.('probe', { q: agentSpec.input }, 'probe-call-1');
  await ctx.journal.record({
    type: 'llm',
    idempotencyKey: `llm:${agentSpec.name}`,
    inputHash: `hash:${agentSpec.input}`,
    output: { finalText: 'answered' },
    usage: USAGE,
    costUsd: 0,
    model: agentSpec.model,
    producedBy: 'test-preflight-backend',
    latencyMs: 1,
    status: 'ok',
    authMode,
  });
  return {
    runId: ctx.runId,
    backend: 'openai',
    authMode,
    status: 'completed',
    finalText: 'answered',
    output: null,
    error: null,
    errorClass: null,
    conversation: [{ role: 'assistant', index: 0, parts: [{ kind: 'text', text: 'answered' }] }],
    usage: USAGE,
    costUsd: 0,
    stepCount: 2,
  };
}

/**
 * A REMOTE backend: its `resolveAuth()` is honest about having bound nothing, and its preflight binds
 * a mode once it is handed the run identity. `run()` BLOCKS until released, so the in-flight header
 * can be read while the run is genuinely executing.
 */
class RemoteBackend implements Backend {
  readonly id = 'openai' as const;
  resolveAuthCalls = 0;
  preflightCalls = 0;
  runs = 0;
  readonly payloads: RunAuthPreflight[] = [];
  boundAuthMode: AuthMode = BOUND_MODE;
  /** When set, the preflight rejects with this instead of binding a mode. */
  preflightError?: Error;
  /** The mode run-core threaded onto the context (what the adapter actually saw). */
  seenCtxAuthMode?: AuthMode;
  readonly entered: Promise<void>;
  #entered!: () => void;
  readonly #released: Promise<void>;
  #release!: () => void;

  constructor() {
    this.entered = new Promise<void>((resolve) => {
      this.#entered = resolve;
    });
    this.#released = new Promise<void>((resolve) => {
      this.#release = resolve;
    });
  }

  release(): void {
    this.#release();
  }

  async resolveAuth(): Promise<AuthMode> {
    this.resolveAuthCalls += 1;
    return PRE_IDENTITY_MODE;
  }

  async preflightAuth(preflight: RunAuthPreflight): Promise<AuthMode> {
    this.preflightCalls += 1;
    this.payloads.push(preflight);
    if (this.preflightError) throw this.preflightError;
    return this.boundAuthMode;
  }

  async run(agentSpec: AgentSpec, ctx: RunContext): Promise<RunResult> {
    this.runs += 1;
    this.#entered();
    await this.#released;
    this.seenCtxAuthMode = ctx.authMode;
    return executeRun(agentSpec, ctx);
  }
}

/** An already-released remote backend — for the arms that do not observe the in-flight window. */
function openRemote(): RemoteBackend {
  const backend = new RemoteBackend();
  backend.release();
  return backend;
}

/**
 * A LEGACY backend — `resolveAuth()` and nothing else. Built as an object LITERAL so the
 * explicit-undefined arm can spread it (a class instance's methods live on the prototype).
 */
function makeLegacyBackend(authMode: AuthMode = 'api-key') {
  const calls = { resolveAuth: 0, run: 0 };
  const backend: Backend & { calls: typeof calls } = {
    id: 'openai',
    calls,
    async resolveAuth(): Promise<AuthMode> {
      calls.resolveAuth += 1;
      return authMode;
    },
    async run(agentSpec: AgentSpec, ctx: RunContext): Promise<RunResult> {
      calls.run += 1;
      return executeRun(agentSpec, ctx);
    },
  };
  return backend;
}

async function readHeader(runId: string) {
  const rows = await db.select().from(schema.runs).where(eq(schema.runs.runId, runId));
  return rows[0];
}

async function readSteps(runId: string) {
  return db.select().from(schema.journalSteps).where(eq(schema.journalSteps.runId, runId));
}

async function readEvents(runId: string) {
  return db.select().from(schema.runEvents).where(eq(schema.runEvents.runId, runId));
}

beforeAll(async () => {
  await resetRunSchema(db);
});
beforeEach(async () => {
  await db.$client.unsafe(
    'TRUNCATE journal_steps, conversation_items, run_events, runs, idempotency_keys CASCADE',
  );
  await seedOrgs(db, TENANT_A);
});
afterAll(async () => {
  await db.$client.end();
});

describe('a preflight-bound mode is the run’s authoritative pre-run mode', () => {
  it('every journaled llm AND tool step carries the BOUND mode, and the ledger bills it as one', async () => {
    const tdb = forTenant(db, TENANT_A);
    const backend = openRemote();
    const runId = 'preflight-bound-run';

    const result = await runAgent(tdb, backend, spec, { runId, tools: [probeTool()] });

    // The preflight REPLACED the pre-run resolveAuth() — they are never both asked.
    expect(backend.preflightCalls).toBe(1);
    expect(backend.resolveAuthCalls).toBe(0);
    // The identity the platform minted, not anything the backend or a request body supplied.
    expect(backend.payloads[0]).toMatchObject({
      runId,
      tenantId: TENANT_A,
      agentName: spec.name,
      model: spec.model,
    });

    expect(backend.seenCtxAuthMode).toBe(BOUND_MODE);
    expect(result.authMode).toBe(BOUND_MODE);

    const steps = await readSteps(runId);
    expect(steps).toHaveLength(2);
    expect(steps.map((s) => s.type).sort()).toEqual(['llm', 'tool']);
    for (const step of steps) expect(step.authMode).toBe(BOUND_MODE);

    // Not merely a field: the bound mode reached the BILLING rule. The llm step has real usage, so
    // its registry-computed cost is non-zero while the subscription rule bills it at zero.
    const llm = steps.find((s) => s.type === 'llm');
    expect(Number(llm?.costUsd)).toBeGreaterThan(0);
    for (const step of steps) expect(step.billedCostUsd).toBe('0');

    expect((await readHeader(runId))?.authMode).toBe(BOUND_MODE);
  });

  it('the in-flight `running` header already carries the bound mode, before the run finishes', async () => {
    const tdb = forTenant(db, TENANT_A);
    const backend = new RemoteBackend();
    const runId = 'preflight-inflight-run';

    const pending = runAgent(tdb, backend, spec, { runId, tools: [probeTool()] });
    await backend.entered;

    const inFlight = await readHeader(runId);
    expect(inFlight?.status).toBe(RUN_STATUS_RUNNING);
    // FAIL-THE-FIX: with the pre-run resolution still coming from resolveAuth() this reads
    // 'unauthenticated' — the mode the remote backend had not bound.
    expect(inFlight?.authMode).toBe(BOUND_MODE);

    backend.release();
    expect((await pending).status).toBe('completed');
  });
});

describe('the credential-binding reference is opaque: forwarded verbatim, stored nowhere', () => {
  it('reaches the backend byte-for-byte and appears in no persisted row', async () => {
    const tdb = forTenant(db, TENANT_A);
    const backend = openRemote();
    const runId = 'preflight-binding-ref-run';
    const credentialBindingRef = 'lease/2026-08-02/9f3c-OPAQUE-HANDLE';

    await runAgent(tdb, backend, spec, { runId, tools: [probeTool()], credentialBindingRef });

    expect(backend.payloads[0]?.credentialBindingRef).toBe(credentialBindingRef);

    const persisted = JSON.stringify([
      await readHeader(runId),
      await readSteps(runId),
      await readEvents(runId),
    ]);
    expect(persisted).not.toContain(credentialBindingRef);
  });

  it('omits the key entirely when the deployment supplied no reference', async () => {
    const tdb = forTenant(db, TENANT_A);
    const backend = openRemote();
    const runId = 'preflight-no-binding-ref-run';

    await runAgent(tdb, backend, spec, { runId, tools: [probeTool()] });

    const payload = backend.payloads[0] as RunAuthPreflight;
    expect('credentialBindingRef' in payload).toBe(false);
    expect(Object.keys(payload).sort()).toEqual(['agentName', 'model', 'runId', 'tenantId']);
  });
});

describe('a backend that implements only resolveAuth() is unchanged', () => {
  it('is asked once, and its answer attributes the header and BOTH journaled steps', async () => {
    const tdb = forTenant(db, TENANT_A);
    const backend = makeLegacyBackend('api-key');
    const runId = 'legacy-omitted-run';

    const result = await runAgent(tdb, backend, spec, { runId, tools: [probeTool()] });

    expect(backend.calls.resolveAuth).toBe(1);
    expect(result.authMode).toBe('api-key');
    const steps = await readSteps(runId);
    expect(steps).toHaveLength(2);
    for (const step of steps) expect(step.authMode).toBe('api-key');
    expect((await readHeader(runId))?.authMode).toBe('api-key');
  });

  it('an EXPLICIT `preflightAuth: undefined` still takes the legacy path', async () => {
    const tdb = forTenant(db, TENANT_A);
    const legacy = makeLegacyBackend('api-key');
    // A presence test written as `'preflightAuth' in backend` would take the preflight arm here and
    // die on `backend.preflightAuth is not a function`.
    const backend = { ...legacy, preflightAuth: undefined };
    const runId = 'legacy-explicit-undefined-run';

    const result = await runAgent(tdb, backend, spec, { runId, tools: [probeTool()] });

    expect(legacy.calls.resolveAuth).toBe(1);
    expect(result.authMode).toBe('api-key');
    for (const step of await readSteps(runId)) expect(step.authMode).toBe('api-key');
  });

  it('an honest `unauthenticated` from resolveAuth() still COMPLETES — the new refusal is not on this path', async () => {
    const tdb = forTenant(db, TENANT_A);
    const backend = makeLegacyBackend('unauthenticated');
    const runId = 'legacy-unauthenticated-run';

    const result = await runAgent(tdb, backend, spec, { runId, tools: [probeTool()] });

    expect(result.status).toBe('completed');
    expect(result.authMode).toBe('unauthenticated');
    expect((await readHeader(runId))?.status).toBe('completed');
  });

  it('an OFF-VOCABULARY answer from resolveAuth() still completes and is still recorded as given', async () => {
    const tdb = forTenant(db, TENANT_A);
    // `resolveAuth()` is declared to return an `AuthMode`, but types are erased: a third-party backend
    // can return anything at runtime, and today such a run completes and records what it reported.
    // This arm is what the asymmetry buys — applying the preflight's fail-closed guard one call too
    // early would newly refuse this run, a failure the contract never had.
    const backend = makeLegacyBackend('bound-somehow' as AuthMode);
    const runId = 'legacy-off-vocabulary-run';

    const result = await runAgent(tdb, backend, spec, { runId, tools: [probeTool()] });

    expect(result.status).toBe('completed');
    expect(result.authMode).toBe('bound-somehow');
    const header = await readHeader(runId);
    expect(header?.status).toBe('completed');
    expect(header?.authMode).toBe('bound-somehow');
    for (const step of await readSteps(runId)) expect(step.authMode).toBe('bound-somehow');
  });
});

describe('a refused preflight ends the run before it writes anything of its own', () => {
  // Deliberately NOT wrapped in `tdb.transaction(...)`: a rollback would make "no header row" true
  // for the wrong reason, and the arm would pass even if the preflight ran after the header
  // transition. Outside a transaction, an absent row means the write never happened.
  it('SYNC: a THROW propagates verbatim and leaves no run, no journal step and no event', async () => {
    const tdb = forTenant(db, TENANT_A);
    const backend = openRemote();
    backend.preflightError = new Error('cloud: no binding for tenant');
    const runId = 'preflight-throw-run';

    await expect(runAgent(tdb, backend, spec, { runId, tools: [probeTool()] })).rejects.toThrow(
      'cloud: no binding for tenant',
    );

    expect(backend.runs).toBe(0);
    expect(await readHeader(runId)).toBeUndefined();
    expect(await readSteps(runId)).toHaveLength(0);
    expect(await readEvents(runId)).toHaveLength(0);
  });

  it('ASYNC: an enqueue-time header SURVIVES the refusal, untouched at `enqueued`', async () => {
    // The arm above is the SYNCHRONOUS surface, where run-core owns the whole header. A run enqueued
    // through the API is different and the difference is worth pinning rather than glossing: that
    // path writes an `enqueued` header BEFORE handing the job over, outside the transaction the
    // durable worker wraps the run in, so a refusal cannot roll it back. What the refusal must not do
    // is ADVANCE it — no `running` transition, no terminal write — or add a journal row or an event.
    const tdb = forTenant(db, TENANT_A);
    const backend = openRemote();
    backend.preflightError = new Error('cloud: no binding for tenant');
    const runId = 'preflight-throw-enqueued-run';

    await insertEnqueuedRunHeader(tdb, {
      runId,
      backend: 'openai',
      agentName: spec.name,
      model: spec.model,
    });
    const enqueued = await readHeader(runId);

    await expect(runAgent(tdb, backend, spec, { runId, tools: [probeTool()] })).rejects.toThrow(
      'cloud: no binding for tenant',
    );

    expect(backend.runs).toBe(0);
    expect(await readHeader(runId)).toEqual(enqueued);
    expect((await readHeader(runId))?.status).toBe(RUN_STATUS_ENQUEUED);
    expect(await readSteps(runId)).toHaveLength(0);
    expect(await readEvents(runId)).toHaveLength(0);
  });

  it('a fabricated mode can never reach runs.auth_mode or journal_steps.auth_mode', async () => {
    const tdb = forTenant(db, TENANT_A);
    const backend = openRemote();
    // Both columns are plain `text NOT NULL` with no CHECK constraint, so the fail-closed guard is
    // the only thing standing between a fabricated mode and the audit record.
    backend.boundAuthMode = 'bound-somehow' as AuthMode;
    const runId = 'preflight-fabricated-mode-run';

    await expect(runAgent(tdb, backend, spec, { runId, tools: [probeTool()] })).rejects.toThrow(
      /outside the neutral AuthMode vocabulary/,
    );

    expect(backend.runs).toBe(0);
    expect(await readHeader(runId)).toBeUndefined();
    expect(await readSteps(runId)).toHaveLength(0);
    expect(await readEvents(runId)).toHaveLength(0);
  });
});
