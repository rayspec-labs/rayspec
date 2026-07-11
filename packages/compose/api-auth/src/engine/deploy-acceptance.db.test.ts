/**
 * EXIT-GATE CRITERION 1 — the THROWAWAY ACCEPTANCE RUN.
 *
 * The headline of the finale: a non-trivial backend defined PURELY in the RaySpec format
 * (`examples/acme-notes-backend/rayspec.yaml`, OUTSIDE `packages/`) DEPLOYS END-TO-END through the REAL
 * GitOps `deploy()` command (validate → diff → lint/gate → migrate → roll out → drift), then the REAL
 * wired surface is exercised + asserted. NOT pass-the-shape: every assertion drives
 * the actual deployed thing (the migration deploy() applied, the routes it mounted, the agent it
 * registered, the tool it dispatched, the handler it ran in a tenant tx) and reads GROUND TRUTH.
 *
 * The platform stays PRODUCT-FREE: the `notebooks`/`entries` stores, routes, agent, tool, handlers
 * come from the throwaway YAML. The committed A1 tuple a real deployment ships is SIMULATED by the
 * deploy harness pre-registering the throwaway tables via the test seam (deploy() verifies-not-
 * registers; the NON-registered-store abort is proven in two places: the real chokepoint's deny-by-
 * default rejection in `packages/db/src/tenant-db.test.ts` (the `/not registered/` toThrow), and
 * deploy()'s abort-propagation of that rejection at step `roll out` in `deploy.test.ts`).
 *
 * The five exit-gate invariants (each a REAL invariant, no stub for the real thing):
 *  1. STORES materialized + tenant-scoped — deploy() applied the generated migration; introspection
 *     confirms the tables exist with the tenant_id FK -> orgs ON DELETE CASCADE (+ the cascade
 *     actually removes product rows on an org delete).
 *  2. API ROUTES live behind the REAL auth chain — a valid org principal CRUDs its rows; a CROSS-
 *     TENANT read returns 404/empty (no leak); an UNAUTHENTICATED request is 401.
 *  3. an AGENT RUN journaled through `runAgent` — the declared `summarizer` runs via the spec-built
 *     registry + the existing run surface; a `runs` row + `llm` journal step exist for the tenant.
 *  4. a declared TOOL dispatched through `dispatchTool` — `lookup_notebook` fires through the UNCHANGED
 *     chokepoint; a `tool` journal step exists; the opaque tool_data flows back in the RunResult.
 *  5. a ROUTE HANDLER running inside a `TenantDb` transaction with the `app.current_tenant` GUC
 *     VERIFIED populated — read back INSIDE the handler's own tx (no proxy/blind assertion).
 *
 * Skips when DATABASE_URL is absent.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentSpec, Backend, BackendId, RunContext, RunResult } from '@rayspec/core';
import { type Db, forTenant, generateProductSql, schema, TENANT_GUC } from '@rayspec/db';
import { type RaySpec, parseSpec } from '@rayspec/spec';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDeployHarness, type DeployHarness, jsonRequest } from '../test-support/harness.js';
import { type DeployResult, deploy } from './deploy.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
// un-skippable ran-guard: this DB-backed acceptance suite proves the end-to-end deploy + cross-tenant
// invariants — it must never silently self-skip to a false green. When the DB is REQUIRED but absent,
// hard-fail at collection rather than skip.
if (requireDb && !hasDb) {
  throw new Error(
    'deploy-acceptance.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — ' +
      'refusing to silently skip a security-load-bearing suite.',
  );
}

const here = dirname(fileURLToPath(import.meta.url));
// packages/api-auth/src/engine -> repo-root/examples/acme-notes-backend
const ACME_DIR = resolve(here, '../../../../../examples/acme-notes-backend');
const YAML_PATH = resolve(ACME_DIR, 'rayspec.yaml');

function loadSpec(): RaySpec {
  const parsed = parseSpec(readFileSync(YAML_PATH, 'utf8'));
  if (!parsed.ok) throw new Error(`throwaway spec invalid: ${JSON.stringify(parsed.errors)}`);
  return parsed.value;
}

/**
 * Build the deploy source: the throwaway YAML with a `{handler}` ROUTE + its handler SPLICED into the
 * existing `api:`/`handlers:` blocks (the throwaway declares only store/agent routes), so the
 * acceptance run also exercises the route-handler-inside-a-tenant-tx + GUC invariant.
 * Spliced into the existing sections (not concatenated — two `api:` keys would be a YAML duplicate-key
 * error), so deploy()'s OWN `parseSpec` (the validate step) processes ONE valid document for real.
 */
function deploySource(): string {
  const base = readFileSync(YAML_PATH, 'utf8');
  // Insert a `{handler}` route after the `{agent}` summarize route, and its handler after the trigger
  // handler — a small structured edit on the throwaway's known layout.
  const withRoute = base.replace(
    /(\n\s*-\s*method: POST\n\s*path: \/notebooks\/\{id\}\/summarize\n\s*action: \{ kind: agent, agent: summarizer \}\n)/,
    `$1  - method: GET\n    path: /completed\n    action: { kind: handler, handler: list_completed_route }\n`,
  );
  const withHandler = withRoute.replace(
    /(\n\s*-\s*id: nightly_digest_handler\n\s*module: handlers\/nightly-digest\.ts\n\s*export: nightlyDigest\n\s*kind: trigger\n)/,
    `$1  - id: list_completed_route\n    module: handlers/list-completed-route.ts\n    export: listCompleted\n    kind: route\n`,
  );
  return withHandler;
}

/**
 * A deterministic backend that drives a REAL `lookup_notebook` dispatch with VALID args (the notebook id
 * threaded as `spec.input`), so the escape-hatch tool handler actually runs against the store + the
 * opaque tool_data flows back — no live model. Mirrors the acceptance backend.
 */
class LookupDrivingBackend implements Backend {
  readonly id = 'openai' as const;
  async resolveAuth() {
    return 'api-key' as const;
  }
  async run(spec: AgentSpec, ctx: RunContext): Promise<RunResult> {
    await ctx.onEvent?.({ type: 'run_started', runId: ctx.runId } as never);
    let toolValue: unknown = null;
    if (ctx.dispatchTool && (ctx.tools?.length ?? 0) > 0) {
      const res = await ctx.dispatchTool('lookup_notebook', { notebook_id: spec.input }, 'call-1');
      toolValue = res.kind === 'tool_data' ? res.data : { error: res.message };
    }
    await ctx.journal.record({
      type: 'llm',
      idempotencyKey: `llm:${spec.name}:0`,
      inputHash: `hash:${spec.input}`,
      output: { finalText: 'done' },
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
      costUsd: 0,
      model: spec.model,
      producedBy: 'lookup-driving-backend',
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
      finalText: 'done',
      output: toolValue !== null ? { tool: toolValue } : null,
      error: null,
      errorClass: null,
      conversation: [{ role: 'user', index: 0, parts: [{ kind: 'text', text: spec.input }] }],
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
      costUsd: 0,
      stepCount: 1,
    };
  }
}

describe.skipIf(!hasDb)('throwaway acceptance run (REAL deploy() end-to-end)', () => {
  let h: DeployHarness;
  let result: DeployResult<ReturnType<DeployHarness['buildApp']>>;
  let app: ReturnType<DeployHarness['buildApp']>;
  const SCHEMA = 'rayspec_test_deploy_accept';
  // Captured per request: the GUC value read INSIDE the route handler's own transaction.
  const capturedGuc: { value: string | null } = { value: null };

  // Wrap the raw Db so the route-handler's `forTenant(...).transaction(...)` body is observed: after
  // TenantDb's set_config + the handler body run, read current_setting on the SAME tx handle.
  function wrapDb(db: Db): Db {
    const realTransaction = db.transaction.bind(db);
    return new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'transaction') {
          return (inner: (tx: unknown) => Promise<unknown>, ...rest: unknown[]) =>
            realTransaction(
              async (tx: unknown) => {
                const r = await inner(tx);
                const rows = (await (tx as Db).execute(
                  sql`select current_setting(${TENANT_GUC}, true) as tenant`,
                )) as unknown as Array<{ tenant: string | null }>;
                capturedGuc.value = rows[0]?.tenant ?? null;
                return r;
              },
              ...(rest as []),
            ) as unknown;
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as Db;
  }

  beforeAll(async () => {
    const spec = loadSpec();
    h = await createDeployHarness({ stores: spec.stores, schema: SCHEMA, wrapDb });
    const backends = new Map<BackendId, Backend>([['openai', new LookupDrivingBackend()]]);
    // THE DEPLOY: drive the REAL GitOps pipeline. The migration is the generator's deterministic,
    // reviewable additive SQL. loadHandlers runs path-jailed against the throwaway dir.
    result = await deploy<ReturnType<DeployHarness['buildApp']>>({
      specSource: deploySource(),
      migrations: [
        { name: '0000_product_stores.sql', sql: generateProductSql(spec.stores), allowlist: [] },
      ],
      target: h.target,
      rollout: {
        productTables: h.productTables,
        escapeHatchRoot: ACME_DIR,
        agentBackends: backends,
        buildApp: h.buildApp,
      },
    });
    app = result.app;
  });
  beforeEach(async () => {
    await h.reset();
    capturedGuc.value = null;
  });
  afterAll(async () => {
    await h.close();
  });

  /** Register → org → switch → JWT (member role: store:read/write + agent:run). */
  async function principal(
    email: string,
    orgName: string,
  ): Promise<{ orgId: string; token: string }> {
    const reg = await jsonRequest(app, 'POST', '/v1/auth/register', {
      body: { email, password: 'a-long-enough-password' },
    });
    const t0 = (await reg.json()).accessToken as string;
    const orgId = (
      await (
        await jsonRequest(app, 'POST', '/v1/orgs', {
          body: { name: orgName },
          headers: { authorization: `Bearer ${t0}` },
        })
      ).json()
    ).id as string;
    const token = (
      await (
        await jsonRequest(app, 'POST', `/v1/orgs/${orgId}/switch`, {
          headers: { authorization: `Bearer ${t0}` },
        })
      ).json()
    ).accessToken as string;
    return { orgId, token };
  }

  it('deploy() succeeded: gate passed, handlers loaded, triggers registered, drift clean', () => {
    // The DIFF step generated the reviewable additive SQL.
    expect(result.generatedStoreSql).toContain('CREATE TABLE "notebooks"');
    // The LINT/GATE step passed (additive migration, no destructive findings).
    expect(result.gateResults.every((g) => g.pass)).toBe(true);
    // ROLL OUT: handlers loaded (tool + trigger + route) + the agent route + triggers registered.
    expect(result.handlers.get('lookup_notebook_handler')?.kind).toBe('tool');
    expect(result.handlers.get('nightly_digest_handler')?.kind).toBe('trigger');
    expect(result.handlers.get('list_completed_route')?.kind).toBe('route');
    // The cron trigger was registered (parse/register only — a fire is fail-closed-rejected).
    expect(result.triggers.get('nightly-digest')?.kind).toBe('cron');
    // DRIFT: report-only, and CLEAN — the live schema deploy() applied matches the spec.
    expect(result.drift).toEqual([]);
  });

  it('(1) STORES materialized + tenant-scoped: tables exist with tenant_id FK -> orgs ON DELETE CASCADE', async () => {
    // Ground truth: deploy()'s MIGRATE step applied the generated migration to the isolated schema.
    const rows = (await h.db.$client.unsafe(
      `SELECT tc.table_name, rc.delete_rule, ccu.table_name AS ref
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
         JOIN information_schema.constraint_column_usage ccu
           ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
         JOIN information_schema.referential_constraints rc
           ON tc.constraint_name = rc.constraint_name AND tc.table_schema = rc.constraint_schema
        WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_schema=$1
          AND kcu.column_name='tenant_id' AND tc.table_name = ANY($2)`,
      [SCHEMA, ['notebooks', 'entries']],
    )) as unknown as Array<{ table_name: string; delete_rule: string; ref: string }>;
    const byTable = new Map(rows.map((r) => [r.table_name, r]));
    expect(byTable.get('notebooks')).toMatchObject({ ref: 'orgs', delete_rule: 'CASCADE' });
    expect(byTable.get('entries')).toMatchObject({ ref: 'orgs', delete_rule: 'CASCADE' });
  });

  it('(2) API ROUTES live behind the REAL auth chain: CRUD works, cross-tenant 404, unauth 401', async () => {
    const a = await principal('accept-a@example.com', 'AcceptAOrg');
    const b = await principal('accept-b@example.com', 'AcceptBOrg');

    // CREATE (store:write) — tenant-scoped through the real chain.
    const created = await jsonRequest(app, 'POST', '/notebooks', {
      body: { title: 'A-only', scheduledAt: '2026-07-01T10:00:00Z', completed: false },
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(created.status).toBe(201);
    const notebookId = (await created.json()).id as string;

    // GET as A works.
    const getA = await jsonRequest(app, 'GET', `/notebooks/${notebookId}`, {
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(getA.status).toBe(200);

    // CROSS-TENANT: B cannot see A's notebook (404, no leak).
    const getB = await jsonRequest(app, 'GET', `/notebooks/${notebookId}`, {
      headers: { authorization: `Bearer ${b.token}` },
    });
    expect(getB.status).toBe(404);

    // UNAUTHENTICATED is rejected at the chain (401), never reaches the store handler.
    const noAuth = await jsonRequest(app, 'GET', '/notebooks', {});
    expect(noAuth.status).toBe(401);
  });

  it('(3+4) an AGENT RUN journals through runAgent + (4) a declared TOOL dispatches through dispatchTool', async () => {
    const { orgId, token } = await principal('accept-agent@example.com', 'AcceptAgentOrg');
    // Seed a notebook via the declared store route (tenant-scoped).
    const created = await jsonRequest(app, 'POST', '/notebooks', {
      body: { title: 'Q3 Planning', scheduledAt: '2026-07-01T10:00:00Z', completed: false },
      headers: { authorization: `Bearer ${token}` },
    });
    const notebookId = (await created.json()).id as string;

    // Run the DECLARED agent (spec-built registry). The run input is the notebook id, threaded into
    // the lookup_notebook dispatch. The tool handler reads THIS tenant's notebook.
    const run = await jsonRequest(app, 'POST', '/v1/agents/summarizer/runs', {
      body: { input: notebookId },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(run.status).toBe(200);
    const runResult = (await run.json()) as RunResult;
    expect(runResult.status).toBe('completed');
    // (4) the tool ran the escape-hatch handler against the store + returned the metadata as opaque
    // tool_data (the tool's outputSchema declares snake_case `scheduled_at`).
    expect(runResult.output).toEqual({
      tool: { title: 'Q3 Planning', scheduled_at: expect.any(String) },
    });

    const tdb = forTenant(h.db, orgId);
    // (3) GROUND TRUTH: a `runs` header row exists for this tenant's run (journaled through runAgent).
    const runs = (await tdb
      .select(schema.runs)
      .where(eq(schema.runs.runId, runResult.runId))) as Array<{ status: string }>;
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('completed');
    // (4) GROUND TRUTH: a `tool` journal step was recorded for this tenant's run (dispatch fired).
    const toolSteps = (await tdb
      .select(schema.journalSteps)
      .where(
        and(eq(schema.journalSteps.runId, runResult.runId), eq(schema.journalSteps.type, 'tool')),
      )) as Array<{ status: string }>;
    expect(toolSteps).toHaveLength(1);
    expect(toolSteps[0]?.status).toBe('ok');
  });

  it('(5) a ROUTE HANDLER runs inside a TenantDb tx with the app.current_tenant GUC VERIFIED populated', async () => {
    const { orgId, token } = await principal('accept-route@example.com', 'AcceptRouteOrg');
    // Seed a completed notebook so the route handler returns it.
    await jsonRequest(app, 'POST', '/notebooks', {
      body: { title: 'done-1', scheduledAt: '2026-07-01T10:00:00Z', completed: true },
      headers: { authorization: `Bearer ${token}` },
    });
    // The seed POST (a {store} create) already populated `capturedGuc.value` via its OWN store-create
    // transaction. RESET it to null BEFORE the GET so ONLY the route handler's own transaction can
    // satisfy the assertion below — otherwise the seed's GUC would mask a "route-handler-skips-its-tx"
    // regression (the assertion would still pass even if the {handler} route stopped opening its tx).
    capturedGuc.value = null;
    // Drive the {handler} route — runs listCompleted inside forTenant(...).transaction(...).
    const res = await jsonRequest(app, 'GET', '/completed', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number; notebooks: Array<{ title: string }> };
    expect(body.count).toBe(1);
    expect(body.notebooks[0]?.title).toBe('done-1');
    // THE deliverable-5 assertion: the GUC read INSIDE the handler's own transaction == request tenant.
    expect(capturedGuc.value).toBe(orgId);
    expect(capturedGuc.value).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('(1b) the tenant_id FK CASCADE actually removes product rows on an org delete', async () => {
    const { orgId, token } = await principal('accept-cascade@example.com', 'AcceptCascadeOrg');
    await jsonRequest(app, 'POST', '/notebooks', {
      body: { title: 'to-cascade', scheduledAt: '2026-07-01T10:00:00Z', completed: false },
      headers: { authorization: `Bearer ${token}` },
    });
    const before = (await h.db.$client.unsafe(
      `SELECT count(*)::int AS c FROM ${SCHEMA}.notebooks WHERE tenant_id=$1`,
      [orgId],
    )) as unknown as Array<{ c: number }>;
    expect(before[0]?.c).toBe(1);
    // Delete the org → the tenant_id FK ON DELETE CASCADE removes the product rows.
    await h.db.$client.unsafe(`DELETE FROM ${SCHEMA}.orgs WHERE id=$1`, [orgId]);
    const after = (await h.db.$client.unsafe(
      `SELECT count(*)::int AS c FROM ${SCHEMA}.notebooks WHERE tenant_id=$1`,
      [orgId],
    )) as unknown as Array<{ c: number }>;
    expect(after[0]?.c).toBe(0);
  });
});
