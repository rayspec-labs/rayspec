/**
 * The Invoice-Intake product, authored in `examples/invoice-intake/`, boots through the REAL server
 * entrypoint (`assembleServer` from `RAYSPEC_SPEC_PATH`) on a throwaway DATABASE + a real DBOS launch,
 * and is driven end-to-end over REAL HTTP against MATERIALIZED ground truth (fail-the-fix). It
 * composes the WHOLE file-ingest chain in ONE doc:
 *   bounded upload/submit + `file_submitted` (file-scoped C10 key) · conditional file mount +
 *   blob-env demand · `file_input.parse_text` (text + PDF text-layer) · the generic extraction
 *   branch's product shape (DETERMINISTIC executor in CI — the live proof is the sibling smoke) ·
 *   plus store_read (vendor→GL catalog) feeding BOTH the agent and the persisted snapshot,
 *   `validation.check`, store_write, and GET views.
 *
 * FAIL-THE-FIX posture: the deterministic executor DERIVES its output from the actual artifact values
 * (the parsed document text + the catalog rows) — it hard-fails on a missing/garbled input instead of
 * returning a canned object, so a parse/flow regression goes RED here rather than being masked by a
 * hardcoded extraction.
 *
 * Arms (the ran-guard pins the count):
 *   (a) boot: blob env demanded; NO media key / STT env (deleted — a wrong demand aborts the boot);
 *       RAYSPEC_EXTRACTION_MODE demanded (one agent); declared route tuples mount;
 *   (b) upload a TEXT invoice → submit → the REAL DBOS workflow runs parse_text → read_catalog →
 *       agent → validation.check → store_write OFF-REQUEST → EXACTLY ONE `workflow_runs` row whose PK
 *       equals the INDEPENDENTLY-RECOMPUTED id over the C10 key `file_id:<id>` → the coded_invoices
 *       row carries fields DERIVED FROM THE DOCUMENT TEXT + the catalog-matched GL code + the catalog
 *       snapshot (read feeds write) → the bytes sit under the tenant-jailed content-addressed key;
 *   (b2) the DECLARED views serve the coded invoice over HTTP (detail + paged list);
 *   (c) a COMMITTED text-layer PDF invoice (self-made via the pdf-fixture builder — the exact
 *       buildPdf call is documented in examples/invoice-intake/fixtures/) parses + codes
 *       end-to-end on the REAL pinned parser (second run, second row);
 *   (d) byte-identical re-upload + re-submit → deduped, run count UNCHANGED (C10 single-flight);
 *   (e) divergent post-seal upload → 409 `file_conflict`, sealed bytes untouched, runs unchanged;
 *   (f) oversize Content-Length → 413 BEFORE any byte: ZERO blob, ZERO pointer row, ZERO new runs;
 *   (g) disallowed mime → 415, zero side effects;
 *   (h) unauthenticated upload + submit → 401;
 *   (i) cross-tenant: a SECOND org's submit → the bridge sink's fail-closed 403, ZERO enqueue;
 *   (j) a FILENAME-LESS upload (no optional x-file-name header) completes end-to-end — the product
 *       does NOT persist the client filename (`{event:}` is fail-closed on a null payload
 *       value, so the doc keeps the attacker-influenced optional filename out of the coded row);
 *   (k) a coded output MISSING a required field (no gl_code, via the sentinel document) is REJECTED
 *       before persist — the agent node's required_output_shape gate fires first
 *       (agent_output_shape_mismatch); validation.check re-checks the SAME declared paths — and
 *       NOTHING persists;
 *   (l) the list view paginates (limit/offset) with created_at-DESC ordering;
 *   (m) cross-tenant READ isolation: tenant B's principal drives BOTH GET views → the structural
 *       TenantDb predicate yields the declared EMPTY shapes, never tenant A's coded invoice.
 *
 * DETERMINISTIC BY DESIGN: CI has no LLM creds, so the merge gate runs
 * RAYSPEC_EXTRACTION_MODE=deterministic with the injected executor above (the same pattern the
 * expense-claim example uses). The REAL-LLM proof of the SAME product is the self-skipping sibling
 * `invoice-intake-live.smoke.db.test.ts` (runs locally with OPENAI_API_KEY; self-skips in CI).
 * Skips without DATABASE_URL; the un-skippable ran-guard hard-fails a REQUIRED run.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryAgentHandlerRegistry } from '@rayspec/agent-runtime';
import { registerScopedTables } from '@rayspec/db/testing';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assembleServer, type BootedServer, loadServerConfig } from './composition-root.js';

const baseUrl = process.env.DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const INVOICE_YAML = resolve(
  here,
  '../../../../examples/invoice-intake/invoice-intake.product.yaml',
);
const FIXTURES = resolve(here, '../../../../examples/invoice-intake/fixtures');

const SUITE_DB = `rayspec_invoice_0_2_${process.pid}`;
const TENANT = '00000000-0000-4000-8000-00000000f201';
const TENANT_B = '00000000-0000-4000-8000-00000000f202';

// The committed sample invoices (self-made — no internet samples). The TEXT invoice is the shared
// document the live smoke also uses; the PDF invoice was generated with exactly
//   buildPdf({ pages: [{ text: 'INVOICE INV-2026-048' }, { text: 'Vendor: Musterbau AG' },
//     { text: 'Date: 2026-06-20' }, { text: 'Item: Scaffolding rental (June) | 120000 cents' },
//     { text: 'Total (EUR cents): 120000' }] })
// (the product-yaml test-support builder; pages join with a blank line on parse).
const TXT_FILE_ID = 'inv-2026-047';
const TXT_BODY = readFileSync(join(FIXTURES, 'sample-invoice.txt'), 'utf8');
const TXT_SHA = createHash('sha256').update(TXT_BODY).digest('hex');
const PDF_FILE_ID = 'inv-2026-048';
const PDF_BYTES = new Uint8Array(readFileSync(join(FIXTURES, 'sample-invoice.pdf')));
const PDF_SHA = createHash('sha256').update(PDF_BYTES).digest('hex');
const NONAME_FILE_ID = 'inv-2026-049';
const BAD_FILE_ID = 'inv-2026-050';

// Ran-guard: skipIf(!baseUrl) must never let a REQUIRED run (CI /
// RAYSPEC_REQUIRE_DB_TESTS) read green after silently skipping this acceptance proof.
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
let e2eTestsRan = 0;

/**
 * The DETERMINISTIC invoice extractor (the platform ships none — product-free). It DERIVES every
 * coded field from the REAL artifact values it receives:
 *  - `invoice.extracted_text` (the parse node's envelope — unwrap `content`): vendor / date /
 *    line items / total are regex-derived from the parsed document, so the arm FAILS if the parse
 *    output never reached the agent or got garbled;
 *  - `invoice.catalog_rows` (the store_read rows, a plain array): the GL code comes from the row
 *    matching the derived vendor (fallback: the seeded 'unmatched' suspense row), so the arm FAILS
 *    if the catalog read never fed the agent.
 */
function invoiceExtractor(): InMemoryAgentHandlerRegistry {
  const registry = new InMemoryAgentHandlerRegistry();
  registry.register('agent.invoice_extractor', (input) => {
    const output = input.artifact_outputs.find((a) => a.schema_ref === 'invoice.coded');
    if (!output) throw new Error('declared output artifact missing');
    const textArt = input.artifact_inputs.find((a) => a.ref === 'invoice.extracted_text');
    const catalogArt = input.artifact_inputs.find((a) => a.ref === 'invoice.catalog_rows');
    if (!textArt || !catalogArt) throw new Error('declared input artifacts missing');
    // The parse node emits a `{ ref, kind, content, metadata }` envelope; the text is `content`.
    const rawText = textArt.value as { content?: unknown } | string;
    const text =
      typeof rawText === 'object' && rawText !== null && 'content' in rawText
        ? String(rawText.content)
        : String(rawText);
    const rows = catalogArt.value as Array<Record<string, unknown>>;
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error('the vendor→GL catalog rows never reached the agent');
    }

    const vendor = /^Vendor:\s*(.+)$/m.exec(text)?.[1]?.trim();
    const total = /^Total \(EUR cents\):\s*(\d+)$/m.exec(text)?.[1];
    const date = /^Date:\s*(\S+)$/m.exec(text)?.[1] ?? null;
    if (!vendor || !total) {
      throw new Error(
        `could not derive invoice fields from the parsed text: ${JSON.stringify(text)}`,
      );
    }
    const line_items = [...text.matchAll(/^Item:\s*(.+?)\s*\|\s*(\d+)\s*cents$/gm)].map((m) => ({
      description: m[1] as string,
      quantity: null,
      amount_cents: Number(m[2]),
    }));
    const match =
      rows.find((r) => r.vendor === vendor) ?? rows.find((r) => r.vendor === 'unmatched');
    if (!match) throw new Error(`no catalog row matches vendor '${vendor}' and no fallback row`);

    const value: Record<string, unknown> = {
      vendor,
      amount_cents: Number(total),
      invoice_date: date,
      currency: 'EUR',
      gl_code: String(match.gl_code),
      line_items,
    };
    // Arm (k)'s sentinel: a document carrying this explicit marker makes the executor emit a coded
    // object MISSING gl_code — the platform's declared-shape gates must REJECT it before persist.
    if (/^X-Test-Omit:\s*gl_code$/m.test(text)) delete value.gl_code;
    return [{ ...output, value }];
  });
  return registry;
}

/**
 * The INDEPENDENT oracle for the durable run id (ids.ts `durableWorkflowRunId`, recomputed here on
 * purpose — a derivation/format drift re-keys durable runs on redelivery, so this test must go RED
 * on it rather than follow it): v5-shaped UUID over sha256(`${tenant}:${workflowId}:${key}`).
 */
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

describe.skipIf(!baseUrl)('Invoice-Intake acceptance — real boot + real DBOS + HTTP', () => {
  let server: BootedServer | undefined;
  let appDbUrl = '';
  let dbosSysDb = '';
  let blobDir = '';
  let tokenA = '';
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

    blobDir = mkdtempSync(join(tmpdir(), 'rayspec-invoice-'));
    for (const k of ENV) saved[k] = process.env[k];
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    process.env.RAYSPEC_JWT_SIGNING_KEY = await exportPKCS8(privateKey);
    process.env.RAYSPEC_API_KEY_PEPPER = 'invoice-0-2-pepper';
    process.env.DATABASE_URL = appDbUrl;
    delete process.env.ALLOWED_ORIGINS;
    process.env.PORT = '8809';
    process.env.RAYSPEC_SPEC_PATH = INVOICE_YAML;
    delete process.env.DBOS_SYSTEM_DATABASE_URL;
    process.env.RAYSPEC_PRODUCT_TENANT_ID = TENANT;
    // The doc-driven env-demand arm (a), proven by the boot itself: a FILE-declaring doc with ONE
    // agent demands RAYSPEC_BLOB_ROOT + RAYSPEC_EXTRACTION_MODE — and must NOT demand the
    // media key or STT env (both deleted; a wrong demand fail-closes the whole suite here).
    process.env.RAYSPEC_BLOB_ROOT = blobDir;
    process.env.RAYSPEC_EXTRACTION_MODE = 'deterministic';
    delete process.env.RAYSPEC_MEDIA_SIGNING_KEY;
    delete process.env.STT_PROVIDER;

    const config = loadServerConfig();
    server = await assembleServer(config, {
      registerProductTables: (tables) => registerScopedTables([...tables.values()]),
      productDeterministicAgents: invoiceExtractor(),
    });

    const client = postgres(appDbUrl, { max: 2 });
    try {
      await client.unsafe(
        `INSERT INTO orgs (id, name, slug) VALUES ($1, 'InvoiceA', 'invoice-a'), ($2, 'InvoiceB', 'invoice-b')`,
        [TENANT, TENANT_B],
      );
      // Seed the vendor→GL catalog the store_read feeds to the agent (the support-ticket-0.2
      // routing-catalog seed pattern, incl. the 'unmatched' suspense fallback row).
      await client.unsafe(
        `INSERT INTO vendor_gl_catalog (tenant_id, vendor, gl_code, gl_account_name)
         VALUES ($1, 'Acme Papierwerke GmbH', '6815', 'Office supplies'),
                ($1, 'Musterbau AG', '6600', 'Construction services'),
                ($1, 'unmatched', '9999', 'Suspense — manual review')`,
        [TENANT],
      );
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
    if (blobDir) rmSync(blobDir, { recursive: true, force: true });
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
    const email = `invoice-${tenant.slice(-4)}-${Date.now()}@example.com`;
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

  /** PUT raw bytes — string OR binary (the in-process Request preserves a manual Content-Length). */
  function upload(
    fileId: string,
    body: string | Uint8Array,
    opts: {
      token?: string;
      contentType?: string;
      contentLength?: string;
      fileName?: string;
    } = {},
  ): Promise<Response> {
    const byteLength = typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength;
    return server!.app.request(`/files/${fileId}`, {
      method: 'PUT',
      headers: {
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        'content-type': opts.contentType ?? 'text/plain',
        'content-length': opts.contentLength ?? String(byteLength),
        ...(opts.fileName ? { 'x-file-name': opts.fileName } : {}),
      },
      body: body as BodyInit,
    });
  }

  function submit(fileId: string, token?: string, body: unknown = {}): Promise<Response> {
    return server!.app.request(`/files/${fileId}/submit`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  async function workflowRuns(): Promise<Array<{ workflow_run_id: string; status: string }>> {
    const client = postgres(appDbUrl, { max: 1 });
    try {
      return (await client.unsafe(
        'SELECT workflow_run_id, status FROM workflow_runs',
      )) as unknown as Array<{ workflow_run_id: string; status: string }>;
    } finally {
      await client.end();
    }
  }
  async function codedInvoices(): Promise<Array<Record<string, unknown>>> {
    const client = postgres(appDbUrl, { max: 1 });
    try {
      return (await client.unsafe(
        'SELECT invoice_ref, file_id, sha256, size_bytes, content_type, ' +
          'coded, catalog_snapshot, status FROM coded_invoices',
      )) as unknown as Array<Record<string, unknown>>;
    } finally {
      await client.end();
    }
  }
  async function pointerRows(): Promise<Array<Record<string, unknown>>> {
    const client = postgres(appDbUrl, { max: 1 });
    try {
      return (await client.unsafe(
        'SELECT file_id, file_ref, state, sha256 FROM file_uploads',
      )) as unknown as Array<Record<string, unknown>>;
    } finally {
      await client.end();
    }
  }
  /** Wait for ONE specific run to reach a TERMINAL status (completed / terminal_failure). */
  async function waitForRun(
    runId: string,
  ): Promise<{ workflow_run_id: string; status: string; error: unknown }> {
    const deadline = Date.now() + 90_000;
    for (;;) {
      const client = postgres(appDbUrl, { max: 1 });
      try {
        const rows = (await client.unsafe(
          'SELECT workflow_run_id, status, error FROM workflow_runs WHERE workflow_run_id = $1',
          [runId],
        )) as unknown as Array<{ workflow_run_id: string; status: string; error: unknown }>;
        const run = rows[0];
        if (run && (run.status === 'completed' || run.status === 'terminal_failure')) return run;
      } finally {
        await client.end();
      }
      if (Date.now() > deadline) throw new Error(`run ${runId} did not reach a terminal status`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  /** Assert run count stays `expected` across a short quiesce window (no late double-fire). */
  async function expectRunsQuiesced(expected: number): Promise<void> {
    const deadline = Date.now() + 2_000;
    for (;;) {
      expect(await workflowRuns()).toHaveLength(expected);
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  const maybe = baseUrl ? it : it.skip;

  maybe(
    '(a) boot: the file+agent doc materializes WITHOUT media/stt env; declared tuples mount',
    () => {
      e2eTestsRan += 1;
      expect(server!.deployMode).toBe('materialized');
      const actions = server!.declaredRoutes.map((r) => `${r.method} ${r.path} → ${r.action}`);
      expect(actions).toContain('PUT /files/{file_id} → stream:ingest.file_input_upload');
      expect(actions).toContain('POST /files/{file_id}/submit → handler:file_input_submit');
      expect(actions.some((a) => a.startsWith('GET /invoices/{invoice_ref} → handler:'))).toBe(
        true,
      );
      expect(actions.some((a) => a.startsWith('GET /invoices → handler:'))).toBe(true);
      // Nothing audio/record-shaped mounts for a file-only doc.
      expect(actions.some((a) => a.includes('/sessions/') || a.includes('/records/'))).toBe(false);
    },
  );

  maybe(
    '(b) TEXT invoice: upload → submit → ONE run (C10) → parse→catalog→agent→validate→store',
    async () => {
      e2eTestsRan += 1;
      const up = await upload(TXT_FILE_ID, TXT_BODY, {
        token: tokenA,
        fileName: 'sample-invoice.txt',
      });
      expect(up.status).toBe(200);
      expect((await up.json()) as Record<string, unknown>).toMatchObject({
        file_id: TXT_FILE_ID,
        state: 'uploaded',
        sha256: TXT_SHA,
        deduped: false,
      });
      // GROUND TRUTH: the bytes sit under the tenant-jailed CONTENT-ADDRESSED key on disk.
      expect(existsSync(join(blobDir, TENANT, 'files', TXT_FILE_ID, TXT_SHA))).toBe(true);

      const sub = await submit(TXT_FILE_ID, tokenA);
      expect(sub.status).toBe(200);
      expect(((await sub.json()) as Record<string, unknown>).deduped).toBe(false);

      // ★ THE C10 KEY PIN through the WHOLE composed stack: the durable run's PK must equal the
      // independently-recomputed deterministic id over the file-scoped key `file_id:<id>`.
      const runId = expectedRunId(TENANT, 'code_invoice', `file_id:${TXT_FILE_ID}`);
      const run = await waitForRun(runId);
      expect(run.status).toBe('completed');
      await expectRunsQuiesced(1);

      // MATERIALIZED ground truth: the coded row's fields were DERIVED from the parsed document
      // text (vendor/date/total/line items) and the GL code from the CATALOG row matching the
      // vendor — proving parse_text → store_read → agent → validation → store_write dataflow.
      const rows = await codedInvoices();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        invoice_ref: TXT_FILE_ID,
        file_id: TXT_FILE_ID,
        sha256: TXT_SHA,
        size_bytes: Buffer.byteLength(TXT_BODY),
        content_type: 'text/plain',
        status: 'coded',
      });
      expect(rows[0]?.coded).toMatchObject({
        vendor: 'Acme Papierwerke GmbH',
        amount_cents: 24990,
        invoice_date: '2026-06-14',
        gl_code: '6815',
      });
      const items = (rows[0]?.coded as { line_items: Array<Record<string, unknown>> }).line_items;
      expect(items).toHaveLength(2);
      expect(items[0]).toMatchObject({
        description: 'A4 copy paper (10 reams)',
        amount_cents: 1990,
      });
      // read feeds write: the catalog snapshot is the three seeded rows.
      expect(Array.isArray(rows[0]?.catalog_snapshot)).toBe(true);
      expect((rows[0]?.catalog_snapshot as unknown[]).length).toBe(3);
    },
    150_000,
  );

  maybe(
    '(b2) the DECLARED views serve the coded invoice over HTTP (detail + paged list)',
    async () => {
      e2eTestsRan += 1;
      const detail = await server!.app.request(`/invoices/${TXT_FILE_ID}`, {
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(detail.status).toBe(200);
      const body = (await detail.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        invoice_ref: TXT_FILE_ID,
        file_id: TXT_FILE_ID,
        content_type: 'text/plain',
        status: 'coded',
      });
      expect(body.coded).toMatchObject({ vendor: 'Acme Papierwerke GmbH', gl_code: '6815' });

      const list = await server!.app.request('/invoices', {
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(list.status).toBe(200);
      const listBody = (await list.json()) as { invoices: Array<Record<string, unknown>> };
      expect(listBody.invoices).toHaveLength(1);
      expect(listBody.invoices[0]).toMatchObject({
        invoice_ref: TXT_FILE_ID,
        status: 'coded',
        content_type: 'text/plain',
      });
    },
    60_000,
  );

  maybe(
    '(c) a text-layer PDF invoice parses + codes END-TO-END on the REAL pinned parser',
    async () => {
      e2eTestsRan += 1;
      const up = await upload(PDF_FILE_ID, PDF_BYTES, {
        token: tokenA,
        contentType: 'application/pdf',
        fileName: 'sample-invoice.pdf',
      });
      expect(up.status).toBe(200);
      expect(((await up.json()) as Record<string, unknown>).sha256).toBe(PDF_SHA);
      expect((await submit(PDF_FILE_ID, tokenA)).status).toBe(200);

      const run = await waitForRun(expectedRunId(TENANT, 'code_invoice', `file_id:${PDF_FILE_ID}`));
      expect(run.status).toBe('completed');

      // The PDF's text layer flowed through the same derive-from-document executor: the vendor is
      // the PDF's, and its GL code is the CATALOG row for that vendor (not the text invoice's).
      const row = (await codedInvoices()).find((r) => r.file_id === PDF_FILE_ID);
      expect(row).toMatchObject({
        invoice_ref: PDF_FILE_ID,
        sha256: PDF_SHA,
        content_type: 'application/pdf',
        status: 'coded',
      });
      expect(row?.coded).toMatchObject({
        vendor: 'Musterbau AG',
        amount_cents: 120000,
        invoice_date: '2026-06-20',
        gl_code: '6600',
      });
      // …and the detail view serves it.
      const detail = await server!.app.request(`/invoices/${PDF_FILE_ID}`, {
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(detail.status).toBe(200);
      expect(((await detail.json()) as Record<string, unknown>).coded).toMatchObject({
        vendor: 'Musterbau AG',
        gl_code: '6600',
      });
      await expectRunsQuiesced(2);
    },
    150_000,
  );

  maybe(
    '(d) byte-identical re-upload + re-submit → deduped, run count UNCHANGED (C10)',
    async () => {
      e2eTestsRan += 1;
      const up = await upload(TXT_FILE_ID, TXT_BODY, { token: tokenA });
      expect(up.status).toBe(200);
      expect((await up.json()) as Record<string, unknown>).toMatchObject({
        state: 'submitted',
        deduped: true,
        replaced: false,
      });
      const sub = await submit(TXT_FILE_ID, tokenA);
      expect(sub.status).toBe(200);
      expect(((await sub.json()) as Record<string, unknown>).deduped).toBe(true);

      await expectRunsQuiesced(2);
      expect(await codedInvoices()).toHaveLength(2);
    },
    60_000,
  );

  maybe(
    '(e) divergent post-seal upload → 409, sealed bytes untouched, runs unchanged',
    async () => {
      e2eTestsRan += 1;
      const up = await upload(TXT_FILE_ID, 'Vendor: Evil Corp\nTotal (EUR cents): 1\n', {
        token: tokenA,
      });
      expect(up.status).toBe(409);
      expect(((await up.json()) as Record<string, unknown>).error).toBe('file_conflict');

      const sealed = (await pointerRows()).find((p) => p.file_id === TXT_FILE_ID);
      expect(sealed).toMatchObject({ state: 'submitted', sha256: TXT_SHA });
      await expectRunsQuiesced(2);
    },
    60_000,
  );

  maybe(
    '(f) oversize Content-Length → 413 with ZERO blob bytes, ZERO pointer row, ZERO new runs',
    async () => {
      e2eTestsRan += 1;
      const res = await upload('too-big', 'tiny', {
        token: tokenA,
        contentLength: String(25 * 1024 * 1024 + 1),
      });
      expect(res.status).toBe(413);
      expect(((await res.json()) as Record<string, unknown>).error).toBe('file_too_large');

      expect(existsSync(join(blobDir, TENANT, 'files', 'too-big'))).toBe(false);
      expect((await pointerRows()).some((p) => p.file_id === 'too-big')).toBe(false);
      await expectRunsQuiesced(2);
    },
    60_000,
  );

  maybe(
    '(g) disallowed mime → 415, zero side effects',
    async () => {
      e2eTestsRan += 1;
      const res = await upload('bad-mime', 'PKzipbytes', {
        token: tokenA,
        contentType: 'application/zip',
      });
      expect(res.status).toBe(415);
      expect(((await res.json()) as Record<string, unknown>).error).toBe('file_type_unsupported');

      expect(existsSync(join(blobDir, TENANT, 'files', 'bad-mime'))).toBe(false);
      expect((await pointerRows()).some((p) => p.file_id === 'bad-mime')).toBe(false);
      await expectRunsQuiesced(2);
    },
    60_000,
  );

  maybe(
    '(h) unauthenticated upload + submit → 401',
    async () => {
      e2eTestsRan += 1;
      expect((await upload('no-auth', 'x')).status).toBe(401);
      expect((await submit('no-auth')).status).toBe(401);
      await expectRunsQuiesced(2);
    },
    60_000,
  );

  maybe(
    "(i) cross-tenant: a SECOND org's submit is the sink's fail-closed 403, ZERO enqueue",
    async () => {
      e2eTestsRan += 1;
      const tokenB = await tokenFor(TENANT_B);
      const up = await upload('b-invoice', 'Vendor: B GmbH\nTotal (EUR cents): 5\n', {
        token: tokenB,
      });
      expect(up.status).toBe(200);
      const sub = await submit('b-invoice', tokenB);
      expect(sub.status).toBe(403);
      const body = (await sub.json()) as Record<string, unknown>;
      expect(body.error).toBe('file_event_rejected');
      expect(String(body.detail)).toContain('cross_tenant');
      await expectRunsQuiesced(2);
      expect(await codedInvoices()).toHaveLength(2);
    },
    60_000,
  );

  maybe(
    '(j) a FILENAME-LESS upload (no x-file-name) codes + persists + serves END-TO-END',
    async () => {
      e2eTestsRan += 1;
      // The client filename is an OPTIONAL header: the pipeline must not be load-bearing on it.
      // The file event carries original_filename:null — the run must still complete and persist.
      const up = await upload(NONAME_FILE_ID, TXT_BODY, { token: tokenA });
      expect(up.status).toBe(200);
      expect((await submit(NONAME_FILE_ID, tokenA)).status).toBe(200);

      const run = await waitForRun(
        expectedRunId(TENANT, 'code_invoice', `file_id:${NONAME_FILE_ID}`),
      );
      expect(run.error ?? undefined).toBeUndefined();
      expect(run.status).toBe('completed');
      await expectRunsQuiesced(3);

      const row = (await codedInvoices()).find((r) => r.file_id === NONAME_FILE_ID);
      expect(row).toMatchObject({ invoice_ref: NONAME_FILE_ID, sha256: TXT_SHA, status: 'coded' });
      expect(row?.coded).toMatchObject({ vendor: 'Acme Papierwerke GmbH', gl_code: '6815' });

      const detail = await server!.app.request(`/invoices/${NONAME_FILE_ID}`, {
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(detail.status).toBe(200);
      expect(((await detail.json()) as Record<string, unknown>).status).toBe('coded');
    },
    150_000,
  );

  maybe(
    '(k) a coded output MISSING a required field is REJECTED before persist (declared-shape gate)',
    async () => {
      e2eTestsRan += 1;
      // The sentinel document makes the injected executor omit gl_code. WHICH LAYER REJECTS: the
      // agent node's own required_output_shape enforcement fires FIRST (agent_output_shape_mismatch)
      // — validation.check is the declared acceptance boundary re-checking the SAME required_paths
      // downstream (it would gate any artifact mutation between agent and persist). Either way the
      // invariant under test holds: the run is terminal and NOTHING persists.
      const body = [
        'INVOICE INV-2026-050',
        'Vendor: Musterbau AG',
        'Date: 2026-06-25',
        'Item: Broken output probe | 100 cents',
        'Total (EUR cents): 100',
        'X-Test-Omit: gl_code',
      ].join('\n');
      const up = await upload(BAD_FILE_ID, body, { token: tokenA });
      expect(up.status).toBe(200);
      expect((await submit(BAD_FILE_ID, tokenA)).status).toBe(200);

      const run = await waitForRun(expectedRunId(TENANT, 'code_invoice', `file_id:${BAD_FILE_ID}`));
      // RED-proven (the failure mode this arm guards against — a bad output completing + persisting
      // — was asserted first and failed: "expected 'terminal_failure' to be 'completed'").
      expect(run.status).toBe('terminal_failure');
      const err = JSON.stringify(run.error);
      expect(err).toContain('agent_output_shape_mismatch');
      expect(err).toContain("missing required path 'gl_code'");
      await expectRunsQuiesced(4);
      // The invariant: NOTHING persisted — no coded_invoices row for the rejected document.
      expect((await codedInvoices()).some((r) => r.file_id === BAD_FILE_ID)).toBe(false);
    },
    150_000,
  );

  maybe(
    '(l) the list view PAGINATES: limit/offset pages + created_at-DESC ordering',
    async () => {
      e2eTestsRan += 1;
      // Three coded invoices exist by now (created in order: TXT, PDF, NONAME).
      const page1 = await server!.app.request('/invoices?limit=2', {
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(page1.status).toBe(200);
      const p1 = (await page1.json()) as { invoices: Array<Record<string, unknown>> };
      // RED-proven (limit ignored / ascending order were asserted first and failed).
      expect(p1.invoices).toHaveLength(2);
      expect(p1.invoices.map((i) => i.invoice_ref)).toEqual([NONAME_FILE_ID, PDF_FILE_ID]);

      const page2 = await server!.app.request('/invoices?limit=2&offset=2', {
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(page2.status).toBe(200);
      const p2 = (await page2.json()) as { invoices: Array<Record<string, unknown>> };
      expect(p2.invoices.map((i) => i.invoice_ref)).toEqual([TXT_FILE_ID]);
    },
    60_000,
  );

  maybe(
    "(m) cross-tenant READ isolation: tenant B's principal drives BOTH views — structurally EMPTY",
    async () => {
      e2eTestsRan += 1;
      const tokenB = await tokenFor(TENANT_B);
      const detail = await server!.app.request(`/invoices/${TXT_FILE_ID}`, {
        headers: { authorization: `Bearer ${tokenB}` },
      });
      expect(detail.status).toBe(200);
      // RED-proven (the leak — tenant B reading tenant A's coded invoice — was asserted first and
      // failed with "expected null to be 'inv-2026-047'"). The isolation is structural (TenantDb):
      // the view finds NO row for tenant B → the declared empty_200 ABSENT shape, never A's data.
      expect(await detail.json()).toEqual({
        invoice_ref: TXT_FILE_ID,
        file_id: null,
        content_type: null,
        status: null,
        coded: null,
      });

      const list = await server!.app.request('/invoices', {
        headers: { authorization: `Bearer ${tokenB}` },
      });
      expect(list.status).toBe(200);
      expect(await list.json()).toEqual({ invoices: [] });
    },
    60_000,
  );
});

// The un-skippable ran-guard: fail loudly if a REQUIRED (CI / RAYSPEC_REQUIRE_DB_TESTS) run
// SKIPPED the acceptance arms (a lost DATABASE_URL would otherwise read GREEN).
describe('Invoice-Intake acceptance — ran-guard (must not silently skip in CI)', () => {
  it('all 14 acceptance arms actually ran when the DB was required', () => {
    if (dbRequired) expect(e2eTestsRan).toBe(14);
    else expect(dbRequired).toBe(false);
  });
});
