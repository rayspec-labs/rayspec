/**
 * Test-support: a throwaway database set up the way the isolated posture expects — three roles of its
 * own created by the shipped setup SQL (`sql/database-roles.sql`), a connection URL for each, and
 * nothing migrated yet. A test migrates it as the migration role, enables isolation, and then works
 * as the runtime role, so what it proves holds for the role a deployment serves with, not for a
 * superuser.
 *
 * Every database and role name carries a random suffix, so suites running at the same time on one
 * server never share a role or a database, and `drop()` removes all of it. Test-support only —
 * exported via `@rayspec/db/testing`, never the main `@rayspec/db` barrel.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { type DatabaseRoleNames, prepareDatabaseRoles } from './database-roles.js';
import { migrationsDir } from './migrations.js';
import { applyTenantIsolation, type IsolationSql } from './tenant-isolation.js';

/** One throwaway isolated database and its roles. */
export interface IsolatedTestDatabase {
  /** The application database's name. */
  name: string;
  /** The workflow system database's name (`<name>_dbos_sys`), when one was requested. */
  workflowSystemName?: string;
  roles: DatabaseRoleNames;
  /** Connection URLs to the application database, one per role, plus the superuser's. */
  urls: { admin: string; migration: string; runtime: string; snapshot: string };
  /** The same four for the workflow system database, when one was requested. */
  workflowSystemUrls?: { admin: string; migration: string; runtime: string; snapshot: string };
  /** Drop the databases and the roles. */
  drop(): Promise<void>;
}

function withCredentials(base: string, db: string, user?: string, password?: string): string {
  const u = new URL(base);
  u.pathname = `/${db}`;
  if (user !== undefined) {
    u.username = user;
    u.password = password ?? '';
  }
  return u.toString();
}

/**
 * Create the databases and roles on the server `adminUrl` (a superuser connection) points at.
 * `workflowSystem: true` also creates and prepares `<name>_dbos_sys` for the durable worker.
 */
export async function createIsolatedTestDatabase(
  adminUrl: string,
  opts: { workflowSystem?: boolean } = {},
): Promise<IsolatedTestDatabase> {
  const suffix = randomBytes(5).toString('hex');
  const name = `rayspec_iso_${suffix}`;
  const roles: DatabaseRoleNames = {
    migration: `rs_iso_${suffix}_migrator`,
    runtime: `rs_iso_${suffix}_runtime`,
    snapshot: `rs_iso_${suffix}_snapshot`,
  };
  const passwords = {
    migration: randomBytes(12).toString('hex'),
    runtime: randomBytes(12).toString('hex'),
    snapshot: randomBytes(12).toString('hex'),
  };
  const databases = opts.workflowSystem ? [name, `${name}_dbos_sys`] : [name];
  const server = postgres(withCredentials(adminUrl, 'postgres'), { max: 1, onnotice: () => {} });
  try {
    for (const db of databases) await server.unsafe(`CREATE DATABASE "${db}"`);
  } finally {
    await server.end();
  }
  for (const [index, db] of databases.entries()) {
    const admin = postgres(withCredentials(adminUrl, db), { max: 1, onnotice: () => {} });
    try {
      await prepareDatabaseRoles(admin, {
        roles,
        kind: index === 0 ? 'application' : 'workflow-system',
      });
      if (index === 0) {
        for (const key of ['migration', 'runtime', 'snapshot'] as const) {
          const [stmt] = (await admin.unsafe('SELECT format($3, $1::text, $2::text) AS stmt', [
            roles[key],
            passwords[key],
            'ALTER ROLE %I PASSWORD %L',
          ])) as unknown as { stmt: string }[];
          if (stmt !== undefined) await admin.unsafe(stmt.stmt);
        }
      }
    } finally {
      await admin.end();
    }
  }
  const urlsFor = (db: string) => ({
    admin: withCredentials(adminUrl, db),
    migration: withCredentials(adminUrl, db, roles.migration, passwords.migration),
    runtime: withCredentials(adminUrl, db, roles.runtime, passwords.runtime),
    snapshot: withCredentials(adminUrl, db, roles.snapshot, passwords.snapshot),
  });
  const system = databases[1];
  return {
    name,
    ...(system !== undefined ? { workflowSystemName: system } : {}),
    roles,
    urls: urlsFor(name),
    ...(system !== undefined ? { workflowSystemUrls: urlsFor(system) } : {}),
    async drop(): Promise<void> {
      const cleanup = postgres(withCredentials(adminUrl, 'postgres'), {
        max: 1,
        onnotice: () => {},
      });
      try {
        for (const db of databases) {
          await cleanup.unsafe(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
        }
        for (const role of [roles.runtime, roles.snapshot, roles.migration]) {
          await cleanup.unsafe(`DROP ROLE IF EXISTS "${role}"`);
        }
      } finally {
        await cleanup.end();
      }
    },
  };
}

/** The platform migration that creates the tenant policies and the isolation functions. */
const ISOLATION_MIGRATION = '0015_tenant_row_security.sql';

/**
 * The platform chain's three isolation functions (the run-ownership probe, the invite resolution and
 * the same-tenant reference trigger), as statements that create them in `schema` instead of `public`
 * — taken from the committed migration, so a test schema gets exactly what a deployment gets.
 */
export function isolationFunctionsSql(schema: string): string[] {
  const text = readFileSync(join(migrationsDir(), ISOLATION_MIGRATION), 'utf8');
  const quoted = `"${schema.replaceAll('"', '""')}"`;
  return text
    .split('--> statement-breakpoint')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.startsWith('CREATE FUNCTION'))
    .map((stmt) => stmt.replaceAll('"public".', `${quoted}.`).replaceAll('public.', `${quoted}.`));
}

/** A role a hand-built test schema is served as, and the URL that connects as it. */
export interface TestRuntimeRole {
  role: string;
  url: string;
  /** Drop the role (after every pool connecting as it has ended). */
  drop(): Promise<void>;
}

/**
 * Put a hand-built test schema under the isolated posture and create a runtime role for it:
 * `admin` (a superuser connection) installs the isolation functions in `schema`, enables and forces
 * the tenant policy on every tenant table there, and grants a new login role — no superuser, no
 * BYPASSRLS, owner of nothing — exactly the privileges the setup SQL grants the runtime role. The
 * role's name derives from the schema, so suites that run at the same time never share one.
 */
export async function isolateTestSchema(
  admin: IsolationSql & { begin<T>(fn: (tx: IsolationSql) => Promise<T>): Promise<T> },
  adminUrl: string,
  schema: string,
): Promise<TestRuntimeRole> {
  const role = `${schema}_runtime`.slice(0, 63);
  const password = randomBytes(12).toString('hex');
  await admin.begin(async (tx) => {
    // A hand-built schema may hold only some core tables; a lookup over a table it lacks is created
    // unchecked and is simply never called.
    await tx.unsafe('SET LOCAL check_function_bodies = off');
    for (const stmt of isolationFunctionsSql(schema)) await tx.unsafe(stmt);
    await applyTenantIsolation(tx, { schemas: [schema], functionSchema: schema });
  });
  const [exists] = (await admin.unsafe(
    'SELECT count(*)::int AS n FROM pg_roles WHERE rolname = $1',
    [role],
  )) as unknown as { n: number }[];
  const statements = [
    ...((exists?.n ?? 0) === 0 ? ['CREATE ROLE %I'] : []),
    'ALTER ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB',
    'GRANT USAGE ON SCHEMA %2$I TO %1$I',
    'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %2$I TO %1$I',
    'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %2$I TO %1$I',
    'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA %2$I TO %1$I',
    'ALTER ROLE %1$I PASSWORD %3$L',
  ];
  for (const template of statements) {
    const [stmt] = (await admin.unsafe('SELECT format($1, $2::text, $3::text, $4::text) AS stmt', [
      template,
      role,
      schema,
      password,
    ])) as unknown as { stmt: string }[];
    if (stmt !== undefined) await admin.unsafe(stmt.stmt);
  }
  const url = new URL(adminUrl);
  url.username = role;
  url.password = password;
  return {
    role,
    url: url.toString(),
    async drop(): Promise<void> {
      const [stmt] = (await admin.unsafe(
        "SELECT format('DROP OWNED BY %1$I; DROP ROLE IF EXISTS %1$I', $1::text) AS stmt",
        [role],
      )) as unknown as { stmt: string }[];
      if (stmt !== undefined) await admin.unsafe(stmt.stmt);
    },
  };
}

/**
 * Whether this run puts hand-built test schemas under the isolated posture. Any value other than
 * `roles` or unset throws, so a mistyped lane never runs as the superuser while claiming otherwise.
 */
export function testDatabaseIsolation(): boolean {
  const value = process.env.RAYSPEC_TEST_DATABASE_ISOLATION;
  if (value === undefined || value === '') return false;
  if (value === 'roles') return true;
  throw new Error(`RAYSPEC_TEST_DATABASE_ISOLATION must be 'roles' or unset, not '${value}'.`);
}

/**
 * Throw unless `sql` is connected as `role`, and that role is no superuser and does not bypass row
 * security: a suite that claims to run as the runtime role checks it once, from inside the session.
 */
export async function assertConnectedAsRuntimeRole(sql: IsolationSql, role: string): Promise<void> {
  const [who] = (await sql.unsafe(
    `SELECT current_user::text AS name, r.rolsuper AS super, r.rolbypassrls AS bypass
       FROM pg_roles r WHERE r.rolname = current_user`,
  )) as { name: string; super: boolean; bypass: boolean }[];
  if (who === undefined || who.name !== role || who.super || who.bypass) {
    throw new Error(
      `expected a session as the runtime role ${role} (no superuser, no BYPASSRLS), got ` +
        `${who === undefined ? 'no role' : `${who.name} (superuser ${who.super}, bypass ${who.bypass})`}.`,
    );
  }
}
