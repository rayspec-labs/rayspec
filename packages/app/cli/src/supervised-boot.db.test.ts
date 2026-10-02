/**
 * The supervised deploy, on a real database through the real built CLI: with role separation the
 * process the operator starts holds the migration role and never imports the application, and serves
 * through a child process started without it. This proves the behaviours the single process had —
 * boot, readiness, graceful drain on SIGTERM and SIGINT, the supervisor's non-zero exit when the
 * serving child crashes — and the single-role mode, which runs one process exactly as before.
 *
 * Every observation is of the real process tree and of real HTTP; the handler reports, with no
 * value, whether the privileged connections ever reached it. Skips without DATABASE_URL; a required
 * run fails the ran-guard instead.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportPKCS8, generateKeyPair } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asAdmin, prepareRoleDatabases } from './test-support/migration-source.js';
import { freePort, SpawnedProcesses } from './test-support/processes.js';

const baseUrl = process.env.DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const CLI_DIST = join(repoRoot, 'packages/app/cli/dist/index.js');
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SPEC = `version: '1.0'
metadata:
  name: supervised
  id: supervised-app
  version: '1.0.0'
stores:
  - name: sup_notes
    columns:
      - { name: body, type: text }
api:
  - { method: GET, path: '/env', action: { kind: handler, handler: env } }
handlers:
  - { id: env, module: handlers/h.js, export: env, kind: route, uses: [] }
`;

// The handler reports, by name only, whether a privileged connection is in its own environment or
// in any ancestor's environment block.
const HANDLER = `import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
export async function env() {
  // Walk this process and every ancestor that is part of the deployment — the serving child and the
  // supervisor, whose command names the runtime's CLI — stopping at the operator's launcher above
  // (the host boundary, out of this runtime's control).
  const hits = [];
  let pid = process.pid;
  for (let hop = 0; pid > 1 && hop < 8; hop++) {
    let command = '';
    try { command = execSync('ps -ww -o command= -p ' + pid).toString(); } catch {}
    if (hop > 0 && !/index.js|supervised-child.js|rayspec/.test(command)) break;
    let text = command;
    try { text += execSync('ps -E -ww -o command= -p ' + pid).toString(); } catch {}
    try { text += readFileSync('/proc/' + pid + '/environ', 'utf8'); } catch {}
    const m = text.match(/[A-Z_]*(MIGRATION_DATABASE_URL|SNAPSHOT_DATABASE_URL)[A-Z_]*|postgres(ql)?:\\/\\/[^\\s]*(migrator|snapshot)/);
    if (m) hits.push(hop + ':' + m[0].slice(0, 40));
    try { pid = Number(execSync('ps -o ppid= -p ' + pid).toString().trim()); } catch { break; }
  }
  return {
    pid: process.pid,
    ppid: process.ppid,
    inEnv: 'RAYSPEC_MIGRATION_DATABASE_URL' in process.env,
    inAnyBlock: hits.length > 0,
    hits,
  };
}
`;

interface Serve {
  child: ChildProcess;
  output: () => string;
  port: number;
}

describe.skipIf(!baseUrl)('rayspec deploy — supervised by the process the operator starts', () => {
  const adminUrl = baseUrl ?? '';
  const name = `rayspec_cli_supervised_${process.pid}`;
  const sysDb = `${name}_dbos_sys`;
  const processes = new SpawnedProcesses();
  let roles: Awaited<ReturnType<typeof prepareRoleDatabases>>['roles'];
  let lane: Awaited<ReturnType<typeof prepareRoleDatabases>>['lane'];
  let dir = '';
  let keyPem = '';
  let ran = 0;

  beforeAll(async () => {
    if (!baseUrl) return;
    const prepared = await prepareRoleDatabases(adminUrl, name, sysDb);
    roles = prepared.roles;
    lane = prepared.lane;
    const { privateKey } = await generateKeyPair('RS256', {
      extractable: true,
      modulusLength: 2048,
    });
    keyPem = await exportPKCS8(privateKey);
    dir = mkdtempSync(join(tmpdir(), 'supervised-boot-'));
    writeFileSync(join(dir, 'rayspec.yaml'), SPEC);
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'supervised', private: true, type: 'module' }),
    );
    const handlers = join(dir, 'handlers');
    mkdirSync(handlers);
    writeFileSync(join(handlers, 'h.js'), HANDLER);
  }, 120_000);

  afterAll(async () => {
    await processes.stopAll(10_000);
    if (dir) rmSync(dir, { recursive: true, force: true });
    await asAdmin(adminUrl, 'postgres', async (sql) => {
      for (const n of [name, sysDb])
        await sql.unsafe(`DROP DATABASE IF EXISTS "${n}" WITH (FORCE)`);
    }).catch(() => {});
    await lane?.drop().catch(() => {});
    if (dbRequired) expect(ran).toBe(4);
  }, 60_000);

  function env(roleSeparated: boolean): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      TMPDIR: process.env.TMPDIR ?? '',
      RAYSPEC_SKIP_DOTENV: '1',
      DATABASE_URL: roleSeparated ? roles.app.runtime : roles.app.migration,
      ...(roleSeparated
        ? {
            RAYSPEC_MIGRATION_DATABASE_URL: roles.app.migration,
            RAYSPEC_SNAPSHOT_DATABASE_URL: roles.app.snapshot,
            DBOS_SYSTEM_DATABASE_URL: roles.sys.runtime,
          }
        : {}),
      RAYSPEC_JWT_SIGNING_KEY: keyPem,
      RAYSPEC_API_KEY_PEPPER: ['supervised', 'pepper', '0000'].join('-'),
    };
  }

  async function serve(roleSeparated: boolean, extra: NodeJS.ProcessEnv = {}): Promise<Serve> {
    const port = await freePort();
    let output = '';
    const child = processes.track(
      spawn(process.execPath, [CLI_DIST, 'deploy', 'rayspec.yaml', '--port', String(port)], {
        cwd: dir,
        env: { ...env(roleSeparated), ...extra },
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
    child.stdout?.on('data', (d) => {
      output += String(d);
    });
    child.stderr?.on('data', (d) => {
      output += String(d);
    });
    const deadline = Date.now() + 150_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`the deploy exited before it served\n${output}`);
      try {
        if ((await fetch(`http://127.0.0.1:${port}/livez`)).status === 200) break;
      } catch {
        // not listening yet
      }
      if (Date.now() > deadline) throw new Error(`the deploy did not serve\n${output}`);
      await pause(250);
    }
    return { child, output: () => output, port };
  }

  /** The Node children of `pid`. */
  function nodeChildren(pid: number): number[] {
    const run = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' });
    return run.stdout
      .split('\n')
      .map((line) => Number(line.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
  }

  it('boots, serves readiness, and keeps the privileged connections out of the serving child and its own', async () => {
    const s = await serve(true);
    expect((await fetch(`http://127.0.0.1:${s.port}/health`)).status).toBe(200);
    const children = nodeChildren(s.child.pid as number);
    expect(children.length, s.output()).toBe(1);
    const servingPid = children[0] as number;
    const res = await fetch(`http://127.0.0.1:${s.port}/env`);
    // The route is behind auth, so read what the handler reported from a successful call path: it is
    // public only to the owner, so register first.
    const owner = await fetch(`http://127.0.0.1:${s.port}/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'o@sup.example',
        password: 'a-long-enough-password',
        orgName: 'S',
      }),
    });
    const token = ((await owner.json()) as { accessToken: string }).accessToken;
    const probe = await fetch(`http://127.0.0.1:${s.port}/env`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = (await probe.json()) as {
      pid: number;
      inEnv: boolean;
      inAnyBlock: boolean;
      hits: string[];
    };
    expect(res.status).toBe(401);
    expect(body.pid).toBe(servingPid);
    expect(body.inEnv).toBe(false);
    expect(body.inAnyBlock, JSON.stringify(body.hits)).toBe(false);
    // The database only ever saw the runtime role connect.
    const users = await asAdmin(adminUrl, name, (sql) =>
      sql.unsafe(
        `SELECT DISTINCT usename FROM pg_stat_activity WHERE datname = current_database()
          AND pid <> pg_backend_pid() AND usename IS NOT NULL`,
      ),
    );
    const runtimeRole = decodeURIComponent(new URL(roles.app.runtime).username);
    expect((users as unknown as { usename: string }[]).map((u) => u.usename)).toEqual([
      runtimeRole,
    ]);
    await processes.stopAll(10_000);
    ran += 1;
  }, 180_000);

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    it(`drains and exits 0 on ${signal}, stopping the serving child with it`, async () => {
      const s = await serve(true);
      const servingPid = nodeChildren(s.child.pid as number)[0] as number;
      const exited = new Promise<{ code: number | null; sig: NodeJS.Signals | null }>((r) =>
        s.child.once('exit', (code, sig) => r({ code, sig })),
      );
      s.child.kill(signal);
      const end = await Promise.race([
        exited,
        pause(30_000).then(() => ({ code: -1, sig: null as NodeJS.Signals | null })),
      ]);
      expect(end.code, s.output()).toBe(0);
      // The serving child is gone too.
      await pause(500);
      expect(nodeChildren(s.child.pid as number)).not.toContain(servingPid);
      expect(spawnSync('ps', ['-p', String(servingPid)], { encoding: 'utf8' }).status).not.toBe(0);
      ran += 1;
    }, 120_000);
  }

  it('exits non-zero, saying why, when the serving child is killed, and runs one process in single-role mode', async () => {
    const s = await serve(true);
    const servingPid = nodeChildren(s.child.pid as number)[0] as number;
    const exited = new Promise<{ code: number | null; sig: NodeJS.Signals | null }>((r) =>
      s.child.once('exit', (code, sig) => r({ code, sig })),
    );
    // Kill the serving child alone: the supervisor sees it end and exits non-zero, naming it.
    process.kill(servingPid, 'SIGKILL');
    const end = await Promise.race([
      exited,
      pause(30_000).then(() => ({ code: 0, sig: null as NodeJS.Signals | null })),
    ]);
    expect(end.code, s.output()).not.toBe(0);
    expect(s.output()).toMatch(/application process ended \(signal SIGKILL\)/);

    // Single-role mode: no migration connection, one process, no application child.
    const single = await serve(false);
    expect(nodeChildren(single.child.pid as number)).toEqual([]);
    expect((await fetch(`http://127.0.0.1:${single.port}/health`)).status).toBe(200);
    await processes.stopAll(10_000);
    ran += 1;
  }, 180_000);
});

describe('rayspec deploy — supervised-boot ran-guard', () => {
  it('fails a required run that could not reach the database', () => {
    if (dbRequired && !baseUrl) throw new Error('supervised-boot: DATABASE_URL is required (CI)');
    expect(true).toBe(true);
  });
});
