/**
 * The document-intake reference application, deployed from its bundle with the real built CLI on a
 * database of its own, with the deterministic extraction provider and no provider credential:
 *  - the plan needs no binding; the boot says the extraction provider is not for production;
 *  - the 50-document seed (40 plain-text, 10 text-layer PDF) uploads and submits; each document's
 *    durable workflow parses, extracts, validates and persists, and every record, hash and the
 *    inventory equal the seed manifest's;
 *  - retrying an upload and a submit replays them: no second row, no second run;
 *  - a document without a required field fails validation and persists nothing; hostile markup
 *    and instruction-like text persist as inert data; an unsupported type (415), an oversized
 *    declaration (413), a missing token (401) and another organization's reads are refused.
 *
 * Skips without DATABASE_URL; the ran-guard hard-fails a REQUIRED run that did not run.
 */
import { randomUUID } from 'node:crypto';
import { copyFileSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  call,
  cli,
  Deployment,
  EXAMPLES,
  inspectAndVerify,
  ownerWithOrg,
  PASSWORD,
  type ParsedJson,
  pack,
  removeScratch,
  type Served,
  SuiteDatabase,
  scratch,
  signingKeyPem,
} from './test-support/reference-apps.js';

const baseUrl = process.env.DATABASE_URL;
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
let armsRan = 0;

const APP = join(EXAMPLES, 'document-intake');
const PORT = 24_300 + (process.pid % 300);
const TENANT = randomUUID();

interface SeedDocument {
  file_id: string;
  file: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  expected: ParsedJson;
}
const MANIFEST = JSON.parse(readFileSync(join(APP, 'seed', 'manifest.json'), 'utf8')) as {
  inventory: Record<string, number>;
  documents: SeedDocument[];
};

describe.skipIf(!baseUrl)('document intake — deterministic extraction from the bundle', () => {
  const db = new SuiteDatabase(baseUrl ?? '', `rayspec_ref_document_intake_${process.pid}`);
  let pem = '';
  let deployment: Deployment;
  let served: Served | undefined;
  let bundle = '';
  let blobRoot = '';
  let token = '';

  function env(): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      DATABASE_URL: db.url,
      SHADOW_DATABASE_URL: process.env.SHADOW_DATABASE_URL ?? baseUrl ?? '',
      RAYSPEC_JWT_SIGNING_KEY: pem,
      RAYSPEC_API_KEY_PEPPER: 'document-intake-suite-pepper',
      ALLOWED_ORIGINS: '',
      RAYSPEC_PRODUCT_TENANT_ID: TENANT,
      RAYSPEC_BLOB_ROOT: blobRoot,
      RAYSPEC_EXTRACTION_MODE: 'deterministic',
    };
  }

  async function upload(fileId: string, bytes: Uint8Array, contentType: string, bearer = token) {
    const res = await fetch(`${deployment.base}/files/${fileId}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': contentType },
      body: bytes,
    });
    return { status: res.status, body: (await res.json()) as ParsedJson };
  }

  async function submit(fileId: string, bearer = token) {
    return call(`${deployment.base}/files/${fileId}/submit`, { token: bearer, method: 'POST' });
  }

  /** The workflow runs' statuses by file id, once none of `fileIds` is still running. */
  async function settled(fileIds: readonly string[]): Promise<Map<string, string>> {
    const keys = fileIds.map((id) => `file_id:${id}`);
    const deadline = Date.now() + 120_000;
    for (;;) {
      const rows = (await db.sql.unsafe(
        'SELECT idempotency_key, status FROM workflow_runs WHERE idempotency_key = ANY($1)',
        [keys],
      )) as unknown as { idempotency_key: string; status: string }[];
      const done = rows.filter((r) => r.status === 'completed' || r.status === 'terminal_failure');
      if (rows.length === keys.length && done.length === keys.length) {
        return new Map(rows.map((r) => [r.idempotency_key.slice('file_id:'.length), r.status]));
      }
      if (Date.now() > deadline) {
        throw new Error(`workflow runs did not settle: ${JSON.stringify(rows)}`);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  async function recordCount(): Promise<number> {
    const rows = await db.sql.unsafe('SELECT count(*)::int AS n FROM intake_records');
    return (rows[0] as { n: number }).n;
  }

  beforeAll(async () => {
    if (!baseUrl) return;
    await db.create();
    pem = await signingKeyPem();
    const dir = scratch('document-intake-deploy-');
    blobRoot = scratch('document-intake-blobs-');
    deployment = new Deployment(dir, PORT, env);
    // The organization and its owner's one-time invite, settled before anything is deployed.
    const inviteFile = join(scratch('document-intake-invite-'), 'owner.token');
    const ensured = cli(
      [
        'tenant',
        'ensure',
        '--org-id',
        TENANT,
        '--name',
        'Intake',
        '--owner-email',
        'owner@example.test',
        '--owner-invite-out',
        inviteFile,
      ],
      { env: env() },
    );
    expect(ensured.status, ensured.stderr).toBe(0);
    const output = join(scratch('document-intake-ray-'), 'document-intake.ray');
    pack(join(APP, 'document-intake.product.yaml'), output);
    bundle = join(dir, 'document-intake.ray');
    copyFileSync(output, bundle);
    inspectAndVerify(bundle);

    const plan = deployment.dryRun(bundle);
    expect(plan.plan.requiredBindings).toEqual([]);
    expect(plan.plan.blockers).toEqual([]);
    served = await deployment.serve(bundle, plan.planDigest);
    const accepted = await fetch(`${deployment.base}/v1/invites/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: readFileSync(inviteFile, 'utf8').trim(), password: PASSWORD }),
    });
    expect(accepted.status).toBe(201);
    token = ((await accepted.json()) as { accessToken: string }).accessToken;
  }, 240_000);

  afterAll(async () => {
    if (served) {
      const stopped = await deployment.stop(served).catch(() => undefined);
      if (stopped) {
        expect(stopped.stderr).toContain('RAYSPEC_EXTRACTION_MODE=deterministic');
        expect(stopped.stderr).toContain('not for production extraction');
      }
    }
    deployment?.kill();
    removeScratch();
    if (baseUrl) await db.drop();
  }, 60_000);

  it('processes the 50-document seed into exactly the records and inventory it records', async () => {
    for (const doc of MANIFEST.documents) {
      const bytes = readFileSync(join(APP, 'seed', doc.file));
      const uploaded = await upload(doc.file_id, bytes, doc.content_type);
      expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(200);
      expect(uploaded.body).toMatchObject({ sha256: doc.sha256, size_bytes: doc.size_bytes });
      const submitted = await submit(doc.file_id);
      expect(submitted.status, submitted.text).toBe(200);
    }
    const statuses = await settled(MANIFEST.documents.map((d) => d.file_id));
    expect([...statuses.values()].every((s) => s === 'completed')).toBe(true);

    const served: ParsedJson[] = [];
    for (const doc of MANIFEST.documents) {
      const res = await call(`${deployment.base}/records/${doc.file_id}`, { token });
      expect(res.status).toBe(200);
      expect(res.body, doc.file_id).toEqual({
        document_ref: doc.file_id,
        sha256: doc.sha256,
        content_type: doc.content_type,
        status: 'processed',
        record: doc.expected,
      });
      served.push(res.body.record);
    }
    // The inventory, recomputed from what the deployment serves.
    expect({
      documents: served.length,
      total_quantity: served.reduce((s, r) => s + (r.quantity as number), 0),
      total_lines: served.reduce((s, r) => s + (r.lines as unknown[]).length, 0),
      without_category: served.filter((r) => r.category === null).length,
      without_received_on: served.filter((r) => r.received_on === null).length,
    }).toEqual({
      documents: MANIFEST.inventory.documents,
      total_quantity: MANIFEST.inventory.total_quantity,
      total_lines: MANIFEST.inventory.total_lines,
      without_category: MANIFEST.inventory.without_category,
      without_received_on: MANIFEST.inventory.without_received_on,
    });
    const list = await call(`${deployment.base}/records?limit=100`, { token });
    expect(list.status).toBe(200);
    expect((list.body.records as unknown[]).length).toBe(50);
    expect(await recordCount()).toBe(50);
    armsRan += 1;
  }, 300_000);

  it('replays a retried upload and a retried submit: no second row, no second run', async () => {
    const doc = MANIFEST.documents[0]!;
    const bytes = readFileSync(join(APP, 'seed', doc.file));
    const again = await upload(doc.file_id, bytes, doc.content_type);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ deduped: true, sha256: doc.sha256 });
    const resubmitted = await submit(doc.file_id);
    expect(resubmitted.status).toBe(200);
    expect(resubmitted.body.deduped).toBe(true);
    // Different bytes under a sealed file id are a conflict, and change nothing.
    const divergent = await upload(
      doc.file_id,
      new TextEncoder().encode('Title: x\n'),
      'text/plain',
    );
    expect(divergent.status).toBe(409);
    await new Promise((r) => setTimeout(r, 1_000));
    const runs = await db.sql.unsafe(
      'SELECT count(*)::int AS n FROM workflow_runs WHERE idempotency_key = $1',
      [`file_id:${doc.file_id}`],
    );
    expect((runs[0] as { n: number }).n).toBe(1);
    expect(await recordCount()).toBe(50);
    armsRan += 1;
  }, 120_000);

  it('persists nothing for a document that fails validation, and hostile text only as data', async () => {
    const missing = readFileSync(join(APP, 'fixtures', 'missing-quantity.txt'));
    const hostile = readFileSync(join(APP, 'fixtures', 'markup-and-instructions.txt'));
    expect(missing.toString('utf8')).not.toMatch(/^Quantity:/m);
    for (const [id, bytes] of [
      ['bad-missing', missing],
      ['bad-hostile', hostile],
    ] as const) {
      expect((await upload(id, bytes, 'text/plain')).status).toBe(200);
      expect((await submit(id)).status).toBe(200);
    }
    const statuses = await settled(['bad-missing', 'bad-hostile']);
    expect(statuses.get('bad-missing')).toBe('terminal_failure');
    expect(statuses.get('bad-hostile')).toBe('completed');
    // It failed at the declared output shape, for the field the document does not state.
    const failure = await db.sql.unsafe(
      'SELECT error::text AS error FROM workflow_runs WHERE idempotency_key = $1',
      ['file_id:bad-missing'],
    );
    expect((failure[0] as { error: string }).error).toContain('agent_output_shape_mismatch');
    expect((failure[0] as { error: string }).error).toContain('quantity');
    const absent = await call(`${deployment.base}/records/bad-missing`, { token });
    expect(absent.body).toMatchObject({ document_ref: 'bad-missing', record: null, status: null });
    const inert = await call(`${deployment.base}/records/bad-hostile`, { token });
    expect(inert.headers.get('content-type')).toContain('application/json');
    expect(inert.body.record).toEqual({
      reference: 'REF-9002',
      title: '<script>alert(1)</script> & "quotes"',
      category: null,
      quantity: 3,
      received_on: null,
      lines: [{ description: '<img src=x onerror=alert(1)>', count: 1 }],
    });
    expect(await recordCount()).toBe(51);
    armsRan += 1;
  }, 180_000);

  it('refuses an unsupported type, an oversized declaration, no token and another organization', async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const unsupported = await upload('bad-type', png, 'image/png');
    expect(unsupported.status).toBe(415);

    // A declared length over the 25 MiB cap is refused before a byte of the body is read.
    const tooLarge = await new Promise<number>((resolve, reject) => {
      const req = request(
        `${deployment.base}/files/bad-size`,
        {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'text/plain',
            'content-length': String(25 * 1024 * 1024 + 1),
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
          req.destroy();
        },
      );
      req.on('error', reject);
      req.write('Title: only the start of a body\n');
    });
    expect(tooLarge).toBe(413);

    expect((await call(`${deployment.base}/records`)).status).toBe(401);
    expect((await call(`${deployment.base}/files/doc-001/submit`, { method: 'POST' })).status).toBe(
      401,
    );
    const outsider = await ownerWithOrg(deployment.base, 'outsider@example.test', 'Elsewhere');
    const foreignList = await call(`${deployment.base}/records`, { token: outsider.token });
    expect(foreignList.status).toBe(200);
    expect(foreignList.body.records).toEqual([]);
    const foreignRead = await call(`${deployment.base}/records/doc-001`, { token: outsider.token });
    expect(foreignRead.body.record).toBeNull();

    const stored = await db.sql.unsafe(
      "SELECT count(*)::int AS n FROM file_uploads WHERE file_ref LIKE '%:bad-type' OR file_ref LIKE '%:bad-size'",
    );
    expect((stored[0] as { n: number }).n).toBe(0);
    expect(await recordCount()).toBe(51);
    armsRan += 1;
  }, 120_000);
});

// The un-skippable ran-guard: a REQUIRED DB run that silently skipped is a false green.
it('document-intake DB-backed arms actually ran when the environment requires them', () => {
  if (dbRequired) expect(armsRan).toBe(4);
  else expect(true).toBe(true);
});
