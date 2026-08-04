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
 *
 * Length is the same collision by another route: Postgres stores only the first 63 bytes of an
 * identifier, so two names that differ only past that byte ARE one database. The cases below pin the
 * bound, the distinctness that must survive it, and — because a fix must not take an existing
 * developer's database away — that a name which already fits is returned unchanged.
 */
import { describe, expect, it } from 'vitest';
import { devDatabaseName } from './serve.js';

/** Postgres truncates any identifier past this many bytes (`NAMEDATALEN` - 1). */
const PG_MAX_IDENTIFIER_BYTES = 63;

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

  it('stays inside the 63-byte identifier limit for a directory name past 63 characters', () => {
    const name = devDatabaseName(`/repo/examples/${'a'.repeat(120)}/rayspec.yaml`);
    expect(Buffer.byteLength(name, 'utf8')).toBeLessThanOrEqual(PG_MAX_IDENTIFIER_BYTES);
    expect(name).toMatch(/^rayspec_local_[a-z0-9_]+$/);
  });

  it('keeps two backends whose directory names agree on their first 49 characters apart', () => {
    // 49 is the threshold: the `rayspec_local_` prefix is 14 bytes and the sanitizer maps every
    // character to one ASCII byte, so two directory names that agree that far used to be one database.
    for (const shared of ['b'.repeat(49), 'a'.repeat(120)]) {
      const a = devDatabaseName(`/repo/examples/${shared}_alpha/rayspec.yaml`);
      const b = devDatabaseName(`/repo/examples/${shared}_beta/rayspec.yaml`);
      // Distinct as JavaScript strings is NOT the property under test — Postgres compares what it
      // stored, which is the first 63 bytes.
      expect(a.slice(0, PG_MAX_IDENTIFIER_BYTES)).not.toBe(b.slice(0, PG_MAX_IDENTIFIER_BYTES));
      for (const name of [a, b]) {
        expect(Buffer.byteLength(name, 'utf8')).toBeLessThanOrEqual(PG_MAX_IDENTIFIER_BYTES);
        expect(name).toMatch(/^rayspec_local_[a-z0-9_]+$/);
      }
    }
  });

  it('separates two capped siblings by the spec-path digest, not by their directory names', () => {
    // What the cap buys is a bound, not distinctness: both names are capped, so their readable segment
    // is byte-identical and the digest is the ONLY thing left holding them apart. Pinned because the
    // derivation is documented as providing exactly this and no more — a 32-bit digest makes a
    // collision improbable, it does not make one impossible.
    const a = devDatabaseName(`/repo/examples/${'a'.repeat(60)}_alpha/rayspec.yaml`);
    const b = devDatabaseName(`/repo/examples/${'a'.repeat(60)}_beta/rayspec.yaml`);
    const shared = `rayspec_local_${'a'.repeat(40)}_`;
    for (const name of [a, b]) {
      expect(name.startsWith(shared)).toBe(true);
      expect(name.slice(shared.length)).toMatch(/^[0-9a-f]{8}$/);
      expect(Buffer.byteLength(name, 'utf8')).toBe(PG_MAX_IDENTIFIER_BYTES);
    }
    expect(a).not.toBe(b);
  });

  it('names a spec at a filesystem root without an empty segment', () => {
    expect(devDatabaseName('/rayspec.yaml')).toBe('rayspec_local_spec');
    expect(devDatabaseName('/dist/rayspec.yaml')).toBe('rayspec_local_spec_dist');
  });

  it('returns a name that already fits unchanged, so an existing dev database is kept', () => {
    expect(devDatabaseName('/repo/examples/acme-notes-backend/rayspec.yaml')).toBe(
      'rayspec_local_acme_notes_backend',
    );
    // 49 characters is the longest directory name that still fits whole: 14 + 49 = 63 bytes. It must
    // come back as the plain concatenation, with nothing appended to it.
    const longestThatFits = 'c'.repeat(49);
    expect(devDatabaseName(`/repo/examples/${longestThatFits}/rayspec.yaml`)).toBe(
      `rayspec_local_${longestThatFits}`,
    );
  });
});
