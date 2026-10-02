/**
 * The entrypoints take the migration and snapshot connections out of the environment before they
 * serve, and still boot from them: the variables leave the environment passed in, the returned copy
 * keeps them, and the configuration read from that copy is the role-separated one.
 */
import { describe, expect, it } from 'vitest';
import { loadServerConfig } from './composition-root.js';
import {
  PRIVILEGED_CONNECTION_VARS,
  withholdPrivilegedConnections,
} from './privileged-connections.js';

const MIGRATION = 'postgres://migrator:m@127.0.0.1:1/app';
const SNAPSHOT = 'postgres://snapshot:s@127.0.0.1:1/app';

function environment(): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: 'postgres://runtime:r@127.0.0.1:1/app',
    RAYSPEC_JWT_SIGNING_KEY: 'pem-is-not-parsed-here',
    RAYSPEC_API_KEY_PEPPER: 'a-pepper',
    RAYSPEC_MIGRATION_DATABASE_URL: MIGRATION,
    RAYSPEC_MIGRATION_DATABASE_URL_FILE: '/run/secrets/migration',
    RAYSPEC_SNAPSHOT_DATABASE_URL: SNAPSHOT,
    RAYSPEC_SNAPSHOT_DATABASE_URL_FILE: '/run/secrets/snapshot',
    PATH: '/usr/bin',
  };
}

describe('withholdPrivilegedConnections', () => {
  it('names both connections and their file forms', () => {
    expect([...PRIVILEGED_CONNECTION_VARS].sort()).toEqual([
      'RAYSPEC_MIGRATION_DATABASE_URL',
      'RAYSPEC_MIGRATION_DATABASE_URL_FILE',
      'RAYSPEC_SNAPSHOT_DATABASE_URL',
      'RAYSPEC_SNAPSHOT_DATABASE_URL_FILE',
    ]);
  });

  it('removes them from the environment it is given and leaves everything else', () => {
    const env = environment();
    for (const name of PRIVILEGED_CONNECTION_VARS) expect(env[name]).toBeDefined();
    withholdPrivilegedConnections(env);
    for (const name of PRIVILEGED_CONNECTION_VARS) expect(name in env).toBe(false);
    expect(env.DATABASE_URL).toBe('postgres://runtime:r@127.0.0.1:1/app');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('returns the environment as it was, so the boot still reads the migration connection', () => {
    const env = environment();
    const before = withholdPrivilegedConnections(env);
    expect(before).toEqual(environment());
    expect(before).not.toBe(env);
    // The plain variable is used here: the `_FILE` form, which wins when set, names no real file.
    delete before.RAYSPEC_MIGRATION_DATABASE_URL_FILE;
    const config = loadServerConfig(before, () => {});
    expect(config.migrationDatabaseUrl).toBe(MIGRATION);
    expect(loadServerConfig(env, () => {}).migrationDatabaseUrl).toBeUndefined();
  });

  it('acts on the process environment when it is given none', () => {
    const saved = new Map(PRIVILEGED_CONNECTION_VARS.map((name) => [name, process.env[name]]));
    process.env.RAYSPEC_SNAPSHOT_DATABASE_URL = SNAPSHOT;
    try {
      const before = withholdPrivilegedConnections();
      for (const name of PRIVILEGED_CONNECTION_VARS) expect(name in process.env).toBe(false);
      expect(before.RAYSPEC_SNAPSHOT_DATABASE_URL).toBe(SNAPSHOT);
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
