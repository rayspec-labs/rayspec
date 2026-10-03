#!/usr/bin/env node
/**
 * Regression test for the runtime the upgrade-with-data harness upgrades to
 * (`scripts/lib/upgrade-target.mjs`, `scripts/upgrade-with-data.mjs --candidate`), without a
 * database.
 *
 *   - with a candidate install, the CLI, the database roles setup and the extension packages are
 *     the install's, and the version is the installed launcher's; a directory without a launcher is
 *     refused;
 *   - a path that lies outside the install (a link back into the working tree, the working tree's
 *     CLI) or is missing is a problem, naming it;
 *   - the version a CLI reports is read from its `--version` line, and a CLI that fails reports none;
 *   - the harness itself, given a candidate whose CLI reports another version or whose package
 *     links into the working tree, stops before it touches a database, and its summary records the
 *     CLI it would have run and the version that CLI reported.
 *
 * Needs `pnpm build` (the working tree's CLI). Standalone: `node <thisfile>`; exit 0 = pass.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reportedVersion, targetProblems, upgradeTarget } from './lib/upgrade-target.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = '1.9.0-rc.0';
const scratch = mkdtempSync(join(tmpdir(), 'rayspec-upgrade-target-'));

let passed = 0;
const check = (label, fn) => {
  fn();
  passed += 1;
  console.log(`ok   ${label}`);
};

/** A consumer install of the candidate, with a CLI that reports `reports`. */
function candidateInstall(name, { reports = VERSION } = {}) {
  const root = join(scratch, name);
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  write(
    'node_modules/rayspec/package.json',
    `${JSON.stringify({ name: 'rayspec', version: VERSION, bin: { rayspec: 'dist/bin.js' } })}\n`,
  );
  write(
    'node_modules/rayspec/dist/bin.js',
    `process.stdout.write(JSON.stringify({ ok: true, version: ${JSON.stringify(reports)} }, null, 2));\n`,
  );
  write('node_modules/@rayspec/db/sql/database-roles.sql', '-- roles\n');
  write('node_modules/@rayspec/platform/package.json', '{}\n');
  write('node_modules/@rayspec/handler-sdk/package.json', '{}\n');
  return root;
}

try {
  check('a candidate target is the install, everything inside it', () => {
    const root = candidateInstall('good');
    const target = upgradeTarget({ repo: REPO, candidate: root });
    assert.equal(target.install, 'candidate');
    assert.equal(target.version, VERSION);
    assert.equal(target.cli, join(root, 'node_modules', 'rayspec', 'dist', 'bin.js'));
    assert.equal(
      target.rolesSql,
      join(root, 'node_modules', '@rayspec', 'db', 'sql', 'database-roles.sql'),
    );
    assert.deepEqual(
      target.packages.map(([name]) => name),
      ['platform', 'handler-sdk'],
    );
    assert.deepEqual(targetProblems(target), []);
    assert.equal(reportedVersion(target.cli), VERSION);
    assert.throws(
      () => upgradeTarget({ repo: REPO, candidate: join(scratch, 'empty') }),
      /holds no installed rayspec/,
    );
  });

  check('a path outside the install or missing is named', () => {
    const root = candidateInstall('linked');
    const platform = join(root, 'node_modules', '@rayspec', 'platform');
    rmSync(platform, { recursive: true });
    symlinkSync(join(REPO, 'packages', 'kernel', 'platform'), platform);
    const target = upgradeTarget({ repo: REPO, candidate: root });
    const workingTreeCli = upgradeTarget({ repo: REPO, candidate: null }).cli;
    const problems = targetProblems({ ...target, cli: workingTreeCli });
    assert.equal(problems.length, 2, problems.join('\n'));
    assert.match(problems[0], /^the CLI resolves to .*, outside the candidate install/);
    assert.match(problems[1], /^@rayspec\/platform resolves to .*, outside the candidate install/);
    rmSync(join(root, 'node_modules', '@rayspec', 'db'), { recursive: true });
    assert.match(targetProblems(target).join('\n'), /the database roles setup is missing/);
  });

  check('the working tree is its own target, with its own version', () => {
    const target = upgradeTarget({ repo: REPO, candidate: null });
    assert.equal(target.install, 'working tree');
    assert.deepEqual(targetProblems(target), []);
    assert.equal(reportedVersion(target.cli), target.version);
    assert.equal(reportedVersion(join(scratch, 'no-such-cli.js')), null);
  });

  /** The harness against `candidate`, with a database URL nothing listens on. */
  const harness = (candidate) => {
    const run = spawnSync(
      process.execPath,
      [join(REPO, 'scripts', 'upgrade-with-data.mjs'), '--from', '1.8.0', '--candidate', candidate],
      {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TMPDIR: scratch,
          DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/none',
        },
        timeout: 60000,
      },
    );
    return { status: run.status, stderr: run.stderr, summary: JSON.parse(run.stdout) };
  };

  check('the harness stops on a candidate CLI that reports another version', () => {
    const root = candidateInstall('other-version', { reports: '1.8.0' });
    const { status, summary, stderr } = harness(root);
    assert.equal(status, 1, stderr);
    assert.equal(summary.ok, false);
    assert.equal(summary.to, `${VERSION} (candidate install)`);
    assert.equal(summary.target.install, 'candidate');
    assert.equal(summary.target.cli, join(root, 'node_modules', 'rayspec', 'dist', 'bin.js'));
    assert.equal(summary.target.cliVersion, '1.8.0');
    assert.deepEqual(
      summary.checks.map((c) => [c.name, c.ok]),
      [
        ['the runtime upgraded to is the one named', true],
        [`the CLI upgraded to reports ${VERSION}`, false],
      ],
    );
    assert.ok(!stderr.includes('installing rayspec@'), 'nothing was installed or deployed');
  });

  check('the harness stops on a candidate whose package links into the working tree', () => {
    const root = candidateInstall('linked-harness');
    const sdk = join(root, 'node_modules', '@rayspec', 'handler-sdk');
    rmSync(sdk, { recursive: true });
    symlinkSync(join(REPO, 'packages', 'kernel', 'handler-sdk'), sdk);
    const { status, summary } = harness(root);
    assert.equal(status, 1);
    assert.deepEqual(summary.checks, [
      { name: 'the runtime upgraded to is the one named', ok: false },
    ]);
    assert.match(
      summary.error,
      /@rayspec\/handler-sdk resolves to .*, outside the candidate install/,
    );
  });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`ALL CASES PASSED (${passed})`);
