/**
 * The golden bundle corpus of `@rayspec/bundle-contract`, located through the workspace dependency,
 * with the test signers the expectations name, and a capture of what the CLI writes.
 */
import { createHash, createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';
// The one case the corpus does not commit (10,005 entries) is built by construction with the bundle
// package's own raw ZIP helper, so the bytes are the ones that package checks against the recording.
import {
  baseFiles,
  bundleEntries,
  rawZip,
} from '../../../../kernel/bundle/src/test-support/raw-zip.js';

/** The raw ZIP helpers, for tests that build a bundle with a file of their own. */
export { bundleEntries, rawZip };

/** The files of the application base of the corpus, as name to bytes. */
export function baseFilesOf(expectations: Expectations): Map<string, Buffer> {
  return baseFiles(expectations as never);
}

const require = createRequire(import.meta.url);

export const CONTRACT_ROOT = join(dirname(require.resolve('@rayspec/bundle-contract')), '..');
export const CORPUS_DIR = join(CONTRACT_ROOT, 'corpus');
export const REPO_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
);
export const CLI_DIST = join(REPO_ROOT, 'packages/app/cli/dist/index.js');

/** A parsed JSON document, read field by field in assertions. */
// biome-ignore lint/suspicious/noExplicitAny: the shape is what the assertions check.
export type ParsedJson = Record<string, any>;

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
  description: string;
  construction: {
    rawBytes?: unknown;
    signature?: unknown;
    trustedSignerSeeds?: string[];
  };
  bytes: { size: number; sha256: string; committed: boolean };
  expect: CaseExpectation[];
}

export interface Expectations {
  runtimeProfiles: Record<string, { version: string }>;
  cases: CorpusCase[];
  bases: Record<
    string,
    { files: Record<string, { utf8: string }>; manifest: Record<string, unknown> }
  >;
}

export function loadExpectations(): Expectations {
  return JSON.parse(
    readFileSync(join(CONTRACT_ROOT, 'contract', 'fixtures', 'EXPECTATIONS.json'), 'utf8'),
  ) as Expectations;
}

/** The committed file of a case. */
export function corpusFile(c: CorpusCase): string {
  return join(CORPUS_DIR, `${c.id}${c.construction.rawBytes ? '.bin' : '.ray'}`);
}

/**
 * The path of a case's archive. A case that is not committed is written into `dir` first, and its
 * size and SHA-256 are checked against the recording before it is used.
 */
export function casePath(expectations: Expectations, c: CorpusCase, dir: string): string {
  if (c.bytes.committed) return corpusFile(c);
  if (c.id !== 'limit-entry-count') throw new Error(`no construction for ${c.id}`);
  const entries = bundleEntries(expectations as never);
  for (let i = 0; i < 10_000; i++) {
    entries.push({ name: `payload/f/${String(i).padStart(5, '0')}`, data: Buffer.alloc(0) });
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  const bytes = rawZip(entries);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== c.bytes.size || digest !== c.bytes.sha256) {
    throw new Error(`the generated ${c.id} does not match its recorded size and digest`);
  }
  const path = join(dir, `${c.id}.ray`);
  writeFileSync(path, bytes);
  return path;
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

/** Write a signer's public key as a PEM file and return its path. */
export function writePublicKeyPem(dir: string, name: string, key: KeyObject): string {
  const path = join(dir, `${name}.pub.pem`);
  writeFileSync(path, key.export({ format: 'pem', type: 'spki' }));
  return path;
}

/** Capture stdout and stderr; the CLI writes with the (chunk, callback) form. */
export function captureOutput(): { out: () => string; err: () => string } {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown, cb?: unknown): boolean => {
    outChunks.push(String(chunk));
    if (typeof cb === 'function') (cb as (e?: Error) => void)();
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown, cb?: unknown): boolean => {
    errChunks.push(String(chunk));
    if (typeof cb === 'function') (cb as (e?: Error) => void)();
    return true;
  });
  return { out: () => outChunks.join(''), err: () => errChunks.join('') };
}
