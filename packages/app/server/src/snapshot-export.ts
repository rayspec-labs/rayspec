/**
 * EXPORTING THE SNAPSHOT — the capture of a fenced source, encrypted to the operator's age X25519
 * recipient and written as one migration-kind `.ray`.
 *
 * `exportSnapshot` runs `captureSnapshot` (snapshot-capture.ts), which leaves the plaintext inner
 * archive in a private scratch directory (mode 0700), then `writeMigrationBundle` (@rayspec/bundle),
 * which encrypts that archive into the same directory and writes the bundle beside the output through
 * a temporary file, read back by the one reader and linked into place. The scratch directory is
 * removed on every path out of this function: success, refusal, failure and a stop request. The
 * plaintext is never written anywhere else, and never as the output.
 *
 * The fence is not touched here. The caller took it before (`quiesce`), and the source stays fenced
 * whatever happens; only `resume` releases it.
 */
import { rm } from 'node:fs/promises';
import { type BundleError, type BundleWarning, bundleError } from '@rayspec/bundle-contract';
import { redactText } from '@rayspec/core';
import { MigrationWriteAborted, writeMigrationBundle } from './migration-bundle.js';
import {
  type CaptureBarrier,
  type CapturedSnapshot,
  type CaptureSnapshotOptions,
  captureSnapshot,
} from './snapshot-capture.js';

export interface ExportSnapshotOptions extends CaptureSnapshotOptions {
  /** The age X25519 recipient (`age1…`); only the holder of the matching identity can decrypt. */
  recipient: string;
  /** Where the migration bundle is written; an existing file is never replaced. */
  output: string;
  /** Called once the capture finished, before the encryption starts. */
  onCaptured?: (captured: CapturedSnapshot) => void | Promise<void>;
}

export interface ExportedSnapshot {
  /** The absolute path of the migration bundle. */
  outputPath: string;
  /** SHA-256 of the migration bundle's bytes. */
  migrationBundleSha256: string;
  migrationBundleSize: number;
  ciphertextSha256: string;
  ciphertextSize: number;
  /** SHA-256 and size of the plaintext inner archive the ciphertext encrypts. */
  innerArchiveSha256: string;
  innerArchiveSize: number;
  snapshot: CapturedSnapshot['snapshot'];
  excludedTables: CapturedSnapshot['excludedTables'];
  barriers: CaptureBarrier[];
  reader: CapturedSnapshot['reader'];
  warnings: BundleWarning[];
}

export type ExportSnapshotResult =
  | { ok: true; value: ExportedSnapshot }
  | { ok: false; errors: BundleError[]; barriers: CaptureBarrier[] | null };

function interrupted(): BundleError {
  return bundleError(
    'RAY_INTERRUPTED',
    'the export was stopped before the bundle was written; nothing was kept, and the source stays ' +
      'fenced: retry the export, or release the fence with resume',
  );
}

/**
 * Capture the fenced source and write it, encrypted, as a migration bundle at `options.output`.
 * Returns what was written, or the refusal with the barriers the fence records. Nothing of the
 * capture survives this call but the bundle.
 */
export async function exportSnapshot(
  options: ExportSnapshotOptions,
): Promise<ExportSnapshotResult> {
  const captured = await captureSnapshot(options);
  if (!captured.ok) return captured;
  const value = captured.value;
  try {
    if (options.signal?.aborted === true) {
      return { ok: false, errors: [interrupted()], barriers: value.barriers };
    }
    await options.onCaptured?.(value);
    const written = await writeMigrationBundle(
      options.output,
      {
        application: {
          id: value.snapshot.applicationId,
          version: value.snapshot.applicationVersion,
        },
        runtime: { version: value.snapshot.sourceRuntime },
        target: value.applicationTarget,
        innerArchive: value.archivePath,
        recipient: options.recipient,
        workDir: value.scratchDir,
      },
      {
        ...(options.limits === undefined ? {} : { limits: options.limits }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    if (!written.ok) {
      return {
        ok: false,
        errors: written.errors.map((e) => ({ ...e, message: redactText(e.message) })),
        barriers: value.barriers,
      };
    }
    return {
      ok: true,
      value: {
        outputPath: written.value.path,
        migrationBundleSha256: written.value.archiveSha256,
        migrationBundleSize: written.value.archiveSize,
        ciphertextSha256: written.value.ciphertextSha256,
        ciphertextSize: written.value.ciphertextSize,
        innerArchiveSha256: value.archiveSha256,
        innerArchiveSize: value.archiveSize,
        snapshot: value.snapshot,
        excludedTables: value.excludedTables,
        barriers: value.barriers,
        reader: value.reader,
        warnings: value.warnings,
      },
    };
  } catch (err) {
    if (err instanceof MigrationWriteAborted) {
      return { ok: false, errors: [interrupted()], barriers: value.barriers };
    }
    return {
      ok: false,
      errors: [
        bundleError(
          'RAY_INFRA_UNAVAILABLE',
          'the migration bundle could not be written; the source stays fenced: retry the export, ' +
            'or release the fence with resume',
        ),
      ],
      barriers: value.barriers,
    };
  } finally {
    await rm(value.scratchDir, { recursive: true, force: true }).catch(() => {});
  }
}
