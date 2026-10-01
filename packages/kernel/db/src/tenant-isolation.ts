/**
 * Row-level tenant isolation in the database — the layer beneath the `TenantDb` chokepoint.
 *
 * The chokepoint puts the tenant predicate into every statement it builds. This module makes the
 * database enforce the same boundary on its own, so a statement that forgot the predicate (or a
 * statement the chokepoint never saw) still reaches only the rows of the tenant the server derived:
 *
 *  - every tenant table (a table with a `tenant_id` column) carries the policy `tenant_isolation`:
 *    a row is visible, updatable and deletable only when its `tenant_id` equals the transaction-local
 *    setting `app.current_tenant`, and a row can be written only with that `tenant_id`. With the
 *    setting absent (or empty, which is what a pooled session holds after an earlier transaction set
 *    it locally) the comparison is NULL: a read returns nothing and a write fails. A value that is not
 *    a UUID fails the statement.
 *  - row security is ENABLED and FORCED on every tenant table, so the table owner is subject to the
 *    policy too unless it holds BYPASSRLS.
 *  - a single-column foreign key from a tenant table onto another tenant table's `id` gets a trigger
 *    that refuses a reference to a parent row of another tenant. Postgres checks a foreign key without
 *    row security, so the key alone would let one tenant point a row at another tenant's row.
 *
 * WHEN IT APPLIES. The platform chain creates the policies on the core tenant tables and they stay
 * inert until row security is enabled, so a deployment that keeps one database role is unchanged.
 * `applyTenantIsolation` enables it, creates the policy and the reference trigger on every tenant
 * table that lacks them (product stores included), and is run by the migration role when the runtime
 * connects as a separate role. It is idempotent: on a database that already has everything it
 * changes nothing.
 *
 * `verifyTenantIsolation` is the check the runtime reports its posture from. It reads the catalog
 * for a named role — the role the runtime connects as — and lists every reason the posture is not
 * in force; an empty list is the only result that counts as active.
 */
import { TENANT_GUC } from './tenant-db.js';

/** The name of the row-level policy every tenant table carries. */
export const TENANT_POLICY_NAME = 'tenant_isolation';

/** The column that makes a table a tenant table. */
export const TENANT_COLUMN = 'tenant_id';

/** The name prefix of the trigger that keeps a foreign key inside one tenant. */
export const SAME_TENANT_TRIGGER_PREFIX = 'rayspec_same_tenant_';

/** The trigger function that trigger calls (created by the platform chain). */
export const SAME_TENANT_FUNCTION = 'rayspec_same_tenant_reference';

/**
 * The tables of the application database that have no `tenant_id` column, and so no tenant policy:
 * the documented exceptions to row-level isolation. Each is reached before a tenant is known (sign-in,
 * token checks, invite and key resolution) or belongs to the environment rather than to a tenant.
 * `orgColumn` names the column that ties a row to an organization when there is one; row security
 * does not cover it, so those rows are reached only through the platform's global stores (the
 * chokepoint refuses every one of these tables, and the build gate keeps the raw handle out of
 * request code). The database-backed test holds this list equal to the catalog.
 */
export const GLOBAL_TABLES: readonly { schema: string; table: string; orgColumn?: string }[] = [
  { schema: 'drizzle', table: '__drizzle_migrations' },
  { schema: 'public', table: 'api_keys', orgColumn: 'org_id' },
  { schema: 'public', table: 'auth_audit', orgColumn: 'actor_org_id' },
  { schema: 'public', table: 'memberships', orgColumn: 'org_id' },
  { schema: 'public', table: 'oidc_models' },
  { schema: 'public', table: 'orgs', orgColumn: 'id' },
  { schema: 'public', table: 'owner_recovery_tokens', orgColumn: 'org_id' },
  { schema: 'public', table: 'product_migration_ledger' },
  { schema: 'public', table: 'runtime_control_processes' },
  { schema: 'public', table: 'runtime_control_receipts' },
  { schema: 'public', table: 'runtime_control_state' },
  { schema: 'public', table: 'sessions', orgColumn: 'current_org_id' },
  { schema: 'public', table: 'users' },
];

/** Tables whose rows only the migration role writes: the two schema ledgers. */
export const MIGRATION_ONLY_TABLES: readonly { schema: string; table: string }[] = [
  { schema: 'drizzle', table: '__drizzle_migrations' },
  { schema: 'public', table: 'product_migration_ledger' },
];

/**
 * Settings no role or database default may preset for the runtime role: the tenant itself, the
 * row-security switch, the object search path and the role a session assumes. Postgres lets a role
 * preset an ordinary setting for its own sessions, so the check looks at what is there.
 */
const ISOLATION_SETTINGS = [TENANT_GUC, 'row_security', 'search_path', 'role'] as const;

/** A query function over a postgres.js handle (a pool or a transaction). */
export interface IsolationSql {
  unsafe(query: string, parameters?: unknown[]): PromiseLike<unknown>;
}

async function rows<T>(db: IsolationSql, query: string, params: unknown[] = []): Promise<T[]> {
  return (await db.unsafe(query, params)) as T[];
}

/**
 * The expression a policy compares `tenant_id` with: the transaction-local tenant, NULL when unset
 * or empty. Written out rather than wrapped in a function so the policy has no dependency beyond the
 * built-in `current_setting`.
 */
export const CURRENT_TENANT_EXPRESSION = `NULLIF(current_setting('${TENANT_GUC}', true), '')::uuid`;

/**
 * The policy expression exactly as Postgres prints it back (`pg_get_expr`) for `tenantPolicySql`. The
 * check compares with it, so a policy that merely mentions the tenant setting (`… OR true`) is not
 * mistaken for the tenant policy.
 */
export const CANONICAL_POLICY_EXPRESSION = `(${TENANT_COLUMN} = (NULLIF(current_setting('${TENANT_GUC}'::text, true), ''::text))::uuid)`;

/**
 * The two SECURITY DEFINER functions the platform chain creates for the lookups that must find a
 * tenant row before any tenant is known. Their owner bypasses row security, so a function like them
 * reaches every tenant: the posture check accepts these two only while each has exactly this
 * signature, body and search path, and names any other one the runtime role may call.
 */
export const ISOLATION_DEFINER_FUNCTIONS: readonly {
  name: string;
  arguments: string;
  body: string;
}[] = [
  {
    name: 'rayspec_run_owned_elsewhere',
    arguments: 'p_run_id text',
    body:
      'SELECT EXISTS ( SELECT 1 FROM public.runs WHERE run_id = p_run_id AND tenant_id IS DISTINCT ' +
      `FROM NULLIF(current_setting('${TENANT_GUC}', true), '')::uuid )`,
  },
  {
    name: 'rayspec_invite_tenant',
    arguments: 'p_token_hash text',
    body: 'SELECT tenant_id FROM public.invites WHERE token_hash = p_token_hash',
  },
];

/** The search path both definer functions pin. */
export const ISOLATION_DEFINER_SEARCH_PATH = 'search_path=pg_catalog, pg_temp';

/** Collapse every run of whitespace to one space, so a body compares by its tokens. */
export function normalizeFunctionBody(body: string): string {
  return body.replace(/\s+/g, ' ').trim();
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** The `CREATE POLICY` statement for one tenant table. */
export function tenantPolicySql(schema: string, table: string): string {
  const target = `${quoteIdent(schema)}.${quoteIdent(table)}`;
  const predicate = `${quoteIdent(TENANT_COLUMN)} = ${CURRENT_TENANT_EXPRESSION}`;
  return (
    `CREATE POLICY ${quoteIdent(TENANT_POLICY_NAME)} ON ${target} AS PERMISSIVE FOR ALL TO PUBLIC ` +
    `USING (${predicate}) WITH CHECK (${predicate})`
  );
}

/** One tenant table as the catalog describes it. */
export interface TenantTableState {
  schema: string;
  table: string;
  rowSecurity: boolean;
  forced: boolean;
  /**
   * Whether the table carries the tenant policy exactly: named `tenant_isolation`, permissive, for
   * every command and every role, with the canonical expression in both USING and WITH CHECK.
   */
  policy: boolean;
  /** Whether the table carries any policy named `tenant_isolation`, whatever it reads. */
  policyNamed: boolean;
  /**
   * Every other permissive policy on the table. Postgres ORs permissive policies, so any one of them
   * widens what the tenant policy allows (`USING (true)` opens every tenant's rows).
   */
  otherPolicies: string[];
}

/**
 * Every tenant table in `schemas`, read from the catalog: each ordinary or partitioned table with a
 * live `tenant_id` column. Never a hand-written list, so a table added by any path is covered.
 */
export async function listTenantTables(
  db: IsolationSql,
  schemas: readonly string[] = ['public'],
): Promise<TenantTableState[]> {
  return rows<TenantTableState>(
    db,
    `SELECT n.nspname::text AS schema, c.relname::text AS table,
            c.relrowsecurity AS "rowSecurity", c.relforcerowsecurity AS forced,
            EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = $2) AS "policyNamed",
            EXISTS (
              SELECT 1 FROM pg_policy p
               WHERE p.polrelid = c.oid AND p.polname = $2 AND p.polcmd = '*' AND p.polpermissive
                 AND p.polroles = '{0}'::oid[]
                 AND pg_get_expr(p.polqual, p.polrelid) = $3
                 AND pg_get_expr(p.polwithcheck, p.polrelid) = $3
            ) AS policy,
            coalesce((SELECT array_agg(p.polname::text ORDER BY p.polname) FROM pg_policy p
                       WHERE p.polrelid = c.oid AND p.polpermissive AND p.polname <> $2),
                     '{}'::text[]) AS "otherPolicies"
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = $4 AND NOT a.attisdropped
      WHERE c.relkind IN ('r', 'p') AND n.nspname = ANY($1::text[])
      ORDER BY 1, 2`,
    [schemas, TENANT_POLICY_NAME, CANONICAL_POLICY_EXPRESSION, TENANT_COLUMN],
  );
}

/** A single-column foreign key between two tenant tables that has no same-tenant trigger yet. */
interface UnguardedReference {
  schema: string;
  table: string;
  column: string;
  constraint: string;
  parent: string;
  trigger: string;
}

async function unguardedReferences(
  db: IsolationSql,
  schemas: readonly string[],
): Promise<UnguardedReference[]> {
  return rows<UnguardedReference>(
    db,
    `SELECT cn.nspname::text AS schema, child.relname::text AS table, ca.attname::text AS column,
            con.conname::text AS constraint,
            format('%I.%I', pn.nspname, parent.relname) AS parent,
            $2 || left(md5(con.conname), 24) AS trigger
       FROM pg_constraint con
       JOIN pg_class child ON child.oid = con.conrelid
       JOIN pg_namespace cn ON cn.oid = child.relnamespace
       JOIN pg_class parent ON parent.oid = con.confrelid
       JOIN pg_namespace pn ON pn.oid = parent.relnamespace
       JOIN pg_attribute ca ON ca.attrelid = con.conrelid AND ca.attnum = con.conkey[1]
       JOIN pg_attribute pa ON pa.attrelid = con.confrelid AND pa.attnum = con.confkey[1]
      WHERE con.contype = 'f' AND cardinality(con.conkey) = 1
        AND cn.nspname = ANY($1::text[])
        AND pa.attname = 'id' AND pa.atttypid = 'uuid'::regtype
        AND ca.attname <> $3
        AND EXISTS (SELECT 1 FROM pg_attribute t WHERE t.attrelid = con.conrelid
                     AND t.attname = $3 AND NOT t.attisdropped)
        AND EXISTS (SELECT 1 FROM pg_attribute t WHERE t.attrelid = con.confrelid
                     AND t.attname = $3 AND NOT t.attisdropped)
        AND NOT EXISTS (SELECT 1 FROM pg_trigger tg WHERE tg.tgrelid = con.conrelid
                         AND tg.tgname = $2 || left(md5(con.conname), 24))
      ORDER BY 1, 2, 4`,
    [schemas, SAME_TENANT_TRIGGER_PREFIX, TENANT_COLUMN],
  );
}

/** What one `applyTenantIsolation` run changed. Empty lists mean the database already had it all. */
export interface TenantIsolationChanges {
  /** Every tenant table found, as `schema.table`. */
  tenantTables: string[];
  policiesCreated: string[];
  rowSecurityEnabled: string[];
  rowSecurityForced: string[];
  referenceTriggersCreated: string[];
}

/**
 * Bring every tenant table in `schemas` under row-level isolation: create the policy where it is
 * missing, enable and force row security, and guard every single-column foreign key between tenant
 * tables with the same-tenant trigger. Runs inside the caller's transaction, as the tables' owner
 * (the migration role); the caller holds the shared schema lock. Changes nothing that is in place.
 *
 * `runtimeRole`, when given, loses every write privilege on the two schema ledgers: only the
 * migration role records a migration. `functionSchema` is where the chain created the trigger
 * function (`public`; a test that builds its tables in a schema of its own installs it there).
 */
export async function applyTenantIsolation(
  tx: IsolationSql,
  opts: { schemas?: readonly string[]; runtimeRole?: string; functionSchema?: string } = {},
): Promise<TenantIsolationChanges> {
  const schemas = opts.schemas ?? ['public'];
  const changes: TenantIsolationChanges = {
    tenantTables: [],
    policiesCreated: [],
    rowSecurityEnabled: [],
    rowSecurityForced: [],
    referenceTriggersCreated: [],
  };
  for (const t of await listTenantTables(tx, schemas)) {
    const target = `${quoteIdent(t.schema)}.${quoteIdent(t.table)}`;
    const name = `${t.schema}.${t.table}`;
    changes.tenantTables.push(name);
    if (!t.policy) {
      // A table can hold a policy of this name that does not read the tenant setting (created by
      // hand, or by an older definition): replace it rather than fail on the duplicate name.
      if (t.policyNamed) {
        await tx.unsafe(`DROP POLICY ${quoteIdent(TENANT_POLICY_NAME)} ON ${target}`);
      }
      await tx.unsafe(tenantPolicySql(t.schema, t.table));
      changes.policiesCreated.push(name);
    }
    if (!t.rowSecurity) {
      await tx.unsafe(`ALTER TABLE ${target} ENABLE ROW LEVEL SECURITY`);
      changes.rowSecurityEnabled.push(name);
    }
    if (!t.forced) {
      await tx.unsafe(`ALTER TABLE ${target} FORCE ROW LEVEL SECURITY`);
      changes.rowSecurityForced.push(name);
    }
  }
  for (const r of await unguardedReferences(tx, schemas)) {
    const [stmt] = await rows<{ stmt: string }>(
      tx,
      `SELECT format(
         'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OF %I ON %I.%I FOR EACH ROW EXECUTE FUNCTION %I.%I(%L, %L, %L)',
         $1::text, $2::text, $3::text, $4::text, $8::text, $5::text, $6::text, $2::text, $7::text) AS stmt`,
      [
        r.trigger,
        r.column,
        r.schema,
        r.table,
        SAME_TENANT_FUNCTION,
        r.parent,
        r.constraint,
        opts.functionSchema ?? 'public',
      ],
    );
    if (stmt !== undefined) await tx.unsafe(stmt.stmt);
    changes.referenceTriggersCreated.push(`${r.schema}.${r.table}.${r.constraint}`);
  }
  if (opts.runtimeRole !== undefined) {
    for (const m of MIGRATION_ONLY_TABLES) {
      const [stmt] = await rows<{ stmt: string | null }>(
        tx,
        `SELECT CASE WHEN to_regclass(format('%I.%I', $1::text, $2::text)) IS NULL THEN NULL
                ELSE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE %I.%I FROM %I',
                            $1::text, $2::text, $3::text) END AS stmt`,
        [m.schema, m.table, opts.runtimeRole],
      );
      if (stmt?.stmt) await tx.unsafe(stmt.stmt);
    }
  }
  return changes;
}

/**
 * Whether a SECURITY DEFINER function is one of the platform chain's two lookups, unchanged. A test
 * schema gets them with its own schema in place of `public` (`isolationFunctionsSql`).
 */
function isIsolationDefiner(f: {
  schema: string;
  name: string;
  arguments: string;
  body: string;
  config: string[] | null;
}): boolean {
  const expected = ISOLATION_DEFINER_FUNCTIONS.find(
    (d) => d.name === f.name && d.arguments === f.arguments,
  );
  if (expected === undefined) return false;
  if (f.config?.length !== 1 || f.config[0] !== ISOLATION_DEFINER_SEARCH_PATH) return false;
  const body =
    f.schema === 'public' ? f.body : f.body.replaceAll(`${quoteIdent(f.schema)}.`, 'public.');
  return normalizeFunctionBody(body) === normalizeFunctionBody(expected.body);
}

/** Why a role does not hold the isolated posture; names no host, password or row. */
export interface IsolationFinding {
  check:
    | 'role-attributes'
    | 'role-membership'
    | 'owns-objects'
    | 'can-create'
    | 'tenant-table-policy'
    | 'extra-policy'
    | 'definer-view'
    | 'definer-function'
    | 'truncate-privilege'
    | 'setting-default';
  detail: string;
}

/** The posture of one runtime role, as `verifyTenantIsolation` found it. */
export interface TenantIsolationReport {
  role: string;
  /** True only when `findings` is empty. */
  active: boolean;
  tenantTables: number;
  findings: IsolationFinding[];
}

/**
 * Check, from the catalog, that `role` (default: the connected role) holds the isolated posture:
 *
 *  - it is not a superuser, does not bypass row security and may not create roles or databases, and
 *    neither may any role it can `SET ROLE` to;
 *  - it owns no table, sequence, view, function or schema outside the system schemas, and cannot act
 *    as an owner through membership (an owner can disable row security and grant itself anything);
 *  - it may create nothing: no object in any non-system schema, no schema in the database, no
 *    temporary table;
 *  - every tenant table has row security enabled and forced and carries the tenant policy exactly,
 *    and no other permissive policy (permissive policies are ORed, so one more widens the first);
 *  - it can read no view or materialized view that reaches a tenant table with its owner's rights
 *    (a view runs as its owner unless it is `security_invoker`, and the owner bypasses row security);
 *  - it can call no SECURITY DEFINER function owned by a role that is a superuser or bypasses row
 *    security, except the two lookups the platform chain creates, unchanged;
 *  - it holds no TRUNCATE on a tenant table (TRUNCATE is not subject to row security);
 *  - no role or database default presets the tenant setting, row security, the search path or the
 *    session role, so a fresh session starts with none of them changed.
 *
 * Any finding means the posture is not in force.
 */
export async function verifyTenantIsolation(
  db: IsolationSql,
  opts: { role?: string; schemas?: readonly string[] } = {},
): Promise<TenantIsolationReport> {
  const schemas = opts.schemas ?? ['public'];
  const [who] = await rows<{ role: string; exists: boolean }>(
    db,
    `SELECT coalesce($1::text, current_user::text) AS role,
            EXISTS (SELECT 1 FROM pg_roles WHERE rolname = coalesce($1::text, current_user::text)) AS exists`,
    [opts.role ?? null],
  );
  const role = who?.role ?? opts.role ?? '';
  const findings: IsolationFinding[] = [];
  if (!who?.exists) {
    return {
      role,
      active: false,
      tenantTables: 0,
      findings: [{ check: 'role-attributes', detail: 'the runtime role does not exist' }],
    };
  }

  const [attrs] = await rows<{
    rolsuper: boolean;
    rolbypassrls: boolean;
    rolcreaterole: boolean;
    rolcreatedb: boolean;
  }>(
    db,
    'SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = $1',
    [role],
  );
  const named: string[] = [];
  if (attrs?.rolsuper) named.push('is a superuser');
  if (attrs?.rolbypassrls) named.push('bypasses row security');
  if (attrs?.rolcreaterole) named.push('may create roles');
  if (attrs?.rolcreatedb) named.push('may create databases');
  if (named.length > 0) {
    findings.push({ check: 'role-attributes', detail: `the runtime role ${named.join(', ')}` });
  }

  const powerful = await rows<{ rolname: string }>(
    db,
    `SELECT m.rolname::text AS rolname FROM pg_roles m
      WHERE m.rolname <> $1 AND pg_has_role($1, m.oid, 'MEMBER')
        AND (m.rolsuper OR m.rolbypassrls OR m.rolcreaterole OR m.rolcreatedb)
      ORDER BY 1`,
    [role],
  );
  if (powerful.length > 0) {
    findings.push({
      check: 'role-membership',
      detail:
        'the runtime role can switch to a role that is a superuser, bypasses row security or may ' +
        `create roles or databases: ${powerful.map((p) => p.rolname).join(', ')}`,
    });
  }

  const owned = await rows<{ kind: string; name: string }>(
    db,
    `SELECT 'relation' AS kind, format('%I.%I', n.nspname, c.relname) AS name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
        AND pg_has_role($1, c.relowner, 'MEMBER')
     UNION ALL
     SELECT 'function', format('%I.%I', n.nspname, p.proname)
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
        AND pg_has_role($1, p.proowner, 'MEMBER')
     UNION ALL
     SELECT 'schema', format('%I', n.nspname)
       FROM pg_namespace n
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
        AND pg_has_role($1, n.nspowner, 'MEMBER')
     UNION ALL
     SELECT 'database', format('%I', d.datname)
       FROM pg_database d
      WHERE d.datname = current_database() AND pg_has_role($1, d.datdba, 'MEMBER')
      ORDER BY 1, 2 LIMIT 20`,
    [role],
  );
  if (owned.length > 0) {
    findings.push({
      check: 'owns-objects',
      detail:
        'the runtime role owns, or can act as the owner of: ' +
        owned.map((o) => `${o.kind} ${o.name}`).join(', '),
    });
  }

  const creatable = await rows<{ what: string }>(
    db,
    `SELECT format('schema %I', n.nspname) AS what FROM pg_namespace n
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
        AND has_schema_privilege($1, n.oid, 'CREATE')
     UNION ALL
     SELECT 'schemas in the database' WHERE has_database_privilege($1, current_database(), 'CREATE')
     UNION ALL
     SELECT 'temporary tables' WHERE has_database_privilege($1, current_database(), 'TEMPORARY')
     ORDER BY 1`,
    [role],
  );
  if (creatable.length > 0) {
    findings.push({
      check: 'can-create',
      detail: `the runtime role may create objects: ${creatable.map((c) => c.what).join(', ')}`,
    });
  }

  const tables = await listTenantTables(db, schemas);
  const unprotected = tables.filter((t) => !t.rowSecurity || !t.forced || !t.policy);
  if (unprotected.length > 0) {
    findings.push({
      check: 'tenant-table-policy',
      detail:
        'tenant tables without an enabled, forced tenant policy: ' +
        unprotected.map((t) => `${t.schema}.${t.table}`).join(', '),
    });
  }

  const widened = tables.filter((t) => t.otherPolicies.length > 0);
  if (widened.length > 0) {
    findings.push({
      check: 'extra-policy',
      detail:
        'tenant tables with a permissive policy besides the tenant policy: ' +
        widened.map((t) => `${t.schema}.${t.table} (${t.otherPolicies.join(', ')})`).join(', '),
    });
  }

  // A view (or a materialized view) that reads a tenant table as its owner, reachable by the role:
  // readable itself, or through another view it can read that depends on it.
  const views = await rows<{ name: string }>(
    db,
    `WITH RECURSIVE edges AS (
       SELECT DISTINCT r.ev_class AS view, d.refobjid AS ref
         FROM pg_rewrite r
         JOIN pg_depend d ON d.classid = 'pg_rewrite'::regclass AND d.objid = r.oid
                         AND d.refclassid = 'pg_class'::regclass AND d.refobjid <> r.ev_class
     ), reach AS (
       SELECT view, ref FROM edges
       UNION
       SELECT r.view, e.ref FROM reach r JOIN edges e ON e.view = r.ref
     ), tenant_tables AS (
       SELECT c.oid FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = $3 AND NOT a.attisdropped
        WHERE c.relkind IN ('r', 'p') AND n.nspname = ANY($2::text[])
     ), definer AS (
       SELECT v.oid FROM pg_class v
         JOIN pg_namespace n ON n.oid = v.relnamespace
        WHERE v.relkind IN ('v', 'm')
          AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
          AND (v.relkind = 'm' OR NOT EXISTS (
                SELECT 1 FROM unnest(coalesce(v.reloptions, '{}'::text[])) AS o
                 WHERE lower(o) IN ('security_invoker=true', 'security_invoker=on',
                                    'security_invoker=yes', 'security_invoker=1')))
          AND EXISTS (SELECT 1 FROM reach r JOIN tenant_tables t ON t.oid = r.ref WHERE r.view = v.oid)
     )
     SELECT format('%I.%I', n.nspname, v.relname) AS name
       FROM definer d JOIN pg_class v ON v.oid = d.oid JOIN pg_namespace n ON n.oid = v.relnamespace
      WHERE has_table_privilege($1, v.oid, 'SELECT')
         OR EXISTS (SELECT 1 FROM reach r WHERE r.ref = v.oid AND has_table_privilege($1, r.view, 'SELECT'))
      ORDER BY 1`,
    [role, schemas, TENANT_COLUMN],
  );
  if (views.length > 0) {
    findings.push({
      check: 'definer-view',
      detail:
        "the runtime role can read a view that reads tenant tables with its owner's rights: " +
        views.map((v) => v.name).join(', '),
    });
  }

  const definers = await rows<{
    schema: string;
    name: string;
    arguments: string;
    body: string;
    config: string[] | null;
  }>(
    db,
    `SELECT n.nspname::text AS schema, p.proname::text AS name,
            pg_get_function_identity_arguments(p.oid) AS arguments, p.prosrc AS body,
            p.proconfig AS config
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       JOIN pg_roles o ON o.oid = p.proowner
      WHERE p.prosecdef AND (o.rolsuper OR o.rolbypassrls)
        AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
        AND has_function_privilege($1, p.oid, 'EXECUTE')
      ORDER BY 1, 2, 3`,
    [role],
  );
  const unexpected = definers.filter((f) => !isIsolationDefiner(f));
  if (unexpected.length > 0) {
    findings.push({
      check: 'definer-function',
      detail:
        'the runtime role can call a function that runs with the rights of a role that bypasses ' +
        `row security: ${unexpected.map((f) => `${f.schema}.${f.name}(${f.arguments})`).join(', ')}`,
    });
  }

  const truncatable = await rows<{ name: string }>(
    db,
    `SELECT format('%I.%I', n.nspname, c.relname) AS name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = $3 AND NOT a.attisdropped
      WHERE c.relkind IN ('r', 'p') AND n.nspname = ANY($2::text[])
        AND has_table_privilege($1, c.oid, 'TRUNCATE')
      ORDER BY 1`,
    [role, schemas, TENANT_COLUMN],
  );
  if (truncatable.length > 0) {
    findings.push({
      check: 'truncate-privilege',
      detail: `the runtime role may truncate tenant tables: ${truncatable.map((t) => t.name).join(', ')}`,
    });
  }

  const presets = await rows<{ scope: string; name: string }>(
    db,
    `SELECT DISTINCT CASE WHEN s.setrole = 0 THEN 'database default' ELSE 'role default' END AS scope,
            split_part(cfg, '=', 1) AS name
       FROM pg_db_role_setting s
       CROSS JOIN LATERAL unnest(s.setconfig) AS cfg
      WHERE (s.setrole = 0 OR s.setrole = (SELECT oid FROM pg_roles WHERE rolname = $1))
        AND (s.setdatabase = 0 OR s.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database()))
        AND lower(split_part(cfg, '=', 1)) = ANY($2::text[])
      ORDER BY 1, 2`,
    [role, [...ISOLATION_SETTINGS]],
  );
  if (presets.length > 0) {
    findings.push({
      check: 'setting-default',
      detail:
        'a session default presets a setting that bears on isolation: ' +
        presets.map((p) => `${p.name} (${p.scope})`).join(', '),
    });
  }

  return { role, active: findings.length === 0, tenantTables: tables.length, findings };
}
