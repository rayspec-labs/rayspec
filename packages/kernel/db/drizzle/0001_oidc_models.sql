-- node-oidc-provider model store (GLOBAL / predicate-exempt by design).
--
-- REVIEWED, hand-authored (never blind autogenerate). Purely ADDITIVE — one CREATE TABLE +
-- three lookup indexes; nothing destructive, so the home-grown destructive-scan has no findings.
--
-- This is the single largest predicate-exempt surface: OAuth artifacts
-- are isolated by token AUDIENCE + the client's org-bound payload, NOT a tenant_id column. The
-- cross-client OIDC isolation test + the full-surface OIDC matrix cover it.

CREATE TABLE "oidc_models" (
	"model" text NOT NULL,
	"id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"grant_id" text,
	"user_code" text,
	"uid" text,
	"consumed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oidc_models_model_id_pk" PRIMARY KEY("model","id")
);
--> statement-breakpoint
CREATE INDEX "oidc_grant_idx" ON "oidc_models" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "oidc_user_code_idx" ON "oidc_models" USING btree ("user_code");--> statement-breakpoint
CREATE INDEX "oidc_uid_idx" ON "oidc_models" USING btree ("uid");--> statement-breakpoint

-- idempotency_keys — tenant-scoped Idempotency-Key replay store (additive; tenant_id FK cascade).
CREATE TABLE "idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"idem_key" text NOT NULL,
	"body_hash" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_tenant_id_orgs_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idem_tenant_scope_key_idx" ON "idempotency_keys" USING btree ("tenant_id","scope","idem_key");
