-- tenant_event_bus: the durable, per-tenant-sequenced product event stream (init.emit).
--
-- REVIEWED: generated with `drizzle-kit generate` against the current snapshot and read
-- statement-by-statement before committing (the mandated generate → read the SQL diff → correct
-- discipline). The generated diff was CLEAN — two new tables and nothing else — so it is committed as
-- generated, with this header added.
--
-- Purely ADDITIVE: two new tenant-scoped tables, no ALTER of an existing table, no data migration.
-- DESTRUCTIVE-SCAN: only CREATE TABLE / ADD CONSTRAINT / CREATE INDEX — no destructive statement, so
-- the home-grown destructive scan has no findings and needs no allowlist entry.
--
-- tenant_event_streams — ONE row per tenant: the stream's HEAD (`last_seq`) and its retention FLOOR
--   (`truncated_through`). The head is what an emit bumps; the UPDATE's row lock is held to COMMIT, so
--   allocation order equals commit order and a `seq > cursor` resume can never skip a row that commits
--   late. bigint, not bigserial: a sequence hands out values BEFORE commit, which is precisely the
--   ordering this table exists to avoid. A rolled-back emit returns its number, so the visible sequence
--   is gap-free and a hole means retention.
--   The floor is written in the SAME statement as the retention DELETE, so no reader can land between
--   the delete and the floor write.
--
-- tenant_events — ONE row per event, keyed (tenant_id, seq): the composite PRIMARY KEY is both the
--   uniqueness guarantee and the ordered resume read path. `seq` is the SOLE ordering authority; `at`
--   is transaction-START time and is NOT monotone with seq under concurrency (display only — a query
--   that orders or windows by it reorders and drops events). The `at` index serves the retention
--   sweep's age scan, not a read path.
--
-- Both carry `tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE`, so a GDPR org-delete
-- takes a tenant's whole stream (and its counter) with it, and both are registered in
-- TENANT_SCOPED_TABLES so the chokepoint auto-injects the predicate.

CREATE TABLE "tenant_event_streams" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"last_seq" bigint DEFAULT 0 NOT NULL,
	"truncated_through" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_events" (
	"tenant_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"topic" text NOT NULL,
	"payload" jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_events_tenant_id_seq_pk" PRIMARY KEY("tenant_id","seq")
);
--> statement-breakpoint
ALTER TABLE "tenant_event_streams" ADD CONSTRAINT "tenant_event_streams_tenant_id_orgs_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_events" ADD CONSTRAINT "tenant_events_tenant_id_orgs_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tenant_events_at_idx" ON "tenant_events" USING btree ("at");