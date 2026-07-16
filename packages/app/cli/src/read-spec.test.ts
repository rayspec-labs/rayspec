/**
 * unit tests — `readSpecFile` reads a spec fail-closed through a SINGLE file handle (open → fstat →
 * bounded read), so there is no `statSync`→`open` check-then-use race. Asserts the read is correct and
 * every fail-closed kind (not_found / not_a_file / too_large) is preserved, and the bounded-read cap holds.
 *
 * Runs inside a temp dir set as the CWD (so realpath + the CWD re-jail resolve to in-tree paths).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_SPEC_BYTES,
  ReadSpecError,
  type ReadSpecErrorKind,
  readSpecFile,
} from './read-spec.js';

let tmp: string;
let cwd: string;

beforeEach(() => {
  cwd = process.cwd();
  tmp = mkdtempSync(join(cwd, '__readspec_'));
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(cwd);
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

/** Resolve an in-CWD name to the absolute path readSpecFile expects. */
function abs(name: string): string {
  return resolve(process.cwd(), name);
}

/** Read + assert it rejected with a specific ReadSpecError kind. */
async function readKind(name: string): Promise<ReadSpecErrorKind> {
  const err = await readSpecFile(abs(name)).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ReadSpecError);
  return (err as ReadSpecError).kind;
}

describe('readSpecFile — single-handle read (no stat→open race)', () => {
  it('reads a regular spec file correctly', async () => {
    const body = 'version: "1.0"\nmetadata:\n  name: demo\n';
    writeFileSync(join(tmp, 'spec.yaml'), body, 'utf8');
    expect(await readSpecFile(abs('spec.yaml'))).toBe(body);
  });

  it('a UTF-8 multibyte spec round-trips byte-for-byte through the bounded read', async () => {
    const body = '# räyspec — üñïçödé ✓\nname: "café"\n';
    writeFileSync(join(tmp, 'u.yaml'), body, 'utf8');
    expect(await readSpecFile(abs('u.yaml'))).toBe(body);
  });

  it('a missing file → not_found', async () => {
    expect(await readKind('nope.yaml')).toBe('not_found');
  });

  it('a directory → not_a_file (fstat on the opened handle rejects a non-regular file)', async () => {
    mkdirSync(join(tmp, 'adir'));
    expect(await readKind('adir')).toBe('not_a_file');
  });

  it('a file at exactly the cap reads fully (bounded read preserved)', async () => {
    const body = 'a'.repeat(MAX_SPEC_BYTES);
    writeFileSync(join(tmp, 'atcap.yaml'), body, 'utf8');
    const out = await readSpecFile(abs('atcap.yaml'));
    expect(out.length).toBe(MAX_SPEC_BYTES);
    expect(out).toBe(body);
  });

  it('a file over the cap → too_large', async () => {
    writeFileSync(join(tmp, 'big.yaml'), 'a'.repeat(MAX_SPEC_BYTES + 1), 'utf8');
    expect(await readKind('big.yaml')).toBe('too_large');
  });
});
