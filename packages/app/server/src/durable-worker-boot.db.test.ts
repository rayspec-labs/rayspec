/**
 * DURABLE-WORKER boot test — the composition-root worker wiring had ZERO
 * coverage. This boots the REAL composition root (`assembleServer`) against a throwaway DATABASE with
 * a `deployment.durableWorker:true` spec + a deterministic FakeBackend (injected via
 * `agentBackendsFactory`) + the A1 `registerProductTables` hook, then asserts END-TO-END on ground
 * truth (fail-the-fix, not pass-the-shape):
 *
 *   1. an `async:true` POST → 202 `{ runId, status:'enqueued', events }` OFF-REQUEST (the request
 *      returns before the run completes);
 *   2. the job runs on the WIRED executor — the REAL `resolveRun` closure (NOT a stub) → the run
 *      header + journal + run_events persist tenant-scoped under the runId, with the GUC populated
 *      (proven indirectly: the writes are tenant-scoped, which is what the GUC-wrapped tx commits);
 *   3. `server.close()` DRAINS the worker (DBOS shutdown + the worker's own pool end) BEFORE ending
 *      the app DB pool — close() resolves cleanly with no leaked connection.
 *
 * This also exercises fix F (the executor is started AFTER deploy() binds the agent registry — a job
 * dispatched at launch resolves correctly) and fix B (the worker gets its OWN postgres pool).
 *
 * It launches a REAL DBOS engine, which needs a SEPARATE system database (the composition root
 * derives `<appdb>_dbos_sys`, which DBOS auto-creates). We create the throwaway APP database and drop
 * BOTH it and the derived system DB on teardown. DB ISOLATION: a whole throwaway DATABASE (not a
 * schema) — the migration chain materializes the platform into a database's default + `drizzle`
 * schema, exactly as boot.smoke.test.ts does.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentSpec, Backend, BackendId, RunContext, RunResult } from '@rayspec/core';
import { registerScopedTables } from '@rayspec/db/testing';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assembleServer,
  type BootedServer,
  deriveDbosSystemUrl,
  loadServerConfig,
} from './composition-root.js';

/**
 * A deterministic, network-free Backend wired as `openai` — it drives the REAL run-core pipeline
 * (emits run_started → text_delta → run_completed via ctx.onEvent; journals one `llm` step) so the
 * run header / journal / run_events tables are populated EXACTLY as a real off-request run would,
 * WITHOUT any model call. (Same shape as durable-dbos's FakeSpineBackend; kept local to this test.)
 */
class FakeBackend implements Backend {
  readonly id = 'openai' as const;
  async resolveAuth() {
    return 'api-key' as const;
  }
  async run(spec: AgentSpec, ctx: RunContext): Promise<RunResult> {
    const finalText = `echo: ${spec.input}`;
    await ctx.onEvent?.({ type: 'run_started', runId: ctx.runId } as never);
    await ctx.onEvent?.({ type: 'text_delta', runId: ctx.runId, text: finalText } as never);
    await ctx.journal.record({
      type: 'llm',
      idempotencyKey: `llm:${spec.name}:0`,
      inputHash: `hash:${spec.input}`,
      output: { finalText },
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
      costUsd: 0.001,
      model: spec.model,
      producedBy: 'fake-boot-backend',
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
  name: durable-boot-test
  description: minimal durable-worker boot fixture
deployment:
  durableWorker: true
stores:
  - name: notes
    columns:
      - { name: body, type: text }
api:
  - { method: POST, path: '/notes', action: { kind: store, store: notes, op: create } }
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

const SUITE_DB = `rayspec_server_durable_${process.pid}`;

describe('durable-worker boot — real composition root wires + runs an async off-request run', () => {
  const baseUrl = process.env.DATABASE_URL;
  const maybe = baseUrl ? it : it.skip;
  const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
  // un-skippable ran-guard (fires synchronously at collection): this DB-backed boot suite must never
  // silently self-skip to a false green. When the DB is REQUIRED but absent, hard-fail rather than skip.
  if (requireDb && !baseUrl) {
    throw new Error(
      'durable-worker-boot.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but ' +
        'absent — refusing to silently skip this DB-backed suite.',
    );
  }

  let server: BootedServer | undefined;
  let appDbUrl = '';
  let dbosSysDb = '';
  let tmpDir = '';
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
    appDbUrl = withDbName(baseUrl, SUITE_DB);
    dbosSysDb = `${SUITE_DB}_dbos_sys`; // what deriveDbosSystemUrl produces from appDbUrl

    // Fresh empty throwaway APP database (drop any leftover app + DBOS-sys DB first).
    const admin = postgres(adminUrl(baseUrl), { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${dbosSysDb}" WITH (FORCE)`);
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE "${SUITE_DB}"`);
    } finally {
      await admin.end();
    }

    // Write the spec to a temp file the composition root reads via RAYSPEC_SPEC_PATH.
    tmpDir = mkdtempSync(join(tmpdir(), 'rayspec-durable-boot-'));
    const specPath = join(tmpDir, 'rayspec.yaml');
    writeFileSync(specPath, SPEC_YAML, 'utf8');

    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    process.env.RAYSPEC_JWT_SIGNING_KEY = await exportPKCS8(privateKey);
    process.env.RAYSPEC_API_KEY_PEPPER = 'durable-boot-pepper-only';
    process.env.DATABASE_URL = appDbUrl;
    delete process.env.ALLOWED_ORIGINS;
    process.env.PORT = '8801';
    process.env.RAYSPEC_SPEC_PATH = specPath;
    delete process.env.DBOS_SYSTEM_DATABASE_URL; // exercise the derived <appdb>_dbos_sys path

    const config = loadServerConfig();
    // Sanity: the derived system DB url matches what we will drop on teardown (fix B/F wiring).
    expect(deriveDbosSystemUrl(appDbUrl)).toBe(withDbName(baseUrl, dbosSysDb));

    // The A1 product-table registrar (the LOCAL stand-in for a committed product-schema tuple) + the
    // FakeBackend wired as the `openai` adapter the declared `echo` agent resolves to.
    server = await assembleServer(config, {
      agentBackendsFactory: (): ReadonlyMap<BackendId, Backend> =>
        new Map<BackendId, Backend>([['openai', new FakeBackend()]]),
      registerProductTables: (tables) => {
        // Register THOSE exact product-table instances (deploy() verifies the same objects — A1).
        registerScopedTables([...tables.values()]);
      },
    });
  }, 120_000);

  afterAll(async () => {
    // close() must DRAIN the worker (DBOS shutdown + worker-pool end) BEFORE ending the app pool.
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
    'async:true POST → 202 off-request → the WIRED worker runs runAgent → header/journal/run_events persist',
    async () => {
      // 1. Register → create org → SWITCH to get a token scoped to the org's membership role
      //    (which carries agent:run). Register alone returns a token whose org is active but not the
      //    switched, permission-scoped token the run surface requires (the working pattern from
      //    deploy-acceptance.db.test.ts).
      const reg = await server!.app.request('/v1/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'durable@example.test',
          password: 'correct-horse-battery-staple-9',
        }),
      });
      expect(reg.status).toBe(201);
      const t0 = (await reg.json()).accessToken as string;
      const orgRes = await server!.app.request('/v1/orgs', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${t0}` },
        body: JSON.stringify({ name: 'Durable Co' }),
      });
      expect(orgRes.status).toBe(201);
      const orgId = (await orgRes.json()).id as string;
      const switchRes = await server!.app.request(`/v1/orgs/${orgId}/switch`, {
        method: 'POST',
        headers: { authorization: `Bearer ${t0}` },
      });
      expect(switchRes.status).toBe(200);
      const accessToken = (await switchRes.json()).accessToken as string;

      // 2. The declared agent route is POST /echo (action kind:agent). Drive the async path via the
      //    generic run surface POST /v1/agents/echo/runs with async:true (the same surface the
      //    declared route reuses). 202 + enqueued, OFF-REQUEST (no blocking on the run).
      const accepted = await server!.app.request('/v1/agents/echo/runs', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${accessToken}`,
          accept: 'application/json',
        },
        body: JSON.stringify({ input: 'off-request please', async: true }),
      });
      expect(accepted.status).toBe(202);
      const body = (await accepted.json()) as {
        runId: string;
        status: string;
        events: string;
      };
      expect(body.status).toBe('enqueued');
      expect(typeof body.runId).toBe('string');
      expect(body.events).toBe(`/v1/runs/${body.runId}/events`);

      // 3. Poll GET /v1/runs/{id} until the off-request run completes on the WIRED worker (the REAL
      //    resolveRun closure, NOT a stub) — proving the composition root actually wired + started it.
      const runId = body.runId;
      let completed: { status: string; finalText: string; stepCount: number } | undefined;
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const get = await server!.app.request(`/v1/runs/${runId}`, {
          headers: { authorization: `Bearer ${accessToken}` },
        });
        if (get.status === 200) {
          const r = (await get.json()) as { status: string; finalText: string; stepCount: number };
          if (r.status === 'completed') {
            completed = r;
            break;
          }
        }
        await new Promise((res) => setTimeout(res, 200));
      }
      expect(completed).toBeDefined();
      expect(completed!.status).toBe('completed');
      expect(completed!.finalText).toBe('echo: off-request please');
      expect(completed!.stepCount).toBeGreaterThanOrEqual(1);

      // 4. The durable run_events stream persisted (run_started … run_completed) — the resumable read
      //    path the client streams completion from. Tenant-scoped via the same authed token.
      const events = await server!.app.request(`/v1/runs/${runId}/events`, {
        headers: { authorization: `Bearer ${accessToken}`, accept: 'text/event-stream' },
      });
      expect(events.status).toBe(200);
      const text = await events.text();
      expect(text).toContain('event: run_started');
      expect(text).toContain('event: run_completed');
    },
    90_000,
  );
});
