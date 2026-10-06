#!/usr/bin/env node
/**
 * Regression test for the release manifest tool (`scripts/release-manifest.mjs`), against artifacts
 * built here: packed tarballs, an identity manifest, an OCI image archive, an SBOM, a managed
 * receipt and upgrade reports.
 *
 *  - generate: the manifest is canonical, validates against the contract's schema and semantic
 *    rules, takes every integrity from the tarball bytes and the image digest from the archive, and
 *    is the same bytes every time; it refuses a tarball set that is not the publish set, a package
 *    at another version, an identity manifest that does not record a package, an image that runs as
 *    root, is labelled with another version or commit, has no health check or no Node version, and
 *    any placeholder value;
 *  - generate through the command line refuses an identity manifest of another commit;
 *  - the OCI archive: a blob that does not match its digest, two image manifests, another
 *    platform, a layer missing from the archive, a layer of another size and a layer with other
 *    bytes are refused; an attestation manifest is ignored and a nested index is followed; a file
 *    is read from the topmost layer that holds it, and a later layer's whiteout hides it;
 *  - the image SBOM (`gen-image-sbom.mjs`) lists the image's installed tree with each tarball's
 *    SHA-512 and the Debian packages its dpkg record names as installed, names the image by digest,
 *    and refuses an image without the tree, without the dpkg record or without an installed ffmpeg;
 *  - sign and verify through the command line: a key file other users can read and a key that is
 *    not Ed25519 are refused; a signature verifies with the release key and not with another; a
 *    manifest changed after signing does not verify; tarballs and image are checked against it: a
 *    tarball with other bytes, an extra tarball and an image archive missing a layer fail verify;
 *  - evidence: binds every input by digest and refuses a receipt for another manifest, runtime
 *    version or commit, a failed or missing upgrade from the previous version (a summary that says
 *    it failed even when its checks passed), an upgrade onto anything but the candidate install or
 *    by a CLI of another version, an unsigned release version, an SBOM without the tarball digests,
 *    an image SBOM of another image or without a tarball installed, and placeholders.
 *
 * Needs `pnpm build` (the built contract, bundle and server). Standalone: `node <thisfile>`; exit 0
 * = pass.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { CHECKS } from './certification.mjs';
import {
  DPKG_STATUS,
  debianPackages,
  INSTALLED_TREE,
  imageSbom,
  main as imageSbomMain,
  OS_RELEASE,
} from './gen-image-sbom.mjs';
import { receiptOf } from './managed-receipt.mjs';
import {
  buildEvidence,
  buildManifest,
  checkImage,
  isPlaceholder,
  ManifestRefused,
  main,
  placeholders,
  readImageFile,
  readOciImage,
  readTarballs,
  versionBelow,
} from './release-manifest.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const contract = await import(
  pathToFileURL(join(REPO, 'packages/kernel/bundle-contract/dist/index.js')).href
);
const { SUPPORTED_BACKEND_MATRIX } = await import(
  pathToFileURL(join(REPO, 'packages/app/server/dist/supported-backends.js')).href
);

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const hexOf = (label) => sha256(label);
const VERSION = '1.9.0-rc.0';
const COMMIT = hexOf('a source commit').slice(0, 40);
const PUBLISH = ['@rayspec/cli', '@rayspec/core', 'rayspec'];
const work = mkdtempSync(join(tmpdir(), 'rayspec-release-manifest-'));

let passed = 0;
const failures = [];
async function check(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok   ${label}`);
  } catch (err) {
    failures.push(label);
    console.error(`FAIL ${label}\n     ${err?.stack ?? err}`);
  }
}

/** A refusal whose message matches `pattern`. */
function refused(fn, pattern) {
  assert.throws(fn, (err) => err instanceof ManifestRefused && pattern.test(err.message));
}

/** Run the command line and return its exit code with what it wrote to stderr. */
async function run(argv, entry = main) {
  const write = process.stderr.write;
  let stderr = '';
  process.stderr.write = (chunk) => {
    stderr += String(chunk);
    return true;
  };
  try {
    return { code: await entry(argv), stderr };
  } finally {
    process.stderr.write = write;
  }
}

// ─── fixtures ──────────────────────────────────────────────────────────────────────────────────

/** Pack `package/package.json` for each name into `dir`, as `pnpm pack` names the files. */
function packTarballs(dir, names = PUBLISH, version = VERSION) {
  mkdirSync(dir, { recursive: true });
  for (const name of names) {
    const src = join(work, 'src', name.replace('/', '-'));
    mkdirSync(join(src, 'package'), { recursive: true });
    writeFileSync(join(src, 'package', 'package.json'), `${JSON.stringify({ name, version })}\n`);
    const file = join(dir, `${name.replace('@', '').replace('/', '-')}-${version}.tgz`);
    execFileSync('tar', ['-czf', file, '-C', src, 'package']);
  }
  return dir;
}

function identityFor(names = PUBLISH) {
  return {
    schema: 'rayspec-release-identity/1',
    version: VERSION,
    source: { commit: COMMIT },
    closure: names.map((name) => ({ name, version: VERSION })),
  };
}

/** One ustar entry. */
function tarEntry(name, body) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'latin1');
  header.write('0000644\0', 100, 'latin1');
  header.write('0000000\0', 108, 'latin1');
  header.write('0000000\0', 116, 'latin1');
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 'latin1');
  header.write('00000000000\0', 136, 'latin1');
  header.write('        ', 148, 'latin1');
  header.write('0', 156, 'latin1');
  header.write('ustar\0', 257, 'latin1');
  header.write('00', 263, 'latin1');
  let sum = 0;
  for (const b of header) sum += b;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  const pad = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([header, body, pad]);
}

/** A gzip-compressed layer holding `files` (path to bytes). */
function layerOf(files) {
  return gzipSync(
    Buffer.concat([
      ...Object.entries(files).map(([name, body]) => tarEntry(name, Buffer.from(body))),
      Buffer.alloc(1024),
    ]),
  );
}

/**
 * An OCI image archive. `config` overrides the image configuration; `extraManifests` adds index
 * entries; `tamper` changes the config blob after its digest was taken; `nest` wraps the index.
 * `layers` are the files of each layer, bottom first; `dropLayer` leaves the blob of that layer out
 * of the archive, `tamperLayer` writes other bytes for it, and `layerSize` adds to the size the
 * manifest names for the first layer.
 */
function ociArchive(
  path,
  {
    config = {},
    extraManifests = [],
    tamper = false,
    nest = false,
    layers = [{ 'etc/hostname': 'image\n' }],
    dropLayer = null,
    tamperLayer = null,
    layerSize = 0,
  } = {},
) {
  const blobs = [];
  const blob = (value) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
    const digest = `sha256:${sha256(bytes)}`;
    blobs.push([digest, bytes]);
    return { digest, size: bytes.length };
  };
  const layerRefs = layers.map((files, i) => {
    const ref = blob(layerOf(files));
    if (i === dropLayer) blobs.pop();
    if (i === tamperLayer) {
      // The same size, one byte different.
      const other = Buffer.from(blobs[blobs.length - 1][1]);
      other[other.length - 1] ^= 0x01;
      blobs[blobs.length - 1] = [ref.digest, other];
    }
    return {
      mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
      ...ref,
      size: ref.size + (i === 0 ? layerSize : 0),
    };
  });
  const cfg = {
    os: 'linux',
    architecture: 'amd64',
    config: {
      User: 'rayspec',
      Env: ['PATH=/usr/bin', 'NODE_VERSION=22.23.3'],
      Labels: {
        'org.opencontainers.image.version': VERSION,
        'org.opencontainers.image.revision': COMMIT,
      },
      Healthcheck: { Test: ['CMD', 'node', '/opt/rayspec/healthcheck.mjs'] },
    },
    ...config,
  };
  const configRef = blob(cfg);
  const manifest = blob({
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: { mediaType: 'application/vnd.oci.image.config.v1+json', ...configRef },
    layers: layerRefs,
  });
  const manifests = [
    { mediaType: 'application/vnd.oci.image.manifest.v1+json', ...manifest },
    ...extraManifests.map((m) => ({ ...m, ...blob({ schemaVersion: 2, layers: [] }) })),
  ];
  let index = { schemaVersion: 2, manifests };
  if (nest) {
    const inner = blob({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.index.v1+json',
      manifests,
    });
    index = {
      schemaVersion: 2,
      manifests: [{ mediaType: 'application/vnd.oci.image.index.v1+json', ...inner }],
    };
  }
  const parts = [
    tarEntry('oci-layout', Buffer.from('{"imageLayoutVersion":"1.0.0"}')),
    tarEntry('index.json', Buffer.from(JSON.stringify(index))),
    ...blobs.map(([digest, bytes]) => {
      const body =
        tamper && digest === configRef.digest
          ? Buffer.from(JSON.stringify({ ...cfg, os: 'other' }))
          : bytes;
      return tarEntry(`blobs/sha256/${digest.slice(7)}`, body);
    }),
    Buffer.alloc(1024),
  ];
  writeFileSync(path, Buffer.concat(parts));
  return { path, digest: manifest.digest };
}

const tarballDir = packTarballs(join(work, 'tarballs'));

/** The installed tree npm records in the image: each tarball at its integrity, and a dependency. */
function installedTree(dir = tarballDir) {
  const packages = { '': { name: 'rayspec-runtime' } };
  for (const t of readTarballs(dir).values()) {
    packages[`node_modules/${t.name}`] = {
      version: t.version,
      resolved: `file:../../build/tarballs/${t.file}`,
      integrity: `sha512-${createHash('sha512').update(t.bytes).digest('base64')}`,
      license: 'FSL-1.1-ALv2',
    };
  }
  packages['node_modules/hono'] = {
    version: '4.13.12',
    integrity: `sha512-${createHash('sha512').update('hono').digest('base64')}`,
    license: 'MIT',
  };
  packages['node_modules/@rayspec/cli/node_modules/hono'] = {
    version: '4.13.12',
    integrity: `sha512-${createHash('sha512').update('hono').digest('base64')}`,
    license: 'MIT',
  };
  return Buffer.from(JSON.stringify({ name: 'rayspec-runtime', lockfileVersion: 3, packages }));
}

/** A dpkg record: one stanza per `[name, version, status]`. */
function dpkgStatus(packages) {
  return packages
    .map(
      ([name, version, status = 'install ok installed']) =>
        `Package: ${name}\nStatus: ${status}\nArchitecture: amd64\nVersion: ${version}\n` +
        `Description: ${name}\n more about ${name}\n`,
    )
    .join('\n');
}

const OS_RELEASE_TEXT = 'PRETTY_NAME="Debian GNU/Linux 13 (trixie)"\nVERSION_ID="13"\nID=debian\n';
const DPKG_STATUS_TEXT = dpkgStatus([
  ['base-files', '13.8+deb13u1'],
  ['ffmpeg', '7:7.1.5-0+deb13u1'],
  ['libavcodec61', '7:7.1.5-0+deb13u1'],
  // dpkg remembers the configuration of a removed package: it is not installed.
  ['curl', '8.14.1-2', 'deinstall ok config-files'],
]);
/** The layers of the image: the base, the Debian packages, the installed tree. */
const imageLayers = (status = DPKG_STATUS_TEXT) => [
  { 'etc/hostname': 'image\n', [OS_RELEASE]: OS_RELEASE_TEXT },
  ...(status === null ? [] : [{ [DPKG_STATUS]: status }]),
  { [INSTALLED_TREE]: installedTree() },
];
const systemFiles = (status = DPKG_STATUS_TEXT) => ({
  status: Buffer.from(status),
  osRelease: Buffer.from(OS_RELEASE_TEXT),
});

const archive = ociArchive(join(work, 'image.tar'), { layers: imageLayers() });
const identity = identityFor();
const identityBytes = Buffer.from(`${JSON.stringify(identity, null, 2)}\n`);

function manifestText(overrides = {}) {
  return buildManifest({
    tarballs: readTarballs(tarballDir),
    identity,
    identityBytes,
    image: readOciImage(archive.path),
    repository: 'ghcr.io/rayspec-labs/rayspec',
    expected: PUBLISH,
    contract,
    ...overrides,
  });
}

// ─── generate ──────────────────────────────────────────────────────────────────────────────────

await check('the manifest is canonical, validates and is reproducible', () => {
  const text = manifestText();
  assert.equal(text, manifestText());
  const parsed = contract.validateReleaseManifest(Buffer.from(text));
  assert.equal(parsed.ok, true);
  const m = parsed.value;
  assert.equal(m.rayspecVersion, VERSION);
  assert.equal(m.sourceCommit, COMMIT);
  assert.equal(m.identityManifestSha256, sha256(identityBytes));
  assert.deepEqual(
    m.packages.map((p) => p.name),
    PUBLISH,
  );
  const cli = readFileSync(join(tarballDir, `rayspec-cli-${VERSION}.tgz`));
  assert.equal(
    m.packages[0].integrity,
    `sha512-${createHash('sha512').update(cli).digest('base64')}`,
  );
  assert.deepEqual(m.images, [
    {
      target: { os: 'linux', arch: 'x64', nodeMajor: 22 },
      platform: 'linux/amd64',
      nodeVersion: '22.23.3',
      repository: 'ghcr.io/rayspec-labs/rayspec',
      digest: archive.digest,
    },
  ]);
});

await check('refuses tarballs that are not exactly the publish set', () => {
  refused(
    () => manifestText({ expected: [...PUBLISH, '@rayspec/server'] }),
    /missing: @rayspec\/server/,
  );
  refused(
    () => manifestText({ expected: ['@rayspec/cli', 'rayspec'] }),
    /not published: @rayspec\/core/,
  );
});

await check('refuses a package at another version and one the identity does not record', () => {
  const drift = packTarballs(join(work, 'drift'), ['@rayspec/core'], '1.8.0');
  packTarballs(drift, ['@rayspec/cli', 'rayspec']);
  refused(
    () => manifestText({ tarballs: readTarballs(drift) }),
    /@rayspec\/core is packed at 1\.8\.0/,
  );
  const partial = identityFor(['@rayspec/cli', 'rayspec']);
  refused(() => manifestText({ identity: partial }), /does not record @rayspec\/core/);
});

await check('refuses an image that does not belong to the release', () => {
  const image = readOciImage(archive.path);
  const facts = { version: VERSION, sourceCommit: COMMIT };
  checkImage(image, facts);
  refused(() => checkImage({ ...image, user: '' }, facts), /runs as root/);
  refused(() => checkImage({ ...image, user: '0:0' }, facts), /runs as 0:0/);
  refused(() => checkImage({ ...image, nodeVersion: null }, facts), /Node version/);
  refused(() => checkImage({ ...image, healthcheck: null }, facts), /health check/);
  refused(
    () =>
      checkImage(
        { ...image, labels: { ...image.labels, 'org.opencontainers.image.version': '1.8.0' } },
        facts,
      ),
    /labelled 1\.8\.0/,
  );
  refused(
    () =>
      checkImage(
        {
          ...image,
          labels: { ...image.labels, 'org.opencontainers.image.revision': hexOf('x').slice(0, 40) },
        },
        facts,
      ),
    /another source commit/,
  );
});

await check('refuses a placeholder anywhere in the manifest', () => {
  const zeros = { ...identity, source: { commit: '0'.repeat(40) } };
  const image = {
    ...readOciImage(archive.path),
    labels: {
      'org.opencontainers.image.version': VERSION,
      'org.opencontainers.image.revision': '0'.repeat(40),
    },
  };
  refused(() => manifestText({ identity: zeros, image }), /placeholder value at \/sourceCommit/);
  for (const value of [
    '',
    'TODO',
    'tbd',
    '<digest>',
    '0.0.0',
    `sha256:${'0'.repeat(64)}`,
    'f'.repeat(40),
  ]) {
    assert.equal(isPlaceholder(value), true, value);
  }
  for (const value of [
    VERSION,
    COMMIT,
    `sha256:${hexOf('y')}`,
    'linux/amd64',
    'ghcr.io/rayspec-labs/rayspec',
  ]) {
    assert.equal(isPlaceholder(value), false, value);
  }
  assert.deepEqual(placeholders({ a: [1, 'TBD'], b: { c: 'ok' } }), ['/a/1']);
});

await check('generate refuses an identity manifest of another commit', async () => {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
  assert.notEqual(COMMIT, head, 'the fixture commit must not be this checkout');
  const file = join(work, 'identity-other-commit.json');
  writeFileSync(file, identityBytes);
  const out = join(work, 'generated-other-commit.json');
  const { code, stderr } = await run([
    'generate',
    '--tarballs',
    tarballDir,
    '--identity',
    file,
    '--image-oci',
    archive.path,
    '--out',
    out,
  ]);
  assert.equal(code, 1);
  assert.match(stderr, new RegExp(`names ${COMMIT}, this checkout is at ${head}`));
  assert.equal(existsSync(out), false);
});

// ─── the OCI archive ───────────────────────────────────────────────────────────────────────────

await check('the archive: a blob that does not match its digest is refused', () => {
  const bad = ociArchive(join(work, 'tampered.tar'), { tamper: true });
  refused(() => readOciImage(bad.path), /does not match its digest/);
});

await check('the archive: two images or another platform are refused', () => {
  const two = ociArchive(join(work, 'two.tar'), {
    extraManifests: [{ mediaType: 'application/vnd.oci.image.manifest.v1+json' }],
  });
  refused(() => readOciImage(two.path), /holds 2 image manifests/);
  const arm = ociArchive(join(work, 'arm.tar'), { config: { architecture: 'arm64' } });
  refused(() => readOciImage(arm.path), /linux\/arm64, not linux\/amd64/);
});

await check('the archive: a layer missing, of another size or with other bytes is refused', () => {
  const layers = [{ 'etc/hostname': 'a\n' }, { 'opt/x': 'b\n' }];
  assert.equal(readOciImage(ociArchive(join(work, 'layers.tar'), { layers }).path).layers, 2);
  const missing = ociArchive(join(work, 'missing-layer.tar'), { layers, dropLayer: 1 });
  refused(() => readOciImage(missing.path), /has no layer sha256:/);
  const sized = ociArchive(join(work, 'sized-layer.tar'), { layers, layerSize: 1 });
  refused(() => readOciImage(sized.path), /is not the size the image names/);
  const other = ociArchive(join(work, 'other-layer.tar'), { layers, tamperLayer: 0 });
  refused(
    () => readOciImage(other.path),
    /layer sha256:[a-f0-9]+ in the image archive does not match/,
  );
});

await check('the archive: a file is read from the topmost layer that holds it', () => {
  const layered = ociArchive(join(work, 'files.tar'), {
    layers: [
      { 'etc/a': 'first\n', 'etc/b': 'kept\n', 'etc/c': 'deleted\n' },
      { 'etc/a': 'second\n', 'etc/.wh.c': '' },
    ],
  });
  assert.equal(readImageFile(layered.path, '/etc/a')?.toString(), 'second\n');
  assert.equal(readImageFile(layered.path, 'etc/b')?.toString(), 'kept\n');
  assert.equal(readImageFile(layered.path, 'etc/c'), null);
  assert.equal(readImageFile(layered.path, 'etc/none'), null);
});

await check('the archive: an attestation is ignored and a nested index is followed', () => {
  const attested = ociArchive(join(work, 'attested.tar'), {
    extraManifests: [
      {
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        annotations: { 'vnd.docker.reference.type': 'attestation-manifest' },
      },
    ],
  });
  assert.equal(readOciImage(attested.path).digest, attested.digest);
  const nested = ociArchive(join(work, 'nested.tar'), { nest: true });
  assert.equal(readOciImage(nested.path).digest, nested.digest);
});

// ─── the image SBOM ────────────────────────────────────────────────────────────────────────────

const imageSbomPath = join(work, 'image-sbom.cdx.json');

await check('the image SBOM lists the installed tree and names the image by digest', async () => {
  const { code } = await run(['--image-oci', archive.path, '--out', imageSbomPath], imageSbomMain);
  assert.equal(code, 0);
  const doc = JSON.parse(readFileSync(imageSbomPath, 'utf8'));
  assert.equal(doc.bomFormat, 'CycloneDX');
  assert.equal(doc.metadata.component.type, 'container');
  assert.equal(`sha256:${doc.metadata.component.hashes[0].content}`, archive.digest);
  assert.equal(doc.metadata.component.version, VERSION);
  // hono is installed twice at one version: one component, both places named.
  const hono = doc.components.filter((c) => c.name === 'hono');
  assert.equal(hono.length, 1);
  assert.equal(hono[0].properties.length, 2);
  const cli = doc.components.find((c) => c.name === '@rayspec/cli');
  const bytes = readFileSync(join(tarballDir, `rayspec-cli-${VERSION}.tgz`));
  assert.equal(cli.hashes[0].content, createHash('sha512').update(bytes).digest('hex'));
  assert.equal(
    imageSbom(readOciImage(archive.path), installedTree(), systemFiles()),
    readFileSync(imageSbomPath, 'utf8'),
  );
});

await check('the image SBOM lists the Debian packages dpkg records as installed', () => {
  const doc = JSON.parse(readFileSync(imageSbomPath, 'utf8'));
  const deb = doc.components.filter((c) => c.purl.startsWith('pkg:deb/'));
  assert.deepEqual(
    deb.map((c) => c.purl),
    [
      'pkg:deb/debian/base-files@13.8%2Bdeb13u1?arch=amd64&distro=debian-13',
      'pkg:deb/debian/ffmpeg@7%3A7.1.5-0%2Bdeb13u1?arch=amd64&distro=debian-13',
      'pkg:deb/debian/libavcodec61@7%3A7.1.5-0%2Bdeb13u1?arch=amd64&distro=debian-13',
    ],
  );
  assert.equal(deb[1].version, '7:7.1.5-0+deb13u1');
  const refs = doc.components.map((c) => c['bom-ref']);
  assert.deepEqual(refs, [...refs].sort(), 'the components are in one order');
  assert.equal(new Set(refs).size, refs.length);
  const property = (name) => doc.metadata.properties.find((p) => p.name === name)?.value;
  assert.equal(property('rayspec:dpkg-record'), '/var/lib/dpkg/status');
  assert.equal(property('rayspec:dpkg-record-sha256'), sha256(Buffer.from(DPKG_STATUS_TEXT)));
});

await check(
  'the image SBOM refuses an image without a dpkg record or an installed ffmpeg',
  async () => {
    const out = join(work, 'no-ffmpeg-sbom.json');
    const refusedFor = async (name, status, reason) => {
      const image = ociArchive(join(work, `${name}.tar`), { layers: imageLayers(status) });
      const { code, stderr } = await run(['--image-oci', image.path, '--out', out], imageSbomMain);
      assert.equal(code, 1, name);
      assert.match(stderr, reason);
      assert.equal(existsSync(out), false);
    };
    await refusedFor('no-dpkg', null, /holds no \/var\/lib\/dpkg\/status/);
    await refusedFor(
      'no-ffmpeg',
      dpkgStatus([['base-files', '13.8+deb13u1']]),
      /names no installed ffmpeg package/,
    );
    await refusedFor(
      'removed-ffmpeg',
      dpkgStatus([['ffmpeg', '7:7.1.5-0+deb13u1', 'deinstall ok config-files']]),
      /names no installed ffmpeg package/,
    );
    const noRelease = ociArchive(join(work, 'no-release.tar'), {
      layers: [{ [DPKG_STATUS]: DPKG_STATUS_TEXT }, { [INSTALLED_TREE]: installedTree() }],
    });
    const lacking = await run(['--image-oci', noRelease.path, '--out', out], imageSbomMain);
    assert.equal(lacking.code, 1);
    assert.match(lacking.stderr, /holds no \/usr\/lib\/os-release/);
    assert.throws(
      () => debianPackages(Buffer.from(DPKG_STATUS_TEXT), Buffer.from('NAME=unknown\n')),
      /names no distribution and release/,
    );
    assert.throws(
      () =>
        debianPackages(
          Buffer.from('Package: ffmpeg\nStatus: install ok installed\nArchitecture: amd64\n'),
          Buffer.from(OS_RELEASE_TEXT),
        ),
      /ffmpeg in the image's dpkg record has no version/,
    );
  },
);

await check(
  'the image SBOM refuses an image without the installed tree or the launcher',
  async () => {
    const bare = ociArchive(join(work, 'bare.tar'));
    const out = join(work, 'bare-sbom.json');
    const { code, stderr } = await run(['--image-oci', bare.path, '--out', out], imageSbomMain);
    assert.equal(code, 1);
    assert.match(stderr, /holds no \/opt\/rayspec\/node_modules\/\.package-lock\.json/);
    assert.equal(existsSync(out), false);
    const tree = JSON.parse(installedTree().toString());
    delete tree.packages['node_modules/rayspec'];
    assert.throws(
      () => imageSbom(readOciImage(archive.path), Buffer.from(JSON.stringify(tree)), systemFiles()),
      /no rayspec 1\.9\.0-rc\.0 launcher/,
    );
  },
);

// ─── sign and verify ───────────────────────────────────────────────────────────────────────────

const manifestPath = join(work, 'release-manifest.json');
writeFileSync(manifestPath, manifestText());
const keys = generateKeyPairSync('ed25519');
const keyFile = join(work, 'release-key.pem');
writeFileSync(keyFile, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
chmodSync(keyFile, 0o600);
const publicFile = join(work, 'release-key.pub.pem');
writeFileSync(publicFile, keys.publicKey.export({ type: 'spki', format: 'pem' }));
const otherPublic = join(work, 'other.pub.pem');
writeFileSync(
  otherPublic,
  generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }),
);

await check('sign and verify refuse a manifest that holds a placeholder value', async () => {
  const text = readFileSync(manifestPath, 'utf8');
  const parsed = JSON.parse(text);
  const zeroed = join(work, 'placeholder-manifest.json');
  writeFileSync(zeroed, text.replace(parsed.sourceCommit, '0'.repeat(40)));
  assert.equal(
    await main(['sign', '--manifest', zeroed, '--key-file', keyFile, '--out', join(work, 'z.sig')]),
    1,
  );
  assert.equal(await main(['verify', '--manifest', zeroed]), 1);
  assert.equal(await main(['verify', '--manifest', manifestPath]), 0);
});

await check(
  'sign refuses a key file other users can read, and a key that is not Ed25519',
  async () => {
    const open = join(work, 'open-key.pem');
    writeFileSync(open, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    chmodSync(open, 0o644);
    assert.equal(
      await main([
        'sign',
        '--manifest',
        manifestPath,
        '--key-file',
        open,
        '--out',
        join(work, 'x.sig'),
      ]),
      1,
    );
    const ec = join(work, 'ec-key.pem');
    writeFileSync(
      ec,
      generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({
        type: 'pkcs8',
        format: 'pem',
      }),
      { mode: 0o600 },
    );
    chmodSync(ec, 0o600);
    assert.equal(
      await main([
        'sign',
        '--manifest',
        manifestPath,
        '--key-file',
        ec,
        '--out',
        join(work, 'x.sig'),
      ]),
      1,
    );
    assert.throws(() => readFileSync(join(work, 'x.sig')));
  },
);

await check('sign checks against the approver key it is given', async () => {
  const out = join(work, 'wrong.sig');
  assert.equal(
    await main([
      'sign',
      '--manifest',
      manifestPath,
      '--key-file',
      keyFile,
      '--trusted-key',
      otherPublic,
      '--out',
      out,
    ]),
    1,
  );
  assert.throws(() => readFileSync(out));
});

await check(
  'a signature verifies with the release key, not another, and not after a change',
  async () => {
    assert.equal(
      await main([
        'sign',
        '--manifest',
        manifestPath,
        '--key-file',
        keyFile,
        '--trusted-key',
        publicFile,
      ]),
      0,
    );
    const sig = `${manifestPath}.sig`;
    const doc = JSON.parse(readFileSync(sig, 'utf8'));
    assert.equal(doc.releaseManifestSha256, sha256(readFileSync(manifestPath)));
    assert.equal(
      await main([
        'verify',
        '--manifest',
        manifestPath,
        '--signature',
        sig,
        '--trusted-key',
        publicFile,
        '--tarballs',
        tarballDir,
        '--image-oci',
        archive.path,
      ]),
      0,
    );
    assert.equal(
      await main([
        'verify',
        '--manifest',
        manifestPath,
        '--signature',
        sig,
        '--trusted-key',
        otherPublic,
      ]),
      1,
    );
    const changed = join(work, 'changed.json');
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
    m.images[0].digest = `sha256:${hexOf('another image')}`;
    writeFileSync(changed, contract.releaseManifestFile(m));
    assert.equal(
      await main([
        'verify',
        '--manifest',
        changed,
        '--signature',
        sig,
        '--trusted-key',
        publicFile,
      ]),
      1,
    );
    assert.equal(await main(['verify', '--manifest', changed, '--image-oci', archive.path]), 1);
    assert.equal(await main(['verify', '--manifest', manifestPath, '--signature', sig]), 2);
  },
);

await check(
  'verify refuses a tarball with other bytes and a tarball the manifest does not list',
  async () => {
    const verify = (dir) =>
      run(['verify', '--manifest', manifestPath, '--tarballs', dir, '--image-oci', archive.path]);
    assert.equal((await verify(tarballDir)).code, 0);
    // The same package at the same version, packed with other bytes.
    const changed = join(work, 'verify-changed');
    cpSync(tarballDir, changed, { recursive: true });
    const src = join(work, 'src-changed', 'package');
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, 'package.json'),
      `${JSON.stringify({ name: '@rayspec/core', version: VERSION, description: 'other' })}\n`,
    );
    const coreFile = join(changed, `rayspec-core-${VERSION}.tgz`);
    const before = readFileSync(coreFile);
    execFileSync('tar', ['-czf', coreFile, '-C', dirname(src), 'package']);
    assert.notDeepEqual(readFileSync(coreFile), before, 'the tarball must really change');
    assert.equal(readTarballs(changed).get('@rayspec/core').version, VERSION);
    const integrity = await verify(changed);
    assert.equal(integrity.code, 1);
    assert.match(integrity.stderr, /@rayspec\/core: the tarball's integrity is not the manifest's/);
    // Every listed tarball as packed, and one more.
    const extra = join(work, 'verify-extra');
    cpSync(tarballDir, extra, { recursive: true });
    packTarballs(extra, ['@rayspec/server']);
    assert.equal(readdirSync(extra).length, readdirSync(tarballDir).length + 1);
    const more = await verify(extra);
    assert.equal(more.code, 1);
    assert.match(more.stderr, /holds a package the manifest does not list/);
  },
);

await check('verify refuses an image archive that lost a layer', async () => {
  const lost = ociArchive(join(work, 'lost-layer.tar'), {
    layers: imageLayers(),
    dropLayer: 1,
  });
  assert.equal(lost.digest, archive.digest, 'the archive names the same image');
  const { code, stderr } = await run([
    'verify',
    '--manifest',
    manifestPath,
    '--image-oci',
    lost.path,
  ]);
  assert.equal(code, 1);
  assert.match(stderr, /has no layer sha256:/);
});

// ─── evidence ──────────────────────────────────────────────────────────────────────────────────

const manifestBytes = readFileSync(manifestPath);
const releaseManifestSha256 = sha256(manifestBytes);

function receiptFor(digest, overrides = {}) {
  const passedFiles = new Set(SUPPORTED_BACKEND_MATRIX.flatMap((r) => r.evidence));
  const lane = {
    sourceCommit: COMMIT,
    runtimeVersion: VERSION,
    target: { os: 'linux', arch: 'x64', nodeMajor: 22, nodeVersion: '22.23.3' },
    passedChecks: new Set(CHECKS.map((c) => c.id)),
    passedFiles,
    evidence: [
      {
        protection: 'certification-lane-summary',
        reference: 'summary.json',
        sha256: hexOf('summary'),
      },
    ],
    ...overrides,
  };
  const receipt = receiptOf({
    lane,
    releaseManifestSha256: digest,
    artifactSha256: archive.digest.slice(7),
    matrix: SUPPORTED_BACKEND_MATRIX,
    contract,
  });
  return Buffer.from(contract.canonicalJsonFile(receipt));
}

function sbomFor(tarballs) {
  const hash = (name) => [
    {
      alg: 'SHA-512',
      content: createHash('sha512').update(tarballs.get(name).bytes).digest('hex'),
    },
  ];
  return Buffer.from(
    JSON.stringify({
      bomFormat: 'CycloneDX',
      specVersion: '1.5',
      metadata: { component: { name: 'rayspec', version: VERSION, hashes: hash('rayspec') } },
      components: PUBLISH.filter((n) => n !== 'rayspec').map((name) => ({
        name,
        version: VERSION,
        hashes: hash(name),
      })),
    }),
  );
}

const upgradeReport = (from, ok = true, overrides = {}) => ({
  app: 'notes-ui',
  roles: false,
  from,
  to: `${VERSION} (candidate install)`,
  target: {
    install: 'candidate',
    cli: '/consumer/node_modules/rayspec/dist/bin.js',
    cliVersion: VERSION,
  },
  ok,
  checks: [{ name: 'every stored row is unchanged', ok }],
  platformMigrations: { before: 12, after: 18 },
  ...overrides,
});

function evidence(overrides = {}) {
  const tarballs = readTarballs(tarballDir);
  return buildEvidence({
    contract,
    manifestBytes,
    manifest: JSON.parse(manifestBytes.toString('utf8')),
    signature: null,
    tarballs,
    identityBytes,
    image: readOciImage(archive.path),
    sbom: { path: join(work, 'closure-sbom.cdx.json'), bytes: sbomFor(tarballs) },
    imageSbom: { path: imageSbomPath, bytes: readFileSync(imageSbomPath) },
    receipt: { path: join(work, 'managed-receipt.json'), bytes: receiptFor(releaseManifestSha256) },
    previous: '1.8.0',
    upgrades: [
      {
        file: join(work, 'upgrade-1.8.0.json'),
        report: upgradeReport('1.8.0'),
        sha256: hexOf('u18'),
      },
      {
        file: join(work, 'upgrade-1.7.0.json'),
        report: upgradeReport('1.7.0'),
        sha256: hexOf('u17'),
      },
    ],
    extra: [],
    repo: REPO,
    ...overrides,
  });
}

await check('the evidence binds every input and is reproducible', () => {
  const text = evidence();
  assert.equal(text, evidence());
  const doc = JSON.parse(text);
  assert.equal(doc.releaseManifestSha256, releaseManifestSha256);
  assert.equal(doc.contract.version, contract.CONTRACT_VERSION);
  assert.match(doc.contract.digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    doc.npmPackages.map((p) => p.name),
    PUBLISH,
  );
  assert.equal(doc.runtimeImages[0].registryRef, `ghcr.io/rayspec-labs/rayspec@${archive.digest}`);
  assert.equal(doc.previousSupportedVersion, '1.8.0');
  assert.deepEqual(
    doc.migrationCompatibility.upgradeFrom.map((u) => u.from),
    ['1.8.0', '1.7.0'],
  );
  assert.equal(doc.releaseManifestSignature.signed, false);
  assert.ok(doc.schemas.length >= 7);
  assert.ok(doc.fixtureCorpusDigest.files > 100);
  assert.ok(doc.evidenceIndex.some((e) => e.role === 'managed-receipt'));
  assert.ok(doc.evidenceIndex.some((e) => e.role === 'image-sbom'));
  assert.equal(doc.imageSbom.image, archive.digest);
  assert.equal(doc.imageSbom.sha256, sha256(readFileSync(imageSbomPath)));
  assert.ok(doc.capabilities.length > 0);
});

await check('the evidence refuses a receipt for another release manifest', () => {
  refused(
    () =>
      evidence({
        receipt: { path: join(work, 'r.json'), bytes: receiptFor(hexOf('other manifest')) },
      }),
    /receipt is for another release manifest/,
  );
  refused(
    () => evidence({ receipt: { path: join(work, 'r.json'), bytes: Buffer.from('{}') } }),
    /receipt does not validate/,
  );
});

await check('the evidence refuses a receipt for another runtime version or commit', () => {
  for (const lane of [
    { runtimeVersion: '1.9.0-rc.1' },
    { sourceCommit: hexOf('another commit').slice(0, 40) },
  ]) {
    const bytes = receiptFor(releaseManifestSha256, lane);
    const parsed = JSON.parse(bytes.toString('utf8'));
    assert.equal(parsed.releaseManifestSha256, releaseManifestSha256);
    assert.ok(
      parsed.runtimeVersion !== VERSION || parsed.sourceCommit !== COMMIT,
      'the receipt must really name another runtime or commit',
    );
    refused(
      () => evidence({ receipt: { path: join(work, 'r.json'), bytes } }),
      /receipt is for another runtime or commit/,
    );
  }
});

await check('the evidence refuses an image SBOM of another image or without a tarball', () => {
  const doc = JSON.parse(readFileSync(imageSbomPath, 'utf8'));
  const as = (d) => ({ path: imageSbomPath, bytes: Buffer.from(JSON.stringify(d)) });
  const other = structuredClone(doc);
  other.metadata.component.hashes[0].content = hexOf('another image');
  refused(() => evidence({ imageSbom: as(other) }), /describes another image/);
  const lacking = structuredClone(doc);
  lacking.components = lacking.components.filter((c) => c.name !== '@rayspec/core');
  refused(
    () => evidence({ imageSbom: as(lacking) }),
    /does not show the @rayspec\/core tarball installed/,
  );
  const rehashed = structuredClone(doc);
  rehashed.components.find((c) => c.name === 'rayspec').hashes[0].content = hexOf('x').repeat(2);
  refused(
    () => evidence({ imageSbom: as(rehashed) }),
    /does not show the rayspec tarball installed/,
  );
});

await check(
  'the evidence refuses a failed upgrade and a missing one from the previous version',
  () => {
    refused(
      () =>
        evidence({
          upgrades: [
            {
              file: join(work, 'u.json'),
              report: upgradeReport('1.8.0', false),
              sha256: hexOf('u'),
            },
          ],
        }),
      /did not pass/,
    );
    refused(
      () =>
        evidence({
          upgrades: [
            { file: join(work, 'u.json'), report: upgradeReport('1.7.0'), sha256: hexOf('u') },
          ],
        }),
      /no passing upgrade report from the previous supported version 1\.8\.0/,
    );
    refused(
      () =>
        evidence({
          upgrades: [
            { file: join(work, 'u.json'), report: upgradeReport('1.9.0'), sha256: hexOf('u') },
          ],
        }),
      /not below/,
    );
    refused(() => evidence({ previous: '2.0.0' }), /not a version below/);
  },
);

await check(
  'the evidence refuses a summary that says it failed, even with every check passing',
  () => {
    const report = upgradeReport('1.8.0', true, { ok: false, error: 'the boot timed out' });
    assert.ok(
      report.checks.every((c) => c.ok === true),
      'every recorded check passed',
    );
    refused(
      () =>
        evidence({
          upgrades: [{ file: join(work, 'u.json'), report, sha256: hexOf('u') }],
        }),
      /did not pass: the boot timed out/,
    );
  },
);

await check('the evidence refuses an upgrade onto anything but the candidate install', () => {
  const onto = (overrides) =>
    evidence({
      upgrades: [
        {
          file: join(work, 'u.json'),
          report: upgradeReport('1.8.0', true, overrides),
          sha256: hexOf('u'),
        },
      ],
    });
  refused(
    () =>
      onto({
        to: `${VERSION} (working tree)`,
        target: { install: 'working tree', cliVersion: VERSION },
      }),
    /onto working tree, not the candidate install/,
  );
  refused(() => onto({ target: undefined }), /onto an unnamed runtime/);
  refused(
    () => onto({ target: { install: 'candidate', cliVersion: '1.8.0' } }),
    /ran a CLI that reported 1\.8\.0, not 1\.9\.0-rc\.0/,
  );
  refused(
    () => onto({ to: `${VERSION} (working tree)` }),
    /not to 1\.9\.0-rc\.0 \(candidate install\)/,
  );
});

await check('the evidence of a release version needs the signature', () => {
  const m = JSON.parse(manifestBytes.toString('utf8'));
  refused(
    () => evidence({ manifest: { ...m, rayspecVersion: '1.9.0' } }),
    /needs the release manifest's signature/,
  );
});

await check('the evidence refuses an SBOM without the tarball digests', () => {
  const doc = JSON.parse(sbomFor(readTarballs(tarballDir)).toString('utf8'));
  doc.components[0].hashes = [];
  refused(
    () =>
      evidence({ sbom: { path: join(work, 's.json'), bytes: Buffer.from(JSON.stringify(doc)) } }),
    /SBOM does not carry the SHA-512/,
  );
});

await check('the evidence refuses another identity manifest and another image', () => {
  refused(
    () => evidence({ identityBytes: Buffer.from('{}\n') }),
    /identity manifest is not the one/,
  );
  refused(
    () => evidence({ image: { ...readOciImage(archive.path), digest: `sha256:${hexOf('z')}` } }),
    /another image/,
  );
});

await check('version order follows semantic versioning', () => {
  assert.equal(versionBelow('1.8.0', '1.9.0-rc.0'), true);
  assert.equal(versionBelow('1.9.0-rc.0', '1.9.0'), true);
  assert.equal(versionBelow('1.9.0-rc.1', '1.9.0-rc.10'), true);
  assert.equal(versionBelow('1.9.0', '1.9.0-rc.0'), false);
  assert.equal(versionBelow('1.9.0', '1.9.0'), false);
});

await check('the command line refuses an unknown command and missing inputs', async () => {
  assert.equal(await main(['publish']), 2);
  assert.equal(await main(['generate', '--tarballs', tarballDir]), 2);
  assert.equal(await main(['evidence', '--manifest', manifestPath]), 2);
  assert.equal((await run(['--out', join(work, 'x.json')], imageSbomMain)).code, 2);
});

rmSync(work, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length === 0 ? 0 : 1);
