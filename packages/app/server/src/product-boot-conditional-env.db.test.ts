/**
 * DOC-DRIVEN env demands, on GROUND TRUTH through the REAL composition root
 * (`assembleServer` → `deployProductYamlSpec`) against throwaway DATABASEs. Two fail-the-fix invariants:
 *
 *   A. THE ACME-NOTES GUARDRAIL (acme-notes STILL demands ALL FOUR): booting the REAL examples/acme-notes/acme-notes.product.yaml
 *      with each of RAYSPEC_BLOB_ROOT / RAYSPEC_MEDIA_SIGNING_KEY / RAYSPEC_EXTRACTION_MODE /
 *      STT_PROVIDER individually MISSING throws the SPECIFIC ProductBootError BEFORE any DBOS launch. A
 *      conditional-demand predicate that stopped demanding a var acme-notes needs would boot green and fail
 *      only at the first real recording — this pins each demand at the boot (green both before AND after the conditional-demand change; it
 *      goes RED the instant the predicate mis-computes for acme-notes).
 *
 *   B. THE CONDITIONAL (non-audio boots demanding NOTHING — RED-first): the committed NON-audio,
 *      zero-agent, no-stt fixture (record_input only) boots the FULL server path with NONE of the four
 *      env vars set → deployMode 'materialized', the record submit + declared view routes MOUNT, and it
 *      SERVES (401 on the submit route without auth). Previously the boot demanded RAYSPEC_EXTRACTION_MODE
 *      UNCONDITIONALLY (`requireEnv`), so this boot THREW — the RED this arm flips to green.
 *
 *   C. THE SINGLE-PREDICATE NON-COLLINEAR arms (F1/F2 — each demand coupled to its OWN predicate):
 *      F1 boots a NON-audio doc that DECLARES an agent (hasAgents=true, withAudio=false, usesStt=false)
 *      with all four unset → it must throw the RAYSPEC_EXTRACTION_MODE demand, NOT RAYSPEC_BLOB_ROOT
 *      (a `withAudio && hasAgents` coupling would skip the demand → RED). F2 boots a doc with an stt.*
 *      step but NO audio capability → the step-5 fail-closed NAMED ProductBootError (never a raw crash).
 *
 *   D. THE GENERALIZED BLOB DEMAND: a FILE-only doc (file_input, no audio) demands
 *      RAYSPEC_BLOB_ROOT with a message NAMING file_input (the `withAudio || withFileInput` blob
 *      predicate; the audio message stays byte-unchanged), and arm B's intake doc additionally pins
 *      that a doc NOT declaring file_input mounts ZERO file surface (404 on the file routes over HTTP)
 *      — and ZERO conversation surface likewise (404 on both conversation routes).
 *
 * DBOS-SINGLETON: exactly ONE full launch (arm B, LAST). The four acme-notes arms + F1 + F2 THROW at the env
 * demands (steps 3–5 of deployProductYamlSpec), which run BEFORE the DBOS executor is even constructed —
 * so they never launch. Skips without DATABASE_URL; the un-skippable ran-guard hard-fails a REQUIRED run
 * that didn't run (the false-green class).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryAgentHandlerRegistry } from '@rayspec/agent-runtime';
import { registerScopedTables } from '@rayspec/db/testing';
import { FakeSttAdapter } from '@rayspec/stt-port';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assembleServer, type BootedServer, loadServerConfig } from './composition-root.js';

const baseUrl = process.env.DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const ACME_YAML = resolve(here, '../../../../examples/acme-notes/acme-notes.product.yaml');
const NON_AUDIO_YAML = resolve(here, '__fixtures__/non-audio-intake.product.yaml');
// F1: a NON-audio doc that DECLARES an agent (hasAgents=true, withAudio=false, usesStt=false).
const NON_AUDIO_AGENT_YAML = resolve(here, '__fixtures__/non-audio-agent.product.yaml');
// F2: an stt.* step WITHOUT the audio capability (usesStt=true, withAudio=false, hasAgents=false).
const STT_NO_AUDIO_YAML = resolve(here, '__fixtures__/stt-no-audio.product.yaml');
// a FILE-only doc (file_input, no audio/record/stt/agents) — the generalized blob demand.
const FILE_ONLY_YAML = resolve(here, '__fixtures__/file-ingest.product.yaml');

const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
let armsRan = 0;

const DEMAND_DB = `rayspec_s4_demand_${process.pid}`; // shared, read-only (the throw arms never write)
const INTAKE_DB = `rayspec_s4_intake_${process.pid}`; // the ONE full boot + launch
const TENANT = '00000000-0000-4000-8000-0000000000e4';

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

/** A deterministic agent registry covering acme-notes's declared agent (so the stt arm reaches step 5). */
function acmeAgents(): InMemoryAgentHandlerRegistry {
  const registry = new InMemoryAgentHandlerRegistry();
  registry.register('agent.note_extractor', () => []);
  return registry;
}

describe.skipIf(!baseUrl)('Product-YAML boot — doc-driven env demands', () => {
  let demandDbUrl = '';
  let intakeDbUrl = '';
  let intakeServer: BootedServer | undefined;
  let blobDir = '';
  const saved: Record<string, string | undefined> = {};
  const ENV = [
    'RAYSPEC_JWT_SIGNING_KEY',
    'RAYSPEC_API_KEY_PEPPER',
    'DATABASE_URL',
    'ALLOWED_ORIGINS',
    'PORT',
    'RAYSPEC_SPEC_PATH',
    'DBOS_SYSTEM_DATABASE_URL',
    'RAYSPEC_PRODUCT_TENANT_ID',
    'STT_PROVIDER',
    'RAYSPEC_EXTRACTION_MODE',
    'RAYSPEC_BLOB_ROOT',
    'RAYSPEC_MEDIA_SIGNING_KEY',
  ] as const;

  /** Set the FOUR doc-driven env vars to valid values (each arm then deletes the one under test). */
  function setAllFour(): void {
    process.env.STT_PROVIDER = 'fake';
    process.env.RAYSPEC_EXTRACTION_MODE = 'deterministic';
    process.env.RAYSPEC_BLOB_ROOT = blobDir;
    process.env.RAYSPEC_MEDIA_SIGNING_KEY = 's4-media-secret-at-least-32-bytes-xxxxxxxx';
  }
  function clearAllFour(): void {
    delete process.env.STT_PROVIDER;
    delete process.env.RAYSPEC_EXTRACTION_MODE;
    delete process.env.RAYSPEC_BLOB_ROOT;
    delete process.env.RAYSPEC_MEDIA_SIGNING_KEY;
  }

  async function boot(
    specPath: string,
    dbUrl: string,
    inject: { stt: boolean; agents: boolean },
  ): Promise<BootedServer> {
    process.env.DATABASE_URL = dbUrl;
    process.env.RAYSPEC_SPEC_PATH = specPath;
    const config = loadServerConfig();
    return assembleServer(config, {
      registerProductTables: (tables) => registerScopedTables([...tables.values()]),
      ...(inject.agents ? { productDeterministicAgents: acmeAgents() } : {}),
      ...(inject.stt ? { productSttAdapter: new FakeSttAdapter({ fixtures: [] }) } : {}),
    });
  }

  beforeAll(async () => {
    if (!baseUrl) return;
    demandDbUrl = withDbName(baseUrl, DEMAND_DB);
    intakeDbUrl = withDbName(baseUrl, INTAKE_DB);
    const admin = postgres(adminUrl(baseUrl), { max: 1 });
    try {
      for (const d of [`${INTAKE_DB}_dbos_sys`, DEMAND_DB, INTAKE_DB]) {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${d}" WITH (FORCE)`);
      }
      for (const d of [DEMAND_DB, INTAKE_DB]) await admin.unsafe(`CREATE DATABASE "${d}"`);
    } finally {
      await admin.end();
    }

    blobDir = mkdtempSync(join(tmpdir(), 'rayspec-s4-'));
    for (const k of ENV) saved[k] = process.env[k];
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    process.env.RAYSPEC_JWT_SIGNING_KEY = await exportPKCS8(privateKey);
    process.env.RAYSPEC_API_KEY_PEPPER = 's4-pepper-only';
    delete process.env.ALLOWED_ORIGINS;
    process.env.PORT = '8806';
    delete process.env.DBOS_SYSTEM_DATABASE_URL;
    process.env.RAYSPEC_PRODUCT_TENANT_ID = TENANT;
  }, 180_000);

  afterAll(async () => {
    if (intakeServer?.durableExecutorShutdown) await intakeServer.durableExecutorShutdown();
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    if (blobDir) rmSync(blobDir, { recursive: true, force: true });
    if (baseUrl) {
      const admin = postgres(adminUrl(baseUrl), { max: 1 });
      try {
        for (const d of [`${INTAKE_DB}_dbos_sys`, DEMAND_DB, INTAKE_DB]) {
          await admin.unsafe(`DROP DATABASE IF EXISTS "${d}" WITH (FORCE)`);
        }
      } finally {
        await admin.end();
      }
    }
  }, 120_000);

  // ── Arm A: acme-notes STILL demands ALL FOUR (throw BEFORE any DBOS launch) ─────────────────────────

  it('acme-notes demands RAYSPEC_BLOB_ROOT (audio declared)', async () => {
    setAllFour();
    delete process.env.RAYSPEC_BLOB_ROOT;
    await expect(boot(ACME_YAML, demandDbUrl, { stt: false, agents: true })).rejects.toThrow(
      /RAYSPEC_BLOB_ROOT is\s+unset/,
    );
    armsRan += 1;
  }, 120_000);

  it('acme-notes demands RAYSPEC_MEDIA_SIGNING_KEY (media_playback declared)', async () => {
    setAllFour();
    delete process.env.RAYSPEC_MEDIA_SIGNING_KEY;
    await expect(boot(ACME_YAML, demandDbUrl, { stt: false, agents: true })).rejects.toThrow(
      /RAYSPEC_MEDIA_SIGNING_KEY is unset/,
    );
    armsRan += 1;
  }, 120_000);

  it('acme-notes demands RAYSPEC_EXTRACTION_MODE (agents declared)', async () => {
    setAllFour();
    delete process.env.RAYSPEC_EXTRACTION_MODE;
    await expect(boot(ACME_YAML, demandDbUrl, { stt: false, agents: true })).rejects.toThrow(
      /RAYSPEC_EXTRACTION_MODE is required/,
    );
    armsRan += 1;
  }, 120_000);

  it('acme-notes demands STT_PROVIDER (stt.* step declared)', async () => {
    setAllFour();
    delete process.env.STT_PROVIDER;
    // inject.stt: false — so the boot reaches the real env-driven STT construction (buildSttAdapter),
    // whose requireEnv(STT_PROVIDER) throws. inject.agents so extraction=deterministic passes step 4.
    await expect(boot(ACME_YAML, demandDbUrl, { stt: false, agents: true })).rejects.toThrow(
      /STT_PROVIDER is required/,
    );
    armsRan += 1;
  }, 120_000);

  // ── F1: a NON-audio doc that DECLARES an agent demands ONLY RAYSPEC_EXTRACTION_MODE ─────────
  // The single-predicate NON-COLLINEAR point: this doc has an agent (hasAgents=true) but NO audio
  // (withAudio=false) and NO stt.* step (usesStt=false). With ALL FOUR env vars unset the boot must
  // throw the RAYSPEC_EXTRACTION_MODE demand (step 4) — NOT RAYSPEC_BLOB_ROOT (step 3, which runs
  // FIRST) — proving the extraction demand is coupled to `hasAgents` ALONE, and blob/media are NOT
  // demanded (step 3 was skipped because withAudio=false; a `withAudio && hasAgents` coupling would
  // instead skip step 4 for this doc → NO throw → this arm RED). It throws BEFORE the DBOS executor is
  // constructed. (STT-independence for a no-stt doc is proven by Arm B — intake boots with STT unset;
  // the POSITIVE "this agent doc composes/would-boot fine with those unset" is pinned WITHOUT a second
  // DBOS launch [process-global singleton] in product-yaml's compose-conditional-mount.test.ts.)
  it('a NON-audio doc that DECLARES an agent demands RAYSPEC_EXTRACTION_MODE (not blob/media/stt)', async () => {
    clearAllFour(); // NONE of the four env vars set
    await expect(
      boot(NON_AUDIO_AGENT_YAML, demandDbUrl, { stt: false, agents: false }),
    ).rejects.toThrow(/RAYSPEC_EXTRACTION_MODE is required/);
    armsRan += 1;
  }, 120_000);

  // ── F2: an stt.* step WITHOUT the audio capability fail-closes with a NAMED error (step 5) ────
  // The real STT media resolver reads the audio capability's blob-backed chunks, so an stt.* step with
  // no audio capability (audio_input/media_playback) is a boot misconfiguration. Step 5 must reject it
  // with the NAMED ProductBootError (never a raw TypeError on an absent blobFactory). withAudio=false
  // (step 3 skipped) + hasAgents=false (step 4 skipped) → step 5 fires: usesStt && no injected adapter
  // && no blobFactory → throw. Throws BEFORE the DBOS executor is constructed.
  it('an stt.* step WITHOUT the audio capability fail-closes with the named ProductBootError', async () => {
    clearAllFour();
    await expect(
      boot(STT_NO_AUDIO_YAML, demandDbUrl, { stt: false, agents: false }),
    ).rejects.toThrow(/declare the audio capability or remove the stt step/);
    armsRan += 1;
  }, 120_000);

  // ── a FILE-only doc demands RAYSPEC_BLOB_ROOT, NAMING file_input (never the audio text) ─
  // The blob predicate is now `withAudio || withFileInput` (step 3 of deployProductYamlSpec). With
  // ALL FOUR env vars unset, a file_input-only doc must throw the BLOB demand whose message names
  // the ACTUAL demanding capability (`the file_input capability … RAYSPEC_BLOB_ROOT`) — a demand
  // that kept the audio-only predicate would boot green here and fail at the first upload; a demand
  // that reused the audio TEXT would mislead the operator. It must NOT demand
  // RAYSPEC_MEDIA_SIGNING_KEY (no file download in v1 — media stays audio-only): the media demand
  // sits AFTER the blob demand in the same step, so this arm alone cannot prove its absence — the
  // POSITIVE half (a file-only boot with blob root set but NO media key SUCCEEDS) is pinned in
  // file-ingest-e2e.db.test.ts, whose whole boot runs with the media key deleted. Throws BEFORE
  // the DBOS executor is constructed.
  it('a FILE-only doc demands RAYSPEC_BLOB_ROOT naming file_input (not the audio text, not media/stt/extraction)', async () => {
    clearAllFour(); // NONE of the four env vars set
    await expect(boot(FILE_ONLY_YAML, demandDbUrl, { stt: false, agents: false })).rejects.toThrow(
      /the file_input capability .*RAYSPEC_BLOB_ROOT\s+is unset/,
    );
    armsRan += 1;
  }, 120_000);

  // ── Arm B: a NON-audio, zero-agent, no-stt doc boots demanding NONE of the four (the ONE launch) ─

  it('a non-audio zero-agent doc BOOTS demanding NONE of the four, composes + serves (RED-first)', async () => {
    clearAllFour(); // NONE of the four env vars set
    intakeServer = await boot(NON_AUDIO_YAML, intakeDbUrl, { stt: false, agents: false });

    // Composed + materialized (a clean DB → first materialization).
    expect(intakeServer.deployMode).toBe('materialized');

    // The record capability + the declared view mounted — NO audio routes, NO file routes (
    // a doc NOT declaring file_input mounts ZERO file surface — the HTTP half of e2e arm (i)), and
    // NO conversation routes (the same conditional-mount law for conversation_input).
    const routes = intakeServer.declaredRoutes.map((r) => `${r.method} ${r.path}`);
    expect(routes).toContain('POST /records/{record_id}/submit');
    expect(routes).toContain('GET /intake/{record_id}/status');
    expect(routes.some((r) => r.includes('/sessions/'))).toBe(false);
    expect(routes.some((r) => r.includes('/files/'))).toBe(false);
    expect(routes.some((r) => r.includes('/conversations/'))).toBe(false);

    // SERVES: the submit route is mounted + auth-gated (401 without a bearer token).
    const res = await intakeServer.app.request('/records/rec-s4/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'hello' }),
    });
    expect(res.status).toBe(401);

    // (i): the file routes are 404 on a doc that does not declare file_input — asserted
    // over live HTTP, not just the declared-route list (a stray mount would answer 401 here).
    const filePut = await intakeServer.app.request('/files/f-s4', {
      method: 'PUT',
      headers: { 'content-type': 'text/plain', 'content-length': '5' },
      body: 'hello',
    });
    expect(filePut.status).toBe(404);
    const fileSubmit = await intakeServer.app.request('/files/f-s4/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(fileSubmit.status).toBe(404);

    // the conversation routes are 404 on a doc that does not declare conversation_input
    // — the ZERO-surface half of the conditional-mount law over live HTTP (a stray mount would
    // answer 401 here, not 404).
    const convCreate = await intakeServer.app.request('/conversations/c-s4', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(convCreate.status).toBe(404);
    const convTurn = await intakeServer.app.request('/conversations/c-s4/turns', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message_id: 'm', text: 'x' }),
    });
    expect(convTurn.status).toBe(404);
    armsRan += 1;
  }, 180_000);
});

// UN-SKIPPABLE ran-guard: a REQUIRED run (CI / RAYSPEC_REQUIRE_DB_TESTS) that lost
// DATABASE_URL would otherwise SILENTLY SKIP the whole boot-demand proof and read GREEN.
describe('boot-demand ran-guard', () => {
  it('the doc-driven env-demand arms ran under a required DB run', () => {
    // 4 acme-notes demands + F1 (non-audio agent) + F2 (stt-without-audio) + the file-only
    // blob demand + Arm B (the intake launch).
    if (dbRequired) expect(armsRan).toBeGreaterThanOrEqual(8);
    else expect(true).toBe(true);
  });
});
