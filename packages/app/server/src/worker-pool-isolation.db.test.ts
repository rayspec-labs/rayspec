/**
 * Worker pool-ISOLATION DB test — the durable worker must hold its OWN
 * postgres pool, SEPARATE from the HTTP/API pool, so long off-request runs (each holds ONE connection
 * across the whole LLM call inside `forTenant(workerDb).transaction()`) cannot starve `GET /events` /
 * `/health` / every HTTP DB caller.
 *
 * Unlike the prior version (a GENERIC postgres-js pool property test that NEVER imported the
 * composition root — a `workerDb = db` regression PASSED it), this drives the REAL composition root
 * (`assembleServer`) on ground truth (fail-the-fix, not pass-the-shape):
 *
 *   1. boot `assembleServer` with a `deployment.durableWorker:true` spec + a GATED FakeBackend whose
 *      `run()` BLOCKS on a test-controlled gate — so each in-flight off-request run HOLDS its
 *      worker-pool connection (inside `forTenant(workerDb).transaction()`) until released;
 *   2. saturate the worker by firing `WORKER_CONCURRENCY` `async:true` runs and WAITING (a barrier,
 *      no fixed sleeps) until every one is confirmed gated in-flight (all worker-pool run-tx
 *      connections held);
 *   3. while the worker pool is fully saturated, assert `GET /health` (which round-trips the HTTP /
 *      `deps.db` pool) STILL returns 200 within a wall-clock bound — the HTTP pool is unaffected;
 *   4. release the gate, let the runs finish, `server.close()`.
 *
 * FAIL-THE-FIX: if the worker shared the HTTP pool (`composition-root.ts`'s `workerDb = db`), the
 * saturated worker would exhaust the shared pool (max 4) and `GET /health`'s `select 1` would block
 * waiting for a connection → TIMEOUT (status !== 200) → RED. Proven by shadow-mutating
 * composition-root.ts and confirming this test goes RED, then restoring byte-identical.
 *
 * `WORKER_CONCURRENCY` mirrors the composition root's hardcoded `DEFAULT_WORKER_CONCURRENCY` (4) — the
 * spec/config cannot make it smaller, but 4 gated runs is still fast + deterministic (a real barrier,
 * not a sleep, gates each run open and the test releases them all at the end).
 *
 * It launches a REAL DBOS engine (needs a SEPARATE derived `<appdb>_dbos_sys` database DBOS
 * auto-creates) against a throwaway APP database; both are dropped on teardown. (Mirrors
 * durable-worker-boot.db.test.ts's isolation: a whole throwaway DATABASE, not a schema.)
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentSpec, Backend, BackendId, RunContext, RunResult } from '@rayspec/core';
import { registerScopedTables } from '@rayspec/db/testing';
import { DEFAULT_WORKER_CONCURRENCY } from '@rayspec/durable-dbos';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assembleServer,
  type BootedServer,
  deriveDbosSystemUrl,
  loadServerConfig,
} from './composition-root.js';

/** Mirrors the composition root's hardcoded worker concurrency — what we must saturate the pool to. */
const WORKER_CONCURRENCY = DEFAULT_WORKER_CONCURRENCY;

/**
 * A GATED, network-free Backend wired as `openai`. Each `run()` drives the REAL run-core pipeline
 * (so the run executes inside `forTenant(workerDb).transaction()`, holding one worker-pool connection)
 * but then BLOCKS on `releaseGate` — so a saturated worker keeps all its run-tx connections held until
 * the test releases. `onEntered` resolves the entry barrier (so the test knows the run is in-flight,
 * inside its tx, holding a connection). After release it finishes a normal run so the job succeeds.
 */
class GatedBackend implements Backend {
  readonly id = 'openai' as const;
  inFlight = 0;
  #releaseGate: Promise<void>;
  #onEntered: () => void;
  constructor(releaseGate: Promise<void>, onEntered: () => void) {
    this.#releaseGate = releaseGate;
    this.#onEntered = onEntered;
  }
  async resolveAuth() {
    return 'api-key' as const;
  }
  async run(spec: AgentSpec, ctx: RunContext): Promise<RunResult> {
    this.inFlight += 1;
    this.#onEntered(); // the run is now executing INSIDE its tx, holding a worker-pool connection
    await this.#releaseGate; // hold the connection until the test releases
    const finalText = `echo: ${spec.input}`;
    await ctx.onEvent?.({ type: 'run_started', runId: ctx.runId } as never);
    await ctx.journal.record({
      type: 'llm',
      idempotencyKey: `llm:${spec.name}:0`,
      inputHash: `hash:${spec.input}`,
      output: { finalText },
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
      costUsd: 0.001,
      model: spec.model,
      producedBy: 'gated-backend',
      latencyMs: 1,
      status: 'ok',
      authMode: 'api-key',
    });
    await ctx.onEvent?.({
      type: 'run_completed',
      runId: ctx.runId,
      status: 'ok',
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
    } as never);
    return {
      runId: ctx.runId,
      backend: this.id,
      authMode: 'api-key',
      status: 'completed',
      finalText,
      output: null,
      error: null,
      errorClass: null,
      conversation: [
        { role: 'user', index: 0, parts: [{ kind: 'text', text: spec.input }] },
        { role: 'assistant', index: 1, parts: [{ kind: 'text', text: finalText }] },
      ],
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
      costUsd: 0.001,
      stepCount: 1,
    };
  }
}

const SPEC_YAML = `
version: '1.0'
metadata:
  name: worker-pool-isolation-test
  description: durable-worker pool-isolation fixture
deployment:
  durableWorker: true
stores:
  - name: notes
    columns:
      - { name: body, type: text }
api:
  - { method: POST, path: '/echo', action: { kind: agent, agent: echo } }
agents:
  - id: echo
    name: echo-agent
    backend: openai
    model: gpt-4o-mini
    instructions: Echo the input back.
    maxTurns: 2
`;

function adminUrl(url: string): string {
  const u = new URL(url);
  u.pathname = '/postgres';
  return u.toString();
}
function withDbName(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

/** Resolve once `p` settles, or 'TIMEOUT' after `ms` — a wall-clock bound for the /health probe. */
async function within<T>(p: Promise<T>, ms: number): Promise<T | 'TIMEOUT'> {
  let t: ReturnType<typeof setTimeout>;
  const timeout = new Promise<'TIMEOUT'>((res) => {
    t = setTimeout(() => res('TIMEOUT'), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

const SUITE_DB = `rayspec_server_pooliso_${process.pid}`;

describe('durable worker pool isolation — a saturated worker pool does NOT starve the HTTP pool', () => {
  const baseUrl = process.env.DATABASE_URL;
  const maybe = baseUrl ? it : it.skip;
  const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
  // un-skippable ran-guard (fires synchronously at collection): this DB-backed worker-isolation SECURITY
  // suite must never silently self-skip to a false green. When the DB is REQUIRED but absent, hard-fail.
  if (requireDb && !baseUrl) {
    throw new Error(
      'worker-pool-isolation.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but ' +
        'absent — refusing to silently skip a security-load-bearing suite.',
    );
  }

  let server: BootedServer | undefined;
  let dbosSysDb = '';
  let tmpDir = '';
  let release!: () => void;
  let releaseGate!: Promise<void>;
  let allEntered!: Promise<void>;
  let backend!: GatedBackend;
  let accessToken = '';
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    'RAYSPEC_JWT_SIGNING_KEY',
    'RAYSPEC_API_KEY_PEPPER',
    'DATABASE_URL',
    'ALLOWED_ORIGINS',
    'PORT',
    'RAYSPEC_SPEC_PATH',
    'DBOS_SYSTEM_DATABASE_URL',
  ] as const;

  beforeAll(async () => {
    if (!baseUrl) return;
    const appDbUrl = withDbName(baseUrl, SUITE_DB);
    dbosSysDb = `${SUITE_DB}_dbos_sys`;

    const admin = postgres(adminUrl(baseUrl), { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${dbosSysDb}" WITH (FORCE)`);
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE "${SUITE_DB}"`);
    } finally {
      await admin.end();
    }

    tmpDir = mkdtempSync(join(tmpdir(), 'rayspec-pooliso-'));
    const specPath = join(tmpDir, 'rayspec.yaml');
    writeFileSync(specPath, SPEC_YAML, 'utf8');

    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    process.env.RAYSPEC_JWT_SIGNING_KEY = await exportPKCS8(privateKey);
    process.env.RAYSPEC_API_KEY_PEPPER = 'pool-iso-pepper-only';
    process.env.DATABASE_URL = appDbUrl;
    delete process.env.ALLOWED_ORIGINS;
    process.env.PORT = '8802';
    process.env.RAYSPEC_SPEC_PATH = specPath;
    delete process.env.DBOS_SYSTEM_DATABASE_URL;

    const config = loadServerConfig();
    expect(deriveDbosSystemUrl(appDbUrl)).toBe(withDbName(baseUrl, dbosSysDb));

    // The entry barrier: resolves once all WORKER_CONCURRENCY runs are confirmed gated in-flight.
    let enteredCount = 0;
    let onAllEntered!: () => void;
    allEntered = new Promise<void>((res) => {
      onAllEntered = res;
    });
    releaseGate = new Promise<void>((res) => {
      release = res;
    });
    backend = new GatedBackend(releaseGate, () => {
      enteredCount += 1;
      if (enteredCount === WORKER_CONCURRENCY) onAllEntered();
    });

    server = await assembleServer(config, {
      agentBackendsFactory: (): ReadonlyMap<BackendId, Backend> =>
        new Map<BackendId, Backend>([['openai', backend]]),
      registerProductTables: (tables) => {
        registerScopedTables([...tables.values()]);
      },
    });

    // Authenticate once: register → create org → switch (the permission-scoped token the run surface
    // requires — the working pattern from durable-worker-boot.db.test.ts).
    const reg = await server.app.request('/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'pooliso@example.test',
        password: 'correct-horse-battery-staple-9',
      }),
    });
    expect(reg.status).toBe(201);
    const t0 = (await reg.json()).accessToken as string;
    const orgRes = await server.app.request('/v1/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${t0}` },
      body: JSON.stringify({ name: 'Pool Iso Co' }),
    });
    expect(orgRes.status).toBe(201);
    const orgId = (await orgRes.json()).id as string;
    const switchRes = await server.app.request(`/v1/orgs/${orgId}/switch`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t0}` },
    });
    expect(switchRes.status).toBe(200);
    accessToken = (await switchRes.json()).accessToken as string;
  }, 120_000);

  afterAll(async () => {
    // Release any still-gated runs so the worker can drain cleanly, then close (drains the worker +
    // its own pool BEFORE ending the app pool).
    if (release) release();
    await server?.close();
    for (const k of ENV_KEYS) {
      const v = savedEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    if (baseUrl) {
      const admin = postgres(adminUrl(baseUrl), { max: 1 });
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${dbosSysDb}" WITH (FORCE)`);
        await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    }
  }, 60_000);

  maybe(
    'a worker pool saturated by WORKER_CONCURRENCY held runs does NOT starve GET /health (the separate-pool fix)',
    async () => {
      // 1. Fire WORKER_CONCURRENCY async:true runs OFF-REQUEST — each enqueues + returns 202, then the
      //    worker picks each up and BLOCKS inside its tx (holding one worker-pool connection).
      for (let i = 0; i < WORKER_CONCURRENCY; i++) {
        const accepted = await server!.app.request('/v1/agents/echo/runs', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${accessToken}`,
            accept: 'application/json',
          },
          body: JSON.stringify({ input: `saturate-${i}`, async: true }),
        });
        expect(accepted.status).toBe(202);
      }

      // 2. WAIT until every run is confirmed gated in-flight (a real barrier — all worker-pool run-tx
      //    connections are now held). Bounded so a wiring failure fails loudly instead of hanging.
      const entered = await within(allEntered, 30_000);
      expect(entered).not.toBe('TIMEOUT');
      expect(backend.inFlight).toBe(WORKER_CONCURRENCY);

      // 3. THE ASSERTION: with the worker pool fully saturated, GET /health (HTTP/deps.db pool) must
      //    STILL return 200 promptly. SEPARATE pools ⇒ the HTTP pool is untouched ⇒ 200. SHARED pool
      //    (the regression `workerDb = db`) ⇒ the saturated worker exhausts the shared pool ⇒ the
      //    /health `select 1` blocks for a connection ⇒ TIMEOUT (status !== 200) ⇒ RED.
      const probe = (async () => {
        const res = await server!.app.request('/health');
        return res.status;
      })();
      const status = await within(probe, 3_000);
      expect(status).toBe(200);

      // 4. Release the held runs so they finish and the suite drains cleanly.
      release();
    },
    90_000,
  );
});
