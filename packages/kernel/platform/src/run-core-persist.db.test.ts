/**
 * Output-persistence acceptance (DB-backed, fake backend — NO LLM).
 *
 * An agent action can declare a `persistTo` store: after a SUCCESSFUL run, the run's validated
 * `outputSchema` output is written as one row into that store, tenant-scoped, EXACTLY-ONCE across the
 * sync path AND a durable recovery RE-DISPATCH of the same runId. This suite proves both against ground
 * truth:
 *   1. the SYNC path writes the row (the auto-persist acceptance);
 *   2. a re-dispatch of the SAME runId writes the row EXACTLY ONCE — the fake reproduces the REAL
 *      constraint (the `runs` PK UNIQUE index + the completed-transition `setWhere` gate + the durable
 *      outer transaction), and the target store carries NO unique business column, so a naive persist
 *      would leave TWO rows. The returning-gate (only the call that WINS the completing transition
 *      persists) is the sole thing keeping it at one.
 *
 * Uses a DEDICATED schema (never `public`, never the shared platform test schema) per the per-suite
 * isolation discipline (false-green hazard). Skips when DATABASE_URL is absent; a ran-guard turns a
 * silent CI skip into a hard RED.
 */
import type { AgentSpec, AuthMode, Backend, RunContext, RunResult } from '@rayspec/core';
import { forTenant, INJECTED_COLUMN_NAMES, schema } from '@rayspec/db';
import {
  buildProductTables,
  injectedColumnLinesSql,
  makeDbWithSchema,
  parseCreateTableColumnNames,
  registerScopedTables,
} from '@rayspec/db/testing';
import type { StoreSpec } from '@rayspec/spec';
import { eq } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runAgent } from './run-core.js';

const SCHEMA = 'rayspec_test_persist';
const TENANT_A = '00000000-0000-0000-0000-0000000000f1';
const TENANT_B = '00000000-0000-0000-0000-0000000000f2';
const hasDb = Boolean(process.env.DATABASE_URL);

// Ran-guard (false-green hazard): this suite is the ONLY output-persist ground-truth proof. It
// skipIf(!hasDb)s so a credential-free dev run skips ergonomically — but a CI run that lost
// DATABASE_URL would SILENTLY skip the exactly-once proof and read green. Count the tests that actually
// RAN and (in a non-skipped describe) assert the count is non-zero whenever the DB is REQUIRED.
let persistTestsRan = 0;
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';

/**
 * The persist target store. NO unique business column on purpose: a duplicate write would produce a
 * SECOND row (not a 23505), so the exactly-once guarantee is proven to come from the returning-gate, not
 * from a lucky unique index.
 */
const factsStore: StoreSpec = {
  name: 'extracted_facts',
  columns: [
    { name: 'title', type: 'text', nullable: false, unique: false },
    { name: 'score', type: 'integer', nullable: true, unique: false },
    { name: 'verified', type: 'boolean', nullable: true, unique: false },
    { name: 'details', type: 'jsonb', nullable: true, unique: false },
  ],
  foreignKeys: [],
};

/**
 * A SECOND persist target with a UNIQUE business column (`title`). Two DISTINCT runs producing the same
 * `title` value collide on the tenant-scoped `(tenant_id, title)` unique index (23505) — a runtime-data
 * constraint the doctor cannot see at deploy. Used to prove the atomic coupling: a colliding persist
 * rolls back the WHOLE run (header + persist) rather than leaving a completed run with no/duplicate row.
 */
const uniqueFactsStore: StoreSpec = {
  name: 'unique_facts',
  columns: [
    { name: 'title', type: 'text', nullable: false, unique: true },
    { name: 'score', type: 'integer', nullable: true, unique: false },
    { name: 'verified', type: 'boolean', nullable: true, unique: false },
    { name: 'details', type: 'jsonb', nullable: true, unique: false },
  ],
  foreignKeys: [],
};

/** The validated structured output a successful run produces (maps 1:1 to the store's columns). */
const OUTPUT = { title: 'Q3 review', score: 7, verified: true, details: { source: 'report' } };

/**
 * A fake backend that ALWAYS returns a COMPLETED run carrying `OUTPUT` as its structured output and
 * journals one ok step. Stateless across dispatches: a re-dispatch of the same runId re-runs it exactly
 * as the durable executor's recovery path does (replay=false, same runId).
 */
class PersistBackend implements Backend {
  readonly id = 'openai' as const;
  runs = 0;
  async resolveAuth(): Promise<AuthMode> {
    return 'api-key';
  }
  async run(spec: AgentSpec, ctx: RunContext): Promise<RunResult> {
    this.runs += 1;
    await ctx.journal.record({
      type: 'llm',
      idempotencyKey: `llm:${spec.name}`,
      inputHash: `hash:${spec.input}`,
      output: { finalText: 'done' },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      costUsd: 0,
      model: spec.model,
      latencyMs: 1,
      status: 'ok',
      authMode: 'api-key',
    });
    return {
      runId: ctx.runId,
      backend: this.id,
      authMode: 'api-key',
      status: 'completed',
      finalText: 'done',
      output: OUTPUT,
      error: null,
      errorClass: null,
      conversation: [{ role: 'assistant', index: 0, parts: [{ kind: 'text', text: 'done' }] }],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      costUsd: 0,
      stepCount: 1,
    };
  }
}

const spec: AgentSpec = {
  name: 'fact_extractor',
  instructions: 'extract facts',
  model: 'gpt-4o-mini',
  input: 'a transcript',
  tools: [],
  outputSchema: { name: 'Facts', schema: { type: 'object' } },
  maxTurns: 8,
};

function buildPersistSchemaSql(): string {
  const { before, after } = injectedColumnLinesSql({
    tenantFkRef: 'REFERENCES orgs(id) ON DELETE CASCADE',
  });
  return `
    DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;
    CREATE SCHEMA ${SCHEMA};
    SET search_path TO ${SCHEMA};
    CREATE TABLE orgs (id uuid PRIMARY KEY, name text, created_at timestamptz NOT NULL DEFAULT now());
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
    CREATE UNIQUE INDEX persist_journal_idem_idx ON journal_steps (tenant_id, run_id, idempotency_key);
    CREATE TABLE idempotency_keys (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      scope text NOT NULL, idem_key text NOT NULL, body_hash text NOT NULL, snapshot jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX persist_idem_idx ON idempotency_keys (tenant_id, scope, idem_key);
    CREATE TABLE conversation_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id text NOT NULL,
      tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, seq numeric NOT NULL,
      turn_index numeric, role text NOT NULL, kind text, tool_call_id text, payload jsonb,
      name text, content text, created_at timestamptz NOT NULL DEFAULT now()
    );
    -- runs: the run header. run_id is the PK (the UNIQUE index the completed-transition gate serializes on).
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
    CREATE UNIQUE INDEX persist_run_events_idx ON run_events (tenant_id, run_id, seq);
    -- the PRODUCT store the run persists into (with the injected tenancy/GDPR columns a real deploy adds).
    CREATE TABLE extracted_facts (
      ${before},
      title text NOT NULL, score integer, verified boolean, details jsonb,
      ${after}
    );
    -- a SECOND store with a UNIQUE business column — the tenant-scoped (tenant_id, title) unique index
    -- MATCHES what buildProductTables emits for a non-conflict-key unique column.
    CREATE TABLE unique_facts (
      ${before},
      title text NOT NULL, score integer, verified boolean, details jsonb,
      ${after}
    );
    CREATE UNIQUE INDEX unique_facts_title_unique ON unique_facts (tenant_id, title);
    INSERT INTO orgs (id, name) VALUES ('${TENANT_A}', 'A'), ('${TENANT_B}', 'B');
  `;
}

// Drift guard (no DB): the product table's CREATE TABLE must carry EXACTLY the injected columns ∪ its
// declared business columns — so a new injected column can never silently drift this fixture.
describe('output-persist schema — injected-column drift guard', () => {
  it('extracted_facts carries exactly the injected + its business columns', () => {
    const columns = new Set(
      parseCreateTableColumnNames(buildPersistSchemaSql(), 'extracted_facts'),
    );
    const expected = new Set([...INJECTED_COLUMN_NAMES, ...factsStore.columns.map((c) => c.name)]);
    expect(columns).toEqual(expected);
  });
});

describe.skipIf(!hasDb)('run-core output persistence (persistTo)', () => {
  let db: ReturnType<typeof makeDbWithSchema>;
  let productTables: Map<string, PgTable>;
  let unregister: () => void;

  beforeAll(async () => {
    db = makeDbWithSchema(process.env.DATABASE_URL as string, SCHEMA);
    await db.$client.unsafe(buildPersistSchemaSql());
    productTables = buildProductTables([factsStore, uniqueFactsStore]);
    unregister = registerScopedTables([...productTables.values()]);
  });

  afterAll(async () => {
    unregister?.();
    await db?.$client.end();
  });

  beforeEach(async () => {
    await db.$client.unsafe(
      `SET search_path TO ${SCHEMA};
       TRUNCATE journal_steps, conversation_items, run_events, runs, idempotency_keys, extracted_facts, unique_facts CASCADE;`,
    );
  });

  async function readFacts(tenant: string): Promise<Record<string, unknown>[]> {
    const facts = productTables.get('extracted_facts') as PgTable;
    return (await forTenant(db, tenant)
      .select(facts as never)
      .all()) as Record<string, unknown>[];
  }

  async function readUniqueFacts(tenant: string): Promise<Record<string, unknown>[]> {
    const facts = productTables.get('unique_facts') as PgTable;
    return (await forTenant(db, tenant)
      .select(facts as never)
      .all()) as Record<string, unknown>[];
  }

  it('SYNC: a successful run writes the validated output as a tenant-scoped row', async () => {
    persistTestsRan++;
    const tdb = forTenant(db, TENANT_A);
    const backend = new PersistBackend();

    const run = await runAgent(tdb, backend, spec, {
      persistTo: 'extracted_facts',
      productTables,
    });
    expect(run.status).toBe('completed');

    // The row LANDED (fail-the-fix: without the persist-write this is 0 rows).
    const rows = await readFacts(TENANT_A);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe('Q3 review');
    expect(Number(rows[0]?.score)).toBe(7);
    expect(rows[0]?.verified).toBe(true);
    expect(rows[0]?.details).toEqual({ source: 'report' });
    // Tenant-scoped: the write carries THIS tenant, and created_by is left unset (uniform sync+durable).
    expect(rows[0]?.tenantId).toBe(TENANT_A);
    expect(rows[0]?.createdBy ?? null).toBeNull();

    // Another tenant sees NOTHING (the persist is tenant-scoped through the chokepoint).
    expect(await readFacts(TENANT_B)).toHaveLength(0);
  });

  it('DURABLE re-dispatch: the persist row is written EXACTLY ONCE across a re-run of the same runId', async () => {
    persistTestsRan++;
    const backend = new PersistBackend();
    const runId = 'persist-redispatch-run';

    // Mirror the durable executor EXACTLY: each dispatch runs runAgent inside the run's outer
    // transaction (forTenant(db,tenant).transaction) under the SAME pre-minted runId, replay=false.
    const dispatch = () =>
      forTenant(db, TENANT_A).transaction((txTdb) =>
        runAgent(txTdb, backend, spec, { runId, persistTo: 'extracted_facts', productTables }),
      );

    const first = await dispatch();
    expect(first.status).toBe('completed');
    // The recovery RE-DISPATCH: the header is already 'completed', so the completing transition is LOST
    // (returning empty) → NO second persist. The backend runs both times (proving the gate, not a
    // no-op, is what stops the double write).
    const second = await dispatch();
    expect(second.status).toBe('completed');
    expect(backend.runs).toBe(2);

    // EXACTLY ONE row — the store has no unique business column, so a naive persist would leave TWO.
    const rows = await readFacts(TENANT_A);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe('Q3 review');
  });

  it('ATOMICITY: a persist that violates a UNIQUE business column rolls back the run header WITH the failed persist (winner intact, exactly one row, loser not completed)', async () => {
    persistTestsRan++;
    const backend = new PersistBackend();

    // Run A persists its row (title 'Q3 review') on the sync path — persistRunOutput opens its OWN
    // transaction (no outer tx), so the header-completing upsert + the store insert commit atomically.
    const a = await runAgent(forTenant(db, TENANT_A), backend, spec, {
      runId: 'unique-run-a',
      persistTo: 'unique_facts',
      productTables,
    });
    expect(a.status).toBe('completed');

    // Run B is a DISTINCT run producing the SAME OUTPUT.title. Its persist INSERT collides on the
    // tenant-scoped (tenant_id, title) unique index (23505) — a runtime-DATA constraint the doctor cannot
    // see at deploy. Because the header-completing upsert AND the store insert share ONE transaction, the
    // 23505 rolls BOTH back: run B throws fail-closed (never a completed header with a missing row).
    await expect(
      runAgent(forTenant(db, TENANT_A), backend, spec, {
        runId: 'unique-run-b',
        persistTo: 'unique_facts',
        productTables,
      }),
    ).rejects.toThrow();

    // The store holds EXACTLY ONE row — A's; B's colliding insert wrote nothing.
    const rows = await readUniqueFacts(TENANT_A);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe('Q3 review');

    // A's run header is completed; B has NO run header at all — its completing transition rolled back
    // atomically with the failed persist (the exactly-once, fail-closed property this coupling guarantees).
    const headerA = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.runId, 'unique-run-a'));
    expect(headerA[0]?.status).toBe('completed');
    const headerB = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.runId, 'unique-run-b'));
    expect(headerB).toHaveLength(0);
  });

  it('does NOT persist when persistTo is set but productTables is absent (inert, no throw)', async () => {
    persistTestsRan++;
    const tdb = forTenant(db, TENANT_A);
    const run = await runAgent(tdb, new PersistBackend(), spec, { persistTo: 'extracted_facts' });
    expect(run.status).toBe('completed');
    // No productTables ⇒ persistTo is inert (nothing written), and the run still completes normally.
    expect(await readFacts(TENANT_A)).toHaveLength(0);
    const header = await db.select().from(schema.runs).where(eq(schema.runs.runId, run.runId));
    expect(header).toHaveLength(1);
    expect(header[0]?.status).toBe('completed');
  });
});

// The un-skippable ran-guard: if the DB is REQUIRED (CI or the local-CI opt-in) but the suite above
// silently skipped (lost DATABASE_URL), FAIL LOUDLY rather than read a false green.
describe('output-persist ran-guard (no silent CI skip)', () => {
  it('ran the persist proofs when the DB is required', () => {
    if (dbRequired) expect(persistTestsRan).toBeGreaterThan(0);
    else expect(true).toBe(true);
  });
});
