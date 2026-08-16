/**
 * THE BOOT starts an extension pack's long-lived SERVICES — measured through the REAL composition root.
 *
 * `extensions/pack-services.test.ts` in @rayspec/platform proves the ORCHESTRATOR half with fakes:
 * declaration-order boot, reverse-order shutdown, a failing boot that unwinds and names its pack. That
 * leaves the WIRING unmeasured — the few lines in `deployDeclaredSpec` that carry `loaded.services` out
 * of the merge, build each pack's context, and boot them after the migrations and before this function
 * returns the app an entrypoint listens on. Deleting that call would leave every other suite green,
 * which is the definition of an unproven claim. So this suite touches none of the plumbing: it sets the
 * deployment's spec path and lets the boot do the whole thing.
 *
 *   (1) THE WIRING, AND THE ORDER, ON GROUND TRUTH: `assembleServer` against a throwaway DATABASE with
 *       the fixture pack's OWN committed deployment document. When it RESOLVES — before any entrypoint
 *       can have created a listener — both of the pack's services have already booted, in the order the
 *       manifest declares them.
 *   (2) AFTER THE MIGRATIONS, PINNED BY THE DATABASE: the first service reads `fixture_pack_audit_events`
 *       through the context's database door at boot. That table is created by the pack's OWN migration
 *       chain, which the same boot applied moments earlier — so a service that booted before the chain
 *       could not have read it at all. The ordering is read back rather than asserted.
 *   (3) THE PACK'S OWN VALIDATED SECTION reaches its service: the document writes `auditing:` — a key
 *       the CORE grammar does not own — and the service is handed `retentionDays: 30` as its own
 *       validator returned it. Nothing else on this boot could have produced that value.
 *   (4) THE JOURNAL WRITER writes real rows: with the deployment tenant bound, the sweep the service
 *       runs at boot lands in `journal_steps`, attributed to `pack-service`, and the TIMER it armed
 *       lands more without anything calling it — the whole reason this contribution kind exists.
 *   (5) SHUTDOWN IS THE REVERSE, and it really stops the work: `close()` shuts the two services down
 *       in the reverse of boot order, and the timer stops ticking afterwards.
 *   (6) FAIL-THE-FIX: a deployment whose pack ships a service that throws on boot ABORTS the boot with
 *       a `BootConfigError` naming the pack AND the service. The accept control is (1): the same boot
 *       with working services comes up.
 *
 * WHAT MAKES (1) AND (5) OBSERVABLE AT ALL: the fixture pack's services record what they did in a
 * module of their own (`services/observed.ts`). A test that imports the SAME compiled module the
 * deployment loaded reads the very instance they wrote to — the module registry is keyed by resolved
 * path — so boot order and shutdown order are read off the pack rather than inferred from a side effect.
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

/** The in-tree fixture pack, and the committed document that WRITES the section its pack claims. */
const PACK_ROOT = join(repoRoot, 'packages/test/fixture-pack');
const PACK_DOC = join(PACK_ROOT, 'rayspec.yaml');
const PACK_ID = 'fixture-pack';

/** The compiled service-observation module — the SAME instance the deployment's services write to. */
const OBSERVED_MODULE = join(PACK_ROOT, 'dist/services/observed.js');

const SUITE_DB = `rayspec_pack_service_${process.pid}`;
/** The deployment tenant the journal writer and the dispatch capability are bound to. */
const TENANT = '00000000-0000-4000-8000-00000000042a';
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
let armsRan = 0;

if (dbRequired && !baseUrl) {
  throw new Error(
    'pack-service-boot.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but ' +
      'absent — refusing to silently skip this DB-backed boot suite.',
  );
}

// The pack has to have been BUILT: the production importer loads compiled JavaScript only, and the
// services the manifest declares are emitted beside the compiled entry. FAIL with the fix, never skip.
const PACK_ENTRY = join(PACK_ROOT, 'dist/index.js');
if (!existsSync(PACK_ENTRY)) {
  throw new Error(
    `the fixture pack is not built (${PACK_ENTRY} is absent) — run \`pnpm build\` before this ` +
      'suite; the loader imports compiled JavaScript only, so an unbuilt pack is an absent pack.',
  );
}

/**
 * The observation module the fixture pack's services write to, loaded from the SAME compiled path the
 * deployment loaded it from — the module registry is keyed by resolved path, so this IS their instance.
 */
interface Observed {
  readonly events: string[];
  readonly contexts: Map<
    string,
    {
      readonly sectionKeys: string[];
      readonly retentionDays?: number;
      readonly journal: boolean;
      readonly dispatch: boolean;
      readonly ledgerRows?: number;
    }
  >;
  readonly ticks: Map<string, number>;
  reset(): void;
}
async function observed(): Promise<Observed> {
  return (await import(OBSERVED_MODULE)) as unknown as Observed;
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
async function scalar(url: string, sql: string): Promise<string> {
  const client = postgres(url, { max: 1 });
  try {
    const rows = (await client.unsafe(sql)) as unknown as Record<string, unknown>[];
    return String(Object.values(rows[0] ?? { v: '' })[0]);
  } finally {
    await client.end();
  }
}

/** Run one statement against the database under test. */
async function exec(url: string, sql: string, params: unknown[] = []): Promise<void> {
  const client = postgres(url, { max: 1 });
  try {
    await client.unsafe(sql, params as never[]);
  } finally {
    await client.end();
  }
}

/**
 * A throwaway DEPLOYMENT whose pack ships a service that throws on boot.
 *
 * The pack entry is written as compiled JavaScript carrying the same runtime brand `defineExtension`
 * stamps — imported from `@rayspec/platform` here rather than spelled out, so a change to the brand
 * breaks this fixture instead of silently making it un-loadable. The service is a real module with a
 * real `{ name, boot, shutdown }`; only its `boot` throws, so what this arm measures is the boot
 * FAILING rather than the module being rejected at load.
 */
function refusedDeployment(root: string): string {
  const packDir = join(root, 'broken-pack');
  mkdirSync(join(packDir, 'services'), { recursive: true });
  writeFileSync(
    join(packDir, 'index.js'),
    'export default {\n' +
      `  __rayspecExtension: ${JSON.stringify(EXTENSION_BRAND)},\n` +
      "  version: '1.0.0',\n" +
      '  fragments: {},\n' +
      "  services: [{ module: 'services/wont-start.js' }],\n" +
      '};\n',
  );
  writeFileSync(
    join(packDir, 'services', 'wont-start.js'),
    'export default {\n' +
      "  name: 'wont-start',\n" +
      "  boot() { throw new Error('the upstream queue is unreachable'); },\n" +
      '  shutdown() {},\n' +
      '};\n',
  );
  const doc = join(root, 'rayspec.yaml');
  writeFileSync(
    doc,
    `version: '1.0'
metadata:
  name: broken-service-deployment
  description: a deployment whose pack ships a service that cannot start (the boot must abort)
extensions:
  - id: broken-pack
    module: ./broken-pack
    version: 1.0.0
`,
  );
  return doc;
}

describe.skipIf(!baseUrl)('the BOOT starts an extension pack’s long-lived services', () => {
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
    'RAYSPEC_CRON_TENANT_ID',
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

    scratch = mkdtempSync(join(tmpdir(), 'rayspec-pack-service-'));
    refusedDoc = refusedDeployment(scratch);

    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    process.env.RAYSPEC_JWT_SIGNING_KEY = await exportPKCS8(privateKey);
    process.env.RAYSPEC_API_KEY_PEPPER = 'pack-service-pepper-only';
    process.env.DATABASE_URL = appDbUrl;
    delete process.env.ALLOWED_ORIGINS;
    process.env.PORT = '8817';
    // The DEPLOYMENT tenant the journal writer is bound to. It has to be a REGISTERED org, because a
    // journal row carries a foreign key onto `orgs` — so the platform chain runs first (a throwaway
    // boot of the same document with no tenant bound), then the org is registered, then the arms below
    // boot with it bound. That first boot is also the accept control for the no-journal posture.
    delete process.env.RAYSPEC_CRON_TENANT_ID;
    process.env.RAYSPEC_SPEC_PATH = PACK_DOC;
    process.env.RAYSPEC_HANDLER_ROOT = PACK_ROOT;
    const first = await assembleServer(loadServerConfig());
    await first.close();
    await exec(appDbUrl, "INSERT INTO orgs (id, name, slug) VALUES ($1, 'Fixture', 'fixture')", [
      TENANT,
    ]);
    process.env.RAYSPEC_CRON_TENANT_ID = TENANT;
  }, 180_000);

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
        'pack-service-boot.db.test: the DB was REQUIRED (CI / RAYSPEC_REQUIRE_DB_TESTS) but no ' +
          'arm ran — refusing to report a green that measured nothing.',
      );
    }
  }, 120_000);

  it('(1)–(5) both services boot in order, with their own section, and stop in reverse', async () => {
    armsRan += 1;
    process.env.RAYSPEC_SPEC_PATH = PACK_DOC;
    process.env.RAYSPEC_HANDLER_ROOT = PACK_ROOT;

    const record = await observed();
    record.reset();

    // No moduleImporter: the PRODUCTION path, which is the wiring under test.
    server = await assembleServer(loadServerConfig());

    // (1) Both services have ALREADY booted by the time assembleServer resolves — which is before any
    //     entrypoint could have created a listener — and in the order the manifest declares them.
    expect(record.events).toEqual(['audit-ledger:boot', 'turn-scheduler:boot']);

    const ledger = record.contexts.get('audit-ledger');
    // (2) The service read its pack's OWN table through the context's database door. That table is
    //     created by the pack's own migration chain, which THIS boot applied — a service booted before
    //     the migrations could not have read it at all.
    expect(ledger?.ledgerRows).toBe(0);
    // (3) The pack's own claimed section reached its service, validated by the pack's own grammar, and
    //     ONLY the key this pack claims (the union of every pack's claims is not what a service gets).
    expect(ledger?.sectionKeys).toEqual(['auditing']);
    expect(ledger?.retentionDays).toBe(30);
    // The tenant is bound on this boot, so there IS a journal writer; no durable worker is wired, so
    // there is NO dispatch capability — the fail-closed absence the second service reads and reports.
    expect(ledger?.journal).toBe(true);
    expect(record.contexts.get('turn-scheduler')?.dispatch).toBe(false);

    // (4) The sweep the service ran at boot is in the run journal, attributed to a pack service — and
    //     the timer it armed keeps adding to it with nothing calling in.
    const sweptAtBoot = Number(
      await scalar(
        appDbUrl,
        "SELECT count(*)::int FROM journal_steps WHERE backend = 'pack-service'",
      ),
    );
    expect(sweptAtBoot).toBeGreaterThanOrEqual(1);
    await new Promise((r) => setTimeout(r, 250));
    const sweptOnTimer = Number(
      await scalar(
        appDbUrl,
        "SELECT count(*)::int FROM journal_steps WHERE backend = 'pack-service'",
      ),
    );
    expect(sweptOnTimer).toBeGreaterThan(sweptAtBoot);

    // (5) close() stops them in the exact REVERSE of boot order — and the timer really stops.
    await server.close();
    server = undefined;
    expect(record.events).toEqual([
      'audit-ledger:boot',
      'turn-scheduler:boot',
      'turn-scheduler:shutdown',
      'audit-ledger:shutdown',
    ]);
    const ticksAtShutdown = record.ticks.get('audit-ledger') ?? 0;
    await new Promise((r) => setTimeout(r, 200));
    expect(record.ticks.get('audit-ledger') ?? 0).toBe(ticksAtShutdown);
  }, 180_000);

  it('(6) FAIL-THE-FIX: a service that cannot start ABORTS the boot, naming pack and service', async () => {
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
    expect(message).toMatch(/service .*failed to boot/);
    expect(message).toContain("extension 'broken-pack'");
    expect(message).toContain('wont-start');
    expect(message).toContain('the upstream queue is unreachable');
  }, 180_000);

  it('the fixture pack is the one the deployment document pins', async () => {
    armsRan += 1;
    // Guards the two arms above against a fixture that quietly stopped being the pack under test.
    expect(await scalar(appDbUrl, `SELECT count(*) FROM drizzle."__migrations_${PACK_ID}"`)).toBe(
      '1',
    );
  }, 60_000);
});
