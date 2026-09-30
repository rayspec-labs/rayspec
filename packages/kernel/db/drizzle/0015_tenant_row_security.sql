-- tenant_row_security: the row-level policy of every core tenant table, and the three functions the
-- isolated posture needs.
--
-- REVIEWED: written by hand and read statement-by-statement before committing. drizzle-kit does not
-- generate these: the policies are deliberately not declared in schema.ts, because declaring one there
-- makes drizzle-kit enable row security in the same migration, and this migration must not.
--
-- Purely ADDITIVE and INERT until row security is enabled: CREATE POLICY and CREATE FUNCTION only. No
-- table is altered, no row is read or written, and no table has row security enabled here, so a
-- deployment that keeps one database role (today's layout) behaves exactly as before. Row security is
-- enabled and forced by the migration role when the runtime connects as its own role
-- (`applyTenantIsolation`, packages/kernel/db/src/tenant-isolation.ts), which also covers the product
-- stores. The policy text equals `tenantPolicySql`, which is what the posture check looks for.
-- DESTRUCTIVE-SCAN: no finding.
--
-- tenant_isolation — on each of the eleven core tenant tables: a row is visible and writable only when
--   its tenant_id equals the transaction-local setting app.current_tenant. Unset or empty (what a
--   pooled session holds after an earlier transaction set it locally) compares as NULL: a read returns
--   nothing and a write fails.
--
-- rayspec_run_owned_elsewhere(run_id) — whether a run with this id exists under a tenant other than
--   the current one. The run-header ownership probe asks it before a replay, so a replay of another
--   tenant's run id is refused before any model call; under row security the probe's own read cannot
--   see the other tenant's row. SECURITY DEFINER, so it reads as its owner (the migration role, which
--   bypasses row security); it returns one boolean and no row data.
--
-- rayspec_invite_tenant(token_hash) — the tenant of the invite with this token hash, or NULL. The
--   invite redemption resolves a token before any tenant is known and then reads the invite under that
--   tenant. SECURITY DEFINER for the same reason; it needs the HMAC of a live token, which only the
--   holder of the token and the pepper can compute.
--
-- rayspec_same_tenant_reference() — the trigger function behind a foreign key between two tenant
--   tables: it refuses a row that references a parent row of another tenant (Postgres checks a foreign
--   key without row security). Arguments: the parent table, the referencing column, the constraint
--   name it reports. SECURITY INVOKER, so under row security the parent lookup sees only the current
--   tenant's rows; it also compares tenant_id itself, so the rule holds for a role that bypasses row
--   security. The triggers are created by `applyTenantIsolation`.

CREATE POLICY "tenant_isolation" ON "public"."conversation_items" AS PERMISSIVE FOR ALL TO PUBLIC USING ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid) WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "public"."idempotency_keys" AS PERMISSIVE FOR ALL TO PUBLIC USING ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid) WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "public"."invites" AS PERMISSIVE FOR ALL TO PUBLIC USING ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid) WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "public"."journal_steps" AS PERMISSIVE FOR ALL TO PUBLIC USING ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid) WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "public"."run_events" AS PERMISSIVE FOR ALL TO PUBLIC USING ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid) WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "public"."runs" AS PERMISSIVE FOR ALL TO PUBLIC USING ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid) WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "public"."tenant_event_streams" AS PERMISSIVE FOR ALL TO PUBLIC USING ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid) WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "public"."tenant_events" AS PERMISSIVE FOR ALL TO PUBLIC USING ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid) WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "public"."workflow_artifacts" AS PERMISSIVE FOR ALL TO PUBLIC USING ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid) WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "public"."workflow_node_states" AS PERMISSIVE FOR ALL TO PUBLIC USING ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid) WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "public"."workflow_runs" AS PERMISSIVE FOR ALL TO PUBLIC USING ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid) WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
--> statement-breakpoint
CREATE FUNCTION "public"."rayspec_run_owned_elsewhere"(p_run_id text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
	SELECT EXISTS (
		SELECT 1 FROM public.runs
		 WHERE run_id = p_run_id
		   AND tenant_id IS DISTINCT FROM NULLIF(current_setting('app.current_tenant', true), '')::uuid
	)
$$;
--> statement-breakpoint
CREATE FUNCTION "public"."rayspec_invite_tenant"(p_token_hash text) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
	SELECT tenant_id FROM public.invites WHERE token_hash = p_token_hash
$$;
--> statement-breakpoint
CREATE FUNCTION "public"."rayspec_same_tenant_reference"() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
	referenced text := to_jsonb(NEW) ->> TG_ARGV[1];
	same_tenant boolean;
BEGIN
	IF referenced IS NULL THEN
		RETURN NEW;
	END IF;
	EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s p WHERE p.id = $1::uuid AND p.tenant_id = $2)', TG_ARGV[0]::regclass)
		INTO same_tenant USING referenced, NEW.tenant_id;
	IF NOT same_tenant THEN
		RAISE EXCEPTION 'insert or update on table "%" violates foreign key constraint "%"', TG_TABLE_NAME, TG_ARGV[2]
			USING ERRCODE = 'foreign_key_violation', CONSTRAINT = TG_ARGV[2], TABLE = TG_TABLE_NAME, SCHEMA = TG_TABLE_SCHEMA;
	END IF;
	RETURN NEW;
END;
$$;
