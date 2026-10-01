/**
 * `rayspec export` and `rayspec resume` on GROUND TRUTH: the real built CLI in real child
 * processes, a real deployment served by `rayspec deploy <file.ray>` with role separation (a
 * migration, a runtime and a read-only snapshot role), its durable worker and workflow system
 * database, a cron trigger, an fs blob root, and the operator's `pg_dump`.
 *
 * In order, on one environment:
 *  1. Refusals that never touch the fence: a deployment id of another state directory.
 *  2. Without role separation and without `--source-stopped`, export fences the source, finds no
 *     database write barrier and refuses before any capture (`database-barrier-unavailable`); the
 *     source stays fenced and mutations answer 503. `resume` refuses another epoch
 *     (`RAY_FENCE_MISMATCH`) and releases the matching one.
 *  3. A writer, an uploader and the cron trigger run against the server while an export runs. They
 *     are blocked once the fence holds (503, no new tick), and the snapshot is consistent: every
 *     acknowledged note and upload is in it, the restored dumps hold exactly the counted rows, which
 *     are the live rows (the source is still fenced and still the same), the object index is the
 *     blob root. The runtime role cannot write. The output decrypts with the matching identity and
 *     not with another, passes the reader's migration-kind checks, and is mode 0600; no plaintext is
 *     left anywhere. The receipts — the local one and the environment's — record every transition,
 *     and the local one names no secret, store or record.
 *  4. A second export while fenced reuses the fence at the same epoch.
 *  5. An export killed during the capture leaves the source fenced and its scratch directory behind;
 *     the next export removes it, closes the killed export's receipt and succeeds at the same epoch.
 *  6. SIGINT during the capture ends `pg_dump`, removes the scratch directory, keeps the fence and
 *     reports `RAY_INTERRUPTED` with the resume instruction (exit 6).
 *  7. `resume` releases the fence; writes are accepted again.
 *  8. Without role separation, on a stopped source attested with `--source-stopped`, the export
 *     succeeds and says which barrier held (`database-stopped-source`) and which did not apply.
 *
 * `pg_dump` and `pg_restore`: the host's when their major is the server's, else the pinned postgres
 * image through docker (test-support/pg-tools.ts). Skips without DATABASE_URL; a REQUIRED run (CI,
 * RAYSPEC_REQUIRE_DB_TESTS) fails instead, and the ran-guard fails a required run whose arms did not
 * all run.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { inspectBundle, inspectSnapshotArchive } from '@rayspec/bundle';
import {
  MIGRATION_CIPHERTEXT_PATH,
  SNAPSHOT_PATHS,
  type Snapshot,
  schemaValidator,
} from '@rayspec/bundle-contract';
import { createRuntimeRoleLane, type RuntimeRoleLane } from '@rayspec/db/testing';
import { listFsBlobs } from '@rayspec/platform';
import { Decrypter, generateX25519Identity, identityToRecipient } from 'age-encryption';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  backendSpec,
  removeTemporaryDirectories,
  temporaryDirectory,
  writeTree,
} from '../../../kernel/bundle-closure/src/test-support/app.js';
import { runPack } from './pack.js';
import { CLI_DIST, type ParsedJson } from './test-support/bundles.js';
import { holdingPgDump, pgToolPath, runPgTool } from './test-support/pg-tools.js';

const baseUrl = process.env.DATABASE_URL;
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (dbRequired && !baseUrl) {
  throw new Error(
    'export.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — ' +
      'refusing to silently skip this DB-backed suite.',
  );
}
let armsRan = 0;
const ARMS = 8;

const SUITE_DB = `rayspec_export_cli_${process.pid}`;
const SYS_DB = `${SUITE_DB}_dbos_sys`;
const RESTORE_DB = `${SUITE_DB}_restore`;
const RESTORE_SYS_DB = `${SUITE_DB}_restore_sys`;
const TENANT = '00000000-0000-4000-8000-0000000e9071';
const valid = schemaValidator('resultEnvelope');
/** The inert provider key the agent declaration needs at boot; never used, never printed. */
const KEY = ['inert', 'export', randomUUID()].join('-');

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

function withDbName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

const SPEC = backendSpec(
  'deployment:\n  durableWorker: true\n' +
    'stores:\n' +
    '  - name: export_notes\n    columns:\n      - { name: body, type: text }\n' +
    '  - name: export_ticks\n    columns:\n      - { name: trigger_name, type: text }\n' +
    'api:\n' +
    "  - { method: POST, path: '/notes', action: { kind: store, store: export_notes, op: create } }\n" +
    "  - { method: GET, path: '/notes', action: { kind: store, store: export_notes, op: list } }\n" +
    "  - { method: POST, path: '/uploads/{upload_id}', action: { kind: stream, handler: ingest, mode: ingest } }\n" +
    'agents:\n  - { id: echo, name: echo, backend: openai, model: gpt-4o-mini, instructions: Echo. }\n' +
    'triggers:\n' +
    "  - { name: every-second, kind: cron, schedule: '* * * * * *', action: { kind: handler, handler: tick } }\n" +
    'handlers:\n' +
    '  - { id: tick, module: handlers/tick.js, export: tick, kind: trigger, uses: [] }\n' +
    '  - { id: ingest, module: handlers/ingest.js, export: ingest, kind: route, uses: [blob] }\n',
);
const TICK =
  'export async function tick(init) {\n' +
  "  await init.db.insert('export_ticks', { trigger_name: init.triggerName });\n}\n";
const INGEST =
  'export async function ingest(init) {\n' +
  '  const bytes = new Uint8Array(await init.request.arrayBuffer());\n' +
  "  await init.blob.put('uploads/' + init.params.upload_id, bytes);\n" +
  "  return new Response(JSON.stringify({ stored: bytes.length }), { status: 200, headers: { 'content-type': 'application/json' } });\n}\n";

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

/** The data of each entry of a stored ZIP in the strict profile, by name. */
function zipEntries(archive: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let at = 0;
  while (archive.readUInt32LE(at) === 0x04034b50) {
    const size = archive.readUInt32LE(at + 22);
    const nameLength = archive.readUInt16LE(at + 26);
    const extraLength = archive.readUInt16LE(at + 28);
    const name = archive.subarray(at + 30, at + 30 + nameLength).toString('utf8');
    const start = at + 30 + nameLength + extraLength;
    out.set(name, archive.subarray(start, start + size));
    at = start + size;
  }
  return out;
}

interface CliRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  envelope: ParsedJson;
  stdout: string;
  stderr: string;
  /** How many of the suite's secrets the output carried: always 0. */
  leaked: number;
}

describe.skipIf(!baseUrl)('rayspec export and rayspec resume — one environment', () => {
  let adminUrl = '';
  let lane: RuntimeRoleLane;
  let roles: {
    app: { migration: string; runtime: string; snapshot: string };
    sys: { migration: string; runtime: string; snapshot: string };
  };
  let deployDir = '';
  let toolsDir = '';
  let blobRoot = '';
  let bindings = '';
  let pem = '';
  let port = 0;
  let pgDump = '';
  let pgRestore = '';
  let bundle = '';
  let identity = '';
  let recipient = '';
  let server: { child: ChildProcess; exited: Promise<number | null> } | undefined;
  let token = '';
  const children: ChildProcess[] = [];
  const state = () => join(deployDir, '.rayspec-state');

  /**
   * Every value that must never appear in any output, receipt or log: the passwords of the
   * deployment's roles (random) and the provider key. (The suite's superuser password is a common
   * word of the development setup, so it cannot be told apart from ordinary text.)
   */
  const secrets = (): string[] =>
    [roles.app.migration, roles.app.runtime, roles.app.snapshot, roles.sys.runtime]
      .map((u) => decodeURIComponent(new URL(u).password))
      .filter((p) => p !== '')
      .concat([KEY]);

  function roleEnv(): Record<string, string> {
    return {
      DATABASE_URL: roles.app.runtime,
      RAYSPEC_MIGRATION_DATABASE_URL: roles.app.migration,
      RAYSPEC_SNAPSHOT_DATABASE_URL: roles.app.snapshot,
      DBOS_SYSTEM_DATABASE_URL: roles.sys.runtime,
    };
  }
  function singleRoleEnv(): Record<string, string> {
    return { DATABASE_URL: withDbName(adminUrl, SUITE_DB) };
  }
  function cliEnv(db: Record<string, string>, extra: Record<string, string> = {}) {
    return {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      ...db,
      RAYSPEC_BLOB_ROOT: blobRoot,
      RAYSPEC_PG_DUMP: pgDump,
      ...extra,
    };
  }

  /** Start the CLI; resolves with its exit and its one envelope once it ends. */
  function start(
    args: string[],
    env: NodeJS.ProcessEnv,
  ): {
    child: ChildProcess;
    done: Promise<CliRun>;
  } {
    const child = spawn(process.execPath, [CLI_DIST, ...args], { cwd: deployDir, env });
    children.push(child);
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr?.on('data', (d) => {
      stderr += String(d);
    });
    const done = new Promise<CliRun>((resolve) => {
      child.on('exit', (code, signal) => {
        let envelope: ParsedJson = {};
        try {
          envelope = JSON.parse(stdout) as ParsedJson;
        } catch {
          envelope = { unparsed: stdout };
        }
        const leaked = secrets().filter((s) => `${stdout}${stderr}`.includes(s)).length;
        resolve({ code, signal, envelope, stdout, stderr, leaked });
      });
    });
    return { child, done };
  }

  async function cli(args: string[], env: NodeJS.ProcessEnv): Promise<CliRun> {
    const run = await start(args, env).done;
    expect(run.leaked, 'a secret reached the output').toBe(0);
    expect(valid(run.envelope), `${JSON.stringify(valid.errors)}\n${run.stderr}`).toBe(true);
    return run;
  }

  function exportArgs(output: string, extra: string[] = []): string[] {
    return [
      'export',
      '--deployment',
      deploymentId(),
      '--recipient',
      recipient,
      '--output',
      output,
      '--run-history',
      'included',
      '--confirm-quiesce',
      ...extra,
    ];
  }

  function deploymentId(): string {
    return (
      JSON.parse(readFileSync(join(state(), 'deployment.json'), 'utf8')) as { deploymentId: string }
    ).deploymentId;
  }

  /** A short-lived superuser connection: none may stay open while an export runs. */
  async function asAdmin<T>(fn: (sql: postgres.Sql) => Promise<T>, db = SUITE_DB): Promise<T> {
    const sql = postgres(withDbName(adminUrl, db), { max: 1, onnotice: () => {} });
    try {
      return await fn(sql);
    } finally {
      await sql.end();
    }
  }
  async function fence(): Promise<{ state: string; epoch: number }> {
    return asAdmin(async (sql) => {
      const [row] = await sql.unsafe(
        'SELECT fence_state AS state, fence_epoch::int AS epoch FROM runtime_control_state WHERE id = 1',
      );
      return row as { state: string; epoch: number };
    });
  }
  async function count(table: string): Promise<number> {
    return asAdmin(async (sql) => {
      const [row] = await sql.unsafe(`SELECT count(*)::int AS n FROM ${table}`);
      return (row as { n: number }).n;
    });
  }

  function http(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (token !== '') headers.set('authorization', `Bearer ${token}`);
    return fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers });
  }
  function postNote(body: string): Promise<Response> {
    return http('/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body }),
    });
  }

  /** Post a note until it is accepted or ten seconds pass; the last status. */
  async function noteUntilAccepted(body: string): Promise<number> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const status = (await postNote(body)).status;
      if (status === 201 || Date.now() > deadline) return status;
      await pause(200);
    }
  }

  async function stopServer(): Promise<void> {
    if (server === undefined || server.child.exitCode !== null) return;
    server.child.kill('SIGTERM');
    expect(await server.exited).toBe(0);
    server = undefined;
  }

  /** Decrypt the bundle's ciphertext with `key` and read the inner archive. */
  async function decrypt(path: string, key: string): Promise<Buffer> {
    const ciphertext = zipEntries(readFileSync(path)).get(MIGRATION_CIPHERTEXT_PATH);
    if (ciphertext === undefined) throw new Error('no ciphertext');
    const d = new Decrypter();
    d.addIdentity(key);
    return Buffer.from(await d.decrypt(ciphertext));
  }

  beforeAll(async () => {
    if (!baseUrl) return;
    adminUrl = baseUrl;
    await asAdmin(async (sql) => {
      for (const name of [SUITE_DB, SYS_DB, RESTORE_DB, RESTORE_SYS_DB]) {
        await sql.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      }
      await sql.unsafe(`CREATE DATABASE "${SUITE_DB}"`);
    }, 'postgres');
    lane = createRuntimeRoleLane();
    const app = await lane.prepare(withDbName(adminUrl, SUITE_DB), 'application');
    const sys = await lane.prepare(withDbName(adminUrl, SYS_DB), 'workflow-system');
    if (app === undefined || sys === undefined) throw new Error('the role lane was not prepared');
    roles = { app, sys };

    const [{ major }] = (await asAdmin((sql) =>
      sql.unsafe("SELECT current_setting('server_version_num')::int / 10000 AS major"),
    )) as unknown as [{ major: number }];
    toolsDir = temporaryDirectory('export-tools-');
    const dump = pgToolPath('pg_dump', major, toolsDir);
    pgDump = dump.path;
    pgRestore = pgToolPath('pg_restore', major, toolsDir).path;
    console.error(`[export suite] pg_dump and pg_restore of major ${major} via ${dump.via}`);

    identity = await generateX25519Identity();
    recipient = await identityToRecipient(identity);
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    pem = await exportPKCS8(privateKey);
    deployDir = temporaryDirectory('export-deploy-');
    blobRoot = join(deployDir, 'blobs');
    mkdirSync(blobRoot);
    bindings = join(temporaryDirectory('export-bindings-'), 'bindings.json');
    writeFileSync(
      bindings,
      JSON.stringify({
        bindingsFormatVersion: 1,
        bindings: [{ name: 'OPENAI_API_KEY', value: KEY }],
      }),
    );
    chmodSync(bindings, 0o600);

    // Pack the application, then deploy it with the real CLI: a dry-run, then the reviewed plan.
    const source = temporaryDirectory('export-source-');
    writeTree(source, {
      'rayspec.yaml': SPEC,
      'package.json': JSON.stringify({ name: 'export-app', private: true, type: 'module' }),
      'handlers/tick.js': TICK,
      'handlers/ingest.js': INGEST,
    });
    const packed = await runPack(
      ['--spec', join(source, 'rayspec.yaml'), '--output', join(source, 'app.ray')],
      { operationId: randomUUID(), cliVersion: '1.8.0' },
    );
    expect(packed.envelope.ok, JSON.stringify(packed.envelope.errors)).toBe(true);
    bundle = join(deployDir, 'app.ray');
    copyFileSync(join(source, 'app.ray'), bundle);
    port = await freePort();
    const deployEnv = {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      DATABASE_URL: roles.app.runtime,
      RAYSPEC_MIGRATION_DATABASE_URL: roles.app.migration,
      DBOS_SYSTEM_DATABASE_URL: roles.sys.runtime,
      SHADOW_DATABASE_URL: process.env.SHADOW_DATABASE_URL ?? adminUrl,
      RAYSPEC_JWT_SIGNING_KEY: pem,
      RAYSPEC_API_KEY_PEPPER: 'export-suite-pepper',
      RAYSPEC_BLOB_ROOT: blobRoot,
      RAYSPEC_CRON_TENANT_ID: TENANT,
    };
    const dry = spawnSync(
      process.execPath,
      [CLI_DIST, 'deploy', bundle, '--dry-run', '--bindings-file', bindings],
      { cwd: deployDir, env: deployEnv, encoding: 'utf8', timeout: 180_000 },
    );
    expect(dry.status, dry.stderr).toBe(0);
    const planDigest = (JSON.parse(dry.stdout) as ParsedJson).data.planDigest as string;
    const applied = spawn(
      process.execPath,
      [
        CLI_DIST,
        'deploy',
        bundle,
        '--plan-digest',
        planDigest,
        '--port',
        String(port),
        '--bindings-file',
        bindings,
      ],
      { cwd: deployDir, env: { ...deployEnv, ALLOWED_ORIGINS: '' } },
    );
    let out = '';
    applied.stdout?.on('data', (d) => {
      out += String(d);
    });
    applied.stderr?.on('data', (d) => {
      out += String(d);
    });
    const deadline = Date.now() + 150_000;
    for (;;) {
      if (applied.exitCode !== null) throw new Error(`deploy exited\n${out}`);
      try {
        if ((await fetch(`http://127.0.0.1:${port}/livez`)).status === 200) break;
      } catch {
        // not listening yet
      }
      if (Date.now() > deadline) throw new Error(`deploy did not serve\n${out}`);
      await pause(250);
    }
    server = { child: applied, exited: new Promise((r) => applied.on('exit', (c) => r(c))) };
    children.push(applied);

    // The one organization, its owner (a password holder) and a token scoped to it.
    await asAdmin((sql) =>
      sql.unsafe("INSERT INTO orgs (id, name, slug) VALUES ($1, 'Export Co', 'export-co')", [
        TENANT,
      ]),
    );
    const email = `owner-${randomUUID()}@example.test`;
    const reg = await http('/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'a-long-enough-password' }),
    });
    expect([200, 201]).toContain(reg.status);
    token = ((await reg.json()) as { accessToken: string }).accessToken;
    await asAdmin(async (sql) => {
      const [user] = await sql.unsafe('SELECT id FROM users WHERE email = $1', [email]);
      await sql.unsafe(
        "INSERT INTO memberships (org_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active')",
        [TENANT, (user as { id: string }).id],
      );
    });
    const switched = await http(`/v1/orgs/${TENANT}/switch`, { method: 'POST' });
    expect(switched.status).toBe(200);
    token = ((await switched.json()) as { accessToken: string }).accessToken;
    // The cron trigger is ticking.
    const tickDeadline = Date.now() + 30_000;
    while ((await count('export_ticks')) === 0) {
      if (Date.now() > tickDeadline) throw new Error(`no cron tick\n${out}`);
      await pause(250);
    }
  }, 400_000);

  afterAll(async () => {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
    if (deployDir !== '') spawnSync('chmod', ['-R', 'u+w', deployDir]);
    removeTemporaryDirectories();
    if (!baseUrl) return;
    await asAdmin(async (sql) => {
      for (const name of [SUITE_DB, SYS_DB, RESTORE_DB, RESTORE_SYS_DB]) {
        await sql.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      }
    }, 'postgres').catch(() => {});
    await lane?.drop().catch(() => {});
    if (dbRequired) expect(armsRan).toBe(ARMS);
  }, 120_000);

  it('refuses a deployment id of another state directory without touching the fence', async () => {
    const before = await fence();
    const run = await cli(
      exportArgs(join(deployDir, 'never.ray')).map((a) =>
        a === deploymentId() ? 'ffffffffffffffff' : a,
      ),
      cliEnv(roleEnv()),
    );
    expect(run.code).toBe(2);
    expect(run.envelope.errors[0]).toMatchObject({ code: 'RAY_USAGE', path: '/deployment' });
    expect(await fence()).toEqual(before);
    expect(existsSync(join(deployDir, 'never.ray'))).toBe(false);
    armsRan += 1;
  }, 60_000);

  it('without a database barrier, fences, refuses before any capture and stays fenced; resume releases only the matching epoch', async () => {
    const before = await fence();
    expect(before.state).toBe('open');
    const run = await cli(exportArgs(join(deployDir, 'no-barrier.ray')), cliEnv(singleRoleEnv()));
    expect(run.code, run.stderr).toBe(3);
    expect(run.envelope.errors[0]).toMatchObject({
      code: 'RAY_EXTERNAL_STATE_UNSUPPORTED',
      reason: 'database-barrier-unavailable',
    });
    const epoch = before.epoch + 1;
    expect(await fence()).toEqual({ state: 'fenced', epoch });
    expect(run.envelope.errors[0].message).toContain(
      `rayspec resume --deployment ${deploymentId()} --fence-epoch ${epoch}`,
    );
    expect(existsSync(join(deployDir, 'no-barrier.ray'))).toBe(false);
    expect((await postNote('during the fence')).status).toBe(503);
    expect(readdirSync(join(state(), 'scratch'))).toEqual([]);

    const wrong = await cli(
      ['resume', '--deployment', deploymentId(), '--fence-epoch', String(epoch - 1)],
      cliEnv(singleRoleEnv()),
    );
    expect(wrong.code).toBe(4);
    expect(wrong.envelope.errors[0].code).toBe('RAY_FENCE_MISMATCH');
    const resumed = await cli(
      ['resume', '--deployment', deploymentId(), '--fence-epoch', String(epoch)],
      cliEnv(singleRoleEnv()),
    );
    expect(resumed.code, resumed.stderr).toBe(0);
    expect(resumed.envelope.data).toMatchObject({ fenceEpoch: epoch, released: true });
    // Every runtime process sees the fence open within a second.
    expect(await noteUntilAccepted('after resume')).toBe(201);
    armsRan += 1;
  }, 180_000);

  let firstExport: CliRun;
  const acknowledged = { notes: [] as string[], uploads: [] as string[] };

  it('blocks a concurrent writer, uploader and cron trigger, and writes a consistent, encrypted snapshot', async () => {
    const statuses: { kind: 'note' | 'upload'; status: number; at: number }[] = [];
    let running = true;
    let n = 0;
    const writer = (async () => {
      while (running) {
        const body = `note-${n++}`;
        const res = await postNote(body).catch(() => null);
        if (res !== null) {
          statuses.push({ kind: 'note', status: res.status, at: Date.now() });
          if (res.status === 201) acknowledged.notes.push(body);
        }
        await pause(30);
      }
    })();
    let u = 0;
    const uploader = (async () => {
      while (running) {
        const key = `up-${u++}`;
        const res = await http(`/uploads/${key}`, {
          method: 'POST',
          body: Buffer.from(`bytes of ${key}`),
        }).catch(() => null);
        if (res !== null) {
          statuses.push({ kind: 'upload', status: res.status, at: Date.now() });
          if (res.status === 200) acknowledged.uploads.push(key);
        }
        await pause(50);
      }
    })();
    try {
      // Both are writing before the export starts.
      const ready = Date.now() + 30_000;
      while (acknowledged.notes.length < 5 || acknowledged.uploads.length < 3) {
        if (Date.now() > ready) throw new Error(`no writes: ${JSON.stringify(statuses.slice(-5))}`);
        await pause(100);
      }
      firstExport = await cli(exportArgs(join(deployDir, 'first.ray')), cliEnv(roleEnv()));
      await pause(1_500);
    } finally {
      running = false;
      await Promise.all([writer, uploader]);
    }
    const run = firstExport;
    expect(run.code, run.stderr).toBe(0);
    const f = await fence();
    expect(f.state).toBe('fenced');
    const data = run.envelope.data as ParsedJson;
    expect(data).toMatchObject({
      deploymentId: deploymentId(),
      outputPath: join(deployDir, 'first.ray'),
      fenceEpoch: f.epoch,
      sourceState: 'fenced',
    });
    expect(data.excludedDataCategories).toEqual([
      'credential-state',
      'request-replay-state',
      'runtime-control-state',
      'security-audit-log',
    ]);
    expect(data.recovery).toContain(
      `rayspec resume --deployment ${deploymentId()} --fence-epoch ${f.epoch}`,
    );
    expect(data.recovery).toContain('database-write-role held');
    expect(data.recovery).toContain('snapshot read as snapshot-role');

    // Once refused, the writer and the uploader were never accepted again: the fence held.
    for (const kind of ['note', 'upload'] as const) {
      const seen = statuses.filter((s) => s.kind === kind);
      const firstRefused = seen.findIndex((s) => s.status === 503);
      expect(firstRefused, kind).toBeGreaterThan(0);
      expect(
        seen.slice(firstRefused).every((s) => s.status === 503),
        kind,
      ).toBe(true);
    }
    // Still fenced: no write, no upload, no tick.
    expect((await postNote('after the export')).status).toBe(503);
    const ticks = await count('export_ticks');
    await pause(2_500);
    expect(await count('export_ticks')).toBe(ticks);
    // The runtime role cannot write at all while the barrier holds.
    const runtime = postgres(roles.app.runtime, { max: 1, onnotice: () => {} });
    try {
      await expect(
        runtime.unsafe(`INSERT INTO export_notes (tenant_id, body) VALUES ('${TENANT}', 'direct')`),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await runtime.end();
    }

    // The bundle: mode 0600, the reader's migration-kind checks, the digests the result names.
    const out = join(deployDir, 'first.ray');
    const bytes = readFileSync(out);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(sha(bytes)).toBe(data.sha256);
    const read = await inspectBundle(out, { operation: 'import' });
    expect(read.ok, read.ok ? '' : JSON.stringify(read.errors)).toBe(true);
    if (!read.ok) return;
    expect(read.value.manifest.kind).toBe('migration');
    expect(read.value.manifest.inventory).toEqual([
      { path: MIGRATION_CIPHERTEXT_PATH, size: data.ciphertextSize, sha256: data.ciphertextSha256 },
    ]);
    const inspected = spawnSync(process.execPath, [CLI_DIST, 'bundle', 'inspect', out, '--json'], {
      encoding: 'utf8',
    });
    expect(inspected.status, inspected.stdout).toBe(0);

    // It decrypts with the matching identity, and not with another.
    const inner = await decrypt(out, identity);
    await expect(decrypt(out, await generateX25519Identity())).rejects.toThrow();
    const innerPath = join(temporaryDirectory('export-inner-'), 'snapshot.zip');
    writeFileSync(innerPath, inner, { mode: 0o600 });
    const snapshotRead = await inspectSnapshotArchive(innerPath);
    expect(snapshotRead.ok, snapshotRead.ok ? '' : JSON.stringify(snapshotRead.errors)).toBe(true);
    const entries = zipEntries(inner);
    const snapshot = JSON.parse(entries.get('snapshot.json')!.toString('utf8')) as Snapshot;
    expect(snapshot).toMatchObject({
      fenceEpoch: f.epoch,
      applicationTenantCount: 1,
      workflowSystemDatabase: 'included',
      runHistoryPolicy: 'included',
    });
    expect(read.value.manifest.application).toEqual({
      id: snapshot.applicationId,
      version: snapshot.applicationVersion,
    });

    // Consistent: every acknowledged write is in it, its counts are the live rows (nothing changed
    // since), and the restored dumps hold exactly those rows.
    const counted = (table: string) =>
      snapshot.tableCounts.find((t) => t.database === 'application' && t.table === table)?.rows;
    expect(counted('export_notes')).toBe(await count('export_notes'));
    expect(counted('export_ticks')).toBe(await count('export_ticks'));
    await asAdmin(async (sql) => {
      await sql.unsafe(`CREATE DATABASE "${RESTORE_DB}"`);
      await sql.unsafe(`CREATE DATABASE "${RESTORE_SYS_DB}"`);
    }, 'postgres');
    const restored = await runPgTool(
      pgRestore,
      withDbName(adminUrl, RESTORE_DB),
      ['--exit-on-error', `--dbname=${RESTORE_DB}`],
      entries.get(SNAPSHOT_PATHS.database),
    );
    expect(restored.code, restored.stderr).toBe(0);
    const restoredSys = await runPgTool(
      pgRestore,
      withDbName(adminUrl, RESTORE_SYS_DB),
      ['--exit-on-error', `--dbname=${RESTORE_SYS_DB}`],
      entries.get(SNAPSHOT_PATHS.workflowSystem),
    );
    expect(restoredSys.code, restoredSys.stderr).toBe(0);
    for (const [db, database] of [
      [RESTORE_DB, 'application'],
      [RESTORE_SYS_DB, 'workflow-system'],
    ] as const) {
      await asAdmin(async (sql) => {
        for (const t of snapshot.tableCounts.filter((c) => c.database === database)) {
          const [row] = await sql.unsafe(
            `SELECT count(*)::int AS n FROM "${t.schema}"."${t.table}"`,
          );
          expect((row as { n: number }).n, `${database} ${t.schema}.${t.table}`).toBe(t.rows);
        }
      }, db);
    }
    const restoredNotes = await asAdmin(
      async (sql) => (await sql.unsafe('SELECT body FROM export_notes')).map((r) => String(r.body)),
      RESTORE_DB,
    );
    for (const body of acknowledged.notes) expect(restoredNotes, body).toContain(body);
    // The objects: the index is the blob root, which is what every acknowledged upload left.
    const index = JSON.parse(entries.get(SNAPSHOT_PATHS.objectIndex)!.toString('utf8')) as {
      objects: { tenantId: string; key: string; sha256: string }[];
    };
    const live = await listFsBlobs(blobRoot);
    expect(index.objects.map((o) => [o.tenantId, o.key, o.sha256])).toEqual(
      live.map((o) => [o.tenantId, o.key, o.sha256]),
    );
    expect(snapshot.objectCount).toBe(live.length);
    for (const key of acknowledged.uploads) {
      expect(
        index.objects.map((o) => o.key),
        key,
      ).toContain(`uploads/${key}`);
    }

    // No plaintext anywhere: the scratch directory is empty, nothing but the bundle was written.
    expect(readdirSync(join(state(), 'scratch'))).toEqual([]);
    expect(readdirSync(deployDir).filter((e) => e.endsWith('.ray') || e.startsWith('.'))).toEqual(
      ['.rayspec-state', 'app.ray', 'first.ray'].sort(),
    );

    // The receipts: every transition, locally and in the environment.
    const operationId = run.envelope.operationId as string;
    const receiptPath = join(state(), 'receipts', `export-${operationId}.json`);
    expect(statSync(receiptPath).mode & 0o777).toBe(0o600);
    const receiptText = readFileSync(receiptPath, 'utf8');
    const receipt = JSON.parse(receiptText) as ParsedJson;
    expect(receipt).toMatchObject({
      operation: 'export',
      operationId,
      actor: 'rayspec-export',
      deploymentId: deploymentId(),
      outcome: 'exported',
      summary: {
        objectCount: live.length,
        reader: 'snapshot-role',
        workflowSystemDatabase: 'included',
      },
    });
    expect((receipt.transitions as ParsedJson[]).map((t) => t.state)).toEqual([
      'PRECHECK',
      'QUIESCING',
      'FROZEN',
      'EXPORTING',
      'EXPORTED',
    ]);
    for (const t of receipt.transitions as ParsedJson[]) {
      expect(t.at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/);
      expect(typeof t.fenceEpoch).toBe('number');
      expect(t.recovery.length).toBeGreaterThan(0);
    }
    expect((receipt.transitions as ParsedJson[]).at(-1)).toMatchObject({
      fenceEpoch: f.epoch,
      digests: {
        migrationBundleSha256: data.sha256,
        ciphertextSha256: data.ciphertextSha256,
        applicationDigest: snapshot.applicationDigest,
      },
    });
    // Shareable: no secret, recipient, path, record, key or store name.
    for (const s of [
      ...secrets(),
      recipient,
      deployDir,
      'note-1',
      'up-1',
      'export_notes',
      'export_ticks',
    ]) {
      expect(receiptText.includes(s), s.slice(0, 12)).toBe(false);
    }
    const dbReceipts = await asAdmin((sql) =>
      sql.unsafe(
        `SELECT operation_kind AS kind, event, step, outcome, digest FROM runtime_control_receipts
          WHERE operation_id = $1 ORDER BY id`,
        [operationId],
      ),
    );
    expect(
      dbReceipts.filter((r) => r.kind === 'export').map((r) => [r.event, r.step, r.outcome]),
    ).toEqual([
      ['step-finished', 'PRECHECK', null],
      ['step-finished', 'QUIESCING', null],
      ['step-finished', 'FROZEN', null],
      ['step-finished', 'EXPORTING', null],
      ['outcome', 'EXPORTED', 'succeeded'],
    ]);
    expect(dbReceipts.filter((r) => r.kind === 'export').at(-1)?.digest).toBe(data.sha256);
    // The quiesce the export ran is recorded under the same operation.
    expect(dbReceipts.some((r) => r.kind === 'runtime.quiesce' && r.event === 'intent')).toBe(true);
    armsRan += 1;
  }, 300_000);

  it('a second export while fenced reuses the fence at its epoch', async () => {
    const before = await fence();
    expect(before.state).toBe('fenced');
    const run = await cli(exportArgs(join(deployDir, 'second.ray')), cliEnv(roleEnv()));
    expect(run.code, run.stderr).toBe(0);
    expect(run.envelope.data.fenceEpoch).toBe(before.epoch);
    expect(await fence()).toEqual(before);
    const inner = await decrypt(join(deployDir, 'second.ray'), identity);
    const snapshot = JSON.parse(
      zipEntries(inner).get('snapshot.json')!.toString('utf8'),
    ) as Snapshot;
    expect(snapshot.fenceEpoch).toBe(before.epoch);
    armsRan += 1;
  }, 180_000);

  it('an export killed during the capture leaves the source fenced; the next one cleans up and succeeds', async () => {
    const before = await fence();
    const marker = join(toolsDir, 'killed.started');
    const release = join(toolsDir, 'killed.release');
    const holding = holdingPgDump(pgDump, toolsDir, marker, release);
    const output = join(deployDir, 'killed.ray');
    const started = start(exportArgs(output), cliEnv(roleEnv(), { RAYSPEC_PG_DUMP: holding }));
    const deadline = Date.now() + 120_000;
    while (!existsSync(marker)) {
      if (started.child.exitCode !== null || Date.now() > deadline) {
        throw new Error(`the capture never started\n${(await started.done).stderr}`);
      }
      await pause(100);
    }
    const dumpPid = Number(readFileSync(marker, 'utf8'));
    started.child.kill('SIGKILL');
    const killed = await started.done;
    expect(killed.leaked).toBe(0);
    expect(killed.signal).toBe('SIGKILL');
    // The held pg_dump notices and exits on its own.
    const gone = Date.now() + 10_000;
    while (Date.now() < gone) {
      try {
        process.kill(dumpPid, 0);
        await pause(100);
      } catch {
        break;
      }
    }
    expect(() => process.kill(dumpPid, 0)).toThrow();
    expect(await fence()).toEqual(before);
    expect(existsSync(output)).toBe(false);
    const left = readdirSync(join(state(), 'scratch')).sort();
    expect(left[0]).toBe('export.lock');
    expect(left.some((e) => e.startsWith('rayspec-snapshot-'))).toBe(true);
    const killedId = /operationId: ([0-9a-f-]{36})/.exec(killed.stderr)?.[1];
    expect(killedId).toBeDefined();

    const next = await cli(exportArgs(join(deployDir, 'after-kill.ray')), cliEnv(roleEnv()));
    expect(next.code, next.stderr).toBe(0);
    expect(next.envelope.data.fenceEpoch).toBe(before.epoch);
    expect(next.stderr).toContain(`interrupted export (${killedId})`);
    expect(readdirSync(join(state(), 'scratch'))).toEqual([]);
    const closed = JSON.parse(
      readFileSync(join(state(), 'receipts', `export-${killedId}.json`), 'utf8'),
    ) as ParsedJson;
    expect(closed.outcome).toBe('blocked');
    expect((closed.transitions as ParsedJson[]).at(-1)).toMatchObject({
      state: 'BLOCKED',
      interrupted: true,
      closedBy: next.envelope.operationId,
      error: { code: 'RAY_INTERRUPTED' },
    });
    const killedReceipts = await asAdmin((sql) =>
      sql.unsafe(
        `SELECT step, outcome FROM runtime_control_receipts
          WHERE operation_id = $1 AND operation_kind = 'export' ORDER BY id`,
        [killedId],
      ),
    );
    expect(killedReceipts.at(-1)).toMatchObject({ step: 'BLOCKED', outcome: 'failed' });
    armsRan += 1;
  }, 300_000);

  it('SIGINT during the capture ends pg_dump, removes the scratch data and keeps the fence', async () => {
    const before = await fence();
    const marker = join(toolsDir, 'interrupted.started');
    const release = join(toolsDir, 'interrupted.release');
    const holding = holdingPgDump(pgDump, toolsDir, marker, release);
    const output = join(deployDir, 'interrupted.ray');
    const started = start(exportArgs(output), cliEnv(roleEnv(), { RAYSPEC_PG_DUMP: holding }));
    const deadline = Date.now() + 120_000;
    while (!existsSync(marker)) {
      if (started.child.exitCode !== null || Date.now() > deadline) {
        throw new Error(`the capture never started\n${(await started.done).stderr}`);
      }
      await pause(100);
    }
    const dumpPid = Number(readFileSync(marker, 'utf8'));
    started.child.kill('SIGINT');
    const run = await started.done;
    expect(run.leaked).toBe(0);
    expect(run.code, run.stderr).toBe(6);
    expect(valid(run.envelope)).toBe(true);
    expect(run.envelope.errors[0].code).toBe('RAY_INTERRUPTED');
    expect(run.envelope.errors[0].message).toContain(
      `rayspec resume --deployment ${deploymentId()} --fence-epoch ${before.epoch}`,
    );
    expect(() => process.kill(dumpPid, 0)).toThrow();
    expect(await fence()).toEqual(before);
    expect(existsSync(output)).toBe(false);
    expect(readdirSync(join(state(), 'scratch'))).toEqual([]);
    const receipt = JSON.parse(
      readFileSync(join(state(), 'receipts', `export-${run.envelope.operationId}.json`), 'utf8'),
    ) as ParsedJson;
    expect(receipt.outcome).toBe('blocked');
    expect((receipt.transitions as ParsedJson[]).at(-1)).toMatchObject({
      state: 'BLOCKED',
      fenceEpoch: before.epoch,
      fenceState: 'fenced',
      error: { code: 'RAY_INTERRUPTED' },
    });
    armsRan += 1;
  }, 300_000);

  it('resume releases the fence the exports held, and writes are accepted again', async () => {
    const before = await fence();
    const run = await cli(
      ['resume', '--deployment', deploymentId(), '--fence-epoch', String(before.epoch)],
      cliEnv(roleEnv()),
    );
    expect(run.code, run.stderr).toBe(0);
    expect(run.envelope.data).toMatchObject({ fenceEpoch: before.epoch, released: true });
    expect(await noteUntilAccepted('after the exports')).toBe(201);
    // The runtime role writes again.
    const runtime = postgres(roles.app.runtime, { max: 1, onnotice: () => {} });
    try {
      await runtime.begin(async (tx) => {
        await tx.unsafe(`SELECT set_config('app.current_tenant', '${TENANT}', true)`);
        await tx.unsafe(
          `INSERT INTO export_notes (tenant_id, body) VALUES ('${TENANT}', 'direct')`,
        );
      });
    } finally {
      await runtime.end();
    }
    const again = await cli(
      ['resume', '--deployment', deploymentId(), '--fence-epoch', String(before.epoch)],
      cliEnv(roleEnv()),
    );
    expect(again.code).toBe(0);
    expect(again.envelope.data).toMatchObject({ released: false });
    armsRan += 1;
  }, 120_000);

  it('without role separation, exports a stopped source the operator attests, and says which barrier held', async () => {
    await stopServer();
    const before = await fence();
    expect(before.state).toBe('open');
    const run = await cli(
      exportArgs(join(deployDir, 'stopped.ray'), ['--source-stopped']).map((a) =>
        a === 'included' ? 'excluded' : a,
      ),
      cliEnv(singleRoleEnv()),
    );
    expect(run.code, run.stderr).toBe(0);
    const data = run.envelope.data as ParsedJson;
    expect(data.fenceEpoch).toBe(before.epoch + 1);
    expect(data.recovery).toContain(
      'database-stopped-source held, database-write-role not-applied, object-writes held',
    );
    expect(data.recovery).toContain('snapshot read as single-role');
    expect(data.excludedDataCategories).toContain('run-history');
    const inner = await decrypt(join(deployDir, 'stopped.ray'), identity);
    const snapshot = JSON.parse(
      zipEntries(inner).get('snapshot.json')!.toString('utf8'),
    ) as Snapshot;
    expect(snapshot.runHistoryPolicy).toBe('excluded');
    expect(await fence()).toEqual({ state: 'fenced', epoch: before.epoch + 1 });
    armsRan += 1;
  }, 180_000);
});
