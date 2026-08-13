-- workforce_task_engine: the durable task engine's nine tenant-scoped tables — tasks, the
-- append-only transition log, wake signals, delegations, approvals, reviews, messages, the budget
-- ledger, and the per-workforce runtime/control row.
--
-- REVIEWED: generated with `drizzle-kit generate` against the current snapshot and read
-- statement-by-statement before committing (the mandated generate → read the SQL diff → correct
-- discipline). The generated diff was CLEAN — nine new tables, their tenant FKs and their declared
-- indexes, nothing else — so it is committed as generated, with this header added and the journal
-- tag renamed to a descriptive one.
--
-- Purely ADDITIVE: nine new tables, no ALTER of an existing table, no data migration, no lock on a
-- hot table. Created unconditionally: the tables exist whether or not any deployment uses the task
-- engine — nine empty tables cost an existing deployment nothing, while conditional DDL keyed on
-- configuration is a class of production bug. Rolling the binary back is safe: older releases never
-- read these tables, and additive DDL ships no down-migration.
-- DESTRUCTIVE-SCAN: only CREATE TABLE / ADD CONSTRAINT / CREATE INDEX — no destructive statement,
-- so the destructive scan has no findings and needs no allowlist entry.
--
-- workforce_tasks — ONE row per durable task. `status` is a closed nine-value set whose only writer
--   is `applyTransition()` (@rayspec/tasks); `version` is the compare-and-swap token every
--   transition presents, so racing schedulers serialize on one UPDATE. `last_event_seq` is the
--   task's journal seq HEAD (the tenant_event_streams.last_seq pattern): allocation order equals
--   commit order because the counter UPDATE's row lock is held to COMMIT. The
--   (tenant_id, status, priority, queued_at) index is the scheduler's reserve scan.
--
-- workforce_task_transitions — APPEND-ONLY transition log written in the same transaction as the
--   status UPDATE. The partial UNIQUE (tenant_id, task_id, turn_number) is a turn's idempotency
--   receipt: a recovered turn workflow whose final transaction already committed finds its receipt
--   and no-ops instead of applying its intents twice.
--
-- workforce_task_signals — wake signals; resume is a ROW, not a process. UNIQUE
--   (tenant_id, task_id, signal_key) makes delivery idempotent.
--
-- workforce_delegations — one record per parent→child hand-off, written with the child row and the
--   parent transition in one transaction. UNIQUE (tenant_id, child_task_id): one opening delegation
--   per child, so a re-executed fan-out collides and no-ops.
--
-- workforce_approvals — approval requests with an ENFORCED timeout fate (`on_timeout`), swept by
--   the scheduler; a hung approval never waits silently.
--
-- workforce_reviews / workforce_messages — review rounds (the maxReviewRounds ceiling input) and
--   task-scoped messages (context DATA, never instructions).
--
-- workforce_budget_ledger — reservations/settlements per (scope_kind, scope_id, window_start);
--   the UNIQUE scope key is both the upsert conflict target and the row-lock identity of the
--   authorize/settle protocol.
--
-- workforce_runtime — ONE row per workforce: the operator pause/halt state (deliberately a flag
--   here, not a tenth task status) and the declared ceilings the ledger enforces.
--
-- All nine carry `tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE`, so an org delete
-- takes the tenant's whole task graph with it, and all nine are registered in TENANT_SCOPED_TABLES
-- so the chokepoint auto-injects the predicate.
CREATE TABLE "workforce_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"task_id" text NOT NULL,
	"question" text NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approver" text NOT NULL,
	"status" text NOT NULL,
	"decision" text,
	"decided_by" text,
	"reason" text,
	"timeout_at" timestamp with time zone,
	"on_timeout" text NOT NULL,
	"escalate_to" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workforce_budget_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_id" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"reserved_usd" numeric DEFAULT '0' NOT NULL,
	"settled_usd" numeric DEFAULT '0' NOT NULL,
	"settled_turns" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workforce_delegations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workforce_id" text,
	"parent_task_id" text NOT NULL,
	"child_task_id" text NOT NULL,
	"delegated_by" text NOT NULL,
	"delegated_to" text NOT NULL,
	"resolved_owner" text NOT NULL,
	"goal" text NOT NULL,
	"expected_output" text NOT NULL,
	"depth" integer NOT NULL,
	"status" text NOT NULL,
	"rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workforce_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"task_id" text NOT NULL,
	"sender" text NOT NULL,
	"recipient" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workforce_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"task_id" text NOT NULL,
	"reviewer" text NOT NULL,
	"round" integer NOT NULL,
	"verdict" text,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"required_changes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workforce_runtime" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workforce_id" text NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"paused_at" timestamp with time zone,
	"paused_by" text,
	"halt_reason" text,
	"halted_at" timestamp with time zone,
	"budgets" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_event_seq" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workforce_task_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"task_id" text NOT NULL,
	"kind" text NOT NULL,
	"signal_key" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workforce_task_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"task_id" text NOT NULL,
	"from_status" text NOT NULL,
	"to_status" text NOT NULL,
	"status_reason" text,
	"actor" text NOT NULL,
	"turn_id" text,
	"turn_number" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workforce_tasks" (
	"task_id" text PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workforce_id" text,
	"parent_task_id" text,
	"root_task_id" text NOT NULL,
	"ancestry_path" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"title" text NOT NULL,
	"goal" text NOT NULL,
	"description" text,
	"owner" text NOT NULL,
	"requested_by" text NOT NULL,
	"department" text,
	"status" text NOT NULL,
	"status_reason" text,
	"priority" text DEFAULT 'normal' NOT NULL,
	"dependencies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"join_policy" jsonb,
	"artifacts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"result" jsonb,
	"confidence" numeric,
	"cost_usd" numeric DEFAULT '0' NOT NULL,
	"token_usage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"turns_used" integer DEFAULT 0 NOT NULL,
	"last_event_seq" integer DEFAULT 0 NOT NULL,
	"deadline_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"queued_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workforce_approvals" ADD CONSTRAINT "workforce_approvals_tenant_id_orgs_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_budget_ledger" ADD CONSTRAINT "workforce_budget_ledger_tenant_id_orgs_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_delegations" ADD CONSTRAINT "workforce_delegations_tenant_id_orgs_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_messages" ADD CONSTRAINT "workforce_messages_tenant_id_orgs_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_reviews" ADD CONSTRAINT "workforce_reviews_tenant_id_orgs_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_runtime" ADD CONSTRAINT "workforce_runtime_tenant_id_orgs_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_task_signals" ADD CONSTRAINT "workforce_task_signals_tenant_id_orgs_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_task_transitions" ADD CONSTRAINT "workforce_task_transitions_tenant_id_orgs_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_tasks" ADD CONSTRAINT "workforce_tasks_tenant_id_orgs_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workforce_approvals_tenant_status_idx" ON "workforce_approvals" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "workforce_approvals_tenant_timeout_idx" ON "workforce_approvals" USING btree ("tenant_id","timeout_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workforce_ledger_scope_idx" ON "workforce_budget_ledger" USING btree ("tenant_id","scope_kind","scope_id","window_start");--> statement-breakpoint
CREATE INDEX "workforce_delegations_tenant_parent_idx" ON "workforce_delegations" USING btree ("tenant_id","parent_task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workforce_delegations_tenant_child_idx" ON "workforce_delegations" USING btree ("tenant_id","child_task_id");--> statement-breakpoint
CREATE INDEX "workforce_messages_tenant_task_created_idx" ON "workforce_messages" USING btree ("tenant_id","task_id","created_at");--> statement-breakpoint
CREATE INDEX "workforce_reviews_tenant_task_idx" ON "workforce_reviews" USING btree ("tenant_id","task_id","round");--> statement-breakpoint
CREATE UNIQUE INDEX "workforce_runtime_tenant_workforce_idx" ON "workforce_runtime" USING btree ("tenant_id","workforce_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workforce_signals_tenant_task_key_idx" ON "workforce_task_signals" USING btree ("tenant_id","task_id","signal_key");--> statement-breakpoint
CREATE INDEX "workforce_transitions_tenant_task_created_idx" ON "workforce_task_transitions" USING btree ("tenant_id","task_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workforce_transitions_turn_receipt_idx" ON "workforce_task_transitions" USING btree ("tenant_id","task_id","turn_number") WHERE "workforce_task_transitions"."turn_number" is not null;--> statement-breakpoint
CREATE INDEX "workforce_tasks_tenant_status_priority_queued_idx" ON "workforce_tasks" USING btree ("tenant_id","status","priority","queued_at");--> statement-breakpoint
CREATE INDEX "workforce_tasks_tenant_root_idx" ON "workforce_tasks" USING btree ("tenant_id","root_task_id");--> statement-breakpoint
CREATE INDEX "workforce_tasks_tenant_parent_idx" ON "workforce_tasks" USING btree ("tenant_id","parent_task_id");