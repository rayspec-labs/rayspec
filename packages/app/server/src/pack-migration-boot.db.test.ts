/**
 * THE BOOT applies an extension pack's migration chain — measured through the REAL composition root.
 *
 * `pack-migrations.db.test.ts` beside this one proves the MIGRATOR half: it calls `applyMigrations`
 * and then `applyPackMigrations` itself, with chains the real loader resolved. That leaves the WIRING
 * unmeasured — the few lines in `assembleServer` that carry `loaded.migrations` out of
 * `mergeExtensions` and hand them to `applyPackMigrations` after the platform chain and before any
 * product DDL. Deleting that call left every suite green, which is the definition of an unproven
 * claim. So this suite touches none of the plumbing: it sets the deployment's spec path and lets the
 * boot do the whole thing.
 *
 *   (1) THE WIRING, ON GROUND TRUTH: `assembleServer` against a throwaway DATABASE with the fixture
 *       pack's own committed deployment document. Afterwards the pack's table EXISTS in the live
 *       database and `drizzle."__migrations_fixture-pack"` carries its row — neither of which any
 *       other code path in this boot could have produced.
 *   (2) AFTER THE PLATFORM CHAIN, PINNED BY THE DATABASE: the chain's foreign key targets `orgs`, a
 *       platform table, so the constraint below could not exist unless the platform chain had
 *       already run when the pack chain applied. The ordering is read back rather than asserted.
 *   (3) IDEMPOTENT ACROSS BOOTS: a second `assembleServer` on the same database re-applies nothing —
 *       the pack table is not recreated (which would throw) and the pack journal does not grow.
 *   (4) FAIL-THE-FIX: a deployment whose pack declares a chain the SCAN refuses ABORTS the boot with
 *       a `BootConfigError` naming the pack — the operator-actionable wrapping around
 *       `PackMigrationError`, which nothing else in the tree exercises. The accept control is (1):
 *       the same boot with a conforming chain comes up.
 *
 * Both packs are loaded by the PRODUCTION importer (compiled JavaScript only) — no `moduleImporter`
 * seam is injected here, because the wiring under test is the production one.
 *
 * DB ISOLATION: one whole throwaway DATABASE named with process.pid, as the neighbouring boot suites.
 * Skips without DATABASE_URL; the un-skippable ran-guard hard-fails a REQUIRED run that did not run.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTENSION_BRAND } from '@rayspec/platform';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assembleServer,
  BootConfigError,
  type BootedServer,
  loadServerConfig,
} from './composition-root.js';

const baseUrl = process.env.DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');

/** The in-tree fixture pack and the committed deployment document the boot's core grammar accepts. */
const PACK_ROOT = join(repoRoot, 'packages/test/fixture-pack');
const PACK_DOC = join(PACK_ROOT, 'rayspec.no-section.yaml');
const PACK_ID = 'fixture-pack';

const SUITE_DB = `rayspec_pack_boot_${process.pid}`;
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
let armsRan = 0;

if (dbRequired && !baseUrl) {
  throw new Error(
    'pack-migration-boot.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but ' +
      'absent — refusing to silently skip this DB-backed boot suite.',
  );
}

// The pack has to have been BUILT: the production importer loads compiled JavaScript only, and the
// chain the manifest declares is emitted beside the compiled entry. FAIL with the fix, never skip.
const PACK_ENTRY = join(PACK_ROOT, 'dist/index.js');
if (!existsSync(PACK_ENTRY)) {
  throw new Error(
    `the fixture pack is not built (${PACK_ENTRY} is absent) — run \`pnpm build\` before this ` +
      'suite; the loader imports compiled JavaScript only, so an unbuilt pack is an absent pack.',
  );
}

function adminUrl(url: string): string {
  const u = new URL(url);
  u.pathname = '/postgres';
  return u.toString();
}
function withDbName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

/** One scalar off the live database under test. */
/** Run one statement for its EFFECT — the seeding half of `scalar`, on its own connection. */
async function exec(url: string, sql: string): Promise<void> {
  const client = postgres(url, { max: 1 });
  try {
    await client.unsafe(sql);
  } finally {
    await client.end();
  }
}

/**
 * Register a fresh user, create an org and switch into it → an owner-role token plus the org id that
 * IS the tenant of every request made with it. Two of these give the read below a foreign tenant to
 * be wrong about, which is the only thing that makes its count falsifiable.
 */
async function registerCreateOrgSwitch(
  booted: { app: { request: (path: string, init?: RequestInit) => Promise<Response> } },
  email: string,
  orgName: string,
): Promise<{ token: string; orgId: string }> {
  const reg = await booted.app.request('/v1/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'Str0ng-Passw0rd!' }),
  });
  if (reg.status !== 201) throw new Error(`register failed: ${reg.status} ${await reg.text()}`);
  const t0 = ((await reg.json()) as { accessToken: string }).accessToken;
  const orgRes = await booted.app.request('/v1/orgs', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${t0}` },
    body: JSON.stringify({ name: orgName }),
  });
  if (orgRes.status !== 201) throw new Error(`org failed: ${orgRes.status} ${await orgRes.text()}`);
  const orgId = ((await orgRes.json()) as { id: string }).id;
  const sw = await booted.app.request(`/v1/orgs/${orgId}/switch`, {
    method: 'POST',
    headers: { authorization: `Bearer ${t0}` },
  });
  if (sw.status !== 200) throw new Error(`switch failed: ${sw.status} ${await sw.text()}`);
  return { token: ((await sw.json()) as { accessToken: string }).accessToken, orgId };
}

async function scalar(url: string, sql: string): Promise<string> {
  const client = postgres(url, { max: 1 });
  try {
    const rows = (await client.unsafe(sql)) as unknown as Record<string, unknown>[];
    return String(Object.values(rows[0] ?? { v: '' })[0]);
  } finally {
    await client.end();
  }
}

/**
 * A throwaway DEPLOYMENT whose pack declares a chain the scan refuses.
 *
 * The pack entry is written as compiled JavaScript carrying the same runtime brand `defineExtension`
 * stamps — imported from `@rayspec/platform` here rather than spelled out, so a change to the brand
 * breaks this fixture instead of silently making it un-loadable. The chain creates `orgs_shadow`,
 * which carries no declared prefix: exactly the class the scan exists to refuse, reaching the boot
 * through the ordinary loader rather than through a hand-built chain.
 */
function refusedDeployment(root: string): string {
  const packDir = join(root, 'refused-pack');
  mkdirSync(join(packDir, 'migrations', 'meta'), { recursive: true });
  writeFileSync(
    join(packDir, 'index.js'),
    'export default {\n' +
      `  __rayspecExtension: ${JSON.stringify(EXTENSION_BRAND)},\n` +
      "  version: '1.0.0',\n" +
      '  fragments: {},\n' +
      "  migrations: { dir: 'migrations', tablePrefix: 'fx_' },\n" +
      '};\n',
  );
  writeFileSync(
    join(packDir, 'migrations', '0000_x.sql'),
    'CREATE TABLE "orgs_shadow" ("id" uuid PRIMARY KEY NOT NULL);',
  );
  writeFileSync(
    join(packDir, 'migrations', 'meta', '_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'postgresql',
      entries: [
        { idx: 0, version: '7', when: 1_700_000_000_000, tag: '0000_x', breakpoints: true },
      ],
    }),
  );
  const doc = join(root, 'rayspec.yaml');
  writeFileSync(
    doc,
    `version: '1.0'
metadata:
  name: refused-pack-deployment
  description: a deployment whose pack declares a chain the scan refuses (the boot must abort)
extensions:
  - id: refused-pack
    module: ./refused-pack
    version: 1.0.0
`,
  );
  return doc;
}

describe.skipIf(!baseUrl)('the BOOT applies an extension pack’s migration chain', () => {
  let appDbUrl = '';
  let scratch = '';
  let refusedDoc = '';
  let server: BootedServer | undefined;
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    'RAYSPEC_JWT_SIGNING_KEY',
    'RAYSPEC_API_KEY_PEPPER',
    'DATABASE_URL',
    'ALLOWED_ORIGINS',
    'PORT',
    'RAYSPEC_SPEC_PATH',
    'RAYSPEC_HANDLER_ROOT',
  ] as const;

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

    scratch = mkdtempSync(join(tmpdir(), 'rayspec-pack-boot-'));
    refusedDoc = refusedDeployment(scratch);

    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    process.env.RAYSPEC_JWT_SIGNING_KEY = await exportPKCS8(privateKey);
    process.env.RAYSPEC_API_KEY_PEPPER = 'pack-boot-pepper-only';
    process.env.DATABASE_URL = appDbUrl;
    delete process.env.ALLOWED_ORIGINS;
    process.env.PORT = '8815';
  }, 120_000);

  afterAll(async () => {
    await server?.close();
    for (const k of ENV_KEYS) {
      const v = savedEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    if (baseUrl) {
      const admin = postgres(adminUrl(baseUrl), { max: 1 });
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    }
    if (dbRequired && armsRan === 0) {
      throw new Error(
        'pack-migration-boot.db.test: the DB was REQUIRED (CI / RAYSPEC_REQUIRE_DB_TESTS) but no ' +
          'arm ran — refusing to report a green that measured nothing.',
      );
    }
  }, 120_000);

  it('(1)+(2) the boot applies the pack’s chain, journaled, after the platform chain', async () => {
    armsRan += 1;
    process.env.RAYSPEC_SPEC_PATH = PACK_DOC;
    process.env.RAYSPEC_HANDLER_ROOT = PACK_ROOT;

    // No moduleImporter: the PRODUCTION path, which is the wiring under test.
    server = await assembleServer(loadServerConfig());

    // (1) the pack's own table, created by nothing else in this boot.
    expect(
      await scalar(appDbUrl, "SELECT to_regclass('public.fixture_pack_audit_events')::text"),
    ).toBe('fixture_pack_audit_events');
    // (1) journaled in the PACK's table, not the platform chain's.
    expect(await scalar(appDbUrl, `SELECT count(*) FROM drizzle."__migrations_${PACK_ID}"`)).toBe(
      '1',
    );

    // (2) the foreign key onto the platform's `orgs` — it could not exist unless the platform
    //     chain had already run when this chain applied. The ordering, read off the database.
    expect(
      await scalar(
        appDbUrl,
        `SELECT count(*) FROM information_schema.table_constraints tc
             JOIN information_schema.constraint_column_usage ccu
               ON ccu.constraint_name = tc.constraint_name
            WHERE tc.table_name = 'fixture_pack_audit_events'
              AND tc.constraint_type = 'FOREIGN KEY'
              AND ccu.table_name = 'orgs'`,
      ),
    ).toBe('1');
  }, 180_000);

  /**
   * (5) THE CHAIN AND THE ROUTE, COMPOSED — a contributed route READS a row this pack's own chain
   * created, over HTTP, on a real boot.
   *
   * The arms above prove the chain APPLIES. `pack-route-auth-parity.db.test.ts` proves a contributed
   * route is REACHABLE and refuses like a deployment route. Neither crossed the two: no shipped code
   * read a pack-owned table from a contributed handler, so the fact that a handler had no door onto
   * its own pack's tables had no red test anywhere — the pack's other route is deliberately
   * database-free and its own comment says why.
   *
   * This arm is the crossing, and it is deliberately here rather than in the api-auth harness: that
   * harness builds its schema by hand and is not the composition root, so it injects no factory and
   * the route could only be observed FAIL-CLOSING. Here `assembleServer` is the production wiring —
   * the pack chain really created the table, the composition root really built the door, and the
   * request really goes through `requireAuth → resolveTenant → requirePermission`.
   */
  it('(5) a contributed route reads a row the pack’s own chain created, over HTTP', async () => {
    armsRan += 1;
    process.env.RAYSPEC_SPEC_PATH = PACK_DOC;
    process.env.RAYSPEC_HANDLER_ROOT = PACK_ROOT;
    // Close whatever an earlier arm left booted before taking another HTTP pool: `afterAll` closes
    // only the LAST assignment, so reassigning without this leaks four connections for the suite —
    // which is how a pool flake gets manufactured.
    await server?.close();
    server = await assembleServer(loadServerConfig());

    // Two owner-role principals, each in its OWN org — which is the tenant the route will be scoped
    // to. Registering twice is what gives the arm a foreign tenant to be wrong about.
    const a = await registerCreateOrgSwitch(server, 'packdb-a@example.test', 'Pack DB A');
    const b = await registerCreateOrgSwitch(server, 'packdb-b@example.test', 'Pack DB B');
    expect(a.orgId).not.toBe(b.orgId);

    // Rows straight into the table the PACK'S CHAIN created — two for A, one for B. The foreign row
    // is what makes the count falsifiable: a route that dropped its tenant predicate answers 3 where
    // a scoped one answers 2, and without it both readings look identical.
    await exec(
      appDbUrl,
      `INSERT INTO fixture_pack_audit_events (tenant_id, actor, action, payload) VALUES
         ('${a.orgId}'::uuid, 'boot', 'created', '{}'::jsonb),
         ('${a.orgId}'::uuid, 'boot', 'updated', '{}'::jsonb),
         ('${b.orgId}'::uuid, 'boot', 'created', '{}'::jsonb)`,
    );

    const readAs = async (token: string): Promise<{ status: number; body: unknown }> => {
      const res = await server.app.request('/ext/fixture-pack/audit/count', {
        headers: { authorization: `Bearer ${token}` },
      });
      return { status: res.status, body: await res.json() };
    };

    // TWO, not three. The door does not rewrite a pack's SQL and is not a tenant filter — the same
    // posture a service's door has — so this number is the pack discharging that obligation with
    // `init.tenantId`, the one value a caller cannot influence.
    //
    // AND the GUC, which is what pins the MOUNT rather than the reach. The count alone cannot tell a
    // pinned door from a pooled one: the rows were committed by another connection and read the same
    // either way. `TenantDb.transaction` sets `app.current_tenant` with `is_local := true`, so it is
    // visible ONLY on the connection this request's transaction holds — a door on a second, pooled
    // connection reads the empty string. Without this assertion the whole change could degrade to
    // pooled and every suite would stay green, which is measured: turning the discriminator in
    // `pinnedConnectionOf` into "always pooled" left all three pack suites passing.
    expect(await readAs(a.token)).toEqual({
      status: 200,
      body: { tenantId: a.orgId, events: 2, tenantGucSeen: a.orgId },
    });

    // ACCEPT CONTROL, discriminating in the other direction: the second tenant sees its own single
    // row through the SAME route, and its own GUC. A handler answering a constant, or a door reading
    // nothing at all, would satisfy the assertions above and fail these.
    expect(await readAs(b.token)).toEqual({
      status: 200,
      body: { tenantId: b.orgId, events: 1, tenantGucSeen: b.orgId },
    });
  }, 180_000);

  it('(3) a SECOND boot on the same database re-applies nothing', async () => {
    armsRan += 1;
    process.env.RAYSPEC_SPEC_PATH = PACK_DOC;
    process.env.RAYSPEC_HANDLER_ROOT = PACK_ROOT;

    const second = await assembleServer(loadServerConfig());
    try {
      expect(await scalar(appDbUrl, `SELECT count(*) FROM drizzle."__migrations_${PACK_ID}"`)).toBe(
        '1',
      );
    } finally {
      await second.close();
    }
  }, 180_000);

  it('(4) FAIL-THE-FIX: a chain the scan refuses ABORTS the boot, naming the pack', async () => {
    armsRan += 1;
    process.env.RAYSPEC_SPEC_PATH = refusedDoc;
    process.env.RAYSPEC_HANDLER_ROOT = scratch;

    let caught: unknown;
    try {
      await assembleServer(loadServerConfig());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BootConfigError);
    const message = (caught as BootConfigError).message;
    expect(message).toMatch(/migration chain was refused/);
    expect(message).toContain("extension pack 'refused-pack'");
    expect(message).toMatch(/does not carry the declared table prefix 'fx_'/);
    // Nothing half-applied: the refused chain's table is not in the database.
    expect(await scalar(appDbUrl, "SELECT to_regclass('public.orgs_shadow')::text")).toBe('null');
  }, 180_000);
});
