/**
 * THE RUNTIME-CONTROL ADAPTER — the typed library a deployment supervisor or the CLI calls to ask a
 * runtime what it is (`inspect`) and what deploying a bundle onto its environment would do
 * (`prepare`). It adds no HTTP route: a caller holds the environment's database connection and calls
 * these functions in process.
 *
 * Both operations are READ-ONLY. They take no advisory lock and write nothing to the environment's
 * database; `prepare` stores no plan — `apply` receives every plan input again and recomputes the
 * digest. The one place `prepare` writes is a throwaway database on the shadow server, created and
 * dropped within the call, to learn the product schema head a delta would produce without running
 * the delta against the live database.
 *
 * Every result is the contract's result envelope with `operation` `runtime.inspect` or
 * `runtime.prepare`, echoing the request's `operationId`. No result carries a secret, a binding
 * value, a connection string, a host name or a file path.
 */
import { createHash, type KeyObject, randomBytes, randomUUID } from 'node:crypto';
import { constants, readFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { inspectBundle, verifySignatureFile } from '@rayspec/bundle';
import {
  type BundleSpec,
  checkDerivedFields,
  deriveManifestFields,
  networkBackends,
  parseBundleSpec,
} from '@rayspec/bundle-closure';
import {
  type ApplicationManifest,
  type BundleError,
  type BundleWarning,
  bundleError,
  CAPABILITIES,
  CAPABILITY_VOCABULARY_VERSION,
  CONTRACT_VERSION,
  checkPrepareRequest,
  checkRequestBase,
  checkRuntimeAdmission,
  compareCodePoints,
  type DeploymentPlan,
  type ExecutionLevel,
  formatTimestamp,
  type InspectData,
  type InspectRequest,
  isSha256,
  isUuidV4,
  type PrepareData,
  type PrepareRequest,
  type ProductTable,
  planDigest,
  planExpiresAt,
  productSchemaDigest,
  type ReaderLimits,
  type ResultEnvelope,
  type ResultOperation,
  type RuntimeControl,
  type SchemaHead,
  SUPPORTED_TARGETS,
  sameSchemaHead,
  V1_EXECUTION_LEVELS,
} from '@rayspec/bundle-contract';
import {
  classifyProductSchema,
  type Db,
  detectDrift,
  generateProductSql,
  makeDb,
  scanMigrationSql,
} from '@rayspec/db';
import {
  composeCapabilityStores,
  deriveConflictKeys,
  deriveProductStores,
} from '@rayspec/product-yaml';
import type { StoreSpec } from '@rayspec/spec';
import { applyMigrations } from './composition-root.js';
import {
  type CatalogQuery,
  readProductTables,
  readSchemaHead,
  runtimePlatformHead,
} from './schema-head.js';

/** The operations this adapter implements today. */
export type RuntimeControlAdapter = Pick<RuntimeControl, 'inspect' | 'prepare'>;

export interface RuntimeControlOptions {
  /** The environment's application database. */
  db: Db;
  /**
   * A server where `prepare` may create and drop a throwaway database (`SHADOW_DATABASE_URL`). Without
   * it, a plan whose product delta is not empty carries the blocker `RAY_MIGRATION_REQUIRED`.
   */
  shadowDatabaseUrl?: string;
  /** SHA-256 of the signed release manifest this runtime was installed from; null when none. */
  releaseManifestSha256?: string | null;
  /** SHA-256 of the managed capability receipt of this release; null when the release has none. */
  managedReceiptSha256?: string | null;
  /** Keys a detached bundle signature is verified against. */
  trustedKeys?: readonly KeyObject[];
  /** Reader limits, lowered from the contract defaults. */
  readerLimits?: Partial<ReaderLimits>;
  /** The clock `preparedAt` is read from. */
  now?: () => Date;
  /** Whether a module resolves in this process; the capability probe. */
  resolvesModule?: (specifier: string) => boolean;
}

// ─── envelopes ─────────────────────────────────────────────────────────────────────────────────

function operationIdOf(request: unknown): string {
  const id = (request as { operationId?: unknown } | null)?.operationId;
  return isUuidV4(id) ? id : randomUUID();
}

function succeeded<T>(
  operation: ResultOperation,
  operationId: string,
  data: T,
  warnings: BundleWarning[] = [],
): ResultEnvelope<T> {
  return {
    contractVersion: CONTRACT_VERSION,
    ok: true,
    operation,
    operationId,
    data,
    errors: [],
    warnings,
  };
}

function failed<T>(
  operation: ResultOperation,
  operationId: string,
  errors: BundleError[],
  warnings: BundleWarning[] = [],
): ResultEnvelope<T> {
  const [first, ...rest] = errors;
  return {
    contractVersion: CONTRACT_VERSION,
    ok: false,
    operation,
    operationId,
    data: null,
    errors: [first ?? bundleError('RAY_INTERNAL', 'the operation failed'), ...rest],
    warnings,
  };
}

/** A database that could not be reached or answered with an error: no detail leaves the process. */
function infraUnavailable(): BundleError {
  return bundleError(
    'RAY_INFRA_UNAVAILABLE',
    'the environment database could not be read; check that it is reachable and retry',
  );
}

// ─── runtime identity ──────────────────────────────────────────────────────────────────────────

/** The version of this runtime: the version of the package that ships it. */
export function runtimeVersion(): string {
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string };
  return manifest.version;
}

/**
 * The module each available capability comes from. A capability is reported only when its module
 * resolves in this process; an id with no entry here — a planned one — is never reported.
 */
export const CAPABILITY_MODULES: Readonly<Record<string, string>> = {
  'static-frontend': '@rayspec/api-auth',
  'declarative-stores': '@rayspec/api-auth',
  'declarative-api': '@rayspec/api-auth',
  'stream-routes': '@rayspec/api-auth',
  'custom-handlers': '@rayspec/platform',
  extensions: '@rayspec/platform',
  'durable-workflow': '@rayspec/durable-dbos',
  'tenant-event-bus': '@rayspec/api-auth',
  'trigger-cron': '@rayspec/durable-dbos',
  'trigger-webhook': '@rayspec/api-auth',
  'trigger-event': '@rayspec/api-auth',
  'trigger-manual': '@rayspec/api-auth',
  'agent-backend-openai': '@rayspec/adapter-openai',
  'agent-backend-anthropic': '@rayspec/adapter-anthropic',
  'agent-backend-pi': '@rayspec/adapter-pi',
  'agent-backend-codex': '@rayspec/adapter-codex',
  audio_input: '@rayspec/audio-runtime',
  media_playback: '@rayspec/audio-runtime',
  conversation_input: '@rayspec/conversation-runtime',
  file_input: '@rayspec/product-yaml',
  record_input: '@rayspec/product-yaml',
  'stt-deepgram': '@rayspec/adapter-deepgram',
  'stt-fake': '@rayspec/stt-port',
  'tts-openai': '@rayspec/adapter-openai-tts',
  'tts-fake': '@rayspec/tts-port',
  'blob-store-fs': '@rayspec/platform',
};

const requireHere = createRequire(import.meta.url);

function defaultResolvesModule(specifier: string): boolean {
  try {
    requireHere.resolve(specifier);
    return true;
  } catch {
    return false;
  }
}

/** The capability ids this process provides, in vocabulary order. */
export function providedCapabilities(
  resolvesModule: (specifier: string) => boolean = defaultResolvesModule,
): string[] {
  return CAPABILITIES.filter((c) => {
    if (c.status !== 'available') return false;
    const module = CAPABILITY_MODULES[c.id];
    return module !== undefined && resolvesModule(module);
  }).map((c) => c.id);
}

// ─── environment state ─────────────────────────────────────────────────────────────────────────

interface ActiveGrants {
  execution: ExecutionLevel;
  egressHosts: string[];
  capabilities: string[];
}

interface EnvironmentState {
  environmentRevision: number;
  fence: { state: 'open' | 'fenced'; fenceEpoch: number };
  applicationId: string | null;
  applicationVersion: string | null;
  applicationDigest: string | null;
  activeGrants: ActiveGrants | null;
  appliedProductSchema: string | null;
}

const FRESH_ENVIRONMENT: EnvironmentState = {
  environmentRevision: 1,
  fence: { state: 'open', fenceEpoch: 0 },
  applicationId: null,
  applicationVersion: null,
  applicationDigest: null,
  activeGrants: null,
  appliedProductSchema: null,
};

function readGrants(value: unknown): ActiveGrants | null {
  if (typeof value !== 'object' || value === null) return null;
  const g = value as Record<string, unknown>;
  const strings = (v: unknown) =>
    Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null;
  const egress = strings(g.egressHosts);
  const caps = strings(g.capabilities);
  if (
    (g.execution !== 'none' && g.execution !== 'in-process' && g.execution !== 'sandboxed') ||
    egress === null ||
    caps === null
  ) {
    return null;
  }
  return { execution: g.execution, egressHosts: egress, capabilities: caps };
}

/** Read the state row; an environment no operation has touched yet reads as a fresh one. */
async function readEnvironmentState(query: CatalogQuery): Promise<EnvironmentState> {
  const present = await query(
    "SELECT to_regclass('public.runtime_control_state') IS NOT NULL AS present",
  );
  if (present[0]?.present !== true) return FRESH_ENVIRONMENT;
  const rows = await query(
    `SELECT environment_revision::text AS environment_revision, fence_state,
            fence_epoch::text AS fence_epoch, application_id, application_version,
            application_digest, active_grants, applied_product_schema
       FROM runtime_control_state WHERE id = 1`,
  );
  const row = rows[0];
  if (row === undefined) return FRESH_ENVIRONMENT;
  return {
    environmentRevision: Number(row.environment_revision),
    fence: {
      state: row.fence_state === 'fenced' ? 'fenced' : 'open',
      fenceEpoch: Number(row.fence_epoch),
    },
    applicationId: (row.application_id as string | null) ?? null,
    applicationVersion: (row.application_version as string | null) ?? null,
    applicationDigest: isSha256(row.application_digest) ? row.application_digest : null,
    activeGrants: readGrants(row.active_grants),
    appliedProductSchema: isSha256(row.applied_product_schema) ? row.applied_product_schema : null,
  };
}

// ─── the adapter ───────────────────────────────────────────────────────────────────────────────

/** Build the runtime-control adapter over one environment database. */
export function createRuntimeControl(options: RuntimeControlOptions): RuntimeControlAdapter {
  const now = options.now ?? (() => new Date());
  const query: CatalogQuery = async (sql, params = []) =>
    (await options.db.$client.unsafe(sql, params as never[])) as unknown as Record<
      string,
      unknown
    >[];

  return {
    async inspect(request: InspectRequest): Promise<ResultEnvelope<InspectData>> {
      const operation = 'runtime.inspect';
      const operationId = operationIdOf(request);
      const usage = checkRequestBase(request);
      if (usage.length > 0) return failed(operation, operationId, usage);

      let head: Awaited<ReturnType<typeof readSchemaHead>>;
      let state: EnvironmentState;
      try {
        head = await readSchemaHead(query);
        state = await readEnvironmentState(query);
      } catch {
        return failed(operation, operationId, [infraUnavailable()]);
      }
      if (head.state === 'unknown') {
        return failed(operation, operationId, [
          bundleError(
            'RAY_SCHEMA_DRIFT',
            'the database records a platform migration this runtime does not ship: it was migrated ' +
              'by a newer runtime',
          ),
        ]);
      }
      const receipt = options.managedReceiptSha256 ?? null;
      return succeeded(operation, operationId, {
        runtimeVersion: runtimeVersion(),
        target: {
          os: process.platform,
          arch: process.arch,
          nodeMajor: Number(process.versions.node.split('.')[0]),
        },
        nodeVersion: process.versions.node,
        contractVersion: CONTRACT_VERSION,
        capabilityVocabularyVersion: CAPABILITY_VOCABULARY_VERSION,
        capabilities: providedCapabilities(options.resolvesModule),
        executionLevels: V1_EXECUTION_LEVELS.filter(
          (l): l is 'none' | 'in-process' => l === 'none' || l === 'in-process',
        ),
        schemaHead: head.state === 'known' ? head.head : null,
        applicationId: state.applicationId,
        applicationVersion: state.applicationVersion,
        applicationDigest: state.applicationDigest,
        releaseManifestSha256: options.releaseManifestSha256 ?? null,
        // The managed posture is supported only by a release that ships its capability receipt.
        managedPosture: { supported: receipt !== null, receiptSha256: receipt },
        fence: state.fence,
        environmentRevision: state.environmentRevision,
      });
    },

    async prepare(request: PrepareRequest): Promise<ResultEnvelope<PrepareData>> {
      const operation = 'runtime.prepare';
      const operationId = operationIdOf(request);
      const usage = checkPrepareRequest(request);
      if (usage.length > 0) return failed(operation, operationId, usage);
      try {
        return await prepareBundle(request, operationId, options, query, now);
      } catch (err) {
        if (err instanceof InfraError) return failed(operation, operationId, [infraUnavailable()]);
        return failed(operation, operationId, [
          bundleError('RAY_INTERNAL', 'preparing the plan failed unexpectedly'),
        ]);
      }
    },
  };
}

/** A database read failed; reported as `RAY_INFRA_UNAVAILABLE` without its detail. */
class InfraError extends Error {}

async function guardedRead<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (err) {
    throw new InfraError('the environment database could not be read', { cause: err });
  }
}

// ─── prepare ───────────────────────────────────────────────────────────────────────────────────

/** Bytes of a detached signature file, one past its limit so an oversized file stays malformed. */
const SIGNATURE_READ_BYTES = 4097;

/** Read a detached signature next to the archive, without following a link; null when unreadable. */
async function readSignature(path: string): Promise<Buffer | null> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    if (!(await handle.stat()).isFile()) return null;
    const buffer = Buffer.alloc(SIGNATURE_READ_BYTES);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
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

/** The stores a spec materializes, with the conflict keys the product generator needs. */
function specStores(spec: BundleSpec): {
  stores: StoreSpec[];
  conflictKeys: ReturnType<typeof deriveConflictKeys> | undefined;
} {
  if (spec.kind === 'rayspec') return { stores: [...spec.spec.stores], conflictKeys: undefined };
  const capability = composeCapabilityStores(spec.spec);
  const derived = deriveProductStores(spec.spec, capability.names);
  const stores = [...capability.stores, ...derived.stores];
  return { stores, conflictKeys: deriveConflictKeys(spec.spec, stores) };
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

function difference(a: readonly string[], b: readonly string[]): string[] {
  const other = new Set(b);
  return [...new Set(a)].filter((x) => !other.has(x)).sort(compareCodePoints);
}

function databaseUrlWithName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

/**
 * The product tables a delta creates, learned by applying the platform chain and the delta to a
 * throwaway database on the shadow server and reading its catalog. The database is dropped on every
 * path out.
 */
async function tablesCreatedByDelta(shadowUrl: string, delta: string): Promise<ProductTable[]> {
  // Hex only, so the name is a safe identifier by construction.
  const name = `rayspec_plan_${randomBytes(8).toString('hex')}`;
  const admin = makeDb(databaseUrlWithName(shadowUrl, 'postgres'), 1);
  let scratch: Db | undefined;
  try {
    await admin.$client.unsafe(`CREATE DATABASE "${name}"`);
    scratch = makeDb(databaseUrlWithName(shadowUrl, name), 2);
    await applyMigrations(scratch);
    await scratch.$client.begin(async (tx) => {
      await tx.unsafe(delta.replace(/-->\s*statement-breakpoint/g, ''));
    });
    const scratchDb = scratch;
    return await readProductTables(
      async (sql, params = []) =>
        (await scratchDb.$client.unsafe(sql, params as never[])) as unknown as Record<
          string,
          unknown
        >[],
    );
  } finally {
    await scratch?.$client.end();
    await admin.$client.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
    await admin.$client.end();
  }
}

async function prepareBundle(
  request: PrepareRequest,
  operationId: string,
  options: RuntimeControlOptions,
  query: CatalogQuery,
  now: () => Date,
): Promise<ResultEnvelope<PrepareData>> {
  const operation = 'runtime.prepare';
  const refuse = (errors: BundleError[], warnings: BundleWarning[] = []) =>
    failed<PrepareData>(operation, operationId, errors, warnings);

  // The reader pipeline: the structural steps, then the digest the caller named, then admission,
  // the spec, the derived fields, the secret scan and the signature.
  const read = await inspectBundle(request.bundlePath, {
    operation: 'prepare',
    captureSpec: true,
    refuseLinks: true,
    ...(options.readerLimits !== undefined ? { limits: options.readerLimits } : {}),
  });
  if (!read.ok) return refuse(read.errors);
  const inspection = read.value;
  if (inspection.archiveSha256 !== request.bundleSha256) {
    return refuse([
      bundleError('RAY_DIGEST_MISMATCH', 'the bundle bytes do not hash to bundleSha256', {
        reason: 'bundle-sha256',
        path: '/bundleSha256',
      }),
    ]);
  }
  if (inspection.manifest.kind !== 'application') {
    return refuse([
      bundleError('RAY_USAGE', 'prepare takes an application bundle', { path: '/bundlePath' }),
    ]);
  }
  const manifest: ApplicationManifest = inspection.manifest;
  const capabilities = providedCapabilities(options.resolvesModule);
  const version = runtimeVersion();
  const admitted = checkRuntimeAdmission(manifest, {
    version,
    capabilities,
    targets: SUPPORTED_TARGETS,
    executionLevels: V1_EXECUTION_LEVELS,
  });
  if (!admitted.ok) return refuse(admitted.errors);
  if (inspection.specBytes === undefined) {
    return refuse([bundleError('RAY_INTERNAL', 'the spec bytes were not kept by the reader')]);
  }
  const parsed = parseBundleSpec(inspection.specBytes);
  if (!parsed.ok) return refuse(parsed.errors);
  const spec = parsed.value;
  const derivedErrors = checkDerivedFields(manifest, deriveManifestFields(spec));
  if (derivedErrors.length > 0) return refuse(derivedErrors);
  if (inspection.secretFindings.length > 0) {
    return refuse(
      inspection.secretFindings.map((f) =>
        bundleError('RAY_SECRET_DETECTED', `a payload file matches the secret scan: ${f.path}`, {
          path: f.path,
        }),
      ),
    );
  }
  const warnings: BundleWarning[] = [];
  if (inspection.signatureFile === 'present') {
    const signature = await readSignature(`${request.bundlePath}.sig`);
    if (signature === null) {
      return refuse([
        bundleError(
          'RAY_SIGNATURE_INVALID',
          'the signature file cannot be read as a regular file',
          {
            reason: 'malformed',
          },
        ),
      ]);
    }
    const verified = verifySignatureFile(
      inspection.archiveSha256,
      signature,
      options.trustedKeys ?? [],
    );
    if (!verified.ok) return refuse(verified.errors);
  } else {
    warnings.push({
      code: 'RAY_W_UNSIGNED',
      message: 'the bundle has no detached signature, so its origin is not established',
    });
  }

  // The live environment: schema head, state row and the product schema against the spec.
  const blockers: BundleError[] = [];
  const liveHead = await guardedRead(() => readSchemaHead(query));
  const state = await guardedRead(() => readEnvironmentState(query));
  const liveTables = await guardedRead(() => readProductTables(query));
  const liveProduct = productSchemaDigest(liveTables);
  const from: SchemaHead | null = liveHead.state === 'known' ? liveHead.head : null;
  if (liveHead.state === 'unknown') {
    blockers.push(
      bundleError(
        'RAY_SCHEMA_DRIFT',
        'the database records a platform migration this runtime does not ship: it was migrated by ' +
          'a newer runtime',
      ),
    );
  }
  if (liveHead.state !== 'unknown' && !sameSchemaHead(request.expectedSchemaHead, from)) {
    blockers.push(
      bundleError('RAY_PLAN_STALE', 'the live schema head is not the expected one', {
        path: '/expectedSchemaHead',
      }),
    );
  }

  const { stores, conflictKeys } = specStores(spec);
  const preDrift = await guardedRead(() =>
    detectDrift(stores, 'public', (sql, params) => query(sql, params)),
  );
  const schemaState = classifyProductSchema(stores, preDrift);
  let delta: string | null = null;
  let toProduct = liveProduct;
  // The product head the last apply recorded, when one did: a live head that differs from it was
  // changed outside apply, which the store-by-store comparison alone cannot see when the change
  // only ADDS (a column or a table the spec does not name).
  const changedOutsideApply =
    state.appliedProductSchema !== null && state.appliedProductSchema !== liveProduct;
  if (changedOutsideApply && schemaState !== 'drifted') {
    blockers.push(
      bundleError(
        'RAY_SCHEMA_DRIFT',
        'the live product schema changed since the last apply recorded it',
      ),
    );
  }
  if (schemaState === 'drifted') {
    blockers.push(
      state.appliedProductSchema !== null && state.appliedProductSchema === liveProduct
        ? bundleError(
            'RAY_MIGRATION_REQUIRED',
            'the live product schema is the one the last apply left, and the bundle needs a ' +
              'reviewed product delta from it',
          )
        : bundleError(
            'RAY_SCHEMA_DRIFT',
            'the live product schema matches neither the active application nor this bundle',
          ),
    );
  } else if (schemaState === 'absent') {
    delta = generateProductSql(stores, conflictKeys);
    if (options.shadowDatabaseUrl === undefined) {
      blockers.push(
        bundleError(
          'RAY_MIGRATION_REQUIRED',
          'the bundle creates product tables, and without a shadow database the schema head ' +
            'they produce cannot be computed',
        ),
      );
    } else {
      const shadowUrl = options.shadowDatabaseUrl;
      const created = await guardedRead(() => tablesCreatedByDelta(shadowUrl, delta as string));
      toProduct = productSchemaDigest([...liveTables, ...created]);
    }
  }
  if (manifest.productMigration !== undefined) {
    blockers.push(
      bundleError(
        'RAY_MIGRATION_REQUIRED',
        manifest.productMigration.fromProductSchemaDigest === liveProduct
          ? 'the bundle carries a product delta, which this runtime does not apply yet'
          : 'the bundle carries a product delta from a schema head that is not the live one',
        { path: '/productMigration' },
      ),
    );
  }
  const productDeltaSha256 = delta === null ? null : sha256(delta);
  const destructive = delta !== null && !scanMigrationSql(delta, []).pass;

  const revisions = new Map(request.bindingRevision.map((b) => [b.name, b.revisionId]));
  const requiredBindings = manifest.bindings.map((b) => ({
    name: b.name,
    kind: b.kind,
    required: b.required,
    satisfied: revisions.has(b.name),
  }));
  for (const [i, b] of manifest.bindings.entries()) {
    if (b.required && !revisions.has(b.name)) {
      blockers.push(
        bundleError('RAY_BINDING_MISSING', `the required binding ${b.name} has no revision`, {
          path: `/bindings/${i}`,
        }),
      );
    }
  }

  warnings.push({
    code: 'RAY_W_PRODUCT_SCHEMA_UNLEDGERED',
    message:
      'the product schema head was computed by introspection: no product migration ledger exists yet',
  });
  if (networkBackends(spec).length > 0 && manifest.permissions.egressHosts.length === 0) {
    warnings.push({
      code: 'RAY_W_EGRESS_UNDECLARED',
      message:
        'the spec calls a model provider but declares no egress hosts; host network policy will deny its calls',
    });
  }

  const active = state.activeGrants;
  const to: SchemaHead = { platform: runtimePlatformHead(), product: toProduct };
  const plan: DeploymentPlan = {
    bundleSha256: inspection.archiveSha256,
    applicationId: manifest.application.id,
    applicationVersion: manifest.application.version,
    requiredBindings,
    schemaImpact: { from, to, productDeltaSha256, destructive, allowlisted: false },
    permissionChanges: {
      executionFrom: active?.execution ?? null,
      executionTo: manifest.permissions.execution,
      egressAdded: difference(manifest.permissions.egressHosts, active?.egressHosts ?? []),
      egressRemoved: difference(active?.egressHosts ?? [], manifest.permissions.egressHosts),
      capabilitiesAdded: difference(manifest.requires, active?.capabilities ?? []),
      capabilitiesRemoved: difference(active?.capabilities ?? [], manifest.requires),
    },
    storageRequirements: {
      bundleBytes: inspection.archiveSize,
      extractedBytes: manifest.inventory.reduce((sum, e) => sum + e.size, 0),
    },
    blockers,
    warnings: [...warnings],
  };

  const preparedAt = formatTimestamp(now());
  const digest = planDigest({
    bundleSha256: plan.bundleSha256,
    releaseManifestSha256: options.releaseManifestSha256 ?? null,
    schemaHeadFrom: from,
    schemaHeadTo: to,
    productDeltaSha256,
    bindingRevisions: request.bindingRevision,
    grants: {
      execution: manifest.permissions.execution,
      egressHosts: manifest.permissions.egressHosts,
      capabilities: manifest.requires,
    },
    environmentRevision: state.environmentRevision,
    preparedAt,
  });
  return succeeded(
    operation,
    operationId,
    {
      plan,
      planDigest: digest,
      preparedAt,
      expiresAt: planExpiresAt(preparedAt),
      environmentRevision: state.environmentRevision,
    },
    warnings,
  );
}
