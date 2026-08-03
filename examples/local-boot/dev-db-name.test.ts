/**
 * The dev DB name derivation.
 *
 * The wrapper gives each spec its own throwaway database so two backends authored side by side never
 * boot into the same one — the second boot DROPs and re-creates it, so a collision destroys the first
 * backend's data rather than merely sharing it.
 *
 * The case with teeth is a spec inside a build-output directory. A bundled build step writes
 * `<backend>/dist/rayspec.yaml`, so a derivation that reads only the spec's own directory name hands
 * EVERY built backend the same name. Reverting the `dist` arm REDs the two cases that name it.
 */
import { describe, expect, it } from 'vitest';
import { devDatabaseName } from './serve.js';

describe('devDatabaseName', () => {
  it('names an authored backend after its directory', () => {
    expect(devDatabaseName('/repo/examples/expense-claim-coder/rayspec.yaml')).toBe(
      'rayspec_local_expense_claim_coder',
    );
  });

  it('names a BUILT backend after the backend, not after the output directory', () => {
    expect(devDatabaseName('/repo/examples/expense-claim-coder/dist/rayspec.yaml')).toBe(
      'rayspec_local_expense_claim_coder_dist',
    );
  });

  it('keeps two DIFFERENT built backends on different databases', () => {
    const a = devDatabaseName('/repo/examples/expense-claim-coder/dist/rayspec.yaml');
    const b = devDatabaseName('/repo/examples/acme-notes-backend/dist/rayspec.yaml');
    expect(a).not.toBe(b);
    // Both must still be the sanitized shape, not just distinct.
    for (const name of [a, b]) expect(name).toMatch(/^rayspec_local_[a-z0-9_]+$/);
  });

  it('separates a backend from its own build output', () => {
    expect(devDatabaseName('/repo/examples/acme-notes-backend/rayspec.yaml')).not.toBe(
      devDatabaseName('/repo/examples/acme-notes-backend/dist/rayspec.yaml'),
    );
  });

  it('sanitizes a directory name that is not a safe identifier', () => {
    expect(devDatabaseName('/repo/examples/My-Backend.v2/rayspec.yaml')).toBe(
      'rayspec_local_my_backend_v2',
    );
  });

  it('is stable across a relative and an absolute path to the same spec', () => {
    const abs = devDatabaseName(`${process.cwd()}/examples/expense-claim-coder/rayspec.yaml`);
    expect(devDatabaseName('examples/expense-claim-coder/rayspec.yaml')).toBe(abs);
  });
});
