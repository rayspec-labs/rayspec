/**
 * The SHARED SCHEMA LOCK, on GROUND TRUTH against throwaway databases.
 *
 * WHAT THESE ARMS PROVE. The boot's platform migration chain, a boot's product-store DDL and
 * `rayspec tenant ensure` all wait for the one advisory lock, so none of them changes the schema while
 * another path holds it; each wait is bounded and ends in a retryable `SchemaLockTimeoutError` that
 * leaves the database untouched; and a boot racing a tenant ensure against an EMPTY database both
 * succeed, where before the loser could die on a duplicate object.
 *
 * The lock is held from the test's own connection, and "waiting" is read from `pg_locks` — never
 * inferred from timing alone.
 *
 * Skips without DATABASE_URL; the un-skippable ran-guard hard-fails a REQUIRED run that did not run.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCHEMA_LOCK_NAMESPACE, SCHEMA_LOCK_SLOT } from '@rayspec/bundle-contract';
import { makeDb } from '@rayspec/db';
import { registerScopedTables } from '@rayspec/db/testing';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyMigrations,
  assembleServer,
  type BootedServer,
  loadServerConfig,
} from './composition-root.js';
import { SchemaLockTimeoutError } from './schema-lock.js';
import { provisionTenant, TenantProvisionError } from './tenant-provision.js';

const baseUrl = process.env.DATABASE_URL;
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
let armsRan = 0;

const PREFIX = `rayspec_schema_lock_${process.pid}`;
const PEPPER = 'schema-lock-suite-pepper';

const SPEC_YAML = `
version: '1.0'
metadata:
  name: schema-lock-test
  description: a store whose DDL a boot applies under the shared schema lock
stores:
  - name: lock_notes
    columns:
      - { name: body, type: text }
api:
  - { method: POST, path: '/lock-notes', action: { kind: store, store: lock_notes, op: create } }
`;

function withDbName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll `check` until it is true, failing after `ms`. */
async function until(check: () => Promise<boolean>, what: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

describe.skipIf(!baseUrl)('the shared schema lock', () => {
  const created: string[] = [];
  let dir = '';
  let specPath = '';
  const saved: Record<string, string | undefined> = {};
  const ENV = [
    'RAYSPEC_JWT_SIGNING_KEY',
    'RAYSPEC_API_KEY_PEPPER',
    'DATABASE_URL',
    'ALLOWED_ORIGINS',
    'PORT',
    'RAYSPEC_SPEC_PATH',
    'DBOS_SYSTEM_DATABASE_URL',
    'RAYSPEC_SCHEMA_LOCK_TIMEOUT_MS',
  ] as const;

  async function admin<T>(run: (sql: postgres.Sql) => Promise<T>): Promise<T> {
    const sql = postgres(withDbName(baseUrl as string, 'postgres'), { max: 1 });
    try {
      return await run(sql);
    } finally {
      await sql.end();
    }
  }

  /** A fresh EMPTY database; returns its URL. */
  async function freshDb(tag: string): Promise<string> {
    const name = `${PREFIX}_${tag}`;
    await admin(async (sql) => {
      await sql.unsafe(`DROP DATABASE IF EXISTS "${name}_dbos_sys" WITH (FORCE)`);
      await sql.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await sql.unsafe(`CREATE DATABASE "${name}"`);
    });
    created.push(name);
    return withDbName(baseUrl as string, name);
  }

  async function scalar(url: string, text: string): Promise<unknown> {
    const sql = postgres(url, { max: 1 });
    try {
      const rows = (await sql.unsafe(text)) as unknown as Record<string, unknown>[];
      return Object.values(rows[0] ?? { v: null })[0];
    } finally {
      await sql.end();
    }
  }

  /** How many requests for the schema lock are waiting in the database `url` names. */
  async function waiters(url: string): Promise<number> {
    return Number(
      await scalar(
        url,
        `SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
            AND classid = ${SCHEMA_LOCK_NAMESPACE} AND objid = ${SCHEMA_LOCK_SLOT}
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
      ),
    );
  }

  /**
   * Take the schema lock from a connection of the test's own and hold it until `release` is called.
   * `acquired` resolves once it is granted.
   */
  function holdLock(url: string): { acquired: Promise<void>; release: () => Promise<void> } {
    const sql = postgres(url, { max: 1 });
    let letGo: () => void = () => {};
    const released = new Promise<void>((r) => {
      letGo = r;
    });
    let granted: () => void = () => {};
    const acquired = new Promise<void>((r) => {
      granted = r;
    });
    const done = sql
      .begin(async (tx) => {
        await tx.unsafe('SELECT pg_advisory_xact_lock($1::int4, $2::int4)', [
          SCHEMA_LOCK_NAMESPACE,
          SCHEMA_LOCK_SLOT,
        ]);
        granted();
        await released;
      })
      .finally(() => sql.end());
    return {
      acquired,
      release: async () => {
        letGo();
        await done;
      },
    };
  }

  async function bootConfig(url: string, spec?: string) {
    process.env.DATABASE_URL = url;
    if (spec === undefined) delete process.env.RAYSPEC_SPEC_PATH;
    else process.env.RAYSPEC_SPEC_PATH = spec;
    return loadServerConfig();
  }

  function boot(config: ReturnType<typeof loadServerConfig>): Promise<BootedServer> {
    return assembleServer(config, {
      registerProductTables: (tables) => registerScopedTables([...tables.values()]),
    });
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'rayspec-schema-lock-'));
    specPath = join(dir, 'rayspec.yaml');
    writeFileSync(specPath, SPEC_YAML, 'utf8');
    for (const k of ENV) saved[k] = process.env[k];
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    process.env.RAYSPEC_JWT_SIGNING_KEY = await exportPKCS8(privateKey);
    process.env.RAYSPEC_API_KEY_PEPPER = PEPPER;
    delete process.env.ALLOWED_ORIGINS;
    process.env.PORT = '8813';
    delete process.env.DBOS_SYSTEM_DATABASE_URL;
    delete process.env.RAYSPEC_SCHEMA_LOCK_TIMEOUT_MS;
  }, 60_000);

  afterAll(async () => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (!baseUrl) return;
    await admin(async (sql) => {
      for (const name of created) {
        await sql.unsafe(`DROP DATABASE IF EXISTS "${name}_dbos_sys" WITH (FORCE)`);
        await sql.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      }
    });
  }, 120_000);

  it('the platform migration chain waits for a held lock and then applies', async () => {
    const url = await freshDb('chain_waits');
    const held = holdLock(url);
    await held.acquired;
    const db = makeDb(url);
    let settled = false;
    const migrating = applyMigrations(db).finally(() => {
      settled = true;
    });
    await until(async () => (await waiters(url)) === 1, 'the migration to queue for the lock');
    await sleep(300);
    expect(settled).toBe(false);
    expect(
      await scalar(url, "SELECT to_regclass('drizzle.__drizzle_migrations')::text"),
    ).toBeNull();
    await held.release();
    await migrating;
    expect(await scalar(url, "SELECT to_regclass('public.orgs')::text")).toBe('orgs');
    await db.$client.end();
    armsRan += 1;
  }, 60_000);

  it('a wait that runs out is a retryable SchemaLockTimeoutError and changes nothing', async () => {
    const url = await freshDb('chain_timeout');
    const held = holdLock(url);
    await held.acquired;
    const db = makeDb(url);
    try {
      const refused = await applyMigrations(db, { lockTimeoutMs: 300 }).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(SchemaLockTimeoutError);
      expect(refused).toMatchObject({ code: 'RAY_LOCK_TIMEOUT', retryable: true });
      expect(
        await scalar(url, "SELECT to_regclass('drizzle.__drizzle_migrations')::text"),
      ).toBeNull();
      expect(
        await scalar(url, "SELECT count(*)::int FROM pg_tables WHERE schemaname = 'public'"),
      ).toBe(0);
    } finally {
      await held.release();
      await db.$client.end();
    }
    armsRan += 1;
  }, 60_000);

  it('a boot waits for the lock, and with a short RAYSPEC_SCHEMA_LOCK_TIMEOUT_MS refuses untouched', async () => {
    const url = await freshDb('boot_waits');
    const held = holdLock(url);
    await held.acquired;
    process.env.RAYSPEC_SCHEMA_LOCK_TIMEOUT_MS = '300';
    const shortConfig = await bootConfig(url);
    delete process.env.RAYSPEC_SCHEMA_LOCK_TIMEOUT_MS;
    expect(shortConfig.schemaLockTimeoutMs).toBe(300);
    await expect(boot(shortConfig)).rejects.toBeInstanceOf(SchemaLockTimeoutError);
    expect(
      await scalar(url, "SELECT count(*)::int FROM pg_tables WHERE schemaname = 'public'"),
    ).toBe(0);

    const config = await bootConfig(url);
    let settled = false;
    const booting = boot(config).finally(() => {
      settled = true;
    });
    await until(async () => (await waiters(url)) === 1, 'the boot to queue for the lock');
    await sleep(300);
    expect(settled).toBe(false);
    await held.release();
    const server = await booting;
    expect(await scalar(url, "SELECT to_regclass('public.runtime_control_state')::text")).toBe(
      'runtime_control_state',
    );
    await server.close();
    armsRan += 1;
  }, 90_000);

  it('a boot applies its product-store DDL under the lock, not only its platform chain', async () => {
    const url = await freshDb('product_ddl');
    // The platform chain is already applied, so the boot has no chain to run and takes no lock for
    // it: the first thing it waits on is its product DDL.
    const setup = makeDb(url);
    await applyMigrations(setup);
    await setup.$client.end();

    const held = holdLock(url);
    await held.acquired;
    const config = await bootConfig(url, specPath);
    let settled = false;
    const booting = boot(config).finally(() => {
      settled = true;
    });
    await until(async () => (await waiters(url)) === 1, "the boot's product DDL to queue");
    await sleep(300);
    expect(settled).toBe(false);
    expect(await scalar(url, "SELECT to_regclass('public.lock_notes')::text")).toBeNull();
    await held.release();
    const server = await booting;
    expect(server.deployMode).toBe('materialized');
    expect(await scalar(url, "SELECT to_regclass('public.lock_notes')::text")).toBe('lock_notes');
    await server.close();
    armsRan += 1;
  }, 90_000);

  it('tenant ensure waits for the lock a boot or migration holds', async () => {
    const url = await freshDb('ensure_waits');
    const held = holdLock(url);
    await held.acquired;
    let settled = false;
    const ensuring = provisionTenant(
      { databaseUrl: url, apiKeyPepper: PEPPER },
      { orgId: '00000000-0000-4000-8000-00000000a001', name: 'Lock Waiters' },
    ).finally(() => {
      settled = true;
    });
    await until(async () => (await waiters(url)) === 1, 'tenant ensure to queue for the lock');
    await sleep(300);
    expect(settled).toBe(false);
    expect(await scalar(url, "SELECT to_regclass('public.orgs')::text")).toBeNull();
    await held.release();
    expect((await ensuring).org).toBe('created');
    armsRan += 1;
  }, 60_000);

  it('a boot and a tenant ensure racing on an empty database both succeed', async () => {
    for (const round of [1, 2, 3]) {
      const url = await freshDb(`race_${round}`);
      const config = await bootConfig(url);
      const [booted, ensured] = await Promise.allSettled([
        boot(config),
        provisionTenant(
          { databaseUrl: url, apiKeyPepper: PEPPER },
          { orgId: `00000000-0000-4000-8000-00000000b00${round}`, name: `Race ${round}` },
        ),
      ]);
      expect(booted.status, `round ${round}: the boot`).toBe('fulfilled');
      expect(ensured.status, `round ${round}: tenant ensure`).toBe('fulfilled');
      if (ensured.status === 'fulfilled') expect(ensured.value.org).toBe('created');
      if (booted.status === 'fulfilled') await booted.value.close();
      expect(
        await scalar(url, 'SELECT count(*)::int FROM drizzle.__drizzle_migrations'),
      ).toBeGreaterThan(0);
    }
    armsRan += 1;
  }, 180_000);

  it('tenant ensure whose lock wait runs out reports SCHEMA_LOCK_TIMEOUT and creates nothing', async () => {
    const url = await freshDb('ensure_timeout');
    const held = holdLock(url);
    await held.acquired;
    try {
      const refused = await provisionTenant(
        { databaseUrl: url, apiKeyPepper: PEPPER },
        { orgId: '00000000-0000-4000-8000-00000000a002', name: 'Too Late' },
        { schemaLockTimeoutMs: 300 },
      ).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(TenantProvisionError);
      expect(refused).toMatchObject({ code: 'SCHEMA_LOCK_TIMEOUT' });
      expect(
        await scalar(url, "SELECT count(*)::int FROM pg_tables WHERE schemaname = 'public'"),
      ).toBe(0);
    } finally {
      await held.release();
    }
    armsRan += 1;
  }, 60_000);
});

// The un-skippable ran-guard: a REQUIRED DB run that silently skipped is a false green.
it('DB-backed arms actually ran when the environment requires them', () => {
  if (dbRequired) expect(armsRan).toBe(7);
  else expect(true).toBe(true);
});
