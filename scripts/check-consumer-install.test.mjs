#!/usr/bin/env node
/**
 * Regression test for check-consumer-install.mjs, the step that installs the packed release the way a
 * consumer does so its lockfile can be scanned.
 *
 * The test drives the REAL script against tarballs it builds with tar in a throwaway directory. The
 * tarballs depend on nothing, and npm runs with `npm_config_offline=true` and a throwaway cache, so no
 * registry is contacted.
 *
 *   (C) coherent tarballs install, every entry point loads, and the consumer lockfile names each one.
 *   (V) a tarball whose entry point throws fails the run and is named.
 *   (B) a bin-only package is installed but not imported.
 *   (G) no tarballs, a non-empty --out and a missing --tarballs each refuse.
 *   (D) the split report finds a package held in two versions and ignores one held once.
 *
 * Standalone (no test framework is wired for the gate scripts): `node <thisfile>`; exit 0 = pass.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { consumerManifest, duplicatedPackages } from './check-consumer-install.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'check-consumer-install.mjs');
const work = mkdtempSync(join(tmpdir(), 'rayspec-consumer-test-'));
const env = { ...process.env, npm_config_offline: 'true', npm_config_cache: join(work, 'cache') };

/** Pack a package directory holding `files` into `<dir>/<name>.tgz`, the layout `npm pack` writes. */
function tarball(dir, slug, files) {
  const src = join(work, 'src', slug);
  mkdirSync(join(src, 'package'), { recursive: true });
  for (const [rel, text] of Object.entries(files)) writeFileSync(join(src, 'package', rel), text);
  mkdirSync(dir, { recursive: true });
  execFileSync('tar', ['-czf', join(dir, `${slug}.tgz`), '-C', src, 'package']);
}

function run(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const pkg = (name, extra = {}) => JSON.stringify({ name, version: '1.0.0', ...extra });
let passed = 0;
const check = (label, fn) => {
  fn();
  passed += 1;
  console.log(`ok   ${label}`);
};

try {
  // (C) + (B)
  const good = join(work, 'good');
  tarball(good, 'scope-a', {
    'package.json': pkg('@scope/a', { type: 'module', exports: './index.js' }),
    'index.js': 'export const a = 1;\n',
  });
  tarball(good, 'scope-b', {
    'package.json': pkg('@scope/b', { main: 'index.cjs' }),
    'index.cjs': 'module.exports = 2;\n',
  });
  tarball(good, 'launcher', {
    'package.json': pkg('launcher', { bin: { launcher: 'bin.js' } }),
    'bin.js': "throw new Error('a bin is never imported');\n",
  });
  const out = join(work, 'consumer-good');
  const ok = run(['--tarballs', good, '--out', out]);
  check('(C) coherent tarballs install and load', () => {
    assert.equal(ok.code, 0, ok.err);
    assert.match(ok.out, /3 tarballs installed and loaded/);
    const lock = JSON.parse(readFileSync(join(out, 'package-lock.json'), 'utf8'));
    for (const name of ['@scope/a', '@scope/b', 'launcher']) {
      assert.ok(lock.packages[`node_modules/${name}`], `${name} is in the consumer lockfile`);
    }
  });
  check('(B) a bin-only package is installed but not imported', () => {
    assert.doesNotMatch(ok.err, /launcher/);
  });

  // (V)
  const bad = join(work, 'bad');
  tarball(bad, 'scope-a', {
    'package.json': pkg('@scope/a', { type: 'module', exports: './index.js' }),
    'index.js': 'export const a = 1;\n',
  });
  tarball(bad, 'scope-broken', {
    'package.json': pkg('@scope/broken', { type: 'module', exports: './index.js' }),
    'index.js': "throw new Error('broken on load');\n",
  });
  const failed = run(['--tarballs', bad, '--out', join(work, 'consumer-bad')]);
  check('(V) an entry point that throws fails the run and is named', () => {
    assert.equal(failed.code, 1);
    assert.match(failed.err, /importing @scope\/broken threw/);
    assert.doesNotMatch(failed.err, /importing @scope\/a threw/);
  });

  // (G)
  check('(G) no tarballs refuses', () => {
    const empty = join(work, 'empty');
    mkdirSync(empty);
    const r = run(['--tarballs', empty]);
    assert.equal(r.code, 1);
    assert.match(r.err, /no \.tgz/);
  });
  check('(G) a non-empty --out refuses', () => {
    const r = run(['--tarballs', good, '--out', out]);
    assert.equal(r.code, 1);
    assert.match(r.err, /is not empty/);
  });
  check('(G) a missing --tarballs is a usage error', () => {
    assert.equal(run([]).code, 2);
  });
  check('(G) the same package packed twice refuses', () => {
    assert.throws(
      () =>
        consumerManifest([
          { name: 'x', path: '/a.tgz' },
          { name: 'x', path: '/b.tgz' },
        ]),
      /packed twice/,
    );
  });

  // (D)
  check('(D) the split report finds two versions and ignores a single one', () => {
    const tree = {
      dependencies: {
        hono: { version: '4.13.11' },
        '@rayspec/api-auth': { version: '1.0.0', dependencies: { hono: { version: '4.13.9' } } },
        undici: { version: '8.11.2' },
        other: { version: '1.0.0', dependencies: { other: { version: '2.0.0' } } },
      },
    };
    assert.deepEqual(duplicatedPackages(tree, new Set(['hono', 'undici'])), [
      ['hono', ['4.13.11', '4.13.9']],
    ]);
  });
} finally {
  if (existsSync(work)) rmSync(work, { recursive: true, force: true });
}
console.log(`check-consumer-install: ${passed} checks passed`);
