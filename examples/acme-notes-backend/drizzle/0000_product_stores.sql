-- GENERATED product migration — review before applying (read the SQL, never blind-apply).
-- Produced by @rayspec/db generate-product-sql from a validated RaySpec `stores[]`.
-- Purely ADDITIVE (CREATE TABLE + FK + index) — the destructive scan has no findings.
-- tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE is INJECTED on every table
-- (the tenant predicate + GDPR cascade); product->product FKs carry the author onDelete policy.
CREATE TABLE "notebooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"subtitle" text,
	"completed" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"retention_days" integer,
	"region" text DEFAULT 'eu' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notebooks" ADD CONSTRAINT "notebooks_tenant_id_orgs_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "notebooks_tenant_idx" ON "notebooks" USING btree ("tenant_id");
--> statement-breakpoint
CREATE TABLE "entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"notebook_id" uuid NOT NULL,
	"body" text NOT NULL,
	"language" text,
	"summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"retention_days" integer,
	"region" text DEFAULT 'eu' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_tenant_id_orgs_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_notebook_id_notebooks_id_fk" FOREIGN KEY ("notebook_id") REFERENCES "public"."notebooks"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "entries_tenant_idx" ON "entries" USING btree ("tenant_id");
