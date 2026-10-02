/**
 * Shared machinery for the reference-application suites: build an example with its own build script,
 * drive the real built CLI in child processes (pack, bundle inspect and verify, deploy), give each
 * suite a database of its own, and sign users in over HTTP. For the custom-handler application, a
 * test certificate authority, an HTTPS classification service and an egress proxy that admits only
 * the hosts a bundle declares.
 */
import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { expect } from 'vitest';
import { CLI_DIST, type ParsedJson, REPO_ROOT } from './bundles.js';

export { CLI_DIST, type ParsedJson, REPO_ROOT };
export const EXAMPLES = join(REPO_ROOT, 'examples');

const created: string[] = [];

/** A fresh temporary directory, mode 0700, removed by `removeScratch`. */
export function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(dir, 0o700);
  created.push(dir);
  return dir;
}

export function removeScratch(): void {
  for (const dir of created.splice(0)) {
    // Deployment version directories are read-only; make them removable first.
    spawnSync('chmod', ['-R', 'u+w', dir]);
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Run an example's Node script (a build or a seed generator) with `args`. */
export function runNode(script: string, args: readonly string[]): string {
  return execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', stdio: 'pipe' });
}

export interface CliRun {
  status: number | null;
  envelope: ParsedJson;
  stdout: string;
  stderr: string;
}

/** One run of the built CLI to completion: its exit, its one JSON envelope, its stderr. */
export function cli(
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): CliRun {
  const run = spawnSync(process.execPath, [CLI_DIST, ...args], {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.env ?? { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    timeout: 180_000,
  });
  let envelope: ParsedJson = {};
  try {
    envelope = JSON.parse(run.stdout) as ParsedJson;
  } catch {
    envelope = { unparsed: run.stdout };
  }
  return { status: run.status, envelope, stdout: run.stdout, stderr: run.stderr };
}

/** `rayspec pack --spec <spec> --output <output>` plus `extra`, expected to succeed. */
export function pack(
  spec: string,
  output: string,
  extra: readonly string[] = [],
  env?: NodeJS.ProcessEnv,
): { sha256: string; envelope: ParsedJson } {
  const run = cli(['pack', '--spec', spec, '--output', output, ...extra], env ? { env } : {});
  expect(run.status, `${run.stderr}\n${JSON.stringify(run.envelope.errors)}`).toBe(0);
  return { sha256: run.envelope.data.sha256 as string, envelope: run.envelope };
}

/** `rayspec bundle inspect` and `rayspec bundle verify` of a bundle; both must accept it. */
export function inspectAndVerify(bundle: string): { inspected: ParsedJson; verified: ParsedJson } {
  const inspected = cli(['bundle', 'inspect', bundle]);
  expect(inspected.status, inspected.stderr).toBe(0);
  const verified = cli(['bundle', 'verify', bundle]);
  expect(verified.status, `${verified.stderr}\n${JSON.stringify(verified.envelope.errors)}`).toBe(
    0,
  );
  return { inspected: inspected.envelope.data, verified: verified.envelope.data };
}

export function withDbName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

/** A database of the suite's own (and its durable-workflow system database), dropped by `drop`. */
export class SuiteDatabase {
  readonly url: string;
  sql!: postgres.Sql;

  constructor(
    private readonly base: string,
    readonly name: string,
  ) {
    this.url = withDbName(base, name);
  }

  private async admin(statements: string[]): Promise<void> {
    const admin = postgres(withDbName(this.base, 'postgres'), { max: 1 });
    try {
      for (const s of statements) await admin.unsafe(s);
    } finally {
      await admin.end();
    }
  }

  async create(): Promise<void> {
    await this.admin([
      `DROP DATABASE IF EXISTS "${this.name}" WITH (FORCE)`,
      `DROP DATABASE IF EXISTS "${this.name}_dbos_sys" WITH (FORCE)`,
      `CREATE DATABASE "${this.name}"`,
    ]);
    this.sql = postgres(this.url, { max: 2, onnotice: () => {} });
  }

  async drop(): Promise<void> {
    await this.sql?.end().catch(() => {});
    await this.admin([
      `DROP DATABASE IF EXISTS "${this.name}" WITH (FORCE)`,
      `DROP DATABASE IF EXISTS "${this.name}_dbos_sys" WITH (FORCE)`,
    ]);
  }
}

/** A throwaway RS256 signing key, as the boot reads it. */
export async function signingKeyPem(): Promise<string> {
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  return exportPKCS8(privateKey);
}

export interface Served {
  child: ChildProcess;
  exited: Promise<{ code: number | null; stdout: string; stderr: string }>;
}

/**
 * One self-hosted deployment driven through `rayspec deploy <file.ray>`: its state directory, the
 * environment every deploy of it runs with, its port.
 */
export class Deployment {
  readonly stateDir: string;
  readonly base: string;
  private readonly children: ChildProcess[] = [];

  constructor(
    readonly dir: string,
    readonly port: number,
    private readonly env: () => NodeJS.ProcessEnv,
  ) {
    this.stateDir = join(dir, '.rayspec-state');
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    this.base = `http://127.0.0.1:${port}`;
  }

  run(args: readonly string[]): CliRun {
    return cli(['deploy', ...args, '--state-dir', this.stateDir], {
      env: this.env(),
      cwd: this.dir,
    });
  }

  /** The dry-run of `bundle`; it must plan. Returns its data (plan, planDigest, …). */
  dryRun(bundle: string, extra: readonly string[] = []): ParsedJson {
    const run = this.run([bundle, '--dry-run', ...extra]);
    expect(run.status, `${run.stderr}\n${JSON.stringify(run.envelope.errors)}`).toBe(0);
    return run.envelope.data as ParsedJson;
  }

  /** Deploy `bundle` with its reviewed plan and serve; resolves once /health answers 200. */
  async serve(bundle: string, planDigest: string, extra: readonly string[] = []): Promise<Served> {
    const child = spawn(
      process.execPath,
      [
        CLI_DIST,
        'deploy',
        bundle,
        '--plan-digest',
        planDigest,
        '--state-dir',
        this.stateDir,
        '--port',
        String(this.port),
        ...extra,
      ],
      { cwd: this.dir, env: this.env() },
    );
    this.children.push(child);
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr?.on('data', (d) => {
      stderr += String(d);
    });
    const exited = new Promise<{ code: number | null; stdout: string; stderr: string }>((r) =>
      child.on('exit', (code) => r({ code, stdout, stderr })),
    );
    const deadline = Date.now() + 120_000;
    for (;;) {
      if (child.exitCode !== null) {
        const out = await exited;
        throw new Error(`deploy exited ${out.code}\n${out.stdout}\n${out.stderr}`);
      }
      try {
        if ((await fetch(`${this.base}/health`)).status === 200) break;
      } catch {
        // not listening yet
      }
      if (Date.now() > deadline) throw new Error(`deploy did not serve\n${stderr}`);
      await new Promise((r) => setTimeout(r, 250));
    }
    return { child, exited };
  }

  /** Stop a served deployment with SIGTERM; it must exit 0 with its one envelope on stdout. */
  async stop(served: Served): Promise<{ envelope: ParsedJson; stderr: string }> {
    served.child.kill('SIGTERM');
    const out = await served.exited;
    expect(out.code, out.stderr).toBe(0);
    return { envelope: JSON.parse(out.stdout) as ParsedJson, stderr: out.stderr };
  }

  /** The bundle digest `active.json` names. */
  active(): string {
    return (
      JSON.parse(readFileSync(join(this.stateDir, 'active.json'), 'utf8')) as {
        bundleSha256: string;
      }
    ).bundleSha256;
  }

  kill(): void {
    for (const child of this.children) if (child.exitCode === null) child.kill('SIGKILL');
  }
}

export const PASSWORD = 'a-long-enough-password';

async function json(res: Response): Promise<ParsedJson> {
  const text = await res.text();
  try {
    return JSON.parse(text) as ParsedJson;
  } catch {
    throw new Error(`${res.status}: ${text.slice(0, 300)}`);
  }
}

/** Register `email` and return its (unscoped) access token. */
export async function register(base: string, email: string): Promise<string> {
  const res = await fetch(`${base}/v1/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  expect([200, 201], await res.clone().text()).toContain(res.status);
  return (await json(res)).accessToken as string;
}

/** Switch `token`'s user into `orgId` and return the organization-scoped token. */
export async function switchOrg(base: string, token: string, orgId: string): Promise<string> {
  const res = await fetch(`${base}/v1/orgs/${orgId}/switch`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  return (await json(res)).accessToken as string;
}

/** A new user who creates an organization: its id and the user's organization-scoped token. */
export async function ownerWithOrg(
  base: string,
  email: string,
  name: string,
): Promise<{ orgId: string; token: string }> {
  const access = await register(base, email);
  const res = await fetch(`${base}/v1/orgs`, {
    method: 'POST',
    headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  expect(res.status).toBe(201);
  const orgId = (await json(res)).id as string;
  return { orgId, token: await switchOrg(base, access, orgId) };
}

/** The owner invites `email`, who accepts as a new account: that user's organization-scoped token. */
export async function invitedMember(
  base: string,
  ownerToken: string,
  orgId: string,
  email: string,
): Promise<string> {
  const issued = await fetch(`${base}/v1/orgs/${orgId}/invites`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ email, role: 'member' }),
  });
  expect(issued.status).toBe(201);
  const inviteToken = (await json(issued)).inviteToken as string;
  const accepted = await fetch(`${base}/v1/invites/accept`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: inviteToken, password: PASSWORD }),
  });
  // A new account is created by the accept: 201.
  expect(accepted.status).toBe(201);
  const body = await json(accepted);
  expect(body.activeOrgId).toBe(orgId);
  return body.accessToken as string;
}

/** An HTTP call with an optional bearer: its status, headers and parsed JSON body (or text). */
export async function call(
  url: string,
  options: {
    token?: string;
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<{ status: number; headers: Headers; body: ParsedJson; text: string }> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(url, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
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

// ─── TLS and egress for the custom-handler application ───────────────────────────────────────────

export interface TestCertificates {
  /** The CA certificate (PEM), which a child trusts through NODE_EXTRA_CA_CERTS. */
  caFile: string;
  key: Buffer;
  cert: Buffer;
}

/**
 * A throwaway P-256 certificate authority and a server certificate it signed for `host`, made with
 * the openssl command line (arguments, never a shell string). The CA certificate is the only file a
 * child reads; the server key stays in this process.
 */
export function testCertificates(dir: string, host: string): TestCertificates {
  const version = spawnSync('openssl', ['version'], { encoding: 'utf8' });
  expect(version.status, 'the openssl command line is needed to make a test certificate').toBe(0);
  const p = (name: string) => join(dir, name);
  const openssl = (args: string[]) => execFileSync('openssl', args, { stdio: 'pipe' });
  openssl([
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:P-256',
    '-nodes',
    '-keyout',
    p('ca.key'),
    '-out',
    p('ca.pem'),
    '-days',
    '1',
    '-subj',
    '/CN=reference-apps test CA',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign',
  ]);
  openssl([
    'req',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:P-256',
    '-nodes',
    '-keyout',
    p('server.key'),
    '-out',
    p('server.csr'),
    '-subj',
    `/CN=${host}`,
  ]);
  const ext = p('server.ext');
  writeFileSync(
    ext,
    `subjectAltName=DNS:${host}\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n`,
  );
  openssl([
    'x509',
    '-req',
    '-in',
    p('server.csr'),
    '-CA',
    p('ca.pem'),
    '-CAkey',
    p('ca.key'),
    '-CAcreateserial',
    '-out',
    p('server.pem'),
    '-days',
    '1',
    '-extfile',
    ext,
  ]);
  const certs = {
    caFile: p('ca.pem'),
    key: readFileSync(p('server.key')),
    cert: readFileSync(p('server.pem')),
  };
  rmSync(p('ca.key'));
  rmSync(p('server.key'));
  return certs;
}

export interface Listening {
  server: Server | HttpsServer;
  port: number;
  close(): Promise<void>;
}

async function listen(server: Server | HttpsServer): Promise<Listening> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    server,
    port: address.port,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

/**
 * The classification service the custom-handler application calls: HTTPS with the test
 * certificate, answering `{ category }` for `?content_type=` (`image` for image types, `document`
 * otherwise) and recording each request path.
 */
export async function startClassifier(
  certs: TestCertificates,
): Promise<Listening & { requests: string[] }> {
  const requests: string[] = [];
  const server = createHttpsServer({ key: certs.key, cert: certs.cert }, (req, res) => {
    requests.push(req.url ?? '');
    const type = new URL(req.url ?? '/', 'https://classifier.invalid').searchParams.get(
      'content_type',
    );
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ category: type?.startsWith('image/') ? 'image' : 'document' }));
  });
  return { ...(await listen(server)), requests };
}

/**
 * An egress proxy programmed from a host allowlist, as a host network policy is programmed from a
 * bundle's `permissions.egressHosts`: a CONNECT to an allowed host on 443 is tunnelled to the
 * classification service; any other is answered 403 and recorded in `denied`.
 */
export async function startEgressProxy(
  upstreamPort: number,
  allowed: () => readonly string[],
): Promise<Listening & { tunnelled: string[]; denied: string[] }> {
  const tunnelled: string[] = [];
  const denied: string[] = [];
  const server = createHttpServer((_req, res) => {
    res.statusCode = 405;
    res.end();
  });
  server.on('connect', (req, socket, head) => {
    const target = req.url ?? '';
    const separator = target.lastIndexOf(':');
    const host = separator > 0 ? target.slice(0, separator) : target;
    const port = separator > 0 ? target.slice(separator + 1) : '';
    if (port !== '443' || !allowed().includes(host)) {
      denied.push(target);
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    tunnelled.push(target);
    const upstream = connect(upstreamPort, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  return { ...(await listen(server)), tunnelled, denied };
}
