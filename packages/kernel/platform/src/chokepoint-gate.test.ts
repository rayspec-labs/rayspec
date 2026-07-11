/**
 * Negative integration test for the tenant-chokepoint CI gate (F1 regression net).
 *
 * Proves the END-TO-END gate (walk a scoped root -> detect -> non-zero exit), not just the
 * pure detector: it drops a temporary fixture file into a SCOPED ROOT
 * (packages/platform/src/__chokepoint_fixture__) that names a raw-handle factory, runs the real
 * gate script as a child process, and asserts it FAILS. Covers both makeDbWithSchema (the F1
 * gap) and makeDb. The fixture is removed in afterEach so it never lingers in the tree.
 *
 * This file is a `.test.ts`, so the gate excludes it from its own scan (no chicken-and-egg).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
// repo root: packages/platform/src -> ../../../
const repoRoot = join(here, '..', '..', '..', '..');
const gateScript = join(repoRoot, 'scripts', 'check-tenant-chokepoint.mjs');
// A directory UNDER the scoped root packages/platform/src so the gate walks into it.
const fixtureDir = join(here, '__chokepoint_fixture__');
const fixtureFile = join(fixtureDir, 'raw-handle.ts');

function runGate(): { code: number; stderr: string } {
  try {
    execFileSync('node', [gateScript], { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stderr?: string };
    return { code: e.status ?? -1, stderr: e.stderr ?? '' };
  }
}

afterEach(() => {
  if (existsSync(fixtureDir)) rmSync(fixtureDir, { recursive: true, force: true });
});

describe('tenant-chokepoint gate (negative)', () => {
  it('passes on the clean tree (sanity)', () => {
    expect(runGate().code).toBe(0);
  });

  it('FAILS when a scoped-root file imports makeDbWithSchema (the F1 gap)', () => {
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(
      fixtureFile,
      "import { makeDbWithSchema } from '@rayspec/db/testing';\nexport const db = makeDbWithSchema('u', 's');\n",
    );
    const { code, stderr } = runGate();
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/makeDbWithSchema/);
  });

  it('FAILS when a scoped-root file imports makeDb', () => {
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(
      fixtureFile,
      "import { makeDb } from '@rayspec/db/testing';\nexport const db = makeDb('u');\n",
    );
    const { code, stderr } = runGate();
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/makeDb/);
  });

  it('FAILS when a scoped-root file imports makeDb from the MAIN @rayspec/db surface', () => {
    // makeDb is now on the PRODUCTION @rayspec/db surface (the boot composition root needs it), but
    // the gate's token detector is import-source-agnostic: naming `makeDb` in a SCOPED root is a
    // violation regardless of WHERE it was imported from. This locks in that exposing the production
    // factory on the main surface did NOT weaken the chokepoint for scoped request/orchestration code.
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(
      fixtureFile,
      "import { makeDb } from '@rayspec/db';\nexport const db = makeDb('u');\n",
    );
    const { code, stderr } = runGate();
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/makeDb/);
  });

  it('FAILS when a scoped-root file calls .unscoped()', () => {
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(
      fixtureFile,
      'export function leak(tdb: { unscoped(): unknown }) {\n  return tdb.unscoped();\n}\n',
    );
    const { code, stderr } = runGate();
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/unscoped/);
  });
});
