/**
 * `rayspec doctor` — deterministic tests (no Postgres).
 *
 * Proves the static validity check wraps `parseSpec` faithfully (the WHOLE result, not a shape):
 *  - a valid spec → ok:true, no errors;
 *  - an invalid spec → ok:false with the EXPECTED closed error codes/paths (not just "some error");
 *  - the fail-closed file reading (missing arg / non-file / `..`-escape / oversized) → ok:false;
 *  - no secret substrings ever appear in the output (defence-in-depth — doctor takes no secrets, but
 *    the no-leak invariant is asserted so a future change cannot quietly start echoing env).
 */
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runDoctor } from './doctor.js';
import { MAX_SPEC_BYTES } from './read-spec.js';

const VALID_SPEC = `
version: '1.0'
metadata:
  name: doctor-test
stores:
  - name: things
    columns:
      - { name: title, type: text }
`;

let dir: string;
let validPath: string;
let prevCwd: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayspec-doctor-'));
  validPath = join(dir, 'rayspec.yaml');
  writeFileSync(validPath, VALID_SPEC, 'utf8');
  // doctor resolves paths relative to CWD + jails to it — run from the temp dir so relative paths work.
  prevCwd = process.cwd();
  process.chdir(dir);
});

afterAll(() => {
  process.chdir(prevCwd);
  rmSync(dir, { recursive: true, force: true });
});

describe('doctor — valid spec', () => {
  it('returns ok:true with no errors for a valid spec', async () => {
    const r = await runDoctor(['rayspec.yaml']);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });
});

describe('doctor — Product-YAML docs (validateAnySpec routing)', () => {
  it('returns ok:true for a valid Product-YAML doc', async () => {
    writeFileSync(
      join(dir, 'p-ok.yaml'),
      'version: "1.0"\nproduct:\n  id: acme_notes\n  name: Acme Notes\n',
      'utf8',
    );
    const r = await runDoctor(['p-ok.yaml']);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('validates the Product-YAML sections (not a useless "version missing"): a dangling ref is rejected', async () => {
    // `status: available` is doc-valid now (wiredness moved to the deploy composition); the
    // invalid vehicle here is a DANGLING `requires` ref — a genuine doc-level defect.
    writeFileSync(
      join(dir, 'p-bad.yaml'),
      'version: "1.0"\nproduct:\n  id: p\n  name: P\nrequires:\n  capabilities:\n    - ghost\n',
      'utf8',
    );
    const r = await runDoctor(['p-bad.yaml']);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.code)).toContain('dangling_ref');
  });

  it('moves the no-code-in-YAML guardrail into the parser: a handler module path is rejected', async () => {
    writeFileSync(
      join(dir, 'p-code.yaml'),
      'version: "1.0"\nproduct:\n  id: p\n  name: P\nviews:\n  - id: v\n    route: { method: GET, path: "/x" }\n    module: handlers/x.ts\n    response_contract: p.r\n',
      'utf8',
    );
    const r = await runDoctor(['p-code.yaml']);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.code)).toContain('no_code_in_yaml');
  });
});

describe('doctor — invalid specs (exact closed error codes/paths)', () => {
  it('flags an unsupported version with code unsupported_version', async () => {
    writeFileSync(join(dir, 'badver.yaml'), "version: '9.9'\nmetadata: { name: x }\n", 'utf8');
    const r = await runDoctor(['badver.yaml']);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.code)).toContain('unsupported_version');
    expect(r.errors.find((e) => e.code === 'unsupported_version')?.path).toBe('version');
  });

  it('flags an unknown top-level field with code unknown_field at its key', async () => {
    writeFileSync(
      join(dir, 'unknown.yaml'),
      "version: '1.0'\nmetadata: { name: x }\nbogus: 1\n",
      'utf8',
    );
    const r = await runDoctor(['unknown.yaml']);
    expect(r.ok).toBe(false);
    const f = r.errors.find((e) => e.code === 'unknown_field');
    expect(f).toBeDefined();
    expect(f?.path).toBe('bogus');
  });

  it('flags a reserved injected column name with code reserved_column_name', async () => {
    // `tenant_id` is an INJECTED tenancy column — a store may not declare it (lint: reserved_column_name).
    writeFileSync(
      join(dir, 'reserved.yaml'),
      "version: '1.0'\nmetadata: { name: x }\nstores:\n  - name: t\n    columns:\n      - { name: tenant_id, type: uuid }\n",
      'utf8',
    );
    const r = await runDoctor(['reserved.yaml']);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.code)).toContain('reserved_column_name');
  });

  it('flags malformed YAML with code yaml_parse_error', async () => {
    writeFileSync(join(dir, 'broken.yaml'), 'version: "1.0"\n  : : :\n', 'utf8');
    const r = await runDoctor(['broken.yaml']);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.code)).toContain('yaml_parse_error');
  });

  it('aggregates the FULL violation list, not just the first', async () => {
    // Two unknown fields → two unknown_field errors (parseSpec aggregates).
    writeFileSync(
      join(dir, 'multi.yaml'),
      "version: '1.0'\nmetadata: { name: x }\nfoo: 1\nbar: 2\n",
      'utf8',
    );
    const r = await runDoctor(['multi.yaml']);
    expect(r.ok).toBe(false);
    const unknownPaths = r.errors.filter((e) => e.code === 'unknown_field').map((e) => e.path);
    expect(unknownPaths).toEqual(expect.arrayContaining(['foo', 'bar']));
  });
});

describe('doctor — fail-closed file reading', () => {
  it('rejects a missing path arg (ok:false, not a crash)', async () => {
    const r = await runDoctor([]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.message).toMatch(/exactly one spec path/i);
  });

  it('rejects more than one path arg', async () => {
    const r = await runDoctor(['a.yaml', 'b.yaml']);
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.message).toMatch(/exactly one spec path/i);
  });

  it('rejects a non-existent file', async () => {
    const r = await runDoctor(['does-not-exist.yaml']);
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.message).toMatch(/not found/i);
  });

  it('rejects a directory (not a regular file)', async () => {
    const r = await runDoctor(['.']); // the cwd is a directory
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.message).toMatch(/not a regular file/i);
  });

  it('rejects a `..`-escaping path (structural jail)', async () => {
    const r = await runDoctor(['../escape.yaml']);
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.message).toMatch(/escapes the working directory/i);
  });

  it('rejects an oversized file (> MAX_SPEC_BYTES)', async () => {
    const bigPath = join(dir, 'big.yaml');
    writeFileSync(bigPath, 'x'.repeat(MAX_SPEC_BYTES + 100), 'utf8');
    const r = await runDoctor(['big.yaml']);
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.message).toMatch(/cap/i);
  });

  it('rejects a symlink to a directory (not a regular file after symlink resolution)', async () => {
    const linkPath = join(dir, 'dirlink.yaml');
    symlinkSync(dir, linkPath);
    const r = await runDoctor(['dirlink.yaml']);
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.message).toMatch(/not a regular file/i);
  });

  it('rejects an in-CWD symlink to a regular FILE OUTSIDE the CWD (re-jailed real target)', async () => {
    // The lexical pre-check passes (the typed path `outlink.yaml` is inside the CWD), but the symlink
    // RESOLVES to a real file OUTSIDE the CWD. Re-applying the jail to the resolved target rejects it.
    const outsideDir = mkdtempSync(join(tmpdir(), 'rayspec-outside-'));
    const outsideFile = join(outsideDir, 'secret.yaml');
    writeFileSync(outsideFile, "version: '1.0'\nmetadata: { name: x }\n", 'utf8');
    const linkPath = join(dir, 'outlink.yaml');
    symlinkSync(outsideFile, linkPath);
    try {
      const r = await runDoctor(['outlink.yaml']);
      expect(r.ok).toBe(false);
      expect(r.errors[0]?.message).toMatch(/outside the working directory/i);
    } finally {
      rmSync(linkPath, { force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

describe('doctor — no secret leak', () => {
  it('output never contains DB-URL / credential substrings', async () => {
    // Plant a couple of secret-shaped env vars; doctor must never surface them.
    process.env.DATABASE_URL = 'postgres://secretuser:secretpass@db.internal:5432/prod';
    process.env.SHADOW_DATABASE_URL = 'postgres://shadowuser:shadowpass@db.internal:5432/shadow';
    try {
      const okJson = JSON.stringify(await runDoctor(['rayspec.yaml']));
      const errJson = JSON.stringify(await runDoctor(['does-not-exist.yaml']));
      for (const blob of [okJson, errJson]) {
        expect(blob).not.toContain('secretpass');
        expect(blob).not.toContain('shadowpass');
        expect(blob).not.toContain('postgres://');
      }
    } finally {
      process.env.DATABASE_URL = undefined;
      process.env.SHADOW_DATABASE_URL = undefined;
    }
  });
});
