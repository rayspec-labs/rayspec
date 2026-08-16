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
 *       could not have read it at all. The ordering is read back rather than asserted. The same door is
 *       what the ledger WRITES through, and it writes TRANSACTIONALLY: the pair of rows that are only
 *       ever right together lands in one callback, and a second callback that throws mid-write leaves
 *       nothing behind. What the table holds afterwards — read on a connection of this suite's own —
 *       is the committed pair and no trace of the abandoned one, and the error the service caught is
 *       the one it threw. `pack-service-db.db.test.ts` measures the door's own guarantees (the pin, the
 *       lock, the rollback, the refused nesting); this arm is the WIRING — that the door a service is
 *       actually handed by the composition root is that door.
 *   (3) THE PACK'S OWN VALIDATED SECTION reaches its service: the document writes `auditing:` — a key
 *       the CORE grammar does not own — and the service is handed `retentionDays: 30` as its own
 *       validator returned it. Nothing else on this boot could have produced that value. The MERGED
 *       DOCUMENT and the ENVIRONMENT are read back the same way — the document by its own
 *       `metadata.name`, the environment by a key only this suite sets — because an empty object in
 *       either slot is indistinguishable from the real one until something asks.
 *   (4) THE JOURNAL WRITER writes real rows: with the deployment tenant bound, the sweep the service
 *       runs at boot lands in `journal_steps`, attributed to `pack-service`, and the TIMER it armed
 *       lands more without anything calling it — the whole reason this contribution kind exists. And
 *       the tenant those rows carry is the DEPLOYMENT's, not something the pack chose: read through
 *       the platform's own tenant chokepoint under a DIFFERENT tenant, the work this service did —
 *       transactions included — is nothing at all. A pack has no `tenantId` on its context to name one
 *       with, in or out of a transaction, so opening one cannot be the seam it widens its reach
 *       through. The accept control is the same read under the deployment tenant, which finds them.
 *   (5) SHUTDOWN IS THE REVERSE, and it really stops the work: `close()` shuts the two services down
 *       in the reverse of boot order, and the timer stops ticking afterwards.
 *   (6) FAIL-THE-FIX: a deployment whose pack ships a service that throws on boot ABORTS the boot with
 *       a `BootConfigError` naming the pack AND the service. The accept control is (1): the same boot
 *       with working services comes up.
 *   (7) `TurnDispatch` IS BUILT AND HANDED OVER BY THIS COMPOSITION ROOT, and what it schedules is a
 *       real run. The pack's committed sibling document wires a durable worker and declares the agent,
 *       so the boot builds the capability, binds it to the deployment tenant and gives it to the
 *       service — which schedules a turn and gets a runId whose `runs` header is really there, under
 *       that tenant, with the identity the agent registry resolved, and whose job really runs. Arm
 *       (1)–(5) is its accept control: same pack, same services, a document with no durable worker,
 *       and the capability slot is ABSENT. Without this arm the whole build-and-bind step could be
 *       deleted and every other suite here would stay green.
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
import type { AgentSpec, Backend, BackendId, RunContext, RunResult } from '@rayspec/core';
import { forTenant, makeDb, schema } from '@rayspec/db';
import { EXTENSION_BRAND } from '@rayspec/platform';
import { eq } from 'drizzle-orm';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assembleServer,
  BootConfigError,
  type BootedServer,
  loadServerConfig,
} from './composition-root.js';

/**
 * A deterministic, network-free backend wired as `openai` — the same shape every other durable-worker
 * boot suite in this package injects. It exists so the run the pack's service schedules can actually
 * EXECUTE on the worker: what this suite measures is the scheduling, not the model call.
 */
class FakeBackend implements Backend {
  readonly id = 'openai' as const;
  async resolveAuth() {
    return 'api-key' as const;
  }
  async run(spec: AgentSpec, ctx: RunContext): Promise<RunResult> {
    const finalText = `echo: ${spec.input}`;
    await ctx.journal.record({
      type: 'llm',
      idempotencyKey: `llm:${spec.name}:0`,
      inputHash: `hash:${spec.input}`,
      output: { finalText },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      costUsd: 0,
      model: spec.model,
      producedBy: 'fake-pack-service-backend',
      latencyMs: 1,
      status: 'ok',
      authMode: 'api-key',
    });
    return {
      runId: ctx.runId,
      backend: this.id,
      authMode: 'api-key',
      status: 'completed',
      finalText,
      output: null,
      error: null,
      errorClass: null,
      conversation: [],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      costUsd: 0,
      stepCount: 1,
    };
  }
}

const baseUrl = process.env.DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');

/** The in-tree fixture pack, and the committed document that WRITES the section its pack claims. */
const PACK_ROOT = join(repoRoot, 'packages/test/fixture-pack');
const PACK_DOC = join(PACK_ROOT, 'rayspec.yaml');
/** The committed sibling document that WIRES A DURABLE WORKER and declares the agent to schedule. */
const DURABLE_DOC = join(PACK_ROOT, 'rayspec.durable.yaml');
const PACK_ID = 'fixture-pack';

/** The compiled service-observation module — the SAME instance the deployment's services write to. */
const OBSERVED_MODULE = join(PACK_ROOT, 'dist/services/observed.js');

/**
 * The environment key the pack's services read off `ctx.env`, set by this suite BEFORE it boots. It is
 * how `ctx.env` becomes measurable at all: without a value only this suite sets, an `env` that arrived
 * empty and an `env` that arrived whole look the same.
 */
const ENV_MARKER_KEY = 'RAYSPEC_FIXTURE_PACK_MARKER';
const ENV_MARKER_VALUE = 'set-by-the-pack-service-boot-suite';

const SUITE_DB = `rayspec_pack_service_${process.pid}`;
/** The durable arm boots a REAL DBOS engine; the composition root derives this system sibling. */
const DBOS_SYS_DB = `${SUITE_DB}_dbos_sys`;
/** The deployment tenant the journal writer and the dispatch capability are bound to. */
const TENANT = '00000000-0000-4000-8000-00000000042a';
/** A tenant this deployment never bound — what the cross-tenant read in arm (4b) asks under. */
const OTHER_TENANT = '00000000-0000-4000-8000-00000000042b';
/** The `backend` column a pack service's journal step is attributed to (the composition root's own). */
const PACK_SERVICE_BACKEND = 'pack-service';
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
      readonly specName?: string;
      readonly envMarker?: string;
      readonly journal: boolean;
      readonly dispatch: boolean;
      readonly ledgerRows?: number;
      readonly ledgerPairRows?: number;
      readonly abandonedError?: string;
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

/** One ROW off the live database under test (undefined when the query selects none). */
async function row(
  url: string,
  sql: string,
  params: unknown[] = [],
): Promise<Record<string, unknown> | undefined> {
  const client = postgres(url, { max: 1 });
  try {
    const rows = (await client.unsafe(sql, params as never[])) as unknown as Record<
      string,
      unknown
    >[];
    return rows[0];
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
    'DBOS_SYSTEM_DATABASE_URL',
    ENV_MARKER_KEY,
  ] as const;

  beforeAll(async () => {
    if (!baseUrl) return;
    appDbUrl = withDbName(baseUrl, SUITE_DB);
    const admin = postgres(adminUrl(baseUrl), { max: 1 });
    try {
      // The derived DBOS system sibling first — it is what holds a connection to nothing else.
      await admin.unsafe(`DROP DATABASE IF EXISTS "${DBOS_SYS_DB}" WITH (FORCE)`);
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
    delete process.env.DBOS_SYSTEM_DATABASE_URL;
    // Set BEFORE any boot, so `ctx.env` carries a value only this suite could have put there.
    process.env[ENV_MARKER_KEY] = ENV_MARKER_VALUE;
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
        await admin.unsafe(`DROP DATABASE IF EXISTS "${DBOS_SYS_DB}" WITH (FORCE)`);
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
    // (2b) And it WROTE through the same door, transactionally. The pair landed together; the second
    //      transaction, abandoned mid-write by a throw, landed nothing — and the error the service
    //      caught is the one it threw, unchanged. Both facts are read back off the DATABASE on this
    //      suite's own connection, so a service that merely believed it had written proves nothing.
    expect(ledger?.ledgerPairRows).toBe(2);
    expect(ledger?.abandonedError).toBe('the ledger sweep was abandoned mid-write');
    const ledgerAction = async (action: string): Promise<string> =>
      await scalar(
        appDbUrl,
        `SELECT count(*)::int FROM fixture_pack_audit_events WHERE action = '${action}'`,
      );
    expect(await ledgerAction('ledger-opened')).toBe('1');
    expect(await ledgerAction('ledger-closed')).toBe('1');
    expect(await ledgerAction('ledger-abandoned')).toBe('0');
    // (3) The pack's own claimed section reached its service, validated by the pack's own grammar, and
    //     ONLY the key this pack claims (the union of every pack's claims is not what a service gets).
    expect(ledger?.sectionKeys).toEqual(['auditing']);
    expect(ledger?.retentionDays).toBe(30);
    // (3b) The MERGED DOCUMENT and the ENVIRONMENT are on the contract too, and both are read back off
    //      what the service was handed: the document by its own `metadata.name`, the environment by a
    //      key only this suite sets. An empty object in either slot reads identically to a whole one
    //      unless something asks, so both services ask.
    expect(ledger?.specName).toBe('fixture-pack-deployment');
    expect(ledger?.envMarker).toBe(ENV_MARKER_VALUE);
    expect(record.contexts.get('turn-scheduler')?.specName).toBe('fixture-pack-deployment');
    expect(record.contexts.get('turn-scheduler')?.envMarker).toBe(ENV_MARKER_VALUE);
    // The tenant is bound on this boot, so there IS a journal writer; no durable worker is wired, so
    // there is NO dispatch capability — the fail-closed absence the second service reads and reports.
    // This is the ACCEPT CONTROL for arm (7) below, which boots the sibling document that wires one.
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

    // (4b) TENANCY IS THE PLATFORM'S, AND A TRANSACTION DOES NOT MOVE IT. The same rows, read through
    //      the platform's OWN tenant chokepoint: under a different tenant there are none, and under
    //      the deployment tenant they are all there. The pack never named either — its context carries
    //      no `tenantId` at all, in a transaction or out of one — so the attribution is the
    //      deployment's doing and nothing a service opened could have widened it.
    const probe = makeDb(appDbUrl);
    try {
      const byPackService = eq(schema.journalSteps.backend, PACK_SERVICE_BACKEND);
      const otherTenant = await forTenant(probe, OTHER_TENANT)
        .select(schema.journalSteps)
        .where(byPackService);
      expect(otherTenant).toHaveLength(0);
      const deploymentTenant = await forTenant(probe, TENANT)
        .select(schema.journalSteps)
        .where(byPackService);
      // At LEAST what the raw count above found — the timer is still ticking between the two reads,
      // so the accept control is "every one of them is there", not a frozen number.
      expect(deploymentTenant.length).toBeGreaterThanOrEqual(sweptOnTimer);
    } finally {
      await probe.$client.end();
    }

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

  /**
   * (7) THE CAPABILITY, THROUGH THE REAL COMPOSITION ROOT — the headline of this seam, on ground truth.
   *
   * Every other measurement of `TurnDispatch` drives it with a hand-built context and a fake executor,
   * which pins the capability's own contract and says nothing about the few lines in the composition
   * root that BUILD it: the tenant it closes over, the executor it is handed, and the registry its
   * `resolveAgent` reads. Those lines can be gutted — `makeTurnDispatch(...)` never called, or called
   * with the wrong tenant — and every fake-driven suite stays green.
   *
   * So this arm boots the pack's committed sibling document, which wires a REAL durable worker and
   * declares the agent the service schedules, and reads back:
   *   • the service was handed a capability at all (arm (1)–(5) is the accept control: the same pack,
   *     the same services, a document with no durable worker, and the slot is ABSENT there);
   *   • it scheduled a turn and got a runId — through the composition root's own capability;
   *   • that runId has a real `runs` header, under the DEPLOYMENT tenant, carrying the identity the
   *     registry resolved for the declared agent. Nothing else on this deployment can start a run: it
   *     declares no route serving the agent and no trigger firing it, so the header can only have come
   *     from the pack's service.
   *   • and the run RUNS: the enqueue landed on the launched engine, so the job reaches a terminal
   *     status rather than sitting in a queue nobody dequeues.
   */
  it('(7) with a durable worker wired, the service is handed a REAL TurnDispatch and schedules a real turn', async () => {
    armsRan += 1;
    process.env.RAYSPEC_SPEC_PATH = DURABLE_DOC;
    process.env.RAYSPEC_HANDLER_ROOT = PACK_ROOT;

    const record = await observed();
    record.reset();
    const scheduler = (await import(join(PACK_ROOT, 'dist/services/turn-scheduler.js'))) as {
      scheduled: string[];
    };
    scheduler.scheduled.length = 0;

    // The deterministic backend is injected the way every durable-worker boot suite here injects one;
    // the WIRING under test is still the production one (no moduleImporter, no executor seam).
    const durable = await assembleServer(loadServerConfig(), {
      agentBackendsFactory: (): ReadonlyMap<BackendId, Backend> =>
        new Map<BackendId, Backend>([['openai', new FakeBackend()]]),
    });
    try {
      // The capability is PRESENT on this deployment, and absent on the other — one variable.
      expect(record.contexts.get('turn-scheduler')?.dispatch).toBe(true);
      expect(record.contexts.get('turn-scheduler')?.specName).toBe(
        'fixture-pack-durable-deployment',
      );

      // The service scheduled exactly one turn, and kept the runId the platform handed back.
      expect(scheduler.scheduled).toHaveLength(1);
      const runId = scheduler.scheduled[0] as string;
      expect(runId).toMatch(/^[0-9a-f-]{36}$/);

      // The enqueue-time run HEADER is real, is the platform's own, and is stamped with the DEPLOYMENT
      // tenant — the tenant the composition root bound, which the request object has no field for.
      const header = await row(
        appDbUrl,
        'SELECT tenant_id, agent_name, model, backend, status FROM runs WHERE run_id = $1',
        [runId],
      );
      expect(header, `no run header for ${runId}`).toBeDefined();
      expect(header?.tenant_id).toBe(TENANT);
      // The identity came from the SAME registry the worker resolves against, for the declared agent.
      expect(header?.agent_name).toBe('fixture-follow-up-agent');
      expect(header?.model).toBe('gpt-4o-mini');
      expect(header?.backend).toBe('openai');

      // And it is a real job on the launched engine, not a row: it reaches a terminal status.
      const deadline = Date.now() + 30_000;
      let status = String(header?.status ?? '');
      while (status !== 'completed' && status !== 'error' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
        status = String(
          (await row(appDbUrl, 'SELECT status FROM runs WHERE run_id = $1', [runId]))?.status ?? '',
        );
      }
      expect(status, `the scheduled run never reached a terminal status (last: ${status})`).toBe(
        'completed',
      );
    } finally {
      await durable.close();
    }
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
