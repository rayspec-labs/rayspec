/**
 * The connections a process that runs application code must never hold.
 *
 * With role separation the boot's schema work runs as the migration role
 * (`RAYSPEC_MIGRATION_DATABASE_URL`), and an operator who exports from the same environment may also
 * have set the snapshot role's connection (`RAYSPEC_SNAPSHOT_DATABASE_URL`), which serving never
 * uses. The migration role can write past the export fence and is not subject to row-level security,
 * so a process that imports the application's handlers or extensions holds neither:
 *
 *  - the entrypoint re-executes itself without them in its environment block
 *    (`supervisor-handoff.ts`), and reads them from the handoff;
 *  - it takes them out of `process.env` before the configuration is read (this module), so no child
 *    process inherits them;
 *  - it supervises: the application runs in a child process started with an environment that never
 *    held them, and every statement that needs the migration role runs in the supervisor
 *    (`supervisor.ts`).
 */
import {
  handedOffPrivilegedConnections,
  PRIVILEGED_CONNECTION_VARS,
} from './supervisor-handoff.js';

/** The variables `withholdPrivilegedConnections` removes: both connections and their `_FILE` forms. */
export { PRIVILEGED_CONNECTION_VARS };

/**
 * Remove the privileged connection variables from `env` (the process environment by default) and
 * return a copy of `env` as it was, with the connections the entrypoint's re-execution handed off,
 * for `loadServerConfig` to read.
 */
export function withholdPrivilegedConnections(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const before: NodeJS.ProcessEnv = { ...env, ...handedOffPrivilegedConnections() };
  for (const name of PRIVILEGED_CONNECTION_VARS) delete env[name];
  return before;
}
