/**
 * `rayspec deploy <file.ray>` — deploy an application bundle on an explicitly configured self-hosted
 * target, and serve it.
 *
 *   rayspec deploy <file.ray> --dry-run [--bindings-file <file>] [--state-dir <dir>]
 *                  [--trusted-key <pem>]... [--require-signature] [--json]
 *       Plan only: read and verify the bundle, prepare the plan against the live database and print
 *       it (binding names, schema impact, permission changes, warnings, blockers, plan digest).
 *       Writes the plan record to the state directory and nothing else; runs no SQL that changes
 *       anything and nothing from the bundle.
 *   rayspec deploy <file.ray> [--bindings-file <file>] [--plan-digest <sha256>] [--state-dir <dir>]
 *                  [--port <n>] [--host <addr>] [--trusted-key <pem>]... [--require-signature] [--json]
 *       Deploy: the same checks, the plan accepted (a plan that changes the schema or the grants
 *       must be the one a dry-run printed, named by --plan-digest), the bundle staged into its
 *       immutable version directory, the boot's own validation, then the apply — the platform chain,
 *       the product delta, the active version — and the application served from that directory.
 *
 * WHICH PATH. `index.ts` sends a `deploy` here when its file starts with a ZIP signature or its name
 * ends in `.ray`, reading at most four bytes and before any configuration is loaded or any database
 * is opened. Every other file takes the YAML deploy in `deploy.ts`, unchanged.
 *
 * ORDER. Nothing opens a database until the arguments, the protected files (bindings file, trusted
 * keys, state directory), the bundle (reader steps 1 to 17) and the bindings file's names have been
 * checked. Nothing changes a database until the plan is accepted and the boot has validated the
 * signing key, the spec and everything its preflight checks; the apply then runs inside the boot,
 * before it changes any schema.
 *
 * BINDINGS come only from `--bindings-file` and the explicit process environment: no `.env` file is
 * loaded on this path, whatever `RAYSPEC_SKIP_DOTENV` says. A binding value is never printed, logged
 * or written: the plan carries revision ids, and the values reach only the served application's
 * environment.
 *
 * OUTPUT. One result envelope on stdout, with or without `--json`: `deploy.dry-run` for a dry-run,
 * `deploy` for a deploy, written when the deploy refuses or, once it serves, when it stops. Progress,
 * the boot banner and the operation id go to stderr, and so does anything else written to stdout
 * while the verb runs (the durable runtime's startup lines, a handler's `console.log`).
 */
import { createPublicKey, type KeyObject } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { type ParseArgsConfig, parseArgs } from 'node:util';
import {
  type BindingRevision,
  type BundleError,
  type BundleWarning,
  bundleError,
  CONTRACT_VERSION,
  digestOf,
  formatTimestamp,
  isPlanExpired,
  isReservedBindingName,
  isSha256,
  type PrepareData,
  parseTimestamp,
  planDigestInput,
  schemaValidator,
} from '@rayspec/bundle-contract';
import type { Db } from '@rayspec/db';
import type { ReadApplicationBundle } from '@rayspec/server';
import type { ServeReport } from './deploy.js';
import { type Envelope, type EnvelopeSink, envelope } from './envelope.js';

/** Bytes a ZIP archive starts with: a local file header, or the end record of an empty archive. */
const ZIP_SIGNATURES: readonly (readonly number[])[] = [
  [0x50, 0x4b, 0x03, 0x04],
  [0x50, 0x4b, 0x05, 0x06],
];

/** The flags of `deploy <file.ray>`; `--json` is taken off by index.ts before they are parsed. */
export const BUNDLE_DEPLOY_ARG_OPTIONS = {
  'dry-run': { type: 'boolean' },
  'bindings-file': { type: 'string' },
  'plan-digest': { type: 'string' },
  'state-dir': { type: 'string' },
  port: { type: 'string' },
  host: { type: 'string' },
  'trusted-key': { type: 'string', multiple: true },
  'require-signature': { type: 'boolean' },
} as const satisfies NonNullable<ParseArgsConfig['options']>;

/** The flags of either deploy path that take a value, so the file argument can be told apart. */
const VALUE_FLAGS = new Set([
  '--port',
  '--host',
  '--apply-migration',
  '--allowlist',
  '--bindings-file',
  '--plan-digest',
  '--state-dir',
  '--trusted-key',
]);

/** The largest bindings file: 256 bindings of at most 64 KiB each, with room for the JSON. */
const MAX_BINDINGS_FILE_BYTES = 17 * 1024 * 1024;
/** A public key file is a few hundred bytes; anything above this is not one. */
const MAX_KEY_FILE_BYTES = 16 * 1024;

/** The file argument of a `deploy` vector (the tokens after `deploy`), or undefined. */
export function deployTarget(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const token = args[i] as string;
    if (token === '--') return args[i + 1];
    if (token.startsWith('-')) {
      if (VALUE_FLAGS.has(token)) i += 1;
      continue;
    }
    return token;
  }
  return undefined;
}

/**
 * The first four bytes of a regular file, or why there are none: the path cannot be opened, or it
 * names something other than a regular file.
 */
async function readLeadingBytes(path: string): Promise<Buffer | 'cannot-open' | 'not-a-file'> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    return 'cannot-open';
  }
  try {
    if (!(await handle.stat()).isFile()) return 'not-a-file';
    const buffer = Buffer.alloc(4);
    const { bytesRead } = await handle.read(buffer, 0, 4, 0);
    return buffer.subarray(0, bytesRead);
  } catch {
    return 'cannot-open';
  } finally {
    await handle.close();
  }
}

/** The first four bytes of a regular file, or null when it is not one or cannot be read. */
async function leadingBytes(path: string): Promise<Buffer | null> {
  const bytes = await readLeadingBytes(path);
  return typeof bytes === 'string' ? null : bytes;
}

function startsWithZipSignature(bytes: Buffer | null): boolean {
  return (
    bytes !== null &&
    bytes.length === 4 &&
    ZIP_SIGNATURES.some((sig) => sig.every((b, i) => bytes[i] === b))
  );
}

/** Whether a name ends in `.ray`, compared ASCII case-insensitively. */
export function hasBundleSuffix(path: string): boolean {
  return /\.ray$/i.test(path);
}

/**
 * Whether `rayspec deploy` takes the bundle path for these arguments: the file starts with a ZIP
 * signature or its name ends in `.ray`. Reads at most four bytes; loads nothing and opens nothing
 * else.
 */
export async function isBundleDeploy(args: readonly string[]): Promise<boolean> {
  const target = deployTarget(args);
  if (target === undefined || target === '') return false;
  if (hasBundleSuffix(target)) return true;
  return startsWithZipSignature(await leadingBytes(target));
}

// ─── outcome ───────────────────────────────────────────────────────────────────────────────────

/** The data of a `deploy.dry-run` envelope. */
export interface DryRunData {
  bundleSha256: string;
  plan: PrepareData['plan'];
  planDigest: string;
  environmentRevision: number;
  preparedAt: string;
  expiresAt: string;
  planRecordPath: string;
}

/** The data of a `deploy` envelope. */
export interface DeployData {
  bundleSha256: string;
  deploymentId: string;
  planDigest: string;
  environmentRevision: number;
  status: 'stopped' | 'refused';
}

export type BundleDeployOutcome =
  /** The verb answered: write the envelope and exit with its class. */
  | { kind: 'envelope'; envelope: Envelope; summary: string[] }
  /** The deployment serves; it writes its own envelope when it stops. */
  | { kind: 'served' };

export interface BundleDeployOptions {
  operationId: string;
  /** Whether `--json` was given; the envelope is written either way. */
  json: boolean;
  /** The explicit process environment. Default: `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Where a served deploy writes its envelope when it stops. Default: stdout. */
  envelopeOut?: EnvelopeSink;
}

interface Parsed {
  file: string;
  dryRun: boolean;
  bindingsFile?: string;
  planDigest?: string;
  stateDir: string;
  port?: string;
  host?: string;
  trustedKeys: string[];
  requireSignature: boolean;
}

class Refused extends Error {
  readonly errors: BundleError[];
  readonly data: unknown;
  constructor(errors: BundleError[], data: unknown = null) {
    super(errors[0]?.message ?? 'refused');
    this.errors = errors;
    this.data = data;
  }
}

function refuse(code: Parameters<typeof bundleError>[0], message: string, extra = {}): never {
  throw new Refused([bundleError(code, message, extra)]);
}

function parse(args: readonly string[]): Parsed {
  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: BUNDLE_DEPLOY_ARG_OPTIONS,
    }));
  } catch (e) {
    refuse('RAY_USAGE', `invalid arguments: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (positionals.length !== 1 || positionals[0] === '') {
    refuse('RAY_USAGE', 'expected exactly one <file.ray> argument');
  }
  const dryRun = values['dry-run'] === true;
  const planDigest = values['plan-digest'] as string | undefined;
  if (planDigest !== undefined && !isSha256(planDigest)) {
    refuse('RAY_USAGE', '--plan-digest must be the lowercase hex planDigest a dry-run printed');
  }
  if (dryRun && planDigest !== undefined) {
    refuse(
      'RAY_USAGE',
      '--plan-digest names a plan to deploy; it cannot be combined with --dry-run',
    );
  }
  if (dryRun && (values.port !== undefined || values.host !== undefined)) {
    refuse('RAY_USAGE', '--port and --host choose where a deploy serves; a dry-run serves nothing');
  }
  const stateDir = (values['state-dir'] as string | undefined) ?? '.rayspec-state';
  if (stateDir === '') refuse('RAY_USAGE', '--state-dir needs a directory');
  return {
    file: positionals[0] as string,
    dryRun,
    ...(values['bindings-file'] !== undefined
      ? { bindingsFile: values['bindings-file'] as string }
      : {}),
    ...(planDigest !== undefined ? { planDigest } : {}),
    stateDir,
    ...(values.port !== undefined ? { port: values.port as string } : {}),
    ...(values.host !== undefined ? { host: values.host as string } : {}),
    trustedKeys: (values['trusted-key'] as string[] | undefined) ?? [],
    requireSignature: values['require-signature'] === true,
  };
}

// ─── protected files ───────────────────────────────────────────────────────────────────────────

/**
 * A trusted key: a regular file, not a link, that group and others cannot write, holding an Ed25519
 * public key in PEM form. It holds nothing secret, so it may be readable by others.
 */
async function readTrustedKey(path: string): Promise<KeyObject> {
  // Open first, without following a link, and judge the file through that one handle: a check by
  // path followed by a separate open could be answered by one file and read from another.
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      refuse('RAY_BINDINGS_FILE_INSECURE', `--trusted-key ${path} is a link or not a regular file`);
    }
    refuse('RAY_USAGE', `--trusted-key ${path} cannot be read as a public key file`);
  }
  let text: string;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      refuse('RAY_BINDINGS_FILE_INSECURE', `--trusted-key ${path} is a link or not a regular file`);
    }
    if ((stat.mode & 0o022) !== 0) {
      refuse(
        'RAY_BINDINGS_FILE_INSECURE',
        `--trusted-key ${path} is writable by group or others; restrict it with chmod 644`,
      );
    }
    const buffer = Buffer.alloc(MAX_KEY_FILE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_KEY_FILE_BYTES) {
      refuse('RAY_USAGE', `--trusted-key ${path} is too large to be a public key file`);
    }
    text = buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
  if (/PRIVATE KEY-----/.test(text)) {
    refuse('RAY_USAGE', `--trusted-key ${path} holds a private key; give the public key only`);
  }
  let key: KeyObject;
  try {
    key = createPublicKey({ key: text, format: 'pem' });
  } catch {
    refuse('RAY_USAGE', `--trusted-key ${path} is not a public key in PEM form`);
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    refuse('RAY_USAGE', `--trusted-key ${path} is not an Ed25519 public key`);
  }
  return key;
}

/**
 * The bindings file, parsed against the contract's schema. Its content never appears in a message:
 * a refusal names the member, never a value.
 */
function parseBindingsFile(bytes: Buffer): Map<string, string> {
  let document: unknown;
  try {
    document = JSON.parse(bytes.toString('utf8'));
  } catch {
    refuse('RAY_USAGE', 'the bindings file is not valid JSON');
  }
  const validate = schemaValidator('bindingsFile');
  if (!validate(document)) {
    const at = validate.errors?.[0]?.instancePath ?? '';
    refuse(
      'RAY_USAGE',
      'the bindings file is not {bindingsFormatVersion: 1, bindings: [{name, value}]} with names ' +
        `of capital letters, digits and underscores${at === '' ? '' : ` (at ${at})`}`,
      at === '' ? {} : { path: at },
    );
  }
  const values = new Map<string, string>();
  const bindings = (document as { bindings: { name: string; value: string }[] }).bindings;
  for (const [i, b] of bindings.entries()) {
    if (values.has(b.name)) {
      refuse('RAY_USAGE', `the bindings file names ${b.name} twice`, {
        path: `/bindings/${i}/name`,
      });
    }
    values.set(b.name, b.value);
  }
  return values;
}

// ─── plan records ──────────────────────────────────────────────────────────────────────────────

interface PlanRecord {
  bundleSha256: string;
  bindingRevisions: BindingRevision[];
  preparedAt: string;
}

/** Read a plan record and check that it hashes to the digest that named it. */
function checkPlanRecord(value: unknown, planDigest: string): PlanRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { bundlePath: _path, ...input } = value as Record<string, unknown>;
  if (digestOf(input) !== planDigest) return null;
  if (
    !isSha256(input.bundleSha256) ||
    !Array.isArray(input.bindingRevisions) ||
    parseTimestamp(input.preparedAt) === null
  ) {
    return null;
  }
  return {
    bundleSha256: input.bundleSha256,
    bindingRevisions: input.bindingRevisions as BindingRevision[],
    preparedAt: input.preparedAt as string,
  };
}

// ─── the verb ──────────────────────────────────────────────────────────────────────────────────

/** Where the verb is when a signal arrives: before the boot it stops at the next safe point. */
type Phase = 'preparing' | 'applying' | 'booting';

class Interrupted extends Error {}

/**
 * Run `rayspec deploy <file.ray> ...`. Returns the envelope to write, or `served` once the
 * deployment serves.
 */
export async function runDeployBundle(
  args: readonly string[],
  options: BundleDeployOptions,
): Promise<BundleDeployOutcome> {
  const env = options.env ?? process.env;
  // No `.env` file is read on this path: behave as if the opt-out were set.
  env.RAYSPEC_SKIP_DOTENV = '1';
  let phase: Phase = 'preparing';
  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const release = () => {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  };
  const safePoint = () => {
    if (interrupted && phase === 'preparing') throw new Interrupted();
  };

  let operation: 'deploy' | 'deploy.dry-run' = args.includes('--dry-run')
    ? 'deploy.dry-run'
    : 'deploy';
  let warnings: BundleWarning[] = [];
  try {
    const parsed = parse(args);
    operation = parsed.dryRun ? 'deploy.dry-run' : 'deploy';
    const outcome = await deploy(parsed, options, env, {
      safePoint,
      warn: (w) => {
        warnings = w;
      },
      applying: () => {
        phase = 'applying';
      },
      applied: () => {
        if (interrupted) return false;
        phase = 'booting';
        release();
        return true;
      },
    });
    if (outcome.kind === 'served') return outcome;
    release();
    return outcome;
  } catch (err) {
    release();
    if (err instanceof Interrupted) {
      return answer(operation, options, null, [
        bundleError(
          'RAY_INTERRUPTED',
          'interrupted before the deploy changed anything; nothing was applied, so run the command ' +
            'again',
        ),
      ]);
    }
    if (err instanceof Refused) return answer(operation, options, err.data, err.errors, warnings);
    throw err;
  }
}

function answer(
  operation: 'deploy' | 'deploy.dry-run',
  options: BundleDeployOptions,
  data: unknown,
  errors: BundleError[],
  warnings: BundleWarning[] = [],
  summary: string[] = [],
): BundleDeployOutcome {
  const result = envelope(operation, options.operationId, data, errors, warnings);
  const first = result.errors[0];
  return {
    kind: 'envelope',
    envelope: result,
    summary:
      first === undefined
        ? summary
        : [
            ...summary,
            `refused: ${first.code}${first.reason ? ` (${first.reason})` : ''} — ${first.message}`,
          ],
  };
}

interface Hooks {
  safePoint(): void;
  warn(warnings: BundleWarning[]): void;
  applying(): void;
  /** False when a signal arrived during the apply: the boot then stops instead of serving. */
  applied(): boolean;
}

async function deploy(
  parsed: Parsed,
  options: BundleDeployOptions,
  env: NodeJS.ProcessEnv,
  hooks: Hooks,
): Promise<BundleDeployOutcome> {
  const bundlePath = resolve(parsed.file);

  // Dispatch: a `.ray` name that cannot be read, in the bundle reader's words, or whose bytes are
  // not a ZIP archive.
  const leading = await readLeadingBytes(bundlePath);
  if (leading === 'cannot-open') refuse('RAY_USAGE', 'the archive cannot be opened for reading');
  if (leading === 'not-a-file') refuse('RAY_USAGE', 'the archive is not a regular file');
  if (!startsWithZipSignature(leading)) {
    refuse('RAY_INVALID_ARCHIVE', 'the file is not a ZIP archive', { reason: 'not-a-zip' });
  }

  const server = await import('@rayspec/server');

  // Protected files: the bindings file, the trusted keys, the state directory.
  let fileValues = new Map<string, string>();
  if (parsed.bindingsFile !== undefined) {
    let bytes: Buffer;
    try {
      bytes = await server.readProtectedFile(
        parsed.bindingsFile,
        'the bindings file',
        MAX_BINDINGS_FILE_BYTES,
      );
    } catch (err) {
      if (err instanceof server.StateDirectoryError) throw new Refused([err.error]);
      throw err;
    }
    fileValues = parseBindingsFile(bytes);
  }
  const trustedKeys: KeyObject[] = [];
  for (const path of parsed.trustedKeys) trustedKeys.push(await readTrustedKey(path));
  const stateRoot = resolve(parsed.stateDir);
  let stateDir: Awaited<ReturnType<typeof server.openStateDirectory>>;
  try {
    stateDir = await server.openStateDirectory(stateRoot, { create: false });
  } catch (err) {
    if (err instanceof server.StateDirectoryError) throw new Refused([err.error]);
    throw err;
  }
  hooks.safePoint();

  // Reader steps 1 to 17: nothing is opened but the bundle.
  const read = await server.readApplicationBundle(bundlePath, {
    operation: 'deploy',
    trustedKeys,
    requireSignature: parsed.requireSignature,
  });
  if (!read.ok) throw new Refused(read.errors);
  const bundle = read.value;
  const bundleSha256 = bundle.inspection.archiveSha256;

  // The bindings file's names: a reserved name comes only from the operator's environment.
  for (const [i, name] of [...fileValues.keys()].entries()) {
    if (isReservedBindingName(name)) {
      refuse(
        'RAY_BINDING_RESERVED',
        `the bindings file supplies ${name}, a name reserved for the operator; set it in the ` +
          'process environment instead',
        { path: `/bindings/${i}/name` },
      );
    }
  }
  // Every other name in it must be one the bundle declares, or the provider credential of the speech
  // provider the operator selected (which a bundle cannot declare for itself): a value reaches the
  // application only for a name it asked for. A provider credential the operator also supplies as a
  // file would leave two values for one name.
  const declared = new Set(bundle.manifest.bindings.map((b) => b.name));
  const speech = speechProviderCredentials(env);
  for (const [i, name] of [...fileValues.keys()].entries()) {
    if (!declared.has(name) && !speech.has(name)) {
      refuse(
        'RAY_USAGE',
        `the bindings file supplies ${name}, which the bundle does not declare; a value reaches the ` +
          'application only for a name its manifest declares in bindings',
        { path: `/bindings/${i}/name` },
      );
    }
    if (server.isProviderCredentialName(name) && env[`${name}_FILE`]?.trim()) {
      refuse(
        'RAY_USAGE',
        `the bindings file supplies ${name} and the environment sets ${name}_FILE; supply it in one ` +
          'place',
        { path: `/bindings/${i}/name` },
      );
    }
  }
  hooks.safePoint();

  // The configuration, from the explicit environment only. A deploy validates the whole boot
  // configuration here, before it opens the database.
  if (parsed.port !== undefined) env.PORT = parsed.port;
  if (parsed.host !== undefined) env.RAYSPEC_HOST = parsed.host;
  let databaseUrl: string;
  let apiKeyPepper: string;
  try {
    if (parsed.dryRun) {
      ({ databaseUrl, apiKeyPepper } = server.loadTenantProvisionSecrets(env, () => {}));
    } else {
      ({ databaseUrl, apiKeyPepper } = server.loadServerConfig(env, () => {}));
    }
  } catch (err) {
    if (err instanceof server.BootConfigError) {
      if (parsed.dryRun && err.missing.length > 0) refuse('RAY_USAGE', dryRunMissing(err.missing));
      refuse(
        'RAY_USAGE',
        `${err.message.replace(/^[^—]*— /, '')} A bundle deploy reads its configuration from the ` +
          'explicit process environment only; no .env file is loaded',
      );
    }
    throw err;
  }

  // The binding values the plan covers: every entry of the bindings file, and each binding the
  // bundle declares that the explicit environment supplies — a provider credential through its
  // `_FILE` too, read with the checks the bindings file passes.
  const values = new Map(fileValues);
  for (const b of bundle.manifest.bindings) {
    if (values.has(b.name)) continue;
    let value: string | undefined;
    try {
      value = server.isProviderCredentialName(b.name)
        ? server.providerCredential(env, b.name as Parameters<typeof server.providerCredential>[1])
        : env[b.name];
    } catch (err) {
      if (err instanceof server.CredentialFileError) {
        refuse(
          err.insecure ? 'RAY_BINDINGS_FILE_INSECURE' : 'RAY_USAGE',
          err.message.replace(/^Boot aborted — /, ''),
        );
      }
      throw err;
    }
    if (value !== undefined && value !== '') values.set(b.name, value);
  }
  // Neither kind of value is written to the process environment: the provider credentials are granted
  // to the adapters that use them, the application's own to its handlers (`init.bindings`), once the
  // deploy is past its dry-run.
  const shadowDatabaseUrl = env.SHADOW_DATABASE_URL?.trim() || undefined;
  const runtime = {
    trustedKeys,
    ...(shadowDatabaseUrl !== undefined ? { shadowDatabaseUrl } : {}),
  };

  const { makeDb } = await import('@rayspec/db');
  const db = makeDb(databaseUrl, 2);
  let prepared: Awaited<ReturnType<typeof server.preparePlan>>;
  let deploymentId: string;
  let identity: Awaited<ReturnType<typeof server.readEnvironmentIdentity>>;
  let preparedAt: string;
  let revisions: BindingRevision[];
  try {
    const recordedDeployment = stateDir === null ? null : await stateDir.readDeployment();
    try {
      identity = await server.readEnvironmentIdentity(db);
    } catch {
      refuse(
        'RAY_INFRA_UNAVAILABLE',
        'the environment database could not be read; check that DATABASE_URL names a reachable ' +
          'database and retry',
      );
    }
    if (
      recordedDeployment !== null &&
      identity.deploymentId !== null &&
      recordedDeployment.deploymentId !== identity.deploymentId
    ) {
      refuse(
        'RAY_USAGE',
        'the state directory belongs to another deployment than the database; use the state ' +
          'directory of this deployment',
      );
    }
    deploymentId =
      recordedDeployment?.deploymentId ?? identity.deploymentId ?? server.newDeploymentId();
    const key = identity.bindingRevisionKey ?? server.initialBindingRevisionKey(apiKeyPepper);
    revisions = server.bindingRevisions(values, key);

    // The plan: prepared now, or recomputed at the time of the plan the operator accepted.
    let record: PlanRecord | null = null;
    if (parsed.planDigest !== undefined) {
      const raw = stateDir === null ? null : await stateDir.readPlanRecord(parsed.planDigest);
      record = raw === null ? null : checkPlanRecord(raw, parsed.planDigest);
      if (record === null) {
        refuse(
          'RAY_PLAN_STALE',
          'the state directory holds no plan record for that digest; run `rayspec deploy ' +
            '<file.ray> --dry-run` and deploy with the plan digest it prints',
          { path: '/planDigest' },
        );
      }
      if (record.bundleSha256 !== bundleSha256) {
        refuse('RAY_PLAN_STALE', 'the plan was prepared for another bundle', {
          path: '/planDigest',
        });
      }
      if (isPlanExpired(record.preparedAt, new Date())) {
        refuse('RAY_PLAN_STALE', 'the plan has expired; run the dry-run again', {
          path: '/planDigest',
        });
      }
    }
    preparedAt = record?.preparedAt ?? formatTimestamp(new Date());
    const live = await server.liveSchemaHead(db).catch(() => {
      refuse('RAY_INFRA_UNAVAILABLE', 'the environment database could not be read; retry');
    });
    hooks.safePoint();
    prepared = await server.preparePlan(
      {
        contractVersion: CONTRACT_VERSION,
        operationId: options.operationId,
        actor: server.BUNDLE_DEPLOY_ACTOR,
        bundleSha256,
        bundlePath,
        bindingRevision: revisions,
        expectedSchemaHead: live ?? null,
      },
      { ...runtime, db },
      { preparedAt, requireSignature: parsed.requireSignature },
    );
    // A reviewed plan that no longer matches is stale, and refused before anything is written —
    // unless the environment already recorded a deploy under it, which the apply itself answers
    // (a deploy that was interrupted is continued, one that finished is reported as applied).
    const recomputed = prepared.envelope.data?.planDigest;
    if (
      parsed.planDigest !== undefined &&
      recomputed !== undefined &&
      recomputed !== parsed.planDigest &&
      !(await deployRecorded(db, parsed.planDigest))
    ) {
      refuse(
        'RAY_PLAN_STALE',
        'the plan no longer matches the environment, the bundle or the bindings; run ' +
          '`rayspec deploy <file.ray> --dry-run` again and deploy with the new plan digest',
        { path: '/planDigest' },
      );
    }
  } finally {
    await db.$client.end().catch(() => {});
  }
  if (!prepared.envelope.ok || prepared.envelope.data === null) {
    throw new Refused(prepared.envelope.errors);
  }
  const data = prepared.envelope.data;
  const warnings = prepared.envelope.warnings;
  hooks.warn(warnings);
  hooks.safePoint();

  if (parsed.dryRun) {
    return dryRun(options, stateRoot, bundlePath, bundle, revisions, data, warnings);
  }

  server.grantProviderCredentials(
    new Map([...fileValues].filter(([name]) => server.isProviderCredentialName(name))),
  );
  server.setApplicationBindings({
    declared: bundle.manifest.bindings.map((b) => b.name),
    providerCredentials: server.PROVIDER_CREDENTIAL_NAMES,
    values,
  });

  // Plan acceptance: a plan that changes the schema or the grants must be the reviewed one.
  if (parsed.planDigest === undefined && server.planNeedsReview(data)) {
    refuse(
      'RAY_PLAN_STALE',
      'this deploy changes the schema or the grants of the environment: review it with ' +
        '`rayspec deploy <file.ray> --dry-run` and deploy with --plan-digest <the planDigest it prints>',
      { path: '/planDigest' },
    );
  }
  const planDigest = parsed.planDigest ?? data.planDigest;
  const deployData = (status: DeployData['status'], environmentRevision: number): DeployData => ({
    bundleSha256,
    deploymentId,
    planDigest,
    environmentRevision,
    status,
  });
  // A plan whose digest no longer matches is refused by the apply, which first answers a deploy
  // already recorded under it; blockers of the plan as recomputed now are refused here.
  if (data.planDigest === planDigest && data.plan.blockers.length > 0) {
    throw new Refused(data.plan.blockers, deployData('refused', data.environmentRevision));
  }

  // Stage the bundle into its version directory; nothing in the database has changed.
  let versionRoot: string;
  try {
    const dir = await server.openStateDirectory(stateRoot, { create: true });
    if (dir === null) throw new Error('the state directory could not be created');
    await dir.createDeployment({
      deploymentFormatVersion: 1,
      deploymentId,
      createdAt: preparedAt,
      applicationId: bundle.manifest.application.id,
    });
    versionRoot = await dir.stageVersion(bundlePath, bundleSha256, bundle.manifest);
  } catch (err) {
    if (err instanceof server.StateDirectoryError) {
      throw new Refused([err.error], deployData('refused', data.environmentRevision));
    }
    throw err;
  }
  hooks.safePoint();

  // Serve from the version directory: the spec, the handlers and the extensions it carries, with
  // `@rayspec/*` imports answered by this runtime.
  const specPath = join(versionRoot, ...bundle.manifest.spec.split('/'));
  env.RAYSPEC_SPEC_PATH = specPath;
  env.RAYSPEC_HANDLER_ROOT = dirname(specPath);
  server.installBundleModuleResolution(versionRoot);

  const state = { environmentRevision: data.environmentRevision };
  const report = bundleServeReport(options.operationId, options.envelopeOut ?? process.stdout, () =>
    deployData('stopped', state.environmentRevision),
  );
  process.stderr.write(
    `[rayspec deploy] ${bundle.manifest.application.id} ${bundle.manifest.application.version} ` +
      `(sha256 ${bundleSha256}), plan ${planDigest}, deployment ${deploymentId}\n`,
  );
  const { serveDeployment } = await import('./deploy.js');
  const stateDirectory = await server.openStateDirectory(stateRoot, { create: false });
  await serveDeployment(
    specPath,
    parsed.port,
    undefined,
    undefined,
    parsed.host,
    { json: false },
    {
      report,
      beforeSchemaChange: async (bootDb, tenantIsolation) => {
        hooks.applying();
        const applied = await server.applyBundle({
          db: bootDb,
          runtime,
          bundlePath,
          bundleSha256,
          planDigest,
          preparedAt,
          bindingValues: values,
          initialBindingRevisionKey: server.initialBindingRevisionKey(apiKeyPepper),
          requireSignature: parsed.requireSignature,
          stateDir: stateDirectory as NonNullable<typeof stateDirectory>,
          deploymentId,
          migratePlatform: () => server.applyMigrations(bootDb),
          operationId: options.operationId,
          ...(tenantIsolation !== undefined ? { tenantIsolation } : {}),
        });
        if (!applied.envelope.ok) throw new server.RuntimeApplyError(applied.envelope.errors);
        state.environmentRevision = applied.envelope.data?.environmentRevision ?? 0;
        if (!hooks.applied()) {
          throw new server.RuntimeApplyError([
            bundleError(
              'RAY_INTERRUPTED',
              'interrupted after the deploy was applied; nothing is served. The new version is ' +
                'active: start it with `rayspec deploy <file.ray>`',
            ),
          ]);
        }
        return applied.productLedgerRow === undefined
          ? undefined
          : { productChange: { ledgerRow: applied.productLedgerRow } };
      },
    },
  );
  return { kind: 'served' };
}

/**
 * The provider credentials the runtime itself reads for the speech providers the operator selected:
 * `DEEPGRAM_API_KEY` under `STT_PROVIDER=deepgram`, `OPENAI_API_KEY` under `TTS_PROVIDER=openai`. A
 * bundle does not declare these (the provider is the operator's choice), so the bindings file may
 * supply them without a declaration.
 */
function speechProviderCredentials(env: NodeJS.ProcessEnv): Set<string> {
  const names = new Set<string>();
  if (env.STT_PROVIDER?.trim() === 'deepgram') names.add('DEEPGRAM_API_KEY');
  if (env.TTS_PROVIDER?.trim() === 'openai') names.add('OPENAI_API_KEY');
  return names;
}

/** Why a dry-run needs each variable it reads from the environment. */
const DRY_RUN_NEEDS: Readonly<Record<string, string>> = {
  DATABASE_URL:
    'DATABASE_URL names the target database, whose live schema head and environment revision ' +
    'the plan is prepared against',
  RAYSPEC_API_KEY_PEPPER:
    "RAYSPEC_API_KEY_PEPPER is the deployment's API key pepper; the plan's binding revision ids " +
    'are derived from it until the environment stores its own revision key',
};

/** The refusal of a dry-run that lacks a variable it needs. */
function dryRunMissing(missing: readonly string[]): string {
  const reasons = missing.map((name) => DRY_RUN_NEEDS[name] ?? `${name} is required`);
  return (
    `the dry-run cannot plan: required environment variable(s) missing: ${missing.join(', ')}. ` +
    `${reasons.join('; ')}. Each also accepts a <VAR>_FILE variant naming a file that holds the ` +
    'value. A bundle deploy reads its configuration from the explicit process environment only; ' +
    'no .env file is loaded'
  );
}

/** Whether the environment recorded a deploy under this plan digest, its idempotency key. */
async function deployRecorded(db: Db, planDigest: string): Promise<boolean> {
  const { findIntentByIdempotencyKey } = await import('@rayspec/server');
  try {
    return (await findIntentByIdempotencyKey(db, planDigest)) !== undefined;
  } catch {
    // No receipts table: nothing was ever recorded.
    return false;
  }
}

async function dryRun(
  options: BundleDeployOptions,
  stateRoot: string,
  bundlePath: string,
  bundle: ReadApplicationBundle,
  revisions: BindingRevision[],
  data: PrepareData,
  warnings: BundleWarning[],
): Promise<BundleDeployOutcome> {
  const server = await import('@rayspec/server');
  const { manifest } = bundle;
  // The plan record is the plan digest input itself, plus the path the bundle was read from.
  const input = planDigestInput({
    bundleSha256: data.plan.bundleSha256,
    releaseManifestSha256: null,
    schemaHeadFrom: data.plan.schemaImpact.from,
    schemaHeadTo: data.plan.schemaImpact.to,
    productDeltaSha256: data.plan.schemaImpact.productDeltaSha256,
    bindingRevisions: revisions,
    grants: {
      execution: manifest.permissions.execution,
      egressHosts: manifest.permissions.egressHosts,
      capabilities: manifest.requires,
    },
    environmentRevision: data.environmentRevision,
    preparedAt: data.preparedAt,
  });
  if (digestOf(input) !== data.planDigest) {
    refuse('RAY_INTERNAL', 'the plan record does not reproduce the plan digest');
  }
  let planRecordPath: string;
  try {
    const dir = await server.openStateDirectory(stateRoot, { create: true });
    if (dir === null) throw new Error('the state directory could not be created');
    planRecordPath = await dir.writePlanRecord(data.planDigest, { ...input, bundlePath });
  } catch (err) {
    if (err instanceof server.StateDirectoryError) throw new Refused([err.error]);
    throw err;
  }
  const out: DryRunData = {
    bundleSha256: data.plan.bundleSha256,
    plan: data.plan,
    planDigest: data.planDigest,
    environmentRevision: data.environmentRevision,
    preparedAt: data.preparedAt,
    expiresAt: data.expiresAt,
    planRecordPath,
  };
  const { plan } = data;
  const from = plan.schemaImpact.from;
  const to = plan.schemaImpact.to;
  const summary = [
    `${plan.applicationId} ${plan.applicationVersion} (sha256 ${plan.bundleSha256})`,
    `schema: ${from === null ? 'empty database' : `${from.platform} / ${from.product.slice(0, 12)}`} -> ` +
      `${to.platform} / ${to.product.slice(0, 12)}${
        plan.schemaImpact.productDeltaSha256 === null ? '' : ', with a product delta'
      }${plan.schemaImpact.destructive ? ' (destructive)' : ''}`,
    `bindings: ${
      plan.requiredBindings.length === 0
        ? 'none'
        : plan.requiredBindings
            .map(
              (b) =>
                `${b.name}${b.required ? '' : ' (optional)'}: ${b.satisfied ? 'set' : 'missing'}`,
            )
            .join(', ')
    }`,
    `execution: ${plan.permissionChanges.executionFrom ?? 'none yet'} -> ${plan.permissionChanges.executionTo}`,
    ...plan.blockers.map((b) => `blocker: ${b.code} — ${b.message}`),
    plan.blockers.length === 0
      ? `plan ${data.planDigest}, valid until ${data.expiresAt}: deploy it with --plan-digest ${data.planDigest}`
      : `plan ${data.planDigest} has blockers; resolve them and run the dry-run again`,
  ];
  return answer('deploy.dry-run', options, out, [], warnings, summary);
}

/**
 * The report of a served bundle deploy: banners on stderr, and one `deploy` envelope on stdout when
 * the process leaves — `ok` with status `stopped` after a signal, or the refusal with its typed
 * errors when the boot or the apply refused.
 */
function bundleServeReport(
  operationId: string,
  out: EnvelopeSink,
  data: () => DeployData,
): ServeReport {
  let refusal: { message: string; cause: unknown } | undefined;
  let written = false;
  process.on('exit', (code) => {
    if (written) return;
    written = true;
    const typed = (refusal?.cause as { errors?: unknown } | undefined)?.errors;
    const errors: BundleError[] =
      code === 0 && refusal === undefined
        ? []
        : Array.isArray(typed) && typed.length > 0
          ? (typed as BundleError[])
          : [
              bundleError(
                'RAY_CHECK_FAILED',
                refusal?.message ??
                  'the deployment stopped with a refusal; the reason is on stderr',
              ),
            ];
    const result = envelope(
      'deploy',
      operationId,
      { ...data(), status: errors.length === 0 ? 'stopped' : 'refused' },
      errors,
    );
    out.write(`${JSON.stringify(result, null, 2)}\n`, () => {});
  });
  return {
    log: (line) => console.error(line),
    refused: (message, cause) => {
      refusal = { message, cause };
    },
    stopped: () => {},
  };
}
