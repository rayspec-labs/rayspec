/**
 * TypeScript shapes of the contract documents and operations: the bundle manifest (`ray.json`),
 * the snapshot root (`snapshot.json`) and its object index, the managed receipt, the release
 * manifest, detached signature files, the result envelope and the runtime-control operations.
 *
 * The JSON Schemas under `contract/` are the source of truth for the documents; these types
 * describe what a document that passed its validator looks like. Integers are safe integers,
 * timestamps are UTC RFC 3339 with `Z`, and digests are lowercase hex SHA-256.
 */
import type { BundleError, BundleWarning } from './errors.js';
import type {
  DataCategory,
  ExecutionLevel,
  QuiesceBarrier,
  ResultOperation,
  Target,
} from './vocabulary.js';

/** Lowercase hex SHA-256, `^[a-f0-9]{64}$`. */
export type Sha256 = string;
/** UTC RFC 3339 with `Z`, for example `2026-09-29T12:00:00Z`. */
export type Timestamp = string;

// ─── ray.json ──────────────────────────────────────────────────────────────────────────────────

export interface ApplicationIdentity {
  /** A stable package identifier, `^[a-z][a-z0-9-]{0,62}$`; not a cloud credential. */
  id: string;
  /** The application's own exact version. */
  version: string;
}

export interface InventoryEntry {
  /** An ASCII path under `payload/`. */
  path: string;
  size: number;
  sha256: Sha256;
}

export interface BindingDeclaration {
  /** An environment variable name; never a reserved one. */
  name: string;
  kind: 'secret' | 'config';
  required: boolean;
  description: string;
}

export interface Permissions {
  /** Lowercase DNS hostnames the application intends to call. Declarative; the host enforces. */
  egressHosts: string[];
  execution: ExecutionLevel;
}

export interface ProductMigration {
  fromProductSchemaDigest: Sha256;
  toProductSchemaDigest: Sha256;
  /** Under `payload/migrations/`, ending in `.sql`. */
  deltaPath: string;
  /** Under `payload/migrations/`, ending in `.json`. */
  allowlistPath?: string;
  /** Advisory only; the server's own scanner and the reviewed allowlist decide. */
  destructive: boolean;
}

interface ManifestBase {
  formatVersion: 1;
  application: ApplicationIdentity;
  /** The exact runtime version: never latest, a range or a version with build metadata. */
  runtime: { version: string };
  target: Target;
  inventory: InventoryEntry[];
}

export interface ApplicationManifest extends ManifestBase {
  kind: 'application';
  /** The spec inside the payload, a `.yaml` or `.yml` path listed in the inventory. */
  spec: string;
  /** Capability ids, derived from the spec by pack and re-derived by verify. */
  requires: string[];
  bindings: BindingDeclaration[];
  permissions: Permissions;
  productMigration?: ProductMigration;
}

export interface MigrationManifest extends ManifestBase {
  kind: 'migration';
  migration: { encryption: 'age-v1-x25519'; ciphertextPath: 'payload/migration.age' };
}

/** `ray.json`, the root manifest of a `.ray` bundle. */
export type RayManifest = ApplicationManifest | MigrationManifest;

/** A detached `.ray` provenance signature, by convention `<file>.ray.sig`. */
export interface BundleSignatureFile {
  signatureFormatVersion: 1;
  algorithm: 'ed25519';
  archiveSha256: Sha256;
  /** SHA-256 of the signer's public key in DER SubjectPublicKeyInfo form. */
  publicKeySha256: Sha256;
  /** Standard base64 of the 64-byte signature over `rayspec-ray-v1\nsha256:<archiveSha256>\n`. */
  signature: string;
}

// ─── snapshot.json ─────────────────────────────────────────────────────────────────────────────

/** The two-part schema head: the last platform migration tag and the product schema digest. */
export interface SchemaHead {
  platform: string;
  product: Sha256;
}

export interface IdentityPolicy {
  userIds: 'preserved';
  passwordHashes: 'preserved' | 'reset';
  sessions: 'reset';
  apiKeys: 'reset';
  invites: 'reset';
  oidcArtifacts: 'reset';
  jwtSigningKey: 'reissued';
  apiKeyPepper: 'reissued';
  mediaSigningKey: 'reissued';
  mediaPlaybackTokens: 'invalidated';
}

export interface TableCount {
  database: 'application' | 'workflow-system';
  schema: string;
  table: string;
  rows: number;
}

export type SnapshotInventoryPath =
  | 'payload/application.ray'
  | 'payload/database.dump'
  | 'payload/workflow-system.dump'
  | 'payload/object-index.json'
  | 'payload/objects.bin';

/** `snapshot.json`, the root of the encrypted inner snapshot archive. */
export interface Snapshot {
  snapshotFormatVersion: 1;
  sourceRuntime: string;
  exportToolVersion: string;
  applicationId: string;
  applicationVersion: string;
  /** SHA-256 of `payload/application.ray`. */
  applicationDigest: Sha256;
  schemaHead: SchemaHead;
  databaseMajor: number;
  fenceEpoch: number;
  capturedAt: Timestamp;
  applicationTenantCount: 1;
  workflowSystemDatabase: 'included' | 'absent';
  runHistoryPolicy: 'included' | 'excluded';
  identityPolicy: IdentityPolicy;
  tableCounts: TableCount[];
  objectCount: number;
  inventory: { path: SnapshotInventoryPath; size: number; sha256: Sha256 }[];
  excludedDataCategories: DataCategory[];
}

/** `payload/object-index.json` inside a snapshot. */
export interface ObjectIndex {
  objectIndexFormatVersion: 1;
  objects: {
    tenantId: string;
    key: string;
    contentType?: string;
    size: number;
    sha256: Sha256;
    storedOffset: number;
    storedSize: number;
    storedSha256: Sha256;
  }[];
}

// ─── managed receipt and release manifest ──────────────────────────────────────────────────────

/** The protections one runtime release was tested for under the managed hosting posture. */
export interface ManagedReceipt {
  receiptFormatVersion: 1;
  contractVersion: '1.0.0-rc.2';
  runtimeVersion: string;
  sourceCommit: string;
  releaseManifestSha256: Sha256;
  artifactSha256: Sha256;
  targets: { os: 'linux'; arch: 'x64'; nodeMajor: 22; nodeVersion: string }[];
  capabilityVocabularyVersion: 1;
  capabilities: string[];
  maxApplicationTenants: 1;
  singleTenantModeEnforced: true;
  publicHostingPosture: 'isolated-environment-v1';
  supportedBackends: 'openai'[];
  executionLevels: ('none' | 'in-process')[];
  databaseIsolation: 'dedicated-db-and-rls';
  databaseRoleSeparation: true;
  crossProcessCancellation: true;
  agentTraceExport: 'off';
  recoveryScopeEndpoint: 'authenticated' | 'disabled';
  trustedProxiesPinned: true;
  egressEnforcement: 'host-network-policy';
  evidence: { protection: string; reference: string; sha256: Sha256 }[];
  residualRisks: { risk: string; owner: string }[];
}

/** The signed release manifest: the release catalog of one RaySpec release. */
export interface ReleaseManifest {
  releaseManifestFormatVersion: 1;
  rayspecVersion: string;
  sourceCommit: string;
  /** SHA-256 of the published release identity manifest bytes. */
  identityManifestSha256: Sha256;
  targets: Target[];
  packages: { name: string; version: string; integrity: string }[];
  images: {
    target: Target;
    platform: string;
    nodeVersion: string;
    repository: string;
    /** `sha256:<hex>`, never a tag. */
    digest: string;
  }[];
}

/** The detached signature of a release manifest. */
export interface ReleaseSignatureFile {
  signatureFormatVersion: 1;
  algorithm: 'ed25519';
  releaseManifestSha256: Sha256;
  publicKeySha256: Sha256;
  /** Base64 of the signature over `rayspec-release-manifest-v1\nsha256:<releaseManifestSha256>\n`. */
  signature: string;
}

// ─── result envelope ───────────────────────────────────────────────────────────────────────────

interface ResultEnvelopeBase<T> {
  contractVersion: '1.0.0-rc.2';
  operation: ResultOperation;
  /** UUID v4: fresh per CLI invocation; echoed from the request by a runtime operation. */
  operationId: string;
  data: T | null;
  warnings: BundleWarning[];
}

/**
 * The one result shape of every new CLI verb and every runtime-control operation. `ok: true`
 * carries no errors; `ok: false` carries at least one, and `errors[0]` is the first failing check
 * in the operation's pipeline order.
 */
export type ResultEnvelope<T> =
  | (ResultEnvelopeBase<T> & { ok: true; errors: [] })
  | (ResultEnvelopeBase<T> & { ok: false; errors: [BundleError, ...BundleError[]] });

// ─── runtime-control operations ────────────────────────────────────────────────────────────────

/** Every runtime-control request carries these. */
export interface RequestBase {
  contractVersion: '1.0.0-rc.2';
  /** UUID v4 chosen by the caller and reused on retry. */
  operationId: string;
  /** Opaque, at most 256 characters, recorded in receipts; never a credential. */
  actor: string;
}

export interface BindingRevision {
  name: string;
  /** Never contains or reveals a value. */
  revisionId: string;
}

export type InspectRequest = RequestBase;

export interface InspectData {
  runtimeVersion: string;
  target: Target;
  nodeVersion: string;
  contractVersion: '1.0.0-rc.2';
  capabilityVocabularyVersion: 1;
  /** Every id this runtime provides. */
  capabilities: string[];
  executionLevels: ('none' | 'in-process')[];
  /** Null before the first migration. */
  schemaHead: SchemaHead | null;
  applicationId: string | null;
  applicationVersion: string | null;
  applicationDigest: Sha256 | null;
  /** Null for a runtime not installed from a signed release. */
  releaseManifestSha256: Sha256 | null;
  managedPosture: { supported: boolean; receiptSha256: Sha256 | null };
  /** `fenceEpoch` is 0 before the first fence. */
  fence: { state: 'open' | 'fenced'; fenceEpoch: number };
  environmentRevision: number;
}

export interface PrepareRequest extends RequestBase {
  bundleSha256: Sha256;
  /** An absolute path to a regular file the runtime can read, placed by the caller. */
  bundlePath: string;
  bindingRevision: BindingRevision[];
  expectedSchemaHead: SchemaHead | null;
}

export interface DeploymentPlan {
  bundleSha256: Sha256;
  applicationId: string;
  applicationVersion: string;
  requiredBindings: {
    name: string;
    kind: 'secret' | 'config';
    required: boolean;
    satisfied: boolean;
  }[];
  schemaImpact: {
    from: SchemaHead | null;
    to: SchemaHead;
    productDeltaSha256: Sha256 | null;
    destructive: boolean;
    allowlisted: boolean;
  };
  permissionChanges: {
    executionFrom: ExecutionLevel | null;
    executionTo: ExecutionLevel;
    egressAdded: string[];
    egressRemoved: string[];
    capabilitiesAdded: string[];
    capabilitiesRemoved: string[];
  };
  storageRequirements: { bundleBytes: number; extractedBytes: number };
  /** A plan with blockers is returned with `ok: true`; apply refuses it. */
  blockers: BundleError[];
  warnings: BundleWarning[];
}

export interface PrepareData {
  plan: DeploymentPlan;
  planDigest: Sha256;
  preparedAt: Timestamp;
  /** Always `preparedAt` plus 30 minutes. */
  expiresAt: Timestamp;
  environmentRevision: number;
}

export interface QuiesceRequest extends RequestBase {
  reason: string;
  deadline: Timestamp;
  /** The operator's attestation that every runtime process of the environment is stopped. */
  sourceStopped: boolean;
}

export interface QuiesceData {
  fenceEpoch: number;
  status: 'fenced' | 'timed-out';
  producers: { producer: string; state: 'stopped' | 'drained' | 'still-running' }[];
  barriers: { barrier: QuiesceBarrier; state: 'held' | 'unavailable' }[];
  /** External services the runtime cannot fence, named, never hidden. */
  unfencedExternal: string[];
}

/**
 * The request a supervisor sends to apply a prepared plan, checked by `checkApplyRequest`. The
 * runtime of this release runs apply as a library operation over the steps its deploy paths supply;
 * no adapter method takes this request, and the grant is not recorded.
 */
export interface ApplyRequest extends RequestBase {
  planDigest: Sha256;
  bundleSha256: Sha256;
  bundlePath: string;
  bindingRevision: BindingRevision[];
  preparedAt: Timestamp;
  expectedEnvironmentRevision: number;
  /** 16 to 128 characters of `[A-Za-z0-9_-]`. */
  idempotencyKey: string;
  grant: { approvedBy: string; approvedAt: Timestamp };
}

export interface ApplyData {
  status: 'applied' | 'already-applied';
  environmentRevision: number;
  receipts: {
    step: string;
    state: 'done' | 'skipped';
    startedAt: Timestamp;
    finishedAt: Timestamp;
    digest: Sha256 | null;
  }[];
}

export type HealthRequest = RequestBase;

export interface HealthData {
  live: boolean;
  ready: boolean;
  checks: {
    name: 'database' | 'schema' | 'bindings' | 'assets' | 'worker' | 'workflow-system-database';
    ok: boolean;
    /** Names a failing check's cause without secrets or topology. */
    detail: string | null;
  }[];
}

export interface ResumeRequest extends RequestBase {
  fenceEpoch: number;
}

export interface ResumeData {
  fenceEpoch: number;
  /** True when this call released the fence; false when it was already open at `fenceEpoch`. */
  released: boolean;
  environmentRevision: number;
}

/**
 * The runtime-control operations of the adapter, as a caller-side interface. Every result is an
 * envelope. Apply is a library operation with its own request (`runtime.apply`), and there is no
 * snapshot operation: the export verb captures under the fence its quiesce took.
 */
export interface RuntimeControl {
  inspect(request: InspectRequest): Promise<ResultEnvelope<InspectData>>;
  prepare(request: PrepareRequest): Promise<ResultEnvelope<PrepareData>>;
  quiesce(request: QuiesceRequest): Promise<ResultEnvelope<QuiesceData>>;
  health(request: HealthRequest): Promise<ResultEnvelope<HealthData>>;
  resume(request: ResumeRequest): Promise<ResultEnvelope<ResumeData>>;
}
