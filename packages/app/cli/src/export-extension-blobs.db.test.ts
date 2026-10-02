/**
 * `rayspec export` of an application that loads extensions, on GROUND TRUTH: the real built CLI in
 * child processes, each application packed with its extension and deployed by
 * `rayspec deploy <file.ray>` on a database of its own, its runtime stopped before the export
 * (`--source-stopped`).
 *
 * The export decides where the blobs are from what the boot recorded
 * (`runtime_control_state.blob_backend`), never by loading the extension itself:
 *  - an extension that contributes a stream route and no blob backend: the boot records the
 *    platform's fs store; a redeploy of the same bundle writes the record again; the export refuses
 *    without RAYSPEC_BLOB_ROOT (the base document declares no stream route, so only the record
 *    knows the deployment keeps blobs), refuses when the record is missing or belongs to another
 *    version, and with the root set exports the rows and the uploaded object;
 *  - an extension that provides its own blob backend: the boot records it by id, and the export
 *    refuses before it fences anything (`RAY_EXTERNAL_STATE_UNSUPPORTED`,
 *    `unsupported-blob-adapter`), naming the extension, and writes nothing.
 *
 * `pg_dump`: the host's when its major is the server's, else the pinned postgres image through
 * docker (test-support/pg-tools.ts). Skips without DATABASE_URL; a REQUIRED run (CI,
 * RAYSPEC_REQUIRE_DB_TESTS) fails instead, and the ran-guard fails a required run whose arms did
 * not all run.
 */
import { copyFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateX25519Identity, identityToRecipient } from 'age-encryption';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeTree } from '../../../kernel/bundle-closure/src/test-support/app.js';
import { pgToolPath } from './test-support/pg-tools.js';
import {
  call,
  cli,
  Deployment,
  ownerWithOrg,
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
if (dbRequired && !baseUrl) {
  throw new Error(
    'export-extension-blobs.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) ' +
      'but absent — refusing to silently skip this DB-backed suite.',
  );
}
let armsRan = 0;
const ARMS = 3;
const PORT = 24_900 + (process.pid % 90);

/** An extension that contributes an upload route and its handler; `capabilities` is added as is. */
function extensionTree(id: string, capabilities: string): Record<string, string> {
  const dir = `packs/${id.replace(/_/g, '-')}`;
  return {
    'package.json': JSON.stringify({ name: 'probe', private: true, type: 'module' }),
    [`${dir}/package.json`]: JSON.stringify({
      name: id.replace(/_/g, '-'),
      version: '1.0.0',
      private: true,
      type: 'module',
      main: './index.js',
      dependencies: { '@rayspec/platform': '^1.8.0' },
    }),
    [`${dir}/index.js`]:
      "import { defineExtension } from '@rayspec/platform';\n" +
      `${capabilities === '' ? '' : `${MEMORY_BLOBS}\n`}` +
      'export default defineExtension({\n' +
      "  version: '1.0.0',\n" +
      '  fragments: {\n' +
      "    handlers: [{ id: 'ingest', module: 'handlers/ingest.js', export: 'ingest', kind: 'route', uses: ['blob'] }],\n" +
      "    api: [{ method: 'POST', path: '/uploads/{upload_id}', action: { kind: 'stream', handler: 'ingest', mode: 'ingest' } }],\n" +
      '  },\n' +
      `${capabilities}` +
      '});\n',
    [`${dir}/handlers/ingest.js`]:
      'export async function ingest(init) {\n' +
      '  const bytes = new Uint8Array(await init.request.arrayBuffer());\n' +
      "  await init.blob.put('uploads/' + init.params.upload_id, bytes);\n" +
      "  return new Response(JSON.stringify({ stored: bytes.length }), { status: 200, headers: { 'content-type': 'application/json' } });\n" +
      '}\n',
    'rayspec.yaml':
      "version: '1.0'\n" +
      `metadata:\n  name: probe\n  id: probe-${id.replace(/_/g, '-')}\n  version: '1.0.0'\n` +
      'stores:\n  - name: ext_notes\n    columns:\n      - { name: body, type: text }\n' +
      'api:\n' +
      "  - { method: POST, path: '/notes', action: { kind: store, store: ext_notes, op: create } }\n" +
      `extensions:\n  - { id: ${id}, module: ./${dir}, version: 1.0.0 }\n`,
  };
}

/** A blob backend held in memory: enough for the boot to build on, never read by the export. */
const MEMORY_BLOBS = `const objects = new Map();
function memoryBlobs(tenantId) {
  const k = (key) => tenantId + '/' + key;
  const missing = (key) => ({ notFound: true, key });
  return {
    async put(key, body) { objects.set(k(key), body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer())); },
    async get(key) { const b = objects.get(k(key)); return b === undefined ? missing(key) : { body: new Response(b).body, contentLength: b.length }; },
    async createReadStream(key) { const b = objects.get(k(key)); return b === undefined ? missing(key) : new Response(b).body; },
    async stat(key) { const b = objects.get(k(key)); return b === undefined ? missing(key) : { len: b.length, etagSource: String(b.length) }; },
    async delete(key) { objects.delete(k(key)); },
    async deleteTenant(id) { if (id !== tenantId) throw new Error('another tenant'); for (const key of [...objects.keys()]) if (key.startsWith(tenantId + '/')) objects.delete(key); },
  };
}`;

describe.skipIf(!baseUrl)('rayspec export — applications that load extensions', () => {
  let pem = '';
  let pgDump = '';
  let recipient = '';

  /** One application: its database, deployment, blob root and packed bundle. */
  class App {
    readonly db: SuiteDatabase;
    readonly deployment: Deployment;
    readonly blobRoot: string;
    bundle = '';
    served: Served | undefined;

    constructor(
      readonly id: string,
      readonly capabilities: string,
      port: number,
    ) {
      this.db = new SuiteDatabase(baseUrl ?? '', `rayspec_export_ext_${id}_${process.pid}`);
      this.blobRoot = scratch(`export-ext-blobs-${id}-`);
      this.deployment = new Deployment(scratch(`export-ext-deploy-${id}-`), port, () => this.env());
    }

    env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
      return {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        DATABASE_URL: this.db.url,
        SHADOW_DATABASE_URL: process.env.SHADOW_DATABASE_URL ?? baseUrl ?? '',
        RAYSPEC_JWT_SIGNING_KEY: pem,
        RAYSPEC_API_KEY_PEPPER: 'export-extension-suite-pepper',
        RAYSPEC_BLOB_ROOT: this.blobRoot,
        RAYSPEC_PG_DUMP: pgDump,
        ALLOWED_ORIGINS: '',
        ...extra,
      };
    }

    async create(): Promise<void> {
      await this.db.create();
      const source = scratch(`export-ext-app-${this.id}-`);
      writeTree(source, extensionTree(this.id, this.capabilities));
      const output = join(source, 'app.ray');
      pack(join(source, 'rayspec.yaml'), output);
      this.bundle = join(this.deployment.dir, 'app.ray');
      copyFileSync(output, this.bundle);
    }

    async deploy(): Promise<void> {
      const plan = this.deployment.dryRun(this.bundle);
      expect(plan.plan.blockers, JSON.stringify(plan.plan.blockers)).toEqual([]);
      this.served = await this.deployment.serve(this.bundle, plan.planDigest as string);
    }

    async stop(): Promise<void> {
      if (this.served !== undefined) await this.deployment.stop(this.served);
      this.served = undefined;
    }

    async recorded(): Promise<{ digest: string | null; backend: unknown; fence: string }> {
      const [row] = (await this.db.sql.unsafe(
        `SELECT application_digest AS digest, blob_backend AS backend, fence_state AS fence
           FROM runtime_control_state WHERE id = 1`,
      )) as unknown as { digest: string | null; backend: unknown; fence: string }[];
      if (row === undefined) throw new Error('no runtime_control_state row');
      return row;
    }

    deploymentId(): string {
      return (
        JSON.parse(readFileSync(join(this.deployment.stateDir, 'deployment.json'), 'utf8')) as {
          deploymentId: string;
        }
      ).deploymentId;
    }

    export(output: string, extra: NodeJS.ProcessEnv = {}) {
      return cli(
        [
          'export',
          '--deployment',
          this.deploymentId(),
          '--recipient',
          recipient,
          '--output',
          output,
          '--run-history',
          'included',
          '--confirm-quiesce',
          '--source-stopped',
          '--state-dir',
          this.deployment.stateDir,
          '--json',
        ],
        { env: this.env(extra), cwd: this.deployment.dir },
      );
    }
  }

  let files: App;
  let vault: App;

  beforeAll(async () => {
    if (!baseUrl) return;
    pem = await signingKeyPem();
    recipient = await identityToRecipient(await generateX25519Identity());
    files = new App('files_pack', '', PORT);
    vault = new App('vault_pack', '  capabilities: { blobFactory: memoryBlobs },\n', PORT + 100);
    await files.create();
    await vault.create();
    const [{ major }] = (await files.db.sql.unsafe(
      "SELECT current_setting('server_version_num')::int / 10000 AS major",
    )) as unknown as [{ major: number }];
    pgDump = pgToolPath('pg_dump', major, scratch('export-ext-tools-')).path;
  }, 240_000);

  afterAll(async () => {
    for (const app of [files, vault]) {
      if (app === undefined) continue;
      await app.stop().catch(() => undefined);
      app.deployment.kill();
      if (baseUrl) await app.db.drop();
    }
    removeScratch();
    if (dbRequired) expect(armsRan, 'every arm of the suite ran').toBe(ARMS);
  }, 60_000);

  it('records the fs store for an extension that provides no blob backend, on every deploy', async () => {
    await files.deploy();
    expect(await files.recorded()).toMatchObject({
      digest: files.deployment.active(),
      backend: { kind: 'fs' },
    });
    const base = files.deployment.base;
    const owner = await ownerWithOrg(base, 'owner@example.test', 'Files');
    const note = await call(`${base}/notes`, {
      token: owner.token,
      method: 'POST',
      body: { body: 'kept by the export' },
    });
    expect(note.status, note.text).toBe(201);
    const upload = await fetch(`${base}/uploads/first`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${owner.token}`,
        'content-type': 'application/octet-stream',
      },
      body: new Uint8Array([1, 2, 3, 4, 5]),
    });
    expect(upload.status, await upload.clone().text()).toBe(200);
    // The upload went through the platform's fs store, under the organization's prefix.
    expect(readdirSync(join(files.blobRoot, owner.orgId), { recursive: true })).toContain(
      join('uploads', 'first'),
    );
    await files.stop();

    // A redeploy of the same bundle writes the record again.
    await files.db.sql.unsafe('UPDATE runtime_control_state SET blob_backend = NULL WHERE id = 1');
    await files.deploy();
    expect((await files.recorded()).backend).toEqual({ kind: 'fs' });
    await files.stop();
    armsRan += 1;
  }, 300_000);

  it('exports it only from a record of the active version, and with the blob root', async () => {
    const output = join(files.deployment.dir, 'refused.migration.ray');
    const refusals: [string, () => Promise<unknown>, NodeJS.ProcessEnv, string][] = [
      [
        'no record',
        () =>
          files.db.sql.unsafe('UPDATE runtime_control_state SET blob_backend = NULL WHERE id = 1'),
        {},
        'RAY_EXTERNAL_STATE_UNSUPPORTED/unsupported-blob-adapter',
      ],
      [
        'a record of another version',
        () =>
          files.db.sql.unsafe(
            `UPDATE runtime_control_state SET blob_backend = '{"kind":"fs"}'::jsonb,
                    application_digest = $1 WHERE id = 1`,
            ['f'.repeat(64)],
          ),
        {},
        'RAY_EXTERNAL_STATE_UNSUPPORTED/unsupported-blob-adapter',
      ],
      [
        'no blob root',
        () =>
          files.db.sql.unsafe(
            'UPDATE runtime_control_state SET application_digest = $1 WHERE id = 1',
            [files.deployment.active()],
          ),
        { RAYSPEC_BLOB_ROOT: '' },
        'RAY_USAGE/',
      ],
    ];
    for (const [what, arrange, extra, expected] of refusals) {
      await arrange();
      const run = files.export(output, extra);
      const first = run.envelope.errors?.[0] as ParsedJson | undefined;
      expect(`${first?.code}/${first?.reason ?? ''}`, `${what}: ${run.stderr}`).toBe(expected);
      expect(existsSync(output), what).toBe(false);
      expect((await files.recorded()).fence, what).toBe('open');
      if (expected === 'RAY_USAGE/') expect(first?.message).toContain('RAYSPEC_BLOB_ROOT');
    }
    // The record of the active version and the blob root: the export carries the row and the object.
    expect(await files.recorded()).toMatchObject({
      digest: files.deployment.active(),
      backend: { kind: 'fs' },
    });
    const exported = join(files.deployment.dir, 'files.migration.ray');
    // A stopped source has no session but the export's own: close the suite's for the export.
    await files.db.sql.end();
    const run = files.export(exported);
    files.db.sql = postgres(files.db.url, { max: 2, onnotice: () => {} });
    expect(run.status, `${run.stderr}\n${JSON.stringify(run.envelope.errors)}`).toBe(0);
    expect(run.envelope.data).toMatchObject({ sourceState: 'fenced' });
    expect(existsSync(exported)).toBe(true);
    // The local receipt counts what the snapshot carries: the note and the one uploaded object.
    const receipt = JSON.parse(
      readFileSync(
        join(files.deployment.stateDir, 'receipts', `export-${run.envelope.operationId}.json`),
        'utf8',
      ),
    ) as { summary: { objectCount: number; rows: { application: number } } };
    expect(receipt.summary.objectCount).toBe(1);
    expect(receipt.summary.rows.application).toBeGreaterThan(0);
    armsRan += 1;
  }, 300_000);

  it('refuses an extension that provides its own blob backend, naming it, before any fence', async () => {
    await vault.deploy();
    expect(await vault.recorded()).toMatchObject({
      digest: vault.deployment.active(),
      backend: { kind: 'extension', extension: 'vault_pack' },
    });
    const base = vault.deployment.base;
    const owner = await ownerWithOrg(base, 'owner@example.test', 'Vault');
    const upload = await fetch(`${base}/uploads/first`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${owner.token}`,
        'content-type': 'application/octet-stream',
      },
      body: new Uint8Array([9, 8, 7]),
    });
    expect(upload.status, await upload.clone().text()).toBe(200);
    // The bytes went to the extension's backend: the fs blob root holds nothing.
    expect(readdirSync(vault.blobRoot)).toEqual([]);
    await vault.stop();

    const output = join(vault.deployment.dir, 'vault.migration.ray');
    const run = vault.export(output);
    expect(run.status, run.stderr).toBe(3);
    const first = run.envelope.errors?.[0] as ParsedJson;
    expect(first).toMatchObject({
      code: 'RAY_EXTERNAL_STATE_UNSUPPORTED',
      reason: 'unsupported-blob-adapter',
    });
    expect(first.message).toContain("'vault_pack'");
    expect(existsSync(output)).toBe(false);
    expect((await vault.recorded()).fence).toBe('open');
    expect(existsSync(join(vault.deployment.stateDir, 'scratch'))).toBe(false);
    armsRan += 1;
  }, 300_000);
});
