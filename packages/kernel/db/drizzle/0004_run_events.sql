-- run_events: the durable, resumable per-run event log (REST+SSE).
--
-- REVIEWED, hand-authored (never blind autogenerate). drizzle-kit's autogen produced a
-- CONTAMINATED diff here (it re-CREATEd idempotency_keys / oidc_models / their FKs+indexes and
-- re-added conversation_items.* / sessions.revoked_reason) because the 0001/0002/0003 hand-authored
-- migrations were intentionally journal-only with no captured per-migration snapshot, so the
-- generator diffed against the stale 0000 snapshot. The autogen output was discarded and this
-- migration hand-written to contain ONLY the run_events table — exactly the "generate, read the SQL
-- diff, correct" discipline mandated. (The committed meta/0004_snapshot.json IS the correct full
-- current-schema snapshot — it captured run_events — so a future `db:generate` diffs against truth.)
--
-- Purely ADDITIVE: one new tenant-scoped table. `run_id` correlates to runs.run_id; `tenant_id uuid
-- NOT NULL REFERENCES orgs(id) ON DELETE CASCADE` so a GDPR org-delete cascades the run's events
-- and the TenantDb chokepoint can auto-inject the predicate (run_events is registered in
-- TENANT_SCOPED_TABLES). `seq` is the single per-run monotonic seq (NeutralEvent.seq, stamped by
-- run-core). `data` is the already-NEUTRALIZED NeutralEvent jsonb (opaque tool_data for tools —
-- never a raw path). UNIQUE(tenant_id, run_id, seq) makes the persist idempotent (a re-emit
-- of the same seq is a no-op via onConflictDoNothing); the (run_id, seq) index serves the ordered
-- replay read (GET /runs/{id}/events?lastEventId=).
--
-- DESTRUCTIVE-SCAN: only CREATE TABLE / ADD CONSTRAINT / CREATE INDEX — no destructive statement, so
-- the home-grown destructive scan has no findings and no allowlist entry is needed.

CREATE TABLE "run_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" text NOT NULL,
	"tenant_id" uuid NOT NULL,
	"seq" numeric NOT NULL,
	"type" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_tenant_id_orgs_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_events_run_seq_idx" ON "run_events" USING btree ("run_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "run_events_tenant_run_seq_idx" ON "run_events" USING btree ("tenant_id","run_id","seq");
