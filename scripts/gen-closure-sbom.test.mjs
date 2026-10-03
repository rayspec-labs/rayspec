#!/usr/bin/env node
/**
 * Regression test for the CycloneDX SBOM of the published closure (`gen-closure-sbom.mjs`) and its
 * freshness check (`check-sbom-fresh.mjs`).
 *
 * The derivation runs on a small lockfile written here, shaped like the real one, and must:
 *   - keep to the publish set: a workspace package outside it, and development dependencies, never
 *     appear;
 *   - follow `link:` edges between published members, peer suffixes and npm aliases to the package
 *     that is really installed;
 *   - mark a package reached only through optional dependencies `optional`, and `required` as soon
 *     as a required edge reaches it, whichever edge is walked first;
 *   - carry each third-party licence from the inventory and its SHA-512 from the lockfile, and say
 *     so when the inventory could not read a licence;
 *   - refuse instead of guessing: a package the inventory has no row for, a resolution that is not
 *     a version, a link to a package that is not published;
 *   - give the same document for the same inputs.
 * Then the gate runs as a script against copies of this repository's real files: the committed
 * document passes, and a document that names another version fails.
 *
 * Standalone: `node scripts/gen-closure-sbom.test.mjs`; exit 0 = pass.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  closureSbom,
  parseLockfile,
  purl,
  SbomRefused,
  snapshotKey,
  splitSnapshotKey,
} from './gen-closure-sbom.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha512 = (fill) => `sha512-${Buffer.alloc(64, fill).toString('base64')}`;

const LOCK = `lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      turbo:
        specifier: 2.9.18
        version: 2.9.18

  packages/app/rayspec:
    dependencies:
      '@rayspec/cli':
        specifier: workspace:*
        version: link:../cli

  packages/app/cli:
    optionalDependencies:
      native:
        specifier: 2.0.0
        version: 2.0.0
    dependencies:
      '@rayspec/core':
        specifier: workspace:*
        version: link:../../kernel/core
      wrapper:
        specifier: 1.0.0
        version: 1.0.0(zod@4.4.3)
    devDependencies:
      vitest:
        specifier: 4.1.11
        version: 4.1.11

  packages/app/server:
    dependencies:
      '@rayspec/core':
        specifier: workspace:*
        version: link:../../kernel/core

  packages/kernel/core:
    dependencies:
      zod:
        specifier: 4.4.3
        version: 4.4.3

  packages/test/parity:
    dependencies:
      leftpad:
        specifier: 1.0.0
        version: 1.0.0

packages:

  leftpad@1.0.0:
    resolution: {integrity: ${sha512(1)}}

  native@2.0.0:
    resolution: {integrity: ${sha512(2)}}

  native-linux@2.0.0:
    resolution: {integrity: ${sha512(3)}}
    cpu: [x64]
    os: [linux]

  shared@1.0.0:
    resolution: {integrity: ${sha512(4)}}

  turbo@2.9.18:
    resolution: {integrity: ${sha512(5)}}

  vitest@4.1.11:
    resolution: {integrity: ${sha512(6)}}

  wrapper@1.0.0:
    resolution: {integrity: ${sha512(7)}}

  zod@4.4.3:
    resolution: {integrity: ${sha512(8)}}

snapshots:

  leftpad@1.0.0: {}

  native-linux@2.0.0:
    optional: true

  native@2.0.0:
    dependencies:
      shared: 1.0.0
    optionalDependencies:
      native-x64: native-linux@2.0.0

  shared@1.0.0: {}

  turbo@2.9.18: {}

  vitest@4.1.11: {}

  wrapper@1.0.0(zod@4.4.3):
    dependencies:
      zod: 4.4.3
      shared: 1.0.0

  zod@4.4.3: {}
`;

const MEMBERS = new Map([
  [
    'rayspec',
    {
      dir: 'packages/app/rayspec',
      json: { license: 'FSL-1.1-ALv2', dependencies: { '@rayspec/cli': 'workspace:*' } },
    },
  ],
  [
    '@rayspec/cli',
    {
      dir: 'packages/app/cli',
      json: {
        license: 'FSL-1.1-ALv2',
        dependencies: { '@rayspec/core': 'workspace:*', wrapper: '1.0.0' },
      },
    },
  ],
  [
    '@rayspec/server',
    {
      dir: 'packages/app/server',
      json: { license: 'FSL-1.1-ALv2', dependencies: { '@rayspec/core': 'workspace:*' } },
    },
  ],
  [
    '@rayspec/core',
    {
      dir: 'packages/kernel/core',
      json: { license: 'FSL-1.1-ALv2', dependencies: { zod: '4.4.3' } },
    },
  ],
  [
    '@rayspec/parity',
    {
      dir: 'packages/test/parity',
      json: { license: 'FSL-1.1-ALv2', dependencies: { leftpad: '1.0.0' } },
    },
  ],
]);

const INVENTORY = {
  sha256: 'f'.repeat(64),
  packages: [
    { name: 'leftpad', version: '1.0.0', license: 'MIT' },
    { name: 'native', version: '2.0.0', license: 'Apache-2.0' },
    { name: 'native-linux', version: '2.0.0', license: null },
    { name: 'shared', version: '1.0.0', license: 'ISC' },
    { name: 'wrapper', version: '1.0.0', license: 'MIT' },
    { name: 'zod', version: '4.4.3', license: 'MIT' },
  ],
};

function derive({ lock = LOCK, members = MEMBERS, inventory = INVENTORY, tarballSha512 } = {}) {
  return closureSbom({
    lock: { ...parseLockfile(lock), sha256: 'e'.repeat(64) },
    members,
    inventory,
    rootVersion: '1.9.0-rc.0',
    tarballSha512,
  });
}

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err });
  }
}

check('the launcher is the described component; the rest are sorted by reference', () => {
  const sbom = derive();
  assert.equal(sbom.bomFormat, 'CycloneDX');
  assert.equal(sbom.specVersion, '1.5');
  assert.equal(sbom.metadata.component['bom-ref'], 'pkg:npm/rayspec@1.9.0-rc.0');
  const refs = sbom.components.map((c) => c['bom-ref']);
  assert.deepEqual(
    refs,
    [...refs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  assert.equal(JSON.stringify(sbom).includes('timestamp'), false);
  assert.equal(JSON.stringify(sbom).includes('serialNumber'), false);
});

check('only the publish set and what it reaches in production', () => {
  const names = derive().components.map((c) => c.name);
  assert.deepEqual(names, [
    '@rayspec/cli',
    '@rayspec/core',
    '@rayspec/server',
    // Sorted by package URL: `native-linux@` before `native@`, '-' before '@'.
    'native-linux',
    'native',
    'shared',
    'wrapper',
    'zod',
  ]);
});

check('a link edge, a peer suffix and an npm alias resolve to the installed package', () => {
  const deps = new Map(derive().dependencies.map((d) => [d.ref, d.dependsOn]));
  assert.deepEqual(deps.get(purl('@rayspec/cli', '1.9.0-rc.0')), [
    purl('@rayspec/core', '1.9.0-rc.0'),
    purl('native', '2.0.0'),
    purl('wrapper', '1.0.0'),
  ]);
  assert.deepEqual(deps.get(purl('native', '2.0.0')), [
    purl('native-linux', '2.0.0'),
    purl('shared', '1.0.0'),
  ]);
  assert.equal(purl('@rayspec/cli', '1.0.0'), 'pkg:npm/%40rayspec/cli@1.0.0');
  assert.equal(snapshotKey('native-x64', 'native-linux@2.0.0'), 'native-linux@2.0.0');
  assert.deepEqual(splitSnapshotKey('wrapper@1.0.0(zod@4.4.3)'), {
    name: 'wrapper',
    version: '1.0.0',
  });
});

check('optional only through optional edges; required once a required edge reaches it', () => {
  const scope = new Map(derive().components.map((c) => [c.name, c.scope]));
  assert.equal(scope.get('native'), 'optional');
  assert.equal(scope.get('native-linux'), 'optional');
  // The importer lists its optional dependency first, so the walk reaches `shared` through
  // optional `native` before required `wrapper` reaches it; it must end up required.
  assert.equal(scope.get('shared'), 'required');
  assert.equal(scope.get('zod'), 'required');
});

check('licences from the inventory, hashes from the lockfile, an unread licence said so', () => {
  const byName = new Map(derive().components.map((c) => [c.name, c]));
  assert.deepEqual(byName.get('zod').licenses, [{ expression: 'MIT' }]);
  assert.deepEqual(byName.get('zod').hashes, [
    { alg: 'SHA-512', content: Buffer.alloc(64, 8).toString('hex') },
  ]);
  assert.equal(byName.get('native-linux').licenses, undefined);
  const props = byName.get('native-linux').properties.map((p) => p.name);
  assert.deepEqual(props, [
    'cdx:npm:package:cpu',
    'cdx:npm:package:os',
    'rayspec:license-not-read',
  ]);
  assert.deepEqual(byName.get('@rayspec/core').licenses, [{ expression: 'FSL-1.1-ALv2' }]);
  assert.equal(byName.get('@rayspec/core').hashes, undefined);
});

check('a packed tarball adds its SHA-512 to its component', () => {
  const hex = 'ab'.repeat(64);
  const sbom = derive({ tarballSha512: new Map([['@rayspec/core', hex]]) });
  const core = sbom.components.find((c) => c.name === '@rayspec/core');
  assert.deepEqual(core.hashes, [{ alg: 'SHA-512', content: hex }]);
});

check('the same inputs give the same document', () => {
  assert.equal(JSON.stringify(derive()), JSON.stringify(derive()));
});

check('refuses a package the inventory has no row for', () => {
  const inventory = { ...INVENTORY, packages: INVENTORY.packages.filter((r) => r.name !== 'zod') };
  assert.throws(
    () => derive({ inventory }),
    (err) => err instanceof SbomRefused && /no row for zod@4\.4\.3/.test(err.message),
  );
});

check('refuses a resolution that is not a version', () => {
  const lock = LOCK.replace('version: 1.0.0(zod@4.4.3)', 'version: file:../somewhere');
  assert.notEqual(lock, LOCK);
  assert.throws(
    () => derive({ lock }),
    (err) => err instanceof SbomRefused && /not a version/.test(err.message),
  );
});

check('refuses a link to a package that is not published', () => {
  const lock = LOCK.replace(
    'version: link:../../kernel/core\n      wrapper',
    'version: link:../../test/parity\n      wrapper',
  );
  assert.notEqual(lock, LOCK);
  assert.throws(
    () => derive({ lock }),
    (err) => err instanceof SbomRefused && /not published/.test(err.message),
  );
});

check('refuses a lockfile of another format', () => {
  assert.throws(
    () => parseLockfile(LOCK.replace("lockfileVersion: '9.0'", "lockfileVersion: '6.0'")),
    SbomRefused,
  );
});

check('the gate passes on the committed document and fails on one for another version', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'rayspec-closure-sbom-'));
  try {
    const copy = join(scratch, 'repo');
    mkdirSync(copy);
    // The gate reads the lockfile, the inventory, the documents and the tracked member manifests:
    // a git checkout of HEAD plus the working-tree copies of the files under test.
    const clone = spawnSync('git', ['clone', '--quiet', '--depth', '1', `file://${REPO}`, copy], {
      encoding: 'utf8',
    });
    assert.equal(clone.status, 0, clone.stderr);
    for (const file of [
      'pnpm-lock.yaml',
      'package.json',
      'docs/dependency-sbom.json',
      'docs/closure-sbom.cdx.json',
      'scripts/check-sbom-fresh.mjs',
      'scripts/gen-closure-sbom.mjs',
      'scripts/lib/release-closure.mjs',
    ]) {
      cpSync(join(REPO, file), join(copy, file));
    }
    const gate = () =>
      spawnSync(process.execPath, [join(copy, 'scripts', 'check-sbom-fresh.mjs')], {
        encoding: 'utf8',
      });
    const passed = gate();
    assert.equal(passed.status, 0, passed.stderr);
    const doc = JSON.parse(readFileSync(join(copy, 'docs/closure-sbom.cdx.json'), 'utf8'));
    doc.metadata.component.version = '0.0.1';
    writeFileSync(join(copy, 'docs/closure-sbom.cdx.json'), `${JSON.stringify(doc, null, 2)}\n`);
    const failed = gate();
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /closure-sbom\.cdx\.json does not describe this checkout/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

let failed = 0;
for (const r of results) {
  if (r.ok) console.log(`ok   ${r.name}`);
  else {
    failed++;
    console.error(`FAIL ${r.name}\n     ${r.err?.stack ?? r.err}`);
  }
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
