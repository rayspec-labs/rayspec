# Database roles and row-level security

RaySpec keeps tenants apart in the application: every query against tenant-owned data goes through
one chokepoint that adds the tenant predicate ([Architecture → the fail-closed tenant
chokepoint](./ARCHITECTURE.md#2-the-fail-closed-tenant-chokepoint)). This guide turns on the second,
in-database layer beneath it: **separate database roles** and **row-level security**. With it, the
database itself refuses a statement that would reach another tenant's rows, whatever issued it.

It is **opt-in**. A deployment that sets nothing new keeps working exactly as before, with one
database role that migrates and serves. The isolated posture is turned on by one setting,
`RAYSPEC_MIGRATION_DATABASE_URL`, and is required before the runtime reports the managed hosting
posture as supported.

## What changes when it is on

| | One role (default) | Role separation |
| --- | --- | --- |
| Who runs the platform migrations, product DDL and ledger writes | the role in `DATABASE_URL` | the migration role, over `RAYSPEC_MIGRATION_DATABASE_URL`; the pool is closed once the boot's schema work is done |
| Who serves requests, jobs and streams | the role in `DATABASE_URL` | the runtime role in `DATABASE_URL`: no superuser, no `BYPASSRLS`, owns nothing, may create nothing |
| Row-level security on tenant tables | policies exist but are not enabled | enabled and forced on every tenant table, product stores included |
| A foreign key from one tenant's row to another tenant's row | accepted by the database | refused (`23503`, reported like a missing parent) |
| The source fence's database barrier | a stopped source only | the runtime role's writes revoked (`database-write-role`) |
| What the runtime reports | `single-role` | `role-separated`, active only when every check passes |

Every statement the application issues runs in a transaction that first sets the transaction-local
setting `app.current_tenant` to the tenant the server derived from the authenticated principal
(or, for a background job, a scheduled firing and the retention sweep, from the job's own
server-created tenant). It is never read from a request. The policy on each tenant table compares
`tenant_id` with that setting:

- no tenant set: a read returns nothing and a write fails;
- a value that is not a tenant id: the statement fails;
- a tenant set in an earlier transaction: gone — the setting ends with its transaction, so a pooled
  connection carries no tenant from one request into the next.

The global tables — `orgs`, `users`, `memberships`, `sessions`, `api_keys`, `auth_audit`,
`oidc_models`, the runtime-control tables and the two migration ledgers — have no tenant column and
no policy. They are reached before a tenant is known (sign-in, token checks) or belong to the
environment rather than to a tenant; they are the documented exceptions, and the platform's global
stores are the only code that reads them.

Two lookups must find a tenant row before any tenant is known, and each goes through one narrow
database function created by the platform migrations: the invite redemption resolves the tenant of
an invite from its token hash (`rayspec_invite_tenant`), and the replay guard asks whether a run id
is taken by another tenant (`rayspec_run_owned_elsewhere`). Each returns that one fact and no row.

## The three roles

`packages/kernel/db/sql/database-roles.sql` (shipped in `@rayspec/db` as `sql/database-roles.sql`)
creates them and their grants. Run it as a superuser; it is idempotent and keeps every row.

| Role (default name) | May | May not |
| --- | --- | --- |
| migration role (`rayspec_migrator`) | own every schema object; run the platform migrations, product DDL, ledger writes and the step that enables row security; bypass row security, so a data migration sees every row | create roles or databases; be a superuser |
| runtime role (`rayspec_runtime`) | `SELECT`, `INSERT`, `UPDATE`, `DELETE` on the application tables; read the two migration ledgers; write the runtime-control receipts and process heartbeats | own, create or alter anything (no table, schema or temporary table); `TRUNCATE`; bypass row security; switch to another role |
| snapshot role (`rayspec_snapshot`) | read every table, every tenant's rows (`BYPASSRLS`) — the export reader | write anything |

Different names come from session settings before the script runs (`rayspec.migration_role`,
`rayspec.runtime_role`, `rayspec.snapshot_role`), so several environments on one database server
each get roles of their own. The script sets no password.

## Turning it on

1. **Create the roles and prepare the application database** (as a superuser, in that database):

   ```bash
   psql -v ON_ERROR_STOP=1 -d app -f database-roles.sql
   psql -d app -c '\password rayspec_migrator'
   psql -d app -c '\password rayspec_runtime'
   psql -d app -c '\password rayspec_snapshot'
   ```

   On a database that already holds a deployment, the script hands every table, sequence, function
   and schema over to the migration role and grants the runtime role its privileges on them; rows
   are not touched.

2. **With a durable worker, prepare its workflow system database too.** The migration role may not
   create databases, so create it first (its name is the application database's plus `_dbos_sys`,
   unless `DBOS_SYSTEM_DATABASE_URL` names another):

   ```bash
   psql -d postgres -c 'CREATE DATABASE app_dbos_sys'
   psql -v ON_ERROR_STOP=1 -d app_dbos_sys \
        -c "SET rayspec.database_kind = 'workflow-system'" -f database-roles.sql
   ```

   The boot applies the workflow engine's own migrations there as the migration role; the engine
   then runs as the runtime role.

3. **Point the runtime at the two roles:**

   ```bash
   export DATABASE_URL=postgresql://rayspec_runtime:…@db.internal:5432/app
   export RAYSPEC_MIGRATION_DATABASE_URL=postgresql://rayspec_migrator:…@db.internal:5432/app
   # or RAYSPEC_MIGRATION_DATABASE_URL_FILE=/run/secrets/migration-database-url
   ```

   `rayspec tenant ensure` reads the same two variables and provisions over the migration role.

4. **Boot.** The boot migrates as the migration role, enables and forces row security on every
   tenant table, creates the policy on any that lacks it, guards every foreign key between tenant
   tables, revokes the runtime role's writes on the migration ledgers, closes the migration pool,
   and checks the posture as the runtime role. Each product migration a deploy applies later does
   the same for the tables it creates, in the transaction that creates them.

## Checking the posture

The boot checks, from the catalog, that the runtime role:

- is not a superuser, does not bypass row security and may not create roles or databases, and
  cannot switch to a role that may;
- owns no table, sequence, function, schema or the database, and cannot act as an owner;
- may create nothing: no object in any schema, no schema, no temporary table;
- holds no `TRUNCATE` on a tenant table (`TRUNCATE` is not subject to row security);
- starts its sessions with no preset `app.current_tenant`, `row_security`, `search_path` or `role`;

and that every tenant table — every table with a `tenant_id` column, read from the catalog — has
row security enabled and forced and carries the tenant policy.

When a check fails the server still starts and serves as before, prints one warning line naming each
failure, and does not report the posture as active. An embedder reads the result as
`BootedServer.databaseIsolation`; the runtime-control adapter reports it with
`inspectDatabaseIsolation()` when it is given the runtime role's name (`runtimeRole`), and its
`inspect()` reports the managed posture as supported only for a release with a capability receipt
**and** an active posture.

## The source fence

With role separation, `quiesce()` holds the database barrier by revoking the runtime role's
`INSERT`, `UPDATE`, `DELETE` and `TRUNCATE` on every table of both databases, except the process
heartbeat table, and `resume()` grants back exactly what it revoked
([Runtime operations](./runtime-operations.md)). Only a table's owner can do that, so the adapter's
database connection is the migration role's. The snapshot role keeps its reads, which is what an
export dumps with.

## Turning it off

Unset `RAYSPEC_MIGRATION_DATABASE_URL` and point `DATABASE_URL` at a role that owns the tables (the
migration role). Row security stays enabled and forced; every query path sets its tenant, and the
migration role bypasses row security, so the application keeps working, but the posture is no longer
reported. To remove it completely, run `ALTER TABLE … NO FORCE ROW LEVEL SECURITY` and
`ALTER TABLE … DISABLE ROW LEVEL SECURITY` on each tenant table as the owner.

## What it does not do

- It does not stop code that runs **inside** the runtime process with the runtime role's connection
  from setting another tenant's id itself. Handlers and extensions run in that process
  ([Security](../SECURITY.md)); the database layer protects against a statement that forgot or lost
  its tenant, not against code that deliberately forges one.
- Restore a dump into a role-separated database as the migration role: it bypasses row security, so
  every tenant's rows load; the runtime role could load only rows of the tenant it has set.
- The policies do not replace the chokepoint: both apply, and a statement must satisfy both.
