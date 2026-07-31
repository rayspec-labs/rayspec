/**
 * CRON-worker boot test — the composition-root cron wiring had ZERO
 * automated coverage (only the CI-excluded dev-server exercised it). This boots the REAL composition
 * root (`assembleServer`) against a throwaway DATABASE with a `deployment.durableWorker:true` spec that
 * declares a `cron` trigger + `RAYSPEC_CRON_TENANT_ID`, and asserts the WHOLE composition-root OUTPUT
 * + the fail-closed boot guards on GROUND TRUTH (fail-the-fix, not pass-the-shape):
 *
 *   1. BOOT (late binding): `assembleServer` boots with a cron spec whose `RAYSPEC_CRON_TENANT_ID`
 *      names an org that does NOT exist yet — the deployment comes up before its tenant is registered.
 *   2. OUTPUT: `server.declaredCronTriggers` surfaces the declared cron name (the banner feed) — the
 *      composition root actually wired the scheduler from the deployed trigger registry. The scheduled
 *      DBOS workflow was registered in the PRE-LAUNCH window (no post-launch-registration throw — a
 *      throw there would abort the boot, so a clean boot IS that assertion).
 *   3. FAIL-CLOSED WHERE IT MOVED TO: with the org still absent a fire through the composition root's
 *      own `fireCronNow` seam dispatches NOTHING; once the org is registered against the RUNNING
 *      application the SAME firing instant fires — no restart, no re-deploy.
 *   4. FAIL-CLOSED: a cron spec WITHOUT a durable worker (deployment.durableWorker omitted) →
 *      boot ABORTS loudly (BootConfigError), never silently leaving the cron unscheduled.
 *   5. FAIL-CLOSED (shape): a malformed (non-UUID) RAYSPEC_CRON_TENANT_ID → boot ABORTS at startup
 *      (an unusable value is a config error, not something to bind later).
 *   6. FAIL-CLOSED (unset): a cron spec with NO RAYSPEC_CRON_TENANT_ID at all → boot ABORTS with the
 *      exact, unchanged message. Pinned VERBATIM: "the org may not exist yet" must never erode into
 *      "the deployment may not name a tenant at all".
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

/**
 * The EXACT abort a cron/manual-declaring spec with an UNSET RAYSPEC_CRON_TENANT_ID must produce.
 * Pinned verbatim (not by substring) because this message is the one boot gate the late-binding change
 * deliberately LEFT in place: an unnamed tenant is unresolvable at any later moment, so it stays a
 * refusal to boot.
 */
const UNSET_TENANT_ABORT =
  'Boot aborted — the spec declares 1 cron/manual trigger(s) but RAYSPEC_CRON_TENANT_ID is not ' +
  'set. A cron/manual trigger fires under a known deployment tenant (single-deployment LOCAL ' +
  'posture; multi-tenant fan-out is reserved). Set RAYSPEC_CRON_TENANT_ID to the org id the ' +
  'trigger should fire under. Fail-closed.';

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
    'LATE BINDING: boots a cron spec whose tenant org does NOT exist yet, fires nothing until it does, then fires without a restart',
    async () => {
      process.env.RAYSPEC_SPEC_PATH = writeSpec(CRON_SPEC_YAML);
      // A well-formed org id that NOTHING has created — the state a cron deployment legitimately
      // passes through while its tenant org is not there (yet). The boot must come up on it.
      process.env.RAYSPEC_CRON_TENANT_ID = CRON_TENANT;

      const config = loadServerConfig();
      // The boot must NOT abort on the absent org. (Before late binding this threw a BootConfigError:
      // "…is a well-formed UUID but no such active org exists".)
      const server = await assembleServer(config, assembleOpts());
      created.push(server);

      // The composition root wired the scheduler from the deployed trigger registry → the cron name
      // surfaces on the output (the banner feed). A registration throw in the pre-launch window would
      // have aborted assembleServer, so a clean boot IS the "registered pre-launch" assertion.
      expect(server.declaredCronTriggers).toContain('nightly-digest');
      // The /health probe round-trips the DB — proves the booted app is live.
      const health = await server.app.request('/health');
      expect(health.status).toBe(200);

      // FAIL-CLOSED, MOVED: the scheduler is running, but the tenant is still unknown, so a fire
      // through the composition root's own seam dispatches nothing and reports that it did not fire.
      const instant = new Date('2026-06-24T02:00:00.000Z');
      expect(await server.fireCronNow?.('nightly-digest', instant)).toBe(false);

      // The `orgs` row for THAT id appears while the application RUNS (assembleServer already applied
      // the migration chain, so `orgs` exists) — no restart, no re-deploy. Inserted directly with the
      // configured id, because that is what makes the id name a real org: `POST /v1/orgs` and register
      // let the database generate the id, so they cannot be pointed at a pre-chosen one.
      const seedDb = postgres(appDbUrl, { max: 1 });
      try {
        await seedDb.unsafe(
          `INSERT INTO orgs (id, name, slug) VALUES ($1, 'cron-tenant', 'cron-tenant') ON CONFLICT (id) DO NOTHING`,
          [CRON_TENANT],
        );
      } finally {
        await seedDb.end();
      }

      // The SAME live server now fires — and for the SAME firing instant, because the skipped firing
      // never consumed the instant's reserve.
      expect(await server.fireCronNow?.('nightly-digest', instant)).toBe(true);
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

  maybe('fail-closed (shape): a non-UUID RAYSPEC_CRON_TENANT_ID aborts the boot', async () => {
    process.env.RAYSPEC_SPEC_PATH = writeSpec(CRON_SPEC_YAML, 'bad-tenant.yaml');
    // Late binding resolves an org that does not exist YET; it cannot resolve a value that could
    // never name an org at all, so a malformed id stays a boot abort with its message unchanged.
    process.env.RAYSPEC_CRON_TENANT_ID = 'not-a-uuid';
    const config = loadServerConfig();
    await expect(assembleServer(config, assembleOpts())).rejects.toBeInstanceOf(BootConfigError);
    await expect(assembleServer(config, assembleOpts())).rejects.toThrow(/is not a valid org UUID/);
  });

  maybe(
    'fail-closed (unset): a cron spec with NO RAYSPEC_CRON_TENANT_ID aborts with the EXACT unchanged message',
    async () => {
      process.env.RAYSPEC_SPEC_PATH = writeSpec(CRON_SPEC_YAML, 'unset-tenant.yaml');
      delete process.env.RAYSPEC_CRON_TENANT_ID;
      const config = loadServerConfig();
      // Verbatim, not a substring: this is the gate late binding deliberately did NOT relax, and its
      // wording is what an operator reads.
      const err = await assembleServer(config, assembleOpts()).then(
        (s) => {
          created.push(s);
          return null;
        },
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(BootConfigError);
      expect((err as BootConfigError).message).toBe(UNSET_TENANT_ABORT);
    },
    120_000,
  );
});
