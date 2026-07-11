-- Identity cluster + run-journal tenant FK retrofit.
--
-- REVIEWED, hand-authored migration (never blind autogenerate). It (a) bootstraps the three
-- run tables in their AUTHENTIC spike pre-state (b) creates the new identity tables and
-- (c) retrofits those three run tables from `tenant_id text` to
-- `tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE`.
--
-- GATE: this file is gated by the home-grown destructive SQL scan in src/migration-scan.ts —
-- NOT `atlas migrate lint`, which is Pro-gated since v0.38. The scan FLAGS the
-- TRUNCATE and the text->uuid `USING`-cast below; each requires an explicit, reasoned allowlist
-- entry (see migration-scan.allowlist.ts) — never a silent pass.
--
-- WHY TRUNCATE: the spike rows used arbitrary text `tenant_id`s; there are no real orgs to
-- backfill, and a text->uuid cast of those values would fail the FK. The journal data is
-- throwaway, so the three run tables are TRUNCATED rather than migrated.
--
-- ============================ self-bootstrapping 0000 ============================
-- This migration is a *retrofit*: the three run tables (runs/journal_steps/conversation_items) were
-- created by the spike OUTSIDE the migration system as `tenant_id text`, so the original 0000
-- assumed they already existed and FAILED to apply against a fresh, empty database (the TRUNCATE/
-- DROP INDEX/ALTER below hit `relation "journal_steps" does not exist`). No deploy ever ran the
-- chain (that was the bug), so this migration PREPENDS the three CREATE TABLEs in their EXACT authentic
-- pre-retrofit shape (tenant_id TEXT, the old (run_id, idempotency_key) journal_idem_idx, and the
-- conv_run_idx/conv_tenant_idx indexes) so the chain now bootstraps from EMPTY. The retrofit
-- statements that follow are unchanged: on a fresh DB the TRUNCATE is a no-op on zero rows, the
-- DROP INDEX removes the just-created (run_id, idempotency_key) index, and the text->uuid casts +
-- FK adds + UNIQUE re-key perform the real type change. Decision: SELF-CONTAINED 0000 (not a
-- squash) — it preserves the reviewed retrofit narrative + its TRUNCATE/text->uuid allowlist +
-- the migration-scan.test.ts coverage keyed to this filename, while making `drizzle-kit migrate`
-- succeed from empty AND leaving the end-state == schema.ts (verified by gate:migrate-clean).
-- The CREATE TABLE columns/types/defaults/indexes below mirror schema.ts (pre-retrofit) exactly.

-- ============================ run tables (authentic spike pre-state, tenant_id TEXT) ============================
CREATE TABLE "journal_steps" (
	"step_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"backend" text NOT NULL,
	"type" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"input_hash" text NOT NULL,
	"output" jsonb,
	"input_tokens" numeric DEFAULT '0' NOT NULL,
	"output_tokens" numeric DEFAULT '0' NOT NULL,
	"total_tokens" numeric DEFAULT '0' NOT NULL,
	"cost_usd" numeric DEFAULT '0' NOT NULL,
	"latency_ms" numeric DEFAULT '0' NOT NULL,
	"status" text NOT NULL,
	"auth_mode" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "journal_run_idx" ON "journal_steps" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "journal_tenant_idx" ON "journal_steps" USING btree ("tenant_id");--> statement-breakpoint
-- The OLD (run_id, idempotency_key) replay index — DROPPED + re-keyed on tenant by the retrofit below.
CREATE INDEX "journal_idem_idx" ON "journal_steps" USING btree ("run_id","idempotency_key");--> statement-breakpoint
CREATE TABLE "conversation_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"seq" numeric NOT NULL,
	"role" text NOT NULL,
	"name" text,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "conv_run_idx" ON "conversation_items" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "conv_tenant_idx" ON "conversation_items" USING btree ("tenant_id");--> statement-breakpoint
CREATE TABLE "runs" (
	"run_id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"backend" text NOT NULL,
	"auth_mode" text NOT NULL,
	"agent_name" text NOT NULL,
	"model" text NOT NULL,
	"status" text NOT NULL,
	"final_text" text,
	"output" jsonb,
	"cost_usd" numeric DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- ============================ identity cluster (new) ============================
CREATE TABLE "orgs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"region" text DEFAULT 'eu' NOT NULL,
	"retention_days" integer,
	"external_idp_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"email_verified_at" timestamp with time zone,
	"password_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"scim_provisioned" boolean DEFAULT false NOT NULL,
	"invited_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"current_org_id" uuid,
	"token_hash" text NOT NULL,
	"family_id" uuid NOT NULL,
	"rotated_at" timestamp with time zone,
	"replaced_by" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"ua" text,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"type" text DEFAULT 'api_key' NOT NULL,
	"key_prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"created_by" uuid,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "auth_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_org_id" uuid,
	"actor_user_id" uuid,
	"event" text NOT NULL,
	"request_id" text,
	"target_hash" text,
	"ip_hash" text,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- ============================ run-journal FK retrofit ============================
-- Throwaway journal data (arbitrary text tenant_ids): TRUNCATE before the type change so
-- the text->uuid cast cannot fail the new FK. ALLOWLISTED + reviewed (migration-scan.allowlist).
TRUNCATE TABLE "journal_steps", "conversation_items", "runs";--> statement-breakpoint

-- Replace the old (run_id, idempotency_key) replay index before re-keying it on tenant.
DROP INDEX IF EXISTS "journal_idem_idx";--> statement-breakpoint

-- text -> uuid type change (USING-cast). ALLOWLISTED + reviewed; safe because the tables were
-- truncated immediately above (no rows to cast).
ALTER TABLE "journal_steps" ALTER COLUMN "tenant_id" TYPE uuid USING "tenant_id"::uuid;--> statement-breakpoint
ALTER TABLE "conversation_items" ALTER COLUMN "tenant_id" TYPE uuid USING "tenant_id"::uuid;--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "tenant_id" TYPE uuid USING "tenant_id"::uuid;--> statement-breakpoint

-- ============================ foreign keys ============================
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_current_org_id_orgs_id_fk" FOREIGN KEY ("current_org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_steps" ADD CONSTRAINT "journal_steps_tenant_id_orgs_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_items" ADD CONSTRAINT "conversation_items_tenant_id_orgs_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_tenant_id_orgs_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- ============================ indexes ============================
CREATE INDEX "api_keys_prefix_idx" ON "api_keys" USING btree ("key_prefix");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_hash_idx" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "api_keys_org_idx" ON "api_keys" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "auth_audit_actor_org_idx" ON "auth_audit" USING btree ("actor_org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_user_org_idx" ON "memberships" USING btree ("user_id","org_id");--> statement-breakpoint
CREATE INDEX "memberships_org_idx" ON "memberships" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orgs_slug_lower_idx" ON "orgs" USING btree (lower("slug"));--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_idx" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_family_idx" ON "sessions" USING btree ("family_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_idx" ON "users" USING btree (lower("email")) WHERE "deleted_at" is null;--> statement-breakpoint

-- Re-key the replay cache on tenant (RLS-ready): exactly one cached step per
-- (tenant, run, key). Replaces the dropped journal_idem_idx.
CREATE UNIQUE INDEX "journal_idem_idx" ON "journal_steps" USING btree ("tenant_id","run_id","idempotency_key");
