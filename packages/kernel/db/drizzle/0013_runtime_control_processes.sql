-- runtime_control_processes: the heartbeat each running runtime process writes about the source fence.
--
-- REVIEWED: generated with `drizzle-kit generate` against the current snapshot and read
-- statement-by-statement before committing. The generated diff was CLEAN — one new table and its
-- two CHECK constraints.
--
-- Purely ADDITIVE: one new GLOBAL table, no ALTER of an existing table, no data migration.
-- DESTRUCTIVE-SCAN: CREATE TABLE only.
--
-- runtime_control_processes — one row per running runtime process: the fence epoch it observed, its
--   phase (open, draining, fenced), each producer's state and the external services it calls that a
--   fence cannot stop. A quiesce reads these rows to learn whether every live process has drained.
--   The chain inserts nothing.

CREATE TABLE "runtime_control_processes" (
	"process_id" uuid PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seen_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"fence_epoch" bigint DEFAULT 0 NOT NULL,
	"phase" text DEFAULT 'open' NOT NULL,
	"producers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"unfenced_external" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "runtime_control_processes_phase" CHECK ("runtime_control_processes"."phase" IN ('open', 'draining', 'fenced')),
	CONSTRAINT "runtime_control_processes_epoch" CHECK ("runtime_control_processes"."fence_epoch" >= 0)
);
