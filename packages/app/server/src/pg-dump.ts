/**
 * RUNNING `pg_dump` FOR A SNAPSHOT — finding the tool, checking its major version against the
 * server's, and writing one custom-format dump to a file.
 *
 * FINDING IT. The tool is the one the operator names (an absolute path to an executable file), or
 * else the first executable `pg_dump` on `PATH`, the way the operator's own shell finds it. A tool
 * may also be a command with leading arguments, so a host without PostgreSQL client tools can run
 * the `pg_dump` of a container image; `rewriteHost` then maps the server's host and port to the
 * address the container reaches it at.
 *
 * VERSIONS. A custom-format dump is read by `pg_restore` of the same or a newer major, and `pg_dump`
 * refuses a server newer than itself, so the snapshot contract fixes the tool's major to the
 * server's. `pgDumpMajor` reads it from `pg_dump --version`.
 *
 * CREDENTIALS. The connection reaches the child through the libpq environment (`PGHOST`, `PGPORT`,
 * `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `PGSSLMODE`), never through its argument list, which other
 * users of the host can read. Every inherited `PG*` variable is dropped first, so a stray
 * `PGSERVICE` or `PGPASSFILE` cannot redirect the dump. The password is registered with the redaction
 * path, and the child's error output is kept (bounded) and passes that path before it reaches a
 * message.
 */
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, open, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { redactText, registerSecretValues } from '@rayspec/core';

/** A way to run `pg_dump`: a command, the arguments that come before the dump's own. */
export interface PgDumpTool {
  command: string;
  args?: readonly string[];
  /** Map the server's address to the one the tool reaches it at (a container's view of the host). */
  rewriteHost?: (address: { host: string; port: string }) => { host: string; port: string };
}

/** `pg_dump` could not be found, run, or did not finish. The message carries no credential. */
export class PgDumpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PgDumpError';
  }
}

/** The dump was stopped by the caller's signal; the child was ended and its output is incomplete. */
export class PgDumpAborted extends Error {
  constructor() {
    super('pg_dump was stopped');
    this.name = 'PgDumpAborted';
  }
}

/** The largest amount of the child's error output kept for a message. */
const MAX_STDERR_BYTES = 16 * 1024;

/** How long a `--version` probe may take. */
const VERSION_TIMEOUT_MS = 30_000;

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    if (!s.isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * A PostgreSQL client tool to run: `explicit` when given (an absolute path to an executable file, or
 * a tool), else the first executable `name` on `PATH`. Null when there is none.
 */
export async function resolvePgTool(
  name: 'pg_dump' | 'pg_restore',
  explicit?: string | PgDumpTool,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PgDumpTool | null> {
  if (typeof explicit === 'object' && explicit !== null) return explicit;
  if (typeof explicit === 'string') {
    if (!isAbsolute(explicit) || !(await isExecutableFile(explicit))) return null;
    return { command: explicit };
  }
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir === '' || !isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    if (await isExecutableFile(candidate)) return { command: candidate };
  }
  return null;
}

/**
 * The `pg_dump` to run: `explicit` when given (an absolute path to an executable file, or a tool),
 * else the first executable `pg_dump` on `PATH`. Null when there is none.
 */
export async function resolvePgDump(
  explicit?: string | PgDumpTool,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PgDumpTool | null> {
  return resolvePgTool('pg_dump', explicit, env);
}

/** The environment a child runs with: the parent's without any `PG*` variable, plus `extra`. */
export function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith('PG')) env[name] = value;
  }
  return { ...env, ...extra };
}

/**
 * The libpq environment of a `postgres://` or `postgresql://` URL. Throws `PgDumpError` for any
 * other form; the message never repeats the URL.
 */
export function connectionEnvironment(
  url: string,
  rewriteHost?: PgDumpTool['rewriteHost'],
  applicationName = 'rayspec-snapshot',
): Record<string, string> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new PgDumpError('the database connection string is not a URL');
  }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') {
    throw new PgDumpError('the database connection string is not a postgres URL');
  }
  const database = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (database === '') throw new PgDumpError('the database connection string names no database');
  let address = { host: u.hostname === '' ? 'localhost' : u.hostname, port: u.port || '5432' };
  // A bracketed IPv6 literal keeps its brackets in `hostname`; libpq takes it without them.
  address.host = address.host.replace(/^\[(.*)\]$/, '$1');
  if (rewriteHost !== undefined) address = rewriteHost(address);
  const env: Record<string, string> = {
    PGHOST: address.host,
    PGPORT: address.port,
    PGDATABASE: database,
    PGCONNECT_TIMEOUT: '10',
    PGAPPNAME: applicationName,
  };
  if (u.username !== '') env.PGUSER = decodeURIComponent(u.username);
  if (u.password !== '') env.PGPASSWORD = decodeURIComponent(u.password);
  const sslmode = u.searchParams.get('sslmode');
  if (sslmode !== null) env.PGSSLMODE = sslmode;
  else if (u.searchParams.get('ssl') === 'true' || u.searchParams.get('ssl') === 'require') {
    env.PGSSLMODE = 'require';
  }
  return env;
}

interface ChildOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: string;
}

function run(
  tool: PgDumpTool,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  options: { stdoutFd?: number; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ChildOutcome> {
  return new Promise((resolvePromise, reject) => {
    if (options.signal?.aborted === true) {
      reject(new PgDumpAborted());
      return;
    }
    const child = spawn(tool.command, [...(tool.args ?? []), ...args], {
      env,
      stdio: ['ignore', options.stdoutFd ?? 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    const out: Buffer[] = [];
    let errBytes = 0;
    const err: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => {
      out.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (errBytes >= MAX_STDERR_BYTES) return;
      err.push(chunk.subarray(0, MAX_STDERR_BYTES - errBytes));
      errBytes += chunk.length;
    });
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => child.kill('SIGKILL'), options.timeoutMs);
    // A stop request ends the child at once; the dump it was writing is incomplete.
    const onAbort = () => child.kill('SIGTERM');
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      reject(
        new PgDumpError(`pg_dump could not be started (${(e as NodeJS.ErrnoException).code})`),
      );
    });
    child.on('close', (code, signal) => {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (options.signal?.aborted === true) {
        reject(new PgDumpAborted());
        return;
      }
      resolvePromise({
        code,
        signal,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
  });
}

/** The major version `pg_dump --version` reports. Throws `PgDumpError` when it reports none. */
export async function pgDumpMajor(tool: PgDumpTool): Promise<number> {
  return pgToolMajor(tool, 'pg_dump');
}

/** The major version `<tool> --version` reports. Throws `PgDumpError` when it reports none. */
export async function pgToolMajor(
  tool: PgDumpTool,
  name: 'pg_dump' | 'pg_restore',
): Promise<number> {
  const outcome = await run(tool, ['--version'], childEnv({}), { timeoutMs: VERSION_TIMEOUT_MS });
  const match = /\(PostgreSQL\)\s+(\d+)/.exec(outcome.stdout.toString('utf8'));
  if (outcome.code !== 0 || match === null) {
    throw new PgDumpError(`${name} --version did not report a PostgreSQL version`);
  }
  return Number(match[1]);
}

/**
 * Write a custom-format dump of the database `url` names to `outFile`, a new file created with mode
 * 0600. `args` are the dump's own arguments after `--format=custom`. Throws `PgDumpError` when the
 * dump fails; the message carries the redacted end of the tool's error output. When `signal` aborts,
 * the child is ended and `PgDumpAborted` is thrown.
 */
export async function runPgDump(
  tool: PgDumpTool,
  url: string,
  args: readonly string[],
  outFile: string,
  signal?: AbortSignal,
): Promise<void> {
  const connection = connectionEnvironment(url, tool.rewriteHost);
  // The password joins the redaction registry, so no message or log line can carry it.
  registerSecretValues([connection.PGPASSWORD]);
  const env = childEnv(connection);
  const handle = await open(outFile, 'wx', 0o600);
  let outcome: ChildOutcome;
  try {
    outcome = await run(tool, ['--format=custom', '--no-password', ...args], env, {
      stdoutFd: handle.fd,
      ...(signal === undefined ? {} : { signal }),
    });
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (outcome.code !== 0) {
    const detail = redactText(outcome.stderr.trim().split('\n').slice(-3).join(' '));
    throw new PgDumpError(
      `pg_dump ended with ${outcome.signal ?? `exit code ${outcome.code}`}` +
        (detail === '' ? '' : `: ${detail}`),
    );
  }
}
