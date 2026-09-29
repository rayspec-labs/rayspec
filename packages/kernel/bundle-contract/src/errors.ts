/**
 * The closed error vocabulary of the bundle contract (`contract/error-codes.json`).
 *
 * Every code carries one exit class and one retryable flag, and a code with reasons accepts only the
 * reasons listed here. Codes are append-only: a code never changes its meaning, exit class or
 * retryable flag within a contract major. `vocabulary.test.ts` holds this table equal to the
 * committed JSON, so the two cannot drift apart.
 */

export const ERROR_CODES = {
  RAY_USAGE: { exit: 2, retryable: false, reasons: [] },
  RAY_INTERNAL: { exit: 7, retryable: false, reasons: [] },
  RAY_CHECK_FAILED: { exit: 1, retryable: false, reasons: [] },
  RAY_INVALID_ARCHIVE: {
    exit: 2,
    retryable: false,
    reasons: [
      'not-a-zip',
      'leading-data',
      'trailing-data',
      'archive-comment',
      'multi-disk',
      'zip64',
      'entry-comment',
      'extra-field',
      'general-purpose-flag',
      'encrypted-entry',
      'data-descriptor',
      'unsupported-compression',
      'unsupported-version-needed',
      'non-canonical-timestamp',
      'non-canonical-mode',
      'symlink',
      'special-file',
      'directory-entry',
      'invalid-name-encoding',
      'non-ascii-name',
      'absolute-path',
      'drive-or-unc-path',
      'backslash',
      'nul-in-name',
      'empty-segment',
      'dot-segment',
      'outside-payload',
      'duplicate-name',
      'case-fold-collision',
      'normalization-collision',
      'path-prefix-collision',
      'entry-order',
      'header-directory-mismatch',
      'overlapping-entries',
      'crc-mismatch',
      'manifest-missing',
      'undeclared-entry',
      'missing-entry',
    ],
  },
  RAY_LIMIT_EXCEEDED: {
    exit: 2,
    retryable: false,
    reasons: [
      'archive-size',
      'extracted-size',
      'entry-count',
      'entry-size',
      'manifest-size',
      'snapshot-size',
      'receipt-size',
      'path-length',
      'json-depth',
      'time-budget',
      'ciphertext-size',
      'object-index-size',
      'migration-size',
    ],
  },
  RAY_DIGEST_MISMATCH: {
    exit: 2,
    retryable: false,
    reasons: [
      'entry-size',
      'entry-sha256',
      'ciphertext-size',
      'ciphertext-sha256',
      'inner-metadata',
      'application-digest',
      'object-sha256',
      'object-range',
      'schema-head',
      'bundle-sha256',
    ],
  },
  RAY_MANIFEST_INVALID: {
    exit: 2,
    retryable: false,
    reasons: [
      'invalid-utf8',
      'bom',
      'invalid-json',
      'duplicate-key',
      'float',
      'non-nfc',
      'not-canonical',
      'schema',
      'inventory-unsorted',
      'inventory-duplicate',
      'spec-not-in-inventory',
      'binding-duplicate',
      'execution-mismatch',
      'requires-mismatch',
      'permissions-mismatch',
      'closure-files-missing',
      'product-migration-files-missing',
      'migration-inventory',
    ],
  },
  RAY_SPEC_INVALID: { exit: 1, retryable: false, reasons: [] },
  RAY_CLOSURE_INVALID: {
    exit: 2,
    retryable: false,
    reasons: [
      'unresolved-import',
      'escaping-link',
      'excluded-file',
      'native-module',
      'source-map-not-opted-in',
    ],
  },
  RAY_APPLICATION_IDENTITY_MISSING: { exit: 2, retryable: false, reasons: ['id', 'version'] },
  RAY_OUTPUT_EXISTS: { exit: 2, retryable: false, reasons: [] },
  RAY_SIGNATURE_INVALID: {
    exit: 4,
    retryable: false,
    reasons: ['malformed', 'mismatch', 'untrusted-key'],
  },
  RAY_RUNTIME_UNSUPPORTED: { exit: 3, retryable: false, reasons: [] },
  RAY_TARGET_UNSUPPORTED: { exit: 3, retryable: false, reasons: [] },
  RAY_CAPABILITY_UNSUPPORTED: {
    exit: 3,
    retryable: false,
    reasons: ['unknown-id', 'not-provided', 'execution-level'],
  },
  RAY_BINDING_RESERVED: { exit: 4, retryable: false, reasons: [] },
  RAY_BINDING_MISSING: { exit: 2, retryable: false, reasons: [] },
  RAY_BINDINGS_FILE_INSECURE: { exit: 4, retryable: false, reasons: [] },
  RAY_SECRET_DETECTED: { exit: 4, retryable: false, reasons: [] },
  RAY_MIGRATION_REQUIRED: { exit: 3, retryable: false, reasons: [] },
  RAY_MIGRATION_MISMATCH: { exit: 3, retryable: false, reasons: [] },
  RAY_SCHEMA_DRIFT: { exit: 6, retryable: false, reasons: [] },
  RAY_PLAN_STALE: { exit: 3, retryable: false, reasons: [] },
  RAY_IDEMPOTENCY_CONFLICT: { exit: 4, retryable: false, reasons: [] },
  RAY_LOCK_TIMEOUT: { exit: 5, retryable: true, reasons: [] },
  RAY_INFRA_UNAVAILABLE: { exit: 5, retryable: true, reasons: [] },
  RAY_TARGET_NOT_EMPTY: { exit: 4, retryable: false, reasons: [] },
  RAY_SOURCE_NOT_QUIESCENT: { exit: 5, retryable: true, reasons: [] },
  RAY_FENCE_MISMATCH: { exit: 4, retryable: false, reasons: [] },
  RAY_EXTERNAL_STATE_UNSUPPORTED: {
    exit: 3,
    retryable: false,
    reasons: [
      'uncontrolled-writer',
      'unsupported-blob-adapter',
      'unreconciled-effects',
      'unknown-table',
      'database-barrier-unavailable',
    ],
  },
  RAY_MULTI_TENANT_UNSUPPORTED: { exit: 3, retryable: false, reasons: [] },
  RAY_OWNER_RECOVERY_REQUIRED: { exit: 4, retryable: false, reasons: [] },
  RAY_DECRYPTION_FAILED: { exit: 2, retryable: false, reasons: [] },
  RAY_POLICY_DENIED: {
    exit: 4,
    retryable: false,
    reasons: [
      'plan-has-blockers',
      'fenced',
      'privileged-statement',
      'unsupported-extension',
      'unmapped-owner',
      'grant-refused',
      'posture-refused',
    ],
  },
  RAY_INTERRUPTED: { exit: 6, retryable: false, reasons: [] },
  RAY_RECONCILIATION_REQUIRED: { exit: 6, retryable: false, reasons: [] },
} as const satisfies Record<
  string,
  { exit: ExitCode; retryable: boolean; reasons: readonly string[] }
>;

/** A code of the closed vocabulary. */
export type BundleErrorCode = keyof typeof ERROR_CODES;

/** The reasons a given code accepts (never for a code that has none). */
export type ErrorReason<C extends BundleErrorCode = BundleErrorCode> =
  (typeof ERROR_CODES)[C]['reasons'][number];

/** The typed warnings. A warning never changes the exit code. */
export const WARNING_CODES = [
  'RAY_W_UNSIGNED',
  'RAY_W_PRODUCT_SCHEMA_UNLEDGERED',
  'RAY_W_EGRESS_UNDECLARED',
  'RAY_W_EXTERNAL_EFFECTS_UNFENCED',
  'RAY_W_LEGACY_OUTPUT',
] as const;

export type BundleWarningCode = (typeof WARNING_CODES)[number];

/**
 * Exit classes: 0 success; 1 completed with a negative verdict; 2 invalid input or usage;
 * 3 incompatibility; 4 policy refusal; 5 retryable infrastructure failure; 6 blocked, manual
 * reconciliation required; 7 unexpected internal error.
 */
export type ExitCode = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/**
 * A failing command exits with the class that comes first in this order among all its errors, so
 * a retryable exit (5) is reported only when no other class is present.
 */
export const EXIT_PRECEDENCE = [7, 6, 4, 3, 2, 1, 5] as const satisfies readonly ExitCode[];

/** The exit class of a spec error carried in an envelope as a `SPEC_` code. */
export const SPEC_CODE_EXIT = 1;

/** One entry of an envelope's `errors` list. */
export interface BundleError {
  code: BundleErrorCode | `SPEC_${string}`;
  reason?: string;
  path?: string;
  message: string;
  retryable: boolean;
}

/** One entry of an envelope's `warnings` list. */
export interface BundleWarning {
  code: BundleWarningCode | `SPEC_${string}`;
  path?: string;
  message: string;
}

export function isBundleErrorCode(code: string): code is BundleErrorCode {
  return Object.hasOwn(ERROR_CODES, code);
}

/** The exit class of one code. A `SPEC_` code exits 1; any other unknown code is internal (7). */
export function exitCodeOf(code: string): ExitCode {
  if (isBundleErrorCode(code)) return ERROR_CODES[code].exit;
  if (/^SPEC_[A-Z0-9_]+$/.test(code)) return SPEC_CODE_EXIT;
  return 7;
}

/**
 * The process exit for a result: 0 with no errors, otherwise the class of the first entry of
 * `EXIT_PRECEDENCE` that any error carries.
 */
export function exitCodeFor(errors: readonly { code: string }[]): ExitCode {
  if (errors.length === 0) return 0;
  const present = new Set(errors.map((e) => exitCodeOf(e.code)));
  for (const exit of EXIT_PRECEDENCE) if (present.has(exit)) return exit;
  return 7;
}

/**
 * The envelope code of a spec error or warning: `SPEC_` followed by the spec code in upper case
 * (`yaml_parse_error` becomes `SPEC_YAML_PARSE_ERROR`). The mapping is total and mechanical, so a
 * spec code added later maps without a contract change.
 */
export function specEnvelopeCode(specCode: string): `SPEC_${string}` {
  return `SPEC_${specCode.toUpperCase()}`;
}

/** Build one error entry; `retryable` always comes from the vocabulary, never from the caller. */
export function bundleError<C extends BundleErrorCode>(
  code: C,
  message: string,
  detail: { reason?: ErrorReason<C>; path?: string } = {},
): BundleError {
  const error: BundleError = { code, message, retryable: ERROR_CODES[code].retryable };
  if (detail.reason !== undefined) error.reason = detail.reason;
  if (detail.path !== undefined) error.path = detail.path;
  return error;
}
