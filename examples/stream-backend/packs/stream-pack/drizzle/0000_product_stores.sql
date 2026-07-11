-- GENERATED product migration — review before applying (read the SQL, never blind-apply).
-- Produced by @rayspec/db generate-product-sql from a validated RaySpec `stores[]`.
-- Purely ADDITIVE (CREATE TABLE + FK + index) — the destructive scan has no findings.
-- tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE is INJECTED on every table
-- (the tenant predicate + GDPR cascade); product->product FKs carry the author onDelete policy.
CREATE TABLE "blob_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"upload_id" text NOT NULL,
	"chunk_index" integer NOT NULL,
	"chunk_ref" text NOT NULL,
	"storage_key" text NOT NULL,
	"byte_len" integer NOT NULL,
	"content_type" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"retention_days" integer,
	"region" text DEFAULT 'eu' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "blob_chunks" ADD CONSTRAINT "blob_chunks_tenant_id_orgs_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "blob_chunks_chunk_ref_unique" ON "blob_chunks" USING btree ("chunk_ref");
--> statement-breakpoint
CREATE INDEX "blob_chunks_tenant_idx" ON "blob_chunks" USING btree ("tenant_id");
