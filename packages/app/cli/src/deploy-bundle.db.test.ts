/**
 * `rayspec deploy <file.ray>` on GROUND TRUTH: the real built CLI in real child processes, a real
 * database, real HTTP.
 *
 * One environment is taken through the life of a deployment, in order:
 *  - a `.ray` that is not an archive and a YAML spec that does not validate are refused with the
 *    empty database left empty;
 *  - a dry-run plans the clean install and changes nothing but its plan record;
 *  - a missing binding, a bindings file others can read and a reserved name are refused with the
 *    database still empty, and a `.env` file in the working directory is not read;
 *  - the packed application is deployed from a directory that holds only the bundle — its source
 *    tree is gone — and serves its declared routes and its handler from the version directory; it
 *    runs a durable worker, whose startup lines go to stderr so stdout holds the one envelope;
 *  - an additive update deploys and keeps the rows written before it;
 *  - a destructive change, drift added by hand, a stale plan, an expired plan and a state directory
 *    of another deployment are refused, leaving the previous version active and the rows in place;
 *  - a deploy killed while its product DDL runs, after the first statement of that DDL, leaves the
 *    schema and the active version as they were, and the same deploy run again finishes it.
 *
 * Skips without DATABASE_URL; the un-skippable ran-guard hard-fails a REQUIRED run that did not run.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  digestOf,
  formatTimestamp,
  PLAN_LIFETIME_MS,
  schemaValidator,
} from '@rayspec/bundle-contract';
import { type RuntimeRoleEnv, runtimeRoleEnv } from '@rayspec/db/testing';
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

const baseUrl = process.env.DATABASE_URL;
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
let armsRan = 0;

const SUITE_DB = `rayspec_bundle_deploy_${process.pid}`;
const PORT = 19_100 + (process.pid % 1500);
const TENANT = '00000000-0000-4000-8000-0000000000b7';
const valid = schemaValidator('resultEnvelope');
/** The provider key the bindings file carries; it must never appear in any output. */
const KEY = `sk-inert-${randomUUID()}`;

function withDbName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

// A durable worker: the durable runtime prints startup lines to stdout, which the deploy must keep
// off its one-envelope stdout.
const notes = (columns: string, extra = '') =>
  backendSpec(
    'deployment:\n  durableWorker: true\n' +
      `stores:\n  - name: bundle_notes\n    columns:\n${columns}\n${extra}` +
      "api:\n  - { method: POST, path: '/notes', action: { kind: store, store: bundle_notes, op: create } }\n" +
      "  - { method: GET, path: '/notes', action: { kind: store, store: bundle_notes, op: list } }\n" +
      "  - { method: GET, path: '/hello', action: { kind: handler, handler: hello } }\n" +
      "  - { method: POST, path: '/summarize', action: { kind: agent, agent: summarizer } }\n" +
      'agents:\n  - { id: summarizer, name: summarizer, backend: openai, model: gpt-4o-mini, ' +
      'instructions: Summarize the notes. }\n' +
      'handlers:\n  - { id: hello, module: handlers/hello.js, export: hello, kind: route }\n',
  );
const BODY = '      - { name: body, type: text }';
const TAG = '      - { name: tag, type: text, nullable: true }';
const PRIORITY = '      - { name: priority, type: text, nullable: true }';
const TAGS_STORE = '  - name: bundle_tags\n    columns:\n      - { name: label, type: text }\n';
const V1 = notes(BODY);
const V2 = notes(`${BODY}\n${TAG}`);
/** V2 plus a new store and a new column: the new store's DDL runs before the column's. */
const V3 = notes(`${BODY}\n${TAG}\n${PRIORITY}`, TAGS_STORE);
/** V2 without its `tag` column: a destructive change. */
const DROPPED = notes(BODY);

const HANDLER =
  'export async function hello() {\n  return { hello: "from the version directory" };\n}\n';

describe.skipIf(!baseUrl)('rayspec deploy <file.ray> — the life of one deployment', () => {
  let appUrl = '';
  let shadowUrl = '';
  let pem = '';
  let deployDir = '';
  let bindings = '';
  let db: postgres.Sql;
  // The children's connections: the superuser's, or in the runtime-role lane role separation.
  let roles: RuntimeRoleEnv | undefined;
  const children: ChildProcess[] = [];
  const bundles: Record<string, { path: string; sha: string }> = {};

  /** Pack `spec` (against `against`, when given) and leave only the bundle in `deployDir`. */
  async function pack(name: string, spec: string, against?: string, version = '1.0.0') {
    const source = temporaryDirectory('bundle-source-');
    writeTree(source, {
      'rayspec.yaml': spec.replace("version: '1.0.0'", `version: '${version}'`),
      'package.json': JSON.stringify({ name: 'bundle-notes', private: true, type: 'module' }),
      'handlers/hello.js': HANDLER,
      ...(against === undefined ? {} : { 'previous.yaml': against }),
    });
    const output = join(source, `${name}.ray`);
    const packed = await runPack(
      [
        '--spec',
        join(source, 'rayspec.yaml'),
        '--output',
        output,
        ...(against === undefined ? [] : ['--against', join(source, 'previous.yaml')]),
      ],
      { operationId: randomUUID(), cliVersion: '1.8.0', env: { SHADOW_DATABASE_URL: shadowUrl } },
    );
    expect(packed.envelope.ok, JSON.stringify(packed.envelope.errors)).toBe(true);
    const target = join(deployDir, `${name}.ray`);
    copyFileSync(output, target);
    // The source tree is gone: the deploy has the bundle and nothing else.
    rmSync(source, { recursive: true, force: true });
    bundles[name] = { path: target, sha: (packed.envelope.data as { sha256: string }).sha256 };
    return bundles[name];
  }

  function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      ...(roles?.env ?? { DATABASE_URL: appUrl }),
      SHADOW_DATABASE_URL: shadowUrl,
      RAYSPEC_JWT_SIGNING_KEY: pem,
      RAYSPEC_API_KEY_PEPPER: 'bundle-deploy-suite-pepper',
      ALLOWED_ORIGINS: '',
      ...extra,
    };
  }

  /** A one-shot run (a dry-run or a refusal): its exit and its envelope. */
  function once(args: string[], extra: Record<string, string> = {}, cwd = deployDir) {
    const run = spawnSync(process.execPath, [CLI_DIST, 'deploy', ...args], {
      cwd,
      encoding: 'utf8',
      env: childEnv(extra),
      timeout: 120_000,
    });
    let envelope: ParsedJson = {};
    try {
      envelope = JSON.parse(run.stdout) as ParsedJson;
    } catch {
      envelope = { unparsed: run.stdout };
    }
    expect(`${run.stdout}${run.stderr}`).not.toContain(KEY);
    return { status: run.status, envelope, stderr: run.stderr };
  }

  function dryRun(bundle: string, extra: string[] = []) {
    const run = once([bundle, '--dry-run', '--bindings-file', bindings, ...extra]);
    expect(run.status, run.stderr).toBe(0);
    expect(valid(run.envelope), JSON.stringify(valid.errors)).toBe(true);
    return run.envelope.data as ParsedJson;
  }

  interface Served {
    child: ChildProcess;
    exited: Promise<{ code: number | null; stdout: string; stderr: string }>;
  }

  /** Start a deploy that serves; resolves once /health answers 200, or rejects with its output. */
  async function serve(args: string[]): Promise<Served> {
    const child = spawn(
      process.execPath,
      [CLI_DIST, 'deploy', ...args, '--port', String(PORT), '--bindings-file', bindings],
      { cwd: deployDir, env: childEnv() },
    );
    children.push(child);
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
        if ((await fetch(`http://127.0.0.1:${PORT}/health`)).status === 200) break;
      } catch {
        // not listening yet
      }
      if (Date.now() > deadline) throw new Error(`deploy did not serve\n${stderr}`);
      await new Promise((r) => setTimeout(r, 250));
    }
    return { child, exited };
  }

  /** The stderr of the last deploy `stop` ended: its boot banner. */
  let lastServeStderr = '';

  async function stop(served: Served): Promise<ParsedJson> {
    served.child.kill('SIGTERM');
    const out = await served.exited;
    lastServeStderr = out.stderr;
    expect(out.code, out.stderr).toBe(0);
    expect(`${out.stdout}${out.stderr}`).not.toContain(KEY);
    // stdout is the one envelope and nothing else; the durable runtime's lines went to stderr.
    expect(out.stdout.trimStart().startsWith('{'), out.stdout.slice(0, 200)).toBe(true);
    expect(out.stderr).toContain('DBOS launched');
    const envelope = JSON.parse(out.stdout) as ParsedJson;
    expect(valid(envelope), JSON.stringify(valid.errors)).toBe(true);
    return envelope;
  }

  async function tableCount(): Promise<number> {
    const rows = await db.unsafe(
      "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')",
    );
    return (rows[0] as { n: number }).n;
  }

  async function active(): Promise<string | null> {
    const path = join(deployDir, '.rayspec-state', 'active.json');
    if (!existsSync(path)) return null;
    return (JSON.parse(readFileSync(path, 'utf8')) as { bundleSha256: string }).bundleSha256;
  }

  let token = '';
  async function orgToken(): Promise<string> {
    if (token !== '') return token;
    const base = `http://127.0.0.1:${PORT}`;
    const email = `bundle-deploy-${Date.now()}@example.com`;
    const reg = await fetch(`${base}/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'a-long-enough-password' }),
    });
    expect([200, 201]).toContain(reg.status);
    const { accessToken } = (await reg.json()) as { accessToken: string };
    const users = await db.unsafe('SELECT id FROM users WHERE email = $1', [email]);
    await db.unsafe("INSERT INTO orgs (id, name, slug) VALUES ($1, 'Bundle', 'bundle')", [TENANT]);
    await db.unsafe(
      "INSERT INTO memberships (org_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active')",
      [TENANT, (users[0] as { id: string }).id],
    );
    const sw = await fetch(`${base}/v1/orgs/${TENANT}/switch`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(sw.status).toBe(200);
    token = ((await sw.json()) as { accessToken: string }).accessToken;
    return token;
  }

  async function get(path: string, bearer: string): Promise<{ status: number; text: string }> {
    const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
      headers: { authorization: `Bearer ${bearer}` },
    });
    return { status: res.status, text: await res.text() };
  }

  beforeAll(async () => {
    if (!baseUrl) return;
    appUrl = withDbName(baseUrl, SUITE_DB);
    shadowUrl = process.env.SHADOW_DATABASE_URL ?? baseUrl;
    const admin = postgres(withDbName(baseUrl, 'postgres'), { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}_dbos_sys" WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE "${SUITE_DB}"`);
    } finally {
      await admin.end();
    }
    db = postgres(appUrl, { max: 2 });
    roles = await runtimeRoleEnv(appUrl, withDbName(baseUrl, `${SUITE_DB}_dbos_sys`));
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    pem = await exportPKCS8(privateKey);
    deployDir = temporaryDirectory('bundle-deploy-');
    bindings = join(temporaryDirectory('bundle-bindings-'), 'bindings.json');
    writeFileSync(
      bindings,
      JSON.stringify({
        bindingsFormatVersion: 1,
        bindings: [{ name: 'OPENAI_API_KEY', value: KEY }],
      }),
    );
    chmodSync(bindings, 0o600);
    await pack('v1', V1);
  }, 180_000);

  afterAll(async () => {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
    await db?.end().catch(() => {});
    if (deployDir !== '') {
      // Version directories are read-only; make them removable.
      spawnSync('chmod', ['-R', 'u+w', deployDir]);
    }
    removeTemporaryDirectories();
    if (!baseUrl) return;
    const admin = postgres(withDbName(baseUrl, 'postgres'), { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}_dbos_sys" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
    await roles?.drop();
  }, 60_000);

  it('refuses a .ray that is no archive and a YAML spec that does not validate, touching nothing', async () => {
    const garbage = join(deployDir, 'garbage.ray');
    writeFileSync(garbage, 'not an archive\n');
    const refused = once([garbage, '--bindings-file', bindings]);
    expect(refused.status).toBe(2);
    expect(refused.envelope.errors[0]).toMatchObject({
      code: 'RAY_INVALID_ARCHIVE',
      reason: 'not-a-zip',
    });
    expect(await tableCount()).toBe(0);

    // The YAML path validates before it changes anything, and keeps its own output and exit.
    writeFileSync(join(deployDir, 'invalid.yaml'), "version: '1.0'\nstores: 7\n");
    const legacy = spawnSync(process.execPath, [CLI_DIST, 'deploy', 'invalid.yaml'], {
      cwd: deployDir,
      encoding: 'utf8',
      env: childEnv({ RAYSPEC_SKIP_DOTENV: '1', PORT: String(PORT) }),
      timeout: 120_000,
    });
    expect(legacy.status, legacy.stderr).toBe(1);
    expect(legacy.stdout).toBe('');
    expect(legacy.stderr).toContain('[rayspec deploy]');
    expect(await tableCount()).toBe(0);
    armsRan += 1;
  }, 180_000);

  it('plans the clean install without changing the database', async () => {
    const data = dryRun(bundles.v1!.path);
    expect(data.bundleSha256).toBe(bundles.v1!.sha);
    expect(data.plan.schemaImpact.from).toBeNull();
    expect(data.plan.requiredBindings).toEqual([
      { name: 'OPENAI_API_KEY', kind: 'secret', required: true, satisfied: true },
    ]);
    expect(data.plan.blockers).toEqual([]);
    expect(data.planRecordPath).toBe(
      join(realpathSync(deployDir), '.rayspec-state', 'plans', `${data.planDigest}.json`),
    );
    const record = readFileSync(data.planRecordPath, 'utf8');
    expect(record).not.toContain(KEY);
    expect(statSync(data.planRecordPath).mode & 0o777).toBe(0o600);
    expect(await tableCount()).toBe(0);
    armsRan += 1;
  }, 180_000);

  it('refuses a missing binding, an open bindings file and a reserved name; reads no .env', async () => {
    // A .env in the working directory supplies the key; the bundle path must not read it.
    writeFileSync(join(deployDir, '.env'), `OPENAI_API_KEY=${KEY}\n`);
    try {
      const planned = once([bundles.v1!.path, '--dry-run']);
      expect(planned.status).toBe(0);
      const plan = planned.envelope.data.plan;
      expect(plan.requiredBindings[0]).toMatchObject({ name: 'OPENAI_API_KEY', satisfied: false });
      expect(plan.blockers.map((b: ParsedJson) => b.code)).toEqual(['RAY_BINDING_MISSING']);
      const missing = once([bundles.v1!.path, '--plan-digest', planned.envelope.data.planDigest]);
      expect(missing.status).toBe(2);
      expect(missing.envelope.errors[0].code).toBe('RAY_BINDING_MISSING');
    } finally {
      rmSync(join(deployDir, '.env'));
    }

    chmodSync(bindings, 0o644);
    const open = once([bundles.v1!.path, '--bindings-file', bindings]);
    chmodSync(bindings, 0o600);
    expect(open.status).toBe(4);
    expect(open.envelope.errors[0].code).toBe('RAY_BINDINGS_FILE_INSECURE');

    const reserved = join(temporaryDirectory('bundle-bindings-'), 'reserved.json');
    writeFileSync(
      reserved,
      JSON.stringify({
        bindingsFormatVersion: 1,
        bindings: [{ name: 'DATABASE_URL', value: 'postgresql://elsewhere/db' }],
      }),
    );
    chmodSync(reserved, 0o600);
    const refused = once([bundles.v1!.path, '--bindings-file', reserved]);
    expect(refused.status).toBe(4);
    expect(refused.envelope.errors[0].code).toBe('RAY_BINDING_RESERVED');
    expect(await tableCount()).toBe(0);
    armsRan += 1;
  }, 180_000);

  it('deploys the packed application from a directory without its source, and serves it', async () => {
    // A first deploy changes the schema: it needs the reviewed plan.
    const unreviewed = once([bundles.v1!.path, '--bindings-file', bindings]);
    expect(unreviewed.status).toBe(3);
    expect(unreviewed.envelope.errors[0].code).toBe('RAY_PLAN_STALE');
    expect(await tableCount()).toBe(0);

    const plan = dryRun(bundles.v1!.path);
    const served = await serve([bundles.v1!.path, '--plan-digest', plan.planDigest]);
    const bearer = await orgToken();
    const created = await fetch(`http://127.0.0.1:${PORT}/notes`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'kept' }),
    });
    expect(created.status).toBe(201);
    const hello = await get('/hello', bearer);
    expect(hello.status).toBe(200);
    expect(hello.text).toContain('from the version directory');
    const envelope = await stop(served);
    expect(envelope).toMatchObject({ ok: true, operation: 'deploy' });
    expect(envelope.data).toMatchObject({
      bundleSha256: bundles.v1!.sha,
      planDigest: plan.planDigest,
      status: 'stopped',
    });
    expect(await active()).toBe(bundles.v1!.sha);
    // The banner says the deploy created the product schema, not that it mounted one without DDL.
    expect(lastServeStderr).toContain(
      'Product DB:   APPLIED by the bundle deploy — product migration ledger row 1',
    );
    const version = join(deployDir, '.rayspec-state', 'versions', bundles.v1!.sha);
    expect(statSync(join(version, 'payload', 'handlers', 'hello.js')).mode & 0o777).toBe(0o400);
    const state = await db.unsafe(
      'SELECT deployment_id, application_id, application_digest FROM runtime_control_state',
    );
    expect(state[0]).toMatchObject({
      deployment_id: envelope.data.deploymentId,
      application_id: 'probe-app',
      application_digest: bundles.v1!.sha,
    });
    armsRan += 1;
  }, 240_000);

  it('updates the deployment with an additive change and keeps its rows', async () => {
    const v2 = await pack('v2', V2, V1, '1.1.0');
    const plan = dryRun(v2.path);
    expect(plan.plan.schemaImpact).toMatchObject({ destructive: false });
    expect(plan.plan.schemaImpact.productDeltaSha256).not.toBeNull();
    const served = await serve([v2.path, '--plan-digest', plan.planDigest]);
    const listed = await get('/notes', await orgToken());
    expect(listed.status).toBe(200);
    expect(listed.text).toContain('kept');
    await stop(served);
    expect(lastServeStderr).toContain(
      'Product DB:   APPLIED by the bundle deploy — product migration ledger row 2',
    );
    expect(await active()).toBe(v2.sha);
    expect(await db.unsafe('SELECT body, tag FROM bundle_notes')).toEqual([
      { body: 'kept', tag: null },
    ]);
    const ledger = await db.unsafe('SELECT count(*)::int AS n FROM product_migration_ledger');
    expect((ledger[0] as { n: number }).n).toBe(2);
    armsRan += 1;
  }, 240_000);

  it('refuses a destructive change, leaving the rows and the active version', async () => {
    const dropped = await pack('dropped', DROPPED, undefined, '1.2.0');
    const plan = dryRun(dropped.path);
    expect(plan.plan.schemaImpact.destructive).toBe(true);
    expect(plan.plan.blockers.map((b: ParsedJson) => b.code)).toContain('RAY_MIGRATION_REQUIRED');
    const refused = once([
      dropped.path,
      '--bindings-file',
      bindings,
      '--plan-digest',
      plan.planDigest,
    ]);
    expect(refused.status).toBe(3);
    expect(refused.envelope.errors[0].code).toBe('RAY_MIGRATION_REQUIRED');
    // The server's own scanner names what the change drops.
    expect(refused.envelope.errors.map((e: ParsedJson) => e.message).join('\n')).toContain(
      'drop-column on bundle_notes.tag',
    );
    expect(await active()).toBe(bundles.v2!.sha);
    expect(await db.unsafe('SELECT body, tag FROM bundle_notes')).toEqual([
      { body: 'kept', tag: null },
    ]);
    armsRan += 1;
  }, 240_000);

  it('refuses drift added by hand', async () => {
    const v3 = await pack('v3', V3, V2, '1.3.0');
    await db.unsafe('ALTER TABLE bundle_notes ADD COLUMN hand_added text');
    try {
      const plan = dryRun(v3.path);
      expect(plan.plan.blockers.map((b: ParsedJson) => b.code)).toContain('RAY_SCHEMA_DRIFT');
      const refused = once([
        v3.path,
        '--bindings-file',
        bindings,
        '--plan-digest',
        plan.planDigest,
      ]);
      expect(refused.status).toBe(6);
      expect(refused.envelope.errors[0].code).toBe('RAY_SCHEMA_DRIFT');
      expect(refused.envelope.errors[0].message).toContain('hand_added');
    } finally {
      await db.unsafe('ALTER TABLE bundle_notes DROP COLUMN hand_added');
    }
    expect(await active()).toBe(bundles.v2!.sha);
    armsRan += 1;
  }, 240_000);

  it('refuses a stale, an unknown and an expired plan, and another deployment', async () => {
    const plan = dryRun(bundles.v3!.path);
    expect(plan.plan.blockers).toEqual([]);
    const revision = await db.unsafe(
      'SELECT environment_revision::int AS r FROM runtime_control_state',
    );
    // The binding value changes after the plan was prepared.
    writeFileSync(
      bindings,
      JSON.stringify({
        bindingsFormatVersion: 1,
        bindings: [{ name: 'OPENAI_API_KEY', value: `${KEY}-rotated` }],
      }),
    );
    try {
      const stale = once([
        bundles.v3!.path,
        '--bindings-file',
        bindings,
        '--plan-digest',
        plan.planDigest,
      ]);
      expect(stale.status).toBe(3);
      expect(stale.envelope.errors[0].code).toBe('RAY_PLAN_STALE');
    } finally {
      writeFileSync(
        bindings,
        JSON.stringify({
          bindingsFormatVersion: 1,
          bindings: [{ name: 'OPENAI_API_KEY', value: KEY }],
        }),
      );
    }
    const unknown = once([
      bundles.v3!.path,
      '--bindings-file',
      bindings,
      '--plan-digest',
      'e'.repeat(64),
    ]);
    expect(unknown.status).toBe(3);
    expect(unknown.envelope.errors[0].code).toBe('RAY_PLAN_STALE');

    // A plan past its lifetime: the dry-run's record, as it would read 30 minutes and more later.
    // Its digest is recomputed for the older time, so only the expiry can refuse it.
    const fresh = dryRun(bundles.v3!.path);
    const record = JSON.parse(readFileSync(fresh.planRecordPath, 'utf8')) as ParsedJson;
    const preparedAt = new Date(Date.parse(record.preparedAt) - PLAN_LIFETIME_MS - 60_000);
    record.preparedAt = formatTimestamp(preparedAt);
    record.expiresAt = formatTimestamp(new Date(preparedAt.getTime() + PLAN_LIFETIME_MS));
    const { bundlePath: _bundlePath, ...input } = record;
    const expiredDigest = digestOf(input);
    writeFileSync(
      join(dirname(fresh.planRecordPath), `${expiredDigest}.json`),
      JSON.stringify(record),
      {
        mode: 0o600,
      },
    );
    const expired = once([
      bundles.v3!.path,
      '--bindings-file',
      bindings,
      '--plan-digest',
      expiredDigest,
    ]);
    expect(expired.status).toBe(3);
    expect(expired.envelope.errors[0]).toMatchObject({
      code: 'RAY_PLAN_STALE',
      message: 'the plan has expired; run the dry-run again',
    });

    // A state directory of another deployment, for a dry-run and a deploy alike.
    const other = temporaryDirectory('bundle-other-state-');
    chmodSync(other, 0o700);
    const otherDeployment = {
      deploymentFormatVersion: 1,
      deploymentId: 'fedcba9876543210',
      createdAt: formatTimestamp(new Date()),
      applicationId: 'probe-app',
    };
    writeFileSync(join(other, 'deployment.json'), JSON.stringify(otherDeployment), { mode: 0o600 });
    for (const args of [['--dry-run'], ['--plan-digest', plan.planDigest]]) {
      const refused = once([
        bundles.v3!.path,
        '--bindings-file',
        bindings,
        '--state-dir',
        other,
        ...args,
      ]);
      expect(refused.status).toBe(2);
      expect(refused.envelope.errors[0].code).toBe('RAY_USAGE');
      expect(refused.envelope.errors[0].message).toContain('belongs to another deployment');
    }
    // The other state directory is as it was: no plan record, no version, no active version.
    expect(readdirSync(other)).toEqual(['deployment.json']);
    expect(JSON.parse(readFileSync(join(other, 'deployment.json'), 'utf8'))).toEqual(
      otherDeployment,
    );
    expect(await active()).toBe(bundles.v2!.sha);
    expect(
      await db.unsafe('SELECT environment_revision::int AS r FROM runtime_control_state'),
    ).toEqual(revision);
    expect(await db.unsafe("SELECT to_regclass('public.bundle_tags') AS t")).toEqual([{ t: null }]);
    // Refused before anything was written: not even the version directory was staged.
    expect(existsSync(join(deployDir, '.rayspec-state', 'versions', bundles.v3!.sha))).toBe(false);
    armsRan += 1;
  }, 240_000);

  it('recovers a deploy killed after the first statement of its schema change', async () => {
    const plan = dryRun(bundles.v3!.path);
    const args = [bundles.v3!.path, '--plan-digest', plan.planDigest];

    // Hold the table the DDL's LAST statement alters, in the one mode that still lets it be read:
    // the DDL creates bundle_tags first, then waits for its ALTER TABLE.
    const locker = postgres(appUrl, { max: 1 });
    const held = await locker.reserve();
    await held.unsafe('BEGIN');
    await held.unsafe('LOCK TABLE bundle_notes IN ACCESS SHARE MODE');
    const child = spawn(
      process.execPath,
      [CLI_DIST, 'deploy', ...args, '--port', String(PORT), '--bindings-file', bindings],
      { cwd: deployDir, env: childEnv() },
    );
    children.push(child);
    let childErr = '';
    child.stderr?.on('data', (d) => {
      childErr += String(d);
    });
    try {
      const deadline = Date.now() + 120_000;
      let waiting: { pid: number; query: string } | undefined;
      while (waiting === undefined) {
        const rows = (await db.unsafe(
          `SELECT a.pid, a.query FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
            WHERE NOT l.granted AND l.relation = 'bundle_notes'::regclass`,
        )) as unknown as { pid: number; query: string }[];
        waiting = rows.find((r) => r.query.includes('CREATE TABLE "bundle_tags"'));
        if (child.exitCode !== null) throw new Error(`the deploy exited early\n${childErr}`);
        if (Date.now() > deadline) throw new Error(`the DDL never waited\n${childErr}`);
        if (waiting === undefined) await new Promise((r) => setTimeout(r, 100));
      }
      // The first statement of the DDL has run; the process dies before the DDL commits.
      child.kill('SIGKILL');
      await new Promise((r) => child.once('exit', r));
    } finally {
      await held.unsafe('ROLLBACK');
      held.release();
      await locker.end();
    }
    // The server rolls the dead session's transaction back once it notices the client is gone.
    const settle = Date.now() + 60_000;
    for (;;) {
      const busy = (await db.unsafe(
        'SELECT count(*)::int AS n FROM pg_stat_activity WHERE query LIKE \'%CREATE TABLE "bundle_tags"%\' AND pid <> pg_backend_pid()',
      )) as unknown as { n: number }[];
      if (busy[0]?.n === 0) break;
      if (Date.now() > settle) throw new Error('the killed session did not end');
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(await db.unsafe("SELECT to_regclass('public.bundle_tags') AS t")).toEqual([{ t: null }]);
    expect(await active()).toBe(bundles.v2!.sha);
    const ledger = await db.unsafe('SELECT count(*)::int AS n FROM product_migration_ledger');
    expect((ledger[0] as { n: number }).n).toBe(2);

    // The same deploy again: while the dead process's lease lives it is refused as retryable; then
    // it continues the interrupted operation, whose DDL step is settled as not applied, and runs it.
    let served: Served | undefined;
    const retryUntil = Date.now() + 150_000;
    while (served === undefined) {
      try {
        served = await serve(args);
      } catch (err) {
        const text = String(err);
        expect(text, text).toMatch(/deploy exited 5/);
        expect(text).toContain('RAY_LOCK_TIMEOUT');
        if (Date.now() > retryUntil) throw err;
        await new Promise((r) => setTimeout(r, 3_000));
      }
    }
    const listed = await get('/notes', await orgToken());
    expect(listed.text).toContain('kept');
    const envelope = await stop(served);
    expect(envelope.data.bundleSha256).toBe(bundles.v3!.sha);
    expect(await active()).toBe(bundles.v3!.sha);
    expect(await db.unsafe("SELECT to_regclass('public.bundle_tags')::text AS t")).toEqual([
      { t: 'bundle_tags' },
    ]);
    expect(await db.unsafe('SELECT body, priority FROM bundle_notes')).toEqual([
      { body: 'kept', priority: null },
    ]);
    // One operation under the plan's key: the killed attempt's DDL step settled as not applied, then
    // run to completion by the second attempt.
    const receipts = (await db.unsafe(
      `SELECT event, step FROM runtime_control_receipts
        WHERE operation_id = (SELECT operation_id FROM runtime_control_receipts
                               WHERE idempotency_key = $1 AND event = 'intent')
          AND step = 'product-ddl' ORDER BY id`,
      [plan.planDigest],
    )) as unknown as { event: string }[];
    expect(receipts.map((r) => r.event)).toEqual([
      'step-started',
      'step-skipped',
      'step-started',
      'step-finished',
    ]);
    armsRan += 1;
  }, 360_000);
});

// The un-skippable ran-guard: a REQUIRED DB run that silently skipped is a false green.
it('DB-backed arms actually ran when the environment requires them', () => {
  if (dbRequired) expect(armsRan).toBe(9);
  else expect(true).toBe(true);
});
