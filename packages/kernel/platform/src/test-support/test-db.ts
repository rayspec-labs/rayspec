/**
 * Test-only Postgres helper for the run-core suite.
 *
 * Connects to DATABASE_URL (loaded from the repo .env) and (re)creates the three run
 * tables in their CURRENT shape so the DB-backed run-core tests are deterministic and
 * independent of whatever the throwaway spike data left behind.
 *
 * NOTE: this file is excluded from the package build (it is test support, not shipped
 * code). The canonical schema is packages/db/src/schema.ts; this DDL mirrors it for an
 * isolated, dependency-free test schema and is updated alongside the schema retrofit.
 */
import { forTenant } from '@rayspec/db';
// Raw-handle factory lives on the test/bootstrap subpath, NOT the main surface, so request
// code cannot import it. This is test-support, so reaching for it here is legitimate.
import { makeDbWithSchema } from '@rayspec/db/testing';

export { forTenant };

// Dedicated Postgres schema so this suite is ISOLATED from the db package's DB-backed tests
// when turbo runs them in parallel against the same DATABASE_URL (they otherwise collide on
// the shared public.journal_steps/orgs/runs tables).
const TEST_SCHEMA = 'rayspec_test_platform';

export function testDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required for run-core DB tests');
  return url;
}

export function makeTestDb() {
  return makeDbWithSchema(testDatabaseUrl(), TEST_SCHEMA);
}

/**
 * Create an isolated schema + (re)create the run tables in it (tenant_id uuid
 * + orgs FK + the UNIQUE(tenant_id, run_id, idempotency_key) replay index). A throwaway `orgs`
 * table is created so the FK resolves; the run-core tests seed the org rows they reference.
 */
export async function resetRunSchema(db: ReturnType<typeof makeTestDb>): Promise<void> {
  await db.$client.unsafe(`
    DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE;
    CREATE SCHEMA ${TEST_SCHEMA};
    SET search_path TO ${TEST_SCHEMA};

    CREATE TABLE orgs (
      id uuid PRIMARY KEY,
      name text,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE journal_steps (
      step_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      run_id text NOT NULL,
      tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      backend text NOT NULL,
      type text NOT NULL,
      idempotency_key text NOT NULL,
      input_hash text NOT NULL,
      output jsonb,
      input_tokens numeric NOT NULL DEFAULT '0',
      output_tokens numeric NOT NULL DEFAULT '0',
      total_tokens numeric NOT NULL DEFAULT '0',
      cost_usd numeric NOT NULL DEFAULT '0',
      -- cost reconciliation + provenance columns (mirrors migration 0005).
      provider_cost_usd numeric,
      billed_cost_usd numeric NOT NULL DEFAULT '0',
      cost_drift boolean NOT NULL DEFAULT false,
      produced_by text,
      pricing_version text,
      latency_ms numeric NOT NULL DEFAULT '0',
      status text NOT NULL,
      auth_mode text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX journal_run_idx ON journal_steps (run_id);
    CREATE INDEX journal_tenant_idx ON journal_steps (tenant_id);
    CREATE UNIQUE INDEX journal_idem_idx ON journal_steps (tenant_id, run_id, idempotency_key);

    -- idempotency_keys: the tenant-scoped replay/dedup store (mirrors schema.ts). The taint path writes the
    -- non-idempotent-taint marker here (scope='run_taint'), so run-core's chokepoint marker write needs
    -- this core table to exist — a real deployment always has it (the test schema must mirror that).
    CREATE TABLE idempotency_keys (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      scope text NOT NULL, idem_key text NOT NULL, body_hash text NOT NULL, snapshot jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX idem_tenant_scope_key_idx ON idempotency_keys (tenant_id, scope, idem_key);

    CREATE TABLE conversation_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      run_id text NOT NULL,
      tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      seq numeric NOT NULL,
      -- ConvPart columns (mirrors migration 0003): one row per part, payload jsonb.
      turn_index numeric,
      role text NOT NULL,
      kind text,
      tool_call_id text,
      payload jsonb,
      name text,
      content text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX conv_run_idx ON conversation_items (run_id);
    CREATE INDEX conv_tenant_idx ON conversation_items (tenant_id);

    CREATE TABLE runs (
      run_id text PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      backend text NOT NULL,
      auth_mode text NOT NULL,
      agent_name text NOT NULL,
      model text NOT NULL,
      status text NOT NULL,
      final_text text,
      output jsonb,
      cost_usd numeric NOT NULL DEFAULT '0',
      -- run-level cost roll-up columns (mirrors migration 0005).
      provider_cost_usd numeric,
      billed_cost_usd numeric NOT NULL DEFAULT '0',
      cost_drift boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    -- run_events: the durable, resumable per-run event log (mirrors migration 0004).
    CREATE TABLE run_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      run_id text NOT NULL,
      tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      seq numeric NOT NULL,
      type text NOT NULL,
      data jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX run_events_run_seq_idx ON run_events (run_id, seq);
    CREATE UNIQUE INDEX run_events_tenant_run_seq_idx ON run_events (tenant_id, run_id, seq);
  `);
}

/** Two fixed tenant org ids used across the cross-tenant tests. */
export const TENANT_A = '00000000-0000-0000-0000-00000000000a';
export const TENANT_B = '00000000-0000-0000-0000-00000000000b';

export async function seedOrgs(db: ReturnType<typeof makeTestDb>, ...ids: string[]): Promise<void> {
  for (const id of ids) {
    await db.$client.unsafe('INSERT INTO orgs (id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
      id,
      `org-${id.slice(-4)}`,
    ]);
  }
}
