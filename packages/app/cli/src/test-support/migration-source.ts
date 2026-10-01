/**
 * A migration SOURCE for the import suites, built the way an operator builds one: an application
 * packed with `rayspec pack`, deployed with the real CLI (`rayspec deploy <file.ray>`) under role
 * separation on databases of its own, with a durable worker, a cron trigger and an fs blob root;
 * seeded through its HTTP API with two users, rows that hold non-ASCII text, NULLs and a foreign key,
 * and files; then exported with `rayspec export` to an age X25519 recipient.
 *
 * The suites that use it compare the import against `expected()`, which reads the source as the
 * superuser after the export, while the source is fenced and cannot change.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { createRuntimeRoleLane, type RuntimeRoleLane } from '@rayspec/db/testing';
import { generateX25519Identity, identityToRecipient } from 'age-encryption';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import {
  backendSpec,
  temporaryDirectory,
  writeTree,
} from '../../../../kernel/bundle-closure/src/test-support/app.js';
import { runPack } from '../pack.js';
import { CLI_DIST, type ParsedJson } from './bundles.js';
import { pgToolPath } from './pg-tools.js';

/** The organization of the source: its one application tenant. */
export const SOURCE_TENANT = '00000000-0000-4000-8000-00000000a171';

/** Text that is not ASCII, in a row and in a file. */
export const NON_ASCII = 'Grüße aus Köln — 東京 🌍 ✓';

export const SOURCE_SPEC = backendSpec(
  'deployment:\n  durableWorker: true\n' +
    'stores:\n' +
    '  - name: import_projects\n    columns:\n' +
    '      - { name: name, type: text }\n' +
    '      - { name: archived, type: boolean, nullable: true }\n' +
    '  - name: import_notes\n    columns:\n' +
    '      - { name: project_id, type: uuid }\n' +
    '      - { name: body, type: text }\n' +
    '      - { name: score, type: integer, nullable: true }\n' +
    '      - { name: details, type: jsonb, nullable: true }\n' +
    '    foreignKeys:\n' +
    '      - { column: project_id, references: import_projects, onDelete: cascade }\n' +
    '  - name: import_ticks\n    columns:\n      - { name: trigger_name, type: text }\n' +
    'api:\n' +
    "  - { method: POST, path: '/projects', action: { kind: store, store: import_projects, op: create } }\n" +
    "  - { method: POST, path: '/notes', action: { kind: store, store: import_notes, op: create } }\n" +
    "  - { method: GET, path: '/notes', action: { kind: store, store: import_notes, op: list } }\n" +
    "  - { method: POST, path: '/uploads/{upload_id}', action: { kind: stream, handler: ingest, mode: ingest } }\n" +
    'agents:\n  - { id: echo, name: echo, backend: openai, model: gpt-4o-mini, instructions: Echo. }\n' +
    'triggers:\n' +
    "  - { name: every-second, kind: cron, schedule: '* * * * * *', action: { kind: handler, handler: tick } }\n" +
    'handlers:\n' +
    '  - { id: tick, module: handlers/tick.js, export: tick, kind: trigger, uses: [] }\n' +
    '  - { id: ingest, module: handlers/ingest.js, export: ingest, kind: route, uses: [blob] }\n',
);
export const TICK =
  'export async function tick(init) {\n' +
  "  await init.db.insert('import_ticks', { trigger_name: init.triggerName });\n}\n";
export const INGEST =
  'export async function ingest(init) {\n' +
  '  const bytes = new Uint8Array(await init.request.arrayBuffer());\n' +
  "  const type = init.request.headers.get('content-type');\n" +
  "  await init.blob.put('uploads/' + init.params.upload_id, bytes, type ? { contentType: type } : {});\n" +
  "  return new Response(JSON.stringify({ stored: bytes.length }), { status: 200, headers: { 'content-type': 'application/json' } });\n}\n";

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function withDbName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

async function freePort(): Promise<number> {
  return await new Promise((res, rej) => {
    const probe = createServer();
    probe.on('error', rej);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      probe.close(() => res(port));
    });
  });
}

/** A short-lived superuser connection to `db`. */
export async function asAdmin<T>(
  adminUrl: string,
  db: string,
  fn: (sql: postgres.Sql) => Promise<T>,
): Promise<T> {
  const sql = postgres(withDbName(adminUrl, db), { max: 1, onnotice: () => {} });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

/** The role URLs of one database pair a role lane prepared. */
export interface LaneRoles {
  app: { migration: string; runtime: string; snapshot: string };
  sys: { migration: string; runtime: string; snapshot: string };
}

/** Prepare `db` and `<db>_dbos_sys` with a role lane of their own; `db` is created first. */
export async function prepareRoleDatabases(
  adminUrl: string,
  db: string,
  sysDb: string,
): Promise<{ lane: RuntimeRoleLane; roles: LaneRoles }> {
  await asAdmin(adminUrl, 'postgres', async (sql) => {
    for (const name of [db, sysDb]) {
      await sql.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }
    await sql.unsafe(`CREATE DATABASE "${db}"`);
  });
  const lane = createRuntimeRoleLane();
  const app = await lane.prepare(withDbName(adminUrl, db), 'application');
  const sys = await lane.prepare(withDbName(adminUrl, sysDb), 'workflow-system');
  if (app === undefined || sys === undefined) throw new Error('the role lane was not prepared');
  return { lane, roles: { app, sys } };
}

export interface MigrationSource {
  db: string;
  sysDb: string;
  roles: LaneRoles;
  lane: RuntimeRoleLane;
  deployDir: string;
  stateDir: string;
  blobRoot: string;
  deploymentId: string;
  pgDump: string;
  pgRestore: string;
  toolsDir: string;
  identity: string;
  recipient: string;
  /** The migration bundle the export wrote, and its envelope's data. */
  bundle: string;
  exported: ParsedJson;
  /** The application bundle the source runs, and the bindings file it was deployed with. */
  appBundle: string;
  bindings: string;
  /** The organization's two members: email and password, owner first. */
  members: { email: string; password: string }[];
  /** An access token the source issued to the owner, signed with the source's key. */
  sourceToken: string;
  /** Every password of the source's roles, which no output may carry. */
  secrets: string[];
  /** Stop the served source and drop its databases and roles. */
  dispose(): Promise<void>;
}

/**
 * Pack, deploy, seed and export a source. `name` keys the databases; the export runs with
 * `--run-history included` while the source serves, under the role barrier.
 */
export async function buildMigrationSource(
  adminUrl: string,
  name: string,
): Promise<MigrationSource> {
  const db = name;
  const sysDb = `${name}_dbos_sys`;
  const { lane, roles } = await prepareRoleDatabases(adminUrl, db, sysDb);
  const children: ChildProcess[] = [];
  const dispose = async () => {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
    await asAdmin(adminUrl, 'postgres', async (sql) => {
      for (const n of [db, sysDb]) await sql.unsafe(`DROP DATABASE IF EXISTS "${n}" WITH (FORCE)`);
    }).catch(() => {});
    await lane.drop().catch(() => {});
  };
  try {
    const [{ major }] = (await asAdmin(adminUrl, 'postgres', (sql) =>
      sql.unsafe("SELECT current_setting('server_version_num')::int / 10000 AS major"),
    )) as unknown as [{ major: number }];
    const toolsDir = temporaryDirectory('import-tools-');
    const pgDump = pgToolPath('pg_dump', major, toolsDir).path;
    const pgRestore = pgToolPath('pg_restore', major, toolsDir).path;

    const identity = await generateX25519Identity();
    const recipient = await identityToRecipient(identity);
    const { privateKey } = await generateKeyPair('RS256', {
      extractable: true,
      modulusLength: 2048,
    });
    const pem = await exportPKCS8(privateKey);
    const key = ['inert', 'import', randomUUID()].join('-');
    const deployDir = temporaryDirectory('import-source-');
    const blobRoot = join(deployDir, 'blobs');
    mkdirSync(blobRoot);
    const bindings = join(temporaryDirectory('import-bindings-'), 'bindings.json');
    writeFileSync(
      bindings,
      JSON.stringify({
        bindingsFormatVersion: 1,
        bindings: [{ name: 'OPENAI_API_KEY', value: key }],
      }),
    );
    chmodSync(bindings, 0o600);

    const source = temporaryDirectory('import-app-');
    writeTree(source, {
      'rayspec.yaml': SOURCE_SPEC,
      'package.json': JSON.stringify({ name: 'import-app', private: true, type: 'module' }),
      'handlers/tick.js': TICK,
      'handlers/ingest.js': INGEST,
    });
    const packed = await runPack(
      ['--spec', join(source, 'rayspec.yaml'), '--output', join(source, 'app.ray')],
      { operationId: randomUUID(), cliVersion: '1.8.0' },
    );
    if (!packed.envelope.ok) throw new Error(JSON.stringify(packed.envelope.errors));
    const appBundle = join(deployDir, 'app.ray');
    copyFileSync(join(source, 'app.ray'), appBundle);
    const port = await freePort();
    const deployEnv = {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      DATABASE_URL: roles.app.runtime,
      RAYSPEC_MIGRATION_DATABASE_URL: roles.app.migration,
      DBOS_SYSTEM_DATABASE_URL: roles.sys.runtime,
      SHADOW_DATABASE_URL: process.env.SHADOW_DATABASE_URL ?? adminUrl,
      RAYSPEC_JWT_SIGNING_KEY: pem,
      RAYSPEC_API_KEY_PEPPER: ['source', 'pepper', randomUUID()].join('-'),
      RAYSPEC_BLOB_ROOT: blobRoot,
      RAYSPEC_CRON_TENANT_ID: SOURCE_TENANT,
    };
    const dry = spawnSync(
      process.execPath,
      [CLI_DIST, 'deploy', appBundle, '--dry-run', '--bindings-file', bindings],
      { cwd: deployDir, env: deployEnv, encoding: 'utf8', timeout: 180_000 },
    );
    if (dry.status !== 0) throw new Error(`deploy --dry-run failed\n${dry.stderr}`);
    const planDigest = (JSON.parse(dry.stdout) as ParsedJson).data.planDigest as string;
    const served = spawn(
      process.execPath,
      [
        CLI_DIST,
        'deploy',
        appBundle,
        '--plan-digest',
        planDigest,
        '--port',
        String(port),
        '--bindings-file',
        bindings,
      ],
      {
        cwd: deployDir,
        env: { ...deployEnv, ALLOWED_ORIGINS: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    children.push(served);
    let out = '';
    served.stdout?.on('data', (d) => {
      out += String(d);
    });
    served.stderr?.on('data', (d) => {
      out += String(d);
    });
    const exited = new Promise<number | null>((r) => served.on('exit', (c) => r(c)));
    const deadline = Date.now() + 150_000;
    for (;;) {
      if (served.exitCode !== null) throw new Error(`deploy exited\n${out}`);
      try {
        if ((await fetch(`http://127.0.0.1:${port}/livez`)).status === 200) break;
      } catch {
        // not listening yet
      }
      if (Date.now() > deadline) throw new Error(`deploy did not serve\n${out}`);
      await pause(250);
    }

    // The organization and its two members, each with a password.
    let token = '';
    const http = (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      if (token !== '') headers.set('authorization', `Bearer ${token}`);
      return fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers });
    };
    const json = (body: unknown) => ({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    await asAdmin(adminUrl, db, (sql) =>
      sql.unsafe("INSERT INTO orgs (id, name, slug) VALUES ($1, 'Import Co — Ü', 'import-co')", [
        SOURCE_TENANT,
      ]),
    );
    const members: { email: string; password: string }[] = [];
    for (const who of ['owner', 'member']) {
      const email = `${who}-${randomUUID()}@example.test`;
      const password = [who, 'long', 'password', randomUUID().slice(0, 8)].join('-');
      const reg = await http('/v1/auth/register', json({ email, password }));
      if (reg.status !== 200 && reg.status !== 201) throw new Error(`register ${reg.status}`);
      if (who === 'owner') token = ((await reg.json()) as { accessToken: string }).accessToken;
      members.push({ email, password });
    }
    await asAdmin(adminUrl, db, async (sql) => {
      for (const [i, { email }] of members.entries()) {
        const [user] = await sql.unsafe('SELECT id FROM users WHERE email = $1', [email]);
        await sql.unsafe(
          "INSERT INTO memberships (org_id, user_id, role, status) VALUES ($1, $2, $3, 'active')",
          [SOURCE_TENANT, (user as { id: string }).id, i === 0 ? 'owner' : 'member'],
        );
      }
    });
    const switched = await http(`/v1/orgs/${SOURCE_TENANT}/switch`, { method: 'POST' });
    if (switched.status !== 200) throw new Error(`switch ${switched.status}`);
    token = ((await switched.json()) as { accessToken: string }).accessToken;

    // Rows: a project, notes that reference it, NULLs, non-ASCII text and JSON.
    const project = await http('/projects', json({ name: NON_ASCII, archived: null }));
    if (project.status !== 201)
      throw new Error(`project ${project.status} ${await project.text()}`);
    const projectId = ((await project.json()) as { id: string }).id;
    const second = await http('/projects', json({ name: 'plain', archived: true }));
    if (second.status !== 201) throw new Error(`project ${second.status}`);
    for (const note of [
      { project_id: projectId, body: NON_ASCII, score: 7, details: { tag: 'ü', list: [1, null] } },
      { project_id: projectId, body: 'no score', score: null, details: null },
      { project_id: projectId, body: "quote ' and \\ and \t tab", score: -3 },
    ]) {
      const res = await http('/notes', json(note));
      if (res.status !== 201) throw new Error(`note ${res.status} ${await res.text()}`);
    }
    // Files: binary bytes, non-ASCII bytes with a content type, and an empty file.
    const binary = Buffer.alloc(70_000);
    for (let i = 0; i < binary.length; i++) binary[i] = (i * 7919) % 256;
    for (const [keyName, bytes, type] of [
      ['binary', binary, undefined],
      ['text', Buffer.from(NON_ASCII, 'utf8'), 'text/plain; charset=utf-8'],
      ['empty', Buffer.alloc(0), undefined],
    ] as const) {
      const res = await http(`/uploads/${keyName}`, {
        method: 'POST',
        body: bytes,
        ...(type === undefined ? {} : { headers: { 'content-type': type } }),
      });
      if (res.status !== 200) throw new Error(`upload ${res.status} ${await res.text()}`);
    }
    // The cron trigger has ticked, so the workflow system database holds workflow rows.
    const tickDeadline = Date.now() + 30_000;
    for (;;) {
      const [row] = (await asAdmin(adminUrl, db, (sql) =>
        sql.unsafe('SELECT count(*)::int AS n FROM import_ticks'),
      )) as unknown as [{ n: number }];
      if (row.n > 0) break;
      if (Date.now() > tickDeadline) throw new Error(`no cron tick\n${out}`);
      await pause(250);
    }

    // The export, with role separation, while the source serves.
    const stateDir = join(deployDir, '.rayspec-state');
    const deploymentId = (
      JSON.parse(readFileSync(join(stateDir, 'deployment.json'), 'utf8')) as {
        deploymentId: string;
      }
    ).deploymentId;
    const bundle = join(deployDir, 'migration.ray');
    const exportRun = spawnSync(
      process.execPath,
      [
        CLI_DIST,
        'export',
        '--deployment',
        deploymentId,
        '--recipient',
        recipient,
        '--output',
        bundle,
        '--run-history',
        'included',
        '--confirm-quiesce',
      ],
      {
        cwd: deployDir,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          DATABASE_URL: roles.app.runtime,
          RAYSPEC_MIGRATION_DATABASE_URL: roles.app.migration,
          RAYSPEC_SNAPSHOT_DATABASE_URL: roles.app.snapshot,
          DBOS_SYSTEM_DATABASE_URL: roles.sys.runtime,
          RAYSPEC_BLOB_ROOT: blobRoot,
          RAYSPEC_PG_DUMP: pgDump,
        },
        encoding: 'utf8',
        timeout: 300_000,
      },
    );
    if (exportRun.status !== 0) {
      throw new Error(
        `export failed (${exportRun.status})\n${exportRun.stdout}\n${exportRun.stderr}`,
      );
    }
    const exported = (JSON.parse(exportRun.stdout) as ParsedJson).data as ParsedJson;
    served.kill('SIGTERM');
    await exited;

    const secrets = [roles.app.migration, roles.app.runtime, roles.app.snapshot, roles.sys.runtime]
      .map((u) => decodeURIComponent(new URL(u).password))
      .filter((p) => p !== '')
      .concat([key]);
    return {
      db,
      sysDb,
      roles,
      lane,
      deployDir,
      stateDir,
      blobRoot,
      deploymentId,
      pgDump,
      pgRestore,
      toolsDir,
      identity,
      recipient,
      bundle,
      exported,
      appBundle,
      bindings,
      members,
      sourceToken: token,
      secrets: [...secrets, ...members.map((m) => m.password)],
      dispose,
    };
  } catch (err) {
    await dispose();
    throw err;
  }
}
