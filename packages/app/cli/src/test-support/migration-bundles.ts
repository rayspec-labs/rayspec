/**
 * Migration bundles an export would never write, for the import suites: the parts of a real one
 * decrypted, changed, and written back with the same writers an export uses — the snapshot archive
 * writer of `@rayspec/bundle` and the migration bundle writer of `@rayspec/server` — so every digest
 * and every inventory agrees and only the change itself is wrong. A dump is changed by rewriting its
 * table of contents (the server's test-support writer), keeping its data blocks byte for byte.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type BundleFile, writeSnapshotArchive } from '@rayspec/bundle';
import {
  MIGRATION_CIPHERTEXT_PATH,
  SNAPSHOT_PATHS,
  SNAPSHOT_ROOT_NAME,
  type Snapshot,
} from '@rayspec/bundle-contract';
import { type DumpTocEntry, readDumpToc, writeMigrationBundle } from '@rayspec/server';
import { Decrypter } from 'age-encryption';
import { temporaryDirectory } from '../../../../kernel/bundle-closure/src/test-support/app.js';
import { rewriteDumpToc } from '../../../server/src/test-support/dump-archive-writer.js';

/** The data of each entry of a stored ZIP in the strict profile, by name. */
export function zipEntries(archive: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let at = 0;
  while (archive.readUInt32LE(at) === 0x04034b50) {
    const size = archive.readUInt32LE(at + 22);
    const nameLength = archive.readUInt16LE(at + 26);
    const extraLength = archive.readUInt16LE(at + 28);
    const name = archive.subarray(at + 30, at + 30 + nameLength).toString('utf8');
    const start = at + 30 + nameLength + extraLength;
    out.set(name, Buffer.from(archive.subarray(start, start + size)));
    at = start + size;
  }
  return out;
}

/** The decrypted parts of a migration bundle: `snapshot.json` parsed, every payload file's bytes. */
export interface SnapshotParts {
  snapshot: Snapshot;
  files: Map<string, Buffer>;
  /** The decrypted inner archive itself. */
  inner: Buffer;
}

export async function decryptParts(bundlePath: string, identity: string): Promise<SnapshotParts> {
  const ciphertext = zipEntries(readFileSync(bundlePath)).get(MIGRATION_CIPHERTEXT_PATH);
  if (ciphertext === undefined) throw new Error('no ciphertext');
  const d = new Decrypter();
  d.addIdentity(identity);
  const inner = Buffer.from(await d.decrypt(ciphertext));
  const entries = zipEntries(inner);
  const snapshot = JSON.parse(entries.get(SNAPSHOT_ROOT_NAME)!.toString('utf8')) as Snapshot;
  entries.delete(SNAPSHOT_ROOT_NAME);
  return { snapshot, files: entries, inner };
}

export interface RebuildOptions {
  recipient: string;
  /** Changes to `snapshot.json` (its inventory is computed again). */
  snapshot?: Partial<Omit<Snapshot, 'inventory'>>;
  /** Payload files replaced by path. */
  files?: Record<string, Buffer>;
  /** The clear outer hints; default the snapshot's. */
  outer?: Partial<{ id: string; version: string; runtime: string }>;
  /** The target the outer manifest states. */
  target: { os: string; arch: string; nodeMajor: number };
  /** Change the encrypted inner archive's bytes before encryption. */
  damageInner?: (inner: Buffer) => void;
}

/** Write a migration bundle from `parts` with the changes `options` names; returns its path. */
export async function rebuildMigrationBundle(
  parts: SnapshotParts,
  options: RebuildOptions,
): Promise<string> {
  const dir = temporaryDirectory('import-rebuilt-');
  const { inventory: _inventory, ...document } = parts.snapshot;
  const snapshot = { ...document, ...options.snapshot };
  const files: BundleFile[] = [];
  for (const [path, bytes] of parts.files) {
    files.push({ path, bytes: options.files?.[path] ?? bytes });
  }
  const inner = join(dir, 'snapshot.zip');
  const written = await writeSnapshotArchive(inner, { snapshot, files });
  if (!written.ok) throw new Error(`snapshot: ${JSON.stringify(written.errors)}`);
  if (options.damageInner !== undefined) {
    const bytes = readFileSync(inner);
    options.damageInner(bytes);
    writeFileSync(inner, bytes);
  }
  const work = join(dir, 'work');
  mkdirSync(work, { mode: 0o700 });
  const out = join(dir, 'migration.ray');
  const bundle = await writeMigrationBundle(out, {
    application: {
      id: options.outer?.id ?? snapshot.applicationId,
      version: options.outer?.version ?? snapshot.applicationVersion,
    },
    runtime: { version: options.outer?.runtime ?? snapshot.sourceRuntime },
    target: options.target,
    innerArchive: inner,
    recipient: options.recipient,
    workDir: work,
  });
  if (!bundle.ok) throw new Error(`bundle: ${JSON.stringify(bundle.errors)}`);
  return out;
}

/** A dump with its table of contents changed by `change`; its data blocks are kept. */
export async function forgeDump(
  dump: Buffer,
  change: (entries: DumpTocEntry[]) => DumpTocEntry[],
): Promise<Buffer> {
  const toc = await readDumpToc(async (p, l) => dump.subarray(p, p + l), dump.length);
  return rewriteDumpToc(dump, toc, change(toc.entries.map((e) => ({ ...e }))));
}

export { SNAPSHOT_PATHS };
