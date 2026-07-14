/**
 * The OPERATIONAL session-reprocess affordance, end-to-end on GROUND TRUTH through the REAL
 * composition-root closure — the ONE place the real store name (`audio_sessions`), the real tenant-bound
 * workflow dispatcher, the real `forTenant` chokepoint, and the audio-only wiring actually meet. The
 * existing route/bridge tests only cover the wiring with FAKES (an injected fake `SessionReprocessor`
 * and a fake ingress); this drives the CONCRETE reprocessor the composition root builds.
 *
 * Boots the REAL audio product (the neutral acme-notes.product.yaml) via the env-driven boot with a
 * fixtured fake STT + an injected deterministic extractor, then drives `POST /v1/sessions/:id/reprocess`
 * and asserts on ground truth (fail-the-fix):
 *   (a) HAPPY PATH — the request tenant IS the deployment tenant + the session exists ⇒ a FRESH durable
 *       run is enqueued under a DISTINCT `:reprocess:<nonce>` idempotency key (NOT deduped to the
 *       session's `:finalized` run); two reprocesses ⇒ two distinct fresh runs.
 *   (b) CROSS-TENANT — a FOREIGN tenant whose own (tenant-namespaced) session collides on the same
 *       client-chosen session id ⇒ 404 + ZERO enqueue. The dispatcher is bound to the DEPLOYMENT tenant
 *       and enqueues every run under it, so without the closure's tenant reconciliation the foreign
 *       tenant would pass its own existence check and enqueue a run under the deployment tenant (a
 *       cross-tenant run). This arm REDs without that reconciliation.
 *   (c) a FOUND session always yields >= 1 enqueue (a found session must match a registered
 *       finalized-session trigger — zero enqueue for a found session is an internal fault, never a 202).
 *
 * Skips without DATABASE_URL; a real DBOS launch needs a separate `<appdb>_dbos_sys` (auto-created).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryAgentHandlerRegistry } from '@rayspec/agent-runtime';
import { registerScopedTables } from '@rayspec/db/testing';
import { FakeSttAdapter, type SttDualTrackFixture } from '@rayspec/stt-port';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assembleServer, type BootedServer, loadServerConfig } from './composition-root.js';

const baseUrl = process.env.DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const ACME_YAML = resolve(here, '../../../../examples/acme-notes/acme-notes.product.yaml');

// A separate, NON-skipped ran-guard (below) hard-fails if a REQUIRED run (CI / RAYSPEC_REQUIRE_DB_TESTS)
// lost DATABASE_URL and silently skipped this reprocess-security proof.
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
let reprocessTestsRan = 0;

const SUITE_DB = `rayspec_reprocess_e2e_${process.pid}`;
const TENANT = '00000000-0000-4000-8000-0000000000e2';
const HAPPY_SESSION = 'reproc-happy';
const CROSS_SESSION = 'reproc-cross';

// A fixture only makes the STT deterministic for the HAPPY session; the reprocess assertions read the
// ENQUEUE (a synchronous workflow_runs row) and never depend on the off-request workflow completing.
const STT_FIXTURE: SttDualTrackFixture = {
  fixture_id: 'reprocess-e2e',
  session_id: HAPPY_SESSION,
  tracks: [
    {
      track: 'mic',
      status: 'completed',
      segments: [{ span_id: 'mic:s0', text: 'Re-run the extraction.' }],
    },
  ],
};

/** A deterministic in-set grounded extractor, injected — the platform ships none (product-free). */
function groundedExtractor(): InMemoryAgentHandlerRegistry {
  const registry = new InMemoryAgentHandlerRegistry();
  registry.register('agent.note_extractor', (input) => {
    const output = input.artifact_outputs.find((a) => a.schema_ref === 'acme.notes');
    if (!output) throw new Error('declared output artifact missing');
    return [
      {
        ...output,
        value: {
          headline: 'Re-run.',
          detail: 'The reprocess re-drove the workflow.',
          output_language: 'en',
          items: [],
          pointers: [],
          queries: [],
          labels: [],
          mentions: [],
        },
      },
    ];
  });
  return registry;
}

function adminUrl(url: string): string {
  const u = new URL(url);
  u.pathname = '/postgres';
  return u.toString();
}
function withDbName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

describe.skipIf(!baseUrl)(
  'Session reprocess — real composition-root closure (tenant chokepoint + real dispatcher)',
  () => {
    let server: BootedServer | undefined;
    let appDbUrl = '';
    let dbosSysDb = '';
    let blobDir = '';
    const saved: Record<string, string | undefined> = {};
    const ENV = [
      'RAYSPEC_JWT_SIGNING_KEY',
      'RAYSPEC_API_KEY_PEPPER',
      'DATABASE_URL',
      'ALLOWED_ORIGINS',
      'PORT',
      'RAYSPEC_SPEC_PATH',
      'DBOS_SYSTEM_DATABASE_URL',
      'RAYSPEC_PRODUCT_TENANT_ID',
      'STT_PROVIDER',
      'RAYSPEC_EXTRACTION_MODE',
      'RAYSPEC_BLOB_ROOT',
      'RAYSPEC_MEDIA_SIGNING_KEY',
    ] as const;

    async function drop(admin: postgres.Sql): Promise<void> {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${dbosSysDb}" WITH (FORCE)`);
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
    }

    beforeAll(async () => {
      if (!baseUrl) return;
      appDbUrl = withDbName(baseUrl, SUITE_DB);
      dbosSysDb = `${SUITE_DB}_dbos_sys`;
      const admin = postgres(adminUrl(baseUrl), { max: 1 });
      try {
        await drop(admin);
        await admin.unsafe(`CREATE DATABASE "${SUITE_DB}"`);
      } finally {
        await admin.end();
      }

      blobDir = mkdtempSync(join(tmpdir(), 'rayspec-reprocess-e2e-'));
      for (const k of ENV) saved[k] = process.env[k];
      const { privateKey } = await generateKeyPair('RS256', { extractable: true });
      process.env.RAYSPEC_JWT_SIGNING_KEY = await exportPKCS8(privateKey);
      process.env.RAYSPEC_API_KEY_PEPPER = 'reprocess-e2e-pepper-only';
      process.env.DATABASE_URL = appDbUrl;
      delete process.env.ALLOWED_ORIGINS;
      process.env.PORT = '8814';
      process.env.RAYSPEC_SPEC_PATH = ACME_YAML;
      delete process.env.DBOS_SYSTEM_DATABASE_URL;
      process.env.RAYSPEC_PRODUCT_TENANT_ID = TENANT;
      process.env.STT_PROVIDER = 'fake';
      process.env.RAYSPEC_EXTRACTION_MODE = 'deterministic';
      process.env.RAYSPEC_BLOB_ROOT = blobDir;
      process.env.RAYSPEC_MEDIA_SIGNING_KEY = 'reprocess-e2e-media-secret-at-least-32-bytes-x';

      const config = loadServerConfig();
      server = await assembleServer(config, {
        registerProductTables: (tables) => registerScopedTables([...tables.values()]),
        productDeterministicAgents: groundedExtractor(),
        productSttAdapter: new FakeSttAdapter({ fixtures: [STT_FIXTURE] }),
      });

      // The deployment tenant org (the workflow_runs FK + the tenant every dispatched run binds to).
      const client = postgres(appDbUrl, { max: 2 });
      try {
        await client.unsafe(`INSERT INTO orgs (id, name, slug) VALUES ($1, 'Acme', 'acme')`, [
          TENANT,
        ]);
      } finally {
        await client.end();
      }
    }, 180_000);

    afterAll(async () => {
      await server?.close();
      for (const k of ENV) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      if (blobDir) rmSync(blobDir, { recursive: true, force: true });
      if (baseUrl) {
        const admin = postgres(adminUrl(baseUrl), { max: 1 });
        try {
          await drop(admin);
        } finally {
          await admin.end();
        }
      }
    }, 60_000);

    /** A JWT for the DEPLOYMENT tenant: register a user, make it an owner of the deployment org, switch. */
    async function deploymentToken(): Promise<string> {
      const email = `reproc-deploy-${Date.now()}-${Math.random()}@example.com`;
      const reg = await server!.app.request('/v1/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 'a-long-enough-password' }),
      });
      expect([200, 201]).toContain(reg.status);
      const client = postgres(appDbUrl, { max: 2 });
      try {
        const rows = (await client.unsafe('SELECT id FROM users WHERE email = $1', [
          email,
        ])) as unknown as Array<{ id: string }>;
        await client.unsafe(
          `INSERT INTO memberships (org_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active')`,
          [TENANT, rows[0]!.id],
        );
      } finally {
        await client.end();
      }
      const sw = await server!.app.request(`/v1/orgs/${TENANT}/switch`, {
        method: 'POST',
        headers: { authorization: `Bearer ${(await reg.json()).accessToken}` },
      });
      expect(sw.status).toBe(200);
      return (await sw.json()).accessToken as string;
    }

    /** A FOREIGN tenant: register a user, create a NEW org (the creator is its owner ⇒ store:write), switch. */
    async function foreignPrincipal(): Promise<{ orgId: string; token: string }> {
      const email = `reproc-foreign-${Date.now()}-${Math.random()}@example.com`;
      const reg = await server!.app.request('/v1/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 'a-long-enough-password' }),
      });
      expect([200, 201]).toContain(reg.status);
      const t0 = (await reg.json()).accessToken as string;
      const orgRes = await server!.app.request('/v1/orgs', {
        method: 'POST',
        headers: { authorization: `Bearer ${t0}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Foreign Org' }),
      });
      expect([200, 201]).toContain(orgRes.status);
      const orgId = (await orgRes.json()).id as string;
      const sw = await server!.app.request(`/v1/orgs/${orgId}/switch`, {
        method: 'POST',
        headers: { authorization: `Bearer ${t0}` },
      });
      expect(sw.status).toBe(200);
      return { orgId, token: (await sw.json()).accessToken as string };
    }

    /** Insert an `audio_sessions` row directly (only the NOT-NULL-without-default columns are set). */
    async function insertSession(tenantId: string, sessionId: string): Promise<void> {
      const client = postgres(appDbUrl, { max: 1 });
      try {
        await client.unsafe(
          `INSERT INTO audio_sessions (tenant_id, session_id, session_ref, status, protocol_version)
           VALUES ($1, $2, $3, 'completed', 1)`,
          [tenantId, sessionId, `${tenantId}:${sessionId}`],
        );
      } finally {
        await client.end();
      }
    }

    /**
     * Every workflow_runs row whose idempotency key belongs to a given session (ground truth). The
     * durable header is written by the worker when the run STARTS (off-request `ensureRun`), so callers
     * poll for the enqueue to materialize.
     */
    async function runsForSession(
      sessionId: string,
    ): Promise<Array<{ workflow_run_id: string; tenant_id: string; idempotency_key: string }>> {
      const client = postgres(appDbUrl, { max: 1 });
      try {
        return (await client.unsafe(
          `SELECT workflow_run_id, tenant_id, idempotency_key FROM workflow_runs
           WHERE idempotency_key LIKE $1 ORDER BY idempotency_key`,
          [`session_id:${sessionId}:%`],
        )) as unknown as Array<{
          workflow_run_id: string;
          tenant_id: string;
          idempotency_key: string;
        }>;
      } finally {
        await client.end();
      }
    }

    /** Poll until at least `min` runs for the session exist (the off-request worker wrote their headers). */
    async function waitForRuns(
      sessionId: string,
      min: number,
    ): Promise<Awaited<ReturnType<typeof runsForSession>>> {
      const deadline = Date.now() + 60_000;
      for (;;) {
        const runs = await runsForSession(sessionId);
        if (runs.length >= min) return runs;
        if (Date.now() > deadline)
          throw new Error(`only ${runs.length}/${min} runs materialized for ${sessionId}`);
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    async function reprocess(sessionId: string, token: string): Promise<Response> {
      return server!.app.request(`/v1/sessions/${sessionId}/reprocess`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
    }

    const maybe = baseUrl ? it : it.skip;

    maybe(
      'happy path: the deployment tenant reprocesses a found session → a FRESH run under a distinct :reprocess: key (never the :finalized run)',
      async () => {
        reprocessTestsRan += 1;
        await insertSession(TENANT, HAPPY_SESSION);
        const token = await deploymentToken();

        const res1 = await reprocess(HAPPY_SESSION, token);
        expect(res1.status).toBe(202);
        const body1 = (await res1.json()) as {
          sessionId: string;
          enqueued: Array<{ workflowId: string; runId: string }>;
        };
        expect(body1.sessionId).toBe(HAPPY_SESSION);
        // (c) FIX — a found session ALWAYS yields >= 1 enqueue (never a 202 with an empty enqueue).
        expect(body1.enqueued.length).toBeGreaterThanOrEqual(1);
        const runId1 = body1.enqueued[0]!.runId;

        // A second reprocess is its OWN fresh run (a distinct nonce → a distinct :reprocess: key/run).
        const res2 = await reprocess(HAPPY_SESSION, token);
        expect(res2.status).toBe(202);
        const body2 = (await res2.json()) as { enqueued: Array<{ runId: string }> };
        const runId2 = body2.enqueued[0]!.runId;
        expect(runId2).not.toBe(runId1);

        // Ground truth: BOTH runs exist, keyed :reprocess: under the DEPLOYMENT tenant, and NEITHER is
        // the session's :finalized run — the reprocess never deduped onto the live finalize key.
        const runs = await waitForRuns(HAPPY_SESSION, 2);
        const ids = runs.map((r) => r.workflow_run_id);
        expect(ids).toContain(runId1);
        expect(ids).toContain(runId2);
        expect(runs.every((r) => r.tenant_id === TENANT)).toBe(true);
        expect(
          runs.every((r) => r.idempotency_key.startsWith(`session_id:${HAPPY_SESSION}:reprocess:`)),
        ).toBe(true);
        expect(
          runs.some((r) => r.idempotency_key === `session_id:${HAPPY_SESSION}:finalized`),
        ).toBe(false);
      },
      120_000,
    );

    maybe(
      'cross-tenant: a foreign tenant with a colliding session id gets 404 + ZERO enqueue (structural tenant enforcement)',
      async () => {
        reprocessTestsRan += 1;
        const foreign = await foreignPrincipal();
        // The foreign tenant owns its OWN (tenant-namespaced) session that collides on the client-chosen
        // session id — its own existence check would pass, so only the closure's tenant reconciliation
        // stops it enqueuing a run under the DEPLOYMENT tenant.
        await insertSession(foreign.orgId, CROSS_SESSION);
        expect(foreign.orgId).not.toBe(TENANT);

        const res = await reprocess(CROSS_SESSION, foreign.token);
        // Uniform 404 (no existence leak) is the load-bearing, timing-free assertion — it REDs (returns
        // 202) without the closure's request-vs-deployment tenant reconciliation, because the foreign
        // existence check passes and the dispatcher enqueues under the deployment tenant.
        expect(res.status).toBe(404);
        // ZERO enqueue confirmation: a 404 means the closure returned before any emit. Settle long
        // enough that a leaked run (which the worker writes within sub-seconds, as the happy path just
        // proved) WOULD have surfaced, then assert none did.
        await new Promise((r) => setTimeout(r, 2_000));
        const runs = await runsForSession(CROSS_SESSION);
        expect(runs).toHaveLength(0);
      },
      120_000,
    );
  },
);

/**
 * A SEPARATE, NON-skipped ran-guard: fails the run when the DB is REQUIRED (CI / RAYSPEC_REQUIRE_DB_TESTS)
 * but the reprocess-security proof above did NOT run (a lost DATABASE_URL silently skipped it). A local
 * dev with no DB and no CI/opt-in still skips ergonomically (the assertion is a no-op there).
 */
describe('Session reprocess e2e — ran-guard (the tenant-enforcement proof must not silently skip in CI)', () => {
  it('the reprocess-security proof ACTUALLY RAN when the DB is required (CI / opt-in)', () => {
    if (dbRequired) {
      expect(reprocessTestsRan).toBe(2);
    } else {
      expect(dbRequired).toBe(false);
    }
  });
});
