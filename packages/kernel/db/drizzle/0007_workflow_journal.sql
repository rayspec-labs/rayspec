CREATE TABLE "workflow_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"artifact_id" text NOT NULL,
	"workflow_run_id" text,
	"kind" text NOT NULL,
	"namespace" text NOT NULL,
	"scope" text NOT NULL,
	"content_hash" text NOT NULL,
	"version" numeric DEFAULT '1' NOT NULL,
	"content" jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_node_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workflow_run_id" text NOT NULL,
	"node_id" text NOT NULL,
	"position" numeric DEFAULT '0' NOT NULL,
	"capability" text NOT NULL,
	"operation" text NOT NULL,
	"status" text NOT NULL,
	"attempts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attempt_count" numeric DEFAULT '0' NOT NULL,
	"artifact_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"output" jsonb,
	"error" jsonb,
	"skipped_reason" text,
	"produced_by" text,
	"cost_usd" numeric DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_runs" (
	"workflow_run_id" text PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workflow_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"trigger_event" text NOT NULL,
	"input_event" jsonb NOT NULL,
	"status" text NOT NULL,
	"resumable" boolean DEFAULT false NOT NULL,
	"error" jsonb,
	"attempts" numeric DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_artifacts" ADD CONSTRAINT "workflow_artifacts_tenant_id_orgs_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_node_states" ADD CONSTRAINT "workflow_node_states_tenant_id_orgs_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_tenant_id_orgs_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflow_artifacts_tenant_idx" ON "workflow_artifacts" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_artifacts_tenant_artifact_idx" ON "workflow_artifacts" USING btree ("tenant_id","artifact_id");--> statement-breakpoint
CREATE INDEX "workflow_node_states_tenant_idx" ON "workflow_node_states" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "workflow_node_states_run_idx" ON "workflow_node_states" USING btree ("workflow_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_node_states_run_node_idx" ON "workflow_node_states" USING btree ("tenant_id","workflow_run_id","node_id");--> statement-breakpoint
CREATE INDEX "workflow_runs_tenant_idx" ON "workflow_runs" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_runs_tenant_wf_idem_idx" ON "workflow_runs" USING btree ("tenant_id","workflow_id","idempotency_key");