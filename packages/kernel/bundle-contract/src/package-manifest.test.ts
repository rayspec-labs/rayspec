/**
 * The package manifest agrees with the repository root on the version and the Node requirement.
 * The publish script refuses a publish target that disagrees on either, so a change to the root
 * that is not carried here fails now rather than when the package first joins the publish set.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PACKAGE_ROOT } from './test-support/contract-files.js';

interface Manifest {
  version: string;
  engines?: { node?: string };
}

const read = (dir: string) =>
  JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest;
const own = read(PACKAGE_ROOT);
const root = read(join(PACKAGE_ROOT, '..', '..', '..'));

describe('package manifest', () => {
  it('carries the repository version', () => {
    expect(own.version).toBe(root.version);
  });

  it('declares the Node requirement of the repository root', () => {
    expect(own.engines?.node).toBeDefined();
    expect(own.engines?.node).toBe(root.engines?.node);
  });
});
