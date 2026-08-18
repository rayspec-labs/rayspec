/**
 * TENANT ERASURE ON AN AUTH-ONLY BOOT — the deployment shapes that declare neither stores nor a
 * workforce, and still accumulate a tenant's run history.
 *
 * WHY THIS SHAPE MATTERS. `createAuthApp` registers the agent-run surface UNCONDITIONALLY
 * (`packages/compose/api-auth/src/app.ts:214`), so `POST /v1/agents/:id/runs` is mounted on EVERY
 * boot — including one whose document declares only `agents:`, and including one with no document at
 * all, which `packages/app/server/src/serve.ts:12` calls the default. Every run through that surface
 * writes the tenant's `runs` header, its `journal_steps` (raw model output), its `conversation_items`
 * (the raw PII transcript) and its `run_events` journal. The erasure control seam is the only shipped
 * way an operator reaches that data — nothing in production code deletes an `orgs` row, so those
 * tables' ON DELETE CASCADE is a net nobody pulls — and it must therefore be wired on these shapes
 * too, not only on one that happens to declare a product store or a workforce.
 *
 * Two boot shapes are covered here, both against a real database, both through the REAL composition
 * root (`assembleServer`):
 *
 *   A. a DECLARED-AGENTS boot — a backend-profile document with `agents:` and NO `stores:` and NO
 *      `workforce:`, which reaches the seam through `deployDeclaredSpec`;
 *   B. a NO-DOCUMENT boot — `RAYSPEC_SPEC_PATH` unset, which reaches `createAuthApp` directly.
 *
 * WHAT THE ARMS ASSERT.
 *
 *   1. ACCEPT CONTROL — the boot really is store-less and workforce-less (`deployMode: 'auth-only'`,
 *      zero declared routes, the declared agent present). Without this, arm 2 could pass on a boot
 *      that quietly carried a store.
 *   2. THE SEAM IS WIRED — `server.eraseTenantNow` is defined. RED against a composition root that
 *      gates the seam on product stores or a declared workforce.
 *   3. THE BANNER IS HONEST — it reports the resolved gate posture, never NOT WIRED.
 *   4. THE OPERATOR GATE STILL GOVERNS — with `RAYSPEC_ERASURE_ENABLED` unset, a call PREVIEWS:
 *      `mode:'dry-run'`, `dryRunReason:'gate-disabled'`, non-zero counts for the four run-history
 *      tables, and NOT ONE ROW REMOVED. Wiring the seam by default is only safe because of this, so
 *      it is asserted on ground truth rather than argued.
 *   5. A REAL ERASE — the SAME boot shape restarted with the gate armed erases tenant A's four
 *      tables to zero.
 *   6. THE CROSS-TENANT WITNESS — tenant B's rows are untouched by both the preview and the real
 *      erase.
 *   7. THE NO-DOCUMENT BOOT — shape B wires the seam too and previews tenant C's rows under the same
 *      gate-off posture.
 *
 * The three boots run sequentially against ONE throwaway database, which is also the operator
 * sequence the gate is designed for: observe the preview, set the variable, restart, erase.
 *
 * DB ISOLATION: a whole throwaway DATABASE, dropped on teardown. No durable worker is declared, so no
 * DBOS system database is derived and no scheduler pass can race the assertions.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentSpec, Backend, BackendId, RunContext, RunResult } from '@rayspec/core';
import { type Db, makeDb } from '@rayspec/db';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootBanner } from './banner.js';
import {
  applyMigrations,
  assembleServer,
  type BootedServer,
  loadServerConfig,
} from './composition-root.js';

const TENANT_A = '00000000-0000-4000-8000-0000000000a1';
const TENANT_B = '00000000-0000-4000-8000-0000000000b2';
const TENANT_C = '00000000-0000-4000-8000-0000000000c3';

/** The core run-history tables an auth-only boot accumulates through the mounted run surface. */
const RUN_HISTORY_TABLES = ['runs', 'journal_steps', 'conversation_items', 'run_events'] as const;

/**
 * A network-free Backend wired as `openai` so the declared agent resolves at boot. No arm reaches a
 * run — the rows below are seeded directly, which is what makes their counts a fixture rather than a
 * by-product of a live dispatch.
 */
class InertBackend implements Backend {
  readonly id = 'openai' as const;
  async resolveAuth() {
    return 'api-key' as const;
  }
  async run(_spec: AgentSpec, _ctx: RunContext): Promise<RunResult> {
    throw new Error('InertBackend.run must never be called — this suite dispatches no run.');
  }
}

/**
 * Shape A's document: declared agents, and NOT ONE product store or workforce. No `deployment:`
 * section either, so no durable worker is launched and the boot stays light.
 */
const SPEC_YAML = `
version: '1.0'
metadata:
  name: auth-only-erasure-boot
  description: declared agents with no stores and no workforce - the shape the erasure seam must still be wired on
agents:
  - id: solo_agent
    name: solo_agent
    backend: openai
    model: gpt-4o-mini
    instructions: Answer the question.
`;

function adminUrl(url: string): string {
  const u = new URL(url);
  u.pathname = '/postgres';
  return u.toString();
}
function withDbName(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

const SUITE_DB = `rayspec_authonly_erase_${process.pid}`;
const BASE = 'http://127.0.0.1:8080';

const baseUrl = process.env.DATABASE_URL;
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
// Un-skippable ran-guard (fires at collection): a data-protection proof must never silently
// self-skip to a false green.
if (requireDb && !baseUrl) {
  throw new Error(
    'auth-only-erasure-boot.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but ' +
      'absent — refusing to silently skip this DB-backed suite.',
  );
}
let armsRan = 0;
const ARM_COUNT = 7;

describe('auth-only boot — the tenant-erasure seam is wired with neither stores nor a workforce', () => {
  const maybe = baseUrl ? it : it.skip;

  let server: BootedServer | undefined;
  let db: Db | undefined;
  let appDbUrl = '';
  let tmpDir = '';
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    'RAYSPEC_JWT_SIGNING_KEY',
    'RAYSPEC_API_KEY_PEPPER',
    'DATABASE_URL',
    'ALLOWED_ORIGINS',
    'PORT',
    'RAYSPEC_SPEC_PATH',
    'RAYSPEC_ERASURE_ENABLED',
  ] as const;

  /** Seed one run's worth of history — header, journal step, transcript part, event — for a tenant. */
  async function seedRunHistory(tenantId: string, label: string): Promise<void> {
    const sql = (db as Db).$client;
    const runId = `run-${label}`;
    await sql.unsafe(
      `INSERT INTO runs (run_id, tenant_id, backend, auth_mode, agent_name, model, status, final_text)
       VALUES ($1,$2,'openai','api-key','solo_agent','gpt-4o-mini','completed',$3)`,
      [runId, tenantId, `subject content in ${label}'s final text`],
    );
    await sql.unsafe(
      `INSERT INTO journal_steps (run_id, tenant_id, backend, type, idempotency_key, input_hash, output, status, auth_mode)
       VALUES ($1,$2,'openai','llm',$3,$4,$5::jsonb,'succeeded','api-key')`,
      [
        runId,
        tenantId,
        `idem-${label}`,
        `hash-${label}`,
        JSON.stringify({ text: `subject content in ${label}'s model output` }),
      ],
    );
    await sql.unsafe(
      `INSERT INTO conversation_items (run_id, tenant_id, seq, turn_index, role, kind, payload)
       VALUES ($1,$2,'1','0','user','text',$3::jsonb)`,
      [
        runId,
        tenantId,
        JSON.stringify({ kind: 'text', text: `subject content in ${label}'s turn` }),
      ],
    );
    await sql.unsafe(
      `INSERT INTO run_events (run_id, tenant_id, seq, type, data)
       VALUES ($1,$2,'1','run_completed',$3::jsonb)`,
      [runId, tenantId, JSON.stringify({ v: 1, type: 'run_completed' })],
    );
  }

  /** Ground-truth per-table row counts for one tenant, read outside the erasure code path. */
  async function counts(tenantId: string): Promise<Record<string, number>> {
    const sql = (db as Db).$client;
    const out: Record<string, number> = {};
    for (const t of RUN_HISTORY_TABLES) {
      const rows = (await sql.unsafe(`SELECT count(*)::int AS n FROM "${t}" WHERE tenant_id = $1`, [
        tenantId,
      ])) as unknown as { n: number }[];
      out[t] = rows[0]?.n ?? -1;
    }
    return out;
  }

  /** Boot the real composition root for the current environment, returning the booted server. */
  async function boot(): Promise<BootedServer> {
    const config = loadServerConfig();
    return assembleServer(config, {
      agentBackendsFactory: (): ReadonlyMap<BackendId, Backend> =>
        new Map<BackendId, Backend>([['openai', new InertBackend()]]),
    });
  }

  beforeAll(async () => {
    if (!baseUrl) return;
    appDbUrl = withDbName(baseUrl, SUITE_DB);

    const admin = postgres(adminUrl(baseUrl), { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE "${SUITE_DB}"`);
    } finally {
      await admin.end();
    }

    db = makeDb(appDbUrl);
    await applyMigrations(db);
    for (const [id, slug] of [
      [TENANT_A, 'auth-only-erase-a'],
      [TENANT_B, 'auth-only-erase-b'],
      [TENANT_C, 'auth-only-erase-c'],
    ] as const) {
      await db.$client.unsafe('INSERT INTO orgs (id, name, slug) VALUES ($1,$2,$3)', [
        id,
        `Auth Only Erase ${slug}`,
        slug,
      ]);
    }
    await seedRunHistory(TENANT_A, 'a');
    await seedRunHistory(TENANT_B, 'b');
    await seedRunHistory(TENANT_C, 'c');

    tmpDir = mkdtempSync(join(tmpdir(), 'rayspec-auth-only-erase-'));
    const specPath = join(tmpDir, 'rayspec.yaml');
    writeFileSync(specPath, SPEC_YAML, 'utf8');

    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    process.env.RAYSPEC_JWT_SIGNING_KEY = await exportPKCS8(privateKey);
    process.env.RAYSPEC_API_KEY_PEPPER = 'auth-only-erase-boot-pepper-only';
    process.env.DATABASE_URL = appDbUrl;
    delete process.env.ALLOWED_ORIGINS;
    process.env.PORT = '8811';
    process.env.RAYSPEC_SPEC_PATH = specPath;
    // Deliberately UNSET for the first boot — the gate-off posture arms 3 and 4 are written against.
    delete process.env.RAYSPEC_ERASURE_ENABLED;

    server = await boot();
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    if (db) await db.$client.end();
    for (const k of ENV_KEYS) {
      const v = savedEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    if (baseUrl) {
      const admin = postgres(adminUrl(baseUrl), { max: 1 });
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    }
  }, 120_000);

  maybe('1. accept control — this boot declared NO product store and NO workforce', () => {
    expect(server?.deployMode).toBe('auth-only');
    expect(server?.declaredRoutes).toEqual([]);
    expect(server?.declaredAgents.map((a) => a.id)).toEqual(['solo_agent']);
    armsRan++;
  });

  maybe('2. the tenant-erasure control seam is WIRED on a declared-agents auth-only boot', () => {
    expect(server?.eraseTenantNow).toBeDefined();
    armsRan++;
  });

  maybe('3. the banner reports the resolved gate posture — never NOT WIRED', () => {
    const banner = bootBanner(server as BootedServer, BASE);
    expect(banner).toContain('Tenant data erasure:   DRY-RUN');
    expect(banner).not.toContain('Tenant data erasure:   NOT WIRED');
    expect(banner).toContain('RAYSPEC_ERASURE_ENABLED');
    armsRan++;
  });

  maybe('4. gate OFF ⇒ the call PREVIEWS the run history and removes NOTHING', async () => {
    const before = await counts(TENANT_A);
    for (const t of RUN_HISTORY_TABLES) expect(before[t]).toBeGreaterThan(0);

    const res = await (server as BootedServer).eraseTenantNow?.(TENANT_A);
    expect(res).toBeDefined();
    expect(res?.mode).toBe('dry-run');
    expect(res?.dryRunReason).toBe('gate-disabled');
    // The four run-history tables report a NON-ZERO would-delete count, so a seam wired to an empty
    // enumeration cannot pass this.
    for (const t of RUN_HISTORY_TABLES) expect(res?.coreTables[t]).toBe(before[t]);
    // A store-less boot erases zero product rows and says so, rather than omitting the half.
    expect(res?.tables).toEqual({});
    // NOT ONE ROW REMOVED — the property that makes wiring the seam by default safe.
    expect(await counts(TENANT_A)).toEqual(before);
    armsRan++;
  });

  maybe(
    '5. the SAME boot shape with the operator gate ARMED really erases the run history',
    async () => {
      const before = await counts(TENANT_A);
      for (const t of RUN_HISTORY_TABLES) expect(before[t]).toBeGreaterThan(0);

      await server?.close();
      process.env.RAYSPEC_ERASURE_ENABLED = 'true';
      server = await boot();
      expect(bootBanner(server as BootedServer, BASE)).toContain('Tenant data erasure:   ARMED');

      const res = await (server as BootedServer).eraseTenantNow?.(TENANT_A);
      expect(res?.mode).toBe('deleted');
      for (const t of RUN_HISTORY_TABLES) expect(res?.coreTables[t]).toBe(before[t]);

      const after = await counts(TENANT_A);
      for (const t of RUN_HISTORY_TABLES) expect(after[t]).toBe(0);
      armsRan++;
    },
  );

  maybe(
    '6. the cross-tenant witness — tenant B is untouched by the preview and the erase',
    async () => {
      const b = await counts(TENANT_B);
      for (const t of RUN_HISTORY_TABLES) expect(b[t]).toBe(1);
      armsRan++;
    },
  );

  maybe('7. a boot with NO document at all wires the seam too, and still previews', async () => {
    await server?.close();
    // Back to the fail-closed posture, and to the shape `serve.ts` calls the default: no document.
    delete process.env.RAYSPEC_ERASURE_ENABLED;
    delete process.env.RAYSPEC_SPEC_PATH;
    server = await boot();

    expect(server?.deployMode).toBe('auth-only');
    expect(server?.declaredRoutes).toEqual([]);
    expect(server?.declaredAgents).toEqual([]);
    expect(server?.eraseTenantNow).toBeDefined();
    expect(bootBanner(server as BootedServer, BASE)).toContain('Tenant data erasure:   DRY-RUN');

    const before = await counts(TENANT_C);
    const res = await (server as BootedServer).eraseTenantNow?.(TENANT_C);
    expect(res?.mode).toBe('dry-run');
    expect(res?.dryRunReason).toBe('gate-disabled');
    for (const t of RUN_HISTORY_TABLES) expect(res?.coreTables[t]).toBe(before[t]);
    expect(await counts(TENANT_C)).toEqual(before);
    armsRan++;
  });
});

/**
 * Ran-guard: a SEPARATE, NON-skipped describe that FAILS the run when the DB is REQUIRED
 * (CI / RAYSPEC_REQUIRE_DB_TESTS) but the arms did NOT run — a CI run that lost DATABASE_URL would
 * otherwise silently skip the proof that an auth-only deployment can erase a tenant at all.
 */
describe('auth-only erasure boot — ran-guard', () => {
  it('the boot arms ACTUALLY RAN when the DB is required (CI / opt-in)', () => {
    if (requireDb) {
      expect(armsRan).toBe(ARM_COUNT);
    } else {
      expect(requireDb).toBe(false);
    }
  });
});
