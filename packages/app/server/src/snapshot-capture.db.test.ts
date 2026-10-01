/**
 * The snapshot producer on GROUND TRUTH: a bundle deployed through `applyBundle` into a real
 * database, a real workflow system database, a real fs blob root written through the blob store, the
 * fence taken by the real `quiesce`, and `pg_dump` / `pg_restore` of the server's major.
 *
 * WHAT THESE ARMS PROVE.
 *  - a capture under a held barrier writes an inner snapshot archive the snapshot reader accepts,
 *    whose `snapshot.json` states the application, the schema head, the fence epoch, one tenant, the
 *    workflow system database, the policies and every table's row count;
 *  - the object index lists exactly the objects of the blob root (tenant, key, logical size and
 *    SHA-256 as the header states them) and `objects.bin` holds each stored file unchanged;
 *  - the dumps restore into empty databases with the counted rows: non-ASCII text, NULLs, integers
 *    beyond 2^53, exact decimals, two users and the password hash survive; credential, replay, audit
 *    and runtime-control rows do not; run history follows the policy, and every exclusion is
 *    reported in `excludedDataCategories` and `excludedTables`;
 *  - the result says which barriers held (single role, stopped source: `database-stopped-source`
 *    held, `database-write-role` not applied) and who read (`single-role`);
 *  - every preflight refusal carries the contract's code: a second organization, no password holder,
 *    an unknown table, an extension, a blob of another tenant, an unfinished upload, an unreadable blob
 *    backend, the size budget, schema drift, a pg_dump of another major or none, a foreign deployment
 *    id; and every capture refusal: another epoch, a released fence, no database barrier, a foreign
 *    session, a run still running, and a blob written while the dumps ran.
 *
 * pg_dump and pg_restore: the host's, when its major is the server's; otherwise the same pinned
 * postgres image docker-compose.yml runs, through `docker run`. Skips without DATABASE_URL; a
 * REQUIRED run (CI, RAYSPEC_REQUIRE_DB_TESTS) fails instead, and the ran-guard fails a required run
 * whose arms did not all run.
 */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectSnapshotArchive, writeBundle } from '@rayspec/bundle';
import {
  CONTRACT_VERSION,
  formatTimestamp,
  type PrepareData,
  SNAPSHOT_PATHS,
  type Snapshot,
} from '@rayspec/bundle-contract';
import { type Db, makeDb } from '@rayspec/db';
import { createIsolatedTestDatabase } from '@rayspec/db/testing';
import { listFsBlobs, makeFsBlobStoreFactory } from '@rayspec/platform';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyBundle,
  bindingRevisions,
  initialBindingRevisionKey,
  liveSchemaHead,
} from './bundle-deploy.js';
import { applyMigrations } from './composition-root.js';
import { openStateDirectory, type StateDirectory } from './deployment-state.js';
import { connectionEnvironment, type PgDumpTool, pgDumpMajor, resolvePgDump } from './pg-dump.js';
import {
  createRuntimeControl,
  preparePlan,
  type ReadApplicationBundle,
  runtimeVersion,
} from './runtime-control.js';
import { type CaptureResult, captureSnapshot } from './snapshot-capture.js';
import { preflightSnapshot, type SnapshotSourceOptions } from './snapshot-source.js';
import { openControlDatabase } from './write-barrier.js';

const baseUrl = process.env.DATABASE_URL;
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (dbRequired && !baseUrl) {
  throw new Error(
    'snapshot-capture.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — ' +
      'refusing to silently skip this DB-backed suite.',
  );
}
let armsRan = 0;
const ARMS = 10;

const SUITE_DB = `rayspec_snapshot_${process.pid}`;
const SYS_DB = `${SUITE_DB}_dbos_sys`;
const RESTORE_DB = `${SUITE_DB}_restore`;
const RESTORE_SYS_DB = `${SUITE_DB}_restore_sys`;
const DEPLOYMENT = 'abcdef0123456789';
const PEPPER = 'snapshot-suite-pepper';
const PREPARED_AT = new Date();
/** The postgres image docker-compose.yml pins, for a host without client tools of the server major. */
const POSTGRES_IMAGE =
  'postgres:16@sha256:17e67d7b9890c99b055ba1e0d5c5be4ec27c9d3a72bda32db24a5e5d8a85af0c';

const SPEC = `version: '1.0'
metadata:
  name: field-notes
  description: notes with every kind of value a snapshot must carry
stores:
  - name: field_notes
    columns:
      - { name: title, type: text }
      - { name: body, type: text, nullable: true }
      - { name: views, type: bigint, nullable: true }
      - { name: amount, type: numeric, precision: 30, scale: 4, nullable: true }
      - { name: meta, type: jsonb, nullable: true }
api:
  - { method: POST, path: '/field-notes', action: { kind: store, store: field_notes, op: create } }
`;

/** Values a dump must carry exactly. 2^53 + 1 is not a JavaScript safe integer. */
const NOTE_TITLE = 'Grüße aus Köln — 東京 👋';
const BIG_VIEWS = '9007199254740993';
const EXACT_AMOUNT = '12345678901234567890123456.0001';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function withDbName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

/** The host's tool when its major is the server's, else the pinned image through docker. */
async function toolFor(name: 'pg_dump' | 'pg_restore', major: number): Promise<PgDumpTool> {
  const found = await resolvePgDump(
    name === 'pg_dump' ? undefined : (await resolvePgDump())?.command.replace(/pg_dump$/, name),
  );
  if (found !== null && (await pgDumpMajor(found).catch(() => null)) === major) return found;
  return {
    command: 'docker',
    args: [
      'run',
      '--rm',
      '-i',
      '--add-host=host.docker.internal:host-gateway',
      ...['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGCONNECT_TIMEOUT'].flatMap(
        (v) => ['-e', v],
      ),
      POSTGRES_IMAGE,
      name,
    ],
    rewriteHost: ({ host, port }) => ({
      host: host === 'localhost' || host === '127.0.0.1' ? 'host.docker.internal' : host,
      port,
    }),
  };
}

/** Run a tool with the libpq environment of `url`, `input` on stdin; resolves with its exit code. */
function runTool(
  tool: PgDumpTool,
  url: string,
  args: string[],
  input?: Buffer,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('PG')) env[k] = v;
    Object.assign(env, connectionEnvironment(url, tool.rewriteHost));
    const child = spawn(tool.command, [...(tool.args ?? []), ...args], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
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

/**
 * Deploy the bundle into `dbUrl` exactly as `rayspec deploy <file.ray>` does, give the workflow
 * system database the schema and rows the durable executor leaves, and seed one organization, two
 * users, rows of every category and four blobs. `dbUrl` and `sysUrl` connect as a role that may
 * migrate: the superuser, or the migration role.
 */
async function deployEnvironment(env: {
  dbUrl: string;
  sysUrl: string;
  dir: string;
  blobRoot: string;
  deploymentId: string;
}): Promise<{ stateDir: StateDirectory; orgId: string }> {
  let orgId = '';
  // The workflow system database, as the durable executor leaves it: its own schema and rows.
  const sys = postgres(env.sysUrl, { max: 1 });
  await sys.unsafe(`CREATE SCHEMA dbos;
    CREATE TABLE dbos.workflow_status (workflow_uuid text PRIMARY KEY, status text NOT NULL, inputs text);
    INSERT INTO dbos.workflow_status VALUES ('wf-1', 'SUCCESS', 'Eingabe ü'), ('wf-2', 'ENQUEUED', NULL);`);
  await sys.end();

  // Deploy the bundle, exactly as `rayspec deploy <file.ray>` does.
  const bundlePath = join(env.dir, 'field-notes.ray');
  const written = await writeBundle(bundlePath, {
    manifest: {
      formatVersion: 1,
      kind: 'application',
      application: { id: 'field-notes', version: '1.0.0' },
      runtime: { version: runtimeVersion() },
      target: { os: 'linux', arch: 'x64', nodeMajor: 22 },
      spec: 'payload/rayspec.yaml',
      requires: ['declarative-api', 'declarative-stores'],
      bindings: [],
      permissions: { egressHosts: [], execution: 'none' },
    },
    files: [
      { path: 'payload/rayspec.yaml', bytes: Buffer.from(SPEC) },
      {
        path: 'payload/sbom.cdx.json',
        bytes: Buffer.from(
          '{"bomFormat":"CycloneDX","components":[],"specVersion":"1.5","version":1}\n',
        ),
      },
      {
        path: 'payload/THIRD-PARTY-NOTICES.txt',
        bytes: Buffer.from('No third-party components are redistributed in this bundle.\n'),
      },
    ],
  });
  if (!written.ok) throw new Error(JSON.stringify(written.errors));
  const bundleSha = written.value.archiveSha256;
  const opened = await openStateDirectory(join(env.dir, 'state'), { create: true });
  if (opened === null) throw new Error('the state directory was not created');
  const stateDir = opened;
  await stateDir.createDeployment({
    deploymentFormatVersion: 1,
    deploymentId: env.deploymentId,
    createdAt: formatTimestamp(PREPARED_AT),
    applicationId: 'field-notes',
  });
  const db = makeDb(env.dbUrl);
  try {
    // The runtime-control tables first, so the plan is prepared against the head the apply sees.
    await applyMigrations(db);
    const shadowUrl = process.env.SHADOW_DATABASE_URL ?? (baseUrl as string);
    const prepared = await preparePlan(
      {
        contractVersion: CONTRACT_VERSION,
        operationId: randomUUID(),
        actor: 'supervisor:test',
        bundleSha256: bundleSha,
        bundlePath,
        bindingRevision: bindingRevisions(new Map(), initialBindingRevisionKey(PEPPER)),
        expectedSchemaHead: await liveSchemaHead(db),
      },
      { db, shadowDatabaseUrl: shadowUrl },
      { preparedAt: formatTimestamp(PREPARED_AT) },
    );
    if (!prepared.envelope.ok) throw new Error(JSON.stringify(prepared.envelope.errors));
    await stateDir.stageVersion(
      bundlePath,
      bundleSha,
      (prepared.bundle as ReadApplicationBundle).manifest,
    );
    const applied = await applyBundle({
      db,
      runtime: { shadowDatabaseUrl: shadowUrl },
      bundlePath,
      bundleSha256: bundleSha,
      planDigest: (prepared.envelope.data as PrepareData).planDigest,
      preparedAt: formatTimestamp(PREPARED_AT),
      bindingValues: new Map(),
      initialBindingRevisionKey: initialBindingRevisionKey(PEPPER),
      stateDir,
      deploymentId: env.deploymentId,
      migratePlatform: () => applyMigrations(db),
      operationId: randomUUID(),
    });
    if (!applied.envelope.ok) throw new Error(JSON.stringify(applied.envelope.errors));

    // One organization, two users (one with a password), and rows in every category.
    const [org] = await db.$client.unsafe(
      "INSERT INTO orgs (name, slug) VALUES ('Feldnotizen', 'feld') RETURNING id::text AS id",
    );
    orgId = String(org!.id);
    const [owner] = await db.$client.unsafe(
      "INSERT INTO users (email, password_hash) VALUES ('owner@example.test', $1) RETURNING id::text AS id",
      [`$argon2id$v=19$m=65536,t=3,p=4$${'c2FsdA'}$${'aGFzaA'}`],
    );
    const [member] = await db.$client.unsafe(
      "INSERT INTO users (email) VALUES ('member@example.test') RETURNING id::text AS id",
    );
    await db.$client.unsafe(
      `INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member')`,
      [orgId, owner!.id, member!.id],
    );
    await db.$client.unsafe(
      "INSERT INTO api_keys (org_id, key_hash, key_prefix) VALUES ($1, 'h1', 'p1')",
      [orgId],
    );
    await db.$client.unsafe("INSERT INTO auth_audit (event) VALUES ('login')");
    await db.$client.unsafe(
      `INSERT INTO sessions (user_id, token_hash, family_id, expires_at)
         VALUES ($1, 'th', gen_random_uuid(), now() + interval '1 day')`,
      [owner!.id],
    );
    await db.$client.unsafe(
      `INSERT INTO invites (tenant_id, email, role, token_hash, expires_at)
         VALUES ($1, 'next@example.test', 'member', 'ih', now() + interval '1 day')`,
      [orgId],
    );
    await db.$client.unsafe(
      `INSERT INTO runs (run_id, tenant_id, backend, auth_mode, agent_name, model, status)
         VALUES ('run-1', $1, 'openai', 'api-key', 'writer', 'm', 'succeeded'),
                ('run-2', $1, 'openai', 'api-key', 'writer', 'm', 'failed')`,
      [orgId],
    );
    await db.$client.unsafe(
      `INSERT INTO workflow_runs (workflow_run_id, tenant_id, workflow_id, idempotency_key,
                                  trigger_event, input_event, status)
         VALUES ('wr-1', $1, 'wf', 'k1', 'manual', '{"note":"ü"}', 'completed')`,
      [orgId],
    );
    await db.$client.unsafe(
      `INSERT INTO field_notes (tenant_id, title, body, views, amount, meta)
         VALUES ($1, $2, NULL, $3::bigint, $4::numeric, '{"tags":["ä","😀"]}'),
                ($1, 'second', 'zweite Notiz', NULL, NULL, NULL)`,
      [orgId, NOTE_TITLE, BIG_VIEWS, EXACT_AMOUNT],
    );
  } finally {
    await db.$client.end();
  }

  // The blobs, through the store itself.
  const store = makeFsBlobStoreFactory(env.blobRoot)(orgId);
  await store.put('uploads/bericht.pdf', Buffer.from('%PDF-1.7 Bericht'), {
    contentType: 'application/pdf',
  });
  await store.put('uploads/größe ä.txt', Buffer.from('Größe: 1 €', 'utf8'), {
    contentType: 'text/plain; charset=utf-8',
  });
  await store.put('audio/take-1.bin', Buffer.from([0, 1, 2, 3, 254, 255]));
  await store.put('empty', new Uint8Array(0));

  return { stateDir, orgId };
}

describe.skipIf(!baseUrl)('snapshot capture', () => {
  let dbUrl = '';
  let sysUrl = '';
  let dir = '';
  let blobRoot = '';
  let scratchParent = '';
  let admin: postgres.Sql;
  let control: Db;
  let stateDir: StateDirectory;
  let orgId = '';
  let pgDump: PgDumpTool;
  let pgRestore: PgDumpTool;
  const captured: string[] = [];

  /** A connection outside the control tag: it counts as someone else's session. */
  async function asOutsider<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
    const sql = postgres(dbUrl, {
      max: 1,
      connection: { application_name: 'snapshot-suite-outsider' },
    });
    try {
      return await fn(sql);
    } finally {
      await sql.end();
    }
  }

  function source(over: Partial<SnapshotSourceOptions> = {}): SnapshotSourceOptions {
    return {
      db: control,
      databaseUrl: dbUrl,
      stateDir,
      deploymentId: DEPLOYMENT,
      blob: { kind: 'fs', root: blobRoot },
      pgDump,
      scratchParent,
      ...over,
    };
  }

  function rc() {
    return createRuntimeControl({ db: control, quiescePollMs: 50 });
  }

  function base() {
    return {
      contractVersion: CONTRACT_VERSION,
      operationId: randomUUID(),
      actor: 'operator:snapshot-suite',
    };
  }

  async function quiesce(sourceStopped: boolean): Promise<number> {
    const r = await rc().quiesce({
      ...base(),
      reason: 'snapshot suite',
      deadline: formatTimestamp(new Date(Date.now() + 5_000)),
      sourceStopped,
    });
    expect(r.ok, JSON.stringify(r.errors)).toBe(true);
    return r.data!.fenceEpoch;
  }

  async function resume(): Promise<void> {
    const [row] = await control.$client.unsafe(
      'SELECT fence_state, fence_epoch::text AS e FROM runtime_control_state WHERE id = 1',
    );
    if (row?.fence_state === 'fenced') {
      const r = await rc().resume({ ...base(), fenceEpoch: Number(row.e) });
      expect(r.ok).toBe(true);
    }
  }

  async function capture(
    fenceEpoch: number,
    runHistoryPolicy: 'included' | 'excluded',
    over: Partial<SnapshotSourceOptions> = {},
  ): Promise<CaptureResult> {
    const result = await captureSnapshot({ ...source(over), fenceEpoch, runHistoryPolicy });
    if (result.ok) captured.push(result.value.scratchDir);
    return result;
  }

  async function blockers(over: Partial<SnapshotSourceOptions> = {}) {
    const r = await preflightSnapshot(source(over));
    return r.blockers.map((b) => `${b.code}/${b.reason ?? ''}`);
  }

  beforeAll(async () => {
    if (!baseUrl) return;
    dbUrl = withDbName(baseUrl, SUITE_DB);
    sysUrl = withDbName(baseUrl, SYS_DB);
    admin = postgres(withDbName(baseUrl, 'postgres'), { max: 1, onnotice: () => {} });
    for (const name of [SUITE_DB, SYS_DB, RESTORE_DB, RESTORE_SYS_DB]) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }
    await admin.unsafe(`CREATE DATABASE "${SUITE_DB}"`);
    await admin.unsafe(`CREATE DATABASE "${SYS_DB}"`);
    const [version] = await admin.unsafe('SHOW server_version_num');
    const major = Math.floor(Number(version!.server_version_num) / 10_000);
    pgDump = await toolFor('pg_dump', major);
    pgRestore = await toolFor('pg_restore', major);

    dir = mkdtempSync(join(tmpdir(), 'rayspec-snapshot-suite-'));
    blobRoot = join(dir, 'blobs');
    mkdirSync(blobRoot);
    scratchParent = join(dir, 'scratch');
    mkdirSync(scratchParent, { mode: 0o700 });
    ({ stateDir, orgId } = await deployEnvironment({
      dbUrl,
      sysUrl,
      dir,
      blobRoot,
      deploymentId: DEPLOYMENT,
    }));

    control = openControlDatabase(dbUrl);
  }, 240_000);

  afterAll(async () => {
    await control?.$client.end().catch(() => {});
    for (const d of captured) rmSync(d, { recursive: true, force: true });
    if (dir !== '') {
      const writable = (path: string): void => {
        chmodSync(path, statSync(path).isDirectory() ? 0o700 : 0o600);
        if (statSync(path).isDirectory())
          for (const e of readdirSync(path)) writable(join(path, e));
      };
      writable(dir);
      rmSync(dir, { recursive: true, force: true });
    }
    if (!baseUrl) return;
    for (const name of [SUITE_DB, SYS_DB, RESTORE_DB, RESTORE_SYS_DB]) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }
    await admin.end();
    if (dbRequired) expect(armsRan).toBe(ARMS);
  }, 120_000);

  it('preflight finds nothing to block on a clean single-tenant source', async () => {
    const r = await preflightSnapshot(source());
    expect(r.blockers).toEqual([]);
    expect(r.facts).toMatchObject({
      deploymentId: DEPLOYMENT,
      applicationId: 'field-notes',
      applicationVersion: '1.0.0',
      sourceRuntime: runtimeVersion(),
      tenantId: orgId,
      workflowSystemDatabase: 'present',
      productTables: ['field_notes'],
      objectCount: 4,
      reader: 'single-role',
    });
    expect(readdirSync(scratchParent)).toEqual([]);
    armsRan += 1;
  });

  it('captures a snapshot that restores with every counted row and every object', async () => {
    const epoch = await quiesce(true);
    try {
      const result = await capture(epoch, 'included');
      expect(result.ok, JSON.stringify(!result.ok && result.errors)).toBe(true);
      if (!result.ok) return;
      const v = result.value;
      expect(v.reader).toBe('single-role');
      expect(v.barriers).toEqual([
        { barrier: 'database-stopped-source', state: 'held' },
        { barrier: 'database-write-role', state: 'not-applied' },
        { barrier: 'object-writes', state: 'held' },
      ]);
      expect(statSync(v.scratchDir).mode & 0o777).toBe(0o700);
      expect(readdirSync(v.scratchDir)).toEqual(['snapshot.zip']);

      const read = await inspectSnapshotArchive(v.archivePath);
      expect(read.ok, JSON.stringify(!read.ok && read.errors)).toBe(true);
      if (!read.ok) return;
      const s: Snapshot = read.value.snapshot;
      expect(s).toMatchObject({
        sourceRuntime: runtimeVersion(),
        exportToolVersion: runtimeVersion(),
        applicationId: 'field-notes',
        applicationVersion: '1.0.0',
        fenceEpoch: epoch,
        applicationTenantCount: 1,
        workflowSystemDatabase: 'included',
        runHistoryPolicy: 'included',
        objectCount: 4,
        excludedDataCategories: [
          'credential-state',
          'request-replay-state',
          'runtime-control-state',
          'security-audit-log',
        ],
      });
      expect(s.identityPolicy.passwordHashes).toBe('preserved');
      expect(s.schemaHead).toEqual(await liveSchemaHead(control));
      const count = (database: string, table: string) =>
        s.tableCounts.find((t) => t.database === database && t.table === table)?.rows;
      expect(count('application', 'orgs')).toBe(1);
      expect(count('application', 'users')).toBe(2);
      expect(count('application', 'memberships')).toBe(2);
      expect(count('application', 'field_notes')).toBe(2);
      expect(count('application', 'runs')).toBe(2);
      expect(count('application', 'workflow_runs')).toBe(1);
      expect(count('application', 'product_migration_ledger')).toBe(1);
      for (const t of ['api_keys', 'sessions', 'invites', 'auth_audit', 'runtime_control_state']) {
        expect(count('application', t), t).toBe(0);
      }
      expect(count('workflow-system', 'workflow_status')).toBe(2);
      expect(v.excludedTables.map((t) => `${t.table}:${t.category}`)).toEqual(
        expect.arrayContaining([
          'api_keys:credential-state',
          'auth_audit:security-audit-log',
          'idempotency_keys:request-replay-state',
          'runtime_control_state:runtime-control-state',
        ]),
      );
      expect(v.excludedTables.some((t) => t.category === 'run-history')).toBe(false);

      // The objects: exactly the blob root, and each stored file unchanged.
      const entries = zipEntries(readFileSync(v.archivePath));
      const listed = await listFsBlobs(blobRoot);
      const index = read.value.objectIndex.objects;
      expect(index.map((o) => [o.tenantId, o.key, o.size, o.sha256, o.contentType])).toEqual(
        listed.map((o) => [o.tenantId, o.key, o.size, o.sha256, o.contentType]),
      );
      const objectsBin = entries.get(SNAPSHOT_PATHS.objects)!;
      for (const [i, o] of index.entries()) {
        const stored = readFileSync(listed[i]!.file);
        expect(
          objectsBin.subarray(o.storedOffset, o.storedOffset + o.storedSize).equals(stored),
        ).toBe(true);
        const store = makeFsBlobStoreFactory(blobRoot)(o.tenantId);
        const got = await store.get(o.key);
        if ('notFound' in got) throw new Error('a listed blob is not found');
        const bytes = Buffer.from(await new Response(got.body).arrayBuffer());
        expect(sha(bytes)).toBe(o.sha256);
      }
      expect(entries.get(SNAPSHOT_PATHS.application)!.length).toBeGreaterThan(0);
      expect(sha(entries.get(SNAPSHOT_PATHS.application)!)).toBe(s.applicationDigest);

      // The credential, replay, audit and runtime-control tables come without rows.
      const listing = await runTool(
        pgRestore,
        dbUrl,
        ['--list'],
        entries.get(SNAPSHOT_PATHS.database),
      );
      expect(listing.code, listing.stderr).toBe(0);
      for (const t of [
        'api_keys',
        'sessions',
        'invites',
        'oidc_models',
        'auth_audit',
        'idempotency_keys',
        'runtime_control_state',
        'runtime_control_receipts',
      ]) {
        expect(listing.stdout.includes(`TABLE public ${t} `), t).toBe(true);
        expect(listing.stdout.includes(`TABLE DATA public ${t} `), t).toBe(false);
      }
      expect(listing.stdout).toMatch(/TABLE DATA public runs /);
      expect(listing.stdout).toMatch(/TABLE DATA public product_migration_ledger /);

      // The dumps restore into empty databases with the counted rows and the exact values.
      await admin.unsafe(`CREATE DATABASE "${RESTORE_DB}"`);
      await admin.unsafe(`CREATE DATABASE "${RESTORE_SYS_DB}"`);
      const restoreUrl = withDbName(baseUrl!, RESTORE_DB);
      const restoreSysUrl = withDbName(baseUrl!, RESTORE_SYS_DB);
      const restored = await runTool(
        pgRestore,
        restoreUrl,
        ['--exit-on-error', `--dbname=${RESTORE_DB}`],
        entries.get(SNAPSHOT_PATHS.database),
      );
      expect(restored, restored.stderr).toMatchObject({ code: 0 });
      const restoredSys = await runTool(
        pgRestore,
        restoreSysUrl,
        ['--exit-on-error', `--dbname=${RESTORE_SYS_DB}`],
        entries.get(SNAPSHOT_PATHS.workflowSystem),
      );
      expect(restoredSys, restoredSys.stderr).toMatchObject({ code: 0 });
      for (const [url, database] of [
        [restoreUrl, 'application'],
        [restoreSysUrl, 'workflow-system'],
      ] as const) {
        const sql = postgres(url, { max: 1 });
        try {
          for (const t of s.tableCounts.filter((c) => c.database === database)) {
            const [row] = await sql.unsafe(
              `SELECT count(*)::int AS n FROM "${t.schema}"."${t.table}"`,
            );
            expect(row!.n, `${database} ${t.schema}.${t.table}`).toBe(t.rows);
          }
        } finally {
          await sql.end();
        }
      }
      const restoredDb = postgres(restoreUrl, { max: 1 });
      try {
        const [note] = await restoredDb.unsafe(
          `SELECT title, body, views::text AS views, amount::text AS amount, meta::text AS meta
             FROM field_notes WHERE title <> 'second'`,
        );
        expect(note).toEqual({
          title: NOTE_TITLE,
          body: null,
          views: BIG_VIEWS,
          amount: EXACT_AMOUNT,
          meta: '{"tags": ["ä", "😀"]}',
        });
        const users = await restoredDb.unsafe(
          'SELECT email, password_hash IS NOT NULL AS has_password FROM users ORDER BY email',
        );
        expect(users).toEqual([
          { email: 'member@example.test', has_password: false },
          { email: 'owner@example.test', has_password: true },
        ]);
      } finally {
        await restoredDb.end();
      }
      armsRan += 1;
    } finally {
      await resume();
    }
  }, 240_000);

  it('excludes run history under that policy and reports it', async () => {
    const epoch = await quiesce(true);
    try {
      const result = await capture(epoch, 'excluded');
      expect(result.ok, JSON.stringify(!result.ok && result.errors)).toBe(true);
      if (!result.ok) return;
      const s = result.value.snapshot;
      expect(s.runHistoryPolicy).toBe('excluded');
      expect(s.excludedDataCategories).toEqual([
        'credential-state',
        'request-replay-state',
        'run-history',
        'runtime-control-state',
        'security-audit-log',
      ]);
      const rows = (t: string) => s.tableCounts.find((c) => c.table === t)?.rows;
      expect(rows('runs')).toBe(0);
      expect(rows('workflow_runs')).toBe(0);
      expect(rows('field_notes')).toBe(2);
      expect(
        result.value.excludedTables.filter((t) => t.category === 'run-history').map((t) => t.table),
      ).toEqual([
        'conversation_items',
        'journal_steps',
        'run_events',
        'runs',
        'workflow_artifacts',
        'workflow_node_states',
        'workflow_runs',
      ]);
      // The dump carries the run-history tables without their rows.
      const entries = zipEntries(readFileSync(result.value.archivePath));
      const listing = await runTool(
        pgRestore,
        dbUrl,
        ['--list'],
        entries.get(SNAPSHOT_PATHS.database),
      );
      expect(listing.code, listing.stderr).toBe(0);
      expect(listing.stdout).toMatch(/TABLE public runs /);
      expect(listing.stdout).not.toMatch(/TABLE DATA public runs /);
      expect(listing.stdout).not.toMatch(/TABLE DATA public workflow_runs /);
      expect(listing.stdout).toMatch(/TABLE DATA public field_notes /);
      armsRan += 1;
    } finally {
      await resume();
    }
  }, 120_000);

  it('says absent and carries no second dump when the workflow system database does not exist', async () => {
    await admin.unsafe(`ALTER DATABASE "${SYS_DB}" RENAME TO "${SYS_DB}_away"`);
    const epoch = await quiesce(true);
    try {
      const result = await capture(epoch, 'included');
      expect(result.ok, JSON.stringify(!result.ok && result.errors)).toBe(true);
      if (!result.ok) return;
      expect(result.value.snapshot.workflowSystemDatabase).toBe('absent');
      expect(result.value.snapshot.inventory.map((e) => e.path)).not.toContain(
        SNAPSHOT_PATHS.workflowSystem,
      );
      expect(result.value.snapshot.tableCounts.some((t) => t.database === 'workflow-system')).toBe(
        false,
      );
      armsRan += 1;
    } finally {
      await resume();
      await admin.unsafe(`ALTER DATABASE "${SYS_DB}_away" RENAME TO "${SYS_DB}"`);
    }
  }, 120_000);

  it('refuses a capture at another epoch, after the fence was released, and without a database barrier', async () => {
    const epoch = await quiesce(true);
    const other = await capture(epoch + 1, 'included');
    expect(!other.ok && other.errors[0]).toMatchObject({ code: 'RAY_FENCE_MISMATCH' });
    await resume();
    const released = await capture(epoch, 'included');
    expect(!released.ok && released.errors[0]).toMatchObject({ code: 'RAY_SOURCE_NOT_QUIESCENT' });

    // Single role without the stopped-source attestation: no barrier the application cannot undo.
    const scratchBefore = readdirSync(scratchParent);
    const unfenced = await quiesce(false);
    try {
      const refused = await capture(unfenced, 'included');
      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.errors[0]).toMatchObject({
        code: 'RAY_EXTERNAL_STATE_UNSUPPORTED',
        reason: 'database-barrier-unavailable',
      });
      expect(refused.barriers).toEqual([
        { barrier: 'database-write-role', state: 'unavailable' },
        { barrier: 'database-stopped-source', state: 'not-applied' },
        { barrier: 'object-writes', state: 'held' },
      ]);
      const [row] = await control.$client.unsafe(
        'SELECT fence_state FROM runtime_control_state WHERE id = 1',
      );
      expect(row!.fence_state).toBe('fenced');
      expect(readdirSync(scratchParent)).toEqual(scratchBefore);
      armsRan += 1;
    } finally {
      await resume();
    }
  }, 120_000);

  it('refuses a foreign session, a run still running, and a blob written during the capture', async () => {
    const scratchBefore = readdirSync(scratchParent);
    const epoch = await quiesce(true);
    try {
      const foreign = await asOutsider(async (sql) => {
        await sql`select 1`;
        return capture(epoch, 'included');
      });
      expect(!foreign.ok && foreign.errors[0]).toMatchObject({
        code: 'RAY_EXTERNAL_STATE_UNSUPPORTED',
        reason: 'uncontrolled-writer',
      });

      await control.$client.unsafe(
        `INSERT INTO runs (run_id, tenant_id, backend, auth_mode, agent_name, model, status)
           VALUES ('run-open', $1, 'openai', 'api-key', 'writer', 'm', 'running')`,
        [orgId],
      );
      const running = await capture(epoch, 'included');
      expect(!running.ok && running.errors[0]).toMatchObject({
        code: 'RAY_EXTERNAL_STATE_UNSUPPORTED',
        reason: 'unreconciled-effects',
      });
      await control.$client.unsafe("DELETE FROM runs WHERE run_id = 'run-open'");

      // A pg_dump wrapper that writes a blob before it dumps: the source moved under the capture.
      const wrapper = join(dir, 'pg-dump-writes-a-blob.mjs');
      writeFileSync(
        wrapper,
        [
          "import { spawnSync } from 'node:child_process';",
          "import { writeFileSync } from 'node:fs';",
          'const [tool, toolArgs, blobFile] = JSON.parse(process.env.SNAPSHOT_SUITE_WRAPPER);',
          "if (!process.argv.includes('--version')) writeFileSync(blobFile, Buffer.from([0, 0, 0, 2, 123, 125]));",
          "const r = spawnSync(tool, [...toolArgs, ...process.argv.slice(2)], { stdio: 'inherit' });",
          'process.exit(r.status ?? 1);',
        ].join('\n'),
      );
      process.env.SNAPSHOT_SUITE_WRAPPER = JSON.stringify([
        pgDump.command,
        pgDump.args ?? [],
        join(blobRoot, orgId, 'late-arrival'),
      ]);
      try {
        const moved = await capture(epoch, 'included', {
          pgDump: {
            command: process.execPath,
            args: [wrapper],
            ...(pgDump.rewriteHost ? { rewriteHost: pgDump.rewriteHost } : {}),
          },
        });
        expect(!moved.ok && moved.errors[0]).toMatchObject({ code: 'RAY_SOURCE_NOT_QUIESCENT' });
      } finally {
        delete process.env.SNAPSHOT_SUITE_WRAPPER;
        rmSync(join(blobRoot, orgId, 'late-arrival'), { force: true });
      }
      // A refused capture leaves no scratch directory behind.
      expect(readdirSync(scratchParent)).toEqual(scratchBefore);
      armsRan += 1;
    } finally {
      await resume();
    }
  }, 180_000);

  it('preflight refuses more than one tenant, a source nobody can sign in to, and foreign blobs', async () => {
    const sql = control.$client;
    const [second] = await sql.unsafe(
      "INSERT INTO orgs (name, slug) VALUES ('Zweite', 'zweite') RETURNING id::text AS id",
    );
    try {
      expect((await blockers())[0]).toBe('RAY_MULTI_TENANT_UNSUPPORTED/');
    } finally {
      await sql.unsafe('DELETE FROM orgs WHERE id = $1', [second!.id]);
    }
    await sql.unsafe("UPDATE users SET password_hash = NULL WHERE email = 'owner@example.test'");
    try {
      expect(await blockers()).toEqual(['RAY_OWNER_RECOVERY_REQUIRED/']);
    } finally {
      await sql.unsafe(
        "UPDATE users SET password_hash = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA' WHERE email = 'owner@example.test'",
      );
    }
    const otherTenant = '0000000f-0000-4000-8000-000000000000';
    await makeFsBlobStoreFactory(blobRoot)(otherTenant).put('x', new Uint8Array([1]));
    try {
      expect(await blockers()).toEqual(['RAY_MULTI_TENANT_UNSUPPORTED/']);
    } finally {
      rmSync(join(blobRoot, otherTenant), { recursive: true, force: true });
    }
    expect(await blockers()).toEqual([]);
    armsRan += 1;
  }, 120_000);

  it('preflight refuses unknown tables, extensions, drift, an unreadable or unfinished blob store and the size budget', async () => {
    const sql = control.$client;
    await sql.unsafe('CREATE TABLE public.side_ledger (id int)');
    try {
      expect(await blockers()).toEqual(['RAY_EXTERNAL_STATE_UNSUPPORTED/unknown-table']);
    } finally {
      await sql.unsafe('DROP TABLE public.side_ledger');
    }
    await sql.unsafe('CREATE EXTENSION IF NOT EXISTS citext');
    try {
      expect(await blockers()).toEqual(['RAY_POLICY_DENIED/unsupported-extension']);
    } finally {
      await sql.unsafe('DROP EXTENSION citext');
    }
    await sql.unsafe('ALTER TABLE field_notes ADD COLUMN stray text');
    try {
      expect(await blockers()).toEqual(['RAY_SCHEMA_DRIFT/']);
    } finally {
      await sql.unsafe('ALTER TABLE field_notes DROP COLUMN stray');
    }
    expect(await blockers({ blob: { kind: 'unsupported', name: 's3' } })).toEqual([
      'RAY_EXTERNAL_STATE_UNSUPPORTED/unsupported-blob-adapter',
    ]);
    const partial = join(blobRoot, orgId, `empty.tmp-1-1700000000000-${randomUUID()}`);
    writeFileSync(partial, 'half');
    try {
      expect(await blockers()).toEqual(['RAY_EXTERNAL_STATE_UNSUPPORTED/unreconciled-effects']);
    } finally {
      rmSync(partial);
    }
    expect(await blockers({ blob: { kind: 'fs', root: join(dir, 'no-such-root') } })).toEqual([
      'RAY_INFRA_UNAVAILABLE/',
    ]);
    expect(await blockers({ limits: { migrationExtractedBytes: 1024 } })).toEqual([
      'RAY_LIMIT_EXCEEDED/migration-size',
    ]);
    expect(
      await blockers({
        unsupportedState: [
          {
            reason: 'uncontrolled-writer',
            message: 'a reporting job writes to the database directly',
          },
        ],
      }),
    ).toEqual(['RAY_EXTERNAL_STATE_UNSUPPORTED/uncontrolled-writer']);
    armsRan += 1;
  }, 120_000);

  it('preflight refuses a pg_dump of another major or none, and a foreign deployment id', async () => {
    const fake = join(dir, 'pg_dump_other_major.mjs');
    writeFileSync(fake, "process.stdout.write('pg_dump (PostgreSQL) 9.6.24\\n');\n");
    const other = await blockers({ pgDump: { command: process.execPath, args: [fake] } });
    expect(other).toEqual(['RAY_USAGE/']);
    expect(await blockers({ pgDump: join(dir, 'no-pg-dump-here') })).toEqual(['RAY_USAGE/']);
    expect(await blockers({ deploymentId: 'fedcba9876543210' })).toEqual(['RAY_USAGE/']);
    armsRan += 1;
  }, 120_000);
  it('with role separation, reads as the snapshot role while the runtime role cannot write', async () => {
    const iso = await createIsolatedTestDatabase(baseUrl!, { workflowSystem: true });
    const isoDir = mkdtempSync(join(tmpdir(), 'rayspec-snapshot-roles-'));
    const isoBlobs = join(isoDir, 'blobs');
    mkdirSync(isoBlobs);
    const sys = iso.workflowSystemUrls!;
    const deploymentId = 'role-separated-01';
    let isoControl: Db | undefined;
    let sysControl: Db | undefined;
    try {
      const { stateDir: isoState } = await deployEnvironment({
        dbUrl: iso.urls.migration,
        sysUrl: sys.migration,
        dir: isoDir,
        blobRoot: isoBlobs,
        deploymentId,
      });
      isoControl = openControlDatabase(iso.urls.migration);
      const isoSource: SnapshotSourceOptions = {
        db: isoControl,
        databaseUrl: iso.urls.migration,
        workflowSystemDatabaseUrl: sys.migration,
        snapshotRole: { databaseUrl: iso.urls.snapshot, workflowSystemDatabaseUrl: sys.snapshot },
        stateDir: isoState,
        deploymentId,
        blob: { kind: 'fs', root: isoBlobs },
        pgDump,
        scratchParent,
      };
      // A snapshot role that cannot read a table is found before any fence is taken.
      await isoControl.$client.unsafe(`REVOKE SELECT ON field_notes FROM "${iso.roles.snapshot}"`);
      const unreadable = await preflightSnapshot(isoSource);
      expect(unreadable.blockers.map((e) => e.code)).toEqual(['RAY_USAGE']);
      expect(unreadable.blockers[0]!.message).toContain('snapshot role cannot read every table');
      await isoControl.$client.unsafe(`GRANT SELECT ON field_notes TO "${iso.roles.snapshot}"`);
      expect((await preflightSnapshot(isoSource)).blockers).toEqual([]);

      const [tag] = await isoControl.$client.unsafe('SHOW application_name');
      sysControl = makeDb(sys.migration, 2, { applicationName: String(tag!.application_name) });
      const adapter = createRuntimeControl({
        db: isoControl,
        runtimeRole: iso.roles.runtime,
        workflowSystemDb: sysControl,
        quiescePollMs: 50,
      });
      const quiesced = await adapter.quiesce({
        ...base(),
        reason: 'snapshot suite, role separation',
        deadline: formatTimestamp(new Date(Date.now() + 5_000)),
        sourceStopped: false,
      });
      expect(quiesced.ok, JSON.stringify(quiesced.errors)).toBe(true);
      const epoch = quiesced.data!.fenceEpoch;
      try {
        // The fence's barrier: the runtime role cannot write in either database.
        const runtime = postgres(iso.urls.runtime, { max: 1 });
        const runtimeSys = postgres(sys.runtime, { max: 1 });
        try {
          await expect(
            runtime.unsafe("UPDATE field_notes SET title = 'changed'"),
          ).rejects.toMatchObject({ code: '42501' });
          await expect(
            runtimeSys.unsafe("UPDATE dbos.workflow_status SET status = 'X'"),
          ).rejects.toMatchObject({ code: '42501' });
        } finally {
          await runtime.end();
          await runtimeSys.end();
        }

        const result = await captureSnapshot({
          ...isoSource,
          fenceEpoch: epoch,
          runHistoryPolicy: 'included',
        });
        expect(result.ok, JSON.stringify(!result.ok && result.errors)).toBe(true);
        if (!result.ok) return;
        captured.push(result.value.scratchDir);
        expect(result.value.reader).toBe('snapshot-role');
        expect(result.value.barriers).toEqual([
          { barrier: 'database-write-role', state: 'held' },
          { barrier: 'database-stopped-source', state: 'not-applied' },
          { barrier: 'object-writes', state: 'held' },
        ]);
        const counts = result.value.snapshot.tableCounts;
        const rows = (database: string, table: string) =>
          counts.find((c) => c.database === database && c.table === table)?.rows;
        expect(rows('application', 'users')).toBe(2);
        expect(rows('application', 'field_notes')).toBe(2);
        expect(rows('workflow-system', 'workflow_status')).toBe(2);
        expect(result.value.snapshot.objectCount).toBe(4);
        const read = await inspectSnapshotArchive(result.value.archivePath);
        expect(read.ok).toBe(true);
        armsRan += 1;
      } finally {
        const resumed = await adapter.resume({ ...base(), fenceEpoch: epoch });
        expect(resumed.ok, JSON.stringify(resumed.errors)).toBe(true);
      }
    } finally {
      await isoControl?.$client.end().catch(() => {});
      await sysControl?.$client.end().catch(() => {});
      await iso.drop();
      const writable = (path: string): void => {
        chmodSync(path, statSync(path).isDirectory() ? 0o700 : 0o600);
        if (statSync(path).isDirectory())
          for (const e of readdirSync(path)) writable(join(path, e));
      };
      writable(isoDir);
      rmSync(isoDir, { recursive: true, force: true });
    }
  }, 240_000);
});
