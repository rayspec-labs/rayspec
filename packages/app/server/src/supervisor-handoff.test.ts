/**
 * The re-execution that takes the privileged connections out of a serving process's environment
 * block: what the re-executed image is started with, the handoff it reads and removes, and the
 * refusals of a handoff that is not one.
 */
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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

class Executed extends Error {
  constructor(
    readonly file: string,
    readonly args: string[],
    readonly env: NodeJS.ProcessEnv,
  ) {
    super('executed');
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
    const { file, args, env } = executed as Executed;
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
    const handoff = env[SUPERVISOR_HANDOFF_VAR] as string;
    expect(statSync(handoff).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(handoff)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(handoff, 'utf8'))).toEqual({
      handoffFormatVersion: 1,
      values: {
        RAYSPEC_MIGRATION_DATABASE_URL: MIGRATION,
        RAYSPEC_SNAPSHOT_DATABASE_URL_FILE: '/run/secrets/snapshot',
      },
    });
    // The re-executed image takes it: the values stay in memory, the file and its directory go.
    const next = { ...env };
    takeSupervisorHandoff({ serving: true }, next);
    expect(next[SUPERVISOR_HANDOFF_VAR]).toBeUndefined();
    expect(existsSync(handoff)).toBe(false);
    expect(existsSync(dirname(handoff))).toBe(false);
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
});

describe('takeSupervisorHandoff', () => {
  function handoffFile(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'rayspec-handoff-'));
    const file = join(dir, 'handoff.json');
    writeFileSync(file, content, { mode: 0o600 });
    return file;
  }

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
