/**
 * `rayspec bundle sign` — write the detached Ed25519 provenance signature of a `.ray` bundle.
 *
 *   rayspec bundle sign <file.ray> --key-file <ed25519-private-key.pem> [--output <file.ray.sig>]
 *                       [--force] [--json]
 *
 * In order, stopping at the first failure:
 *
 *  1. The arguments: one archive, a key file, and a signature path (`--output`, else
 *     `<file.ray>.sig`, the file `bundle verify` and `deploy` read) that names neither of them.
 *  2. The key file, opened once without following a link and judged through that handle: a regular
 *     file owned by the invoking user that group and others can neither read nor write
 *     (`RAY_BINDINGS_FILE_INSECURE`), holding one unencrypted Ed25519 private key in PEM form. A
 *     public key, another algorithm or an encrypted key is a usage error.
 *  3. The bundle, through the structural steps of the one reader (budget, container, manifest,
 *     inventory), as `bundle inspect` reads it: never extracted, imported or run. Its archive
 *     SHA-256 is what the signature signs, so a bundle the reader refuses is refused here, before
 *     anything is written.
 *  4. The signature file, made by the bundle library's `createSignatureFile`, written to a temporary
 *     file beside the signature path, read back through the same handle and verified with
 *     `verifySignatureFile` against the public half of the key. A file that does not verify is a
 *     defect and never placed.
 *  5. Placement in one step: linked to the signature path, which fails when anything is there
 *     (`RAY_OUTPUT_EXISTS`), or with `--force` renamed over it, which replaces a file or a link
 *     without writing through it. The temporary file is removed on every outcome.
 *
 * One result envelope goes to stdout, with or without `--json`: the archive SHA-256, the signature
 * path and the SHA-256 of the public key, the value `bundle verify` reports for a signature it
 * verified. No output carries key material; a refusal names the flag and the path, never the file's
 * content. A signature says who signed the archive, for whoever trusts that key; it does not vouch
 * for the code the bundle carries.
 *
 * The import graph of this module is the bundle codec, the contract and Node's own modules: no
 * server, database layer or handler loader is loaded to sign a bundle.
 */
import { createPrivateKey, createPublicKey, type KeyObject, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createSignatureFile, inspectBundle, verifySignatureFile } from '@rayspec/bundle';
import {
  type BundleError,
  type BundleErrorCode,
  bundleError,
  type ReaderLimits,
} from '@rayspec/bundle-contract';
import { type BundleOutcome, errorLines, onePositional } from './bundle.js';
import { envelope, interruptedEnvelope, usageEnvelope } from './envelope.js';

const OPERATION = 'bundle.sign';

/** A private key file is a few hundred bytes; anything above this is not one. */
const MAX_KEY_FILE_BYTES = 16 * 1024;
/** The envelope schema's limit on `signaturePath`. */
const MAX_SIGNATURE_PATH = 4096;
/** One byte more than the largest signature file, so the read-back sees an oversized one. */
const SIGNATURE_READ_BYTES = 4097;
/** A PEM boundary starts with five dashes. */
const PEM_BEGIN = `${'-'.repeat(5)}BEGIN `;

export interface SignRunOptions {
  /** The operation id of this invocation. */
  operationId: string;
  /** Whether `--json` was given; index.ts takes the flag off the vector before the verb parses it. */
  json?: boolean;
  /** Raised by SIGINT or SIGTERM; checked before the signature file is placed. */
  signal?: AbortSignal;
  /** Reader limits lowered from the contract defaults, for a test that reaches a limit cheaply. */
  readerLimits?: Partial<ReaderLimits>;
}

/** The data of a `bundle sign` envelope. */
export interface SignData {
  bundleSha256: string;
  signaturePath: string;
  publicKeySha256: string;
}

interface SignArgs {
  file: string;
  keyFile: string;
  signaturePath: string;
  force: boolean;
  json: boolean;
}

/** A refusal at any step: the envelope's first error. */
class Refused extends Error {
  constructor(readonly error: BundleError) {
    super(error.message);
  }
}

function refuse(code: BundleErrorCode, message: string): never {
  throw new Refused(bundleError(code, message));
}

/** Run `rayspec bundle sign ...` (the arguments after `sign`). */
export async function runSign(
  args: readonly string[],
  options: SignRunOptions,
): Promise<BundleOutcome> {
  let parsed: SignArgs;
  try {
    parsed = parseSignArgs(args, options);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const result = usageEnvelope(OPERATION, options.operationId, `invalid arguments: ${message}`);
    return {
      envelope: result,
      summary: errorLines(result),
      json: options.json === true || args.includes('--json'),
    };
  }
  try {
    return await sign(parsed, options);
  } catch (e) {
    if (!(e instanceof Refused)) throw e;
    const result = envelope(OPERATION, options.operationId, null, [e.error]);
    return { envelope: result, summary: errorLines(result), json: parsed.json };
  }
}

function parseSignArgs(args: readonly string[], options: SignRunOptions): SignArgs {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      json: { type: 'boolean' },
      'key-file': { type: 'string' },
      output: { type: 'string' },
      force: { type: 'boolean' },
    },
  });
  const file = onePositional(positionals);
  const keyFile = values['key-file'];
  if (keyFile === undefined) {
    throw new Error('--key-file <ed25519-private-key.pem> is required: the key that signs');
  }
  if (keyFile === '') throw new Error('--key-file needs a file path');
  if (values.output === '') throw new Error('--output needs a file path');
  const signaturePath = values.output ?? `${file}.sig`;
  if (signaturePath.length > MAX_SIGNATURE_PATH) {
    throw new Error(`the signature path is longer than ${MAX_SIGNATURE_PATH} characters`);
  }
  if (resolve(signaturePath) === resolve(file)) {
    throw new Error('the signature path names the bundle itself; choose another --output');
  }
  if (resolve(signaturePath) === resolve(keyFile)) {
    throw new Error('the signature path names the key file; choose another --output');
  }
  return {
    file,
    keyFile,
    signaturePath,
    force: values.force === true,
    json: options.json === true || values.json === true,
  };
}

async function sign(args: SignArgs, options: SignRunOptions): Promise<BundleOutcome> {
  const { privateKey, publicKey } = await readSigningKey(args.keyFile);

  // Reader steps 1 to 9: the archive SHA-256 is computed over the bytes the reader checked.
  const read = await inspectBundle(args.file, {
    operation: 'verify',
    limits: options.readerLimits,
  });
  if (!read.ok) {
    const result = envelope(OPERATION, options.operationId, null, read.errors);
    return { envelope: result, summary: errorLines(result), json: args.json };
  }
  const { archiveSha256, manifest } = read.value;

  const created = createSignatureFile(archiveSha256, privateKey);
  if (!created.ok) throw new Refused(created.errors[0]!);

  const temporary = join(
    dirname(args.signaturePath),
    `.${basename(args.signaturePath)}.${randomBytes(8).toString('hex')}.tmp`,
  );
  try {
    const publicKeySha256 = await writeVerified(temporary, created.value, archiveSha256, publicKey);
    if (options.signal?.aborted) {
      const stopped = interruptedEnvelope(
        OPERATION,
        options.operationId,
        'nothing was written, so run the command again',
      );
      return { envelope: stopped, summary: errorLines(stopped), json: args.json };
    }
    await place(temporary, args.signaturePath, args.force);
    const data: SignData = {
      bundleSha256: archiveSha256,
      signaturePath: args.signaturePath,
      publicKeySha256,
    };
    return {
      envelope: envelope(OPERATION, options.operationId, data),
      summary: [
        `${manifest.application.id} ${manifest.application.version} — ${manifest.kind} bundle, sha256 ${archiveSha256}`,
        `signature written to ${args.signaturePath} and verified with the key's public half`,
        `public key sha256 ${publicKeySha256}: give that public key to whoever verifies, as`,
        `  rayspec bundle verify ${args.file} --trusted-key <public-key.pem> --require-signature`,
        'The signature says who signed this archive, for whoever trusts that key; it does not',
        '  vouch for the code the bundle carries.',
      ],
      json: args.json,
    };
  } finally {
    // After a link the temporary name is a second name of the placed file; after a rename it is
    // already gone. Either way nothing is left under the temporary name.
    await unlink(temporary).catch(() => {});
  }
}

// ─── the key file ──────────────────────────────────────────────────────────────────────────────

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

/**
 * The signing key: a protected file, opened once without following a link and judged through that
 * one handle, so a check by path and a read by path can never be answered by two different files.
 * Its content is never placed in a message.
 */
async function readSigningKey(
  path: string,
): Promise<{ privateKey: KeyObject; publicKey: KeyObject }> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') {
      refuse(
        'RAY_BINDINGS_FILE_INSECURE',
        `--key-file ${path} is a symbolic link; name the file itself`,
      );
    }
    if (code === 'ENOENT') refuse('RAY_USAGE', `--key-file ${path}: there is no file at that path`);
    refuse('RAY_USAGE', `--key-file ${path} cannot be opened`);
  }
  let text: string;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      refuse('RAY_BINDINGS_FILE_INSECURE', `--key-file ${path} is not a regular file`);
    }
    const uid = currentUid();
    if (uid !== undefined && stat.uid !== uid) {
      refuse(
        'RAY_BINDINGS_FILE_INSECURE',
        `--key-file ${path} is not owned by the user running the command`,
      );
    }
    if ((stat.mode & 0o077) !== 0) {
      refuse(
        'RAY_BINDINGS_FILE_INSECURE',
        `--key-file ${path} is readable or writable by group or others; restrict it with chmod 600`,
      );
    }
    const buffer = Buffer.alloc(MAX_KEY_FILE_BYTES + 1);
    let filled = 0;
    try {
      while (filled < buffer.length) {
        const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
    } catch {
      refuse('RAY_USAGE', `--key-file ${path} cannot be read`);
    }
    if (filled > MAX_KEY_FILE_BYTES) {
      refuse('RAY_USAGE', `--key-file ${path} is larger than a key file is (16 KiB)`);
    }
    text = buffer.subarray(0, filled).toString('utf8');
  } finally {
    await handle.close();
  }
  return parseSigningKey(path, text);
}

function parseSigningKey(
  path: string,
  text: string,
): { privateKey: KeyObject; publicKey: KeyObject } {
  if (text.split(PEM_BEGIN).length !== 2) {
    refuse('RAY_USAGE', `--key-file ${path} does not hold exactly one key in PEM form`);
  }
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: text, format: 'pem' });
  } catch {
    if (text.includes('ENCRYPTED PRIVATE KEY')) {
      refuse(
        'RAY_USAGE',
        `--key-file ${path} holds an encrypted key; give an unencrypted key file that only you can read`,
      );
    }
    if (isPublicKey(text)) {
      refuse('RAY_USAGE', `--key-file ${path} holds a public key; give the private key`);
    }
    refuse('RAY_USAGE', `--key-file ${path} is not a private key in PEM form`);
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    refuse(
      'RAY_USAGE',
      `--key-file ${path} is not an Ed25519 key (it is ${privateKey.asymmetricKeyType ?? 'unknown'})`,
    );
  }
  return { privateKey, publicKey: createPublicKey(privateKey) };
}

function isPublicKey(text: string): boolean {
  try {
    createPublicKey({ key: text, format: 'pem' });
    return true;
  } catch {
    return false;
  }
}

// ─── the signature file ────────────────────────────────────────────────────────────────────────

/**
 * Write the signature file to `temporary`, sync it, read it back through the same handle and
 * verify it against the public half of the key. Returns the public key SHA-256 the file names.
 */
async function writeVerified(
  temporary: string,
  bytes: Buffer,
  archiveSha256: string,
  publicKey: KeyObject,
): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      temporary,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o644,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      refuse('RAY_USAGE', 'the directory of the signature path does not exist');
    }
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
      refuse('RAY_USAGE', 'the directory of the signature path cannot be written');
    }
    throw error;
  }
  let readBack: Buffer;
  try {
    await handle.write(bytes, 0, bytes.length, 0);
    await handle.sync();
    const buffer = Buffer.alloc(SIGNATURE_READ_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    readBack = buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  const verified = verifySignatureFile(archiveSha256, readBack, [publicKey]);
  if (!verified.ok) {
    refuse('RAY_INTERNAL', "the written signature does not verify with the key's public half");
  }
  return verified.value.publicKeySha256;
}

/**
 * Move the finished signature file into place in one step. Without `force` it is linked, which
 * fails when anything exists at the signature path; with `force` it is renamed over it, which
 * replaces a file or a link and never writes through one.
 */
async function place(temporary: string, signaturePath: string, force: boolean): Promise<void> {
  try {
    if (force) await rename(temporary, signaturePath);
    else await link(temporary, signaturePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      refuse(
        'RAY_OUTPUT_EXISTS',
        `${signaturePath} already exists; pass --force to replace it, or choose another --output`,
      );
    }
    if (code === 'EISDIR' || code === 'ENOTEMPTY' || code === 'ENOTDIR' || code === 'ENOENT') {
      refuse('RAY_USAGE', `${signaturePath} cannot be replaced by a file`);
    }
    throw error;
  }
}
