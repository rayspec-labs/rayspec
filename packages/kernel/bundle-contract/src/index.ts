/**
 * @rayspec/bundle-contract — the contract of RaySpec application bundles (`.ray`), encrypted
 * migration snapshots and the managed hosting receipt, carried in code.
 *
 * It holds the committed JSON Schemas and vocabularies, their TypeScript shapes and the canonical
 * JSON form.
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
  CONTRACT_SCHEMAS,
  type ContractSchemaName,
  failingPointer,
  schemaValidator,
} from './schemas.js';
export type * from './types.js';
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
  type ManagedPosture,
  MIGRATION_CIPHERTEXT_PATH,
  NOTICES_PATH,
  PLATFORM_GRANTABLE_BINDINGS,
  type PlatformGrantableBinding,
  RESERVED_BINDING_NAMES,
  RESERVED_BINDING_PREFIXES,
  type ReaderLimits,
  resolveReaderLimits,
  SBOM_PATH,
  SUPPORTED_TARGETS,
  type Target,
  V1_EXECUTION_LEVELS,
} from './vocabulary.js';
