/**
 * The migration bundle writer: a plaintext inner snapshot archive in, one migration-kind `.ray` out,
 * whose only payload file is the archive encrypted with age to one X25519 recipient.
 *
 * The plaintext never reaches the destination's directory. It is encrypted into the caller's private
 * work directory, and that ciphertext is written into the bundle by the one bundle writer, which reads
 * the archive back through the reader (the migration kind passes reader steps 1 to 9 without
 * decryption) and links it into place, never over an existing file. The manifest's clear application,
 * runtime and target are hints a reader compares with the authenticated inner metadata after
 * decryption.
 */
import { lstat, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { type WriteOptions, type WrittenBundle, writeBundle } from '@rayspec/bundle';
import {
  type ApplicationIdentity,
  bundleError,
  MIGRATION_CIPHERTEXT_PATH,
  type Target,
  type ValidationResult,
} from '@rayspec/bundle-contract';
import { AGE_X25519_ENCRYPTION, EncryptionAborted, encryptFile } from './age-encryption.js';

export interface MigrationBundleInput {
  application: ApplicationIdentity;
  runtime: { version: string };
  target: Target;
  /** The plaintext inner snapshot archive. */
  innerArchive: string;
  /** The age X25519 recipient (`age1…`) only the holder of the matching identity can decrypt for. */
  recipient: string;
  /**
   * A private directory (mode 0700) the ciphertext is written to before it goes into the bundle;
   * the file is removed again before this function returns.
   */
  workDir: string;
}

export interface MigrationWriteOptions extends Pick<WriteOptions, 'limits'> {
  /** Stops the write at the next safe point; nothing is left at the destination. */
  signal?: AbortSignal;
}

export interface WrittenMigrationBundle extends WrittenBundle {
  /** SHA-256 of `payload/migration.age`. */
  ciphertextSha256: string;
  ciphertextSize: number;
}

/** The migration bundle write stopped because the caller's signal aborted. */
export class MigrationWriteAborted extends Error {
  constructor() {
    super('the migration bundle write was stopped');
    this.name = 'MigrationWriteAborted';
  }
}

/**
 * Encrypt `input.innerArchive` and write the migration bundle to `destination` (mode 0600). An
 * existing destination is refused with `RAY_OUTPUT_EXISTS` before anything is encrypted. Throws
 * `MigrationWriteAborted` when the signal aborts; every other failure is returned as a refusal.
 */
export async function writeMigrationBundle(
  destination: string,
  input: MigrationBundleInput,
  options: MigrationWriteOptions = {},
): Promise<ValidationResult<WrittenMigrationBundle>> {
  const ciphertextPath = join(input.workDir, 'migration.age');
  try {
    const path = resolve(destination);
    const parent = await lstat(dirname(path)).catch(() => null);
    if (parent === null || !parent.isDirectory()) {
      return {
        ok: false,
        errors: [bundleError('RAY_USAGE', 'the directory of the destination does not exist')],
      };
    }
    if ((await lstat(path).catch(() => null)) !== null) {
      return {
        ok: false,
        errors: [bundleError('RAY_OUTPUT_EXISTS', 'the destination already exists')],
      };
    }
    const encrypted = await encryptFile(input.innerArchive, ciphertextPath, input.recipient, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!encrypted.ok) return encrypted;
    if (options.signal?.aborted === true) throw new MigrationWriteAborted();
    const written = await writeBundle(
      destination,
      {
        manifest: {
          formatVersion: 1,
          kind: 'migration',
          application: input.application,
          runtime: input.runtime,
          target: input.target,
          migration: {
            encryption: AGE_X25519_ENCRYPTION,
            ciphertextPath: MIGRATION_CIPHERTEXT_PATH,
          },
        },
        files: [{ path: MIGRATION_CIPHERTEXT_PATH, file: encrypted.value.path }],
      },
      { fileMode: 0o600, ...(options.limits === undefined ? {} : { limits: options.limits }) },
    );
    if (!written.ok) return written;
    const entry = written.value.manifest.inventory[0];
    if (entry?.sha256 !== encrypted.value.sha256 || entry.size !== encrypted.value.size) {
      // The bundle this call linked into place (it never replaces a file) is not handed out.
      await unlink(written.value.path).catch(() => {});
      return {
        ok: false,
        errors: [
          bundleError('RAY_INTERNAL', 'the bundle does not carry the ciphertext that was written'),
        ],
      };
    }
    return {
      ok: true,
      value: {
        ...written.value,
        ciphertextSha256: encrypted.value.sha256,
        ciphertextSize: encrypted.value.size,
      },
    };
  } catch (err) {
    if (err instanceof EncryptionAborted) throw new MigrationWriteAborted();
    if (err instanceof MigrationWriteAborted) throw err;
    return {
      ok: false,
      errors: [bundleError('RAY_INTERNAL', 'writing the migration bundle failed unexpectedly')],
    };
  } finally {
    await unlink(ciphertextPath).catch(() => {});
  }
}
