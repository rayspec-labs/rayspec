/**
 * THE CONTRACT-INTAKE LIVE SMOKE (real provider). The SAME Contract-Intake
 * product the merge-gated deterministic e2e proves, booted on
 * the REAL composed stack with RAYSPEC_EXTRACTION_MODE=live and driven with ONE real document:
 * upload the committed sample NDA → REAL `file_input.parse_text` → the S4 GENERIC live-extraction
 * branch assembles the model input (parsed document text + the contract-type retention catalog +
 * the extractor-config payload fields) → ONE REAL gpt-5 call through `runAgent` (native strict
 * structured output) → `validation.check` → store_write → the declared view serves the coded
 * contract.
 *
 * Asserts the coded fields are GROUNDED in the document (the printed counterparty legal name, the
 * printed ISO effective date, the NDA classification) and the retention policy comes from the
 * SEEDED catalog row for 'nda' (never invented) — proving the catalog→policy match is real.
 *
 * GATED (the live-extraction-smoke pattern): skips unless BOTH DATABASE_URL and OPENAI_API_KEY are
 * set — CI has no LLM creds ⇒ it self-skips there; it runs locally. Cost-conscious: ONE
 * short contract, ONE gpt-5 call; the journaled token/cost row is logged for the evidence record.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerScopedTables } from '@rayspec/db/testing';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assembleServer, type BootedServer, loadServerConfig } from './composition-root.js';

const baseUrl = process.env.DATABASE_URL;
const hasKey = Boolean(process.env.OPENAI_API_KEY);
const canRun = Boolean(baseUrl) && hasKey;

if (process.env.RAYSPEC_REQUIRE_LIVE_TESTS === 'true' && !canRun) {
  throw new Error(
    'packages/app/server/src/contract-intake-live.smoke.db.test.ts: RAYSPEC_REQUIRE_LIVE_TESTS is set but the live prerequisites (API creds / DB) are absent — refusing to silently skip the live suite.',
  );
}

const here = dirname(fileURLToPath(import.meta.url));
const CONTRACT_YAML = resolve(
  here,
  '../../../../examples/contract-intake/contract-intake.product.yaml',
);
const TXT_BODY = readFileSync(
  join(here, '../../../../examples/contract-intake/fixtures/sample-contract.txt'),
  'utf8',
);

const SUITE_DB = `rayspec_contract_live_${process.pid}`;
const TENANT = '00000000-0000-4000-8000-00000000f501';
const FILE_ID = 'ctr-live-001';

/** The independent run-id oracle (same derivation the deterministic e2e pins). */
function expectedRunId(tenantId: string, workflowId: string, idempotencyKey: string): string {
  const h = createHash('sha256')
    .update(`${tenantId}:${workflowId}:${idempotencyKey}`)
    .digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
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

describe.skipIf(!canRun)(
  'Contract-Intake LIVE smoke — real gpt-5 through the composed stack',
  () => {
    let server: BootedServer | undefined;
    let appDbUrl = '';
    let dbosSysDb = '';
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
      'RAYSPEC_EXTRACTION_MODE',
      'STT_PROVIDER',
      'RAYSPEC_BLOB_ROOT',
      'RAYSPEC_MEDIA_SIGNING_KEY',
    ] as const;

    async function drop(admin: postgres.Sql): Promise<void> {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${dbosSysDb}" WITH (FORCE)`);
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
    }

    beforeAll(async () => {
      if (!canRun) return;
      appDbUrl = withDbName(baseUrl as string, SUITE_DB);
      dbosSysDb = `${SUITE_DB}_dbos_sys`;
      const admin = postgres(adminUrl(baseUrl as string), { max: 1 });
      try {
        await drop(admin);
        await admin.unsafe(`CREATE DATABASE "${SUITE_DB}"`);
      } finally {
        await admin.end();
      }

      blobDir = mkdtempSync(join(tmpdir(), 'rayspec-contract-live-'));
      for (const k of ENV) saved[k] = process.env[k];
      const { privateKey } = await generateKeyPair('RS256', { extractable: true });
      process.env.RAYSPEC_JWT_SIGNING_KEY = await exportPKCS8(privateKey);
      process.env.RAYSPEC_API_KEY_PEPPER = 'contract-live-pepper';
      process.env.DATABASE_URL = appDbUrl;
      delete process.env.ALLOWED_ORIGINS;
      process.env.PORT = '8812';
      process.env.RAYSPEC_SPEC_PATH = CONTRACT_YAML;
      delete process.env.DBOS_SYSTEM_DATABASE_URL;
      process.env.RAYSPEC_PRODUCT_TENANT_ID = TENANT;
      process.env.RAYSPEC_BLOB_ROOT = blobDir;
      // THE LIVE PATH: the boot reads extraction/contract_extractor.extractor.json (backend openai,
      // gpt-5, native structured output, the S4 input_context) and wires the REAL runAgent node.
      process.env.RAYSPEC_EXTRACTION_MODE = 'live';
      delete process.env.RAYSPEC_MEDIA_SIGNING_KEY;
      delete process.env.STT_PROVIDER;

      const config = loadServerConfig();
      server = await assembleServer(config, {
        registerProductTables: (tables) => registerScopedTables([...tables.values()]),
      });

      const client = postgres(appDbUrl, { max: 2 });
      try {
        await client.unsafe(
          `INSERT INTO orgs (id, name, slug) VALUES ($1, 'ContractLive', 'contract-live')`,
          [TENANT],
        );
        await client.unsafe(
          `INSERT INTO contract_type_catalog (tenant_id, contract_type, retention_years, review_owner)
         VALUES ($1, 'nda', 5, 'legal-ops'),
                ($1, 'msa', 10, 'general-counsel'),
                ($1, 'sow', 7, 'procurement-desk'),
                ($1, 'dpa', 6, 'privacy-office'),
                ($1, 'other', 10, 'legal-review-queue')`,
          [TENANT],
        );
      } finally {
        await client.end();
      }
    }, 180_000);

    afterAll(async () => {
      await server?.close();
      for (const k of ENV) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      if (blobDir) rmSync(blobDir, { recursive: true, force: true });
      if (canRun) {
        const admin = postgres(adminUrl(baseUrl as string), { max: 1 });
        try {
          await drop(admin);
        } finally {
          await admin.end();
        }
      }
    }, 60_000);

    async function tokenFor(tenant: string): Promise<string> {
      const email = `contract-live-${Date.now()}@example.com`;
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

    (canRun ? it : it.skip)(
      'ONE real contract: upload → parse → REAL gpt-5 generic-branch extraction → validated, coded, served',
      async () => {
        const token = await tokenFor(TENANT);

        const up = await server!.app.request(`/files/${FILE_ID}`, {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'text/plain',
            'content-length': String(Buffer.byteLength(TXT_BODY)),
            'x-file-name': 'sample-contract.txt',
          },
          body: TXT_BODY,
        });
        expect(up.status).toBe(200);
        const sub = await server!.app.request(`/files/${FILE_ID}/submit`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({}),
        });
        expect(sub.status).toBe(200);

        // Wait for the ONE durable run (parse → catalog → REAL gpt-5 → validate → persist).
        const runId = expectedRunId(TENANT, 'code_contract', `file_id:${FILE_ID}`);
        const deadline = Date.now() + 150_000;
        let run: { status: string; error: unknown } | undefined;
        for (;;) {
          const client = postgres(appDbUrl, { max: 1 });
          try {
            const rows = (await client.unsafe(
              'SELECT status, error FROM workflow_runs WHERE workflow_run_id = $1',
              [runId],
            )) as unknown as Array<{ status: string; error: unknown }>;
            run = rows[0];
          } finally {
            await client.end();
          }
          if (run && (run.status === 'completed' || run.status === 'terminal_failure')) break;
          if (Date.now() > deadline) throw new Error(`live run did not reach a terminal status`);
          await new Promise((r) => setTimeout(r, 500));
        }
        // eslint-disable-next-line no-console
        console.log('[contract-live] run:', run?.status, run?.error ?? '');
        expect(run?.status).toBe('completed');

        // GROUNDED ground truth: the coded row's fields must match what the DOCUMENT states, and
        // the retention policy must be the SEEDED catalog row for the classified type (never an
        // invented policy).
        const client = postgres(appDbUrl, { max: 1 });
        let row: Record<string, unknown> | undefined;
        let usage: { n: number; max_tokens: string; max_cost: string } | undefined;
        try {
          const rows = (await client.unsafe(
            'SELECT contract_ref, coded, catalog_snapshot, status FROM coded_contracts',
          )) as unknown as Array<Record<string, unknown>>;
          row = rows[0];
          const steps = (await client.unsafe(
            'SELECT count(*)::int AS n, coalesce(max(total_tokens),0)::numeric AS max_tokens, ' +
              'coalesce(max(cost_usd),0)::numeric AS max_cost FROM journal_steps',
          )) as unknown as Array<{ n: number; max_tokens: string; max_cost: string }>;
          usage = steps[0];
        } finally {
          await client.end();
        }
        expect(row).toBeDefined();
        const coded = row?.coded as Record<string, unknown>;
        // eslint-disable-next-line no-console
        console.log('[contract-live] coded:', JSON.stringify(coded));
        // Document-grounded: the exact printed counterparty legal name + the printed ISO date.
        expect(coded.counterparty_name).toBe('Nordwind Robotics GmbH');
        expect(coded.contract_type).toBe('nda');
        expect(coded.effective_date).toBe('2026-05-01');
        // Catalog-grounded: the SEEDED 'nda' row's policy — proving the match is not invented.
        expect(coded.retention_years).toBe(5);
        expect(coded.review_owner).toBe('legal-ops');

        // The REAL provider call journaled NONZERO token usage under the tenant (the metering
        // signal).
        // eslint-disable-next-line no-console
        console.log(
          '[contract-live] journal_steps:',
          usage?.n,
          'max_tokens:',
          Number(usage?.max_tokens ?? 0),
          'max_cost_usd:',
          Number(usage?.max_cost ?? 0),
        );
        expect(Number(usage?.max_tokens ?? 0)).toBeGreaterThan(0);

        // …and the declared view serves the coded contract over HTTP.
        const detail = await server!.app.request(`/contracts/${FILE_ID}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(detail.status).toBe(200);
        expect(((await detail.json()) as Record<string, unknown>).coded).toMatchObject({
          contract_type: 'nda',
          retention_years: 5,
        });
      },
      240_000,
    );
  },
);
