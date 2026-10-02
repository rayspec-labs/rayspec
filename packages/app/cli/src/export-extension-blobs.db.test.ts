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
 *    knows the deployment keeps blobs), refuses when the record is missing, when the database
 *    predates the column, or when the record belongs to another version, and with the root set
 *    exports the rows and the uploaded object, which an import restores byte for byte;
 *  - an extension that provides its own blob backend: the boot records it by id, and the export
 *    refuses before it fences anything (`RAY_EXTERNAL_STATE_UNSUPPORTED`,
 *    `unsupported-blob-adapter`), naming the extension, and writes nothing;
 *  - a deploy that activates such a version while the export waits for its confirmation: the
 *    capture under the fence refuses (`RAY_SOURCE_NOT_QUIESCENT`) instead of exporting the new
 *    version with the blob source decided for the old one.
 *
 * Every extension module writes a marker file when it is loaded with RAYSPEC_EXPORT_SUITE_MARKER
 * set; only the export processes get that variable, and no export leaves the marker, so the export
 * never loads extension code. A boot with the variable set shows that loading the module does write
 * it.
 *
 * `pg_dump`: the host's when its major is the server's, else the pinned postgres image through
 * docker (test-support/pg-tools.ts). Skips without DATABASE_URL; a REQUIRED run (CI,
 * RAYSPEC_REQUIRE_DB_TESTS) fails instead, and the ran-guard fails a required run whose arms did
 * not all run.
 */
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { generateX25519Identity, identityToRecipient } from 'age-encryption';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeTree } from '../../../kernel/bundle-closure/src/test-support/app.js';
import { runExport } from './export.js';
import { asAdmin, type LaneRoles, prepareRoleDatabases } from './test-support/migration-source.js';
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
const ARMS = 5;
/** The variable only the export processes get; an extension module loaded with it writes a marker. */
const MARKER = 'RAYSPEC_EXPORT_SUITE_MARKER';
const PORT = 24_900 + (process.pid % 90);

/**
 * An extension that contributes an upload route and its handler; `capabilities` is added as is. Its
 * module writes a marker file when it is loaded with `MARKER` set.
 */
function extensionTree(
  id: string,
  capabilities: string,
  version = '1.0.0',
): Record<string, string> {
  const dir = `packs/${id.replace(/_/g, '-')}`;
  return {
    'package.json': JSON.stringify({ name: 'probe', private: true, type: 'module' }),
    [`${dir}/package.json`]: JSON.stringify({
      name: id.replace(/_/g, '-'),
      version,
      private: true,
      type: 'module',
      main: './index.js',
      dependencies: { '@rayspec/platform': '^1.8.0' },
    }),
    [`${dir}/index.js`]:
      "import { writeFileSync } from 'node:fs';\n" +
      "import { defineExtension } from '@rayspec/platform';\n" +
      `const marker = process.env.${MARKER};\n` +
      "if (marker) writeFileSync(marker, 'the extension module was loaded');\n" +
      `${capabilities === '' ? '' : `${MEMORY_BLOBS}\n`}` +
      'export default defineExtension({\n' +
      `  version: '${version}',\n` +
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
      `metadata:\n  name: probe\n  id: probe-${id.replace(/_/g, '-')}\n  version: '${version}'\n` +
      'stores:\n  - name: ext_notes\n    columns:\n      - { name: body, type: text }\n' +
      'api:\n' +
      "  - { method: POST, path: '/notes', action: { kind: store, store: ext_notes, op: create } }\n" +
      `extensions:\n  - { id: ${id}, module: ./${dir}, version: ${version} }\n`,
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
  let pgRestore = '';
  let identity = '';
  let recipient = '';
  /** Where an extension module loaded with `MARKER` set writes; no export may leave it. */
  let marker = '';

  /** One application: its database, deployment, blob root and packed bundle. */
  class App {
    readonly db: SuiteDatabase;
    readonly deployment: Deployment;
    readonly blobRoot: string;
    bundle = '';
    served: Served | undefined;
    /** Added to the environment of the deployment's boots. */
    bootEnv: NodeJS.ProcessEnv = {};

    constructor(
      readonly id: string,
      readonly capabilities: string,
      port: number,
    ) {
      this.db = new SuiteDatabase(baseUrl ?? '', `rayspec_export_ext_${id}_${process.pid}`);
      this.blobRoot = scratch(`export-ext-blobs-${id}-`);
      this.deployment = new Deployment(scratch(`export-ext-deploy-${id}-`), port, () =>
        this.env(this.bootEnv),
      );
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
      this.bundle = this.packed(this.capabilities, '1.0.0');
    }

    /** The application at `version`, its extension with `capabilities`, packed beside the deployment. */
    packed(capabilities: string, version: string): string {
      const source = scratch(`export-ext-app-${this.id}-`);
      writeTree(source, extensionTree(this.id, capabilities, version));
      const output = join(source, 'app.ray');
      pack(join(source, 'rayspec.yaml'), output);
      const bundle = join(this.deployment.dir, `app-${version}.ray`);
      copyFileSync(output, bundle);
      return bundle;
    }

    async deploy(bundle = this.bundle): Promise<void> {
      const plan = this.deployment.dryRun(bundle);
      expect(plan.plan.blockers, JSON.stringify(plan.plan.blockers)).toEqual([]);
      this.served = await this.deployment.serve(bundle, plan.planDigest as string);
    }

    async stop(): Promise<void> {
      if (this.served !== undefined) await this.deployment.stop(this.served);
      this.served = undefined;
    }

    async fence(): Promise<string | undefined> {
      const [row] = (await this.db.sql.unsafe(
        'SELECT fence_state AS fence FROM runtime_control_state WHERE id = 1',
      )) as unknown as { fence: string }[];
      return row?.fence;
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

    exportArgs(output: string, confirm = true): string[] {
      return [
        '--deployment',
        this.deploymentId(),
        '--recipient',
        recipient,
        '--output',
        output,
        '--run-history',
        'included',
        ...(confirm ? ['--confirm-quiesce'] : []),
        '--source-stopped',
        '--state-dir',
        this.deployment.stateDir,
      ];
    }

    /** The export, as its own process with `MARKER` set; it must not leave the marker. */
    export(output: string, extra: NodeJS.ProcessEnv = {}) {
      const run = cli(['export', ...this.exportArgs(output), '--json'], {
        env: this.env({ [MARKER]: marker, ...extra }),
        cwd: this.deployment.dir,
      });
      expect(existsSync(marker), 'the export loaded an extension module').toBe(false);
      return run;
    }
  }

  let files: App;
  let vault: App;
  let swap: App;
  /**
   * The object arm 1 uploads: its bytes, and the file the fs store keeps them in (its metadata, then
   * the bytes) as its path below the blob root and its content.
   */
  const uploaded = {
    bytes: new Uint8Array([1, 2, 3, 4, 5]),
    path: '',
    stored: new Uint8Array(),
  };
  let exportedFiles = '';

  beforeAll(async () => {
    if (!baseUrl) return;
    pem = await signingKeyPem();
    identity = await generateX25519Identity();
    recipient = await identityToRecipient(identity);
    marker = join(scratch('export-ext-marker-'), 'loaded');
    files = new App('files_pack', '', PORT);
    vault = new App('vault_pack', '  capabilities: { blobFactory: memoryBlobs },\n', PORT + 100);
    swap = new App('swap_pack', '', PORT + 200);
    await files.create();
    await vault.create();
    await swap.create();
    const [{ major }] = (await files.db.sql.unsafe(
      "SELECT current_setting('server_version_num')::int / 10000 AS major",
    )) as unknown as [{ major: number }];
    const tools = scratch('export-ext-tools-');
    pgDump = pgToolPath('pg_dump', major, tools).path;
    pgRestore = pgToolPath('pg_restore', major, tools).path;
  }, 240_000);

  afterAll(async () => {
    for (const app of [files, vault, swap]) {
      if (app === undefined) continue;
      await app.stop().catch(() => undefined);
      app.deployment.kill();
      if (baseUrl) await app.db.drop();
    }
    removeScratch();
    if (dbRequired) expect(armsRan, 'every arm of the suite ran').toBe(ARMS);
  }, 60_000);

  it('records the fs store for an extension that provides no blob backend, on every deploy', async () => {
    // A boot with the marker variable set loads the module, which writes the marker: the check every
    // export makes is not vacuous.
    files.bootEnv = { [MARKER]: marker };
    await files.deploy();
    files.bootEnv = {};
    expect(existsSync(marker), 'a boot loads the extension module').toBe(true);
    rmSync(marker);
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
      body: uploaded.bytes,
    });
    expect(upload.status, await upload.clone().text()).toBe(200);
    // The upload went through the platform's fs store, under the organization's prefix.
    const stored = readdirSync(files.blobRoot, { recursive: true })
      .map(String)
      .filter((p) => p.startsWith(owner.orgId) && p.endsWith(join('uploads', 'first')));
    expect(stored).toHaveLength(1);
    uploaded.path = stored[0] ?? '';
    uploaded.stored = new Uint8Array(readFileSync(join(files.blobRoot, uploaded.path)));
    expect(uploaded.stored.subarray(-uploaded.bytes.length)).toEqual(uploaded.bytes);
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
    const column = async () =>
      (
        (await files.db.sql.unsafe(
          `SELECT count(*)::int AS n FROM information_schema.columns
            WHERE table_name = 'runtime_control_state' AND column_name = 'blob_backend'`,
        )) as unknown as { n: number }[]
      )[0]?.n;
    const redeploy = 'Deploy the active bundle once with this runtime';
    const refusals: [string, () => Promise<unknown>, NodeJS.ProcessEnv, string, string][] = [
      [
        'no record',
        () =>
          files.db.sql.unsafe('UPDATE runtime_control_state SET blob_backend = NULL WHERE id = 1'),
        {},
        'RAY_EXTERNAL_STATE_UNSUPPORTED/unsupported-blob-adapter',
        redeploy,
      ],
      [
        'a database from before the column',
        async () => {
          await files.db.sql.unsafe('ALTER TABLE runtime_control_state DROP COLUMN blob_backend');
          expect(await column(), 'the column is gone').toBe(0);
        },
        {},
        'RAY_EXTERNAL_STATE_UNSUPPORTED/unsupported-blob-adapter',
        redeploy,
      ],
      [
        'a record of another version',
        async () => {
          await files.db.sql.unsafe(
            'ALTER TABLE runtime_control_state ADD COLUMN blob_backend jsonb',
          );
          expect(await column(), 'the column is back').toBe(1);
          await files.db.sql.unsafe(
            `UPDATE runtime_control_state SET blob_backend = '{"kind":"fs"}'::jsonb,
                    application_digest = $1 WHERE id = 1`,
            ['f'.repeat(64)],
          );
        },
        {},
        'RAY_EXTERNAL_STATE_UNSUPPORTED/unsupported-blob-adapter',
        redeploy,
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
        'RAYSPEC_BLOB_ROOT',
      ],
    ];
    for (const [what, arrange, extra, expected, says] of refusals) {
      await arrange();
      const run = files.export(output, extra);
      const first = run.envelope.errors?.[0] as ParsedJson | undefined;
      expect(`${first?.code}/${first?.reason ?? ''}`, `${what}: ${run.stderr}`).toBe(expected);
      expect(first?.message, what).toContain(says);
      // Only an extension's own backend is refused as such; a missing record says so instead.
      expect(first?.message, what).not.toContain('provides the blob backend');
      expect(existsSync(output), what).toBe(false);
      expect(await files.fence(), what).toBe('open');
    }
    // The record of the active version and the blob root: the export carries the row and the object.
    expect(await files.recorded()).toMatchObject({
      digest: files.deployment.active(),
      backend: { kind: 'fs' },
    });
    exportedFiles = join(files.deployment.dir, 'files.migration.ray');
    // A stopped source has no session but the export's own: close the suite's for the export.
    await files.db.sql.end();
    const run = files.export(exportedFiles);
    files.db.sql = postgres(files.db.url, { max: 2, onnotice: () => {} });
    expect(run.status, `${run.stderr}\n${JSON.stringify(run.envelope.errors)}`).toBe(0);
    expect(run.envelope.data).toMatchObject({ sourceState: 'fenced' });
    expect(existsSync(exportedFiles)).toBe(true);
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

  it('imports that export, the uploaded object byte for byte', async () => {
    expect(exportedFiles, 'the export arm wrote the migration bundle').not.toBe('');
    const name = `rayspec_export_ext_target_${process.pid}`;
    const target = await prepareRoleDatabases(baseUrl ?? '', name, `${name}_dbos_sys`);
    try {
      const dir = scratch('export-ext-target-');
      const blobRoot = join(dir, 'blobs');
      const identityFile = join(dir, 'identity.txt');
      writeFileSync(identityFile, `${identity}\n`, { mode: 0o600 });
      chmodSync(identityFile, 0o600);
      const roles: LaneRoles = target.roles;
      const run = cli(
        [
          'import',
          exportedFiles,
          '--target',
          join(dir, 'state'),
          '--identity-file',
          identityFile,
          '--secrets-out',
          join(dir, 'secrets'),
          '--json',
        ],
        {
          env: {
            PATH: process.env.PATH ?? '',
            HOME: process.env.HOME ?? '',
            DATABASE_URL: roles.app.runtime,
            RAYSPEC_MIGRATION_DATABASE_URL: roles.app.migration,
            DBOS_SYSTEM_DATABASE_URL: roles.sys.runtime,
            RAYSPEC_BLOB_ROOT: blobRoot,
            RAYSPEC_PG_RESTORE: pgRestore,
            [MARKER]: marker,
          },
          cwd: dir,
        },
      );
      expect(run.status, `${run.stderr}\n${JSON.stringify(run.envelope.errors)}`).toBe(0);
      expect(run.envelope.data).toMatchObject({
        status: 'ready-for-cutover',
        verification: { objects: 'match', tableCounts: 'match', checksums: 'match' },
      });
      expect(uploaded.path, 'the upload arm found the object').not.toBe('');
      expect(new Uint8Array(readFileSync(join(blobRoot, uploaded.path)))).toEqual(uploaded.stored);
      const [note] = (await asAdmin(baseUrl ?? '', name, (sql) =>
        sql.unsafe('SELECT body FROM ext_notes'),
      )) as unknown as { body: string }[];
      expect(note?.body).toBe('kept by the export');
    } finally {
      await asAdmin(baseUrl ?? '', 'postgres', async (sql) => {
        for (const db of [name, `${name}_dbos_sys`]) {
          await sql.unsafe(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
        }
      }).catch(() => {});
      await target.lane.drop().catch(() => {});
    }
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
    expect(first.message).toContain("the extension 'vault_pack' provides the blob backend");
    expect(first.message).not.toContain('Deploy the active bundle once');
    expect(existsSync(output)).toBe(false);
    expect((await vault.recorded()).fence).toBe('open');
    expect(existsSync(join(vault.deployment.stateDir, 'scratch'))).toBe(false);
    armsRan += 1;
  }, 300_000);

  it('refuses a version a deploy activated while the export waited, instead of exporting it', async () => {
    await swap.deploy();
    await ownerWithOrg(swap.deployment.base, 'owner@example.test', 'Swap');
    await swap.stop();
    const before = swap.deployment.active();
    expect(await swap.recorded()).toMatchObject({ digest: before, backend: { kind: 'fs' } });
    // The next version: the same application, its extension now providing a blob backend.
    const next = swap.packed('  capabilities: { blobFactory: memoryBlobs },\n', '1.0.1');

    const output = join(swap.deployment.dir, 'swap.migration.ray');
    const input = new PassThrough();
    const shown = new PassThrough();
    let prompt = '';
    const asked = new Promise<void>((resolve) => {
      shown.on('data', (c: Buffer) => {
        prompt += c.toString('utf8');
        if (prompt.includes('Type "yes"')) resolve();
      });
    });
    // A stopped source has no session but the export's own.
    await swap.db.sql.end();
    const exported = runExport(swap.exportArgs(output, false), {
      operationId: randomUUID(),
      json: false,
      env: swap.env(),
      terminal: { input, output: shown },
      progress: () => {},
    });
    await Promise.race([
      asked,
      exported.then((o) => {
        throw new Error(`the export ended before asking: ${JSON.stringify(o.envelope.errors)}`);
      }),
    ]);

    // While the operator reads the plan, a deploy activates the next version.
    await swap.deploy(next);
    await swap.stop();
    const [row] = (await asAdmin(baseUrl ?? '', swap.db.name, (sql) =>
      sql.unsafe(
        'SELECT application_digest AS digest, blob_backend AS backend FROM runtime_control_state',
      ),
    )) as unknown as { digest: string; backend: unknown }[];
    expect(row?.digest, 'the deploy activated the next version').not.toBe(before);
    expect(row?.backend).toEqual({ kind: 'extension', extension: 'swap_pack' });

    input.write('yes\n');
    const outcome = await exported;
    swap.db.sql = postgres(swap.db.url, { max: 2, onnotice: () => {} });
    expect(outcome.envelope.errors[0]?.code, JSON.stringify(outcome.envelope.errors)).toBe(
      'RAY_SOURCE_NOT_QUIESCENT',
    );
    expect(existsSync(output)).toBe(false);
    expect(existsSync(marker), 'the export loaded an extension module').toBe(false);
    armsRan += 1;
  }, 300_000);
});
