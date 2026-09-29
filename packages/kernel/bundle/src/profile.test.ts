/**
 * The profile constants restate the writer profile of the contract, and the package manifest
 * agrees with the repository root and depends on nothing but the contract package.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DOS_DATE,
  DOS_TIME,
  EXTERNAL_ATTRIBUTES,
  INTERNAL_ATTRIBUTES,
  LOCAL_HEADER_SIGNATURE,
  METHOD_STORED,
  VERSION_MADE_BY,
  VERSION_NEEDED,
} from './profile.js';
import { loadExpectations, PACKAGE_ROOT } from './test-support/contract.js';

const { writerProfile } = loadExpectations();

describe('the writer profile', () => {
  it('the local header values are the contract values', () => {
    const l = writerProfile.localHeader;
    const signature = Buffer.alloc(4);
    signature.writeUInt32LE(LOCAL_HEADER_SIGNATURE);
    expect(signature.toString('hex').toUpperCase().match(/../g)!.join(' ')).toBe(l.signature);
    expect([l.versionNeeded, l.flags, l.method, l.dosTime, l.dosDate, l.extraLength]).toEqual([
      VERSION_NEEDED,
      0,
      METHOD_STORED,
      DOS_TIME,
      DOS_DATE,
      0,
    ]);
  });

  it('the central record values are the contract values', () => {
    expect(writerProfile.centralRecord).toEqual({
      versionMadeBy: VERSION_MADE_BY,
      versionNeeded: VERSION_NEEDED,
      flags: 0,
      method: METHOD_STORED,
      dosTime: DOS_TIME,
      dosDate: DOS_DATE,
      extraLength: 0,
      commentLength: 0,
      diskStart: 0,
      internalAttributes: INTERNAL_ATTRIBUTES,
      externalAttributes: EXTERNAL_ATTRIBUTES,
    });
    expect(writerProfile.endRecord).toEqual({ diskNumbers: 0, commentLength: 0 });
  });
});

interface Manifest {
  name: string;
  version: string;
  engines?: { node?: string };
  dependencies?: Record<string, string>;
}

describe('package manifest', () => {
  const read = (dir: string) =>
    JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest;
  const own = read(PACKAGE_ROOT);
  const root = read(join(PACKAGE_ROOT, '..', '..', '..'));

  it('carries the repository version and Node requirement', () => {
    expect(own.version).toBe(root.version);
    expect(own.engines?.node).toBe(root.engines?.node);
  });

  it('depends on the contract package and nothing else at run time', () => {
    expect(own.dependencies).toEqual({ '@rayspec/bundle-contract': 'workspace:*' });
  });
});
