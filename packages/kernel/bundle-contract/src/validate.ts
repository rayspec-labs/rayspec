/**
 * Validators for the contract documents: `ray.json`, `snapshot.json` and the managed receipt, and
 * the runtime admission checks a bundle manifest must pass on a given runtime.
 *
 * Each validator takes the document bytes (or text), parses them under the canonical JSON rules,
 * validates the structure with the contract's JSON Schema, and then applies every rule the
 * contract states that a schema cannot express. The checks run in the order of the reader
 * pipeline, and the first failure is returned as `errors[0]` with a code (and reason) from the
 * closed vocabulary.
 *
 * The validators never throw on hostile input, read no file and load nothing at run time.
 * Messages never echo document content, not even a member name: the failing member is named by
 * `path` only, and only as far as its names are short printable ASCII (see `failingPointer`).
 */
import { compareCodePoints, parseJsonDocument } from './canonical-json.js';
import { type BundleError, type BundleErrorCode, bundleError, type ErrorReason } from './errors.js';
import { type ContractSchemaName, failingPointer, schemaValidator } from './schemas.js';
import type { ManagedReceipt, RayManifest, Snapshot } from './types.js';
import {
  capability,
  type ExecutionLevel,
  isReservedBindingName,
  MIGRATION_CIPHERTEXT_PATH,
  NOTICES_PATH,
  type ReaderLimits,
  resolveReaderLimits,
  SBOM_PATH,
  SUPPORTED_TARGETS,
  type Target,
  V1_EXECUTION_LEVELS,
} from './vocabulary.js';

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: BundleError[] };

export interface ManifestValidationOptions {
  /** Reader limits, lowered from the defaults. */
  limits?: Partial<ReaderLimits>;
  /**
   * The transfer size of the archive the manifest came from: a safe integer of 0 or more, else
   * `RAY_USAGE`. Once the schema has fixed the kind, a size above that kind's archive limit is
   * refused (`RAY_LIMIT_EXCEEDED` `archive-size`).
   */
  archiveSize?: number;
}

export interface DocumentValidationOptions {
  /**
   * Reader limits, lowered from the defaults; `jsonDepth` applies, and `snapshotBytes` to
   * `snapshot.json` or `receiptBytes` to the receipt.
   */
  limits?: Partial<ReaderLimits>;
}

/**
 * Validate `ray.json`: the manifest bytes, the schema, the archive limit of the kind and the
 * manifest semantics, in that order. The archive around the manifest is not read here.
 */
export function validateManifest(
  input: Uint8Array | string,
  options: ManifestValidationOptions = {},
): ValidationResult<RayManifest> {
  return guarded('ray.json', options, (limits) => {
    const archiveSize = options?.archiveSize;
    if (archiveSize !== undefined && !(Number.isSafeInteger(archiveSize) && archiveSize >= 0)) {
      return refuse('RAY_USAGE', 'the archive size is not an integer of 0 or more');
    }
    const parsed = parseDocument('ray.json', input, limits, {
      maxBytes: limits.manifestBytes,
      sizeReason: 'manifest-size',
      canonical: true,
    });
    if (!parsed.ok) return parsed;
    const structural = checkSchema<RayManifest>('ray.json', 'manifest', parsed.value);
    if (!structural.ok) return structural;
    const manifest = structural.value;
    const kindLimit =
      manifest.kind === 'migration' ? limits.migrationArchiveBytes : limits.archiveBytes;
    if (archiveSize !== undefined && archiveSize > kindLimit) {
      return refuse(
        'RAY_LIMIT_EXCEEDED',
        `the archive is larger than the ${manifest.kind} archive limit`,
        { reason: 'archive-size' },
      );
    }
    return checkManifestSemantics(manifest);
  });
}

function checkManifestSemantics(manifest: RayManifest): ValidationResult<RayManifest> {
  const inventory = checkInventoryOrder('ray.json', manifest.inventory);
  if (!inventory.ok) return inventory;
  const paths = new Set(manifest.inventory.map((e) => e.path));

  if (manifest.kind === 'migration') {
    if (paths.size !== 1 || !paths.has(MIGRATION_CIPHERTEXT_PATH)) {
      return refuse(
        'RAY_MANIFEST_INVALID',
        `a migration inventory lists exactly ${MIGRATION_CIPHERTEXT_PATH}`,
        { reason: 'migration-inventory', path: '/inventory' },
      );
    }
    return { ok: true, value: manifest };
  }

  if (!paths.has(manifest.spec)) {
    return refuse('RAY_MANIFEST_INVALID', 'the spec is not listed in the inventory', {
      reason: 'spec-not-in-inventory',
      path: '/spec',
    });
  }
  const names = new Set<string>();
  for (const [i, binding] of manifest.bindings.entries()) {
    if (names.has(binding.name)) {
      return refuse('RAY_MANIFEST_INVALID', 'a binding name is declared twice', {
        reason: 'binding-duplicate',
        path: `/bindings/${i}/name`,
      });
    }
    names.add(binding.name);
  }
  if (!paths.has(SBOM_PATH) || !paths.has(NOTICES_PATH)) {
    return refuse(
      'RAY_MANIFEST_INVALID',
      `an application inventory lists ${SBOM_PATH} and ${NOTICES_PATH}`,
      { reason: 'closure-files-missing', path: '/inventory' },
    );
  }
  const migration = manifest.productMigration;
  if (migration !== undefined) {
    const missing = !paths.has(migration.deltaPath)
      ? '/productMigration/deltaPath'
      : migration.allowlistPath !== undefined && !paths.has(migration.allowlistPath)
        ? '/productMigration/allowlistPath'
        : undefined;
    if (missing !== undefined) {
      return refuse('RAY_MANIFEST_INVALID', 'a product migration file is not in the inventory', {
        reason: 'product-migration-files-missing',
        path: missing,
      });
    }
  }
  return { ok: true, value: manifest };
}

/** Paths appear once and in strictly increasing byte order (code-point order equals it). */
function checkInventoryOrder(
  document: string,
  inventory: readonly { path: string }[],
): ValidationResult<void> {
  const seen = new Set<string>();
  for (const [i, entry] of inventory.entries()) {
    if (seen.has(entry.path)) {
      return refuse('RAY_MANIFEST_INVALID', `${document} lists an inventory path twice`, {
        reason: 'inventory-duplicate',
        path: `/inventory/${i}/path`,
      });
    }
    seen.add(entry.path);
  }
  for (let i = 1; i < inventory.length; i++) {
    if (compareCodePoints(inventory[i - 1]!.path, inventory[i]!.path) >= 0) {
      return refuse('RAY_MANIFEST_INVALID', `${document} inventory is not sorted by byte value`, {
        reason: 'inventory-unsorted',
        path: `/inventory/${i}/path`,
      });
    }
  }
  return { ok: true, value: undefined };
}

// ─── runtime admission ─────────────────────────────────────────────────────────────────────────

/** What a runtime provides, for the admission checks of a bundle manifest. */
export interface RuntimeProfile {
  /** The exact runtime version. */
  version: string;
  /** Every capability id the runtime provides (its `inspect()` list). */
  capabilities: readonly string[];
  /** The targets the runtime supports; the v1 target by default. */
  targets?: readonly Target[];
  /** The execution levels the runtime provides; `none` and `in-process` by default. */
  executionLevels?: readonly ExecutionLevel[];
}

/**
 * The admission checks of a validated manifest against one runtime, in pipeline order: the exact
 * runtime version, the target, each required capability (unknown, not provided, then the
 * execution level) and reserved binding names. A migration manifest is checked for runtime and
 * target only; its clear values are hints until import compares them with the inner metadata.
 *
 * The spec, the fields derived from it, the secret scan and the signature follow these checks and
 * need the payload, so they are not part of this function.
 */
export function checkRuntimeAdmission(
  manifest: RayManifest,
  runtime: RuntimeProfile,
): ValidationResult<RayManifest> {
  if (manifest.runtime.version !== runtime.version) {
    return refuse('RAY_RUNTIME_UNSUPPORTED', 'the bundle pins a different runtime version', {
      path: '/runtime/version',
    });
  }
  const targets = runtime.targets ?? SUPPORTED_TARGETS;
  const t = manifest.target;
  if (!targets.some((s) => s.os === t.os && s.arch === t.arch && s.nodeMajor === t.nodeMajor)) {
    return refuse('RAY_TARGET_UNSUPPORTED', 'this runtime does not support the bundle target', {
      path: '/target',
    });
  }
  if (manifest.kind === 'migration') return { ok: true, value: manifest };

  const provided = new Set(runtime.capabilities);
  for (const [i, id] of manifest.requires.entries()) {
    if (capability(id) === undefined) {
      return refuse('RAY_CAPABILITY_UNSUPPORTED', 'a required capability id is unknown', {
        reason: 'unknown-id',
        path: `/requires/${i}`,
      });
    }
    if (!provided.has(id)) {
      return refuse('RAY_CAPABILITY_UNSUPPORTED', 'this runtime does not provide a capability', {
        reason: 'not-provided',
        path: `/requires/${i}`,
      });
    }
  }
  const levels = runtime.executionLevels ?? V1_EXECUTION_LEVELS;
  if (!levels.includes(manifest.permissions.execution)) {
    return refuse(
      'RAY_CAPABILITY_UNSUPPORTED',
      'this runtime does not provide the execution level',
      {
        reason: 'execution-level',
        path: '/permissions/execution',
      },
    );
  }
  for (const [i, binding] of manifest.bindings.entries()) {
    if (isReservedBindingName(binding.name)) {
      return refuse(
        'RAY_BINDING_RESERVED',
        'the bundle declares a name reserved for the operator',
        {
          path: `/bindings/${i}/name`,
        },
      );
    }
  }
  return { ok: true, value: manifest };
}

// ─── snapshot.json and the managed receipt ─────────────────────────────────────────────────────

/**
 * Validate `snapshot.json`: canonical JSON bytes, the schema, then the inventory rules (each
 * fixed path once, sorted by byte value). Comparing its digests and identity with the embedded
 * application bundle and the outer manifest needs the decrypted archive and happens at import.
 */
export function validateSnapshot(
  input: Uint8Array | string,
  options: DocumentValidationOptions = {},
): ValidationResult<Snapshot> {
  return guarded('snapshot.json', options, (limits) => {
    const parsed = parseDocument('snapshot.json', input, limits, {
      maxBytes: limits.snapshotBytes,
      sizeReason: 'snapshot-size',
      canonical: true,
    });
    if (!parsed.ok) return parsed;
    const structural = checkSchema<Snapshot>('snapshot.json', 'snapshot', parsed.value);
    if (!structural.ok) return structural;
    const inventory = checkInventoryOrder('snapshot.json', structural.value.inventory);
    if (!inventory.ok) return inventory;
    return structural;
  });
}

/**
 * Validate a managed receipt: strict JSON (no duplicate keys, floats, non-NFC strings or unsafe
 * integers; canonical bytes are not required of a receipt), the schema, and then every listed
 * capability id against the vocabulary. The schema already refuses the ids the managed posture
 * does not allow; an id the vocabulary does not know is refused here.
 */
export function validateReceipt(
  input: Uint8Array | string,
  options: DocumentValidationOptions = {},
): ValidationResult<ManagedReceipt> {
  return guarded('the receipt', options, (limits) => {
    const parsed = parseDocument('the receipt', input, limits, {
      maxBytes: limits.receiptBytes,
      sizeReason: 'receipt-size',
      canonical: false,
    });
    if (!parsed.ok) return parsed;
    const structural = checkSchema<ManagedReceipt>('the receipt', 'managedReceipt', parsed.value);
    if (!structural.ok) return structural;
    for (const [i, id] of structural.value.capabilities.entries()) {
      if (capability(id) === undefined) {
        return refuse('RAY_CAPABILITY_UNSUPPORTED', 'the receipt lists an unknown capability id', {
          reason: 'unknown-id',
          path: `/capabilities/${i}`,
        });
      }
    }
    return structural;
  });
}

// ─── shared steps ──────────────────────────────────────────────────────────────────────────────

const JSON_FAILURE_MESSAGES: Record<string, string> = {
  'manifest-size': 'is larger than the manifest byte limit',
  'snapshot-size': 'is larger than the snapshot.json byte limit',
  'receipt-size': 'is larger than the receipt byte limit',
  'json-depth': 'nests deeper than the JSON depth limit',
  bom: 'starts with a byte order mark',
  'invalid-utf8': 'is not valid UTF-8',
  'invalid-json': 'is not valid JSON',
  'duplicate-key': 'repeats a key within one object',
  float: 'contains a number with a fraction or exponent',
  'non-nfc': 'contains a string that is not Unicode NFC',
  'not-canonical': 'is not in canonical JSON form',
};

interface DocumentRules {
  /** The byte limit of this document. */
  maxBytes: number;
  /** The reason a document above `maxBytes` is refused with. */
  sizeReason: 'manifest-size' | 'snapshot-size' | 'receipt-size';
  /** Whether the bytes must be canonical JSON. */
  canonical: boolean;
}

function parseDocument(
  document: string,
  input: unknown,
  limits: ReaderLimits,
  rules: DocumentRules,
): ValidationResult<unknown> {
  let bytes: Uint8Array;
  if (input instanceof Uint8Array) {
    bytes = input;
  } else if (typeof input === 'string') {
    // A lone surrogate has no UTF-8 form; encoding would silently replace it.
    if (/[\uD800-\uDFFF]/u.test(input)) {
      return refuse('RAY_MANIFEST_INVALID', `${document} is not valid UTF-8`, {
        reason: 'invalid-utf8',
      });
    }
    bytes = new TextEncoder().encode(input);
  } else {
    return refuse('RAY_MANIFEST_INVALID', `${document} is not a byte sequence or text`, {
      reason: 'invalid-json',
    });
  }
  const result = parseJsonDocument(bytes, {
    maxBytes: rules.maxBytes,
    maxDepth: limits.jsonDepth,
    canonical: rules.canonical,
  });
  if (result.ok) return result;
  const { code } = result.failure;
  const reason =
    result.failure.reason === 'manifest-size' ? rules.sizeReason : result.failure.reason;
  return {
    ok: false,
    errors: [
      bundleError(code, `${document} ${JSON_FAILURE_MESSAGES[reason] ?? 'is refused'}`, {
        reason,
      } as { reason: ErrorReason<typeof code> }),
    ],
  };
}

function checkSchema<T>(
  document: string,
  schema: ContractSchemaName,
  value: unknown,
): ValidationResult<T> {
  const validate = schemaValidator(schema);
  if (validate(value)) return { ok: true, value: value as T };
  const first = validate.errors?.[0];
  const path = first === undefined ? '' : failingPointer(first);
  // The keyword comes from the schema, never from the document. The pointer can hold member names
  // taken from the document, so it stays in `path` and out of the message.
  const keyword = first === undefined ? 'schema' : first.keyword;
  return refuse('RAY_MANIFEST_INVALID', `${document} fails its JSON Schema (${keyword})`, {
    reason: 'schema',
    path,
  });
}

function refuse<C extends BundleErrorCode>(
  code: C,
  message: string,
  detail: { reason?: ErrorReason<C>; path?: string } = {},
): { ok: false; errors: BundleError[] } {
  return { ok: false, errors: [bundleError(code, message, detail)] };
}

/**
 * Resolve the limits, then run a validator so that nothing escapes as an exception: a limit set
 * above its default is a usage error, and any unexpected fault is reported as internal. The
 * options are read inside, so options that are `null` or throw when read are answered too.
 */
function guarded<T>(
  document: string,
  options: { limits?: Partial<ReaderLimits> } | null | undefined,
  run: (limits: ReaderLimits) => ValidationResult<T>,
): ValidationResult<T> {
  let limits: ReaderLimits;
  try {
    limits = resolveReaderLimits(options?.limits);
  } catch {
    return refuse('RAY_USAGE', `a reader limit for ${document} is outside 0 to its default`);
  }
  try {
    return run(limits);
  } catch {
    return refuse('RAY_INTERNAL', `validating ${document} failed unexpectedly`);
  }
}
