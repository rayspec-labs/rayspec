/**
 * Minimal isolated-schema DDL for the durable-dbos spine integration test — the core tenant tables
 * `runAgent` (+ the started-once guard) write to, plus their `orgs` FK target. Mirrors the committed
 * schema.ts shape (the same columns the api-auth harness creates); kept LOCAL to this package so the
 * DBOS spine test is self-contained (no api-auth test-support dependency).
 *
 * The pool's startup `search_path = '<schema>, public'` (makeDbWithSchema) resolves the unqualified
 * CREATEs to <schema> on every connection — NO bare `SET search_path` (it would drop `, public` and
 * persist on the pooled connection → a heterogeneous pool / intermittent relation-not-found).
 */
export function buildSpineSchemaSql(schema: string): string {
  return `
  DROP SCHEMA IF EXISTS ${schema} CASCADE;
  CREATE SCHEMA ${schema};

  CREATE TABLE orgs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL, slug text NOT NULL,
    region text NOT NULL DEFAULT 'eu', retention_days integer, external_idp_id text,
    created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
  );

  CREATE TABLE idempotency_keys (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    scope text NOT NULL, idem_key text NOT NULL, body_hash text NOT NULL, snapshot jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX idem_tenant_scope_key_idx ON idempotency_keys (tenant_id, scope, idem_key);

  CREATE TABLE journal_steps (
    step_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id text NOT NULL,
    tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    backend text NOT NULL, type text NOT NULL, idempotency_key text NOT NULL,
    input_hash text NOT NULL, output jsonb,
    input_tokens numeric NOT NULL DEFAULT '0', output_tokens numeric NOT NULL DEFAULT '0',
    total_tokens numeric NOT NULL DEFAULT '0', cost_usd numeric NOT NULL DEFAULT '0',
    provider_cost_usd numeric, billed_cost_usd numeric NOT NULL DEFAULT '0',
    cost_drift boolean NOT NULL DEFAULT false, produced_by text, pricing_version text,
    latency_ms numeric NOT NULL DEFAULT '0', status text NOT NULL, auth_mode text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX journal_idem_idx ON journal_steps (tenant_id, run_id, idempotency_key);

  CREATE TABLE conversation_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id text NOT NULL,
    tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    seq numeric NOT NULL, role text NOT NULL,
    turn_index numeric, kind text, tool_call_id text, payload jsonb,
    name text, content text,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE runs (
    run_id text PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    backend text NOT NULL, auth_mode text NOT NULL, agent_name text NOT NULL,
    model text NOT NULL, status text NOT NULL, final_text text, output jsonb,
    cost_usd numeric NOT NULL DEFAULT '0',
    provider_cost_usd numeric, billed_cost_usd numeric NOT NULL DEFAULT '0',
    cost_drift boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE run_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id text NOT NULL,
    tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    seq numeric NOT NULL, type text NOT NULL, data jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX run_events_run_seq_idx ON run_events (run_id, seq);
  CREATE UNIQUE INDEX run_events_tenant_run_seq_idx ON run_events (tenant_id, run_id, seq);
`;
}

/**
 * The `cron_marks` PRODUCT table DDL for the cron-scheduler test's HANDLER action. A
 * trigger handler writes a row here so the test proves the handler ran inside the tenant tx (GUC set)
 * and exactly once. The injected tenancy/GDPR columns MATCH what `buildProductTables` emits for a
 * `StoreSpec` (id/tenant_id/created_at/deleted_at/retention_days/region/created_by/idempotency_key) so the test's `PgTable`
 * (built by `buildProductTables`) lines up with this schema. ONE business column `(note text)`.
 * `IF NOT EXISTS` so it composes onto the spine schema without re-dropping it.
 */
export function buildCronProductSchemaSql(schema: string): string {
  return `
  CREATE TABLE IF NOT EXISTS ${schema}.cron_marks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES ${schema}.orgs(id) ON DELETE CASCADE,
    note text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz, retention_days integer, region text NOT NULL DEFAULT 'eu', created_by text, idempotency_key text
  );
`;
}
