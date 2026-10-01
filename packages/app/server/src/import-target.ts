/**
 * THE TARGET OF AN IMPORT — what an import checks on the target before it restores, the restore
 * itself, the verification after it, the fence that keeps the target from serving until the cutover,
 * and the explicit discard of a target an import left half done.
 *
 * WHO RESTORES. Everything here runs as the target's migration role (`RAYSPEC_MIGRATION_DATABASE_URL`),
 * never as a superuser: a role that is one, or may create roles, is refused (`RAY_POLICY_DENIED`
 * `posture-refused`). `pg_restore` connects as that role too. The roles of the target are prepared by
 * the database roles setup (`database-roles.sql`) before the import, so the migration role's default
 * privileges give the runtime and snapshot roles their grants on every object it restores.
 *
 * THE CHECKS (`inspectImportTarget`), read-only:
 *  - the migration role is not privileged, may create in its database and schema `public`, and its
 *    default privileges grant the runtime role (the role `DATABASE_URL` names) its table writes;
 *  - the server's major is the snapshot's (`RAY_TARGET_UNSUPPORTED`): an import never upgrades;
 *  - both databases are empty — no table, sequence, view, function, type, schema besides `public`,
 *    extension besides `plpgsql` or large object — and the blob root is empty or absent
 *    (`RAY_TARGET_NOT_EMPTY`): nothing is merged, nothing overwritten;
 *  - the workflow system database exists when the snapshot carries one (the migration role cannot
 *    create a database);
 *  - a `pg_restore` of the server's major is at hand.
 *
 * THE RESTORE (`restoreImport`), under the shared schema advisory lock held on the application
 * database for its whole course:
 *  1. each dump, workflow system database first, with `pg_restore` in one transaction, restoring only
 *     the entries the allowlist approved (`dump-policy.ts`), with no owner, privilege, comment or
 *     tablespace from the dump; the bytes streamed must hash to the inventory's digest;
 *  2. the one organization: a dump that restores another number of organizations is refused
 *     (`RAY_MULTI_TENANT_UNSUPPORTED`) and the restore is discarded at once;
 *  3. the objects: each stored blob file written unchanged under `<blob root>/<tenant>/<key>`
 *     (directories 0700, files 0600, never over anything, never through a link);
 *  4. the posture of the runtime role: row security enabled and forced on every tenant table, the
 *     migration ledgers closed to it (`applyTenantIsolation`), checked with `verifyTenantIsolation`;
 *  5. the verification: the tables and their row counts are exactly the snapshot's, every foreign key
 *     is there and validated (reference integrity), the schema head is the snapshot's, exactly one
 *     organization owns every tenant row and object, the credential tables are empty (sessions, API
 *     keys, invites, OIDC artifacts and owner-recovery tokens are reset), and every restored blob file, read back, has the
 *     index's size, header and both digests;
 *  6. the identity policy (`import-identity.ts`): each account's carried identity recorded in the
 *     target's security audit, and who signs in again, who needs owner recovery and who has no way
 *     in reported;
 *  7. the runtime-control state of the target: its own deployment id and a fence taken at once, with
 *     the runtime role's writes revoked, so no runtime serves the target until the cutover releases
 *     the fence.
 * A failure from step 1 on leaves the target marked failed (the caller's receipts and `import.json`)
 * for an explicit discard; only the multi-tenant refusal discards by itself, as the contract asks.
 *
 * THE DISCARD (`discardImportTarget`) drops every object the migration role owns in both target
 * databases (schemas, tables, sequences, functions, types, extensions) and empties the blob root,
 * then checks the target is empty again. It touches nothing it does not own.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { type FileHandle, lstat, mkdir, open, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  type BundleError,
  bundleError,
  CONTRACT_VERSION,
  formatTimestamp,
  type ObjectIndex,
  RUNTIME_CONTROL_TABLES,
  SNAPSHOT_PATHS,
  type Snapshot,
} from '@rayspec/bundle-contract';
import {
  applyTenantIsolation,
  type Db,
  listTenantTables,
  MIGRATION_ONLY_TABLES,
  makeDb,
  verifyTenantIsolation,
} from '@rayspec/db';
import { BlobInventoryError, listFsBlobs } from '@rayspec/platform';
import { quiesceOperation } from './fence-operations.js';
import { applyIdentityPolicy, type IdentityReport } from './import-identity.js';
import { ensureRuntimeControlState } from './operation-lease.js';
import { PgDumpError, type PgDumpTool, pgToolMajor, resolvePgTool } from './pg-dump.js';
import { PgRestoreAborted, restoreDump } from './pg-restore.js';
import { ledgerDrift, readProductLedger } from './product-ledger.js';
import { readProductTables, readSchemaHead } from './schema-head.js';
import { SchemaLockTimeoutError, withSchemaLock } from './schema-lock.js';
import type { ImportDump, OpenedMigration } from './snapshot-import.js';
import { queryOf, readUserTables } from './snapshot-source.js';
import { openControlDatabase } from './write-barrier.js';

/** Where and as whom an import restores. */
export interface ImportTargetConfig {
  /** The target's application database, as the migration role. */
  migrationDatabaseUrl: string;
  /** The target's workflow system database, as the migration role. */
  migrationWorkflowSystemDatabaseUrl: string;
  /** The role the target's runtime connects as (the user of `DATABASE_URL`). */
  runtimeRole: string;
  /** The fs blob root of the target, or null when it keeps none. */
  blobRoot: string | null;
  /** The `pg_restore` to run (an absolute path or a tool); default the first on `PATH`. */
  pgRestore?: string | PgDumpTool;
}

/** What the checks established about a target that has no blocker. */
export interface ImportTargetFacts {
  serverMajor: number;
  migrationRole: string;
  workflowSystemDatabase: 'present' | 'absent';
  workflowSystemDatabaseName: string;
  pgRestore: PgDumpTool;
}

export interface ImportTargetInspection {
  /** Every finding that stops an import, first one first. */
  blockers: BundleError[];
  facts: ImportTargetFacts | null;
}

function databaseNameOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

/** The runtime-control tables, which hold the target's own state once the restore created them. */
const RUNTIME_CONTROL_TABLE_NAMES: ReadonlySet<string> = new Set(
  RUNTIME_CONTROL_TABLES.map((t) => t.table),
);

/** Everything in a database an import would merge with; all zero in an empty one. */
async function databaseContents(db: Db): Promise<Record<string, number>> {
  const user = `n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'`;
  const [row] = (await db.$client.unsafe(
    `SELECT
       (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE ${user}) AS relations,
       (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE ${user}) AS functions,
       (SELECT count(*)::int FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
         WHERE ${user}) AS types,
       (SELECT count(*)::int FROM pg_namespace n WHERE ${user} AND n.nspname <> 'public') AS schemas,
       (SELECT count(*)::int FROM pg_extension WHERE extname <> 'plpgsql') AS extensions,
       (SELECT count(*)::int FROM pg_largeobject_metadata) AS large_objects`,
  )) as unknown as Record<string, number>[];
  return row ?? {};
}

function isEmpty(contents: Record<string, number>): boolean {
  return Object.values(contents).every((n) => n === 0);
}

/** The blob root as an import finds it. */
async function blobRootState(
  root: string,
): Promise<'absent' | 'empty' | 'not-empty' | 'not-a-directory'> {
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(root);
  } catch {
    return 'absent';
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return 'not-a-directory';
  return (await readdir(root)).length === 0 ? 'empty' : 'not-empty';
}

/**
 * Check the target of an import, read-only. `control` is a connection to the target's application
 * database as its migration role. Every finding is a blocker; a database that cannot be reached is
 * `RAY_INFRA_UNAVAILABLE`.
 */
export async function inspectImportTarget(
  control: Db,
  config: ImportTargetConfig,
  snapshot: Snapshot,
): Promise<ImportTargetInspection> {
  const blockers: BundleError[] = [];
  const sysName = databaseNameOf(config.migrationWorkflowSystemDatabaseUrl);
  let sys: Db | null = null;
  try {
    const query = queryOf(control);
    const [role] = await query(
      `SELECT current_user::text AS name, r.rolsuper, r.rolcreaterole,
              has_database_privilege(current_database(), 'CREATE') AS create_db,
              has_schema_privilege('public', 'CREATE') AS create_public,
              current_setting('server_version_num')::int / 10000 AS major
         FROM pg_roles r WHERE r.rolname = current_user`,
    );
    const migrationRole = String(role?.name ?? '');
    if (role?.rolsuper === true || role?.rolcreaterole === true) {
      blockers.push(
        bundleError(
          'RAY_POLICY_DENIED',
          'the import connects as a role that is a superuser or may create roles; restore as the ' +
            "target's dedicated migration role (RAYSPEC_MIGRATION_DATABASE_URL), which the database " +
            'roles setup creates without either',
          { reason: 'posture-refused' },
        ),
      );
    }
    if (migrationRole === config.runtimeRole) {
      blockers.push(
        bundleError(
          'RAY_USAGE',
          'DATABASE_URL and RAYSPEC_MIGRATION_DATABASE_URL name the same role; an import restores as ' +
            'the migration role and hands the runtime role its grants',
        ),
      );
    }
    if (role?.create_db !== true || role?.create_public !== true) {
      blockers.push(
        bundleError(
          'RAY_USAGE',
          "the migration role may not create in the target's application database or its public " +
            'schema; prepare the target with the database roles setup first',
        ),
      );
    }
    const serverMajor = Number(role?.major ?? 0);
    if (serverMajor !== snapshot.databaseMajor) {
      blockers.push(
        bundleError(
          'RAY_TARGET_UNSUPPORTED',
          `the target's database server is major ${serverMajor} and the snapshot was taken on major ` +
            `${snapshot.databaseMajor}; import into a server of the same major and upgrade afterwards`,
        ),
      );
    }
    const [runtime] = await query(
      `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS present,
              EXISTS (SELECT 1 FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
                       WHERE d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = current_user)
                         AND d.defaclobjtype = 'r' AND a.privilege_type = 'INSERT'
                         AND a.grantee = (SELECT oid FROM pg_roles WHERE rolname = $1)) AS writes`,
      [config.runtimeRole],
    );
    if (runtime?.present !== true || runtime?.writes !== true) {
      blockers.push(
        bundleError(
          'RAY_USAGE',
          "the target's runtime role does not exist, or the migration role's default privileges do " +
            'not grant it its writes; prepare the target with the database roles setup first',
        ),
      );
    }

    const contents = await databaseContents(control);
    if (!isEmpty(contents)) {
      blockers.push(
        bundleError(
          'RAY_TARGET_NOT_EMPTY',
          "the target's application database is not empty (it holds tables, functions, schemas, " +
            'extensions or large objects); an import restores into a new, empty database only',
        ),
      );
    }
    const [sysRow] = await query(
      'SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS present',
      [sysName],
    );
    const sysPresent = sysRow?.present === true;
    if (sysPresent) {
      sys = makeDb(config.migrationWorkflowSystemDatabaseUrl, 1, {
        applicationName: 'rayspec-import',
      });
      if (!isEmpty(await databaseContents(sys))) {
        blockers.push(
          bundleError(
            'RAY_TARGET_NOT_EMPTY',
            "the target's workflow system database is not empty; an import restores into a new, " +
              'empty database only',
          ),
        );
      }
    } else if (snapshot.workflowSystemDatabase === 'included') {
      blockers.push(
        bundleError(
          'RAY_USAGE',
          "the snapshot carries a workflow system database and the target's does not exist; create " +
            'it and prepare it with the database roles setup (database kind workflow-system) first',
        ),
      );
    }

    if (config.blobRoot === null) {
      if (snapshot.objectCount > 0) {
        blockers.push(
          bundleError(
            'RAY_USAGE',
            'the snapshot carries objects and RAYSPEC_BLOB_ROOT is not set: name the empty blob root ' +
              'the target will serve from',
          ),
        );
      }
    } else {
      const state = await blobRootState(config.blobRoot);
      if (state === 'not-empty') {
        blockers.push(
          bundleError(
            'RAY_TARGET_NOT_EMPTY',
            "the target's blob root is not empty; an import restores into an empty blob root only",
          ),
        );
      } else if (state === 'not-a-directory') {
        blockers.push(
          bundleError('RAY_USAGE', 'RAYSPEC_BLOB_ROOT is not a directory (or is a link)'),
        );
      } else if (
        state === 'absent' &&
        (await blobRootState(dirname(config.blobRoot))) === 'absent'
      ) {
        blockers.push(
          bundleError('RAY_USAGE', 'the parent directory of RAYSPEC_BLOB_ROOT does not exist'),
        );
      }
    }

    const tool = await resolvePgTool('pg_restore', config.pgRestore);
    let pgRestore: PgDumpTool | null = null;
    if (tool === null) {
      blockers.push(
        bundleError(
          'RAY_USAGE',
          'no pg_restore was found: install the PostgreSQL client tools of the server major, or name ' +
            'pg_restore by its absolute path (RAYSPEC_PG_RESTORE)',
        ),
      );
    } else {
      const major = await pgToolMajor(tool, 'pg_restore').catch(() => null);
      if (major !== serverMajor) {
        blockers.push(
          bundleError(
            'RAY_USAGE',
            `the pg_restore found is ${major === null ? 'not runnable' : `major ${major}`}, and the ` +
              `target's server is major ${serverMajor}: name a pg_restore of that major`,
          ),
        );
      } else pgRestore = tool;
    }

    if (blockers.length > 0 || pgRestore === null) return { blockers, facts: null };
    return {
      blockers,
      facts: {
        serverMajor,
        migrationRole,
        workflowSystemDatabase: sysPresent ? 'present' : 'absent',
        workflowSystemDatabaseName: sysName,
        pgRestore,
      },
    };
  } catch {
    return {
      blockers: [
        ...blockers,
        bundleError(
          'RAY_INFRA_UNAVAILABLE',
          "the target's databases could not be read; check that they are reachable and retry",
        ),
      ],
      facts: null,
    };
  } finally {
    await sys?.$client.end().catch(() => {});
  }
}

// ─── the restore ───────────────────────────────────────────────────────────────────────────────

/** The verification an import reports: every part matched, or the import was refused. */
export interface ImportVerification {
  checksums: 'match';
  tableCounts: 'match';
  objects: 'match';
  referenceIntegrity: 'match';
}

export interface RestoredImport {
  verification: ImportVerification;
  tenantId: string;
  foreignKeys: number;
  /** The target's fence, taken by the import: the cutover releases it. */
  targetFenceEpoch: number;
  targetEnvironmentRevision: number;
  credentialReset: {
    sessions: 'reset';
    apiKeys: 'reset';
    invites: 'reset';
    oidcArtifacts: 'reset';
    passwordHashes: 'preserved' | 'reset';
    forcedLogin: boolean;
  };
  /** Who signs in again, who needs owner recovery, who has no way in. */
  identity: IdentityReport;
}

export interface RestoreImportOptions {
  opened: OpenedMigration;
  dumps: readonly ImportDump[];
  config: ImportTargetConfig;
  facts: ImportTargetFacts;
  /** The target's application database as the migration role (a control connection). */
  control: Db;
  /** The deployment id the import minted for the target. */
  deploymentId: string;
  operationId: string;
  actor: string;
  /** The migration bundle's digest, recorded with the identity the import carried. */
  migrationBundleSha256: string;
  /** A private directory for the restore lists. */
  workDir: string;
  /** Called when verification starts. */
  onVerifying?: () => Promise<void>;
  /** Stops at the next safe point; a running `pg_restore` is ended and rolls back. */
  signal?: AbortSignal;
  lockTimeoutMs?: number;
}

export type RestoreImportResult =
  | { ok: true; value: RestoredImport }
  | {
      ok: false;
      errors: BundleError[];
      /** Whether anything of the target changed: it then needs an explicit discard. */
      targetChanged: boolean;
      interrupted?: true;
    };

class RestoreRefusal extends Error {
  constructor(
    readonly error: BundleError,
    readonly discarded = false,
  ) {
    super(error.message);
  }
}

class RestoreInterrupted extends Error {}

function checkpoint(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new RestoreInterrupted();
}

function verificationFailed(
  what: string,
  reason?: 'object-sha256' | 'schema-head' | 'entry-sha256',
): RestoreRefusal {
  return new RestoreRefusal(
    reason === undefined
      ? bundleError(
          'RAY_RECONCILIATION_REQUIRED',
          `the restored target does not verify: ${what}. The target is marked failed and the ` +
            'source stays authoritative',
        )
      : bundleError('RAY_DIGEST_MISMATCH', `the restored target does not verify: ${what}`, {
          reason,
        }),
  );
}

/** The tenant tables of the application database and how many rows of another tenant each holds. */
async function rowsOfOtherTenants(db: Db, tenantId: string): Promise<number> {
  let total = 0;
  for (const t of await listTenantTables(db.$client, ['public'])) {
    const [row] = (await db.$client.unsafe(
      `SELECT count(*)::int AS n FROM "${t.schema.replaceAll('"', '""')}"."${t.table.replaceAll('"', '""')}"
        WHERE tenant_id IS DISTINCT FROM $1::uuid`,
      [tenantId],
    )) as unknown as { n: number }[];
    total += row?.n ?? 0;
  }
  return total;
}

/** Write every stored blob file of the snapshot under the blob root, unchanged. */
async function restoreObjects(
  root: string,
  archive: FileHandle,
  objectsOffset: number,
  index: ObjectIndex,
  signal: AbortSignal | undefined,
): Promise<void> {
  const ensureDirectory = async (path: string): Promise<void> => {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw verificationFailed('a directory of the blob root is not a directory');
    }
  };
  await ensureDirectory(root);
  const buffer = Buffer.alloc(1024 * 1024);
  for (const object of index.objects) {
    checkpoint(signal);
    const segments = object.key.split('/');
    let dir = join(root, object.tenantId);
    await ensureDirectory(dir);
    for (const segment of segments.slice(0, -1)) {
      dir = join(dir, segment);
      await ensureDirectory(dir);
    }
    const file = await open(
      join(dir, segments.at(-1)!),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      for (let at = 0; at < object.storedSize; ) {
        const length = Math.min(buffer.length, object.storedSize - at);
        const { bytesRead } = await archive.read(
          buffer,
          0,
          length,
          objectsOffset + object.storedOffset + at,
        );
        if (bytesRead === 0) throw new Error('the archive ended inside an object');
        await file.write(buffer.subarray(0, bytesRead));
        at += bytesRead;
      }
      await file.sync();
    } finally {
      await file.close();
    }
  }
}

/** Read every restored blob file back: the walk, sizes, headers and both digests against the index. */
async function verifyObjects(root: string, index: ObjectIndex): Promise<void> {
  if (index.objects.length === 0 && (await blobRootState(root)) !== 'not-empty') return;
  let listed: Awaited<ReturnType<typeof listFsBlobs>>;
  try {
    listed = await listFsBlobs(root, { phase: 'quiesced' });
  } catch (err) {
    if (err instanceof BlobInventoryError) {
      throw verificationFailed('the blob root does not read back as a blob store', 'object-sha256');
    }
    throw err;
  }
  if (listed.objects.length !== index.objects.length) {
    throw verificationFailed(
      'the blob root holds another number of objects than the index',
      'object-sha256',
    );
  }
  const buffer = Buffer.alloc(1024 * 1024);
  for (const [i, o] of index.objects.entries()) {
    const found = listed.objects[i]!;
    if (
      found.tenantId !== o.tenantId ||
      found.key !== o.key ||
      found.size !== o.size ||
      found.sha256 !== o.sha256 ||
      found.storedSize !== o.storedSize ||
      found.contentType !== o.contentType
    ) {
      throw verificationFailed(
        'a restored object is not the one the index states',
        'object-sha256',
      );
    }
    const handle = await open(found.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stored = createHash('sha256');
    const logical = createHash('sha256');
    try {
      for (let at = 0; ; ) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, at);
        if (bytesRead === 0) break;
        const chunk = buffer.subarray(0, bytesRead);
        stored.update(chunk);
        if (at + bytesRead > found.dataStart)
          logical.update(chunk.subarray(Math.max(0, found.dataStart - at)));
        at += bytesRead;
      }
    } finally {
      await handle.close();
    }
    if (stored.digest('hex') !== o.storedSha256 || logical.digest('hex') !== o.sha256) {
      throw verificationFailed('a restored object does not hash to the index', 'object-sha256');
    }
  }
}

/**
 * Tables of the connected database the runtime role cannot use as a runtime needs to: read every
 * table and the schema it is in, and write every table but the migration ledgers — in the
 * application database those of schema `public`, in the workflow system database all of them. The
 * database roles setup grants exactly this through the migration role's default privileges.
 */
async function tablesWithoutRuntimeGrants(
  db: Db,
  runtimeRole: string,
  database: 'application' | 'workflow-system',
): Promise<number> {
  const [row] = (await db.$client.unsafe(
    `SELECT count(*)::int AS n
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p')
        AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
        AND NOT (has_schema_privilege($1, n.oid, 'USAGE') AND has_table_privilege($1, c.oid, 'SELECT')
                 AND (CASE WHEN $2 = 'application'
                                AND (n.nspname <> 'public' OR c.relname = ANY($3::text[]))
                           THEN true
                           ELSE has_table_privilege($1, c.oid, 'INSERT')
                                AND has_table_privilege($1, c.oid, 'UPDATE')
                                AND has_table_privilege($1, c.oid, 'DELETE') END))`,
    [
      runtimeRole,
      database,
      MIGRATION_ONLY_TABLES.filter((t) => t.schema === 'public').map((t) => t.table),
    ],
  )) as unknown as { n: number }[];
  return row?.n ?? 0;
}

/**
 * Restore an opened snapshot into a checked target, verify it and fence it. Returns what was restored
 * or the refusal, saying whether the target changed (and so needs an explicit discard).
 */
export async function restoreImport(options: RestoreImportOptions): Promise<RestoreImportResult> {
  const { opened, config, facts, control } = options;
  let changed = false;
  let sys: Db | null = null;
  const archive = await open(opened.archivePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const restored = await withSchemaLock(
      control,
      async () => {
        // 1. The dumps.
        let foreignKeys = 0;
        for (const dump of options.dumps) {
          checkpoint(options.signal);
          const listFile = join(options.workDir, `${dump.database}.list`);
          await writeFile(listFile, dump.plan.useList, { mode: 0o600, flag: 'wx' });
          const url =
            dump.database === 'application'
              ? config.migrationDatabaseUrl
              : config.migrationWorkflowSystemDatabaseUrl;
          changed = true;
          const { sourceSha256 } = await restoreDump(
            facts.pgRestore,
            url,
            listFile,
            { handle: archive, offset: dump.location.dataOffset, size: dump.location.size },
            options.signal,
          );
          if (sourceSha256 !== dump.location.sha256) {
            throw verificationFailed('a dump changed while it was restored', 'entry-sha256');
          }
          foreignKeys += dump.plan.foreignKeys;
          if (dump.database === 'application') {
            // The target's own runtime-control state, at once: its deployment id is how a discard
            // knows the database is the one this import changed.
            await control.$client.begin(async (tx) => {
              await ensureRuntimeControlState(tx);
              await tx.unsafe(
                'UPDATE runtime_control_state SET deployment_id = $1, updated_at = now() WHERE id = 1',
                [options.deploymentId],
              );
            });
          }
        }

        // 2. Exactly one organization, whatever snapshot.json says.
        const query = queryOf(control);
        const orgs = await query('SELECT id::text AS id FROM orgs ORDER BY id');
        if (orgs.length !== 1) {
          await discardDatabases(control, config.migrationWorkflowSystemDatabaseUrl);
          changed = false;
          throw new RestoreRefusal(
            bundleError(
              'RAY_MULTI_TENANT_UNSUPPORTED',
              `the dump restores ${orgs.length} organizations and an import carries exactly one; ` +
                'the restore was discarded',
            ),
            true,
          );
        }
        const tenantId = String(orgs[0]!.id);
        if (opened.objectIndex.objects.some((o) => o.tenantId !== tenantId)) {
          throw new RestoreRefusal(
            bundleError(
              'RAY_MULTI_TENANT_UNSUPPORTED',
              'the snapshot holds objects of a tenant that is not its organization',
            ),
          );
        }

        // 3. The objects.
        if (config.blobRoot !== null && opened.objectIndex.objects.length > 0) {
          const objects = opened.entries.find((e) => e.path === SNAPSHOT_PATHS.objects)!;
          await restoreObjects(
            config.blobRoot,
            archive,
            objects.dataOffset,
            opened.objectIndex,
            options.signal,
          );
        }
        checkpoint(options.signal);
        await options.onVerifying?.();

        // 4. The runtime role's posture.
        await control.$client.begin(async (tx) => {
          await applyTenantIsolation(tx, { runtimeRole: config.runtimeRole });
        });
        const posture = await verifyTenantIsolation(control.$client, { role: config.runtimeRole });
        if (!posture.active) {
          throw new RestoreRefusal(
            bundleError(
              'RAY_POLICY_DENIED',
              `the runtime role does not hold the isolated posture on the restored target: ${posture.findings
                .map((f) => f.check)
                .join(', ')}`,
              { reason: 'posture-refused' },
            ),
          );
        }

        // 5. The verification.
        sys =
          opened.snapshot.workflowSystemDatabase === 'included'
            ? makeDb(config.migrationWorkflowSystemDatabaseUrl, 1, {
                applicationName: 'rayspec-import',
              })
            : null;
        for (const [database, db] of [
          ['application', control],
          ['workflow-system', sys],
        ] as const) {
          if (
            db !== null &&
            (await tablesWithoutRuntimeGrants(db, config.runtimeRole, database)) > 0
          ) {
            throw new RestoreRefusal(
              bundleError(
                'RAY_POLICY_DENIED',
                `the runtime role lacks its grants on restored tables of the ${database} database: ` +
                  'prepare the target with the database roles setup (the workflow system database ' +
                  'with database kind workflow-system)',
                { reason: 'posture-refused' },
              ),
            );
          }
        }
        for (const [database, db] of [
          ['application', control],
          ['workflow-system', sys],
        ] as const) {
          if (db === null) continue;
          const expected = opened.snapshot.tableCounts.filter((t) => t.database === database);
          const live = await readUserTables(queryOf(db));
          const key = (t: { schema: string; table: string }) => `${t.schema}.${t.table}`;
          if (
            live.length !== expected.length ||
            live.some((t) => !expected.some((e) => key(e) === key(t)))
          ) {
            throw verificationFailed(
              `the ${database} database holds other tables than the snapshot`,
            );
          }
          for (const t of expected) {
            // The runtime-control tables are the target's own from the restore on; the allowlist
            // let no row of the source's into them.
            if (database === 'application' && RUNTIME_CONTROL_TABLE_NAMES.has(t.table)) continue;
            const [row] = (await db.$client.unsafe(
              `SELECT count(*)::text AS n FROM "${t.schema}"."${t.table}"`,
            )) as unknown as { n: string }[];
            if (Number(row?.n) !== t.rows) {
              throw verificationFailed(
                `${t.schema}.${t.table} of the ${database} database holds ${row?.n} rows, not the ` +
                  `${t.rows} the snapshot counts`,
              );
            }
          }
          const [fk] = (await db.$client.unsafe(
            `SELECT count(*)::int AS n, count(*) FILTER (WHERE NOT c.convalidated)::int AS invalid
               FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
              WHERE c.contype = 'f' AND n.nspname NOT IN ('pg_catalog', 'information_schema')`,
          )) as unknown as { n: number; invalid: number }[];
          const planned = options.dumps.find((d) => d.database === database)?.plan.foreignKeys ?? 0;
          if (fk?.n !== planned || fk?.invalid !== 0) {
            throw verificationFailed(
              `a foreign key of the ${database} database is missing or not validated`,
            );
          }
        }
        const head = await readSchemaHead(query);
        if (
          head.state !== 'known' ||
          head.head.platform !== opened.snapshot.schemaHead.platform ||
          head.head.product !== opened.snapshot.schemaHead.product
        ) {
          throw verificationFailed("its schema head is not the snapshot's", 'schema-head');
        }
        const ledger = await readProductLedger(query);
        if (ledger.state === 'ledgered') {
          const live = await readProductTables(query);
          if (ledgerDrift(ledger.head, live) !== null) {
            throw verificationFailed(
              'its product schema is not the one its ledger records',
              'schema-head',
            );
          }
        }
        if ((await rowsOfOtherTenants(control, tenantId)) > 0) {
          throw new RestoreRefusal(
            bundleError(
              'RAY_MULTI_TENANT_UNSUPPORTED',
              'the restored tenant tables hold rows of a tenant that is not the organization',
            ),
          );
        }
        const [credentials] = await query(
          `SELECT (SELECT count(*) FROM sessions)::int + (SELECT count(*) FROM api_keys)::int +
                  (SELECT count(*) FROM invites)::int + (SELECT count(*) FROM oidc_models)::int +
                  (SELECT count(*) FROM owner_recovery_tokens)::int AS n,
                  (SELECT count(*) FROM memberships m WHERE m.org_id <> $1::uuid)::int AS foreign_members`,
          [tenantId],
        );
        if (Number(credentials?.n) !== 0) {
          throw verificationFailed(
            'the credential tables are not empty, so credentials would not be reset',
          );
        }
        if (Number(credentials?.foreign_members) !== 0) {
          throw new RestoreRefusal(
            bundleError('RAY_MULTI_TENANT_UNSUPPORTED', 'a membership names another organization'),
          );
        }
        if (config.blobRoot !== null) await verifyObjects(config.blobRoot, opened.objectIndex);

        // 6. The identity policy: the carried identity recorded, the credentials reset.
        const identity = await applyIdentityPolicy(control, {
          tenantId,
          operationId: options.operationId,
          migrationBundleSha256: options.migrationBundleSha256,
        });

        return { tenantId, foreignKeys, identity };
      },
      { timeoutMs: options.lockTimeoutMs },
    );

    // The fence: no runtime serves the target until the cutover releases it.
    const fenced = await fenceTarget(
      options,
      `import ${options.operationId}: not live until the cutover`,
    );
    if (fenced === null) {
      return {
        ok: false,
        targetChanged: true,
        errors: [
          bundleError(
            'RAY_RECONCILIATION_REQUIRED',
            'the target was restored and verified, but its fence could not be taken with the runtime ' +
              "role's writes revoked; the target is marked failed",
          ),
        ],
      };
    }
    const [revision] = (await control.$client.unsafe(
      'SELECT environment_revision::int AS revision FROM runtime_control_state WHERE id = 1',
    )) as unknown as { revision: number }[];
    const passwordHashes = opened.snapshot.identityPolicy.passwordHashes;
    return {
      ok: true,
      value: {
        verification: {
          checksums: 'match',
          tableCounts: 'match',
          objects: 'match',
          referenceIntegrity: 'match',
        },
        tenantId: restored.tenantId,
        foreignKeys: restored.foreignKeys,
        targetFenceEpoch: fenced,
        targetEnvironmentRevision: revision?.revision ?? 0,
        credentialReset: {
          sessions: 'reset',
          apiKeys: 'reset',
          invites: 'reset',
          oidcArtifacts: 'reset',
          passwordHashes,
          forcedLogin: true,
        },
        identity: restored.identity,
      },
    };
  } catch (err) {
    // A target the restore changed is fenced as failed when its control tables made it that far, so
    // no runtime serves it before it is discarded.
    const discarded = err instanceof RestoreRefusal && err.discarded;
    if (changed && !discarded) {
      await fenceTarget(options, `import ${options.operationId} failed: discard this target`).catch(
        () => null,
      );
    }
    if (err instanceof RestoreRefusal) {
      return { ok: false, errors: [err.error], targetChanged: err.discarded ? false : changed };
    }
    if (err instanceof RestoreInterrupted || err instanceof PgRestoreAborted) {
      return {
        ok: false,
        interrupted: true,
        targetChanged: changed,
        errors: [
          bundleError(
            'RAY_INTERRUPTED',
            'interrupted while the target was restored; the source stays authoritative',
          ),
        ],
      };
    }
    if (err instanceof SchemaLockTimeoutError) {
      return {
        ok: false,
        targetChanged: false,
        errors: [bundleError('RAY_LOCK_TIMEOUT', err.message)],
      };
    }
    if (err instanceof PgDumpError) {
      return {
        ok: false,
        targetChanged: changed,
        errors: [
          bundleError(
            'RAY_RECONCILIATION_REQUIRED',
            `the restore failed: ${err.message}. The target is marked failed and the source stays ` +
              'authoritative',
          ),
        ],
      };
    }
    return {
      ok: false,
      targetChanged: changed,
      errors: [
        bundleError(
          'RAY_RECONCILIATION_REQUIRED',
          "the target's databases or blob root failed during the restore; the target is marked " +
            'failed and the source stays authoritative',
        ),
      ],
    };
  } finally {
    await archive.close().catch(() => {});
    await (sys as Db | null)?.$client.end().catch(() => {});
  }
}

/**
 * Take the target's fence with the runtime role's writes revoked in both databases, as `quiesce`
 * does; returns its epoch, or null when the database barrier did not hold or the target has no
 * control tables (a restore that failed before the application database).
 */
async function fenceTarget(options: RestoreImportOptions, reason: string): Promise<number | null> {
  const { control, config, facts } = options;
  const [present] = (await control.$client.unsafe(
    "SELECT to_regclass('public.runtime_control_state') IS NOT NULL AS present",
  )) as unknown as { present: boolean }[];
  if (present?.present !== true) return null;
  const workflowSystemDb =
    facts.workflowSystemDatabase === 'present'
      ? openControlDatabase(config.migrationWorkflowSystemDatabaseUrl, 1)
      : null;
  try {
    const fenced = await quiesceOperation(
      {
        contractVersion: CONTRACT_VERSION,
        operationId: options.operationId,
        actor: options.actor,
        reason,
        deadline: formatTimestamp(new Date(Date.now() + 60_000)),
        sourceStopped: false,
      },
      options.operationId,
      {
        db: control,
        runtimeRole: config.runtimeRole,
        ...(workflowSystemDb !== null ? { workflowSystemDb } : {}),
        workflowSystemDatabaseName: facts.workflowSystemDatabaseName,
      },
    );
    const held =
      fenced.data?.barriers.find((b) => b.barrier === 'database-write-role')?.state === 'held';
    return fenced.ok && fenced.data !== null && held ? fenced.data.fenceEpoch : null;
  } finally {
    await workflowSystemDb?.$client.end().catch(() => {});
  }
}

// ─── the discard ───────────────────────────────────────────────────────────────────────────────

/** Drop every object the connected role owns in the connected database; returns how many. */
async function discardDatabase(db: Db): Promise<void> {
  const user = `n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'`;
  await db.$client.begin(async (tx) => {
    const statements = (await tx.unsafe(
      `SELECT format('DROP SCHEMA %I CASCADE', n.nspname) AS stmt, 1 AS step
         FROM pg_namespace n
        WHERE ${user} AND n.nspname <> 'public' AND n.nspowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
       UNION ALL
       SELECT format('DROP EXTENSION IF EXISTS %I CASCADE', e.extname), 2
         FROM pg_extension e
        WHERE e.extname <> 'plpgsql' AND e.extowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
       ORDER BY 2, 1`,
    )) as unknown as { stmt: string }[];
    for (const s of statements) await tx.unsafe(s.stmt);
    // Relations first (a sequence a column owns goes with its table), then what is left.
    for (const kinds of [['r', 'p', 'v', 'm', 'f'], ['S']]) {
      const relations = (await tx.unsafe(
        `SELECT format('DROP %s IF EXISTS %I.%I CASCADE',
                       CASE c.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW'
                                      WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'f' THEN 'FOREIGN TABLE'
                                      ELSE 'TABLE' END,
                       n.nspname, c.relname) AS stmt
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE ${user} AND c.relkind = ANY($1::"char"[])
            AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)`,
        [kinds],
      )) as unknown as { stmt: string }[];
      for (const r of relations) await tx.unsafe(r.stmt);
    }
    const routines = (await tx.unsafe(
      `SELECT format('DROP ROUTINE IF EXISTS %s CASCADE', p.oid::regprocedure) AS stmt
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE ${user} AND p.proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass
                           AND d.objid = p.oid AND d.deptype = 'e')`,
    )) as unknown as { stmt: string }[];
    for (const r of routines) await tx.unsafe(r.stmt);
    const types = (await tx.unsafe(
      `SELECT format('DROP TYPE IF EXISTS %I.%I CASCADE', n.nspname, t.typname) AS stmt
         FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE ${user} AND t.typowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
          AND t.typtype IN ('c', 'e', 'd', 'r', 'm') AND t.typrelid = 0`,
    )) as unknown as { stmt: string }[];
    for (const s of types) await tx.unsafe(s.stmt);
  });
}

async function discardDatabases(control: Db, workflowSystemUrl: string): Promise<void> {
  await discardDatabase(control);
  const [present] = (await control.$client.unsafe(
    'SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS present',
    [databaseNameOf(workflowSystemUrl)],
  )) as unknown as { present: boolean }[];
  if (present?.present === true) {
    const sys = makeDb(workflowSystemUrl, 1, { applicationName: 'rayspec-import' });
    try {
      await discardDatabase(sys);
    } finally {
      await sys.$client.end().catch(() => {});
    }
  }
}

/**
 * Discard what an import restored into a target: every object the migration role owns in both
 * databases, and everything in the blob root (the root itself stays). Then the target must be empty
 * again (`RAY_TARGET_NOT_EMPTY` otherwise: something the migration role does not own is in it).
 */
export async function discardImportTarget(
  control: Db,
  config: ImportTargetConfig,
  failed: { deploymentId: string },
): Promise<{ ok: true } | { ok: false; errors: BundleError[] }> {
  // Only the database this import changed: it records the import's deployment id, or it holds no
  // relation at all (the restore failed before the application database).
  try {
    const [found] = (await control.$client.unsafe(
      `SELECT to_regclass('public.runtime_control_state') IS NOT NULL AS control,
              (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
                  AND n.nspname NOT LIKE 'pg\\_%') AS relations`,
    )) as unknown as { control: boolean; relations: number }[];
    let owner: string | null = null;
    if (found?.control === true) {
      const [row] = (await control.$client.unsafe(
        'SELECT deployment_id FROM runtime_control_state WHERE id = 1',
      )) as unknown as { deployment_id: string | null }[];
      owner = row?.deployment_id ?? null;
    }
    if (owner !== failed.deploymentId && (found?.relations ?? 0) > 0) {
      return {
        ok: false,
        errors: [
          bundleError(
            'RAY_USAGE',
            'the database the environment names does not hold the failed import of this state ' +
              'directory; nothing was discarded',
          ),
        ],
      };
    }
  } catch {
    return {
      ok: false,
      errors: [
        bundleError(
          'RAY_INFRA_UNAVAILABLE',
          "the target's databases could not be read; check that they are reachable and retry",
        ),
      ],
    };
  }
  try {
    await withSchemaLock(control, async () => {
      await discardDatabases(control, config.migrationWorkflowSystemDatabaseUrl);
    });
    if (config.blobRoot !== null && (await blobRootState(config.blobRoot)) === 'not-empty') {
      for (const entry of await readdir(config.blobRoot)) {
        await rm(join(config.blobRoot, entry), { recursive: true, force: true });
      }
    }
  } catch (err) {
    if (err instanceof SchemaLockTimeoutError) {
      return { ok: false, errors: [bundleError('RAY_LOCK_TIMEOUT', err.message)] };
    }
    return {
      ok: false,
      errors: [
        bundleError(
          'RAY_INFRA_UNAVAILABLE',
          "the target's databases or blob root could not be cleared; check that they are reachable " +
            'and retry',
        ),
      ],
    };
  }
  const left = [await databaseContents(control)];
  const [present] = (await control.$client.unsafe(
    'SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS present',
    [databaseNameOf(config.migrationWorkflowSystemDatabaseUrl)],
  )) as unknown as { present: boolean }[];
  if (present?.present === true) {
    const sys = makeDb(config.migrationWorkflowSystemDatabaseUrl, 1, {
      applicationName: 'rayspec-import',
    });
    try {
      left.push(await databaseContents(sys));
    } finally {
      await sys.$client.end().catch(() => {});
    }
  }
  if (!left.every(isEmpty)) {
    return {
      ok: false,
      errors: [
        bundleError(
          'RAY_TARGET_NOT_EMPTY',
          'the target still holds objects after the discard, which its migration role does not own; ' +
            'remove them by hand',
        ),
      ],
    };
  }
  return { ok: true };
}
