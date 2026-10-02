#!/usr/bin/env node
/**
 * managed-receipt — the managed-posture capability receipt of one runtime release, made from what the
 * certification lane established and nothing else.
 *
 * A receipt (`managed-receipt.schema.json` of @rayspec/bundle-contract) names exactly which
 * public-hosting protections were tested for one release. It is not a compliance certificate. This
 * script writes one only when every claim in it rests on a test that ran and passed:
 *
 *   - THE LANE. `--lane <dir>` is the log directory of one run of `scripts/certification.mjs`: its
 *     `summary.json` and the vitest JSON report of every suite file. The summary must say the lane
 *     passed, and must hold every check this checkout's lane defines (`CHECKS`), each with exactly the
 *     suite files the check names. The summary's verdicts are not taken on trust: every report is read
 *     again and judged again by the lane's own rule (`judgeReport`), against the one suite file it is
 *     named for: a failed, skipped or missing test refuses the receipt, naming the check and the file,
 *     and so does one report named for two suite files. The report cannot show an error outside the
 *     tests, so a file whose vitest run the summary records as not exiting 0 refuses it too.
 *   - THE CODE. The lane must have run on a clean working tree, at the commit this checkout is at, so
 *     the checks, the supported-backend matrix and the vocabulary read here are the ones it tested.
 *   - THE TARGET. A receipt names only linux x64 targets on Node 22.21 or later; a lane run anywhere
 *     else is not evidence for one.
 *   - THE RELEASE. `--release-manifest <file>` is the release manifest of the release: canonical JSON
 *     that its schema admits, for this runtime version and this commit, listing the lane's target. Its
 *     SHA-256 is `releaseManifestSha256`. `--artifact <file>` (or `--artifact-sha256 <hex>`) names the
 *     runtime artifact the receipt is for. Both are required by the receipt schema.
 *
 * WHAT IT CLAIMS. Each fixed protection of the schema is claimed only through `ATTESTATIONS`, which
 * names the lane checks that establish it. `supportedBackends` lists the agent backends the
 * supported-backend matrix of `@rayspec/server` allows under the managed posture AND whose every
 * evidence file passed in the lane; `capabilities` is not a tested claim: it is the
 * vocabulary's list of available ids that the managed posture allows (the contract's definition of
 * the field), less any provider capability whose matrix row was not proven the same way.
 * `evidence` lists every report the claims rest on (by file name in the lane directory, with its
 * SHA-256) and the summary itself; `residualRisks` is `scripts/lib/residual-risks.mjs`, which
 * docs/threat-model.md states word for word. The receipt is written as canonical JSON and validated
 * with `validateReceipt` before anything is written.
 *
 *   node scripts/managed-receipt.mjs --lane <dir> --release-manifest <file>
 *     (--artifact <file> | --artifact-sha256 <hex>) [--out <receipt.json>]
 *
 * Needs `pnpm build` (it reads the built contract and the built matrix). Prints the receipt on stdout
 * or writes it to `--out`, and its SHA-256 on stderr. Exit 0: written; 1: refused, with the reason on
 * stderr and nothing written; 2: a usage error.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { CHECKS, judgeReport, laneFacts, SUMMARY_FILE } from './certification.mjs';
import { RESIDUAL_RISKS } from './lib/residual-risks.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every fixed protection the receipt states, with the lane checks that establish it. A receipt is
 * written only when all of them passed; a protection with no check here is never claimed.
 */
export const ATTESTATIONS = [
  {
    field: 'maxApplicationTenants',
    value: 1,
    checks: ['single-tenant-mode'],
  },
  {
    field: 'singleTenantModeEnforced',
    value: true,
    checks: ['single-tenant-mode'],
  },
  {
    field: 'publicHostingPosture',
    value: 'isolated-environment-v1',
    checks: [
      'runtime-role-evidence',
      'object-authorization',
      'trusted-proxies',
      'cors-and-csrf',
      'upload-limits',
      'sanitized-errors',
      'outbound-guard',
      'recovery-scope',
      'hostile-archives',
      'hostile-migration-bundles',
      'crash-recovery',
      'resource-bounds',
      'export-import-round-trip',
    ],
  },
  {
    field: 'executionLevels',
    value: ['none', 'in-process'],
    checks: ['execution-levels'],
  },
  {
    field: 'databaseIsolation',
    value: 'dedicated-db-and-rls',
    checks: ['runtime-role-evidence', 'object-authorization'],
  },
  {
    field: 'databaseRoleSeparation',
    value: true,
    checks: ['runtime-role-evidence', 'privileged-credentials'],
  },
  {
    field: 'crossProcessCancellation',
    value: true,
    checks: ['cross-process-cancel'],
  },
  {
    field: 'agentTraceExport',
    value: 'off',
    checks: ['agent-trace-export-off'],
  },
  {
    field: 'recoveryScopeEndpoint',
    value: 'disabled',
    checks: ['recovery-scope'],
  },
  {
    field: 'trustedProxiesPinned',
    value: true,
    checks: ['trusted-proxies'],
  },
  {
    // Core enforces no egress and says so; what it does enforce is the guard on its own requests.
    field: 'egressEnforcement',
    value: 'host-network-policy',
    checks: ['outbound-guard'],
  },
];

/** The targets a receipt may name: linux x64, Node 22.21 or a later 22 release. */
const NODE_FLOOR = [22, 21, 0];

/** The largest release manifest read: the receipt's own document limit. */
const RELEASE_MANIFEST_MAX_BYTES = 4 * 1024 * 1024;

/** A receipt that cannot be made, with the reason. */
export class ReceiptRefused extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReceiptRefused';
  }
}

function refuse(message) {
  throw new ReceiptRefused(message);
}

function log(line) {
  process.stderr.write(`[managed-receipt] ${line}\n`);
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Parse the arguments; a usage error is returned as `{ error }`. */
export function parseReceiptArgs(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        lane: { type: 'string' },
        'release-manifest': { type: 'string' },
        artifact: { type: 'string' },
        'artifact-sha256': { type: 'string' },
        out: { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  if (values.lane === undefined) return { error: '--lane <dir> is required' };
  if (values['release-manifest'] === undefined) {
    return { error: '--release-manifest <file> is required: the receipt carries its digest' };
  }
  if ((values.artifact === undefined) === (values['artifact-sha256'] === undefined)) {
    return { error: 'give exactly one of --artifact <file> and --artifact-sha256 <hex>' };
  }
  const artifactSha256 = values['artifact-sha256'];
  if (artifactSha256 !== undefined && !/^[a-f0-9]{64}$/.test(artifactSha256)) {
    return { error: '--artifact-sha256 must be 64 lowercase hexadecimal characters' };
  }
  return {
    lane: resolve(values.lane),
    releaseManifest: resolve(values['release-manifest']),
    artifact: values.artifact === undefined ? undefined : resolve(values.artifact),
    artifactSha256,
    out: values.out === undefined ? undefined : resolve(values.out),
  };
}

function readInput(path, what) {
  try {
    return readFileSync(path);
  } catch {
    return refuse(`${what} cannot be read: ${path}`);
  }
}

/** `a.b.c` at or above the floor. */
function atLeast(version, floor) {
  const parts = version.split('.').map(Number);
  for (let i = 0; i < floor.length; i++) {
    if (parts[i] !== floor[i]) return parts[i] > floor[i];
  }
  return true;
}

/** A report's name in the lane directory: a plain file name, never a path. */
const REPORT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;

/**
 * Judge the lane from its own files. Returns the commit, the target, the runtime version, the set of
 * suite files that passed, and the evidence entries; refuses on the first thing that does not hold.
 */
export function establishLane(laneDir, repoHead) {
  const summaryBytes = readInput(join(laneDir, SUMMARY_FILE), 'the lane summary');
  let summary;
  try {
    summary = JSON.parse(summaryBytes.toString('utf8'));
  } catch {
    refuse('the lane summary is not JSON');
  }
  if (summary === null || typeof summary !== 'object' || !Array.isArray(summary.checks)) {
    refuse('the lane summary has no checks');
  }
  if (summary.ok !== true) refuse('the certification lane did not pass');
  if (summary.posture?.databaseIsolation !== 'roles') {
    refuse('the lane did not run as the runtime role (posture.databaseIsolation is not roles)');
  }
  if (typeof summary.sourceCommit !== 'string' || !/^[a-f0-9]{40}$/.test(summary.sourceCommit)) {
    refuse('the lane summary names no commit: run the lane again from a checkout');
  }
  if (summary.worktreeClean !== true) {
    refuse('the lane ran on a working tree with changes, so no commit names the code it tested');
  }
  if (summary.sourceCommit !== repoHead) {
    refuse(
      `the lane ran at ${summary.sourceCommit} and this checkout is at ${repoHead}: make the ` +
        'receipt from the checkout the lane tested',
    );
  }
  if (typeof summary.runtimeVersion !== 'string')
    refuse('the lane summary names no runtime version');
  const target = summary.target ?? {};
  if (
    target.os !== 'linux' ||
    target.arch !== 'x64' ||
    typeof target.nodeVersion !== 'string' ||
    !/^22\.\d+\.\d+$/.test(target.nodeVersion) ||
    !atLeast(target.nodeVersion, NODE_FLOOR)
  ) {
    refuse(
      `the lane ran on ${target.os}/${target.arch} with Node ${target.nodeVersion}: a managed ` +
        `receipt names only linux/x64 with Node ${NODE_FLOOR.join('.')} or a later 22 release`,
    );
  }

  const passedFiles = new Set();
  const evidence = [];
  // One judgement per report and suite file, and one suite file per report: a report named for two
  // files would let one file's run stand in for another's.
  const judged = new Map();
  const reportOf = new Map();
  for (const c of CHECKS) {
    const ran = summary.checks.find((x) => x?.id === c.id);
    if (ran === undefined) refuse(`the lane did not run the check ${c.id}`);
    if (ran.verdict !== 'passed') refuse(`the check ${c.id} did not pass`);
    const files = Array.isArray(ran.files) ? ran.files : [];
    const named = files.map((f) => f?.file).sort();
    const wanted = c.suites.map((s) => `${s.dir}/${s.file}`).sort();
    if (named.length !== wanted.length || named.some((f, i) => f !== wanted[i])) {
      refuse(
        `the check ${c.id} ran other suite files than this checkout names: run the lane again`,
      );
    }
    for (const s of c.suites) {
      const path = `${s.dir}/${s.file}`;
      const entry = files.find((f) => f.file === path);
      if (typeof entry.report !== 'string' || !REPORT_NAME.test(entry.report)) {
        refuse(`${c.id}: ${path} names no report in the lane directory`);
      }
      const other = reportOf.get(entry.report);
      if (other !== undefined && other !== path) {
        refuse(`the report ${entry.report} is named for both ${other} and ${path}`);
      }
      reportOf.set(entry.report, path);
      if (entry.exit !== 0) {
        refuse(
          `${c.id}: ${path} ended with vitest exit status ${entry.exit ?? 'unknown'}, an error ` +
            'outside its tests',
        );
      }
      const key = `${entry.report}\0${path}`;
      let digest = judged.get(key);
      if (digest === undefined) {
        const bytes = readInput(join(laneDir, entry.report), `the report of ${path}`);
        let report = null;
        try {
          report = JSON.parse(bytes.toString('utf8'));
        } catch {
          report = null;
        }
        const verdict = judgeReport(report, path, s.notInThisLane ?? []);
        if (verdict.verdict !== 'passed') {
          refuse(`${c.id}: ${path} did not pass in its own report (${verdict.reason})`);
        }
        digest = sha256(bytes);
        judged.set(key, digest);
      }
      passedFiles.add(path);
      evidence.push({ protection: c.id, reference: entry.report, sha256: digest });
    }
  }
  evidence.push({
    protection: 'certification-lane-summary',
    reference: SUMMARY_FILE,
    sha256: sha256(summaryBytes),
  });
  return {
    sourceCommit: summary.sourceCommit,
    runtimeVersion: summary.runtimeVersion,
    target: { os: 'linux', arch: 'x64', nodeMajor: 22, nodeVersion: target.nodeVersion },
    passedChecks: new Set(CHECKS.map((c) => c.id)),
    passedFiles,
    evidence,
  };
}

/** Check the release manifest against the lane; returns its SHA-256. */
export function establishRelease(bytes, lane, contract) {
  if (bytes.length > RELEASE_MANIFEST_MAX_BYTES)
    refuse('the release manifest is larger than 4 MiB');
  const parsed = contract.parseJsonDocument(bytes, {
    maxBytes: RELEASE_MANIFEST_MAX_BYTES,
    maxDepth: contract.MAX_JSON_DEPTH,
    canonical: true,
  });
  if (!parsed.ok) {
    refuse(`the release manifest is not canonical JSON (${parsed.failure.reason})`);
  }
  const manifest = parsed.value;
  if (!contract.schemaValidator('releaseManifest')(manifest)) {
    refuse('the release manifest does not match its schema');
  }
  if (manifest.rayspecVersion !== lane.runtimeVersion) {
    refuse(
      `the release manifest is for ${manifest.rayspecVersion} and the lane tested ${lane.runtimeVersion}`,
    );
  }
  if (manifest.packages.some((p) => p.version !== manifest.rayspecVersion)) {
    refuse('a package of the release manifest has another version than the release');
  }
  if (manifest.sourceCommit !== lane.sourceCommit) {
    refuse(
      `the release manifest was built from ${manifest.sourceCommit} and the lane tested ${lane.sourceCommit}`,
    );
  }
  const { os, arch, nodeMajor } = lane.target;
  if (!manifest.targets.some((t) => t.os === os && t.arch === arch && t.nodeMajor === nodeMajor)) {
    refuse(
      `the release manifest does not list the target the lane ran on (${os}/${arch}/${nodeMajor})`,
    );
  }
  return sha256(bytes);
}

/**
 * The receipt from what the lane and the release establish. `matrix` is the supported-backend matrix;
 * `contract` the built @rayspec/bundle-contract.
 */
export function receiptOf({ lane, releaseManifestSha256, artifactSha256, matrix, contract }) {
  for (const a of ATTESTATIONS) {
    for (const id of a.checks) {
      if (!lane.passedChecks.has(id))
        refuse(`${a.field} rests on the check ${id}, which did not pass`);
    }
  }
  const proven = (row) =>
    row.managed === 'allowed' &&
    row.evidence.length > 0 &&
    row.evidence.every((path) => lane.passedFiles.has(path));
  const supportedBackends = matrix.filter((r) => r.kind === 'agent' && proven(r)).map((r) => r.id);
  if (supportedBackends.length === 0) {
    refuse('no agent backend the managed posture allows was proven by the lane');
  }
  const matrixCapabilities = new Set(matrix.map((r) => r.capability));
  const provenCapabilities = new Set(matrix.filter(proven).map((r) => r.capability));
  const capabilities = contract.CAPABILITIES.filter(
    (c) =>
      c.status === 'available' &&
      c.managedPosture === 'allowed' &&
      (!matrixCapabilities.has(c.id) || provenCapabilities.has(c.id)),
  ).map((c) => c.id);
  const claimed = Object.fromEntries(ATTESTATIONS.map((a) => [a.field, a.value]));
  return {
    receiptFormatVersion: 1,
    contractVersion: contract.CONTRACT_VERSION,
    runtimeVersion: lane.runtimeVersion,
    sourceCommit: lane.sourceCommit,
    releaseManifestSha256,
    artifactSha256,
    targets: [lane.target],
    capabilityVocabularyVersion: contract.CAPABILITY_VOCABULARY_VERSION,
    capabilities,
    maxApplicationTenants: claimed.maxApplicationTenants,
    singleTenantModeEnforced: claimed.singleTenantModeEnforced,
    publicHostingPosture: claimed.publicHostingPosture,
    supportedBackends,
    executionLevels: claimed.executionLevels,
    databaseIsolation: claimed.databaseIsolation,
    databaseRoleSeparation: claimed.databaseRoleSeparation,
    crossProcessCancellation: claimed.crossProcessCancellation,
    agentTraceExport: claimed.agentTraceExport,
    recoveryScopeEndpoint: claimed.recoveryScopeEndpoint,
    trustedProxiesPinned: claimed.trustedProxiesPinned,
    egressEnforcement: claimed.egressEnforcement,
    evidence: lane.evidence,
    residualRisks: RESIDUAL_RISKS.map((r) => ({ risk: r.risk, owner: r.owner })),
  };
}

/** The built contract and matrix; refuses with a hint when the build is missing. */
async function loadBuilt() {
  try {
    const contract = await import(
      pathToFileURL(join(REPO, 'packages/kernel/bundle-contract/dist/index.js')).href
    );
    const { SUPPORTED_BACKEND_MATRIX } = await import(
      pathToFileURL(join(REPO, 'packages/app/server/dist/supported-backends.js')).href
    );
    return { contract, matrix: SUPPORTED_BACKEND_MATRIX };
  } catch {
    return refuse('the built contract or server is missing: run pnpm build first');
  }
}

/**
 * Make the receipt. `options.repoHead` is the commit this checkout is at (read from git when not
 * given). Returns the exit code.
 */
export async function main(argv = process.argv.slice(2), options = {}) {
  const args = parseReceiptArgs(argv);
  if ('error' in args) {
    log(`usage: ${args.error}`);
    return 2;
  }
  try {
    const { contract, matrix } = await loadBuilt();
    const repoHead = options.repoHead ?? laneFacts().sourceCommit;
    const lane = establishLane(args.lane, repoHead);
    const releaseManifestSha256 = establishRelease(
      readInput(args.releaseManifest, 'the release manifest'),
      lane,
      contract,
    );
    const artifactSha256 = args.artifactSha256 ?? sha256(readInput(args.artifact, 'the artifact'));
    const receipt = receiptOf({ lane, releaseManifestSha256, artifactSha256, matrix, contract });
    const text = contract.canonicalJsonFile(receipt);
    const checked = contract.validateReceipt(text);
    if (!checked.ok) {
      const e = checked.errors[0];
      refuse(
        `the receipt does not validate: ${e.code}${e.reason ? ` ${e.reason}` : ''}` +
          `${e.path ? ` at ${e.path}` : ''}`,
      );
    }
    if (args.out) writeFileSync(args.out, text);
    else process.stdout.write(text);
    log(`receipt sha256 ${sha256(Buffer.from(text, 'utf8'))}`);
    log(
      `${receipt.runtimeVersion} at ${receipt.sourceCommit}: ${CHECKS.length} checks, ` +
        `${receipt.evidence.length} evidence entries, backends ${receipt.supportedBackends.join(', ')}`,
    );
    return 0;
  } catch (err) {
    if (err instanceof ReceiptRefused) {
      log(`refused: ${err.message}`);
      return 1;
    }
    throw err;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main();
}
