#!/usr/bin/env node
/**
 * corpus-conformance — the contract's golden fixture corpus run through an installed `rayspec`, as a
 * consumer runs it: `rayspec bundle inspect` and `rayspec bundle verify` on every case, each
 * outcome compared with the case's expectation.
 *
 * The suites of @rayspec/cli run the same corpus through the CLI's own code in the workspace. This
 * runs it through the CLI a consumer installed from the release tarballs, or the one inside the
 * runtime image: it needs nothing but Node, so the same file runs on the host and in the image.
 *
 * For every case of EXPECTATIONS.json (the copy the installed @rayspec/bundle-contract ships):
 *   - the case file is found (committed under the corpus directory, or written by
 *     `tsx scripts/gen-corpus.ts --uncommitted <dir>` for a case generated at test time), and its
 *     size and SHA-256 must be the ones the expectation records;
 *   - each expectation runs as `bundle inspect <file> --json` or `bundle verify <file> --runtime
 *     <the profile's version> --json`, with `--trusted-key` for each test signer the case trusts;
 *   - `ok`, the verdict, the first error's code and reason, and the exit code must be exactly the
 *     expectation's.
 * An expectation a command line cannot state — a lowered reader limit, a runtime profile narrower
 * than the CLI's own — is not run and is listed by id with that reason; the CLI suites run those
 * through the verb body. Anything else that does not run is a failure.
 *
 *   node scripts/corpus-conformance.mjs --cli <installed rayspec bin.js> --expectations <file>
 *        --corpus <dir> [--generated <dir>] [--work <dir>] [--report <file>] [--jobs <n>]
 *
 * Prints a summary and exits 0 when every runnable expectation held, 1 otherwise, 2 on usage.
 */
import { spawn } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The file name a case is committed (or generated) under. */
export function caseFileName(c) {
  return `${c.id}${c.construction.rawBytes ? '.bin' : '.ray'}`;
}

/** Why an expectation cannot be stated on a command line, or null when it can. */
export function notExpressible(c, e, profiles) {
  if (c.construction.readerLimits !== undefined) {
    return 'lowers a reader limit, which no command-line flag can do';
  }
  if (e.operation === 'bundle.verify') {
    const profile = profiles[e.runtimeProfile ?? 'fixture'];
    if (profile === undefined) return `names an unknown runtime profile ${e.runtimeProfile}`;
    if (
      profile.provides !== 'as fixture' &&
      !profile.provides.startsWith('every capabilities.json id')
    ) {
      return `checks against the runtime profile ${e.runtimeProfile} (${profile.provides}), narrower than the installed CLI`;
    }
  }
  return null;
}

/** The command-line arguments of one expectation. */
export function argsFor(c, e, file, profiles, keyFiles) {
  if (e.operation === 'bundle.inspect') return ['bundle', 'inspect', file, '--json'];
  const version = profiles[e.runtimeProfile ?? 'fixture'].version;
  const keys = (c.construction.trustedSignerSeeds ?? []).flatMap((seed) => [
    '--trusted-key',
    keyFiles.get(seed),
  ]);
  return ['bundle', 'verify', file, '--runtime', version, ...keys, '--json'];
}

/** What a run says, in the terms of an expectation. */
export function outcomeOf(operation, stdout, exit) {
  let envelope = null;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    return { ok: null, verdict: null, code: undefined, reason: undefined, exit, envelope: false };
  }
  const first = envelope?.errors?.[0];
  return {
    ok: envelope?.ok,
    verdict:
      envelope?.data?.verdict ?? (operation === 'bundle.inspect' ? 'invalid' : 'not-deployable'),
    code: first?.code,
    reason: first?.reason,
    exit,
  };
}

/** The expectation's own terms. */
export function expectedOf(e) {
  return { ok: e.ok, verdict: e.verdict, code: e.code, reason: e.reason, exit: e.exit };
}

const same = (a, b) =>
  a.ok === b.ok &&
  a.verdict === b.verdict &&
  a.code === b.code &&
  a.reason === b.reason &&
  a.exit === b.exit;

/** A test signer's public key, written as a PEM file: its seed is SHA-256 of the seed text. */
function writeSignerKey(dir, seedText, index) {
  const seed = createHash('sha256').update(seedText).digest();
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const path = join(dir, `signer-${index}.pem`);
  writeFileSync(path, createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }));
  return path;
}

function run(cli, args, cwd) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      env: { PATH: process.env.PATH ?? '', HOME: cwd },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr.on('data', (d) => {
      stderr += String(d);
    });
    child.on('close', (status) => resolveRun({ status, stdout, stderr }));
  });
}

export async function runCorpus({
  cli,
  expectations,
  corpus,
  generated,
  work,
  jobs = 4,
  log = () => {},
}) {
  const doc = JSON.parse(readFileSync(expectations, 'utf8'));
  const keyDir = join(work, 'keys');
  mkdirSync(keyDir, { recursive: true });
  const keyFiles = new Map(
    doc.testSigners.seeds.map((seed, i) => [seed, writeSignerKey(keyDir, seed, i)]),
  );
  const report = {
    contractVersion: doc.contractVersion,
    cases: doc.cases.length,
    expectations: 0,
    passed: 0,
    failed: [],
    notExpressible: [],
    notRunHere: {
      documentCases: (doc.documentCases ?? []).length,
      decryptionCases: (doc.decryptionCases ?? []).length,
      integrationCases: (doc.integrationCases ?? []).length,
      reason: 'library-level and integration cases: no inspect or verify command states them',
    },
  };
  const tasks = [];
  for (const c of doc.cases) {
    const name = caseFileName(c);
    const file = c.bytes.committed
      ? join(corpus, name)
      : generated === undefined
        ? null
        : join(generated, name);
    let bytes = null;
    try {
      bytes = file === null ? null : readFileSync(file);
    } catch {
      bytes = null;
    }
    if (bytes === null) {
      report.failed.push({ id: c.id, why: `the case file ${name} is missing` });
      continue;
    }
    if (bytes.length !== c.bytes.size || sha256(bytes) !== c.bytes.sha256) {
      report.failed.push({ id: c.id, why: `${name} is not the bytes the expectation records` });
      continue;
    }
    for (const e of c.expect) {
      report.expectations += 1;
      const skip = notExpressible(c, e, doc.runtimeProfiles);
      if (skip !== null) {
        report.notExpressible.push({ id: c.id, operation: e.operation, reason: skip });
        continue;
      }
      tasks.push({ c, e, args: argsFor(c, e, file, doc.runtimeProfiles, keyFiles) });
    }
  }
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const task = tasks[next++];
      const res = await run(cli, task.args, work);
      const got = outcomeOf(task.e.operation, res.stdout, res.status);
      const want = expectedOf(task.e);
      if (same(got, want)) report.passed += 1;
      else {
        report.failed.push({
          id: task.c.id,
          operation: task.e.operation,
          expected: want,
          got: { ...got, envelope: undefined },
        });
        log(
          `FAIL ${task.c.id} ${task.e.operation}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`,
        );
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, jobs) }, worker));
  report.ran = tasks.length;
  report.ok =
    report.failed.length === 0 &&
    report.passed === tasks.length &&
    report.passed + report.notExpressible.length === report.expectations;
  return report;
}

async function main(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        cli: { type: 'string' },
        expectations: { type: 'string' },
        corpus: { type: 'string' },
        generated: { type: 'string' },
        work: { type: 'string' },
        report: { type: 'string' },
        jobs: { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    process.stderr.write(`usage: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  for (const flag of ['cli', 'expectations', 'corpus']) {
    if (values[flag] === undefined) {
      process.stderr.write(`usage: --${flag} is required\n`);
      return 2;
    }
  }
  const work =
    values.work === undefined
      ? mkdtempSync(join(tmpdir(), 'rayspec-corpus-'))
      : resolve(values.work);
  mkdirSync(work, { recursive: true });
  try {
    const report = await runCorpus({
      cli: resolve(values.cli),
      expectations: resolve(values.expectations),
      corpus: resolve(values.corpus),
      generated: values.generated === undefined ? undefined : resolve(values.generated),
      work,
      jobs: values.jobs === undefined ? 4 : Number(values.jobs),
      log: (line) => process.stderr.write(`[corpus-conformance] ${line}\n`),
    });
    const text = `${JSON.stringify(report, null, 2)}\n`;
    if (values.report !== undefined) writeFileSync(resolve(values.report), text);
    process.stdout.write(text);
    return report.ok ? 0 : 1;
  } finally {
    if (values.work === undefined) rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main(process.argv.slice(2));
}
