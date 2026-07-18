/**
 * `rayspec init` — deterministic tests (no Postgres).
 *
 * The load-bearing (fail-the-fix) assertion is the ROUND-TRIP: the scaffolded `rayspec.yaml` is parsed
 * back through the SAME parser `doctor` uses (`runDoctor`) and must validate ok:true — a malformed
 * starter template fails here, not silently at a user's first `deploy`. The rest proves the
 * fail-closed behaviour: no clobber without --force, --force overwrites, a target subdir is created, a
 * `..`-escape is rejected, and no secret ever leaks into the output.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runDoctor } from './doctor.js';
import { runInit, SPEC_FILENAME, STARTER_SPEC } from './init.js';

let dir: string;
let prevCwd: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayspec-init-'));
  // init writes relative to CWD + jails to it — run from the temp dir so relative paths resolve there.
  prevCwd = process.cwd();
  process.chdir(dir);
});

afterEach(() => {
  // Remove any scaffolded file/dir between cases so each starts clean.
  rmSync(join(dir, SPEC_FILENAME), { force: true });
  rmSync(join(dir, 'sub'), { recursive: true, force: true });
});

afterAll(() => {
  process.chdir(prevCwd);
  rmSync(dir, { recursive: true, force: true });
});

describe('init — scaffolds a valid starter (round-trip through the doctor parser)', () => {
  it('writes rayspec.yaml and the generated spec validates ok:true', async () => {
    const r = await runInit([]);
    expect(r.ok).toBe(true);
    expect(r.created).toEqual([SPEC_FILENAME]);
    expect(r.path).toBe(SPEC_FILENAME);
    expect(existsSync(join(dir, SPEC_FILENAME))).toBe(true);

    // FAIL-THE-FIX: the file on disk must parse+validate through the real doctor path.
    const d = await runDoctor([SPEC_FILENAME]);
    expect(d.ok).toBe(true);
    expect(d.errors).toEqual([]);
  });

  it('the exported STARTER_SPEC constant itself is a valid spec (matches what is written)', async () => {
    // Write the constant directly under a distinct name and validate it — guards against the constant
    // and the on-disk output diverging, and pins the template as valid independent of the write path.
    writeFileSync(join(dir, 'starter-check.yaml'), STARTER_SPEC, 'utf8');
    try {
      const d = await runDoctor(['starter-check.yaml']);
      expect(d.ok).toBe(true);
      expect(d.errors).toEqual([]);
    } finally {
      rmSync(join(dir, 'starter-check.yaml'), { force: true });
    }
  });

  it('the starter is a generic, product-neutral template', () => {
    // The shipped starter carries no product identity — only generic placeholder names.
    expect(STARTER_SPEC).toContain('name: my-backend');
    expect(STARTER_SPEC).toContain('name: items');
    // No branded "<Proper Noun> Notes/CRM/App"-style identifier leaks into the template.
    expect(STARTER_SPEC).not.toMatch(/\b[A-Z][a-z]+ (Notes|CRM|App)\b/);
  });
});

describe('init — target directory', () => {
  it('scaffolds into a positional subdirectory, creating it if absent', async () => {
    const r = await runInit(['sub']);
    expect(r.ok).toBe(true);
    expect(r.created).toEqual([join('sub', SPEC_FILENAME)]);
    expect(existsSync(join(dir, 'sub', SPEC_FILENAME))).toBe(true);
  });

  it('rejects a `..`-escaping target directory (structural jail)', async () => {
    await expect(runInit(['../escape'])).rejects.toThrow(/escapes the working directory/i);
  });

  it('rejects more than one target directory', async () => {
    await expect(runInit(['a', 'b'])).rejects.toThrow(/at most one target directory/i);
  });

  it('rejects an unknown flag (usage error → thrown)', async () => {
    await expect(runInit(['--nope'])).rejects.toThrow(/invalid arguments/i);
  });
});

describe('init — never clobbers without --force', () => {
  it('refuses to overwrite an existing rayspec.yaml (ok:false, file untouched)', async () => {
    writeFileSync(join(dir, SPEC_FILENAME), 'PRE-EXISTING CONTENT', 'utf8');
    const r = await runInit([]);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.code)).toContain('spec_exists');
    // The existing file must be untouched.
    expect(readFileSync(join(dir, SPEC_FILENAME), 'utf8')).toBe('PRE-EXISTING CONTENT');
  });

  it('--force overwrites an existing rayspec.yaml with the starter', async () => {
    writeFileSync(join(dir, SPEC_FILENAME), 'PRE-EXISTING CONTENT', 'utf8');
    const r = await runInit(['--force']);
    expect(r.ok).toBe(true);
    expect(readFileSync(join(dir, SPEC_FILENAME), 'utf8')).toBe(STARTER_SPEC);
  });
});

describe('init — no secret leak', () => {
  it('output never contains DB-URL / credential substrings', async () => {
    process.env.DATABASE_URL = 'postgres://secretuser:secretpass@db.internal:5432/prod';
    try {
      const okJson = JSON.stringify(await runInit([]));
      rmSync(join(dir, SPEC_FILENAME), { force: true });
      writeFileSync(join(dir, SPEC_FILENAME), 'x', 'utf8');
      const errJson = JSON.stringify(await runInit([]));
      for (const blob of [okJson, errJson]) {
        expect(blob).not.toContain('secretpass');
        expect(blob).not.toContain('postgres://');
      }
    } finally {
      process.env.DATABASE_URL = undefined;
    }
  });
});
