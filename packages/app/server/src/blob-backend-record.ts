/**
 * The blob backend an application's boot resolved, as the environment records it
 * (`runtime_control_state.blob_backend`).
 *
 * WHY IT IS RECORDED. Where a deployment keeps its blobs is decided at boot: a backend an extension
 * provides (`capabilities.blobFactory` in its `defineExtension` manifest) comes before the platform's
 * fs store over `RAYSPEC_BLOB_ROOT`, and the backend is built only for an application whose merged
 * spec declares a stream route. Whether an extension provides one is a value of its module, known
 * only by importing it. The boot imports the extensions anyway; an export must not run application
 * code in its own process. So the boot states what it resolved, and the bundle deploy that activates
 * the application writes it in the same transaction as the application digest. The record therefore
 * always describes the version the row names, and every later bundle deploy, a restart included,
 * writes it again.
 *
 * NULL means the activating deploy recorded nothing: an apply by a runtime that predates the column,
 * or a deploy that did not boot a backend-profile document. A reader treats NULL as unknown.
 */
import type { Db } from '@rayspec/db';

/** What the boot resolved: the platform's fs store, no blob backend, or an extension's backend. */
export type BlobBackendRecord =
  | { readonly kind: 'fs' }
  | { readonly kind: 'none' }
  | { readonly kind: 'extension'; readonly extension: string };

/** An extension id as a record may carry it: 1 to 256 characters, none of them a control character. */
function isExtensionId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

/**
 * Parse a recorded value, fail-closed: exactly one of the three shapes with no other key, or null.
 */
export function parseBlobBackendRecord(value: unknown): BlobBackendRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (record.kind === 'fs' || record.kind === 'none') {
    return keys.length === 1 ? { kind: record.kind } : null;
  }
  if (
    record.kind === 'extension' &&
    keys.length === 2 &&
    keys[0] === 'extension' &&
    isExtensionId(record.extension)
  ) {
    return { kind: 'extension', extension: record.extension };
  }
  return null;
}

/** The record and the application it belongs to, as `runtime_control_state` holds them. */
export interface RecordedBlobBackend {
  /** The bundle digest of the application the row names; null before the first bundle deploy. */
  readonly applicationDigest: string | null;
  /** The parsed record; null when none was recorded or the value is not a valid record. */
  readonly blobBackend: BlobBackendRecord | null;
}

/**
 * Read the record from the environment database. An environment no operation has touched yet reads
 * as no record. Throws when the database cannot be read.
 */
export async function readRecordedBlobBackend(db: Db): Promise<RecordedBlobBackend> {
  const [present] = (await db.$client.unsafe(
    `SELECT to_regclass('public.runtime_control_state') IS NOT NULL AS state,
            EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'runtime_control_state'
                       AND column_name = 'blob_backend') AS recorded`,
  )) as unknown as { state: boolean; recorded: boolean }[];
  if (present?.state !== true || present.recorded !== true) {
    return { applicationDigest: null, blobBackend: null };
  }
  const [row] = (await db.$client.unsafe(
    'SELECT application_digest, blob_backend FROM runtime_control_state WHERE id = 1',
  )) as unknown as { application_digest: string | null; blob_backend: unknown }[];
  if (row === undefined) return { applicationDigest: null, blobBackend: null };
  return {
    applicationDigest: row.application_digest,
    blobBackend: parseBlobBackendRecord(row.blob_backend),
  };
}
