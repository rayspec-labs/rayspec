/**
 * The fixed vocabularies of the bundle contract: the contract version, capability ids, reserved
 * binding names, reader limits, supported targets, execution levels, snapshot data categories,
 * result operations and quiesce barriers.
 *
 * Each constant restates one committed contract file (`contract/capabilities.json`,
 * `contract/reserved-bindings.json`, `contract/fixtures/EXPECTATIONS.json`,
 * `contract/snapshot.schema.json`, `contract/cli-verbs.json`); `vocabulary.test.ts` holds them
 * equal, so a contract change that is not carried here fails the suite.
 */

/** The contract version every artifact, envelope and request states. */
export const CONTRACT_VERSION = '1.0.0-rc.2';

// ─── capabilities ──────────────────────────────────────────────────────────────────────────────

/** The capability vocabulary version; it increments when ids are added. */
export const CAPABILITY_VOCABULARY_VERSION = 1;

export type CapabilityStatus = 'available' | 'planned';
export type ManagedPosture = 'allowed' | 'self-host-only' | 'test-only';

export interface Capability {
  id: string;
  /** `available` in the runtime of this release, or `planned` for a later one. */
  status: CapabilityStatus;
  /** Whether a bundle may list the id in `requires`; runtime-provided ids cannot be required. */
  requirableByBundle: boolean;
  /** Whether the id may be deployed under the managed hosting posture. */
  managedPosture: ManagedPosture;
}

/** Every capability id. An id never changes meaning; a changed meaning gets a new id. */
export const CAPABILITIES: readonly Capability[] = [
  {
    id: 'static-frontend',
    status: 'available',
    requirableByBundle: true,
    managedPosture: 'allowed',
  },
  {
    id: 'declarative-stores',
    status: 'available',
    requirableByBundle: true,
    managedPosture: 'allowed',
  },
  {
    id: 'declarative-api',
    status: 'available',
    requirableByBundle: true,
    managedPosture: 'allowed',
  },
  { id: 'stream-routes', status: 'available', requirableByBundle: true, managedPosture: 'allowed' },
  {
    id: 'custom-handlers',
    status: 'available',
    requirableByBundle: true,
    managedPosture: 'allowed',
  },
  { id: 'extensions', status: 'available', requirableByBundle: true, managedPosture: 'allowed' },
  {
    id: 'durable-workflow',
    status: 'available',
    requirableByBundle: true,
    managedPosture: 'allowed',
  },
  {
    id: 'tenant-event-bus',
    status: 'available',
    requirableByBundle: true,
    managedPosture: 'allowed',
  },
  { id: 'trigger-cron', status: 'available', requirableByBundle: true, managedPosture: 'allowed' },
  {
    id: 'trigger-webhook',
    status: 'available',
    requirableByBundle: true,
    managedPosture: 'allowed',
  },
  { id: 'trigger-event', status: 'available', requirableByBundle: true, managedPosture: 'allowed' },
  {
    id: 'trigger-manual',
    status: 'available',
    requirableByBundle: true,
    managedPosture: 'allowed',
  },
  {
    id: 'agent-backend-openai',
    status: 'available',
    requirableByBundle: true,
    managedPosture: 'allowed',
  },
  {
    id: 'agent-backend-anthropic',
    status: 'available',
    requirableByBundle: true,
    managedPosture: 'self-host-only',
  },
  {
    id: 'agent-backend-pi',
    status: 'available',
    requirableByBundle: true,
    managedPosture: 'self-host-only',
  },
  {
    id: 'agent-backend-codex',
    status: 'available',
    requirableByBundle: true,
    managedPosture: 'self-host-only',
  },
  { id: 'audio_input', status: 'available', requirableByBundle: true, managedPosture: 'allowed' },
  {
    id: 'media_playback',
    status: 'available',
    requirableByBundle: true,
    managedPosture: 'allowed',
  },
  {
    id: 'conversation_input',
    status: 'available',
    requirableByBundle: true,
    managedPosture: 'allowed',
  },
  { id: 'file_input', status: 'available', requirableByBundle: true, managedPosture: 'allowed' },
  { id: 'record_input', status: 'available', requirableByBundle: true, managedPosture: 'allowed' },
  { id: 'stt-deepgram', status: 'available', requirableByBundle: false, managedPosture: 'allowed' },
  { id: 'stt-fake', status: 'available', requirableByBundle: false, managedPosture: 'test-only' },
  { id: 'tts-openai', status: 'available', requirableByBundle: false, managedPosture: 'allowed' },
  { id: 'tts-fake', status: 'available', requirableByBundle: false, managedPosture: 'test-only' },
  {
    id: 'blob-store-fs',
    status: 'available',
    requirableByBundle: false,
    managedPosture: 'allowed',
  },
  {
    id: 'extraction-deterministic',
    status: 'available',
    requirableByBundle: false,
    managedPosture: 'test-only',
  },
];

const CAPABILITY_BY_ID = new Map(CAPABILITIES.map((c) => [c.id, c]));

/** The vocabulary entry of an id, or undefined for an id the vocabulary does not know. */
export function capability(id: string): Capability | undefined {
  return CAPABILITY_BY_ID.get(id);
}

// ─── bindings ──────────────────────────────────────────────────────────────────────────────────

/** A binding name: an environment variable name. */
export const BINDING_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;

/**
 * Names only the operator supplies. They include the `_FILE` variant of every platform-grantable
 * name, because such a variant names a host path.
 */
export const RESERVED_BINDING_NAMES: readonly string[] = [
  'DATABASE_URL',
  'DATABASE_URL_FILE',
  'DBOS_SYSTEM_DATABASE_URL',
  'SHADOW_DATABASE_URL',
  'MIGRATE_CLEAN_URL',
  'DRYRUN_PRODUCT_URL',
  'PORT',
  'ALLOWED_ORIGINS',
  'ALLOWED_REQUEST_HEADERS',
  'OIDC_ISSUER',
  'STT_PROVIDER',
  'TTS_PROVIDER',
  'OPENAI_BASE_URL',
  'DEEPGRAM_BASE_URL',
  'CODEX_HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'TMPDIR',
  'TZ',
  'LANG',
  'CI',
  'ALL_PROXY',
  'BASH_ENV',
  'GLIBC_TUNABLES',
  'OPENSSL_CONF',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'CLOUD_PROVIDER_TOKEN',
  'OPENAI_API_KEY_FILE',
  'ANTHROPIC_API_KEY_FILE',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE',
  'CODEX_API_KEY_FILE',
  'DEEPGRAM_API_KEY_FILE',
];

/** Every name starting with one of these is reserved as well, unless it is platform-grantable. */
export const RESERVED_BINDING_PREFIXES: readonly string[] = [
  'RAYSPEC_',
  'DBOS_',
  'PG',
  'NODE_',
  'NPM_',
  'LD_',
  'DYLD_',
  'CLOUD_',
  'OPENAI_AGENTS_',
  'OTEL_',
  'ANTHROPIC_',
  'CLAUDE_',
];

export interface PlatformGrantableBinding {
  name: string;
  kind: 'secret';
  /** The reserved, operator-only variant that names a file holding the value. */
  fileVariant: string;
}

/**
 * The only names the platform itself reads from application bindings. Every other valid,
 * unreserved name is application-defined: the platform never reads it.
 */
export const PLATFORM_GRANTABLE_BINDINGS: readonly PlatformGrantableBinding[] = [
  { name: 'OPENAI_API_KEY', kind: 'secret', fileVariant: 'OPENAI_API_KEY_FILE' },
  { name: 'ANTHROPIC_API_KEY', kind: 'secret', fileVariant: 'ANTHROPIC_API_KEY_FILE' },
  { name: 'CLAUDE_CODE_OAUTH_TOKEN', kind: 'secret', fileVariant: 'CLAUDE_CODE_OAUTH_TOKEN_FILE' },
  { name: 'CODEX_API_KEY', kind: 'secret', fileVariant: 'CODEX_API_KEY_FILE' },
  { name: 'DEEPGRAM_API_KEY', kind: 'secret', fileVariant: 'DEEPGRAM_API_KEY_FILE' },
];

const RESERVED_EXACT = new Set(RESERVED_BINDING_NAMES);
const GRANTABLE = new Set(PLATFORM_GRANTABLE_BINDINGS.map((b) => b.name));

/**
 * Whether a binding name is reserved for the operator: equal to a reserved name, or starting with
 * a reserved prefix without being platform-grantable, compared byte for byte. The exemption keeps
 * `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` grantable under the `ANTHROPIC_` and `CLAUDE_`
 * prefixes.
 */
export function isReservedBindingName(name: string): boolean {
  if (RESERVED_EXACT.has(name)) return true;
  return !GRANTABLE.has(name) && RESERVED_BINDING_PREFIXES.some((p) => name.startsWith(p));
}

// ─── limits and targets ────────────────────────────────────────────────────────────────────────

/** Reader limits. They may be configured downward; raising one needs load and security evidence. */
export interface ReaderLimits {
  /** Application archive bytes. */
  archiveBytes: number;
  /** Migration archive bytes. */
  migrationArchiveBytes: number;
  /** Cumulative extracted bytes of an application bundle. */
  extractedBytes: number;
  /** Cumulative extracted bytes of a migration bundle. */
  migrationExtractedBytes: number;
  /** Archive entries, `ray.json` included, so an inventory holds at most one fewer. */
  entryCount: number;
  /** Bytes of `ray.json`. */
  manifestBytes: number;
  /** Bytes of `snapshot.json` inside a migration. */
  snapshotBytes: number;
  /** Bytes of a managed receipt. */
  receiptBytes: number;
  /** Bytes of one entry name. */
  pathBytes: number;
  /** Nested containers of a JSON document. */
  jsonDepth: number;
}

export const DEFAULT_READER_LIMITS: Readonly<ReaderLimits> = {
  archiveBytes: 512 * 1024 * 1024,
  migrationArchiveBytes: 2 * 1024 * 1024 * 1024,
  extractedBytes: 512 * 1024 * 1024,
  migrationExtractedBytes: 2 * 1024 * 1024 * 1024,
  entryCount: 10_000,
  manifestBytes: 1024 * 1024,
  snapshotBytes: 4 * 1024 * 1024,
  receiptBytes: 4 * 1024 * 1024,
  pathBytes: 4096,
  jsonDepth: 64,
};

/** Merge caller limits over the defaults, refusing any attempt to raise a limit. */
export function resolveReaderLimits(overrides: Partial<ReaderLimits> = {}): ReaderLimits {
  const limits: ReaderLimits = { ...DEFAULT_READER_LIMITS };
  for (const key of Object.keys(DEFAULT_READER_LIMITS) as (keyof ReaderLimits)[]) {
    const value = overrides[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 0 || value > DEFAULT_READER_LIMITS[key]) {
      throw new RangeError(`reader limit ${key} must be an integer from 0 to its default`);
    }
    limits[key] = value;
  }
  return limits;
}

export interface Target {
  os: string;
  arch: string;
  nodeMajor: number;
}

/** The targets a v1 runtime supports. The schema accepts any well-formed target. */
export const SUPPORTED_TARGETS: readonly Target[] = [{ os: 'linux', arch: 'x64', nodeMajor: 22 }];

export type ExecutionLevel = 'none' | 'in-process' | 'sandboxed';

/**
 * `none`: declarative only, no custom code. `in-process`: trusted compiled handlers or extensions
 * imported into the runtime process with full Node access. `sandboxed`: reserved for a future
 * isolated executor; no v1 runtime provides it.
 */
export const EXECUTION_LEVELS: readonly ExecutionLevel[] = ['none', 'in-process', 'sandboxed'];

/** The execution levels a v1 runtime provides. */
export const V1_EXECUTION_LEVELS: readonly ExecutionLevel[] = ['none', 'in-process'];

// ─── result envelope ───────────────────────────────────────────────────────────────────────────

/** Every `operation` a result envelope may name: the CLI verbs and the runtime-control operations. */
export const RESULT_OPERATIONS = [
  'pack',
  'bundle.inspect',
  'bundle.verify',
  'bundle.sign',
  'deploy.dry-run',
  'deploy',
  'export',
  'import.dry-run',
  'import',
  'resume',
  'runtime.inspect',
  'runtime.prepare',
  'runtime.quiesce',
  'runtime.apply',
  'runtime.health',
  'runtime.resume',
  'init',
  'doctor',
  'plan',
  'openapi',
  'gen-handler',
  'deploy.legacy',
  'tenant.ensure',
  'dev.gen-secrets',
  'dev.db',
  'dev.bootstrap-tenant',
  'version',
  'help',
] as const;

export type ResultOperation = (typeof RESULT_OPERATIONS)[number];

/** The write barriers a quiesce reports: one for the database, one for objects. */
export const QUIESCE_BARRIERS = [
  'database-write-role',
  'database-stopped-source',
  'object-writes',
] as const;

export type QuiesceBarrier = (typeof QUIESCE_BARRIERS)[number];

// ─── snapshot categories ───────────────────────────────────────────────────────────────────────

export type DataCategory =
  | 'identity-and-tenancy'
  | 'credential-state'
  | 'request-replay-state'
  | 'run-history'
  | 'security-audit-log'
  | 'application-event-log'
  | 'platform-migration-ledger'
  | 'runtime-control-state'
  | 'product-store-data'
  | 'workflow-system-state'
  | 'blob-objects';

export const DATA_CATEGORIES: readonly DataCategory[] = [
  'identity-and-tenancy',
  'credential-state',
  'request-replay-state',
  'run-history',
  'security-audit-log',
  'application-event-log',
  'platform-migration-ledger',
  'runtime-control-state',
  'product-store-data',
  'workflow-system-state',
  'blob-objects',
];

/** Categories every snapshot excludes, whatever the run-history policy. */
export const ALWAYS_EXCLUDED_DATA_CATEGORIES: readonly DataCategory[] = [
  'credential-state',
  'request-replay-state',
  'security-audit-log',
  'runtime-control-state',
];

/** The two paths every application bundle carries. */
export const SBOM_PATH = 'payload/sbom.cdx.json';
export const NOTICES_PATH = 'payload/THIRD-PARTY-NOTICES.txt';

/** The one inventory path of a migration bundle. */
export const MIGRATION_CIPHERTEXT_PATH = 'payload/migration.age';

// ─── the inner snapshot archive ────────────────────────────────────────────────────────────────

/** The root document of the inner snapshot archive, the one entry outside `payload/`. */
export const SNAPSHOT_ROOT_NAME = 'snapshot.json';

/** The fixed inventory paths of the inner snapshot archive. */
export const SNAPSHOT_PATHS = {
  application: 'payload/application.ray',
  database: 'payload/database.dump',
  workflowSystem: 'payload/workflow-system.dump',
  objectIndex: 'payload/object-index.json',
  objects: 'payload/objects.bin',
} as const;

/** The most objects one object index lists (snapshot.schema.json `$defs/objectIndex`). */
export const MAX_SNAPSHOT_OBJECTS = 500_000;

/** The most `tableCounts` entries one `snapshot.json` carries. */
export const MAX_SNAPSHOT_TABLE_COUNTS = 10_000;

/** The largest size, offset or inventory entry a snapshot document can state. */
export const MAX_SNAPSHOT_ENTRY_BYTES = 4_294_967_294;
