#!/usr/bin/env node
/**
 * Regression test for the certification lane's own logic — what it runs and how it judges — without
 * a database (the lane itself runs as `pnpm test:certification`).
 *
 *  - every suite file a check names exists, and every certification suite is named by a check;
 *  - a file passes only when it ran tests and all of them passed: a failed test, a skipped one, a
 *    file that ran no test and a file missing from the report each fail it, naming why; a report of
 *    a file of the same name in another package is not taken for it;
 *  - a file whose vitest run did not exit 0 fails even when its report lists every test as passed,
 *    and a report left by an earlier run is never judged in place of a run that wrote none;
 *  - a check fails when any of its files failed or did not run;
 *  - the suites see no provider credential and no live-test switch, and run in the runtime-role
 *    lane with the database required;
 *  - the lane records what it ran on: the commit, whether the tree was clean, the runtime version and
 *    the platform, and claims no commit outside a checkout;
 *  - the log directory, summary and receipt the docs write into the repository are ignored by git, so
 *    a second run still finds a clean tree;
 *  - the arguments: an unknown check or a positional refuses; no DATABASE_URL refuses with exit 2
 *    before anything runs.
 *
 * Standalone (no test framework is wired for the scripts): `node <thisfile>`; exit 0 = pass.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHECKS,
  judgeChecks,
  judgeReport,
  judgeRun,
  laneEnvironment,
  laneFacts,
  NOT_APPLICABLE,
  PROVIDER_VARIABLES,
  parseCertificationArgs,
  reportNameOf,
  runFile,
  suitesOf,
} from './certification.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..');
const SCRIPT = join(here, 'certification.mjs');

let passed = 0;
const check = (label, fn) => {
  fn();
  passed += 1;
  console.log(`ok   ${label}`);
};

check('every suite file a check names exists', () => {
  for (const c of CHECKS) {
    assert.ok(c.suites.length > 0, `${c.id} names no suite`);
    for (const s of c.suites) {
      assert.ok(
        existsSync(join(REPO, s.dir, s.file)),
        `${c.id}: ${s.dir}/${s.file} does not exist`,
      );
      if (s.config !== null) {
        assert.ok(existsSync(join(REPO, s.dir, s.config)), `${c.id}: ${s.config} does not exist`);
      }
    }
  }
});

check('every certification suite is named by a check', () => {
  const dir = join(REPO, 'packages/app/cli/src/certification');
  const named = new Set(CHECKS.flatMap((c) => c.suites.map((s) => s.file)));
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.test.ts'))) {
    assert.ok(named.has(`src/certification/${file}`), `${file} is not part of any check`);
  }
});

check('check ids are unique and every check and exemption says what it proves', () => {
  const ids = [...CHECKS, ...NOT_APPLICABLE].map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const c of [...CHECKS, ...NOT_APPLICABLE]) assert.ok(c.check.length > 20, c.id);
  for (const c of NOT_APPLICABLE) assert.ok(c.reason.length > 20, c.id);
});

check('a file shared by several checks runs once', () => {
  const suites = suitesOf(CHECKS);
  const keys = suites.map((s) => `${s.dir}/${s.file}`);
  assert.equal(new Set(keys).size, keys.length);
  const hosting = suites.find((s) => s.file === 'src/certification/hosting-checks.test.ts');
  assert.ok(hosting.checks.length > 3);
});

const report = (file, statuses, fileStatus = 'passed') => ({
  testResults: [
    {
      name: `/repo/${file}`,
      status: fileStatus,
      assertionResults: statuses.map((status, i) => ({ title: `t${i}`, status })),
    },
  ],
});

check('a file whose tests all passed passes', () => {
  const v = judgeReport(report('pkg/src/a.test.ts', ['passed', 'passed']), 'pkg/src/a.test.ts');
  assert.deepEqual(v, { verdict: 'passed', passed: 2, failed: 0, skipped: 0, reason: null });
});

check('a failed test fails the file', () => {
  const v = judgeReport(
    report('pkg/src/a.test.ts', ['passed', 'failed'], 'failed'),
    'pkg/src/a.test.ts',
  );
  assert.equal(v.verdict, 'failed');
  assert.match(v.reason, /1 test\(s\) failed/);
});

check('a skipped, pending or todo test fails the file: it is not evidence', () => {
  for (const status of ['skipped', 'pending', 'todo']) {
    const v = judgeReport(report('pkg/src/a.test.ts', ['passed', status]), 'pkg/src/a.test.ts');
    assert.equal(v.verdict, 'failed', status);
    assert.match(v.reason, /skipped: a skipped test is not evidence/);
  }
});

check('a file that ran no test, or is missing from the report, fails', () => {
  assert.equal(
    judgeReport(report('pkg/src/a.test.ts', []), 'pkg/src/a.test.ts').reason,
    'the file ran no test',
  );
  assert.equal(
    judgeReport(report('pkg/src/a.test.ts', ['passed']), 'pkg/src/b.test.ts').reason,
    'the file was not run',
  );
  assert.equal(judgeReport(null, 'pkg/src/a.test.ts').reason, 'no test report');
});

check('a report of a file of the same name in another package is not taken for it', () => {
  const openai = report('packages/adapters/openai/src/hanging-provider.test.ts', ['passed']);
  assert.equal(
    judgeReport(openai, 'packages/adapters/openai/src/hanging-provider.test.ts').verdict,
    'passed',
  );
  for (const other of [
    'packages/adapters/deepgram/src/hanging-provider.test.ts',
    'adapters/deepgram/src/hanging-provider.test.ts',
  ]) {
    // The precondition: the file names are the same, only the package differs.
    assert.ok(openai.testResults[0].name.endsWith('src/hanging-provider.test.ts'));
    assert.equal(judgeReport(openai, other).reason, 'the file was not run', other);
  }
  // A path that only ends like the file's path, without a directory boundary, is not it either.
  const lookalike = report('xpkg/src/a.test.ts', ['passed']);
  assert.equal(judgeReport(lookalike, 'pkg/src/a.test.ts').reason, 'the file was not run');
});

check('a run that did not exit 0 fails a file whose report passed, and says why', () => {
  const passing = judgeReport(report('pkg/src/a.test.ts', ['passed']), 'pkg/src/a.test.ts');
  assert.equal(passing.verdict, 'passed');
  const clean = judgeRun(passing, { status: 0, signal: null });
  assert.equal(clean.verdict, 'passed');
  assert.equal(clean.exit, 0);
  const unhandled = judgeRun(passing, { status: 1, signal: null });
  assert.equal(unhandled.verdict, 'failed');
  assert.equal(unhandled.exit, 1);
  assert.match(unhandled.reason, /exited with status 1: an error outside the tests/);
  const killed = judgeRun(passing, { status: null, signal: 'SIGKILL' });
  assert.equal(killed.verdict, 'failed');
  assert.equal(killed.signal, 'SIGKILL');
  assert.match(killed.reason, /ended by SIGKILL/);
  const unstarted = judgeRun(passing, {
    status: null,
    signal: null,
    error: Object.assign(new Error('spawn pnpm ENOENT'), { code: 'ENOENT' }),
  });
  assert.equal(unstarted.verdict, 'failed');
  assert.match(unstarted.reason, /could not be run \(ENOENT\)/);
  // A file that already failed keeps the reason its report gives.
  const failing = judgeReport(
    report('pkg/src/a.test.ts', ['failed'], 'failed'),
    'pkg/src/a.test.ts',
  );
  assert.match(judgeRun(failing, { status: 1, signal: null }).reason, /1 test\(s\) failed/);
});

check(
  'a report an earlier run left in the log directory is not judged for a run that wrote none',
  () => {
    const logDir = mkdtempSync(join(tmpdir(), 'rayspec-lane-stale-'));
    try {
      // A config that does not exist: vitest exits before it writes a report.
      const suite = {
        dir: 'packages/kernel/platform',
        config: 'no-such-vitest.config.ts',
        file: 'src/outbound-guard.test.ts',
        notInThisLane: [],
      };
      assert.ok(!existsSync(join(REPO, suite.dir, suite.config)));
      const name = reportNameOf(suite, 1);
      const stale = report(`${suite.dir}/${suite.file}`, ['passed']);
      assert.equal(judgeReport(stale, `${suite.dir}/${suite.file}`).verdict, 'passed');
      writeFileSync(join(logDir, `${name}.json`), JSON.stringify(stale));
      const v = runFile(
        suite,
        laneEnvironment({ ...process.env, DATABASE_URL: 'unused' }),
        logDir,
        1,
      );
      assert.equal(v.verdict, 'failed');
      assert.equal(v.reason, 'no test report');
      assert.notEqual(v.exit, 0);
      assert.ok(!existsSync(join(logDir, `${name}.json`)), 'the stale report is still there');
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  },
);

check(
  'a test declared as not run in this lane, by exact title, is left out; any other skip is not',
  () => {
    const declared = [{ title: 't1', reason: 'proves the single-role boot' }];
    const ok = judgeReport(
      report('pkg/src/a.test.ts', ['passed', 'skipped']),
      'pkg/src/a.test.ts',
      declared,
    );
    assert.equal(ok.verdict, 'passed');
    assert.deepEqual(ok.notInThisLane, declared);
    const other = judgeReport(
      report('pkg/src/a.test.ts', ['skipped', 'skipped']),
      'pkg/src/a.test.ts',
      declared,
    );
    assert.equal(other.verdict, 'failed');
    // A declaration whose test now runs is stale and fails the file, so it cannot hide a later skip.
    const stale = judgeReport(
      report('pkg/src/a.test.ts', ['passed', 'passed']),
      'pkg/src/a.test.ts',
      declared,
    );
    assert.equal(stale.verdict, 'failed');
    assert.match(stale.reason, /declared as not run/);
  },
);

check('a file whose hook failed fails even when its tests passed', () => {
  const v = judgeReport(report('pkg/src/a.test.ts', ['passed'], 'failed'), 'pkg/src/a.test.ts');
  assert.equal(v.verdict, 'failed');
});

check('a check fails when one of its files failed or did not run', () => {
  const checks = [
    {
      id: 'x',
      check: 'a check',
      suites: [
        { dir: 'p', config: null, file: 'a' },
        { dir: 'p', config: null, file: 'b' },
      ],
    },
  ];
  const ok = { verdict: 'passed', passed: 1, failed: 0, skipped: 0, reason: null };
  assert.equal(
    judgeChecks(
      checks,
      new Map([
        ['p/a', ok],
        ['p/b', ok],
      ]),
    )[0].verdict,
    'passed',
  );
  assert.equal(judgeChecks(checks, new Map([['p/a', ok]]))[0].verdict, 'failed');
  assert.equal(
    judgeChecks(
      checks,
      new Map([
        ['p/a', ok],
        ['p/b', { ...ok, verdict: 'failed' }],
      ]),
    )[0].verdict,
    'failed',
  );
});

check('the suites see no provider credential and run in the runtime-role lane', () => {
  const env = laneEnvironment({
    DATABASE_URL: 'postgres://u@h/db',
    OPENAI_API_KEY: 'present',
    RAYSPEC_REQUIRE_LIVE_TESTS: 'true',
  });
  for (const name of PROVIDER_VARIABLES) assert.equal(env[name], '', name);
  assert.equal(env.RAYSPEC_REQUIRE_DB_TESTS, 'true');
  assert.equal(env.RAYSPEC_TEST_DATABASE_ISOLATION, 'roles');
  assert.equal(env.SHADOW_DATABASE_URL, 'postgres://u@h/db');
});

check('the arguments: a subset by id; an unknown check or a positional refuses', () => {
  assert.deepEqual(
    parseCertificationArgs(['--check', 'outbound-guard']).checks.map((c) => c.id),
    ['outbound-guard'],
  );
  assert.match(parseCertificationArgs(['--check', 'nope']).error, /unknown check: nope/);
  assert.ok('error' in parseCertificationArgs(['stray']));
});

check('the lane records the commit, the tree state, the runtime version and the platform', () => {
  const facts = laneFacts();
  assert.match(facts.sourceCommit, /^[a-f0-9]{40}$/);
  assert.equal(typeof facts.worktreeClean, 'boolean');
  const server = JSON.parse(readFileSync(join(REPO, 'packages/app/server/package.json'), 'utf8'));
  assert.equal(facts.runtimeVersion, server.version);
  assert.deepEqual(facts.target, {
    os: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
  });
  // Outside a checkout nothing is claimed: no commit, and the tree is not called clean.
  const outside = mkdtempSync(join(tmpdir(), 'rayspec-lane-facts-'));
  try {
    const none = laneFacts(outside);
    assert.equal(none.sourceCommit, null);
    assert.equal(none.worktreeClean, false);
    assert.equal(none.runtimeVersion, null);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

check('the output the docs write into the repository leaves the working tree clean', () => {
  const doc = readFileSync(join(REPO, 'docs', 'hardened-posture.md'), 'utf8');
  const named = new Set();
  for (const m of doc.matchAll(/--(?:log-dir|lane|out) ([A-Za-z0-9._-]+)/g)) named.add(m[1]);
  // The precondition: the docs do name a log directory, a summary and a receipt.
  assert.ok(named.has('certification-logs') && named.has('certification.json'), [...named].join());
  assert.ok(named.has('managed-receipt.json'), [...named].join());
  for (const path of named) {
    const probe = path.endsWith('.json') ? path : `${path}/summary.json`;
    const run = spawnSync('git', ['check-ignore', '-q', probe], { cwd: REPO });
    assert.equal(run.status, 0, `${probe} is not ignored`);
  }
});

check('without DATABASE_URL the script refuses with exit 2 before running anything', () => {
  const env = { PATH: process.env.PATH ?? '' };
  const run = spawnSync(process.execPath, [SCRIPT], { env, encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /DATABASE_URL must name a superuser/);
  assert.equal(run.stdout, '');
});

console.log(`\n${passed} checks passed`);
