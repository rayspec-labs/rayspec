/**
 * Opening a migration bundle for import, without a database: every bundle here is written by the
 * same writers an export uses (`writeSnapshotArchive`, `writeMigrationBundle`) around a real
 * application bundle, and then damaged or altered one way at a time.
 *
 *  - A good bundle opens: the snapshot, the object index, the located entries and the embedded
 *    application come back; the private scratch directory (mode 0700) holds the plaintext archive
 *    and the application, and nothing of the ciphertext.
 *  - A wrong identity, and a flipped ciphertext byte under a matching inventory, are
 *    `RAY_DECRYPTION_FAILED`; a flipped byte the inventory does not match is refused by the reader
 *    before anything is decrypted; a flipped byte in the inner archive is refused by its reader.
 *  - Every clear hint must equal the authenticated metadata (`inner-metadata`), the snapshot must be
 *    of this exact runtime (`RAY_RUNTIME_UNSUPPORTED`), and the object index must name paths a blob
 *    store writes, of one tenant.
 *  - Nothing is left in the scratch parent after a refusal.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BundleFile, writeBundle, writeSnapshotArchive } from '@rayspec/bundle';
import { closureFiles, closureManifest, resolveClosure } from '@rayspec/bundle-closure';
import {
  type ApplicationManifest,
  canonicalJsonFile,
  MIGRATION_CIPHERTEXT_PATH,
  type ObjectIndex,
  SNAPSHOT_PATHS,
  type Snapshot,
} from '@rayspec/bundle-contract';
import { generateX25519Identity, identityToRecipient } from 'age-encryption';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  backendSpec,
  RUNTIME,
  removeTemporaryDirectories,
  temporaryDirectory,
  writeTree,
} from '../../../kernel/bundle-closure/src/test-support/app.js';
import { writeMigrationBundle } from './migration-bundle.js';
import { isRestorableObjectKey, openMigrationBundle } from './snapshot-import.js';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const TENANT = '00000000-0000-4000-8000-0000000c0ffe';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  removeTemporaryDirectories();
});
function workDir(prefix = 'rayspec-import-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** An application bundle built for `runtime`, as `rayspec pack` builds one. */
async function applicationBundle(
  runtime: string,
): Promise<{ bytes: Buffer; manifest: ApplicationManifest }> {
  const app = temporaryDirectory('import-app-');
  writeTree(app, {
    'rayspec.yaml': backendSpec(
      'stores:\n  - name: notes\n    columns:\n      - { name: body, type: text }\n',
    ),
    'package.json': JSON.stringify({ name: 'probe', private: true, type: 'module' }),
  });
  const closure = await resolveClosure({
    specPath: join(app, 'rayspec.yaml'),
    runtimeVersion: runtime,
  });
  if (!closure.ok) throw new Error(JSON.stringify(closure.errors));
  const path = join(workDir(), 'app.ray');
  const written = await writeBundle(path, {
    manifest: closureManifest(closure.value),
    files: closureFiles(closure.value),
  });
  if (!written.ok) throw new Error(JSON.stringify(written.errors));
  return { bytes: readFileSync(path), manifest: written.value.manifest as ApplicationManifest };
}

function storedBlob(bytes: Buffer): Buffer {
  const header = Buffer.from(JSON.stringify({ sha256: sha(bytes), len: bytes.length }), 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(header.length, 0);
  return Buffer.concat([length, header, bytes]);
}

let app: { bytes: Buffer; manifest: ApplicationManifest };
let identity = '';
let recipient = '';

beforeAll(async () => {
  app = await applicationBundle(RUNTIME);
  identity = await generateX25519Identity();
  recipient = await identityToRecipient(identity);
}, 60_000);

interface BundleOptions {
  application?: { bytes: Buffer; manifest: ApplicationManifest };
  objects?: { tenantId: string; key: string }[];
  snapshot?: Partial<Omit<Snapshot, 'inventory'>>;
  outer?: Partial<{
    id: string;
    version: string;
    runtime: string;
    target: ApplicationManifest['target'];
  }>;
  /** Change the inner archive's bytes before it is encrypted. */
  damageInner?: (archive: Buffer) => void;
}

/** A migration bundle around the application, written as an export writes one. */
async function migrationBundle(options: BundleOptions = {}): Promise<string> {
  const dir = workDir();
  const application = options.application ?? app;
  const blobs = (
    options.objects ?? [
      { tenantId: TENANT, key: 'docs/b.bin' },
      { tenantId: TENANT, key: 'docs/größe.txt' },
    ]
  ).map((o, i) => ({ ...o, bytes: Buffer.from(`bytes of object ${i} — ü`) }));
  const stored = blobs.map((b) => storedBlob(b.bytes));
  let offset = 0;
  const index: ObjectIndex = {
    objectIndexFormatVersion: 1,
    objects: blobs.map((b, i) => {
      const e = {
        tenantId: b.tenantId,
        key: b.key,
        size: b.bytes.length,
        sha256: sha(b.bytes),
        storedOffset: offset,
        storedSize: stored[i]!.length,
        storedSha256: sha(stored[i]!),
      };
      offset += stored[i]!.length;
      return e;
    }),
  };
  const files: BundleFile[] = [
    { path: SNAPSHOT_PATHS.application, bytes: application.bytes },
    {
      path: SNAPSHOT_PATHS.database,
      bytes: Buffer.concat([Buffer.from('PGDMP'), randomBytes(5000)]),
    },
    { path: SNAPSHOT_PATHS.objectIndex, bytes: Buffer.from(canonicalJsonFile(index)) },
    { path: SNAPSHOT_PATHS.objects, bytes: Buffer.concat(stored) },
  ];
  const m = application.manifest;
  const inner = join(dir, 'snapshot.zip');
  const written = await writeSnapshotArchive(inner, {
    snapshot: {
      snapshotFormatVersion: 1,
      sourceRuntime: m.runtime.version,
      exportToolVersion: m.runtime.version,
      applicationId: m.application.id,
      applicationVersion: m.application.version,
      applicationDigest: sha(application.bytes),
      schemaHead: { platform: '0015_tenant_row_security', product: 'a'.repeat(64) },
      databaseMajor: 16,
      fenceEpoch: 4,
      capturedAt: '2026-10-01T08:00:00Z',
      applicationTenantCount: 1,
      workflowSystemDatabase: 'absent',
      runHistoryPolicy: 'included',
      identityPolicy: {
        userIds: 'preserved',
        passwordHashes: 'preserved',
        sessions: 'reset',
        apiKeys: 'reset',
        invites: 'reset',
        oidcArtifacts: 'reset',
        jwtSigningKey: 'reissued',
        apiKeyPepper: 'reissued',
        mediaSigningKey: 'reissued',
        mediaPlaybackTokens: 'invalidated',
      },
      tableCounts: [{ database: 'application', schema: 'public', table: 'orgs', rows: 1 }],
      objectCount: index.objects.length,
      excludedDataCategories: [
        'credential-state',
        'request-replay-state',
        'runtime-control-state',
        'security-audit-log',
      ],
      ...options.snapshot,
    },
    files,
  });
  if (!written.ok) throw new Error(JSON.stringify(written.errors));
  if (options.damageInner !== undefined) {
    const bytes = readFileSync(inner);
    options.damageInner(bytes);
    writeFileSync(inner, bytes);
  }
  const out = join(dir, 'migration.ray');
  const work = join(dir, 'work');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(work, { mode: 0o700 });
  const bundle = await writeMigrationBundle(out, {
    application: {
      id: options.outer?.id ?? m.application.id,
      version: options.outer?.version ?? m.application.version,
    },
    runtime: { version: options.outer?.runtime ?? m.runtime.version },
    target: options.outer?.target ?? m.target,
    innerArchive: inner,
    recipient,
    workDir: work,
  });
  if (!bundle.ok) throw new Error(JSON.stringify(bundle.errors));
  return out;
}

async function open(bundlePath: string, key = identity, limits = {}) {
  const parent = workDir('rayspec-import-scratch-');
  const result = await openMigrationBundle({
    bundlePath,
    identity: key,
    scratchParent: parent,
    limits,
  });
  return { result, parent };
}

const outcome = (r: Awaited<ReturnType<typeof open>>['result']) =>
  r.ok ? 'ok' : `${r.errors[0]!.code}/${r.errors[0]!.reason ?? ''}`;

/** The ciphertext entry's data range in the outer bundle. */
function ciphertextRange(bundle: Buffer): { start: number; size: number } {
  let at = 0;
  while (bundle.readUInt32LE(at) === 0x04034b50) {
    const size = bundle.readUInt32LE(at + 22);
    const nameLength = bundle.readUInt16LE(at + 26);
    const extraLength = bundle.readUInt16LE(at + 28);
    const name = bundle.subarray(at + 30, at + 30 + nameLength).toString('utf8');
    const start = at + 30 + nameLength + extraLength;
    if (name === MIGRATION_CIPHERTEXT_PATH) return { start, size };
    at = start + size;
  }
  throw new Error('no ciphertext entry');
}

describe('openMigrationBundle', () => {
  it('opens a good bundle into a private scratch directory holding the plaintext and the application only', async () => {
    const bundlePath = await migrationBundle();
    const { result, parent } = await open(bundlePath);
    expect(outcome(result)).toBe('ok');
    if (!result.ok) return;
    const o = result.value;
    expect(o.bundleSha256).toBe(sha(readFileSync(bundlePath)));
    expect(o.snapshot.applicationId).toBe(app.manifest.application.id);
    expect(o.objectIndex.objects.map((x) => x.key)).toEqual(['docs/b.bin', 'docs/größe.txt']);
    expect(o.entries.map((e) => e.path)).toEqual(o.snapshot.inventory.map((e) => e.path));
    expect(o.application.manifest.application).toEqual(app.manifest.application);
    expect(o.application.productTables).toEqual(['notes']);
    expect(statSync(o.scratchDir).mode & 0o777).toBe(0o700);
    expect(readdirSync(o.scratchDir).sort()).toEqual(['application.ray', 'snapshot.zip']);
    expect(readdirSync(parent)).toEqual([o.scratchDir.split('/').at(-1)]);
  });

  it('refuses a wrong identity with RAY_DECRYPTION_FAILED and keeps nothing', async () => {
    const { result, parent } = await open(await migrationBundle(), await generateX25519Identity());
    expect(outcome(result)).toBe('RAY_DECRYPTION_FAILED/');
    expect(readdirSync(parent)).toEqual([]);
  });

  it('refuses a flipped ciphertext byte: before decryption when the inventory does not match, by decryption when it does', async () => {
    const bundlePath = await migrationBundle();
    const bytes = readFileSync(bundlePath);
    const range = ciphertextRange(bytes);
    const flipped = Buffer.from(bytes);
    const at = range.start + range.size - 40;
    flipped[at] = flipped[at]! ^ 0x01;
    const tampered = join(workDir(), 'tampered.ray');
    writeFileSync(tampered, flipped);
    const unmatched = await open(tampered);
    expect(outcome(unmatched.result)).toMatch(
      /^RAY_(INVALID_ARCHIVE\/crc-mismatch|DIGEST_MISMATCH\/entry-sha256)$/,
    );
    expect(readdirSync(unmatched.parent)).toEqual([]);

    // The same flipped ciphertext in a bundle whose inventory states its digest.
    const ciphertext = join(workDir(), 'migration.age');
    writeFileSync(ciphertext, flipped.subarray(range.start, range.start + range.size));
    const rewritten = join(workDir(), 'rewritten.ray');
    const m = app.manifest;
    const written = await writeBundle(rewritten, {
      manifest: {
        formatVersion: 1,
        kind: 'migration',
        application: m.application,
        runtime: m.runtime,
        target: m.target,
        migration: { encryption: 'age-v1-x25519', ciphertextPath: MIGRATION_CIPHERTEXT_PATH },
      },
      files: [{ path: MIGRATION_CIPHERTEXT_PATH, file: ciphertext }],
    });
    expect(written.ok).toBe(true);
    const matched = await open(rewritten);
    expect(outcome(matched.result)).toBe('RAY_DECRYPTION_FAILED/');
    expect(readdirSync(matched.parent)).toEqual([]);
  });

  it('refuses a flipped byte inside the inner archive, which its reader finds', async () => {
    const { result, parent } = await open(
      await migrationBundle({
        damageInner: (archive) => {
          const at = archive.indexOf(Buffer.from('PGDMP')) + 100;
          archive[at] = archive[at]! ^ 0x01;
        },
      }),
    );
    expect(outcome(result)).toBe('RAY_INVALID_ARCHIVE/crc-mismatch');
    expect(readdirSync(parent)).toEqual([]);
  });

  it('refuses a clear hint that differs from the authenticated metadata', async () => {
    for (const outer of [
      { id: 'another-app' },
      { version: '9.9.9' },
      { runtime: '1.7.9' },
      { target: { ...app.manifest.target, arch: 'arm64' } },
    ]) {
      const { result } = await open(await migrationBundle({ outer }));
      expect(outcome(result), JSON.stringify(outer)).toBe('RAY_DIGEST_MISMATCH/inner-metadata');
    }
  });

  it('refuses a snapshot of another runtime, consistent in every hint', async () => {
    const other = await applicationBundle('1.7.9');
    expect(other.manifest.runtime.version).not.toBe(RUNTIME);
    const { result } = await open(await migrationBundle({ application: other }));
    expect(outcome(result)).toBe('RAY_RUNTIME_UNSUPPORTED/');
  });

  it('refuses object keys a blob store could not have written, and objects of two tenants', async () => {
    for (const key of [
      '../escape',
      'a//b',
      './a',
      'a/%2e%2e',
      'tmp/x.tmp-1-2-00000000-0000-4000-8000-000000000001',
    ]) {
      const { result } = await open(
        await migrationBundle({ objects: [{ tenantId: TENANT, key }] }),
      );
      expect(outcome(result), key).toBe('RAY_MANIFEST_INVALID/schema');
    }
    const collide = await open(
      await migrationBundle({
        objects: [
          { tenantId: TENANT, key: 'a' },
          { tenantId: TENANT, key: 'a/b' },
        ],
      }),
    );
    expect(outcome(collide.result)).toBe('RAY_MANIFEST_INVALID/schema');
    const two = await open(
      await migrationBundle({
        objects: [
          { tenantId: '00000000-0000-4000-8000-0000000000b2', key: 'a' },
          { tenantId: TENANT, key: 'a' },
        ],
      }),
    );
    expect(outcome(two.result)).toBe('RAY_MULTI_TENANT_UNSUPPORTED/');
  });

  it('refuses a plaintext over the extracted byte limit', async () => {
    const bundlePath = await migrationBundle();
    const limit = 4 * 1024;
    const { result, parent } = await open(bundlePath, identity, { migrationExtractedBytes: limit });
    // The snapshot is larger than the limit: the bundle carries all of it, encrypted.
    expect(statSync(bundlePath).size).toBeGreaterThan(2 * limit);
    expect(outcome(result)).toBe('RAY_LIMIT_EXCEEDED/extracted-size');
    expect(readdirSync(parent)).toEqual([]);
  });

  it('refuses a snapshot whose identity policy resets password hashes, which this runtime does not do', async () => {
    const preserved = await open(await migrationBundle());
    expect(outcome(preserved.result)).toBe('ok');
    const { result } = await open(
      await migrationBundle({
        snapshot: {
          identityPolicy: {
            userIds: 'preserved',
            passwordHashes: 'reset',
            sessions: 'reset',
            apiKeys: 'reset',
            invites: 'reset',
            oidcArtifacts: 'reset',
            jwtSigningKey: 'reissued',
            apiKeyPepper: 'reissued',
            mediaSigningKey: 'reissued',
            mediaPlaybackTokens: 'invalidated',
          },
        },
      }),
    );
    expect(outcome(result)).toBe('RAY_POLICY_DENIED/posture-refused');
  });

  it('refuses an application bundle in place of a migration bundle', async () => {
    const path = join(workDir(), 'app.ray');
    writeFileSync(path, app.bytes);
    const { result } = await open(path);
    expect(outcome(result)).toBe('RAY_MANIFEST_INVALID/migration-inventory');
  });
});

describe('isRestorableObjectKey', () => {
  it('takes the keys the fs blob store writes and nothing else', () => {
    for (const key of ['a', 'uploads/up-1', 'docs/größe.txt', 'a.b/c-d_e']) {
      expect(isRestorableObjectKey(key), key).toBe(true);
    }
    for (const key of [
      '',
      '/abs',
      'a/../b',
      'a/./b',
      'a//b',
      'a\\b',
      'a\0b',
      'a#b',
      'a?b',
      'x'.repeat(1025),
      'é',
    ]) {
      expect(isRestorableObjectKey(key), JSON.stringify(key)).toBe(false);
    }
  });
});
