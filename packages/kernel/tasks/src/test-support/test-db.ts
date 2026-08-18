/**
 * Test-only Postgres helper for the task-engine db-backed suites.
 *
 * Connects to DATABASE_URL (loaded from the repo .env) and (re)creates the task-engine tables in
 * their CURRENT shape inside a dedicated schema, so these suites are deterministic and isolated
 * from the db/platform/api-auth suites when turbo runs them against the same local Postgres.
 *
 * NOTE: exported via the `@rayspec/tasks/test-support` subpath (never the main barrel) so the
 * db-backed suites of the layers ABOVE the engine — the boot wiring included — can drive exactly
 * the rows the engine writes. The canonical schema is packages/kernel/db/src/schema.ts; this DDL
 * mirrors migration 0012 plus the orgs root, the agent-run tables a dispatched turn journals into,
 * and run_events (the journal stream the engine appends
 * to).
 */
import { randomUUID } from 'node:crypto';
import { forTenant } from '@rayspec/db';
// Raw-handle factory lives on the test/bootstrap subpath, NOT the main surface, so request
// code cannot import it. This is test-support, so reaching for it here is legitimate.
import { makeDbWithSchema } from '@rayspec/db/testing';

export { forTenant };

const TEST_SCHEMA = 'rayspec_test_tasks';

export function testDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required for task-engine DB tests');
  return url;
}

export function makeTestDb() {
  return makeDbWithSchema(testDatabaseUrl(), TEST_SCHEMA);
}

export const TENANT_A = '00000000-0000-4000-8000-00000000000a';
export const TENANT_B = '00000000-0000-4000-8000-00000000000b';

export async function seedOrgs(db: ReturnType<typeof makeTestDb>): Promise<void> {
  await db.$client.unsafe(
    `INSERT INTO ${TEST_SCHEMA}.orgs (id, name) VALUES ('${TENANT_A}', 'Tenant A'), ('${TENANT_B}', 'Tenant B') ON CONFLICT DO NOTHING;`,
  );
}

/** A unique-per-call org so suites that seed their own tenant cannot collide across files. */
export async function seedFreshOrg(db: ReturnType<typeof makeTestDb>): Promise<string> {
  const id = randomUUID();
  await db.$client.unsafe(`INSERT INTO ${TEST_SCHEMA}.orgs (id, name) VALUES ('${id}', 'Org');`);
  return id;
}

export async function resetTaskSchema(db: ReturnType<typeof makeTestDb>): Promise<void> {
  await db.$client.unsafe(`
    DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE;
    CREATE SCHEMA ${TEST_SCHEMA};
    SET search_path TO ${TEST_SCHEMA};

    CREATE TABLE orgs (
      id uuid PRIMARY KEY,
      name text,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    -- The AGENT-RUN tables. A workforce turn IS an agent run: the composition calls runAgent,
    -- which writes a run header and journals every dispatched tool step. A suite that drives a
    -- turn end to end therefore needs these beside the workforce tables (mirrors 0001-0005/0010,
    -- the same DDL the platform suite's own helper carries).
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
      -- error classification + retry advice columns (mirrors migration 0010).
      error_class text,
      retry_after_ms numeric,
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

    -- run_events: the journal stream the engine appends task/workforce events to (mirrors 0004).
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

    -- The task-engine tables (mirrors migration 0012).
    CREATE TABLE workforce_tasks (
      task_id text PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
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
    CREATE INDEX workforce_tasks_tenant_status_priority_queued_idx
      ON workforce_tasks (tenant_id, status, priority, queued_at);
    CREATE INDEX workforce_tasks_tenant_root_idx ON workforce_tasks (tenant_id, root_task_id);
    CREATE INDEX workforce_tasks_tenant_parent_idx ON workforce_tasks (tenant_id, parent_task_id);

    CREATE TABLE workforce_task_transitions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      task_id text NOT NULL, from_status text NOT NULL, to_status text NOT NULL,
      status_reason text, actor text NOT NULL, turn_id text, turn_number integer,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX workforce_transitions_tenant_task_created_idx
      ON workforce_task_transitions (tenant_id, task_id, created_at);
    CREATE UNIQUE INDEX workforce_transitions_turn_receipt_idx
      ON workforce_task_transitions (tenant_id, task_id, turn_number) WHERE turn_number IS NOT NULL;

    CREATE TABLE workforce_task_signals (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      task_id text NOT NULL, kind text NOT NULL, signal_key text NOT NULL,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb, consumed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX workforce_signals_tenant_task_key_idx
      ON workforce_task_signals (tenant_id, task_id, signal_key);

    CREATE TABLE workforce_delegations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      workforce_id text, parent_task_id text NOT NULL, child_task_id text NOT NULL,
      delegated_by text NOT NULL, delegated_to text NOT NULL, resolved_owner text NOT NULL,
      goal text, expected_output text, depth integer NOT NULL,
      status text NOT NULL, rejection_reason text,
      created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
    );
    CREATE INDEX workforce_delegations_tenant_parent_idx
      ON workforce_delegations (tenant_id, parent_task_id);
    CREATE UNIQUE INDEX workforce_delegations_tenant_child_idx
      ON workforce_delegations (tenant_id, child_task_id);

    CREATE TABLE workforce_approvals (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      task_id text NOT NULL, question text,
      options jsonb NOT NULL DEFAULT '[]'::jsonb, approver text NOT NULL,
      status text NOT NULL, decision text, decided_by text, reason text,
      timeout_at timestamptz, on_timeout text NOT NULL, escalate_to text, turn_number integer,
      created_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz
    );
    CREATE INDEX workforce_approvals_tenant_status_idx ON workforce_approvals (tenant_id, status);
    CREATE INDEX workforce_approvals_tenant_timeout_idx ON workforce_approvals (tenant_id, timeout_at);
    CREATE UNIQUE INDEX workforce_approvals_turn_receipt_idx
      ON workforce_approvals (tenant_id, task_id, turn_number) WHERE turn_number IS NOT NULL;

    CREATE TABLE workforce_reviews (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      task_id text NOT NULL, reviewer text NOT NULL, round integer NOT NULL,
      verdict text, reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
      required_changes jsonb NOT NULL DEFAULT '[]'::jsonb, turn_number integer,
      created_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz
    );
    CREATE INDEX workforce_reviews_tenant_task_idx ON workforce_reviews (tenant_id, task_id, round);
    CREATE UNIQUE INDEX workforce_reviews_turn_receipt_idx
      ON workforce_reviews (tenant_id, task_id, turn_number) WHERE turn_number IS NOT NULL;

    CREATE TABLE workforce_messages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      task_id text NOT NULL, sender text NOT NULL, recipient text NOT NULL, body text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX workforce_messages_tenant_task_created_idx
      ON workforce_messages (tenant_id, task_id, created_at);

    CREATE TABLE workforce_budget_ledger (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      scope_kind text NOT NULL, scope_id text NOT NULL, window_start timestamptz NOT NULL,
      reserved_usd numeric NOT NULL DEFAULT '0', settled_usd numeric NOT NULL DEFAULT '0',
      settled_turns integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX workforce_ledger_scope_idx
      ON workforce_budget_ledger (tenant_id, scope_kind, scope_id, window_start);

    CREATE TABLE workforce_runtime (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      workforce_id text NOT NULL, paused boolean NOT NULL DEFAULT false,
      paused_at timestamptz, paused_by text, halt_reason text, halted_at timestamptz,
      budgets jsonb NOT NULL DEFAULT '{}'::jsonb, last_event_seq integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX workforce_runtime_tenant_workforce_idx
      ON workforce_runtime (tenant_id, workforce_id);
  `);
}
