/**
 * Manual-trigger fire E2E — the consumer's control path over REAL HTTP, wired whole: the fire route →
 * the composition root's `ManualTriggerFirer` → the wired `DbosCronScheduler` → the durable enqueue.
 * Boots the REAL composition root (`assembleServer`) on a throwaway DATABASE with a
 * `deployment.durableWorker:true` spec declaring a `kind: manual` trigger with an AGENT action, and
 * pins the #322 contract on ground truth:
 *
 *   1. `POST /v1/triggers/{name}/fire` on an agent-action trigger answers 202 with the enqueued run's
 *      `runId` and the `/v1/runs/{id}/events` path — the run this fire started is followable through
 *      the public API (no client-side re-derivation of the internal deterministic id, no polling a
 *      runs listing).
 *   2. THE HEADER ALIGNMENT: `GET /v1/runs/{id}` resolves that id IMMEDIATELY (200, never 404) —
 *      the fire path writes the SAME pre-enqueue run header the `async:true` run surface writes, so
 *      the id resolves for the whole run instead of 404ing until the run's own header commits (and
 *      forever, if the run ends by throwing).
 *
 * The response SHAPES of a handler-action fire / a deduped no-op (no runId key) are pinned
 * deterministically in api-auth's triggers.db.test.ts (fake firer) and durable-dbos's
 * cron-scheduler-run-header.db.test.ts (stub executor + controlled instants); this test covers the
 * composition-root WIRING those tests cannot.
 *
 * The principal is provisioned through the operator-gated `POST /v1/auth/bootstrap-tenant` (the ONLY
 * HTTP surface with a client-chosen org id) so the caller's org IS the deployment tenant the fire is
 * reconciled against (`RAYSPEC_CRON_TENANT_ID`).
 *
 * Launches a REAL DBOS engine (separate auto-created `<appdb>_dbos_sys` system database); a whole
 * throwaway APP database is created + dropped, and the derived system DB is dropped on teardown.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentSpec, Backend, BackendId, RunContext, RunResult } from '@rayspec/core';
import { registerScopedTables } from '@rayspec/db/testing';
import type { PgTable } from 'drizzle-orm/pg-core';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assembleServer, type BootedServer, loadServerConfig } from './composition-root.js';

/** A deterministic, network-free Backend wired as `openai` (same shape as durable-worker-cron-boot). */
class FakeBackend implements Backend {
  readonly id = 'openai' as const;
  async resolveAuth() {
    return 'api-key' as const;
  }
  async run(spec: AgentSpec, ctx: RunContext): Promise<RunResult> {
    const finalText = `echo: ${spec.input}`;
    await ctx.onEvent?.({ type: 'run_started', runId: ctx.runId } as never);
    await ctx.journal.record({
      type: 'llm',
      idempotencyKey: `llm:${spec.name}:0`,
      inputHash: `hash:${spec.input}`,
      output: { finalText },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      costUsd: 0,
      model: spec.model,
      producedBy: 'fake-manual-fire-backend',
      latencyMs: 1,
      status: 'ok',
      authMode: 'api-key',
    });
    await ctx.onEvent?.({
      type: 'run_completed',
      runId: ctx.runId,
      status: 'ok',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
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
      conversation: [],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      costUsd: 0,
      stepCount: 1,
    };
  }
}

/** A durable worker + a `digest` agent + a MANUAL trigger firing that agent (the on-demand path). */
const MANUAL_SPEC_YAML = `
version: '1.0'
metadata:
  name: manual-fire-test
deployment:
  durableWorker: true
agents:
  - id: digest
    name: digest-agent
    backend: openai
    model: gpt-4o-mini
    instructions: Summarize.
    maxTurns: 2
triggers:
  - name: manual-digest
    kind: manual
    action: { kind: agent, agent: digest }
`;

/** The deployment tenant — CHOSEN, so the bootstrap route can create the org under exactly this id. */
const CRON_TENANT = '00000000-0000-4000-8000-0000000000fe';

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

const SUITE_DB = `rayspec_server_manualfire_${process.pid}`;
const DBOS_SYS_DB = `${SUITE_DB}_dbos_sys`;

describe('manual-trigger fire E2E — the 202 hands back a followable run', () => {
  const baseUrl = process.env.DATABASE_URL;
  const maybe = baseUrl ? it : it.skip;
  const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
  // un-skippable ran-guard (fires synchronously at collection): this DB-backed E2E must never
  // silently self-skip to a false green. When the DB is REQUIRED but absent, hard-fail rather than skip.
  if (requireDb && !baseUrl) {
    throw new Error(
      'manual-trigger-fire-e2e.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but ' +
        'absent — refusing to silently skip this DB-backed suite.',
    );
  }

  let tmpDir = '';
  let server: BootedServer | undefined;
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    'RAYSPEC_JWT_SIGNING_KEY',
    'RAYSPEC_API_KEY_PEPPER',
    'DATABASE_URL',
    'ALLOWED_ORIGINS',
    'PORT',
    'RAYSPEC_SPEC_PATH',
    'RAYSPEC_CRON_TENANT_ID',
    'RAYSPEC_TENANT_BOOTSTRAP_ENABLED',
    'DBOS_SYSTEM_DATABASE_URL',
  ] as const;

  beforeAll(async () => {
    if (!baseUrl) return;
    const admin = postgres(adminUrl(baseUrl), { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${DBOS_SYS_DB}" WITH (FORCE)`);
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE "${SUITE_DB}"`);
    } finally {
      await admin.end();
    }

    tmpDir = mkdtempSync(join(tmpdir(), 'rayspec-manual-fire-'));
    const specPath = join(tmpDir, 'rayspec.yaml');
    writeFileSync(specPath, MANUAL_SPEC_YAML, 'utf8');

    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    process.env.RAYSPEC_JWT_SIGNING_KEY = await exportPKCS8(privateKey);
    process.env.RAYSPEC_API_KEY_PEPPER = 'manual-fire-pepper-only';
    process.env.DATABASE_URL = withDbName(baseUrl, SUITE_DB);
    delete process.env.ALLOWED_ORIGINS;
    process.env.PORT = '8803';
    process.env.RAYSPEC_SPEC_PATH = specPath;
    process.env.RAYSPEC_CRON_TENANT_ID = CRON_TENANT;
    // The operator posture: the bootstrap route is how this suite makes the caller's org BE the
    // deployment tenant (a public register cannot choose an org id — by design).
    process.env.RAYSPEC_TENANT_BOOTSTRAP_ENABLED = 'true';
    delete process.env.DBOS_SYSTEM_DATABASE_URL;

    server = await assembleServer(loadServerConfig(), {
      agentBackendsFactory: (): ReadonlyMap<BackendId, Backend> =>
        new Map<BackendId, Backend>([['openai', new FakeBackend()]]),
      registerProductTables: (tables: ReadonlyMap<string, PgTable>) => {
        registerScopedTables([...tables.values()]);
      },
    });
  }, 120_000);

  afterAll(async () => {
    await server?.close().catch(() => {});
    for (const k of ENV_KEYS) {
      const v = savedEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    if (baseUrl) {
      const admin = postgres(adminUrl(baseUrl), { max: 1 });
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${DBOS_SYS_DB}" WITH (FORCE)`);
        await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    }
  }, 60_000);

  maybe(
    'an agent-action fire answers 202 + runId + events, and GET /v1/runs/{id} resolves IMMEDIATELY',
    async () => {
      const app = (server as BootedServer).app;

      // Provision the owner INSIDE the deployment tenant: the bootstrap route creates the org under
      // the CHOSEN id (= RAYSPEC_CRON_TENANT_ID) with this user as owner, in one transaction.
      const boot = await app.request('/v1/auth/bootstrap-tenant', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'fire-owner@example.test',
          password: 'a-long-enough-password',
          orgName: 'Fire Tenant',
          orgId: CRON_TENANT,
        }),
      });
      expect(boot.status).toBe(201);
      const t0 = ((await boot.json()) as { accessToken: string }).accessToken;
      const sw = await app.request(`/v1/orgs/${CRON_TENANT}/switch`, {
        method: 'POST',
        headers: { authorization: `Bearer ${t0}` },
      });
      expect(sw.status).toBe(200);
      const token = ((await sw.json()) as { accessToken: string }).accessToken;

      // FIRE. The dispatched action is an AGENT action, so the 202 must hand back the run it
      // enqueued: the real id plus the events path (the same shape the async run surface's 202
      // advertises) — not the bare `{ name, fired }` that leaves the run unfollowable.
      const fire = await app.request('/v1/triggers/manual-digest/fire', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(fire.status).toBe(202);
      const body = (await fire.json()) as {
        name: string;
        fired: boolean;
        runId?: string;
        events?: string;
      };
      expect(body.name).toBe('manual-digest');
      expect(body.fired).toBe(true);
      expect(typeof body.runId).toBe('string');
      expect(body.events).toBe(`/v1/runs/${body.runId}/events`);

      // THE HEADER ALIGNMENT (red without it): the returned id resolves IMMEDIATELY — the fire path
      // wrote the run's `enqueued` header BEFORE the enqueue, exactly like the HTTP async path, so
      // the caller is never handed an id that 404s until (or forever, on a throwing run past) the
      // worker's own header commit.
      const read = await app.request(`/v1/runs/${body.runId}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(read.status).toBe(200);
      const run = (await read.json()) as { runId: string; status: string };
      expect(run.runId).toBe(body.runId);
      // Whatever phase the off-request run is in by now, the status is one of the documented four —
      // never a 404 gap between the 202 and the run's own writes.
      expect(['enqueued', 'running', 'completed', 'error']).toContain(run.status);
    },
    120_000,
  );
});
