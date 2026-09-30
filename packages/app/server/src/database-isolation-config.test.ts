/**
 * RAYSPEC_MIGRATION_DATABASE_URL, the one setting that turns role separation on, read like a boot
 * secret: unset or blank keeps the single-role boot; set, it carries the migration connection and
 * the migration connection to the workflow system database derived from it; the `_FILE` variant
 * wins; a value that is not a URL refuses the boot without echoing it. And the boot's warning line
 * names each failed check but no connection detail.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BootConfigError,
  databaseIsolationWarning,
  loadServerConfig,
  SINGLE_ROLE_ISOLATION,
} from './composition-root.js';

const BASE = {
  DATABASE_URL: 'postgres://runtime_role:runtime-pass@db.internal:5432/app',
  RAYSPEC_JWT_SIGNING_KEY: 'placeholder-key-not-parsed-here',
  RAYSPEC_API_KEY_PEPPER: 'placeholder-pepper',
};
const MIGRATION = 'postgres://migration_role:migration-pass@db.internal:5432/app';

const quiet = () => {};
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('RAYSPEC_MIGRATION_DATABASE_URL', () => {
  it('unset or blank: the single-role boot, with no migration connection', () => {
    for (const env of [BASE, { ...BASE, RAYSPEC_MIGRATION_DATABASE_URL: '   ' }]) {
      const config = loadServerConfig(env, quiet);
      expect(config.migrationDatabaseUrl).toBeUndefined();
      expect(config.migrationDbosSystemDatabaseUrl).toBeUndefined();
    }
  });

  it('set: the migration connection, and its connection to the derived workflow system database', () => {
    const config = loadServerConfig({ ...BASE, RAYSPEC_MIGRATION_DATABASE_URL: MIGRATION }, quiet);
    expect(config.migrationDatabaseUrl).toBe(MIGRATION);
    expect(config.dbosSystemDatabaseUrl).toBe(
      'postgres://runtime_role:runtime-pass@db.internal:5432/app_dbos_sys',
    );
    expect(config.migrationDbosSystemDatabaseUrl).toBe(
      'postgres://migration_role:migration-pass@db.internal:5432/app_dbos_sys',
    );
  });

  it('an explicit workflow system database is the one the migration connection points at', () => {
    const config = loadServerConfig(
      {
        ...BASE,
        RAYSPEC_MIGRATION_DATABASE_URL: MIGRATION,
        DBOS_SYSTEM_DATABASE_URL: 'postgres://runtime_role:runtime-pass@db.internal:5432/wf',
      },
      quiet,
    );
    expect(config.migrationDbosSystemDatabaseUrl).toBe(
      'postgres://migration_role:migration-pass@db.internal:5432/wf',
    );
  });

  it('the _FILE variant wins over the plain variable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rayspec-migration-url-'));
    dirs.push(dir);
    const file = join(dir, 'migration-url');
    writeFileSync(file, `${MIGRATION}\n`, { mode: 0o600 });
    const config = loadServerConfig(
      {
        ...BASE,
        RAYSPEC_MIGRATION_DATABASE_URL: 'postgres://ignored:ignored@elsewhere:5432/other',
        RAYSPEC_MIGRATION_DATABASE_URL_FILE: file,
      },
      quiet,
    );
    expect(config.migrationDatabaseUrl).toBe(MIGRATION);
  });

  it('a _FILE naming a missing file refuses the boot, never falling back to the plain variable', () => {
    expect(() =>
      loadServerConfig(
        {
          ...BASE,
          RAYSPEC_MIGRATION_DATABASE_URL: MIGRATION,
          RAYSPEC_MIGRATION_DATABASE_URL_FILE: join(tmpdir(), 'no-such-migration-url-file'),
        },
        quiet,
      ),
    ).toThrow(BootConfigError);
  });

  it('a value that is not a URL refuses the boot and does not echo it', () => {
    let caught: unknown;
    try {
      loadServerConfig({ ...BASE, RAYSPEC_MIGRATION_DATABASE_URL: 'not a url secret-ish' }, quiet);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BootConfigError);
    expect((caught as Error).message).toContain('RAYSPEC_MIGRATION_DATABASE_URL');
    expect((caught as Error).message).not.toContain('secret-ish');
  });
});

describe('the database isolation status', () => {
  it('one role is never reported active', () => {
    expect(SINGLE_ROLE_ISOLATION).toMatchObject({ mode: 'single-role', active: false });
  });

  it('the warning names the role and each failed check, and no connection detail', () => {
    const line = databaseIsolationWarning({
      mode: 'role-separated',
      active: false,
      runtimeRole: 'app_runtime',
      tenantTables: 12,
      findings: [
        { check: 'role-attributes', detail: 'the runtime role is a superuser' },
        { check: 'tenant-table-policy', detail: 'tenant tables without a policy: public.notes' },
      ],
    });
    expect(line).toContain("'app_runtime'");
    expect(line).toContain('the runtime role is a superuser');
    expect(line).toContain('public.notes');
    expect(line).not.toMatch(/postgres:\/\//);
  });
});
