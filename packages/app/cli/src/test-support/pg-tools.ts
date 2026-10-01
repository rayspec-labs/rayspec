/**
 * PostgreSQL client tools for the database-backed suites, the way an operator's machine has them:
 * the host's `pg_dump` / `pg_restore` on PATH when their major is the server's, otherwise the same
 * pinned `postgres` image `docker-compose.yml` runs, through `docker run`, behind an executable
 * wrapper — so the CLI under test is handed an absolute path either way (`RAYSPEC_PG_DUMP`).
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/** The postgres image docker-compose.yml pins. */
export const POSTGRES_IMAGE =
  'postgres:16@sha256:17e67d7b9890c99b055ba1e0d5c5be4ec27c9d3a72bda32db24a5e5d8a85af0c';

function hostTool(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, name);
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (probe.status === 0) return candidate;
  }
  return null;
}

function majorOf(tool: string): number | null {
  const probe = spawnSync(tool, ['--version'], { encoding: 'utf8' });
  const match = /\(PostgreSQL\)\s+(\d+)/.exec(probe.stdout ?? '');
  return probe.status === 0 && match !== null ? Number(match[1]) : null;
}

/**
 * An absolute path to `name` of the server's `major`: the host's, or a wrapper in `dir` that runs
 * the pinned image. `RAYSPEC_TEST_PG_TOOLS=docker` forces the wrapper, to exercise it on a host that
 * has the tools.
 */
export function pgToolPath(
  name: 'pg_dump' | 'pg_restore',
  major: number,
  dir: string,
): {
  path: string;
  via: 'host' | 'docker';
} {
  if (process.env.RAYSPEC_TEST_PG_TOOLS !== 'docker') {
    const host = hostTool(name);
    if (host !== null && majorOf(host) === major) return { path: host, via: 'host' };
  }
  const wrapper = join(dir, `${name}-docker`);
  writeFileSync(
    wrapper,
    [
      `#!${process.execPath}`,
      "const { spawn } = require('node:child_process');",
      'const env = { ...process.env };',
      "if (env.PGHOST === 'localhost' || env.PGHOST === '127.0.0.1') env.PGHOST = 'host.docker.internal';",
      "const names = ['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGCONNECT_TIMEOUT', 'PGAPPNAME', 'PGSSLMODE'];",
      "const pass = names.flatMap((v) => (env[v] === undefined ? [] : ['-e', v]));",
      `const args = ['run', '--rm', '-i', '--add-host=host.docker.internal:host-gateway', ...pass, ${JSON.stringify(POSTGRES_IMAGE)}, ${JSON.stringify(name)}, ...process.argv.slice(2)];`,
      "const child = spawn('docker', args, { env, stdio: 'inherit' });",
      "for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => child.kill(s));",
      "child.on('exit', (code) => process.exit(code ?? 1));",
      '',
    ].join('\n'),
  );
  chmodSync(wrapper, 0o755);
  return { path: wrapper, via: 'docker' };
}

/**
 * A `pg_dump` that waits, before every dump (not for `--version`), until the file `release` exists:
 * it writes its process id to `marker` first, so a suite knows a capture is running. It exits on its
 * own once the process that started it is gone, so a killed export leaves no dump behind.
 */
export function holdingPgDump(
  realPgDump: string,
  dir: string,
  marker: string,
  release: string,
): string {
  const wrapper = join(dir, 'pg_dump-holding');
  writeFileSync(
    wrapper,
    [
      `#!${process.execPath}`,
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      'const args = process.argv.slice(2);',
      'const run = () => {',
      `  const child = spawn(${JSON.stringify(realPgDump)}, args, { stdio: 'inherit' });`,
      "  process.on('SIGTERM', () => child.kill('SIGTERM'));",
      "  child.on('exit', (code) => process.exit(code ?? 1));",
      '};',
      "if (args.includes('--version')) run();",
      'else {',
      '  const parent = process.ppid;',
      `  fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid));`,
      '  const timer = setInterval(() => {',
      '    if (process.ppid !== parent) process.exit(3);',
      `    if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(timer); run(); }`,
      '  }, 50);',
      '}',
      '',
    ].join('\n'),
  );
  chmodSync(wrapper, 0o755);
  return wrapper;
}

/** Run a client tool with the libpq environment of `url`, `input` on stdin. */
export function runPgTool(
  tool: string,
  url: string,
  args: readonly string[],
  input?: Buffer,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('PG')) env[k] = v;
    Object.assign(env, {
      PGHOST: u.hostname,
      PGPORT: u.port || '5432',
      PGUSER: decodeURIComponent(u.username),
      PGPASSWORD: decodeURIComponent(u.password),
      PGDATABASE: decodeURIComponent(u.pathname.slice(1)),
    });
    const child = spawn(tool, [...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input ?? Buffer.alloc(0));
  });
}
