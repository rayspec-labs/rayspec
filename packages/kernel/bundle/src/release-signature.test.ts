/**
 * The detached signature of a release manifest: the canonical document the release key writes,
 * the verifier's order and reasons, and the separation from `.ray` signatures in both directions.
 */
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { type BundleError, canonicalJsonFile, schemaValidator } from '@rayspec/bundle-contract';
import { describe, expect, it } from 'vitest';
import {
  createReleaseSignatureFile,
  createSignatureFile,
  publicKeySha256,
  releaseSignatureMessage,
  verifyReleaseSignatureFile,
  verifySignatureFile,
} from './index.js';
import { loadExpectations, testSigner } from './test-support/contract.js';

const expectations = loadExpectations();
const releaseKey = testSigner(expectations.testSigners.seeds[0]!);
const otherKey = testSigner(expectations.testSigners.seeds[1]!);
const digest = createHash('sha256').update('a release manifest').digest('hex');

const outcome = (r: { ok: true } | { ok: false; errors: BundleError[] }) =>
  r.ok ? 'ok' : `${r.errors[0]!.code}/${r.errors[0]!.reason ?? ''}`;
const file = (doc: unknown) => Buffer.from(canonicalJsonFile(doc), 'utf8');

function signed(): Record<string, unknown> {
  const r = createReleaseSignatureFile(digest, releaseKey.privateKey);
  if (!r.ok) throw new Error('signing failed');
  return JSON.parse(r.value.toString('utf8')) as Record<string, unknown>;
}

describe('createReleaseSignatureFile', () => {
  it('writes the canonical document of the release manifest schema', () => {
    const r = createReleaseSignatureFile(digest, releaseKey.privateKey);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const doc = JSON.parse(r.value.toString('utf8'));
    expect(r.value.toString('utf8')).toBe(canonicalJsonFile(doc));
    expect(schemaValidator('releaseManifest', '/$defs/signatureFile')(doc)).toBe(true);
    expect(doc).toMatchObject({
      signatureFormatVersion: 1,
      algorithm: 'ed25519',
      releaseManifestSha256: digest,
      publicKeySha256: publicKeySha256(releaseKey.publicKey),
    });
  });

  it('signs exactly the ASCII message of the contract', () => {
    expect(releaseSignatureMessage(digest).toString('ascii')).toBe(
      `rayspec-release-manifest-v1\nsha256:${digest}\n`,
    );
  });

  it('refuses a digest that is not lowercase hex, and a key that is not Ed25519 private', () => {
    expect(outcome(createReleaseSignatureFile(digest.toUpperCase(), releaseKey.privateKey))).toBe(
      'RAY_USAGE/',
    );
    expect(outcome(createReleaseSignatureFile(digest, releaseKey.publicKey))).toBe('RAY_USAGE/');
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    expect(outcome(createReleaseSignatureFile(digest, ec))).toBe('RAY_USAGE/');
  });
});

describe('verifyReleaseSignatureFile', () => {
  it('verifies a signature by a trusted release key', () => {
    const r = verifyReleaseSignatureFile(digest, file(signed()), [releaseKey.publicKey]);
    expect(r).toEqual({
      ok: true,
      value: { publicKeySha256: publicKeySha256(releaseKey.publicKey) },
    });
  });

  it('refuses a document that is not the five-member signature file as malformed', () => {
    const extra = { ...signed(), comment: 'x' };
    expect(outcome(verifyReleaseSignatureFile(digest, file(extra), [releaseKey.publicKey]))).toBe(
      'RAY_SIGNATURE_INVALID/malformed',
    );
    const archiveShaped = { ...signed(), archiveSha256: digest };
    delete archiveShaped.releaseManifestSha256;
    expect(
      outcome(verifyReleaseSignatureFile(digest, file(archiveShaped), [releaseKey.publicKey])),
    ).toBe('RAY_SIGNATURE_INVALID/malformed');
    expect(
      outcome(verifyReleaseSignatureFile(digest, Buffer.from('not json'), [releaseKey.publicKey])),
    ).toBe('RAY_SIGNATURE_INVALID/malformed');
  });

  it('refuses a signature for another manifest before looking at the key', () => {
    const other = createHash('sha256').update('another manifest').digest('hex');
    expect(other).not.toBe(digest);
    expect(outcome(verifyReleaseSignatureFile(other, file(signed()), []))).toBe(
      'RAY_SIGNATURE_INVALID/mismatch',
    );
  });

  it('refuses a key that is not trusted', () => {
    expect(outcome(verifyReleaseSignatureFile(digest, file(signed()), [otherKey.publicKey]))).toBe(
      'RAY_SIGNATURE_INVALID/untrusted-key',
    );
  });

  it('refuses a signature that does not verify with the trusted key', () => {
    const doc = signed();
    const raw = Buffer.from(String(doc.signature), 'base64');
    raw[0] = (raw[0] ?? 0) ^ 0xff;
    doc.signature = raw.toString('base64');
    expect(outcome(verifyReleaseSignatureFile(digest, file(doc), [releaseKey.publicKey]))).toBe(
      'RAY_SIGNATURE_INVALID/mismatch',
    );
  });

  it('a .ray signature over the same digest never verifies as a release signature', () => {
    const ray = createSignatureFile(digest, releaseKey.privateKey);
    expect(ray.ok).toBe(true);
    if (!ray.ok) return;
    expect(outcome(verifyReleaseSignatureFile(digest, ray.value, [releaseKey.publicKey]))).toBe(
      'RAY_SIGNATURE_INVALID/malformed',
    );
    // The same five members with the signature made under the .ray domain: the shape passes, the
    // signature does not.
    const doc = signed();
    doc.signature = sign(
      null,
      Buffer.from(`rayspec-ray-v1\nsha256:${digest}\n`, 'ascii'),
      releaseKey.privateKey,
    ).toString('base64');
    expect(outcome(verifyReleaseSignatureFile(digest, file(doc), [releaseKey.publicKey]))).toBe(
      'RAY_SIGNATURE_INVALID/mismatch',
    );
  });

  it('a release signature never verifies as a .ray signature', () => {
    expect(outcome(verifySignatureFile(digest, file(signed()), [releaseKey.publicKey]))).toBe(
      'RAY_SIGNATURE_INVALID/malformed',
    );
  });

  it('refuses usage errors: a bad digest or a trusted key that is not an Ed25519 public key', () => {
    expect(outcome(verifyReleaseSignatureFile('abc', file(signed()), [releaseKey.publicKey]))).toBe(
      'RAY_USAGE/',
    );
    expect(
      outcome(verifyReleaseSignatureFile(digest, file(signed()), [releaseKey.privateKey])),
    ).toBe('RAY_USAGE/');
    expect(
      outcome(verifyReleaseSignatureFile(digest, 'text' as never, [releaseKey.publicKey])),
    ).toBe('RAY_SIGNATURE_INVALID/malformed');
  });
});
