/**
 * `rayspec pack` — write an application bundle (`.ray`) from an application that is already built.
 *
 *   rayspec pack --spec <path> --output <file.ray> [--id <application-id>] [--version <semver>]
 *                [--runtime <exact-version>] [--include <path>]... [--source-maps] [--preview]
 *                [--force] [--json]
 *
 * The steps run in the order of the pack pipeline, and the first failing one ends the run: the
 * arguments; the spec, parsed; the application identity; the closure, resolved from what the spec
 * names (`@rayspec/bundle-closure`); the secret scan; the manifest, with its binding names; the
 * archive, written by `@rayspec/bundle`, which reads its own output back through the reader before
 * anything is moved into place.
 *
 * Pack builds nothing and runs nothing. Handlers, extensions and frontends must be built first;
 * modules are read by a lexer, never imported. The archive is written to a temporary file in the
 * directory of the output, its inventory is compared with the digests the closure was checked
 * under, and only then is it linked to the output path (renamed over it with `--force`). A refused
 * or interrupted pack leaves neither the output nor a temporary file behind, and an existing output
 * is never replaced without `--force`.
 *
 * The same prepared files and flags give the same archive bytes wherever and whenever they are
 * packed: bundle paths are relative to the directory of the spec, and the archive carries no
 * timestamp, owner or host.
 *
 * Like the bundle verbs, pack writes exactly one result envelope to stdout, with or without
 * `--json`; the operation id and, without `--json`, the inclusion summary go to stderr. The summary
 * says what was packed; it never suggests that anything was deployed.
 *
 * The import graph of this module is the closure resolver, the bundle codec, the contract, the spec
 * grammar and Node's own modules: no server, database layer or handler loader is loaded to pack.
 */
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { type BundleManifestInput, writeBundle } from '@rayspec/bundle';
import {
  type Closure,
  type ClosurePreview,
  closureFiles,
  closureManifest,
  closurePreview,
  resolveClosure,
} from '@rayspec/bundle-closure';
import {
  type BundleError,
  type BundleErrorCode,
  bundleError,
  isReservedBindingName,
} from '@rayspec/bundle-contract';
import { APPLICATION_VERSION_PATTERN } from '@rayspec/spec';
import { type Envelope, envelope, interruptedEnvelope, usageEnvelope } from './envelope.js';

const OPERATION = 'pack';

/** Every code the pack pipeline can report; any other failure is an internal error. */
export const PACK_ERROR_CODES: readonly BundleErrorCode[] = [
  'RAY_USAGE',
  'RAY_SPEC_INVALID',
  'RAY_APPLICATION_IDENTITY_MISSING',
  'RAY_CLOSURE_INVALID',
  'RAY_RUNTIME_UNSUPPORTED',
  'RAY_BINDING_RESERVED',
  'RAY_SECRET_DETECTED',
  'RAY_LIMIT_EXCEEDED',
  'RAY_OUTPUT_EXISTS',
  'RAY_INTERNAL',
];
const PACK_CODES: ReadonlySet<string> = new Set(PACK_ERROR_CODES);

/** Why `--build` is refused, with the manual step that replaces it. */
export const BUILD_REFUSAL =
  '--build is not available: pack does not run builds yet. Build the application yourself first ' +
  '(compile TypeScript handlers and extensions to JavaScript, build the frontend, and build any ' +
  'native module for linux/x64 and Node 22 in an isolated build), then pack the spec of the built ' +
  'output without --build';

/** Why `--against` and `--allowlist` are refused, with the commands that do the work today. */
export const AGAINST_REFUSAL =
  '--against and --allowlist are not available yet: a bundled product delta must name the product ' +
  'schema heads it migrates between, which are read from a database and not from spec files. ' +
  'Review the delta with `rayspec plan <spec> --against <old-spec> [--allowlist <file.json>]` and ' +
  'apply it with `rayspec deploy <spec> --apply-migration <delta.sql>`';

const MAX_VERSION_LENGTH = 128;

export interface PackRunOptions {
  /** The operation id of this invocation. */
  operationId: string;
  /** The version of the running CLI: the runtime a bundle pins unless `--runtime` names another. */
  cliVersion: string;
  /** Whether `--json` was given; index.ts takes the flag off the vector before pack parses it. */
  json?: boolean;
  /** Raised on SIGINT or SIGTERM. Pack stops at the next safe point and removes what it wrote. */
  signal?: AbortSignal;
  /**
   * Called once the closure is resolved, before anything is written. A test changes a file or
   * raises the signal here, to reach the checks that guard the write.
   */
  afterResolve?: (closure: Closure) => Promise<void> | void;
}

export interface PackOutcome {
  envelope: Envelope;
  /** The inclusion summary for stderr, used without `--json`. */
  summary: string[];
  /** Whether `--json` was given. */
  json: boolean;
}

/** The data of a `pack` envelope. */
export interface PackData {
  outputPath: string | null;
  preview: boolean;
  sha256: string | null;
  size: number | null;
  applicationId: string;
  applicationVersion: string;
  runtimeVersion: string;
  target: { os: string; arch: string; nodeMajor: number };
  requires: string[];
  bindings: { name: string; kind: 'secret' | 'config'; required: boolean }[];
  execution: 'none' | 'in-process' | 'sandboxed';
  egressHosts: string[];
  inclusion: { path: string; size: number; sha256: string; source: string }[];
}

interface PackArgs {
  spec: string;
  output: string;
  id: string | undefined;
  version: string | undefined;
  runtime: string;
  include: string[];
  sourceMaps: boolean;
  preview: boolean;
  force: boolean;
  json: boolean;
}

/**
 * Run `rayspec pack ...`. Every outcome, a refusal included, is an envelope. The summary quotes
 * file names from the application tree, so every control character in it is escaped before it can
 * reach a terminal; the envelope carries them as JSON escapes.
 */
export async function runPack(
  args: readonly string[],
  options: PackRunOptions,
): Promise<PackOutcome> {
  const outcome = await pack(args, options);
  return { ...outcome, summary: outcome.summary.map(printable) };
}

/**
 * A line with every C0 and C1 control character, DEL and bidirectional formatting character
 * written as a `\u` escape, so a hostile file name cannot move the cursor, recolor the terminal or
 * reorder what the line shows.
 */
export function printable(line: string): string {
  let out = '';
  for (const char of line) {
    const code = char.codePointAt(0)!;
    const hidden =
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069);
    out += hidden ? `\\u${code.toString(16).padStart(4, '0')}` : char;
  }
  return out;
}

async function pack(args: readonly string[], options: PackRunOptions): Promise<PackOutcome> {
  let parsed: PackArgs;
  try {
    parsed = parsePackArgs(args, options);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const result = usageEnvelope(OPERATION, options.operationId, `invalid arguments: ${message}`);
    return {
      envelope: result,
      summary: errorLines(result),
      json: options.json === true || args.includes('--json'),
    };
  }

  // Spec, identity, closure and secret scan: the resolver runs them in the pipeline's order.
  const resolved = await resolveClosure({
    specPath: parsed.spec,
    runtimeVersion: parsed.runtime,
    id: parsed.id,
    version: parsed.version,
    include: parsed.include,
    sourceMaps: parsed.sourceMaps,
  });
  if (!resolved.ok) return refused(resolved.errors, parsed.json, options);
  const closure = resolved.value;
  await options.afterResolve?.(closure);
  if (options.signal?.aborted) return interrupted(parsed.json, options);

  // The manifest: every binding name the bundle declares must be one a deployer may supply.
  const manifest = closureManifest(closure);
  const reserved = reservedBindingErrors(manifest);
  if (reserved.length > 0) return refused(reserved, parsed.json, options);

  const preview = closurePreview(closure);
  const data = packData(preview);
  if (parsed.preview) {
    return {
      envelope: envelope(OPERATION, options.operationId, data, [], preview.warnings),
      summary: [
        ...describe(preview, true),
        'preview only: nothing was written. Run the command again without --preview to write the bundle.',
      ],
      json: parsed.json,
    };
  }

  const written = await writeOutput(closure, manifest, parsed, options.signal);
  if (written === 'interrupted') return interrupted(parsed.json, options);
  if (!written.ok) return refused(written.errors, parsed.json, options);
  data.outputPath = written.path;
  data.preview = false;
  data.sha256 = written.sha256;
  data.size = written.size;
  return {
    envelope: envelope(OPERATION, options.operationId, data, [], preview.warnings),
    summary: [
      ...describe(preview, false),
      `wrote ${written.path}`,
      `  ${written.size} bytes, sha256 ${written.sha256}`,
      'This is a package, not a deployment: nothing was deployed, started or run. Check it with',
      `  \`rayspec bundle verify ${written.path}\` before deploying it.`,
    ],
    json: parsed.json,
  };
}

// ─── arguments ─────────────────────────────────────────────────────────────────────────────────

function parsePackArgs(args: readonly string[], options: PackRunOptions): PackArgs {
  const { values } = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: {
      spec: { type: 'string' },
      output: { type: 'string' },
      id: { type: 'string' },
      version: { type: 'string' },
      runtime: { type: 'string' },
      include: { type: 'string', multiple: true },
      against: { type: 'string' },
      allowlist: { type: 'string' },
      'source-maps': { type: 'boolean' },
      preview: { type: 'boolean' },
      force: { type: 'boolean' },
      build: { type: 'boolean' },
      json: { type: 'boolean' },
    },
  });
  if (values.build === true) throw new Error(BUILD_REFUSAL);
  if (values.against !== undefined || values.allowlist !== undefined) {
    throw new Error(AGAINST_REFUSAL);
  }
  if (values.spec === undefined || values.spec === '') {
    throw new Error('--spec <path> is required: the spec file of the built application');
  }
  if (values.output === undefined || values.output === '') {
    throw new Error('--output <file.ray> is required: the bundle file to write');
  }
  const runtime = values.runtime ?? options.cliVersion;
  if (runtime.length > MAX_VERSION_LENGTH || !APPLICATION_VERSION_PATTERN.test(runtime)) {
    throw new Error(
      '--runtime must be an exact version (MAJOR.MINOR.PATCH with an optional pre-release, no build metadata)',
    );
  }
  const include = values.include ?? [];
  if (include.some((path) => path === '')) throw new Error('--include needs a path');
  return {
    spec: values.spec,
    output: values.output,
    id: values.id,
    version: values.version,
    runtime,
    include,
    sourceMaps: values['source-maps'] === true,
    preview: values.preview === true,
    force: values.force === true,
    json: options.json === true || values.json === true,
  };
}

// ─── manifest ──────────────────────────────────────────────────────────────────────────────────

/** A binding name the operator reserves cannot be one the bundle asks a deployer for. */
export function reservedBindingErrors(manifest: BundleManifestInput): BundleError[] {
  if (manifest.kind !== 'application') return [];
  return manifest.bindings
    .filter((binding) => isReservedBindingName(binding.name))
    .map((binding) =>
      bundleError(
        'RAY_BINDING_RESERVED',
        `the binding name ${binding.name} is reserved for the operator and cannot be declared by an application`,
        { path: `/bindings/${manifest.bindings.indexOf(binding)}/name` },
      ),
    );
}

// ─── writing ───────────────────────────────────────────────────────────────────────────────────

type WriteResult =
  | { ok: true; path: string; sha256: string; size: number }
  | { ok: false; errors: BundleError[] }
  | 'interrupted';

/**
 * Write the archive next to the output under a temporary name, check that it carries exactly the
 * bytes the closure was checked under, and move it into place. Whatever the outcome, no temporary
 * file is left behind, and the output exists only when the whole write succeeded.
 */
async function writeOutput(
  closure: Closure,
  manifest: BundleManifestInput,
  args: PackArgs,
  signal: AbortSignal | undefined,
): Promise<WriteResult> {
  const output = resolve(args.output);
  const existing = await lstat(output).catch(() => null);
  if (existing?.isDirectory()) {
    return failure('RAY_USAGE', `the output path ${output} is a directory; name a file`);
  }
  if (existing !== null && !args.force) {
    return failure(
      'RAY_OUTPUT_EXISTS',
      `the output file ${output} already exists; choose another path, or pass --force to replace it`,
    );
  }

  const temporary = join(
    dirname(output),
    `.${basename(output)}.${randomBytes(8).toString('hex')}.pack`,
  );
  try {
    const written = await writeBundle(temporary, { manifest, files: closureFiles(closure) });
    if (!written.ok) return { ok: false, errors: written.errors };
    const inventory =
      written.value.manifest.kind === 'application' ? written.value.manifest.inventory : [];
    const changed = changedFile(closure, inventory);
    if (changed !== undefined) {
      return failure(
        'RAY_USAGE',
        `the application file ${changed} changed while pack was running; nothing was written. ` +
          'Run pack again once the build has finished',
      );
    }
    if (signal?.aborted) return 'interrupted';
    const placed = await place(temporary, output, args.force);
    if (!placed.ok) return placed;
    return {
      ok: true,
      path: output,
      sha256: written.value.archiveSha256,
      size: written.value.archiveSize,
    };
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

/**
 * The source of the first file whose written bytes are not the ones the closure resolved and
 * scanned. The writer reads files on disk again, so a file rewritten in between is caught here,
 * before the archive is moved into place.
 */
function changedFile(
  closure: Closure,
  inventory: readonly { path: string; size: number; sha256: string }[],
): string | undefined {
  const written = new Map(inventory.map((entry) => [entry.path, entry]));
  for (const file of closure.files) {
    const entry = written.get(file.path);
    if (entry === undefined || entry.size !== file.size || entry.sha256 !== file.sha256) {
      return file.source;
    }
    written.delete(file.path);
  }
  // An entry the closure does not list cannot come from these inputs; name it all the same.
  return written.keys().next().value;
}

/** Link the finished archive to the output (rename over it with `--force`), then sync the directory. */
async function place(
  from: string,
  to: string,
  force: boolean,
): Promise<{ ok: true } | { ok: false; errors: BundleError[] }> {
  if (force) {
    await rename(from, to);
  } else {
    try {
      await link(from, to);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        return failure(
          'RAY_OUTPUT_EXISTS',
          `the output file ${to} appeared while pack was running; choose another path, or pass --force to replace it`,
        );
      }
      throw err;
    }
  }
  await syncDirectory(dirname(to));
  return { ok: true };
}

/** Flush the directory entry of the placed archive; a file system that cannot is left as it is. */
async function syncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY);
    await handle.sync();
  } catch {
    // Some file systems refuse to sync a directory; the rename itself has already happened.
  } finally {
    await handle?.close().catch(() => {});
  }
}

function failure(code: BundleErrorCode, message: string): { ok: false; errors: BundleError[] } {
  return { ok: false, errors: [bundleError(code, message)] };
}

// ─── envelope and summary ──────────────────────────────────────────────────────────────────────

function packData(preview: ClosurePreview): PackData {
  return {
    outputPath: null,
    preview: true,
    sha256: null,
    size: null,
    applicationId: preview.applicationId,
    applicationVersion: preview.applicationVersion,
    runtimeVersion: preview.runtimeVersion,
    target: { ...preview.target },
    requires: [...preview.requires],
    bindings: preview.bindings.map(({ name, kind, required }) => ({ name, kind, required })),
    execution: preview.execution,
    egressHosts: [...preview.egressHosts],
    inclusion: preview.inclusion.map(({ path, size, sha256, source }) => ({
      path,
      size,
      sha256,
      source,
    })),
  };
}

/**
 * The envelope of a refusal. A code outside the pack pipeline (a manifest the writer refuses, say)
 * can only come from a defect, so it is reported as an internal error without its message.
 */
function refused(
  errors: readonly BundleError[],
  json: boolean,
  options: PackRunOptions,
): PackOutcome {
  const listed = errors.map((error) =>
    PACK_CODES.has(error.code) || error.code.startsWith('SPEC_')
      ? error
      : bundleError('RAY_INTERNAL', 'pack failed unexpectedly'),
  );
  const result = envelope<never>(OPERATION, options.operationId, null, listed);
  return {
    envelope: result,
    summary: [...errorLines(result), 'nothing was written.'],
    json,
  };
}

function interrupted(json: boolean, options: PackRunOptions): PackOutcome {
  const result = interruptedEnvelope(
    OPERATION,
    options.operationId,
    'no bundle was written, so run the command again',
  );
  return { envelope: result, summary: errorLines(result), json };
}

function errorLines(result: Envelope): string[] {
  const first = result.errors[0];
  if (first === undefined) return [];
  const lines = [
    `refused: ${first.code}${first.reason ? ` (${first.reason})` : ''} — ${first.message}`,
  ];
  if (result.errors.length > 1) {
    lines.push(`  and ${result.errors.length - 1} more; see the envelope on stdout`);
  }
  return lines;
}

/** How many excluded entries the summary names before it only counts the rest. */
const EXCLUDED_SHOWN = 20;

/** The inclusion summary: identity, pins, declarations, what goes in and what was left out. */
function describe(preview: ClosurePreview, listFiles: boolean): string[] {
  const t = preview.target;
  const bindings = preview.bindings.map(
    (b) => `${b.name} (${b.kind}${b.required ? ', required' : ''})`,
  );
  const lines = [
    `${preview.applicationId} ${preview.applicationVersion} — application bundle for runtime ${preview.runtimeVersion} on ${t.os}/${t.arch}, Node ${t.nodeMajor}`,
    `spec: ${preview.spec}`,
    `requires: ${preview.requires.length > 0 ? preview.requires.join(', ') : 'nothing'}`,
    `bindings: ${bindings.length > 0 ? bindings.join(', ') : 'none'} (names only; values are supplied at deploy time)`,
    `execution: ${preview.execution}; egress hosts: ${
      preview.egressHosts.length > 0 ? preview.egressHosts.join(', ') : 'none'
    }`,
    `included: ${preview.inclusion.length} files, ${preview.totalBytes} bytes (${roleCounts(preview)})`,
  ];
  if (listFiles) {
    for (const entry of preview.inclusion) {
      lines.push(
        `  ${entry.path}  ${entry.size} bytes  sha256 ${entry.sha256}  from ${entry.source}`,
      );
    }
  }
  if (preview.excluded.length > 0) {
    lines.push(`left out: ${preview.excluded.length}`);
    for (const entry of preview.excluded.slice(0, EXCLUDED_SHOWN)) {
      lines.push(`  ${entry.source} — ${entry.reason}`);
    }
    if (preview.excluded.length > EXCLUDED_SHOWN) {
      lines.push(`  and ${preview.excluded.length - EXCLUDED_SHOWN} more`);
    }
  }
  for (const warning of preview.warnings) lines.push(`warning ${warning.code}: ${warning.message}`);
  for (const note of preview.notes) lines.push(`note: ${note}`);
  return lines;
}

function roleCounts(preview: ClosurePreview): string {
  const counts = new Map<string, number>();
  for (const entry of preview.inclusion) counts.set(entry.role, (counts.get(entry.role) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([role, count]) => `${count} ${role}`)
    .join(', ');
}
