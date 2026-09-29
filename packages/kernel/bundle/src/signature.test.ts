/**
 * Detached signatures: the verifier's order and reasons beyond the corpus cases, the canonical
 * form of what the signer writes, and the domain separation from release-manifest signatures.
 */
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { type BundleError, canonicalJsonFile, schemaValidator } from '@rayspec/bundle-contract';
import { describe, expect, it } from 'vitest';
import {
  createSignatureFile,
  publicKeySha256,
  signatureMessage,
  verifySignatureFile,
} from './index.js';
import { loadExpectations, testSigner } from './test-support/contract.js';

const expectations = loadExpectations();
const signer = testSigner(expectations.testSigners.seeds[0]!);
const other = testSigner(expectations.testSigners.seeds[1]!);
const digest = createHash('sha256').update('an archive').digest('hex');

const outcome = (r: { ok: true } | { ok: false; errors: BundleError[] }) =>
  r.ok ? 'ok' : `${r.errors[0]!.code}/${r.errors[0]!.reason ?? ''}`;

function signed(): Record<string, unknown> {
  const r = createSignatureFile(digest, signer.privateKey);
  if (!r.ok) throw new Error('signing failed');
  return JSON.parse(r.value.toString('utf8')) as Record<string, unknown>;
}
function withoutSignature(): Record<string, unknown> {
  const { signature: _drop, ...rest } = signed();
  return rest;
}
const file = (doc: unknown) => Buffer.from(canonicalJsonFile(doc), 'utf8');

describe('createSignatureFile', () => {
  it('writes the canonical, schema-valid document of the contract', () => {
    const r = createSignatureFile(digest, signer.privateKey);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const doc = JSON.parse(r.value.toString('utf8'));
    expect(r.value.toString('utf8')).toBe(canonicalJsonFile(doc));
    expect(schemaValidator('bundleSignatureFile')(doc)).toBe(true);
    expect(doc.publicKeySha256).toBe(publicKeySha256(signer.publicKey));
    // Ed25519 is deterministic, so the same digest and key give the same file.
    const again = createSignatureFile(digest, signer.privateKey);
    expect(again.ok && again.value.equals(r.value)).toBe(true);
  });

  it('signs exactly the ASCII message of the contract', () => {
    expect(signatureMessage(digest).toString('ascii')).toBe(`rayspec-ray-v1\nsha256:${digest}\n`);
  });

  it('refuses a digest that is not lowercase hex, and a key that is not Ed25519 private', () => {
    expect(outcome(createSignatureFile(digest.toUpperCase(), signer.privateKey))).toBe(
      'RAY_USAGE/',
    );
    expect(outcome(createSignatureFile(digest, signer.publicKey))).toBe('RAY_USAGE/');
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey;
    expect(outcome(createSignatureFile(digest, rsa))).toBe('RAY_USAGE/');
  });
});

describe('verifySignatureFile', () => {
  it('accepts a signature by a trusted key over this archive', () => {
    expect(
      outcome(verifySignatureFile(digest, file(signed()), [other.publicKey, signer.publicKey])),
    ).toBe('ok');
  });

  it.each([
    ['not JSON', Buffer.from('not json')],
    ['an extra member', file({ ...signed(), note: 'x' })],
    ['a missing member', file(withoutSignature())],
    ['another algorithm', file({ ...signed(), algorithm: 'rsa' })],
    ['another format version', file({ ...signed(), signatureFormatVersion: 2 })],
    ['a short signature', file({ ...signed(), signature: 'AAAA' })],
    ['an array', file([signed()])],
    ['a huge document', Buffer.from(`{"a":"${'x'.repeat(10_000)}"}`)],
  ])('refuses %s as malformed', (_label, bytes) => {
    expect(outcome(verifySignatureFile(digest, bytes, [signer.publicKey]))).toBe(
      'RAY_SIGNATURE_INVALID/malformed',
    );
  });

  it('checks the archive digest before the key, and the key before the signature', () => {
    const forOther = { ...signed(), archiveSha256: 'f'.repeat(64) };
    expect(outcome(verifySignatureFile(digest, file(forOther), []))).toBe(
      'RAY_SIGNATURE_INVALID/mismatch',
    );
    const flipped = signed();
    const bytes = Buffer.from(flipped.signature as string, 'base64');
    bytes[10] = bytes[10]! ^ 0x80;
    flipped.signature = bytes.toString('base64');
    expect(outcome(verifySignatureFile(digest, file(flipped), [other.publicKey]))).toBe(
      'RAY_SIGNATURE_INVALID/untrusted-key',
    );
    expect(outcome(verifySignatureFile(digest, file(flipped), [signer.publicKey]))).toBe(
      'RAY_SIGNATURE_INVALID/mismatch',
    );
  });

  it('a signature over the release-manifest domain never verifies as a .ray signature', () => {
    const doc = signed();
    doc.signature = sign(
      null,
      Buffer.from(`rayspec-release-manifest-v1\nsha256:${digest}\n`, 'ascii'),
      signer.privateKey,
    ).toString('base64');
    expect(outcome(verifySignatureFile(digest, file(doc), [signer.publicKey]))).toBe(
      'RAY_SIGNATURE_INVALID/mismatch',
    );
  });

  it('refuses usage errors: a bad digest or a trusted key that is not an Ed25519 public key', () => {
    expect(outcome(verifySignatureFile('abc', file(signed()), [signer.publicKey]))).toBe(
      'RAY_USAGE/',
    );
    expect(outcome(verifySignatureFile(digest, file(signed()), [signer.privateKey]))).toBe(
      'RAY_USAGE/',
    );
    expect(outcome(verifySignatureFile(digest, file(signed()), null as never))).toBe('RAY_USAGE/');
    expect(outcome(verifySignatureFile(digest, 'text' as never, [signer.publicKey]))).toBe(
      'RAY_SIGNATURE_INVALID/malformed',
    );
  });
});
