-- runtime_control: the durable runtime-control state of an environment and its operation receipts.
--
-- REVIEWED: generated with `drizzle-kit generate` against the current snapshot and read
-- statement-by-statement before committing. The generated diff was CLEAN — two new tables, their
-- CHECK constraints and two indexes — and the append-only trigger at the end is added by hand,
-- because drizzle-kit does not model functions or triggers.
--
-- Purely ADDITIVE: two new GLOBAL tables, no ALTER of an existing table, no data migration.
-- DESTRUCTIVE-SCAN: CREATE TABLE / CREATE INDEX / CREATE FUNCTION / CREATE TRIGGER only; the one
-- finding (the word TRUNCATE in the trigger that refuses a truncate) is cleared by a reviewed
-- allowlist entry.
--
-- runtime_control_state — ONE row (id pinned to 1 by a CHECK): the environment revision, the source
--   fence, the binding revision key, the operation lease with its fencing epoch, and what the last
--   apply activated. The row is inserted by the first runtime-control operation, which generates the
--   binding revision key; the chain inserts nothing, so it runs no random-number function.
--
-- runtime_control_receipts — append-only operation receipts, ordered by an identity column. The
--   trigger refuses UPDATE, DELETE and TRUNCATE, so a receipt, once committed, is never rewritten.
--   Only an intent may carry an idempotency key, and the partial unique index lets a key name
--   exactly one intent.

CREATE TABLE "runtime_control_receipts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "runtime_control_receipts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"operation_id" uuid NOT NULL,
	"operation_kind" text NOT NULL,
	"actor" text NOT NULL,
	"lease_epoch" bigint NOT NULL,
	"inputs_digest" text NOT NULL,
	"event" text NOT NULL,
	"step" text,
	"digest" text,
	"outcome" text,
	"idempotency_key" text,
	"detail" jsonb,
	"recorded_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "runtime_control_receipts_idempotency_intent" CHECK ("runtime_control_receipts"."idempotency_key" IS NULL OR "runtime_control_receipts"."event" = 'intent'),
	CONSTRAINT "runtime_control_receipts_event" CHECK ("runtime_control_receipts"."event" IN ('intent', 'lease-taken-over', 'step-started', 'step-finished', 'step-skipped', 'outcome'))
);
--> statement-breakpoint
CREATE TABLE "runtime_control_state" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"deployment_id" text,
	"environment_revision" bigint DEFAULT 1 NOT NULL,
	"fence_state" text DEFAULT 'open' NOT NULL,
	"fence_epoch" bigint DEFAULT 0 NOT NULL,
	"fence_actor" text,
	"fence_reason" text,
	"fenced_at" timestamp with time zone,
	"fence_barriers" jsonb,
	"binding_revision_key" text NOT NULL,
	"lease_epoch" bigint DEFAULT 0 NOT NULL,
	"lease_operation_id" uuid,
	"lease_kind" text,
	"lease_actor" text,
	"lease_expires_at" timestamp with time zone,
	"application_id" text,
	"application_version" text,
	"application_digest" text,
	"active_grants" jsonb,
	"applied_product_schema" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runtime_control_state_singleton" CHECK ("runtime_control_state"."id" = 1),
	CONSTRAINT "runtime_control_state_fence_state" CHECK ("runtime_control_state"."fence_state" IN ('open', 'fenced')),
	CONSTRAINT "runtime_control_state_binding_key" CHECK ("runtime_control_state"."binding_revision_key" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "runtime_control_state_revision" CHECK ("runtime_control_state"."environment_revision" >= 1 AND "runtime_control_state"."fence_epoch" >= 0 AND "runtime_control_state"."lease_epoch" >= 0)
);
--> statement-breakpoint
CREATE INDEX "runtime_control_receipts_operation_idx" ON "runtime_control_receipts" USING btree ("operation_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_control_receipts_idempotency_idx" ON "runtime_control_receipts" USING btree ("idempotency_key") WHERE "runtime_control_receipts"."idempotency_key" IS NOT NULL;
--> statement-breakpoint
CREATE FUNCTION "runtime_control_receipts_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'runtime_control_receipts is append-only: % is refused', TG_OP
		USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "runtime_control_receipts_no_rewrite" BEFORE UPDATE OR DELETE ON "runtime_control_receipts" FOR EACH ROW EXECUTE FUNCTION "runtime_control_receipts_append_only"();
--> statement-breakpoint
CREATE TRIGGER "runtime_control_receipts_no_truncate" BEFORE TRUNCATE ON "runtime_control_receipts" FOR EACH STATEMENT EXECUTE FUNCTION "runtime_control_receipts_append_only"();
