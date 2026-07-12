/**
 * Deterministic AUTO-PERSIST LOOP acceptance test (NO LLM, fake backend).
 *
 * This is the deterministic floor: it wires the GENERATED Expense-Claim handlers (rendered by
 * `rayspec gen-handler` from committed holes — examples/expense-claim-coder/handlers) through the REAL
 * `dispatchTool` chokepoint (via `buildToolFactory` + run-core) + a FAKE backend that deterministically
 * (a) calls `lookup_categories` to read the org's catalog and (b) calls `code_claim` with a fixed valid
 * arg — then ASSERTS the row LANDED in `expense_claims` via the tenant-bound db (status:coded + the
 * chosen category_code), proving the loop end-to-end against ground truth, NO model involved.
 *
 * THE LOOP A ONE-SHOT AGENT STRUCTURALLY CANNOT DO: an agent that, inside its run, READS a store (lookup) and
 * WRITES its result back to a store (persist) via tool handlers — both through the UNCHANGED
 * dispatchTool, both tenant-scoped by the injected init.db.
 *
 * FAIL-THE-FIX (non-blind):
 *   - the loop asserts the WRITTEN ROW (not just a 200) — a no-op handler would leave the claim
 *     `submitted` and flip this RED;
 *   - the coercion is load-bearing: an UNTRUSTED arg that violates the column contract (a non-enum
 *     policy_flag, a non-string code) returns `failed` and writes NOTHING. Revert the rendered
 *     coercion (accept any arg) and the malformed-arg case would WRITE the bad value → RED;
 *   - the FK re-validation is load-bearing: a category_code NOT in the catalog returns `failed`, no
 *     write. Remove the rendered FK re-check and that case would persist an invalid code → RED;
 *   - tenant isolation: a second tenant's coder cannot read/write the first tenant's rows.
 *
 * Skips when DATABASE_URL is absent (turbo passes it in CI; a credential-free run self-skips). Uses a
 * DEDICATED schema (never `public`, never the shared platform test schema) per the per-suite-isolation
 * hard-won lesson (false-green hazard).
 */

import type {
  AgentSpec,
  AuthMode,
  Backend,
  NeutralTool,
  RunContext,
  RunResult,
} from '@rayspec/core';
import { forTenant } from '@rayspec/db';
import { buildProductTables, makeDbWithSchema, registerScopedTables } from '@rayspec/db/testing';
import type { RaySpec, StoreSpec } from '@rayspec/spec';
import type { PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
// The GENERATED reference handlers (rendered by `rayspec gen-handler`; committed under examples/).
import { codeClaim } from '../../../../examples/expense-claim-coder/handlers/code-claim.gen.js';
import { lookupCategories } from '../../../../examples/expense-claim-coder/handlers/lookup-categories.gen.js';
import type { ResolvedHandler } from './handlers/handler-runtime.js';
import { buildToolFactory } from './handlers/resolve-tools.js';
import { runAgent } from './run-core.js';

const SCHEMA = 'rayspec_test_it2_loop';
const TENANT_A = '00000000-0000-0000-0000-0000000000a2';
const TENANT_B = '00000000-0000-0000-0000-0000000000b2';
const hasDb = Boolean(process.env.DATABASE_URL);

/**
 * Ran-guard (the false-green hazard). This file is the ONLY suite that exercises
 * the GENERATED handlers' RUNTIME safety (coercion / FK re-check / tenant isolation / the row landed).
 * The DB-backed suite `skipIf(!hasDb)`s so a credential-free dev run skips ergonomically — but a CI run
 * that lost DATABASE_URL would then SILENTLY SKIP the security proof and still read green. We close that
 * by counting the security tests that actually RAN and asserting (in a separate, NON-skipped describe)
 * that the count is non-zero whenever the DB is REQUIRED. "Required" = `CI` is set (GitHub Actions sets
 * `CI=true`; turbo passes `CI` through to the test process — verified) OR an explicit
 * `RAYSPEC_REQUIRE_DB_TESTS` opt-in (for the local-CI gate run, or a direct `pnpm --filter` run
 * outside turbo). So a silent skip in CI becomes a hard RED; a local dev with no DB still gets a skip.
 */
let securityTestsRan = 0;
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';

// The two product stores (declared OUTSIDE the platform — a TEST fixture mirroring the golden spec).
const categoriesStore: StoreSpec = {
  name: 'expense_categories',
  columns: [
    { name: 'code', type: 'text', nullable: false, unique: true },
    { name: 'name', type: 'text', nullable: false, unique: false },
    { name: 'description', type: 'text', nullable: true, unique: false },
    { name: 'active', type: 'boolean', nullable: false, unique: false },
  ],
  foreignKeys: [],
};
const claimsStore: StoreSpec = {
  name: 'expense_claims',
  columns: [
    { name: 'employee_email', type: 'text', nullable: false, unique: false },
    { name: 'description', type: 'text', nullable: false, unique: false },
    { name: 'amount_cents', type: 'integer', nullable: false, unique: false },
    { name: 'currency', type: 'text', nullable: false, unique: false },
    { name: 'status', type: 'text', nullable: false, unique: false },
    { name: 'category_code', type: 'text', nullable: true, unique: false },
    { name: 'gl_code', type: 'text', nullable: true, unique: false },
    { name: 'coding_summary', type: 'text', nullable: true, unique: false },
    { name: 'policy_flag', type: 'text', nullable: true, unique: false },
  ],
  foreignKeys: [],
};

/** The (boot-loaded-equivalent) id → ResolvedHandler map the factory resolves the tools against. */
const handlers: ReadonlyMap<string, ResolvedHandler> = new Map<string, ResolvedHandler>([
  ['ec_lookup_categories', { kind: 'tool', fn: lookupCategories as never }],
  ['ec_code_claim', { kind: 'tool', fn: codeClaim as never }],
]);

/** A spec carrying ONLY the loop tooling (the agent's two tools), as the golden rayspec.yaml declares. */
function it2Spec(): RaySpec {
  return {
    version: '1.0',
    metadata: { name: 'expense-claim-coder' },
    stores: [],
    api: [],
    agents: [],
    triggers: [],
    handlers: [],
    tooling: [
      {
        id: 'lookup_categories',
        name: 'lookup_categories',
        description: 'List the org active expense categories.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: { query: { type: 'string' } },
          required: [],
        },
        outputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            rows: { type: 'array', items: { type: 'object' } },
            count: { type: 'number' },
          },
          required: ['rows', 'count'],
        },
        handler: 'ec_lookup_categories',
        idempotent: true,
        timeoutMs: 15000,
      },
      {
        id: 'code_claim',
        name: 'code_claim',
        description: 'Persist the coding decision for an expense claim.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            claim_id: { type: 'string' },
            category_code: { type: 'string' },
            gl_code: { type: 'string' },
            coding_summary: { type: 'string' },
            policy_flag: { type: 'string', enum: ['ok', 'review', 'violation'] },
          },
          required: ['claim_id', 'category_code', 'gl_code', 'coding_summary', 'policy_flag'],
        },
        outputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string' },
            id: { type: 'string' },
            detail: { type: 'string' },
          },
          required: ['status'],
        },
        handler: 'ec_code_claim',
        idempotent: true,
        timeoutMs: 30000,
      },
    ],
  } as RaySpec;
}

/**
 * A fake backend that drives the auto-persist LOOP deterministically (no model): it dispatches
 * `lookup_categories`, then `code_claim` with the provided fixed args — EXACTLY as a real adapter
 * marshals SDK tool calls into ctx.dispatchTool. It holds no handler (the dispatcher owns the path).
 */
class LoopBackend implements Backend {
  readonly id = 'openai' as const;
  codeArgs: Record<string, unknown>;
  lookupRows: unknown[] = [];
  codeStatus?: string;
  constructor(codeArgs: Record<string, unknown>) {
    this.codeArgs = codeArgs;
  }
  async resolveAuth(): Promise<AuthMode> {
    return 'api-key';
  }
  async run(spec: AgentSpec, ctx: RunContext): Promise<RunResult> {
    if (ctx.dispatchTool) {
      const looked = await ctx.dispatchTool('lookup_categories', { query: '' }, 'call-lookup-1');
      if (looked.kind === 'tool_data') {
        const data = looked.data as { rows?: unknown[] };
        this.lookupRows = Array.isArray(data.rows) ? data.rows : [];
      }
      const coded = await ctx.dispatchTool('code_claim', this.codeArgs, 'call-code-1');
      if (coded.kind === 'tool_data') {
        this.codeStatus = (coded.data as { status?: string }).status;
      }
    }
    if (!ctx.replay) {
      await ctx.journal.record({
        type: 'llm',
        idempotencyKey: `llm:${spec.name}`,
        inputHash: `hash:${spec.input}`,
        output: { finalText: 'coded' },
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        costUsd: 0,
        model: spec.model,
        producedBy: 'it2-loop-backend',
        latencyMs: 1,
        status: 'ok',
        authMode: 'api-key',
      });
    }
    return {
      runId: ctx.runId,
      backend: this.id,
      authMode: 'api-key',
      status: 'completed',
      finalText: 'coded',
      output: null,
      error: null,
      errorClass: null,
      conversation: [{ role: 'assistant', index: 0, parts: [{ kind: 'text', text: 'coded' }] }],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      costUsd: 0,
      stepCount: 3,
    };
  }
}

function agentSpec(): AgentSpec {
  return {
    name: 'expense_coder',
    instructions: 'code the claim',
    model: 'gpt-4o-mini',
    input: 'code claim',
    tools: [],
    maxTurns: 12,
  };
}

describe.skipIf(!hasDb)(
  'auto-persist LOOP — generated handlers through the real dispatchTool',
  () => {
    let db: ReturnType<typeof makeDbWithSchema>;
    let productTables: Map<string, PgTable>;
    let unregister: () => void;

    beforeAll(async () => {
      db = makeDbWithSchema(process.env.DATABASE_URL as string, SCHEMA);
      await db.$client.unsafe(`
      DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;
      CREATE SCHEMA ${SCHEMA};
      SET search_path TO ${SCHEMA};
      CREATE TABLE orgs (id uuid PRIMARY KEY, name text, created_at timestamptz NOT NULL DEFAULT now());
      -- run-core journal/idempotency tables (the dispatch chokepoint journals one step per tool call).
      CREATE TABLE journal_steps (
        step_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id text NOT NULL,
        tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, backend text NOT NULL,
        type text NOT NULL, idempotency_key text NOT NULL, input_hash text NOT NULL, output jsonb,
        input_tokens numeric NOT NULL DEFAULT '0', output_tokens numeric NOT NULL DEFAULT '0',
        total_tokens numeric NOT NULL DEFAULT '0', cost_usd numeric NOT NULL DEFAULT '0',
        provider_cost_usd numeric, billed_cost_usd numeric NOT NULL DEFAULT '0',
        cost_drift boolean NOT NULL DEFAULT false, produced_by text, pricing_version text,
        latency_ms numeric NOT NULL DEFAULT '0', status text NOT NULL, auth_mode text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX it2_journal_idem_idx ON journal_steps (tenant_id, run_id, idempotency_key);
      CREATE TABLE idempotency_keys (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        scope text NOT NULL, idem_key text NOT NULL, body_hash text NOT NULL, snapshot jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX it2_idem_idx ON idempotency_keys (tenant_id, scope, idem_key);
      CREATE TABLE conversation_items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id text NOT NULL,
        tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, seq numeric NOT NULL,
        turn_index numeric, role text NOT NULL, kind text, tool_call_id text, payload jsonb,
        name text, content text, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE runs (
        run_id text PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        backend text NOT NULL, auth_mode text NOT NULL, agent_name text NOT NULL, model text NOT NULL,
        status text NOT NULL, final_text text, output jsonb, cost_usd numeric NOT NULL DEFAULT '0',
        provider_cost_usd numeric, billed_cost_usd numeric NOT NULL DEFAULT '0',
        cost_drift boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE run_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id text NOT NULL,
        tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, seq numeric NOT NULL,
        type text NOT NULL, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX it2_run_events_idx ON run_events (tenant_id, run_id, seq);
      -- the two PRODUCT stores (with the injected tenancy/GDPR columns a real deploy adds).
      CREATE TABLE expense_categories (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        code text NOT NULL, name text NOT NULL, description text, active boolean NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
        retention_days integer, region text NOT NULL DEFAULT 'eu', created_by text, idempotency_key text
      );
      CREATE TABLE expense_claims (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        employee_email text NOT NULL, description text NOT NULL, amount_cents integer NOT NULL,
        currency text NOT NULL, status text NOT NULL, category_code text, gl_code text,
        coding_summary text, policy_flag text,
        created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
        retention_days integer, region text NOT NULL DEFAULT 'eu', created_by text, idempotency_key text
      );
      INSERT INTO orgs (id, name) VALUES ('${TENANT_A}', 'A'), ('${TENANT_B}', 'B');
    `);
      productTables = buildProductTables([categoriesStore, claimsStore]);
      unregister = registerScopedTables([...productTables.values()]);
    });

    afterAll(async () => {
      unregister?.();
      await db?.$client.end();
    });

    beforeEach(async () => {
      await db.$client.unsafe(
        `SET search_path TO ${SCHEMA};
       TRUNCATE journal_steps, conversation_items, run_events, runs, idempotency_keys, expense_claims, expense_categories CASCADE;`,
      );
    });

    /** Seed the lookup catalog + one submitted claim for TENANT_A; return the claim id. */
    async function seedClaim(tenant: string): Promise<string> {
      const tdb = forTenant(db, tenant);
      const cat = productTables.get('expense_categories') as PgTable;
      const claims = productTables.get('expense_claims') as PgTable;
      await tdb.insert(
        cat as never,
        { code: 'TRAVEL', name: 'Travel', description: 'trips', active: true } as never,
      );
      await tdb.insert(cat as never, { code: 'MEALS', name: 'Meals', active: true } as never);
      const inserted = (await tdb
        .insert(
          claims as never,
          {
            employeeEmail: 'a@x.com',
            description: 'Taxi to the airport',
            amountCents: 4200,
            currency: 'EUR',
            status: 'submitted',
          } as never,
        )
        .returning()) as Record<string, unknown>[];
      return inserted[0]?.id as string;
    }

    async function getClaim(
      tenant: string,
      id: string,
    ): Promise<Record<string, unknown> | undefined> {
      const handlerDb = (await import('./handlers/store-facade.js')).makeHandlerDb(
        forTenant(db, tenant),
        productTables,
      );
      const rows = await handlerDb.select('expense_claims', { id });
      return rows[0];
    }

    it('LOOP: lookup reads the catalog → code_claim WRITES the coded row back (the auto-persist acceptance)', async () => {
      securityTestsRan++;
      const claimId = await seedClaim(TENANT_A);
      const tdb = forTenant(db, TENANT_A);
      const tools: NeutralTool[] = buildToolFactory(it2Spec(), handlers, productTables, [
        'lookup_categories',
        'code_claim',
      ])(tdb);

      const backend = new LoopBackend({
        claim_id: claimId,
        category_code: 'TRAVEL',
        gl_code: '6000',
        coding_summary: 'Travel expense for an airport taxi.',
        policy_flag: 'ok',
      });
      const run = await runAgent(tdb, backend, agentSpec(), { tools });

      expect(run.status).toBe('completed');
      // The lookup READ the org catalog (both seeded categories visible).
      expect(backend.lookupRows.length).toBe(2);
      // code_claim reported success.
      expect(backend.codeStatus).toBe('coded');

      // THE ACCEPTANCE: the row LANDED — the claim is now coded with a catalog category_code + filled
      // fields (a no-op handler would leave it `submitted` → RED).
      const claim = await getClaim(TENANT_A, claimId);
      expect(claim?.status).toBe('coded');
      expect(claim?.category_code).toBe('TRAVEL');
      expect(['TRAVEL', 'MEALS']).toContain(claim?.category_code); // ∈ the seeded catalog
      expect(claim?.gl_code).toBe('6000');
      expect(claim?.coding_summary).toBe('Travel expense for an airport taxi.');
      expect(claim?.policy_flag).toBe('ok');
    });

    it('idempotency: re-coding the same claim id reconciles ONE row (update-by-id, not a duplicate)', async () => {
      securityTestsRan++;
      const claimId = await seedClaim(TENANT_A);
      const tdb = forTenant(db, TENANT_A);
      const mk = () =>
        buildToolFactory(it2Spec(), handlers, productTables, ['lookup_categories', 'code_claim'])(
          tdb,
        );
      const args = {
        claim_id: claimId,
        category_code: 'MEALS',
        gl_code: '6100',
        coding_summary: 'Team lunch.',
        policy_flag: 'review',
      };
      await runAgent(tdb, new LoopBackend(args), agentSpec(), { tools: mk() });
      await runAgent(tdb, new LoopBackend(args), agentSpec(), { tools: mk() });
      const facade = (await import('./handlers/store-facade.js')).makeHandlerDb(tdb, productTables);
      const all = await facade.select('expense_claims');
      expect(all).toHaveLength(1); // ONE claim row — re-coding reconciled it, did not duplicate.
      expect(all[0]?.category_code).toBe('MEALS');
    });

    it('coercion is load-bearing (DIRECT handler call, schema bypassed): a malformed arg → failed, NO write', async () => {
      securityTestsRan++;
      // dispatchTool's inputSchema would reject some of these before the handler runs; to prove the
      // HANDLER'S OWN coercion is load-bearing (revert the rendered coercion → these would WRITE the bad
      // value), call the generated handler DIRECTLY with the engine-built tenant-bound init (the same
      // init.db the resolver injects). Each malformed UNTRUSTED arg must return `failed` and write NOTHING.
      const claimId = await seedClaim(TENANT_A);
      const init = {
        tenantId: TENANT_A,
        db: (await import('./handlers/store-facade.js')).makeHandlerDb(
          forTenant(db, TENANT_A),
          productTables,
        ),
      };
      const base = {
        claim_id: claimId,
        category_code: 'TRAVEL',
        gl_code: '6000',
        coding_summary: 'x',
        policy_flag: 'ok',
      };
      const malformed: Array<Record<string, unknown>> = [
        { ...base, policy_flag: 'totally-not-a-flag' }, // enum violation
        { ...base, category_code: 123 }, // non-string text column
        { ...base, gl_code: null }, // required, non-nullable → missing
        { ...base, coding_summary: { evil: true } }, // an object where a string is required
      ];
      for (const args of malformed) {
        const res = (await codeClaim(args, init as never)) as { status: string };
        expect(res.status).toBe('failed');
      }
      // After ALL malformed attempts the claim is still submitted, uncoded (nothing was written).
      const claim = await getClaim(TENANT_A, claimId);
      expect(claim?.status).toBe('submitted');
      expect(claim?.category_code).toBeNull();
      expect(claim?.policy_flag).toBeNull();
    });

    it('FK re-validation is load-bearing: a category_code NOT in the catalog is rejected — no write', async () => {
      securityTestsRan++;
      const claimId = await seedClaim(TENANT_A);
      const tdb = forTenant(db, TENANT_A);
      const tools = buildToolFactory(it2Spec(), handlers, productTables, [
        'lookup_categories',
        'code_claim',
      ])(tdb);
      const backend = new LoopBackend({
        claim_id: claimId,
        category_code: 'NOPE', // a well-formed string, but NOT a real code in expense_categories.
        gl_code: '6000',
        coding_summary: 'x',
        policy_flag: 'ok',
      });
      await runAgent(tdb, backend, agentSpec(), { tools });
      expect(backend.codeStatus).toBe('failed');
      const claim = await getClaim(TENANT_A, claimId);
      expect(claim?.status).toBe('submitted'); // not coded — the FK re-check refused the model's choice.
      expect(claim?.category_code).toBeNull();
    });

    it("tenant isolation: tenant B cannot read/code tenant A's claim through the generated handlers", async () => {
      securityTestsRan++;
      const aClaimId = await seedClaim(TENANT_A);
      const bTdb = forTenant(db, TENANT_B);
      // B seeds its OWN catalog so a lookup is non-empty; then B tries to code A's claim id.
      await bTdb.insert(
        productTables.get('expense_categories') as never,
        {
          code: 'TRAVEL',
          name: 'Travel',
          active: true,
        } as never,
      );
      const tools = buildToolFactory(it2Spec(), handlers, productTables, [
        'lookup_categories',
        'code_claim',
      ])(bTdb);
      const backend = new LoopBackend({
        claim_id: aClaimId,
        category_code: 'TRAVEL',
        gl_code: '6000',
        coding_summary: 'x',
        policy_flag: 'ok',
      });
      await runAgent(bTdb, backend, agentSpec(), { tools });
      // B's update matched ZERO rows (A's claim is invisible to B's tenant-scoped facade) → failed.
      expect(backend.codeStatus).toBe('failed');
      // A's claim is untouched (still submitted, no category).
      const aClaim = await getClaim(TENANT_A, aClaimId);
      expect(aClaim?.status).toBe('submitted');
      expect(aClaim?.category_code).toBeNull();
    });
  },
);

/**
 * Ran-guard: a SEPARATE, NON-skipped top-level describe that fails
 * the run when the DB is REQUIRED (CI / RAYSPEC_REQUIRE_DB_TESTS) but the security suite above did NOT
 * run — i.e. a CI run that lost DATABASE_URL silently skipped the loop safety proof. Registered LAST and
 * with NO beforeAll dependency, so even if the main describe's setup throws-and-skips, `securityTestsRan`
 * stays 0 and THIS test FAILS — a skipped security file can never read as a passing (green) file in CI.
 * A local dev with no DB and no CI/opt-in still skips ergonomically (the assertion is a no-op there).
 *
 * RED/GREEN: simulate CI-without-DATABASE_URL (CI=true, DATABASE_URL unset) and this test goes RED
 * (securityTestsRan===0 while dbRequired===true); with DATABASE_URL present it runs all 5 and stays GREEN.
 */
describe('auto-persist LOOP — ran-guard (the security proof must not silently skip in CI)', () => {
  it('the loop runtime-safety tests ACTUALLY RAN when the DB is required (CI / opt-in)', () => {
    if (dbRequired) {
      // DB-required context: all five loop safety tests MUST have run. A 0 here means the DB-backed
      // suite was skipped (lost DATABASE_URL) — fail loudly rather than false-green.
      expect(securityTestsRan).toBe(5);
    } else {
      // Local dev without CI/opt-in: an ergonomic skip is allowed. Nothing to assert; document it.
      expect(dbRequired).toBe(false);
    }
  });
});
