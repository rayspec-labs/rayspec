/**
 * The committed contract files and golden corpus of `@rayspec/bundle-contract`, located through
 * the workspace dependency, and the test signers and runtime profiles the expectations name.
 */
import { createHash, createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPABILITIES, type RuntimeProfile } from '@rayspec/bundle-contract';

const require = createRequire(import.meta.url);

/** The root of the contract package: its entry is `dist/index.js`. */
export const CONTRACT_PACKAGE_ROOT = join(
  dirname(require.resolve('@rayspec/bundle-contract')),
  '..',
);
export const CORPUS_DIR = join(CONTRACT_PACKAGE_ROOT, 'corpus');
export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface CaseExpectation {
  operation: 'bundle.inspect' | 'bundle.verify';
  runtimeProfile?: string;
  ok: boolean;
  verdict: string;
  code?: string;
  reason?: string;
  exit: number;
}

export interface CorpusCase {
  id: string;
  layer: string;
  description: string;
  construction: {
    base?: 'application' | 'migration';
    rawBytes?: { hex: string; repeat?: number };
    readerLimits?: Record<string, number>;
    signature?: { signerSeed: string; over: string; flipFirstByte?: boolean };
    trustedSignerSeeds?: string[];
    archive?: ({ op: string } & Record<string, unknown>)[];
  };
  bytes: { size: number; sha256: string; committed: boolean };
  expect: CaseExpectation[];
}

export interface Expectations {
  bases: Record<
    'application' | 'migration',
    {
      files: Record<string, { utf8: string; size: number; sha256: string }>;
      manifest: Record<string, unknown>;
    }
  >;
  writerProfile: {
    localHeader: Record<string, number | string>;
    centralRecord: Record<string, number>;
    endRecord: Record<string, number>;
  };
  readerLimitsDefault: Record<string, number>;
  runtimeProfiles: Record<
    string,
    { version: string; target: { os: string; arch: string; nodeMajor: number } }
  >;
  testSigners: { seeds: string[] };
  cases: CorpusCase[];
}

export function loadExpectations(): Expectations {
  return JSON.parse(
    readFileSync(join(CONTRACT_PACKAGE_ROOT, 'contract', 'fixtures', 'EXPECTATIONS.json'), 'utf8'),
  ) as Expectations;
}

/** The committed file of a case. */
export function corpusFile(c: CorpusCase): string {
  return join(CORPUS_DIR, `${c.id}${c.construction.rawBytes ? '.bin' : '.ray'}`);
}

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** The Ed25519 key of a test signer: its 32-byte seed is SHA-256 of the public seed text. */
export function testSigner(seedText: string): { privateKey: KeyObject; publicKey: KeyObject } {
  const seed = createHash('sha256').update(seedText).digest();
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  return { privateKey, publicKey: createPublicKey(privateKey) };
}

/**
 * A runtime profile of the expectations as the admission check takes it. Every profile provides
 * the capabilities with status `available`; `without-static-frontend` lacks that one.
 */
export function runtimeProfile(expectations: Expectations, name: string): RuntimeProfile {
  const profile = expectations.runtimeProfiles[name];
  if (profile === undefined) throw new Error(`unknown runtime profile ${name}`);
  const available = CAPABILITIES.filter((c) => c.status === 'available').map((c) => c.id);
  return {
    version: profile.version,
    targets: [profile.target],
    capabilities:
      name === 'without-static-frontend'
        ? available.filter((id) => id !== 'static-frontend')
        : available,
  };
}
