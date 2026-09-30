-- product_migration_ledger: the append-only record of every product schema change an environment applied.
--
-- REVIEWED: generated with `drizzle-kit generate` against the current snapshot and read
-- statement-by-statement before committing. The generated diff was CLEAN — one new table and its two
-- CHECK constraints — and the append-only function and triggers at the end are added by hand, because
-- drizzle-kit does not model functions or triggers.
--
-- Purely ADDITIVE: one new GLOBAL table, no ALTER of an existing table, no data migration.
-- DESTRUCTIVE-SCAN: CREATE TABLE / CREATE FUNCTION / CREATE TRIGGER only; the one finding (the word
-- TRUNCATE in the trigger that refuses a truncate) is cleared by a reviewed allowlist entry.
--
-- product_migration_ledger — one row per applied product change, in order: the DDL and its SHA-256,
--   the product schema digest before and after, the product schema description after, the declared
--   stores the schema then implements, and the operation that applied it. The trigger refuses UPDATE,
--   DELETE and TRUNCATE, so a row, once committed, is never rewritten. The chain inserts nothing: an
--   environment deployed before the ledger existed starts with an empty ledger.

CREATE TABLE "product_migration_ledger" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "product_migration_ledger_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"ledger_format_version" smallint NOT NULL,
	"operation_id" uuid NOT NULL,
	"migration_name" text NOT NULL,
	"ddl" text NOT NULL,
	"ddl_sha256" text NOT NULL,
	"product_schema_before" text NOT NULL,
	"product_schema_after" text NOT NULL,
	"schema_after" jsonb NOT NULL,
	"declared_stores" jsonb NOT NULL,
	"applied_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "product_migration_ledger_format" CHECK ("product_migration_ledger"."ledger_format_version" >= 1),
	CONSTRAINT "product_migration_ledger_digests" CHECK ("product_migration_ledger"."ddl_sha256" ~ '^[a-f0-9]{64}$' AND "product_migration_ledger"."product_schema_before" ~ '^[a-f0-9]{64}$' AND "product_migration_ledger"."product_schema_after" ~ '^[a-f0-9]{64}$')
);

--> statement-breakpoint
CREATE FUNCTION "product_migration_ledger_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'product_migration_ledger is append-only: % is refused', TG_OP
		USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "product_migration_ledger_no_rewrite" BEFORE UPDATE OR DELETE ON "product_migration_ledger" FOR EACH ROW EXECUTE FUNCTION "product_migration_ledger_append_only"();
--> statement-breakpoint
CREATE TRIGGER "product_migration_ledger_no_truncate" BEFORE TRUNCATE ON "product_migration_ledger" FOR EACH STATEMENT EXECUTE FUNCTION "product_migration_ledger_append_only"();
