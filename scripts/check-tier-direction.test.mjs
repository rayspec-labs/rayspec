#!/usr/bin/env node
/**
 * Regression test for the tier-direction gate (check-tier-direction.mjs).
 *
 * Throwaway workspaces are built in a temp directory with the pieces the gate reads — a
 * pnpm-workspace.yaml, package manifests under tier directories and the taxonomy table of
 * docs/ARCHITECTURE.md — so a pass means the gate saw the packages and a failure names the planted
 * problem. The real script runs twice: over this checkout, which must pass, and over a throwaway
 * workspace with a planted upward edge, which must fail with exit 1.
 *
 * Standalone (no test framework is wired for the gate scripts): `node <thisfile>`; exit 0 = pass.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkTierDirection, EXCEPTIONS, TIERS } from './check-tier-direction.mjs';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPTS_DIR, '..');

const TABLE = (tiers) =>
  [
    '# Architecture',
    '',
    '## Package taxonomy',
    '',
    '| Tier | Packages | Role |',
    '| --- | --- | --- |',
    ...tiers.map((t) => `| **${t}** | x | y |`),
    '',
    '## Data flow',
    '',
  ].join('\n');

const WORKSPACE = `packages:
  - "packages/kernel/*"
  - "packages/adapters/*"
  - "packages/app/*"
  - "examples/*"

onlyBuiltDependencies:
  - "esbuild"
`;

/** A throwaway workspace: `packages` maps a directory to its manifest. */
function workspace(packages, { tiers = TIERS, workspaceFile = WORKSPACE } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rayspec-tier-gate-'));
  writeFileSync(join(root, 'pnpm-workspace.yaml'), workspaceFile);
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs', 'ARCHITECTURE.md'), TABLE(tiers));
  for (const [dir, manifest] of Object.entries(packages)) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, 'package.json'), JSON.stringify(manifest));
  }
  return root;
}

const pkg = (name, fields = {}) => ({ name, version: '0.0.0', ...fields });
const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test('this checkout passes, run as the real script', () => {
  const out = execFileSync('node', [join(SCRIPTS_DIR, 'check-tier-direction.mjs')], {
    encoding: 'utf8',
  });
  assert.match(out, /tier-direction: \d+ workspace packages/);
  const { problems, scanned } = checkTierDirection(REPO_ROOT);
  assert.deepEqual(problems, []);
  assert.ok(scanned > 20, `scanned only ${scanned} packages`);
});

test('downward and same-tier edges pass', () => {
  const root = workspace({
    'packages/kernel/core': pkg('@x/core'),
    'packages/kernel/spec': pkg('@x/spec', { dependencies: { '@x/core': '*' } }),
    'packages/adapters/one': pkg('@x/one', { dependencies: { '@x/core': '*' } }),
    'packages/app/cli': pkg('@x/cli', { dependencies: { '@x/one': '*', '@x/spec': '*' } }),
    'examples/demo': pkg('@x/demo', { dependencies: { '@x/cli': '*' } }),
  });
  assert.deepEqual(checkTierDirection(root, []).problems, []);
  rmSync(root, { recursive: true, force: true });
});

for (const field of [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
]) {
  test(`an upward edge in ${field} fails and is named`, () => {
    const root = workspace({
      'packages/kernel/core': pkg('@x/core', { [field]: { '@x/cli': '*' } }),
      'packages/app/cli': pkg('@x/cli'),
    });
    const { problems } = checkTierDirection(root, []);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /@x\/core \(kernel\) depends on @x\/cli \(app\) in /);
    assert.ok(problems[0].includes(field));
    rmSync(root, { recursive: true, force: true });
  });
}

test('a package that depends on an example fails', () => {
  const root = workspace({
    'packages/app/cli': pkg('@x/cli', { devDependencies: { '@x/demo': '*' } }),
    'examples/demo': pkg('@x/demo'),
  });
  const { problems } = checkTierDirection(root, []);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /depends on @x\/demo \(examples\)/);
  rmSync(root, { recursive: true, force: true });
});

test('a third-party dependency is not a workspace edge', () => {
  const root = workspace({
    'packages/kernel/core': pkg('@x/core', { dependencies: { zod: '4.0.0' } }),
  });
  assert.deepEqual(checkTierDirection(root, []).problems, []);
  rmSync(root, { recursive: true, force: true });
});

test('a reviewed exception admits exactly its edge', () => {
  const root = workspace({
    'packages/kernel/core': pkg('@x/core', { devDependencies: { '@x/cli': '*' } }),
    'packages/app/cli': pkg('@x/cli'),
  });
  const exact = [{ from: '@x/core', to: '@x/cli', field: 'devDependencies', reason: 'r' }];
  assert.deepEqual(checkTierDirection(root, exact).problems, []);
  // The same edge in another field is not covered.
  const other = [{ from: '@x/core', to: '@x/cli', field: 'dependencies', reason: 'r' }];
  const { problems } = checkTierDirection(root, other);
  assert.equal(problems.length, 2);
  assert.match(problems.join('\n'), /in devDependencies/);
  assert.match(problems.join('\n'), /matches no dependency any more/);
  rmSync(root, { recursive: true, force: true });
});

test('a stale exception fails', () => {
  const root = workspace({ 'packages/kernel/core': pkg('@x/core') });
  const stale = [{ from: '@x/core', to: '@x/cli', field: 'dependencies', reason: 'r' }];
  const { problems } = checkTierDirection(root, stale);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /@x\/core -> @x\/cli \(dependencies\) matches no dependency any more/);
  rmSync(root, { recursive: true, force: true });
});

test('a package outside every tier directory fails', () => {
  const root = workspace(
    { 'packages/tools/lint': pkg('@x/lint') },
    { workspaceFile: 'packages:\n  - "packages/tools/*"\n' },
  );
  const { problems } = checkTierDirection(root, []);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /@x\/lint \(packages\/tools\/lint\) lies in no tier directory/);
  rmSync(root, { recursive: true, force: true });
});

test('a tier list in the architecture document that differs fails', () => {
  const swapped = [...TIERS];
  [swapped[2], swapped[3]] = [swapped[3], swapped[2]];
  const root = workspace({ 'packages/kernel/core': pkg('@x/core') }, { tiers: swapped });
  const { problems } = checkTierDirection(root, []);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /docs\/ARCHITECTURE\.md lists the tiers/);
  rmSync(root, { recursive: true, force: true });
});

test('a workspace with no package fails closed', () => {
  const root = workspace({}, { workspaceFile: 'packages:\n  - "packages/kernel/*"\n' });
  const { problems, scanned } = checkTierDirection(root, []);
  assert.equal(scanned, 0);
  assert.match(problems[0], /scanned nothing/);
  rmSync(root, { recursive: true, force: true });
});

test('the real script exits 1 on a planted upward edge', () => {
  const root = workspace({
    'packages/kernel/core': pkg('@x/core', { dependencies: { '@x/cli': '*' } }),
    'packages/app/cli': pkg('@x/cli'),
  });
  mkdirSync(join(root, 'scripts'));
  cpSync(
    join(SCRIPTS_DIR, 'check-tier-direction.mjs'),
    join(root, 'scripts', 'check-tier-direction.mjs'),
  );
  let status = 0;
  let stderr = '';
  try {
    execFileSync('node', [join(root, 'scripts', 'check-tier-direction.mjs')], { stdio: 'pipe' });
  } catch (e) {
    status = e.status;
    stderr = String(e.stderr);
  }
  assert.equal(status, 1);
  assert.match(stderr, /@x\/core \(kernel\) depends on @x\/cli \(app\)/);
  rmSync(root, { recursive: true, force: true });
});

test('every reviewed exception carries a reason', () => {
  for (const e of EXCEPTIONS) assert.ok(e.reason.length > 20, `${e.from} -> ${e.to}`);
});

let failed = 0;
for (const [name, fn] of cases) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${name}\n     ${e.message}`);
  }
}
if (failed > 0) {
  console.error(`${failed} of ${cases.length} case(s) FAILED`);
  process.exit(1);
}
console.log(`ALL CASES PASSED (${cases.length})`);
