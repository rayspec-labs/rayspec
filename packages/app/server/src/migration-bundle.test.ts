/**
 * The migration bundle writer: the inner archive encrypted to one X25519 recipient inside a
 * migration-kind `.ray` that the one reader accepts for import (reader steps 1 to 9, without
 * decryption), mode 0600, linked into place, never over an existing file, with no plaintext and no
 * ciphertext left beside it or in the work directory.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectBundle } from '@rayspec/bundle';
import { MIGRATION_CIPHERTEXT_PATH } from '@rayspec/bundle-contract';
import { Decrypter, generateX25519Identity, identityToRecipient } from 'age-encryption';
import { afterAll, describe, expect, it } from 'vitest';
import {
  type MigrationBundleInput,
  MigrationWriteAborted,
  writeMigrationBundle,
} from './migration-bundle.js';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** The data of each entry of a stored ZIP in the strict profile, by name. */
function zipEntries(archive: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let at = 0;
  while (archive.readUInt32LE(at) === 0x04034b50) {
    const size = archive.readUInt32LE(at + 22);
    const nameLength = archive.readUInt16LE(at + 26);
    const extraLength = archive.readUInt16LE(at + 28);
    const name = archive.subarray(at + 30, at + 30 + nameLength).toString('utf8');
    const start = at + 30 + nameLength + extraLength;
    out.set(name, archive.subarray(start, start + size));
    at = start + size;
  }
  return out;
}

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function dir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

async function fixture(): Promise<{
  input: MigrationBundleInput;
  identity: string;
  plaintext: Buffer;
  out: string;
}> {
  const work = dir('rayspec-migration-work-');
  const plaintext = randomBytes(300_000);
  writeFileSync(join(work, 'snapshot.zip'), plaintext, { mode: 0o600 });
  const identity = await generateX25519Identity();
  return {
    input: {
      application: { id: 'field-notes', version: '1.0.0' },
      runtime: { version: '1.8.0' },
      target: { os: 'linux', arch: 'x64', nodeMajor: 22 },
      innerArchive: join(work, 'snapshot.zip'),
      recipient: await identityToRecipient(identity),
      workDir: work,
    },
    identity,
    plaintext,
    out: join(dir('rayspec-migration-out-'), 'migration.ray'),
  };
}

describe('writeMigrationBundle', () => {
  it('writes a migration bundle the reader accepts for import, holding only the ciphertext', async () => {
    const { input, identity, plaintext, out } = await fixture();
    const written = await writeMigrationBundle(out, input);
    expect(written.ok, written.ok ? '' : JSON.stringify(written.errors)).toBe(true);
    if (!written.ok) return;
    const bytes = readFileSync(out);
    expect(written.value.archiveSha256).toBe(sha(bytes));
    expect(statSync(out).mode & 0o777).toBe(0o600);

    const read = await inspectBundle(out, { operation: 'import' });
    expect(read.ok, read.ok ? '' : JSON.stringify(read.errors)).toBe(true);
    if (!read.ok) return;
    expect(read.value.manifest).toEqual({
      formatVersion: 1,
      kind: 'migration',
      application: input.application,
      runtime: input.runtime,
      target: input.target,
      migration: { encryption: 'age-v1-x25519', ciphertextPath: MIGRATION_CIPHERTEXT_PATH },
      inventory: [
        {
          path: MIGRATION_CIPHERTEXT_PATH,
          size: written.value.ciphertextSize,
          sha256: written.value.ciphertextSha256,
        },
      ],
    });

    // The one payload entry decrypts to the inner archive with the matching identity only.
    const entries = zipEntries(bytes);
    expect([...entries.keys()].sort()).toEqual([MIGRATION_CIPHERTEXT_PATH, 'ray.json']);
    const ciphertext = entries.get(MIGRATION_CIPHERTEXT_PATH)!;
    expect(sha(ciphertext)).toBe(written.value.ciphertextSha256);
    const right = new Decrypter();
    right.addIdentity(identity);
    expect(Buffer.from(await right.decrypt(ciphertext)).equals(plaintext)).toBe(true);
    const wrong = new Decrypter();
    wrong.addIdentity(await generateX25519Identity());
    await expect(wrong.decrypt(ciphertext)).rejects.toThrow();

    // The plaintext appears nowhere in the bundle, and nothing but the bundle is beside it; the work
    // directory holds what it held before.
    expect(bytes.includes(plaintext.subarray(0, 64))).toBe(false);
    expect(readdirSync(join(out, '..'))).toEqual(['migration.ray']);
    expect(readdirSync(input.workDir)).toEqual(['snapshot.zip']);
  });

  it('refuses an existing destination before it encrypts anything', async () => {
    const { input, out } = await fixture();
    writeFileSync(out, 'kept');
    const written = await writeMigrationBundle(out, input);
    expect(written.ok ? 'ok' : written.errors[0]!.code).toBe('RAY_OUTPUT_EXISTS');
    expect(readFileSync(out, 'utf8')).toBe('kept');
    expect(readdirSync(input.workDir)).toEqual(['snapshot.zip']);
  });

  it('refuses a recipient that is not X25519 and writes nothing', async () => {
    const { input, out } = await fixture();
    const written = await writeMigrationBundle(out, { ...input, recipient: 'age1nope' });
    expect(written.ok ? 'ok' : written.errors[0]!.code).toBe('RAY_USAGE');
    expect(readdirSync(join(out, '..'))).toEqual([]);
    expect(readdirSync(input.workDir)).toEqual(['snapshot.zip']);
  });

  it('refuses an inner archive above the migration archive limit with migration-size', async () => {
    const { input, out } = await fixture();
    const written = await writeMigrationBundle(out, input, {
      limits: { migrationArchiveBytes: 100_000, migrationExtractedBytes: 100_000 },
    });
    expect(written.ok ? 'ok' : `${written.errors[0]!.code}/${written.errors[0]!.reason}`).toBe(
      'RAY_LIMIT_EXCEEDED/migration-size',
    );
    expect(readdirSync(join(out, '..'))).toEqual([]);
    expect(readdirSync(input.workDir)).toEqual(['snapshot.zip']);
  });

  it('stops when its signal aborts and leaves nothing at the destination', async () => {
    const { input, out } = await fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      writeMigrationBundle(out, input, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(MigrationWriteAborted);
    expect(readdirSync(join(out, '..'))).toEqual([]);
    expect(readdirSync(input.workDir)).toEqual(['snapshot.zip']);
  });
});
