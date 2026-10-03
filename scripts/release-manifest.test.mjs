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
 *  - the OCI archive: a blob that does not match its digest, two image manifests, and another
 *    platform are refused; an attestation manifest is ignored and a nested index is followed;
 *  - sign and verify through the command line: a key file other users can read and a key that is
 *    not Ed25519 are refused; a signature verifies with the release key and not with another; a
 *    manifest changed after signing does not verify; tarballs and image are checked against it;
 *  - evidence: binds every input by digest and refuses a receipt for another manifest, a failed or
 *    missing upgrade from the previous version, an unsigned release version, an SBOM without the
 *    tarball digests, and placeholders.
 *
 * Needs `pnpm build` (the built contract, bundle and server). Standalone: `node <thisfile>`; exit 0
 * = pass.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CHECKS } from './certification.mjs';
import { receiptOf } from './managed-receipt.mjs';
import {
  buildEvidence,
  buildManifest,
  checkImage,
  isPlaceholder,
  ManifestRefused,
  main,
  placeholders,
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

/**
 * An OCI image archive. `config` overrides the image configuration; `extraManifests` adds index
 * entries; `tamper` changes the config blob after its digest was taken; `nest` wraps the index.
 */
function ociArchive(path, { config = {}, extraManifests = [], tamper = false, nest = false } = {}) {
  const blobs = [];
  const blob = (value) => {
    const bytes = Buffer.from(JSON.stringify(value));
    const digest = `sha256:${sha256(bytes)}`;
    blobs.push([digest, bytes]);
    return { digest, size: bytes.length };
  };
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
    layers: [],
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
const archive = ociArchive(join(work, 'image.tar'));
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

const upgradeReport = (from, ok = true) => ({
  app: 'notes-ui',
  roles: false,
  from,
  to: `${VERSION} (working tree)`,
  ok,
  checks: [{ name: 'every stored row is unchanged', ok }],
  platformMigrations: { before: 12, after: 18 },
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
});

rmSync(work, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length === 0 ? 0 : 1);
