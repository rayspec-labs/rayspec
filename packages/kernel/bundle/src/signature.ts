/**
 * Detached Ed25519 provenance signatures of a `.ray` archive, by convention `<file>.ray.sig`: a
 * canonical JSON file naming the archive's SHA-256, the SHA-256 of the signer's public key (DER
 * SubjectPublicKeyInfo) and the signature over `rayspec-ray-v1\nsha256:<archiveSha256>\n`.
 *
 * A signature establishes origin only when its signer is trusted; it is not proof that the code
 * in the archive is safe. Everything here uses Node's crypto; no key material is ever logged or
 * placed in a message.
 */
import { createHash, createPublicKey, type KeyObject, sign, verify } from 'node:crypto';
import {
  type BundleError,
  type BundleSignatureFile,
  bundleError,
  canonicalJsonFile,
  parseJsonDocument,
  schemaValidator,
  type ValidationResult,
} from '@rayspec/bundle-contract';

/** The domain string of a `.ray` signature; a release-manifest signature uses another one. */
const DOMAIN = 'rayspec-ray-v1';

/** A signature file is five short members; anything longer is not one. */
const MAX_SIGNATURE_FILE_BYTES = 4096;

const HEX_SHA256 = /^[a-f0-9]{64}$/;

/** The exact bytes an archive signature signs. */
export function signatureMessage(archiveSha256: string): Buffer {
  return Buffer.from(`${DOMAIN}\nsha256:${archiveSha256}\n`, 'ascii');
}

/** SHA-256 of an Ed25519 public key in DER SubjectPublicKeyInfo form. */
export function publicKeySha256(key: KeyObject): string {
  return createHash('sha256')
    .update(key.export({ format: 'der', type: 'spki' }))
    .digest('hex');
}

function isEd25519(key: unknown, type: 'public' | 'private'): key is KeyObject {
  return (
    typeof key === 'object' &&
    key !== null &&
    (key as KeyObject).type === type &&
    (key as KeyObject).asymmetricKeyType === 'ed25519'
  );
}

/**
 * The canonical signature file for an archive digest, signed with an Ed25519 private key. The
 * public key is derived from the private one, so the file always names the key that signed.
 */
export function createSignatureFile(
  archiveSha256: string,
  privateKey: KeyObject,
): ValidationResult<Buffer> {
  if (!HEX_SHA256.test(archiveSha256)) {
    return usage('the archive digest is not a lowercase hex SHA-256');
  }
  if (!isEd25519(privateKey, 'private'))
    return usage('the signing key is not an Ed25519 private key');
  const publicKey = createPublicKey(privateKey);
  const document: BundleSignatureFile = {
    signatureFormatVersion: 1,
    algorithm: 'ed25519',
    archiveSha256,
    publicKeySha256: publicKeySha256(publicKey),
    signature: sign(null, signatureMessage(archiveSha256), privateKey).toString('base64'),
  };
  return { ok: true, value: Buffer.from(canonicalJsonFile(document), 'utf8') };
}

/**
 * Verify a detached signature file against an archive digest and a set of trusted Ed25519 public
 * keys, in the contract's order: the file parses and has exactly the five members (`malformed`);
 * its digest is the archive's (`mismatch`); it names a trusted key (`untrusted-key`); the signature
 * verifies with that key (`mismatch`).
 */
export function verifySignatureFile(
  archiveSha256: string,
  signatureFile: Uint8Array,
  trustedKeys: readonly KeyObject[],
): ValidationResult<{ publicKeySha256: string }> {
  try {
    if (!HEX_SHA256.test(archiveSha256)) {
      return usage('the archive digest is not a lowercase hex SHA-256');
    }
    if (!Array.isArray(trustedKeys) || !trustedKeys.every((k) => isEd25519(k, 'public'))) {
      return usage('a trusted key is not an Ed25519 public key');
    }
    if (!(signatureFile instanceof Uint8Array)) return malformed();
    const parsed = parseJsonDocument(signatureFile, {
      maxBytes: MAX_SIGNATURE_FILE_BYTES,
      maxDepth: 1,
      canonical: false,
    });
    if (!parsed.ok || !schemaValidator('bundleSignatureFile')(parsed.value)) return malformed();
    const document = parsed.value as BundleSignatureFile;
    if (document.archiveSha256 !== archiveSha256) {
      return signatureRefused('mismatch', 'the signature is for another archive');
    }
    const key = trustedKeys.find((k) => publicKeySha256(k) === document.publicKeySha256);
    if (key === undefined) {
      return signatureRefused('untrusted-key', 'the signature names a key that is not trusted');
    }
    const signature = Buffer.from(document.signature, 'base64');
    if (signature.length !== 64 || !verify(null, signatureMessage(archiveSha256), key, signature)) {
      return signatureRefused('mismatch', 'the signature does not verify with the trusted key');
    }
    return { ok: true, value: { publicKeySha256: document.publicKeySha256 } };
  } catch {
    return {
      ok: false,
      errors: [bundleError('RAY_INTERNAL', 'verifying the signature failed unexpectedly')],
    };
  }
}

function malformed(): { ok: false; errors: BundleError[] } {
  return signatureRefused('malformed', 'the signature file is not a .ray signature document');
}

function signatureRefused(
  reason: 'malformed' | 'mismatch' | 'untrusted-key',
  message: string,
): { ok: false; errors: BundleError[] } {
  return { ok: false, errors: [bundleError('RAY_SIGNATURE_INVALID', message, { reason })] };
}

function usage(message: string): { ok: false; errors: BundleError[] } {
  return { ok: false, errors: [bundleError('RAY_USAGE', message)] };
}
