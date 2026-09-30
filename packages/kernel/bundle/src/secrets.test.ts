/**
 * The secret scan: the path rule, and the streaming private-key automaton checked against the
 * contract's pattern as a regular expression, on generated text split at every chunk boundary.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isSecretPath, PrivateKeyScanner } from './index.js';
import { PACKAGE_ROOT } from './test-support/contract.js';

/**
 * Five dashes, joined into every header at run time. A header written out whole in this file would be
 * reported by the repository's own secret scan, so none is.
 */
const D = '-'.repeat(5);

/** The content rule of the contract as a regular expression over the whole text. */
const PEM_HEADER = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/;

function scan(chunks: readonly Buffer[]): boolean {
  const scanner = new PrivateKeyScanner();
  for (const chunk of chunks) scanner.update(chunk);
  return scanner.found;
}

describe('the path rule', () => {
  it.each([
    ['payload/.env', true],
    ['payload/app/.env.local', true],
    ['payload/.env.', true],
    ['payload/id_rsa', true],
    ['payload/keys/id_ecdsa', true],
    ['payload/id_ed25519', true],
    ['payload/.pgpass', true],
    ['payload/env', false],
    ['payload/.envrc', false],
    ['payload/id_rsa.pub', false],
    ['payload/.env/readme', false],
    ['payload/my.env', false],
  ])('%s is %s', (path, refused) => {
    expect(isSecretPath(path)).toBe(refused);
  });
});

describe('the private-key header', () => {
  it.each([
    [`${D}BEGIN PRIVATE KEY${D}`, true],
    [`${D}BEGIN RSA PRIVATE KEY${D}`, true],
    [`${D}BEGIN ENCRYPTED PRIVATE KEY${D}`, true],
    [`${D}BEGIN OPENSSH PRIVATE KEY${D}`, true],
    [`x-${D}BEGIN EC PRIVATE KEY${D}y`, true],
    [`${D}BEGIN PRIVATE PRIVATE KEY${D}`, true],
    [`${D}BEGIN SM2 PRIVATE KEY${D}`, true],
    [`${D}BEGIN X25519 PRIVATE KEY${D}`, true],
    [`${D}BEGIN ED448 PRIVATE KEY${D}`, true],
    [`${D}BEGIN 2 PRIVATE KEY${D}`, true],
    [`${D}BEGIN SM-2 PRIVATE KEY${D}`, false],
    [`${D}BEGIN PUBLIC KEY${D}`, false],
    [`${D}BEGIN rsa PRIVATE KEY${D}`, false],
    [`${D}BEGIN RSA  PRIVATE KEY${D}`, false],
    [`${D}BEGIN PRIVATE KEY----`, false],
    [`${D}BEGINPRIVATE KEY${D}`, false],
    [`----BEGIN PRIVATE KEY${D}`, false],
  ])('%s is %s', (text, found) => {
    expect(scan([Buffer.from(text)])).toBe(found);
    expect(PEM_HEADER.test(text)).toBe(found);
  });

  it('agrees with the pattern on generated text, split at every boundary', () => {
    let seed = 0x5eed_0005;
    const next = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed >>> 16;
    };
    const parts = [
      '-',
      '-----',
      '-----BEGIN ',
      'BEGIN',
      'PRIVATE KEY-----',
      'PRIVATE ',
      'KEY',
      'RSA ',
      'X25519 ',
      '2',
      ' ',
      'A',
      'a',
      '\n',
    ];
    let positives = 0;
    for (let i = 0; i < 2000; i++) {
      const text = Array.from(
        { length: 1 + (next() % 8) },
        () => parts[next() % parts.length],
      ).join('');
      const want = PEM_HEADER.test(text);
      if (want) positives++;
      const bytes = Buffer.from(text);
      expect(scan([bytes]), text).toBe(want);
      for (let cut = 1; cut < bytes.length; cut++) {
        expect(scan([bytes.subarray(0, cut), bytes.subarray(cut)]), `${text} @${cut}`).toBe(want);
      }
    }
    expect(positives).toBeGreaterThan(10);
  });

  it('finds a header that arrives one byte per chunk after a long run of other bytes', () => {
    const text = `${'x'.repeat(100_000)}${D}BEGIN DSA PRIVATE KEY${D}`;
    expect(scan([...Buffer.from(text)].map((b) => Buffer.from([b])))).toBe(true);
  });
});

describe('the package files', () => {
  it('hold no private-key header, so the repository secret scan stays clean', () => {
    const files = [
      join(PACKAGE_ROOT, 'README.md'),
      ...readdirSync(join(PACKAGE_ROOT, 'src'), { recursive: true, withFileTypes: true })
        .filter((d) => d.isFile())
        .map((d) => join(d.parentPath, d.name)),
    ];
    expect(files.length).toBeGreaterThan(20);
    const carrying = files
      .filter((f) => scan([readFileSync(f)]))
      .map((f) => relative(PACKAGE_ROOT, f));
    expect(carrying).toEqual([]);
  });
});
