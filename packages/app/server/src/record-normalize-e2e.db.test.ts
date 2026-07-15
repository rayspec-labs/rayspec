/**
 * The record input-normalize step end-to-end on the REAL composition root
 * (`assembleServer` → `deployProductYamlSpec` → `deploy()` → the real DBOS workflow engine + HTTP app),
 * with an INJECTED deterministic normalize Backend (the injected-Backend proof: the whole standard-boot
 * normalizer wiring runs — the per-product `record/<agent_id>.normalizer.json` resolve + validation and
 * the output schema built from the declared `output_contract` — with ZERO LLM creds; only the neutral
 * Backend is swapped). Ground-truth proofs:
 *
 *   (a) a record_input doc that DECLARES `input_normalize` BOOTS via the standard server path. Before the
 *       standard-boot wiring existed the boot had NO record.normalizer, so compose fail-closed with a
 *       rolloutError and this whole suite could not boot — this is the RED→GREEN of the wiring.
 *   (b) a submitted record is NORMALIZED BEFORE persist: the stored `record_submissions.payload` is the
 *       transformed value (title upper-cased by the injected backend), never the raw request body; the
 *       normalize Backend was invoked exactly once.
 *   (c) the NORMALIZED value flows end-to-end: the record-triggered workflow writes the normalized title
 *       into the declared store and the store-sourced view serves it (the emitted event carried the
 *       normalized record, not the raw input).
 *
 * Skips without DATABASE_URL — but HARD-FAILS when the DB is required (CI / RAYSPEC_REQUIRE_DB_TESTS).
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentSpec, Backend, RunContext, RunResult } from '@rayspec/core';
import { registerScopedTables } from '@rayspec/db/testing';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assembleServer, type BootedServer, loadServerConfig } from './composition-root.js';

const baseUrl = process.env.DATABASE_URL;
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (requireDb && !baseUrl) {
  throw new Error(
    'record-normalize-e2e.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but ' +
      'absent — refusing to silently skip the record input-normalize end-to-end.',
  );
}

const here = dirname(fileURLToPath(import.meta.url));
const SPEC_YAML = resolve(here, '__fixtures__/record-normalize/record-normalize.product.yaml');
const SUITE_DB = `rayspec_record_normalize_${process.pid}`;
const TENANT = '00000000-0000-4000-8000-0000000000d5';
const RECORD = 'intake-req-1';

/**
 * The injected deterministic normalize Backend: derives the NORMALIZED record from the raw record framed
 * in `spec.input` (upper-cases `title`), so the transform is observably a function of the SUBMITTED
 * record (not a constant). COUNTS its invocations (the normalize-ran / no-double-invoke pins). Structured
 * output is returned as `output` — the record-normalizer reads it as the normalized record.
 */
class UppercaseNormalizeBackend implements Backend {
  readonly id = 'openai' as const;
  runCalls = 0;
  async resolveAuth() {
    return 'api-key' as const;
  }
  async run(spec: AgentSpec, _ctx: RunContext): Promise<RunResult> {
    this.runCalls += 1;
    // The raw record is framed after the untrusted-data preamble (…\n\n<json>) — parse it back out.
    const json = spec.input.slice(spec.input.indexOf('\n\n') + 2);
    const raw = JSON.parse(json) as Record<string, unknown>;
    const output = {
      title: String(raw.title ?? '').toUpperCase(),
      priority: raw.priority,
    };
    return {
      runId: 'set-by-run-core',
      backend: 'openai',
      authMode: 'api-key',
      status: 'completed',
      finalText: '',
      output,
      error: null,
      errorClass: null,
      conversation: [],
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      costUsd: 0,
      stepCount: 1,
    } as RunResult;
  }
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

describe.skipIf(!baseUrl)('record input-normalize — real boot + real DBOS + HTTP', () => {
  let server: BootedServer | undefined;
  let appDbUrl = '';
  let dbosSysDb = '';
  let tokenA = '';
  const normalizeBackend = new UppercaseNormalizeBackend();
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
    'RAYSPEC_EXTRACTION_MODE',
    'STT_PROVIDER',
    'RAYSPEC_BLOB_ROOT',
    'RAYSPEC_MEDIA_SIGNING_KEY',
    'RAYSPEC_NORMALIZE_MODE',
  ] as const;

  async function drop(admin: postgres.Sql): Promise<void> {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbosSysDb}" WITH (FORCE)`);
    await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
  }

  beforeAll(async () => {
    if (!baseUrl) return;
    appDbUrl = withDbName(baseUrl, SUITE_DB);
    dbosSysDb = `${SUITE_DB}_dbos_sys`;
    const admin = postgres(adminUrl(baseUrl), { max: 1 });
    try {
      await drop(admin);
      await admin.unsafe(`CREATE DATABASE "${SUITE_DB}"`);
    } finally {
      await admin.end();
    }

    for (const k of ENV) saved[k] = process.env[k];
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    process.env.RAYSPEC_JWT_SIGNING_KEY = await exportPKCS8(privateKey);
    process.env.RAYSPEC_API_KEY_PEPPER = 'record-normalize-pepper';
    process.env.DATABASE_URL = appDbUrl;
    delete process.env.ALLOWED_ORIGINS;
    process.env.PORT = '8811';
    process.env.RAYSPEC_SPEC_PATH = SPEC_YAML;
    delete process.env.DBOS_SYSTEM_DATABASE_URL;
    process.env.RAYSPEC_PRODUCT_TENANT_ID = TENANT;
    // A record_input-only doc moves NO bytes and runs NO stt/agents/conversation — it boots with NONE
    // of the four doc-driven env vars (the negative-env law). It DOES declare input_normalize, so it
    // demands RAYSPEC_NORMALIZE_MODE (deterministic here — the injected Backend below; the per-product
    // normalizer.json + the output_contract schema still fully resolve/validate).
    delete process.env.RAYSPEC_BLOB_ROOT;
    delete process.env.RAYSPEC_MEDIA_SIGNING_KEY;
    delete process.env.STT_PROVIDER;
    delete process.env.RAYSPEC_EXTRACTION_MODE;
    process.env.RAYSPEC_NORMALIZE_MODE = 'deterministic';

    const config = loadServerConfig();
    server = await assembleServer(config, {
      registerProductTables: (tables) => registerScopedTables([...tables.values()]),
      productDeterministicNormalizerBackend: normalizeBackend,
    });

    const client = postgres(appDbUrl, { max: 2 });
    try {
      await client.unsafe(`INSERT INTO orgs (id, name, slug) VALUES ($1, 'NormA', 'norm-a')`, [
        TENANT,
      ]);
    } finally {
      await client.end();
    }
    tokenA = await tokenFor(TENANT);
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    if (baseUrl) {
      const admin = postgres(adminUrl(baseUrl), { max: 1 });
      try {
        await drop(admin);
      } finally {
        await admin.end();
      }
    }
  }, 60_000);

  async function tokenFor(tenant: string): Promise<string> {
    const email = `record-normalize-${tenant.slice(-4)}-${Date.now()}@example.com`;
    const reg = await server!.app.request('/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'a-long-enough-password' }),
    });
    expect([200, 201]).toContain(reg.status);
    const client = postgres(appDbUrl, { max: 2 });
    try {
      const rows = (await client.unsafe('SELECT id FROM users WHERE email = $1', [
        email,
      ])) as unknown as Array<{ id: string }>;
      await client.unsafe(
        `INSERT INTO memberships (org_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active')`,
        [tenant, rows[0]!.id],
      );
    } finally {
      await client.end();
    }
    const sw = await server!.app.request(`/v1/orgs/${tenant}/switch`, {
      method: 'POST',
      headers: { authorization: `Bearer ${(await reg.json()).accessToken}` },
    });
    expect(sw.status).toBe(200);
    return (await sw.json()).accessToken as string;
  }

  function submit(recordId: string, token: string | undefined, body: unknown): Promise<Response> {
    return server!.app.request(`/records/${recordId}/submit`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  async function storedPayload(recordId: string): Promise<Record<string, unknown> | undefined> {
    const client = postgres(appDbUrl, { max: 2 });
    try {
      const rows = (await client.unsafe(
        'SELECT payload FROM record_submissions WHERE record_ref = $1',
        [`${TENANT}:${recordId}`],
      )) as unknown as Array<{ payload: Record<string, unknown> }>;
      return rows[0]?.payload;
    } finally {
      await client.end();
    }
  }

  it('BOOTS via the standard server path and mounts the record submit route + the store-sourced view (the wiring RED→GREEN — a normalize-declaring doc bricked the boot before this)', () => {
    expect(server).toBeDefined();
    // The declared surface is mounted (the boot did not fail-closed at compose).
    expect(server?.declaredRoutes.some((r) => r.path.includes('/records/'))).toBe(true);
  });

  it('NORMALIZES the submitted record BEFORE persist: the stored payload is the transformed value (title upper-cased), never the raw body; the normalize Backend ran exactly once', async () => {
    const before = normalizeBackend.runCalls;
    const res = await submit(RECORD, tokenA, { title: 'fix the door', priority: 'high' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { record_id: string; event_id: string; deduped: boolean };
    expect(body).toMatchObject({
      record_id: RECORD,
      event_id: `${TENANT}:${RECORD}`,
      deduped: false,
    });

    // The injected normalize Backend was invoked exactly once for this first persist.
    expect(normalizeBackend.runCalls).toBe(before + 1);

    // The STORED capability-owned payload is the NORMALIZED value — NOT the raw request body.
    const payload = await storedPayload(RECORD);
    expect(payload).toEqual({ title: 'FIX THE DOOR', priority: 'high' });
  });

  it('the NORMALIZED value flows end-to-end: the record-triggered workflow writes the normalized title into the store and the view serves it', async () => {
    // Poll the store-sourced view until the async workflow has written the row (bounded).
    let served: { record_id: string; title: string | null } | undefined;
    for (let i = 0; i < 60; i += 1) {
      const res = await server!.app.request(`/intake/${RECORD}/status`, {
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(res.status).toBe(200);
      served = (await res.json()) as { record_id: string; title: string | null };
      if (served.title !== null) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    // The emitted event carried the NORMALIZED record — the view reflects the upper-cased title.
    expect(served).toMatchObject({ record_id: RECORD, title: 'FIX THE DOOR' });
  });

  it('an unauthenticated submit is 401 (the standard bearer chain owns the route)', async () => {
    const res = await submit('rec-anon', undefined, { title: 'x', priority: 'low' });
    expect(res.status).toBe(401);
  });
});
