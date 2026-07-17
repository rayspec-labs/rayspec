/**
 * CRON-worker boot test — the composition-root cron wiring had ZERO
 * automated coverage (only the CI-excluded dev-server exercised it). This boots the REAL composition
 * root (`assembleServer`) against a throwaway DATABASE with a `deployment.durableWorker:true` spec that
 * declares a `cron` trigger + `RAYSPEC_CRON_TENANT_ID`, and asserts the WHOLE composition-root OUTPUT
 * + the fail-closed boot guards on GROUND TRUTH (fail-the-fix, not pass-the-shape):
 *
 *   1. BOOT: `assembleServer` boots with a cron spec + a valid, EXISTING cron tenant.
 *   2. OUTPUT: `server.declaredCronTriggers` surfaces the declared cron name (the banner feed) — the
 *      composition root actually wired the scheduler from the deployed trigger registry. The scheduled
 *      DBOS workflow was registered in the PRE-LAUNCH window (no post-launch-registration throw — a
 *      throw there would abort the boot, so a clean boot IS that assertion).
 *   3. FAIL-CLOSED: a cron spec WITHOUT a durable worker (deployment.durableWorker omitted) →
 *      boot ABORTS loudly (BootConfigError), never silently leaving the cron unscheduled.
 *   4. FAIL-CLOSED #3 (shape): a malformed (non-UUID) RAYSPEC_CRON_TENANT_ID → boot ABORTS at startup
 *      (not lazily at fire time).
 *   5. FAIL-CLOSED #3 (existence): a well-formed-but-NONEXISTENT cron tenant → boot ABORTS at startup
 *      (the org-existence probe), not via the orgs FK at 2am.
 *
 * The actual fire→dispatch→tenant-tx behavior (the GUC-populated handler run + exactly-once) is proven
 * on ground truth in @rayspec/durable-dbos's cron-scheduler.db.test.ts (which drives the SAME
 * `DbosCronScheduler` via `fireNow`); this test covers the composition-root WIRING + the boot guards,
 * which that test does not.
 *
 * Launches a REAL DBOS engine, which needs a SEPARATE system database (the composition root derives
 * `<appdb>_dbos_sys`, which DBOS auto-creates). A whole throwaway APP database is created + dropped
 * (DB isolation), and the derived system DB is dropped on teardown.
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
import {
  assembleServer,
  BootConfigError,
  type BootedServer,
  loadServerConfig,
} from './composition-root.js';

/** A deterministic, network-free Backend wired as `openai` (same shape as durable-worker-boot.db.test). */
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
      producedBy: 'fake-cron-boot-backend',
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

/** A cron spec: a durable worker + a `digest` agent + a cron trigger firing that agent. */
const CRON_SPEC_YAML = `
version: '1.0'
metadata:
  name: cron-boot-test
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
  - name: nightly-digest
    kind: cron
    schedule: '0 2 * * *'
    action: { kind: agent, agent: digest }
`;

/** The SAME spec but WITHOUT the durable worker — the without-durable-worker fail-closed case. */
const CRON_NO_WORKER_YAML = CRON_SPEC_YAML.replace('deployment:\n  durableWorker: true\n', '');

const CRON_TENANT = '00000000-0000-0000-0000-0000000000cc';

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

const SUITE_DB = `rayspec_server_cron_${process.pid}`;
const DBOS_SYS_DB = `${SUITE_DB}_dbos_sys`;

describe('cron-worker boot — composition root wires the scheduler + fail-closed boot guards', () => {
  const baseUrl = process.env.DATABASE_URL;
  const maybe = baseUrl ? it : it.skip;
  const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
  // un-skippable ran-guard (fires synchronously at collection): this DB-backed cron-boot suite must
  // never silently self-skip to a false green. When the DB is REQUIRED but absent, hard-fail rather than skip.
  if (requireDb && !baseUrl) {
    throw new Error(
      'durable-worker-cron-boot.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but ' +
        'absent — refusing to silently skip this DB-backed suite.',
    );
  }

  let appDbUrl = '';
  let tmpDir = '';
  const created: BootedServer[] = [];
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    'RAYSPEC_JWT_SIGNING_KEY',
    'RAYSPEC_API_KEY_PEPPER',
    'DATABASE_URL',
    'ALLOWED_ORIGINS',
    'PORT',
    'RAYSPEC_SPEC_PATH',
    'RAYSPEC_CRON_TENANT_ID',
    'DBOS_SYSTEM_DATABASE_URL',
  ] as const;

  /** Write a spec to a temp file + return its path. */
  function writeSpec(yaml: string, file = 'rayspec.yaml'): string {
    const p = join(tmpDir, file);
    writeFileSync(p, yaml, 'utf8');
    return p;
  }

  /** The shared registrar + backend factory for an assembleServer call. */
  function assembleOpts(): Parameters<typeof assembleServer>[1] {
    return {
      agentBackendsFactory: (): ReadonlyMap<BackendId, Backend> =>
        new Map<BackendId, Backend>([['openai', new FakeBackend()]]),
      registerProductTables: (tables: ReadonlyMap<string, PgTable>) => {
        registerScopedTables([...tables.values()]);
      },
    };
  }

  /**
   * The SAME registrar but with NO `agentBackendsFactory` — so `agentBackends` (composition-root.ts
   * `opts.agentBackendsFactory?.()`) stays undefined and the durable worker is NEVER constructed
   * (`durableExecutorInstance` stays undefined at ~:525), even though the spec passes lint. This is the
   * fixture that REACHES the runtime without-durable-worker guard (~:656) in isolation — the lint rule does not fire,
   * because the spec keeps `deployment.durableWorker:true` + the cron trigger.
   */
  function assembleOptsNoBackend(): Parameters<typeof assembleServer>[1] {
    return {
      registerProductTables: (tables: ReadonlyMap<string, PgTable>) => {
        registerScopedTables([...tables.values()]);
      },
    };
  }

  beforeAll(async () => {
    if (!baseUrl) return;
    appDbUrl = withDbName(baseUrl, SUITE_DB);

    const admin = postgres(adminUrl(baseUrl), { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${DBOS_SYS_DB}" WITH (FORCE)`);
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE "${SUITE_DB}"`);
    } finally {
      await admin.end();
    }

    tmpDir = mkdtempSync(join(tmpdir(), 'rayspec-cron-boot-'));

    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    process.env.RAYSPEC_JWT_SIGNING_KEY = await exportPKCS8(privateKey);
    process.env.RAYSPEC_API_KEY_PEPPER = 'cron-boot-pepper-only';
    process.env.DATABASE_URL = appDbUrl;
    delete process.env.ALLOWED_ORIGINS;
    process.env.PORT = '8802';
    delete process.env.DBOS_SYSTEM_DATABASE_URL;
  }, 120_000);

  afterAll(async () => {
    for (const s of created) await s.close().catch(() => {});
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
    'boots a cron spec + surfaces the cron name on the composition-root output (declaredCronTriggers)',
    async () => {
      process.env.RAYSPEC_SPEC_PATH = writeSpec(CRON_SPEC_YAML);
      process.env.RAYSPEC_CRON_TENANT_ID = CRON_TENANT;

      // The cron tenant must EXIST before boot (the #3 existence probe runs inside assembleServer). The
      // org table only exists after the migration chain, so we apply migrations (idempotent —
      // assembleServer re-applies them as a no-op) and seed the cron org FIRST — exactly the pattern
      // the dev-server uses. Then assembleServer's boot probe finds the org and proceeds.
      const { makeDb } = await import('@rayspec/db');
      const { applyMigrations } = await import('./composition-root.js');
      const seedDb = makeDb(appDbUrl);
      try {
        await applyMigrations(seedDb);
        await seedDb.$client.unsafe(
          `INSERT INTO orgs (id, name, slug) VALUES ($1, 'cron-tenant', 'cron-tenant') ON CONFLICT (id) DO NOTHING`,
          [CRON_TENANT],
        );
      } finally {
        await seedDb.$client.end();
      }

      const config = loadServerConfig();
      const server = await assembleServer(config, assembleOpts());
      created.push(server);

      // The composition root wired the scheduler from the deployed trigger registry → the cron name
      // surfaces on the output (the banner feed). A registration throw in the pre-launch window would
      // have aborted assembleServer, so a clean boot IS the "registered pre-launch" assertion.
      expect(server.declaredCronTriggers).toContain('nightly-digest');
      // The /health probe round-trips the DB — proves the booted app is live.
      const health = await server.app.request('/health');
      expect(health.status).toBe(200);
    },
    120_000,
  );

  maybe(
    'without-durable-worker fail-closed: a cron spec WITHOUT a durable worker aborts the boot loudly',
    async () => {
      process.env.RAYSPEC_SPEC_PATH = writeSpec(CRON_NO_WORKER_YAML, 'no-worker.yaml');
      process.env.RAYSPEC_CRON_TENANT_ID = CRON_TENANT;
      const config = loadServerConfig();
      // The static lint rule rejects this at parse time (cron requires durableWorker) — so the deploy()
      // VALIDATE step inside assembleServer aborts. Either way the boot MUST fail loudly (never silently
      // leave the cron unscheduled).
      await expect(assembleServer(config, assembleOpts())).rejects.toThrow();
    },
  );

  maybe(
    'without-durable-worker fail-closed (runtime guard, isolated): a lint-PASSING cron spec with NO durable worker wired ' +
      '(no backend factory) aborts with BootConfigError at the runtime guard',
    async () => {
      // The PRIOR test's spec is rejected by the LINT rule FIRST (cron-without-durableWorker), so the
      // runtime without-durable-worker guard at composition-root.ts:~656 is never reached — that test cannot prove the
      // runtime backstop. This one isolates the RUNTIME guard: the spec KEEPS deployment.durableWorker:
      // true + the cron trigger (so lint PASSES + deploy()'s validate does NOT reject), but the server
      // is assembled WITHOUT an agentBackendsFactory → `agentBackends` is undefined → the worker is
      // never constructed (`durableExecutorInstance` stays undefined) → the boot reaches the without-durable-worker guard,
      // which throws BootConfigError. The cron tenant is set so the failure is the without-durable-worker guard, not
      // the (later) cron-tenant guard. The org table is not required: the without-durable-worker guard throw precedes any DB probe.
      process.env.RAYSPEC_SPEC_PATH = writeSpec(CRON_SPEC_YAML, 'runtime-no-worker.yaml');
      process.env.RAYSPEC_CRON_TENANT_ID = CRON_TENANT;
      const config = loadServerConfig();
      await expect(assembleServer(config, assembleOptsNoBackend())).rejects.toBeInstanceOf(
        BootConfigError,
      );
      // Assert the message names the cron-needs-worker reason (not some unrelated BootConfigError).
      await expect(assembleServer(config, assembleOptsNoBackend())).rejects.toThrow(
        /durable[\s\S]*worker is wired/i,
      );
    },
    120_000,
  );

  maybe('#3 fail-closed (shape): a non-UUID RAYSPEC_CRON_TENANT_ID aborts the boot', async () => {
    process.env.RAYSPEC_SPEC_PATH = writeSpec(CRON_SPEC_YAML, 'bad-tenant.yaml');
    process.env.RAYSPEC_CRON_TENANT_ID = 'not-a-uuid';
    const config = loadServerConfig();
    await expect(assembleServer(config, assembleOpts())).rejects.toBeInstanceOf(BootConfigError);
  });

  maybe(
    '#3 fail-closed (existence): a well-formed-but-NONEXISTENT cron tenant aborts the boot',
    async () => {
      process.env.RAYSPEC_SPEC_PATH = writeSpec(CRON_SPEC_YAML, 'ghost-tenant.yaml');
      // A valid UUID that no org row matches → the existence probe must abort the boot.
      process.env.RAYSPEC_CRON_TENANT_ID = '00000000-0000-0000-0000-0000000000ff';
      const config = loadServerConfig();
      await expect(assembleServer(config, assembleOpts())).rejects.toBeInstanceOf(BootConfigError);
    },
    120_000,
  );
});
