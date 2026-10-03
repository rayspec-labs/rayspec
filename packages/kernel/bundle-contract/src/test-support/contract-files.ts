/**
 * Paths to the committed contract files and corpus, and the shape of
 * `contract/fixtures/EXPECTATIONS.json`, for the tests and the generators.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CONTRACT_DIR = join(PACKAGE_ROOT, 'contract');
export const CORPUS_DIR = join(PACKAGE_ROOT, 'corpus');

export function readContractFile(relative: string): Buffer {
  return readFileSync(join(CONTRACT_DIR, relative));
}

export function readContractJson<T = Record<string, unknown>>(relative: string): T {
  return JSON.parse(readContractFile(relative).toString('utf8')) as T;
}

export function loadExpectations(): Expectations {
  return readContractJson<Expectations>('fixtures/EXPECTATIONS.json');
}

// ─── the shape of EXPECTATIONS.json ───────────────────────────────────────────────────────────

export interface CaseExpectation {
  operation: 'bundle.inspect' | 'bundle.verify';
  runtimeProfile?: string;
  ok: boolean;
  verdict: string;
  code?: string;
  reason?: string;
  exit: number;
}

export interface SignatureConstruction {
  signerSeed: string;
  over: string;
  flipFirstByte?: boolean;
}

export interface Construction {
  base?: 'application' | 'migration';
  files?: { op: 'add' | 'remove'; name: string; utf8?: string; hex?: string }[];
  inventory?: 'recompute' | 'base';
  undeclared?: string[];
  manifestPatch?: PatchOperation[];
  manifestBytes?: Record<string, unknown>;
  archive?: ArchiveOperation[];
  rawBytes?: { hex: string; repeat?: number };
  readerLimits?: Record<string, number>;
  signature?: SignatureConstruction;
  trustedSignerSeeds?: string[];
}

export interface CorpusCase {
  id: string;
  layer: string;
  description: string;
  construction: Construction;
  bytes: { size: number; sha256: string; committed: boolean };
  signatureFile?: { size: number; sha256: string; document: Record<string, unknown> };
  expect: CaseExpectation[];
}

export interface Expectations {
  contractVersion: string;
  bases: Record<'application' | 'migration', BaseDefinition>;
  readerLimitsDefault: Record<string, number>;
  runtimeProfiles: Record<string, { version: string; target: Record<string, unknown> }>;
  testSigners: { seeds: string[] };
  /** The construction rules; `pinnedDeflateStreams` maps an entry's SHA-256 to its deflate stream. */
  construction: { pinnedDeflateStreams: Record<string, string> };
  cases: CorpusCase[];
  documentCases: { id: string; schema: string; document: unknown; valid: boolean }[];
  decryptionCases: { id: string; operation: string; expect: { code?: string } }[];
  integrationCases: { id: string; operation: string; expect: { code?: string } }[];
}

export interface BaseDefinition {
  files: Record<string, { utf8: string; size: number; sha256: string }>;
  manifest: Record<string, unknown>;
}

export type PatchOperation =
  | { op: 'add' | 'replace'; path: string; value: unknown }
  | { op: 'remove'; path: string }
  | { op: 'copy'; path: string; from: string };

export type ArchiveOperation = { op: string } & Record<string, unknown>;
