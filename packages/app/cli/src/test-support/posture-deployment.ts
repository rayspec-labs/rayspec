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
import { CLI_DIST, type ParsedJson } from './bundles.js';
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
    'agents:\n' +
    '  - { id: echo, name: echo, backend: openai, model: gpt-4o-mini, instructions: Echo the input., maxTurns: 1 }\n' +
    'handlers:\n' +
    '  - { id: ingest, module: handlers/h.js, export: ingest, kind: route, uses: [blob] }\n' +
    '  - { id: mint, module: handlers/h.js, export: mint, kind: route, uses: [mintPlayToken] }\n' +
    '  - { id: play, module: handlers/h.js, export: play, kind: route, uses: [blob] }\n' +
    '  - { id: announce, module: handlers/h.js, export: announce, kind: route, uses: [emit] }\n' +
    '  - { id: boom, module: handlers/h.js, export: boom, kind: route, uses: [] }\n',
);

export const POSTURE_HANDLERS = `
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
`;

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
  /** The served process; `undefined` once stopped. */
  child(): ChildProcess | undefined;
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
      { operationId: randomUUID(), cliVersion: '1.8.0' },
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
