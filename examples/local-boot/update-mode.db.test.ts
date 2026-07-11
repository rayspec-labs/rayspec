/**
 * WRAPPER UPDATE-MODE integration — the real composition root (`assembleServer` with the
 * `updateMigrations` seam) against a throwaway DATABASE proves the update LIFECYCLE END-TO-END on
 * ground truth (fail-the-fix, not pass-the-shape). It uses a whole throwaway DATABASE, env
 * save/restore, `loadServerConfig` + `assembleServer`, drop on teardown, and drives the wrapper's REAL
 * update path (`readUpdateMigrations` builds the delta from the on-disk `.sql` + reviewed-allowlist
 * `.json` a reviewed update authors) + `diffProductStores`.
 *
 * ONE throwaway DATABASE reused across the boots below (they MUST share the DB to prove data survival):
 *   1.  v1 MATERIALIZE  — boot on a clean DB (`deployMode==='materialized'`); seed a REAL `widgets` row.
 *   2.  v2 ADDITIVE     — write the v1→v2 delta (ADD nullable `color`) via `diffProductStores`, boot in
 *                         UPDATE mode (NO allowlist needed — additive) → `deployMode==='updated'`, the
 *                         SEEDED ROW SURVIVES (read it back) AND the new `color` column is live (a new
 *                         row carries it; the live catalog confirms it).
 *   2b. PLAIN REBOOT    — boot v2 with NO updateMigrations → the REAL classifier sees present-matching →
 *                         `deployMode==='mounted'` and report-only `drift` EMPTY (proves the update left
 *                         the schema drift-clean; an under-reconciled update would classify 'drifted').
 *   3.  v3 BLOCKED      — write the v2→v3 delta (DROP `color`, DESTRUCTIVE) + its machine-proposed
 *                         allowlist. Boot WITHOUT the allowlist → `deploy()` BLOCKS at [lint/gate] with a
 *                         `DeployError` (the delta never applies — the `color` column is STILL present).
 *   4.  v3 APPLIED      — boot WITH the reviewed allowlist → `deployMode==='updated'`, the `color` column
 *                         is DROPPED (end state matches v3) and the seeded row's `name` STILL survives.
 *   5.  INCOMPLETE      — the NEW spec (v4) adds TWO nullable columns but the reviewed delta adds only
 *                         ONE (applies clean, UNDER-reconciles). The update boot must FAIL CLOSED on the
 *                         residual drift — NOT boot green as 'updated' and brick the next reboot. Then
 *                         the COMPLETING delta recovers to `deployMode==='updated'`, `drift` empty.
 *
 * The specs are minimal (a `widgets` store + create/get routes; NO durableWorker, NO agents) so no DBOS
 * is launched — the survival + gate behavior of a plain product store is the whole point.
 *
 * UN-SKIPPABLE RAN-GUARD (the DB-backed false-green class): a DB-backed proof must never SILENTLY
 * self-skip. A separate, NON-skipped describe hard-FAILS when the DB is REQUIRED
 * (CI / RAYSPEC_REQUIRE_DB_TESTS) but the six scenarios did not run.
 */
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffProductStores } from '@rayspec/db';
import { registerScopedTables } from '@rayspec/db/testing';
import {
  assembleServer,
  BootConfigError,
  type BootedServer,
  DeployError,
  loadServerConfig,
  type PlannedMigration,
} from '@rayspec/server';
import { type RaySpec, parseSpec } from '@rayspec/spec';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readUpdateMigrations } from './serve.js';

// ── The three spec versions (a `widgets` store evolving name → +color → −color) ───────────────────
const V1_YAML = `
version: '1.0'
metadata:
  name: update-test
  description: v1 — widgets with a name only
stores:
  - name: widgets
    columns:
      - { name: name, type: text }
api:
  - { method: POST, path: '/widgets', action: { kind: store, store: widgets, op: create } }
  - { method: GET, path: '/widgets/{id}', action: { kind: store, store: widgets, op: get } }
`;

const V2_YAML = `
version: '1.0'
metadata:
  name: update-test
  description: v2 — widgets gains a nullable color (ADDITIVE)
stores:
  - name: widgets
    columns:
      - { name: name, type: text }
      - { name: color, type: text, nullable: true }
api:
  - { method: POST, path: '/widgets', action: { kind: store, store: widgets, op: create } }
  - { method: GET, path: '/widgets/{id}', action: { kind: store, store: widgets, op: get } }
`;

const V3_YAML = `
version: '1.0'
metadata:
  name: update-test
  description: v3 — color dropped (DESTRUCTIVE)
stores:
  - name: widgets
    columns:
      - { name: name, type: text }
api:
  - { method: POST, path: '/widgets', action: { kind: store, store: widgets, op: create } }
  - { method: GET, path: '/widgets/{id}', action: { kind: store, store: widgets, op: get } }
`;

// v4 evolves widgets with TWO new nullable columns (size + weight) — used by the incomplete-delta arm:
// the FINAL spec declares both, but the reviewed delta under-reconciles (adds only `size`).
const V4_PARTIAL_YAML = `
version: '1.0'
metadata:
  name: update-test
  description: v4 (intermediate) — widgets gains only size (the under-reconciling delta's target)
stores:
  - name: widgets
    columns:
      - { name: name, type: text }
      - { name: size, type: text, nullable: true }
api:
  - { method: POST, path: '/widgets', action: { kind: store, store: widgets, op: create } }
  - { method: GET, path: '/widgets/{id}', action: { kind: store, store: widgets, op: get } }
`;

const V4_YAML = `
version: '1.0'
metadata:
  name: update-test
  description: v4 — widgets gains size AND weight (both nullable, ADDITIVE)
stores:
  - name: widgets
    columns:
      - { name: name, type: text }
      - { name: size, type: text, nullable: true }
      - { name: weight, type: text, nullable: true }
api:
  - { method: POST, path: '/widgets', action: { kind: store, store: widgets, op: create } }
  - { method: GET, path: '/widgets/{id}', action: { kind: store, store: widgets, op: get } }
`;

function parseValid(yaml: string): RaySpec {
  const r = parseSpec(yaml);
  if (!r.ok) throw new Error(`fixture invalid: ${r.errors.map((e) => e.message).join('; ')}`);
  return r.value;
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

const SUITE_DB = `rayspec_local_update_${process.pid}`;
const EMAIL = 'update@example.test';
const PASSWORD = 'correct-horse-battery-staple-9';

let securityTestsRan = 0;
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';

describe('local-boot update mode — the reviewed forward-delta lifecycle', () => {
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
  let v4Path = '';
  // Cross-boot shared facts (the seeded row + the org it lives under).
  let seededId = '';
  let orgId = '';

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

    tmpDir = mkdtempSync(join(tmpdir(), 'rayspec-local-update-'));
    v1Path = join(tmpDir, 'v1.yaml');
    v2Path = join(tmpDir, 'v2.yaml');
    v3Path = join(tmpDir, 'v3.yaml');
    v4Path = join(tmpDir, 'v4.yaml');
    writeFileSync(v1Path, V1_YAML, 'utf8');
    writeFileSync(v2Path, V2_YAML, 'utf8');
    writeFileSync(v3Path, V3_YAML, 'utf8');
    writeFileSync(v4Path, V4_YAML, 'utf8');

    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    // A dev RS256 signer as a PKCS#8 PEM (exactly what createSigner's importPKCS8 expects) — via
    // node:crypto so this dev harness needs no jose dependency.
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    process.env.RAYSPEC_JWT_SIGNING_KEY = privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString();
    process.env.RAYSPEC_API_KEY_PEPPER = 'local-update-pepper-only';
    process.env.DATABASE_URL = appDbUrl;
    delete process.env.ALLOWED_ORIGINS;
    process.env.PORT = '8803';
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

  // Boot the real composition root against the throwaway DB. `updateMigrations` present ⇒ UPDATE mode
  // (NO drop; the reviewed delta is gated + applied by deploy()); absent ⇒ first-deploy/mount.
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

  // Ground truth: is a given `widgets.<col>` column present in the LIVE schema? (non-vacuous — the
  // deploy gate's block vs apply, and the drift gate's mid-state, are proven against the real catalog.)
  async function widgetsHasColumn(col: string): Promise<boolean> {
    const c = postgres(appDbUrl, { max: 1 });
    try {
      const rows = await c`
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'widgets' and column_name = ${col}`;
      return rows.length > 0;
    } finally {
      await c.end();
    }
  }
  const widgetsHasColor = (): Promise<boolean> => widgetsHasColumn('color');

  // Write the v(old)→v(new) delta a reviewed update would author (via diffProductStores) to disk + its
  // machine-proposed allowlist, then build the wrapper's PlannedMigration[] via the REAL
  // readUpdateMigrations helper (with/without the allowlist file — the two update-review arms).
  function buildDelta(
    oldYaml: string,
    newYaml: string,
    base: string,
    withAllowlist: boolean,
  ): PlannedMigration[] {
    const diff = diffProductStores(parseValid(oldYaml).stores, parseValid(newYaml).stores, {
      label: base,
    });
    const sqlPath = join(tmpDir, `${base}.sql`);
    writeFileSync(sqlPath, diff.migrationSql, 'utf8');
    let allowlistPath: string | undefined;
    if (withAllowlist) {
      allowlistPath = join(tmpDir, `${base}.allowlist.json`);
      writeFileSync(allowlistPath, JSON.stringify(diff.proposedAllowlist, null, 2), 'utf8');
    }
    return readUpdateMigrations({
      migrationPath: sqlPath,
      ...(allowlistPath ? { allowlistPath } : {}),
    });
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
      body: JSON.stringify({ name: 'Update Co' }),
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
    '(1) v1 materialize: boot creates the store; a seeded widget row is created',
    async () => {
      securityTestsRan++;
      const server = await boot(v1Path);
      try {
        expect(server.deployMode).toBe('materialized');
        const { token, orgId: newOrgId } = await registerCreateOrgSwitch(server);
        orgId = newOrgId;
        const created = await server.app.request('/widgets', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ name: 'survive-me' }),
        });
        expect(created.status).toBe(201);
        const row = (await created.json()) as { id: string; name: string };
        expect(row.name).toBe('survive-me');
        seededId = row.id;
        expect(await widgetsHasColor()).toBe(false); // starting state: no color column
      } finally {
        await server.close();
      }
    },
    120_000,
  );

  maybe(
    '(2) v2 ADDITIVE update: the delta applies, the seeded row SURVIVES, and color is live',
    async () => {
      securityTestsRan++;
      expect(seededId).not.toBe(''); // depends on (1)
      const migrations = buildDelta(V1_YAML, V2_YAML, '0001_add_color', false); // additive → no allowlist
      const server = await boot(v2Path, migrations);
      try {
        expect(server.deployMode).toBe('updated');
        // Ground truth: the ADD COLUMN really applied.
        expect(await widgetsHasColor()).toBe(true);
        const token = await loginSwitch(server, orgId);
        // The seeded row survived the in-place update (no drop/recreate).
        const got = await server.app.request(`/widgets/${seededId}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(got.status).toBe(200);
        expect(((await got.json()) as { name: string }).name).toBe('survive-me');
        // The new column is live end-to-end: a fresh row can carry color, read back on GET.
        const created = await server.app.request('/widgets', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ name: 'has-color', color: 'red' }),
        });
        expect(created.status).toBe(201);
        const newId = ((await created.json()) as { id: string }).id;
        const back = await server.app.request(`/widgets/${newId}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(((await back.json()) as { color: string }).color).toBe('red');
      } finally {
        await server.close();
      }
    },
    120_000,
  );

  maybe(
    '(2b) post-update PLAIN reboot (no updateMigrations): the classifier sees present-matching → MOUNTED, drift empty',
    async () => {
      securityTestsRan++;
      expect(await widgetsHasColor()).toBe(true); // depends on (2): the additive update landed
      // Boot the SAME v2 spec with NO updateMigrations — the ordinary reboot path. This proves through
      // the REAL classifyProductSchema that the v2 update left the live schema DRIFT-CLEAN vs the spec:
      // a residual/under-reconciled update would classify 'drifted' here and fail closed. Mounted ⇒ no
      // product DDL ran (existing data survived), and the report-only drift surfaced empty.
      const server = await boot(v2Path);
      try {
        expect(server.deployMode).toBe('mounted');
        expect(server.drift).toEqual([]);
      } finally {
        await server.close();
      }
    },
    120_000,
  );

  maybe(
    '(3) v3 DESTRUCTIVE without an allowlist: deploy() BLOCKS at [lint/gate]; color NOT dropped',
    async () => {
      securityTestsRan++;
      expect(await widgetsHasColor()).toBe(true); // depends on (2)
      const migrations = buildDelta(V2_YAML, V3_YAML, '0002_drop_color', false); // NO reviewed allowlist
      // deploy() throws DeployError at [lint/gate] (propagates through assembleServer — boot rejects).
      const err = await boot(v3Path, migrations).catch((e) => e);
      expect(err).toBeInstanceOf(DeployError);
      expect((err as DeployError).step).toBe('lint/gate');
      // GROUND TRUTH: the destructive DROP COLUMN was NEVER applied — the column is still present.
      expect(await widgetsHasColor()).toBe(true);
    },
    120_000,
  );

  maybe(
    '(4) v3 DESTRUCTIVE with the reviewed allowlist: applies; color dropped; the row survives',
    async () => {
      securityTestsRan++;
      expect(await widgetsHasColor()).toBe(true); // depends on (3): still present after the block
      const migrations = buildDelta(V2_YAML, V3_YAML, '0002_drop_color', true); // reviewed allowlist file
      const server = await boot(v3Path, migrations);
      try {
        expect(server.deployMode).toBe('updated');
        // Ground truth: the reviewed DROP COLUMN really applied (end state matches v3).
        expect(await widgetsHasColor()).toBe(false);
        // The seeded row's surviving column is intact (the drop preserved the rest of the row).
        const token = await loginSwitch(server, orgId);
        const got = await server.app.request(`/widgets/${seededId}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(got.status).toBe(200);
        expect(((await got.json()) as { name: string }).name).toBe('survive-me');
      } finally {
        await server.close();
      }
    },
    120_000,
  );

  maybe(
    '(5) INCOMPLETE delta (under-reconciles the NEW spec): update boot FAILS CLOSED on residual drift; the completing delta recovers',
    async () => {
      securityTestsRan++;
      // Starting state (after (4)): widgets(name). The NEW spec (v4) adds TWO nullable columns
      // (size + weight), but the reviewed delta authored here under-reconciles it — it adds ONLY `size`
      // (built as the v3→v4-PARTIAL diff). Both statements are ADDITIVE, so the delta passes the
      // [lint/gate] and APPLIES cleanly — the failure mode guarded here is precisely an applies-clean-
      // but-incomplete delta that would otherwise boot green as 'updated' and brick the NEXT reboot.
      expect(await widgetsHasColumn('size')).toBe(false);
      expect(await widgetsHasColumn('weight')).toBe(false);
      const incomplete = buildDelta(V3_YAML, V4_PARTIAL_YAML, '0003_add_size', false); // adds size only
      // Boot UPDATE mode with the FINAL v4 spec (name + size + weight) + the incomplete delta. deploy()
      // applies ADD size (committed), then the post-migrate drift check finds `weight` still missing.
      // The update boot fails CLOSED with a BootConfigError — it does NOT return deployMode
      // 'updated'. (Against the UNGATED code this resolves to a BootedServer with deployMode:'updated'
      // and a non-empty `drift` — the delayed-brick hazard; that green boot is the red evidence.)
      const err = await boot(v4Path, incomplete).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BootConfigError);
      expect((err as Error).message).toMatch(/STILL DRIFTED/);
      // GROUND TRUTH: the delta really committed a MID-STATE — `size` applied, `weight` did not.
      expect(await widgetsHasColumn('size')).toBe(true);
      expect(await widgetsHasColumn('weight')).toBe(false);

      // RECOVERY (forward-fix discipline): author + apply the COMPLETING delta (v4-PARTIAL→v4 = ADD
      // weight). The update now reconciles fully → deployMode 'updated' and drift EMPTY (a real path,
      // not prose). A down-migration / hand-patch is never used.
      const completing = buildDelta(V4_PARTIAL_YAML, V4_YAML, '0004_add_weight', false);
      const recovered = await boot(v4Path, completing);
      try {
        expect(recovered.deployMode).toBe('updated');
        expect(recovered.drift).toEqual([]);
        expect(await widgetsHasColumn('weight')).toBe(true);
      } finally {
        await recovered.close();
      }
      // …and the recovery reached a genuine MOUNTING state: a subsequent PLAIN reboot (no
      // updateMigrations) now classifies present-matching → 'mounted', drift empty — the REAL classifier
      // confirming the completed delta left the live schema fully drift-clean vs the v4 spec.
      const reboot = await boot(v4Path);
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
 * the DB is REQUIRED (CI / RAYSPEC_REQUIRE_DB_TESTS) but the six scenarios above did NOT run — a CI
 * run that lost DATABASE_URL silently skipped the update-lifecycle proof. Registered with NO beforeAll
 * dependency, so a suite whose setup throws-and-skips still leaves `securityTestsRan` at 0 and THIS
 * test FAILS. A local dev with no DB and no opt-in skips ergonomically.
 */
describe('local-boot update mode — ran-guard (the update-lifecycle proof must not silently skip)', () => {
  it('the six update-lifecycle scenarios ACTUALLY RAN when the DB is required (CI / opt-in)', () => {
    if (dbRequired) {
      expect(securityTestsRan).toBe(6);
    } else {
      expect(dbRequired).toBe(false);
    }
  });
});

/**
 * NON-DB unit coverage for the wrapper's `readUpdateMigrations` fail-closed contract (runs always — no
 * DB). These pin the actionable errors the update mode surfaces before it ever touches a database.
 */
describe('readUpdateMigrations — fail-closed on missing/malformed inputs (no DB)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rayspec-rum-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('throws when RAYSPEC_UPDATE_MIGRATION is absent', () => {
    expect(() => readUpdateMigrations({})).toThrow(/RAYSPEC_UPDATE_MIGRATION/);
  });

  it('throws when the delta .sql path is unreadable', () => {
    expect(() => readUpdateMigrations({ migrationPath: join(tmp, 'nope.sql') })).toThrow(
      /unreadable/,
    );
  });

  it('builds one PlannedMigration keyed by filename with an empty allowlist when none is given', () => {
    const sqlPath = join(tmp, '0001_add.sql');
    writeFileSync(sqlPath, 'ALTER TABLE "widgets" ADD COLUMN "color" text;', 'utf8');
    const [m] = readUpdateMigrations({ migrationPath: sqlPath });
    expect(m.name).toBe('0001_add.sql');
    expect(m.sql).toContain('ADD COLUMN "color"');
    expect(m.allowlist).toEqual([]);
  });

  it('throws when the allowlist file is not a JSON array of entries', () => {
    const sqlPath = join(tmp, '0002_drop.sql');
    writeFileSync(sqlPath, 'ALTER TABLE "widgets" DROP COLUMN "color";', 'utf8');
    const bad = join(tmp, 'bad.json');
    writeFileSync(bad, '{"not":"an array"}', 'utf8');
    expect(() => readUpdateMigrations({ migrationPath: sqlPath, allowlistPath: bad })).toThrow(
      /must be a JSON array/,
    );
  });

  it('parses a well-formed reviewed allowlist file into entries', () => {
    const sqlPath = join(tmp, '0003_drop.sql');
    writeFileSync(sqlPath, 'ALTER TABLE "widgets" DROP COLUMN "color";', 'utf8');
    const ok = join(tmp, 'ok.json');
    writeFileSync(
      ok,
      JSON.stringify([
        {
          kind: 'drop-column',
          match: 'ALTER TABLE "widgets" DROP COLUMN "color"',
          reason: 'reviewed',
        },
      ]),
      'utf8',
    );
    const [m] = readUpdateMigrations({ migrationPath: sqlPath, allowlistPath: ok });
    expect(m.allowlist).toHaveLength(1);
    expect(m.allowlist?.[0]?.kind).toBe('drop-column');
  });
});
