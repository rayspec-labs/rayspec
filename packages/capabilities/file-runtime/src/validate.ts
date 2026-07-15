/**
 * Shared request-shape validation (the audio `validate.ts` role): the file-id gate BOTH cores run
 * first. Pattern check + the point-of-use STRUCTURAL belt (the record capability's delimiter belt, widened for
 * bytes): ':' is the `file_ref`/event-id delimiter; '/'/'\\' and the bare dot-segments are
 * path-significant in the blob key (`files/${fileId}`). The belt holds even for a hand-built
 * config whose pattern would admit these (resolveFileConfig already rejects such an override at
 * construction).
 */
import type { ResolvedFileConfig } from './config.js';
import { err, type FileCapabilityResult } from './errors.js';
import type { FileParams } from './ports.js';

/** Validate the client-supplied file id; returns the id or the typed 422. */
export function validateFileId(
  config: ResolvedFileConfig,
  params: FileParams,
): FileCapabilityResult<string> {
  const fileId = params.file_id ?? '';
  if (!config.fileIdPattern.test(fileId)) {
    return err(
      422,
      'file_id_invalid',
      'file_id must match the configured safe-id shape (default: 1..128 ASCII letters/digits/._-).',
    );
  }
  if (fileId.includes(':')) {
    return err(
      422,
      'file_id_invalid',
      "file_id must not contain ':' — it is the reserved tenant/file delimiter of the file ref " +
        'and the event idempotency key.',
    );
  }
  if (fileId.includes('/') || fileId.includes('\\')) {
    return err(
      422,
      'file_id_invalid',
      'file_id must not contain path separators — the blob key embeds it as a path component.',
    );
  }
  if (fileId === '.' || fileId === '..') {
    return err(
      422,
      'file_id_invalid',
      'file_id must not be a bare dot-segment — the blob key embeds it as a path component.',
    );
  }
  return { ok: true, value: fileId };
}
