/**
 * Where the reader takes archive bytes from, and the budget it reads them under.
 *
 * A source is either a file, read with positional reads through one open handle, or bytes already
 * in memory. Every read is bounded by the size taken when the source was opened, so the reader
 * never reads past it however the archive's fields point. A deadline is checked between reads,
 * which caps the wall time (and so the CPU time) of one inspection.
 */
import { constants, type promises as fsp } from 'node:fs';
import { open } from 'node:fs/promises';
import {
  type BundleError,
  type BundleErrorCode,
  bundleError,
  type ErrorReason,
} from '@rayspec/bundle-contract';

/**
 * A refusal carried up through the reader's steps. It never leaves the package: the entry points
 * catch it and return its error in the result envelope.
 */
export class Refusal extends Error {
  readonly error: BundleError;
  constructor(error: BundleError) {
    super(error.message);
    this.name = 'Refusal';
    this.error = error;
  }
}

export function refusal<C extends BundleErrorCode>(
  code: C,
  message: string,
  detail: { reason?: ErrorReason<C>; path?: string } = {},
): Refusal {
  return new Refusal(bundleError(code, message, detail));
}

/** Random access to the bytes of one archive. */
export interface ArchiveSource {
  /** The size taken when the source was opened; no read goes past it. */
  readonly size: number;
  /** Exactly `length` bytes from `position`, or a refusal if the source ended early. */
  read(position: number, length: number): Promise<Buffer>;
  /** The size of the source now, to notice a file that changed while it was read. */
  currentSize(): Promise<number>;
  close(): Promise<void>;
}

/** Open a regular file as a source. A missing path, a directory or a device is a usage error. */
export async function openFileSource(path: string): Promise<ArchiveSource> {
  let handle: fsp.FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY);
  } catch {
    throw refusal('RAY_USAGE', 'the archive cannot be opened for reading');
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw refusal('RAY_USAGE', 'the archive is not a regular file');
    return fileSource(handle, stat.size);
  } catch (err) {
    await handle.close();
    throw err;
  }
}

function fileSource(handle: fsp.FileHandle, size: number): ArchiveSource {
  return {
    size,
    async read(position, length) {
      if (position < 0 || length < 0 || position + length > size) throw shortRead();
      const buffer = Buffer.alloc(length);
      let filled = 0;
      while (filled < length) {
        const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
        if (bytesRead === 0) throw shortRead();
        filled += bytesRead;
      }
      return buffer;
    },
    async currentSize() {
      return (await handle.stat()).size;
    },
    close: () => handle.close(),
  };
}

/** Bytes in memory as a source. The bytes are copied, so a caller cannot change them mid-read. */
export function bytesSource(bytes: Uint8Array): ArchiveSource {
  const copy = Buffer.from(bytes);
  return {
    size: copy.length,
    async read(position, length) {
      if (position < 0 || length < 0 || position + length > copy.length) throw shortRead();
      return copy.subarray(position, position + length);
    },
    async currentSize() {
      return copy.length;
    },
    async close() {},
  };
}

function shortRead(): Refusal {
  return refusal('RAY_INVALID_ARCHIVE', 'the archive ends inside a record it announces', {
    reason: 'header-directory-mismatch',
  });
}

/** A monotonic clock in milliseconds. */
export type Clock = () => number;

export const monotonicClock: Clock = () => performance.now();

/** The deadline of one read, checked between reads and between records. */
export class Deadline {
  private readonly end: number;
  constructor(
    budgetMs: number,
    private readonly clock: Clock,
  ) {
    this.end = clock() + budgetMs;
  }

  check(): void {
    if (this.clock() > this.end) {
      throw refusal('RAY_LIMIT_EXCEEDED', 'reading the archive took longer than its time budget', {
        reason: 'time-budget',
      });
    }
  }
}

/**
 * Sequential reads through a window of the source, so a run of small records costs one read per
 * window rather than one per record.
 */
export class SequentialReader {
  private window: Buffer = Buffer.alloc(0);
  private windowStart: number;
  position: number;

  constructor(
    private readonly source: ArchiveSource,
    start: number,
    private readonly end: number,
    private readonly deadline: Deadline,
    private readonly windowSize = 64 * 1024,
  ) {
    this.position = start;
    this.windowStart = start;
  }

  /** Whether `n` more bytes lie before the end of the region. */
  has(n: number): boolean {
    return this.position + n <= this.end;
  }

  /** The next `n` bytes of the region; a refusal if the region ends first. */
  async take(n: number): Promise<Buffer> {
    if (!this.has(n)) throw shortRead();
    const offset = this.position - this.windowStart;
    if (offset + n > this.window.length) {
      this.deadline.check();
      const length = Math.min(Math.max(n, this.windowSize), this.end - this.position);
      this.window = await this.source.read(this.position, length);
      this.windowStart = this.position;
    }
    const at = this.position - this.windowStart;
    this.position += n;
    return this.window.subarray(at, at + n);
  }
}
