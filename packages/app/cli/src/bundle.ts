/**
 * `rayspec bundle inspect` and `rayspec bundle verify` — the two passive bundle verbs.
 *
 *   rayspec bundle inspect <file.ray> [--json]
 *       The structural half of the reader pipeline: the archive budget, the container, the manifest
 *       bytes, schema and semantics, and every entry against the inventory. Reports what the bundle
 *       declares and whether a detached signature lies next to it. Runtime, target and capability
 *       checks are not run.
 *   rayspec bundle verify <file.ray> [--runtime <exact-version>] [--signature <file.ray.sig>]
 *                         [--trusted-key <ed25519-public-key.pem>]... [--require-signature] [--json]
 *       The same, then the runtime version, target, capabilities (an unknown id is refused) and
 *       reserved bindings against the running CLI, the spec parsed from the payload and the fields
 *       derived from it, the secret scan, and the signature when one is given, present or required.
 *
 * Both verbs are passive: the archive is read, compared and parsed, never extracted, imported,
 * evaluated or run, and nothing is written anywhere. They write exactly one result envelope to
 * stdout, with or without `--json`; the operation id and, without `--json`, a short description of
 * the bundle go to stderr. The description says what the bundle is and which checks passed; it
 * never vouches for the code the bundle carries.
 *
 * The import graph of this module is the bundle codec, the contract, the spec grammar and Node's
 * own modules: no server, database layer or handler loader is loaded to inspect or verify a bundle.
 */
import { createPublicKey, type KeyObject } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { inspectBundle, verifySignatureFile } from '@rayspec/bundle';
import {
  type ApplicationManifest,
  type BundleError,
  type BundleWarning,
  bundleError,
  CAPABILITIES,
  checkRuntimeAdmission,
  type RayManifest,
  type ReaderLimits,
  type RuntimeProfile,
  SUPPORTED_TARGETS,
  V1_EXECUTION_LEVELS,
} from '@rayspec/bundle-contract';
import { checkDerivedFields, deriveManifestFields, parseBundleSpec } from './bundle-spec.js';
import { type Envelope, envelope, usageEnvelope } from './envelope.js';

/** A problem with the `bundle` group itself (no or an unknown subcommand): exit 2 in index.ts. */
export class BundleCliError extends Error {}

/** The subcommands of the group. */
export const BUNDLE_SUBCOMMANDS = ['inspect', 'verify'] as const;
export type BundleSubcommand = (typeof BUNDLE_SUBCOMMANDS)[number];

export interface BundleRunOptions {
  /** The operation id of this invocation. */
  operationId: string;
  /** The version of the running CLI: the runtime `verify` checks against by default. */
  cliVersion: string;
  /**
   * What the runtime provides, for `verify`; the running CLI's own profile by default. A test
   * substitutes a narrower one.
   */
  runtimeProfile?: (version: string) => RuntimeProfile;
  /**
   * Reader limits lowered from the contract defaults. The CLI takes no limit flag; a test lowers
   * them to reach a limit with a small archive, as the corpus does.
   */
  readerLimits?: Partial<ReaderLimits>;
  /** Whether `--json` was given; index.ts takes the flag off the vector before the verb parses it. */
  json?: boolean;
}

export interface BundleOutcome {
  envelope: Envelope;
  /** The short description of the result for stderr, used without `--json`. */
  summary: string[];
  /** Whether `--json` was given. */
  json: boolean;
}

/** The data of a `bundle inspect` envelope. */
export interface InspectData {
  sha256: string;
  size: number;
  entries: number;
  kind: 'application' | 'migration';
  applicationId: string;
  applicationVersion: string;
  runtimeVersion: string;
  target: { os: string; arch: string; nodeMajor: number };
  requires: string[];
  bindings: { name: string; kind: 'secret' | 'config'; required: boolean }[];
  execution: 'none' | 'in-process' | 'sandboxed' | null;
  egressHosts: string[];
  signature: SignatureData;
  verdict: 'structurally-valid' | 'invalid';
}

/** The data of a `bundle verify` envelope. */
export interface VerifyData {
  sha256: string;
  kind: 'application' | 'migration';
  applicationId: string;
  applicationVersion: string;
  runtimeVersion: string;
  checkedAgainstRuntime: string;
  signature: SignatureData;
  verdict: 'deployable' | 'not-deployable';
}

interface SignatureData {
  present: boolean;
  verified: boolean;
  publicKeySha256: string | null;
}

/**
 * An exact runtime version: the manifest's `runtime.version` form (semver without build metadata,
 * at most 128 characters).
 */
const EXACT_VERSION =
  /^(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:[.](?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?$/;
const MAX_VERSION_LENGTH = 128;

/** A public key file is a few hundred bytes; anything above this is not one. */
const MAX_KEY_FILE_BYTES = 16 * 1024;
/** One byte more than the largest signature file, so an oversized one is seen as such. */
const SIGNATURE_READ_BYTES = 4097;

/**
 * The runtime the running CLI is: its version (or the one `--runtime` names), every capability the
 * vocabulary marks available, the v1 target and the v1 execution levels.
 */
export function cliRuntimeProfile(version: string): RuntimeProfile {
  return {
    version,
    capabilities: CAPABILITIES.filter((c) => c.status === 'available').map((c) => c.id),
    targets: SUPPORTED_TARGETS,
    executionLevels: V1_EXECUTION_LEVELS,
  };
}

/** Run `rayspec bundle <subcommand> ...`. A problem with the group itself throws BundleCliError. */
export async function runBundle(
  args: readonly string[],
  options: BundleRunOptions,
): Promise<BundleOutcome> {
  const [subcommand, ...rest] = args;
  if (subcommand === undefined) {
    throw new BundleCliError('missing bundle subcommand (expected `inspect` or `verify`)');
  }
  if (subcommand === 'inspect') return runInspect(rest, options);
  if (subcommand === 'verify') return runVerify(rest, options);
  throw new BundleCliError(
    `unknown bundle subcommand ${JSON.stringify(subcommand)} (expected \`inspect\` or \`verify\`)`,
  );
}

// ─── inspect ───────────────────────────────────────────────────────────────────────────────────

async function runInspect(
  args: readonly string[],
  options: BundleRunOptions,
): Promise<BundleOutcome> {
  const operation = 'bundle.inspect';
  let parsed: { file: string; json: boolean };
  try {
    const { values, positionals } = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: { json: { type: 'boolean' } },
    });
    parsed = {
      file: onePositional(positionals),
      json: options.json === true || values.json === true,
    };
  } catch (e) {
    return usage(operation, options, e, args);
  }

  const read = await inspectBundle(parsed.file, {
    operation: 'inspect',
    limits: options.readerLimits,
  });
  if (!read.ok) {
    return refused(envelope(operation, options.operationId, null, read.errors), parsed.json);
  }
  const { manifest } = read.value;
  const data: InspectData = {
    sha256: read.value.archiveSha256,
    size: read.value.archiveSize,
    entries: read.value.entryCount,
    kind: manifest.kind,
    applicationId: manifest.application.id,
    applicationVersion: manifest.application.version,
    runtimeVersion: manifest.runtime.version,
    target: { ...manifest.target },
    requires: manifest.kind === 'application' ? [...manifest.requires] : [],
    bindings:
      manifest.kind === 'application'
        ? manifest.bindings.map((b) => ({ name: b.name, kind: b.kind, required: b.required }))
        : [],
    execution: manifest.kind === 'application' ? manifest.permissions.execution : null,
    egressHosts: manifest.kind === 'application' ? [...manifest.permissions.egressHosts] : [],
    signature: {
      present: read.value.signatureFile === 'present',
      verified: false,
      publicKeySha256: null,
    },
    verdict: 'structurally-valid',
  };
  return {
    envelope: envelope(operation, options.operationId, data),
    summary: [
      ...describe(manifest, data.sha256, data.size, data.entries),
      `signature: ${data.signature.present ? 'a signature file lies next to it (not checked)' : 'none'}`,
      'verdict: structurally valid — the archive, manifest and inventory checks passed; runtime,',
      '  target, capability, spec and signature checks were not run (use `rayspec bundle verify`).',
    ],
    json: parsed.json,
  };
}

// ─── verify ────────────────────────────────────────────────────────────────────────────────────

interface VerifyArgs {
  file: string;
  json: boolean;
  runtime: string;
  signature: string | undefined;
  trustedKeys: KeyObject[];
  requireSignature: boolean;
}

async function runVerify(
  args: readonly string[],
  options: BundleRunOptions,
): Promise<BundleOutcome> {
  const operation = 'bundle.verify';
  let parsed: VerifyArgs;
  try {
    const { values, positionals } = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: 'boolean' },
        runtime: { type: 'string' },
        signature: { type: 'string' },
        'trusted-key': { type: 'string', multiple: true },
        'require-signature': { type: 'boolean' },
      },
    });
    const file = onePositional(positionals);
    const runtime = values.runtime ?? options.cliVersion;
    if (runtime.length > MAX_VERSION_LENGTH || !EXACT_VERSION.test(runtime)) {
      throw new Error(
        '--runtime must be an exact version (MAJOR.MINOR.PATCH with an optional pre-release, no build metadata)',
      );
    }
    if (values.signature === '') throw new Error('--signature needs a file path');
    parsed = {
      file,
      json: options.json === true || values.json === true,
      runtime,
      signature: values.signature,
      trustedKeys: await readTrustedKeys(values['trusted-key'] ?? []),
      requireSignature: values['require-signature'] === true,
    };
  } catch (e) {
    return usage(operation, options, e, args);
  }

  // Reader steps 1 to 9. The spec bytes are kept once they have matched the inventory.
  const read = await inspectBundle(parsed.file, {
    operation: 'verify',
    captureSpec: true,
    limits: options.readerLimits,
  });
  if (!read.ok) {
    return refused(envelope(operation, options.operationId, null, read.errors), parsed.json);
  }
  const { manifest } = read.value;
  const signaturePath =
    parsed.signature ?? (read.value.signatureFile === 'present' ? `${parsed.file}.sig` : undefined);
  const data: VerifyData = {
    sha256: read.value.archiveSha256,
    kind: manifest.kind,
    applicationId: manifest.application.id,
    applicationVersion: manifest.application.version,
    runtimeVersion: manifest.runtime.version,
    checkedAgainstRuntime: parsed.runtime,
    signature: { present: signaturePath !== undefined, verified: false, publicKeySha256: null },
    verdict: 'not-deployable',
  };
  const warnings: BundleWarning[] = [];
  const profile = (options.runtimeProfile ?? cliRuntimeProfile)(parsed.runtime);

  const errors = await verifySteps(
    manifest,
    read.value,
    profile,
    parsed,
    signaturePath,
    data,
    warnings,
  );
  if (errors.length > 0) {
    return refused(envelope(operation, options.operationId, data, errors, warnings), parsed.json, [
      ...describe(manifest, data.sha256, read.value.archiveSize, read.value.entryCount),
      `checked against runtime ${parsed.runtime}`,
    ]);
  }
  data.verdict = 'deployable';
  return {
    envelope: envelope(operation, options.operationId, data, [], warnings),
    summary: [
      ...describe(manifest, data.sha256, read.value.archiveSize, read.value.entryCount),
      `checked against runtime ${parsed.runtime}`,
      `signature: ${
        data.signature.verified
          ? `verified with trusted key sha256 ${data.signature.publicKeySha256}`
          : 'none (unsigned; the origin of the bundle is not established)'
      }`,
      'verdict: deployable — the archive, manifest, runtime, target, capability, binding, spec,',
      '  derived-field, secret-scan and signature checks passed. They describe the bundle; they',
      '  do not vouch for the code it carries.',
    ],
    json: parsed.json,
  };
}

/** Reader steps 10 to 17, in order; the first failing step ends the run. */
async function verifySteps(
  manifest: RayManifest,
  read: { archiveSha256: string; specBytes?: Buffer; secretFindings: { path: string }[] },
  profile: RuntimeProfile,
  args: VerifyArgs,
  signaturePath: string | undefined,
  data: VerifyData,
  warnings: BundleWarning[],
): Promise<BundleError[]> {
  // 10 to 13: runtime, target, capabilities, reserved bindings.
  const admitted = checkRuntimeAdmission(manifest, profile);
  if (!admitted.ok) return admitted.errors;

  if (manifest.kind === 'application') {
    // 14: the spec, parsed from the payload.
    if (read.specBytes === undefined) {
      return [bundleError('RAY_INTERNAL', 'the spec bytes were not kept by the reader')];
    }
    const spec = parseBundleSpec(read.specBytes);
    if (!spec.ok) return spec.errors;
    // 15: the fields the spec derives.
    const derived = checkDerivedFields(
      manifest as ApplicationManifest,
      deriveManifestFields(spec.value),
    );
    if (derived.length > 0) return derived;
    // 16: the secret scan.
    if (read.secretFindings.length > 0) {
      return read.secretFindings.map((f) =>
        bundleError('RAY_SECRET_DETECTED', `a payload file matches the secret scan: ${f.path}`, {
          path: f.path,
        }),
      );
    }
  }

  // 17: the signature, when one is given, lies next to the archive, or is required.
  if (signaturePath === undefined) {
    if (args.requireSignature) {
      return [
        bundleError('RAY_SIGNATURE_INVALID', 'the bundle has no signature and one is required', {
          reason: 'malformed',
        }),
      ];
    }
    warnings.push({
      code: 'RAY_W_UNSIGNED',
      message: 'the bundle has no detached signature, so its origin is not established',
    });
    return [];
  }
  const signatureFile = await readSignatureFile(signaturePath);
  if (signatureFile === null) {
    return [
      bundleError('RAY_SIGNATURE_INVALID', 'the signature file cannot be read as a regular file', {
        reason: 'malformed',
      }),
    ];
  }
  const verified = verifySignatureFile(read.archiveSha256, signatureFile, args.trustedKeys);
  if (!verified.ok) return verified.errors;
  data.signature = {
    present: true,
    verified: true,
    publicKeySha256: verified.value.publicKeySha256,
  };
  return [];
}

// ─── files ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Read up to `limit` bytes of a regular file; null when it is not one or cannot be read. The file
 * is opened without blocking, so a FIFO with no writer is answered at once instead of hanging.
 */
async function readBounded(path: string, limit: number): Promise<Buffer | null> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    if (!(await handle.stat()).isFile()) return null;
    const buffer = Buffer.alloc(limit);
    let filled = 0;
    while (filled < limit) {
      const { bytesRead } = await handle.read(buffer, filled, limit - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return buffer.subarray(0, filled);
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

/** The signature file, bounded one byte past its limit so an oversized file stays malformed. */
async function readSignatureFile(path: string): Promise<Buffer | null> {
  return readBounded(path, SIGNATURE_READ_BYTES);
}

/**
 * Each `--trusted-key` file as an Ed25519 public key. A file that cannot be read, is larger than a
 * key file is, holds a private key, or is not an Ed25519 public key in PEM form is a usage error
 * that names the flag, never the file's content.
 */
async function readTrustedKeys(paths: readonly string[]): Promise<KeyObject[]> {
  const keys: KeyObject[] = [];
  for (const path of paths) {
    const bytes = await readBounded(path, MAX_KEY_FILE_BYTES + 1);
    if (bytes === null || bytes.length > MAX_KEY_FILE_BYTES) {
      throw new Error(`--trusted-key ${path} cannot be read as a public key file`);
    }
    const text = bytes.toString('utf8');
    if (/PRIVATE KEY-----/.test(text)) {
      throw new Error(`--trusted-key ${path} holds a private key; give the public key only`);
    }
    let key: KeyObject;
    try {
      key = createPublicKey({ key: text, format: 'pem' });
    } catch {
      throw new Error(`--trusted-key ${path} is not a public key in PEM form`);
    }
    if (key.asymmetricKeyType !== 'ed25519') {
      throw new Error(`--trusted-key ${path} is not an Ed25519 public key`);
    }
    keys.push(key);
  }
  return keys;
}

// ─── shared ────────────────────────────────────────────────────────────────────────────────────

function onePositional(positionals: readonly string[]): string {
  if (positionals.length === 0) throw new Error('missing the <file.ray> argument');
  if (positionals.length > 1) {
    throw new Error(`expected exactly one <file.ray>, got ${positionals.length} arguments`);
  }
  const file = positionals[0]!;
  if (file === '') throw new Error('the <file.ray> argument is empty');
  return file;
}

function usage(
  operation: 'bundle.inspect' | 'bundle.verify',
  options: BundleRunOptions,
  error: unknown,
  args: readonly string[],
): BundleOutcome {
  const message = error instanceof Error ? error.message : String(error);
  const result = usageEnvelope(operation, options.operationId, `invalid arguments: ${message}`);
  return {
    envelope: result,
    summary: errorLines(result),
    json: options.json === true || args.includes('--json'),
  };
}

function refused(result: Envelope, json: boolean, context: string[] = []): BundleOutcome {
  return { envelope: result, summary: [...context, ...errorLines(result)], json };
}

function errorLines(result: Envelope): string[] {
  const first = result.errors[0];
  if (first === undefined) return [];
  const lines = [
    `refused: ${first.code}${first.reason ? ` (${first.reason})` : ''} — ${first.message}`,
  ];
  if (result.errors.length > 1)
    lines.push(`  and ${result.errors.length - 1} more; see the envelope on stdout`);
  return lines;
}

/** What the bundle is, in a few lines: identity, pins, size, digest and declarations. */
function describe(manifest: RayManifest, sha256: string, size: number, entries: number): string[] {
  const t = manifest.target;
  const lines = [
    `${manifest.application.id} ${manifest.application.version} — ${manifest.kind} bundle for runtime ${manifest.runtime.version} on ${t.os}/${t.arch}, Node ${t.nodeMajor}`,
    `${entries} entries, ${size} bytes, sha256 ${sha256}`,
  ];
  if (manifest.kind === 'application') {
    const bindings = manifest.bindings.map(
      (b) => `${b.name} (${b.kind}${b.required ? ', required' : ''})`,
    );
    lines.push(
      `requires: ${manifest.requires.length > 0 ? manifest.requires.join(', ') : 'nothing'}`,
      `bindings: ${bindings.length > 0 ? bindings.join(', ') : 'none'}`,
      `execution: ${manifest.permissions.execution}; egress hosts: ${
        manifest.permissions.egressHosts.length > 0
          ? manifest.permissions.egressHosts.join(', ')
          : 'none'
      }`,
    );
  } else {
    lines.push('encrypted migration snapshot; its contents are not read without the identity');
  }
  return lines;
}
