#!/usr/bin/env node
/**
 * Regression test for the corpus run through an installed CLI (`corpus-conformance.mjs`).
 *
 *   - the whole corpus through the workspace's built CLI: every expectation a command line can
 *     state holds, and the ones it cannot are listed by id with the reason, never dropped;
 *   - a case file whose bytes are not the recorded ones fails its case instead of running;
 *   - a case generated at test time and not supplied fails its case;
 *   - a CLI that answers every command the same way fails, case by case;
 *   - an outcome that differs from its expectation in one term only, the refusal reason or the exit
 *     code, is a failure, both as a judgement and through a CLI that changes only that term;
 *   - the outcome of a run is read as the CLI suites read it: the verdict of an envelope without
 *     data follows the operation, and output that is not one JSON object is a failure.
 *
 * Needs `pnpm build` and `pnpm install` (tsx writes the generated case). Standalone:
 * `node <thisfile>`; exit 0 = pass.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { notExpressible, outcomeOf, runCorpus, sameOutcome } from './corpus-conformance.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT = join(REPO, 'packages', 'kernel', 'bundle-contract');
const EXPECTATIONS = join(CONTRACT, 'contract', 'fixtures', 'EXPECTATIONS.json');
const CORPUS = join(CONTRACT, 'corpus');
const CLI = join(REPO, 'packages', 'app', 'cli', 'dist', 'index.js');
const scratch = mkdtempSync(join(tmpdir(), 'rayspec-corpus-conformance-'));

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

const generated = join(scratch, 'generated');
const made = spawnSync(
  join(REPO, 'node_modules', '.bin', 'tsx'),
  [join(CONTRACT, 'scripts', 'gen-corpus.ts'), '--uncommitted', generated],
  { encoding: 'utf8' },
);
assert.equal(made.status, 0, made.stderr);
const doc = JSON.parse(readFileSync(EXPECTATIONS, 'utf8'));
const total = doc.cases.reduce((n, c) => n + c.expect.length, 0);

await check('the whole corpus holds through the built CLI, and nothing is dropped', async () => {
  const report = await runCorpus({
    cli: CLI,
    expectations: EXPECTATIONS,
    corpus: CORPUS,
    generated,
    work: join(scratch, 'run'),
  });
  assert.equal(report.ok, true, JSON.stringify(report.failed.slice(0, 3)));
  assert.equal(report.expectations, total);
  assert.equal(report.passed + report.notExpressible.length, total);
  assert.ok(report.passed > 240, `${report.passed} passed`);
  for (const e of report.notExpressible) assert.ok(e.reason.length > 0 && e.id.length > 0);
});

await check('a case file with other bytes fails its case', async () => {
  const corpus = join(scratch, 'corpus-altered');
  cpSync(CORPUS, corpus, { recursive: true });
  const file = join(corpus, 'app-good-minimal.ray');
  const bytes = readFileSync(file);
  bytes[bytes.length - 1] ^= 0x01;
  writeFileSync(file, bytes);
  const report = await runCorpus({
    cli: join(scratch, 'never-run.js'),
    expectations: EXPECTATIONS,
    corpus,
    generated,
    work: join(scratch, 'run-altered'),
    jobs: 1,
  }).catch((err) => ({ error: err }));
  // The CLI path does not exist: every case that does run fails, so look only at the altered one.
  const altered = report.failed.filter((f) => f.id === 'app-good-minimal');
  assert.deepEqual(altered, [
    {
      id: 'app-good-minimal',
      why: 'app-good-minimal.ray is not the bytes the expectation records',
    },
  ]);
  assert.equal(report.ok, false);
});

await check('a generated case that is not supplied fails its case', async () => {
  const report = await runCorpus({
    cli: CLI,
    expectations: EXPECTATIONS,
    corpus: CORPUS,
    generated: undefined,
    work: join(scratch, 'run-no-generated'),
  });
  assert.equal(report.ok, false);
  assert.deepEqual(report.failed, [
    { id: 'limit-entry-count', why: 'the case file limit-entry-count.ray is missing' },
  ]);
});

await check('a CLI that answers every command the same way fails case by case', async () => {
  const fake = join(scratch, 'fake-cli.mjs');
  writeFileSync(
    fake,
    "process.stdout.write(JSON.stringify({ ok: true, errors: [], data: { verdict: 'deployable' } }));\n",
  );
  mkdirSync(join(scratch, 'run-fake'), { recursive: true });
  const report = await runCorpus({
    cli: fake,
    expectations: EXPECTATIONS,
    corpus: CORPUS,
    generated,
    work: join(scratch, 'run-fake'),
  });
  assert.equal(report.ok, false);
  assert.ok(report.failed.length > 100, `${report.failed.length} failed`);
});

await check('an outcome that differs only in its reason or only in its exit code fails', () => {
  const want = {
    ok: false,
    verdict: 'invalid',
    code: 'RAY_INVALID_ARCHIVE',
    reason: 'not-a-zip',
    exit: 2,
  };
  assert.equal(sameOutcome({ ...want }, want), true);
  for (const [term, value] of [
    ['reason', 'unsafe-path'],
    ['exit', 1],
    ['code', 'RAY_LIMIT_EXCEEDED'],
    ['verdict', 'not-deployable'],
    ['ok', true],
  ]) {
    assert.notEqual(want[term], value);
    assert.equal(sameOutcome({ ...want, [term]: value }, want), false, term);
  }
});

/**
 * A CLI that runs the built one and changes one term of its answer: `reason` rewrites the reason
 * of every refusal, `exit` adds 10 to every non-zero exit code.
 */
function alteringCli(term) {
  const path = join(scratch, `altering-${term}.cjs`);
  writeFileSync(
    path,
    [
      "const { spawnSync } = require('node:child_process');",
      `const res = spawnSync(process.execPath, [${JSON.stringify(CLI)}, ...process.argv.slice(2)], { encoding: 'utf8' });`,
      'let out = res.stdout;',
      term === 'reason'
        ? "try { const e = JSON.parse(out); for (const x of e.errors ?? []) if (x.reason) x.reason = 'another-reason'; out = JSON.stringify(e); } catch {}"
        : '',
      'process.stdout.write(out);',
      term === 'exit'
        ? 'process.exit(res.status === 0 ? 0 : res.status + 10);'
        : 'process.exit(res.status);',
      '',
    ].join('\n'),
  );
  return path;
}

for (const term of ['reason', 'exit']) {
  await check(`a CLI that changes only the ${term} fails the cases that state one`, async () => {
    const work = join(scratch, `run-altered-${term}`);
    mkdirSync(work, { recursive: true });
    const report = await runCorpus({
      cli: alteringCli(term),
      expectations: EXPECTATIONS,
      corpus: CORPUS,
      generated,
      work,
    });
    assert.equal(report.ok, false);
    const stated = doc.cases.flatMap((c) =>
      c.expect.filter((e) => (term === 'reason' ? e.reason !== undefined : e.exit !== 0)),
    );
    assert.ok(stated.length > 10, `${stated.length} expectations state a ${term}`);
    assert.ok(report.failed.length > 10, `${report.failed.length} failed`);
    for (const f of report.failed) {
      assert.notEqual(f.got?.[term], f.expected?.[term], `${f.id} failed on another term`);
      for (const other of ['ok', 'verdict', 'code', 'reason', 'exit'].filter((t) => t !== term)) {
        assert.equal(f.got[other], f.expected[other], `${f.id}: ${other}`);
      }
    }
  });
}

await check('outcomes are read as the CLI suites read them', () => {
  assert.deepEqual(
    outcomeOf(
      'bundle.inspect',
      '{"ok":false,"data":null,"errors":[{"code":"RAY_INVALID_ARCHIVE","reason":"not-a-zip"}]}',
      2,
    ),
    {
      ok: false,
      verdict: 'invalid',
      code: 'RAY_INVALID_ARCHIVE',
      reason: 'not-a-zip',
      exit: 2,
    },
  );
  assert.equal(
    outcomeOf('bundle.verify', '{"ok":false,"data":null,"errors":[]}', 2).verdict,
    'not-deployable',
  );
  assert.equal(outcomeOf('bundle.verify', 'not json', 7).ok, null);
  const profiles = doc.runtimeProfiles;
  const plain = doc.cases.find((c) => c.id === 'app-good-minimal');
  assert.equal(notExpressible(plain, plain.expect[1], profiles), null);
  const narrower = doc.cases.find((c) => c.id === 'capability-not-provided');
  assert.match(
    notExpressible(
      narrower,
      narrower.expect.find((e) => e.runtimeProfile),
      profiles,
    ),
    /narrower/,
  );
});

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length === 0 ? 0 : 1);
