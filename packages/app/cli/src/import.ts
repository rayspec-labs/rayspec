/**
 * `rayspec import` — restore a migration bundle into a new, empty target, verify it, and leave it
 * fenced until the cutover. The source stays authoritative throughout.
 *
 *   rayspec import <migration.ray> --target <state-dir> --identity-file <file> --dry-run [--json]
 *   rayspec import <migration.ray> --target <state-dir> --identity-file <file>
 *                  --secrets-out <new-dir> [--bindings-file <file>] [--json]
 *   rayspec import --target <state-dir> --discard-failed [--json]
 *
 * THE DRY RUN is the passive eligibility plan: the outer bundle through the one reader, its
 * ciphertext's size and digest, the decryption with the identity file into a private scratch
 * directory under the plaintext budget, the inner snapshot through the same reader, every clear hint
 * against the authenticated metadata, the embedded application through the full reader pipeline for
 * this runtime, each dump's table of contents against the restore allowlist, and the target: empty,
 * the snapshot's server major, roles prepared, a `pg_restore` of that major. It restores nothing,
 * runs nothing from the bundle and writes only the target's (empty) state directory and its scratch
 * space, which it empties again.
 *
 * THE IMPORT runs the same checks, then moves through the migration state machine, each transition
 * recorded in the target's local receipt (`receipts/import-<operationId>.json`) and, once the
 * application database is restored, in the target's environment receipts:
 *   IMPORTING          the target's deployment id is minted (`deployment.json`, `import.json`), and
 *                      both databases are restored as the target's migration role under the shared
 *                      schema lock, then the objects into the blob root;
 *   VERIFYING          row counts, foreign keys, the schema head, one organization owning every row
 *                      and object, empty credential tables, the runtime role's posture, every object's
 *                      digests read back;
 *                      then the identity policy: each account's carried identity recorded in the
 *                      target's security audit, the credentials reset;
 *   READY_FOR_CUTOVER  the target is fenced with the runtime role's writes revoked, and its own boot
 *                      secrets (signing key, API-key pepper, media key) are minted into the new
 *                      directory `--secrets-out` names; the result and the receipt give the cutover
 *                      instruction and the cutover token, which binds the migration bundle, the
 *                      target and both fence epochs; stderr lists who signs in again, which owner
 *                      needs owner recovery and who has no way in;
 *   BLOCKED            any refusal or failure: the source stays authoritative; a target the import
 *                      changed is marked failed (`import.json`, the receipts) and is removed only by
 *                      `--discard-failed`.
 *
 * SIGINT and SIGTERM stop at the next safe point; a running `pg_restore` is ended and rolls back. A
 * process killed outright leaves its scratch data and the mark `IMPORTING`; the next `rayspec import`
 * or `rayspec resume` on the target removes the scratch data, and the next import closes the killed
 * one's receipt and marks the target failed.
 *
 * CONFIGURATION comes from the explicit process environment only, never a `.env` file: `DATABASE_URL`
 * (the target's runtime role) and `RAYSPEC_MIGRATION_DATABASE_URL` (the migration role the restore
 * runs as; required), each with its `_FILE` variant, `DBOS_SYSTEM_DATABASE_URL`, `RAYSPEC_BLOB_ROOT`
 * and `RAYSPEC_PG_RESTORE` (an absolute path to `pg_restore`; default the first on `PATH`). No output
 * carries a value of any of them, of a binding or of the identity file.
 */
import { resolve } from 'node:path';
import { type ParseArgsConfig, parseArgs } from 'node:util';
import {
  type BundleError,
  type BundleWarning,
  bundleError,
  formatTimestamp,
  isReservedBindingName,
  type SchemaHead,
} from '@rayspec/bundle-contract';
import type { Db } from '@rayspec/db';
import type {
  ExportScratch,
  ImportReceiptLog,
  ImportRecord,
  OpenedMigration,
  StateDirectory,
} from '@rayspec/server';
import { MAX_BINDINGS_FILE_BYTES, parseBindingsFile } from './bindings-file.js';
import { type Envelope, envelope } from './envelope.js';

/** The flags of `import`; `--json` is taken off by index.ts before they are parsed. */
export const IMPORT_ARG_OPTIONS = {
  target: { type: 'string' },
  'identity-file': { type: 'string' },
  'bindings-file': { type: 'string' },
  'secrets-out': { type: 'string' },
  'dry-run': { type: 'boolean' },
  'discard-failed': { type: 'boolean' },
} as const satisfies NonNullable<ParseArgsConfig['options']>;

/** An identity file is a few lines; anything larger is not one. */
const MAX_IDENTITY_FILE_BYTES = 64 * 1024;

/** The data of a successful `import.dry-run` envelope (cli-verbs.json `import.dry-run`). */
export interface ImportDryRunData {
  bundleSha256: string;
  eligible: boolean;
  applicationId: string;
  applicationVersion: string;
  sourceRuntime: string;
  schemaHead: SchemaHead;
  fenceEpoch: number;
  workflowSystemDatabase: 'included' | 'absent';
  blockers: BundleError[];
}

/** The data of a successful `import` envelope (cli-verbs.json `import`). */
export interface ImportData {
  bundleSha256: string;
  deploymentId: string;
  status: 'ready-for-cutover';
  applicationDigest: string;
  schemaHead: SchemaHead;
  verification: {
    checksums: 'match';
    tableCounts: 'match';
    objects: 'match';
    referenceIntegrity: 'match';
  };
  credentialReset: {
    sessions: 'reset';
    apiKeys: 'reset';
    invites: 'reset';
    oidcArtifacts: 'reset';
    passwordHashes: 'preserved' | 'reset';
    forcedLogin: boolean;
  };
}

export interface ImportOptions {
  operationId: string;
  json: boolean;
  /** The explicit process environment. Default: `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Aborted on SIGINT or SIGTERM: the import stops at its next safe point. */
  signal?: AbortSignal;
  /** Where progress lines go. Default: stderr. */
  progress?: (line: string) => void;
}

export interface ImportOutcome {
  envelope: Envelope;
  summary: string[];
}

interface Parsed {
  bundle: string | null;
  target: string;
  identityFile: string | null;
  bindingsFile: string | null;
  secretsOut: string | null;
  dryRun: boolean;
  discardFailed: boolean;
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

/** Parse the arguments; every problem is `RAY_USAGE`. */
export function parseImportArgs(args: readonly string[]): Parsed {
  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: IMPORT_ARG_OPTIONS,
    }));
  } catch (e) {
    refuse('RAY_USAGE', `invalid arguments: ${e instanceof Error ? e.message : String(e)}`);
  }
  const target = values.target as string | undefined;
  if (target === undefined || target === '') {
    refuse('RAY_USAGE', '--target <state-dir> is required: the state directory of the new target', {
      path: '/target',
    });
  }
  const discardFailed = values['discard-failed'] === true;
  if (discardFailed) {
    if (
      positionals.length > 0 ||
      values['identity-file'] !== undefined ||
      values['bindings-file'] !== undefined ||
      values['secrets-out'] !== undefined ||
      values['dry-run'] === true
    ) {
      refuse(
        'RAY_USAGE',
        '--discard-failed takes --target alone: it discards what a failed import left in that target',
      );
    }
    return {
      bundle: null,
      target,
      identityFile: null,
      bindingsFile: null,
      secretsOut: null,
      dryRun: false,
      discardFailed,
    };
  }
  if (positionals.length !== 1 || positionals[0] === '') {
    refuse('RAY_USAGE', 'expected exactly one <migration.ray> argument');
  }
  const identityFile = values['identity-file'] as string | undefined;
  if (identityFile === undefined || identityFile === '') {
    refuse(
      'RAY_USAGE',
      '--identity-file <file> is required: the age X25519 identity the bundle was encrypted to',
      { path: '/identity-file' },
    );
  }
  const dryRun = values['dry-run'] === true;
  const bindingsFile = (values['bindings-file'] as string | undefined) ?? null;
  if (dryRun && bindingsFile !== null) {
    refuse('RAY_USAGE', '--bindings-file is read by an import, not by its dry run');
  }
  const secretsOut = (values['secrets-out'] as string | undefined) ?? null;
  if (dryRun && secretsOut !== null) {
    refuse('RAY_USAGE', '--secrets-out is written by an import, not by its dry run');
  }
  if (!dryRun && (secretsOut === null || secretsOut === '')) {
    refuse(
      'RAY_USAGE',
      "--secrets-out <new-dir> is required: the import mints the target's own signing key, API-key " +
        "pepper and media key into that new directory (mode 0700); the source's secrets are never " +
        'carried',
      { path: '/secrets-out' },
    );
  }
  return {
    bundle: positionals[0] as string,
    target,
    identityFile,
    bindingsFile,
    secretsOut,
    dryRun,
    discardFailed,
  };
}

type Server = typeof import('@rayspec/server');

function passwordOf(url: string | undefined): string[] {
  if (url === undefined) return [];
  try {
    const password = decodeURIComponent(new URL(url).password);
    return password === '' ? [] : [password];
  } catch {
    return [];
  }
}

function userOf(url: string): string {
  try {
    return decodeURIComponent(new URL(url).username);
  } catch {
    return '';
  }
}

/** Read an import record, or null when the state directory has none or it is not one. */
function importRecordOf(value: unknown): ImportRecord | null {
  const v = value as Partial<ImportRecord> | null;
  if (
    typeof v !== 'object' ||
    v === null ||
    v.importFormatVersion !== 1 ||
    typeof v.operationId !== 'string' ||
    (v.state !== 'IMPORTING' && v.state !== 'READY_FOR_CUTOVER' && v.state !== 'BLOCKED')
  ) {
    return null;
  }
  return v as ImportRecord;
}

/** Run `rayspec import ...`. Never throws for a refusal; an unexpected failure is thrown. */
export async function runImport(
  args: readonly string[],
  options: ImportOptions,
): Promise<ImportOutcome> {
  const env = options.env ?? process.env;
  const progress = options.progress ?? ((line: string) => process.stderr.write(`${line}\n`));
  const server = await import('@rayspec/server');
  server.installOutputRedaction();
  const operation = args.includes('--dry-run') ? 'import.dry-run' : 'import';

  let scratch: ExportScratch | null = null;
  let control: Db | null = null;
  let opened: OpenedMigration | null = null;
  let warnings: BundleWarning[] = [];

  const answer = (data: unknown, errors: BundleError[], summary: string[] = []): ImportOutcome => {
    const result = envelope(operation, options.operationId, data, errors, warnings);
    const first = result.errors[0];
    return {
      envelope: result,
      summary:
        first === undefined
          ? summary
          : [
              ...summary,
              `refused: ${first.code}${first.reason ? ` (${first.reason})` : ''} — ${first.message}`,
            ],
    };
  };

  try {
    const p = parseImportArgs(args);
    const targetRoot = resolve(p.target);

    // The target's state directory: created when missing (mode 0700), checked like every other.
    let dir: StateDirectory;
    try {
      const opened = await server.openStateDirectory(targetRoot, { create: true });
      if (opened === null) throw new Error('the state directory could not be opened');
      dir = opened;
    } catch (err) {
      if (err instanceof server.StateDirectoryError) throw new Refused([err.error]);
      throw err;
    }

    // Its scratch space, held for this run alone; what a killed import left there goes first.
    try {
      scratch = await server.takeExportScratch(dir, options.operationId);
    } catch (err) {
      if (err instanceof server.StateDirectoryError) throw new Refused([err.error]);
      throw err;
    }
    const record = importRecordOf(await dir.readImportRecord().catch(() => null));
    if (scratch.cleanedUpAfter !== null) {
      progress(
        `removed what an interrupted import (${scratch.cleanedUpAfter}) left in the scratch directory`,
      );
      await server
        .closeInterruptedImport(
          dir,
          scratch.cleanedUpAfter,
          options.operationId,
          null,
          'the import was killed before it finished; the source stays authoritative: discard the ' +
            'target with `rayspec import --target <target state directory> --discard-failed`, then ' +
            'import again or resume the source',
        )
        .catch(() => false);
    }
    // An import that is not running and never ended was killed: its target is failed.
    if (record !== null && record.state === 'IMPORTING') {
      record.state = 'BLOCKED';
      record.updatedAt = formatTimestamp(new Date());
      await dir.writeImportRecord(record);
      await server
        .closeInterruptedImport(
          dir,
          record.operationId,
          options.operationId,
          null,
          'the import was killed before it finished; the source stays authoritative: discard the ' +
            'target with `rayspec import --target <target state directory> --discard-failed`, then ' +
            'import again or resume the source',
        )
        .catch(() => false);
    }

    // The configuration, from the explicit environment only.
    let config: ReturnType<Server['loadExportSourceConfig']>;
    try {
      config = server.loadExportSourceConfig(env, () => {});
    } catch (err) {
      if (err instanceof server.BootConfigError) {
        refuse(
          'RAY_USAGE',
          `${err.message.replace(/^[^—]*— /, '')} An import reads its configuration from the ` +
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
      ].flatMap((url) => (url === undefined ? [] : [url, ...passwordOf(url)])),
    );
    if (
      config.migrationDatabaseUrl === undefined ||
      config.migrationDbosSystemDatabaseUrl === undefined
    ) {
      refuse(
        'RAY_USAGE',
        "an import restores as the target's migration role: set RAYSPEC_MIGRATION_DATABASE_URL " +
          '(and DATABASE_URL to the runtime role), as the database roles setup prepares them',
      );
    }
    const runtimeRole = userOf(config.databaseUrl);
    if (runtimeRole === '') refuse('RAY_USAGE', 'DATABASE_URL must name the runtime role');
    const pgRestore = env.RAYSPEC_PG_RESTORE?.trim() || undefined;
    if (pgRestore !== undefined && !pgRestore.startsWith('/')) {
      refuse('RAY_USAGE', 'RAYSPEC_PG_RESTORE must be an absolute path to pg_restore');
    }
    const targetConfig = {
      migrationDatabaseUrl: config.migrationDatabaseUrl,
      migrationWorkflowSystemDatabaseUrl: config.migrationDbosSystemDatabaseUrl,
      runtimeRole,
      blobRoot: config.blobRoot === undefined ? null : resolve(config.blobRoot),
      ...(pgRestore !== undefined ? { pgRestore } : {}),
    };

    if (p.discardFailed) {
      return await discard(server, dir, record, targetConfig, options, answer, progress, p.target);
    }

    // The target state directory holds no deployment and no import.
    const present = (await dir.deploymentState()).filter((name) => name !== 'plans');
    if (present.length > 0) {
      refuse(
        'RAY_TARGET_NOT_EMPTY',
        record === null
          ? 'the target state directory already holds a deployment; import into a new, empty one'
          : record.state === 'READY_FOR_CUTOVER'
            ? 'the target state directory holds an import that is ready for its cutover; import ' +
              'into a new, empty one'
            : `the target holds a failed import (${record.operationId}); discard it with ` +
              `\`${server.discardInstruction(p.target)}\`, then import again`,
        { path: '/target' },
      );
    }

    // The directory the target's new boot secrets go into: new, under an existing parent.
    const secretsOut = p.secretsOut === null ? null : resolve(p.secretsOut);
    if (secretsOut !== null) {
      const refusal = await server.bootSecretsDirectoryRefusal(secretsOut);
      if (refusal !== null) throw new Refused([refusal]);
    }

    // The identity file and the bindings file: protected files, their content never printed.
    let identity: string;
    try {
      const bytes = await server.readProtectedFile(
        p.identityFile as string,
        'the identity file',
        MAX_IDENTITY_FILE_BYTES,
      );
      const parsed = server.parseAgeX25519Identity(bytes.toString('utf8'));
      if (parsed === null) {
        refuse(
          'RAY_USAGE',
          'the identity file does not hold exactly one age X25519 identity (AGE-SECRET-KEY-1...), ' +
            'as age-keygen writes it',
          { path: '/identity-file' },
        );
      }
      identity = parsed;
    } catch (err) {
      if (err instanceof server.StateDirectoryError) throw new Refused([err.error]);
      throw err;
    }
    server.registerSecretValues([identity]);
    let fileBindings = new Map<string, string>();
    if (p.bindingsFile !== null) {
      let bytes: Buffer;
      try {
        bytes = await server.readProtectedFile(
          p.bindingsFile,
          'the bindings file',
          MAX_BINDINGS_FILE_BYTES,
        );
      } catch (err) {
        if (err instanceof server.StateDirectoryError) throw new Refused([err.error]);
        throw err;
      }
      const parsed = parseBindingsFile(bytes);
      if (!parsed.ok) throw new Refused([parsed.error]);
      fileBindings = parsed.value;
      server.registerSecretValues(fileBindings.values());
    }

    // The bundle: decrypted and checked in the private scratch directory.
    progress('opening the migration bundle');
    const openedResult = await server.openMigrationBundle({
      bundlePath: resolve(p.bundle as string),
      identity,
      scratchParent: scratch.dir,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    if (!openedResult.ok) throw new Refused(openedResult.errors);
    opened = openedResult.value;
    const o = opened;
    warnings = [...o.warnings];
    const snapshot = o.snapshot;

    // The bindings the target's application will need: none reserved, every one declared, every
    // required one supplied by the file or the explicit environment.
    if (!p.dryRun) checkBindings(server, o, fileBindings, env);

    // The dumps, against the restore allowlist; then the target.
    const tool = await server.resolvePgTool('pg_restore', pgRestore);
    if (tool === null) {
      refuse(
        'RAY_USAGE',
        'no pg_restore was found: install the PostgreSQL client tools of the server major, or name ' +
          'pg_restore by its absolute path (RAYSPEC_PG_RESTORE)',
      );
    }
    progress('inspecting the dumps');
    const dumps = await server.planDumps({ opened: o, pgRestore: tool });
    if (!dumps.ok) throw new Refused(dumps.errors);
    control = server.openControlDatabase(targetConfig.migrationDatabaseUrl, 2);
    progress('checking the target');
    const inspection = await server.inspectImportTarget(control, targetConfig, snapshot);
    const dryRunData = (blockers: BundleError[]): ImportDryRunData => ({
      bundleSha256: o.bundleSha256,
      eligible: blockers.length === 0,
      applicationId: snapshot.applicationId,
      applicationVersion: snapshot.applicationVersion,
      sourceRuntime: snapshot.sourceRuntime,
      schemaHead: snapshot.schemaHead,
      fenceEpoch: snapshot.fenceEpoch,
      workflowSystemDatabase: snapshot.workflowSystemDatabase,
      blockers,
    });
    if (inspection.blockers.length > 0 || inspection.facts === null) {
      const blockers =
        inspection.blockers.length > 0
          ? inspection.blockers
          : [bundleError('RAY_INTERNAL', 'the target check returned neither a finding nor facts')];
      return answer(p.dryRun ? dryRunData(blockers) : null, blockers);
    }
    const facts = inspection.facts;
    const tableTotals = (database: 'application' | 'workflow-system') => {
      const rows = snapshot.tableCounts.filter((t) => t.database === database);
      return { tables: rows.length, rows: rows.reduce((sum, t) => sum + t.rows, 0) };
    };
    if (p.dryRun) {
      const app = tableTotals('application');
      const sys = tableTotals('workflow-system');
      return answer(
        dryRunData([]),
        [],
        [
          `eligible: ${snapshot.applicationId} ${snapshot.applicationVersion} (runtime ${snapshot.sourceRuntime}), ` +
            `snapshot taken under source fence epoch ${snapshot.fenceEpoch}`,
          `would restore ${app.tables + sys.tables} tables (${app.rows + sys.rows} rows) and ` +
            `${snapshot.objectCount} objects; workflow system database ${snapshot.workflowSystemDatabase}`,
          'nothing was restored; run the same command without --dry-run to import',
        ],
      );
    }

    // IMPORTING: the target's own deployment id, and the mark that it is being imported into.
    const deploymentId = server.newDeploymentId();
    await dir.createDeployment({
      deploymentFormatVersion: 1,
      deploymentId,
      createdAt: formatTimestamp(new Date()),
      applicationId: snapshot.applicationId,
    });
    const mark = async (state: ImportRecord['state']) =>
      dir.writeImportRecord({
        importFormatVersion: 1,
        operationId: options.operationId,
        deploymentId,
        migrationBundleSha256: o.bundleSha256,
        sourceFenceEpoch: snapshot.fenceEpoch,
        state,
        updatedAt: formatTimestamp(new Date()),
      } satisfies ImportRecord);
    await mark('IMPORTING');
    const receipts: ImportReceiptLog = server.ImportReceiptLog.start(dir, options.operationId, {
      migrationBundleSha256: o.bundleSha256,
      target: deploymentId,
    });
    receipts.setDeploymentId(deploymentId);
    const digests = {
      migrationBundleSha256: o.bundleSha256,
      ciphertextSha256: o.ciphertextSha256,
      innerArchiveSha256: o.archiveSha256,
      applicationDigest: snapshot.applicationDigest,
    };
    const blockedRecovery =
      'the source stays authoritative: discard the target with `rayspec import --target ' +
      '<target state directory> --discard-failed` and import again, or resume the source at fence ' +
      `epoch ${snapshot.fenceEpoch}`;
    await receipts.transition('IMPORTING', {
      sourceFenceEpoch: snapshot.fenceEpoch,
      targetFenceEpoch: null,
      digests,
      recovery: blockedRecovery,
    });
    progress(`restoring into deployment ${deploymentId}`);
    const restored = await server.restoreImport({
      opened: o,
      dumps: dumps.value,
      config: targetConfig,
      facts,
      control,
      deploymentId,
      operationId: options.operationId,
      actor: server.IMPORT_ACTOR,
      migrationBundleSha256: o.bundleSha256,
      workDir: o.scratchDir,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      onVerifying: async () => {
        progress('verifying the target');
        await receipts.transition('VERIFYING', {
          sourceFenceEpoch: snapshot.fenceEpoch,
          targetFenceEpoch: null,
          digests,
          recovery: blockedRecovery,
        });
      },
    });
    // The target's own receipts take every transition from here on, the earlier ones first. They are
    // attached only now: rows written before the verification would have changed what it counts.
    if (restored.ok || restored.targetChanged) await receipts.attach(control);
    if (!restored.ok) {
      const first = restored.errors[0];
      await receipts
        .transition('BLOCKED', {
          sourceFenceEpoch: snapshot.fenceEpoch,
          targetFenceEpoch: null,
          digests,
          recovery: restored.targetChanged
            ? blockedRecovery
            : 'nothing of the target changed; the source stays authoritative: import again, or ' +
              `resume the source at fence epoch ${snapshot.fenceEpoch}`,
          ...(first === undefined ? {} : { error: first }),
        })
        .catch(() => {});
      if (restored.targetChanged) {
        await mark('BLOCKED');
        return answer(
          null,
          restored.errors.map((e, i) =>
            i === 0
              ? {
                  ...e,
                  message: `${e.message} — discard the target with \`${server.discardInstruction(p.target)}\``,
                }
              : e,
          ),
        );
      }
      // Nothing changed: the target is new again.
      await dir.removeDeploymentState();
      return answer(null, restored.errors);
    }
    const value = restored.value;

    // The target's own boot secrets. A directory that appeared since the check is refused like a
    // failed restore: the target is restored and verified, but not ready without its secrets.
    let secretFiles: Record<string, string>;
    try {
      secretFiles = await server.mintBootSecrets(secretsOut as string);
    } catch {
      await receipts
        .transition('BLOCKED', {
          sourceFenceEpoch: snapshot.fenceEpoch,
          targetFenceEpoch: value.targetFenceEpoch,
          digests,
          recovery: blockedRecovery,
        })
        .catch(() => {});
      await mark('BLOCKED');
      return answer(null, [
        bundleError(
          'RAY_RECONCILIATION_REQUIRED',
          'the target was restored and verified, but its new boot secrets could not be written to --secrets-out; the target is marked failed — discard it with ' +
            `\`${server.discardInstruction(p.target)}\``,
        ),
      ]);
    }

    // READY_FOR_CUTOVER: the cutover token binds the migration, the target and both fences.
    const app = tableTotals('application');
    const sys = tableTotals('workflow-system');
    await receipts.summarize({
      applicationId: snapshot.applicationId,
      applicationVersion: snapshot.applicationVersion,
      sourceRuntime: snapshot.sourceRuntime,
      workflowSystemDatabase: snapshot.workflowSystemDatabase,
      tables: { application: app.tables, workflowSystem: sys.tables },
      rows: { application: app.rows, workflowSystem: sys.rows },
      objectCount: snapshot.objectCount,
      foreignKeys: value.foreignKeys,
      credentialReset: value.credentialReset,
      bootSecrets: 'reissued',
      identity: {
        signInAgain: value.identity.counts['sign-in-again'],
        ownerRecovery: value.identity.counts['owner-recovery'],
        noCredential: value.identity.counts['no-credential'],
      },
    });
    const issuedAt = new Date();
    const token = {
      cutoverTokenFormatVersion: 1 as const,
      migrationBundleSha256: o.bundleSha256,
      applicationDigest: snapshot.applicationDigest,
      targetDeploymentId: deploymentId,
      sourceFenceEpoch: snapshot.fenceEpoch,
      targetFenceEpoch: value.targetFenceEpoch,
      targetEnvironmentRevision: value.targetEnvironmentRevision,
      issuedAt: formatTimestamp(issuedAt),
      expiresAt: formatTimestamp(new Date(issuedAt.getTime() + server.CUTOVER_TOKEN_LIFETIME_MS)),
    };
    const tokenSha256 = await receipts.cutover(token);
    const cutover =
      `cutover: keep the source fenced at epoch ${snapshot.fenceEpoch}; release the target's fence ` +
      `with \`rayspec resume --deployment ${deploymentId} --fence-epoch ${value.targetFenceEpoch} ` +
      `--state-dir ${p.target}\` (the target's environment), then deploy the application the source ` +
      `ran (sha256 ${snapshot.applicationDigest}) there with the new boot secrets: ` +
      `RAYSPEC_JWT_SIGNING_KEY_FILE=${secretFiles.RAYSPEC_JWT_SIGNING_KEY} ` +
      `RAYSPEC_API_KEY_PEPPER_FILE=${secretFiles.RAYSPEC_API_KEY_PEPPER}, and ` +
      `RAYSPEC_MEDIA_SIGNING_KEY from ${secretFiles.RAYSPEC_MEDIA_SIGNING_KEY} when the application ` +
      'has a playback route';
    await receipts.transition('READY_FOR_CUTOVER', {
      sourceFenceEpoch: snapshot.fenceEpoch,
      targetFenceEpoch: value.targetFenceEpoch,
      digests,
      recovery:
        `cutover: keep the source fenced at epoch ${snapshot.fenceEpoch}; release the target's ` +
        `fence with \`rayspec resume --deployment ${deploymentId} --fence-epoch ` +
        `${value.targetFenceEpoch}\`, then deploy the application the source ran on the target. ` +
        `Cutover token ${tokenSha256}`,
    });
    await mark('READY_FOR_CUTOVER');
    const data: ImportData = {
      bundleSha256: o.bundleSha256,
      deploymentId,
      status: 'ready-for-cutover',
      applicationDigest: snapshot.applicationDigest,
      schemaHead: snapshot.schemaHead,
      verification: value.verification,
      credentialReset: value.credentialReset,
    };
    return answer(
      data,
      [],
      [
        `imported ${snapshot.applicationId} ${snapshot.applicationVersion} into deployment ${deploymentId}: ` +
          `${app.tables + sys.tables} tables (${app.rows + sys.rows} rows), ${snapshot.objectCount} objects, ` +
          `${value.foreignKeys} foreign keys; every check matched`,
        'every user signs in again; API keys and invites are issued again (sessions, keys, invites and ' +
          'OIDC artifacts were not carried)',
        ...identityLines(value.identity),
        `the target is fenced at epoch ${value.targetFenceEpoch} and accepts no traffic until the cutover`,
        cutover,
        `cutover token ${tokenSha256}, valid until ${token.expiresAt}: binds the migration bundle, the ` +
          `target and both fence epochs`,
        `receipt: ${dir.root}/receipts/${server.importReceiptName(options.operationId)}.json` +
          (receipts.databaseReceiptsFailed ? ' (the target did not take every receipt)' : ''),
      ],
    );
  } catch (err) {
    if (err instanceof Refused) return answer(null, err.errors);
    progress(`import failed: ${err instanceof Error ? err.message : String(err)}`);
    return answer(null, [bundleError('RAY_INTERNAL', 'the import failed unexpectedly')]);
  } finally {
    await control?.$client.end().catch(() => {});
    await scratch?.release().catch(() => {});
  }
}

/**
 * What the operator tells each account before the cutover: who signs in again with their password,
 * which owner needs owner recovery, which account has no way in; and that every API key is reissued.
 */
function identityLines(report: import('@rayspec/server').IdentityReport): string[] {
  const named = (action: string) =>
    report.users
      .filter((u) => u.action === action)
      .map((u) => `${u.email} (${u.role ?? 'no membership'})`);
  const lines = [
    `sign in again with their password (${report.counts['sign-in-again']}): ` +
      (named('sign-in-again').join(', ') || 'none'),
  ];
  if (report.counts['owner-recovery'] > 0) {
    lines.push(
      `owner recovery needed, no password (${report.counts['owner-recovery']}): ` +
        `${named('owner-recovery').join(', ')} — once the target serves, issue each a one-time token ` +
        'with `rayspec tenant recover-owner --email <address>`',
    );
  }
  if (report.counts['no-credential'] > 0) {
    lines.push(
      `no way in, no password and not an owner (${report.counts['no-credential']}): ` +
        `${named('no-credential').join(', ')} — an owner removes and re-invites them under a new address`,
    );
  }
  lines.push(
    'API keys: none was carried, so every key of the source is reissued by an owner after the ' +
      'cutover; pending invites are issued again',
  );
  return lines;
}

/** Every binding the application declares, against the bindings file and the environment. */
function checkBindings(
  server: Server,
  opened: OpenedMigration,
  fileBindings: ReadonlyMap<string, string>,
  env: NodeJS.ProcessEnv,
): void {
  const declared = new Set(opened.application.manifest.bindings.map((b) => b.name));
  for (const [i, name] of [...fileBindings.keys()].entries()) {
    if (isReservedBindingName(name)) {
      refuse(
        'RAY_BINDING_RESERVED',
        `the bindings file supplies ${name}, a name reserved for the operator; set it in the ` +
          'process environment instead',
        { path: `/bindings/${i}/name` },
      );
    }
    if (!declared.has(name)) {
      refuse(
        'RAY_USAGE',
        `the bindings file supplies ${name}, which the application does not declare`,
        { path: `/bindings/${i}/name` },
      );
    }
  }
  for (const b of opened.application.manifest.bindings) {
    if (!b.required || fileBindings.has(b.name)) continue;
    let value: string | undefined;
    try {
      value = server.isProviderCredentialName(b.name)
        ? server.providerCredential(env, b.name as Parameters<Server['providerCredential']>[1])
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
    if (value === undefined || value === '') {
      refuse(
        'RAY_BINDING_MISSING',
        `the application requires the binding ${b.name}; supply it in the bindings file or the ` +
          'process environment',
      );
    }
  }
}

/** `--discard-failed`: remove what a failed import left in the target. */
async function discard(
  server: Server,
  dir: StateDirectory,
  record: ImportRecord | null,
  config: Parameters<Server['discardImportTarget']>[1],
  options: ImportOptions,
  answer: (data: unknown, errors: BundleError[], summary?: string[]) => ImportOutcome,
  progress: (line: string) => void,
  target: string,
): Promise<ImportOutcome> {
  if (record === null) {
    if ((await dir.deploymentState()).length > 0) {
      refuse(
        'RAY_USAGE',
        'the target state directory holds a deployment, not a failed import; it is never discarded',
        { path: '/target' },
      );
    }
    return answer(null, [], ['the target holds no failed import; nothing was discarded']);
  }
  if (record.state === 'READY_FOR_CUTOVER') {
    refuse(
      'RAY_USAGE',
      'the target holds an import that is ready for its cutover, not a failed one; it is not discarded',
      { path: '/target' },
    );
  }
  const control = server.openControlDatabase(config.migrationDatabaseUrl, 2);
  try {
    progress(`discarding the failed import ${record.operationId}`);
    const discarded = await server.discardImportTarget(control, config, {
      deploymentId: record.deploymentId,
    });
    if (!discarded.ok) return answer(null, discarded.errors);
    await dir.removeDeploymentState();
    return answer(
      null,
      [],
      [
        `discarded what the failed import ${record.operationId} left: both databases and the blob ` +
          `root are empty again, and ${target} holds no deployment; its receipts stay`,
        `run the import again (operation ${options.operationId})`,
      ],
    );
  } finally {
    await control.$client.end().catch(() => {});
  }
}
