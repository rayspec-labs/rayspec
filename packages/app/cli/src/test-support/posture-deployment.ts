/**
 * One deployment in the hardened hosting posture, stood up the way an operator stands one up: an
 * application packed with `rayspec pack`, deployed with the real built CLI (`rayspec deploy
 * <file.ray>`) as a child process, with every part of the posture on:
 *
 *  - role separation and row-level security: databases of its own, a migration role that migrates
 *    and a runtime role (no superuser, no BYPASSRLS, owner of nothing) that serves, prepared by the
 *    shipped database roles setup, for the application and the workflow system database;
 *  - single-tenant mode (`RAYSPEC_SINGLE_TENANT=true`);
 *  - the managed hosting posture (`RAYSPEC_HOSTING_POSTURE=managed`);
 *  - forwarding headers believed only from a pinned proxy address (`RAYSPEC_TRUSTED_PROXIES`), one
 *    the test client is not;
 *  - an allowed browser origin (`ALLOWED_ORIGINS`).
 *
 * The model provider is a local HTTP server standing in for the OpenAI API (`OPENAI_BASE_URL`): it
 * records what it is sent and either holds the request open (a provider that never answers) or
 * answers it, as the test steers it. No request leaves the machine and no key is a credential.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { exportPKCS8, generateKeyPair } from 'jose';
import type postgres from 'postgres';
import {
  backendSpec,
  temporaryDirectory,
  writeTree,
} from '../../../../kernel/bundle-closure/src/test-support/app.js';
import { runPack } from '../pack.js';
import { CLI_DIST, CLI_VERSION, type ParsedJson } from './bundles.js';
import { asAdmin, type LaneRoles, prepareRoleDatabases, withDbName } from './migration-source.js';
import { freePort, SpawnedProcesses } from './processes.js';

export { asAdmin, withDbName };

/** The address the deployment believes forwarding headers from: a documentation address. */
export const PINNED_PROXY = '192.0.2.10';

/** The one browser origin the deployment allows. */
export const ALLOWED_ORIGIN = 'https://app.example.test';

/** A password long enough for registration. */
export const PASSWORD = ['a', 'long', 'enough', 'password'].join('-');

/** What a handler puts in an error it throws: a connection string with a password and an address. */
export const INTERNAL_DETAIL = ['connect to postgres://svc:', 'hunter2', '@10.0.0.5:5432/app'].join(
  '',
);

/** The application every posture suite deploys: stores, an upload, playback, events, an agent. */
export const POSTURE_SPEC = backendSpec(
  'deployment:\n' +
    '  durableWorker: true\n' +
    '  eventBus: { enabled: true }\n' +
    'stores:\n' +
    '  - name: posture_notes\n    columns:\n      - { name: body, type: text }\n' +
    'api:\n' +
    "  - { method: GET, path: '/notes', action: { kind: store, store: posture_notes, op: list } }\n" +
    "  - { method: POST, path: '/notes', action: { kind: store, store: posture_notes, op: create } }\n" +
    "  - { method: GET, path: '/notes/{id}', action: { kind: store, store: posture_notes, op: get } }\n" +
    "  - { method: PATCH, path: '/notes/{id}', action: { kind: store, store: posture_notes, op: update } }\n" +
    "  - { method: DELETE, path: '/notes/{id}', action: { kind: store, store: posture_notes, op: delete } }\n" +
    "  - { method: POST, path: '/uploads/{upload_id}', action: { kind: stream, handler: ingest, mode: ingest } }\n" +
    "  - { method: POST, path: '/media/{id}/token', action: { kind: handler, handler: mint } }\n" +
    "  - { method: GET, path: '/media/{id}', action: { kind: stream, handler: play, mode: playback } }\n" +
    "  - { method: POST, path: '/announce', action: { kind: handler, handler: announce } }\n" +
    "  - { method: POST, path: '/boom', action: { kind: handler, handler: boom } }\n" +
    "  - { method: GET, path: '/environment', action: { kind: handler, handler: environment } }\n" +
    "  - { method: GET, path: '/driver-users', action: { kind: handler, handler: driverUsers } }\n" +
    "  - { method: POST, path: '/escalate', action: { kind: handler, handler: escalate } }\n" +
    'agents:\n' +
    '  - { id: echo, name: echo, backend: openai, model: gpt-4o-mini, instructions: Echo the input., maxTurns: 1 }\n' +
    'handlers:\n' +
    '  - { id: ingest, module: handlers/h.js, export: ingest, kind: route, uses: [blob] }\n' +
    '  - { id: mint, module: handlers/h.js, export: mint, kind: route, uses: [mintPlayToken] }\n' +
    '  - { id: play, module: handlers/h.js, export: play, kind: route, uses: [blob] }\n' +
    '  - { id: announce, module: handlers/h.js, export: announce, kind: route, uses: [emit] }\n' +
    '  - { id: boom, module: handlers/h.js, export: boom, kind: route, uses: [] }\n' +
    '  - { id: environment, module: handlers/h.js, export: environment, kind: route, uses: [] }\n' +
    '  - { id: driverUsers, module: handlers/h.js, export: driverUsers, kind: route, uses: [] }\n' +
    '  - { id: escalate, module: handlers/h.js, export: escalate, kind: route, uses: [] }\n',
);

/** The privileged connection variables a handler must find in neither its import nor its request. */
export const PRIVILEGED_VARIABLES = [
  'RAYSPEC_MIGRATION_DATABASE_URL',
  'RAYSPEC_MIGRATION_DATABASE_URL_FILE',
  'RAYSPEC_SNAPSHOT_DATABASE_URL',
  'RAYSPEC_SNAPSHOT_DATABASE_URL_FILE',
];

export const POSTURE_HANDLERS = `
const PRIVILEGED = ${JSON.stringify(PRIVILEGED_VARIABLES)};
const seenAtImport = PRIVILEGED.filter((name) => name in process.env);
// At import, before the migration pool could connect: watch every PostgreSQL connection this
// process opens and record the user its startup message names, and record every IPC message.
globalThis.__RAYSPEC_PROBE_DRIVER_USERS__ = new Set();
globalThis.__RAYSPEC_PROBE_MESSAGES__ = [];
try {
  const net = await import('node:net');
  const realWrite = net.Socket.prototype.write;
  net.Socket.prototype.write = function (chunk, ...rest) {
    try {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      const text = Buffer.isBuffer(buf) ? buf.toString('latin1') : '';
      const m = text.match(/user\0([^\0]+)\0/);
      if (m) globalThis.__RAYSPEC_PROBE_DRIVER_USERS__.add(m[1]);
    } catch {}
    return realWrite.call(this, chunk, ...rest);
  };
} catch {}
if (typeof process.on === 'function') {
  process.on('message', (m) => {
    try { globalThis.__RAYSPEC_PROBE_MESSAGES__.push(JSON.stringify(m)); } catch {}
  });
}
export async function ingest(init) {
  const bytes = new Uint8Array(await init.request.arrayBuffer());
  await init.blob.put('uploads/' + init.params.upload_id, bytes, {});
  return new Response(
    JSON.stringify({ stored: bytes.length, headers: [...init.request.headers.keys()].sort() }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}
export async function mint(init) {
  return { token: await init.mintPlayToken({ resource: 'media-' + init.params.id, ttlSeconds: 3600 }) };
}
export async function play(init) {
  return new Response(JSON.stringify({ resource: init.mediaResource ?? null }), {
    headers: { 'content-type': 'application/json' },
  });
}
export async function announce(init) {
  await init.emit('posture.announced', { at: Date.now() });
  return { announced: true };
}
export async function boom() {
  throw new Error(${JSON.stringify(INTERNAL_DETAIL)});
}
export async function environment() {
  const { execSync } = await import('node:child_process');
  const block = (pid) => {
    try { return execSync(\`ps -E -ww -o command= -p \${pid}\`).toString(); }
    catch { return ''; }
  };
  const environ = (pid) => {
    try { return require('node:fs').readFileSync(\`/proc/\${pid}/environ\`, 'utf8'); }
    catch { return ''; }
  };
  // Every ancestor up to the first that is not this runtime, its own pid first.
  const pids = [];
  let pid = process.pid;
  for (let hop = 0; hop < 8 && pid > 1; hop++) {
    pids.push(pid);
    const text = block(pid);
    if (!text.includes('node') && !text.includes('/bin/sh')) break;
    try { pid = Number(execSync(\`ps -o ppid= -p \${pid}\`).toString().trim()); }
    catch { break; }
    if (!Number.isInteger(pid) || pid <= 1) break;
  }
  const names = [...PRIVILEGED, 'RAYSPEC_SUPERVISOR_HANDOFF'];
  const seenInAny = new Set();
  let privilegedUrl = false;
  for (const p of pids) {
    const text = \`\${block(p)}\n\${environ(p)}\`;
    for (const name of names) if (text.includes(name)) seenInAny.add(name);
    // A connection string naming the migration or snapshot role carries the password too; found by
    // its shape, so the probe never has to hold the password itself.
    if (/postgres(ql)?:\\/\\/[^\\s]*(migrator|snapshot)/.test(text)) privilegedUrl = true;
  }
  return {
    atImport: seenAtImport,
    atRequest: PRIVILEGED.filter((name) => name in process.env),
    database: 'DATABASE_URL' in process.env,
    // Across this process and every ancestor up to the launch: the variable names found in any
    // environment block, and whether a migration/snapshot connection string appears in one.
    // The four privileged variable names (the handoff variable is internal and names a file removed
    // before any child existed; reported separately so the test can prove that file is gone).
    envBlockNames: [...seenInAny].filter((n) => n !== 'RAYSPEC_SUPERVISOR_HANDOFF').sort(),
    envBlockPrivilegedUrl: privilegedUrl,
    handoffPath: process.env.RAYSPEC_SUPERVISOR_HANDOFF ?? null,
    handoffFileExists: (() => {
      const path = process.env.RAYSPEC_SUPERVISOR_HANDOFF;
      try { return path !== undefined && require('node:fs').existsSync(path); }
      catch { return false; }
    })(),
    pids,
    ipcMessages: (globalThis.__RAYSPEC_PROBE_MESSAGES__ ?? []),
  };
}
export async function driverUsers() {
  return { users: [...(globalThis.__RAYSPEC_PROBE_DRIVER_USERS__ ?? [])].sort() };
}
export async function escalate(init) {
  const body = init.body ?? {};
  const { readFileSync } = await import('node:fs');
  const { execSync } = await import('node:child_process');
  // Every place in-process code could find a privileged connection: this process's environment and
  // every ancestor's environment block, and any _FILE path it can guess or was given.
  const sources = [];
  for (const [name, value] of Object.entries(process.env)) {
    if (/MIGRATION|SNAPSHOT/.test(name) && typeof value === 'string') sources.push(value);
  }
  let pid = process.pid;
  for (let hop = 0; pid > 1 && hop < 8; hop++) {
    try { sources.push(readFileSync(\`/proc/\${pid}/environ\`, 'utf8')); } catch {}
    try { pid = Number(execSync(\`ps -o ppid= -p \${pid}\`).toString().trim()); } catch { break; }
  }
  for (const path of (body.filePaths ?? [])) {
    try { sources.push(readFileSync(path, 'utf8')); } catch {}
  }
  const credentialFound = sources.some((c) =>
    /postgres(ql)?:\\/\\/[^\\s]*(migrator|snapshot)/.test(String(c)),
  );
  // Its only database access is the tenant-scoped runtime handle: a store write it attempts here is
  // what the fence and row security answer. (A fence answers 503; row security is proven by the
  // external runtime-role probes.)
  let storeWrite;
  try {
    const row = await init.db.insert('posture_notes', { body: 'escalation attempt' });
    storeWrite = row && row.id ? 'written' : 'no-row';
  } catch (err) {
    storeWrite = String((err && err.code) || (err && err.message) || err).slice(0, 40);
  }
  return { credentialFound, sourcesSearched: sources.length, storeWrite };
}`;

/** One request the stand-in provider received. */
export interface ProviderRequest {
  path: string;
  body: string;
}

/**
 * The stand-in for the model provider. `hold` keeps every request open until the connection is
 * closed (by the client's timeout or abort, or `close`); `answer` replies with a minimal completed
 * Responses API result echoing the input.
 */
export class StandInProvider {
  readonly requests: ProviderRequest[] = [];
  mode: 'hold' | 'answer' = 'hold';
  /** Requests whose connection is still open. */
  open = 0;
  #server!: Server;
  readonly #held = new Set<ServerResponse>();
  base = '';

  async start(): Promise<void> {
    this.#server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = '';
      req.on('data', (d) => {
        body += String(d);
      });
      req.on('end', () => {
        this.requests.push({ path: req.url ?? '', body });
        if (this.mode === 'answer') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(completedResponse(body)));
          return;
        }
        this.open++;
        this.#held.add(res);
        res.on('close', () => {
          this.open--;
          this.#held.delete(res);
        });
      });
    });
    await new Promise<void>((resolve) => this.#server.listen(0, '127.0.0.1', () => resolve()));
    this.base = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}/v1`;
  }

  /** How many requests carried `text` in their body. */
  sawText(text: string): number {
    return this.requests.filter((r) => r.body.includes(text)).length;
  }

  async close(): Promise<void> {
    for (const res of this.#held) res.destroy();
    this.#server.closeAllConnections();
    await new Promise((resolve) => this.#server.close(resolve));
  }
}

/** The smallest Responses API result the agents SDK reads as a completed turn. */
function completedResponse(requestBody: string): unknown {
  let model = 'gpt-4o-mini';
  try {
    model = (JSON.parse(requestBody) as { model?: string }).model ?? model;
  } catch {
    // keep the default
  }
  const id = `resp_${randomUUID().replaceAll('-', '')}`;
  return {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model,
    output: [
      {
        type: 'message',
        id: `msg_${randomUUID().replaceAll('-', '')}`,
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'ok', annotations: [] }],
      },
    ],
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      total_tokens: 2,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
}

export interface PostureDeployment {
  /** `http://127.0.0.1:<port>`. */
  base: string;
  port: number;
  db: string;
  sysDb: string;
  roles: LaneRoles;
  deployDir: string;
  stateDir: string;
  blobRoot: string;
  deploymentId: string;
  provider: StandInProvider;
  /** The environment every CLI run against this deployment gets. */
  env: NodeJS.ProcessEnv;
  /** The bundle the deployment runs, and its bindings file. */
  appBundle: string;
  bindings: string;
  /** What the served process wrote to stdout and stderr so far. */
  output(): string;
  /** The process the operator started (the supervisor under role separation); `undefined` once stopped. */
  child(): ChildProcess | undefined;
  /**
   * The pid of the process that serves: the supervisor's application child under role separation, or
   * the one process otherwise. `undefined` before it serves or once stopped.
   */
  servingPid(): number | undefined;
  /** Stop the served process with SIGTERM (SIGKILL after a grace). */
  stop(): Promise<void>;
  /** Serve the active version again (after `stop`). */
  restart(): Promise<void>;
  /** A superuser query against the deployment's application database. */
  admin<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T>;
  /** Every value no output may carry. */
  secrets: string[];
  /** Stop everything and drop the databases and roles. */
  dispose(): Promise<void>;
}

export interface PostureOptions {
  /** Extra settings for the served process (bounds, a different proxy list, …). */
  env?: Record<string, string>;
  spec?: string;
  handlers?: string;
}

/**
 * The pid of the process that serves: a supervisor's one application child (its only Node child),
 * or the supervisor itself in single-role mode. Found through `pgrep -P`, so a test reads the serving
 * process whether or not role separation split it off.
 */
function servingChildPid(served: ChildProcess | undefined): number | undefined {
  const pid = served?.pid;
  if (pid === undefined || served?.exitCode !== null) return undefined;
  const run = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' });
  const children = run.stdout
    .split('\n')
    .map((line) => Number(line.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  return children.length === 1 ? children[0] : pid;
}

async function waitUntilServing(
  base: string,
  child: ChildProcess,
  output: () => string,
): Promise<void> {
  const deadline = Date.now() + 150_000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`the deploy exited before it served\n${output()}`);
    }
    try {
      if ((await fetch(`${base}/livez`)).status === 200) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`the deploy did not serve\n${output()}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * Pack, deploy and serve the posture application on databases named after `name`. The caller owns
 * the result and must `dispose` it.
 */
export async function startPostureDeployment(
  adminUrl: string,
  name: string,
  options: PostureOptions = {},
): Promise<PostureDeployment> {
  const db = name;
  const sysDb = `${name}_dbos_sys`;
  const processes = new SpawnedProcesses();
  const provider = new StandInProvider();
  let lane: Awaited<ReturnType<typeof prepareRoleDatabases>>['lane'] | undefined;
  const writable: string[] = [];
  const dispose = async () => {
    await processes.stopAll(5_000);
    await provider.close().catch(() => {});
    // The deployment's version directories are read-only; make them removable.
    for (const dir of writable) spawnSync('chmod', ['-R', 'u+w', dir]);
    await asAdmin(adminUrl, 'postgres', async (sql) => {
      for (const n of [db, sysDb]) await sql.unsafe(`DROP DATABASE IF EXISTS "${n}" WITH (FORCE)`);
    }).catch(() => {});
    await lane?.drop().catch(() => {});
  };
  try {
    const prepared = await prepareRoleDatabases(adminUrl, db, sysDb);
    lane = prepared.lane;
    const { roles } = prepared;
    await provider.start();

    const { privateKey } = await generateKeyPair('RS256', {
      extractable: true,
      modulusLength: 2048,
    });
    const pem = await exportPKCS8(privateKey);
    const pepper = ['posture', 'pepper', randomUUID()].join('-');
    const mediaKey = ['posture', 'media', 'key', randomUUID()].join('-');
    const providerKey = ['inert', 'posture', randomUUID()].join('-');

    const deployDir = temporaryDirectory('posture-deploy-');
    writable.push(deployDir);
    const blobRoot = join(deployDir, 'blobs');
    mkdirSync(blobRoot);
    const bindings = join(temporaryDirectory('posture-bindings-'), 'bindings.json');
    writeFileSync(
      bindings,
      JSON.stringify({
        bindingsFormatVersion: 1,
        bindings: [{ name: 'OPENAI_API_KEY', value: providerKey }],
      }),
    );
    chmodSync(bindings, 0o600);

    const source = temporaryDirectory('posture-app-');
    writeTree(source, {
      'rayspec.yaml': options.spec ?? POSTURE_SPEC,
      'package.json': JSON.stringify({ name: 'posture-app', private: true, type: 'module' }),
      'handlers/h.js': options.handlers ?? POSTURE_HANDLERS,
    });
    const packed = await runPack(
      ['--spec', join(source, 'rayspec.yaml'), '--output', join(source, 'app.ray')],
      { operationId: randomUUID(), cliVersion: CLI_VERSION },
    );
    if (!packed.envelope.ok) throw new Error(JSON.stringify(packed.envelope.errors));
    const appBundle = join(deployDir, 'app.ray');
    copyFileSync(join(source, 'app.ray'), appBundle);

    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      TMPDIR: process.env.TMPDIR ?? '',
      DATABASE_URL: roles.app.runtime,
      RAYSPEC_MIGRATION_DATABASE_URL: roles.app.migration,
      DBOS_SYSTEM_DATABASE_URL: roles.sys.runtime,
      RAYSPEC_SNAPSHOT_DATABASE_URL: roles.app.snapshot,
      SHADOW_DATABASE_URL: process.env.SHADOW_DATABASE_URL ?? adminUrl,
      RAYSPEC_JWT_SIGNING_KEY: pem,
      RAYSPEC_API_KEY_PEPPER: pepper,
      RAYSPEC_MEDIA_SIGNING_KEY: mediaKey,
      RAYSPEC_BLOB_ROOT: blobRoot,
      RAYSPEC_SINGLE_TENANT: 'true',
      RAYSPEC_HOSTING_POSTURE: 'managed',
      RAYSPEC_TRUSTED_PROXIES: PINNED_PROXY,
      ALLOWED_ORIGINS: ALLOWED_ORIGIN,
      OPENAI_BASE_URL: provider.base,
      ...(options.env ?? {}),
    };
    const dry = spawnSync(
      process.execPath,
      [CLI_DIST, 'deploy', appBundle, '--dry-run', '--bindings-file', bindings],
      { cwd: deployDir, env, encoding: 'utf8', timeout: 180_000 },
    );
    if (dry.status !== 0) throw new Error(`deploy --dry-run failed\n${dry.stdout}\n${dry.stderr}`);
    const planDigest = (JSON.parse(dry.stdout) as ParsedJson).data.planDigest as string;

    let served: ChildProcess | undefined;
    let out = '';
    const serve = async (args: readonly string[]) => {
      out = '';
      served = processes.track(
        spawn(process.execPath, [CLI_DIST, 'deploy', appBundle, ...args, '--port', String(port)], {
          cwd: deployDir,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      );
      served.stdout?.on('data', (d) => {
        out += String(d);
      });
      served.stderr?.on('data', (d) => {
        out += String(d);
      });
      await waitUntilServing(base, served, () => out);
    };
    await serve(['--plan-digest', planDigest, '--bindings-file', bindings]);

    const stateDir = join(deployDir, '.rayspec-state');
    const deploymentId = (
      JSON.parse(readFileSync(join(stateDir, 'deployment.json'), 'utf8')) as {
        deploymentId: string;
      }
    ).deploymentId;
    const passwords = [
      roles.app.migration,
      roles.app.runtime,
      roles.app.snapshot,
      roles.sys.runtime,
    ]
      .map((u) => decodeURIComponent(new URL(u).password))
      .filter((p) => p !== '');
    return {
      base,
      port,
      db,
      sysDb,
      roles,
      deployDir,
      stateDir,
      blobRoot,
      deploymentId,
      provider,
      env,
      appBundle,
      bindings,
      output: () => out,
      child: () => served,
      servingPid: () => servingChildPid(served),
      stop: async () => {
        await processes.stopAll(10_000);
        served = undefined;
      },
      restart: async () => {
        // The active version, already applied: a deploy of the same bundle with a fresh plan.
        const again = spawnSync(
          process.execPath,
          [CLI_DIST, 'deploy', appBundle, '--dry-run', '--bindings-file', bindings],
          { cwd: deployDir, env, encoding: 'utf8', timeout: 180_000 },
        );
        if (again.status !== 0) throw new Error(`deploy --dry-run failed\n${again.stderr}`);
        const digest = (JSON.parse(again.stdout) as ParsedJson).data.planDigest as string;
        await serve(['--plan-digest', digest, '--bindings-file', bindings]);
      },
      admin: (fn) => asAdmin(adminUrl, db, fn),
      secrets: [...passwords, pepper, mediaKey, providerKey],
      dispose,
    };
  } catch (err) {
    await dispose();
    throw err;
  }
}

/** A JSON request to the deployment; returns the status, headers and parsed body (or `{}`). */
export async function request(
  base: string,
  path: string,
  options: {
    method?: string;
    token?: string;
    body?: unknown;
    raw?: Uint8Array | string;
    headers?: Record<string, string>;
  } = {},
): Promise<{ status: number; headers: Headers; body: ParsedJson; text: string }> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}${path}`, {
    method: options.method ?? (options.body !== undefined || options.raw ? 'POST' : 'GET'),
    headers,
    ...(options.body !== undefined
      ? { body: JSON.stringify(options.body) }
      : options.raw !== undefined
        ? { body: options.raw }
        : {}),
  });
  const text = await res.text();
  let body: ParsedJson = {};
  try {
    body = JSON.parse(text) as ParsedJson;
  } catch {
    body = {};
  }
  return { status: res.status, headers: res.headers, body, text };
}

/**
 * A POST whose body may be refused before it has been sent in full: resolves with the response the
 * server sends, even when it closes the connection while the body is still being written.
 */
export function postBody(
  base: string,
  path: string,
  body: Buffer,
  headers: Record<string, string>,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${base}${path}`, {
      method: 'POST',
      headers: { ...headers, 'content-length': String(body.length) },
    });
    let settled = false;
    req.on('response', (res) => {
      let text = '';
      res.on('data', (d) => {
        text += String(d);
      });
      res.on('end', () => {
        settled = true;
        resolve({ status: res.statusCode ?? 0, text });
      });
      res.on('error', () => {
        settled = true;
        resolve({ status: res.statusCode ?? 0, text });
      });
    });
    req.on('error', (err) => {
      // The server may close the connection once it has answered; the answer is what counts.
      if (!settled) setTimeout(() => (settled ? undefined : reject(err)), 500);
    });
    req.end(body);
  });
}
