/**
 * Every case of the golden corpus runs through the reader and gives exactly the verdict, code and
 * reason its expectation states, for inspection and for extraction. No case is skipped: the one
 * case that is not committed (10,005 entries) is generated here and checked against its recorded
 * size and digest first.
 *
 * The verify expectations run through the steps this package and the contract package provide:
 * the reader, the runtime admission checks, the secret scan and the signature. Four cases fail
 * verification only at the spec steps, which parse the spec from the payload and live with the
 * spec parser; for those the test asserts that every step here passes and that the expected code
 * is one only a spec step emits.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BundleError, checkRuntimeAdmission } from '@rayspec/bundle-contract';
import { afterAll, describe, expect, it } from 'vitest';
import { extractBundle, inspectBundle } from './index.js';
import { verifySignatureFile } from './signature.js';
import {
  type CaseExpectation,
  type CorpusCase,
  corpusFile,
  loadExpectations,
  runtimeProfile,
  testSigner,
} from './test-support/contract.js';
import { bundleEntries, type RawEntry, rawZip } from './test-support/raw-zip.js';

const expectations = loadExpectations();
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** The case built by construction rather than committed: the base plus 10,000 empty entries. */
function generatedEntryCountCase(): Buffer {
  const entries: RawEntry[] = bundleEntries(expectations);
  for (let i = 0; i < 10_000; i++) {
    entries.push({ name: `payload/f/${String(i).padStart(5, '0')}`, data: Buffer.alloc(0) });
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  return rawZip(entries);
}

const generated = new Map<string, Buffer>([['limit-entry-count', generatedEntryCountCase()]]);

function caseBytes(c: CorpusCase): Buffer {
  return c.bytes.committed ? readFileSync(corpusFile(c)) : generated.get(c.id)!;
}

const outcome = (r: { ok: true } | { ok: false; errors: BundleError[] }) =>
  r.ok ? { ok: true } : { ok: false, code: r.errors[0]!.code, reason: r.errors[0]!.reason };

const expected = (e: CaseExpectation) =>
  e.ok ? { ok: true } : { ok: false, code: e.code, reason: e.reason };

const inspectCases = expectations.cases.filter((c) =>
  c.expect.some((e) => e.operation === 'bundle.inspect'),
);
const verifyCases = expectations.cases.filter((c) =>
  c.expect.some((e) => e.operation === 'bundle.verify'),
);

describe('the corpus', () => {
  it('is complete: every case has an expectation this suite runs', () => {
    expect(expectations.cases).toHaveLength(133);
    const covered = new Set([...inspectCases, ...verifyCases].map((c) => c.id));
    expect(covered.size).toBe(expectations.cases.length);
  });

  it('the generated case matches the size and digest its expectation records', () => {
    for (const c of expectations.cases.filter((x) => !x.bytes.committed)) {
      const bytes = generated.get(c.id);
      expect(bytes, c.id).toBeDefined();
      expect({ size: bytes!.length, sha256: sha256(bytes!) }).toEqual({
        size: c.bytes.size,
        sha256: c.bytes.sha256,
      });
    }
  });

  it('every committed case is byte-identical to the digest its expectation records', () => {
    for (const c of expectations.cases.filter((x) => x.bytes.committed)) {
      expect(sha256(readFileSync(corpusFile(c))), c.id).toBe(c.bytes.sha256);
    }
  });
});

describe('inspection', () => {
  it.each(inspectCases.map((c) => [c.id, c] as const))('%s', async (_id, c) => {
    const want = c.expect.find((e) => e.operation === 'bundle.inspect')!;
    const limits = c.construction.readerLimits;
    const fromFile = c.bytes.committed
      ? await inspectBundle(corpusFile(c), { limits })
      : await inspectBundle(caseBytes(c), { limits });
    expect(outcome(fromFile)).toEqual(expected(want));
    const fromBytes = await inspectBundle(caseBytes(c), { limits });
    expect(outcome(fromBytes)).toEqual(expected(want));
    if (fromFile.ok) expect(fromFile.value.archiveSha256).toBe(c.bytes.sha256);
  });
});

describe('extraction', () => {
  const sandboxes: string[] = [];
  afterAll(() => {
    for (const s of sandboxes) rmSync(s, { recursive: true, force: true });
  });

  it.each(
    inspectCases.map((c) => [c.id, c] as const),
  )('%s writes only under its root, and nothing when refused', async (_id, c) => {
    const want = c.expect.find((e) => e.operation === 'bundle.inspect')!;
    const sandbox = mkdtempSync(join(tmpdir(), 'rayspec-bundle-extract-'));
    sandboxes.push(sandbox);
    const root = join(sandbox, 'out');
    const r = await extractBundle(caseBytes(c), root, { limits: c.construction.readerLimits });
    expect(outcome(r)).toEqual(expected(want));
    if (!r.ok) {
      expect(readdirSync(sandbox)).toEqual([]);
      return;
    }
    expect(readdirSync(sandbox)).toEqual(['out']);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    const written = listFiles(root);
    const listed = [...r.value.manifest.inventory.map((e) => e.path), 'ray.json'].sort();
    expect(written).toEqual(listed);
    for (const entry of r.value.manifest.inventory) {
      const file = join(root, entry.path);
      expect(sha256(readFileSync(file))).toBe(entry.sha256);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });
});

function listFiles(root: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const d of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix === '' ? d.name : `${prefix}/${d.name}`;
    if (d.isDirectory()) out.push(...listFiles(root, rel));
    else if (d.isFile()) out.push(rel);
    else throw new Error(`unexpected file type at ${rel}`);
  }
  return out.sort();
}

// ─── verification ──────────────────────────────────────────────────────────────────────────────

/** The cases whose verify outcome is decided by the spec steps, and the codes those steps emit. */
const SPEC_STEP_CASES = [
  'semantic-requires-mismatch',
  'semantic-execution-mismatch',
  'semantic-egress-mismatch',
  'spec-invalid',
];
const SPEC_STEP_OUTCOMES = [
  { code: 'RAY_MANIFEST_INVALID', reason: 'requires-mismatch' },
  { code: 'RAY_MANIFEST_INVALID', reason: 'execution-mismatch' },
  { code: 'RAY_MANIFEST_INVALID', reason: 'permissions-mismatch' },
  { code: 'RAY_SPEC_INVALID', reason: undefined },
];

/** The verify steps this package and the contract package provide, in pipeline order. */
async function verifyWithoutSpec(c: CorpusCase, e: CaseExpectation) {
  const inspected = await inspectBundle(caseBytes(c), { limits: c.construction.readerLimits });
  if (!inspected.ok) return outcome(inspected);
  const admitted = checkRuntimeAdmission(
    inspected.value.manifest,
    runtimeProfile(expectations, e.runtimeProfile ?? 'fixture'),
  );
  if (!admitted.ok) return outcome(admitted);
  if (inspected.value.secretFindings.length > 0) {
    return { ok: false, code: 'RAY_SECRET_DETECTED', reason: undefined };
  }
  if (c.construction.signature !== undefined) {
    const trusted = (c.construction.trustedSignerSeeds ?? []).map((s) => testSigner(s).publicKey);
    const signature = readFileSync(`${corpusFile(c)}.sig`);
    return outcome(verifySignatureFile(inspected.value.archiveSha256, signature, trusted));
  }
  return { ok: true };
}

describe('verification', () => {
  it('only the four spec-step cases depend on a step outside this package', () => {
    const spec = verifyCases.filter((c) => {
      const e = c.expect.find((x) => x.operation === 'bundle.verify')!;
      return SPEC_STEP_OUTCOMES.some((o) => o.code === e.code && o.reason === e.reason);
    });
    expect(spec.map((c) => c.id).sort()).toEqual([...SPEC_STEP_CASES].sort());
  });

  it.each(verifyCases.map((c) => [c.id, c] as const))('%s', async (id, c) => {
    const want = c.expect.find((e) => e.operation === 'bundle.verify')!;
    const got = await verifyWithoutSpec(c, want);
    if (SPEC_STEP_CASES.includes(id)) {
      // Everything before the spec steps passes, and only a spec step can refuse it.
      expect(got).toEqual({ ok: true });
      return;
    }
    expect(got).toEqual(expected(want));
  });

  it('the signature cases have their signature files next to them', () => {
    for (const c of verifyCases.filter((x) => x.construction.signature !== undefined)) {
      expect(existsSync(`${corpusFile(c)}.sig`), c.id).toBe(true);
    }
  });
});
