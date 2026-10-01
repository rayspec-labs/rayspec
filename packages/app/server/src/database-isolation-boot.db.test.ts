/**
 * DATABASE ISOLATION at boot — the real composition root with role separation turned on
 * (RAYSPEC_MIGRATION_DATABASE_URL), serving as the RUNTIME ROLE of a throwaway database whose three
 * roles were created by the shipped setup SQL.
 *
 *   1. The boot migrates as the migration role, brings every tenant table (the core ones and the
 *      product stores it creates) under an enabled, forced tenant policy, guards the product foreign
 *      key with the same-tenant trigger, closes the migration pool, and reports the posture ACTIVE.
 *      The migration role owns every table; the runtime role owns none, reads the ledgers only, and
 *      still writes heartbeats and receipts. The workflow engine's own tables were created by the
 *      migration role, and the durable worker runs as the runtime role.
 *   2. Through HTTP, as the runtime role: tenant B cannot read, update or delete tenant A's record,
 *      cannot reference it through a foreign key, and receives none of A's events on its stream.
 *   3. The scheduled cleanup sweeps the event bus per tenant under row security.
 *   4. A source fence revokes the runtime role's writes while the snapshot role still reads every
 *      tenant's rows; resume grants them back.
 *   5. The runtime-control adapter reports the managed posture supported only with a receipt, the
 *      posture active AND single-tenant mode; a runtime role that is a superuser is reported not
 *      active, with a boot warning.
 *   6. Without the migration connection the boot is today's single-role boot: nothing is enabled.
 *
 * The durable worker launches DBOS (a process-global singleton), so only the first boot declares one.
 * Skips without DATABASE_URL; hard-fails when the DB is required (CI / RAYSPEC_REQUIRE_DB_TESTS).
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatTimestamp } from '@rayspec/bundle-contract';
import type { Backend, BackendId, RunResult } from '@rayspec/core';
import { type Db, listTenantTables, makeDb } from '@rayspec/db';
import {
  createIsolatedTestDatabase,
  type IsolatedTestDatabase,
  registerScopedTables,
  testDatabaseIsolation,
} from '@rayspec/db/testing';
import { typeStrippingImporter } from '@rayspec/platform';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assembleServer, type BootedServer, loadServerConfig } from './composition-root.js';
import { createRuntimeControl } from './runtime-control.js';

const baseUrl = process.env.DATABASE_URL;
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (requireDb && !baseUrl) {
  throw new Error(
    'database-isolation-boot.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but ' +
      'absent — refusing to silently skip the role-separated boot proofs.',
  );
}

const HANDLER_TS = `
export const emitNote = async (init) => {
  await init.emit('note.created', { tenantSeen: init.tenantId });
  return { tenant: init.tenantId };
};
`;

const STORES = `
stores:
  - name: notebooks
    columns:
      - { name: title, type: text }
  - name: entries
    columns:
      - { name: notebook_id, type: uuid }
      - { name: body, type: text }
    foreignKeys:
      - { column: notebook_id, references: notebooks, onDelete: cascade }
api:
  - { method: GET, path: '/notebooks', action: { kind: store, store: notebooks, op: list } }
  - { method: GET, path: '/notebooks/{id}', action: { kind: store, store: notebooks, op: get } }
  - { method: POST, path: '/notebooks', action: { kind: store, store: notebooks, op: create } }
  - { method: PATCH, path: '/notebooks/{id}', action: { kind: store, store: notebooks, op: update } }
  - { method: DELETE, path: '/notebooks/{id}', action: { kind: store, store: notebooks, op: delete } }
  - { method: POST, path: '/entries', action: { kind: store, store: entries, op: create } }
  - { method: GET, path: '/entries', action: { kind: store, store: entries, op: list } }
  - method: POST
    path: /emit
    action: { kind: handler, handler: emit_handler }
handlers:
  - id: emit_handler
    module: handlers/emit.ts
    export: emitNote
    kind: route
`;

const SPEC_WORKER = `
version: '1.0'
metadata:
  name: isolation-boot
  description: a backend served as the runtime role under row-level tenant isolation
deployment:
  durableWorker: true
  eventBus:
    enabled: true
    retentionHours: 6
agents:
  - id: echo
    name: echo-agent
    backend: openai
    model: gpt-4o-mini
    instructions: Echo the input back.
    maxTurns: 2
${STORES}`;

const SPEC_PLAIN = `
version: '1.0'
metadata:
  name: isolation-boot-plain
  description: the same stores without a durable worker
${STORES}`;

class UnusedBackend implements Backend {
  readonly id = 'openai' as const;
  async resolveAuth() {
    return 'api-key' as const;
  }
  async run(): Promise<RunResult> {
    throw new Error('this suite never fires an agent run');
  }
}

const ENV_KEYS = [
  'RAYSPEC_JWT_SIGNING_KEY',
  'RAYSPEC_API_KEY_PEPPER',
  'DATABASE_URL',
  'RAYSPEC_MIGRATION_DATABASE_URL',
  'RAYSPEC_MIGRATION_DATABASE_URL_FILE',
  'DBOS_SYSTEM_DATABASE_URL',
  'ALLOWED_ORIGINS',
  'PORT',
  'RAYSPEC_SPEC_PATH',
  'RAYSPEC_HANDLER_ROOT',
  'RAYSPEC_CLEANUP_SCHEDULE',
  'RAYSPEC_GDPR_PURGE_ENABLED',
] as const;

function base() {
  return {
    contractVersion: '1.0.0-draft.2' as const,
    operationId: randomUUID(),
    actor: 'operator:isolation-suite',
  };
}

describe.skipIf(!baseUrl)(
  'a role-separated boot serves as the runtime role under row security',
  () => {
    let iso: IsolatedTestDatabase;
    let admin: postgres.Sql;
    let server: BootedServer | undefined;
    let tmpDir = '';
    let specPath = '';
    const savedEnv: Record<string, string | undefined> = {};
    const warnings: string[] = [];

    async function boot(
      specYaml: string,
      env: Record<string, string | undefined>,
      opts: { withBackends?: boolean } = {},
    ): Promise<BootedServer> {
      writeFileSync(specPath, specYaml, 'utf8');
      for (const [k, v] of Object.entries(env)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      return assembleServer(loadServerConfig(), {
        registerProductTables: (tables) => {
          registerScopedTables([...tables.values()]);
        },
        moduleImporter: typeStrippingImporter,
        bootWarn: (line: string) => warnings.push(line),
        ...(opts.withBackends
          ? {
              agentBackendsFactory: (): ReadonlyMap<BackendId, Backend> =>
                new Map<BackendId, Backend>([['openai', new UnusedBackend()]]),
            }
          : {}),
      });
    }

    async function memberToken(app: BootedServer['app'], email: string): Promise<string> {
      const reg = await app.request('/v1/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 'correct-horse-battery-staple-9' }),
      });
      expect(reg.status).toBe(201);
      const t0 = (await reg.json()).accessToken as string;
      const orgRes = await app.request('/v1/orgs', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${t0}` },
        body: JSON.stringify({ name: `Isolation ${email}` }),
      });
      expect(orgRes.status).toBe(201);
      const orgId = (await orgRes.json()).id as string;
      const switchRes = await app.request(`/v1/orgs/${orgId}/switch`, {
        method: 'POST',
        headers: { authorization: `Bearer ${t0}` },
      });
      expect(switchRes.status).toBe(200);
      return (await switchRes.json()).accessToken as string;
    }

    function call(
      app: BootedServer['app'],
      token: string,
      method: string,
      path: string,
      body?: unknown,
    ): Promise<Response> {
      return app.request(path, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    }

    beforeAll(async () => {
      iso = await createIsolatedTestDatabase(baseUrl as string, { workflowSystem: true });
      admin = postgres(iso.urls.admin, { max: 2, onnotice: () => {} });
      tmpDir = mkdtempSync(join(tmpdir(), 'rayspec-isolation-boot-'));
      specPath = join(tmpDir, 'rayspec.yaml');
      mkdirSync(join(tmpDir, 'handlers'), { recursive: true });
      writeFileSync(join(tmpDir, 'handlers', 'emit.ts'), HANDLER_TS, 'utf8');
      for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
      const { privateKey } = await generateKeyPair('RS256', { extractable: true });
      process.env.RAYSPEC_JWT_SIGNING_KEY = await exportPKCS8(privateKey);
      process.env.RAYSPEC_API_KEY_PEPPER = 'isolation-boot-pepper-only';
      delete process.env.ALLOWED_ORIGINS;
      delete process.env.RAYSPEC_MIGRATION_DATABASE_URL_FILE;
      delete process.env.RAYSPEC_CLEANUP_SCHEDULE;
      delete process.env.RAYSPEC_GDPR_PURGE_ENABLED;
      process.env.PORT = '8806';
      process.env.RAYSPEC_SPEC_PATH = specPath;
      process.env.RAYSPEC_HANDLER_ROOT = tmpDir;
      server = await boot(
        SPEC_WORKER,
        {
          DATABASE_URL: iso.urls.runtime,
          RAYSPEC_MIGRATION_DATABASE_URL: iso.urls.migration,
          DBOS_SYSTEM_DATABASE_URL: iso.workflowSystemUrls?.runtime,
        },
        { withBackends: true },
      );
    }, 180_000);

    afterAll(async () => {
      await server?.close();
      await admin?.end();
      for (const k of ENV_KEYS) {
        const v = savedEnv[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
      await iso?.drop();
    }, 120_000);

    it('reports the posture active for the runtime role, and warns about nothing', () => {
      expect(server?.databaseIsolation).toMatchObject({
        mode: 'role-separated',
        active: true,
        runtimeRole: iso.roles.runtime,
        findings: [],
      });
      expect(warnings.filter((w) => w.includes('RAYSPEC_MIGRATION_DATABASE_URL'))).toEqual([]);
    });

    it('a restart mounts the product stores it created: the runtime role sees their foreign keys', async () => {
      // The first boot's drift report reads the live schema as the runtime role, which owns nothing.
      expect(server?.deployMode).toBe('materialized');
      expect(server?.drift).toEqual([]);
      // A second boot of the same stores decides mount-or-materialize from that same read; a drift
      // check blind to foreign keys it does not own would refuse it as drifted.
      const restarted = await boot(SPEC_PLAIN, {
        DATABASE_URL: iso.urls.runtime,
        RAYSPEC_MIGRATION_DATABASE_URL: iso.urls.migration,
        DBOS_SYSTEM_DATABASE_URL: iso.workflowSystemUrls?.runtime,
      });
      try {
        expect(restarted.deployMode).toBe('mounted');
        expect(restarted.drift).toEqual([]);
        expect(restarted.databaseIsolation.active).toBe(true);
      } finally {
        await restarted.close();
      }
    }, 120_000);

    it('every tenant table, product stores included, has an enabled, forced policy; the migration role owns them', async () => {
      const tables = await listTenantTables(admin);
      expect(tables.map((t) => t.table)).toEqual(expect.arrayContaining(['notebooks', 'entries']));
      expect(tables.filter((t) => !t.rowSecurity || !t.forced || !t.policy)).toEqual([]);
      const owners = (await admin.unsafe(
        `SELECT DISTINCT pg_get_userbyid(c.relowner)::text AS owner
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p') AND n.nspname IN ('public', 'drizzle')`,
      )) as unknown as { owner: string }[];
      expect(owners.map((o) => o.owner)).toEqual([iso.roles.migration]);
      const [triggers] = (await admin.unsafe(
        `SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = 'public.entries'::regclass
          AND tgname LIKE 'rayspec_same_tenant_%'`,
      )) as unknown as { n: number }[];
      expect(triggers?.n).toBe(1);
      const [privileges] = (await admin.unsafe(
        `SELECT has_table_privilege($1, 'drizzle.__drizzle_migrations', 'INSERT') AS ledger_write,
              has_table_privilege($1, 'public.product_migration_ledger', 'INSERT') AS product_ledger_write,
              has_table_privilege($1, 'public.product_migration_ledger', 'SELECT') AS product_ledger_read,
              has_table_privilege($1, 'public.runtime_control_processes', 'INSERT') AS heartbeat_write,
              has_table_privilege($1, 'public.runtime_control_receipts', 'INSERT') AS receipt_write,
              has_table_privilege($1, 'public.notebooks', 'TRUNCATE') AS truncate`,
        [iso.roles.runtime],
      )) as unknown as Record<string, boolean>[];
      expect(privileges).toEqual({
        ledger_write: false,
        product_ledger_write: false,
        product_ledger_read: true,
        heartbeat_write: true,
        receipt_write: true,
        truncate: false,
      });
    });

    it('the boot closed the migration pool, and the workflow engine runs as the runtime role on tables it does not own', async () => {
      const sessions = (await admin.unsafe(
        `SELECT usename::text AS role, datname::text AS db FROM pg_stat_activity
        WHERE datname = ANY($1::text[]) AND backend_type = 'client backend'`,
        [[iso.name, iso.workflowSystemName]],
      )) as unknown as { role: string; db: string }[];
      expect(sessions.filter((s) => s.role === iso.roles.migration)).toEqual([]);
      expect(sessions.filter((s) => s.role === iso.roles.runtime).length).toBeGreaterThan(0);
      const system = postgres(iso.workflowSystemUrls?.admin as string, {
        max: 1,
        onnotice: () => {},
      });
      try {
        const owners = (await system.unsafe(
          `SELECT DISTINCT pg_get_userbyid(c.relowner)::text AS owner
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind IN ('r', 'p') AND n.nspname = 'dbos'`,
        )) as unknown as { owner: string }[];
        expect(owners.map((o) => o.owner)).toEqual([iso.roles.migration]);
      } finally {
        await system.end();
      }
      const worker = server?.readiness.find((p) => p.name === 'worker');
      expect(worker).toBeDefined();
    });

    it("through HTTP, tenant B cannot read, update, delete or reference tenant A's record", async () => {
      const app = server?.app as BootedServer['app'];
      const a = await memberToken(app, `a-${randomUUID()}@example.test`);
      const b = await memberToken(app, `b-${randomUUID()}@example.test`);
      const created = await call(app, a, 'POST', '/notebooks', { title: 'A only' });
      expect(created.status).toBe(201);
      const notebook = (await created.json()) as { id: string };

      expect((await call(app, b, 'GET', `/notebooks/${notebook.id}`)).status).toBe(404);
      expect(
        (await call(app, b, 'PATCH', `/notebooks/${notebook.id}`, { title: 'B' })).status,
      ).toBe(404);
      expect((await call(app, b, 'DELETE', `/notebooks/${notebook.id}`)).status).toBe(404);
      const listed = (await (await call(app, b, 'GET', '/notebooks')).json()) as {
        items?: unknown[];
      };
      expect(listed.items ?? listed).toEqual([]);

      // A foreign key may not point at another tenant's row: refused like a missing parent.
      const planted = await call(app, b, 'POST', '/entries', {
        notebook_id: notebook.id,
        body: 'planted',
      });
      expect(planted.status).toBe(400);
      const [entries] = (await admin.unsafe(
        'SELECT count(*)::int AS n FROM entries',
      )) as unknown as { n: number }[];
      expect(entries?.n).toBe(0);
      const own = await call(app, a, 'POST', '/entries', {
        notebook_id: notebook.id,
        body: 'mine',
      });
      expect(own.status).toBe(201);

      const [title] = (await admin.unsafe('SELECT title FROM notebooks WHERE id = $1', [
        notebook.id,
      ])) as unknown as { title: string }[];
      expect(title?.title).toBe('A only');
    });

    it("tenant B's event stream never carries tenant A's events, and the cleanup sweeps each tenant", async () => {
      const app = server?.app as BootedServer['app'];
      const a = await memberToken(app, `stream-a-${randomUUID()}@example.test`);
      const b = await memberToken(app, `stream-b-${randomUUID()}@example.test`);
      const emitted = await call(app, a, 'POST', '/emit', {});
      expect(emitted.status).toBe(200);
      const tenantA = ((await emitted.json()) as { tenant: string }).tenant;

      const sub = await app.request('/v1/subscribe', {
        headers: { authorization: `Bearer ${b}`, accept: 'text/event-stream' },
      });
      expect(sub.status).toBe(200);
      const reader = sub.body?.getReader();
      let text = '';
      const deadline = Date.now() + 3_000;
      while (reader && Date.now() < deadline && !text.includes('rayspec.live')) {
        const chunk = await Promise.race([
          reader.read(),
          new Promise<{ done: true; value: undefined }>((r) =>
            setTimeout(() => r({ done: true, value: undefined }), 500),
          ),
        ]);
        if (chunk.value !== undefined) text += new TextDecoder().decode(chunk.value);
      }
      await reader?.cancel().catch(() => {});
      expect(text).toContain('rayspec.live');
      expect(text).not.toContain('note.created');
      expect(text).not.toContain(tenantA);

      await admin.unsafe(
        `UPDATE tenant_events SET at = now() - interval '8 hours' WHERE tenant_id = $1`,
        [tenantA],
      );
      const cleaned = await server?.runCleanupNow?.();
      expect(cleaned?.eventBus?.deleted).toBeGreaterThanOrEqual(1);
      const [left] = (await admin.unsafe(
        'SELECT count(*)::int AS n FROM tenant_events WHERE tenant_id = $1',
        [tenantA],
      )) as unknown as { n: number }[];
      expect(left?.n).toBe(0);
    });

    it("a source fence revokes the runtime role's writes, the snapshot role still reads every tenant, and resume restores them", async () => {
      const control: Db = makeDb(iso.urls.migration, 2);
      const systemControl: Db = makeDb(iso.workflowSystemUrls?.migration as string, 1);
      const runtime = postgres(iso.urls.runtime, { max: 1, onnotice: () => {} });
      const snapshot = postgres(iso.urls.snapshot, { max: 1, onnotice: () => {} });
      try {
        const adapter = createRuntimeControl({
          db: control,
          runtimeRole: iso.roles.runtime,
          workflowSystemDb: systemControl,
          quiescePollMs: 50,
        });
        const quiesced = await adapter.quiesce({
          ...base(),
          reason: 'export',
          deadline: formatTimestamp(new Date(Date.now() + 15_000)),
          sourceStopped: false,
        });
        expect(quiesced.data?.barriers).toEqual([
          { barrier: 'database-write-role', state: 'held' },
          { barrier: 'object-writes', state: 'held' },
        ]);
        const tenant = (await admin.unsafe(
          'SELECT id::text AS id FROM orgs LIMIT 1',
        )) as unknown as {
          id: string;
        }[];
        await expect(
          runtime.begin(async (tx) => {
            await tx.unsafe(`SELECT set_config('app.current_tenant', $1, true)`, [tenant[0]?.id]);
            await tx.unsafe(`INSERT INTO notebooks (tenant_id, title) VALUES ($1, 'during')`, [
              tenant[0]?.id,
            ]);
          }),
        ).rejects.toMatchObject({ code: '42501' });
        // The snapshot role reads every tenant's rows with no tenant context at all.
        const [all] = (await snapshot.unsafe(
          'SELECT count(DISTINCT tenant_id)::int AS tenants FROM notebooks',
        )) as unknown as { tenants: number }[];
        expect(all?.tenants).toBeGreaterThanOrEqual(1);
        await expect(snapshot.unsafe('DELETE FROM notebooks')).rejects.toMatchObject({
          code: '42501',
        });

        const [fence] = (await admin.unsafe(
          'SELECT fence_epoch::int AS epoch FROM runtime_control_state WHERE id = 1',
        )) as unknown as { epoch: number }[];
        const resumed = await adapter.resume({ ...base(), fenceEpoch: fence?.epoch ?? 0 });
        expect(resumed.data?.released).toBe(true);
        await runtime.begin(async (tx) => {
          await tx.unsafe(`SELECT set_config('app.current_tenant', $1, true)`, [tenant[0]?.id]);
          await tx.unsafe(`INSERT INTO notebooks (tenant_id, title) VALUES ($1, 'after')`, [
            tenant[0]?.id,
          ]);
        });
      } finally {
        await snapshot.end();
        await runtime.end();
        await systemControl.$client.end();
        await control.$client.end();
      }
    }, 60_000);

    it('the managed posture is supported only with a receipt, the isolation posture active and single-tenant mode', async () => {
      const control: Db = makeDb(iso.urls.migration, 1);
      try {
        const receipt = 'a'.repeat(64);
        const inspect = (
          runtimeRole?: string,
          env: NodeJS.ProcessEnv = { RAYSPEC_SINGLE_TENANT: 'true' },
        ) =>
          createRuntimeControl({
            db: control,
            managedReceiptSha256: receipt,
            env,
            ...(runtimeRole !== undefined ? { runtimeRole } : {}),
          }).inspect(base());
        expect((await inspect(iso.roles.runtime)).data?.managedPosture).toEqual({
          supported: true,
          receiptSha256: receipt,
        });
        // Without single-tenant mode (unset, or a value the boot would refuse): not supported.
        expect((await inspect(iso.roles.runtime, {})).data?.managedPosture.supported).toBe(false);
        expect(
          (await inspect(iso.roles.runtime, { RAYSPEC_SINGLE_TENANT: 'yes' })).data?.managedPosture
            .supported,
        ).toBe(false);
        // The snapshot role bypasses row security: as a runtime role it would not hold the posture.
        expect((await inspect(iso.roles.snapshot)).data?.managedPosture.supported).toBe(false);
        // One database role: never supported.
        expect((await inspect()).data?.managedPosture.supported).toBe(false);
        const isolation = await createRuntimeControl({
          db: control,
          runtimeRole: iso.roles.runtime,
        }).inspectDatabaseIsolation();
        expect(isolation).toMatchObject({ mode: 'role-separated', active: true, findings: [] });
      } finally {
        await control.$client.end();
      }
    });

    describe('misconfiguration and the single-role default', () => {
      let second: IsolatedTestDatabase;

      beforeAll(async () => {
        second = await createIsolatedTestDatabase(baseUrl as string);
      }, 60_000);

      afterAll(async () => {
        await second?.drop();
      });

      it('a runtime connection that is a superuser boots, is reported not active, and the boot says why', async () => {
        warnings.length = 0;
        const booted = await boot(SPEC_PLAIN, {
          DATABASE_URL: second.urls.admin,
          RAYSPEC_MIGRATION_DATABASE_URL: second.urls.migration,
          DBOS_SYSTEM_DATABASE_URL: undefined,
        });
        try {
          expect(booted.databaseIsolation.mode).toBe('role-separated');
          expect(booted.databaseIsolation.active).toBe(false);
          expect(booted.databaseIsolation.findings.map((f) => f.check)).toContain(
            'role-attributes',
          );
          expect(warnings.some((w) => w.includes('is NOT active'))).toBe(true);
        } finally {
          await booted.close();
        }
      }, 120_000);

      // The runtime-role lane turns role separation on for every boot, so the single-role boot is
      // proven only outside it.
      it.skipIf(testDatabaseIsolation())(
        'without the migration connection the boot is the single-role boot: no table has row security',
        async () => {
          const single = new URL(baseUrl as string);
          single.pathname = `/${second.name}_single`;
          const server0 = postgres(iso.urls.admin.replace(`/${iso.name}`, '/postgres'), { max: 1 });
          try {
            await server0.unsafe(`CREATE DATABASE "${second.name}_single"`);
          } finally {
            await server0.end();
          }
          try {
            const booted = await boot(SPEC_PLAIN, {
              DATABASE_URL: single.toString(),
              RAYSPEC_MIGRATION_DATABASE_URL: undefined,
              DBOS_SYSTEM_DATABASE_URL: undefined,
            });
            try {
              expect(booted.databaseIsolation).toMatchObject({
                mode: 'single-role',
                active: false,
              });
              const check = postgres(single.toString(), { max: 1, onnotice: () => {} });
              try {
                const tables = await listTenantTables(check);
                expect(tables.map((t) => t.table)).toEqual(
                  expect.arrayContaining(['notebooks', 'entries']),
                );
                expect(tables.filter((t) => t.rowSecurity || t.forced)).toEqual([]);
              } finally {
                await check.end();
              }
            } finally {
              await booted.close();
            }
          } finally {
            const server1 = postgres(iso.urls.admin.replace(`/${iso.name}`, '/postgres'), {
              max: 1,
            });
            try {
              await server1.unsafe(`DROP DATABASE IF EXISTS "${second.name}_single" WITH (FORCE)`);
            } finally {
              await server1.end();
            }
          }
        },
        120_000,
      );
    });
  },
);
