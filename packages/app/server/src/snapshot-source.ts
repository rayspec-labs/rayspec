/**
 * THE SNAPSHOT SOURCE — what an export reads and checks before it captures anything: the deployed
 * application, the schema head, the blob root, the disk and size budgets, the database extensions,
 * the tenants and their way back in, and every table and piece of state the snapshot could not
 * carry. `preflightSnapshot` runs it all read-only, before any fence is taken, and reports each
 * finding as a blocker; `captureSnapshot` (snapshot-capture.ts) runs it again under the fence.
 *
 * THE CHECKS, in the order the contract's export sequence names them:
 *   1. the source: the state directory's active bundle, rebuilt byte for byte with the one bundle
 *      writer, is the application the database records (digest, id, version), was built for this
 *      runtime and reads through the full reader pipeline; the deployment id matches; the platform
 *      head is one this runtime ships and the product schema is the one the product ledger recorded
 *      (`RAY_SCHEMA_DRIFT` otherwise; an environment without ledger rows warns
 *      `RAY_W_PRODUCT_SCHEMA_UNLEDGERED`); the server's major is one a snapshot can state and the
 *      `pg_dump` found has the same major; the role the dumps read as (the snapshot role, or the
 *      single role) can read every table of both databases past row-level security;
 *   2. the blob adapter: the fs blob root, walked completely (`unsupported-blob-adapter` for any
 *      other adapter, `unreconciled-effects` for an upload that never finished);
 *   3. the budgets: objects and their bytes against the migration limits (`RAY_LIMIT_EXCEEDED`
 *      `migration-size`, `object-index-size`), and free space for the scratch copy;
 *   4. extensions: the snapshot format's extension allowlist is empty, so any extension but the built-in `plpgsql` in either
 *      database is refused (`RAY_POLICY_DENIED` `unsupported-extension`);
 *   5. tenants: exactly one organization, and no blob of another tenant
 *      (`RAY_MULTI_TENANT_UNSUPPORTED`);
 *   6. owner recovery: a member of the organization holds a password (`RAY_OWNER_RECOVERY_REQUIRED`);
 *   7. external state: every table that is neither a platform table nor a product store of the
 *      embedded application (`unknown-table`), and whatever the caller knows the export cannot
 *      capture.
 *
 * DATA CATEGORIES. Every application table is classified from the platform table list (which
 * restates the contract's category file) or as a product store of the embedded spec. The rows of
 * `credential-state`, `request-replay-state`, `security-audit-log` and `runtime-control-state`
 * tables never leave the source, and neither do `run-history` rows under
 * `runHistoryPolicy: excluded`; their tables are dumped with their schema only.
 *
 * Nothing here writes to either database or to the blob root; temporary files live in a private
 * directory that is removed before the function returns.
 */
import { mkdtemp, readFile, rm, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { writeBundle } from '@rayspec/bundle';
import {
  ALWAYS_EXCLUDED_DATA_CATEGORIES,
  type ApplicationManifest,
  type BundleError,
  type BundleWarning,
  bundleError,
  compareCodePoints,
  type DataCategory,
  type ErrorReason,
  type IdentityPolicy,
  MAX_SNAPSHOT_ENTRY_BYTES,
  MAX_SNAPSHOT_OBJECTS,
  PLATFORM_TABLES,
  type ReaderLimits,
  resolveReaderLimits,
  type SchemaHead,
  validateManifest,
} from '@rayspec/bundle-contract';
import { redactText } from '@rayspec/core';
import { type Db, makeDb } from '@rayspec/db';
import { BlobInventoryError, type FsStoredBlob, listFsBlobs } from '@rayspec/platform';
import type { StateDirectory } from './deployment-state.js';
import { type PgDumpTool, pgDumpMajor, resolvePgDump } from './pg-dump.js';
import { ledgerDrift, readProductLedger } from './product-ledger.js';
import { declaredStoresOf } from './product-schema-plan.js';
import { readApplicationBundle } from './runtime-control.js';
import { type CatalogQuery, readProductTables, readSchemaHead } from './schema-head.js';

/** Where the blobs of the environment live. */
export type SnapshotBlobSource =
  /** The fs blob store over this root (`RAYSPEC_BLOB_ROOT`). */
  | { kind: 'fs'; root: string }
  /** No blob store is configured: the snapshot carries no objects. */
  | { kind: 'none' }
  /** A blob backend the export cannot read (an extension's, a cloud bucket), named. */
  | { kind: 'unsupported'; name: string };

/** State the caller knows the export cannot capture, reported as a blocker. */
export interface UnsupportedSourceState {
  reason: ErrorReason<'RAY_EXTERNAL_STATE_UNSUPPORTED'>;
  /** What it is and what to do, without a secret. */
  message: string;
}

export interface SnapshotSourceOptions {
  /**
   * The control connection to the application database, opened with `openControlDatabase` so its
   * sessions count as the caller's own: the migration role with role separation, else the one role.
   */
  db: Db;
  /** The connection string of `db`. */
  databaseUrl: string;
  /**
   * The workflow system database, with the same role as `databaseUrl`. Default: `databaseUrl` on the
   * database `<application database>_dbos_sys`, as the runtime derives it.
   */
  workflowSystemDatabaseUrl?: string;
  /**
   * The read-only snapshot role, when one is configured: the dumps and the row counts read through
   * it. Without it the reads use the connection strings above (single-role mode), which the result
   * says.
   */
  snapshotRole?: { databaseUrl: string; workflowSystemDatabaseUrl?: string };
  /** The deployment's state directory: its active version is the application exported. */
  stateDir: StateDirectory;
  /** The deployment id the operator named; it must be the state directory's and the database's. */
  deploymentId: string;
  blob: SnapshotBlobSource;
  /** The `pg_dump` to run (an absolute path or a tool); default the first on `PATH`. */
  pgDump?: string | PgDumpTool;
  /** The directory the private scratch directory is created in. */
  scratchParent: string;
  /** State outside the databases and the blob root that the snapshot cannot carry. */
  unsupportedState?: readonly UnsupportedSourceState[];
  /** Reader limits, lowered from the contract defaults. */
  limits?: Partial<ReaderLimits>;
}

/** What preflight established about a source that has no blocker. */
export interface SnapshotSourceFacts {
  deploymentId: string;
  applicationId: string;
  applicationVersion: string;
  applicationDigest: string;
  /** The runtime the application was built for and runs on. */
  sourceRuntime: string;
  schemaHead: SchemaHead;
  databaseMajor: number;
  /** The organization: the one application tenant. */
  tenantId: string;
  /** Whether the workflow system database exists now. */
  workflowSystemDatabase: 'present' | 'absent';
  /** The product store tables of the embedded application, by name. */
  productTables: string[];
  objectCount: number;
  /** The bytes of every stored blob file together. */
  objectBytes: number;
  /** Who the dumps read as. */
  reader: 'snapshot-role' | 'single-role';
  pgDump: PgDumpTool;
}

export interface SnapshotPreflight {
  /** Every finding that stops an export, first one first. Empty when the source can be exported. */
  blockers: BundleError[];
  warnings: BundleWarning[];
  /** Present when there is no blocker. */
  facts: SnapshotSourceFacts | null;
}

// ─── data categories ───────────────────────────────────────────────────────────────────────────

export type RunHistoryPolicy = 'included' | 'excluded';

/** One application table with its data category and whether its rows are exported. */
export interface ClassifiedTable {
  schema: string;
  table: string;
  category: DataCategory;
  rowsExported: boolean;
}

/** The categories whose rows never leave the source, plus run history when the policy says so. */
export function excludedDataCategories(policy: RunHistoryPolicy): DataCategory[] {
  const out: DataCategory[] = [...ALWAYS_EXCLUDED_DATA_CATEGORIES];
  if (policy === 'excluded') out.push('run-history');
  return out.sort(compareCodePoints);
}

/**
 * Classify the live application tables: a platform table takes its category from the platform table
 * list, a table of the embedded application's product stores is `product-store-data`, and anything
 * else is returned as unknown (`schema.table`), which blocks the export.
 */
export function classifyApplicationTables(
  live: readonly { schema: string; table: string }[],
  productTables: ReadonlySet<string>,
  policy: RunHistoryPolicy,
): { tables: ClassifiedTable[]; unknown: string[] } {
  const platform = new Map(PLATFORM_TABLES.map((p) => [`${p.schema}.${p.table}`, p.category]));
  const excluded = new Set(excludedDataCategories(policy));
  const tables: ClassifiedTable[] = [];
  const unknown: string[] = [];
  for (const { schema, table } of live) {
    const category: DataCategory | undefined =
      platform.get(`${schema}.${table}`) ??
      (schema === 'public' && productTables.has(table) ? 'product-store-data' : undefined);
    if (category === undefined) {
      unknown.push(`${schema}.${table}`);
      continue;
    }
    tables.push({ schema, table, category, rowsExported: !excluded.has(category) });
  }
  const order = (a: { schema: string; table: string }, b: { schema: string; table: string }) =>
    compareCodePoints(a.schema, b.schema) || compareCodePoints(a.table, b.table);
  return { tables: tables.sort(order), unknown: unknown.sort(compareCodePoints) };
}

/** The identity policy a snapshot states: what the target keeps, resets and reissues. */
export function identityPolicy(passwordHashes: 'preserved' | 'reset'): IdentityPolicy {
  return {
    userIds: 'preserved',
    passwordHashes,
    sessions: 'reset',
    apiKeys: 'reset',
    invites: 'reset',
    oidcArtifacts: 'reset',
    jwtSigningKey: 'reissued',
    apiKeyPepper: 'reissued',
    mediaSigningKey: 'reissued',
    mediaPlaybackTokens: 'invalidated',
  };
}

// ─── catalog reads ─────────────────────────────────────────────────────────────────────────────

/** The table name form a snapshot's `tableCounts` can state. */
export const SNAPSHOT_TABLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

const USER_SCHEMAS = `n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'`;

/** Every table of the connected database outside the system schemas: ordinary, partitioned, foreign and materialized. */
export async function readUserTables(
  query: CatalogQuery,
): Promise<{ schema: string; table: string }[]> {
  const rows = await query(
    `SELECT n.nspname::text AS schema, c.relname::text AS table
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p', 'f', 'm') AND ${USER_SCHEMAS}
      ORDER BY 1, 2`,
  );
  return rows.map((r) => ({ schema: String(r.schema), table: String(r.table) }));
}

/** The extensions of the connected database other than the built-in procedural language. */
export async function readExtensions(query: CatalogQuery): Promise<string[]> {
  const rows = await query(
    "SELECT extname::text AS name FROM pg_extension WHERE extname <> 'plpgsql' ORDER BY 1",
  );
  return rows.map((r) => String(r.name));
}

export function queryOf(db: Db): CatalogQuery {
  return async (sql, params = []) =>
    (await db.$client.unsafe(sql, params as never[])) as unknown as Record<string, unknown>[];
}

/** The connection string of another database on the same server, with the same role. */
export function withDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${encodeURIComponent(name)}`;
  return u.toString();
}

/** The workflow system database's connection string the runtime would derive from `databaseUrl`. */
export function derivedWorkflowSystemUrl(databaseUrl: string): string {
  const u = new URL(databaseUrl);
  const name = decodeURIComponent(u.pathname.replace(/^\//, ''));
  return withDatabase(databaseUrl, `${name}_dbos_sys`);
}

/**
 * Open the workflow system database with the control connection's application name (so a session
 * check counts it as the caller's own), or return null when that database does not exist.
 */
export async function openWorkflowSystemDatabase(control: Db, url: string): Promise<Db | null> {
  const [tag] = (await control.$client.unsafe('SHOW application_name')) as unknown as {
    application_name: string;
  }[];
  const db = makeDb(url, 1, { applicationName: tag?.application_name ?? '' });
  try {
    await db.$client.unsafe('SELECT 1');
    return db;
  } catch (err) {
    await db.$client.end().catch(() => {});
    if ((err as { code?: string }).code === '3D000') return null;
    throw err;
  }
}

/** The deployed application, rebuilt from the state directory's active version. */
export interface DeployedApplication {
  path: string;
  sha256: string;
  manifest: ApplicationManifest;
  productTables: string[];
}

/**
 * Rebuild the `.ray` the deployment activated from its version directory, with the one bundle
 * writer, into `directory`. The writer is deterministic, so a bundle it wrote comes back byte for
 * byte; the SHA-256 is checked against `active.json`. Throws a refusal as `SourceRefusal`.
 */
export async function rebuildDeployedApplication(
  stateDir: StateDirectory,
  directory: string,
): Promise<DeployedApplication> {
  const active = await stateDir.readActive();
  if (active === null) {
    throw new SourceRefusal(
      bundleError(
        'RAY_USAGE',
        'the state directory has no active version: this deployment was never deployed from a bundle',
      ),
    );
  }
  const root = stateDir.versionPath(active.bundleSha256);
  const manifestBytes = await readFile(join(root, 'ray.json')).catch(() => null);
  const validated = manifestBytes === null ? null : validateManifest(manifestBytes);
  if (validated === null || !validated.ok || validated.value.kind !== 'application') {
    throw new SourceRefusal(
      bundleError(
        'RAY_DIGEST_MISMATCH',
        'the active version directory has no readable application manifest; deploy the bundle again',
        { reason: 'bundle-sha256' },
      ),
    );
  }
  const manifest = validated.value;
  const path = join(directory, 'application.ray');
  const written = await writeBundle(path, {
    manifest,
    files: manifest.inventory.map((e) => ({ path: e.path, file: join(root, e.path) })),
  });
  if (!written.ok || written.value.archiveSha256 !== active.bundleSha256) {
    throw new SourceRefusal(
      bundleError(
        'RAY_DIGEST_MISMATCH',
        'the active version directory does not rebuild into the bundle that was deployed: a file ' +
          'changed, or the bundle was written by another writer. Deploy the bundle again',
        { reason: 'bundle-sha256' },
      ),
    );
  }
  const read = await readApplicationBundle(path, {
    operation: 'deploy',
    expectedSha256: active.bundleSha256,
  });
  if (!read.ok) throw new SourceRefusal(read.errors[0]!);
  return {
    path,
    sha256: active.bundleSha256,
    manifest: read.value.manifest,
    productTables: declaredStoresOf(read.value.spec)
      .stores.map((s) => s.name)
      .sort(compareCodePoints),
  };
}

/** A refusal raised while reading the source; carried to the result as a blocker. */
export class SourceRefusal extends Error {
  readonly error: BundleError;
  constructor(error: BundleError) {
    super(error.message);
    this.name = 'SourceRefusal';
    this.error = error;
  }
}

/** The blob listing of the source, or the refusal the walk ends with. */
export async function listSourceBlobs(
  blob: SnapshotBlobSource,
): Promise<{ objects: FsStoredBlob[] } | { refusal: BundleError }> {
  if (blob.kind === 'none') return { objects: [] };
  if (blob.kind === 'unsupported') {
    return {
      refusal: bundleError(
        'RAY_EXTERNAL_STATE_UNSUPPORTED',
        'the blobs are kept by a backend the export cannot read; an export reads the fs blob store only',
        { reason: 'unsupported-blob-adapter' },
      ),
    };
  }
  try {
    return { objects: await listFsBlobs(blob.root) };
  } catch (err) {
    if (!(err instanceof BlobInventoryError)) throw err;
    if (err.kind === 'root-missing') {
      return {
        refusal: bundleError(
          'RAY_INFRA_UNAVAILABLE',
          'the blob root cannot be read; check that it exists and is reachable',
        ),
      };
    }
    return {
      refusal: bundleError(
        'RAY_EXTERNAL_STATE_UNSUPPORTED',
        `the blob root cannot be exported completely: ${err.message}`,
        {
          reason:
            err.kind === 'partial-write' ? 'unreconciled-effects' : 'unsupported-blob-adapter',
        },
      ),
    };
  }
}

// ─── preflight ─────────────────────────────────────────────────────────────────────────────────

/** Bytes kept free beyond the estimate, so a nearly full disk is refused before a capture. */
const DISK_HEADROOM_BYTES = 64 * 1024 * 1024;

function names(list: readonly string[]): string {
  const shown = list.slice(0, 10).join(', ');
  return list.length > 10 ? `${shown} and ${list.length - 10} more` : shown;
}

/**
 * Check the source of an export, read-only, before any fence is taken. Every finding is a blocker in
 * `blockers`; a database or blob root that cannot be reached is `RAY_INFRA_UNAVAILABLE`.
 */
export async function preflightSnapshot(
  options: SnapshotSourceOptions,
): Promise<SnapshotPreflight> {
  const result = await preflightUnredacted(options);
  return {
    ...result,
    blockers: result.blockers.map(redactedError),
    warnings: result.warnings.map((w) => ({ ...w, message: redactText(w.message) })),
  };
}

/** A message passes the one redaction path before it leaves the snapshot code. */
export function redactedError(error: BundleError): BundleError {
  return { ...error, message: redactText(error.message) };
}

async function preflightUnredacted(options: SnapshotSourceOptions): Promise<SnapshotPreflight> {
  const blockers: BundleError[] = [];
  const warnings: BundleWarning[] = [];
  let limits: ReaderLimits;
  try {
    limits = resolveReaderLimits(options.limits);
  } catch {
    return {
      blockers: [bundleError('RAY_USAGE', 'a reader limit is outside 0 to its default')],
      warnings,
      facts: null,
    };
  }
  try {
    return await preflight(options, limits, blockers, warnings);
  } catch (err) {
    if (err instanceof SourceRefusal)
      return { blockers: [...blockers, err.error], warnings, facts: null };
    return {
      blockers: [
        ...blockers,
        bundleError(
          'RAY_INFRA_UNAVAILABLE',
          'the source database, the workflow system database or the scratch directory could not ' +
            'be read; check that they are reachable and retry',
        ),
      ],
      warnings,
      facts: null,
    };
  }
}

async function preflight(
  options: SnapshotSourceOptions,
  limits: ReaderLimits,
  blockers: BundleError[],
  warnings: BundleWarning[],
): Promise<SnapshotPreflight> {
  const query = queryOf(options.db);
  const scratch = await mkdtemp(join(options.scratchParent, 'rayspec-preflight-'));
  let workflowDb: Db | null = null;
  try {
    // 1. The source: the deployed application, the deployment id, the schema head.
    let application: DeployedApplication | null = null;
    try {
      application = await rebuildDeployedApplication(options.stateDir, scratch);
    } catch (err) {
      if (!(err instanceof SourceRefusal)) throw err;
      blockers.push(err.error);
    }
    const [state] = await query(
      `SELECT deployment_id, application_id, application_version, application_digest
         FROM runtime_control_state WHERE id = 1`,
    ).catch(() => [] as Record<string, unknown>[]);
    const deployment = await options.stateDir.readDeployment();
    if (
      state === undefined ||
      deployment === null ||
      deployment.deploymentId !== options.deploymentId ||
      state.deployment_id !== options.deploymentId
    ) {
      blockers.push(
        bundleError(
          'RAY_USAGE',
          'the deployment id is not the one the state directory and the database record; name ' +
            'the deployment of this environment',
        ),
      );
    } else if (
      application !== null &&
      (state.application_digest !== application.sha256 ||
        state.application_id !== application.manifest.application.id ||
        state.application_version !== application.manifest.application.version)
    ) {
      blockers.push(
        bundleError(
          'RAY_DIGEST_MISMATCH',
          'the application the database records is not the active version of the state directory',
          { reason: 'bundle-sha256' },
        ),
      );
    }

    const head = await readSchemaHead(query);
    let schemaHead: SchemaHead | null = null;
    if (head.state === 'unknown') {
      blockers.push(
        bundleError(
          'RAY_SCHEMA_DRIFT',
          'the database records a platform migration this runtime does not ship: it was migrated ' +
            'by a newer runtime; export with that runtime',
        ),
      );
    } else if (head.state === 'empty') {
      blockers.push(bundleError('RAY_USAGE', 'the database has no platform schema to export'));
    } else {
      schemaHead = head.head;
      const ledger = await readProductLedger(query);
      if (ledger.state === 'unreadable') {
        blockers.push(bundleError('RAY_SCHEMA_DRIFT', ledger.message));
      } else if (ledger.state === 'ledgered') {
        // A table that is neither the application's nor the ledger's is reported once, as an
        // unknown table below, not again as drift.
        const known = new Set([
          ...(application?.productTables ?? []),
          ...ledger.head.tablesAfter.map((t) => t.name),
        ]);
        const live = (await readProductTables(query)).filter((t) => known.has(t.name));
        const drift = ledgerDrift(ledger.head, live);
        if (drift !== null) blockers.push(bundleError('RAY_SCHEMA_DRIFT', drift));
      } else {
        warnings.push({
          code: 'RAY_W_PRODUCT_SCHEMA_UNLEDGERED',
          message:
            'the product schema head was computed by introspection: no product change was recorded ' +
            'in the product migration ledger yet',
        });
      }
    }

    const [version] = await query('SHOW server_version_num');
    const databaseMajor = Math.floor(Number(version?.server_version_num) / 10_000);
    if (!(databaseMajor >= 14 && databaseMajor <= 99)) {
      blockers.push(
        bundleError(
          'RAY_TARGET_UNSUPPORTED',
          'the database server major is below 14, which a snapshot cannot carry',
        ),
      );
    }
    const pgDump = await resolvePgDump(options.pgDump);
    if (pgDump === null) {
      blockers.push(
        bundleError(
          'RAY_USAGE',
          'no pg_dump was found: install the PostgreSQL client tools of the server major, or name ' +
            'pg_dump by its absolute path',
        ),
      );
    } else {
      const major = await pgDumpMajor(pgDump).catch(() => null);
      if (major !== databaseMajor) {
        blockers.push(
          bundleError(
            'RAY_USAGE',
            `the pg_dump found is ${major === null ? 'not runnable' : `major ${major}`}, and a ` +
              `snapshot needs the server major ${databaseMajor}: name a pg_dump of that major`,
          ),
        );
      }
    }

    const workflowUrl =
      options.workflowSystemDatabaseUrl ?? derivedWorkflowSystemUrl(options.databaseUrl);
    workflowDb = await openWorkflowSystemDatabase(options.db, workflowUrl);

    // Whoever the dumps read as must read every table, past row-level security.
    const readers = [
      options.snapshotRole?.databaseUrl ?? options.databaseUrl,
      ...(workflowDb === null
        ? []
        : [
            options.snapshotRole === undefined
              ? workflowUrl
              : (options.snapshotRole.workflowSystemDatabaseUrl ??
                derivedWorkflowSystemUrl(options.snapshotRole.databaseUrl)),
          ]),
    ];
    for (const url of readers) {
      if ((await unreadableTables(url)) > 0) {
        blockers.push(
          bundleError(
            'RAY_USAGE',
            `the ${options.snapshotRole === undefined ? 'database role' : 'snapshot role'} cannot ` +
              'read every table past row-level security; grant it SELECT on every table and ' +
              'BYPASSRLS (the database roles setup script sets up the snapshot role this way)',
          ),
        );
        break;
      }
    }

    // 2. The blob adapter.
    const listed = await listSourceBlobs(options.blob);
    const objects = 'objects' in listed ? listed.objects : [];
    if ('refusal' in listed) blockers.push(listed.refusal);

    // 3. The budgets.
    const objectBytes = objects.reduce((sum, o) => sum + o.storedSize, 0);
    if (objects.length > MAX_SNAPSHOT_OBJECTS) {
      blockers.push(
        bundleError(
          'RAY_LIMIT_EXCEEDED',
          `the blob root holds ${objects.length} objects; a snapshot indexes at most ${MAX_SNAPSHOT_OBJECTS}`,
          { reason: 'object-index-size' },
        ),
      );
    }
    const applicationBytes = application === null ? 0 : ((await statSize(application.path)) ?? 0);
    if (
      objectBytes > MAX_SNAPSHOT_ENTRY_BYTES ||
      objectBytes + applicationBytes > limits.migrationExtractedBytes
    ) {
      blockers.push(
        bundleError(
          'RAY_LIMIT_EXCEEDED',
          'the objects and the application alone are larger than the migration archive limit ' +
            `(${limits.migrationExtractedBytes} bytes); an export has no larger transfer`,
          { reason: 'migration-size' },
        ),
      );
    }
    const [appSize] = await query('SELECT pg_database_size(current_database())::text AS bytes');
    let estimate = Number(appSize?.bytes ?? 0) + objectBytes + applicationBytes;
    if (workflowDb !== null) {
      const [sysSize] = await queryOf(workflowDb)(
        'SELECT pg_database_size(current_database())::text AS bytes',
      );
      estimate += Number(sysSize?.bytes ?? 0);
    }
    const disk = await statfs(options.scratchParent);
    // The dumps and objects are written once, then copied into the snapshot archive.
    const needed = 2 * estimate + DISK_HEADROOM_BYTES;
    if (disk.bavail * disk.bsize < needed) {
      blockers.push(
        bundleError(
          'RAY_INFRA_UNAVAILABLE',
          `the scratch directory has ${disk.bavail * disk.bsize} bytes free; the snapshot needs ` +
            `about ${needed}. Free space or choose another scratch directory`,
        ),
      );
    }

    // 4. Extensions.
    const extensions = [
      ...(await readExtensions(query)),
      ...(workflowDb === null ? [] : await readExtensions(queryOf(workflowDb))),
    ];
    if (extensions.length > 0) {
      blockers.push(
        bundleError(
          'RAY_POLICY_DENIED',
          `the source uses database extensions a snapshot cannot carry: ${names([...new Set(extensions)])}`,
          { reason: 'unsupported-extension' },
        ),
      );
    }

    // 5. Tenants, and 6. a way back in.
    const tenants = await query(
      `SELECT o.id::text AS id,
              EXISTS (SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id
                       WHERE m.org_id = o.id AND m.deleted_at IS NULL AND m.status = 'active'
                         AND u.deleted_at IS NULL AND u.password_hash IS NOT NULL) AS recoverable
         FROM orgs o ORDER BY o.id`,
    );
    const tenantId = tenants.length === 1 ? String(tenants[0]!.id) : null;
    if (tenants.length > 1) {
      blockers.push(
        bundleError(
          'RAY_MULTI_TENANT_UNSUPPORTED',
          `the source holds ${tenants.length} organizations; a snapshot carries exactly one`,
        ),
      );
    } else if (tenants.length === 0) {
      blockers.push(bundleError('RAY_USAGE', 'the source has no organization to export'));
    } else if (objects.some((o) => o.tenantId !== tenantId)) {
      blockers.push(
        bundleError(
          'RAY_MULTI_TENANT_UNSUPPORTED',
          'the blob root holds objects of a tenant that is not the organization; a snapshot ' +
            'carries exactly one tenant',
        ),
      );
    }
    if (tenants.length >= 1 && tenants.some((t) => t.recoverable !== true)) {
      blockers.push(
        bundleError(
          'RAY_OWNER_RECOVERY_REQUIRED',
          'no member of the organization holds a password, so after the import, where every API ' +
            'key, session and invite is reset, nobody could sign in. Add a password-holding owner ' +
            'before export',
        ),
      );
    }

    // 7. External state: unknown tables, then what the caller names.
    const productTables = new Set(application?.productTables ?? []);
    const appTables = await readUserTables(query);
    const { unknown } = classifyApplicationTables(appTables, productTables, 'included');
    const unrepresentable = appTables.filter(
      (t) => !SNAPSHOT_TABLE_NAME.test(t.schema) || !SNAPSHOT_TABLE_NAME.test(t.table),
    );
    const sysTables = workflowDb === null ? [] : await readUserTables(queryOf(workflowDb));
    const sysUnrepresentable = sysTables.filter(
      (t) => !SNAPSHOT_TABLE_NAME.test(t.schema) || !SNAPSHOT_TABLE_NAME.test(t.table),
    );
    const unknownTables = [
      ...new Set([
        ...unknown,
        ...unrepresentable.map((t) => `${t.schema}.${t.table}`),
        ...sysUnrepresentable.map((t) => `workflow system ${t.schema}.${t.table}`),
      ]),
    ];
    if (unknownTables.length > 0) {
      blockers.push(
        bundleError(
          'RAY_EXTERNAL_STATE_UNSUPPORTED',
          'the source has tables that are neither platform tables nor product stores of the ' +
            `application, or whose names a snapshot cannot state: ${names(unknownTables)}`,
          { reason: 'unknown-table' },
        ),
      );
    }
    for (const s of options.unsupportedState ?? []) {
      blockers.push(bundleError('RAY_EXTERNAL_STATE_UNSUPPORTED', s.message, { reason: s.reason }));
    }

    if (
      blockers.length > 0 ||
      application === null ||
      schemaHead === null ||
      tenantId === null ||
      pgDump === null
    ) {
      return { blockers, warnings, facts: null };
    }
    return {
      blockers,
      warnings,
      facts: {
        deploymentId: options.deploymentId,
        applicationId: application.manifest.application.id,
        applicationVersion: application.manifest.application.version,
        applicationDigest: application.sha256,
        sourceRuntime: application.manifest.runtime.version,
        schemaHead,
        databaseMajor,
        tenantId,
        workflowSystemDatabase: workflowDb === null ? 'absent' : 'present',
        productTables: [...productTables],
        objectCount: objects.length,
        objectBytes,
        reader: options.snapshotRole === undefined ? 'single-role' : 'snapshot-role',
        pgDump,
      },
    };
  } finally {
    await workflowDb?.$client.end().catch(() => {});
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * How many tables of the database `url` names its role cannot read in full: no USAGE on the schema,
 * no SELECT on the table, or row-level security that applies to the role.
 */
async function unreadableTables(url: string): Promise<number> {
  const reader = makeDb(url, 1, { applicationName: 'rayspec-snapshot-reader' });
  try {
    const [row] = (await reader.$client.unsafe(
      `SELECT count(*)::int AS n
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p') AND ${USER_SCHEMAS}
          AND NOT (has_schema_privilege(n.oid, 'USAGE') AND has_table_privilege(c.oid, 'SELECT')
                   AND (NOT c.relrowsecurity
                        OR (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user)
                        OR (NOT c.relforcerowsecurity AND pg_has_role(c.relowner, 'USAGE'))))`,
    )) as unknown as { n: number }[];
    return row?.n ?? 0;
  } finally {
    await reader.$client.end().catch(() => {});
  }
}

async function statSize(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}
