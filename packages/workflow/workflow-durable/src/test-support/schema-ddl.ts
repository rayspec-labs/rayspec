/**
 * Minimal isolated-schema DDL for the workflow-durable DB-backed tests — the workflow journal
 * tables + the agent-node's runAgent spine tables (runs/journal_steps/conversation_items/run_events/
 * idempotency_keys) + their `orgs` FK target. Mirrors the committed schema.ts shape (kept LOCAL so the
 * test is self-contained, like durable-dbos's buildSpineSchemaSql).
 *
 * The pool's startup `search_path = '<schema>, public'` (makeDbWithSchema) resolves the unqualified
 * CREATEs to <schema> on every connection — NO bare `SET search_path`.
 */
export function buildWorkflowDurableSchemaSql(schema: string): string {
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

  -- workflow journal ------------------------------------------------------------------------------
  CREATE TABLE workflow_runs (
    workflow_run_id text PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    workflow_id text NOT NULL, idempotency_key text NOT NULL, trigger_event text NOT NULL,
    input_event jsonb NOT NULL, status text NOT NULL, resumable boolean NOT NULL DEFAULT false,
    error jsonb, attempts numeric NOT NULL DEFAULT '0',
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX workflow_runs_tenant_idx ON workflow_runs (tenant_id);
  CREATE UNIQUE INDEX workflow_runs_tenant_wf_idem_idx ON workflow_runs (tenant_id, workflow_id, idempotency_key);

  CREATE TABLE workflow_node_states (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    workflow_run_id text NOT NULL, node_id text NOT NULL, position numeric NOT NULL DEFAULT '0',
    capability text NOT NULL, operation text NOT NULL, status text NOT NULL,
    attempts jsonb NOT NULL DEFAULT '[]'::jsonb, attempt_count numeric NOT NULL DEFAULT '0',
    artifact_refs jsonb NOT NULL DEFAULT '[]'::jsonb, output jsonb, error jsonb,
    skipped_reason text, produced_by text, cost_usd numeric NOT NULL DEFAULT '0',
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX workflow_node_states_tenant_idx ON workflow_node_states (tenant_id);
  CREATE INDEX workflow_node_states_run_idx ON workflow_node_states (workflow_run_id);
  CREATE UNIQUE INDEX workflow_node_states_run_node_idx ON workflow_node_states (tenant_id, workflow_run_id, node_id);

  CREATE TABLE workflow_artifacts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    artifact_id text NOT NULL, workflow_run_id text, kind text NOT NULL,
    namespace text NOT NULL, scope text NOT NULL, content_hash text NOT NULL,
    version numeric NOT NULL DEFAULT '1', content jsonb NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX workflow_artifacts_tenant_idx ON workflow_artifacts (tenant_id);
  CREATE UNIQUE INDEX workflow_artifacts_tenant_artifact_idx ON workflow_artifacts (tenant_id, artifact_id);
`;
}
