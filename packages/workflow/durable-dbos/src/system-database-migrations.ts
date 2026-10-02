/**
 * The workflow system database's own schema, applied by the migration role.
 *
 * DBOS creates and migrates its system database the first time it launches, over the connection it
 * launches with. With role separation that connection is the runtime role, which may create nothing,
 * so the schema must already be in place when the durable worker starts: this runs the same
 * migrations, from the same installed SDK, over a connection as the migration role. On a system
 * database that is already at the SDK's version it only reads the version. The runtime role's access
 * to the tables it creates comes from the migration role's default privileges in that database, which
 * the setup SQL (`database-roles.sql`, kind `workflow-system`) grants.
 *
 * The SDK's `exports` map exposes only `.` and `./datasource`, so its system-database module has no
 * bare specifier; it is loaded beside the SDK entrypoint, the way `scheduled-workflow.ts` loads the
 * crontab matcher. A missing module is an installation fault and says so.
 */
import { createRequire } from 'node:module';
import path from 'node:path';

type EnsureSystemDatabase = (url: string, logger: SystemDatabaseLogger) => Promise<void>;

interface SystemDatabaseLogger {
  debug(message: unknown): void;
  info(message: unknown): void;
  warn(message: unknown): void;
  error(message: unknown): void;
}

let ensure: EnsureSystemDatabase | undefined;

function loadEnsureSystemDatabase(): EnsureSystemDatabase {
  if (ensure === undefined) {
    try {
      const req = createRequire(import.meta.url);
      const sdkDir = path.dirname(req.resolve('@dbos-inc/dbos-sdk'));
      const mod = req(path.join(sdkDir, 'system_database.js')) as {
        ensureSystemDatabase?: unknown;
      };
      if (typeof mod.ensureSystemDatabase !== 'function') {
        throw new Error('ensureSystemDatabase is missing');
      }
      ensure = mod.ensureSystemDatabase as EnsureSystemDatabase;
    } catch (e) {
      throw new Error(
        "the workflow system database migrations could not be loaded from the installed '@dbos-inc/dbos-sdk' " +
          `(expected 'system_database.js' beside its entrypoint): ${e instanceof Error ? e.message : String(e)}. ` +
          'This is an SDK-layout fault.',
      );
    }
  }
  return ensure;
}

/**
 * Load the workflow engine's system-database migration module now, so a later migration runs code
 * that was read before anything else could change the installation. Throws the same SDK-layout
 * fault the migration itself would.
 */
export function preloadWorkflowSystemMigrations(): void {
  loadEnsureSystemDatabase();
}

/**
 * Apply the workflow engine's system-database migrations over `migrationUrl`, a connection to the
 * workflow system database as the migration role. The database itself must exist: the migration
 * role may not create databases. SDK log lines go to `log` (default: dropped), never to stdout.
 */
export async function migrateWorkflowSystemDatabase(
  migrationUrl: string,
  log: (line: string) => void = () => {},
): Promise<void> {
  const text = (m: unknown) => (typeof m === 'string' ? m : String(m));
  await loadEnsureSystemDatabase()(migrationUrl, {
    debug: () => {},
    info: (m) => log(text(m)),
    warn: (m) => log(text(m)),
    error: (m) => log(text(m)),
  });
}
