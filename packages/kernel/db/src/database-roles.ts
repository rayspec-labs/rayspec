/**
 * The database roles of the isolated posture, and the setup SQL that creates them.
 *
 * `sql/database-roles.sql` in this package is the one definition of the three roles and their grants
 * (the migration role, the runtime role, the snapshot role — see the file's header). An operator runs
 * it with psql as a superuser; the compose file and CI run it when the database cluster is created;
 * tests run it through `prepareDatabaseRoles`, so every path creates the roles from the same text.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The role names the setup SQL uses unless it is told otherwise. */
export const DEFAULT_DATABASE_ROLES = {
  migration: 'rayspec_migrator',
  runtime: 'rayspec_runtime',
  snapshot: 'rayspec_snapshot',
} as const;

/** The three role names of one environment. */
export interface DatabaseRoleNames {
  migration: string;
  runtime: string;
  snapshot: string;
}

/** Which database the setup prepares: the application database or the workflow system database. */
export type DatabaseKind = 'application' | 'workflow-system';

/** Absolute path to the setup SQL shipped in this package. */
export function databaseRolesSqlPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'sql', 'database-roles.sql');
}

/** The setup SQL's text. */
export function databaseRolesSql(): string {
  return readFileSync(databaseRolesSqlPath(), 'utf8');
}

/** A postgres.js handle connected as a superuser to the database to prepare. */
export interface RolesAdminSql {
  begin<T>(fn: (tx: RolesAdminTx) => Promise<T>): Promise<T>;
}

/** The transaction handle `begin` passes. */
export interface RolesAdminTx {
  unsafe(query: string, parameters?: unknown[]): PromiseLike<unknown>;
}

/**
 * Run the setup SQL in the database `admin` is connected to, with the given role names and kind, in
 * one transaction. The names travel as transaction-local settings, the same way `psql` users pass
 * them, so this runs the file exactly as an operator does.
 */
export async function prepareDatabaseRoles(
  admin: RolesAdminSql,
  opts: { roles?: Partial<DatabaseRoleNames>; kind?: DatabaseKind } = {},
): Promise<void> {
  const roles = { ...DEFAULT_DATABASE_ROLES, ...opts.roles };
  const text = databaseRolesSql();
  await admin.begin(async (tx) => {
    await tx.unsafe(
      `SELECT set_config('rayspec.migration_role', $1, true), set_config('rayspec.runtime_role', $2, true),
              set_config('rayspec.snapshot_role', $3, true), set_config('rayspec.database_kind', $4, true)`,
      [roles.migration, roles.runtime, roles.snapshot, opts.kind ?? 'application'],
    );
    await tx.unsafe(text);
  });
}
