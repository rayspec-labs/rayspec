/**
 * THE RUNTIME-CONTROL ADAPTER — the typed library a deployment supervisor or the CLI calls to ask a
 * runtime what it is (`inspect`), what deploying a bundle onto its environment would do (`prepare`),
 * whether it is ready (`health`), and to fence and release its source (`quiesce`, `resume`). It adds
 * no HTTP route: a caller holds the environment's database connection and calls these functions in
 * process.
 *
 * `inspect`, `prepare` and `health` are READ-ONLY. They take no advisory lock and write nothing to
 * the environment's database; `prepare` stores no plan — `apply` receives every plan input again and
 * recomputes the digest. The one place `prepare` writes is a throwaway database on the shadow server,
 * created and dropped within the call, to learn the product schema head a delta would produce without
 * running the delta against the live database. `quiesce` and `resume` run under the operation lease
 * and write receipts (`fence-operations.ts`).
 *
 * Every result is the contract's result envelope with `operation` `runtime.inspect` or
 * `runtime.prepare`, echoing the request's `operationId`. No result carries a secret, a binding
 * value, a connection string, a host name or a file path.
 */
import { type KeyObject, randomUUID } from 'node:crypto';
import { constants, readFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { type BundleInspection, inspectBundle, verifySignatureFile } from '@rayspec/bundle';
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
  checkQuiesceRequest,
  checkRequestBase,
  checkResumeRequest,
  checkRuntimeAdmission,
  compareCodePoints,
  type DeploymentPlan,
  EMPTY_PRODUCT_SCHEMA_DIGEST,
  type ExecutionLevel,
  formatTimestamp,
  type HealthData,
  type HealthRequest,
  type InspectData,
  type InspectRequest,
  isSha256,
  isUuidV4,
  type PrepareData,
  type PrepareRequest,
  planDigest,
  planExpiresAt,
  type QuiesceData,
  type QuiesceRequest,
  type ReaderLimits,
  type ResultEnvelope,
  type ResultOperation,
  type ResumeData,
  type ResumeRequest,
  type RuntimeControl,
  type SchemaHead,
  SUPPORTED_TARGETS,
  sameSchemaHead,
  V1_EXECUTION_LEVELS,
  type ValidationResult,
} from '@rayspec/bundle-contract';
import { type Db, verifyTenantIsolation } from '@rayspec/db';
import {
  type ExecutionPolicy,
  type RunCancelPollSource,
  resolveExecutionPolicy,
  resolveRunCancelPoll,
} from '@rayspec/platform';
import {
  type DatabaseIsolationStatus,
  type HostingPosture,
  parseHostingPosture,
  parseSingleTenantMode,
  SINGLE_ROLE_ISOLATION,
} from './composition-root.js';
import {
  type FenceOperationOptions,
  healthOperation,
  quiesceOperation,
  resumeOperation,
} from './fence-operations.js';
import {
  declaredStoresOf,
  type ProductPlan,
  ProductPlanReadError,
  planProductSchema,
} from './product-schema-plan.js';
import { type CatalogQuery, readSchemaHead, runtimePlatformHead } from './schema-head.js';
import { SUPPORTED_BACKEND_MATRIX, type SupportedBackend } from './supported-backends.js';

/**
 * How this runtime is hosted, beside what `inspect()` reports: the contract's inspect result is a
 * closed shape with no member for it.
 */
export interface HostingReport {
  /** `RAYSPEC_HOSTING_POSTURE`. */
  hostingPosture: HostingPosture;
  /**
   * Whether a run executing in another worker process is reached by a cancellation: on when
   * `RAYSPEC_RUN_CANCEL_POLL_MS` sets an interval (`explicit`) or the posture is managed
   * (`hosting-posture`), off otherwise.
   */
  crossProcessCancellation: {
    enabled: boolean;
    pollIntervalMs: number | null;
    source: RunCancelPollSource;
  };
  /**
   * How many application tenants (organizations) the runtime holds, read from
   * `RAYSPEC_SINGLE_TENANT`: `singleTenantMode: true` with `maxApplicationTenants: 1`, or `false`
   * with `null` (no limit).
   */
  applicationTenants: {
    singleTenantMode: boolean;
    maxApplicationTenants: 1 | null;
  };
  /**
   * The execution policy this runtime enforces (execution-policy.ts in @rayspec/platform): each bound
   * with its value (null ⇒ no bound) and where it came from.
   */
  executionPolicy: ExecutionPolicy;
  /**
   * The supported-backend matrix (supported-backends.ts): per backend, whether the managed posture
   * runs it and how its calls are bounded and stopped.
   */
  supportedBackends: readonly SupportedBackend[];
  /**
   * Who enforces the egress a bundle declares (`permissions.egressHosts`): the host network policy,
   * never this runtime. The platform's own requests to a URL it did not choose go through
   * `guardedFetch`, which refuses internal destinations; custom code is not bound by it.
   */
  egress: { enforcement: 'host-network-policy'; platformOutboundGuard: true };
}

/** The operations this adapter implements today, and the hosting report. */
export type RuntimeControlAdapter = Pick<
  RuntimeControl,
  'inspect' | 'prepare' | 'quiesce' | 'resume' | 'health'
> & {
  /** The hosting posture and the cross-process cancellation it implies; reads no database. */
  inspectHosting(): HostingReport;
  /**
   * The database isolation posture of the environment: `single-role` without `runtimeRole`; with it,
   * the posture check (`verifyTenantIsolation`) for that role, read from the catalog over `db`.
   */
  inspectDatabaseIsolation(): Promise<DatabaseIsolationStatus>;
};

export interface RuntimeControlOptions extends Omit<FenceOperationOptions, 'db'> {
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
  /** The environment the hosting report reads. Default: `process.env`. */
  env?: NodeJS.ProcessEnv;
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
}

const FRESH_ENVIRONMENT: EnvironmentState = {
  environmentRevision: 1,
  fence: { state: 'open', fenceEpoch: 0 },
  applicationId: null,
  applicationVersion: null,
  applicationDigest: null,
  activeGrants: null,
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
            application_digest, active_grants
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

  const databaseIsolation = async (): Promise<DatabaseIsolationStatus> => {
    if (options.runtimeRole === undefined) return SINGLE_ROLE_ISOLATION;
    const report = await verifyTenantIsolation(options.db.$client, { role: options.runtimeRole });
    return {
      mode: 'role-separated',
      active: report.active,
      runtimeRole: report.role,
      tenantTables: report.tenantTables,
      findings: report.findings,
    };
  };

  return {
    inspectDatabaseIsolation: databaseIsolation,

    inspectHosting(): HostingReport {
      const env = options.env ?? process.env;
      const poll = resolveRunCancelPoll(env);
      const singleTenantMode = parseSingleTenantMode(env);
      return {
        hostingPosture: parseHostingPosture(env),
        crossProcessCancellation: {
          enabled: poll.intervalMs !== undefined,
          pollIntervalMs: poll.intervalMs ?? null,
          source: poll.source,
        },
        applicationTenants: {
          singleTenantMode,
          maxApplicationTenants: singleTenantMode ? 1 : null,
        },
        executionPolicy: resolveExecutionPolicy(env),
        supportedBackends: SUPPORTED_BACKEND_MATRIX,
        egress: { enforcement: 'host-network-policy', platformOutboundGuard: true },
      };
    },

    async inspect(request: InspectRequest): Promise<ResultEnvelope<InspectData>> {
      const operation = 'runtime.inspect';
      const operationId = operationIdOf(request);
      const usage = checkRequestBase(request);
      if (usage.length > 0) return failed(operation, operationId, usage);

      let head: Awaited<ReturnType<typeof readSchemaHead>>;
      let state: EnvironmentState;
      let isolation: DatabaseIsolationStatus;
      try {
        head = await readSchemaHead(query);
        state = await readEnvironmentState(query);
        isolation = await databaseIsolation();
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
      // Single-tenant mode is part of the supported posture. An unreadable value (which a boot would
      // refuse) counts as off: the posture is never reported on a setting that does not parse.
      let singleTenantMode = false;
      try {
        singleTenantMode = parseSingleTenantMode(options.env ?? process.env);
      } catch {
        singleTenantMode = false;
      }
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
        // The managed posture is supported only by a release that ships its capability receipt, on an
        // environment whose database isolation (role separation and row-level security) is active
        // and whose runtime runs in single-tenant mode.
        managedPosture: {
          supported: receipt !== null && isolation.active && singleTenantMode,
          receiptSha256: receipt,
        },
        fence: state.fence,
        environmentRevision: state.environmentRevision,
      });
    },

    async quiesce(request: QuiesceRequest): Promise<ResultEnvelope<QuiesceData>> {
      const operationId = operationIdOf(request);
      const usage = checkQuiesceRequest(request);
      if (usage.length > 0) return failed('runtime.quiesce', operationId, usage);
      return quiesceOperation(request, operationId, options);
    },

    async resume(request: ResumeRequest): Promise<ResultEnvelope<ResumeData>> {
      const operationId = operationIdOf(request);
      const usage = checkResumeRequest(request);
      if (usage.length > 0) return failed('runtime.resume', operationId, usage);
      return resumeOperation(request, operationId, options);
    },

    async health(request: HealthRequest): Promise<ResultEnvelope<HealthData>> {
      const operationId = operationIdOf(request);
      const usage = checkRequestBase(request);
      if (usage.length > 0) return failed('runtime.health', operationId, usage);
      return healthOperation(request, operationId, options);
    },

    async prepare(request: PrepareRequest): Promise<ResultEnvelope<PrepareData>> {
      return (await preparePlan(request, options, { preparedAt: formatTimestamp(now()) })).envelope;
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

function difference(a: readonly string[], b: readonly string[]): string[] {
  const other = new Set(b);
  return [...new Set(a)].filter((x) => !other.has(x)).sort(compareCodePoints);
}

/** What the reader pipeline established about an application bundle, steps 1 to 17. */
export interface ReadApplicationBundle {
  inspection: BundleInspection;
  manifest: ApplicationManifest;
  spec: BundleSpec;
  /** `RAY_W_UNSIGNED` for a bundle without a signature. */
  warnings: BundleWarning[];
}

/** How `readApplicationBundle` reads a bundle. */
export interface ReadApplicationBundleOptions {
  /** The operation the read serves: the application archive limit applies to both. */
  operation: 'deploy' | 'prepare';
  /** The SHA-256 the caller names; different bytes are refused after reader step 9. */
  expectedSha256?: string;
  /** Keys a detached signature is verified against. */
  trustedKeys?: readonly KeyObject[];
  /** Refuse a bundle without a detached signature. */
  requireSignature?: boolean;
  readerLimits?: Partial<ReaderLimits>;
  resolvesModule?: (specifier: string) => boolean;
  /** Keep the product delta and allowlist bytes the manifest names. */
  captureProductMigration?: boolean;
}

/**
 * Read an application bundle through the reader pipeline, steps 1 to 17, in the contract's order:
 * the archive and manifest, the bytes against the inventory, the digest the caller named, the
 * runtime, target, capabilities and reserved bindings, the spec, the derived fields, the secret scan
 * and the signature. Opens no database and runs nothing from the archive. The archive is opened
 * without following a link.
 */
export async function readApplicationBundle(
  bundlePath: string,
  options: ReadApplicationBundleOptions,
): Promise<ValidationResult<ReadApplicationBundle>> {
  const refuse = (errors: BundleError[]) => ({ ok: false as const, errors });
  const read = await inspectBundle(bundlePath, {
    operation: options.operation,
    captureSpec: true,
    captureProductMigration: options.captureProductMigration === true,
    refuseLinks: true,
    ...(options.readerLimits !== undefined ? { limits: options.readerLimits } : {}),
  });
  if (!read.ok) return refuse(read.errors);
  const inspection = read.value;
  if (options.expectedSha256 !== undefined && inspection.archiveSha256 !== options.expectedSha256) {
    return refuse([
      bundleError('RAY_DIGEST_MISMATCH', 'the bundle bytes do not hash to bundleSha256', {
        reason: 'bundle-sha256',
        path: '/bundleSha256',
      }),
    ]);
  }
  if (inspection.manifest.kind !== 'application') {
    return refuse([
      bundleError('RAY_USAGE', `${options.operation} takes an application bundle`, {
        path: '/bundlePath',
      }),
    ]);
  }
  const manifest: ApplicationManifest = inspection.manifest;
  const admitted = checkRuntimeAdmission(manifest, {
    version: runtimeVersion(),
    capabilities: providedCapabilities(options.resolvesModule),
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
    const signature = await readSignature(`${bundlePath}.sig`);
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
  } else if (options.requireSignature === true) {
    return refuse([
      bundleError('RAY_SIGNATURE_INVALID', 'the bundle has no signature and one is required', {
        reason: 'malformed',
      }),
    ]);
  } else {
    warnings.push({
      code: 'RAY_W_UNSIGNED',
      message: 'the bundle has no detached signature, so its origin is not established',
    });
  }
  return { ok: true, value: { inspection, manifest, spec, warnings } };
}

/** How `preparePlan` prepares, beyond the request. */
export interface PreparePlanOptions {
  /** The time the plan is prepared at: now for a new plan, the plan's own time to recompute one. */
  preparedAt: string;
  /** Refuse a bundle without a detached signature. */
  requireSignature?: boolean;
  /**
   * The schema head the environment had before this process ran the platform chain that creates
   * the runtime-control tables, outside apply. It stands for the live head only while the live head
   * is exactly what that chain leaves behind: this runtime's platform head and an unchanged product
   * schema. Any other live head is used as it is, so a change made meanwhile makes the plan stale.
   */
  bootstrappedFrom?: { head: SchemaHead | null };
}

/** A prepared plan, with what the reader and the product planner established on the way. */
export interface PreparedPlan {
  envelope: ResultEnvelope<PrepareData>;
  /** Present when the plan was prepared. */
  bundle?: ReadApplicationBundle;
  /** Present when the plan was prepared. */
  product?: ProductPlan;
}

/**
 * Prepare a plan for a bundle: `prepare()` with the time it is prepared at named by the caller, so
 * `apply` can recompute the digest of a plan prepared earlier. Read-only against the environment.
 */
export async function preparePlan(
  request: PrepareRequest,
  options: RuntimeControlOptions,
  extra: PreparePlanOptions,
): Promise<PreparedPlan> {
  const operation = 'runtime.prepare';
  const operationId = operationIdOf(request);
  const usage = checkPrepareRequest(request);
  if (usage.length > 0) return { envelope: failed(operation, operationId, usage) };
  const query: CatalogQuery = async (sql, params = []) =>
    (await options.db.$client.unsafe(sql, params as never[])) as unknown as Record<
      string,
      unknown
    >[];
  try {
    return await prepareBundle(request, operationId, options, query, extra);
  } catch (err) {
    if (err instanceof InfraError) {
      return { envelope: failed(operation, operationId, [infraUnavailable()]) };
    }
    return {
      envelope: failed(operation, operationId, [
        bundleError('RAY_INTERNAL', 'preparing the plan failed unexpectedly'),
      ]),
    };
  }
}

async function prepareBundle(
  request: PrepareRequest,
  operationId: string,
  options: RuntimeControlOptions,
  query: CatalogQuery,
  extra: PreparePlanOptions,
): Promise<PreparedPlan> {
  const operation = 'runtime.prepare';
  const refuse = (errors: BundleError[], warnings: BundleWarning[] = []): PreparedPlan => ({
    envelope: failed<PrepareData>(operation, operationId, errors, warnings),
  });

  // The reader pipeline: the structural steps, then the digest the caller named, then admission,
  // the spec, the derived fields, the secret scan and the signature.
  const read = await readApplicationBundle(request.bundlePath, {
    operation: 'prepare',
    expectedSha256: request.bundleSha256,
    captureProductMigration: true,
    ...(options.trustedKeys !== undefined ? { trustedKeys: options.trustedKeys } : {}),
    ...(extra.requireSignature === true ? { requireSignature: true } : {}),
    ...(options.readerLimits !== undefined ? { readerLimits: options.readerLimits } : {}),
    ...(options.resolvesModule !== undefined ? { resolvesModule: options.resolvesModule } : {}),
  });
  if (!read.ok) return refuse(read.errors);
  const { inspection, manifest, spec } = read.value;
  const warnings: BundleWarning[] = [...read.value.warnings];

  // The live environment: schema head, state row, and the product change planned against the live
  // schema and the product migration ledger (product-schema-plan.ts).
  const blockers: BundleError[] = [];
  const liveHead = await guardedRead(() => readSchemaHead(query));
  const state = await guardedRead(() => readEnvironmentState(query));
  let from: SchemaHead | null = liveHead.state === 'known' ? liveHead.head : null;
  const bootstrapped = extra.bootstrappedFrom;
  if (
    bootstrapped !== undefined &&
    from !== null &&
    from.platform === runtimePlatformHead() &&
    from.product === (bootstrapped.head?.product ?? EMPTY_PRODUCT_SCHEMA_DIGEST)
  ) {
    from = bootstrapped.head;
  }
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

  const migrationFiles = inspection.productMigrationFiles;
  if (manifest.productMigration !== undefined && migrationFiles === undefined) {
    return refuse([bundleError('RAY_INTERNAL', 'the product delta was not kept by the reader')]);
  }
  let product: ProductPlan;
  try {
    product = await planProductSchema({
      query,
      declared: declaredStoresOf(spec),
      ...(manifest.productMigration !== undefined && migrationFiles !== undefined
        ? {
            migration: {
              manifest: manifest.productMigration,
              delta: migrationFiles.delta,
              ...(migrationFiles.allowlist === undefined
                ? {}
                : { allowlist: migrationFiles.allowlist }),
            },
          }
        : {}),
      ...(options.shadowDatabaseUrl === undefined
        ? {}
        : { shadowDatabaseUrl: options.shadowDatabaseUrl }),
    });
  } catch (err) {
    if (err instanceof ProductPlanReadError) throw new InfraError(err.message, { cause: err });
    throw err;
  }
  blockers.push(...product.blockers);
  warnings.push(...product.warnings);
  const productDeltaSha256 = product.productDeltaSha256;

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

  if (networkBackends(spec).length > 0 && manifest.permissions.egressHosts.length === 0) {
    warnings.push({
      code: 'RAY_W_EGRESS_UNDECLARED',
      message:
        'the spec calls a model provider but declares no egress hosts; host network policy will deny its calls',
    });
  }

  const active = state.activeGrants;
  const to: SchemaHead = { platform: runtimePlatformHead(), product: product.to };
  const plan: DeploymentPlan = {
    bundleSha256: inspection.archiveSha256,
    applicationId: manifest.application.id,
    applicationVersion: manifest.application.version,
    requiredBindings,
    schemaImpact: {
      from,
      to,
      productDeltaSha256,
      destructive: product.destructive,
      allowlisted: product.allowlisted,
    },
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

  const preparedAt = extra.preparedAt;
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
  return {
    envelope: succeeded(
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
    ),
    bundle: read.value,
    product,
  };
}
