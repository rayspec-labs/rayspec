-- The fixture pack's migration chain: the platform state this pack owns, hand-written rather than
-- generated, because an append-only ledger with its own indexes is not a `stores` business table.
--
-- Every object this file creates carries the pack's declared table prefix (`fixture_pack_`), and
-- every statement is additive: a pack chain has no allowlist to clear anything else. That is what
-- `gate:pack-migrations` reads these bytes for, and the same rule set refuses them at boot.
--
-- The foreign key below targets `orgs`, a PLATFORM table, which is why a pack chain runs strictly
-- AFTER the platform chain: on a database the platform chain has not reached, this file cannot apply
-- at all.
CREATE TABLE "fixture_pack_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	-- a bare `orgs` named in a comment is not a statement: the scan strips comments before it matches
	"payload" jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fixture_pack_audit_events" ADD CONSTRAINT "fixture_pack_audit_events_tenant_id_orgs_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "fixture_pack_audit_events_tenant_idx" ON "fixture_pack_audit_events" USING btree ("tenant_id","recorded_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "fixture_pack_audit_events_action_unique" ON "fixture_pack_audit_events" USING btree ("tenant_id","actor","action","recorded_at");
