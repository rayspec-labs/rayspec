-- RaySpec database roles: the migration role, the runtime role and the snapshot role.
--
-- Run as a superuser, once per database, in the database it prepares:
--
--   psql -v ON_ERROR_STOP=1 -d <application database> -f database-roles.sql
--   psql -v ON_ERROR_STOP=1 -d <workflow system database> \
--        -c "SET rayspec.database_kind = 'workflow-system'" -f database-roles.sql
--
-- (psql runs `-c` and `-f` in order in one session, so the setting reaches the script.) It is
-- idempotent: a second run changes nothing, and running it on a database that already holds data
-- keeps every row. It sets no password; set one per role afterwards with `\password <role>` or
-- `ALTER ROLE <role> PASSWORD '...'`, never in a file.
--
-- The role names default to rayspec_migrator, rayspec_runtime and rayspec_snapshot. Different names
-- come from session settings before the script runs, for example
-- `SET rayspec.runtime_role = 'env1_runtime'` (also `rayspec.migration_role`, `rayspec.snapshot_role`).
--
-- WHAT EACH ROLE MAY DO
--
--   migration role  owns every schema object: it runs the platform migrations, the product DDL, the
--                   ledger writes and the step that enables row-level security. BYPASSRLS, so a
--                   migration that reads or rewrites rows sees all of them. NOSUPERUSER, NOCREATEROLE,
--                   NOCREATEDB. The runtime connects with it only through RAYSPEC_MIGRATION_DATABASE_URL.
--   runtime role    what the serving process connects as (DATABASE_URL). Reads and writes rows:
--                   SELECT, INSERT, UPDATE, DELETE on the application tables, the schema ledgers
--                   read-only. Owns nothing and may create nothing (no table, schema or temporary
--                   table), holds no TRUNCATE, is no superuser and does not bypass row security, so
--                   every tenant table's policy applies to it.
--   snapshot role   the read-only export reader: SELECT on every table, BYPASSRLS so a dump sees every
--                   tenant's rows. A source fence revokes the runtime role's writes and leaves this
--                   role's reads in place.
--
-- WHAT THE SCRIPT DOES TO THE DATABASE
--
--   - creates the three roles, or resets their attributes to the ones above;
--   - makes the migration role the owner of every existing table, sequence, view, function and
--     schema outside the system schemas (a database first set up with one role hands its objects
--     over here), except objects that belong to an extension;
--   - revokes CREATE and TEMPORARY on the database and CREATE on schema public from PUBLIC, and grants
--     the migration role CONNECT, CREATE and TEMPORARY on the database and USAGE and CREATE on public;
--   - grants the privileges above on the existing objects and, as default privileges of the migration
--     role, on every object it creates later.
--
-- In a workflow system database ('workflow-system') the runtime role gets SELECT, INSERT, UPDATE and
-- DELETE on every table the migration role creates in any schema, because the workflow engine keeps its
-- tables in a schema of its own that the migration role creates.
DO $roles$
DECLARE
	migrator text := coalesce(nullif(current_setting('rayspec.migration_role', true), ''), 'rayspec_migrator');
	runtime text := coalesce(nullif(current_setting('rayspec.runtime_role', true), ''), 'rayspec_runtime');
	snapshot text := coalesce(nullif(current_setting('rayspec.snapshot_role', true), ''), 'rayspec_snapshot');
	kind text := coalesce(nullif(current_setting('rayspec.database_kind', true), ''), 'application');
	obj record;
BEGIN
	IF kind NOT IN ('application', 'workflow-system') THEN
		RAISE EXCEPTION 'rayspec.database_kind must be application or workflow-system, not %', kind;
	END IF;
	IF migrator = runtime OR migrator = snapshot OR runtime = snapshot THEN
		RAISE EXCEPTION 'the migration, runtime and snapshot roles must be three different roles';
	END IF;

	-- The roles.
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = migrator) THEN
		EXECUTE format('CREATE ROLE %I', migrator);
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime) THEN
		EXECUTE format('CREATE ROLE %I', runtime);
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = snapshot) THEN
		EXECUTE format('CREATE ROLE %I', snapshot);
	END IF;
	EXECUTE format('ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION BYPASSRLS', migrator);
	EXECUTE format('ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS', runtime);
	EXECUTE format('ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION BYPASSRLS', snapshot);

	-- The database and schema public.
	EXECUTE format('REVOKE CREATE, TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
	EXECUTE format('GRANT CONNECT, CREATE, TEMPORARY ON DATABASE %I TO %I', current_database(), migrator);
	EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I, %I', current_database(), runtime, snapshot);
	REVOKE CREATE ON SCHEMA public FROM PUBLIC;
	EXECUTE format('GRANT USAGE, CREATE ON SCHEMA public TO %I', migrator);
	EXECUTE format('GRANT USAGE ON SCHEMA public TO %I, %I', runtime, snapshot);

	-- Hand every existing object over to the migration role. A sequence that belongs to a table column
	-- moves with its table.
	FOR obj IN
		SELECT n.nspname, c.relname, c.relkind
		  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
		 WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
		   AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\_%'
		   AND c.relowner <> (SELECT oid FROM pg_roles WHERE rolname = migrator)
		   AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass
		                    AND d.objid = c.oid AND d.deptype IN ('e', 'a', 'i'))
	LOOP
		EXECUTE format('ALTER %s %I.%I OWNER TO %I',
			CASE obj.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW'
			                 WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END,
			obj.nspname, obj.relname, migrator);
	END LOOP;
	FOR obj IN
		SELECT p.oid::regprocedure AS signature, p.prokind
		  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
		 WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\_%'
		   AND p.proowner <> (SELECT oid FROM pg_roles WHERE rolname = migrator)
		   AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass
		                    AND d.objid = p.oid AND d.deptype = 'e')
	LOOP
		EXECUTE format('ALTER %s %s OWNER TO %I',
			CASE obj.prokind WHEN 'p' THEN 'PROCEDURE' WHEN 'a' THEN 'AGGREGATE' ELSE 'FUNCTION' END,
			obj.signature, migrator);
	END LOOP;
	FOR obj IN
		SELECT n.nspname
		  FROM pg_namespace n
		 WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'public') AND n.nspname NOT LIKE 'pg\_%'
		   AND n.nspowner <> (SELECT oid FROM pg_roles WHERE rolname = migrator)
		   AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_namespace'::regclass
		                    AND d.objid = n.oid AND d.deptype = 'e')
	LOOP
		EXECUTE format('ALTER SCHEMA %I OWNER TO %I', obj.nspname, migrator);
	END LOOP;

	-- Privileges on what exists now.
	FOR obj IN
		SELECT n.nspname FROM pg_namespace n
		 WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\_%'
	LOOP
		EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I, %I', obj.nspname, runtime, snapshot);
		EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO %I, %I', obj.nspname, runtime, snapshot);
		EXECUTE format('GRANT SELECT ON ALL SEQUENCES IN SCHEMA %I TO %I', obj.nspname, snapshot);
		EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO %I', obj.nspname, runtime);
		EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA %I TO %I', obj.nspname, runtime);
		EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA %I FROM %I, %I',
			obj.nspname, runtime, snapshot);
		IF kind = 'workflow-system' OR obj.nspname = 'public' THEN
			EXECUTE format('GRANT INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO %I', obj.nspname, runtime);
		END IF;
	END LOOP;
	IF to_regclass('public.product_migration_ledger') IS NOT NULL THEN
		EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON TABLE public.product_migration_ledger FROM %I', runtime);
	END IF;

	-- Default privileges on what the migration role creates later.
	EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I GRANT USAGE ON SCHEMAS TO %I, %I', migrator, runtime, snapshot);
	EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I GRANT SELECT ON TABLES TO %I, %I', migrator, runtime, snapshot);
	EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I GRANT SELECT ON SEQUENCES TO %I', migrator, snapshot);
	EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I GRANT USAGE, SELECT ON SEQUENCES TO %I', migrator, runtime);
	EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT INSERT, UPDATE, DELETE ON TABLES TO %I',
		migrator, runtime);
	IF kind = 'workflow-system' THEN
		EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I GRANT INSERT, UPDATE, DELETE ON TABLES TO %I', migrator, runtime);
	END IF;
END
$roles$;
