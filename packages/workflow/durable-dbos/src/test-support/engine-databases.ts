/**
 * Test-support: the databases a suite's workflow engine and schedulers run against.
 *
 * Normally they run over the suite's own handle (`admin`, the superuser that built the test schema)
 * and the engine launches with the superuser's workflow system database URL. In the runtime-role lane
 * (RAYSPEC_TEST_DATABASE_ISOLATION=roles) they run in the posture a role-separated deployment serves
 * in: the application side over a runtime role of the schema's own (no superuser, no BYPASSRLS, owner
 * of nothing) with every tenant table's policy enabled and forced, and the engine over a runtime role
 * in a workflow system database prepared by the shipped setup SQL and migrated as the migration role
 * first — the same steps the server's boot takes. `admin` stays the handle the suite seeds and
 * inspects through.
 *
 * Call `runtimeAppDb` / `engineDatabases` after the suite's DDL: the tenant tables that exist then are
 * the ones put under row security. Excluded from the package build.
 */
import { type Db, requireTenantContext } from '@rayspec/db';
import {
  createRuntimeRoleLane,
  type RuntimeRoleLane,
  testAppDb,
  testDatabaseIsolation,
} from '@rayspec/db/testing';
import { migrateWorkflowSystemDatabase } from '../system-database-migrations.js';

/** The application-side handle code under test runs over. */
export interface RuntimeAppDb {
  /** `admin` itself, or the runtime role's handle over the same schema. */
  readonly appDb: Db;
  /** Whether this is the runtime-role lane. */
  readonly runtimeRole: boolean;
  /**
   * A handle derived from `appDb` (a wrapping proxy) marked like `appDb`: in the lane every chokepoint
   * statement on it runs under the tenant context. Returned unchanged otherwise.
   */
  serving<D extends Db>(handle: D): D;
  /** End the runtime role's pool and drop the role. */
  close(): Promise<void>;
}

export async function runtimeAppDb(opts: {
  /** The suite's own handle over `schema` (a superuser connection). */
  admin: Db;
  /** The superuser URL `admin` was opened with. */
  adminUrl: string;
  schema: string;
  /** Pool size of the runtime role's handle (default: the testing factory's). */
  poolMax?: number;
}): Promise<RuntimeAppDb> {
  const app = await testAppDb(opts.admin, opts.adminUrl, opts.schema, opts.poolMax);
  return {
    ...app,
    serving: (handle) => (app.runtimeRole ? requireTenantContext(handle) : handle),
  };
}

/** The workflow system database the engine launches with. */
export interface WorkflowSystemDatabase {
  readonly url: string;
  /** Drop the lane's roles (and the database, when the lane created it) after the engine shut down. */
  close(): Promise<void>;
}

/**
 * `adminUrl` (the superuser's URL of the workflow system database) itself, or in the lane the runtime
 * role's URL of that database, created and prepared by the setup SQL and migrated as the migration
 * role.
 */
export async function workflowSystemDatabase(adminUrl: string): Promise<WorkflowSystemDatabase> {
  if (!testDatabaseIsolation()) return { url: adminUrl, close: async () => {} };
  const lane: RuntimeRoleLane = createRuntimeRoleLane();
  try {
    const system = await lane.prepare(adminUrl, 'workflow-system');
    if (system === undefined) {
      throw new Error('the runtime-role lane could not prepare the workflow system database.');
    }
    await migrateWorkflowSystemDatabase(system.migration);
    return { url: system.runtime, close: () => lane.drop() };
  } catch (error) {
    await lane.drop().catch(() => {});
    throw error;
  }
}

/** Both sides of an engine: {@link runtimeAppDb} and {@link workflowSystemDatabase}. */
export interface EngineDatabases extends RuntimeAppDb {
  /** The workflow system database URL the engine launches with. */
  readonly systemDatabaseUrl: string;
}

export async function engineDatabases(opts: {
  admin: Db;
  adminUrl: string;
  schema: string;
  /** The superuser URL of the workflow system database the engine would launch with. */
  systemDatabaseUrl: string;
  poolMax?: number;
}): Promise<EngineDatabases> {
  const app = await runtimeAppDb(opts);
  let system: WorkflowSystemDatabase;
  try {
    system = await workflowSystemDatabase(opts.systemDatabaseUrl);
  } catch (error) {
    await app.close().catch(() => {});
    throw error;
  }
  return {
    ...app,
    systemDatabaseUrl: system.url,
    async close() {
      await app.close();
      await system.close();
    },
  };
}
