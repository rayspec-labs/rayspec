/**
 * Shared machinery of the reference-application journeys (scripts/reference-journeys.mjs).
 *
 * A journey drives the RaySpec a consumer installed from the packed release tarballs — never the
 * workspace — through one application's life: pack, inspect, deploy on fresh databases, write data,
 * update, export, import into empty targets, and verify what arrived. This module holds what every
 * journey needs:
 *
 *   - `Journey`: named checks that fail the run on the first broken one, and a summary of them;
 *   - `Environment`: one self-hosted environment — an application database and a workflow system
 *     database on the server `adminUrl` names, each prepared with the database roles setup the
 *     installed `@rayspec/db` ships (roles of the environment's own), a state directory, a blob root
 *     and its own boot secrets;
 *   - `rayspec()` and `serve()`: the installed CLI run to completion, or a deploy kept serving;
 *   - HTTP helpers, digests, the PostgreSQL client tools of the server's major, and an age key pair.
 *
 * No password, key, pepper or token is printed: they are generated here and passed to children
 * through their environment or a file of mode 0600. Every child gets an explicit environment, never
 * this process's.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect, createServer } from 'node:net';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import postgres from 'postgres';

/** The postgres image docker-compose.yml pins, for the client tools when the host has none. */
export const POSTGRES_IMAGE =
  'postgres:16@sha256:17e67d7b9890c99b055ba1e0d5c5be4ec27c9d3a72bda32db24a5e5d8a85af0c';

export const pause = (ms) => new Promise((r) => setTimeout(r, ms));

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Code-point order, the order every digest here sorts by. */
export function byCodePoint(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A SHA-256 over rows: each row reduced to `columns`, as JSON, sorted in code-point order. */
export function rowsDigest(rows, columns) {
  const lines = rows.map((r) => JSON.stringify(columns.map((c) => r[c] ?? null))).sort(byCodePoint);
  return sha256(JSON.stringify(lines));
}

/** JSON with every object's keys in code-point order, so equal values compare equal as text. */
export function canonical(value) {
  return JSON.stringify(value, (_key, v) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => byCodePoint(a, b)))
      : v,
  );
}

export function withDbName(url, name) {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

export async function freePort() {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** A short-lived connection to database `db` of the server `adminUrl` names. */
export async function asAdmin(adminUrl, db, fn) {
  const sql = postgres(withDbName(adminUrl, db), { max: 1, onnotice: () => {} });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

export class JourneyFailure extends Error {}

/** One application's journey: an ordered list of named checks; the first failed one ends it. */
export class Journey {
  constructor(name, log) {
    this.name = name;
    this.checks = [];
    this.notes = [];
    this.log = log;
  }

  step(text) {
    this.log(`[${this.name}] ${text}`);
  }

  check(name, ok, detail = '') {
    this.checks.push({ name, ok: Boolean(ok) });
    if (!ok) {
      throw new JourneyFailure(`${this.name}: ${name}${detail === '' ? '' : ` — ${detail}`}`);
    }
  }

  /** A fact the run establishes that is not a pass/fail check (a count, a digest, a code). */
  note(key, value) {
    this.notes.push({ key, value });
  }
}

/**
 * The run context every journey gets: where the installed release is, the work directory, the
 * database server, the client tools and the age library of the installed tree.
 */
export class Context {
  constructor({ repo, consumer, tarballs, work, adminUrl, shadowUrl, logDir, log, image }) {
    this.repo = repo;
    this.consumer = consumer;
    this.tarballs = tarballs;
    this.work = work;
    this.adminUrl = adminUrl;
    this.shadowUrl = shadowUrl;
    this.logDir = logDir;
    this.log = log;
    const launcher = JSON.parse(
      readFileSync(join(consumer, 'node_modules', 'rayspec', 'package.json'), 'utf8'),
    );
    this.cli = join(consumer, 'node_modules', 'rayspec', launcher.bin.rayspec);
    this.version = launcher.version;
    // With a runtime image, every `rayspec` command of the journey runs in a container of that
    // image instead (see imageCliSource); the installed tree still supplies the helpers above.
    this.image = image ?? null;
    if (this.image !== null) {
      this.cli = join(work, 'rayspec-in-image.cjs');
      writeFileSync(
        this.cli,
        imageCliSource({
          image: this.image.ref,
          network: this.image.network,
          label: this.image.label,
          namePrefix: this.image.namePrefix,
          mounts: [...new Set([work, consumer, repo])],
          user: `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
          home: work,
        }),
      );
    }
    this.rolesSql = readFileSync(
      join(consumer, 'node_modules', '@rayspec', 'db', 'sql', 'database-roles.sql'),
      'utf8',
    );
    this.children = new Set();
    this.serving = new Set();
    this.environments = [];
    this.pgTools = null;
  }

  /** `pg_dump` and `pg_restore` of the server's major: the host's, or the pinned image's. */
  async tools() {
    if (this.pgTools !== null) return this.pgTools;
    const [{ major }] = await asAdmin(this.adminUrl, 'postgres', (sql) =>
      sql.unsafe("SELECT current_setting('server_version_num')::int / 10000 AS major"),
    );
    const dir = join(this.work, 'pg-tools');
    mkdirSync(dir, { recursive: true });
    this.pgTools = {
      major,
      pgDump: pgToolPath('pg_dump', major, dir),
      pgRestore: pgToolPath('pg_restore', major, dir),
    };
    return this.pgTools;
  }

  /** An age X25519 identity and its recipient, made with the age library the release installs. */
  async ageKeyPair() {
    const entry = join(this.consumer, 'node_modules', 'age-encryption', 'dist', 'index.js');
    const age = await import(pathToFileURL(entry).href);
    const identity = await age.generateX25519Identity();
    return { identity, recipient: await age.identityToRecipient(identity) };
  }

  saveLog(label, text) {
    if (!this.logDir) return;
    mkdirSync(this.logDir, { recursive: true });
    writeFileSync(join(this.logDir, `${label}.log`), text);
  }

  /**
   * With an image, SIGKILL the container a stand-in child started: a SIGKILL ends the stand-in
   * without a chance to pass it on, and the container would keep running. The container is named
   * after the stand-in's process id (imageCliSource).
   */
  killContainer(child) {
    if (this.image === null || child.pid === undefined) return;
    spawnSync('docker', ['kill', '--signal', 'KILL', `${this.image.namePrefix}-${child.pid}`], {
      stdio: 'ignore',
    });
  }

  /** Stop every child still running and drop every environment's databases and roles. */
  async dispose() {
    for (const served of [...this.serving]) await served.kill();
    for (const child of this.children) {
      if (child.exitCode !== null) continue;
      this.killContainer(child);
      child.kill('SIGKILL');
    }
    // A killed wrapper cannot stop its container; every container of this run carries the label.
    if (this.image !== null) removeLabelledContainers(this.image.label);
    for (const env of this.environments.splice(0).reverse()) await env.drop().catch(() => {});
  }
}

/**
 * A pre-release runtime is outside every caret range of its release line under npm's rules
 * (`^1.8.0` excludes `1.9.0-rc.0`), and pack refuses an extension whose `@rayspec` range excludes
 * the runtime the bundle pins. For a release candidate, the built extension's `@rayspec` ranges are
 * therefore set to `^<version>` of the candidate, and the change is returned so the run records it.
 * A release version changes nothing.
 */
export function platformRangesForRuntime(packageJsonPath, version) {
  if (!version.includes('-')) return [];
  const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const changed = [];
  for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
    if (!name.startsWith('@rayspec/')) continue;
    manifest.dependencies[name] = `^${version}`;
    changed.push({ name, from: range, to: `^${version}` });
  }
  writeFileSync(packageJsonPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return changed;
}

/** Environment variables a container of the image never takes from the journey. */
export const IMAGE_ENV_DROPPED = [
  'PATH',
  'HOME',
  'TMPDIR',
  'RAYSPEC_PG_DUMP',
  'RAYSPEC_PG_RESTORE',
];

/**
 * The source of a Node script that runs `rayspec <args>` in a container of `image`, standing in
 * for the installed CLI: the same arguments, working directory, environment and exit code.
 *
 *   - `mounts` are bind-mounted at their own real paths, so every path a journey passes means the
 *     same file inside the container; the working directory is the real path too, so a directory
 *     reached through a symbolic link (macOS keeps its temporary directories under /var, a link to
 *     /private/var) is still inside a mount;
 *   - the container runs as `user` (the journey's own, never root), so it reads the journey's
 *     private files and the installation stays read-only to it; `home` is its HOME;
 *   - every variable of the environment it is given is passed by name (`-e NAME`), so no value
 *     appears on a command line, except those in IMAGE_ENV_DROPPED: the image has its own PATH and
 *     its own pg_dump and pg_restore;
 *   - `network` is the container's network (`host` on Linux, where the journey's servers, proxies
 *     and database are on 127.0.0.1);
 *   - SIGTERM and SIGINT are passed to the container with `docker kill --signal`; every container
 *     carries `label`, so one left by a SIGKILL is removed by the run.
 */
export function imageCliSource({
  image,
  network,
  label,
  namePrefix = 'rayspec-journey',
  mounts,
  user,
  home,
}) {
  const config = {
    image,
    network,
    label,
    namePrefix,
    mounts,
    user,
    home,
    dropped: IMAGE_ENV_DROPPED,
  };
  return [
    `#!/usr/bin/env node`,
    "'use strict';",
    "const { spawn, spawnSync } = require('node:child_process');",
    "const { realpathSync } = require('node:fs');",
    `const config = ${JSON.stringify(config)};`,
    "const name = config.namePrefix + '-' + process.pid;",
    'const env = { ...process.env };',
    'const names = Object.keys(env).filter((k) => !config.dropped.includes(k) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k));',
    "const args = ['run', '--rm', '--name', name, '--label', config.label, '--network', config.network,",
    "  '--ulimit', 'core=0', '--user', config.user, '-w', process.cwd(), '-e', 'HOME=' + config.home,",
    "  ...config.mounts.map((m) => realpathSync(m)).flatMap((m) => ['-v', m + ':' + m]),",
    "  ...names.flatMap((k) => ['-e', k]),",
    '  config.image, ...process.argv.slice(2)];',
    "const child = spawn('docker', args, { env, stdio: ['ignore', 'inherit', 'inherit'] });",
    "for (const signal of ['SIGTERM', 'SIGINT']) {",
    "  process.on(signal, () => spawnSync('docker', ['kill', '--signal', signal.slice(3), name], { stdio: 'ignore' }));",
    '}',
    "child.on('exit', (code) => process.exit(code ?? 1));",
    '',
  ].join('\n');
}

/** Remove every container carrying `label`, running or not. */
export function removeLabelledContainers(label) {
  const listed = spawnSync('docker', ['ps', '-aq', '--filter', `label=${label}`], {
    encoding: 'utf8',
  });
  const ids = (listed.stdout ?? '').split('\n').filter(Boolean);
  if (ids.length > 0) spawnSync('docker', ['rm', '-f', ...ids], { stdio: 'ignore' });
  return ids.length;
}

function hostTool(name) {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, name);
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (probe.status === 0) return { path: candidate, version: probe.stdout };
  }
  return null;
}

/**
 * An absolute path to `name` of the server's `major`: the host's when its major matches, otherwise
 * a wrapper in `dir` that runs it from the pinned postgres image through `docker run`, with the
 * libpq environment passed through.
 */
export function pgToolPath(name, major, dir) {
  const host = hostTool(name);
  const match = host === null ? null : /\(PostgreSQL\)\s+(\d+)/.exec(host.version);
  if (host !== null && match !== null && Number(match[1]) === major) return host.path;
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
      "const { dirname } = require('node:path');",
      "const lists = process.argv.slice(2).filter((a) => a.startsWith('--use-list=/')).map((a) => dirname(a.slice(11)));",
      "const mounts = lists.flatMap((d) => ['-v', d + ':' + d + ':ro']);",
      `const args = ['run', '--rm', '-i', '--add-host=host.docker.internal:host-gateway', ...pass, ...mounts, ${JSON.stringify(POSTGRES_IMAGE)}, ${JSON.stringify(name)}, ...process.argv.slice(2)];`,
      "const child = spawn('docker', args, { env, stdio: 'inherit' });",
      "for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => child.kill(s));",
      "child.on('exit', (code) => process.exit(code ?? 1));",
      '',
    ].join('\n'),
  );
  chmodSync(wrapper, 0o755);
  return wrapper;
}

/** A private file (mode 0600) holding `text`. */
export function privateFile(path, text) {
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

/** A private directory (mode 0700). */
export function privateDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

/**
 * One self-hosted environment: its databases with roles of its own, its directory (state directory,
 * blob root, the secrets it was deployed with), and the environment its CLI runs get.
 */
export class Environment {
  constructor(ctx, label, { workflowSystem = false } = {}) {
    this.ctx = ctx;
    this.label = label;
    this.workflowSystem = workflowSystem;
    const suffix = randomBytes(4).toString('hex');
    this.db = `rsj_${label.replace(/[^a-z0-9]/g, '_')}_${suffix}`;
    this.sysDb = `${this.db}_dbos_sys`;
    this.roles = {
      migration: `rsj_${suffix}_migrator`,
      runtime: `rsj_${suffix}_runtime`,
      snapshot: `rsj_${suffix}_snapshot`,
    };
    this.passwords = {
      migration: randomBytes(16).toString('hex'),
      runtime: randomBytes(16).toString('hex'),
      snapshot: randomBytes(16).toString('hex'),
    };
    this.dir = privateDir(join(ctx.work, label));
    this.stateDir = join(this.dir, '.rayspec-state');
    this.blobRoot = privateDir(join(this.dir, 'blobs'));
    this.secrets = null;
    this.port = 0;
    ctx.environments.push(this);
  }

  url(db, role) {
    const u = new URL(withDbName(this.ctx.adminUrl, db));
    u.username = this.roles[role];
    u.password = this.passwords[role];
    return u.toString();
  }

  get base() {
    return `http://127.0.0.1:${this.port}`;
  }

  /** The databases of the environment: the application's, and the workflow system's when it has one. */
  databases() {
    return this.workflowSystem
      ? [
          [this.db, 'application'],
          [this.sysDb, 'workflow-system'],
        ]
      : [[this.db, 'application']];
  }

  /**
   * Create the databases and prepare each with the shipped database roles setup. The workflow
   * system database exists only for an application with a durable workflow: an export carries that
   * database whenever it exists.
   */
  async create() {
    await asAdmin(this.ctx.adminUrl, 'postgres', async (sql) => {
      for (const [name] of this.databases()) {
        await sql.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
        await sql.unsafe(`CREATE DATABASE "${name}"`);
      }
    });
    for (const [db, kind] of this.databases()) {
      await asAdmin(this.ctx.adminUrl, db, async (sql) => {
        await sql.begin(async (tx) => {
          await tx.unsafe(
            `SELECT set_config('rayspec.migration_role', $1, true), set_config('rayspec.runtime_role', $2, true),
                    set_config('rayspec.snapshot_role', $3, true), set_config('rayspec.database_kind', $4, true)`,
            [this.roles.migration, this.roles.runtime, this.roles.snapshot, kind],
          );
          await tx.unsafe(this.ctx.rolesSql);
        });
      });
    }
    await asAdmin(this.ctx.adminUrl, this.db, async (sql) => {
      for (const key of ['migration', 'runtime', 'snapshot']) {
        const [stmt] = await sql.unsafe(
          "SELECT format('ALTER ROLE %I PASSWORD %L', $1::text, $2::text) AS stmt",
          [this.roles[key], this.passwords[key]],
        );
        await sql.unsafe(stmt.stmt);
      }
    });
    this.port = await freePort();
    return this;
  }

  /** Boot secrets minted for a first deploy (an import mints its target's own instead). */
  mintSecrets() {
    const dir = privateDir(join(this.dir, 'secrets'));
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    privateFile(
      join(dir, 'jwt-signing-key.pem'),
      privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    );
    privateFile(join(dir, 'api-key-pepper'), randomBytes(32).toString('base64'));
    this.secrets = dir;
    return dir;
  }

  /** The environment the deployment's CLI runs get, with `extra` on top. */
  env(extra = {}) {
    const out = {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      DATABASE_URL: this.url(this.db, 'runtime'),
      RAYSPEC_MIGRATION_DATABASE_URL: this.url(this.db, 'migration'),
      RAYSPEC_SNAPSHOT_DATABASE_URL: this.url(this.db, 'snapshot'),
      SHADOW_DATABASE_URL: this.ctx.shadowUrl,
      RAYSPEC_BLOB_ROOT: this.blobRoot,
      ALLOWED_ORIGINS: '',
      ...extra,
    };
    if (this.workflowSystem) out.DBOS_SYSTEM_DATABASE_URL = this.url(this.sysDb, 'runtime');
    if (this.secrets !== null) {
      out.RAYSPEC_JWT_SIGNING_KEY_FILE = join(this.secrets, 'jwt-signing-key.pem');
      out.RAYSPEC_API_KEY_PEPPER_FILE = join(this.secrets, 'api-key-pepper');
    }
    if (this.ctx.pgTools !== null) {
      out.RAYSPEC_PG_DUMP = this.ctx.pgTools.pgDump;
      out.RAYSPEC_PG_RESTORE = this.ctx.pgTools.pgRestore;
    }
    return out;
  }

  /** The deployment id the state directory records. */
  deploymentId() {
    return JSON.parse(readFileSync(join(this.stateDir, 'deployment.json'), 'utf8')).deploymentId;
  }

  /** The bundle digest `active.json` names. */
  active() {
    return JSON.parse(readFileSync(join(this.stateDir, 'active.json'), 'utf8')).bundleSha256;
  }

  async query(text, params = []) {
    return asAdmin(this.ctx.adminUrl, this.db, (sql) => sql.unsafe(text, params));
  }

  async fence() {
    const [row] = await this.query(
      'SELECT fence_state AS state, fence_epoch::int AS epoch FROM runtime_control_state WHERE id = 1',
    );
    return row ?? null;
  }

  async drop() {
    await asAdmin(this.ctx.adminUrl, 'postgres', async (sql) => {
      for (const name of [this.db, this.sysDb]) {
        await sql.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      }
      for (const role of Object.values(this.roles)) {
        await sql.unsafe(`DROP ROLE IF EXISTS "${role}"`);
      }
    });
  }
}

/** The installed CLI, run to completion: exit code, the one envelope on stdout, stderr. */
export function rayspec(ctx, args, { env, cwd, timeout = 300_000 } = {}) {
  const run = spawnSync(process.execPath, [ctx.cli, ...args], {
    cwd: cwd ?? ctx.work,
    env: env ?? { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    encoding: 'utf8',
    timeout,
    maxBuffer: 64 * 1024 * 1024,
  });
  let envelope = {};
  try {
    envelope = JSON.parse(run.stdout);
  } catch {
    envelope = {};
  }
  return { status: run.status, envelope, stdout: run.stdout ?? '', stderr: run.stderr ?? '' };
}

/** `rayspec` without blocking the journey: resolves to the same shape once the process exits. */
export function rayspecAsync(ctx, args, { env, cwd, timeout = 300_000 } = {}) {
  const child = spawn(process.execPath, [ctx.cli, ...args], {
    cwd: cwd ?? ctx.work,
    env: env ?? { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => {
    stdout += String(d);
  });
  child.stderr.on('data', (d) => {
    stderr += String(d);
  });
  const timer = setTimeout(() => {
    ctx.killContainer(child);
    child.kill('SIGKILL');
  }, timeout);
  return new Promise((resolve) => {
    child.on('close', (status) => {
      clearTimeout(timer);
      let envelope = {};
      try {
        envelope = JSON.parse(stdout);
      } catch {
        envelope = {};
      }
      resolve({ status, envelope, stdout, stderr });
    });
  });
}

/** Everything `secrets` holds must be absent from `text`. */
export function leaks(text, secrets) {
  return secrets.filter((s) => s !== '' && text.includes(s)).length;
}

/**
 * `rayspec deploy <bundle> --plan-digest <digest>` kept serving: resolves once `/health` answers
 * 200. `stop()` sends SIGTERM and returns the exit code and the envelope; `kill()` sends SIGKILL.
 */
export async function serve(ctx, environment, bundle, planDigest, { env, label, extra = [] } = {}) {
  const child = spawn(
    process.execPath,
    [
      ctx.cli,
      'deploy',
      bundle,
      '--plan-digest',
      planDigest,
      '--state-dir',
      environment.stateDir,
      '--port',
      String(environment.port),
      ...extra,
    ],
    { cwd: environment.dir, env: env ?? environment.env(), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  ctx.children.add(child);
  let stdout = '';
  let output = '';
  child.stdout.on('data', (d) => {
    stdout += String(d);
    output += String(d);
  });
  child.stderr.on('data', (d) => {
    output += String(d);
  });
  const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
  const name = label ?? `${environment.label}-serve`;
  const deadline = Date.now() + 180_000;
  for (;;) {
    if (child.exitCode !== null) {
      await exited;
      ctx.saveLog(name, output);
      throw new JourneyFailure(`the deploy of ${environment.label} exited ${child.exitCode}`);
    }
    try {
      if ((await fetch(`${environment.base}/health`)).status === 200) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      ctx.killContainer(child);
      child.kill('SIGKILL');
      ctx.saveLog(name, output);
      throw new JourneyFailure(`the deploy of ${environment.label} did not serve within 180 s`);
    }
    await pause(250);
  }
  const handle = {
    child,
    output: () => output,
    async stop() {
      child.kill('SIGTERM');
      const { code } = await exited;
      ctx.children.delete(child);
      ctx.serving.delete(handle);
      ctx.saveLog(name, output);
      let envelope = {};
      try {
        envelope = JSON.parse(stdout);
      } catch {
        envelope = {};
      }
      return { code, envelope };
    },
    async kill() {
      ctx.killContainer(child);
      child.kill('SIGKILL');
      const result = await exited;
      ctx.children.delete(child);
      ctx.serving.delete(handle);
      ctx.saveLog(`${name}-killed`, output);
      return result;
    },
  };
  ctx.serving.add(handle);
  return handle;
}

/** A dry run and the reviewed deploy of `bundle`, serving. Returns the plan and the server. */
export async function deployServing(ctx, journey, environment, bundle, options = {}) {
  const extra = options.extra ?? [];
  const dry = rayspec(
    ctx,
    ['deploy', bundle, '--dry-run', '--state-dir', environment.stateDir, ...extra],
    { env: options.env ?? environment.env(), cwd: environment.dir },
  );
  journey.check(
    `${environment.label}: the deploy dry run plans ${options.what ?? bundle}`,
    dry.status === 0,
    `${dry.status} ${JSON.stringify(dry.envelope.errors)} ${dry.stderr.slice(-2000)}`,
  );
  const plan = dry.envelope.data;
  journey.check(
    `${environment.label}: the plan has no blocker`,
    plan.plan.blockers.length === 0,
    JSON.stringify(plan.plan.blockers),
  );
  const served = await serve(ctx, environment, bundle, plan.planDigest, {
    env: options.env,
    label: options.label,
    extra,
  });
  return { plan, served };
}

/** An HTTP call: status, headers, the parsed JSON body (or {}), the text. */
export async function call(url, { token, method = 'GET', body, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (token !== undefined) h.authorization = `Bearer ${token}`;
  let payload;
  if (raw !== undefined) payload = raw;
  else if (body !== undefined) {
    h['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(url, {
    method,
    headers: h,
    ...(payload === undefined ? {} : { body: payload }),
  });
  const text = await res.text();
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {
    json = {};
  }
  return { status: res.status, headers: res.headers, body: json, text };
}

/** A password that satisfies the platform's length rule, generated per run. */
export function newPassword(label) {
  return [label, 'pass', randomBytes(9).toString('base64url')].join('-');
}

/** Register `email` with `password`; the unscoped access token. */
export async function register(base, email, password) {
  const res = await call(`${base}/v1/auth/register`, { method: 'POST', body: { email, password } });
  if (res.status !== 200 && res.status !== 201) {
    throw new JourneyFailure(`register answered ${res.status}: ${res.text.slice(0, 200)}`);
  }
  return res.body.accessToken;
}

/** Sign in with a password and switch into `orgId`: the organization-scoped token, or the status. */
export async function signIn(base, email, password, orgId) {
  const login = await call(`${base}/v1/auth/login`, { method: 'POST', body: { email, password } });
  if (login.status !== 200) return { status: login.status, token: null };
  if (login.body.activeOrgId === orgId) return { status: 200, token: login.body.accessToken };
  const switched = await call(`${base}/v1/orgs/${orgId}/switch`, {
    method: 'POST',
    token: login.body.accessToken,
  });
  return { status: switched.status, token: switched.body.accessToken ?? null };
}

/**
 * `rayspec export` of a deployment, serving or not: role separation holds the write barrier. The
 * run is returned for the caller to check (an export a journey expects to be refused, too).
 */
export function exportDeployment(ctx, environment, recipient, output, extra = []) {
  return rayspec(ctx, ...exportCommand(environment, recipient, output, extra));
}

/** `exportDeployment` without blocking the journey, for writes sent while the export runs. */
export function exportDeploymentAsync(ctx, environment, recipient, output, extra = []) {
  return rayspecAsync(ctx, ...exportCommand(environment, recipient, output, extra));
}

function exportCommand(environment, recipient, output, extra) {
  return [
    [
      'export',
      '--deployment',
      environment.deploymentId(),
      '--recipient',
      recipient,
      '--output',
      output,
      '--run-history',
      'included',
      '--confirm-quiesce',
      '--state-dir',
      environment.stateDir,
      ...extra,
    ],
    { env: environment.env(), cwd: environment.dir },
  ];
}

/**
 * `rayspec import` into the empty `target`: a dry run, then the import; returns the import's data,
 * the cutover token from stderr, and the secrets directory it minted.
 */
export function importInto(ctx, journey, target, bundle, identityFile, extra = []) {
  const dry = rayspec(
    ctx,
    [
      'import',
      bundle,
      '--target',
      target.stateDir,
      '--identity-file',
      identityFile,
      '--dry-run',
      ...extra,
    ],
    { env: target.env(), cwd: target.dir },
  );
  journey.check(
    `${target.label}: the import dry run finds the target eligible`,
    dry.status === 0 && dry.envelope.data?.eligible === true,
    `${dry.status} ${JSON.stringify(dry.envelope.errors)} ${dry.stderr.slice(-1500)}`,
  );
  const secretsOut = join(target.dir, 'secrets');
  const run = rayspec(
    ctx,
    [
      'import',
      bundle,
      '--target',
      target.stateDir,
      '--identity-file',
      identityFile,
      '--secrets-out',
      secretsOut,
      ...extra,
    ],
    { env: target.env(), cwd: target.dir },
  );
  journey.check(
    `${target.label}: the import restores and verifies`,
    run.status === 0 && run.envelope.data?.status === 'ready-for-cutover',
    `${run.status} ${JSON.stringify(run.envelope.errors)} ${run.stderr.slice(-2000)}`,
  );
  const token = /cutover token ([0-9a-f]{64}): works once/.exec(run.stderr)?.[1] ?? '';
  journey.check(`${target.label}: the import shows a cutover token once`, token !== '');
  journey.check(
    `${target.label}: the cutover token is on stderr only`,
    !run.stdout.includes(token) && run.stderr.split(token).length === 2,
  );
  target.secrets = secretsOut;
  const cut = rayspec(ctx, ['import', '--target', target.stateDir, '--cutover-token', token], {
    env: target.env(),
    cwd: target.dir,
  });
  journey.check(
    `${target.label}: the cutover token releases the target`,
    cut.status === 0,
    `${cut.status} ${JSON.stringify(cut.envelope.errors)}`,
  );
  return { data: run.envelope.data, stderr: run.stderr, dry: dry.envelope.data };
}

/**
 * The entry names of a ZIP archive (a `.ray` bundle), read from its central directory. Throws on a
 * file that is not a single-disk ZIP; enough for a bundle, which is never a ZIP64 archive.
 */
export function zipEntryNames(bytes) {
  const END = 0x06054b50;
  const CENTRAL = 0x02014b50;
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at -= 1) {
    if (bytes.readUInt32LE(at) === END) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new JourneyFailure('not a ZIP archive: no end of central directory');
  const count = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);
  const names = [];
  for (let i = 0; i < count; i += 1) {
    if (bytes.readUInt32LE(at) !== CENTRAL) {
      throw new JourneyFailure(`not a ZIP archive: central entry ${i} is malformed`);
    }
    const nameLength = bytes.readUInt16LE(at + 28);
    const extraLength = bytes.readUInt16LE(at + 30);
    const commentLength = bytes.readUInt16LE(at + 32);
    names.push(bytes.subarray(at + 46, at + 46 + nameLength).toString('utf8'));
    at += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

/**
 * Check that a migration bundle carries its data only encrypted: exactly the manifest and the age
 * payload, the payload an age file, and none of `plaintexts` anywhere in the file's bytes.
 */
export function checkEncryptedExport(journey, label, bundle, plaintexts) {
  const bytes = readFileSync(bundle);
  const names = zipEntryNames(bytes).sort();
  journey.check(
    `${label}: the export holds only its manifest and the encrypted payload`,
    JSON.stringify(names) === JSON.stringify(['payload/migration.age', 'ray.json']),
    JSON.stringify(names),
  );
  journey.check(
    `${label}: the payload is an age file`,
    bytes.includes(Buffer.from('age-encryption.org/v1')),
  );
  if (plaintexts.length === 0) throw new JourneyFailure(`${label}: no plaintext to look for`);
  const found = plaintexts.filter((text) => bytes.includes(Buffer.from(text, 'utf8')));
  journey.check(
    `${label}: no stored value is readable in the export (${plaintexts.length} looked for)`,
    found.length === 0,
    `${found.length} found`,
  );
}

/** Every row of `table` of database `db`, in a stable text form, for comparing two environments. */
export async function tableText(adminUrl, db, table, schema = 'public') {
  return asAdmin(adminUrl, db, async (sql) =>
    (await sql.unsafe(`SELECT t::text AS row FROM "${schema}"."${table}" t ORDER BY t::text`)).map(
      (r) => r.row,
    ),
  );
}

// ─── TLS and egress for the custom-handler journey ───────────────────────────────────────────────

/**
 * A throwaway P-256 certificate authority and a server certificate it signed for `host`, made with
 * the openssl command line (arguments, never a shell string). The CA certificate is the only file a
 * deployment reads (NODE_EXTRA_CA_CERTS); the keys stay in this process.
 */
export function testCertificates(dir, host) {
  const version = spawnSync('openssl', ['version'], { encoding: 'utf8' });
  if (version.status !== 0) throw new JourneyFailure('the openssl command line is needed');
  mkdirSync(dir, { recursive: true });
  const p = (name) => join(dir, name);
  const openssl = (args) => {
    const run = spawnSync('openssl', args, { encoding: 'utf8' });
    if (run.status !== 0) throw new JourneyFailure(`openssl ${args[0]} failed: ${run.stderr}`);
  };
  const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes'];
  openssl([
    'req',
    '-x509',
    ...ec,
    '-keyout',
    p('ca.key'),
    '-out',
    p('ca.pem'),
    '-days',
    '1',
    '-subj',
    '/CN=reference journeys test CA',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign',
  ]);
  openssl([
    'req',
    ...ec,
    '-keyout',
    p('server.key'),
    '-out',
    p('server.csr'),
    '-subj',
    `/CN=${host}`,
  ]);
  writeFileSync(
    p('server.ext'),
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
    p('server.ext'),
  ]);
  return {
    caFile: p('ca.pem'),
    key: readFileSync(p('server.key')),
    cert: readFileSync(p('server.pem')),
  };
}

async function listen(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  return {
    server,
    port: address.port,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

/**
 * The classification service: HTTPS with the test certificate, answering `{ category }` for
 * `?content_type=` (`image` for image types, `document` otherwise), recording each request path.
 */
export async function startClassifier(certs) {
  const requests = [];
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
 * classification service; any other CONNECT, and any plain HTTP request, is refused and recorded.
 */
export async function startEgressProxy(upstreamPort, allowed) {
  const tunnelled = [];
  const denied = [];
  const server = createHttpServer((req, res) => {
    denied.push(req.url ?? '');
    res.statusCode = 403;
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
