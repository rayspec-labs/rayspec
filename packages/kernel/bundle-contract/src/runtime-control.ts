/**
 * The pure rules of the runtime-control operations that every implementation and every caller must
 * compute the same way: request checks, timestamps, the plan digest and its expiry, the product
 * schema digest, the shared schema lock key and self-hosted binding revision ids.
 *
 * Nothing here reads a file or opens a connection. A runtime implements the operations against its
 * own database; a caller such as a deployment supervisor recomputes a plan digest from the same
 * inputs and gets the same bytes, because both go through `canonicalJson` and SHA-256.
 */
import { createHash, createHmac } from 'node:crypto';
import { canonicalJson, compareCodePoints } from './canonical-json.js';
import { type BundleError, bundleError } from './errors.js';
import type { BindingRevision, SchemaHead, Sha256, Timestamp } from './types.js';
import { BINDING_NAME_PATTERN, CONTRACT_VERSION, type ExecutionLevel } from './vocabulary.js';

// ─── shared schema lock ────────────────────────────────────────────────────────────────────────

/**
 * The two-key advisory lock every schema-mutating path takes, transaction-scoped:
 * `pg_advisory_xact_lock(SCHEMA_LOCK_NAMESPACE, SCHEMA_LOCK_SLOT)`. The namespace is the ASCII of
 * `rays`; slot 1 is schema mutation.
 */
export const SCHEMA_LOCK_NAMESPACE = 0x7261_7973;
export const SCHEMA_LOCK_SLOT = 1;

/** How long a waiter waits for the schema lock unless it is configured otherwise. */
export const DEFAULT_SCHEMA_LOCK_TIMEOUT_MS = 60_000;

// ─── requests ──────────────────────────────────────────────────────────────────────────────────

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const PLATFORM_TAG = /^[0-9]{4}_[a-z0-9_]{1,120}$/;
const REVISION_ID = /^[\x21-\x7e]{1,128}$/;

/** The longest actor a request may carry. */
export const MAX_ACTOR_LENGTH = 256;

/** The most binding revisions a request may carry, the plan's `requiredBindings` limit. */
export const MAX_BINDING_REVISIONS = 256;

/** Whether a string is a lowercase UUID version 4. */
export function isUuidV4(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4.test(value);
}

/** Whether a string is a lowercase hex SHA-256. */
export function isSha256(value: unknown): value is Sha256 {
  return typeof value === 'string' && SHA256.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function usage(message: string, path: string): BundleError {
  return bundleError('RAY_USAGE', message, { path });
}

/**
 * The checks every request shares: the contract version, a UUID v4 operation id and an actor of 1
 * to 256 characters with no control character. The first failure is returned, or an empty list.
 */
export function checkRequestBase(request: unknown): BundleError[] {
  if (!isRecord(request)) return [usage('the request is not an object', '')];
  if (request.contractVersion !== CONTRACT_VERSION) {
    return [usage(`contractVersion must be ${CONTRACT_VERSION}`, '/contractVersion')];
  }
  if (!isUuidV4(request.operationId)) {
    return [usage('operationId must be a lowercase UUID v4', '/operationId')];
  }
  const actor = request.actor;
  if (
    typeof actor !== 'string' ||
    actor.length === 0 ||
    actor.length > MAX_ACTOR_LENGTH ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the control range is what is refused
    /[\u0000-\u001f\u007f]/.test(actor)
  ) {
    return [
      usage(
        `actor must be 1 to ${MAX_ACTOR_LENGTH} characters without control characters`,
        '/actor',
      ),
    ];
  }
  return [];
}

function checkSchemaHead(value: unknown, path: string): BundleError[] {
  if (value === null) return [];
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    typeof value.platform !== 'string' ||
    !PLATFORM_TAG.test(value.platform) ||
    !isSha256(value.product)
  ) {
    return [usage('a schema head is null or {platform, product}', path)];
  }
  return [];
}

/**
 * Check binding revisions: at most 256, each `{name, revisionId}` with a binding name and a revision
 * id of 1 to 128 printable ASCII characters, each name once.
 */
export function checkBindingRevisions(value: unknown, path: string): BundleError[] {
  if (!Array.isArray(value) || value.length > MAX_BINDING_REVISIONS) {
    return [usage(`bindingRevision must be a list of at most ${MAX_BINDING_REVISIONS}`, path)];
  }
  const seen = new Set<string>();
  for (const [i, entry] of value.entries()) {
    if (
      !isRecord(entry) ||
      Object.keys(entry).length !== 2 ||
      typeof entry.name !== 'string' ||
      !BINDING_NAME_PATTERN.test(entry.name) ||
      typeof entry.revisionId !== 'string' ||
      !REVISION_ID.test(entry.revisionId)
    ) {
      return [usage('a binding revision is {name, revisionId}', `${path}/${i}`)];
    }
    if (seen.has(entry.name)) return [usage('a binding is named twice', `${path}/${i}/name`)];
    seen.add(entry.name);
  }
  return [];
}

/** Check a prepare request after its common members: digest, path, revisions, expected head. */
export function checkPrepareRequest(request: unknown): BundleError[] {
  const base = checkRequestBase(request);
  if (base.length > 0) return base;
  const r = request as Record<string, unknown>;
  if (!isSha256(r.bundleSha256)) {
    return [usage('bundleSha256 must be a lowercase hex SHA-256', '/bundleSha256')];
  }
  if (
    typeof r.bundlePath !== 'string' ||
    !r.bundlePath.startsWith('/') ||
    r.bundlePath.includes('\0')
  ) {
    return [usage('bundlePath must be an absolute path', '/bundlePath')];
  }
  const revisions = checkBindingRevisions(r.bindingRevision, '/bindingRevision');
  if (revisions.length > 0) return revisions;
  if (!('expectedSchemaHead' in r)) {
    return [
      usage('expectedSchemaHead is required (null for an empty database)', '/expectedSchemaHead'),
    ];
  }
  return checkSchemaHead(r.expectedSchemaHead, '/expectedSchemaHead');
}

/** The longest reason a quiesce may record. */
export const MAX_QUIESCE_REASON_LENGTH = 1024;

/**
 * Check a quiesce request after its common members: a reason of 1 to 1024 characters without control
 * characters, a whole-second UTC `deadline` and a boolean `sourceStopped`.
 */
export function checkQuiesceRequest(request: unknown): BundleError[] {
  const base = checkRequestBase(request);
  if (base.length > 0) return base;
  const r = request as Record<string, unknown>;
  if (
    typeof r.reason !== 'string' ||
    r.reason.length === 0 ||
    r.reason.length > MAX_QUIESCE_REASON_LENGTH ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the control range is what is refused
    /[\u0000-\u001f\u007f]/.test(r.reason)
  ) {
    return [
      usage(
        `reason must be 1 to ${MAX_QUIESCE_REASON_LENGTH} characters without control characters`,
        '/reason',
      ),
    ];
  }
  if (parseTimestamp(r.deadline) === null) {
    return [usage('deadline must be a whole-second UTC timestamp ending in Z', '/deadline')];
  }
  if (typeof r.sourceStopped !== 'boolean') {
    return [usage('sourceStopped must be a boolean', '/sourceStopped')];
  }
  return [];
}

/** Check a resume request after its common members: `fenceEpoch` is a non-negative safe integer. */
export function checkResumeRequest(request: unknown): BundleError[] {
  const base = checkRequestBase(request);
  if (base.length > 0) return base;
  const epoch = (request as Record<string, unknown>).fenceEpoch;
  if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 0) {
    return [usage('fenceEpoch must be a non-negative safe integer', '/fenceEpoch')];
  }
  return [];
}

// ─── timestamps ────────────────────────────────────────────────────────────────────────────────

const TIMESTAMP =
  /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z$/;

/**
 * A timestamp in the form the operations write: UTC, whole seconds, `Z`. Whole seconds keep a plan
 * digest input free of the sub-second digits one clock writes and another drops.
 */
export function formatTimestamp(at: Date): Timestamp {
  const ms = at.getTime();
  if (!Number.isFinite(ms)) throw new RangeError('the time is not a valid date');
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.000Z$/, 'Z');
}

/** Parse a timestamp in the form `formatTimestamp` writes; null for anything else. */
export function parseTimestamp(value: unknown): Date | null {
  if (typeof value !== 'string' || !TIMESTAMP.test(value)) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) || formatTimestamp(at) !== value ? null : at;
}

// ─── plans ─────────────────────────────────────────────────────────────────────────────────────

/** The version of the plan digest input. */
export const PLAN_FORMAT_VERSION = 1;

/** A plan lives exactly this long after `preparedAt`. */
export const PLAN_LIFETIME_MS = 30 * 60 * 1000;

/** `runtimeReleaseDigest` of a runtime not installed from a signed release. */
export const UNRELEASED_RUNTIME = 'unreleased';

/** The grants of a bundle: its manifest's `permissions.execution`, `egressHosts` and `requires`. */
export interface PlanGrants {
  execution: ExecutionLevel;
  egressHosts: readonly string[];
  capabilities: readonly string[];
}

/** Everything a plan digest covers, before normalization. */
export interface PlanDigestInputs {
  bundleSha256: Sha256;
  /** The runtime's `releaseManifestSha256`, or null for a runtime not installed from a release. */
  releaseManifestSha256: Sha256 | null;
  schemaHeadFrom: SchemaHead | null;
  schemaHeadTo: SchemaHead;
  productDeltaSha256: Sha256 | null;
  bindingRevisions: readonly BindingRevision[];
  grants: PlanGrants;
  environmentRevision: number;
  preparedAt: Timestamp;
}

/** The canonical plan digest input document. */
export interface PlanDigestInput {
  planFormatVersion: typeof PLAN_FORMAT_VERSION;
  contractVersion: typeof CONTRACT_VERSION;
  bundleSha256: Sha256;
  runtimeReleaseDigest: Sha256 | typeof UNRELEASED_RUNTIME;
  schemaHeadFrom: SchemaHead | null;
  schemaHeadTo: SchemaHead;
  productDeltaSha256: Sha256 | null;
  bindingRevisions: BindingRevision[];
  grants: { execution: ExecutionLevel; egressHosts: string[]; capabilities: string[] };
  environmentRevision: number;
  preparedAt: Timestamp;
  expiresAt: Timestamp;
}

/** `preparedAt` plus exactly the plan lifetime. */
export function planExpiresAt(preparedAt: Timestamp): Timestamp {
  const at = parseTimestamp(preparedAt);
  if (at === null) throw new RangeError('preparedAt is not a whole-second UTC timestamp');
  return formatTimestamp(new Date(at.getTime() + PLAN_LIFETIME_MS));
}

/**
 * Whether a plan prepared at `preparedAt` has expired at `now`. The plan is valid up to, and not
 * including, its `expiresAt`. A `preparedAt` that does not parse, or lies in the future, counts as
 * expired, so a forged or skewed timestamp never extends a plan.
 */
export function isPlanExpired(preparedAt: Timestamp, now: Date): boolean {
  const at = parseTimestamp(preparedAt);
  if (at === null || at.getTime() > now.getTime()) return true;
  return now.getTime() >= at.getTime() + PLAN_LIFETIME_MS;
}

/**
 * Build the plan digest input: the constants, the release digest or `unreleased`, binding revisions
 * sorted by name, egress hosts and capabilities sorted by code point, and `expiresAt` computed from
 * `preparedAt`.
 */
export function planDigestInput(inputs: PlanDigestInputs): PlanDigestInput {
  const byName = (a: BindingRevision, b: BindingRevision) => compareCodePoints(a.name, b.name);
  return {
    planFormatVersion: PLAN_FORMAT_VERSION,
    contractVersion: CONTRACT_VERSION,
    bundleSha256: inputs.bundleSha256,
    runtimeReleaseDigest: inputs.releaseManifestSha256 ?? UNRELEASED_RUNTIME,
    schemaHeadFrom:
      inputs.schemaHeadFrom === null
        ? null
        : { platform: inputs.schemaHeadFrom.platform, product: inputs.schemaHeadFrom.product },
    schemaHeadTo: { platform: inputs.schemaHeadTo.platform, product: inputs.schemaHeadTo.product },
    productDeltaSha256: inputs.productDeltaSha256,
    bindingRevisions: inputs.bindingRevisions
      .map((b) => ({ name: b.name, revisionId: b.revisionId }))
      .sort(byName),
    grants: {
      execution: inputs.grants.execution,
      egressHosts: [...inputs.grants.egressHosts].sort(compareCodePoints),
      capabilities: [...inputs.grants.capabilities].sort(compareCodePoints),
    },
    environmentRevision: inputs.environmentRevision,
    preparedAt: inputs.preparedAt,
    expiresAt: planExpiresAt(inputs.preparedAt),
  };
}

/** SHA-256 of the canonical JSON of a digest input document. */
export function digestOf(input: unknown): Sha256 {
  return createHash('sha256').update(canonicalJson(input), 'utf8').digest('hex');
}

/** The plan digest of a set of inputs. */
export function planDigest(inputs: PlanDigestInputs): Sha256 {
  return digestOf(planDigestInput(inputs));
}

// ─── product schema head ───────────────────────────────────────────────────────────────────────

/** The version of the product schema description. */
export const PRODUCT_SCHEMA_FORMAT_VERSION = 1;

export interface ProductColumn {
  name: string;
  /** `format_type()` of the column. */
  type: string;
  nullable: boolean;
  /** `pg_get_expr()` of the default, or null. */
  default: string | null;
}

export interface ProductTable {
  name: string;
  columns: ProductColumn[];
  /** The primary key's columns in key order; empty without a primary key. */
  primaryKey: string[];
  /** One column list per unique constraint. */
  uniques: string[][];
  indexes: { name: string; columns: string[]; unique: boolean }[];
  foreignKeys: {
    columns: string[];
    references: { table: string; columns: string[] };
    onDelete: string;
  }[];
}

/** The description the product schema digest is taken over. */
export interface ProductSchemaDescription {
  productSchemaFormatVersion: typeof PRODUCT_SCHEMA_FORMAT_VERSION;
  tables: ProductTable[];
}

function compareLists(a: readonly string[], b: readonly string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const c = compareCodePoints(a[i]!, b[i]!);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

/**
 * Put a product schema description into its canonical order: tables by name, columns by name,
 * uniques as sorted lists, indexes by name, foreign keys by their column list. Column order inside
 * a key, a unique or an index is kept: it is part of what the key means.
 */
export function normalizeProductSchema(tables: readonly ProductTable[]): ProductSchemaDescription {
  return {
    productSchemaFormatVersion: PRODUCT_SCHEMA_FORMAT_VERSION,
    tables: tables
      .map((t) => ({
        name: t.name,
        columns: t.columns
          .map((c) => ({ name: c.name, type: c.type, nullable: c.nullable, default: c.default }))
          .sort((a, b) => compareCodePoints(a.name, b.name)),
        primaryKey: [...t.primaryKey],
        uniques: t.uniques.map((u) => [...u]).sort(compareLists),
        indexes: t.indexes
          .map((i) => ({ name: i.name, columns: [...i.columns], unique: i.unique }))
          .sort((a, b) => compareCodePoints(a.name, b.name)),
        foreignKeys: t.foreignKeys
          .map((f) => ({
            columns: [...f.columns],
            references: { table: f.references.table, columns: [...f.references.columns] },
            onDelete: f.onDelete,
          }))
          .sort((a, b) => compareLists(a.columns, b.columns)),
      }))
      .sort((a, b) => compareCodePoints(a.name, b.name)),
  };
}

/** The product half of a schema head: the digest of the normalized description. */
export function productSchemaDigest(tables: readonly ProductTable[]): Sha256 {
  return digestOf(normalizeProductSchema(tables));
}

/** The product digest of a database without product tables. */
export const EMPTY_PRODUCT_SCHEMA_DIGEST: Sha256 = productSchemaDigest([]);

/** Whether two schema heads, either possibly null, are equal. */
export function sameSchemaHead(a: SchemaHead | null, b: SchemaHead | null): boolean {
  if (a === null || b === null) return a === b;
  return a.platform === b.platform && a.product === b.product;
}

// ─── binding revisions ─────────────────────────────────────────────────────────────────────────

/** The length of an environment's binding revision key. */
export const BINDING_REVISION_KEY_BYTES = 32;

/**
 * The revision id a self-hosted runtime computes for a binding value: lowercase hex HMAC-SHA256
 * under the environment's binding revision key over the name, a NUL byte and the value. The id
 * changes whenever the value does and reveals nothing about it.
 */
export function bindingRevisionId(key: Uint8Array, name: string, value: string): string {
  if (key.length !== BINDING_REVISION_KEY_BYTES) {
    throw new RangeError(`the binding revision key must be ${BINDING_REVISION_KEY_BYTES} bytes`);
  }
  if (!BINDING_NAME_PATTERN.test(name)) throw new RangeError('the binding name is not valid');
  return createHmac('sha256', key)
    .update(name, 'utf8')
    .update('\0')
    .update(value, 'utf8')
    .digest('hex');
}
