#!/usr/bin/env node
/**
 * certification — the hosting-posture certification lane: the suites that prove the hosting
 * contract's mandatory public-hosting checks and its recovery cases, run on a real PostgreSQL with the
 * hardened posture on, and one verdict per check.
 *
 * WHAT IT RUNS. Each check of `CHECKS` names the suites that prove it:
 *   - the certification suites of @rayspec/cli (`packages/app/cli/src/certification/`, run with
 *     `vitest.certification.config.ts`), which deploy an application through the real built CLI with
 *     every part of the posture on — role separation and forced row-level security, single-tenant
 *     mode, the managed posture, pinned trusted proxies, one allowed origin — and drive it over HTTP;
 *   - the existing suites of the packages that hold each protection, run in the runtime-role lane
 *     (`RAYSPEC_TEST_DATABASE_ISOLATION=roles`): every server boot migrates as a migration role and
 *     serves as a runtime role with no superuser, no BYPASSRLS and every tenant policy forced.
 * A suite file shared by several checks runs once. Files run one at a time, package by package, so two
 * workflow engines never share the database at once.
 *
 * THE VERDICT. A check passes only when every one of its suite files ran, every test in it passed,
 * none was skipped, and vitest itself exited 0: a skipped test is not evidence, so it fails the check
 * (and the lane) by name, and so does a file whose run ended with an error outside its tests (an
 * unhandled rejection, a crash) even when its report lists every test as passed. A file that reports
 * no test at all fails too. The lane exits 1 when any check failed.
 *
 * NO PAID PROVIDER. Every provider credential and the live-test switches are set empty in the
 * environment the suites see, so neither the environment nor a repository `.env` can make a suite
 * call a real provider; the model provider the certification suites use is a local stand-in.
 *
 *   node scripts/certification.mjs [--check <id>]... [--out <summary.json>] [--log-dir <dir>]
 *
 * Needs: `pnpm build`; DATABASE_URL naming a superuser of a PostgreSQL 16 server with the database
 * roles of `packages/kernel/db/sql/database-roles.sql` created (docker-compose.yml does on a new
 * volume; CI runs the file); SHADOW_DATABASE_URL (default DATABASE_URL); `pg_dump`/`pg_restore` of the
 * server's major on PATH or Docker. Prints one JSON summary on stdout (and to `--out`); each file's
 * vitest output and JSON report go to `--log-dir` (default a new temporary directory, which is kept
 * and named), and the summary, written there as `summary.json` too, names each report by its file
 * name in that directory and records the exit status of the vitest run that wrote it. The summary also records
 * what the lane ran on (`laneFacts`): the commit, whether the tree was clean, the runtime version and
 * the platform. `scripts/managed-receipt.mjs` makes the managed-posture receipt from that directory.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The name of the summary the lane writes into its log directory. */
export const SUMMARY_FILE = 'summary.json';

/** The certification suites of the CLI package, with the config that includes them. */
const CERT = (file) => ({
  dir: 'packages/app/cli',
  config: 'vitest.certification.config.ts',
  file: `src/certification/${file}`,
  notInThisLane: [],
});
/**
 * A suite file of a package, run with the package's own config. `notInThisLane` names, by exact
 * title, a test the file skips in the runtime-role lane by design because it proves something only
 * outside it, and why; any other skip fails the file.
 */
const SUITE = (dir, file, notInThisLane = []) => ({ dir, config: null, file, notInThisLane });

/**
 * The checks the lane certifies, each in plain words, and the suites that prove it. The first group
 * is the hosting contract's list of mandatory public-hosting checks; the second its recovery and
 * resource cases.
 */
export const CHECKS = [
  {
    id: 'runtime-role-evidence',
    check:
      'evidence is taken as the ordinary runtime role: no superuser, no BYPASSRLS, every tenant table under a forced row policy',
    suites: [
      CERT('hosting-checks.test.ts'),
      SUITE('packages/kernel/db', 'src/tenant-isolation.db.test.ts'),
      SUITE('packages/app/server', 'src/database-isolation-boot.db.test.ts', [
        {
          title:
            'without the migration connection the boot is the single-role boot: no table has row security',
          reason:
            'it proves the single-role boot, which the runtime-role lane never makes; the database lane runs it',
        },
      ]),
    ],
  },
  {
    id: 'object-authorization',
    check:
      'authentication is not object authorization: every object, upload part, stream, export download and background job is checked, for two users and a removed member',
    suites: [
      CERT('hosting-checks.test.ts'),
      SUITE('packages/app/server', 'src/hardened-posture.db.test.ts'),
      SUITE('packages/compose/api-auth', 'src/routes/single-tenant.db.test.ts'),
      SUITE('packages/compose/api-auth', 'src/routes/runs-async.db.test.ts'),
      SUITE('packages/compose/api-auth', 'src/routes/subscribe.db.test.ts'),
      SUITE('packages/compose/api-auth', 'src/services/run-authorizer.test.ts'),
      SUITE('packages/compose/api-auth', 'src/cross-tenant-gate.test.ts'),
    ],
  },
  {
    id: 'trusted-proxies',
    check:
      'forwarding headers are believed only from the pinned proxy addresses, and the application port is not reachable around the proxy',
    suites: [
      CERT('hosting-checks.test.ts'),
      SUITE('packages/compose/api-auth', 'src/http/client-ip.test.ts'),
      SUITE('packages/app/server', 'src/serve-bind.test.ts'),
    ],
  },
  {
    id: 'cors-and-csrf',
    check:
      'only the configured browser origins are allowed, and a cross-site request is refused where a cookie authenticates',
    suites: [
      CERT('hosting-checks.test.ts'),
      SUITE('packages/compose/api-auth', 'src/cors.test.ts'),
      SUITE('packages/compose/api-auth', 'src/routes/auth.test.ts'),
    ],
  },
  {
    id: 'upload-limits',
    check:
      'JSON request bodies and file uploads are bounded in size, and an upload cannot leave its tenant’s blob space; a stream ingest body is capped by the host’s reverse proxy',
    suites: [
      CERT('hosting-checks.test.ts'),
      SUITE('packages/compose/api-auth', 'src/http/bounded-body.test.ts'),
      SUITE('packages/kernel/platform', 'src/blob/fs-blob-store.test.ts'),
      SUITE('packages/capabilities/file-runtime', 'src/upload.test.ts'),
    ],
  },
  {
    id: 'sanitized-errors',
    check:
      'every error answer is a sanitized envelope, and every output passes the one redaction path',
    suites: [
      CERT('hosting-checks.test.ts'),
      SUITE('packages/app/server', 'src/redaction-canaries.test.ts'),
      SUITE('packages/compose/api-auth', 'src/app-error-logging.test.ts'),
    ],
  },
  {
    id: 'outbound-guard',
    check:
      'an outbound request to a URL the platform did not choose never reaches loopback, private, link-local or metadata addresses, after resolution and on every redirect, and is time-limited',
    suites: [
      SUITE('packages/kernel/platform', 'src/outbound-guard.test.ts'),
      SUITE('packages/kernel/platform', 'src/outbound-call-sites.test.ts'),
    ],
  },
  {
    id: 'recovery-scope',
    check: 'the recovery probe is not served under the managed posture',
    suites: [
      CERT('hosting-checks.test.ts'),
      SUITE('packages/app/server', 'src/recovery-scope.test.ts'),
    ],
  },
  {
    id: 'single-tenant-mode',
    check:
      'the runtime holds one organization: a second one is refused on every path, a boot over more than one is refused, and export and import refuse more than one',
    suites: [
      CERT('hosting-checks.test.ts'),
      SUITE('packages/compose/api-auth', 'src/routes/single-tenant.db.test.ts'),
      SUITE('packages/app/server', 'src/hardened-posture.db.test.ts'),
      SUITE('packages/app/server', 'src/snapshot-capture.db.test.ts'),
      SUITE('packages/app/cli', 'src/import.db.test.ts'),
    ],
  },
  {
    id: 'agent-trace-export-off',
    check:
      'no agent trace is exported on the bundle deploy path or under the managed posture unless the operator asks for it, as the agent SDK itself reports',
    suites: [
      SUITE('packages/app/server', 'src/agent-tracing.test.ts'),
      SUITE('packages/app/server', 'src/hosting-config.test.ts'),
      SUITE('packages/app/cli', 'src/deploy-agent-tracing.test.ts'),
      SUITE('packages/app/cli', 'src/deploy-agent-tracing.sdk.test.ts'),
    ],
  },
  {
    id: 'execution-levels',
    check:
      'the runtime reports exactly the execution levels none and in-process, deploys a bundle of each, and refuses a bundle that asks for a sandbox',
    suites: [
      CERT('hosting-checks.test.ts'),
      SUITE('packages/app/server', 'src/runtime-control.db.test.ts'),
      SUITE('packages/app/server', 'src/bundle-deploy.db.test.ts'),
      SUITE('packages/kernel/bundle', 'src/corpus.test.ts'),
    ],
  },
  {
    id: 'supported-backends',
    check:
      'every backend the managed posture allows is bounded and stopped as the supported-backend matrix states, and a boot that would use any other backend is refused',
    suites: [
      SUITE('packages/app/server', 'src/supported-backends.test.ts'),
      SUITE('packages/adapters/openai', 'src/hanging-provider.test.ts'),
      SUITE('packages/kernel/platform', 'src/run-core-bound.db.test.ts'),
      SUITE('packages/adapters/deepgram', 'src/hanging-provider.test.ts'),
      SUITE('packages/adapters/openai-tts', 'src/hanging-provider.test.ts'),
    ],
  },
  {
    id: 'hostile-archives',
    check:
      'a hostile application archive is refused before anything is extracted or run, through the reader and through the real CLI',
    suites: [
      CERT('hostile-inputs.test.ts'),
      SUITE('packages/kernel/bundle', 'src/corpus.test.ts'),
      SUITE('packages/kernel/bundle', 'src/canary.test.ts'),
      SUITE('packages/app/cli', 'src/bundle-binary.test.ts'),
    ],
  },
  {
    id: 'hostile-migration-bundles',
    check:
      'a hostile migration bundle or dump is refused before anything reaches the target, and a privileged dump runs nothing',
    suites: [CERT('hostile-inputs.test.ts'), SUITE('packages/app/cli', 'src/import.db.test.ts')],
  },
  {
    id: 'cross-process-cancel',
    check:
      'a run executing in another worker process is cancelled within the poll bound and its outcome recorded, not replayed',
    suites: [
      SUITE('packages/kernel/platform', 'src/run-cancel-cross-process.db.test.ts'),
      SUITE('packages/workflow/durable-dbos', 'src/executor-cross-process-cancel.db.test.ts'),
      SUITE('packages/compose/api-auth', 'src/routes/runs-cancel.db.test.ts'),
    ],
  },
  {
    id: 'crash-recovery',
    check:
      'a process killed during an apply, an export or an import leaves a state the next run recovers from',
    suites: [
      SUITE('packages/app/server', 'src/apply-crash.db.test.ts'),
      SUITE('packages/app/cli', 'src/deploy-bundle.db.test.ts'),
      SUITE('packages/app/cli', 'src/export.db.test.ts'),
      SUITE('packages/app/cli', 'src/import.db.test.ts'),
    ],
  },
  {
    id: 'resource-bounds',
    check:
      'a parallel workload with a hanging provider stays within the run, queue, session and memory bounds, and every admitted run ends',
    suites: [
      CERT('resource-bounds.test.ts'),
      SUITE('packages/kernel/platform', 'src/run-core-bound.db.test.ts'),
      SUITE('packages/compose/api-auth', 'src/routes/runs-admission.db.test.ts'),
      SUITE('packages/workflow/durable-dbos', 'src/executor-pool-saturation.db.test.ts'),
    ],
  },
  {
    id: 'export-import-round-trip',
    check:
      'a full export, import and restore round trip carries every row and file, and resets every credential the old secrets keyed',
    suites: [CERT('round-trip.test.ts'), SUITE('packages/app/cli', 'src/import.db.test.ts')],
  },
];

/**
 * What the hosting contract asks that Core has no surface for, said here so the summary states it
 * rather than leaving it out.
 */
export const NOT_APPLICABLE = [
  {
    id: 'support-access',
    check: 'support access is capped and audited',
    reason:
      'Core has no support-access path: no operator or vendor account reaches an organization’s data through the runtime. A hosting provider that adds one owns that check.',
  },
];

/** The variables a suite could spend money or reach a provider with; the lane sets each empty. */
export const PROVIDER_VARIABLES = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CODEX_API_KEY',
  'DEEPGRAM_API_KEY',
  'RAYSPEC_REQUIRE_LIVE_TESTS',
  'RAYSPEC_LIVE_BACKENDS',
];

/** The environment every suite runs with. */
export function laneEnvironment(env) {
  const out = { ...env };
  for (const name of PROVIDER_VARIABLES) out[name] = '';
  out.RAYSPEC_REQUIRE_DB_TESTS = 'true';
  out.RAYSPEC_TEST_DATABASE_ISOLATION = 'roles';
  if (!out.SHADOW_DATABASE_URL) out.SHADOW_DATABASE_URL = env.DATABASE_URL;
  return out;
}

/** The distinct suite files of `checks`, in order, each with the ids of the checks it proves. */
export function suitesOf(checks) {
  const byKey = new Map();
  for (const c of checks) {
    for (const s of c.suites) {
      const key = `${s.dir}\0${s.config ?? ''}\0${s.file}`;
      const entry = byKey.get(key) ?? { ...s, checks: [] };
      entry.checks.push(c.id);
      byKey.set(key, entry);
    }
  }
  return [...byKey.values()];
}

/**
 * The verdict on one file from vitest's JSON report: `passed` only when the file ran at least one test
 * and every test passed. A skipped, pending or todo test is not evidence. `path` is the file's path in
 * the repository (`<dir>/<file>`): a report entry counts only when it names that path, so a report of
 * a file of the same name in another package is never taken for it.
 */
export function judgeReport(report, path, notInThisLane = []) {
  if (report === null || typeof report !== 'object' || !Array.isArray(report.testResults)) {
    return { verdict: 'failed', passed: 0, failed: 0, skipped: 0, reason: 'no test report' };
  }
  const results = report.testResults.filter(
    (r) => typeof r.name === 'string' && (r.name === path || r.name.endsWith(`/${path}`)),
  );
  const all = results.flatMap((r) => r.assertionResults ?? []);
  // A test skipped by design in this lane, named by exact title, is left out of the count; it must
  // really be skipped, or the declaration is stale.
  const declared = new Set(notInThisLane.map((n) => n.title));
  const byDesign = all.filter(
    (t) => declared.has(t.title) && t.status !== 'passed' && t.status !== 'failed',
  );
  const tests = all.filter((t) => !byDesign.includes(t));
  const passed = tests.filter((t) => t.status === 'passed').length;
  const failed = tests.filter((t) => t.status === 'failed').length;
  const skipped = tests.length - passed - failed;
  const fileFailed = results.some((r) => r.status === 'failed');
  let reason = null;
  if (results.length === 0) reason = 'the file was not run';
  else if (tests.length === 0) reason = 'the file ran no test';
  else if (failed > 0) reason = `${failed} test(s) failed`;
  else if (skipped > 0) reason = `${skipped} test(s) skipped: a skipped test is not evidence`;
  else if (fileFailed) reason = 'the file failed outside its tests (a hook or the collection)';
  else if (byDesign.length !== declared.size) {
    reason = 'a test declared as not run in this lane was not found skipped';
  }
  return {
    verdict: reason === null ? 'passed' : 'failed',
    passed,
    failed,
    skipped,
    reason,
    ...(declared.size === 0 ? {} : { notInThisLane }),
  };
}

/**
 * The verdict on one file from its report and how its vitest process ended. vitest exits 1 for an
 * error outside every test (an unhandled rejection or exception, a crash in a worker) while its JSON
 * report still lists each test as passed, so a report that passed counts only when the process exited
 * 0, by itself, and could be started at all.
 */
export function judgeRun(verdict, run) {
  const exit = typeof run.status === 'number' ? run.status : null;
  const signal = run.signal ?? null;
  let reason = null;
  if (run.error) reason = `vitest could not be run (${run.error.code ?? run.error.message})`;
  else if (signal !== null) reason = `vitest was ended by ${signal}`;
  else if (exit !== 0) {
    reason = `vitest exited with status ${exit}: an error outside the tests, such as an unhandled rejection`;
  }
  const failedRun = reason !== null && verdict.verdict === 'passed';
  return {
    ...verdict,
    ...(failedRun ? { verdict: 'failed', reason } : {}),
    exit,
    ...(signal === null ? {} : { signal }),
  };
}

/** The verdict on each check from the verdicts on its files. */
export function judgeChecks(checks, fileVerdicts) {
  return checks.map((c) => {
    const files = c.suites.map((s) => {
      const v = fileVerdicts.get(`${s.dir}/${s.file}`);
      return { file: `${s.dir}/${s.file}`, ...(v ?? { verdict: 'failed', reason: 'not run' }) };
    });
    return {
      id: c.id,
      check: c.check,
      verdict: files.every((f) => f.verdict === 'passed') ? 'passed' : 'failed',
      files,
    };
  });
}

function log(line) {
  process.stderr.write(`[certification] ${line}\n`);
}

/** Parse the arguments; a usage error is returned as `{ error }`. */
export function parseCertificationArgs(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        check: { type: 'string', multiple: true },
        out: { type: 'string' },
        'log-dir': { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  const known = new Set(CHECKS.map((c) => c.id));
  const unknown = (values.check ?? []).filter((id) => !known.has(id));
  if (unknown.length > 0) return { error: `unknown check: ${unknown.join(', ')}` };
  return {
    checks: values.check === undefined ? CHECKS : CHECKS.filter((c) => values.check.includes(c.id)),
    out: values.out,
    logDir: values['log-dir'],
  };
}

/** The name a suite file's output and report carry in the log directory. */
export function reportNameOf(suite, index) {
  return `${String(index).padStart(2, '0')}-${suite.dir.replaceAll('/', '_')}-${suite.file.replaceAll('/', '_')}`;
}

/**
 * Run one suite file and judge it. A report left in the log directory by an earlier run is removed
 * first, so a run that writes none is judged as having no report, never by the old one.
 */
export function runFile(suite, env, logDir, index, repo = REPO) {
  const cwd = join(repo, suite.dir);
  const name = reportNameOf(suite, index);
  const reportPath = join(logDir, `${name}.json`);
  rmSync(reportPath, { force: true });
  const args = [
    'exec',
    'vitest',
    'run',
    suite.file,
    ...(suite.config === null ? [] : ['--config', suite.config]),
    '--reporter=default',
    '--reporter=json',
    `--outputFile.json=${reportPath}`,
  ];
  const started = Date.now();
  const run = spawnSync('pnpm', args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  writeFileSync(join(logDir, `${name}.log`), `${run.stdout ?? ''}\n${run.stderr ?? ''}`);
  // One read: a report that is missing or not JSON is no report.
  let report = null;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch {
    report = null;
  }
  return {
    ...judgeRun(judgeReport(report, `${suite.dir}/${suite.file}`, suite.notInThisLane ?? []), run),
    seconds: Math.round((Date.now() - started) / 1000),
    log: join(logDir, `${name}.log`),
    report: `${name}.json`,
  };
}

/**
 * What the lane ran on, recorded before the first suite runs: the commit checked out and whether the
 * working tree matched it (tracked and untracked files alike), the version of the runtime package,
 * and the platform, architecture and Node version. A receipt is made only from a lane whose tree was
 * clean, so the commit names exactly the code that was tested.
 */
export function laneFacts(repo = REPO) {
  const git = (args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  const head = git(['rev-parse', 'HEAD']);
  const status = git(['status', '--porcelain']);
  const sourceCommit = head.status === 0 ? head.stdout.trim() : null;
  let runtimeVersion = null;
  try {
    runtimeVersion = JSON.parse(
      readFileSync(join(repo, 'packages/app/server/package.json'), 'utf8'),
    ).version;
  } catch {
    runtimeVersion = null;
  }
  return {
    sourceCommit: /^[a-f0-9]{40}$/.test(sourceCommit ?? '') ? sourceCommit : null,
    worktreeClean: status.status === 0 && status.stdout.trim() === '',
    runtimeVersion,
    target: { os: process.platform, arch: process.arch, nodeVersion: process.versions.node },
  };
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseCertificationArgs(argv);
  if ('error' in args) {
    log(`usage: ${args.error}`);
    return 2;
  }
  if (!env.DATABASE_URL) {
    log('DATABASE_URL must name a superuser of the PostgreSQL server the lane runs on');
    return 2;
  }
  const logDir = args.logDir
    ? resolve(args.logDir)
    : mkdtempSync(join(env.TMPDIR || tmpdir(), 'rayspec-certification-'));
  mkdirSync(logDir, { recursive: true });
  const laneEnv = laneEnvironment(env);
  const facts = laneFacts();
  const suites = suitesOf(args.checks);
  log(`${args.checks.length} checks, ${suites.length} suite files; logs in ${logDir}`);
  const fileVerdicts = new Map();
  for (const [i, suite] of suites.entries()) {
    log(`running ${suite.dir}/${suite.file} (${suite.checks.join(', ')})`);
    const verdict = runFile(suite, laneEnv, logDir, i + 1);
    fileVerdicts.set(`${suite.dir}/${suite.file}`, verdict);
    log(
      `  ${verdict.verdict}: ${verdict.passed} passed, ${verdict.failed} failed, ${verdict.skipped} skipped` +
        ` in ${verdict.seconds} s${verdict.reason === null ? '' : ` (${verdict.reason})`}`,
    );
  }
  const checks = judgeChecks(args.checks, fileVerdicts);
  const summary = {
    ok: checks.every((c) => c.verdict === 'passed'),
    ...facts,
    posture: {
      databaseIsolation: 'roles',
      certificationSuites:
        'role separation, forced row-level security, single-tenant mode, the managed posture, pinned trusted proxies',
    },
    checks,
    notApplicable: NOT_APPLICABLE,
    logDir,
  };
  const text = `${JSON.stringify(summary, null, 2)}\n`;
  process.stdout.write(text);
  // The log directory holds the summary beside the reports it names, so it is the lane's whole
  // evidence on its own.
  writeFileSync(join(logDir, SUMMARY_FILE), text);
  if (args.out) writeFileSync(resolve(args.out), text);
  for (const c of checks.filter((x) => x.verdict !== 'passed')) {
    log(
      `FAILED ${c.id}: ${c.files
        .filter((f) => f.verdict !== 'passed')
        .map((f) => `${f.file} (${f.reason})`)
        .join('; ')}`,
    );
  }
  return summary.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main();
}
