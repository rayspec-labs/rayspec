import { injectedColumnLinesSql } from '@rayspec/db/testing';

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
    latency_ms numeric NOT NULL DEFAULT '0', status text NOT NULL,
    -- error classification + retry advice columns (mirrors migration 0010).
    error_class text, retry_after_ms numeric,
    auth_mode text NOT NULL,
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
  const { before, after } = injectedColumnLinesSql({
    tenantFkRef: `REFERENCES ${schema}.orgs(id) ON DELETE CASCADE`,
  });
  return `
  CREATE TABLE IF NOT EXISTS ${schema}.cron_marks (
    ${before},
    note text NOT NULL,
    ${after}
  );
`;
}

/**
 * The task-engine tables for the task-scheduler integration test (mirrors migration 0012), composed
 * onto the spine schema with `IF NOT EXISTS` (the spine provides `orgs` + `run_events`, which the
 * engine's journal writer appends to).
 */
export function buildWorkforceSchemaSql(schema: string): string {
  return `
  CREATE TABLE IF NOT EXISTS ${schema}.workforce_tasks (
    task_id text PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES ${schema}.orgs(id) ON DELETE CASCADE,
    workforce_id text, parent_task_id text, root_task_id text NOT NULL,
    ancestry_path jsonb NOT NULL DEFAULT '[]'::jsonb,
    title text, goal text, description text,
    owner text NOT NULL, requested_by text NOT NULL, department text,
    status text NOT NULL, status_reason text, priority text NOT NULL DEFAULT 'normal',
    dependencies jsonb NOT NULL DEFAULT '[]'::jsonb, join_policy jsonb,
    artifacts jsonb NOT NULL DEFAULT '[]'::jsonb, result jsonb, confidence numeric,
    cost_usd numeric NOT NULL DEFAULT '0', token_usage jsonb NOT NULL DEFAULT '{}'::jsonb,
    turns_used integer NOT NULL DEFAULT 0, last_event_seq integer NOT NULL DEFAULT 0,
    deadline_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
    queued_at timestamptz, started_at timestamptz, completed_at timestamptz,
    claim_expires_at timestamptz,
    version integer NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS workforce_tasks_tenant_status_priority_queued_idx
    ON ${schema}.workforce_tasks (tenant_id, status, priority, queued_at);

  CREATE TABLE IF NOT EXISTS ${schema}.workforce_task_transitions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES ${schema}.orgs(id) ON DELETE CASCADE,
    task_id text NOT NULL, from_status text NOT NULL, to_status text NOT NULL,
    status_reason text, actor text NOT NULL, turn_id text, turn_number integer,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS workforce_transitions_turn_receipt_idx
    ON ${schema}.workforce_task_transitions (tenant_id, task_id, turn_number)
    WHERE turn_number IS NOT NULL;

  CREATE TABLE IF NOT EXISTS ${schema}.workforce_task_signals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES ${schema}.orgs(id) ON DELETE CASCADE,
    task_id text NOT NULL, kind text NOT NULL, signal_key text NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb, consumed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS workforce_signals_tenant_task_key_idx
    ON ${schema}.workforce_task_signals (tenant_id, task_id, signal_key);

  CREATE TABLE IF NOT EXISTS ${schema}.workforce_delegations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES ${schema}.orgs(id) ON DELETE CASCADE,
    workforce_id text, parent_task_id text NOT NULL, child_task_id text NOT NULL,
    delegated_by text NOT NULL, delegated_to text NOT NULL, resolved_owner text NOT NULL,
    goal text, expected_output text, depth integer NOT NULL,
    status text NOT NULL, rejection_reason text,
    created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
  );
  CREATE UNIQUE INDEX IF NOT EXISTS workforce_delegations_tenant_child_idx
    ON ${schema}.workforce_delegations (tenant_id, child_task_id);

  CREATE TABLE IF NOT EXISTS ${schema}.workforce_approvals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES ${schema}.orgs(id) ON DELETE CASCADE,
    task_id text NOT NULL, question text,
    options jsonb NOT NULL DEFAULT '[]'::jsonb, approver text NOT NULL,
    status text NOT NULL, decision text, decided_by text, reason text,
    timeout_at timestamptz, on_timeout text NOT NULL, escalate_to text, turn_number integer,
    created_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz
  );
  CREATE UNIQUE INDEX IF NOT EXISTS workforce_approvals_turn_receipt_idx
    ON ${schema}.workforce_approvals (tenant_id, task_id, turn_number)
    WHERE turn_number IS NOT NULL;

  CREATE TABLE IF NOT EXISTS ${schema}.workforce_reviews (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES ${schema}.orgs(id) ON DELETE CASCADE,
    task_id text NOT NULL, reviewer text NOT NULL, round integer NOT NULL,
    verdict text, reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
    required_changes jsonb NOT NULL DEFAULT '[]'::jsonb, turn_number integer,
    created_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz
  );
  CREATE UNIQUE INDEX IF NOT EXISTS workforce_reviews_turn_receipt_idx
    ON ${schema}.workforce_reviews (tenant_id, task_id, turn_number)
    WHERE turn_number IS NOT NULL;

  CREATE TABLE IF NOT EXISTS ${schema}.workforce_messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES ${schema}.orgs(id) ON DELETE CASCADE,
    task_id text NOT NULL, sender text NOT NULL, recipient text NOT NULL, body text,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS ${schema}.workforce_budget_ledger (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES ${schema}.orgs(id) ON DELETE CASCADE,
    scope_kind text NOT NULL, scope_id text NOT NULL, window_start timestamptz NOT NULL,
    reserved_usd numeric NOT NULL DEFAULT '0', settled_usd numeric NOT NULL DEFAULT '0',
    settled_turns integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS workforce_ledger_scope_idx
    ON ${schema}.workforce_budget_ledger (tenant_id, scope_kind, scope_id, window_start);

  CREATE TABLE IF NOT EXISTS ${schema}.workforce_runtime (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES ${schema}.orgs(id) ON DELETE CASCADE,
    workforce_id text NOT NULL, paused boolean NOT NULL DEFAULT false,
    paused_at timestamptz, paused_by text, halt_reason text, halted_at timestamptz,
    budgets jsonb NOT NULL DEFAULT '{}'::jsonb, last_event_seq integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS workforce_runtime_tenant_workforce_idx
    ON ${schema}.workforce_runtime (tenant_id, workforce_id);
`;
}
