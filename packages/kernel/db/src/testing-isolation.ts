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
import { type Db, makeDbWithSchema } from './client.js';
import {
  type DatabaseKind,
  type DatabaseRoleNames,
  prepareDatabaseRoles,
} from './database-roles.js';
import { migrationsDir } from './migrations.js';
import { requireTenantContext } from './tenant-db.js';
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
 * the same-tenant reference trigger), as statements that create (or replace) them in `schema` instead
 * of `public` — taken from the committed migration, so a test schema gets exactly what a deployment
 * gets.
 */
export function isolationFunctionsSql(schema: string): string[] {
  const text = readFileSync(join(migrationsDir(), ISOLATION_MIGRATION), 'utf8');
  const quoted = `"${schema.replaceAll('"', '""')}"`;
  // OR REPLACE, so a schema isolated a second time (another executor in the same suite) gets the
  // same functions again instead of an error.
  return text
    .split('--> statement-breakpoint')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.startsWith('CREATE FUNCTION'))
    .map((stmt) => `CREATE OR REPLACE FUNCTION${stmt.slice('CREATE FUNCTION'.length)}`)
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

/** The handle a suite's code under test runs over, and how to release it. */
export interface TestAppDb<D> {
  /** `admin` itself, or the runtime role's handle over the same schema. */
  readonly appDb: D;
  /** Whether this is the runtime-role lane. */
  readonly runtimeRole: boolean;
  /** End the runtime role's pool and drop the role (a no-op outside the lane). */
  close(): Promise<void>;
}

/**
 * The handle code under test runs over, for a suite's own hand-built `schema` (built by `admin`, a
 * superuser handle opened with `adminUrl`). Outside the runtime-role lane, `admin` itself. In the lane
 * (RAYSPEC_TEST_DATABASE_ISOLATION=roles), a runtime role of the schema's own (no superuser, no
 * BYPASSRLS, owner of nothing) with every tenant table of the schema under the enabled, forced tenant
 * policy, its pool marked with `requireTenantContext` as the server marks the runtime role's, and
 * checked from inside a session. `admin` stays the handle the suite seeds and inspects through. Call
 * it after the schema's DDL: the tables that exist then are the ones put under row security.
 */
export async function testAppDb<D extends Db>(
  admin: D,
  adminUrl: string,
  schema: string,
  poolMax?: number,
): Promise<TestAppDb<D>> {
  if (!testDatabaseIsolation()) {
    return { appDb: admin, runtimeRole: false, close: async () => {} };
  }
  const role = await isolateTestSchema(admin.$client, adminUrl, schema);
  const appDb = requireTenantContext(makeDbWithSchema(role.url, schema, poolMax)) as unknown as D;
  try {
    await assertConnectedAsRuntimeRole(appDb.$client, role.role);
  } catch (error) {
    await appDb.$client.end();
    await role.drop();
    throw error;
  }
  return {
    appDb,
    runtimeRole: true,
    async close() {
      await appDb.$client.end();
      await role.drop();
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

/** The connection URLs of one database for each role of a {@link RuntimeRoleLane}. */
export interface RuntimeRoleLaneUrls {
  migration: string;
  runtime: string;
  snapshot: string;
}

/**
 * The runtime-role lane of a suite that boots whole servers (or runs the CLI) on databases it creates
 * itself: one set of roles for the test file, prepared in every database a boot uses, so the boot can
 * migrate as the migration role and serve as the runtime role instead of as the superuser the suite
 * connects with.
 */
export interface RuntimeRoleLane {
  readonly roles: DatabaseRoleNames;
  /**
   * Prepare the lane's roles in the database `adminUrl` (a superuser connection) names and return
   * that database's URL for each role; `kind` says which setup the database gets. A workflow system
   * database that does not exist yet is created. Undefined, and nothing changed, when the database
   * cannot be reached or `adminUrl` is not a superuser: a boot that is meant to fail before it
   * touches a database fails the same way. Tables already in the database pass to the migration
   * role, as the setup SQL does for an existing deployment. Throws for the database the run shares
   * (see {@link createRuntimeRoleLane}).
   */
  prepare(adminUrl: string, kind: DatabaseKind): Promise<RuntimeRoleLaneUrls | undefined>;
  /**
   * For a boot configured with the superuser's `databaseUrl` and `systemDatabaseUrl` (its workflow
   * system database): prepare both and return the four connections of role separation. Undefined,
   * and nothing changed, when the application database cannot be reached.
   */
  bootUrls(
    databaseUrl: string,
    systemDatabaseUrl: string,
  ): Promise<RuntimeRoleLaneBootUrls | undefined>;
  /** Drop what the roles own in every database the lane prepared, the databases it created, and the roles. */
  drop(): Promise<void>;
}

/** The connections a role-separated boot takes, as the server's configuration names them. */
export interface RuntimeRoleLaneBootUrls {
  databaseUrl: string;
  migrationDatabaseUrl: string;
  dbosSystemDatabaseUrl: string;
  migrationDbosSystemDatabaseUrl: string;
}

/**
 * Create a lane with role names of its own (a random suffix), valid until `drop()`. The database the
 * run shares is read from `DATABASE_URL` now, before a suite points that variable at its own.
 */
export function createRuntimeRoleLane(): RuntimeRoleLane {
  const suffix = randomBytes(5).toString('hex');
  const roles: DatabaseRoleNames = {
    migration: `rs_lane_${suffix}_migrator`,
    runtime: `rs_lane_${suffix}_runtime`,
    snapshot: `rs_lane_${suffix}_snapshot`,
  };
  const passwords = {
    migration: randomBytes(12).toString('hex'),
    runtime: randomBytes(12).toString('hex'),
    snapshot: randomBytes(12).toString('hex'),
  };
  /** Database name → a superuser URL to it, for every database the lane prepared. */
  const prepared = new Map<string, string>();
  const created = new Set<string>();
  let passwordsSet = false;

  const databaseOf = (url: string): string => decodeURIComponent(new URL(url).pathname.slice(1));
  const sharedUrl = process.env.DATABASE_URL;
  const sharedDatabase =
    sharedUrl !== undefined && sharedUrl !== '' ? databaseOf(sharedUrl) : undefined;
  const withDatabase = (url: string, db: string): string => {
    const u = new URL(url);
    u.pathname = `/${db}`;
    return u.toString();
  };
  const as = (url: string, key: keyof DatabaseRoleNames): string => {
    const u = new URL(url);
    u.username = roles[key];
    u.password = passwords[key];
    return u.toString();
  };

  async function exists(adminUrl: string, db: string): Promise<boolean> {
    const server = postgres(withDatabase(adminUrl, 'postgres'), { max: 1, onnotice: () => {} });
    try {
      const rows = (await server.unsafe('SELECT 1 FROM pg_database WHERE datname = $1', [
        db,
      ])) as unknown as unknown[];
      return rows.length > 0;
    } finally {
      await server.end();
    }
  }

  let queue: Promise<unknown> = Promise.resolve();

  async function prepareOnce(
    adminUrl: string,
    kind: DatabaseKind,
  ): Promise<RuntimeRoleLaneUrls | undefined> {
    const db = databaseOf(adminUrl);
    if (db === '') return undefined;
    // The setup SQL hands every existing table to the migration role, and `drop()` drops what the
    // roles own: never do that to the database the whole test run shares.
    if (sharedDatabase !== undefined && sharedDatabase === db) {
      throw new Error(
        `the runtime-role lane will not prepare '${db}', the database every suite shares; ` +
          "boot on a database of the suite's own.",
      );
    }
    let reachable: boolean;
    try {
      reachable = await exists(adminUrl, db);
    } catch {
      return undefined;
    }
    if (!reachable) {
      if (kind === 'application') return undefined;
      const server = postgres(withDatabase(adminUrl, 'postgres'), { max: 1, onnotice: () => {} });
      try {
        const [stmt] = (await server.unsafe(
          "SELECT format('CREATE DATABASE %I', $1::text) AS stmt",
          [db],
        )) as unknown as { stmt: string }[];
        if (stmt !== undefined) await server.unsafe(stmt.stmt);
      } finally {
        await server.end();
      }
      created.add(db);
    }
    const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
    try {
      const [who] = (await admin.unsafe(
        'SELECT rolsuper AS super FROM pg_roles WHERE rolname = current_user',
      )) as unknown as { super: boolean }[];
      if (who?.super !== true) return undefined;
      await prepareDatabaseRoles(admin, { roles, kind });
      if (!passwordsSet) {
        for (const key of ['migration', 'runtime', 'snapshot'] as const) {
          const [stmt] = (await admin.unsafe(
            "SELECT format('ALTER ROLE %I PASSWORD %L', $1::text, $2::text) AS stmt",
            [roles[key], passwords[key]],
          )) as unknown as { stmt: string }[];
          if (stmt !== undefined) await admin.unsafe(stmt.stmt);
        }
        passwordsSet = true;
      }
    } finally {
      await admin.end();
    }
    prepared.set(db, adminUrl);
    return {
      migration: as(adminUrl, 'migration'),
      runtime: as(adminUrl, 'runtime'),
      snapshot: as(adminUrl, 'snapshot'),
    };
  }

  const lane: RuntimeRoleLane = {
    roles,
    async bootUrls(databaseUrl, systemDatabaseUrl) {
      const app = await lane.prepare(databaseUrl, 'application');
      if (app === undefined) return undefined;
      const system = await lane.prepare(systemDatabaseUrl, 'workflow-system');
      if (system === undefined) {
        throw new Error('the runtime-role lane could not prepare the workflow system database.');
      }
      return {
        databaseUrl: app.runtime,
        migrationDatabaseUrl: app.migration,
        dbosSystemDatabaseUrl: system.runtime,
        migrationDbosSystemDatabaseUrl: system.migration,
      };
    },
    prepare(adminUrl, kind) {
      // One preparation at a time: a boot and a tenant ensure racing on one database both prepare it,
      // and two runs of the setup SQL at once would contend on the same role and grant rows.
      const run = queue.then(() => prepareOnce(adminUrl, kind));
      queue = run.catch(() => {});
      return run;
    },
    async drop() {
      const names = [roles.runtime, roles.snapshot, roles.migration];
      let anyUrl: string | undefined;
      for (const [db, adminUrl] of prepared) {
        anyUrl = adminUrl;
        if (!(await exists(adminUrl, db))) continue;
        if (created.has(db)) {
          const server = postgres(withDatabase(adminUrl, 'postgres'), {
            max: 1,
            onnotice: () => {},
          });
          try {
            const [stmt] = (await server.unsafe(
              "SELECT format('DROP DATABASE IF EXISTS %I WITH (FORCE)', $1::text) AS stmt",
              [db],
            )) as unknown as { stmt: string }[];
            if (stmt !== undefined) await server.unsafe(stmt.stmt);
          } finally {
            await server.end();
          }
          continue;
        }
        const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
        try {
          const [stmt] = (await admin.unsafe(
            "SELECT format('DROP OWNED BY %I, %I, %I CASCADE', $1::text, $2::text, $3::text) AS stmt",
            names,
          )) as unknown as { stmt: string }[];
          if (stmt !== undefined) await admin.unsafe(stmt.stmt);
        } finally {
          await admin.end();
        }
      }
      if (anyUrl === undefined) return;
      const server = postgres(withDatabase(anyUrl, 'postgres'), { max: 1, onnotice: () => {} });
      try {
        for (const role of names) {
          const [stmt] = (await server.unsafe(
            "SELECT format('DROP ROLE IF EXISTS %I', $1::text) AS stmt",
            [role],
          )) as unknown as { stmt: string }[];
          if (stmt !== undefined) await server.unsafe(stmt.stmt);
        }
      } finally {
        await server.end();
      }
    },
  };
  return lane;
}

/** The connections {@link runtimeRoleEnv} hands a child process, and how to release them. */
export interface RuntimeRoleEnv {
  /** The variables to put in the child's environment. */
  readonly env: Readonly<Record<string, string>>;
  /** Whether this is the runtime-role lane. */
  readonly runtimeRole: boolean;
  /** Drop the lane's roles once the child has exited and the suite is done with the database. */
  drop(): Promise<void>;
}

/**
 * The tenant tables of the database `adminUrl` (a superuser connection) names whose row security is
 * not both enabled and forced: none once a role-separated boot has run.
 */
export async function tablesWithoutForcedRowSecurity(adminUrl: string): Promise<string[]> {
  const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    const rows = (await sql.unsafe(
      `SELECT c.relname::text AS name
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
          AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
        ORDER BY 1`,
    )) as unknown as { name: string }[];
    return rows.map((r) => r.name);
  } finally {
    await sql.end();
  }
}

/**
 * The database connections a suite hands a server or CLI it spawns as a child process. Outside the
 * runtime-role lane, the one superuser connection the suite created its throwaway database with. In
 * the lane (RAYSPEC_TEST_DATABASE_ISOLATION=roles) a lane's own three roles are prepared in that
 * database and its workflow system database by the shipped setup SQL, and the child is handed role
 * separation — `RAYSPEC_MIGRATION_DATABASE_URL` for the migration role, `DATABASE_URL` for the runtime
 * role, `DBOS_SYSTEM_DATABASE_URL` for the engine — exactly as an operator turns it on. The suite
 * keeps its superuser connection for seeding and inspecting. Call it after the suite's own schema
 * work: tables already there pass to the migration role, as the setup SQL does for an existing
 * deployment.
 */
export async function runtimeRoleEnv(
  databaseUrl: string,
  systemDatabaseUrl: string,
): Promise<RuntimeRoleEnv> {
  if (!testDatabaseIsolation()) {
    return { env: { DATABASE_URL: databaseUrl }, runtimeRole: false, drop: async () => {} };
  }
  const lane = createRuntimeRoleLane();
  const urls = await lane.bootUrls(databaseUrl, systemDatabaseUrl);
  if (urls === undefined) {
    await lane.drop();
    throw new Error(`the runtime-role lane could not reach the suite's database.`);
  }
  return {
    env: {
      DATABASE_URL: urls.databaseUrl,
      RAYSPEC_MIGRATION_DATABASE_URL: urls.migrationDatabaseUrl,
      DBOS_SYSTEM_DATABASE_URL: urls.dbosSystemDatabaseUrl,
    },
    runtimeRole: true,
    drop: () => lane.drop(),
  };
}
