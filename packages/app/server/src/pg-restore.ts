/**
 * RUNNING `pg_restore` FOR AN IMPORT — listing a dump's table of contents, and restoring the entries
 * an import approved into a target database as the target's migration role.
 *
 * THE TOOL is found like `pg_dump` (`pg-dump.ts`): the one the operator names (`RAYSPEC_PG_RESTORE`, an
 * absolute path), else the first `pg_restore` on `PATH`, or a command with leading arguments; its
 * major must be the target server's. The connection reaches it through the libpq environment, never
 * its argument list, with every inherited `PG*` variable dropped first.
 *
 * THE DUMP reaches the child on its standard input, read from a range of the private inner snapshot
 * archive, so the dump is never extracted to a file of its own. Every byte of the range is hashed
 * on the way, also the bytes `pg_restore` does not read: it stops reading once it has every entry it
 * needs, and the end of a custom-format archive may hold bytes no entry needs (a copy of the table
 * of contents). Its standard input then closes, and the remaining writes fail with `EPIPE`; that is
 * the tool's choice, judged by its exit code. The caller compares the hash with the inventory, so a
 * restore is known to have read exactly the authenticated bytes.
 *
 * A KILLED CALLER. The child reads its archive from the caller's pipe: when the caller dies, the
 * pipe ends early, `pg_restore` finds the archive truncated and exits, and its single transaction
 * rolls back. A stop request (the caller's abort signal) ends the child at once.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { redactText, registerSecretValues } from '@rayspec/core';
import { childEnv, connectionEnvironment, PgDumpError, type PgDumpTool } from './pg-dump.js';

/** The restore was stopped by the caller's signal; the child was ended and rolled back. */
export class PgRestoreAborted extends Error {
  constructor() {
    super('pg_restore was stopped');
    this.name = 'PgRestoreAborted';
  }
}

/** A range of an open file: where a dump lies inside the inner snapshot archive. */
export interface DumpSource {
  handle: FileHandle;
  offset: number;
  size: number;
}

/** What one run of `pg_restore` did. */
export interface PgRestoreOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  /** The end of the child's error output, redacted. */
  stderr: string;
  /** SHA-256 of every byte of the source range, read whether or not the child consumed it. */
  sourceSha256: string;
}

/** The most of the child's standard output kept: a listing of the largest table of contents. */
const MAX_STDOUT_BYTES = 64 * 1024 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const CHUNK_BYTES = 1024 * 1024;

function runWithSource(
  tool: PgDumpTool,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  source: DumpSource,
  signal?: AbortSignal,
): Promise<PgRestoreOutcome> {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted === true) {
      reject(new PgRestoreAborted());
      return;
    }
    const child = spawn(tool.command, [...(tool.args ?? []), ...args], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    const out: Buffer[] = [];
    let outBytes = 0;
    let overflow = false;
    const err: Buffer[] = [];
    let errBytes = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > MAX_STDOUT_BYTES) {
        overflow = true;
        child.kill('SIGKILL');
        return;
      }
      out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (errBytes >= MAX_STDERR_BYTES) return;
      err.push(chunk.subarray(0, MAX_STDERR_BYTES - errBytes));
      errBytes += chunk.length;
    });
    // The child may stop reading at any time; a write it no longer takes fails here, not as an
    // uncaught error. Its exit code decides.
    let stdinClosed = false;
    let stdinError: NodeJS.ErrnoException | undefined;
    child.stdin.on('error', (e: NodeJS.ErrnoException) => {
      stdinClosed = true;
      if (e.code !== 'EPIPE') stdinError = e;
    });
    const onAbort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', onAbort, { once: true });

    const hash = createHash('sha256');
    let feedError: unknown;
    const feed = (async () => {
      const buffer = Buffer.alloc(CHUNK_BYTES);
      for (let at = 0; at < source.size; ) {
        if (signal?.aborted === true) break;
        const length = Math.min(CHUNK_BYTES, source.size - at);
        const { bytesRead } = await source.handle.read(buffer, 0, length, source.offset + at);
        if (bytesRead === 0) throw new Error('the archive ended inside the dump');
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        at += bytesRead;
        if (stdinClosed || child.stdin.destroyed) continue;
        const copy = Buffer.from(chunk);
        const flushed = child.stdin.write(copy);
        if (!flushed) {
          await new Promise<void>((resume) => {
            const done = () => {
              child.stdin.off('drain', done);
              child.stdin.off('close', done);
              resume();
            };
            child.stdin.on('drain', done);
            child.stdin.on('close', done);
          });
        }
      }
      if (!child.stdin.destroyed) child.stdin.end();
    })().catch((e: unknown) => {
      feedError = e;
      child.stdin.destroy();
    });

    child.on('error', (e) => {
      signal?.removeEventListener('abort', onAbort);
      reject(
        new PgDumpError(`pg_restore could not be started (${(e as NodeJS.ErrnoException).code})`),
      );
    });
    child.on('close', (code, exitSignal) => {
      signal?.removeEventListener('abort', onAbort);
      void feed.then(() => {
        if (signal?.aborted === true) {
          reject(new PgRestoreAborted());
          return;
        }
        if (feedError !== undefined) {
          reject(new PgDumpError('the dump could not be read from the snapshot archive'));
          return;
        }
        if (overflow) {
          reject(new PgDumpError('pg_restore wrote more output than a table of contents holds'));
          return;
        }
        if (stdinError !== undefined && code === 0) {
          reject(new PgDumpError(`pg_restore's input failed (${stdinError.code})`));
          return;
        }
        resolvePromise({
          code,
          signal: exitSignal,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: redactText(
            Buffer.concat(err).toString('utf8').trim().split('\n').slice(-3).join(' '),
          ),
          sourceSha256: hash.digest('hex'),
        });
      });
    });
  });
}

/**
 * `pg_restore --list --create` of the dump: every entry of its table of contents as `pg_restore`
 * reads it, the database's own included, one line each, without the header comments.
 */
export async function listDump(
  tool: PgDumpTool,
  source: DumpSource,
): Promise<{ lines: string[]; sourceSha256: string }> {
  const outcome = await runWithSource(tool, ['--list', '--create'], childEnv({}), source);
  if (outcome.code !== 0) {
    throw new PgDumpError(
      `pg_restore --list ended with ${outcome.signal ?? `exit code ${outcome.code}`}` +
        (outcome.stderr === '' ? '' : `: ${outcome.stderr}`),
    );
  }
  return {
    lines: outcome.stdout
      .split('\n')
      .map((line) => line.replace(/\r$/, ''))
      .filter((line) => line !== '' && !line.startsWith(';')),
    sourceSha256: outcome.sourceSha256,
  };
}

/** The options every import restore runs with: no owner, privilege, comment or tablespace from the dump. */
export const RESTORE_OPTIONS: readonly string[] = [
  '--single-transaction',
  '--exit-on-error',
  '--no-owner',
  '--no-privileges',
  '--no-comments',
  '--no-tablespaces',
  '--no-table-access-method',
  '--no-security-labels',
  '--no-publications',
  '--no-subscriptions',
];

/**
 * Restore the entries `useListFile` names from the dump into the database `url` names, in one
 * transaction. Throws `PgDumpError` when the restore fails (it rolled back) and `PgRestoreAborted`
 * when the signal stopped it. Returns the SHA-256 of the dump's bytes.
 */
export async function restoreDump(
  tool: PgDumpTool,
  url: string,
  useListFile: string,
  source: DumpSource,
  signal?: AbortSignal,
): Promise<{ sourceSha256: string }> {
  const connection = connectionEnvironment(url, tool.rewriteHost, 'rayspec-import');
  registerSecretValues([connection.PGPASSWORD]);
  const outcome = await runWithSource(
    tool,
    [...RESTORE_OPTIONS, `--use-list=${useListFile}`, `--dbname=${connection.PGDATABASE}`],
    childEnv(connection),
    source,
    signal,
  );
  if (outcome.code !== 0) {
    throw new PgDumpError(
      `pg_restore ended with ${outcome.signal ?? `exit code ${outcome.code}`}; its transaction ` +
        `rolled back${outcome.stderr === '' ? '' : `: ${outcome.stderr}`}`,
    );
  }
  return { sourceSha256: outcome.sourceSha256 };
}
