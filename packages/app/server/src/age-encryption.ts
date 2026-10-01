/**
 * age v1 encryption of a migration bundle's payload, with one X25519 recipient.
 *
 * The cryptography is the age authors' own JavaScript implementation of the format (`age-encryption`,
 * the typage project), which this package runs against the official test vectors of the format
 * (`age-encryption.test.ts`). It lives here rather than in `@rayspec/bundle`, whose reader depends on
 * the contract package and nothing else. Nothing here implements a primitive: this module checks the recipient, streams a
 * file through the library's encrypter, and counts and hashes what comes out.
 *
 * ONLY X25519. A migration bundle is encrypted to exactly one native X25519 recipient (`age1…`, the
 * Bech32 encoding of 32 bytes). A passphrase (scrypt) is never offered, and the library's other
 * recipient types (the post-quantum hybrid `age1pq1…`, the tag recipients `age1tag1…`) are refused,
 * because the contract fixes the encryption to `age-v1-x25519`.
 *
 * FILES. The plaintext is read from a regular file opened without following a link; the ciphertext
 * is written to a new file (mode 0600, created exclusively) and synced. On any failure, or when the
 * caller's signal aborts, the partial ciphertext is removed.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { type FileHandle, open, unlink } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { bundleError, type ValidationResult } from '@rayspec/bundle-contract';
import { Encrypter } from 'age-encryption';

/** The `migration.encryption` value of a migration manifest. */
export const AGE_X25519_ENCRYPTION = 'age-v1-x25519';

/**
 * A native age X25519 recipient: the lowercase Bech32 string with the human-readable part `age`
 * and 32 data bytes (52 data characters and a 6-character checksum). The character class is the
 * Bech32 alphabet, which has no `1`, `b`, `i` or `o`, so `age1pq1…` and `age1tag1…` cannot match.
 */
const X25519_RECIPIENT = /^age1[02-9ac-hj-np-z]{58}$/;

/** The bytes read from the plaintext per step. */
const CHUNK_BYTES = 1024 * 1024;

/**
 * Whether `value` is an age X25519 recipient: the shape above and a valid Bech32 checksum, as the
 * library decodes it.
 */
export function isAgeX25519Recipient(value: unknown): value is string {
  if (typeof value !== 'string' || !X25519_RECIPIENT.test(value)) return false;
  try {
    new Encrypter().addRecipient(value);
    return true;
  } catch {
    return false;
  }
}

/** What `encryptFile` wrote. */
export interface EncryptedFile {
  /** The ciphertext file. */
  path: string;
  /** Its size in bytes. */
  size: number;
  /** The SHA-256 of its bytes. */
  sha256: string;
  /** The size of the plaintext it encrypts. */
  plaintextSize: number;
}

export interface EncryptOptions {
  /** Stops the encryption at the next chunk; the partial ciphertext is removed. */
  signal?: AbortSignal;
}

/** The encryption stopped because the caller's signal aborted. */
export class EncryptionAborted extends Error {
  constructor() {
    super('the encryption was stopped');
    this.name = 'EncryptionAborted';
  }
}

async function openPlaintext(path: string): Promise<FileHandle | null> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    if ((await handle.stat()).isFile()) return handle;
    await handle.close();
    return null;
  } catch {
    return null;
  }
}

/**
 * Encrypt the regular file `source` to `recipient` into the new file `destination`. Returns the
 * ciphertext's size and SHA-256, or the refusal: `RAY_USAGE` for a recipient that is not an X25519
 * recipient, a source that is not a regular file, or a destination that exists. Throws
 * `EncryptionAborted` when `options.signal` aborts; any other failure is `RAY_INTERNAL`. Either way
 * no partial ciphertext is left behind.
 */
export async function encryptFile(
  source: string,
  destination: string,
  recipient: string,
  options: EncryptOptions = {},
): Promise<ValidationResult<EncryptedFile>> {
  if (!isAgeX25519Recipient(recipient)) {
    return {
      ok: false,
      errors: [bundleError('RAY_USAGE', 'the recipient is not an age X25519 recipient (age1...)')],
    };
  }
  const input = await openPlaintext(source);
  if (input === null) {
    return {
      ok: false,
      errors: [bundleError('RAY_USAGE', 'the plaintext is not a regular file')],
    };
  }
  let output: FileHandle;
  try {
    output = await open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    await input.close();
    return {
      ok: false,
      errors: [bundleError('RAY_USAGE', 'the ciphertext file exists or cannot be created')],
    };
  }
  let written = false;
  try {
    const plaintextSize = (await input.stat()).size;
    const encrypter = new Encrypter();
    encrypter.addRecipient(recipient);
    const plaintext = Readable.toWeb(
      input.createReadStream({ highWaterMark: CHUNK_BYTES, autoClose: false }),
    ) as ReadableStream<Uint8Array>;
    const ciphertext = await encrypter.encrypt(plaintext);
    const hash = createHash('sha256');
    let size = 0;
    const reader = ciphertext.getReader();
    try {
      for (;;) {
        if (options.signal?.aborted === true) throw new EncryptionAborted();
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        size += value.length;
        await output.write(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    // The plaintext must not have changed while it was read: the ciphertext of exactly its bytes has
    // the size the format fixes for them.
    if (size !== ciphertext.size(plaintextSize) || (await input.stat()).size !== plaintextSize) {
      throw new Error('the plaintext changed while it was encrypted');
    }
    await output.sync();
    written = true;
    return {
      ok: true,
      value: { path: destination, size, sha256: hash.digest('hex'), plaintextSize },
    };
  } catch (err) {
    if (err instanceof EncryptionAborted) throw err;
    return {
      ok: false,
      errors: [bundleError('RAY_INTERNAL', 'the encryption failed unexpectedly')],
    };
  } finally {
    await output.close().catch(() => {});
    await input.close().catch(() => {});
    if (!written) await unlink(destination).catch(() => {});
  }
}
