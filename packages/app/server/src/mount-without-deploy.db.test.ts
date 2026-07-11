/**
 * MOUNT-WITHOUT-DEPLOY boot gate — the real composition root (`assembleServer`) against a
 * throwaway DATABASE proves the data-survival invariant END-TO-END on ground truth (fail-the-fix,
 * not pass-the-shape). It mirrors `durable-worker-boot.db.test.ts`'s harness (a whole throwaway
 * DATABASE, env save/restore, `loadServerConfig` + `assembleServer`, drop on teardown).
 *
 * ONE throwaway DATABASE is reused across FOUR boots within the suite (they MUST share the DB to prove
 * persistence):
 *   1. from-clean    — boot #1 on a clean DB → `deployMode === 'materialized'`; seed a `notes` row.
 *   2. from-existing — close + boot #2 against the SAME DB with the SAME spec → `deployMode ===
 *                      'mounted'` and the seeded row SURVIVES (read it back — the real no-drop proof).
 *   3. drift→closed  — boot #3 with a spec that ADDS a column → `assembleServer` REJECTS with
 *                      `BootConfigError` (mount never auto-materializes/drops); then boot #4 with the
 *                      ORIGINAL spec MOUNTS and the seeded row STILL survives (the drift abort altered
 *                      nothing).
 *
 * The spec is minimal (one `notes` store + a store-create route + a store-get route; NO durableWorker,
 * NO agents) so no DBOS is launched — the survival of a plain product store is the whole point.
 *
 * UN-SKIPPABLE RAN-GUARD (the false-green class): a DB-backed
 * persistence proof must never SILENTLY self-skip. A separate, NON-skipped describe hard-FAILS when the
 * DB is REQUIRED (CI / RAYSPEC_REQUIRE_DB_TESTS) but the three scenarios did not run.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerScopedTables } from '@rayspec/db/testing';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assembleServer,
  BootConfigError,
  type BootedServer,
  loadServerConfig,
} from './composition-root.js';

// The minimal product spec — a `notes` store with a `text` column PLUS the rich business-column types
// a real product pack relies on (`integer`, `jsonb`, + a NOT-NULL UNIQUE non-text column). Exercising
// these through the actual MOUNT decision closes the rich-type no-drift round-trip gap: a regression to
// either type map (EXPECTED_DATA_TYPE in drift-detect vs PG_TYPE in generate-product-sql) for
// integer/jsonb would keep CI green but break every product reboot (false `drifted` → BootConfigError).
const SPEC_YAML = `
version: '1.0'
metadata:
  name: mount-test
  description: minimal mount-without-deploy boot fixture
stores:
  - name: notes
    columns:
      - { name: body, type: text }
      - { name: note_count, type: integer, nullable: true }
      - { name: note_meta, type: jsonb, nullable: true }
      - { name: note_rank, type: integer, unique: true, nullable: false }
api:
  - { method: POST, path: '/notes', action: { kind: store, store: notes, op: create } }
  - { method: GET, path: '/notes/{id}', action: { kind: store, store: notes, op: get } }
`;

// The DRIFT spec — identical EXCEPT it ADDS a column to the already-materialized store. The live table
// has no `note_title` → detectDrift reports a missing_column → classifyProductSchema → 'drifted' → boot
// fails closed (mount never alters a populated store).
const DRIFT_SPEC_YAML = `
version: '1.0'
metadata:
  name: mount-test
  description: drift fixture — adds a column to the materialized store
stores:
  - name: notes
    columns:
      - { name: body, type: text }
      - { name: note_count, type: integer, nullable: true }
      - { name: note_meta, type: jsonb, nullable: true }
      - { name: note_rank, type: integer, unique: true, nullable: false }
      - { name: note_title, type: text }
api:
  - { method: POST, path: '/notes', action: { kind: store, store: notes, op: create } }
  - { method: GET, path: '/notes/{id}', action: { kind: store, store: notes, op: get } }
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

const SUITE_DB = `rayspec_server_mount_${process.pid}`;
const EMAIL = 'mount@example.test';
const PASSWORD = 'correct-horse-battery-staple-9';

let securityTestsRan = 0;
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';

describe('mount-without-deploy — reboot preserves materialized product stores', () => {
  const baseUrl = process.env.DATABASE_URL;
  const maybe = baseUrl ? it : it.skip;

  let appDbUrl = '';
  let dbosSysDb = '';
  let tmpDir = '';
  let specPath = '';
  let driftSpecPath = '';
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    'RAYSPEC_JWT_SIGNING_KEY',
    'RAYSPEC_API_KEY_PEPPER',
    'DATABASE_URL',
    'ALLOWED_ORIGINS',
    'PORT',
    'RAYSPEC_SPEC_PATH',
    'DBOS_SYSTEM_DATABASE_URL',
  ] as const;

  // Cross-boot shared facts (the seeded row + the org it lives under).
  let seededId = '';
  let seededBody = '';
  let orgId = '';

  beforeAll(async () => {
    if (!baseUrl) return;
    appDbUrl = withDbName(baseUrl, SUITE_DB);
    dbosSysDb = `${SUITE_DB}_dbos_sys`; // this spec has no worker, but drop defensively on teardown.

    // Fresh empty throwaway APP database (drop any leftover app + derived DBOS-sys DB first).
    const admin = postgres(adminUrl(baseUrl), { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${dbosSysDb}" WITH (FORCE)`);
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE "${SUITE_DB}"`);
    } finally {
      await admin.end();
    }

    tmpDir = mkdtempSync(join(tmpdir(), 'rayspec-mount-boot-'));
    specPath = join(tmpDir, 'rayspec.yaml');
    driftSpecPath = join(tmpDir, 'rayspec.drift.yaml');
    writeFileSync(specPath, SPEC_YAML, 'utf8');
    writeFileSync(driftSpecPath, DRIFT_SPEC_YAML, 'utf8');

    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    process.env.RAYSPEC_JWT_SIGNING_KEY = await exportPKCS8(privateKey);
    process.env.RAYSPEC_API_KEY_PEPPER = 'mount-boot-pepper-only';
    process.env.DATABASE_URL = appDbUrl;
    delete process.env.ALLOWED_ORIGINS;
    process.env.PORT = '8802';
    delete process.env.DBOS_SYSTEM_DATABASE_URL;
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
        await admin.unsafe(`DROP DATABASE IF EXISTS "${dbosSysDb}" WITH (FORCE)`);
        await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    }
  }, 60_000);

  // Boot the real composition root against the throwaway DB with the given spec path. Registers the
  // built product tables through the A1 chokepoint hook (deploy() verifies the SAME instances).
  async function boot(whichSpecPath: string): Promise<BootedServer> {
    process.env.RAYSPEC_SPEC_PATH = whichSpecPath;
    const config = loadServerConfig();
    return assembleServer(config, {
      registerProductTables: (tables) => registerScopedTables([...tables.values()]),
    });
  }

  // Register a fresh user, create an org, switch into it → an owner-role (store:read/store:write) token.
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
      body: JSON.stringify({ name: 'Mount Co' }),
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

  // Log in the persisted user + switch into the persisted org → a fresh org-scoped token (cross-boot).
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
    '(1) from-clean: boot materializes the store; a seeded row is created',
    async () => {
      securityTestsRan++;
      const server = await boot(specPath);
      try {
        expect(server.deployMode).toBe('materialized');
        const { token, orgId: newOrgId } = await registerCreateOrgSwitch(server);
        orgId = newOrgId;
        const created = await server.app.request('/notes', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          // `note_rank` is NOT-NULL UNIQUE (a non-text column) — it MUST be supplied; note_count/note_meta
          // are nullable and omitted here (they still ride the no-drift classification of the live schema).
          // The create-body schema is keyed by camelCase (snakeToCamel) + strict, so the wire key is
          // `noteRank`; serializeRow maps it back to the author's snake_case `note_rank` on the response.
          body: JSON.stringify({ body: 'survive-me', noteRank: 7 }),
        });
        expect(created.status).toBe(201);
        const row = (await created.json()) as { id: string; body: string; note_rank: number };
        expect(row.body).toBe('survive-me');
        expect(row.note_rank).toBe(7);
        seededId = row.id;
        seededBody = row.body;
      } finally {
        await server.close();
      }
    },
    120_000,
  );

  maybe(
    '(2) from-existing: reboot MOUNTS (deployMode==="mounted") and the seeded row SURVIVES (no drop)',
    async () => {
      securityTestsRan++;
      expect(seededId).not.toBe(''); // depends on (1)
      const server = await boot(specPath);
      try {
        // The real no-op/no-drop proof: a 2nd boot of the SAME spec against a populated DB MOUNTS.
        expect(server.deployMode).toBe('mounted');
        const token = await loginSwitch(server, orgId);
        const got = await server.app.request(`/notes/${seededId}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(got.status).toBe(200);
        const row = (await got.json()) as { id: string; body: string; note_rank: number };
        expect(row.id).toBe(seededId);
        expect(row.body).toBe(seededBody); // the row from boot #1 survived the reboot
        // Reaching deployMode==='mounted' PROVES detectDrift returned [] for the integer+jsonb+unique
        // schema (else 'drifted' → BootConfigError → red); assert the non-text column survived too.
        expect(row.note_rank).toBe(7);
      } finally {
        await server.close();
      }
    },
    120_000,
  );

  maybe(
    '(3) drift→fail-closed: a spec that adds a column REJECTS at boot, and a re-mount still has the row',
    async () => {
      securityTestsRan++;
      expect(seededId).not.toBe(''); // depends on (1)
      // Boot #3: the drift spec (adds `note_title`) → the live table lacks it → 'drifted' → fail closed.
      // (assembleServer throws BEFORE returning a server, so there is nothing to close — the orphaned
      // pool is reaped by the afterAll DROP ... WITH FORCE; mount never ran DDL, so the row is intact.)
      await expect(boot(driftSpecPath)).rejects.toBeInstanceOf(BootConfigError);

      // Boot #4: the ORIGINAL spec mounts cleanly and the seeded row STILL survives (the drift abort
      // altered nothing — no auto-materialize, no drop).
      const server = await boot(specPath);
      try {
        expect(server.deployMode).toBe('mounted');
        const token = await loginSwitch(server, orgId);
        const got = await server.app.request(`/notes/${seededId}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(got.status).toBe(200);
        const row = (await got.json()) as { id: string; body: string };
        expect(row.body).toBe(seededBody);
      } finally {
        await server.close();
      }
    },
    120_000,
  );
});

/**
 * Ran-guard (the false-green class): a SEPARATE, NON-skipped describe that
 * fails the run when the DB is REQUIRED (CI / RAYSPEC_REQUIRE_DB_TESTS) but the three scenarios above
 * did NOT run — i.e. a CI run that lost DATABASE_URL silently skipped the data-survival proof. Registered
 * with NO beforeAll dependency, so even if the suite's setup throws-and-skips, `securityTestsRan` stays 0
 * and THIS test FAILS — a skipped persistence proof can never read as green in CI. A local dev with no DB
 * and no CI/opt-in still skips ergonomically.
 */
describe('mount-without-deploy — ran-guard (the persistence proof must not silently skip in CI)', () => {
  it('the three boot-survival scenarios ACTUALLY RAN when the DB is required (CI / opt-in)', () => {
    if (dbRequired) {
      expect(securityTestsRan).toBe(3);
    } else {
      expect(dbRequired).toBe(false);
    }
  });
});
