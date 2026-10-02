#!/usr/bin/env node
/**
 * Regression test for the reference journeys' own logic — the parts that decide what runs, not the
 * journeys themselves (those need a database and run as `pnpm test:journeys`).
 *
 *   (Q) the committed quickstart page plans: the install and the clone are done by the harness, every
 *       other command runs as written, the deploy that serves ends the first session and the second
 *       session uses it.
 *   (M) a page that drops or repeats a substituted line refuses, naming it.
 *   (S) a page without a serving deploy, or with two, refuses; an unclosed block refuses.
 *   (A) the arguments: every journey by default, an unknown one or a positional refuses.
 *   (R) the script refuses usage errors and a missing DATABASE_URL with exit 2, before any work.
 *   (D) the digests compare values, not key order, and notice a changed value.
 *   (J) a failed check ends a journey with its name.
 *
 * Standalone (no test framework is wired for the gate scripts): `node <thisfile>`; exit 0 = pass.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, Journey, JourneyFailure, rowsDigest } from './journeys/lib.mjs';
import { bashBlocks, quickstartPlan, SUBSTITUTIONS } from './journeys/quickstart.mjs';
import { JOURNEYS, parseJourneyArgs } from './reference-journeys.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, 'reference-journeys.mjs');
const PAGE = readFileSync(join(here, '..', 'docs', 'quickstart.md'), 'utf8');

let passed = 0;
const check = (label, fn) => {
  fn();
  passed += 1;
  console.log(`ok   ${label}`);
};

// (Q)
check('(Q) the quickstart page plans with the harness doing the install and the clone', () => {
  const plan = quickstartPlan(PAGE);
  assert.deepEqual(plan.harness, ['install', 'clone']);
  assert.ok(plan.blocks >= 5, `${plan.blocks} blocks`);
  const firstLines = plan.first.split('\n');
  assert.ok(
    firstLines.some((l) => l.startsWith('npx rayspec pack --spec team-notes/rayspec.yaml')),
  );
  assert.ok(firstLines.some((l) => l.startsWith('npx rayspec bundle verify ')));
  assert.equal(
    firstLines
      .filter((l) => l.trim() !== '')
      .at(-1)
      ?.startsWith('npx rayspec deploy '),
    true,
    'the first session ends with the serving deploy',
  );
  assert.ok(plan.first.includes('export DATABASE_URL="$QUICKSTART_DATABASE_URL"'));
  assert.ok(!plan.first.includes('localhost:5433'), 'the page database URLs are replaced');
  assert.ok(plan.second.includes('BASE="http://127.0.0.1:$PORT"'));
  assert.ok(plan.second.includes('/api/notes'));
  // Every line of the page that is not substituted is in one of the two scripts, as written.
  const substituted = new Set(SUBSTITUTIONS.map((s) => s.line));
  for (const line of bashBlocks(PAGE).flat()) {
    if (substituted.has(line.trim())) continue;
    assert.ok(`${plan.first}\n${plan.second}`.split('\n').includes(line), line);
  }
});

// (M)
check('(M) a page that drops or repeats a substituted line refuses, naming it', () => {
  const dropped = PAGE.replace('npm install rayspec\n', 'npm install rayspec@latest\n');
  assert.notEqual(dropped, PAGE, 'precondition: the page holds the install line');
  assert.throws(() => quickstartPlan(dropped), /npm install rayspec \(0 times\)/);
  const repeated = PAGE.replace(
    'BASE=http://127.0.0.1:8080\n',
    'BASE=http://127.0.0.1:8080\nBASE=http://127.0.0.1:8080\n',
  );
  assert.notEqual(repeated, PAGE, 'precondition: the page holds the base URL line');
  assert.throws(() => quickstartPlan(repeated), /BASE=http:\/\/127\.0\.0\.1:8080 \(2 times\)/);
});

// (S)
check('(S) no serving deploy, two of them, or an unclosed block refuse', () => {
  const serve = /^npx rayspec deploy team-notes-1\.0\.0\.ray --plan-digest .*$/m;
  assert.ok(serve.test(PAGE), 'precondition: the page holds the serving deploy');
  assert.throws(
    () => quickstartPlan(PAGE.replace(serve, 'echo no deploy')),
    /exactly one block, found 0/,
  );
  const line = PAGE.match(serve)[0];
  const twice = PAGE.replace('```bash\nBASE=', `\`\`\`bash\n${line}\n\`\`\`\n\n\`\`\`bash\nBASE=`);
  assert.notEqual(twice, PAGE);
  assert.throws(() => quickstartPlan(twice), /exactly one block, found 2/);
  assert.throws(() => bashBlocks('```bash\nls\n'), /not closed/);
});

// (A)
check('(A) every journey by default; an unknown journey or a positional refuses', () => {
  const all = parseJourneyArgs([]);
  assert.deepEqual(all.apps, Object.keys(JOURNEYS));
  assert.deepEqual(Object.keys(JOURNEYS), [
    'team-notes',
    'document-intake',
    'asset-catalog',
    'quickstart',
  ]);
  assert.deepEqual(parseJourneyArgs(['--app', 'quickstart', '--app', 'team-notes']).apps, [
    'quickstart',
    'team-notes',
  ]);
  assert.match(parseJourneyArgs(['--app', 'nope']).error, /unknown --app nope/);
  assert.ok('error' in parseJourneyArgs(['stray']));
  assert.ok('error' in parseJourneyArgs(['--unknown-flag']));
});

// (R)
check('(R) usage errors and a missing DATABASE_URL exit 2 before any work', () => {
  const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };
  const usage = spawnSync(process.execPath, [SCRIPT, '--app', 'nope'], { env, encoding: 'utf8' });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /unknown --app/);
  const noDb = spawnSync(process.execPath, [SCRIPT, '--app', 'team-notes'], {
    env,
    encoding: 'utf8',
  });
  assert.equal(noDb.status, 2);
  assert.match(noDb.stderr, /DATABASE_URL is not set/);
  assert.equal(noDb.stdout, '');
});

// (D)
check('(D) digests compare values, not key or row order, and notice a changed value', () => {
  assert.equal(
    canonical({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } }),
    canonical({ a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 }),
  );
  assert.notEqual(canonical({ a: [1, 2] }), canonical({ a: [2, 1] }));
  const rows = [
    { id: '1', title: 'Grüße', content: null },
    { id: '2', title: 'b', content: 'x' },
  ];
  const columns = ['id', 'title', 'content'];
  assert.equal(rowsDigest(rows, columns), rowsDigest([...rows].reverse(), columns));
  assert.notEqual(
    rowsDigest(rows, columns),
    rowsDigest([rows[0], { ...rows[1], content: 'y' }], columns),
  );
  assert.notEqual(rowsDigest(rows, columns), rowsDigest(rows.slice(0, 1), columns));
});

// (J)
check('(J) a failed check ends the journey with its name and records it', () => {
  const journey = new Journey('sample', () => {});
  journey.check('first passes', true);
  assert.throws(
    () => journey.check('second fails', false, 'why'),
    (err) => {
      assert.ok(err instanceof JourneyFailure);
      assert.equal(err.message, 'sample: second fails — why');
      return true;
    },
  );
  assert.deepEqual(journey.checks, [
    { name: 'first passes', ok: true },
    { name: 'second fails', ok: false },
  ]);
});

console.log(`ALL CASES PASSED (${passed})`);
