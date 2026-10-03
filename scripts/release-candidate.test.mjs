#!/usr/bin/env node
/**
 * Regression test for the candidate builder (`scripts/release-candidate.mjs`): the parts that keep a
 * candidate from becoming a release or leaving the tree changed.
 *
 *  - a candidate version is a pre-release above the committed version: a release version, a version
 *    with build metadata, the committed version itself and one below it are refused;
 *  - stamping changes the version line of a manifest and nothing else, and refuses a manifest whose
 *    version line is missing or appears twice;
 *  - the stamped run restores every manifest to its committed bytes when the work succeeds and when
 *    it throws, inside a throwaway git workspace with real member manifests;
 *  - a release build is the committed version with its annotated tag on HEAD, and nothing else;
 *  - the command line refuses a release version, a release build without its tag, and an
 *    incomplete argument list before it writes anything (exit 2, no output directory).
 *
 * Standalone: `node scripts/release-candidate.test.mjs`; exit 0 = pass.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CandidateRefused,
  checkCandidateVersion,
  checkReleaseVersion,
  main,
  stampVersionLine,
  withStampedVersion,
} from './release-candidate.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'rayspec-release-candidate-'));
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
const refusedWith = (fn, pattern) =>
  assert.throws(fn, (err) => err instanceof CandidateRefused && pattern.test(err.message));

await check('a candidate version is a pre-release above the committed version', () => {
  checkCandidateVersion('1.9.0-rc.0', '1.8.0');
  checkCandidateVersion('1.8.1-rc.2', '1.8.0');
  checkCandidateVersion('2.0.0-beta.1', '1.8.0');
  refusedWith(() => checkCandidateVersion('1.9.0', '1.8.0'), /not a pre-release/);
  refusedWith(() => checkCandidateVersion('1.9.0-rc.0+build.1', '1.8.0'), /not a pre-release/);
  refusedWith(() => checkCandidateVersion('v1.9.0-rc.0', '1.8.0'), /not a pre-release/);
  refusedWith(
    () => checkCandidateVersion('1.8.0-rc.0', '1.8.0'),
    /not above the committed version/,
  );
  refusedWith(
    () => checkCandidateVersion('1.7.9-rc.0', '1.8.0'),
    /not above the committed version/,
  );
});

await check('a release build is the committed version with its tag on HEAD', () => {
  checkReleaseVersion('1.9.0', '1.9.0', 'v1.9.0');
  refusedWith(() => checkReleaseVersion('1.9.0', '1.8.0', 'v1.9.0'), /commit the version first/);
  refusedWith(() => checkReleaseVersion('1.9.0', '1.9.0', null), /annotated tag v1\.9\.0 on HEAD/);
  refusedWith(
    () => checkReleaseVersion('1.9.0', '1.9.0', 'v1.8.0'),
    /annotated tag v1\.9\.0 on HEAD/,
  );
});

await check('stamping changes the version line and nothing else', () => {
  const text =
    '{\n  "name": "@rayspec/x",\n  "version": "1.8.0",\n  "files": ["dist"],\n  "dependencies": { "y": "1.8.0" }\n}\n';
  const stamped = stampVersionLine(text, '1.8.0', '1.9.0-rc.0');
  assert.equal(stamped, text.replace('"version": "1.8.0"', '"version": "1.9.0-rc.0"'));
  assert.equal(JSON.parse(stamped).dependencies.y, '1.8.0');
  refusedWith(
    () => stampVersionLine('{\n  "name": "x"\n}\n', '1.8.0', '1.9.0-rc.0'),
    /exactly one/,
  );
  refusedWith(
    () =>
      stampVersionLine(
        '{\n  "a": {\n  "version": "1.8.0",\n  },\n  "version": "1.8.0",\n  "b": 1\n}\n',
        '1.8.0',
        '1.9.0-rc.0',
      ),
    /exactly one/,
  );
});

/** A git workspace with a root manifest and two members, committed. */
function workspace() {
  const root = mkdtempSync(join(scratch, 'ws-'));
  const files = {
    'package.json': { name: 'rayspec', version: '1.8.0', private: true },
    'packages/app/rayspec/package.json': {
      name: 'rayspec',
      version: '1.8.0',
      bin: { rayspec: './dist/bin.js' },
    },
    'packages/kernel/core/package.json': {
      name: '@rayspec/core',
      version: '1.8.0',
      files: ['dist'],
    },
    'examples/spike/package.json': { name: '@spike/pack', version: '1.0.0' },
  };
  for (const [path, json] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), `${JSON.stringify(json, null, 2)}\n`);
  }
  const git = (...args) => {
    const r = spawnSync(
      'git',
      [
        '-c',
        'user.email=t@rayspec.test',
        '-c',
        'user.name=T',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  git('init', '--quiet');
  git('add', '.');
  git('commit', '--quiet', '-m', 'fixture');
  return { root, files: Object.keys(files), git };
}

await check('the stamped run restores every manifest after success', () => {
  const ws = workspace();
  const seen = withStampedVersion(ws.root, '1.9.0-rc.0', () =>
    ws.files.map((f) => JSON.parse(readFileSync(join(ws.root, f), 'utf8')).version),
  );
  // The root and both RaySpec members are stamped; the example fixture is not a RaySpec package.
  assert.deepEqual(seen, ['1.9.0-rc.0', '1.9.0-rc.0', '1.9.0-rc.0', '1.0.0']);
  assert.equal(ws.git('status', '--porcelain'), '');
});

await check('the stamped run restores every manifest when the work throws', () => {
  const ws = workspace();
  assert.throws(
    () =>
      withStampedVersion(ws.root, '1.9.0-rc.0', () => {
        throw new Error('pack failed');
      }),
    /pack failed/,
  );
  assert.equal(ws.git('status', '--porcelain'), '');
});

await check('the command line refuses before it writes anything', async () => {
  const out = join(scratch, 'refused-out');
  assert.equal(await main(['--version', '1.9.0', '--out', out]), 2);
  assert.equal(existsSync(out), false);
  assert.equal(await main(['--version', '1.9.0-rc.0']), 2);
  const committed = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
  ).version;
  assert.equal(await main(['--release', '--version', '9.9.9', '--out', out]), 2);
  // This checkout's HEAD is a development commit: it carries no release tag of its own version.
  assert.equal(await main(['--release', '--version', committed, '--out', out]), 2);
  assert.equal(await main(['--version', '1.9.0-rc.0', '--out', out, '--key-file', 'k.pem']), 2);
  assert.equal(existsSync(out), false);
});

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length === 0 ? 0 : 1);
