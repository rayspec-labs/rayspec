/**
 * @rayspec/bundle-contract — the contract of RaySpec application bundles (`.ray`), encrypted
 * migration snapshots and the managed hosting receipt, carried in code.
 *
 * It holds the committed JSON Schemas and vocabularies, their TypeScript shapes, the canonical
 * JSON form, and validators that parse and check each document in the reader pipeline's order.
 * It also carries the pure rules of the runtime-control operations: request checks, the plan
 * digest and its expiry, the product schema digest, the shared schema lock key and the platform
 * tables with their snapshot categories.
 *
 * No I/O: it reads no file, opens no connection and knows no cloud provider. The committed
 * contract files ship beside the build under `contract/`, with `CONTRACT-LOCK.json` recording the
 * SHA-256 of each.
 */

export {
  CanonicalJsonError,
  canonicalJson,
  canonicalJsonFile,
  compareCodePoints,
  escapePointer,
  isCanonicalString,
  type JsonDocumentFailure,
  type JsonDocumentOptions,
  type JsonDocumentResult,
  MAX_JSON_DEPTH,
  parseJsonDocument,
} from './canonical-json.js';
export {
  type BundleError,
  type BundleErrorCode,
  type BundleWarning,
  type BundleWarningCode,
  bundleError,
  ERROR_CODES,
  type ErrorReason,
  EXIT_PRECEDENCE,
  type ExitCode,
  exitCodeFor,
  exitCodeOf,
  isBundleErrorCode,
  SPEC_CODE_EXIT,
  specEnvelopeCode,
  WARNING_CODES,
} from './errors.js';
export {
  CONTRACT_PLATFORM_TABLES,
  PLATFORM_TABLES,
  type PlatformTable,
  PRODUCT_LEDGER_TABLES,
  PUBLIC_PLATFORM_TABLE_NAMES,
  RUNTIME_CONTROL_TABLES,
} from './platform-tables.js';
export {
  BINDING_REVISION_KEY_BYTES,
  bindingRevisionId,
  checkApplyControl,
  checkApplyRequest,
  checkBindingRevisions,
  checkPrepareRequest,
  checkQuiesceRequest,
  checkRequestBase,
  checkResumeRequest,
  DEFAULT_SCHEMA_LOCK_TIMEOUT_MS,
  digestOf,
  EMPTY_PRODUCT_SCHEMA_DIGEST,
  formatTimestamp,
  IDEMPOTENCY_KEY_PATTERN,
  isIdempotencyKey,
  isPlanExpired,
  isSha256,
  isUuidV4,
  MAX_ACTOR_LENGTH,
  MAX_BINDING_REVISIONS,
  MAX_QUIESCE_REASON_LENGTH,
  normalizeProductSchema,
  PLAN_FORMAT_VERSION,
  PLAN_LIFETIME_MS,
  type PlanDigestInput,
  type PlanDigestInputs,
  type PlanGrants,
  PRODUCT_SCHEMA_FORMAT_VERSION,
  type ProductColumn,
  type ProductSchemaDescription,
  type ProductTable,
  parseTimestamp,
  planDigest,
  planDigestInput,
  planExpiresAt,
  productSchemaDigest,
  SCHEMA_LOCK_NAMESPACE,
  SCHEMA_LOCK_SLOT,
  sameSchemaHead,
  UNRELEASED_RUNTIME,
} from './runtime-control.js';
export {
  CONTRACT_SCHEMAS,
  type ContractSchemaName,
  failingPointer,
  schemaValidator,
} from './schemas.js';
export type * from './types.js';
export {
  checkRuntimeAdmission,
  type DocumentValidationOptions,
  type ManifestValidationOptions,
  type ObjectIndexValidationOptions,
  type RuntimeProfile,
  type ValidationResult,
  validateManifest,
  validateObjectIndex,
  validateReceipt,
  validateSnapshot,
} from './validate.js';
export {
  ALWAYS_EXCLUDED_DATA_CATEGORIES,
  BINDING_NAME_PATTERN,
  CAPABILITIES,
  CAPABILITY_VOCABULARY_VERSION,
  type Capability,
  type CapabilityStatus,
  CONTRACT_VERSION,
  capability,
  DATA_CATEGORIES,
  type DataCategory,
  DEFAULT_READER_LIMITS,
  EXECUTION_LEVELS,
  type ExecutionLevel,
  isReservedBindingName,
  MAX_SNAPSHOT_ENTRY_BYTES,
  MAX_SNAPSHOT_OBJECTS,
  MAX_SNAPSHOT_TABLE_COUNTS,
  type ManagedPosture,
  MIGRATION_CIPHERTEXT_PATH,
  NOTICES_PATH,
  PLATFORM_GRANTABLE_BINDINGS,
  type PlatformGrantableBinding,
  QUIESCE_BARRIERS,
  type QuiesceBarrier,
  RESERVED_BINDING_NAMES,
  RESERVED_BINDING_PREFIXES,
  RESULT_OPERATIONS,
  type ReaderLimits,
  type ResultOperation,
  resolveReaderLimits,
  SBOM_PATH,
  SNAPSHOT_PATHS,
  SNAPSHOT_ROOT_NAME,
  SUPPORTED_TARGETS,
  type Target,
  V1_EXECUTION_LEVELS,
} from './vocabulary.js';
