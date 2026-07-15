/**
 * THE CONTRACT-INTAKE E2E (the shipping gate's harness). The greenfield
 * FILE-declaring Contract-Metadata-Intake product in `examples/contract-intake/` (a DIFFERENT file
 * product from the invoice acceptance), boots
 * through the REAL server entrypoint (`assembleServer` from `RAYSPEC_SPEC_PATH`) on a throwaway
 * DATABASE + a real DBOS launch, and is driven end-to-end over REAL HTTP against MATERIALIZED ground
 * truth (fail-the-fix). Same file-ingest chain as the acceptance, second independent product:
 *   bounded upload/submit + `file_submitted` (file-scoped C10 key) · conditional file mount +
 *   blob-env demand · `file_input.parse_text` (text + PDF text-layer) · the generic extraction
 *   branch's product shape (DETERMINISTIC executor in CI — the live proof is the sibling smoke) ·
 *   plus store_read (the contract-type→retention catalog) feeding BOTH the agent and the persisted
 *   snapshot, `validation.check`, store_write, and GET views.
 *
 * FAIL-THE-FIX posture: the deterministic executor DERIVES its output from the actual artifact values
 * (the parsed document text + the catalog rows) — it hard-fails on a missing/garbled input instead of
 * returning a canned object, so a parse/flow regression goes RED here rather than being masked by a
 * hardcoded extraction.
 *
 * Arms (the ran-guard pins the count):
 *   (a) boot: blob env demanded; NO media key / STT env (deleted — a wrong demand aborts the boot);
 *       RAYSPEC_EXTRACTION_MODE demanded (one agent); declared route tuples mount;
 *   (b) upload a TEXT contract (the committed NDA) → submit → the REAL DBOS workflow runs parse_text →
 *       read_catalog → agent → validation.check → store_write OFF-REQUEST → EXACTLY ONE
 *       `workflow_runs` row whose PK equals the INDEPENDENTLY-RECOMPUTED id over the C10 key
 *       `file_id:<id>` → the coded_contracts row carries fields DERIVED FROM THE DOCUMENT TEXT +
 *       the catalog-matched retention policy + the catalog snapshot (read feeds write) → the bytes
 *       sit under the tenant-jailed content-addressed key;
 *   (b2) the DECLARED views serve the coded contract over HTTP (detail + paged list);
 *   (c) a COMMITTED text-layer PDF contract (a DPA — self-made via the pdf-fixture builder; the
 *       exact buildPdf call is documented in examples/contract-intake/fixtures/README.md) parses
 *       + codes end-to-end on the REAL pinned parser — a DIFFERENT contract_type, so its retention
 *       policy comes from a DIFFERENT catalog row (the match is provably not canned);
 *   (d) byte-identical re-upload + re-submit → deduped, run count UNCHANGED (C10 single-flight);
 *   (e) divergent post-seal upload → 409 `file_conflict`, sealed bytes untouched, runs unchanged;
 *   (f) oversize Content-Length → 413 BEFORE any byte: ZERO blob, ZERO pointer row, ZERO new runs;
 *   (g) disallowed mime → 415, zero side effects;
 *   (h) unauthenticated upload + submit → 401;
 *   (i) cross-tenant: a SECOND org's submit → the bridge sink's fail-closed 403, ZERO enqueue;
 *   (j) a FILENAME-LESS upload (no optional x-file-name header) completes end-to-end — the product
 *       does NOT persist the client filename (the `{event:}` resolver is fail-closed on a null
 *       payload value — the null-payload posture — so the doc keeps the attacker-influenced optional
 *       filename out of the coded row);
 *   (k) a coded output MISSING a required field (no retention_years, via the sentinel document) is
 *       REJECTED before persist — the agent node's required_output_shape gate fires first
 *       (agent_output_shape_mismatch); validation.check re-checks the SAME declared paths — and
 *       NOTHING persists;
 *   (l) the list view paginates (limit/offset) with created_at-DESC ordering;
 *   (m) cross-tenant READ isolation: tenant B's principal drives BOTH GET views → the structural
 *       TenantDb predicate yields the declared EMPTY shapes, never tenant A's coded contract.
 *
 * DETERMINISTIC BY DESIGN: CI has no LLM creds, so the merge gate runs
 * RAYSPEC_EXTRACTION_MODE=deterministic with the injected executor above (the same pattern the
 * invoice-intake example uses). The REAL-LLM proof of the SAME product is the self-skipping sibling
 * `contract-intake-live.smoke.db.test.ts` (runs locally with OPENAI_API_KEY; self-skips in CI).
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
const CONTRACT_YAML = resolve(
  here,
  '../../../../examples/contract-intake/contract-intake.product.yaml',
);
const FIXTURES = resolve(here, '../../../../examples/contract-intake/fixtures');

const SUITE_DB = `rayspec_contract_0_2_${process.pid}`;
const TENANT = '00000000-0000-4000-8000-00000000f401';
const TENANT_B = '00000000-0000-4000-8000-00000000f402';

// The committed sample contracts (self-made — no internet samples). The TEXT contract (an NDA) is
// the shared document the live smoke also uses; the PDF contract (a DPA — a DIFFERENT contract type,
// so its retention row differs from the NDA's) was generated with exactly
//   buildPdf({ pages: [{ text: 'DATA PROCESSING AGREEMENT' },
//     { text: 'Helios Cloud Services AG and our company.' },
//     { text: 'Effective Date: 2026-06-15' }, { text: 'Initial Term: 36 months' },
//     { text: 'Governing Law: Ireland' }, { text: 'Total Contract Value (EUR cents): 5000000' }] })
// (the product-yaml test-support builder; pages join with a blank line on parse).
const TXT_FILE_ID = 'ctr-2026-001';
const TXT_BODY = readFileSync(join(FIXTURES, 'sample-contract.txt'), 'utf8');
const TXT_SHA = createHash('sha256').update(TXT_BODY).digest('hex');
const PDF_FILE_ID = 'ctr-2026-002';
const PDF_BYTES = new Uint8Array(readFileSync(join(FIXTURES, 'sample-contract.pdf')));
const PDF_SHA = createHash('sha256').update(PDF_BYTES).digest('hex');
const NONAME_FILE_ID = 'ctr-2026-003';
const BAD_FILE_ID = 'ctr-2026-004';

// Ran-guard: skipIf(!baseUrl) must never let a REQUIRED run (CI /
// RAYSPEC_REQUIRE_DB_TESTS) read green after silently skipping this e2e proof.
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
let e2eTestsRan = 0;

/**
 * The DETERMINISTIC contract extractor (the platform ships none — product-free). It DERIVES every
 * coded field from the REAL artifact values it receives:
 *  - `contract.extracted_text` (the parse node's envelope — unwrap `content`): counterparty /
 *    contract type / dates / term / value are regex-derived from the parsed document, so the arm
 *    FAILS if the parse output never reached the agent or got garbled;
 *  - `contract.catalog_rows` (the store_read rows, a plain array): retention_years + review_owner
 *    come from the row matching the CLASSIFIED contract_type (fallback: the seeded 'other' row), so
 *    the arm FAILS if the catalog read never fed the agent.
 */
function contractExtractor(): InMemoryAgentHandlerRegistry {
  const registry = new InMemoryAgentHandlerRegistry();
  registry.register('agent.contract_extractor', (input) => {
    const output = input.artifact_outputs.find((a) => a.schema_ref === 'contract.coded');
    if (!output) throw new Error('declared output artifact missing');
    const textArt = input.artifact_inputs.find((a) => a.ref === 'contract.extracted_text');
    const catalogArt = input.artifact_inputs.find((a) => a.ref === 'contract.catalog_rows');
    if (!textArt || !catalogArt) throw new Error('declared input artifacts missing');
    // The parse node emits a `{ ref, kind, content, metadata }` envelope; the text is `content`.
    const rawText = textArt.value as { content?: unknown } | string;
    const text =
      typeof rawText === 'object' && rawText !== null && 'content' in rawText
        ? String(rawText.content)
        : String(rawText);
    const rows = catalogArt.value as Array<Record<string, unknown>>;
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error('the contract-type retention catalog rows never reached the agent');
    }

    const counterparty = /^(.+?) and our company\.$/m.exec(text)?.[1]?.trim();
    const effectiveDate = /^Effective Date:\s*(\S+)$/m.exec(text)?.[1];
    const contractType = /NON-DISCLOSURE/i.test(text)
      ? 'nda'
      : /MASTER SERVICES/i.test(text)
        ? 'msa'
        : /STATEMENT OF WORK/i.test(text)
          ? 'sow'
          : /DATA PROCESSING/i.test(text)
            ? 'dpa'
            : 'other';
    if (!counterparty || !effectiveDate) {
      throw new Error(
        `could not derive contract fields from the parsed text: ${JSON.stringify(text)}`,
      );
    }
    const term = /^Initial Term:\s*(\d+)\s*months$/m.exec(text)?.[1];
    const notice = /at least (\d+) days/.exec(text)?.[1];
    const law = /^Governing Law:\s*(.+)$/m.exec(text)?.[1]?.trim();
    const value = /^Total Contract Value \(EUR cents\):\s*(\d+)$/m.exec(text)?.[1];
    const match =
      rows.find((r) => r.contract_type === contractType) ??
      rows.find((r) => r.contract_type === 'other');
    if (!match) {
      throw new Error(`no catalog row matches type '${contractType}' and no 'other' fallback row`);
    }

    const coded: Record<string, unknown> = {
      counterparty_name: counterparty,
      contract_type: contractType,
      effective_date: effectiveDate,
      term_months: term ? Number(term) : null,
      auto_renews: /renews automatically/.test(text) ? true : null,
      notice_period_days: notice ? Number(notice) : null,
      governing_law: law ?? null,
      total_value_cents: value ? Number(value) : null,
      retention_years: Number(match.retention_years),
      review_owner: String(match.review_owner),
    };
    // Arm (k)'s sentinel: a document carrying this explicit marker makes the executor emit a coded
    // object MISSING retention_years — the platform's declared-shape gates must REJECT it before
    // persist.
    if (/^X-Test-Omit:\s*retention_years$/m.test(text)) delete coded.retention_years;
    return [{ ...output, value: coded }];
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

describe.skipIf(!baseUrl)('Contract-Intake e2e — real boot + real DBOS + HTTP', () => {
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

    blobDir = mkdtempSync(join(tmpdir(), 'rayspec-contract-'));
    for (const k of ENV) saved[k] = process.env[k];
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    process.env.RAYSPEC_JWT_SIGNING_KEY = await exportPKCS8(privateKey);
    process.env.RAYSPEC_API_KEY_PEPPER = 'contract-0-2-pepper';
    process.env.DATABASE_URL = appDbUrl;
    delete process.env.ALLOWED_ORIGINS;
    process.env.PORT = '8811';
    process.env.RAYSPEC_SPEC_PATH = CONTRACT_YAML;
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
      productDeterministicAgents: contractExtractor(),
    });

    const client = postgres(appDbUrl, { max: 2 });
    try {
      await client.unsafe(
        `INSERT INTO orgs (id, name, slug) VALUES ($1, 'ContractA', 'contract-a'), ($2, 'ContractB', 'contract-b')`,
        [TENANT, TENANT_B],
      );
      // Seed the contract-type retention catalog the store_read feeds to the agent (one row per
      // contract type, incl. the 'other' suspense fallback row — the product-YAML seed contract).
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
    const email = `contract-${tenant.slice(-4)}-${Date.now()}@example.com`;
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
  async function codedContracts(): Promise<Array<Record<string, unknown>>> {
    const client = postgres(appDbUrl, { max: 1 });
    try {
      return (await client.unsafe(
        'SELECT contract_ref, file_id, sha256, size_bytes, content_type, ' +
          'coded, catalog_snapshot, status FROM coded_contracts',
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
      expect(actions.some((a) => a.startsWith('GET /contracts/{contract_ref} → handler:'))).toBe(
        true,
      );
      expect(actions.some((a) => a.startsWith('GET /contracts → handler:'))).toBe(true);
      // Nothing audio/record-shaped mounts for a file-only doc.
      expect(actions.some((a) => a.includes('/sessions/') || a.includes('/records/'))).toBe(false);
    },
  );

  maybe(
    '(b) TEXT contract: upload → submit → ONE run (C10) → parse→catalog→agent→validate→store',
    async () => {
      e2eTestsRan += 1;
      const up = await upload(TXT_FILE_ID, TXT_BODY, {
        token: tokenA,
        fileName: 'sample-contract.txt',
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
      const runId = expectedRunId(TENANT, 'code_contract', `file_id:${TXT_FILE_ID}`);
      const run = await waitForRun(runId);
      expect(run.status).toBe('completed');
      await expectRunsQuiesced(1);

      // MATERIALIZED ground truth: the coded row's fields were DERIVED from the parsed document
      // text (counterparty/type/dates/term) and the retention policy from the CATALOG row matching
      // the classified type — proving parse_text → store_read → agent → validation → store_write
      // dataflow.
      const rows = await codedContracts();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        contract_ref: TXT_FILE_ID,
        file_id: TXT_FILE_ID,
        sha256: TXT_SHA,
        size_bytes: Buffer.byteLength(TXT_BODY),
        content_type: 'text/plain',
        status: 'coded',
      });
      expect(rows[0]?.coded).toMatchObject({
        counterparty_name: 'Nordwind Robotics GmbH',
        contract_type: 'nda',
        effective_date: '2026-05-01',
        term_months: 24,
        auto_renews: true,
        notice_period_days: 30,
        governing_law: 'Germany',
        total_value_cents: null,
        // The catalog-matched retention policy: the SEEDED 'nda' row, not an invented one.
        retention_years: 5,
        review_owner: 'legal-ops',
      });
      // read feeds write: the catalog snapshot is the five seeded rows.
      expect(Array.isArray(rows[0]?.catalog_snapshot)).toBe(true);
      expect((rows[0]?.catalog_snapshot as unknown[]).length).toBe(5);
    },
    150_000,
  );

  maybe(
    '(b2) the DECLARED views serve the coded contract over HTTP (detail + paged list)',
    async () => {
      e2eTestsRan += 1;
      const detail = await server!.app.request(`/contracts/${TXT_FILE_ID}`, {
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(detail.status).toBe(200);
      const body = (await detail.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        contract_ref: TXT_FILE_ID,
        file_id: TXT_FILE_ID,
        content_type: 'text/plain',
        status: 'coded',
      });
      expect(body.coded).toMatchObject({
        counterparty_name: 'Nordwind Robotics GmbH',
        contract_type: 'nda',
        retention_years: 5,
      });

      const list = await server!.app.request('/contracts', {
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(list.status).toBe(200);
      const listBody = (await list.json()) as { contracts: Array<Record<string, unknown>> };
      expect(listBody.contracts).toHaveLength(1);
      expect(listBody.contracts[0]).toMatchObject({
        contract_ref: TXT_FILE_ID,
        status: 'coded',
        content_type: 'text/plain',
      });
    },
    60_000,
  );

  maybe(
    '(c) a text-layer PDF contract (a DPA) parses + codes END-TO-END on the REAL pinned parser',
    async () => {
      e2eTestsRan += 1;
      const up = await upload(PDF_FILE_ID, PDF_BYTES, {
        token: tokenA,
        contentType: 'application/pdf',
        fileName: 'sample-contract.pdf',
      });
      expect(up.status).toBe(200);
      expect(((await up.json()) as Record<string, unknown>).sha256).toBe(PDF_SHA);
      expect((await submit(PDF_FILE_ID, tokenA)).status).toBe(200);

      const run = await waitForRun(
        expectedRunId(TENANT, 'code_contract', `file_id:${PDF_FILE_ID}`),
      );
      expect(run.status).toBe('completed');

      // The PDF's text layer flowed through the same derive-from-document executor: the DPA
      // classifies to a DIFFERENT contract_type than the NDA, so its retention policy is a
      // DIFFERENT catalog row (privacy-office/6y, not legal-ops/5y) — the match is not canned.
      const row = (await codedContracts()).find((r) => r.file_id === PDF_FILE_ID);
      expect(row).toMatchObject({
        contract_ref: PDF_FILE_ID,
        sha256: PDF_SHA,
        content_type: 'application/pdf',
        status: 'coded',
      });
      expect(row?.coded).toMatchObject({
        counterparty_name: 'Helios Cloud Services AG',
        contract_type: 'dpa',
        effective_date: '2026-06-15',
        term_months: 36,
        auto_renews: null,
        notice_period_days: null,
        governing_law: 'Ireland',
        total_value_cents: 5000000,
        retention_years: 6,
        review_owner: 'privacy-office',
      });
      // …and the detail view serves it.
      const detail = await server!.app.request(`/contracts/${PDF_FILE_ID}`, {
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(detail.status).toBe(200);
      expect(((await detail.json()) as Record<string, unknown>).coded).toMatchObject({
        contract_type: 'dpa',
        retention_years: 6,
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
      expect(await codedContracts()).toHaveLength(2);
    },
    60_000,
  );

  maybe(
    '(e) divergent post-seal upload → 409, sealed bytes untouched, runs unchanged',
    async () => {
      e2eTestsRan += 1;
      const up = await upload(
        TXT_FILE_ID,
        'Evil Corp and our company.\nEffective Date: 1999-01-01\n',
        {
          token: tokenA,
        },
      );
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
      const up = await upload(
        'b-contract',
        'B Corp and our company.\nEffective Date: 2026-01-01\n',
        {
          token: tokenB,
        },
      );
      expect(up.status).toBe(200);
      const sub = await submit('b-contract', tokenB);
      expect(sub.status).toBe(403);
      const body = (await sub.json()) as Record<string, unknown>;
      expect(body.error).toBe('file_event_rejected');
      expect(String(body.detail)).toContain('cross_tenant');
      await expectRunsQuiesced(2);
      expect(await codedContracts()).toHaveLength(2);
    },
    60_000,
  );

  maybe(
    '(j) a FILENAME-LESS upload (no x-file-name) codes + persists + serves END-TO-END',
    async () => {
      e2eTestsRan += 1;
      // The client filename is an OPTIONAL header: the pipeline must not be load-bearing on it.
      // The file event carries original_filename:null — the run must still complete and persist
      // (this product persists NO filename at all — the null-payload posture).
      const up = await upload(NONAME_FILE_ID, TXT_BODY, { token: tokenA });
      expect(up.status).toBe(200);
      expect((await submit(NONAME_FILE_ID, tokenA)).status).toBe(200);

      const run = await waitForRun(
        expectedRunId(TENANT, 'code_contract', `file_id:${NONAME_FILE_ID}`),
      );
      expect(run.error ?? undefined).toBeUndefined();
      expect(run.status).toBe('completed');
      await expectRunsQuiesced(3);

      const row = (await codedContracts()).find((r) => r.file_id === NONAME_FILE_ID);
      expect(row).toMatchObject({
        contract_ref: NONAME_FILE_ID,
        sha256: TXT_SHA,
        status: 'coded',
      });
      expect(row?.coded).toMatchObject({ contract_type: 'nda', retention_years: 5 });

      const detail = await server!.app.request(`/contracts/${NONAME_FILE_ID}`, {
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
      // The sentinel document makes the injected executor omit retention_years. WHICH LAYER REJECTS:
      // the agent node's own required_output_shape enforcement fires FIRST
      // (agent_output_shape_mismatch) — validation.check is the declared acceptance boundary
      // re-checking the SAME required_paths downstream (it would gate any artifact mutation between
      // agent and persist). Either way the invariant under test holds: the run is terminal and
      // NOTHING persists.
      const body = [
        'MUTUAL NON-DISCLOSURE AGREEMENT',
        'Broken Probe GmbH and our company.',
        'Effective Date: 2026-06-01',
        'X-Test-Omit: retention_years',
      ].join('\n');
      const up = await upload(BAD_FILE_ID, body, { token: tokenA });
      expect(up.status).toBe(200);
      expect((await submit(BAD_FILE_ID, tokenA)).status).toBe(200);

      const run = await waitForRun(
        expectedRunId(TENANT, 'code_contract', `file_id:${BAD_FILE_ID}`),
      );
      // RED-proven (the failure mode this arm guards against — a bad output completing + persisting
      // — was asserted first and failed: "expected 'terminal_failure' to be 'completed'").
      expect(run.status).toBe('terminal_failure');
      const err = JSON.stringify(run.error);
      expect(err).toContain('agent_output_shape_mismatch');
      expect(err).toContain("missing required path 'retention_years'");
      await expectRunsQuiesced(4);
      // The invariant: NOTHING persisted — no coded_contracts row for the rejected document.
      expect((await codedContracts()).some((r) => r.file_id === BAD_FILE_ID)).toBe(false);
    },
    150_000,
  );

  maybe(
    '(l) the list view PAGINATES: limit/offset pages + created_at-DESC ordering',
    async () => {
      e2eTestsRan += 1;
      // Three coded contracts exist by now (created in order: TXT, PDF, NONAME).
      const page1 = await server!.app.request('/contracts?limit=2', {
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(page1.status).toBe(200);
      const p1 = (await page1.json()) as { contracts: Array<Record<string, unknown>> };
      // RED-proven (limit-ignored was asserted first — "to have a length of 3 but got 2" — and the
      // cross-check below pins the created_at-DESC order).
      expect(p1.contracts).toHaveLength(2);
      expect(p1.contracts.map((c) => c.contract_ref)).toEqual([NONAME_FILE_ID, PDF_FILE_ID]);

      const page2 = await server!.app.request('/contracts?limit=2&offset=2', {
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(page2.status).toBe(200);
      const p2 = (await page2.json()) as { contracts: Array<Record<string, unknown>> };
      expect(p2.contracts.map((c) => c.contract_ref)).toEqual([TXT_FILE_ID]);
    },
    60_000,
  );

  maybe(
    "(m) cross-tenant READ isolation: tenant B's principal drives BOTH views — structurally EMPTY",
    async () => {
      e2eTestsRan += 1;
      const tokenB = await tokenFor(TENANT_B);
      const detail = await server!.app.request(`/contracts/${TXT_FILE_ID}`, {
        headers: { authorization: `Bearer ${tokenB}` },
      });
      expect(detail.status).toBe(200);
      // RED-proven (the leak — tenant B reading tenant A's coded contract — was asserted first and
      // failed with "expected null to be 'ctr-2026-001'"). The isolation is structural (TenantDb):
      // the view finds NO row for tenant B → the declared empty_200 ABSENT shape, never A's data.
      expect(await detail.json()).toEqual({
        contract_ref: TXT_FILE_ID,
        file_id: null,
        content_type: null,
        status: null,
        coded: null,
      });

      const list = await server!.app.request('/contracts', {
        headers: { authorization: `Bearer ${tokenB}` },
      });
      expect(list.status).toBe(200);
      expect(await list.json()).toEqual({ contracts: [] });
    },
    60_000,
  );
});

// The un-skippable ran-guard: fail loudly if a REQUIRED (CI / RAYSPEC_REQUIRE_DB_TESTS) run
// SKIPPED the e2e arms (a lost DATABASE_URL would otherwise read GREEN).
describe('Contract-Intake e2e — ran-guard (must not silently skip in CI)', () => {
  it('all 14 e2e arms actually ran when the DB was required', () => {
    if (dbRequired) expect(e2eTestsRan).toBe(14);
    else expect(dbRequired).toBe(false);
  });
});
