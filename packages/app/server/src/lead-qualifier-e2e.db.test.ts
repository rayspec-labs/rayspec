/**
 * The lead-qualifier backend, authored in `examples/lead-qualifier/`, boots through the REAL server
 * entrypoint (`assembleServer` from `RAYSPEC_SPEC_PATH`) on a throwaway DATABASE + a real DBOS launch,
 * and is driven end-to-end over REAL HTTP against MATERIALIZED ground truth (fail-the-fix). It is the
 * worked example for a BACKEND-profile spec whose declared agent ACTUALLY RUNS: unlike a validate-only
 * showcase, an inbound lead is qualified OFF-REQUEST on the durable worker, and the worker's agent
 * records its verdict by dispatching the declared `save_qualification` tool through the UNCHANGED
 * `ctx.dispatchTool` chokepoint.
 *
 * The whole chain in one doc: POST /leads → the `ingest_lead` ROUTE handler inserts the lead as
 * `unqualified` + `init.enqueue`s a durable `qualifier` run → the durable worker runs the agent (a
 * deterministic fake Backend here) → the agent calls `save_qualification` → the tool handler updates
 * the lead by id to `qualified` with the verdict → the declarative GET /leads + GET /leads/{id} views
 * serve it.
 *
 * FAIL-THE-FIX posture: the fake Backend DERIVES its verdict from the actual RUN INPUT (the lead's
 * headcount/company/message) and dispatches the tool with those derived values — it THROWS if the lead
 * never reached the run, so a wiring regression (the ingress didn't enqueue the lead, or the tool never
 * fired) goes RED here rather than being masked by a canned row. The persisted tier/queue TRACK the
 * input (a distinct lead yields a distinct verdict), and cross-tenant reads are structurally empty.
 *
 * DETERMINISTIC BY DESIGN: CI has no LLM creds, so the merge gate injects the fake Backend via
 * `agentBackendsFactory`. The REAL-LLM proof of the SAME backend is the self-skipping sibling
 * `lead-qualifier-live.smoke.db.test.ts` (runs locally with OPENAI_API_KEY; self-skips in CI).
 * Skips without DATABASE_URL; the un-skippable ran-guard hard-fails a REQUIRED run.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

const baseUrl = process.env.DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = resolve(here, '../../../../examples/lead-qualifier/lead-qualifier.rayspec.yaml');

const SUITE_DB = `rayspec_lead_qualifier_${process.pid}`;
const TENANT = '00000000-0000-4000-8000-00000000c701';
const TENANT_B = '00000000-0000-4000-8000-00000000c702';

// Ran-guard: skipIf(!baseUrl) must never let a REQUIRED run (CI / RAYSPEC_REQUIRE_DB_TESTS) read
// green after silently skipping this acceptance proof.
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
let e2eTestsRan = 0;

/**
 * The DETERMINISTIC fake Backend (the platform ships none). Wired as the `openai` adapter the declared
 * `qualifier` agent resolves to. It DERIVES the verdict from the RUN INPUT (the lead JSON the ingress
 * enqueued) and dispatches `save_qualification` through the REAL `ctx.dispatchTool` chokepoint.
 *
 * FAIL-THE-FIX: it parses `spec.input` and reads `id`/`company`/`headcount`/`message` — so if the lead
 * never reached the run (the ingress didn't enqueue it, or serialization dropped a field), the parse/
 * derivation throws and the run errors instead of persisting a canned row. The tier/queue are a pure
 * function of the headcount, so a DISTINCT lead yields a DISTINCT persisted verdict.
 */
function fakeQualifierBackend(): Backend {
  return {
    id: 'openai',
    resolveAuth: async () => 'api-key',
    run: async (spec: AgentSpec, ctx: RunContext): Promise<RunResult> => {
      const lead = JSON.parse(spec.input) as {
        id?: unknown;
        company?: unknown;
        headcount?: unknown;
        message?: unknown;
      };
      const leadId = String(lead.id);
      const company = String(lead.company);
      const headcount = Number(lead.headcount);
      if (
        typeof lead.id !== 'string' ||
        typeof lead.company !== 'string' ||
        !Number.isFinite(headcount)
      ) {
        throw new Error(`run input did not carry the lead: ${spec.input}`);
      }
      // Derived verdict — a pure function of the lead, so the persisted row tracks the input.
      const tier = headcount >= 1000 ? 'enterprise' : headcount >= 100 ? 'mid_market' : 'smb';
      const owningQueue =
        tier === 'enterprise'
          ? 'field_sales'
          : tier === 'mid_market'
            ? 'inside_sales'
            : 'self_serve';
      const base = tier === 'enterprise' ? 80 : tier === 'mid_market' ? 60 : 35;
      const nudge = Math.min(15, Math.floor(String(lead.message ?? '').length / 20));
      const fitScore = Math.min(100, base + nudge);
      const rationale = `${company} has ~${headcount} staff; routed to ${owningQueue}.`;

      if (!ctx.dispatchTool) {
        throw new Error('ctx.dispatchTool is not wired — the declared tool never reached the run.');
      }
      const res = await ctx.dispatchTool('save_qualification', {
        lead_id: leadId,
        tier,
        fit_score: fitScore,
        owning_queue: owningQueue,
        rationale,
      });
      if (res.kind !== 'tool_data') {
        throw new Error(`save_qualification dispatch failed: ${JSON.stringify(res)}`);
      }
      return {
        runId: ctx.runId,
        backend: 'openai',
        authMode: ctx.authMode ?? 'api-key',
        status: 'completed',
        finalText: `qualified ${leadId} as ${tier}`,
        output: null,
        error: null,
        errorClass: null,
        conversation: [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        costUsd: 0,
        stepCount: 1,
      };
    },
  };
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

describe.skipIf(!baseUrl)('lead-qualifier acceptance — real boot + real DBOS + HTTP', () => {
  let server: BootedServer | undefined;
  let appDbUrl = '';
  let dbosSysDb = '';
  let tokenA = '';
  let unregisterTables: (() => void) | undefined;
  const saved: Record<string, string | undefined> = {};
  const ENV = [
    'RAYSPEC_JWT_SIGNING_KEY',
    'RAYSPEC_API_KEY_PEPPER',
    'DATABASE_URL',
    'ALLOWED_ORIGINS',
    'PORT',
    'RAYSPEC_SPEC_PATH',
    'DBOS_SYSTEM_DATABASE_URL',
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
    process.env.RAYSPEC_API_KEY_PEPPER = 'lead-qualifier-pepper';
    process.env.DATABASE_URL = appDbUrl;
    delete process.env.ALLOWED_ORIGINS;
    process.env.PORT = '8817';
    process.env.RAYSPEC_SPEC_PATH = SPEC_PATH;
    delete process.env.DBOS_SYSTEM_DATABASE_URL; // exercise the derived <appdb>_dbos_sys path

    const config = loadServerConfig();
    // The derived DBOS system DB url matches what we drop on teardown.
    expect(deriveDbosSystemUrl(appDbUrl)).toBe(withDbName(baseUrl, dbosSysDb));

    server = await assembleServer(config, {
      registerProductTables: (tables) => {
        unregisterTables = registerScopedTables([...tables.values()]);
      },
      agentBackendsFactory: () => new Map<BackendId, Backend>([['openai', fakeQualifierBackend()]]),
    });

    const client = postgres(appDbUrl, { max: 2 });
    try {
      await client.unsafe(
        `INSERT INTO orgs (id, name, slug) VALUES ($1, 'LeadA', 'lead-a'), ($2, 'LeadB', 'lead-b')`,
        [TENANT, TENANT_B],
      );
    } finally {
      await client.end();
    }
    tokenA = await tokenFor(TENANT);
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    unregisterTables?.();
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

  async function tokenFor(tenant: string): Promise<string> {
    const email = `lead-${tenant.slice(-4)}-${Date.now()}@example.com`;
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

  function postLead(
    lead: { company: string; contact_email: string; message: string; headcount: number },
    token?: string,
  ): Promise<Response> {
    return server!.app.request('/leads', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(lead),
    });
  }

  function getLead(id: string, token?: string): Promise<Response> {
    return server!.app.request(`/leads/${id}`, {
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}) },
    });
  }

  function listLeads(token?: string): Promise<Response> {
    return server!.app.request('/leads', {
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}) },
    });
  }

  /** Poll GET /leads/{id} until the lead flips to `qualified` (the whole enqueue→run→tool→persist chain). */
  async function waitForQualified(id: string, token: string): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 90_000;
    for (;;) {
      const res = await getLead(id, token);
      if (res.status === 200) {
        const row = (await res.json()) as Record<string, unknown>;
        if (row.status === 'qualified') return row;
      }
      if (Date.now() > deadline)
        throw new Error(`lead ${id} was not qualified before the deadline`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  const maybe = baseUrl ? it : it.skip;

  maybe('(a) boot: the backend materializes; the ingress + declarative read routes mount', () => {
    e2eTestsRan += 1;
    expect(server!.deployMode).toBe('materialized');
    expect(server!.declaredAgents.map((a) => a.id)).toContain('qualifier');
    const actions = server!.declaredRoutes.map((r) => `${r.method} ${r.path} → ${r.action}`);
    expect(actions).toContain('POST /leads → handler:ingest_lead');
    expect(actions).toContain('GET /leads → store:leads.list');
    expect(actions).toContain('GET /leads/{id} → store:leads.get');
  });

  maybe(
    '(b) an ENTERPRISE lead: POST → 201 unqualified → durable qualify → qualified verdict from the input',
    async () => {
      e2eTestsRan += 1;
      const res = await postLead(
        {
          company: 'Globex Manufacturing',
          contact_email: 'ap@globex.example',
          message: 'We need to roll this out to every regional plant next quarter.',
          headcount: 4200,
        },
        tokenA,
      );
      expect(res.status).toBe(201);
      const created = (await res.json()) as Record<string, unknown>;
      expect(created.status).toBe('unqualified');
      expect(typeof created.id).toBe('string');
      expect(typeof created.run_id).toBe('string');
      const id = String(created.id);

      // The durable qualify run flips the lead to `qualified` with the verdict DERIVED FROM THE INPUT.
      const row = await waitForQualified(id, tokenA);
      expect(row).toMatchObject({
        company: 'Globex Manufacturing',
        status: 'qualified',
        tier: 'enterprise',
        owning_queue: 'field_sales',
      });
      expect(Number(row.fit_score)).toBeGreaterThanOrEqual(80);
      // The rationale flowed the ACTUAL company + headcount through the run input → the tool → the row.
      expect(String(row.rationale)).toContain('Globex Manufacturing');
      expect(String(row.rationale)).toContain('4200');
      expect(typeof row.qualified_at).toBe('string');

      // The declarative list view serves it (a JSON array of tenant-scoped rows).
      const list = (await (await listLeads(tokenA)).json()) as Array<Record<string, unknown>>;
      expect(Array.isArray(list)).toBe(true);
      expect(list.some((r) => r.id === id && r.tier === 'enterprise')).toBe(true);
    },
    150_000,
  );

  maybe(
    '(c) an SMB lead yields a DISTINCT verdict (the persisted tier/queue track the input, not a canned row)',
    async () => {
      e2eTestsRan += 1;
      const res = await postLead(
        {
          company: 'Corner Cafe',
          contact_email: 'owner@cornercafe.example',
          message: 'Just me and one part-timer — curious what this costs.',
          headcount: 3,
        },
        tokenA,
      );
      expect(res.status).toBe(201);
      const id = String(((await res.json()) as Record<string, unknown>).id);

      const row = await waitForQualified(id, tokenA);
      expect(row).toMatchObject({
        company: 'Corner Cafe',
        status: 'qualified',
        tier: 'smb',
        owning_queue: 'self_serve',
      });
      // Distinct from the enterprise lead: a lower fit score, a different queue — derived, not canned.
      expect(Number(row.fit_score)).toBeLessThan(80);
      expect(String(row.rationale)).toContain('Corner Cafe');
    },
    150_000,
  );

  maybe('(d) a malformed lead body → 400, nothing persisted, nothing enqueued', async () => {
    e2eTestsRan += 1;
    const res = await server!.app.request('/leads', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ company: 'No Contact', message: 'missing fields', headcount: 'lots' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>).error).toBe('invalid_lead');
    // The list is unchanged: exactly the two leads created above (no partial row from the bad POST).
    const list = (await (await listLeads(tokenA)).json()) as Array<Record<string, unknown>>;
    expect(list).toHaveLength(2);
  });

  maybe('(e) an unauthenticated POST /leads → 401 — nothing persists', async () => {
    e2eTestsRan += 1;
    const res = await postLead({
      company: 'Anon Corp',
      contact_email: 'x@anon.example',
      message: 'no auth',
      headcount: 50,
    });
    expect(res.status).toBe(401);
    const list = (await (await listLeads(tokenA)).json()) as Array<Record<string, unknown>>;
    expect(list.some((r) => r.company === 'Anon Corp')).toBe(false);
  });

  maybe(
    "(f) cross-tenant isolation: tenant B cannot read tenant A's lead (get → 404, list → empty)",
    async () => {
      e2eTestsRan += 1;
      const created = await postLead(
        {
          company: 'Initech',
          contact_email: 'tps@initech.example',
          message: 'Evaluating for the whole finance org.',
          headcount: 850,
        },
        tokenA,
      );
      const idA = String(((await created.json()) as Record<string, unknown>).id);
      await waitForQualified(idA, tokenA);

      const tokenB = await tokenFor(TENANT_B);
      // The structural TenantDb predicate makes tenant A's row invisible to tenant B → uniform 404.
      expect((await getLead(idA, tokenB)).status).toBe(404);
      // Tenant B has created no leads → an empty list (never tenant A's rows).
      const listB = await listLeads(tokenB);
      expect(listB.status).toBe(200);
      expect(await listB.json()).toEqual([]);
    },
    150_000,
  );
});

// The un-skippable ran-guard: a REQUIRED (CI / RAYSPEC_REQUIRE_DB_TESTS) run that lost DATABASE_URL
// would otherwise SILENTLY skip this acceptance proof and still read GREEN.
describe('lead-qualifier acceptance — ran-guard (must not silently skip in CI)', () => {
  it('all 6 acceptance arms actually ran when the DB was required', () => {
    if (dbRequired) expect(e2eTestsRan).toBe(6);
    else expect(dbRequired).toBe(false);
  });
});
