/**
 * THE BOOT WIRING, MEASURED. `deployProductYamlSpec` constructs THREE product-side model calls, and
 * they are wired to the deployment-supplied factory at three separate call sites. The responder site
 * is measured through a real boot in product-backend-factory-parity.db.test.ts; this file measures the
 * OTHER TWO — the live extraction executor (the extraction step) and the record normalizer (the
 * rollout step) — against a real database, through the REAL composition root.
 *
 * ONE BOOT, BOTH SITES. The committed fixture declares an extraction agent AND an input_normalize
 * step, so a single `assembleServer` boot with `RAYSPEC_EXTRACTION_MODE=live` +
 * `RAYSPEC_NORMALIZE_MODE=live` has to construct both — with NO provider credential anywhere in env
 * (OPENAI_API_KEY / ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN / CODEX_HOME are all deleted for the
 * boot). The ONLY way that boot can succeed is if BOTH call sites take their Backend from the factory:
 * a call site that fell back to the built-in env construction aborts the boot with
 * `extractor 'note_extractor': … OPENAI_API_KEY is required` or
 * `normalizer 'field_normalizer': … OPENAI_API_KEY is required`, and every case in this file fails in
 * `beforeAll`. That is this file's RED, and the CONTROL case below pins it by running the omission
 * path over the SAME env and the SAME deployment directory and asserting both throws.
 *
 * WHAT THIS FILE DOES NOT CLAIM. The fixture's record workflow is a plain store_write — it declares NO
 * agent step — so the extraction executor here is CONSTRUCTED at boot and never INVOKED. The
 * extraction call site is therefore proven at BOOT, not end-to-end; a credential-free live-extraction
 * run through the workflow engine is a separate piece of work. The NORMALIZER, by contrast, IS driven
 * through the real request path below: the factory-supplied Backend instance is the one the booted
 * server invokes on a submitted record.
 *
 * ONE FULL LAUNCH: DBOS is a process-global singleton and the product boot never deregisters, so this
 * file boots exactly ONCE (vitest isolates test FILES — `pool: 'forks'` — which is why this is its own
 * file rather than a case in the parity suite).
 *
 * Skips without DATABASE_URL — but HARD-FAILS when the DB is required (CI / RAYSPEC_REQUIRE_DB_TESTS).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentSpec, Backend, RunContext, RunResult } from '@rayspec/core';
import { type Db, makeDb } from '@rayspec/db';
import { registerScopedTables } from '@rayspec/db/testing';
import { type ProductSpec, parseProductSpec } from '@rayspec/spec';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyMigrations,
  assembleServer,
  type BootedServer,
  loadServerConfig,
} from './composition-root.js';
import {
  buildLiveAgent,
  buildRecordNormalizer,
  type ProductAgentBackendsFactory,
  type ProductBackendContext,
} from './product-boot.js';

const baseUrl = process.env.DATABASE_URL;
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (requireDb && !baseUrl) {
  throw new Error(
    'product-backend-factory-boot.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) ' +
      'but absent — refusing to silently skip the boot-wiring proof.',
  );
}

const here = dirname(fileURLToPath(import.meta.url));
const SPEC_YAML = resolve(
  here,
  '__fixtures__/backend-factory-boot/backend-factory-boot.product.yaml',
);
const SUITE_DB = `rayspec_backend_factory_boot_${process.pid}`;
const TENANT = '00000000-0000-4000-8000-00000000c402';
const RECORD = 'intake-boot-1';

/** The credential-relevant env the BOOT runs with — reused verbatim by the control case. */
const BOOT_MODE_ENV: NodeJS.ProcessEnv = {
  RAYSPEC_EXTRACTION_MODE: 'live',
  RAYSPEC_NORMALIZE_MODE: 'live',
};

/**
 * The Backend the factory hands back. It reports the id the sidecars declare ('openai'), COUNTS its
 * invocations and derives the normalized record from the raw record framed in `spec.input`, so the
 * transform is observably a function of the SUBMITTED record rather than a constant.
 */
class BrokeredBackend implements Backend {
  readonly id = 'openai' as const;
  runCalls = 0;
  async resolveAuth() {
    return 'api-key' as const;
  }
  async run(spec: AgentSpec, _ctx: RunContext): Promise<RunResult> {
    this.runCalls += 1;
    const raw = JSON.parse(spec.input.slice(spec.input.indexOf('\n\n') + 2)) as Record<
      string,
      unknown
    >;
    return {
      runId: 'set-by-run-core',
      backend: 'openai',
      authMode: 'api-key',
      status: 'completed',
      finalText: '',
      output: { title: String(raw.title ?? '').toUpperCase(), priority: raw.priority },
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
function specOf(path: string): ProductSpec {
  const parsed = parseProductSpec(readFileSync(path, 'utf8'));
  if (!parsed.ok) throw new Error(`${path} must parse: ${JSON.stringify(parsed.errors)}`);
  return parsed.value;
}

describe.skipIf(!baseUrl)(
  'the product backend factory — the BOOT constructs extraction and the normalizer through it',
  () => {
    let server: BootedServer | undefined;
    let appDbUrl = '';
    let dbosSysDb = '';
    let tokenA = '';
    const brokered = new BrokeredBackend();
    /** Every context the factory was shown — the "called once, complete set" comparand. */
    const seen: ProductBackendContext[] = [];
    const factory: ProductAgentBackendsFactory = (ctx) => {
      seen.push(ctx);
      return new Map(ctx.requirements.map((r) => [r, brokered as Backend]));
    };
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
      'RAYSPEC_NORMALIZE_MODE',
      'STT_PROVIDER',
      'RAYSPEC_BLOB_ROOT',
      'RAYSPEC_MEDIA_SIGNING_KEY',
      // The four ambient credentials the built-in construction would otherwise reach for. They must
      // ALL be absent, or "the factory constructed it" is not what this boot proves.
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CODEX_HOME',
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
      process.env.RAYSPEC_API_KEY_PEPPER = 'backend-factory-boot-pepper';
      process.env.DATABASE_URL = appDbUrl;
      delete process.env.ALLOWED_ORIGINS;
      process.env.PORT = '8819';
      process.env.RAYSPEC_SPEC_PATH = SPEC_YAML;
      delete process.env.DBOS_SYSTEM_DATABASE_URL;
      process.env.RAYSPEC_PRODUCT_TENANT_ID = TENANT;
      // The doc moves NO bytes and runs NO stt (the negative env-demand law); it DOES declare an
      // extraction agent and an input_normalize step, so it demands exactly these two modes — LIVE,
      // the real construction path, with every provider credential deleted.
      delete process.env.RAYSPEC_BLOB_ROOT;
      delete process.env.RAYSPEC_MEDIA_SIGNING_KEY;
      delete process.env.STT_PROVIDER;
      delete process.env.OPENAI_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      delete process.env.CODEX_HOME;
      process.env.RAYSPEC_EXTRACTION_MODE = 'live';
      process.env.RAYSPEC_NORMALIZE_MODE = 'live';

      // The deployment tenant must be a LIVE org BEFORE the boot: a product deployment whose
      // RAYSPEC_PRODUCT_TENANT_ID names none refuses to start.
      const seed = makeDb(appDbUrl);
      try {
        await applyMigrations(seed);
        await seed.$client.unsafe(
          `INSERT INTO orgs (id, name, slug) VALUES ($1, 'FactoryBoot', 'factory-boot')`,
          [TENANT],
        );
      } finally {
        await seed.$client.end();
      }

      const config = loadServerConfig();
      server = await assembleServer(config, {
        registerProductTables: (tables) => registerScopedTables([...tables.values()]),
        productAgentBackendsFactory: factory,
      });
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
    }, 120_000);

    async function tokenFor(tenant: string): Promise<string> {
      const email = `factory-boot-${tenant.slice(-4)}-${Date.now()}@example.com`;
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

    it('BOOTS with NO provider credential in env — the factory constructed BOTH the extraction executor and the record normalizer', () => {
      expect(server).toBeDefined();
      expect(process.env.OPENAI_API_KEY).toBeUndefined();

      // ONE call, with EXACTLY the two model calls this document needs, in boot order.
      expect(seen).toHaveLength(1);
      expect(seen[0]?.productId).toBe('factoryboot');
      expect(seen[0]?.requirements.map((r) => ({ ...r }))).toEqual([
        {
          kind: 'extraction',
          agentId: 'note_extractor',
          backend: 'openai',
          model: 'test-extraction-model',
        },
        {
          kind: 'normalizer',
          agentId: 'field_normalizer',
          backend: 'openai',
          model: 'test-normalize-model',
        },
      ]);

      // CONTROL — the credential really IS absent for BOTH sites: the omission path over the SAME
      // deployment directory and the SAME mode env fails exactly as it does with no seam installed.
      // So a call site that stopped passing the factory-bound source could not have booted at all.
      const spec = specOf(SPEC_YAML);
      expect(() => buildLiveAgent(BOOT_MODE_ENV, SPEC_YAML, spec)).toThrow(
        /extractor 'note_extractor': .*OPENAI_API_KEY is required/,
      );
      expect(() =>
        buildRecordNormalizer(
          BOOT_MODE_ENV,
          SPEC_YAML,
          spec,
          {} as Db,
          {},
          {
            agent: 'field_normalizer',
            output_contract: 'intake.normalized',
          },
        ),
      ).toThrow(/normalizer 'field_normalizer': .*OPENAI_API_KEY is required/);
    });

    it('the record submit route is MOUNTED and a submitted record is normalized by the FACTORY-supplied Backend instance', async () => {
      expect(server?.declaredRoutes.some((r) => r.path.includes('/records/'))).toBe(true);

      const before = brokered.runCalls;
      const res = await server!.app.request(`/records/${RECORD}/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenA}` },
        body: JSON.stringify({ title: 'fix the door', priority: 'high' }),
      });
      expect(res.status).toBe(200);

      // The instance the FACTORY returned is the one the booted server invoked — not a look-alike.
      expect(brokered.runCalls).toBe(before + 1);

      // ...and the persisted capability-owned payload is the NORMALIZED value, never the raw body.
      const client = postgres(appDbUrl, { max: 2 });
      try {
        const rows = (await client.unsafe(
          'SELECT payload FROM record_submissions WHERE record_ref = $1',
          [`${TENANT}:${RECORD}`],
        )) as unknown as Array<{ payload: Record<string, unknown> }>;
        expect(rows[0]?.payload).toEqual({ title: 'FIX THE DOOR', priority: 'high' });
      } finally {
        await client.end();
      }
    });
  },
);
