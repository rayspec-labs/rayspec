/**
 * The `pg_dump` runner without a database: a stand-in tool (a small Node script) records the
 * arguments and the environment it was started with, so these arms prove how the tool is found, that
 * the connection reaches it through the libpq environment and never through its arguments, that an
 * inherited `PG*` variable cannot redirect it, and that a failed dump is reported without its
 * credential.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  connectionEnvironment,
  PgDumpError,
  type PgDumpTool,
  pgDumpMajor,
  resolvePgDump,
  runPgDump,
} from './pg-dump.js';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function workDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rayspec-pg-dump-'));
  dirs.push(dir);
  return dir;
}

/** A password with every character a URL must escape, built at run time. */
const PASSWORD = ['p@ss', 'w/rd', '%41?', '#x'].join(':');
const URL_WITH_PASSWORD = `postgresql://${encodeURIComponent('dump user')}:${encodeURIComponent(PASSWORD)}@db.internal:6543/app_db?sslmode=verify-full`;

/** A stand-in for pg_dump: records argv and the PG environment, writes stdout, exits as told. */
function standIn(dir: string, behaviour: { exit?: number; stderr?: string } = {}): PgDumpTool {
  const script = join(dir, 'stand-in.mjs');
  writeFileSync(
    script,
    [
      "import { writeFileSync } from 'node:fs';",
      `const record = ${JSON.stringify(join(dir, 'record.json'))};`,
      'const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("PG")));',
      'writeFileSync(record, JSON.stringify({ argv: process.argv.slice(2), env }));',
      "if (process.argv.includes('--version')) process.stdout.write('pg_dump (PostgreSQL) 16.4\\n');",
      "else process.stdout.write('PGDMP-bytes');",
      `process.stderr.write(${JSON.stringify(behaviour.stderr ?? '')});`,
      `process.exit(${behaviour.exit ?? 0});`,
    ].join('\n'),
  );
  return { command: process.execPath, args: [script] };
}

function recorded(dir: string): { argv: string[]; env: Record<string, string> } {
  return JSON.parse(readFileSync(join(dir, 'record.json'), 'utf8'));
}

describe('connectionEnvironment', () => {
  it('maps a URL onto the libpq environment, decoding the user and the password', () => {
    expect(connectionEnvironment(URL_WITH_PASSWORD)).toEqual({
      PGHOST: 'db.internal',
      PGPORT: '6543',
      PGDATABASE: 'app_db',
      PGUSER: 'dump user',
      PGPASSWORD: PASSWORD,
      PGSSLMODE: 'verify-full',
      PGCONNECT_TIMEOUT: '10',
      PGAPPNAME: 'rayspec-snapshot',
    });
  });

  it('defaults the host and port, maps ssl=true to require and applies a host rewrite', () => {
    expect(connectionEnvironment('postgres:///app?ssl=true')).toMatchObject({
      PGHOST: 'localhost',
      PGPORT: '5432',
      PGSSLMODE: 'require',
    });
    expect(
      connectionEnvironment('postgres://u@localhost:5448/app', () => ({
        host: 'host.docker.internal',
        port: '5448',
      })),
    ).toMatchObject({ PGHOST: 'host.docker.internal', PGPORT: '5448' });
    expect(connectionEnvironment('postgres://u@[::1]:5433/app').PGHOST).toBe('::1');
  });

  it('refuses what is not a postgres URL naming a database, without repeating it', () => {
    const withSecret = (scheme: string, tail: string) =>
      [`${scheme}://u`, `secret@h/${tail}`].join(':');
    for (const bad of ['not a url', withSecret('mysql', 'db'), withSecret('postgres', '')]) {
      expect(() => connectionEnvironment(bad)).toThrow(PgDumpError);
      try {
        connectionEnvironment(bad);
      } catch (err) {
        expect((err as Error).message).not.toContain('secret');
      }
    }
  });
});

describe('resolvePgDump', () => {
  it('finds the first executable pg_dump on PATH and skips relative and non-executable entries', async () => {
    const first = workDir();
    const second = workDir();
    writeFileSync(join(first, 'pg_dump'), '#!/bin/sh\n');
    chmodSync(join(first, 'pg_dump'), 0o644);
    writeFileSync(join(second, 'pg_dump'), '#!/bin/sh\n');
    chmodSync(join(second, 'pg_dump'), 0o755);
    const found = await resolvePgDump(undefined, {
      PATH: ['relative/bin', first, second].join(':'),
    });
    expect(found).toEqual({ command: join(second, 'pg_dump') });
    expect(await resolvePgDump(undefined, { PATH: first })).toBeNull();
    expect(await resolvePgDump(undefined, {})).toBeNull();
  });

  it('takes an explicit absolute executable, and refuses a relative path, a directory or a missing file', async () => {
    const dir = workDir();
    const tool = join(dir, 'pg_dump16');
    writeFileSync(tool, '#!/bin/sh\n');
    chmodSync(tool, 0o755);
    mkdirSync(join(dir, 'a-directory'));
    expect(await resolvePgDump(tool, { PATH: '' })).toEqual({ command: tool });
    expect(await resolvePgDump('pg_dump16', { PATH: dir })).toBeNull();
    expect(await resolvePgDump(join(dir, 'a-directory'))).toBeNull();
    expect(await resolvePgDump(join(dir, 'missing'))).toBeNull();
  });
});

describe('runPgDump and pgDumpMajor', () => {
  it('reads the major from --version', async () => {
    expect(await pgDumpMajor(standIn(workDir()))).toBe(16);
  });

  it('passes the connection in the environment only, drops inherited PG variables and writes stdout to a 0600 file', async () => {
    const dir = workDir();
    const out = join(dir, 'app.dump');
    const inherited = { PGSERVICE: process.env.PGSERVICE, PGPASSFILE: process.env.PGPASSFILE };
    process.env.PGSERVICE = 'elsewhere';
    process.env.PGPASSFILE = join(dir, 'other.pgpass');
    try {
      await runPgDump(standIn(dir), URL_WITH_PASSWORD, ['--snapshot=00000003-1'], out);
    } finally {
      for (const [k, v] of Object.entries(inherited)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    const { argv, env } = recorded(dir);
    expect(argv).toEqual(['--format=custom', '--no-password', '--snapshot=00000003-1']);
    expect(argv.join(' ')).not.toContain(PASSWORD);
    expect(argv.join(' ')).not.toContain('db.internal');
    expect(env.PGPASSWORD).toBe(PASSWORD);
    expect(env.PGUSER).toBe('dump user');
    expect(env.PGSERVICE).toBeUndefined();
    expect(env.PGPASSFILE).toBeUndefined();
    expect(readFileSync(out, 'utf8')).toBe('PGDMP-bytes');
    const { statSync } = await import('node:fs');
    expect(statSync(out).mode & 0o777).toBe(0o600);
  });

  it('never writes over an existing file', async () => {
    const dir = workDir();
    const out = join(dir, 'taken.dump');
    writeFileSync(out, 'keep');
    await expect(runPgDump(standIn(dir), URL_WITH_PASSWORD, [], out)).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(readFileSync(out, 'utf8')).toBe('keep');
  });

  it('reports a failed dump with its exit code and the end of its error output, without the password', async () => {
    const dir = workDir();
    const tool = standIn(dir, {
      exit: 1,
      stderr: `pg_dump: error: connection failed: password ${PASSWORD} rejected\n`,
    });
    const failed = runPgDump(tool, URL_WITH_PASSWORD, [], join(dir, 'x.dump'));
    await expect(failed).rejects.toBeInstanceOf(PgDumpError);
    const message = await failed.catch((e: Error) => e.message);
    expect(message).toContain('exit code 1');
    expect(message).toContain('connection failed');
    expect(message).not.toContain(PASSWORD);
  });

  it('reports a tool that cannot be started', async () => {
    await expect(
      runPgDump(
        { command: join(workDir(), 'absent') },
        URL_WITH_PASSWORD,
        [],
        join(workDir(), 'x'),
      ),
    ).rejects.toBeInstanceOf(PgDumpError);
    await expect(pgDumpMajor({ command: join(workDir(), 'absent') })).rejects.toBeInstanceOf(
      PgDumpError,
    );
  });
});
