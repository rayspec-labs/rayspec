/**
 * THE ACCEPTANCE E2E (the mission capstone). The greenfield NON-audio
 * Expense-Claim Auto-Coder product, authored in `examples/expense-claim/`, boots through
 * the REAL server entrypoint (`assembleServer` from `RAYSPEC_SPEC_PATH`) on a throwaway DATABASE + a
 * real DBOS launch, and is driven end-to-end over REAL HTTP against MATERIALIZED ground truth
 * (fail-the-fix). It composes EVERY component the unlock delivered in ONE doc:
 *   S1 record_submitted trigger · S2 declared stores + store_read/store_write · S3 record_input ingress
 *   · S4 conditional-no-audio (demands NEITHER blob/media NOR stt env) · S5 the single-turn extraction
 *   agent (DETERMINISTIC in CI — no live LLM).
 *
 * Arms:
 *   1. env boot → Product-YAML dispatch (deployMode 'materialized'; NO audio/stt env demanded);
 *   2. seed the policy catalog → POST /records/{id}/submit → the REAL DbosWorkflowExecutor runs
 *      store_read → agent → validation → store_write OFF-REQUEST → EXACTLY ONE workflow_runs row (C10)
 *      → the coded_claims row carries the coded jsonb + the catalog snapshot (read feeds write);
 *   3. the DECLARED views serve the coded claim (detail + paged list) over HTTP;
 *   4. re-submit the SAME claim id → deduped:true → STILL one run + one row (C10 single-flight);
 *   5. a foreign-tenant submit → 403 record_event_rejected (cross-tenant fail-closed, zero enqueue);
 *   6. an unauthenticated submit → 401;
 *   7. the S6 boot-scope gate is WIRED: an out-of-scope (multi-scope) doc fails the boot fail-closed.
 *
 * Skips without DATABASE_URL; a real DBOS launch needs a separate `<appdb>_dbos_sys` (auto-created).
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryAgentHandlerRegistry } from '@rayspec/agent-runtime';
import { registerScopedTables } from '@rayspec/db/testing';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assembleServer, type BootedServer, loadServerConfig } from './composition-root.js';

const baseUrl = process.env.DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const EXPENSE_YAML = resolve(here, '../../../../examples/expense-claim/expense-claim.product.yaml');
const MULTISCOPE_YAML = resolve(here, '__fixtures__/out-of-scope-multiscope.product.yaml');

// Ran-guard: the suite skipIf(!baseUrl)s so a credential-free dev run skips, but a
// REQUIRED run (CI / RAYSPEC_REQUIRE_DB_TESTS) that lost DATABASE_URL would SILENTLY
// SKIP this acceptance proof and still read GREEN. The separate NON-skipped describe at the bottom
// hard-fails on exactly that.
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
let e2eTestsRan = 0;

const SUITE_DB = `rayspec_expense_0_2_${process.pid}`;
const TENANT = '00000000-0000-4000-8000-0000000000e2';
const TENANT_B = '00000000-0000-4000-8000-0000000000e3';
const RECORD = 'claim-001';

/** The DETERMINISTIC single-turn coder (the platform ships none — product-free). */
function expenseCoder(): InMemoryAgentHandlerRegistry {
  const registry = new InMemoryAgentHandlerRegistry();
  registry.register('agent.expense_coder', (input) => {
    const output = input.artifact_outputs.find((a) => a.schema_ref === 'expense_claim.coded');
    if (!output) throw new Error('declared output artifact missing');
    return [
      {
        ...output,
        value: {
          category: 'travel',
          gl_code: '6100',
          policy_ok: true,
          rationale: 'Taxi to the client site — matches the travel policy row.',
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

describe.skipIf(!baseUrl)('Expense-Claim acceptance — real boot + real DBOS + HTTP', () => {
  let server: BootedServer | undefined;
  let appDbUrl = '';
  let dbosSysDb = '';
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
    'RAYSPEC_EXTRACTION_MODE',
    'STT_PROVIDER',
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

    for (const k of ENV) saved[k] = process.env[k];
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    process.env.RAYSPEC_JWT_SIGNING_KEY = await exportPKCS8(privateKey);
    process.env.RAYSPEC_API_KEY_PEPPER = 'expense-0-2-pepper-only';
    process.env.DATABASE_URL = appDbUrl;
    delete process.env.ALLOWED_ORIGINS;
    process.env.PORT = '8803';
    process.env.RAYSPEC_SPEC_PATH = EXPENSE_YAML;
    delete process.env.DBOS_SYSTEM_DATABASE_URL;
    process.env.RAYSPEC_PRODUCT_TENANT_ID = TENANT;
    process.env.RAYSPEC_EXTRACTION_MODE = 'deterministic';
    // S4 doc-driven env: this NON-audio, no-stt doc demands NEITHER of these. Prove it by leaving them
    // UNSET — a boot that (wrongly) demanded them would fail-close here instead of booting.
    delete process.env.STT_PROVIDER;
    delete process.env.RAYSPEC_BLOB_ROOT;
    delete process.env.RAYSPEC_MEDIA_SIGNING_KEY;

    const config = loadServerConfig();
    server = await assembleServer(config, {
      registerProductTables: (tables) => registerScopedTables([...tables.values()]),
      productDeterministicAgents: expenseCoder(),
    });

    // The deployment tenant + a foreign tenant B (the cross-tenant arm needs a real second org).
    const client = postgres(appDbUrl, { max: 2 });
    try {
      await client.unsafe(`INSERT INTO orgs (id, name, slug) VALUES ($1, 'Finance', 'finance')`, [
        TENANT,
      ]);
      await client.unsafe(`INSERT INTO orgs (id, name, slug) VALUES ($1, 'Other', 'other-org')`, [
        TENANT_B,
      ]);
      // Seed the policy catalog the store_read reads (tenant-scoped; injected columns default).
      await client.unsafe(
        `INSERT INTO expense_policies (tenant_id, category, gl_code, daily_limit_cents)
         VALUES ($1, 'travel', '6100', 50000), ($1, 'meals', '6200', 7500)`,
        [TENANT],
      );
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
    if (baseUrl) {
      const admin = postgres(adminUrl(baseUrl), { max: 1 });
      try {
        await drop(admin);
      } finally {
        await admin.end();
      }
    }
  }, 60_000);

  /** Register a user + a membership in `tenant`, switch, and return the tenant access token. */
  async function tokenFor(tenant: string): Promise<string> {
    const email = `expense-${tenant.slice(-4)}-${Date.now()}@example.com`;
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
        [tenant, rows[0]!.id],
      );
    } finally {
      await client.end();
    }
    const sw = await server!.app.request(`/v1/orgs/${tenant}/switch`, {
      method: 'POST',
      headers: { authorization: `Bearer ${(await reg.json()).accessToken}` },
    });
    expect(sw.status).toBe(200);
    return (await sw.json()).accessToken as string;
  }

  function submit(recordId: string, body: unknown, token?: string): Promise<Response> {
    return server!.app.request(`/records/${recordId}/submit`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  async function codedClaims(): Promise<Array<Record<string, unknown>>> {
    const client = postgres(appDbUrl, { max: 1 });
    try {
      return (await client.unsafe(
        'SELECT claim_ref, record_id, merchant, amount_cents, coded, policies_snapshot FROM coded_claims',
      )) as unknown as Array<Record<string, unknown>>;
    } finally {
      await client.end();
    }
  }

  async function workflowRuns(): Promise<Array<{ status: string; tenant_id: string }>> {
    const client = postgres(appDbUrl, { max: 1 });
    try {
      return (await client.unsafe(
        'SELECT status, tenant_id FROM workflow_runs',
      )) as unknown as Array<{ status: string; tenant_id: string }>;
    } finally {
      await client.end();
    }
  }

  async function waitForOneCompletedRun(): Promise<Array<{ status: string; tenant_id: string }>> {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const runs = await workflowRuns();
      if (runs.length > 0 && runs.every((r) => r.status === 'completed')) return runs;
      if (Date.now() > deadline)
        throw new Error(`workflow did not complete: ${JSON.stringify(runs)}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  const maybe = baseUrl ? it : it.skip;

  maybe(
    'boot → ingress submit → store_read→agent→validation→store_write → views serve the coded claim',
    async () => {
      e2eTestsRan += 1;

      // 1. The boot dispatched to the Product-YAML path and MATERIALIZED — with NO audio/stt env set.
      expect(server!.deployMode).toBe('materialized');

      const t = await tokenFor(TENANT);

      // 2. Submit a claim → the REAL DBOS workflow runs OFF-REQUEST.
      const res = await submit(
        RECORD,
        {
          merchant: 'Yellow Cab',
          amount_cents: 4200,
          description: 'Taxi to client',
        },
        t,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { record_id: string; event_id: string; deduped: boolean };
      expect(body.record_id).toBe(RECORD);
      expect(body.event_id).toBe(`${TENANT}:${RECORD}`);
      expect(body.deduped).toBe(false);

      const runs = await waitForOneCompletedRun();
      expect(runs).toHaveLength(1); // C10 single-flight
      expect(runs[0]?.tenant_id).toBe(TENANT);

      // 3. MATERIALIZED ground truth: one coded row with the coded jsonb + the catalog snapshot.
      const rows = await codedClaims();
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.claim_ref).toBe(RECORD);
      expect(row.record_id).toBe(RECORD);
      expect(row.merchant).toBe('Yellow Cab');
      expect(row.amount_cents).toBe(4200);
      expect(row.coded).toMatchObject({ category: 'travel', gl_code: '6100', policy_ok: true });
      // read feeds write: the store_read catalog snapshot is the two seeded rows.
      expect(Array.isArray(row.policies_snapshot)).toBe(true);
      expect((row.policies_snapshot as unknown[]).length).toBe(2);

      // 4. The DECLARED views serve the coded claim over HTTP (detail + list).
      const detail = await server!.app.request(`/claims/${RECORD}`, {
        headers: { authorization: `Bearer ${t}` },
      });
      expect(detail.status).toBe(200);
      const detailBody = (await detail.json()) as Record<string, unknown>;
      expect(detailBody.claim_ref).toBe(RECORD);
      expect(detailBody.merchant).toBe('Yellow Cab');
      expect(detailBody.amount_cents).toBe(4200);
      expect(detailBody.coded).toMatchObject({ category: 'travel', gl_code: '6100' });

      const list = await server!.app.request('/claims', {
        headers: { authorization: `Bearer ${t}` },
      });
      expect(list.status).toBe(200);
      const listBody = (await list.json()) as { claims: Array<Record<string, unknown>> };
      expect(listBody.claims).toHaveLength(1);
      expect(listBody.claims[0]).toMatchObject({ claim_ref: RECORD, amount_cents: 4200 });

      // 5. Re-submit the SAME claim (reordered body) → deduped → STILL one run + one row (C10).
      const again = await submit(
        RECORD,
        {
          amount_cents: 4200,
          description: 'Taxi to client',
          merchant: 'Yellow Cab',
        },
        t,
      );
      expect(again.status).toBe(200);
      expect((await again.json()).deduped).toBe(true);
      // C10 single-flight: a re-submit must enqueue NO second durable run. A FIXED sleep-then-read
      // samples ONCE and can MISS a genuine 2nd run whose `ensureRun` header lands just after the sleep
      // (a slow-box timing false-green — e.g. a regression that made the durable workflowRunId
      // non-deterministic). Instead POLL-until-quiescent: over a multi-second window, on EVERY tick the
      // run count must STAY at 1 and the one run must stay terminal — so a 2nd run's header (pending or
      // completed) flips the count to 2 and FAILS the instant it appears, regardless of when in the
      // window it enqueues.
      const quiesceDeadline = Date.now() + 3_000;
      for (;;) {
        const stillOne = await workflowRuns();
        expect(stillOne).toHaveLength(1); // no second run EVER appears
        expect(stillOne[0]?.status).toBe('completed'); // the one run stays terminal (no mid-flight re-run)
        if (Date.now() > quiesceDeadline) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(await codedClaims()).toHaveLength(1);

      // 6. A FOREIGN-tenant submit → 403 (cross-tenant fail-closed; zero enqueue).
      const tb = await tokenFor(TENANT_B);
      const foreign = await submit(RECORD, { merchant: 'X', amount_cents: 1 }, tb);
      expect(foreign.status).toBe(403);
      expect((await foreign.json()).error).toBe('record_event_rejected');
      expect(await workflowRuns()).toHaveLength(1); // still one run — B never enqueued
      expect(await codedClaims()).toHaveLength(1);

      // 7. An UNAUTHENTICATED submit → 401.
      const noAuth = await submit('claim-unauth', { merchant: 'X', amount_cents: 1 });
      expect(noAuth.status).toBe(401);
    },
    150_000,
  );

  maybe(
    'the S6 boot-scope gate is WIRED — an out-of-scope product doc fails the boot fail-closed',
    async () => {
      e2eTestsRan += 1;
      const savedPath = process.env.RAYSPEC_SPEC_PATH;
      process.env.RAYSPEC_SPEC_PATH = MULTISCOPE_YAML;
      try {
        const cfg = loadServerConfig();
        await expect(
          assembleServer(cfg, {
            registerProductTables: (tables) => registerScopedTables([...tables.values()]),
            productDeterministicAgents: expenseCoder(),
          }),
        ).rejects.toThrow(/multi-scope persistence/);
      } finally {
        process.env.RAYSPEC_SPEC_PATH = savedPath;
      }
    },
    120_000,
  );
});

/**
 * Ran-guard: a SEPARATE, NON-skipped describe that fails the run when the DB is
 * REQUIRED (CI / RAYSPEC_REQUIRE_DB_TESTS) but the acceptance proof above did NOT run
 * (a lost DATABASE_URL silently skipped it). Registered LAST with no beforeAll dependency.
 */
describe('Expense-Claim acceptance — ran-guard (must not silently skip in CI)', () => {
  it('the acceptance arms ACTUALLY RAN when the DB is required (CI / opt-in)', () => {
    if (dbRequired) {
      expect(e2eTestsRan).toBe(2);
    } else {
      expect(dbRequired).toBe(false);
    }
  });
});
