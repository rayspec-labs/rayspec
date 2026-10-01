/**
 * OPENING A MIGRATION BUNDLE FOR IMPORT — everything an import learns from the bundle before it looks
 * at a target, in this order:
 *
 *  1. the outer bundle, through the one reader (`extractBundle`, operation `import`): the container,
 *     the manifest, and the ciphertext's size and SHA-256 against the inventory, before anything is
 *     decrypted. Only a migration bundle is taken;
 *  2. the ciphertext, decrypted with the operator's X25519 identity into a private scratch directory
 *     (mode 0700) while the plaintext budget is enforced (`decryptFile`); a wrong identity or any
 *     damage is `RAY_DECRYPTION_FAILED` and leaves no plaintext;
 *  3. the inner snapshot archive, through the same reader (`inspectSnapshotArchive`): `snapshot.json`
 *     against its schema, every entry against the inventory, the application digest, the object
 *     index and every object's two digests;
 *  4. the embedded application bundle, through the full reader pipeline for this runtime
 *     (`readApplicationBundle`, steps 1 to 17), so a snapshot of another runtime, target or
 *     capability set is refused as a deploy of that bundle would be;
 *  5. every clear outer hint — the manifest's application, runtime and target — against the
 *     authenticated inner metadata (`snapshot.json` and the embedded manifest), and the snapshot's
 *     runtime against this one (`RAY_DIGEST_MISMATCH` `inner-metadata`, `RAY_RUNTIME_UNSUPPORTED`);
 *  6. the identity policy: password hashes preserved, the one policy this runtime carries out
 *     (`RAY_POLICY_DENIED` `posture-refused` otherwise); the object index as paths: every key one a
 *     blob store could have written, none the directory of another, all of one tenant;
 *  7. each dump's table of contents, read from the archive bytes (`dump-archive.ts`) and compared with
 *     what `pg_restore --list` reads from the same bytes, then judged by the restore allowlist
 *     (`dump-policy.ts`) against the tables `snapshot.json` counts.
 *
 * Nothing here opens a target database or writes outside the scratch directory, and nothing from the
 * bundle is executed. On a refusal the scratch directory is removed; on success the caller owns it
 * and removes it when the import ends.
 */
import { chmod, mkdtemp, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { extractBundle, inspectSnapshotArchive, type SnapshotEntryLocation } from '@rayspec/bundle';
import {
  type ApplicationManifest,
  type BundleError,
  type BundleWarning,
  bundleError,
  compareCodePoints,
  MIGRATION_CIPHERTEXT_PATH,
  type MigrationManifest,
  type ObjectIndex,
  PLATFORM_TABLES,
  type ReaderLimits,
  resolveReaderLimits,
  SNAPSHOT_PATHS,
  type Snapshot,
} from '@rayspec/bundle-contract';
import { redactText } from '@rayspec/core';
import { decryptFile, EncryptionAborted } from './age-encryption.js';
import { DumpArchiveError, type DumpToc, readDumpToc, tocListing } from './dump-archive.js';
import { type DumpDatabase, type DumpRestorePlan, planDumpRestore } from './dump-policy.js';
import { PgDumpError, type PgDumpTool } from './pg-dump.js';
import { type DumpSource, listDump } from './pg-restore.js';
import { declaredStoresOf } from './product-schema-plan.js';
import { readApplicationBundle, runtimeVersion } from './runtime-control.js';

/** The embedded application, as the reader pipeline established it. */
export interface ImportApplication {
  /** The embedded bundle, copied into the scratch directory. */
  path: string;
  sha256: string;
  manifest: ApplicationManifest;
  /** The product store tables its spec declares. */
  productTables: string[];
}

/** One dump of the snapshot, located in the inner archive and planned for restore. */
export interface ImportDump {
  database: DumpDatabase;
  location: SnapshotEntryLocation;
  toc: DumpToc;
  plan: DumpRestorePlan;
}

/** A migration bundle opened for import. */
export interface OpenedMigration {
  /** The private scratch directory (mode 0700); the caller removes it. */
  scratchDir: string;
  /** SHA-256 of the migration bundle's bytes. */
  bundleSha256: string;
  manifest: MigrationManifest;
  ciphertextSha256: string;
  ciphertextSize: number;
  /** The plaintext inner snapshot archive, inside `scratchDir`. */
  archivePath: string;
  archiveSha256: string;
  snapshot: Snapshot;
  objectIndex: ObjectIndex;
  entries: SnapshotEntryLocation[];
  application: ImportApplication;
  warnings: BundleWarning[];
}

export interface OpenMigrationOptions {
  bundlePath: string;
  /** The operator's age X25519 identity (`AGE-SECRET-KEY-1…`). */
  identity: string;
  /** The directory the private scratch directory is created in. */
  scratchParent: string;
  limits?: Partial<ReaderLimits>;
  signal?: AbortSignal;
}

export type OpenMigrationResult =
  | { ok: true; value: OpenedMigration }
  | { ok: false; errors: BundleError[]; interrupted?: true };

class OpenRefusal extends Error {
  constructor(readonly error: BundleError) {
    super(error.message);
  }
}

function refuse(error: BundleError): never {
  throw new OpenRefusal(error);
}

/** Stop at a safe point when the caller's signal has aborted. */
function checkpoint(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new EncryptionAborted();
}

function innerMetadata(what: string): BundleError {
  return bundleError(
    'RAY_DIGEST_MISMATCH',
    `the bundle's clear ${what} differs from the authenticated snapshot inside it`,
    { reason: 'inner-metadata' },
  );
}

/** The temporary file the fs blob store writes before it renames it into place. */
const TEMPORARY_BLOB = /\.tmp-[0-9]+-[0-9]+-[0-9a-f-]{36}$/;

/**
 * Whether an object key is one the fs blob store could have written under a tenant directory: a
 * relative `/`-separated path of non-empty segments, none `.` or `..`, without a NUL, a backslash
 * or a URL-significant character, in Unicode NFC, and not a temporary file of a write.
 */
export function isRestorableObjectKey(key: string): boolean {
  if (key.length === 0 || key.length > 1024 || key.normalize('NFC') !== key) return false;
  if (/[\0\\%#?]/.test(key) || key.startsWith('/')) return false;
  if (TEMPORARY_BLOB.test(key)) return false;
  return key.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The object index as paths: every key restorable, none a directory of another, one tenant. */
function checkObjectKeys(index: ObjectIndex): void {
  const tenants = new Set(index.objects.map((o) => o.tenantId));
  if (tenants.size > 1) {
    refuse(
      bundleError(
        'RAY_MULTI_TENANT_UNSUPPORTED',
        'the snapshot holds objects of more than one tenant; an import restores exactly one',
      ),
    );
  }
  const files = new Set<string>();
  const directories = new Set<string>();
  for (const [i, o] of index.objects.entries()) {
    if (!isRestorableObjectKey(o.key)) {
      refuse(
        bundleError(
          'RAY_MANIFEST_INVALID',
          'an object key is not a path the blob store could have written',
          { reason: 'schema', path: `/objects/${i}/key` },
        ),
      );
    }
    files.add(o.key);
    const segments = o.key.split('/');
    for (let n = 1; n < segments.length; n++) directories.add(segments.slice(0, n).join('/'));
  }
  for (const [i, o] of index.objects.entries()) {
    if (directories.has(o.key)) {
      refuse(
        bundleError(
          'RAY_MANIFEST_INVALID',
          'an object key is also the directory of another object',
          { reason: 'schema', path: `/objects/${i}/key` },
        ),
      );
    }
  }
}

/**
 * Open the migration bundle at `options.bundlePath`: decrypt it into a private scratch directory and
 * check it as the module header describes, up to and excluding the dumps (`planDumps`).
 */
export async function openMigrationBundle(
  options: OpenMigrationOptions,
): Promise<OpenMigrationResult> {
  let limits: ReaderLimits;
  try {
    limits = resolveReaderLimits(options.limits);
  } catch {
    return {
      ok: false,
      errors: [bundleError('RAY_USAGE', 'a reader limit is outside 0 to its default')],
    };
  }
  let scratch: string | undefined;
  try {
    scratch = await mkdtemp(join(options.scratchParent, 'rayspec-import-'));
    await chmod(scratch, 0o700);

    // 1. The outer bundle: its ciphertext's size and digest against the inventory.
    const outer = await extractBundle(options.bundlePath, join(scratch, 'outer'), {
      operation: 'import',
      limits,
      refuseLinks: true,
    });
    if (!outer.ok) refuse(outer.errors[0]!);
    if (outer.value.manifest.kind !== 'migration') {
      refuse(
        bundleError('RAY_MANIFEST_INVALID', 'import takes a migration bundle, not an application', {
          reason: 'migration-inventory',
          path: '/kind',
        }),
      );
    }
    const manifest = outer.value.manifest;
    const cipherEntry = manifest.inventory.find((e) => e.path === MIGRATION_CIPHERTEXT_PATH);
    if (manifest.inventory.length !== 1 || cipherEntry === undefined) {
      refuse(
        bundleError('RAY_MANIFEST_INVALID', 'a migration bundle carries its ciphertext alone', {
          reason: 'migration-inventory',
          path: '/inventory',
        }),
      );
    }

    // 2. Decryption, under the plaintext budget.
    const archivePath = join(scratch, 'snapshot.zip');
    checkpoint(options.signal);
    const decrypted = await decryptFile(
      join(outer.value.root, ...MIGRATION_CIPHERTEXT_PATH.split('/')),
      archivePath,
      options.identity,
      {
        maxPlaintextBytes: limits.migrationExtractedBytes,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    await rm(outer.value.root, { recursive: true, force: true });
    if (!decrypted.ok) refuse(decrypted.errors[0]!);
    if (
      decrypted.value.ciphertextSha256 !== cipherEntry.sha256 ||
      decrypted.value.ciphertextSize !== cipherEntry.size
    ) {
      refuse(
        bundleError('RAY_DIGEST_MISMATCH', 'the ciphertext changed after it was read', {
          reason: 'ciphertext-sha256',
        }),
      );
    }

    // 3. The inner snapshot archive.
    checkpoint(options.signal);
    const inner = await inspectSnapshotArchive(archivePath, { limits });
    if (!inner.ok) refuse(inner.errors[0]!);
    const { snapshot, objectIndex, entries } = inner.value;

    // 4. The embedded application, through the full reader pipeline for this runtime.
    const appEntry = entries.find((e) => e.path === SNAPSHOT_PATHS.application)!;
    const applicationPath = join(scratch, 'application.ray');
    await copyRange(archivePath, appEntry, applicationPath);
    const app = await readApplicationBundle(applicationPath, {
      operation: 'deploy',
      expectedSha256: snapshot.applicationDigest,
    });
    if (!app.ok) refuse(app.errors[0]!);
    const appManifest = app.value.manifest;

    // 5. The clear hints against the authenticated metadata, and the runtime.
    if (
      manifest.application.id !== snapshot.applicationId ||
      manifest.application.version !== snapshot.applicationVersion ||
      appManifest.application.id !== snapshot.applicationId ||
      appManifest.application.version !== snapshot.applicationVersion
    ) {
      refuse(innerMetadata('application'));
    }
    if (
      manifest.runtime.version !== snapshot.sourceRuntime ||
      appManifest.runtime.version !== snapshot.sourceRuntime
    ) {
      refuse(innerMetadata('runtime'));
    }
    if (
      manifest.target.os !== appManifest.target.os ||
      manifest.target.arch !== appManifest.target.arch ||
      manifest.target.nodeMajor !== appManifest.target.nodeMajor
    ) {
      refuse(innerMetadata('target'));
    }
    if (snapshot.sourceRuntime !== runtimeVersion()) {
      refuse(
        bundleError(
          'RAY_RUNTIME_UNSUPPORTED',
          `the snapshot was taken by runtime ${snapshot.sourceRuntime}; import it with exactly that ` +
            `runtime (this is ${runtimeVersion()}), and upgrade only after the import`,
        ),
      );
    }

    // The identity policy this runtime carries out: sessions, keys, invites and OIDC artifacts never
    // leave the source, and password hashes stay. A snapshot asking for password hashes to be reset
    // needs an identity adapter this runtime does not have; it is refused, never half applied.
    if (snapshot.identityPolicy.passwordHashes !== 'preserved') {
      refuse(
        bundleError(
          'RAY_POLICY_DENIED',
          'the snapshot asks for every password hash to be reset, and this runtime keeps them; ' +
            'export with password hashes preserved',
          { reason: 'posture-refused', path: '/identityPolicy/passwordHashes' },
        ),
      );
    }

    // 6. The object index as paths.
    checkObjectKeys(objectIndex);

    return {
      ok: true,
      value: {
        scratchDir: scratch,
        bundleSha256: outer.value.archiveSha256,
        manifest,
        ciphertextSha256: cipherEntry.sha256,
        ciphertextSize: cipherEntry.size,
        archivePath,
        archiveSha256: inner.value.archiveSha256,
        snapshot,
        objectIndex,
        entries,
        application: {
          path: applicationPath,
          sha256: snapshot.applicationDigest,
          manifest: appManifest,
          productTables: declaredStoresOf(app.value.spec)
            .stores.map((s) => s.name)
            .sort(compareCodePoints),
        },
        warnings: app.value.warnings.filter((w) => w.code !== 'RAY_W_UNSIGNED'),
      },
    };
  } catch (err) {
    if (scratch !== undefined) await rm(scratch, { recursive: true, force: true }).catch(() => {});
    if (err instanceof OpenRefusal) {
      return { ok: false, errors: [{ ...err.error, message: redactText(err.error.message) }] };
    }
    if (err instanceof EncryptionAborted) {
      return {
        ok: false,
        interrupted: true,
        errors: [
          bundleError(
            'RAY_INTERRUPTED',
            'interrupted while the bundle was decrypted; nothing was restored and nothing was kept',
          ),
        ],
      };
    }
    return {
      ok: false,
      errors: [
        bundleError(
          'RAY_INFRA_UNAVAILABLE',
          'the scratch directory could not be written while the bundle was opened; check its disk ' +
            'and retry',
        ),
      ],
    };
  }
}

/** Copy one stored entry of the inner archive into a new private file. */
async function copyRange(
  archive: string,
  entry: SnapshotEntryLocation,
  out: string,
): Promise<void> {
  const source = await open(archive, 'r');
  try {
    const target = await open(out, 'wx', 0o600);
    try {
      const buffer = Buffer.alloc(1024 * 1024);
      for (let at = 0; at < entry.size; ) {
        const { bytesRead } = await source.read(
          buffer,
          0,
          Math.min(buffer.length, entry.size - at),
          entry.dataOffset + at,
        );
        if (bytesRead === 0) throw new Error('the archive ended inside an entry');
        await target.write(buffer.subarray(0, bytesRead));
        at += bytesRead;
      }
      await target.sync();
    } finally {
      await target.close();
    }
  } finally {
    await source.close();
  }
}

/** The tables of the application database whose rows the snapshot excludes. */
function rowsExcluded(snapshot: Snapshot): Set<string> {
  const excluded = new Set<string>(snapshot.excludedDataCategories);
  return new Set(
    PLATFORM_TABLES.filter((p) => excluded.has(p.category)).map((p) => `${p.schema}.${p.table}`),
  );
}

export interface PlanDumpsOptions {
  opened: OpenedMigration;
  /** The `pg_restore` that lists each dump's table of contents for the comparison. */
  pgRestore: PgDumpTool;
}

/**
 * Read, compare and judge each dump of an opened snapshot. Returns the dumps with their restore plans
 * (the workflow system database's first when the snapshot carries it), or the first refusal.
 */
export async function planDumps(
  options: PlanDumpsOptions,
): Promise<{ ok: true; value: ImportDump[] } | { ok: false; errors: BundleError[] }> {
  const { opened } = options;
  const handle = await open(opened.archivePath, 'r');
  try {
    const dumps: ImportDump[] = [];
    const wanted: [DumpDatabase, string][] = [
      ...(opened.snapshot.workflowSystemDatabase === 'included'
        ? [['workflow-system', SNAPSHOT_PATHS.workflowSystem] as [DumpDatabase, string]]
        : []),
      ['application', SNAPSHOT_PATHS.database],
    ];
    for (const [database, path] of wanted) {
      const location = opened.entries.find((e) => e.path === path);
      if (location === undefined) {
        return { ok: false, errors: [innerMetadata('inventory')] };
      }
      const read = async (position: number, length: number): Promise<Buffer> => {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, location.dataOffset + position);
        return buffer.subarray(0, bytesRead);
      };
      let toc: DumpToc;
      try {
        toc = await readDumpToc(read, location.size);
      } catch (err) {
        if (!(err instanceof DumpArchiveError)) throw err;
        return {
          ok: false,
          errors: [
            bundleError(
              'RAY_POLICY_DENIED',
              `the ${database === 'application' ? 'application' : 'workflow system'} database ` +
                `dump cannot be inspected: ${err.message}; nothing was restored`,
              { reason: 'privileged-statement' },
            ),
          ],
        };
      }
      // The dump is the server major the snapshot states.
      const major = /^([0-9]+)/.exec(toc.header.serverVersion ?? '')?.[1];
      if (major === undefined || Number(major) !== opened.snapshot.databaseMajor) {
        return { ok: false, errors: [innerMetadata('database major')] };
      }
      // pg_restore must read the same table of contents from the same bytes.
      const source: DumpSource = { handle, offset: location.dataOffset, size: location.size };
      let listed: Awaited<ReturnType<typeof listDump>>;
      try {
        listed = await listDump(options.pgRestore, source);
      } catch (err) {
        if (!(err instanceof PgDumpError)) throw err;
        return {
          ok: false,
          errors: [
            bundleError(
              'RAY_POLICY_DENIED',
              `pg_restore cannot list the ${database === 'application' ? 'application' : 'workflow system'} ` +
                'database dump; nothing was restored',
              { reason: 'privileged-statement' },
            ),
          ],
        };
      }
      if (listed.sourceSha256 !== location.sha256) {
        return {
          ok: false,
          errors: [
            bundleError('RAY_DIGEST_MISMATCH', 'a dump changed after the snapshot was read', {
              reason: 'entry-sha256',
            }),
          ],
        };
      }
      const mine = tocListing(toc.entries);
      if (mine.length !== listed.lines.length || mine.some((line, i) => line !== listed.lines[i])) {
        return {
          ok: false,
          errors: [
            bundleError(
              'RAY_POLICY_DENIED',
              `the ${database === 'application' ? 'application' : 'workflow system'} database ` +
                "dump's table of contents reads differently to pg_restore than to the import; " +
                'nothing was restored',
              { reason: 'privileged-statement' },
            ),
          ],
        };
      }
      const planned = planDumpRestore({
        database,
        toc,
        tables: opened.snapshot.tableCounts.filter((t) => t.database === database),
        rowsExcluded:
          database === 'application' ? rowsExcluded(opened.snapshot) : new Set<string>(),
      });
      if (!planned.ok) return planned;
      if (database === 'application') {
        // Every application table is a platform table or a product store of the embedded spec.
        const platform = new Set(PLATFORM_TABLES.map((p) => `${p.schema}.${p.table}`));
        const product = new Set(opened.application.productTables.map((t) => `public.${t}`));
        const unknown = planned.value.restore.filter(
          (e) =>
            e.desc === 'TABLE' &&
            !platform.has(`${e.namespace}.${e.tag}`) &&
            !product.has(`${e.namespace}.${e.tag}`),
        );
        if (unknown.length > 0) return { ok: false, errors: [innerMetadata('application')] };
      }
      dumps.push({ database, location, toc, plan: planned.value });
    }
    return { ok: true, value: dumps };
  } finally {
    await handle.close();
  }
}
