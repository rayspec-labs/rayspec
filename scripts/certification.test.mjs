#!/usr/bin/env node
/**
 * Regression test for the certification lane's own logic — what it runs and how it judges — without
 * a database (the lane itself runs as `pnpm test:certification`).
 *
 *  - every suite file a check names exists, and every certification suite is named by a check;
 *  - a file passes only when it ran tests and all of them passed: a failed test, a skipped one, a
 *    file that ran no test and a file missing from the report each fail it, naming why;
 *  - a check fails when any of its files failed or did not run;
 *  - the suites see no provider credential and no live-test switch, and run in the runtime-role
 *    lane with the database required;
 *  - the arguments: an unknown check or a positional refuses; no DATABASE_URL refuses with exit 2
 *    before anything runs.
 *
 * Standalone (no test framework is wired for the scripts): `node <thisfile>`; exit 0 = pass.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHECKS,
  judgeChecks,
  judgeReport,
  laneEnvironment,
  NOT_APPLICABLE,
  PROVIDER_VARIABLES,
  parseCertificationArgs,
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
      name: `/repo/pkg/${file}`,
      status: fileStatus,
      assertionResults: statuses.map((status, i) => ({ title: `t${i}`, status })),
    },
  ],
});

check('a file whose tests all passed passes', () => {
  const v = judgeReport(report('src/a.test.ts', ['passed', 'passed']), 'src/a.test.ts');
  assert.deepEqual(v, { verdict: 'passed', passed: 2, failed: 0, skipped: 0, reason: null });
});

check('a failed test fails the file', () => {
  const v = judgeReport(report('src/a.test.ts', ['passed', 'failed'], 'failed'), 'src/a.test.ts');
  assert.equal(v.verdict, 'failed');
  assert.match(v.reason, /1 test\(s\) failed/);
});

check('a skipped, pending or todo test fails the file: it is not evidence', () => {
  for (const status of ['skipped', 'pending', 'todo']) {
    const v = judgeReport(report('src/a.test.ts', ['passed', status]), 'src/a.test.ts');
    assert.equal(v.verdict, 'failed', status);
    assert.match(v.reason, /skipped: a skipped test is not evidence/);
  }
});

check('a file that ran no test, or is missing from the report, fails', () => {
  assert.equal(
    judgeReport(report('src/a.test.ts', []), 'src/a.test.ts').reason,
    'the file ran no test',
  );
  assert.equal(
    judgeReport(report('src/a.test.ts', ['passed']), 'src/b.test.ts').reason,
    'the file was not run',
  );
  assert.equal(judgeReport(null, 'src/a.test.ts').reason, 'no test report');
});

check(
  'a test declared as not run in this lane, by exact title, is left out; any other skip is not',
  () => {
    const declared = [{ title: 't1', reason: 'proves the single-role boot' }];
    const ok = judgeReport(
      report('src/a.test.ts', ['passed', 'skipped']),
      'src/a.test.ts',
      declared,
    );
    assert.equal(ok.verdict, 'passed');
    assert.deepEqual(ok.notInThisLane, declared);
    const other = judgeReport(
      report('src/a.test.ts', ['skipped', 'skipped']),
      'src/a.test.ts',
      declared,
    );
    assert.equal(other.verdict, 'failed');
    // A declaration whose test now runs is stale and fails the file, so it cannot hide a later skip.
    const stale = judgeReport(
      report('src/a.test.ts', ['passed', 'passed']),
      'src/a.test.ts',
      declared,
    );
    assert.equal(stale.verdict, 'failed');
    assert.match(stale.reason, /declared as not run/);
  },
);

check('a file whose hook failed fails even when its tests passed', () => {
  const v = judgeReport(report('src/a.test.ts', ['passed'], 'failed'), 'src/a.test.ts');
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

check('without DATABASE_URL the script refuses with exit 2 before running anything', () => {
  const env = { PATH: process.env.PATH ?? '' };
  const run = spawnSync(process.execPath, [SCRIPT], { env, encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /DATABASE_URL must name a superuser/);
  assert.equal(run.stdout, '');
});

console.log(`\n${passed} checks passed`);
