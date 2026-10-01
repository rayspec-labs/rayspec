-- owner_recovery: the operator's one-time way back in for an organization owner who holds no password.
--
-- REVIEWED: generated with `drizzle-kit generate` against the current snapshot and read
-- statement-by-statement before committing. The generated diff was CLEAN: one new table, its two
-- foreign keys and its two indexes.
--
-- Purely ADDITIVE: one new GLOBAL table (no tenant_id, so no row-level policy; it is reached only
-- through the platform's global store, like sessions and api_keys), no ALTER of an existing table, no
-- data migration.
-- DESTRUCTIVE-SCAN: no finding.
--
-- owner_recovery_tokens — one row per recovery token the operator issued: the owner (org_id,
--   user_id), the HMAC of the token under the API-key pepper (token_hash, unique; the token itself is
--   printed once and stored nowhere), its expiry, and the single-use and replaced markers.

CREATE TABLE "owner_recovery_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "owner_recovery_tokens" ADD CONSTRAINT "owner_recovery_tokens_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_recovery_tokens" ADD CONSTRAINT "owner_recovery_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "owner_recovery_tokens_hash_idx" ON "owner_recovery_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "owner_recovery_tokens_user_idx" ON "owner_recovery_tokens" USING btree ("user_id");