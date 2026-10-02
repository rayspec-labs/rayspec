/**
 * The re-execution that takes the privileged connections out of a serving process's environment
 * block: what the re-executed image is started with, the handoff it reads and removes, and the
 * refusals of a handoff that is not one.
 */
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  handedOffPrivilegedConnections,
  privilegedOrigin,
  type ReexecProcess,
  reexecWithoutPrivilegedConnections,
  SUPERVISOR_HANDOFF_VAR,
  SupervisorHandoffError,
  takeSupervisorHandoff,
} from './supervisor-handoff.js';

const MIGRATION = ['postgres://migrator:', 'not-a-real-secret', '@127.0.0.1:1/app'].join('');

/** The handoff as the new image would find it, read while the fake execution runs. */
interface HandoffSeen {
  mode: number;
  directoryMode: number;
  content: string;
}

/**
 * A fake execution: the real one replaces the image and never returns, this one throws. The throw
 * ends the call the way a failed execution does, which removes the handoff, so what the new image
 * would have found is read here first.
 */
class Executed extends Error {
  readonly handoff: HandoffSeen | undefined;
  constructor(
    readonly file: string,
    readonly args: string[],
    readonly env: NodeJS.ProcessEnv,
  ) {
    super('executed');
    const path = env[SUPERVISOR_HANDOFF_VAR];
    this.handoff = path === undefined ? undefined : readHandoff(path);
  }
}

/** The handoff file's mode and content, judged and read through one descriptor. */
function readHandoff(path: string): { mode: number; directoryMode: number; content: string } {
  const fd = openSync(path, 'r');
  try {
    return {
      mode: fstatSync(fd).mode & 0o777,
      directoryMode: statSync(dirname(path)).mode & 0o777,
      content: readFileSync(fd, 'utf8'),
    };
  } finally {
    closeSync(fd);
  }
}

function fakeProcess(env: NodeJS.ProcessEnv): ReexecProcess {
  return {
    env,
    execPath: '/usr/bin/node',
    execArgv: ['--enable-source-maps'],
    argv: ['/usr/bin/node', '/opt/rayspec/bin.js', 'deploy', 'app.yaml'],
    platform: 'darwin',
    execve: (file, args, nextEnv) => {
      throw new Executed(file, args, nextEnv);
    },
  };
}

/** A handoff file in a directory of the kind the re-execution makes. */
function handoffFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'rayspec-handoff-'));
  const file = join(dir, 'handoff.json');
  writeFileSync(file, content, { mode: 0o600 });
  return file;
}

function reexec(env: NodeJS.ProcessEnv): Executed | undefined {
  try {
    reexecWithoutPrivilegedConnections(fakeProcess(env));
    return undefined;
  } catch (err) {
    if (err instanceof Executed) return err;
    throw err;
  }
}

describe('reexecWithoutPrivilegedConnections', () => {
  it('re-executes the same command without the connections, carrying them in a private handoff', () => {
    const executed = reexec({
      PATH: '/usr/bin',
      RAYSPEC_MIGRATION_DATABASE_URL: MIGRATION,
      RAYSPEC_SNAPSHOT_DATABASE_URL_FILE: '/run/secrets/snapshot',
    });
    expect(executed).toBeDefined();
    const { file, args, env, handoff } = executed as Executed;
    // Through the shell that sets the hard core-file limit to 0, then the same node, same arguments.
    expect(file).toBe('/bin/sh');
    expect(args.slice(3)).toEqual([
      '/usr/bin/node',
      '--enable-source-maps',
      '/opt/rayspec/bin.js',
      'deploy',
      'app.yaml',
    ]);
    expect(args[2]).toContain('ulimit -H -c 0');
    expect(env.PATH).toBe('/usr/bin');
    expect(Object.keys(env).filter((name) => name.includes('DATABASE_URL'))).toEqual([]);
    expect(handoff?.mode).toBe(0o600);
    expect(handoff?.directoryMode).toBe(0o700);
    expect(JSON.parse(handoff?.content ?? '')).toEqual({
      handoffFormatVersion: 1,
      values: {
        RAYSPEC_MIGRATION_DATABASE_URL: MIGRATION,
        RAYSPEC_SNAPSHOT_DATABASE_URL_FILE: '/run/secrets/snapshot',
      },
    });
    // The re-executed image takes it: the values stay in memory, the file and its directory go.
    const path = handoffFile(handoff?.content ?? '');
    const next = { ...env, [SUPERVISOR_HANDOFF_VAR]: path };
    takeSupervisorHandoff({ serving: true }, next);
    expect(next[SUPERVISOR_HANDOFF_VAR]).toBeUndefined();
    expect(existsSync(path)).toBe(false);
    expect(existsSync(dirname(path))).toBe(false);
    expect(handedOffPrivilegedConnections()).toEqual({
      RAYSPEC_MIGRATION_DATABASE_URL: MIGRATION,
      RAYSPEC_SNAPSHOT_DATABASE_URL_FILE: '/run/secrets/snapshot',
    });
    expect(privilegedOrigin('RAYSPEC_MIGRATION_DATABASE_URL')).toBe('handed-off');
  });

  it('changes nothing without a privileged connection, in the re-executed image, or without execve', () => {
    expect(reexec({ PATH: '/usr/bin', RAYSPEC_MIGRATION_DATABASE_URL: '  ' })).toBeUndefined();
    expect(
      reexec({
        RAYSPEC_MIGRATION_DATABASE_URL: MIGRATION,
        [SUPERVISOR_HANDOFF_VAR]: '/somewhere/handoff.json',
      }),
    ).toBeUndefined();
    const withoutExecve = { ...fakeProcess({ RAYSPEC_MIGRATION_DATABASE_URL: MIGRATION }) };
    delete withoutExecve.execve;
    expect(() => reexecWithoutPrivilegedConnections(withoutExecve)).not.toThrow();
  });

  it('leaves single-role mode alone: a snapshot connection without a migration connection is not handed off', () => {
    expect(reexec({ PATH: '/usr/bin', RAYSPEC_SNAPSHOT_DATABASE_URL: MIGRATION })).toBeUndefined();
    expect(
      reexec({ PATH: '/usr/bin', RAYSPEC_SNAPSHOT_DATABASE_URL_FILE: '/run/secrets/snapshot' }),
    ).toBeUndefined();
    // The migration connection's file form turns role separation on as the connection does.
    expect(
      reexec({ RAYSPEC_MIGRATION_DATABASE_URL_FILE: '/run/secrets/migration' })?.env[
        SUPERVISOR_HANDOFF_VAR
      ],
    ).toBeDefined();
  });

  it('removes the handoff when the new image cannot be started, and says why', () => {
    const handoffs: string[] = [];
    const failing: ReexecProcess = {
      ...fakeProcess({ RAYSPEC_MIGRATION_DATABASE_URL: MIGRATION }),
      execve: (_file, _args, nextEnv) => {
        handoffs.push(nextEnv[SUPERVISOR_HANDOFF_VAR] as string);
        throw new Error('execve failed: EACCES');
      },
    };
    expect(() => reexecWithoutPrivilegedConnections(failing)).toThrow(/EACCES/);
    expect(handoffs.length).toBeGreaterThan(0);
    for (const handoff of handoffs) {
      expect(existsSync(handoff)).toBe(false);
      expect(existsSync(dirname(handoff))).toBe(false);
    }
  });
});

describe('takeSupervisorHandoff', () => {
  it('refuses a handoff that reaches a command that does not serve, and removes it', () => {
    const file = handoffFile(JSON.stringify({ handoffFormatVersion: 1, values: {} }));
    expect(() =>
      takeSupervisorHandoff({ serving: false }, { [SUPERVISOR_HANDOFF_VAR]: file }),
    ).toThrow(SupervisorHandoffError);
    expect(existsSync(file)).toBe(false);
  });

  it('refuses a handoff it cannot read or that holds anything but the privileged connections', () => {
    expect(() =>
      takeSupervisorHandoff(
        { serving: true },
        { [SUPERVISOR_HANDOFF_VAR]: join(tmpdir(), 'no-such-handoff.json') },
      ),
    ).toThrow(/cannot be read/);
    for (const content of [
      'not json',
      JSON.stringify({ handoffFormatVersion: 2, values: {} }),
      JSON.stringify({ handoffFormatVersion: 1, values: { PATH: '/bin' } }),
      JSON.stringify({ handoffFormatVersion: 1, values: {}, extra: true }),
    ]) {
      const file = handoffFile(content);
      expect(() =>
        takeSupervisorHandoff({ serving: true }, { [SUPERVISOR_HANDOFF_VAR]: file }),
      ).toThrow(/format/);
    }
  });

  it('without a handoff, records which privileged connections the process was started with', () => {
    takeSupervisorHandoff({ serving: true }, { RAYSPEC_SNAPSHOT_DATABASE_URL: MIGRATION });
    expect(privilegedOrigin('RAYSPEC_SNAPSHOT_DATABASE_URL')).toBe('environment');
    expect(privilegedOrigin('RAYSPEC_MIGRATION_DATABASE_URL')).toBe('dotenv');
  });
});
