/**
 * The connections a serving process must not leave where application code can read them.
 *
 * With role separation the boot reads the migration role's connection (`RAYSPEC_MIGRATION_DATABASE_URL`)
 * for its schema work, and an operator who exports from the same environment may also have set the
 * snapshot role's (`RAYSPEC_SNAPSHOT_DATABASE_URL`), which a serving process never uses. Either one,
 * left in `process.env`, is readable by every handler module the boot imports and is copied into every
 * child process the server spawns: the migration role can write past the export fence and is not
 * subject to row-level security.
 *
 * The entrypoints take both variables, and their `_FILE` forms, out of `process.env` before the
 * configuration is read and before any application module is imported. The configuration is read from
 * the copy this returns, so the boot still finds the migration connection, and nothing but the boot's
 * own configuration object holds it afterwards.
 *
 * This keeps the connection strings out of the environment a handler or a child reads. It is not a
 * sandbox: code running in the process can still read the process's original environment block from
 * the operating system or a mounted `_FILE`, which only running the schema work in a separate process
 * would close (docs/threat-model.md, "Secrets").
 */
import { MIGRATION_DATABASE_URL_VAR, SNAPSHOT_DATABASE_URL_VAR } from './composition-root.js';

/** The variables `withholdPrivilegedConnections` removes: both connections and their `_FILE` forms. */
export const PRIVILEGED_CONNECTION_VARS: readonly string[] = [
  MIGRATION_DATABASE_URL_VAR,
  `${MIGRATION_DATABASE_URL_VAR}_FILE`,
  SNAPSHOT_DATABASE_URL_VAR,
  `${SNAPSHOT_DATABASE_URL_VAR}_FILE`,
];

/**
 * Remove the privileged connection variables from `env` (the process environment by default) and
 * return a copy of `env` as it was, for `loadServerConfig` to read.
 */
export function withholdPrivilegedConnections(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const before: NodeJS.ProcessEnv = { ...env };
  for (const name of PRIVILEGED_CONNECTION_VARS) delete env[name];
  return before;
}
