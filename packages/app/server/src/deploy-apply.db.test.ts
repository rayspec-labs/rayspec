/**
 * The legacy YAML deploy through apply, on real boots (`assembleServer`, the composition root both
 * entrypoints run) against throwaway databases.
 *
 * WHAT THESE ARMS PROVE, on ground truth (receipt rows, the state row, the catalog):
 *  1. A first deploy materializes exactly as before, and its product DDL is one apply: intent, a
 *     receipt before and after the `product-ddl` step, the outcome, the environment revision raised
 *     by one and the product schema digest recorded — and `inspect()` reports that revision.
 *  2. A restart of the same deploy changes nothing and writes no receipt: no lease, no revision.
 *  3. A database one platform migration behind is brought up to date as an apply with a
 *     `platform-migrations` step whose receipts name the head it reached.
 *  4. A deploy that would change the schema of a fenced environment is refused with
 *     `RAY_POLICY_DENIED` `fenced` (exit class 4) and creates no product table.
 *
 * Skips without DATABASE_URL; the ran-guard hard-fails a REQUIRED run that did not run.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeDb } from '@rayspec/db';
import { registerScopedTables } from '@rayspec/db/testing';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, assembleServer, loadServerConfig } from './composition-root.js';
import { RuntimeApplyError } from './deploy-apply.js';
import { createRuntimeControl } from './runtime-control.js';
import { readProductSchemaDigest, runtimePlatformHead } from './schema-head.js';

const baseUrl = process.env.DATABASE_URL;
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (dbRequired && !baseUrl) {
  throw new Error(
    'deploy-apply.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — ' +
      'refusing to silently skip this DB-backed suite.',
  );
}
let armsRan = 0;

const SUITE = `rayspec_deploy_apply_${process.pid}`;

const SPEC = `
version: '1.0'
metadata:
  name: deploy-apply
  description: a backend spec with one store
stores:
  - name: applied_notes
    columns:
      - { name: body, type: text }
api:
  - { method: POST, path: '/applied-notes', action: { kind: store, store: applied_notes, op: create } }
`;

function withDbName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

describe.skipIf(!baseUrl)('the legacy deploy through apply', () => {
  let dir = '';
  let specPath = '';
  const created: string[] = [];
  const saved: Record<string, string | undefined> = {};
  const ENV = [
    'RAYSPEC_JWT_SIGNING_KEY',
    'RAYSPEC_API_KEY_PEPPER',
    'DATABASE_URL',
    'ALLOWED_ORIGINS',
    'PORT',
    'RAYSPEC_SPEC_PATH',
    'DBOS_SYSTEM_DATABASE_URL',
  ] as const;

  async function freshDatabase(suffix: string): Promise<string> {
    const name = `${SUITE}_${suffix}`;
    const admin = postgres(withDbName(baseUrl as string, 'postgres'), { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE "${name}"`);
    } finally {
      await admin.end();
    }
    created.push(name);
    return withDbName(baseUrl as string, name);
  }

  async function boot(dbUrl: string, warnings: string[] = []) {
    process.env.DATABASE_URL = dbUrl;
    process.env.RAYSPEC_SPEC_PATH = specPath;
    return assembleServer(loadServerConfig(), {
      registerProductTables: (tables) => registerScopedTables([...tables.values()]),
      bootWarn: (line) => warnings.push(line),
    });
  }

  async function receipts(dbUrl: string) {
    const sql = postgres(dbUrl, { max: 1 });
    try {
      return await sql<
        {
          operation_id: string;
          event: string;
          step: string | null;
          outcome: string | null;
          detail: unknown;
        }[]
      >`SELECT operation_id::text, event, step, outcome, detail FROM runtime_control_receipts ORDER BY id`;
    } finally {
      await sql.end();
    }
  }

  async function state(dbUrl: string) {
    const sql = postgres(dbUrl, { max: 1 });
    try {
      const [row] = await sql<{ revision: string; applied: string | null }[]>`
        SELECT environment_revision::text AS revision, applied_product_schema AS applied
          FROM runtime_control_state WHERE id = 1`;
      return row;
    } finally {
      await sql.end();
    }
  }

  beforeAll(async () => {
    if (!baseUrl) return;
    dir = mkdtempSync(join(tmpdir(), 'rayspec-deploy-apply-'));
    specPath = join(dir, 'deploy-apply.yaml');
    writeFileSync(specPath, SPEC, 'utf8');
    for (const k of ENV) saved[k] = process.env[k];
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    process.env.RAYSPEC_JWT_SIGNING_KEY = await exportPKCS8(privateKey);
    process.env.RAYSPEC_API_KEY_PEPPER = 'deploy-apply-pepper';
    delete process.env.ALLOWED_ORIGINS;
    delete process.env.DBOS_SYSTEM_DATABASE_URL;
    process.env.PORT = '8815';
  }, 60_000);

  afterAll(async () => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (!baseUrl) return;
    const admin = postgres(withDbName(baseUrl, 'postgres'), { max: 1 });
    try {
      for (const name of created) {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${name}_dbos_sys" WITH (FORCE)`);
        await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      }
    } finally {
      await admin.end();
    }
  }, 60_000);

  it('runs a first deploy product DDL as one apply, and a restart writes nothing', async () => {
    const dbUrl = await freshDatabase('first');
    const warnings: string[] = [];
    const server = await boot(dbUrl, warnings);
    try {
      expect(server.deployMode).toBe('materialized');
      expect((await server.app.request('/health')).status).toBe(200);
    } finally {
      await server.close();
    }
    expect(warnings).toEqual([]);
    const rows = await receipts(dbUrl);
    expect(rows.map((r) => [r.event, r.step, r.outcome])).toEqual([
      ['intent', null, null],
      ['step-started', 'product-ddl', null],
      ['step-finished', 'product-ddl', null],
      ['outcome', null, 'succeeded'],
    ]);
    const db = makeDb(dbUrl, 2);
    try {
      const live = await readProductSchemaDigest(
        async (sql, params = []) =>
          (await db.$client.unsafe(sql, params as never[])) as unknown as Record<string, unknown>[],
      );
      expect(await state(dbUrl)).toEqual({ revision: '2', applied: live });
      const inspected = await createRuntimeControl({ db }).inspect({
        contractVersion: '1.0.0-draft.2',
        operationId: randomUUID(),
        actor: 'operator:deploy-apply',
      });
      expect(inspected.data?.environmentRevision).toBe(2);
    } finally {
      await db.$client.end();
    }

    const again = await boot(dbUrl);
    try {
      expect(again.deployMode).toBe('mounted');
    } finally {
      await again.close();
    }
    expect(await receipts(dbUrl)).toHaveLength(rows.length);
    expect((await state(dbUrl))?.revision).toBe('2');
    armsRan += 1;
  }, 120_000);

  it('brings a database one platform migration behind up to date as an apply', async () => {
    const dbUrl = await freshDatabase('behind');
    const setup = makeDb(dbUrl, 2);
    try {
      await applyMigrations(setup);
      await setup.$client.unsafe('DROP TABLE runtime_control_processes');
      await setup.$client.unsafe(
        `DELETE FROM drizzle.__drizzle_migrations
          WHERE created_at = (SELECT max(created_at) FROM drizzle.__drizzle_migrations)`,
      );
    } finally {
      await setup.$client.end();
    }
    const server = await boot(dbUrl);
    await server.close();
    const rows = await receipts(dbUrl);
    const platform = rows.filter((r) => r.step === 'platform-migrations');
    expect(platform.map((r) => r.event)).toEqual(['step-started', 'step-finished']);
    expect(platform[0]?.detail).toMatchObject({ after: runtimePlatformHead() });
    expect(rows.filter((r) => r.event === 'outcome').map((r) => r.outcome)).toEqual([
      'succeeded',
      'succeeded',
    ]);
    // One apply for the platform chain, one for the product DDL, each raising the revision.
    expect((await state(dbUrl))?.revision).toBe('3');
    armsRan += 1;
  }, 120_000);

  it('refuses a schema change on a fenced environment and creates nothing', async () => {
    const dbUrl = await freshDatabase('fenced');
    const setup = makeDb(dbUrl, 2);
    try {
      await applyMigrations(setup);
      await setup.$client.unsafe(
        `INSERT INTO runtime_control_state (id, binding_revision_key, fence_state, fence_epoch)
         VALUES (1, $1, 'fenced', 1)`,
        ['a'.repeat(64)],
      );
    } finally {
      await setup.$client.end();
    }
    const refused = await boot(dbUrl).then(
      async (s) => {
        await s.close();
        return null;
      },
      (err: unknown) => err,
    );
    expect(refused).toBeInstanceOf(RuntimeApplyError);
    expect(refused).toMatchObject({ code: 'RAY_POLICY_DENIED', exitCode: 4 });
    expect((refused as Error).message).toContain('fenced');
    const sql = postgres(dbUrl, { max: 1 });
    try {
      const [row] = await sql<{ present: boolean }[]>`
        SELECT to_regclass('public.applied_notes') IS NOT NULL AS present`;
      expect(row?.present).toBe(false);
    } finally {
      await sql.end();
    }
    armsRan += 1;
  }, 120_000);
});

// The un-skippable ran-guard: a REQUIRED DB run that silently skipped is a false green.
it('DB-backed arms actually ran when the environment requires them', () => {
  if (dbRequired) expect(armsRan).toBe(3);
  else expect(true).toBe(true);
});
