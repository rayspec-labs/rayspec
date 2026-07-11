/**
 * COMMAND-LEVEL update lifecycle acceptance — the REAL `rayspec` CLI + the REAL local-boot wrapper,
 * composed end-to-end against a throwaway DATABASE. Where update-mode.db.test.ts drives the wrapper's
 * boot with a delta built IN-PROCESS via `diffProductStores`, THIS test adds the plan-integration arc:
 * the delta + the machine-proposed allowlist come from the actual `rayspec plan <new> --against <old>
 * [--allowlist <file>]` COMMAND (a child process running the built CLI binary), and flow through the
 * wrapper's REAL `readUpdateMigrations` into the REAL composition root (`assembleServer` + the
 * `updateMigrations` seam) — exactly as an update flow does at the command level.
 *
 * ONE throwaway DATABASE reused across the boots (they MUST share it to prove data survival):
 *   1.  v1 DEPLOY     — first-mode boot (materialize `tickets`); seed a REAL ticket row via HTTP.
 *   2.  v2 ADDITIVE   — `plan v2 --against v1` (REAL CLI) → additive delta (ADD nullable `priority`,
 *                       proposed allowlist EMPTY) → wrapper update boot → deployMode 'updated', the
 *                       seeded row SURVIVES, and `priority` is live end-to-end.
 *   3.  v3 BLOCKED    — `plan v3 --against v2` (REAL CLI, NO allowlist) → ok:false phase:'gate',
 *                       breakingChangeBlocked:true over the REAL generated `DROP COLUMN` SQL, with a
 *                       machine-proposed drop-column allowlist entry.
 *   4.  v3 WOULD-PASS — `plan v3 --against v2 --allowlist <proposed>` (REAL CLI) → ok:true (the reviewed
 *                       allowlist clears the gate) → wrapper update boot applies it → `priority` DROPPED,
 *                       the row's `title` survives → post-update drift EMPTY + a plain reboot MOUNTs.
 *
 * SCOPE NOTE: the specs are stores + CRUD. No `{agent}` route is authored: the agent/tool-loop surface
 * is orthogonal to the update LIFECYCLE and would pull a live backend/API key into a schema-evolution
 * proof; this arc stays deterministic + API-free (fake providers only).
 *
 * UN-SKIPPABLE RAN-GUARD: a separate, NON-skipped describe hard-FAILS when the DB is REQUIRED
 * (CI / RAYSPEC_REQUIRE_DB_TESTS) but the four arms did not run.
 */
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerScopedTables } from '@rayspec/db/testing';
import {
  assembleServer,
  type BootedServer,
  loadServerConfig,
  type PlannedMigration,
} from '@rayspec/server';
import { parseSpec } from '@rayspec/spec';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readUpdateMigrations } from './serve.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '../..');
const CLI_BIN = join(REPO_ROOT, 'packages/app/cli/dist/index.js');

// ── The three 1.0 spec versions (a `tickets` store evolving title → +priority → −priority) ────────
const V1_YAML = `
version: '1.0'
metadata:
  name: plan-lifecycle
  description: v1 — tickets with a title only
stores:
  - name: tickets
    columns:
      - { name: title, type: text }
api:
  - { method: POST, path: '/tickets', action: { kind: store, store: tickets, op: create } }
  - { method: GET, path: '/tickets/{id}', action: { kind: store, store: tickets, op: get } }
`;

const V2_YAML = `
version: '1.0'
metadata:
  name: plan-lifecycle
  description: v2 — tickets gains a nullable priority (ADDITIVE)
stores:
  - name: tickets
    columns:
      - { name: title, type: text }
      - { name: priority, type: text, nullable: true }
api:
  - { method: POST, path: '/tickets', action: { kind: store, store: tickets, op: create } }
  - { method: GET, path: '/tickets/{id}', action: { kind: store, store: tickets, op: get } }
`;

const V3_YAML = `
version: '1.0'
metadata:
  name: plan-lifecycle
  description: v3 — priority dropped (DESTRUCTIVE)
stores:
  - name: tickets
    columns:
      - { name: title, type: text }
api:
  - { method: POST, path: '/tickets', action: { kind: store, store: tickets, op: create } }
  - { method: GET, path: '/tickets/{id}', action: { kind: store, store: tickets, op: get } }
`;

interface PlanResult {
  ok: boolean;
  phase?: string;
  migrationSql: string;
  breakingChangeBlocked: boolean;
  proposedAllowlist?: Array<{ kind: string; match: string; reason: string }>;
  gateFindings: Array<{ kind: string; allowed: boolean }>;
}

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

const SUITE_DB = `rayspec_plan_lifecycle_${process.pid}`;
const EMAIL = 'plan-lifecycle@example.test';
const PASSWORD = 'correct-horse-battery-staple-9';

let armsRan = 0;
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';

describe('local-boot — command-level plan → wrapper update lifecycle', () => {
  const baseUrl = process.env.DATABASE_URL;
  const maybe = baseUrl ? it : it.skip;

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
  ] as const;

  let v1Path = '';
  let v2Path = '';
  let v3Path = '';
  let seededId = '';
  let orgId = '';

  beforeAll(async () => {
    if (!baseUrl) return;
    // The command-level arc needs the built CLI binary; run after `pnpm build`. Fail LOUD (never a
    // silent skip) if the CLI dist is missing.
    if (!existsSync(CLI_BIN)) {
      throw new Error(
        `[plan-lifecycle] the built CLI is missing at ${CLI_BIN} — run \`pnpm --filter @rayspec/cli build\` ` +
          '(or `pnpm build`) before this command-level acceptance.',
      );
    }
    appDbUrl = withDbName(baseUrl, SUITE_DB);

    const admin = postgres(adminUrl(baseUrl), { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE "${SUITE_DB}"`);
    } finally {
      await admin.end();
    }

    tmpDir = mkdtempSync(join(tmpdir(), 'rayspec-plan-lifecycle-'));
    v1Path = join(tmpDir, 'v1.yaml');
    v2Path = join(tmpDir, 'v2.yaml');
    v3Path = join(tmpDir, 'v3.yaml');
    writeFileSync(v1Path, V1_YAML, 'utf8');
    writeFileSync(v2Path, V2_YAML, 'utf8');
    writeFileSync(v3Path, V3_YAML, 'utf8');

    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    process.env.RAYSPEC_JWT_SIGNING_KEY = privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString();
    process.env.RAYSPEC_API_KEY_PEPPER = 'plan-lifecycle-pepper-only';
    process.env.DATABASE_URL = appDbUrl;
    delete process.env.ALLOWED_ORIGINS;
    process.env.PORT = '8805';
  }, 120_000);

  afterAll(async () => {
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
  }, 60_000);

  /**
   * Invoke the REAL `rayspec plan` COMMAND (child process, built binary). cwd = the spec dir (the CLI
   * path-jails specs to its working directory) with relative names. RAYSPEC_SKIP_DOTENV + an empty
   * SHADOW_DATABASE_URL keep it a pure front-half dry-run (no shadow DB / no real-DB contact). Returns
   * the parsed `PlanResult` JSON the command emits to stdout (never throws for ok:false — that's data).
   */
  function planCommand(newRel: string, againstRel: string, allowlistRel?: string): PlanResult {
    const args = ['plan', newRel, '--against', againstRel];
    if (allowlistRel) args.push('--allowlist', allowlistRel);
    let stdout: string;
    try {
      stdout = execFileSync('node', [CLI_BIN, ...args], {
        cwd: tmpDir,
        env: { ...process.env, RAYSPEC_SKIP_DOTENV: '1', SHADOW_DATABASE_URL: '' },
        encoding: 'utf8',
      });
    } catch (e) {
      // The CLI exits 1 for an ok:false plan (blocked gate) — that is a NORMAL result, not a crash: its
      // stdout still carries the JSON. Re-parse it; only a genuine crash (no stdout) re-throws.
      const err = e as { stdout?: string; status?: number };
      if (typeof err.stdout === 'string' && err.stdout.trim().length > 0) stdout = err.stdout;
      else throw e;
    }
    return JSON.parse(stdout) as PlanResult;
  }

  /** Build the wrapper's PlannedMigration[] from a delta SQL string (+ optional reviewed allowlist). */
  function wrapperMigrations(
    base: string,
    migrationSql: string,
    proposed?: PlanResult['proposedAllowlist'],
  ): PlannedMigration[] {
    const sqlPath = join(tmpDir, `${base}.sql`);
    writeFileSync(sqlPath, migrationSql, 'utf8');
    let allowlistPath: string | undefined;
    if (proposed && proposed.length > 0) {
      allowlistPath = join(tmpDir, `${base}.allowlist.json`);
      writeFileSync(allowlistPath, JSON.stringify(proposed, null, 2), 'utf8');
    }
    return readUpdateMigrations({
      migrationPath: sqlPath,
      ...(allowlistPath ? { allowlistPath } : {}),
    });
  }

  async function boot(
    specPath: string,
    updateMigrations?: PlannedMigration[],
  ): Promise<BootedServer> {
    process.env.RAYSPEC_SPEC_PATH = specPath;
    const config = loadServerConfig();
    return assembleServer(config, {
      registerProductTables: (tables) => registerScopedTables([...tables.values()]),
      ...(updateMigrations ? { updateMigrations } : {}),
    });
  }

  async function ticketsHasColumn(col: string): Promise<boolean> {
    const c = postgres(appDbUrl, { max: 1 });
    try {
      const rows = await c`
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'tickets' and column_name = ${col}`;
      return rows.length > 0;
    } finally {
      await c.end();
    }
  }

  async function registerCreateOrgSwitch(
    server: BootedServer,
  ): Promise<{ token: string; orgId: string }> {
    const reg = await server.app.request('/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    expect(reg.status).toBe(201);
    const t0 = (await reg.json()).accessToken as string;
    const orgRes = await server.app.request('/v1/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${t0}` },
      body: JSON.stringify({ name: 'Plan Co' }),
    });
    expect(orgRes.status).toBe(201);
    const newOrgId = (await orgRes.json()).id as string;
    const sw = await server.app.request(`/v1/orgs/${newOrgId}/switch`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t0}` },
    });
    expect(sw.status).toBe(200);
    return { token: (await sw.json()).accessToken as string, orgId: newOrgId };
  }

  async function loginSwitch(server: BootedServer, targetOrgId: string): Promise<string> {
    const login = await server.app.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    expect(login.status).toBe(200);
    const t0 = (await login.json()).accessToken as string;
    const sw = await server.app.request(`/v1/orgs/${targetOrgId}/switch`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t0}` },
    });
    expect(sw.status).toBe(200);
    return (await sw.json()).accessToken as string;
  }

  maybe(
    '(1) v1 DEPLOY (first mode): materialize tickets; seed a REAL row; the spec parses/validates',
    async () => {
      armsRan++;
      const parsed = parseSpec(V1_YAML);
      expect(parsed.ok).toBe(true);

      const server = await boot(v1Path);
      try {
        expect(server.deployMode).toBe('materialized');
        const { token, orgId: newOrgId } = await registerCreateOrgSwitch(server);
        orgId = newOrgId;
        const created = await server.app.request('/tickets', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ title: 'survive-me' }),
        });
        expect(created.status).toBe(201);
        seededId = ((await created.json()) as { id: string }).id;
        expect(await ticketsHasColumn('priority')).toBe(false);
      } finally {
        await server.close();
      }
    },
    120_000,
  );

  maybe(
    '(2) v2 ADDITIVE via the REAL `plan` command → wrapper update: the row survives, priority is live',
    async () => {
      armsRan++;
      expect(seededId).not.toBe('');
      const plan = planCommand('v2.yaml', 'v1.yaml');
      // The REAL command produced an ADDITIVE delta: ok, update mode, no breaking change, empty proposal.
      expect(plan.ok).toBe(true);
      expect(plan.breakingChangeBlocked).toBe(false);
      expect(plan.migrationSql).toMatch(/ADD COLUMN "priority"/);
      expect(plan.proposedAllowlist).toEqual([]);

      const server = await boot(v2Path, wrapperMigrations('0001_add_priority', plan.migrationSql));
      try {
        expect(server.deployMode).toBe('updated');
        expect(await ticketsHasColumn('priority')).toBe(true);
        const token = await loginSwitch(server, orgId);
        // The seeded row survived the in-place update.
        const got = await server.app.request(`/tickets/${seededId}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(got.status).toBe(200);
        expect(((await got.json()) as { title: string }).title).toBe('survive-me');
        // The new column is live end-to-end.
        const created = await server.app.request('/tickets', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ title: 'has-priority', priority: 'high' }),
        });
        expect(created.status).toBe(201);
        const newId = ((await created.json()) as { id: string }).id;
        const back = await server.app.request(`/tickets/${newId}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(((await back.json()) as { priority: string }).priority).toBe('high');
      } finally {
        await server.close();
      }
    },
    120_000,
  );

  maybe(
    '(3) v3 DESTRUCTIVE via the REAL `plan` command with NO allowlist: blocked at the gate on REAL generated SQL',
    async () => {
      armsRan++;
      expect(await ticketsHasColumn('priority')).toBe(true);
      const plan = planCommand('v3.yaml', 'v2.yaml');
      expect(plan.ok).toBe(false);
      expect(plan.phase).toBe('gate');
      expect(plan.breakingChangeBlocked).toBe(true);
      // The REAL generated SQL is a DROP COLUMN, and the gate found it destructive (not allowed).
      expect(plan.migrationSql).toMatch(/DROP COLUMN "priority"/);
      expect(plan.gateFindings.some((f) => f.kind === 'drop-column' && f.allowed === false)).toBe(
        true,
      );
      // The machine-proposed allowlist names exactly that drop-column (a proposal for a human to review).
      expect(plan.proposedAllowlist?.[0]?.kind).toBe('drop-column');
      // GROUND TRUTH: a blocked plan never touched the DB — priority is still present.
      expect(await ticketsHasColumn('priority')).toBe(true);
    },
    120_000,
  );

  maybe(
    '(4) v3 with the REVIEWED allowlist → `plan` would-pass → wrapper applies: priority dropped, title survives, reboot MOUNTs',
    async () => {
      armsRan++;
      expect(await ticketsHasColumn('priority')).toBe(true);
      // Re-run the REAL command WITH the reviewed allowlist file (the proposal a human approved) → ok:true.
      const blocked = planCommand('v3.yaml', 'v2.yaml');
      const allowlistPath = join(tmpDir, 'reviewed.allowlist.json');
      writeFileSync(
        allowlistPath,
        JSON.stringify(blocked.proposedAllowlist ?? [], null, 2),
        'utf8',
      );
      const wouldPass = planCommand('v3.yaml', 'v2.yaml', 'reviewed.allowlist.json');
      expect(wouldPass.ok).toBe(true);
      expect(wouldPass.breakingChangeBlocked).toBe(false);

      // The wrapper applies the SAME delta with the reviewed allowlist (deploy() gates + applies).
      const server = await boot(
        v3Path,
        wrapperMigrations(
          '0002_drop_priority',
          wouldPass.migrationSql,
          wouldPass.proposedAllowlist,
        ),
      );
      try {
        expect(server.deployMode).toBe('updated');
        // Post-update drift is EMPTY (the delta fully reconciled the schema to v3).
        expect(server.drift).toEqual([]);
        // GROUND TRUTH: the reviewed DROP COLUMN really applied; the surviving column is intact.
        expect(await ticketsHasColumn('priority')).toBe(false);
        const token = await loginSwitch(server, orgId);
        const got = await server.app.request(`/tickets/${seededId}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(got.status).toBe(200);
        expect(((await got.json()) as { title: string }).title).toBe('survive-me');
      } finally {
        await server.close();
      }

      // A plain reboot (no updateMigrations) now MOUNTs (present-matching vs v3) with drift empty — the
      // REAL classifier confirming the destructive update left the live schema drift-clean.
      const reboot = await boot(v3Path);
      try {
        expect(reboot.deployMode).toBe('mounted');
        expect(reboot.drift).toEqual([]);
      } finally {
        await reboot.close();
      }
    },
    120_000,
  );
});

/**
 * Ran-guard (the DB-backed false-green class): a SEPARATE, NON-skipped describe that FAILS the run when
 * the DB is REQUIRED (CI / RAYSPEC_REQUIRE_DB_TESTS) but the four arms did NOT run. Registered with NO
 * beforeAll dependency, so a setup that throws-and-skips still leaves `armsRan` at 0 and THIS test
 * FAILS. A local dev with no DB skips ergonomically.
 */
describe('local-boot plan-lifecycle — ran-guard (the command-level proof must not silently skip)', () => {
  it('the four command-level lifecycle arms ACTUALLY RAN when the DB is required (CI / opt-in)', () => {
    if (dbRequired) {
      expect(armsRan).toBe(4);
    } else {
      expect(dbRequired).toBe(false);
    }
  });
});
