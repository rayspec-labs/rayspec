CREATE INDEX "runs_created_at_idx" ON "runs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "runs_tenant_created_at_idx" ON "runs" USING btree ("tenant_id","created_at");