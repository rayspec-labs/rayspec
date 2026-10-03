#!/usr/bin/env node
/**
 * release-manifest — the signed release manifest of one RaySpec release, and the evidence document
 * that binds everything else a release ships to it.
 *
 * TWO DOCUMENTS, ON PURPOSE.
 *   release-manifest.json  The release catalog of the shared contract (`release-manifest.schema.json`
 *                          of @rayspec/bundle-contract): version, source commit, the SHA-256 of the
 *                          release identity manifest (`scripts/release-identity.mjs`), the targets,
 *                          every npm package with its npm integrity and the runtime image by digest.
 *                          Canonical JSON and one LF; its SHA-256 is `releaseManifestSha256`. The
 *                          schema is closed, so nothing else can be added to it, and the managed
 *                          receipt names this digest, so the receipt cannot be inside it.
 *   release-evidence.json  Everything the release hands over beside the catalog, each bound by
 *                          SHA-256: the contract version and digest, every package with its SHA-256,
 *                          the image with its registry reference, the schemas, the fixture corpus
 *                          digest, the previous supported version and the upgrade results from it,
 *                          the capabilities, the managed-posture receipt, the SBOM and an index of
 *                          every evidence file.
 *
 * NOTHING IS TAKEN ON TRUST AND NOTHING IS LEFT BLANK. Every value is read from the artifact it
 * describes — the packed tarballs, the identity manifest, the image's OCI archive, the receipt, the
 * reports — and checked against the others; a value that cannot be established refuses the run
 * instead of being written as a placeholder. Both documents are scanned for placeholder values
 * before they are written, and the manifest is validated against its schema and the contract's
 * semantic rules.
 *
 *   node scripts/release-manifest.mjs generate --tarballs <dir> --identity <file> --image-oci <tar>
 *        [--repository ghcr.io/<owner>/<name>] --out <release-manifest.json>
 *   node scripts/release-manifest.mjs sign --manifest <file> --key-file <ed25519-private.pem>
 *        [--trusted-key <ed25519-public.pem>] [--out <file.sig>]
 *   node scripts/release-manifest.mjs verify --manifest <file> [--signature <file.sig>]
 *        [--trusted-key <pem>]... [--tarballs <dir>] [--image-oci <tar>]
 *   node scripts/release-manifest.mjs evidence --manifest <file> (--signature <file.sig> |
 *        --unsigned-candidate) --tarballs <dir> --identity <file> --image-oci <tar> --sbom <file>
 *        --receipt <file> --previous <version> --upgrade-report <file>... [--evidence <role>=<file>]...
 *        --out <release-evidence.json>
 *
 * `sign` reads the key through one descriptor and refuses a key file other users can read; it
 * writes `<manifest>.sig` and verifies it before it exits. `--unsigned-candidate` is accepted only
 * for a pre-release version. Needs `pnpm build` (the built contract and bundle packages). Exit 0
 * written or verified, 1 refused or not verified (the reason on stderr, nothing written), 2 usage.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { publishSet, workspaceMembers } from './lib/release-closure.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_REPOSITORY = 'ghcr.io/rayspec-labs/rayspec';
export const EVIDENCE_SCHEMA = 'rayspec-release-evidence/1';
/** The image platform of the one supported target, and the target itself. */
export const IMAGE_PLATFORM = { os: 'linux', architecture: 'amd64' };
/** The schema files a release ships, by the name the evidence lists them under. */
export const SHIPPED_SCHEMAS = [
  ['spec-unified', 'packages/kernel/spec/version-1.0.schema.json'],
  ['spec-backend', 'packages/kernel/spec/spec.schema.json'],
  ['spec-product', 'packages/kernel/spec/product.schema.json'],
  ['ray-manifest', 'packages/kernel/bundle-contract/contract/ray-manifest.schema.json'],
  ['snapshot', 'packages/kernel/bundle-contract/contract/snapshot.schema.json'],
  ['managed-receipt', 'packages/kernel/bundle-contract/contract/managed-receipt.schema.json'],
  ['release-manifest', 'packages/kernel/bundle-contract/contract/release-manifest.schema.json'],
];
export const CORPUS_DIR = 'packages/kernel/bundle-contract/corpus';
export const EXPECTATIONS = 'packages/kernel/bundle-contract/contract/fixtures/EXPECTATIONS.json';
export const CONTRACT_LOCK = 'packages/kernel/bundle-contract/contract/CONTRACT-LOCK.json';
export const MIGRATION_JOURNAL = 'packages/kernel/db/drizzle/meta/_journal.json';

/** A refusal: the run writes nothing and says why. */
export class ManifestRefused extends Error {}

function refuse(message) {
  throw new ManifestRefused(message);
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const EXACT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

/** Read a whole file, refusing with what it is when it cannot be read. */
function readInput(path, what) {
  try {
    return readFileSync(path);
  } catch {
    return refuse(`${what} cannot be read: ${path}`);
  }
}

function parseJson(bytes, what) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    return refuse(`${what} is not JSON`);
  }
}

// ─── placeholders ──────────────────────────────────────────────────────────────────────────────

/**
 * A value that stands in for one not established: an empty string, a word that marks a gap, an
 * angle-bracket template, a version of all zeros, or a digest of one repeated character.
 */
export function isPlaceholder(value) {
  if (typeof value !== 'string') return false;
  if (value.trim() === '') return true;
  if (/\b(?:todo|tbd|fixme|placeholder|changeme|unknown|xxx+)\b/i.test(value)) return true;
  if (/<[^<>\s]*>/.test(value)) return true;
  if (/^v?0\.0\.0(?:$|-)/.test(value)) return true;
  for (const hex of value.match(/[a-f0-9]{40,}/g) ?? []) {
    if (/^(.)\1+$/.test(hex)) return true;
  }
  return false;
}

/** The JSON pointer of every placeholder value in `value`. */
export function placeholders(value, path = '') {
  if (Array.isArray(value)) return value.flatMap((v, i) => placeholders(v, `${path}/${i}`));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => placeholders(v, `${path}/${k}`));
  }
  return isPlaceholder(value) ? [path] : [];
}

function refusePlaceholders(document, what) {
  const found = placeholders(document);
  if (found.length > 0) refuse(`${what} holds a placeholder value at ${found.join(', ')}`);
}

// ─── tarballs ──────────────────────────────────────────────────────────────────────────────────

/** Every packed tarball in `dir`: name, version, bytes, sorted by name. Refuses a name twice. */
export function readTarballs(dir) {
  let files;
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith('.tgz'))
      .sort();
  } catch {
    return refuse(`the tarball directory cannot be read: ${dir}`);
  }
  if (files.length === 0) refuse(`${dir} holds no .tgz file: pack the release first`);
  const out = new Map();
  for (const file of files) {
    const path = join(dir, file);
    const bytes = readInput(path, 'a tarball');
    let manifest;
    try {
      manifest = JSON.parse(
        execFileSync('tar', ['-xzOf', '-', 'package/package.json'], {
          input: bytes,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'ignore'],
          maxBuffer: 16 * 1024 * 1024,
        }),
      );
    } catch {
      return refuse(`${file} carries no readable package/package.json`);
    }
    if (out.has(manifest.name)) refuse(`${manifest.name} is packed twice in ${dir}`);
    out.set(manifest.name, { file, name: manifest.name, version: manifest.version, bytes });
  }
  return new Map([...out].sort(([a], [b]) => byCodePoint(a, b)));
}

// ─── OCI image archive ─────────────────────────────────────────────────────────────────────────

/**
 * The entries of an uncompressed tar file, as `Map<path, { offset, size }>`, read through one
 * descriptor. A pax header's `path` and `size` apply to the entry after it; any other entry type
 * than a regular file, a directory or a pax header is refused.
 */
function tarIndex(fd, total) {
  const entries = new Map();
  const header = Buffer.alloc(512);
  let offset = 0;
  let pax = {};
  while (offset + 512 <= total) {
    readSync(fd, header, 0, 512, offset);
    if (header.every((b) => b === 0)) break;
    const field = (start, length) =>
      header
        .subarray(start, start + length)
        .toString('latin1')
        .split('\0')[0];
    const size = pax.size ?? Number.parseInt(field(124, 12).trim() || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0)
      refuse('the image archive has an unreadable entry size');
    const prefix = field(345, 155);
    const name = pax.path ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    const type = field(156, 1);
    const body = offset + 512;
    if (type === 'x') {
      const text = Buffer.alloc(size);
      readSync(fd, text, 0, size, body);
      pax = {};
      for (const record of text.toString('utf8').split('\n')) {
        const m = /^\d+ ([^=]+)=(.*)$/.exec(record);
        if (m?.[1] === 'path') pax.path = m[2];
        if (m?.[1] === 'size') pax.size = Number.parseInt(m[2], 10);
      }
    } else {
      if (!['0', '', '5', 'g'].includes(type)) {
        refuse(`the image archive holds an entry of type '${type}', which an OCI layout never has`);
      }
      if (type === '0' || type === '') {
        const path = name.replace(/^\.\//, '');
        if (entries.has(path)) refuse(`the image archive holds ${path} twice`);
        entries.set(path, { offset: body, size });
      }
      pax = {};
    }
    offset = body + Math.ceil(size / 512) * 512;
  }
  return entries;
}

const MAX_OCI_JSON_BYTES = 4 * 1024 * 1024;

/**
 * The image an OCI archive (`docker buildx build --output type=oci`) holds for linux/amd64: the
 * digest of its image manifest, which is the digest a registry serves it under when the archive is
 * pushed without conversion, and its configuration. Every blob read is checked against its digest.
 */
export function readOciImage(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
  } catch {
    return refuse(`the image archive cannot be read: ${path}`);
  }
  try {
    const total = fstatSync(fd).size;
    const entries = tarIndex(fd, total);
    const read = (name, digest) => {
      const entry = entries.get(name);
      if (entry === undefined) refuse(`the image archive has no ${name}`);
      if (entry.size > MAX_OCI_JSON_BYTES) refuse(`${name} in the image archive is too large`);
      const bytes = Buffer.alloc(entry.size);
      readSync(fd, bytes, 0, entry.size, entry.offset);
      if (digest !== undefined && `sha256:${sha256(bytes)}` !== digest) {
        refuse(`${name} in the image archive does not match its digest`);
      }
      return bytes;
    };
    const blob = (digest) => {
      if (!/^sha256:[a-f0-9]{64}$/.test(digest ?? ''))
        refuse('the image archive names a malformed digest');
      return read(`blobs/sha256/${digest.slice('sha256:'.length)}`, digest);
    };
    const layout = parseJson(read('oci-layout'), 'oci-layout');
    if (layout.imageLayoutVersion !== '1.0.0')
      refuse('the archive is not an OCI image layout 1.0.0');
    const index = parseJson(read('index.json'), 'index.json');
    let candidates = index.manifests ?? [];
    // An index that points at another index (buildx can nest one) is followed one level.
    if (
      candidates.length === 1 &&
      candidates[0].mediaType === 'application/vnd.oci.image.index.v1+json'
    ) {
      candidates = parseJson(blob(candidates[0].digest), 'the nested index').manifests ?? [];
    }
    const images = candidates.filter(
      (m) =>
        m.mediaType === 'application/vnd.oci.image.manifest.v1+json' &&
        m.annotations?.['vnd.docker.reference.type'] !== 'attestation-manifest',
    );
    if (images.length !== 1) {
      refuse(
        `the image archive holds ${images.length} image manifests; build exactly one platform`,
      );
    }
    const manifestBytes = blob(images[0].digest);
    const manifest = parseJson(manifestBytes, 'the image manifest');
    const config = parseJson(blob(manifest.config?.digest), 'the image configuration');
    if (config.os !== IMAGE_PLATFORM.os || config.architecture !== IMAGE_PLATFORM.architecture) {
      refuse(`the image is ${config.os}/${config.architecture}, not linux/amd64`);
    }
    const env = new Map(
      (config.config?.Env ?? []).map((e) => [
        e.slice(0, e.indexOf('=')),
        e.slice(e.indexOf('=') + 1),
      ]),
    );
    return {
      digest: images[0].digest,
      platform: `${config.os}/${config.architecture}`,
      nodeVersion: env.get('NODE_VERSION') ?? null,
      user: config.config?.User ?? '',
      labels: config.config?.Labels ?? {},
      healthcheck: config.config?.Healthcheck?.Test ?? null,
    };
  } finally {
    closeSync(fd);
  }
}

/** The image facts the release relies on, checked against the release they belong to. */
export function checkImage(image, { version, sourceCommit }) {
  if (!/^\d+\.\d+\.\d+$/.test(image.nodeVersion ?? '')) {
    refuse('the image does not name its exact Node version (NODE_VERSION)');
  }
  if (image.user === '' || image.user === 'root' || /^0(?::|$)/.test(image.user)) {
    refuse(`the image runs as ${image.user === '' ? 'root (no USER)' : image.user}`);
  }
  if (image.labels['org.opencontainers.image.version'] !== version) {
    refuse(
      `the image is labelled ${image.labels['org.opencontainers.image.version'] ?? 'with no version'}, not ${version}`,
    );
  }
  if (image.labels['org.opencontainers.image.revision'] !== sourceCommit) {
    refuse('the image is labelled with another source commit than the release');
  }
  if (!Array.isArray(image.healthcheck) || image.healthcheck.length === 0) {
    refuse('the image declares no health check');
  }
}

// ─── the built contract ────────────────────────────────────────────────────────────────────────

async function loadBuilt() {
  try {
    const contract = await import(
      pathToFileURL(join(REPO, 'packages/kernel/bundle-contract/dist/index.js')).href
    );
    const bundle = await import(
      pathToFileURL(join(REPO, 'packages/kernel/bundle/dist/index.js')).href
    );
    return { contract, bundle };
  } catch {
    return refuse('the built contract or bundle package is missing: run pnpm build first');
  }
}

function gitHead() {
  const res = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : null;
}

// ─── generate ──────────────────────────────────────────────────────────────────────────────────

/**
 * The release manifest from the artifacts. `identity` is the parsed identity manifest and
 * `identityBytes` its file bytes; `expected` is the publish set the tarballs must be exactly.
 */
export function buildManifest({
  tarballs,
  identity,
  identityBytes,
  image,
  repository,
  expected,
  contract,
}) {
  const version = identity.version;
  if (typeof version !== 'string' || !EXACT_VERSION.test(version)) {
    refuse('the identity manifest names no exact version');
  }
  const sourceCommit = identity.source?.commit;
  if (!/^[a-f0-9]{40}$/.test(sourceCommit ?? ''))
    refuse('the identity manifest names no source commit');
  const names = [...tarballs.keys()];
  if (JSON.stringify(names) !== JSON.stringify([...expected].sort(byCodePoint))) {
    const missing = expected.filter((n) => !tarballs.has(n));
    const extra = names.filter((n) => !expected.includes(n));
    refuse(
      `the tarballs are not exactly the publish set (missing: ${missing.join(', ') || 'none'}; ` +
        `not published: ${extra.join(', ') || 'none'})`,
    );
  }
  const recorded = new Map((identity.closure ?? []).map((m) => [m.name, m]));
  for (const t of tarballs.values()) {
    if (t.version !== version)
      refuse(`${t.name} is packed at ${t.version}, the release is ${version}`);
    if (!recorded.has(t.name)) refuse(`the identity manifest does not record ${t.name}`);
  }
  if (recorded.size !== tarballs.size) refuse('the identity manifest records another closure');
  checkImage(image, { version, sourceCommit });
  const target = contract.SUPPORTED_TARGETS[0];
  const manifest = {
    releaseManifestFormatVersion: 1,
    rayspecVersion: version,
    sourceCommit,
    identityManifestSha256: sha256(identityBytes),
    targets: contract.SUPPORTED_TARGETS.map((t) => ({
      os: t.os,
      arch: t.arch,
      nodeMajor: t.nodeMajor,
    })),
    packages: [...tarballs.values()].map((t) => ({
      name: t.name,
      version: t.version,
      integrity: `sha512-${createHash('sha512').update(t.bytes).digest('base64')}`,
    })),
    images: [
      {
        target: { os: target.os, arch: target.arch, nodeMajor: target.nodeMajor },
        platform: image.platform,
        nodeVersion: image.nodeVersion,
        repository,
        digest: image.digest,
      },
    ],
  };
  if (Number(image.nodeVersion.split('.')[0]) !== target.nodeMajor) {
    refuse(`the image runs Node ${image.nodeVersion}, the target is Node ${target.nodeMajor}`);
  }
  refusePlaceholders(manifest, 'the release manifest');
  const text = contract.releaseManifestFile(manifest);
  const checked = contract.validateReleaseManifest(Buffer.from(text, 'utf8'));
  if (!checked.ok) {
    const e = checked.errors[0];
    refuse(
      `the release manifest does not validate: ${e.code}${e.reason ? ` ${e.reason}` : ''} ${e.path ?? ''} (${e.message})`,
    );
  }
  return text;
}

/** Verify the identity manifest against the tarballs with its own verifier. */
function verifyIdentity(identityPath, tarballDir) {
  const run = spawnSync(
    process.execPath,
    [
      join(REPO, 'scripts', 'release-identity.mjs'),
      '--verify',
      '--json',
      '--tarballs',
      tarballDir,
      '--manifest',
      identityPath,
    ],
    { cwd: REPO, encoding: 'utf8' },
  );
  if (run.status !== 0) {
    refuse(`the identity manifest does not verify against the tarballs:\n${run.stderr.trim()}`);
  }
}

async function generate(args) {
  const { contract } = await loadBuilt();
  for (const flag of ['tarballs', 'identity', 'image-oci', 'out']) {
    if (args[flag] === undefined) return usage(`generate needs --${flag}`);
  }
  const identityBytes = readInput(args.identity, 'the identity manifest');
  const identity = parseJson(identityBytes, 'the identity manifest');
  if (identity.schema !== 'rayspec-release-identity/1')
    refuse('the identity manifest has another schema');
  const head = gitHead();
  if (identity.source?.commit !== head) {
    refuse(`the identity manifest names ${identity.source?.commit}, this checkout is at ${head}`);
  }
  verifyIdentity(resolve(args.identity), resolve(args.tarballs));
  const text = buildManifest({
    tarballs: readTarballs(resolve(args.tarballs)),
    identity,
    identityBytes,
    image: readOciImage(resolve(args['image-oci'])),
    repository: args.repository ?? DEFAULT_REPOSITORY,
    expected: publishSet(workspaceMembers(REPO)),
    contract,
  });
  writeFileSync(resolve(args.out), text);
  log(`release manifest ${resolve(args.out)}`);
  log(`releaseManifestSha256 ${sha256(Buffer.from(text, 'utf8'))}`);
  return 0;
}

// ─── sign and verify ───────────────────────────────────────────────────────────────────────────

/**
 * The release key, read through one descriptor: refused when other users can read it, or when it
 * is not an Ed25519 private key. Nothing about the key is ever printed but its public digest.
 */
export function readPrivateKey(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
  } catch {
    return refuse(`the key file cannot be read: ${path}`);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) refuse('the key file is not a regular file');
    if ((stat.mode & 0o077) !== 0) {
      refuse('the key file can be read by other users: restrict it to its owner (chmod 600)');
    }
    let key;
    try {
      key = createPrivateKey(readFileSync(fd));
    } catch {
      return refuse('the key file holds no private key in PEM or DER form');
    }
    if (key.asymmetricKeyType !== 'ed25519') refuse('the release key is not an Ed25519 key');
    return key;
  } finally {
    closeSync(fd);
  }
}

function readPublicKey(path) {
  try {
    const key = createPublicKey(readInput(path, 'a trusted key'));
    if (key.asymmetricKeyType !== 'ed25519') refuse(`${path} is not an Ed25519 public key`);
    return key;
  } catch (err) {
    if (err instanceof ManifestRefused) throw err;
    return refuse(`${path} holds no public key`);
  }
}

async function signCommand(args) {
  const { contract, bundle } = await loadBuilt();
  if (args.manifest === undefined || args['key-file'] === undefined) {
    return usage('sign needs --manifest and --key-file');
  }
  const bytes = readInput(args.manifest, 'the release manifest');
  const checked = contract.validateReleaseManifest(bytes);
  if (!checked.ok) refuse(`the release manifest does not validate: ${checked.errors[0].message}`);
  const key = readPrivateKey(resolve(args['key-file']));
  const digest = sha256(bytes);
  const made = bundle.createReleaseSignatureFile(digest, key);
  if (!made.ok) refuse(`signing failed: ${made.errors[0].message}`);
  const trusted = [createPublicKey(key)];
  if (args['trusted-key'] !== undefined) {
    // The approver's published key: the signature must verify against it, not just against the
    // key that made it, or a wrong key file would sign without anyone noticing.
    trusted.splice(0, 1, ...args['trusted-key'].map((p) => readPublicKey(resolve(p))));
  }
  const verified = bundle.verifyReleaseSignatureFile(digest, made.value, trusted);
  if (!verified.ok)
    refuse(
      `the signature does not verify: ${verified.errors[0].reason ?? verified.errors[0].message}`,
    );
  const out = resolve(args.out ?? `${args.manifest}.sig`);
  writeFileSync(out, made.value);
  log(`signature ${out}`);
  log(`publicKeySha256 ${verified.value.publicKeySha256}`);
  return 0;
}

async function verifyCommand(args) {
  const { contract, bundle } = await loadBuilt();
  if (args.manifest === undefined) return usage('verify needs --manifest');
  const bytes = readInput(args.manifest, 'the release manifest');
  const checked = contract.validateReleaseManifest(bytes);
  if (!checked.ok) {
    const e = checked.errors[0];
    refuse(
      `the release manifest does not validate: ${e.code}${e.reason ? ` ${e.reason}` : ''} ${e.path ?? ''}`,
    );
  }
  const manifest = checked.value;
  const digest = sha256(bytes);
  if (args.signature !== undefined) {
    const trusted = (args['trusted-key'] ?? []).map((p) => readPublicKey(resolve(p)));
    if (trusted.length === 0)
      return usage('verifying a signature needs at least one --trusted-key');
    const verified = bundle.verifyReleaseSignatureFile(
      digest,
      readInput(args.signature, 'the signature'),
      trusted,
    );
    if (!verified.ok)
      refuse(
        `the signature does not verify: ${verified.errors[0].reason ?? verified.errors[0].message}`,
      );
    log(`signature verified with key ${verified.value.publicKeySha256}`);
  }
  if (args.tarballs !== undefined) {
    const tarballs = readTarballs(resolve(args.tarballs));
    for (const p of manifest.packages) {
      const t = tarballs.get(p.name);
      if (t === undefined) refuse(`${p.name}: no tarball in ${args.tarballs}`);
      const actual = `sha512-${createHash('sha512').update(t.bytes).digest('base64')}`;
      if (actual !== p.integrity)
        refuse(`${p.name}: the tarball's integrity is not the manifest's`);
    }
    if (tarballs.size !== manifest.packages.length)
      refuse('the tarball directory holds a package the manifest does not list');
    log(`${manifest.packages.length} tarballs match their integrity`);
  }
  if (args['image-oci'] !== undefined) {
    const image = readOciImage(resolve(args['image-oci']));
    if (image.digest !== manifest.images[0].digest)
      refuse('the image archive holds another image than the manifest names');
    log(`image ${image.digest} matches`);
  }
  log(`release manifest ${manifest.rayspecVersion} at ${manifest.sourceCommit}: sha256 ${digest}`);
  return 0;
}

// ─── evidence ──────────────────────────────────────────────────────────────────────────────────

/**
 * The digest of the contract fixture corpus: SHA-256 over the lines `<file> <sha256>\n` of
 * EXPECTATIONS.json and every corpus file, sorted by code point.
 */
export function corpusDigest(repo = REPO) {
  const lines = [
    `fixtures/EXPECTATIONS.json ${sha256(readInput(join(repo, EXPECTATIONS), 'EXPECTATIONS.json'))}\n`,
  ];
  for (const file of readdirSync(join(repo, CORPUS_DIR)).sort(byCodePoint)) {
    lines.push(`corpus/${file} ${sha256(readInput(join(repo, CORPUS_DIR, file), file))}\n`);
  }
  lines.sort(byCodePoint);
  return { files: lines.length, sha256: sha256(Buffer.from(lines.join(''), 'utf8')) };
}

/** `a` below `b` in semantic-version precedence, for release versions and pre-releases. */
export function versionBelow(a, b) {
  const parse = (v) => {
    const [core, pre] = v.split('-', 2);
    return { core: core.split('.').map(Number), pre: pre === undefined ? null : pre.split('.') };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i];
  if (x.pre === null) return false;
  if (y.pre === null) return true;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return true;
    if (q === undefined) return false;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) < Number(q);
    if (pn !== qn) return pn;
    return p < q;
  }
  return false;
}

/** One upgrade-with-data summary, judged: it passed, from a version below the release. */
export function judgeUpgrade(report, version, file) {
  if (report === null || typeof report !== 'object') refuse(`${file} is not an upgrade summary`);
  if (report.ok !== true)
    refuse(`the upgrade in ${file} did not pass${report.error ? `: ${report.error}` : ''}`);
  if (typeof report.from !== 'string' || !EXACT_VERSION.test(report.from))
    refuse(`${file} names no version it upgraded from`);
  if (!versionBelow(report.from, version))
    refuse(`${file} upgraded from ${report.from}, which is not below ${version}`);
  if (typeof report.to !== 'string' || !report.to.startsWith(`${version} `)) {
    refuse(`${file} upgraded to ${report.to}, not to ${version}`);
  }
  const checks = Array.isArray(report.checks) ? report.checks : [];
  if (checks.length === 0 || checks.some((c) => c.ok !== true))
    refuse(`${file} records a check that did not pass`);
  return {
    from: report.from,
    app: report.app,
    roles: report.roles === true,
    checks: checks.length,
    platformMigrations: report.platformMigrations ?? null,
  };
}

/** Parse `role=file` evidence arguments. */
function evidenceArgs(list) {
  return (list ?? []).map((item) => {
    const at = item.indexOf('=');
    if (at <= 0 || at === item.length - 1) refuse(`--evidence ${item} is not <role>=<file>`);
    return { role: item.slice(0, at), path: resolve(item.slice(at + 1)) };
  });
}

/**
 * The evidence document. Every input has been read; this binds them and refuses whatever does not
 * agree with the manifest.
 */
export function buildEvidence(inputs) {
  const {
    contract,
    manifestBytes,
    manifest,
    signature,
    tarballs,
    identityBytes,
    image,
    sbom,
    receipt,
    previous,
    upgrades,
    extra,
    repo,
  } = inputs;
  const releaseManifestSha256 = sha256(manifestBytes);
  const version = manifest.rayspecVersion;
  if (sha256(identityBytes) !== manifest.identityManifestSha256)
    refuse('the identity manifest is not the one the release manifest names');
  for (const p of manifest.packages) {
    const t = tarballs.get(p.name);
    if (t === undefined) refuse(`${p.name}: no tarball`);
    if (`sha512-${createHash('sha512').update(t.bytes).digest('base64')}` !== p.integrity)
      refuse(`${p.name}: the tarball is not the one the manifest names`);
  }
  if (tarballs.size !== manifest.packages.length)
    refuse('the tarball directory holds a package the manifest does not list');
  if (image.digest !== manifest.images[0].digest)
    refuse('the image archive holds another image than the manifest names');

  if (signature === null && !version.includes('-')) {
    refuse(`${version} is a release version: its evidence needs the release manifest's signature`);
  }

  const sbomDoc = parseJson(sbom.bytes, 'the SBOM');
  if (sbomDoc.bomFormat !== 'CycloneDX' || sbomDoc.specVersion !== '1.5')
    refuse('the SBOM is not CycloneDX 1.5');
  if (sbomDoc.metadata?.component?.version !== version)
    refuse(`the SBOM describes ${sbomDoc.metadata?.component?.version}, not ${version}`);
  for (const p of manifest.packages) {
    const c =
      p.name === 'rayspec'
        ? sbomDoc.metadata.component
        : sbomDoc.components?.find((x) => x.name === p.name && x.version === version);
    const hex = c?.hashes?.find((h) => h.alg === 'SHA-512')?.content;
    if (hex !== Buffer.from(p.integrity.slice('sha512-'.length), 'base64').toString('hex')) {
      refuse(`the SBOM does not carry the SHA-512 of the ${p.name} tarball`);
    }
  }

  const checked = contract.validateReceipt(receipt.bytes);
  if (!checked.ok) refuse(`the managed receipt does not validate: ${checked.errors[0].message}`);
  const r = checked.value;
  if (r.releaseManifestSha256 !== releaseManifestSha256)
    refuse('the managed receipt is for another release manifest');
  if (r.runtimeVersion !== version || r.sourceCommit !== manifest.sourceCommit)
    refuse('the managed receipt is for another runtime or commit');

  if (!EXACT_VERSION.test(previous) || !versionBelow(previous, version))
    refuse(`--previous ${previous} is not a version below ${version}`);
  const upgradeFrom = upgrades.map((u) => ({
    ...judgeUpgrade(u.report, version, u.file),
    report: basename(u.file),
    sha256: u.sha256,
  }));
  if (!upgradeFrom.some((u) => u.from === previous))
    refuse(`no passing upgrade report from the previous supported version ${previous}`);

  const lock = parseJson(
    readInput(join(repo, CONTRACT_LOCK), 'CONTRACT-LOCK.json'),
    'CONTRACT-LOCK.json',
  );
  if (lock.contractVersion !== contract.CONTRACT_VERSION)
    refuse('CONTRACT-LOCK.json names another contract version than the build');
  const journal = parseJson(
    readInput(join(repo, MIGRATION_JOURNAL), 'the migration journal'),
    'the migration journal',
  );
  const entries = journal.entries ?? [];
  if (entries.length === 0) refuse('the platform migration journal is empty');
  const corpus = corpusDigest(repo);

  const file = (role, path, bytes) => ({ role, file: basename(path), sha256: sha256(bytes) });
  const index = [
    file('release-manifest', 'release-manifest.json', manifestBytes),
    ...(signature === null
      ? []
      : [file('release-manifest-signature', signature.path, signature.bytes)]),
    file('release-identity', 'rayspec-release-identity.json', identityBytes),
    file('sbom', sbom.path, sbom.bytes),
    file('managed-receipt', receipt.path, receipt.bytes),
    ...upgrades.map((u) => ({ role: 'upgrade-report', file: basename(u.file), sha256: u.sha256 })),
    ...extra.map((e) => file(e.role, e.path, e.bytes)),
  ].sort((a, b) => byCodePoint(`${a.role} ${a.file}`, `${b.role} ${b.file}`));
  const evidence = {
    schema: EVIDENCE_SCHEMA,
    rayspecVersion: version,
    sourceCommit: manifest.sourceCommit,
    releaseManifestSha256,
    releaseManifestSignature:
      signature === null
        ? { signed: false, reason: 'a release candidate is not signed with the release key' }
        : {
            signed: true,
            sha256: sha256(signature.bytes),
            publicKeySha256: signature.publicKeySha256,
          },
    identityManifestSha256: manifest.identityManifestSha256,
    contract: {
      version: contract.CONTRACT_VERSION,
      digest: lock.digest,
      digestAlgorithm: lock.digestAlgorithm,
    },
    npmPackages: manifest.packages.map((p) => ({
      name: p.name,
      version: p.version,
      integrity: p.integrity,
      sha256: sha256(tarballs.get(p.name).bytes),
      file: tarballs.get(p.name).file,
    })),
    runtimeImages: manifest.images.map((i) => ({
      platform: i.platform,
      nodeVersion: i.nodeVersion,
      digest: i.digest,
      registryRef: `${i.repository}@${i.digest}`,
    })),
    schemas: SHIPPED_SCHEMAS.map(([name, path]) => ({
      name,
      path,
      sha256: sha256(readInput(join(repo, path), path)),
    })),
    fixtureCorpusDigest: {
      files: corpus.files,
      sha256: corpus.sha256,
      algorithm:
        'SHA-256 over the lines "file digest" plus LF, sorted by code point, of ' +
        'fixtures/EXPECTATIONS.json and every corpus file, each digest the SHA-256 of the file',
    },
    previousSupportedVersion: previous,
    migrationCompatibility: {
      platformSchemaHead: entries[entries.length - 1].tag,
      platformMigrations: entries.length,
      upgradeFrom,
      downgrade: 'not supported: a runtime refuses a platform schema newer than its own chain',
    },
    capabilities: contract.CAPABILITIES.filter((c) => c.status === 'available').map((c) => ({
      id: c.id,
      managedPosture: c.managedPosture,
    })),
    securityPostureReceipt: {
      file: basename(receipt.path),
      sha256: sha256(receipt.bytes),
      publicHostingPosture: r.publicHostingPosture,
      supportedBackends: r.supportedBackends,
    },
    sbom: { file: basename(sbom.path), format: 'CycloneDX 1.5', sha256: sha256(sbom.bytes) },
    evidenceIndex: index,
  };
  refusePlaceholders(evidence, 'the evidence document');
  return contract.canonicalJsonFile(evidence);
}

async function evidenceCommand(args) {
  const { contract, bundle } = await loadBuilt();
  for (const flag of [
    'manifest',
    'tarballs',
    'identity',
    'image-oci',
    'sbom',
    'receipt',
    'previous',
    'out',
  ]) {
    if (args[flag] === undefined) return usage(`evidence needs --${flag}`);
  }
  if ((args.signature === undefined) === (args['unsigned-candidate'] !== true)) {
    return usage('give exactly one of --signature <file.sig> and --unsigned-candidate');
  }
  if ((args['upgrade-report'] ?? []).length === 0)
    return usage('evidence needs at least one --upgrade-report');
  const manifestBytes = readInput(args.manifest, 'the release manifest');
  const checked = contract.validateReleaseManifest(manifestBytes);
  if (!checked.ok) refuse(`the release manifest does not validate: ${checked.errors[0].message}`);
  let signature = null;
  if (args.signature !== undefined) {
    const trusted = (args['trusted-key'] ?? []).map((p) => readPublicKey(resolve(p)));
    if (trusted.length === 0)
      return usage('a signed release needs --trusted-key <release public key>');
    const bytes = readInput(args.signature, 'the signature');
    const verified = bundle.verifyReleaseSignatureFile(sha256(manifestBytes), bytes, trusted);
    if (!verified.ok)
      refuse(
        `the signature does not verify: ${verified.errors[0].reason ?? verified.errors[0].message}`,
      );
    signature = {
      path: resolve(args.signature),
      bytes,
      publicKeySha256: verified.value.publicKeySha256,
    };
  }
  const upgrades = args['upgrade-report'].map((path) => {
    const bytes = readInput(resolve(path), 'an upgrade report');
    return { file: resolve(path), report: parseJson(bytes, path), sha256: sha256(bytes) };
  });
  const extra = evidenceArgs(args.evidence).map((e) => ({
    ...e,
    bytes: readInput(e.path, `the ${e.role} evidence`),
  }));
  const text = buildEvidence({
    contract,
    manifestBytes,
    manifest: checked.value,
    signature,
    tarballs: readTarballs(resolve(args.tarballs)),
    identityBytes: readInput(args.identity, 'the identity manifest'),
    image: readOciImage(resolve(args['image-oci'])),
    sbom: { path: resolve(args.sbom), bytes: readInput(args.sbom, 'the SBOM') },
    receipt: { path: resolve(args.receipt), bytes: readInput(args.receipt, 'the managed receipt') },
    previous: args.previous,
    upgrades,
    extra,
    repo: REPO,
  });
  writeFileSync(resolve(args.out), text);
  log(`evidence ${resolve(args.out)}: sha256 ${sha256(Buffer.from(text, 'utf8'))}`);
  return 0;
}

// ─── command line ──────────────────────────────────────────────────────────────────────────────

function log(line) {
  process.stderr.write(`[release-manifest] ${line}\n`);
}

function usage(message) {
  log(`usage: ${message}`);
  return 2;
}

const COMMANDS = { generate, sign: signCommand, verify: verifyCommand, evidence: evidenceCommand };

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (!Object.hasOwn(COMMANDS, command ?? '')) {
    return usage(`the first argument is one of ${Object.keys(COMMANDS).join(', ')}`);
  }
  let values;
  try {
    ({ values } = parseArgs({
      args: rest,
      options: {
        tarballs: { type: 'string' },
        identity: { type: 'string' },
        'image-oci': { type: 'string' },
        repository: { type: 'string' },
        out: { type: 'string' },
        manifest: { type: 'string' },
        signature: { type: 'string' },
        'key-file': { type: 'string' },
        'trusted-key': { type: 'string', multiple: true },
        sbom: { type: 'string' },
        receipt: { type: 'string' },
        previous: { type: 'string' },
        'upgrade-report': { type: 'string', multiple: true },
        evidence: { type: 'string', multiple: true },
        'unsigned-candidate': { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    return usage(err instanceof Error ? err.message : String(err));
  }
  try {
    return await COMMANDS[command](values);
  } catch (err) {
    if (err instanceof ManifestRefused) {
      log(`refused: ${err.message}`);
      return 1;
    }
    throw err;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main();
}
