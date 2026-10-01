/**
 * age v1 encryption of a migration bundle's payload, with one X25519 recipient, and its decryption
 * with the matching X25519 identity.
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
 *
 * DECRYPTION (`decryptFile`) takes one X25519 identity (`AGE-SECRET-KEY-1…`, as `age-keygen` writes
 * it) and streams the ciphertext into a new private file. The plaintext budget is enforced twice:
 * against the size the format fixes for the ciphertext, before a byte is decrypted, and again while
 * the plaintext streams out, never trusting the ciphertext size as a plaintext budget. A wrong
 * identity, a passphrase file, a damaged header or any chunk that fails authentication is
 * `RAY_DECRYPTION_FAILED`, and the partial plaintext is removed: nothing decrypted is kept unless the
 * whole file authenticated.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { type FileHandle, open, unlink } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { bundleError, type ValidationResult } from '@rayspec/bundle-contract';
import { Decrypter, Encrypter } from 'age-encryption';

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

/** A native age X25519 identity: `AGE-SECRET-KEY-1` and the 58-character Bech32 rest, uppercase. */
const X25519_IDENTITY = /^AGE-SECRET-KEY-1[02-9AC-HJ-NP-Z]{58}$/;

/**
 * The one X25519 identity of an identity file as `age-keygen` writes it: comment lines (`#`) and
 * blank lines around exactly one `AGE-SECRET-KEY-1…` line. Null for anything else — a file with no
 * identity or more than one, a post-quantum or plugin identity, or a key whose checksum fails. The
 * caller registers the value with the redaction path and never prints it.
 */
export function parseAgeX25519Identity(text: string): string | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  if (lines.length !== 1 || !X25519_IDENTITY.test(lines[0]!)) return null;
  try {
    new Decrypter().addIdentity(lines[0]!);
    return lines[0]!;
  } catch {
    return null;
  }
}

export interface DecryptOptions {
  /** The largest plaintext accepted; a larger one is `RAY_LIMIT_EXCEEDED` `extracted-size`. */
  maxPlaintextBytes: number;
  /** Stops the decryption at the next chunk; the partial plaintext is removed. */
  signal?: AbortSignal;
}

/** What `decryptFile` wrote. */
export interface DecryptedFile {
  path: string;
  size: number;
  /** The SHA-256 of the ciphertext bytes that were read. */
  ciphertextSha256: string;
  ciphertextSize: number;
}

function decryptionFailed(): ValidationResult<DecryptedFile> {
  return {
    ok: false,
    errors: [
      bundleError(
        'RAY_DECRYPTION_FAILED',
        'the migration payload could not be decrypted with the identity file: it is not encrypted ' +
          'to that identity, or it is damaged. Nothing was imported',
      ),
    ],
  };
}

/**
 * Decrypt the regular file `source` with the X25519 `identity` into the new file `destination`
 * (mode 0600, created exclusively). Returns the plaintext's size and what was read, or the refusal:
 * `RAY_DECRYPTION_FAILED` for a wrong identity or damaged ciphertext, `RAY_LIMIT_EXCEEDED`
 * `extracted-size` for a plaintext over the budget, `RAY_USAGE` for a source that is not a regular
 * file or a destination that exists. Throws `EncryptionAborted` when the signal aborts. On every
 * path but success the destination is removed.
 */
export async function decryptFile(
  source: string,
  destination: string,
  identity: string,
  options: DecryptOptions,
): Promise<ValidationResult<DecryptedFile>> {
  const decrypter = new Decrypter();
  try {
    if (!X25519_IDENTITY.test(identity)) throw new Error('not an X25519 identity');
    decrypter.addIdentity(identity);
  } catch {
    return {
      ok: false,
      errors: [bundleError('RAY_USAGE', 'the identity is not an age X25519 identity')],
    };
  }
  const input = await openPlaintext(source);
  if (input === null) {
    return {
      ok: false,
      errors: [bundleError('RAY_USAGE', 'the ciphertext is not a regular file')],
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
      errors: [bundleError('RAY_USAGE', 'the plaintext file exists or cannot be created')],
    };
  }
  let written = false;
  try {
    const ciphertextSize = (await input.stat()).size;
    const hash = createHash('sha256');
    const counted = input
      .createReadStream({ highWaterMark: CHUNK_BYTES, autoClose: false })
      .on('data', (chunk) => {
        hash.update(chunk as Buffer);
      });
    const ciphertext = Readable.toWeb(counted) as ReadableStream<Uint8Array>;
    let plaintext: ReadableStream<Uint8Array>;
    let expected: number;
    try {
      const decrypted = await decrypter.decrypt(ciphertext);
      expected = decrypted.size(ciphertextSize);
      plaintext = decrypted;
    } catch {
      counted.destroy();
      return decryptionFailed();
    }
    const reader = plaintext.getReader();
    let size = 0;
    let unchanged = false;
    try {
      if (expected > options.maxPlaintextBytes) {
        return {
          ok: false,
          errors: [
            bundleError(
              'RAY_LIMIT_EXCEEDED',
              'the decrypted snapshot would be larger than the migration extracted byte limit',
              { reason: 'extracted-size' },
            ),
          ],
        };
      }
      for (;;) {
        if (options.signal?.aborted === true) throw new EncryptionAborted();
        let next: Awaited<ReturnType<typeof reader.read>>;
        try {
          next = await reader.read();
        } catch {
          return decryptionFailed();
        }
        if (next.done) break;
        size += next.value.length;
        if (size > options.maxPlaintextBytes) {
          return {
            ok: false,
            errors: [
              bundleError(
                'RAY_LIMIT_EXCEEDED',
                'the decrypted snapshot is larger than the migration extracted byte limit',
                { reason: 'extracted-size' },
              ),
            ],
          };
        }
        await output.write(next.value);
      }
      unchanged = (await input.stat()).size === ciphertextSize;
    } finally {
      await reader.cancel().catch(() => {});
      counted.destroy();
    }
    if (size !== expected || !unchanged) return decryptionFailed();
    await output.sync();
    written = true;
    return {
      ok: true,
      value: {
        path: destination,
        size,
        ciphertextSha256: hash.digest('hex'),
        ciphertextSize,
      },
    };
  } catch (err) {
    if (err instanceof EncryptionAborted) throw err;
    return {
      ok: false,
      errors: [
        bundleError(
          'RAY_INFRA_UNAVAILABLE',
          'the decrypted snapshot could not be written to the scratch directory',
        ),
      ],
    };
  } finally {
    await output.close().catch(() => {});
    await input.close().catch(() => {});
    if (!written) await unlink(destination).catch(() => {});
  }
}
