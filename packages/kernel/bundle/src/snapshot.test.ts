/**
 * The inner snapshot archive: the writer computes the inventory and reads its output back, the same
 * input gives the same bytes, and the reader refuses, with the contract's code and reason, a
 * snapshot whose entries, application digest, object ranges or object digests do not hold together.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type BundleError,
  canonicalJsonFile,
  type ObjectIndex,
  SNAPSHOT_PATHS,
} from '@rayspec/bundle-contract';
import { afterAll, describe, expect, it } from 'vitest';
import {
  type BundleFile,
  inspectSnapshotArchive,
  type SnapshotDocumentInput,
  writeSnapshotArchive,
} from './index.js';
import { rawZip } from './test-support/raw-zip.js';

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

const outcome = (r: { ok: true } | { ok: false; errors: BundleError[] }) =>
  r.ok ? 'ok' : `${r.errors[0]!.code}/${r.errors[0]!.reason ?? ''}`;

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function workDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rayspec-snapshot-archive-'));
  dirs.push(dir);
  return dir;
}

/**
 * Write a snapshot the writer must refuse into a directory of its own, and check that nothing is
 * left there: neither the destination nor the plaintext temporary archive the read-back refused.
 */
async function writeRefused(
  name: string,
  input: Parameters<typeof writeSnapshotArchive>[1],
  options?: Parameters<typeof writeSnapshotArchive>[2],
): Promise<string> {
  const dir = workDir();
  const r = await writeSnapshotArchive(join(dir, name), input, options);
  expect(readdirSync(dir)).toEqual([]);
  return outcome(r);
}

const TENANT = '00000000-0000-4000-8000-000000000001';

/** A stored blob file as the fs blob store writes it: a length-prefixed JSON header, then bytes. */
function storedBlob(bytes: Buffer, contentType?: string): Buffer {
  const header = Buffer.from(
    JSON.stringify({
      ...(contentType === undefined ? {} : { contentType }),
      sha256: sha(bytes),
      len: bytes.length,
    }),
    'utf8',
  );
  const length = Buffer.alloc(4);
  length.writeUInt32BE(header.length, 0);
  return Buffer.concat([length, header, bytes]);
}

interface Fixture {
  files: BundleFile[];
  snapshot: SnapshotDocumentInput;
  objectsBin: Buffer;
  index: ObjectIndex;
}

function fixture(
  options: { workflowSystem?: boolean; edit?: (index: ObjectIndex) => void } = {},
): Fixture {
  const blobs = [
    { key: 'docs/a.txt', bytes: Buffer.from('größe: 1 €', 'utf8'), contentType: 'text/plain' },
    { key: 'docs/b.bin', bytes: Buffer.from([0, 1, 2, 3, 255]) },
  ];
  const stored = blobs.map((b) => storedBlob(b.bytes, b.contentType));
  let offset = 0;
  const index: ObjectIndex = {
    objectIndexFormatVersion: 1,
    objects: blobs.map((b, i) => {
      const entry = {
        tenantId: TENANT,
        key: b.key,
        ...(b.contentType === undefined ? {} : { contentType: b.contentType }),
        size: b.bytes.length,
        sha256: sha(b.bytes),
        storedOffset: offset,
        storedSize: stored[i]!.length,
        storedSha256: sha(stored[i]!),
      };
      offset += stored[i]!.length;
      return entry;
    }),
  };
  options.edit?.(index);
  const objectsBin = Buffer.concat(stored);
  const application = Buffer.from('application bundle bytes');
  const files: BundleFile[] = [
    { path: SNAPSHOT_PATHS.application, bytes: application },
    { path: SNAPSHOT_PATHS.database, bytes: Buffer.from('PGDMP application') },
    { path: SNAPSHOT_PATHS.objectIndex, bytes: Buffer.from(canonicalJsonFile(index)) },
    { path: SNAPSHOT_PATHS.objects, bytes: objectsBin },
  ];
  if (options.workflowSystem === true) {
    files.push({ path: SNAPSHOT_PATHS.workflowSystem, bytes: Buffer.from('PGDMP workflow') });
  }
  const snapshot: SnapshotDocumentInput = {
    snapshotFormatVersion: 1,
    sourceRuntime: '1.8.0',
    exportToolVersion: '1.8.0',
    applicationId: 'notes',
    applicationVersion: '1.0.0',
    applicationDigest: sha(application),
    schemaHead: { platform: '0015_tenant_row_security', product: 'a'.repeat(64) },
    databaseMajor: 16,
    fenceEpoch: 3,
    capturedAt: '2026-10-01T08:00:00Z',
    applicationTenantCount: 1,
    workflowSystemDatabase: options.workflowSystem === true ? 'included' : 'absent',
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
  };
  return { files, snapshot, objectsBin, index };
}

describe('writeSnapshotArchive', () => {
  it('writes an archive the reader accepts, with the computed inventory, mode 0600', async () => {
    const f = fixture({ workflowSystem: true });
    const out = join(workDir(), 'snapshot.zip');
    const written = await writeSnapshotArchive(out, { snapshot: f.snapshot, files: f.files });
    expect(outcome(written)).toBe('ok');
    if (!written.ok) return;
    expect(written.value.snapshot.inventory.map((e) => e.path)).toEqual([
      'payload/application.ray',
      'payload/database.dump',
      'payload/object-index.json',
      'payload/objects.bin',
      'payload/workflow-system.dump',
    ]);
    expect(written.value.objectIndex).toEqual(f.index);
    expect(written.value.archiveSha256).toBe(sha(readFileSync(out)));
    expect(statSync(out).mode & 0o777).toBe(0o600);
    const read = await inspectSnapshotArchive(out);
    expect(outcome(read)).toBe('ok');
    expect(read.ok && read.value.snapshot).toEqual(written.value.snapshot);
  });

  it('gives the same bytes for the same input, files given in any order', async () => {
    const f = fixture();
    const a = join(workDir(), 'a.zip');
    const b = join(workDir(), 'b.zip');
    expect(outcome(await writeSnapshotArchive(a, { snapshot: f.snapshot, files: f.files }))).toBe(
      'ok',
    );
    const reversed = [...f.files].reverse();
    expect(outcome(await writeSnapshotArchive(b, { snapshot: f.snapshot, files: reversed }))).toBe(
      'ok',
    );
    expect(readFileSync(a).equals(readFileSync(b))).toBe(true);
  });

  it('never writes over an existing file and refuses a given inventory', async () => {
    const f = fixture();
    const out = join(workDir(), 'taken.zip');
    writeFileSync(out, 'already here');
    expect(outcome(await writeSnapshotArchive(out, { snapshot: f.snapshot, files: f.files }))).toBe(
      'RAY_OUTPUT_EXISTS/',
    );
    expect(readFileSync(out, 'utf8')).toBe('already here');
    const withInventory = { ...f.snapshot, inventory: [] } as unknown as SnapshotDocumentInput;
    expect(
      await writeRefused('x.zip', {
        snapshot: withInventory,
        files: f.files,
      }),
    ).toBe('RAY_USAGE/');
  });

  it('refuses a document the schema refuses and writes nothing', async () => {
    const f = fixture();
    // The workflow system database is said to be included, but no dump is given.
    const dir = workDir();
    const out = join(dir, 's.zip');
    const r = await writeSnapshotArchive(out, {
      snapshot: { ...f.snapshot, workflowSystemDatabase: 'included' },
      files: f.files,
    });
    expect(outcome(r)).toBe('RAY_MANIFEST_INVALID/schema');
    expect(() => statSync(out)).toThrow();
  });

  it('refuses an object index whose ranges or digests do not match objects.bin', async () => {
    const gap = fixture({
      edit: (i) => {
        i.objects[1]!.storedOffset += 1;
      },
    });
    expect(
      await writeRefused('gap.zip', {
        snapshot: gap.snapshot,
        files: gap.files,
      }),
    ).toBe('RAY_DIGEST_MISMATCH/object-range');
    const digest = fixture({
      edit: (i) => {
        i.objects[0]!.sha256 = 'f'.repeat(64);
      },
    });
    expect(
      await writeRefused('digest.zip', {
        snapshot: digest.snapshot,
        files: digest.files,
      }),
    ).toBe('RAY_DIGEST_MISMATCH/object-sha256');
    const stored = fixture({
      edit: (i) => {
        i.objects[1]!.storedSha256 = 'f'.repeat(64);
      },
    });
    expect(
      await writeRefused('stored.zip', {
        snapshot: stored.snapshot,
        files: stored.files,
      }),
    ).toBe('RAY_DIGEST_MISMATCH/object-sha256');
  });

  it('refuses an application digest that is not the embedded bundle and a wrong object count', async () => {
    const f = fixture();
    expect(
      await writeRefused('app.zip', {
        snapshot: { ...f.snapshot, applicationDigest: 'b'.repeat(64) },
        files: f.files,
      }),
    ).toBe('RAY_DIGEST_MISMATCH/application-digest');
    expect(
      await writeRefused('count.zip', {
        snapshot: { ...f.snapshot, objectCount: 3 },
        files: f.files,
      }),
    ).toBe('RAY_DIGEST_MISMATCH/object-range');
  });

  it('refuses a snapshot above the migration limit before writing it', async () => {
    const f = fixture();
    expect(
      await writeRefused(
        'big.zip',
        { snapshot: f.snapshot, files: f.files },
        { limits: { migrationExtractedBytes: 1024 } },
      ),
    ).toBe('RAY_LIMIT_EXCEEDED/migration-size');
  });
});

describe('inspectSnapshotArchive', () => {
  /** The entries of a good snapshot, as raw ZIP entries the test can change. */
  function entries(f: Fixture) {
    const sorted = [...f.files].sort((a, b) => (a.path < b.path ? -1 : 1));
    const inventory = sorted.map((file) => ({
      path: file.path,
      size: file.bytes!.length,
      sha256: sha(file.bytes!),
    }));
    return {
      payload: sorted.map((file) => ({ name: file.path, data: Buffer.from(file.bytes!) })),
      root: (extra: Record<string, unknown> = {}) => ({
        name: 'snapshot.json',
        data: canonicalJsonFile({ ...f.snapshot, inventory, ...extra }),
      }),
      inventory,
    };
  }

  it('accepts a hand-built archive identical to what the writer writes', async () => {
    const f = fixture();
    const e = entries(f);
    const raw = rawZip([...e.payload, e.root()]);
    expect(outcome(await inspectSnapshotArchive(raw))).toBe('ok');
  });

  it('refuses an archive rooted at ray.json, an undeclared entry and a missing entry', async () => {
    const f = fixture();
    const e = entries(f);
    expect(
      outcome(
        await inspectSnapshotArchive(rawZip([...e.payload, { ...e.root(), name: 'ray.json' }])),
      ),
    ).toBe('RAY_INVALID_ARCHIVE/outside-payload');
    const extra = { name: 'payload/objects/x', data: Buffer.from('x') };
    const withExtra = [...e.payload, extra].sort((a, b) => (a.name < b.name ? -1 : 1));
    expect(outcome(await inspectSnapshotArchive(rawZip([...withExtra, e.root()])))).toBe(
      'RAY_INVALID_ARCHIVE/undeclared-entry',
    );
    const withoutDump = e.payload.filter((p) => p.name !== SNAPSHOT_PATHS.database);
    expect(outcome(await inspectSnapshotArchive(rawZip([...withoutDump, e.root()])))).toBe(
      'RAY_INVALID_ARCHIVE/missing-entry',
    );
  });

  it('refuses an entry whose bytes differ from the inventory', async () => {
    const f = fixture();
    const e = entries(f);
    const changed = e.payload.map((p) =>
      p.name === SNAPSHOT_PATHS.database ? { ...p, data: Buffer.from('PGDMP applicatioN') } : p,
    );
    expect(outcome(await inspectSnapshotArchive(rawZip([...changed, e.root()])))).toBe(
      'RAY_DIGEST_MISMATCH/entry-sha256',
    );
    const longer = e.payload.map((p) =>
      p.name === SNAPSHOT_PATHS.database ? { ...p, data: Buffer.from('PGDMP application!') } : p,
    );
    expect(outcome(await inspectSnapshotArchive(rawZip([...longer, e.root()])))).toBe(
      'RAY_DIGEST_MISMATCH/entry-size',
    );
  });

  it('refuses objects.bin bytes that no longer match an object, and a snapshot.json above its limit', async () => {
    const f = fixture();
    const e = entries(f);
    // Flip the last logical byte of the last object, and state the new digests of objects.bin so
    // that only the object check can notice.
    const objects = Buffer.from(f.objectsBin);
    objects[objects.length - 1] = 0;
    const payload = e.payload.map((p) =>
      p.name === SNAPSHOT_PATHS.objects ? { ...p, data: objects } : p,
    );
    const inventory = e.inventory.map((i) =>
      i.path === SNAPSHOT_PATHS.objects ? { ...i, sha256: sha(objects) } : i,
    );
    const root = { name: 'snapshot.json', data: canonicalJsonFile({ ...f.snapshot, inventory }) };
    expect(outcome(await inspectSnapshotArchive(rawZip([...payload, root])))).toBe(
      'RAY_DIGEST_MISMATCH/object-sha256',
    );
    expect(
      outcome(
        await inspectSnapshotArchive(rawZip([...e.payload, e.root()]), {
          limits: { snapshotBytes: 100 },
        }),
      ),
    ).toBe('RAY_LIMIT_EXCEEDED/snapshot-size');
  });
});
