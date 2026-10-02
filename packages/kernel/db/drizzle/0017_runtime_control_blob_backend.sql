-- runtime_control_blob_backend: the blob backend the active application's boot resolved.
--
-- REVIEWED: generated with `drizzle-kit generate` against the current snapshot and read
-- statement-by-statement before committing. The generated diff was CLEAN: one nullable column on
-- an existing table.
--
-- Purely ADDITIVE: one NULLABLE ADD COLUMN on the global runtime_control_state row, no table
-- rebuild, no data migration. An environment migrated from an earlier head reads NULL until its
-- next bundle deploy records the value.
-- DESTRUCTIVE-SCAN: no finding.
--
-- runtime_control_state.blob_backend  jsonb  NULLABLE — written by the bundle deploy that activates
--   an application, in the same transaction as the application digest: `{"kind":"fs"}` (the
--   platform's fs store over RAYSPEC_BLOB_ROOT), `{"kind":"none"}`, or
--   `{"kind":"extension","extension":"<id>"}` (a backend an extension provides). It is what the
--   boot learned by loading the application's extensions, so an export can tell where the blobs
--   are without loading extension code itself.

ALTER TABLE "runtime_control_state" ADD COLUMN "blob_backend" jsonb;
