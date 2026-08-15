/**
 * TRIGGER CAPABILITY PARITY — which capabilities a fired TRIGGER handler's init carries, end to end
 * through the REAL composition root.
 *
 * A cron trigger whose action is a `handler` is dispatched by the cron scheduler, not by the api
 * interpreter, so its init is built by a DIFFERENT builder from the one a `handler`-kind route goes
 * through. The three DEPLOYMENT-STATIC capabilities — `init.fsSource`, `init.stt`, `init.tts` — reach
 * it only because the composition root threads the handles it already built into the scheduler's deps
 * and the scheduler forwards them to `invokeTriggerHandler`. Every one of those deps is OPTIONAL, so
 * deleting the whole pass-through typechecks and lints clean and leaves the platform's own injection
 * tests green: they prove `invokeTriggerHandler` honours arguments handed to it directly, not that
 * anything ever hands them over. This suite is what makes the wiring un-deletable.
 *
 * It boots a whole live deployment (`assembleServer`) against a throwaway DATABASE, configured the way
 * a deployer configures these — a source root on the box (`RAYSPEC_FS_SOURCE_ROOT`) and both speech
 * providers selected as their offline fakes (`STT_PROVIDER`/`TTS_PROVIDER`) — then fires the declared
 * cron→handler trigger through the composition root's own `fireCronNow` seam and reads what the
 * handler observed back out of the deployment's own store:
 *
 *   - THE THREE THAT CROSS: `fsSource`, `stt`, `tts` are PRESENT (read with the `in` idiom, so an
 *     `undefined`-valued key cannot pass as a capability) and each one is USED, not merely counted:
 *     the handler reads the configured root's own bytes back, transcribes to a completed transcript,
 *     and synthesizes to the offline provider's honest content type. A present-but-inert handle
 *     satisfies a flag; it cannot produce any of those three.
 *   - THE TWO THAT DO NOT: `emit` and `enqueue` are ABSENT. Both are ones this deployment actually
 *     BUILT — the spec enables the event bus and wires the durable worker — so these are measurements
 *     of the seam rather than unconfigured blanks. They are also the INSTRUMENT CHECK on the five
 *     readings: they come from the same handler, the same `in` idiom and the same report row, so a
 *     harness that reported presence blindly would read `true` for these too.
 *
 * The other direction — a scheduler wired with NONE of the three fires a handler whose init carries
 * none of them, ABSENT rather than `undefined` — is measured at the dispatch itself in
 * @rayspec/durable-dbos's cron-scheduler.db.test.ts, which drives the same `invokeTriggerHandler`
 * without booting a server.
 *
 * DETERMINISTIC BY DESIGN: no network. Both speech providers are the offline fakes, and the handler
 * module is self-contained native ESM loaded through the REAL path-jailed loader.
 *
 * DB ISOLATION: a whole throwaway DATABASE (not a per-schema), exactly as durable-worker-boot.db.test.ts
 * — the migration chain materializes the platform into a database's default + `drizzle` schema. This
 * suite launches a REAL DBOS engine, so it also drops the derived `<appdb>_dbos_sys` on teardown, and
 * it boots ONCE: DBOS is a per-process singleton, so a second launch in one file is refused.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Backend, BackendId } from '@rayspec/core';
import { registerScopedTables } from '@rayspec/db/testing';
import type { PgTable } from 'drizzle-orm/pg-core';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assembleServer, type BootedServer, loadServerConfig } from './composition-root.js';

/** The store the fired handler records its report into (a store name IS its table name). */
const STORE_TABLE = 'trigger_caps_marks';
/** The declared cron trigger this suite fires. */
const TRIGGER_NAME = 'caps-digest';
/** The root-relative file the deployment's fs-source root holds, and its EXACT bytes. */
const SOURCE_FILE = 'digest-source.txt';
const SOURCE_MARKER = 'trigger-capability-marker';
/** The deployment tenant the trigger fires under (a well-formed org id this suite registers itself). */
const CRON_TENANT = '00000000-0000-0000-0000-0000000000dd';

/**
 * The spec: a durable worker (a cron trigger requires one), the event bus ENABLED, the store the
 * handler writes its report into, and a cron trigger whose action is a HANDLER — the dispatch path
 * this suite exists for. The bus is enabled so `init.emit`'s absence on the trigger init is the seam
 * and not an unconfigured blank; the worker is wired for the same reason on `init.enqueue`.
 */
const SPEC_YAML = `
version: '1.0'
metadata:
  name: trigger-capability-parity
  description: one cron trigger whose handler reports the capabilities its init carried
deployment:
  durableWorker: true
  eventBus:
    enabled: true
stores:
  - name: ${STORE_TABLE}
    columns:
      - { name: note, type: text }
handlers:
  - id: caps_digest_handler
    module: handlers/caps-digest.mjs
    export: reportCapabilities
    kind: trigger
triggers:
  - name: ${TRIGGER_NAME}
    kind: cron
    schedule: '0 3 * * *'
    action: { kind: handler, handler: caps_digest_handler }
`;

/**
 * The declared TRIGGER handler, written to the temp handler root and loaded through the REAL
 * path-jailed loader. Self-contained native ESM (no imports), so it loads identically under vitest and
 * a plain node boot. It reports PRESENCE with the `in` idiom — an `undefined`-valued key would read as
 * present and let a half-wired composition root pass — then USES each capability it got, and records
 * the whole report through `init.db` so the assertions read it back out of the database.
 */
const HANDLER_MJS = `
export async function reportCapabilities(init) {
  const present = {
    fsSource: 'fsSource' in init,
    stt: 'stt' in init,
    tts: 'tts' in init,
    emit: 'emit' in init,
    enqueue: 'enqueue' in init,
  };
  let sourceText = null;
  if (present.fsSource) {
    const read = await init.fsSource.read('${SOURCE_FILE}');
    sourceText = read && read.bytes ? new TextDecoder().decode(read.bytes).trim() : null;
  }
  let transcript = null;
  if (present.stt) {
    const result = await init.stt.transcribe(new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02]), {
      contentType: 'audio/ogg',
    });
    transcript = result.status === 'completed' ? result.transcript.full_text : null;
  }
  let spokenContentType = null;
  if (present.tts) {
    const speech = await init.tts.synthesize('the digest is ready');
    spokenContentType = speech.contentType;
  }
  await init.db.insert('${STORE_TABLE}', {
    note: JSON.stringify({
      tenant: init.tenantId,
      trigger: init.triggerName,
      present,
      sourceText,
      transcript,
      spokenContentType,
    }),
  });
}
`;

/** What the fired trigger handler recorded about the init it was handed. */
interface TriggerCapabilityReport {
  readonly tenant: string;
  readonly trigger: string;
  readonly present: {
    readonly fsSource: boolean;
    readonly stt: boolean;
    readonly tts: boolean;
    readonly emit: boolean;
    readonly enqueue: boolean;
  };
  /** The text the handler read through `init.fsSource` (null when the handle was absent). */
  readonly sourceText: string | null;
  /** The transcript `init.stt` returned (null when the handle was absent or the call did not complete). */
  readonly transcript: string | null;
  /** The content type `init.tts` reported for its audio (null when the handle was absent). */
  readonly spokenContentType: string | null;
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

const SUITE_DB = `rayspec_server_trigcaps_${process.pid}`;
const DBOS_SYS_DB = `${SUITE_DB}_dbos_sys`;

describe('trigger capability parity — what a fired cron→handler init carries, end to end', () => {
  const baseUrl = process.env.DATABASE_URL;
  const maybe = baseUrl ? it : it.skip;
  const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
  // un-skippable ran-guard (fires synchronously at collection): when the DB is REQUIRED but absent,
  // hard-fail rather than let this DB-backed suite silently self-skip to a false green.
  if (requireDb && !baseUrl) {
    throw new Error(
      'trigger-capability-parity.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) ' +
        'but absent — refusing to silently skip this DB-backed suite.',
    );
  }

  let server: BootedServer | undefined;
  let appDbUrl = '';
  let tmpDir = '';
  let sourceRoot = '';
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    'RAYSPEC_JWT_SIGNING_KEY',
    'RAYSPEC_API_KEY_PEPPER',
    'DATABASE_URL',
    'ALLOWED_ORIGINS',
    'PORT',
    'RAYSPEC_SPEC_PATH',
    'RAYSPEC_HANDLER_ROOT',
    'RAYSPEC_FS_SOURCE_ROOT',
    'RAYSPEC_CRON_TENANT_ID',
    'DBOS_SYSTEM_DATABASE_URL',
    'STT_PROVIDER',
    'TTS_PROVIDER',
  ] as const;

  beforeAll(async () => {
    if (!baseUrl) return;
    appDbUrl = withDbName(baseUrl, SUITE_DB);

    const admin = postgres(adminUrl(baseUrl), { max: 1 });
    try {
      // The derived DBOS system sibling first (it is what holds a connection to nothing else).
      await admin.unsafe(`DROP DATABASE IF EXISTS "${DBOS_SYS_DB}" WITH (FORCE)`);
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE "${SUITE_DB}"`);
    } finally {
      await admin.end();
    }

    // A temp dir holding the spec, the handler root and the deployment's READ-ONLY source root.
    tmpDir = mkdtempSync(join(tmpdir(), 'rayspec-trigger-caps-'));
    writeFileSync(join(tmpDir, 'rayspec.yaml'), SPEC_YAML, 'utf8');
    mkdirSync(join(tmpDir, 'handlers'), { recursive: true });
    writeFileSync(join(tmpDir, 'handlers', 'caps-digest.mjs'), HANDLER_MJS, 'utf8');
    sourceRoot = join(tmpDir, 'source-root');
    mkdirSync(sourceRoot, { recursive: true });
    writeFileSync(join(sourceRoot, SOURCE_FILE), SOURCE_MARKER, 'utf8');

    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    process.env.RAYSPEC_JWT_SIGNING_KEY = await exportPKCS8(privateKey);
    process.env.RAYSPEC_API_KEY_PEPPER = 'trigger-caps-pepper-only';
    process.env.DATABASE_URL = appDbUrl;
    delete process.env.ALLOWED_ORIGINS;
    delete process.env.DBOS_SYSTEM_DATABASE_URL;
    process.env.PORT = '8809';
    process.env.RAYSPEC_SPEC_PATH = join(tmpDir, 'rayspec.yaml');
    // The handler module path is `handlers/caps-digest.mjs`; the jail root is that directory's parent.
    process.env.RAYSPEC_HANDLER_ROOT = tmpDir;
    process.env.RAYSPEC_FS_SOURCE_ROOT = sourceRoot;
    process.env.RAYSPEC_CRON_TENANT_ID = CRON_TENANT;
    process.env.STT_PROVIDER = 'fake';
    process.env.TTS_PROVIDER = 'fake';
  }, 120_000);

  afterAll(async () => {
    await server?.close().catch(() => {});
    for (const k of ENV_KEYS) {
      const v = savedEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    if (baseUrl) {
      const admin = postgres(adminUrl(baseUrl), { max: 1 });
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${DBOS_SYS_DB}" WITH (FORCE)`);
        await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    }
  }, 60_000);

  maybe(
    'a fired cron→handler trigger receives the deployment-static init.fsSource/init.stt/init.tts — ' +
      'each one working — and neither init.emit nor init.enqueue',
    async () => {
      const config = loadServerConfig();
      // The deployment configured all three; the boot is what turns that into wired handles.
      expect(config.sttProvider).toBe('fake');
      expect(config.ttsProvider).toBe('fake');
      expect(config.fsSourceRoot).toBe(sourceRoot);

      server = await assembleServer(config, {
        // The declared handler needs no backend of its own, but the durable worker a cron trigger
        // requires is only constructed when a backend registry is injected.
        agentBackendsFactory: (): ReadonlyMap<BackendId, Backend> => new Map<BackendId, Backend>(),
        registerProductTables: (tables: ReadonlyMap<string, PgTable>) => {
          registerScopedTables([...tables.values()]);
        },
      });
      // The composition root wired the scheduler from the deployed trigger registry.
      expect(server.declaredCronTriggers).toContain(TRIGGER_NAME);

      // The deployment tenant, registered against the RUNNING application (the late-binding seam). A
      // fire under an unknown org is skipped, so this is what makes the dispatch below a real one.
      const seedDb = postgres(appDbUrl, { max: 1 });
      try {
        await seedDb.unsafe(
          `INSERT INTO orgs (id, name, slug) VALUES ($1, 'caps-tenant', 'caps-tenant') ON CONFLICT (id) DO NOTHING`,
          [CRON_TENANT],
        );
      } finally {
        await seedDb.end();
      }

      // FIRE through the composition root's OWN seam: env → composition root → cron scheduler →
      // `invokeTriggerHandler` → the declared handler's init.
      const instant = new Date('2026-06-24T03:00:00.000Z');
      expect(await server.fireCronNow?.(TRIGGER_NAME, instant)).toBe(true);

      // GROUND TRUTH out of the deployment's own store — the report crossed the handler's tenant
      // transaction to get there, so a dispatch that never ran cannot read as an empty report.
      const readDb = postgres(appDbUrl, { max: 1 });
      let report: TriggerCapabilityReport;
      try {
        const rows = await readDb.unsafe<Array<{ note: string }>>(
          `SELECT note FROM "${STORE_TABLE}"`,
        );
        expect(rows.length).toBe(1); // the handler ran exactly once
        report = JSON.parse(String(rows[0]?.note)) as TriggerCapabilityReport;
      } finally {
        await readDb.end();
      }

      expect(report.tenant).toBe(CRON_TENANT);
      expect(report.trigger).toBe(TRIGGER_NAME);

      // THE THREE THAT CROSS — present, and each one did REAL work. FAIL-THE-FIX: the scheduler's
      // capability deps are optional, so deleting the composition-root spreads that fill them (or the
      // dispatch that forwards them) typechecks and lints clean; only these readings turn red.
      expect(report.present.fsSource).toBe(true);
      expect(report.present.stt).toBe(true);
      expect(report.present.tts).toBe(true);
      expect(report.sourceText).toBe(SOURCE_MARKER);
      expect(typeof report.transcript).toBe('string');
      expect((report.transcript ?? '').length).toBeGreaterThan(0);
      // The offline synthesizer always answers WAV and says so honestly (it encodes nothing).
      expect(report.spokenContentType).toBe('audio/wav');

      // THE TWO THAT DO NOT — and the instrument check on all five readings: both are capabilities
      // THIS deployment built (the bus is enabled, the worker is wired), and both are reported by the
      // same handler through the same `in` idiom, so a blindly-affirmative report would read `true`
      // here too.
      expect(report.present.emit).toBe(false);
      expect(report.present.enqueue).toBe(false);
    },
    180_000,
  );
});
