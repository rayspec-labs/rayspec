/**
 * The golden corpus under `corpus/` is exactly what the construction rules of
 * `contract/fixtures/EXPECTATIONS.json` build, and every case is fit for what it tests.
 *
 * The archive reader that consumes the byte-level cases ships separately; here each case is
 * rebuilt and byte-compared, its expectation is checked against the error vocabulary, and each
 * signature file is checked to carry exactly the defect it is named for. `validate.test.ts` runs
 * the cases whose outcome depends only on the manifest.
 */
import { createHash, verify } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { canonicalJsonFile } from './canonical-json.js';
import { ERROR_CODES, isBundleErrorCode } from './errors.js';
import { schemaValidator } from './schemas.js';
import { CORPUS_DIR, loadExpectations, readContractFile } from './test-support/contract-files.js';
import {
  buildCase,
  buildCorpus,
  caseFileName,
  PINNED_DEFLATE_STREAMS,
  raySignatureMessage,
  testSignerKey,
} from './test-support/corpus.js';

const expectations = loadExpectations();
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const built = new Map(
  expectations.cases.map((c) => [c.id, buildCase(expectations, c.construction).bytes]),
);

describe('corpus regeneration', () => {
  it('builds every case to the size and SHA-256 its expectation records', () => {
    expect(expectations.cases).toHaveLength(133);
    for (const c of expectations.cases) {
      const bytes = built.get(c.id)!;
      expect({ id: c.id, size: bytes.length, sha256: sha256(bytes) }).toEqual({
        id: c.id,
        size: c.bytes.size,
        sha256: c.bytes.sha256,
      });
    }
  });

  it('the committed corpus is byte-identical to a fresh build, with no stray file', () => {
    const fresh = buildCorpus(expectations);
    const committed = readdirSync(CORPUS_DIR).sort();
    expect(committed).toEqual([...fresh.keys()].sort());
    for (const [name, bytes] of fresh) {
      expect(readFileSync(join(CORPUS_DIR, name)).equals(bytes), name).toBe(true);
    }
  });

  it('commits every case except the one generated at test time', () => {
    const uncommitted = expectations.cases.filter((c) => !c.bytes.committed).map((c) => c.id);
    expect(uncommitted).toEqual(['limit-entry-count']);
    const committed = new Set(readdirSync(CORPUS_DIR));
    for (const c of expectations.cases) {
      expect(committed.has(caseFileName(c)), c.id).toBe(c.bytes.committed);
    }
  });

  it('the base application case is the contract fixture inspect-only.ray', () => {
    expect(
      built.get('app-good-minimal')!.equals(readContractFile('fixtures/inspect-only.ray')),
    ).toBe(true);
  });

  it('the pinned deflate stream inflates back to the entry it stands for', () => {
    for (const [inputSha256, hex] of PINNED_DEFLATE_STREAMS) {
      expect(sha256(inflateRawSync(Buffer.from(hex, 'hex')))).toBe(inputSha256);
    }
    const base = expectations.bases.application.files['payload/rayspec.yaml']!;
    expect(PINNED_DEFLATE_STREAMS.has(base.sha256)).toBe(true);
  });
});

describe('case expectations', () => {
  const verdicts: Record<string, [string, string]> = {
    'bundle.inspect': ['structurally-valid', 'invalid'],
    'bundle.verify': ['deployable', 'not-deployable'],
  };

  it('every expected code, reason and exit belongs to the closed vocabulary', () => {
    for (const c of expectations.cases) {
      expect(c.expect.length, c.id).toBeGreaterThan(0);
      for (const e of c.expect) {
        const [good, bad] = verdicts[e.operation]!;
        if (e.ok) {
          expect({ id: c.id, verdict: e.verdict, exit: e.exit, code: e.code }).toEqual({
            id: c.id,
            verdict: good,
            exit: 0,
            code: undefined,
          });
          continue;
        }
        expect(e.verdict, c.id).toBe(bad);
        expect(isBundleErrorCode(e.code!), `${c.id}: ${e.code}`).toBe(true);
        const entry = ERROR_CODES[e.code as keyof typeof ERROR_CODES];
        expect(e.exit, c.id).toBe(entry.exit);
        if (e.reason !== undefined) {
          expect(
            (entry.reasons as readonly string[]).includes(e.reason),
            `${c.id}: ${e.reason}`,
          ).toBe(true);
        } else {
          expect(entry.reasons.length, `${c.id}: ${e.code} needs a reason`).toBe(0);
        }
      }
    }
  });

  it('inspect and verify agree whenever inspect already refuses', () => {
    for (const c of expectations.cases) {
      const inspect = c.expect.find((e) => e.operation === 'bundle.inspect');
      const verifyExp = c.expect.find((e) => e.operation === 'bundle.verify');
      if (!inspect || inspect.ok || !verifyExp) continue;
      expect([verifyExp.code, verifyExp.reason], c.id).toEqual([inspect.code, inspect.reason]);
    }
  });

  it('the cases that need decryption, a database or a running source name vocabulary codes', () => {
    const cases = [...expectations.decryptionCases, ...expectations.integrationCases];
    expect(expectations.decryptionCases).toHaveLength(11);
    expect(expectations.integrationCases).toHaveLength(24);
    for (const x of cases) {
      const code = x.expect.code;
      if (code === undefined) continue;
      expect(isBundleErrorCode(code) || /^SPEC_[A-Z_]+$/.test(code), `${x.id}: ${code}`).toBe(true);
    }
  });
});

describe('raw-bytes cases', () => {
  it('archive-not-a-zip has no end-record signature anywhere', () => {
    const bytes = built.get('archive-not-a-zip')!;
    expect(bytes.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06]))).toBe(false);
  });

  it('archive-empty-zip is one end record announcing zero entries', () => {
    const bytes = built.get('archive-empty-zip')!;
    expect(bytes.length).toBe(22);
    expect(bytes.readUInt32LE(0)).toBe(0x06054b50);
    expect(bytes.readUInt16LE(10)).toBe(0);
  });
});

describe('signature cases', () => {
  const trustedKey = testSignerKey(expectations.testSigners.seeds[0]!);
  const signatureCases = expectations.cases.filter((c) => c.construction.signature);
  const files = buildCorpus(expectations);
  const documentOf = (id: string) => {
    const c = signatureCases.find((x) => x.id === id)!;
    const bytes = files.get(`${caseFileName(c)}.sig`)!;
    return { c, bytes, doc: JSON.parse(bytes.toString('utf8')) as Record<string, string> };
  };
  const verifies = (doc: Record<string, string>, key = trustedKey.publicKey) =>
    verify(
      null,
      raySignatureMessage(doc.archiveSha256!),
      key,
      Buffer.from(doc.signature!, 'base64'),
    );

  it('each signature file is canonical, schema-valid and equal to its recorded document', () => {
    expect(signatureCases.map((c) => c.id)).toEqual([
      'signature-good',
      'signature-untrusted',
      'signature-mismatch',
      'signature-flipped-bit',
    ]);
    const validate = schemaValidator('bundleSignatureFile');
    for (const c of signatureCases) {
      const { bytes, doc } = documentOf(c.id);
      expect(bytes.toString('utf8')).toBe(canonicalJsonFile(c.signatureFile!.document));
      expect(validate(doc), c.id).toBe(true);
    }
  });

  it('signature-good: trusted key, this archive, and the signature verifies', () => {
    const { doc } = documentOf('signature-good');
    expect(doc.archiveSha256).toBe(sha256(built.get('signature-good')!));
    expect(doc.publicKeySha256).toBe(trustedKey.publicKeySha256);
    expect(verifies(doc)).toBe(true);
  });

  it('signature-untrusted: a valid signature by a key that is not trusted', () => {
    const { doc } = documentOf('signature-untrusted');
    const other = testSignerKey(expectations.testSigners.seeds[1]!);
    expect(doc.archiveSha256).toBe(sha256(built.get('signature-untrusted')!));
    expect(doc.publicKeySha256).toBe(other.publicKeySha256);
    expect(doc.publicKeySha256).not.toBe(trustedKey.publicKeySha256);
    expect(verifies(doc, other.publicKey)).toBe(true);
  });

  it('signature-mismatch: a valid signature by the trusted key over another archive', () => {
    const { doc } = documentOf('signature-mismatch');
    expect(doc.archiveSha256).not.toBe(sha256(built.get('signature-mismatch')!));
    expect(doc.archiveSha256).toBe(sha256(built.get('app-good-scoped-package-paths')!));
    expect(verifies(doc)).toBe(true);
  });

  it('signature-flipped-bit: this archive and the trusted key, but the signature does not verify', () => {
    const { doc } = documentOf('signature-flipped-bit');
    expect(doc.archiveSha256).toBe(sha256(built.get('signature-flipped-bit')!));
    expect(doc.publicKeySha256).toBe(trustedKey.publicKeySha256);
    expect(verifies(doc)).toBe(false);
    const good = documentOf('signature-good').doc;
    const a = Buffer.from(good.signature!, 'base64');
    const b = Buffer.from(doc.signature!, 'base64');
    expect(a[0]! ^ b[0]!).toBe(1);
    expect(a.subarray(1).equals(b.subarray(1))).toBe(true);
  });
});
