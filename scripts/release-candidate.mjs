#!/usr/bin/env node
/**
 * release-candidate — build the artifacts of a release candidate from this checkout, stamped with a
 * pre-release version for the duration of the run only.
 *
 * A candidate is the release built and tested before the version is committed: the same tarballs,
 * image, SBOM and manifest a release produces, under a pre-release version such as `1.9.0-rc.0`.
 * Nothing is published, pushed, tagged or committed. The run:
 *
 *   1. refuses unless the version is a pre-release above the committed version, the tracked tree
 *      is clean, no identity manifest is left in the launcher directory and `--out` is empty;
 *   2. stamps the version into the repo-root manifest and every RaySpec member manifest — the
 *      version line only — and, while stamped, packs the publish set (`scripts/publish.mjs --pack`),
 *      writes the release identity manifest (`scripts/release-identity.mjs`), packs the launcher
 *      again with that manifest inside it, verifies the manifest against the tarballs, and writes
 *      the CycloneDX SBOM of the closure (`scripts/gen-closure-sbom.mjs --tarballs`);
 *   3. restores every manifest to its committed bytes — also on an error or a signal — and refuses
 *      to go on unless the tracked tree is exactly what it was before;
 *   4. builds the runtime image for linux/amd64 from the tarballs into an OCI archive
 *      (`deployments/runtime-image/Dockerfile`, `--skip-image` leaves it out and then no release
 *      manifest can be written);
 *   5. writes the release manifest (`scripts/release-manifest.mjs generate`) and, with
 *      `--key-file`, signs and verifies it;
 *   6. writes `candidate.json`: the version, the commit, every artifact with its SHA-256 and the
 *      outcome of each step.
 *
 * With `--release` the same artifacts are built for the release itself: the version must be the
 * committed one and HEAD must carry its annotated tag, and nothing is stamped (the release workflow,
 * docs/releasing.md).
 *
 *   node scripts/release-candidate.mjs --version <x.y.z-pre> --out <dir> [--builder <buildx builder>]
 *        [--skip-image] [--repository ghcr.io/<owner>/<name>] [--key-file <pem> --trusted-key <pem>]
 *
 * The image is exported as an OCI image layout that `docker load` also reads, which the buildx
 * `docker` driver cannot write without the containerd image store: name a `docker-container`
 * builder with `--builder` (or BUILDX_BUILDER).
 *
 * The conformance of the candidate — the consumer install, the reference journeys and the contract
 * corpus against that install and against the image, the upgrade matrix — runs on these artifacts
 * afterwards (docs/releasing.md). Needs `pnpm build`, git, tar and, for the image, docker buildx
 * and the registry. Exit 0 built, 1 a step failed (named in candidate.json and on stderr), 2 usage
 * or a refused precondition.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { publishSet, workspaceMembers } from './lib/release-closure.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IDENTITY_IN_LAUNCHER = 'packages/app/rayspec/rayspec-release-identity.json';
export const DOCKERFILE_DIR = 'deployments/runtime-image';

export class CandidateRefused extends Error {}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function log(line) {
  process.stderr.write(`[release-candidate] ${line}\n`);
}

/** The three numbers of `x.y.z`, or null. */
function core(version) {
  const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)/.exec(version);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * A candidate version: an exact pre-release (`x.y.z-<pre>`, no build metadata) whose release part
 * is above the committed version. A release version is never a candidate.
 */
export function checkCandidateVersion(version, committed) {
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*$/.test(version)
  ) {
    throw new CandidateRefused(
      `${version} is not a pre-release version (x.y.z-<pre>): a candidate never carries a release version`,
    );
  }
  const a = core(version);
  const b = core(committed);
  if (b === null) throw new CandidateRefused(`the committed version ${committed} is not x.y.z`);
  const above = a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];
  if (!above) {
    throw new CandidateRefused(
      `${version} is not above the committed version ${committed}: a candidate leads to the next release`,
    );
  }
}

/**
 * A release build: the version is the committed one, and HEAD carries its annotated tag. A release
 * is built from the commit that names it, never stamped.
 */
export function checkReleaseVersion(version, committed, tagOfHead) {
  if (version !== committed) {
    throw new CandidateRefused(
      `--release builds the committed version ${committed}, not ${version}: commit the version first`,
    );
  }
  if (tagOfHead !== `v${version}`) {
    throw new CandidateRefused(`--release needs the annotated tag v${version} on HEAD`);
  }
}

/** The annotated release tag on HEAD for `version`, or null. */
function annotatedTagOnHead(version) {
  const name = `v${version}`;
  const type = spawnSync('git', ['cat-file', '-t', `refs/tags/${name}`], {
    cwd: REPO,
    encoding: 'utf8',
  });
  if (type.status !== 0 || type.stdout.trim() !== 'tag') return null;
  const target = spawnSync('git', ['rev-list', '-n', '1', name], { cwd: REPO, encoding: 'utf8' });
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' });
  return target.stdout.trim() !== '' && target.stdout.trim() === head.stdout.trim() ? name : null;
}

/**
 * The manifest text with its top-level `version` replaced, everything else byte for byte. Refuses
 * a manifest whose version line is not where a formatted manifest keeps it.
 */
export function stampVersionLine(text, from, to) {
  const line = `\n  "version": ${JSON.stringify(from)},\n`;
  const at = text.indexOf(line);
  if (at < 0 || text.indexOf(line, at + 1) >= 0) {
    throw new CandidateRefused('a manifest does not carry exactly one top-level version line');
  }
  const stamped = `${text.slice(0, at)}\n  "version": ${JSON.stringify(to)},\n${text.slice(at + line.length)}`;
  if (JSON.parse(stamped).version !== to) {
    throw new CandidateRefused('stamping a manifest changed something other than its version');
  }
  return stamped;
}

function git(args) {
  const res = spawnSync('git', args, { cwd: REPO, encoding: 'utf8' });
  if (res.status !== 0)
    throw new CandidateRefused(`git ${args.join(' ')} failed: ${res.stderr.trim()}`);
  return res.stdout;
}

/** Tracked changes only: the run's own output and build products are untracked by design. */
const trackedChanges = () => git(['status', '--porcelain', '--untracked-files=no']);

/**
 * Stamp `version` into the root and every member manifest, run `work`, and restore every manifest
 * to its original bytes whatever happens. A signal restores before the process ends.
 */
export function withStampedVersion(repo, version, work) {
  const root = join(repo, 'package.json');
  const committed = JSON.parse(readFileSync(root, 'utf8')).version;
  const paths = [
    root,
    ...[...workspaceMembers(repo).values()].map((m) => join(repo, m.dir, 'package.json')),
  ];
  const originals = new Map(paths.map((p) => [p, readFileSync(p)]));
  const restore = () => {
    for (const [path, bytes] of originals) writeFileSync(path, bytes);
  };
  const onSignal = (signal) => {
    restore();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  let result;
  try {
    for (const [path, bytes] of originals) {
      writeFileSync(path, stampVersionLine(bytes.toString('utf8'), committed, version));
    }
    result = work();
  } finally {
    restore();
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
  for (const [path, bytes] of originals) {
    if (!readFileSync(path).equals(bytes)) {
      throw new CandidateRefused(`${relative(repo, path)} was not restored to its committed bytes`);
    }
  }
  return result;
}

/** Run a node script of this repository; its output goes to `logFile`. Returns the exit code. */
function runScript(script, args, logFile, extraEnv = {}) {
  const res = spawnSync(process.execPath, [join(REPO, 'scripts', script), ...args], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
    maxBuffer: 256 * 1024 * 1024,
  });
  writeFileSync(
    logFile,
    `$ node scripts/${script} ${args.join(' ')}\n--- stdout\n${res.stdout}\n--- stderr\n${res.stderr}\nexit ${res.status}\n`,
  );
  return res.status ?? 1;
}

function buildImage({ tarballs, version, commit, out, logFile, builder }) {
  const args = [
    'buildx',
    'build',
    ...(builder === undefined ? [] : ['--builder', builder]),
    '--platform',
    'linux/amd64',
    '--provenance=false',
    '--sbom=false',
    '--build-context',
    `tarballs=${tarballs}`,
    '--build-arg',
    `RAYSPEC_VERSION=${version}`,
    '--build-arg',
    `SOURCE_COMMIT=${commit}`,
    '--output',
    // The docker exporter with OCI media types writes an OCI image layout that `docker load`
    // also reads, so the archive the manifest names is the image the conformance runs.
    `type=docker,oci-mediatypes=true,dest=${out},name=rayspec-candidate:${version}`,
    join(REPO, DOCKERFILE_DIR),
  ];
  const res = spawnSync('docker', args, {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  writeFileSync(
    logFile,
    `$ docker ${args.join(' ')}\n${res.stdout}\n${res.stderr}\nexit ${res.status}\n`,
  );
  return res.status ?? 1;
}

/** Every file under `dir`, relative, with its SHA-256. */
function inventory(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    byCodePoint(a.name, b.name),
  )) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...inventory(path, base));
    else if (entry.isFile())
      out.push({ file: relative(base, path), sha256: sha256(readFileSync(path)) });
  }
  return out;
}

export async function main(argv = process.argv.slice(2)) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        version: { type: 'string' },
        out: { type: 'string' },
        'skip-image': { type: 'boolean' },
        repository: { type: 'string' },
        'key-file': { type: 'string' },
        'trusted-key': { type: 'string' },
        builder: { type: 'string' },
        release: { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    log(`usage: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  if (values.version === undefined || values.out === undefined) {
    log('usage: --version <x.y.z-pre> and --out <dir> are required');
    return 2;
  }
  if ((values['key-file'] === undefined) !== (values['trusted-key'] === undefined)) {
    log(
      'usage: --key-file and --trusted-key (the approver key the signature must verify with) go together',
    );
    return 2;
  }
  const out = resolve(values.out);
  const summary = { version: values.version, sourceCommit: null, steps: [], ok: false };
  // candidate.json is written only into a directory this run prepared, never into one it refused.
  let prepared = false;
  const step = (name, ok, detail = {}) => {
    summary.steps.push({ name, ok, ...detail });
    log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
    if (!ok) throw new CandidateRefused(`${name} failed; see ${detail.log ?? 'the log'}`);
  };
  try {
    const committed = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;
    const release = values.release === true;
    if (release) checkReleaseVersion(values.version, committed, annotatedTagOnHead(values.version));
    else checkCandidateVersion(values.version, committed);
    summary.mode = release ? 'release' : 'candidate';
    if (trackedChanges() !== '') {
      throw new CandidateRefused(
        'the tracked tree has changes: a candidate is built from a commit',
      );
    }
    if (existsSync(join(REPO, IDENTITY_IN_LAUNCHER))) {
      throw new CandidateRefused(
        `${IDENTITY_IN_LAUNCHER} is left from an earlier run: remove it first`,
      );
    }
    if (existsSync(out) && readdirSync(out).length > 0)
      throw new CandidateRefused(`${out} is not empty`);
    mkdirSync(join(out, 'logs'), { recursive: true });
    prepared = true;
    summary.sourceCommit = git(['rev-parse', 'HEAD']).trim();
    summary.committedVersion = committed;
    const before = trackedChanges();
    const tarballs = join(out, 'tarballs');
    const identity = join(out, 'rayspec-release-identity.json');
    const sbom = join(out, 'closure-sbom.cdx.json');

    const build = release
      ? (work) => work()
      : (work) => withStampedVersion(REPO, values.version, work);
    build(() => {
      const packLog = join(out, 'logs', 'pack.log');
      step(
        'pack the publish set',
        runScript('publish.mjs', ['--pack', '--out', tarballs], packLog) === 0,
        { log: packLog },
      );
      const packed = readdirSync(tarballs).filter((f) => f.endsWith('.tgz')).length;
      const expected = publishSet(workspaceMembers(REPO));
      step('the tarballs are exactly the publish set', packed === expected.length, {
        packed,
        expected: expected.length,
      });
      const idLog = join(out, 'logs', 'release-identity.log');
      step(
        'release identity manifest',
        runScript('release-identity.mjs', ['--tarballs', tarballs, '--out', identity], idLog) === 0,
        { log: idLog },
      );
      // The launcher ships the identity manifest: pack the closure again with the manifest in the
      // launcher's directory and keep only the new launcher tarball. Its file-list digest leaves the
      // manifest out, so the identity still holds, and the verifier checks the shipped copy.
      const launcherLog = join(out, 'logs', 'launcher-repack.log');
      const repack = join(out, 'logs', 'repack');
      const shipped = join(REPO, IDENTITY_IN_LAUNCHER);
      try {
        copyFileSync(identity, shipped);
        step(
          'the launcher packed with its identity manifest',
          runScript('publish.mjs', ['--pack', '--out', repack], launcherLog) === 0,
          { log: launcherLog },
        );
        const launcher = readdirSync(repack).filter((f) => /^rayspec-\d.*\.tgz$/.test(f));
        step('one launcher tarball', launcher.length === 1, { found: launcher });
        renameSync(join(repack, launcher[0]), join(tarballs, launcher[0]));
      } finally {
        rmSync(shipped, { force: true });
        rmSync(repack, { recursive: true, force: true });
      }
      const verifyLog = join(out, 'logs', 'release-identity-verify.log');
      step(
        'the identity manifest verifies against the tarballs it ships in',
        runScript(
          'release-identity.mjs',
          ['--verify', '--tarballs', tarballs, '--manifest', identity],
          verifyLog,
        ) === 0 &&
          readFileSync(verifyLog, 'utf8').includes(
            'the tarball carries this rayspec-release-identity.json',
          ),
        { log: verifyLog },
      );
      const sbomLog = join(out, 'logs', 'closure-sbom.log');
      step(
        'CycloneDX SBOM of the closure',
        runScript('gen-closure-sbom.mjs', ['--out', sbom, '--tarballs', tarballs], sbomLog) === 0,
        { log: sbomLog },
      );
    });
    step(
      'the tracked tree is back at its committed bytes',
      trackedChanges() === before && before === '',
    );

    if (values['skip-image'] === true) {
      summary.steps.push({ name: 'runtime image', ok: null, skipped: '--skip-image' });
      log('skipped: runtime image and release manifest (--skip-image)');
    } else {
      mkdirSync(join(out, 'image'), { recursive: true });
      const image = join(out, 'image', 'rayspec-runtime.oci.tar');
      const imageLog = join(out, 'logs', 'image-build.log');
      step(
        'runtime image (linux/amd64)',
        buildImage({
          tarballs,
          version: values.version,
          commit: summary.sourceCommit,
          out: image,
          logFile: imageLog,
          builder: values.builder,
        }) === 0,
        { log: imageLog },
      );
      const manifest = join(out, 'release-manifest.json');
      const manifestLog = join(out, 'logs', 'release-manifest.log');
      const genArgs = [
        'generate',
        '--tarballs',
        tarballs,
        '--identity',
        identity,
        '--image-oci',
        image,
        '--out',
        manifest,
      ];
      if (values.repository !== undefined) genArgs.push('--repository', values.repository);
      step('release manifest', runScript('release-manifest.mjs', genArgs, manifestLog) === 0, {
        log: manifestLog,
      });
      if (values['key-file'] !== undefined) {
        const signLog = join(out, 'logs', 'release-manifest-sign.log');
        step(
          'release manifest signature',
          runScript(
            'release-manifest.mjs',
            [
              'sign',
              '--manifest',
              manifest,
              '--key-file',
              resolve(values['key-file']),
              '--trusted-key',
              resolve(values['trusted-key']),
            ],
            signLog,
          ) === 0,
          { log: signLog },
        );
      }
    }
    summary.ok = true;
  } catch (err) {
    if (!(err instanceof CandidateRefused)) throw err;
    summary.error = err.message;
    log(`refused: ${err.message}`);
  } finally {
    if (prepared) {
      summary.artifacts = inventory(out).filter(
        (a) => a.file !== 'candidate.json' && !a.file.startsWith('logs/'),
      );
      writeFileSync(join(out, 'candidate.json'), `${JSON.stringify(summary, null, 2)}\n`);
    }
  }
  if (!prepared) return 2;
  return summary.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main();
}
