/**
 * THE LIVE SMOKE (real provider) of the document-intake reference application: the same product the
 * reference journey runs on the deterministic extraction provider, booted with
 * RAYSPEC_EXTRACTION_MODE=live and the application's live config (RAYSPEC_EXTRACTION_CONFIG →
 * examples/document-intake/live-extraction/record_extractor.extractor.json, backend openai), and
 * driven with ONE seed document: upload → parse → ONE real model call → validate → persist → the
 * detail view.
 *
 * Bounded: one short plain-text document, one workflow run, one extraction call. It asserts the
 * record is grounded in the document — the reference, the title and the quantity the document
 * states, as many lines as it lists — and that the call journaled a nonzero token usage. It makes no
 * claim about extraction quality beyond those fields.
 *
 * GATED like the other intake smokes: skips unless BOTH DATABASE_URL and OPENAI_API_KEY are set, so
 * CI's deterministic and database lanes never call a provider; with RAYSPEC_REQUIRE_LIVE_TESTS=true
 * and either absent, collection fails instead of skipping.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeDb } from '@rayspec/db';
import { registerScopedTables } from '@rayspec/db/testing';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyMigrations,
  assembleServer,
  type BootedServer,
  loadServerConfig,
} from './composition-root.js';
import { logRedactedRunFailure } from './live-smoke-diagnostics.js';

const baseUrl = process.env.DATABASE_URL;
const hasKey = Boolean(process.env.OPENAI_API_KEY);
const canRun = Boolean(baseUrl) && hasKey;

if (process.env.RAYSPEC_REQUIRE_LIVE_TESTS === 'true' && !canRun) {
  throw new Error(
    'packages/app/server/src/document-intake-live.smoke.db.test.ts: RAYSPEC_REQUIRE_LIVE_TESTS is set but the live prerequisites (API creds / DB) are absent — refusing to silently skip the live suite.',
  );
}

const here = dirname(fileURLToPath(import.meta.url));
const APP = resolve(here, '../../../../examples/document-intake');
const SPEC = join(APP, 'document-intake.product.yaml');
const LIVE_CONFIG = join(APP, 'live-extraction', 'record_extractor.extractor.json');

interface SeedDocument {
  file_id: string;
  file: string;
  content_type: string;
  expected: { reference: string; title: string; quantity: number; lines: unknown[] };
}
const MANIFEST = JSON.parse(readFileSync(join(APP, 'seed', 'manifest.json'), 'utf8')) as {
  documents: SeedDocument[];
};
// The first plain-text document of the seed: the shortest path through the parser.
const DOC = MANIFEST.documents.find((d) => d.content_type === 'text/plain') as SeedDocument;
const BODY = readFileSync(join(APP, 'seed', DOC.file));

const SUITE_DB = `rayspec_document_intake_live_${process.pid}`;
const TENANT = '00000000-0000-4000-8000-00000000d1a1';
const WORKFLOW = 'process_document';

/** The durable run id the runtime derives for (tenant, workflow, idempotency key). */
function expectedRunId(tenantId: string, workflowId: string, idempotencyKey: string): string {
  const h = createHash('sha256')
    .update(`${tenantId}:${workflowId}:${idempotencyKey}`)
    .digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function withDbName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

describe.skipIf(!canRun)('Document intake LIVE smoke — one real extraction call', () => {
  let server: BootedServer | undefined;
  let appDbUrl = '';
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
    'RAYSPEC_EXTRACTION_CONFIG',
    'STT_PROVIDER',
    'RAYSPEC_BLOB_ROOT',
    'RAYSPEC_MEDIA_SIGNING_KEY',
  ] as const;

  async function drop(): Promise<void> {
    const admin = postgres(withDbName(baseUrl as string, 'postgres'), { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}_dbos_sys" WITH (FORCE)`);
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  }

  beforeAll(async () => {
    if (!canRun) return;
    // Preconditions the assertions below rely on: a plain-text seed document with lines.
    expect(DOC).toBeDefined();
    expect(DOC.expected.lines.length).toBeGreaterThan(0);
    appDbUrl = withDbName(baseUrl as string, SUITE_DB);
    await drop();
    const admin = postgres(withDbName(baseUrl as string, 'postgres'), { max: 1 });
    try {
      await admin.unsafe(`CREATE DATABASE "${SUITE_DB}"`);
    } finally {
      await admin.end();
    }
    blobDir = mkdtempSync(join(tmpdir(), 'rayspec-document-intake-live-'));
    for (const k of ENV) saved[k] = process.env[k];
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    process.env.RAYSPEC_JWT_SIGNING_KEY = await exportPKCS8(privateKey);
    process.env.RAYSPEC_API_KEY_PEPPER = ['document', 'intake', 'live', 'pepper'].join('-');
    process.env.DATABASE_URL = appDbUrl;
    delete process.env.ALLOWED_ORIGINS;
    process.env.PORT = '8811';
    process.env.RAYSPEC_SPEC_PATH = SPEC;
    delete process.env.DBOS_SYSTEM_DATABASE_URL;
    process.env.RAYSPEC_PRODUCT_TENANT_ID = TENANT;
    process.env.RAYSPEC_BLOB_ROOT = blobDir;
    // The live path: the application's live config replaces the deterministic one.
    process.env.RAYSPEC_EXTRACTION_MODE = 'live';
    process.env.RAYSPEC_EXTRACTION_CONFIG = LIVE_CONFIG;
    delete process.env.RAYSPEC_MEDIA_SIGNING_KEY;
    delete process.env.STT_PROVIDER;

    // The organization must exist before a product deployment boots.
    const seed = makeDb(appDbUrl);
    try {
      await applyMigrations(seed);
      await seed.$client.unsafe(
        `INSERT INTO orgs (id, name, slug) VALUES ($1, 'Intake live', 'intake-live')`,
        [TENANT],
      );
    } finally {
      await seed.$client.end();
    }
    server = await assembleServer(loadServerConfig(), {
      registerProductTables: (tables) => registerScopedTables([...tables.values()]),
    });
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    if (blobDir) rmSync(blobDir, { recursive: true, force: true });
    if (canRun) await drop();
  }, 60_000);

  async function ownerToken(): Promise<string> {
    const email = `intake-live-${Date.now()}@example.com`;
    const reg = await server!.app.request('/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'a-long-enough-password' }),
    });
    expect([200, 201]).toContain(reg.status);
    const client = postgres(appDbUrl, { max: 1 });
    try {
      await client.unsafe(
        `INSERT INTO memberships (org_id, user_id, role, status)
         SELECT $1, id, 'owner', 'active' FROM users WHERE email = $2`,
        [TENANT, email],
      );
    } finally {
      await client.end();
    }
    const sw = await server!.app.request(`/v1/orgs/${TENANT}/switch`, {
      method: 'POST',
      headers: { authorization: `Bearer ${(await reg.json()).accessToken}` },
    });
    expect(sw.status).toBe(200);
    return (await sw.json()).accessToken as string;
  }

  (canRun ? it : it.skip)(
    'one seed document: upload → parse → one real extraction → validated, persisted, served',
    async () => {
      const token = await ownerToken();
      const up = await server!.app.request(`/files/${DOC.file_id}`, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': DOC.content_type,
          'content-length': String(BODY.length),
        },
        body: BODY,
      });
      expect(up.status).toBe(200);
      const sub = await server!.app.request(`/files/${DOC.file_id}/submit`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(sub.status).toBe(200);

      const runId = expectedRunId(TENANT, WORKFLOW, `file_id:${DOC.file_id}`);
      const diagnose = async () => {
        const diag = postgres(appDbUrl, { max: 1 });
        try {
          await logRedactedRunFailure(diag, runId);
        } finally {
          await diag.end();
        }
      };
      const deadline = Date.now() + 150_000;
      let run: { status: string } | undefined;
      for (;;) {
        const client = postgres(appDbUrl, { max: 1 });
        try {
          const rows = (await client.unsafe(
            'SELECT status FROM workflow_runs WHERE workflow_run_id = $1',
            [runId],
          )) as unknown as Array<{ status: string }>;
          run = rows[0];
        } finally {
          await client.end();
        }
        if (run && (run.status === 'completed' || run.status === 'terminal_failure')) break;
        if (Date.now() > deadline) {
          await diagnose();
          throw new Error('the live run did not reach a terminal status');
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      if (run?.status !== 'completed') await diagnose();
      expect(run?.status).toBe('completed');

      // Grounded in the document: the fields it states, as it states them.
      const detail = await server!.app.request(`/records/${DOC.file_id}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(detail.status).toBe(200);
      const record = ((await detail.json()) as { record: SeedDocument['expected'] }).record;
      expect(record.reference).toBe(DOC.expected.reference);
      expect(record.title).toBe(DOC.expected.title);
      expect(record.quantity).toBe(DOC.expected.quantity);
      expect(record.lines).toHaveLength(DOC.expected.lines.length);

      // One extraction call, with a nonzero token usage journaled under the tenant.
      const client = postgres(appDbUrl, { max: 1 });
      try {
        const [usage] = (await client.unsafe(
          'SELECT count(*)::int AS n, coalesce(max(total_tokens),0)::numeric AS max_tokens FROM journal_steps',
        )) as unknown as Array<{ n: number; max_tokens: string }>;
        // eslint-disable-next-line no-console
        console.log(
          '[document-intake-live] journal_steps:',
          usage?.n,
          'max_tokens:',
          usage?.max_tokens,
        );
        expect(Number(usage?.max_tokens ?? 0)).toBeGreaterThan(0);
      } finally {
        await client.end();
      }
    },
    240_000,
  );
});
