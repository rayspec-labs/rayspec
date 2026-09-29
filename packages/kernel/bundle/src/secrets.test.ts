/**
 * The secret scan: the path rule, and the streaming private-key automaton checked against the
 * contract's pattern as a regular expression, on generated text split at every chunk boundary.
 */
import { describe, expect, it } from 'vitest';
import { isSecretPath, PrivateKeyScanner } from './index.js';

/** The content rule of the contract as a regular expression over the whole text. */
const PEM_HEADER = /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/;

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
    ['-----BEGIN PRIVATE KEY-----', true],
    ['-----BEGIN RSA PRIVATE KEY-----', true],
    ['-----BEGIN ENCRYPTED PRIVATE KEY-----', true],
    ['-----BEGIN OPENSSH PRIVATE KEY-----', true],
    ['x------BEGIN EC PRIVATE KEY-----y', true],
    ['-----BEGIN PRIVATE PRIVATE KEY-----', true],
    ['-----BEGIN PUBLIC KEY-----', false],
    ['-----BEGIN rsa PRIVATE KEY-----', false],
    ['-----BEGIN RSA  PRIVATE KEY-----', false],
    ['-----BEGIN PRIVATE KEY----', false],
    ['-----BEGINPRIVATE KEY-----', false],
    ['----BEGIN PRIVATE KEY-----', false],
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
    const text = `${'x'.repeat(100_000)}-----BEGIN DSA PRIVATE KEY-----`;
    expect(scan([...Buffer.from(text)].map((b) => Buffer.from([b])))).toBe(true);
  });
});
