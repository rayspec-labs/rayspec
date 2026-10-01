/**
 * `rayspec export` — preflight a self-hosted deployment, fence it under the operator's confirmation,
 * and write its complete snapshot, encrypted to the operator's age X25519 recipient, as one
 * migration-kind `.ray`. The source stays fenced afterwards.
 *
 *   rayspec export --deployment <id> --recipient <age1…> --output <migration.ray>
 *                  --run-history <included|excluded> [--confirm-quiesce] [--source-stopped]
 *                  [--quiesce-deadline <seconds>] [--state-dir <dir>] [--json]
 *
 * THE SEQUENCE, each step a transition of the migration state machine recorded in the receipts
 * (`export-receipts.ts` in @rayspec/server):
 *
 *   PRECHECK   arguments, the state directory, the configuration, the blob source (an application
 *              that loads an extension is refused), the scratch lock, then the read-only preflight
 *              of the source (`preflightSnapshot`), recorded with the application digest it
 *              established. A refusal here changes nothing at the source.
 *              Then the operator confirms the downtime: `--confirm-quiesce`, or an answer at the
 *              terminal to the plan printed on stderr.
 *   QUIESCING  `quiesce()` takes the source fence (or finds the one an earlier export took, at its
 *              epoch), stops and drains every producer, refuses uploads, and takes the database write
 *              barrier: the runtime role's writes revoked with role separation, or the stopped source
 *              the operator attested with `--source-stopped`.
 *   FROZEN     the fence is held with both barriers. Without the database barrier the export refuses
 *              (`RAY_EXTERNAL_STATE_UNSUPPORTED` `database-barrier-unavailable`) and the source stays
 *              fenced.
 *   EXPORTING  both databases and the blobs captured under that one fence epoch, counts and digests
 *              verified, the inner archive encrypted in a private scratch directory under the state
 *              directory and the migration bundle written beside the output, read back and linked into
 *              place (`exportSnapshot`). The scratch directory is removed on every path.
 *   EXPORTED   the result names the bundle, its digests, the fence epoch and how to resume.
 *   BLOCKED    any refusal or failure after the precheck: the source stays fenced, and the error says
 *              how to resume it.
 *
 * SIGINT and SIGTERM stop the export at its next safe point (a running `pg_dump` is ended): the
 * scratch directory is removed, any fence it took stays, and the envelope reports `RAY_INTERRUPTED`
 * with the resume instruction. A process killed outright leaves its scratch directory; the next
 * export, or `rayspec resume`, removes it before anything else and closes the killed export's
 * receipt.
 *
 * CONFIGURATION comes from the explicit process environment only, never a `.env` file:
 * `DATABASE_URL` (or `_FILE`), `RAYSPEC_MIGRATION_DATABASE_URL` (role separation),
 * `RAYSPEC_SNAPSHOT_DATABASE_URL` (the read-only snapshot role), `DBOS_SYSTEM_DATABASE_URL`,
 * `RAYSPEC_BLOB_ROOT`, and `RAYSPEC_PG_DUMP` (an absolute path to `pg_dump`; default the first on
 * `PATH`). No output carries a value of any of them.
 *
 * OUTPUT. One `export` envelope on stdout, with or without `--json`; progress, the plan and, without
 * `--json`, a summary go to stderr.
 */
import { lstat, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { type ParseArgsConfig, parseArgs } from 'node:util';
import {
  type BundleError,
  type BundleErrorCode,
  type BundleWarning,
  bundleError,
  CONTRACT_VERSION,
  formatTimestamp,
  type QuiesceData,
  validateManifest,
} from '@rayspec/bundle-contract';
import type { Db } from '@rayspec/db';
import type {
  CaptureBarrier,
  ExportDigests,
  ExportReceiptLog,
  ExportScratch,
  ExportSnapshotOptions,
  SnapshotBlobSource,
  StateDirectory,
} from '@rayspec/server';
import { type Envelope, envelope } from './envelope.js';

/** The flags of `export`; `--json` is taken off by index.ts before they are parsed. */
export const EXPORT_ARG_OPTIONS = {
  deployment: { type: 'string' },
  'state-dir': { type: 'string' },
  recipient: { type: 'string' },
  output: { type: 'string' },
  'run-history': { type: 'string' },
  'confirm-quiesce': { type: 'boolean' },
  'quiesce-deadline': { type: 'string' },
  'source-stopped': { type: 'boolean' },
} as const satisfies NonNullable<ParseArgsConfig['options']>;

/**
 * Every code the export can report. The preflight it runs adds codes the contract's verb list does
 * not name (an extension, a digest, a runtime or target, a fence epoch); they are the contract's own
 * codes for those findings.
 */
export const EXPORT_ERROR_CODES: ReadonlySet<BundleErrorCode> = new Set<BundleErrorCode>([
  'RAY_USAGE',
  'RAY_BINDINGS_FILE_INSECURE',
  'RAY_OUTPUT_EXISTS',
  'RAY_MULTI_TENANT_UNSUPPORTED',
  'RAY_OWNER_RECOVERY_REQUIRED',
  'RAY_EXTERNAL_STATE_UNSUPPORTED',
  'RAY_SCHEMA_DRIFT',
  'RAY_SOURCE_NOT_QUIESCENT',
  'RAY_LIMIT_EXCEEDED',
  'RAY_LOCK_TIMEOUT',
  'RAY_INFRA_UNAVAILABLE',
  'RAY_INTERRUPTED',
  'RAY_INTERNAL',
  'RAY_POLICY_DENIED',
  'RAY_DIGEST_MISMATCH',
  'RAY_RUNTIME_UNSUPPORTED',
  'RAY_TARGET_UNSUPPORTED',
  'RAY_FENCE_MISMATCH',
]);

/** The default and the bounds of `--quiesce-deadline`, in seconds. */
export const DEFAULT_QUIESCE_DEADLINE_SECONDS = 300;
const MAX_QUIESCE_DEADLINE_SECONDS = 24 * 60 * 60;

/** The data of a successful `export` envelope (cli-verbs.json `export`). */
export interface ExportData {
  deploymentId: string;
  outputPath: string;
  sha256: string;
  ciphertextSha256: string;
  ciphertextSize: number;
  fenceEpoch: number;
  sourceState: 'fenced';
  excludedDataCategories: string[];
  recovery: string;
}

/** Where the confirmation is asked when `--confirm-quiesce` is not given. */
export interface ConfirmationTerminal {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

export interface ExportOptions {
  operationId: string;
  /** Whether `--json` was given; the envelope is written either way. */
  json: boolean;
  /** The explicit process environment. Default: `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Aborted on SIGINT or SIGTERM: the export stops at its next safe point. */
  signal?: AbortSignal;
  /** The operator's terminal, or null when there is none (the confirmation flag is then required). */
  terminal?: ConfirmationTerminal | null;
  /** Where progress lines go. Default: stderr. */
  progress?: (line: string) => void;
}

export interface ExportOutcome {
  envelope: Envelope;
  /** A short description for stderr, when `--json` was not given. */
  summary: string[];
}

interface Parsed {
  deploymentId: string;
  stateDir: string;
  recipient: string;
  output: string;
  runHistoryPolicy: 'included' | 'excluded';
  confirmQuiesce: boolean;
  quiesceDeadlineSeconds: number;
  sourceStopped: boolean;
}

class Refused extends Error {
  readonly errors: BundleError[];
  constructor(errors: BundleError[]) {
    super(errors[0]?.message ?? 'refused');
    this.errors = errors;
  }
}

function refuse(code: Parameters<typeof bundleError>[0], message: string, extra = {}): never {
  throw new Refused([bundleError(code, message, extra)]);
}

const DEPLOYMENT_ID = /^[a-z0-9-]{1,64}$/;

/** Parse the arguments; every problem is `RAY_USAGE`. The recipient is checked by `isRecipient`. */
export function parseExportArgs(
  args: readonly string[],
  isRecipient: (value: string) => boolean,
): Parsed {
  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: EXPORT_ARG_OPTIONS,
    }));
  } catch (e) {
    refuse('RAY_USAGE', `invalid arguments: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (positionals.length > 0) refuse('RAY_USAGE', 'export takes no positional argument');
  const deploymentId = values.deployment as string | undefined;
  if (deploymentId === undefined || !DEPLOYMENT_ID.test(deploymentId)) {
    refuse('RAY_USAGE', '--deployment <id> is required: the deploymentId in deployment.json', {
      path: '/deployment',
    });
  }
  const recipient = values.recipient as string | undefined;
  if (recipient === undefined) {
    refuse('RAY_USAGE', '--recipient <age1...> is required: the age X25519 public recipient', {
      path: '/recipient',
    });
  }
  if (!isRecipient(recipient)) {
    refuse(
      'RAY_USAGE',
      '--recipient is not an age X25519 recipient (age1 followed by 58 Bech32 characters); a ' +
        'passphrase, an identity and the post-quantum or tag recipients are refused',
      { path: '/recipient' },
    );
  }
  const output = values.output as string | undefined;
  if (output === undefined || output === '') {
    refuse('RAY_USAGE', '--output <migration.ray> is required', { path: '/output' });
  }
  const runHistory = values['run-history'] as string | undefined;
  if (runHistory !== 'included' && runHistory !== 'excluded') {
    refuse(
      'RAY_USAGE',
      '--run-history <included|excluded> is required; there is no default: the run history and ' +
        'the workflow inputs and outputs it holds leave the source only when you say so',
      { path: '/run-history' },
    );
  }
  let quiesceDeadlineSeconds = DEFAULT_QUIESCE_DEADLINE_SECONDS;
  const deadline = values['quiesce-deadline'] as string | undefined;
  if (deadline !== undefined) {
    quiesceDeadlineSeconds = /^[1-9][0-9]{0,5}$/.test(deadline) ? Number(deadline) : Number.NaN;
    if (!(quiesceDeadlineSeconds <= MAX_QUIESCE_DEADLINE_SECONDS)) {
      refuse(
        'RAY_USAGE',
        `--quiesce-deadline is a whole number of seconds from 1 to ${MAX_QUIESCE_DEADLINE_SECONDS}`,
        { path: '/quiesce-deadline' },
      );
    }
  }
  const stateDir = (values['state-dir'] as string | undefined) ?? '.rayspec-state';
  if (stateDir === '') refuse('RAY_USAGE', '--state-dir needs a directory');
  return {
    deploymentId,
    stateDir,
    recipient,
    output,
    runHistoryPolicy: runHistory,
    confirmQuiesce: values['confirm-quiesce'] === true,
    quiesceDeadlineSeconds,
    sourceStopped: values['source-stopped'] === true,
  };
}

// ─── the confirmation ──────────────────────────────────────────────────────────────────────────

/**
 * Print the downtime plan and ask for `yes`. Resolves false for any other answer or a closed input;
 * rejects when the signal aborts.
 */
export async function askConfirmation(
  terminal: ConfirmationTerminal,
  plan: readonly string[],
  signal?: AbortSignal,
): Promise<boolean> {
  terminal.output.write(`${plan.join('\n')}\nType "yes" to fence the source and export: `);
  const rl = createInterface({ input: terminal.input, terminal: false });
  try {
    const answer = await new Promise<string | null>((resolvePromise, reject) => {
      const onAbort = () => reject(new Error('interrupted'));
      signal?.addEventListener('abort', onAbort, { once: true });
      rl.once('line', (line) => {
        signal?.removeEventListener('abort', onAbort);
        resolvePromise(line);
      });
      rl.once('close', () => {
        signal?.removeEventListener('abort', onAbort);
        resolvePromise(null);
      });
    });
    return answer !== null && answer.trim().toLowerCase() === 'yes';
  } finally {
    rl.close();
  }
}

function downtimePlan(
  parsed: Parsed,
  applicationId: string,
  applicationVersion: string,
  barrier: string,
): string[] {
  return [
    `rayspec export will fence deployment ${parsed.deploymentId} (${applicationId} ${applicationVersion}).`,
    'While it is fenced, and after the export until you resume it:',
    '  - writes and uploads are refused with 503 SERVICE_UNAVAILABLE; reads keep answering;',
    '  - cron and webhook triggers, the run queue and event streams are stopped;',
    `  - runs in flight are drained for up to ${parsed.quiesceDeadlineSeconds} seconds;`,
    `  - database write barrier: ${barrier}.`,
    `The source stays fenced after the export. Release it with \`rayspec resume --deployment ${parsed.deploymentId} --fence-epoch <n>\`.`,
  ];
}

// ─── the verb ──────────────────────────────────────────────────────────────────────────────────

type Server = typeof import('@rayspec/server');

/** The fence as the environment records it. */
async function readFence(db: Db): Promise<{ epoch: number; state: 'open' | 'fenced' } | null> {
  try {
    const rows = (await db.$client.unsafe(
      `SELECT fence_state, fence_epoch::text AS fence_epoch FROM runtime_control_state WHERE id = 1`,
    )) as unknown as { fence_state: string; fence_epoch: string }[];
    const row = rows[0];
    if (row === undefined) return { epoch: 0, state: 'open' };
    return {
      epoch: Number(row.fence_epoch),
      state: row.fence_state === 'fenced' ? 'fenced' : 'open',
    };
  } catch {
    return null;
  }
}

/**
 * Where the blobs of the active version are, decided the way the runtime decides it: a blob backend
 * an extension provides comes before `RAYSPEC_BLOB_ROOT`, so an application that loads any extension
 * is `unsupported` whether or not the root is set (which extension provides one is known only by
 * running its code). Otherwise the fs store at `blobRoot`, or none.
 */
async function blobSourceOf(
  server: Server,
  stateDir: StateDirectory,
  env: NodeJS.ProcessEnv,
  blobRoot: string | undefined,
): Promise<SnapshotBlobSource> {
  const fallback: SnapshotBlobSource =
    blobRoot !== undefined ? { kind: 'fs', root: resolve(blobRoot) } : { kind: 'none' };
  const active = await stateDir.readActive().catch(() => null);
  if (active === null) return fallback;
  const root = stateDir.versionPath(active.bundleSha256);
  const manifestBytes = await readFile(join(root, 'ray.json')).catch(() => null);
  const validated = manifestBytes === null ? null : validateManifest(manifestBytes);
  if (validated === null || !validated.ok || validated.value.kind !== 'application') {
    // The preflight refuses this version directory with its own finding.
    return fallback;
  }
  const specPath = join(root, ...validated.value.spec.split('/'));
  const specText = await readFile(specPath, 'utf8').catch(() => '');
  const { parseSpec } = await import('@rayspec/spec');
  const parsed = parseSpec(specText);
  if (parsed.ok && parsed.value.extensions.length > 0) {
    return { kind: 'unsupported', name: 'a blob backend an extension may provide' };
  }
  if (blobRoot !== undefined) return fallback;
  const report = await server.checkBootEnv(specPath, specText, { ...env, RAYSPEC_BLOB_ROOT: '' });
  if (report.required.some((r) => r.name === 'RAYSPEC_BLOB_ROOT')) {
    refuse(
      'RAY_USAGE',
      'the deployed application keeps blobs, and RAYSPEC_BLOB_ROOT is not set: set it to the blob ' +
        'root the deployment serves from',
    );
  }
  return fallback;
}

function userOf(url: string): string {
  try {
    return decodeURIComponent(new URL(url).username);
  } catch {
    return '';
  }
}

function passwordOf(url: string | undefined): string[] {
  if (url === undefined) return [];
  try {
    const password = decodeURIComponent(new URL(url).password);
    return password === '' ? [] : [password];
  } catch {
    return [];
  }
}

function barrierLine(barriers: readonly { barrier: string; state: string }[]): string {
  return barriers.map((b) => `${b.barrier} ${b.state}`).join(', ');
}

/** The database barrier quiesce reports, as a capture states it: both forms, one not applied. */
function captureBarriers(data: QuiesceData): CaptureBarrier[] {
  const database = data.barriers.find((b) => b.barrier !== 'object-writes');
  const form = database?.barrier ?? 'database-write-role';
  const other = form === 'database-write-role' ? 'database-stopped-source' : 'database-write-role';
  const objects = data.barriers.find((b) => b.barrier === 'object-writes');
  return [
    { barrier: form as CaptureBarrier['barrier'], state: database?.state ?? 'unavailable' },
    { barrier: other, state: 'not-applied' },
    { barrier: 'object-writes', state: objects?.state ?? 'unavailable' },
  ];
}

/** Run `rayspec export ...`. Never throws for a refusal; an unexpected failure is thrown. */
export async function runExport(
  args: readonly string[],
  options: ExportOptions,
): Promise<ExportOutcome> {
  const env = options.env ?? process.env;
  const progress = options.progress ?? ((line: string) => process.stderr.write(`${line}\n`));
  const server = await import('@rayspec/server');
  // Everything this process writes from here on passes the one redaction path.
  server.installOutputRedaction();

  let warnings: BundleWarning[] = [];
  let receipts: ExportReceiptLog | null = null;
  let scratch: ExportScratch | null = null;
  let control: Db | null = null;
  let workflowControl: Db | null = null;
  let parsed: Parsed | null = null;
  /** The fence this export holds, once quiesce has taken or found it. */
  let fenced: { epoch: number } | null = null;
  /** The digests established so far; every transition from the precheck's end on carries them. */
  let known: ExportDigests = {};

  const recoveryFor = (deploymentId: string): string =>
    fenced === null
      ? 'nothing at the source was changed'
      : `the source stays fenced at epoch ${fenced.epoch}: run the export again, or release the ` +
        `fence with \`${server.resumeInstruction(deploymentId, fenced.epoch)}\``;

  const blocked = async (errors: BundleError[]): Promise<ExportOutcome> => {
    const id = parsed?.deploymentId;
    const withRecovery =
      fenced === null || id === undefined
        ? errors
        : errors.map((e, i) =>
            i === 0
              ? {
                  ...e,
                  message: `${e.message} — ${recoveryFor(id)}`,
                }
              : e,
          );
    if (receipts !== null && id !== undefined) {
      const fence = control === null ? null : await readFence(control);
      await receipts
        .transition('BLOCKED', {
          fenceEpoch: fence?.epoch ?? fenced?.epoch ?? null,
          fenceState: fence?.state ?? (fenced === null ? null : 'fenced'),
          digests: known,
          recovery: recoveryFor(id),
          ...(errors[0] === undefined ? {} : { error: errors[0] }),
        })
        .catch(() => {});
    }
    const result = envelope<ExportData>(
      'export',
      options.operationId,
      null,
      withRecovery,
      warnings,
    );
    const first = result.errors[0];
    return {
      envelope: result,
      summary:
        first === undefined
          ? []
          : [
              `refused: ${first.code}${first.reason ? ` (${first.reason})` : ''} — ${first.message}`,
            ],
    };
  };
  const interrupted = () =>
    bundleError('RAY_INTERRUPTED', 'interrupted before the export finished; nothing was written');
  const safePoint = () => {
    if (options.signal?.aborted === true) throw new Refused([interrupted()]);
  };

  try {
    parsed = parseExportArgs(args, server.isAgeX25519Recipient);
    const p = parsed;

    // The state directory and the deployment it holds.
    let stateDir: StateDirectory | null;
    try {
      stateDir = await server.openStateDirectory(resolve(p.stateDir), { create: false });
    } catch (err) {
      if (err instanceof server.StateDirectoryError) throw new Refused([err.error]);
      throw err;
    }
    if (stateDir === null) {
      refuse('RAY_USAGE', 'there is no deployment state directory at --state-dir', {
        path: '/state-dir',
      });
    }
    const dir = stateDir;
    let recorded: Awaited<ReturnType<StateDirectory['readDeployment']>>;
    try {
      recorded = await dir.readDeployment();
    } catch (err) {
      if (err instanceof server.StateDirectoryError) throw new Refused([err.error]);
      throw err;
    }
    if (recorded === null || recorded.deploymentId !== p.deploymentId) {
      refuse(
        'RAY_USAGE',
        recorded === null
          ? 'the state directory holds no deployment; name the state directory of the deployment'
          : '--deployment is not the deployment of this state directory',
        { path: '/deployment' },
      );
    }

    // The output: never an existing file, in a directory that exists.
    const outputPath = resolve(p.output);
    if ((await lstat(outputPath).catch(() => null)) !== null) {
      refuse('RAY_OUTPUT_EXISTS', 'the output already exists; name a new file', {
        path: '/output',
      });
    }
    const parent = await lstat(dirname(outputPath)).catch(() => null);
    if (parent === null || !parent.isDirectory()) {
      refuse('RAY_USAGE', 'the directory of --output does not exist', { path: '/output' });
    }

    // The confirmation must be possible before anything is read from the source.
    const terminal = options.terminal ?? null;
    if (!p.confirmQuiesce && (options.json || terminal === null)) {
      refuse(
        'RAY_USAGE',
        'the export fences the source: pass --confirm-quiesce to confirm the downtime (required ' +
          'with --json and without a terminal)',
        { path: '/confirm-quiesce' },
      );
    }

    // The configuration, from the explicit environment only.
    let config: ReturnType<Server['loadExportSourceConfig']>;
    try {
      config = server.loadExportSourceConfig(env, () => {});
    } catch (err) {
      if (err instanceof server.BootConfigError) {
        refuse(
          'RAY_USAGE',
          `${err.message.replace(/^[^—]*— /, '')} An export reads its configuration from the ` +
            'explicit process environment only; no .env file is loaded',
        );
      }
      throw err;
    }
    server.registerSecretValues(
      [
        config.databaseUrl,
        config.dbosSystemDatabaseUrl,
        config.migrationDatabaseUrl,
        config.migrationDbosSystemDatabaseUrl,
        config.snapshotDatabaseUrl,
        config.snapshotDbosSystemDatabaseUrl,
      ].flatMap((url) => (url === undefined ? [] : [url, ...passwordOf(url)])),
    );
    const roleSeparated = config.migrationDatabaseUrl !== undefined;
    const runtimeRole = roleSeparated ? userOf(config.databaseUrl) : undefined;
    if (runtimeRole === '') {
      refuse(
        'RAY_USAGE',
        'with RAYSPEC_MIGRATION_DATABASE_URL set, DATABASE_URL must name the runtime role, whose ' +
          'writes the fence revokes',
      );
    }
    const pgDump = env.RAYSPEC_PG_DUMP?.trim() || undefined;
    if (pgDump !== undefined && !pgDump.startsWith('/')) {
      refuse('RAY_USAGE', 'RAYSPEC_PG_DUMP must be an absolute path to pg_dump');
    }
    const blob = await blobSourceOf(server, dir, env, config.blobRoot);
    if (blob.kind === 'unsupported') {
      refuse(
        'RAY_EXTERNAL_STATE_UNSUPPORTED',
        'the deployed application loads an extension, and an extension may keep the blobs in a ' +
          'backend of its own, which the runtime prefers over RAYSPEC_BLOB_ROOT; an export reads ' +
          'the fs blob store only',
        { reason: 'unsupported-blob-adapter' },
      );
    }
    safePoint();

    // The scratch space, held for this export alone; what a killed export left there is removed.
    try {
      scratch = await server.takeExportScratch(dir, options.operationId);
    } catch (err) {
      if (err instanceof server.StateDirectoryError) throw new Refused([err.error]);
      throw err;
    }
    const controlUrl = config.migrationDatabaseUrl ?? config.databaseUrl;
    const controlWorkflowUrl =
      config.migrationDbosSystemDatabaseUrl ?? config.dbosSystemDatabaseUrl;
    control = server.openControlDatabase(controlUrl);
    receipts = server.ExportReceiptLog.start(dir, options.operationId, {
      deploymentId: p.deploymentId,
      recipient: p.recipient,
      runHistoryPolicy: p.runHistoryPolicy,
      sourceStopped: p.sourceStopped,
      quiesceDeadlineSeconds: p.quiesceDeadlineSeconds,
    });
    if (scratch.cleanedUpAfter !== null) {
      await server.closeInterruptedExport(
        dir,
        scratch.cleanedUpAfter,
        options.operationId,
        control,
      );
      progress(
        `removed what an interrupted export (${scratch.cleanedUpAfter}) left in the scratch directory`,
      );
    }

    // PRECHECK.
    progress('precheck: reading the source');
    const before = await readFence(control);
    if (before === null) {
      refuse(
        'RAY_INFRA_UNAVAILABLE',
        'the environment database could not be read; check that it is reachable and retry',
      );
    }
    const source: Omit<ExportSnapshotOptions, 'fenceEpoch' | 'recipient' | 'output'> = {
      db: control,
      databaseUrl: controlUrl,
      workflowSystemDatabaseUrl: controlWorkflowUrl,
      ...(config.snapshotDatabaseUrl !== undefined
        ? {
            snapshotRole: {
              databaseUrl: config.snapshotDatabaseUrl,
              ...(config.snapshotDbosSystemDatabaseUrl !== undefined
                ? { workflowSystemDatabaseUrl: config.snapshotDbosSystemDatabaseUrl }
                : {}),
            },
          }
        : {}),
      stateDir: dir,
      deploymentId: p.deploymentId,
      blob,
      ...(pgDump !== undefined ? { pgDump } : {}),
      scratchParent: scratch.dir,
      runHistoryPolicy: p.runHistoryPolicy,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    };
    const preflight = await server.preflightSnapshot(source);
    warnings = [...preflight.warnings];
    // The precheck's transition is recorded once it has finished, with the application digest it
    // established.
    if (preflight.facts !== null) known = { applicationDigest: preflight.facts.applicationDigest };
    await receipts.transition('PRECHECK', {
      fenceEpoch: before.epoch,
      fenceState: before.state,
      digests: known,
      recovery: 'nothing at the source changes until the operator confirms the downtime',
    });
    if (preflight.blockers.length > 0 || preflight.facts === null) {
      return await blocked(
        preflight.blockers.length > 0
          ? preflight.blockers
          : [bundleError('RAY_INTERNAL', 'the precheck returned neither a finding nor the source')],
      );
    }
    const facts = preflight.facts;
    safePoint();

    // The operator's confirmation of the downtime.
    if (!p.confirmQuiesce && terminal !== null) {
      const barrier = roleSeparated
        ? `the runtime role's writes are revoked (database-write-role)`
        : p.sourceStopped
          ? 'you attest that every runtime process is stopped (database-stopped-source)'
          : 'none is available: without role separation, stop every runtime process and pass ' +
            '--source-stopped, or the export will refuse after fencing';
      let confirmed: boolean;
      try {
        confirmed = await askConfirmation(
          terminal,
          downtimePlan(p, facts.applicationId, facts.applicationVersion, barrier),
          options.signal,
        );
      } catch {
        throw new Refused([interrupted()]);
      }
      if (!confirmed) {
        return await blocked([
          bundleError(
            'RAY_USAGE',
            'the downtime was not confirmed; nothing at the source changed',
            {
              path: '/confirm-quiesce',
            },
          ),
        ]);
      }
    }
    safePoint();

    // QUIESCING: from the confirmation on the environment's receipts record the export too, the
    // precheck's transition first.
    await receipts.attach(control);
    const predicted = before.state === 'fenced' ? before.epoch : before.epoch + 1;
    await receipts.transition('QUIESCING', {
      fenceEpoch: before.epoch,
      fenceState: before.state,
      digests: { applicationDigest: facts.applicationDigest },
      recovery:
        'if the export stops here, release the fence with ' +
        `\`${server.resumeInstruction(p.deploymentId, predicted)}\``,
    });
    progress(
      before.state === 'fenced'
        ? `quiesce: the source is fenced at epoch ${before.epoch} already; checking its barriers`
        : `quiesce: fencing the source and draining it (deadline ${p.quiesceDeadlineSeconds} s)`,
    );
    workflowControl = await server.openWorkflowSystemDatabase(control, controlWorkflowUrl);
    const rc = server.createRuntimeControl({
      db: control,
      ...(runtimeRole !== undefined ? { runtimeRole } : {}),
      ...(workflowControl !== null ? { workflowSystemDb: workflowControl } : {}),
      workflowSystemDatabaseName: decodeURIComponent(new URL(controlWorkflowUrl).pathname.slice(1)),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    const quiesced = await rc.quiesce({
      contractVersion: CONTRACT_VERSION,
      operationId: options.operationId,
      actor: server.EXPORT_ACTOR,
      reason: `export ${options.operationId}`,
      deadline: formatTimestamp(new Date(Date.now() + p.quiesceDeadlineSeconds * 1000)),
      sourceStopped: p.sourceStopped,
    });
    warnings = [...warnings, ...quiesced.warnings];
    if (quiesced.data !== null) fenced = { epoch: quiesced.data.fenceEpoch };
    else {
      // The fence may have been taken before the operation failed: read it back.
      const now = await readFence(control);
      if (now?.state === 'fenced') fenced = { epoch: now.epoch };
    }
    safePoint();
    if (!quiesced.ok || quiesced.data === null) return await blocked(quiesced.errors);
    const data = quiesced.data;
    const barriers = captureBarriers(data);
    const databaseHeld = barriers[0]?.state === 'held';

    // FROZEN, or blocked for want of a database barrier.
    if (!databaseHeld) {
      return await blocked([
        bundleError(
          'RAY_EXTERNAL_STATE_UNSUPPORTED',
          roleSeparated
            ? "the runtime role's writes could not be revoked, so no database write barrier holds"
            : 'no database write barrier holds: without role separation the barrier is a stopped ' +
                'source; stop every runtime process of the deployment and run the export again ' +
                'with --source-stopped, or enable role separation',
          { reason: 'database-barrier-unavailable' },
        ),
      ]);
    }
    await receipts.transition('FROZEN', {
      fenceEpoch: data.fenceEpoch,
      fenceState: 'fenced',
      digests: { applicationDigest: facts.applicationDigest },
      recovery: recoveryFor(p.deploymentId),
    });
    safePoint();

    // EXPORTING.
    await receipts.transition('EXPORTING', {
      fenceEpoch: data.fenceEpoch,
      fenceState: 'fenced',
      digests: { applicationDigest: facts.applicationDigest },
      recovery: recoveryFor(p.deploymentId),
    });
    progress(`capture: both databases and the blobs under fence epoch ${data.fenceEpoch}`);
    const exported = await server.exportSnapshot({
      ...source,
      fenceEpoch: data.fenceEpoch,
      recipient: p.recipient,
      output: outputPath,
      onCaptured: () => progress('encrypt: writing the migration bundle'),
    });
    if (!exported.ok) {
      if (options.signal?.aborted === true) {
        return await blocked([
          bundleError(
            'RAY_INTERRUPTED',
            'interrupted before the export finished; nothing was written',
          ),
        ]);
      }
      return await blocked(exported.errors);
    }
    const value = exported.value;
    warnings = [
      ...warnings,
      ...value.warnings.filter((w) => !warnings.some((x) => x.code === w.code)),
    ];

    // EXPORTED.
    const counts = (database: 'application' | 'workflow-system') => {
      const rows = value.snapshot.tableCounts.filter((t) => t.database === database);
      return { tables: rows.length, rows: rows.reduce((sum, t) => sum + t.rows, 0) };
    };
    const app = counts('application');
    const sys = counts('workflow-system');
    const recovery =
      `The source stays fenced at epoch ${data.fenceEpoch} (database barrier ` +
      `${barrierLine(value.barriers)}; snapshot read as ${value.reader}). Keep it fenced while the ` +
      'bundle is imported and until cutover; to bring the source back instead, run ' +
      `\`${server.resumeInstruction(p.deploymentId, data.fenceEpoch)}\`.`;
    await receipts.summarize({
      applicationId: value.snapshot.applicationId,
      applicationVersion: value.snapshot.applicationVersion,
      sourceRuntime: value.snapshot.sourceRuntime,
      runHistoryPolicy: value.snapshot.runHistoryPolicy,
      workflowSystemDatabase: value.snapshot.workflowSystemDatabase,
      excludedDataCategories: value.snapshot.excludedDataCategories,
      tables: { application: app.tables, workflowSystem: sys.tables },
      rows: { application: app.rows, workflowSystem: sys.rows },
      objectCount: value.snapshot.objectCount,
      reader: value.reader,
      barriers: value.barriers,
      ciphertextSize: value.ciphertextSize,
    });
    await receipts.transition('EXPORTED', {
      fenceEpoch: data.fenceEpoch,
      fenceState: 'fenced',
      digests: {
        applicationDigest: value.snapshot.applicationDigest,
        innerArchiveSha256: value.innerArchiveSha256,
        ciphertextSha256: value.ciphertextSha256,
        migrationBundleSha256: value.migrationBundleSha256,
      },
      recovery,
    });
    const out: ExportData = {
      deploymentId: p.deploymentId,
      outputPath: value.outputPath,
      sha256: value.migrationBundleSha256,
      ciphertextSha256: value.ciphertextSha256,
      ciphertextSize: value.ciphertextSize,
      fenceEpoch: data.fenceEpoch,
      sourceState: 'fenced',
      excludedDataCategories: value.snapshot.excludedDataCategories,
      recovery,
    };
    const receiptPath = join(
      dir.root,
      'receipts',
      `${server.exportReceiptName(options.operationId)}.json`,
    );
    return {
      envelope: envelope('export', options.operationId, out, [], warnings),
      summary: [
        `exported ${value.snapshot.applicationId} ${value.snapshot.applicationVersion} to ${value.outputPath}`,
        `bundle sha256 ${value.migrationBundleSha256}; ciphertext ${value.ciphertextSize} bytes, sha256 ${value.ciphertextSha256}`,
        `snapshot: ${app.tables + sys.tables} tables (${app.rows + sys.rows} rows), ${value.snapshot.objectCount} objects; ` +
          `workflow system database ${value.snapshot.workflowSystemDatabase}; run history ${value.snapshot.runHistoryPolicy}`,
        `not exported: ${value.snapshot.excludedDataCategories.join(', ')}`,
        `read as ${value.reader}; barriers: ${barrierLine(value.barriers)}`,
        recovery,
        `receipt: ${receiptPath}${receipts.databaseReceiptsFailed ? ' (the environment did not take every receipt)' : ''}`,
      ],
    };
  } catch (err) {
    if (err instanceof Refused) return await blocked(err.errors);
    // An unexpected failure is reported without its detail, which could quote the environment; the
    // detail goes to stderr through the redaction path. The receipt records the export as blocked.
    progress(`export failed: ${err instanceof Error ? err.message : String(err)}`);
    return await blocked([bundleError('RAY_INTERNAL', 'the export failed unexpectedly')]);
  } finally {
    await workflowControl?.$client.end().catch(() => {});
    await control?.$client.end().catch(() => {});
    await scratch?.release().catch(() => {});
  }
}
