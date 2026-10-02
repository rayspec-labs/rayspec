#!/usr/bin/env node
/**
 * Regression test for the managed-posture receipt generator (`scripts/managed-receipt.mjs`), against
 * lane directories built here: a summary and one vitest JSON report per suite file, as the lane writes
 * them.
 *
 *  - a lane where every check passed, on linux x64 with Node 22, at the checkout's commit, with a
 *    matching release manifest, gives a receipt that `validateReceipt` accepts, that claims exactly
 *    the protections the checks establish, lists every report it rests on with its digest, and is the
 *    same bytes every time;
 *  - the receipt is refused (exit 1, nothing written) when the lane did not pass, a check failed or is
 *    missing, a report shows a skipped or failed test the summary called passed, a report is missing
 *    or named by a path, the tree was not clean, the commit is not the checkout's, the lane ran on
 *    another platform or an older Node, the lane did not run as the runtime role, or the release
 *    manifest is for another version, another commit or another target, or is not canonical;
 *  - a backend is claimed only when every evidence file of its matrix row passed;
 *  - every fixed protection of the receipt schema is claimed through a named check, and every check
 *    named exists;
 *  - docs/threat-model.md states every residual risk word for word and renders the supported-backend
 *    matrix's rows;
 *  - the arguments: a missing lane or release manifest, both or neither artifact option, or a malformed
 *    digest is a usage error (exit 2).
 *
 * Needs `pnpm build` (the generator reads the built contract and matrix). Standalone (no test
 * framework is wired for the scripts): `node <thisfile>`; exit 0 = pass.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CHECKS, SUMMARY_FILE, suitesOf } from './certification.mjs';
import { RESIDUAL_RISKS } from './lib/residual-risks.mjs';
import {
  ATTESTATIONS,
  main,
  parseReceiptArgs,
  ReceiptRefused,
  receiptOf,
} from './managed-receipt.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..');
const contract = await import(
  pathToFileURL(join(REPO, 'packages/kernel/bundle-contract/dist/index.js')).href
);
const { SUPPORTED_BACKEND_MATRIX } = await import(
  pathToFileURL(join(REPO, 'packages/app/server/dist/supported-backends.js')).href
);

let passed = 0;
const check = async (label, fn) => {
  await fn();
  passed += 1;
  console.log(`ok   ${label}`);
};

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const COMMIT = 'c'.repeat(40);
const VERSION = '1.2.3-rc.0';
const scratch = mkdtempSync(join(tmpdir(), 'rayspec-managed-receipt-'));
let dirs = 0;

/** A report of one suite file: every test passed, the declared not-in-this-lane ones skipped. */
function passingReport(suite) {
  return {
    testResults: [
      {
        name: `/repo/${suite.dir}/${suite.file}`,
        status: 'passed',
        assertionResults: [
          { title: 'proves it', status: 'passed' },
          ...(suite.notInThisLane ?? []).map((n) => ({ title: n.title, status: 'skipped' })),
        ],
      },
    ],
  };
}

/** A lane directory as `scripts/certification.mjs` writes it, every check passed; `change` edits it. */
function laneDir(change = {}) {
  const dir = join(scratch, `lane-${++dirs}`);
  mkdirSync(dir);
  const reports = new Map();
  for (const [i, suite] of suitesOf(CHECKS).entries()) {
    const name = `${String(i + 1).padStart(2, '0')}-report.json`;
    reports.set(`${suite.dir}/${suite.file}`, name);
    const report = change.report?.(suite) ?? passingReport(suite);
    if (report !== 'absent') writeFileSync(join(dir, name), JSON.stringify(report));
  }
  const summary = {
    ok: true,
    sourceCommit: COMMIT,
    worktreeClean: true,
    runtimeVersion: VERSION,
    target: { os: 'linux', arch: 'x64', nodeVersion: '22.23.3' },
    posture: { databaseIsolation: 'roles' },
    checks: CHECKS.map((c) => ({
      id: c.id,
      verdict: 'passed',
      files: c.suites.map((s) => ({
        file: `${s.dir}/${s.file}`,
        verdict: 'passed',
        report: reports.get(`${s.dir}/${s.file}`),
      })),
    })),
  };
  writeFileSync(join(dir, SUMMARY_FILE), JSON.stringify(change.summary?.(summary) ?? summary));
  return dir;
}

/** The release manifest of the contract's own fixture, for this version and commit. */
function releaseManifest(change = (m) => m) {
  const expectations = JSON.parse(
    readFileSync(
      join(REPO, 'packages/kernel/bundle-contract/contract/fixtures/EXPECTATIONS.json'),
      'utf8',
    ),
  );
  const good = expectations.documentCases.find((c) => c.id === 'release-manifest-good').document;
  const manifest = change({
    ...good,
    rayspecVersion: VERSION,
    sourceCommit: COMMIT,
    packages: good.packages.map((p) => ({ ...p, version: VERSION })),
  });
  const path = join(scratch, `release-${++dirs}.json`);
  writeFileSync(
    path,
    typeof manifest === 'string' ? manifest : contract.canonicalJsonFile(manifest),
  );
  return path;
}

const ARTIFACT_SHA = sha256(Buffer.from('a runtime artifact'));

/** Run the generator in this process; returns the exit code, the output path and its bytes. */
async function generate({ lane = laneDir(), manifest = releaseManifest(), head = COMMIT } = {}) {
  const out = join(scratch, `receipt-${++dirs}.json`);
  const code = await main(
    [
      '--lane',
      lane,
      '--release-manifest',
      manifest,
      '--artifact-sha256',
      ARTIFACT_SHA,
      '--out',
      out,
    ],
    { repoHead: head },
  );
  let text = null;
  try {
    text = readFileSync(out, 'utf8');
  } catch {
    text = null;
  }
  return { code, out, text };
}

/** The generator refuses with exit 1, for the reason `why` matches, and writes nothing. */
async function refused(input, why) {
  const said = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk) => said.push(String(chunk)) > 0;
  let result;
  try {
    result = await generate(input);
  } finally {
    process.stderr.write = write;
  }
  assert.equal(result.code, 1);
  assert.equal(result.text, null);
  assert.match(said.join(''), why);
}

try {
  await check(
    'a lane where every check passed gives a receipt validateReceipt accepts',
    async () => {
      const lane = laneDir();
      const manifest = releaseManifest();
      const { code, text } = await generate({ lane, manifest });
      assert.equal(code, 0);
      const checked = contract.validateReceipt(text);
      assert.equal(checked.ok, true, JSON.stringify(checked.errors));
      const r = checked.value;
      assert.equal(text, contract.canonicalJsonFile(r));
      assert.deepEqual(
        Object.keys(r).sort(),
        [...contract.CONTRACT_SCHEMAS.managedReceipt.required].sort(),
      );
      assert.equal(r.runtimeVersion, VERSION);
      assert.equal(r.sourceCommit, COMMIT);
      assert.equal(r.releaseManifestSha256, sha256(readFileSync(manifest)));
      assert.equal(r.artifactSha256, ARTIFACT_SHA);
      assert.deepEqual(r.targets, [
        { os: 'linux', arch: 'x64', nodeMajor: 22, nodeVersion: '22.23.3' },
      ]);
      assert.deepEqual(r.supportedBackends, ['openai']);
      for (const id of ['agent-backend-openai', 'stt-deepgram', 'tts-openai', 'custom-handlers']) {
        assert.ok(r.capabilities.includes(id), id);
      }
      for (const c of contract.CAPABILITIES.filter((x) => x.managedPosture !== 'allowed')) {
        assert.ok(!r.capabilities.includes(c.id), c.id);
      }
      assert.equal(r.recoveryScopeEndpoint, 'disabled');
      assert.deepEqual(r.executionLevels, ['none', 'in-process']);
      assert.deepEqual(
        r.residualRisks,
        RESIDUAL_RISKS.map((x) => ({ risk: x.risk, owner: x.owner })),
      );
      // Every evidence entry names a file of the lane directory and carries its digest; every check
      // and every suite file of each check is there, and the summary itself.
      for (const e of r.evidence) {
        assert.equal(e.sha256, sha256(readFileSync(join(lane, e.reference))), e.reference);
      }
      const expected = CHECKS.reduce((n, c) => n + c.suites.length, 0) + 1;
      assert.equal(r.evidence.length, expected);
      assert.equal(r.evidence.at(-1).reference, SUMMARY_FILE);
      // The same inputs give the same bytes.
      assert.equal((await generate({ lane, manifest })).text, text);
    },
  );

  await check(
    'a lane that did not pass, or a check that failed or did not run, refuses',
    async () => {
      await refused(
        { lane: laneDir({ summary: (s) => ({ ...s, ok: false }) }) },
        /lane did not pass/,
      );
      await refused(
        {
          lane: laneDir({
            summary: (s) => ({
              ...s,
              checks: s.checks.map((c) =>
                c.id === 'resource-bounds' ? { ...c, verdict: 'failed' } : c,
              ),
            }),
          }),
        },
        /check resource-bounds did not pass/,
      );
      await refused(
        {
          lane: laneDir({
            summary: (s) => ({
              ...s,
              checks: s.checks.filter((c) => c.id !== 'single-tenant-mode'),
            }),
          }),
        },
        /did not run the check single-tenant-mode/,
      );
      // A check that ran fewer suite files than this checkout names is an older lane.
      await refused(
        {
          lane: laneDir({
            summary: (s) => ({
              ...s,
              checks: s.checks.map((c) =>
                c.id === 'supported-backends' ? { ...c, files: c.files.slice(1) } : c,
              ),
            }),
          }),
        },
        /supported-backends ran other suite files/,
      );
    },
  );

  await check('the reports are judged again: a skipped or failed test refuses', async () => {
    for (const status of ['skipped', 'failed']) {
      await refused(
        {
          lane: laneDir({
            report: (suite) =>
              suite.file === 'src/hanging-provider.test.ts' && suite.dir.endsWith('/openai')
                ? {
                    testResults: [
                      {
                        name: `/repo/${suite.dir}/${suite.file}`,
                        status: 'passed',
                        assertionResults: [
                          { title: 'a', status: 'passed' },
                          { title: 'b', status },
                        ],
                      },
                    ],
                  }
                : undefined,
          }),
        },
        new RegExp(
          `openai/src/hanging-provider.test.ts did not pass in its own report \\(1 test\\(s\\) ${status}`,
        ),
      );
    }
  });

  await check('a missing report, or one named by a path, refuses', async () => {
    await refused(
      {
        lane: laneDir({
          report: (suite) =>
            suite.file === 'src/certification/round-trip.test.ts' ? 'absent' : undefined,
        }),
      },
      /report of packages\/app\/cli\/src\/certification\/round-trip.test.ts cannot be read/,
    );
    await refused(
      {
        lane: laneDir({
          summary: (s) => ({
            ...s,
            checks: s.checks.map((c, i) =>
              i === 0
                ? {
                    ...c,
                    files: c.files.map((f, j) => (j === 0 ? { ...f, report: '../x.json' } : f)),
                  }
                : c,
            ),
          }),
        }),
      },
      /names no report in the lane directory/,
    );
  });

  await check('a lane that cannot name the tested code refuses', async () => {
    await refused(
      { lane: laneDir({ summary: (s) => ({ ...s, worktreeClean: false }) }) },
      /working tree with changes/,
    );
    await refused(
      { lane: laneDir({ summary: (s) => ({ ...s, sourceCommit: null }) }) },
      /names no commit/,
    );
    await refused({ head: 'd'.repeat(40) }, /this checkout is at d{40}/);
    await refused(
      {
        lane: laneDir({ summary: (s) => ({ ...s, posture: { databaseIsolation: 'superuser' } }) }),
      },
      /did not run as the runtime role/,
    );
  });

  await check('a lane on another platform or an older Node refuses', async () => {
    for (const target of [
      { os: 'darwin', arch: 'arm64', nodeVersion: '22.23.3' },
      { os: 'darwin', arch: 'x64', nodeVersion: '22.23.3' },
      { os: 'linux', arch: 'arm64', nodeVersion: '22.23.3' },
      { os: 'linux', arch: 'x64', nodeVersion: '22.20.9' },
      { os: 'linux', arch: 'x64', nodeVersion: '24.1.0' },
    ]) {
      // The precondition: the contract itself refuses the target this case gives.
      assert.ok(
        !(
          target.os === 'linux' &&
          target.arch === 'x64' &&
          /^22[.](2[1-9]|[3-9][0-9])[.]/.test(target.nodeVersion)
        ),
      );
      await refused(
        { lane: laneDir({ summary: (s) => ({ ...s, target }) }) },
        /names only linux\/x64/,
      );
    }
  });

  await check(
    'a release manifest of another release, commit or target, or not canonical, refuses',
    async () => {
      await refused(
        { manifest: releaseManifest((m) => ({ ...m, rayspecVersion: '9.9.9' })) },
        /is for 9.9.9/,
      );
      await refused(
        { manifest: releaseManifest((m) => ({ ...m, sourceCommit: 'e'.repeat(40) })) },
        /built from e{40}/,
      );
      await refused(
        {
          manifest: releaseManifest((m) => ({
            ...m,
            targets: [{ os: 'linux', arch: 'x64', nodeMajor: 24 }],
            images: m.images.map((i) => ({ ...i, target: { ...i.target, nodeMajor: 24 } })),
          })),
        },
        /does not list the target the lane ran on/,
      );
      await refused(
        { manifest: releaseManifest((m) => `${JSON.stringify(m, null, 2)}\n`) },
        /not canonical JSON/,
      );
      await refused(
        { manifest: releaseManifest((m) => ({ ...m, releaseManifestFormatVersion: 2 })) },
        /does not match its schema/,
      );
      await refused(
        { manifest: join(scratch, 'no-such-manifest.json') },
        /release manifest cannot be read/,
      );
    },
  );

  await check('a backend is claimed only when every evidence file of its row passed', async () => {
    const all = new Set(suitesOf(CHECKS).map((s) => `${s.dir}/${s.file}`));
    const lane = {
      sourceCommit: COMMIT,
      runtimeVersion: VERSION,
      target: { os: 'linux', arch: 'x64', nodeMajor: 22, nodeVersion: '22.23.3' },
      passedChecks: new Set(CHECKS.map((c) => c.id)),
      evidence: [{ protection: 'x', reference: SUMMARY_FILE, sha256: ARTIFACT_SHA }],
    };
    const input = (passedFiles) => ({
      lane: { ...lane, passedFiles },
      releaseManifestSha256: ARTIFACT_SHA,
      artifactSha256: ARTIFACT_SHA,
      matrix: SUPPORTED_BACKEND_MATRIX,
      contract,
    });
    const deepgram = SUPPORTED_BACKEND_MATRIX.find((r) => r.id === 'deepgram').evidence[0];
    const withoutDeepgram = receiptOf(input(new Set([...all].filter((f) => f !== deepgram))));
    assert.ok(!withoutDeepgram.capabilities.includes('stt-deepgram'));
    assert.ok(withoutDeepgram.capabilities.includes('tts-openai'));
    const openai = SUPPORTED_BACKEND_MATRIX.find((r) => r.kind === 'agent' && r.id === 'openai');
    assert.ok(openai.evidence.length > 0);
    assert.throws(
      () => receiptOf(input(new Set([...all].filter((f) => f !== openai.evidence[0])))),
      (err) => err instanceof ReceiptRefused && /no agent backend/.test(err.message),
    );
    // A protection whose check did not pass is not claimed.
    assert.throws(
      () =>
        receiptOf({
          ...input(all),
          lane: { ...lane, passedFiles: all, passedChecks: new Set(['outbound-guard']) },
        }),
      (err) => err instanceof ReceiptRefused && /rests on the check/.test(err.message),
    );
  });

  await check('every fixed protection is claimed through checks that exist', async () => {
    const schema = contract.CONTRACT_SCHEMAS.managedReceipt;
    const fixed = Object.entries(schema.properties)
      .filter(([, p]) => 'const' in p || 'enum' in p || p.items?.enum)
      .map(([name]) => name)
      .filter(
        (name) =>
          ![
            'receiptFormatVersion',
            'contractVersion',
            'capabilityVocabularyVersion',
            'supportedBackends',
          ].includes(name),
      );
    assert.deepEqual(ATTESTATIONS.map((a) => a.field).sort(), fixed.sort());
    const ids = new Set(CHECKS.map((c) => c.id));
    for (const a of ATTESTATIONS) {
      assert.ok(a.checks.length > 0, a.field);
      for (const id of a.checks) assert.ok(ids.has(id), `${a.field}: ${id}`);
    }
    // Every check of the lane backs some claim, so none runs for nothing.
    const used = new Set(ATTESTATIONS.flatMap((a) => a.checks));
    for (const id of ids) {
      if (id !== 'supported-backends') assert.ok(used.has(id), `${id} backs no claim`);
    }
    // Every evidence file of an allowed backend is a suite file of the lane, so it can be proven.
    const files = new Set(suitesOf(CHECKS).map((s) => `${s.dir}/${s.file}`));
    for (const row of SUPPORTED_BACKEND_MATRIX.filter((r) => r.managed === 'allowed')) {
      for (const path of row.evidence) assert.ok(files.has(path), `${row.id}: ${path}`);
    }
  });

  await check(
    'docs/threat-model.md states every residual risk and renders the matrix',
    async () => {
      const doc = readFileSync(join(REPO, 'docs', 'threat-model.md'), 'utf8');
      const section = (heading) => {
        const start = doc.indexOf(heading);
        assert.ok(start >= 0, heading);
        const end = doc.indexOf('\n## ', start + 1);
        return doc.slice(start, end === -1 ? undefined : end);
      };
      // Markup aside (code spans, bold), the words must be the same.
      const flat = (text) => text.replace(/[`*]/g, '').replace(/\s+/g, ' ');
      const risks = flat(section('## Accepted residual risks'));
      for (const r of RESIDUAL_RISKS) {
        assert.ok(risks.includes(`${r.owner}: ${flat(r.risk)}`), r.risk.slice(0, 60));
      }
      const rows = section('## Supported backends')
        .split('\n')
        .filter((line) => line.startsWith('| `'))
        .map((line) => line.split('|').map((cell) => cell.trim()))
        .map((cells) => `${cells[1]} ${cells[2]} ${cells[3]}`);
      assert.deepEqual(
        rows,
        SUPPORTED_BACKEND_MATRIX.map((r) => `\`${r.id}\` ${r.kind} ${r.managed}`),
      );
    },
  );

  await check(
    'docs/hardened-posture.md names the checks behind every claimed protection',
    async () => {
      const doc = readFileSync(join(REPO, 'docs', 'hardened-posture.md'), 'utf8');
      const start = doc.indexOf('### The managed-posture receipt');
      assert.ok(start >= 0);
      const rows = doc
        .slice(start, doc.indexOf('\n## ', start))
        .split('\n')
        .filter((line) => line.startsWith('| `'));
      for (const a of ATTESTATIONS) {
        const row = rows.find((line) => line.split('|')[1].includes(`\`${a.field}\``));
        assert.ok(row, a.field);
        const named = [...row.split('|')[3].matchAll(/`([a-z-]+)`/g)].map((m) => m[1]);
        assert.deepEqual(named.sort(), [...a.checks].sort(), a.field);
      }
    },
  );

  await check('the arguments: lane, release manifest and one artifact are required', async () => {
    const base = ['--lane', 'l', '--release-manifest', 'm'];
    assert.match(parseReceiptArgs(['--release-manifest', 'm', '--artifact', 'a']).error, /--lane/);
    assert.match(parseReceiptArgs(['--lane', 'l', '--artifact', 'a']).error, /--release-manifest/);
    assert.match(parseReceiptArgs(base).error, /exactly one/);
    assert.match(
      parseReceiptArgs([...base, '--artifact', 'a', '--artifact-sha256', ARTIFACT_SHA]).error,
      /exactly one/,
    );
    assert.match(parseReceiptArgs([...base, '--artifact-sha256', 'ABC']).error, /64 lowercase/);
    assert.ok('error' in parseReceiptArgs([...base, '--artifact', 'a', 'stray']));
    assert.equal(await main(base, { repoHead: COMMIT }), 2);
    // An artifact file is digested as it is read.
    const artifact = join(scratch, 'artifact.bin');
    writeFileSync(artifact, 'a runtime artifact');
    const out = join(scratch, 'from-file.json');
    const code = await main(
      [
        '--lane',
        laneDir(),
        '--release-manifest',
        releaseManifest(),
        '--artifact',
        artifact,
        '--out',
        out,
      ],
      { repoHead: COMMIT },
    );
    assert.equal(code, 0);
    assert.equal(JSON.parse(readFileSync(out, 'utf8')).artifactSha256, ARTIFACT_SHA);
  });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${passed} checks passed`);
