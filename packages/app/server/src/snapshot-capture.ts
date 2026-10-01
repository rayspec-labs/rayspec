/**
 * CAPTURING THE SNAPSHOT — the plaintext inner snapshot archive of an export, taken under the source
 * fence. Encrypting it is the caller's next step; this module never writes outside a private scratch
 * directory.
 *
 * PRECONDITIONS, checked before anything is read for the snapshot:
 *  - the fence is held at exactly the epoch quiesce returned (`RAY_FENCE_MISMATCH` for another epoch,
 *    `RAY_SOURCE_NOT_QUIESCENT` when it was released);
 *  - the database write barrier recorded with the fence is held: the runtime role's writes revoked
 *    (`database-write-role`), or a stopped source attested and checked (`database-stopped-source`).
 *    Otherwise the capture refuses with `RAY_EXTERNAL_STATE_UNSUPPORTED`
 *    `database-barrier-unavailable` and the fence stays as it is;
 *  - object writes are fenced (every runtime process drained), else `RAY_SOURCE_NOT_QUIESCENT`;
 *  - every preflight check passes again, now under the fence;
 *  - no session other than the caller's own can write: with the role barrier, only sessions of the
 *    fenced runtime role may be connected; with the stopped source, none at all
 *    (`uncontrolled-writer`);
 *  - no run, workflow run or workflow node is still marked running: its external effect is unknown
 *    and must be reconciled first (`unreconciled-effects`).
 *
 * THE CAPTURE, in a private directory (mode 0700) under the scratch parent:
 *  1. the deployed application, rebuilt byte for byte from the active version;
 *  2. the objects: every stored blob file copied into `objects.bin` in index order, each hashed
 *     twice on the way (the stored file, and the logical bytes behind its header, which must match
 *     the header's digest and length);
 *  3. each database inside one REPEATABLE READ READ ONLY transaction that exports its snapshot: the
 *     row count of every exported table is read in it, and `pg_dump --snapshot` dumps exactly what
 *     the counts saw. Tables whose rows the policy excludes are dumped with their schema only
 *     (`--exclude-table-data`) and counted as 0, the count they restore with. The workflow system
 *     database is dumped whole whenever it exists at that moment;
 *  4. the blob root listed again and the fence read again: a changed object or a released fence
 *     means the source was not still, and the capture is refused (`RAY_SOURCE_NOT_QUIESCENT`);
 *  5. `snapshot.json` and the archive, written by the one snapshot writer and read back.
 * The reads use the read-only snapshot role when one is configured, else the single role; the result
 * says which, and which barriers held. On any refusal or failure the scratch directory is removed.
 * Every message passes the redaction path (`redactText`) before it is returned.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdtemp, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { writeSnapshotArchive } from '@rayspec/bundle';
import {
  type BundleError,
  type BundleWarning,
  bundleError,
  canonicalJsonFile,
  compareCodePoints,
  type DataCategory,
  formatTimestamp,
  MAX_SNAPSHOT_TABLE_COUNTS,
  type ObjectIndex,
  SNAPSHOT_PATHS,
  type Snapshot,
  type TableCount,
} from '@rayspec/bundle-contract';
import { redactText } from '@rayspec/core';
import { type Db, makeDb } from '@rayspec/db';
import type { FsStoredBlob } from '@rayspec/platform';
import { readBarrierRecord } from './fence-operations.js';
import { PgDumpError, type PgDumpTool, runPgDump } from './pg-dump.js';
import { runtimeVersion } from './runtime-control.js';
import {
  classifyApplicationTables,
  derivedWorkflowSystemUrl,
  excludedDataCategories,
  identityPolicy,
  listSourceBlobs,
  openWorkflowSystemDatabase,
  preflightSnapshot,
  queryOf,
  type RunHistoryPolicy,
  readUserTables,
  rebuildDeployedApplication,
  redactedError,
  type SnapshotSourceOptions,
  SourceRefusal,
} from './snapshot-source.js';
import { CONTROL_APPLICATION_PREFIX } from './write-barrier.js';

export interface CaptureSnapshotOptions extends SnapshotSourceOptions {
  /** The epoch quiesce returned; the fence must be held at it for the whole capture. */
  fenceEpoch: number;
  runHistoryPolicy: RunHistoryPolicy;
  /** Whether the target keeps password hashes (through the audited identity adapter). Default preserved. */
  passwordHashes?: 'preserved' | 'reset';
  now?: () => Date;
}

/** One barrier and what the capture found it to be. */
export interface CaptureBarrier {
  barrier: 'database-write-role' | 'database-stopped-source' | 'object-writes';
  /** `not-applied`: this form of the database barrier is not the one the fence used. */
  state: 'held' | 'unavailable' | 'not-applied';
}

/** One table whose rows the snapshot does not carry, and why. */
export interface ExcludedTable {
  schema: string;
  table: string;
  category: DataCategory;
}

export interface CapturedSnapshot {
  /** The plaintext inner snapshot archive, inside `scratchDir`. */
  archivePath: string;
  /** The private directory (mode 0700) holding it; the caller removes it once it encrypted it. */
  scratchDir: string;
  archiveSha256: string;
  archiveSize: number;
  snapshot: Snapshot;
  /** Every application table whose rows stayed at the source, by category. */
  excludedTables: ExcludedTable[];
  barriers: CaptureBarrier[];
  /** Who the dumps and counts read as. */
  reader: 'snapshot-role' | 'single-role';
  warnings: BundleWarning[];
}

export type CaptureResult =
  | { ok: true; value: CapturedSnapshot }
  | { ok: false; errors: BundleError[]; barriers: CaptureBarrier[] | null };

class CaptureRefusal extends Error {
  readonly error: BundleError;
  constructor(error: BundleError) {
    super(error.message);
    this.error = error;
  }
}

function refuse(error: BundleError): never {
  throw new CaptureRefusal(error);
}

function notQuiescent(message: string): BundleError {
  return bundleError(
    'RAY_SOURCE_NOT_QUIESCENT',
    `${message}; the source stays fenced: retry the export, or release the fence with resume`,
  );
}

interface FenceRow {
  state: string;
  epoch: number;
  barriers: unknown;
}

async function readFence(db: Db): Promise<FenceRow | null> {
  const [row] = (await db.$client.unsafe(
    `SELECT fence_state, fence_epoch::text AS fence_epoch, fence_barriers
       FROM runtime_control_state WHERE id = 1`,
  )) as unknown as { fence_state: string; fence_epoch: string; fence_barriers: unknown }[];
  if (row === undefined) return null;
  return { state: row.fence_state, epoch: Number(row.fence_epoch), barriers: row.fence_barriers };
}

function barrierReport(value: unknown): {
  barriers: CaptureBarrier[];
  databaseHeld: boolean;
  objectsHeld: boolean;
  runtimeRole: string | undefined;
  form: 'database-write-role' | 'database-stopped-source';
} {
  const record = readBarrierRecord(value);
  const form = record?.database.barrier ?? 'database-write-role';
  const databaseHeld = record?.database.state === 'held';
  const objectsHeld = record?.objects.state === 'held';
  const other = form === 'database-write-role' ? 'database-stopped-source' : 'database-write-role';
  return {
    barriers: [
      { barrier: form, state: databaseHeld ? 'held' : 'unavailable' },
      { barrier: other, state: 'not-applied' },
      { barrier: 'object-writes', state: objectsHeld ? 'held' : 'unavailable' },
    ],
    databaseHeld,
    objectsHeld,
    runtimeRole: record?.database.role,
    form,
  };
}

/** Sessions on `databases` that are not the caller's own and, with a role barrier, not the fenced role's. */
async function foreignSessions(
  db: Db,
  databases: readonly string[],
  fencedRole: string | undefined,
): Promise<number> {
  const [row] = (await db.$client.unsafe(
    `SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = ANY($1::text[]) AND pid <> pg_backend_pid() AND backend_type = 'client backend'
        AND NOT (current_setting('application_name') LIKE $2
                 AND application_name = current_setting('application_name'))
        AND ($3::text IS NULL OR usename IS DISTINCT FROM $3::text)`,
    [databases, `${CONTROL_APPLICATION_PREFIX}%`, fencedRole ?? null],
  )) as unknown as { n: number }[];
  return row?.n ?? 0;
}

/** Runs, workflow runs and workflow nodes still marked running: effects whose outcome is unknown. */
async function unreconciledEffects(db: Db): Promise<number> {
  const query = queryOf(db);
  let total = 0;
  for (const table of ['runs', 'workflow_runs', 'workflow_node_states']) {
    const [present] = await query(`SELECT to_regclass('public.${table}') IS NOT NULL AS present`);
    if (present?.present !== true) continue;
    const [row] = await query(`SELECT count(*)::int AS n FROM "${table}" WHERE status = 'running'`);
    total += Number(row?.n ?? 0);
  }
  return total;
}

/** Copy the stored blob files into `objects.bin`, hashing each, and build the object index. */
async function captureObjects(objects: readonly FsStoredBlob[], out: string): Promise<ObjectIndex> {
  const target = await open(out, 'wx', 0o600);
  const index: ObjectIndex = { objectIndexFormatVersion: 1, objects: [] };
  let offset = 0;
  try {
    for (const object of objects) {
      const source = await open(object.file, constants.O_RDONLY | constants.O_NOFOLLOW).catch(
        () => null,
      );
      if (source === null) refuse(notQuiescent('a blob disappeared while the snapshot was taken'));
      const stored = createHash('sha256');
      const logical = createHash('sha256');
      let read = 0;
      try {
        const buffer = Buffer.alloc(1024 * 1024);
        for (;;) {
          const { bytesRead } = await source.read(buffer, 0, buffer.length, read);
          if (bytesRead === 0) break;
          const chunk = buffer.subarray(0, bytesRead);
          stored.update(chunk);
          if (read + bytesRead > object.dataStart) {
            logical.update(chunk.subarray(Math.max(0, object.dataStart - read)));
          }
          await target.write(chunk);
          read += bytesRead;
        }
      } finally {
        await source.close();
      }
      if (read !== object.storedSize) {
        refuse(notQuiescent('a blob changed size while the snapshot was taken'));
      }
      if (logical.digest('hex') !== object.sha256) {
        refuse(
          bundleError(
            'RAY_DIGEST_MISMATCH',
            'a stored blob does not hold the bytes its header states: the blob root is corrupt',
            { reason: 'object-sha256' },
          ),
        );
      }
      index.objects.push({
        tenantId: object.tenantId,
        key: object.key,
        ...(object.contentType === undefined ? {} : { contentType: object.contentType }),
        size: object.size,
        sha256: object.sha256,
        storedOffset: offset,
        storedSize: object.storedSize,
        storedSha256: stored.digest('hex'),
      });
      offset += object.storedSize;
    }
    await target.sync();
  } finally {
    await target.close();
  }
  return index;
}

/** The fields of a blob listing that change when an object is written, removed or replaced. */
function listingDigest(objects: readonly FsStoredBlob[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        objects.map((o) => [o.tenantId, o.key, o.storedSize, o.sha256, o.contentType]),
      ),
    )
    .digest('hex');
}

const quoted = (schema: string, table: string) => `"${schema}"."${table}"`;

/**
 * Dump one database in custom format, inside a REPEATABLE READ READ ONLY transaction whose exported
 * snapshot `pg_dump` reads, and count the rows of every table the dump carries in that same
 * snapshot. Tables in `schemaOnly` are dumped without rows and counted as 0.
 */
async function dumpDatabase(
  url: string,
  tool: PgDumpTool,
  tables: readonly { schema: string; table: string; rowsExported: boolean }[],
  outFile: string,
  database: TableCount['database'],
): Promise<TableCount[]> {
  const reader = makeDb(url, 1, { applicationName: 'rayspec-snapshot-reader' });
  try {
    return await reader.$client.begin('ISOLATION LEVEL REPEATABLE READ READ ONLY', async (tx) => {
      const [exported] = (await tx.unsafe('SELECT pg_export_snapshot() AS id')) as unknown as {
        id: string;
      }[];
      const counts: TableCount[] = [];
      for (const t of tables) {
        let rows = 0;
        if (t.rowsExported) {
          const [row] = (await tx.unsafe(
            `SELECT count(*)::text AS n FROM ${quoted(t.schema, t.table)}`,
          )) as unknown as { n: string }[];
          rows = Number(row?.n ?? 0);
          if (!Number.isSafeInteger(rows)) {
            refuse(
              bundleError(
                'RAY_LIMIT_EXCEEDED',
                'a table holds more rows than a snapshot can count',
                {
                  reason: 'snapshot-size',
                },
              ),
            );
          }
        }
        counts.push({ database, schema: t.schema, table: t.table, rows });
      }
      const excluded = tables
        .filter((t) => !t.rowsExported)
        .map((t) => `--exclude-table-data=${t.schema}.${t.table}`);
      await runPgDump(tool, url, [`--snapshot=${exported!.id}`, ...excluded], outFile);
      return counts;
    });
  } finally {
    await reader.$client.end().catch(() => {});
  }
}

function validRequest(options: CaptureSnapshotOptions): BundleError | null {
  if (!Number.isSafeInteger(options.fenceEpoch) || options.fenceEpoch < 1) {
    return bundleError('RAY_USAGE', 'the fence epoch is not an integer of 1 or more', {
      path: '/fenceEpoch',
    });
  }
  if (options.runHistoryPolicy !== 'included' && options.runHistoryPolicy !== 'excluded') {
    return bundleError(
      'RAY_USAGE',
      'the run history policy is included or excluded; there is no default',
      {
        path: '/runHistoryPolicy',
      },
    );
  }
  const passwords = options.passwordHashes ?? 'preserved';
  if (passwords !== 'preserved' && passwords !== 'reset') {
    return bundleError('RAY_USAGE', 'the password hash policy is preserved or reset');
  }
  return null;
}

/**
 * Capture the inner snapshot archive of the fenced source. Returns its path inside a private scratch
 * directory the caller removes, or the refusal with the barriers as the fence records them.
 */
export async function captureSnapshot(options: CaptureSnapshotOptions): Promise<CaptureResult> {
  const result = await captureUnredacted(options);
  if (result.ok) {
    return {
      ok: true,
      value: {
        ...result.value,
        warnings: result.value.warnings.map((w) => ({ ...w, message: redactText(w.message) })),
      },
    };
  }
  return { ...result, errors: result.errors.map(redactedError) };
}

async function captureUnredacted(options: CaptureSnapshotOptions): Promise<CaptureResult> {
  const usage = validRequest(options);
  if (usage !== null) return { ok: false, errors: [usage], barriers: null };
  const now = options.now ?? (() => new Date());
  let barriers: CaptureBarrier[] | null = null;
  let scratch: string | undefined;
  let workflowDb: Db | null = null;
  try {
    // The fence and its barriers.
    const fence = await readFence(options.db);
    if (fence === null || fence.epoch !== options.fenceEpoch) {
      refuse(
        bundleError(
          'RAY_FENCE_MISMATCH',
          'the fence is not held at that epoch; capture only with the epoch quiesce returned',
          { path: '/fenceEpoch' },
        ),
      );
    }
    if (fence.state !== 'fenced') refuse(notQuiescent('the fence was released'));
    const report = barrierReport(fence.barriers);
    barriers = report.barriers;
    if (!report.databaseHeld) {
      refuse(
        bundleError(
          'RAY_EXTERNAL_STATE_UNSUPPORTED',
          'no database write barrier is held: enable database role separation, or stop every ' +
            'runtime process and attest it (--source-stopped), then quiesce again',
          { reason: 'database-barrier-unavailable' },
        ),
      );
    }
    if (!report.objectsHeld)
      refuse(notQuiescent('object writes are not fenced: a process has not drained'));

    // Every preflight check, now under the fence.
    const checked = await preflightSnapshot(options);
    if (checked.blockers.length > 0 || checked.facts === null) {
      return {
        ok: false,
        errors:
          checked.blockers.length > 0
            ? checked.blockers
            : [bundleError('RAY_INTERNAL', 'preflight returned neither a blocker nor the source')],
        barriers,
      };
    }
    const facts = checked.facts;

    // Who else is connected, and what is still running.
    const workflowUrl =
      options.workflowSystemDatabaseUrl ?? derivedWorkflowSystemUrl(options.databaseUrl);
    const [current] = (await options.db.$client.unsafe(
      'SELECT current_database() AS name',
    )) as unknown as { name: string }[];
    const databases = [current!.name, decodeURIComponent(new URL(workflowUrl).pathname.slice(1))];
    const fencedRole = report.form === 'database-write-role' ? report.runtimeRole : undefined;
    if ((await foreignSessions(options.db, databases, fencedRole)) > 0) {
      refuse(
        bundleError(
          'RAY_EXTERNAL_STATE_UNSUPPORTED',
          report.form === 'database-write-role'
            ? 'a session of a role other than the fenced runtime role is connected to the source ' +
                'databases and could write; disconnect it before export'
            : 'a session other than the export is connected to the source databases although the ' +
                'source was attested as stopped; stop it before export',
          { reason: 'uncontrolled-writer' },
        ),
      );
    }
    const running = await unreconciledEffects(options.db);
    if (running > 0) {
      refuse(
        bundleError(
          'RAY_EXTERNAL_STATE_UNSUPPORTED',
          `${running} runs, workflow runs or workflow nodes are still marked running, so their ` +
            'external effects are unknown; reconcile them before export',
          { reason: 'unreconciled-effects' },
        ),
      );
    }

    // The scratch directory.
    scratch = await mkdtemp(join(options.scratchParent, 'rayspec-snapshot-'));
    await chmod(scratch, 0o700);
    const files = {
      application: '',
      database: join(scratch, 'database.dump'),
      workflowSystem: join(scratch, 'workflow-system.dump'),
      objectIndex: join(scratch, 'object-index.json'),
      objects: join(scratch, 'objects.bin'),
      archive: join(scratch, 'snapshot.zip'),
    };

    // 1. The application.
    const application = await rebuildDeployedApplication(options.stateDir, scratch);
    if (application.sha256 !== facts.applicationDigest) {
      refuse(notQuiescent('the deployed application changed while the snapshot was taken'));
    }
    files.application = application.path;

    // 2. The objects.
    const before = await listSourceBlobs(options.blob);
    if ('refusal' in before) refuse(before.refusal);
    const objectIndex = await captureObjects(before.objects, files.objects);
    const indexBytes = Buffer.from(canonicalJsonFile(objectIndex), 'utf8');
    const indexFile = await open(files.objectIndex, 'wx', 0o600);
    try {
      await indexFile.write(indexBytes);
    } finally {
      await indexFile.close();
    }

    // 3. The databases.
    const policy = options.runHistoryPolicy;
    const capturedAt = formatTimestamp(now());
    const appTables = classifyApplicationTables(
      await readUserTables(queryOf(options.db)),
      new Set(facts.productTables),
      policy,
    );
    if (appTables.unknown.length > 0) {
      refuse(
        bundleError(
          'RAY_EXTERNAL_STATE_UNSUPPORTED',
          'a table appeared that is neither a platform table nor a product store',
          { reason: 'unknown-table' },
        ),
      );
    }
    const reader = options.snapshotRole;
    const appReadUrl = reader?.databaseUrl ?? options.databaseUrl;
    const tableCounts = await dumpDatabase(
      appReadUrl,
      facts.pgDump,
      appTables.tables,
      files.database,
      'application',
    );
    workflowDb = await openWorkflowSystemDatabase(options.db, workflowUrl);
    const workflowSystem: Snapshot['workflowSystemDatabase'] =
      workflowDb === null ? 'absent' : 'included';
    if (workflowDb !== null) {
      const sysTables = (await readUserTables(queryOf(workflowDb))).map((t) => ({
        ...t,
        rowsExported: true,
      }));
      await workflowDb.$client.end();
      workflowDb = null;
      const sysReadUrl =
        reader === undefined
          ? workflowUrl
          : (reader.workflowSystemDatabaseUrl ?? derivedWorkflowSystemUrl(reader.databaseUrl));
      tableCounts.push(
        ...(await dumpDatabase(
          sysReadUrl,
          facts.pgDump,
          sysTables,
          files.workflowSystem,
          'workflow-system',
        )),
      );
    }
    if (tableCounts.length > MAX_SNAPSHOT_TABLE_COUNTS) {
      refuse(
        bundleError(
          'RAY_LIMIT_EXCEEDED',
          `the source has ${tableCounts.length} tables; snapshot.json counts at most ${MAX_SNAPSHOT_TABLE_COUNTS}`,
          { reason: 'snapshot-size' },
        ),
      );
    }

    // 4. Still the same source?
    const after = await listSourceBlobs(options.blob);
    if ('refusal' in after || listingDigest(after.objects) !== listingDigest(before.objects)) {
      refuse(notQuiescent('the blob root changed while the snapshot was taken'));
    }
    const still = await readFence(options.db);
    if (still === null || still.epoch !== options.fenceEpoch || still.state !== 'fenced') {
      refuse(notQuiescent('the fence was lost before the snapshot completed'));
    }

    // 5. The archive.
    tableCounts.sort(
      (a, b) =>
        compareCodePoints(a.database, b.database) ||
        compareCodePoints(a.schema, b.schema) ||
        compareCodePoints(a.table, b.table),
    );
    const snapshot: Omit<Snapshot, 'inventory'> = {
      snapshotFormatVersion: 1,
      sourceRuntime: facts.sourceRuntime,
      exportToolVersion: runtimeVersion(),
      applicationId: facts.applicationId,
      applicationVersion: facts.applicationVersion,
      applicationDigest: facts.applicationDigest,
      schemaHead: facts.schemaHead,
      databaseMajor: facts.databaseMajor,
      fenceEpoch: options.fenceEpoch,
      capturedAt,
      applicationTenantCount: 1,
      workflowSystemDatabase: workflowSystem,
      runHistoryPolicy: policy,
      identityPolicy: identityPolicy(options.passwordHashes ?? 'preserved'),
      tableCounts,
      objectCount: objectIndex.objects.length,
      excludedDataCategories: excludedDataCategories(policy),
    };
    const written = await writeSnapshotArchive(
      files.archive,
      {
        snapshot,
        files: [
          { path: SNAPSHOT_PATHS.application, file: files.application },
          { path: SNAPSHOT_PATHS.database, file: files.database },
          ...(workflowSystem === 'included'
            ? [{ path: SNAPSHOT_PATHS.workflowSystem, file: files.workflowSystem }]
            : []),
          { path: SNAPSHOT_PATHS.objectIndex, file: files.objectIndex },
          { path: SNAPSHOT_PATHS.objects, file: files.objects },
        ],
      },
      options.limits === undefined ? {} : { limits: options.limits },
    );
    if (!written.ok) refuse(written.errors[0]!);
    // Only the archive stays: the parts it was written from are removed.
    for (const part of [
      files.application,
      files.database,
      files.workflowSystem,
      files.objectIndex,
      files.objects,
    ]) {
      await rm(part, { force: true });
    }
    return {
      ok: true,
      value: {
        archivePath: written.value.path,
        scratchDir: scratch,
        archiveSha256: written.value.archiveSha256,
        archiveSize: written.value.archiveSize,
        snapshot: written.value.snapshot,
        excludedTables: appTables.tables
          .filter((t) => !t.rowsExported)
          .map(({ schema, table, category }) => ({ schema, table, category })),
        barriers,
        reader: facts.reader,
        warnings: checked.warnings,
      },
    };
  } catch (err) {
    if (scratch !== undefined) await rm(scratch, { recursive: true, force: true }).catch(() => {});
    if (err instanceof CaptureRefusal || err instanceof SourceRefusal) {
      return { ok: false, errors: [err.error], barriers };
    }
    if (err instanceof PgDumpError) {
      return {
        ok: false,
        errors: [bundleError('RAY_INFRA_UNAVAILABLE', err.message)],
        barriers,
      };
    }
    return {
      ok: false,
      errors: [
        bundleError(
          'RAY_INFRA_UNAVAILABLE',
          'a source database, the blob root or the scratch directory failed during the capture; ' +
            'the source stays fenced: retry the export, or release the fence with resume',
        ),
      ],
      barriers,
    };
  } finally {
    await workflowDb?.$client.end().catch(() => {});
  }
}
