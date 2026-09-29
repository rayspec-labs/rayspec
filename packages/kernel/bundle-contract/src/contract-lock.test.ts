/**
 * The committed contract files are exactly the ones the contract lock names.
 *
 * `contract/CONTRACT-LOCK.json` records the SHA-256 of every file of the contract and one digest
 * over that file map: SHA-256 of the compact JSON of `{path: sha256}` with keys sorted. The
 * package commits every JSON, schema and fixture file of the contract byte for byte; the prose
 * documents stay with the contract and are covered here only through the lock's digest.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONTRACT_DIR,
  PACKAGE_ROOT,
  readContractFile,
  readContractJson,
} from './test-support/contract-files.js';
import { renderSchemasModule } from './test-support/schemas-module.js';
import { CONTRACT_VERSION } from './vocabulary.js';

interface ContractLock {
  status: string;
  contractVersion: string;
  digestAlgorithm: string;
  digest: string;
  files: Record<string, string>;
}

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

function committedContractFiles(dir = CONTRACT_DIR): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...committedContractFiles(full));
    else out.push(relative(CONTRACT_DIR, full).split(sep).join('/'));
  }
  return out.sort();
}

const lock = readContractJson<ContractLock>('CONTRACT-LOCK.json');

describe('contract lock', () => {
  it('its digest is the SHA-256 of its sorted, compact file map', () => {
    expect(lock.digestAlgorithm).toBe('sha256-of-canonical-file-map');
    const sorted = Object.fromEntries(
      Object.keys(lock.files)
        .sort()
        .map((k) => [k, lock.files[k]]),
    );
    expect(sha256(JSON.stringify(sorted))).toBe(lock.digest);
    expect(lock.digest).toBe('30dcafcb4a712d3ebd05f083e1719bd99dbb6e006d395b8fbec491a23a354e4d');
  });

  it('every committed contract file hashes to its lock entry', () => {
    const files = committedContractFiles().filter((f) => f !== 'CONTRACT-LOCK.json');
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(lock.files[file], `${file} is not in the lock`).toBeDefined();
      expect(sha256(readContractFile(file)), file).toBe(lock.files[file]);
    }
  });

  it('commits every file of the lock except the prose documents', () => {
    const committed = new Set(committedContractFiles());
    const left = Object.keys(lock.files).filter((f) => !committed.has(f));
    expect(left.length).toBeGreaterThan(0);
    expect(left.every((f) => f.endsWith('.md'))).toBe(true);
    for (const f of Object.keys(lock.files)) {
      if (!f.endsWith('.md')) expect(committed.has(f), f).toBe(true);
    }
  });

  it('every contract file states the version the package carries', () => {
    expect(lock.contractVersion).toBe(CONTRACT_VERSION);
    for (const f of [
      'capabilities.json',
      'cli-verbs.json',
      'error-codes.json',
      'reserved-bindings.json',
      'snapshot-categories.json',
      'fixtures/EXPECTATIONS.json',
    ]) {
      expect(readContractJson(f).contractVersion, f).toBe(CONTRACT_VERSION);
    }
    for (const f of [
      'ray-manifest.schema.json',
      'snapshot.schema.json',
      'managed-receipt.schema.json',
      'release-manifest.schema.json',
    ]) {
      expect(String(readContractJson(f).$comment), f).toContain(`contract ${CONTRACT_VERSION}.`);
    }
  });

  it('the generated schema module is current with the committed schemas', () => {
    const committed = readFileSync(join(PACKAGE_ROOT, 'src', 'schemas.gen.ts'), 'utf8');
    expect(committed).toBe(renderSchemasModule(CONTRACT_DIR));
  });
});
