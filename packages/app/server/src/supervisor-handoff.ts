/**
 * The first thing a serving boot with role separation does: take the privileged connections out of
 * the process's environment block.
 *
 * Deleting a variable from `process.env` leaves it in the environment block the kernel shows for the
 * process (`/proc/<pid>/environ`, `ps -E`), and any process of the same user can read that block —
 * the application process the supervisor starts included. The only way to change the block is to
 * execute again. So the process the operator started writes the privileged values to a one-time
 * handoff file, private to its user, and re-executes itself with `process.execve` (same pid, same
 * arguments, same standard streams) with an environment that no longer holds them. The new image
 * reads the handoff, removes it, and keeps the values in this module, the only place the boot reads
 * them from afterwards (`withholdPrivilegedConnections`).
 *
 * On a system with `/bin/sh` the re-execution passes through `ulimit -H -c 0`, so the supervisor can
 * never write a core file: a process of the same user could otherwise raise the supervisor's soft
 * limit and make it dump its memory where that process can read it.
 *
 * This module imports nothing but Node built-ins, so an entrypoint can run it before it loads the
 * boot.
 */
import {
  accessSync,
  constants,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

/** The migration role's connection: the variable that turns role separation on. */
export const MIGRATION_CONNECTION_VAR = 'RAYSPEC_MIGRATION_DATABASE_URL';
/** The snapshot role's connection, which only an export uses. */
export const SNAPSHOT_CONNECTION_VAR = 'RAYSPEC_SNAPSHOT_DATABASE_URL';

/** The privileged connection variables: both connections and their `_FILE` forms. */
export const PRIVILEGED_CONNECTION_VARS: readonly string[] = [
  MIGRATION_CONNECTION_VAR,
  `${MIGRATION_CONNECTION_VAR}_FILE`,
  SNAPSHOT_CONNECTION_VAR,
  `${SNAPSHOT_CONNECTION_VAR}_FILE`,
];

/** The variable that carries the handoff file's path into the re-executed image. */
export const SUPERVISOR_HANDOFF_VAR = 'RAYSPEC_SUPERVISOR_HANDOFF';

const HANDOFF_FORMAT_VERSION = 1;
const HANDOFF_DIRECTORY_PREFIX = 'rayspec-handoff-';
const HANDOFF_FILE = 'handoff.json';

/** A handoff that cannot be read or does not hold what the boot wrote. The boot refuses. */
export class SupervisorHandoffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupervisorHandoffError';
  }
}

/** How a privileged connection reached this process. */
export type PrivilegedOrigin =
  /** The environment the operator started the process with; it was handed off and is gone from it. */
  | 'handed-off'
  /** The environment the operator started the process with, still in this process's block. */
  | 'environment'
  /** Neither: a `.env` file the boot loaded put it into `process.env`. */
  | 'dotenv';

let handedOff: Readonly<Record<string, string>> = {};
/** The privileged variables the operator started this process with; undefined until recorded. */
let startedWith: readonly string[] | undefined;

function isSet(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name];
  return value !== undefined && value.trim() !== '';
}

/** The privileged connection variables `env` sets. */
export function privilegedConnectionsIn(env: NodeJS.ProcessEnv = process.env): string[] {
  return PRIVILEGED_CONNECTION_VARS.filter((name) => isSet(env, name));
}

/** What `reexecWithoutPrivilegedConnections` needs from the running process; a test passes its own. */
export interface ReexecProcess {
  env: NodeJS.ProcessEnv;
  execPath: string;
  execArgv: readonly string[];
  argv: readonly string[];
  platform: NodeJS.Platform;
  execve?: (file: string, args: string[], env: NodeJS.ProcessEnv) => never;
}

function currentProcess(): ReexecProcess {
  return {
    env: process.env,
    execPath: process.execPath,
    execArgv: process.execArgv,
    argv: process.argv,
    platform: process.platform,
    execve: (process as unknown as { execve?: ReexecProcess['execve'] }).execve?.bind(process),
  };
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** A private directory for the handoff, memory-backed where the system has one. */
function handoffDirectory(platform: NodeJS.Platform): string {
  if (platform === 'linux') {
    try {
      return mkdtempSync(join('/dev/shm', HANDOFF_DIRECTORY_PREFIX));
    } catch {
      // No usable /dev/shm: the temporary directory below.
    }
  }
  return mkdtempSync(join(tmpdir(), HANDOFF_DIRECTORY_PREFIX));
}

/**
 * Re-execute this process with an environment block that holds no privileged connection, when role
 * separation is on (the migration connection or its `_FILE` form is set) and the block holds one.
 * Returns when there is nothing to do (single-role mode, which only deletes a snapshot connection
 * from `process.env` as before, or this image is already the re-executed one) and when the runtime
 * cannot re-execute (`process.execve` is missing); otherwise it does not return. When the execution
 * fails the handoff is removed before the error is thrown. A serving entrypoint calls it before it
 * reads anything else.
 */
export function reexecWithoutPrivilegedConnections(proc: ReexecProcess = currentProcess()): void {
  const env = proc.env;
  if (env[SUPERVISOR_HANDOFF_VAR] !== undefined) return;
  const names = privilegedConnectionsIn(env);
  const roleSeparated = names.some((name) => name.startsWith(MIGRATION_CONNECTION_VAR));
  if (!roleSeparated || proc.execve === undefined) return;
  const directory = handoffDirectory(proc.platform);
  const file = join(directory, HANDOFF_FILE);
  const values: Record<string, string> = {};
  for (const name of names) values[name] = env[name] as string;
  writeFileSync(file, JSON.stringify({ handoffFormatVersion: HANDOFF_FORMAT_VERSION, values }), {
    mode: 0o600,
    flag: 'wx',
  });
  const next: NodeJS.ProcessEnv = { ...env };
  for (const name of PRIVILEGED_CONNECTION_VARS) delete next[name];
  next[SUPERVISOR_HANDOFF_VAR] = file;
  const args = [...proc.execArgv, ...proc.argv.slice(1)];
  const execve = proc.execve;
  try {
    if (executable('/bin/sh')) {
      execve(
        '/bin/sh',
        ['/bin/sh', '-c', 'ulimit -H -c 0 2>/dev/null; exec "$0" "$@"', proc.execPath, ...args],
        next,
      );
    }
    execve(proc.execPath, [proc.execPath, ...args], next);
  } catch (err) {
    // The new image did not start: the handoff holding the connections must not stay behind.
    removeHandoff(file);
    throw err;
  }
}

function removeHandoff(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone.
  }
  // Only the directory the boot made for it, and only when empty.
  const directory = dirname(path);
  if (basename(path) === HANDOFF_FILE && basename(directory).startsWith(HANDOFF_DIRECTORY_PREFIX)) {
    try {
      rmdirSync(directory);
    } catch {
      // Not empty or already gone: left as it is.
    }
  }
}

/**
 * Take the handoff a re-executing entrypoint left: read the file, remove it and its directory, drop
 * the variable from `process.env`, and keep the values here. `serving` is whether the command serves;
 * a handoff variable reaching any other command is refused, since only a serving deploy writes one.
 * Without a handoff variable, it records which privileged variables the process was started with.
 */
export function takeSupervisorHandoff(
  options: { serving: boolean },
  env: NodeJS.ProcessEnv = process.env,
): void {
  const path = env[SUPERVISOR_HANDOFF_VAR];
  if (path === undefined) {
    handedOff = {};
    startedWith = privilegedConnectionsIn(env);
    return;
  }
  delete env[SUPERVISOR_HANDOFF_VAR];
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new SupervisorHandoffError(
      `the supervisor handoff ${path} (${SUPERVISOR_HANDOFF_VAR}) cannot be read; the variable is ` +
        'internal to a serving deploy and is not set by an operator',
    );
  } finally {
    removeHandoff(path);
  }
  if (!options.serving) {
    throw new SupervisorHandoffError(
      `${SUPERVISOR_HANDOFF_VAR} is set, but this command does not serve; the variable is internal to ` +
        'a serving deploy and is not set by an operator',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  const values = (parsed as { values?: unknown } | undefined)?.values;
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { handoffFormatVersion?: unknown }).handoffFormatVersion !==
      HANDOFF_FORMAT_VERSION ||
    Object.keys(parsed).length !== 2 ||
    typeof values !== 'object' ||
    values === null ||
    Object.entries(values).some(
      ([name, value]) => !PRIVILEGED_CONNECTION_VARS.includes(name) || typeof value !== 'string',
    )
  ) {
    throw new SupervisorHandoffError(
      `the supervisor handoff ${path} does not hold the privileged connections in the format this ` +
        'runtime writes',
    );
  }
  handedOff = Object.freeze({ ...(values as Record<string, string>) });
  startedWith = Object.keys(handedOff);
}

/** The privileged connection variables this process received through the handoff, with their values. */
export function handedOffPrivilegedConnections(): Readonly<Record<string, string>> {
  return handedOff;
}

/** How the privileged connection variable `name` reached this process. */
export function privilegedOrigin(name: string): PrivilegedOrigin {
  if (Object.hasOwn(handedOff, name)) return 'handed-off';
  if (startedWith === undefined || startedWith.includes(name)) return 'environment';
  return 'dotenv';
}
