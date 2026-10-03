/**
 * The supervised deploy, on a real database through the real built CLI: with role separation the
 * process the operator starts holds the migration role and never imports the application, and serves
 * through a child process started without it. This proves the behaviours the single process had —
 * boot, readiness, graceful drain on SIGTERM and SIGINT (once, when a terminal's Ctrl-C reaches the
 * whole process group), ending by the signal that stopped a boot, the supervisor's non-zero exit when
 * the serving child crashes, the one `--json` envelope of `rayspec deploy` and of a bundle deploy —
 * that a serving child never outlives a supervisor that was killed, and the single-role mode, which
 * runs one process exactly as before.
 *
 * Every observation is of the real process tree and of real HTTP; the handler reports, with no
 * value, whether the privileged connections ever reached it. Skips without DATABASE_URL; a required
 * run fails the ran-guard instead.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportPKCS8, generateKeyPair } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runPack } from './pack.js';
import { CLI_VERSION, type ParsedJson } from './test-support/bundles.js';
import { asAdmin, prepareRoleDatabases } from './test-support/migration-source.js';
import { freePort, SpawnedProcesses } from './test-support/processes.js';

const baseUrl = process.env.DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const CLI_DIST = join(repoRoot, 'packages/app/cli/dist/index.js');
const SERVE_DIST = join(repoRoot, 'packages/app/server/dist/serve.js');
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
  - { method: GET, path: '/slow', action: { kind: handler, handler: slow } }
  - { method: GET, path: '/crash', action: { kind: handler, handler: crash } }
handlers:
  - { id: env, module: handlers/h.js, export: env, kind: route, uses: [] }
  - { id: slow, module: handlers/h.js, export: slow, kind: route, uses: [] }
  - { id: crash, module: handlers/h.js, export: crash, kind: route, uses: [] }
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
// A request that stays in flight, so a drain has something to wait for.
export async function slow() {
  await new Promise((r) => setTimeout(r, 15000));
  return { slow: true };
}
// Answers, then throws outside any request: the process ends with an uncaught exception.
export async function crash() {
  setTimeout(() => {
    throw new Error('the handler crashed after it answered');
  }, 50);
  return { crashing: true };
}
`;

interface Serve {
  child: ChildProcess;
  /** Standard output and standard error, interleaved as they arrived. */
  output: () => string;
  /** Standard output alone: with `--json`, and for a bundle deploy, the one envelope. */
  stdout: () => string;
  port: number;
  /** How the process ended. */
  exited: Promise<{ code: number | null; sig: NodeJS.Signals | null }>;
}

interface ServeOptions {
  /** The command after the CLI: a `deploy` of the spec by default; `--port <port>` is appended. */
  args?: string[];
  /** Run the built `rayspec-serve` instead of the CLI. */
  rayspecServe?: boolean;
  /** Start the process in a process group of its own, as a terminal starts a command. */
  detached?: boolean;
  /** The directory to run in; the application directory by default. */
  cwd?: string;
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
  // The databases a bundle deploy is applied to, kept apart from the spec deploys'.
  const bundleName = `${name}_bundle`;
  const bundleSysDb = `${bundleName}_dbos_sys`;
  let bundleRoles: typeof roles;
  let bundleLane: typeof lane;
  let bundleDir = '';

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
    const bundled = await prepareRoleDatabases(adminUrl, bundleName, bundleSysDb);
    bundleRoles = bundled.roles;
    bundleLane = bundled.lane;
    bundleDir = mkdtempSync(join(tmpdir(), 'supervised-bundle-'));
    const packed = await runPack(
      ['--spec', join(dir, 'rayspec.yaml'), '--output', join(bundleDir, 'app.ray')],
      { operationId: randomUUID(), cliVersion: CLI_VERSION },
    );
    if (!packed.envelope.ok) throw new Error(JSON.stringify(packed.envelope.errors));
  }, 120_000);

  afterAll(async () => {
    await processes.stopAll(10_000);
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (bundleDir) {
      // A staged version is read-only.
      spawnSync('chmod', ['-R', 'u+w', bundleDir]);
      rmSync(bundleDir, { recursive: true, force: true });
    }
    await asAdmin(adminUrl, 'postgres', async (sql) => {
      for (const n of [name, sysDb, bundleName, bundleSysDb])
        await sql.unsafe(`DROP DATABASE IF EXISTS "${n}" WITH (FORCE)`);
    }).catch(() => {});
    await lane?.drop().catch(() => {});
    await bundleLane?.drop().catch(() => {});
    if (dbRequired) expect(ran).toBe(10);
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

  /** Start a deploy (or `rayspec-serve`) and return once its process exists, before it serves. */
  async function start(
    roleSeparated: boolean,
    extra: NodeJS.ProcessEnv = {},
    options: ServeOptions = {},
  ): Promise<Serve> {
    const port = await freePort();
    let output = '';
    let stdout = '';
    const command = options.rayspecServe
      ? [SERVE_DIST]
      : [CLI_DIST, ...(options.args ?? ['deploy', 'rayspec.yaml']), '--port', String(port)];
    const child = processes.track(
      spawn(process.execPath, command, {
        cwd: options.cwd ?? dir,
        env: {
          ...env(roleSeparated),
          ...(options.rayspecServe
            ? { RAYSPEC_SPEC_PATH: join(dir, 'rayspec.yaml'), PORT: String(port) }
            : {}),
          ...extra,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(options.detached ? { detached: true } : {}),
      }),
    );
    const exited = new Promise<{ code: number | null; sig: NodeJS.Signals | null }>((r) =>
      child.once('exit', (code, sig) => r({ code, sig })),
    );
    child.stdout?.on('data', (d) => {
      output += String(d);
      stdout += String(d);
    });
    child.stderr?.on('data', (d) => {
      output += String(d);
    });
    return { child, output: () => output, stdout: () => stdout, port, exited };
  }

  /** `start`, then wait until it serves. */
  async function serve(
    roleSeparated: boolean,
    extra: NodeJS.ProcessEnv = {},
    options: ServeOptions = {},
  ): Promise<Serve> {
    const s = await start(roleSeparated, extra, options);
    const deadline = Date.now() + 150_000;
    for (;;) {
      if (s.child.exitCode !== null) {
        throw new Error(`the deploy exited before it served\n${s.output()}`);
      }
      try {
        if ((await fetch(`http://127.0.0.1:${s.port}/livez`)).status === 200) break;
      } catch {
        // not listening yet
      }
      if (Date.now() > deadline) throw new Error(`the deploy did not serve\n${s.output()}`);
      await pause(250);
    }
    return s;
  }

  /** A bundle deploy of the packed application: its dry-run, then the deploy of that plan. */
  async function serveBundle(): Promise<Serve> {
    const bundleEnv = {
      ...env(true),
      DATABASE_URL: bundleRoles.app.runtime,
      RAYSPEC_MIGRATION_DATABASE_URL: bundleRoles.app.migration,
      RAYSPEC_SNAPSHOT_DATABASE_URL: bundleRoles.app.snapshot,
      DBOS_SYSTEM_DATABASE_URL: bundleRoles.sys.runtime,
      SHADOW_DATABASE_URL: process.env.SHADOW_DATABASE_URL ?? adminUrl,
    };
    const dry = spawnSync(process.execPath, [CLI_DIST, 'deploy', 'app.ray', '--dry-run'], {
      cwd: bundleDir,
      env: bundleEnv,
      encoding: 'utf8',
      timeout: 180_000,
    });
    if (dry.status !== 0) throw new Error(`deploy --dry-run failed\n${dry.stdout}\n${dry.stderr}`);
    const planDigest = (JSON.parse(dry.stdout) as ParsedJson).data.planDigest as string;
    return await serve(true, bundleEnv, {
      args: ['deploy', 'app.ray', '--plan-digest', planDigest],
      cwd: bundleDir,
    });
  }

  /** Whether process `pid` still exists. */
  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /** Whether anything still answers on `port`. */
  async function answers(port: number): Promise<boolean> {
    try {
      await fetch(`http://127.0.0.1:${port}/livez`, { signal: AbortSignal.timeout(2_000) });
      return true;
    } catch {
      return false;
    }
  }

  /** An access token of a new account, for the routes behind auth. */
  async function token(port: number): Promise<string> {
    const res = await fetch(`http://127.0.0.1:${port}/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: `${randomUUID()}@sup.example`,
        password: 'a-long-enough-password',
        orgName: 'S',
      }),
    });
    return ((await res.json()) as { accessToken: string }).accessToken;
  }

  /** How the process ended, or `undefined` when it had not within `ms`. */
  async function ended(s: Serve, ms: number) {
    return await Promise.race([s.exited, pause(ms).then(() => undefined)]);
  }

  /** Standard output as the one JSON document it must be (a second envelope fails the parse). */
  function oneEnvelope(s: Serve): ParsedJson {
    expect(s.stdout().match(/"contractVersion"/g)?.length, s.output()).toBe(1);
    return JSON.parse(s.stdout()) as ParsedJson;
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

  it('stops the serving child at once, without a drain, when the supervisor is killed', async () => {
    // A long drain and a request in flight: a child that drained would outlive the supervisor.
    const s = await serve(true, { RAYSPEC_SHUTDOWN_DRAIN_MS: '20000' });
    const servingPid = nodeChildren(s.child.pid as number)[0] as number;
    expect(alive(servingPid)).toBe(true);
    const bearer = await token(s.port);
    const inFlight = fetch(`http://127.0.0.1:${s.port}/slow`, {
      headers: { authorization: `Bearer ${bearer}` },
    }).catch(() => undefined);
    await pause(500);
    // As an OOM kill or `kill -9` ends it: no signal reaches the child from the supervisor.
    process.kill(s.child.pid as number, 'SIGKILL');
    const deadline = Date.now() + 3_000;
    while (alive(servingPid) && Date.now() < deadline) await pause(50);
    expect(alive(servingPid), s.output()).toBe(false);
    expect(await answers(s.port)).toBe(false);
    await inFlight;
    expect(s.output()).toMatch(
      /\[rayspec deploy\] the supervisor ended without stopping the application process; it stops at once, without a drain/,
    );
    expect(s.output()).not.toMatch(/SIGTERM received/);
    ran += 1;
  }, 180_000);

  it('ends by the signal that stopped a boot before the serving child could handle it', async () => {
    const s = await start(true);
    // The child exists and is still booting: its signal handlers are installed once it serves.
    const deadline = Date.now() + 60_000;
    let child: number | undefined;
    while (child === undefined && s.child.exitCode === null && Date.now() < deadline) {
      child = nodeChildren(s.child.pid as number)[0];
      if (child === undefined) await pause(25);
    }
    expect(child, s.output()).toBeDefined();
    s.child.kill('SIGTERM');
    const end = await ended(s, 60_000);
    expect(end, s.output()).toEqual({ code: null, sig: 'SIGTERM' });
    expect(alive(child as number)).toBe(false);
    ran += 1;
  }, 180_000);

  for (const entry of ['rayspec deploy', 'rayspec-serve'] as const) {
    it(`shuts down once when Ctrl-C reaches the whole process group (${entry})`, async () => {
      const s = await serve(true, {}, { detached: true, rayspecServe: entry === 'rayspec-serve' });
      const servingPid = nodeChildren(s.child.pid as number)[0] as number;
      // A terminal's Ctrl-C: SIGINT to every process of the foreground group, the supervisor (which
      // forwards it) and the serving child alike.
      process.kill(-(s.child.pid as number), 'SIGINT');
      const end = await ended(s, 60_000);
      expect(end, s.output()).toEqual({ code: 0, sig: null });
      expect(s.output().match(/SIGINT received — shutting down/g)?.length, s.output()).toBe(1);
      expect(alive(servingPid)).toBe(false);
      ran += 1;
    }, 180_000);
  }

  it('writes one --json envelope when stopped, and one when the serving child crashes after serving', async () => {
    const stopped = await serve(true, {}, { args: ['--json', 'deploy', 'rayspec.yaml'] });
    stopped.child.kill('SIGTERM');
    expect(await ended(stopped, 60_000), stopped.output()).toEqual({ code: 0, sig: null });
    expect(oneEnvelope(stopped)).toMatchObject({
      ok: true,
      operation: 'deploy.legacy',
      data: { ok: true, mode: 'serve', stoppedBy: 'SIGTERM' },
    });

    const crashed = await serve(true, {}, { args: ['--json', 'deploy', 'rayspec.yaml'] });
    const bearer = await token(crashed.port);
    await fetch(`http://127.0.0.1:${crashed.port}/crash`, {
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(await ended(crashed, 60_000), crashed.output()).toEqual({ code: 1, sig: null });
    expect(oneEnvelope(crashed)).toMatchObject({ ok: false, operation: 'deploy.legacy' });
    // The supervisor still says why on stderr.
    expect(crashed.output()).toMatch(/application process exited with code 1/);
    ran += 1;
  }, 240_000);

  it('a bundle deploy writes one envelope when stopped, and one when the serving child crashes after serving', async () => {
    const stopped = await serveBundle();
    expect(nodeChildren(stopped.child.pid as number).length, stopped.output()).toBe(1);
    stopped.child.kill('SIGTERM');
    expect(await ended(stopped, 60_000), stopped.output()).toEqual({ code: 0, sig: null });
    expect(oneEnvelope(stopped)).toMatchObject({
      ok: true,
      operation: 'deploy',
      data: { status: 'stopped' },
    });

    const crashed = await serveBundle();
    const bearer = await token(crashed.port);
    await fetch(`http://127.0.0.1:${crashed.port}/crash`, {
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(await ended(crashed, 60_000), crashed.output()).toEqual({ code: 1, sig: null });
    expect(oneEnvelope(crashed)).toMatchObject({
      ok: false,
      operation: 'deploy',
      data: { status: 'refused' },
    });
    ran += 1;
  }, 360_000);
});

describe('rayspec deploy — supervised-boot ran-guard', () => {
  it('fails a required run that could not reach the database', () => {
    if (dbRequired && !baseUrl) throw new Error('supervised-boot: DATABASE_URL is required (CI)');
    expect(true).toBe(true);
  });
});
