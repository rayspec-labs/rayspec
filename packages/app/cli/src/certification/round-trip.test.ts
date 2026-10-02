/**
 * Export, import and restore in the hardened posture, end to end through the real built CLI: a
 * source deployment with the posture fully on (test-support/posture-deployment.ts) holds an organization, two
 * members, rows, uploaded files, a completed agent run and the credentials its secrets key (access
 * tokens, a refresh session, an API key, a pending invite). `rayspec export` writes its encrypted
 * migration bundle while it serves; `rayspec import` restores it into an empty target with roles of
 * its own; the cutover token releases the target; the application is deployed there with the
 * secrets the import minted, again with the posture fully on.
 *
 * What the round trip must show: every row and every file arrives unchanged, the identity reset
 * holds (each credential the old secrets keyed is refused, each password still signs in), the
 * target serves as its runtime role in single-tenant mode, and the source stays fenced.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { schemaValidator } from '@rayspec/bundle-contract';
import type { RuntimeRoleLane } from '@rayspec/db/testing';
import { generateX25519Identity, identityToRecipient } from 'age-encryption';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  removeTemporaryDirectories,
  temporaryDirectory,
} from '../../../../kernel/bundle-closure/src/test-support/app.js';
import { CLI_DIST, type ParsedJson } from '../test-support/bundles.js';
import { type LaneRoles, prepareRoleDatabases } from '../test-support/migration-source.js';
import { pgToolPath } from '../test-support/pg-tools.js';
import {
  ALLOWED_ORIGIN,
  asAdmin,
  PASSWORD,
  PINNED_PROXY,
  type PostureDeployment,
  request,
  startPostureDeployment,
} from '../test-support/posture-deployment.js';
import { freePort, SpawnedProcesses } from '../test-support/processes.js';

const baseUrl = process.env.DATABASE_URL;
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (dbRequired && !baseUrl) {
  throw new Error('round-trip: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS)');
}

const ARMS = 2;
let armsRan = 0;
const valid = schemaValidator('resultEnvelope');
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

const TARGET_DB = `rayspec_cert_target_${process.pid}`;
const TARGET_SYS = `${TARGET_DB}_dbos_sys`;

/** Every file under `root`, as relative path and SHA-256, sorted. */
function filesOf(root: string): [string, string][] {
  const out: [string, string][] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        out.push([
          relative(root, path),
          createHash('sha256').update(readFileSync(path)).digest('hex'),
        ]);
      }
    }
  };
  walk(root);
  return out.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

describe.skipIf(!baseUrl)('export, import and restore in the hardened posture', () => {
  const adminUrl = baseUrl ?? '';
  const processes = new SpawnedProcesses();
  let source: PostureDeployment;
  let target: { lane: RuntimeRoleLane; roles: LaneRoles };
  let workDir = '';
  let pgDump = '';
  let pgRestore = '';
  let identity = '';
  let recipient = '';
  let orgId = '';
  const issued = {
    ownerToken: '',
    refreshCookie: '',
    apiKey: '',
    inviteToken: '',
  };
  const people = {
    owner: { email: 'owner@roundtrip.example', password: PASSWORD },
    member: { email: 'member@roundtrip.example', password: ['member', PASSWORD].join('-') },
  };

  /** One CLI run to completion; no secret may reach its output. */
  async function cli(
    args: string[],
    env: NodeJS.ProcessEnv,
    secrets: string[],
  ): Promise<{ code: number | null; envelope: ParsedJson; stdout: string; stderr: string }> {
    const child = processes.track(
      spawn(process.execPath, [CLI_DIST, ...args], {
        cwd: workDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr?.on('data', (d) => {
      stderr += String(d);
    });
    const code = await new Promise<number | null>((r) => child.on('exit', (c) => r(c)));
    let envelope: ParsedJson = {};
    try {
      envelope = JSON.parse(stdout) as ParsedJson;
    } catch {
      envelope = { unparsed: stdout };
    }
    for (const secret of secrets) {
      expect(`${stdout}${stderr}`.includes(secret), 'a secret reached the output').toBe(false);
    }
    expect(valid(envelope), `${JSON.stringify(valid.errors)}\n${stderr}`).toBe(true);
    return { code, envelope, stdout, stderr };
  }

  beforeAll(async () => {
    if (!baseUrl) return;
    source = await startPostureDeployment(adminUrl, `rayspec_cert_source_${process.pid}`);
    target = await prepareRoleDatabases(adminUrl, TARGET_DB, TARGET_SYS);
    workDir = temporaryDirectory('posture-roundtrip-');
    const [{ major }] = (await asAdmin(adminUrl, 'postgres', (sql) =>
      sql.unsafe("SELECT current_setting('server_version_num')::int / 10000 AS major"),
    )) as unknown as [{ major: number }];
    pgDump = pgToolPath('pg_dump', major, workDir).path;
    pgRestore = pgToolPath('pg_restore', major, workDir).path;
    identity = await generateX25519Identity();
    recipient = await identityToRecipient(identity);
  }, 600_000);

  afterAll(async () => {
    await processes.stopAll(10_000);
    if (workDir !== '') spawnSync('chmod', ['-R', 'u+w', workDir]);
    await source?.dispose();
    await asAdmin(adminUrl, 'postgres', async (sql) => {
      for (const name of [TARGET_DB, TARGET_SYS]) {
        await sql.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      }
    }).catch(() => {});
    await target?.lane.drop().catch(() => {});
    removeTemporaryDirectories();
    if (dbRequired) expect(armsRan).toBe(ARMS);
  }, 180_000);

  let bundle = '';
  let sourceNotes: string[] = [];
  let sourceFiles: [string, string][] = [];

  it('exports the deployment while it serves, with its rows, files, run history and credentials, as an encrypted bundle only the operator reads', async () => {
    const base = source.base;
    // The organization, its owner and a member with passwords of their own.
    const owner = await request(base, '/v1/auth/register', {
      body: { ...people.owner, orgName: 'Round Trip — Ü' },
    });
    expect(owner.status, owner.text).toBe(201);
    orgId = owner.body.activeOrgId as string;
    issued.ownerToken = owner.body.accessToken as string;
    const invite = await request(base, `/v1/orgs/${orgId}/invites`, {
      token: issued.ownerToken,
      body: { email: people.member.email, role: 'member' },
    });
    expect(invite.status).toBe(201);
    const accepted = await request(base, '/v1/invites/accept', {
      body: { token: invite.body.inviteToken, password: people.member.password },
    });
    expect(accepted.status, accepted.text).toBe(201);
    // The credentials the source's secrets key: a refresh session, an API key, a pending invite.
    const login = await fetch(`${base}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN },
      body: JSON.stringify(people.owner),
    });
    expect(login.status).toBe(200);
    issued.refreshCookie =
      login.headers
        .getSetCookie()
        .find((c) => c.startsWith('__Host-rayspec_refresh='))
        ?.split(';')[0] ?? '';
    expect(issued.refreshCookie).not.toBe('');
    const key = await request(base, `/v1/orgs/${orgId}/api-keys`, {
      token: issued.ownerToken,
      body: { scopes: ['apikey:read', 'store:read'] },
    });
    expect(key.status, key.text).toBe(201);
    issued.apiKey = key.body.plaintext as string;
    const pending = await request(base, `/v1/orgs/${orgId}/invites`, {
      token: issued.ownerToken,
      body: { email: `pending-${randomUUID()}@roundtrip.example`, role: 'member' },
    });
    expect(pending.status).toBe(201);
    issued.inviteToken = pending.body.inviteToken as string;
    // Rows and files.
    for (const body of ['Grüße — 東京 🌍', "quote ' and \\ and tab\t", 'plain']) {
      expect(
        (await request(base, '/notes', { token: issued.ownerToken, body: { body } })).status,
      ).toBe(201);
    }
    const binary = Buffer.alloc(50_000);
    for (let i = 0; i < binary.length; i++) binary[i] = (i * 7919) % 256;
    for (const [name, bytes] of [
      ['binary', binary],
      ['empty', Buffer.alloc(0)],
    ] as const) {
      const res = await request(base, `/uploads/${name}`, { token: issued.ownerToken, raw: bytes });
      expect(res.status, res.text).toBe(200);
    }
    // A completed agent run: run history in both databases.
    source.provider.mode = 'answer';
    const run = await request(base, '/v1/agents/echo/runs', {
      token: issued.ownerToken,
      body: { input: 'round trip run' },
    });
    expect(run.status, run.text).toBe(200);
    expect(source.provider.sawText('round trip run')).toBeGreaterThan(0);

    sourceNotes = (
      (await source.admin((sql) =>
        sql.unsafe('SELECT id::text, tenant_id::text, body FROM posture_notes ORDER BY id'),
      )) as unknown as { id: string; tenant_id: string; body: string }[]
    ).map((r) => JSON.stringify(r));
    expect(sourceNotes).toHaveLength(3);

    // The export, with role separation, while the source serves.
    bundle = join(workDir, 'migration.ray');
    const exported = await cli(
      [
        'export',
        '--deployment',
        source.deploymentId,
        '--recipient',
        recipient,
        '--output',
        bundle,
        '--run-history',
        'included',
        '--confirm-quiesce',
        '--state-dir',
        source.stateDir,
      ],
      { ...source.env, RAYSPEC_PG_DUMP: pgDump },
      [...source.secrets, identity, issued.apiKey, issued.inviteToken, PASSWORD],
    );
    expect(exported.code, exported.stderr).toBe(0);
    expect(exported.envelope.data.excludedDataCategories).toEqual(
      expect.arrayContaining(['credential-state']),
    );
    // The bundle is the operator's alone: mode 0600, judged on the handle that reads it.
    const fd = openSync(bundle, 'r');
    try {
      expect(fstatSync(fd).mode & 0o777).toBe(0o600);
      const head = Buffer.alloc(4);
      readFileSync(fd).copy(head, 0, 0, 4);
      expect(head.readUInt32LE(0)).toBe(0x04034b50);
    } finally {
      closeSync(fd);
    }
    // No plaintext of a row is in it.
    expect(readFileSync(bundle).includes(Buffer.from('Grüße'))).toBe(false);
    sourceFiles = filesOf(source.blobRoot);
    expect(sourceFiles.length).toBeGreaterThanOrEqual(2);
    // The source is fenced now: writes are refused.
    const late = await request(base, '/notes', {
      token: issued.ownerToken,
      body: { body: 'late' },
    });
    expect(late.status).toBe(503);
    armsRan += 1;
  }, 600_000);

  it('imports into an empty target, cuts over with the token, and serves every row and file there with the identity reset', async () => {
    expect(bundle, 'the export arm did not run').not.toBe('');
    const stateDir = join(workDir, 'target-state');
    const blobRoot = join(workDir, 'target-blobs');
    mkdirSync(blobRoot);
    const identityFile = join(workDir, 'identity.txt');
    writeFileSync(identityFile, `${identity}\n`);
    chmodSync(identityFile, 0o600);
    const bindingsFile = join(workDir, 'target-bindings.json');
    writeFileSync(
      bindingsFile,
      JSON.stringify({
        bindingsFormatVersion: 1,
        bindings: [{ name: 'OPENAI_API_KEY', value: ['inert', 'target', randomUUID()].join('-') }],
      }),
    );
    chmodSync(bindingsFile, 0o600);
    const targetSecrets = [
      target.roles.app.migration,
      target.roles.app.runtime,
      target.roles.sys.runtime,
    ]
      .map((u) => decodeURIComponent(new URL(u).password))
      .filter((p) => p !== '');
    const secrets = [...source.secrets, ...targetSecrets, identity, issued.apiKey, PASSWORD];
    const targetEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      TMPDIR: process.env.TMPDIR ?? '',
      DATABASE_URL: target.roles.app.runtime,
      RAYSPEC_MIGRATION_DATABASE_URL: target.roles.app.migration,
      DBOS_SYSTEM_DATABASE_URL: target.roles.sys.runtime,
      RAYSPEC_BLOB_ROOT: blobRoot,
      RAYSPEC_PG_RESTORE: pgRestore,
    };
    const secretsOut = join(workDir, 'target-secrets');
    const imported = await cli(
      [
        'import',
        bundle,
        '--target',
        stateDir,
        '--secrets-out',
        secretsOut,
        '--identity-file',
        identityFile,
        '--bindings-file',
        bindingsFile,
      ],
      targetEnv,
      secrets,
    );
    expect(imported.code, imported.stderr).toBe(0);
    const token = /cutover token ([0-9a-f]{64}): works once/.exec(imported.stderr)?.[1] ?? '';
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const cut = await cli(
      ['import', '--target', stateDir, '--cutover-token', token],
      targetEnv,
      secrets,
    );
    expect(cut.code, cut.stderr).toBe(0);

    // The application on the target, with the secrets the import minted and the posture fully on.
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const deployEnv: NodeJS.ProcessEnv = {
      ...targetEnv,
      SHADOW_DATABASE_URL: process.env.SHADOW_DATABASE_URL ?? adminUrl,
      RAYSPEC_JWT_SIGNING_KEY_FILE: join(secretsOut, 'jwt-signing-key.pem'),
      RAYSPEC_API_KEY_PEPPER_FILE: join(secretsOut, 'api-key-pepper'),
      RAYSPEC_MEDIA_SIGNING_KEY: ['target', 'media', 'key', randomUUID()].join('-'),
      RAYSPEC_SINGLE_TENANT: 'true',
      RAYSPEC_HOSTING_POSTURE: 'managed',
      RAYSPEC_TRUSTED_PROXIES: PINNED_PROXY,
      ALLOWED_ORIGINS: ALLOWED_ORIGIN,
      OPENAI_BASE_URL: source.provider.base,
    };
    const dry = spawnSync(
      process.execPath,
      [
        CLI_DIST,
        'deploy',
        source.appBundle,
        '--dry-run',
        '--bindings-file',
        bindingsFile,
        '--state-dir',
        stateDir,
      ],
      { cwd: workDir, env: deployEnv, encoding: 'utf8', timeout: 180_000 },
    );
    expect(dry.status, dry.stderr).toBe(0);
    const planDigest = (JSON.parse(dry.stdout) as ParsedJson).data.planDigest as string;
    const served = processes.track(
      spawn(
        process.execPath,
        [
          CLI_DIST,
          'deploy',
          source.appBundle,
          '--plan-digest',
          planDigest,
          '--port',
          String(port),
          '--bindings-file',
          bindingsFile,
          '--state-dir',
          stateDir,
        ],
        { cwd: workDir, env: deployEnv, stdio: ['ignore', 'pipe', 'pipe'] },
      ),
    );
    let out = '';
    served.stdout?.on('data', (d) => {
      out += String(d);
    });
    served.stderr?.on('data', (d) => {
      out += String(d);
    });
    const deadline = Date.now() + 150_000;
    for (;;) {
      if (served.exitCode !== null) throw new Error(`the target deploy exited\n${out}`);
      try {
        if ((await fetch(`${base}/livez`)).status === 200) break;
      } catch {
        // not listening yet
      }
      if (Date.now() > deadline) throw new Error(`the target did not serve\n${out}`);
      await pause(250);
    }

    // Every row and every file arrived unchanged.
    const targetNotes = (
      (await asAdmin(adminUrl, TARGET_DB, (sql) =>
        sql.unsafe('SELECT id::text, tenant_id::text, body FROM posture_notes ORDER BY id'),
      )) as unknown as { id: string; tenant_id: string; body: string }[]
    ).map((r) => JSON.stringify(r));
    expect(targetNotes).toEqual(sourceNotes);
    expect(filesOf(blobRoot)).toEqual(sourceFiles);
    const [runs] = (await asAdmin(adminUrl, TARGET_DB, (sql) =>
      sql.unsafe("SELECT count(*)::int AS n FROM runs WHERE status = 'completed'"),
    )) as unknown as [{ n: number }];
    expect(runs.n).toBeGreaterThan(0);

    // The identity reset: every credential the source's secrets keyed is refused.
    expect((await request(base, '/notes', { token: issued.ownerToken })).status).toBe(401);
    expect((await request(base, '/notes', { token: issued.apiKey })).status).toBe(401);
    const refreshed = await fetch(`${base}/v1/auth/refresh`, {
      method: 'POST',
      headers: {
        cookie: issued.refreshCookie,
        origin: ALLOWED_ORIGIN,
        'sec-fetch-site': 'same-site',
      },
    });
    expect(refreshed.status).toBe(401);
    const invited = await request(base, '/v1/invites/accept', {
      body: { token: issued.inviteToken, password: 'an-invitee-long-password' },
    });
    expect(invited.status).toBe(400);
    const [credentials] = (await asAdmin(adminUrl, TARGET_DB, (sql) =>
      sql.unsafe(
        `SELECT (SELECT count(*) FROM sessions)::int AS sessions,
                (SELECT count(*) FROM api_keys)::int AS keys,
                (SELECT count(*) FROM invites)::int AS invites`,
      ),
    )) as unknown as [{ sessions: number; keys: number; invites: number }];
    expect(credentials).toEqual({ sessions: 0, keys: 0, invites: 0 });

    // Each password still signs in, and reads the organization's rows.
    for (const person of [people.owner, people.member]) {
      const login = await request(base, '/v1/auth/login', { body: person });
      expect(login.status, `${person.email}: ${login.text}`).toBe(200);
      const switched = await request(base, `/v1/orgs/${orgId}/switch`, {
        method: 'POST',
        token: login.body.accessToken as string,
      });
      expect(switched.status).toBe(200);
      const listed = await request(base, '/notes', { token: switched.body.accessToken as string });
      expect(listed.status).toBe(200);
      expect(listed.text).toContain('Grüße');
    }
    // The target is in the posture: one organization, registration closed, the runtime role serving.
    const again = await request(base, '/v1/auth/register', {
      body: { email: 'new@roundtrip.example', password: PASSWORD, orgName: 'Another' },
    });
    expect(again.status).toBe(403);
    const sessions = (await asAdmin(adminUrl, TARGET_DB, (sql) =>
      sql.unsafe(
        `SELECT DISTINCT usename FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid() AND usename IS NOT NULL`,
      ),
    )) as unknown as { usename: string }[];
    expect(sessions.map((s) => s.usename)).toEqual([
      decodeURIComponent(new URL(target.roles.app.runtime).username),
    ]);
    // The source stays fenced.
    const [fence] = await source.admin(
      (sql) =>
        sql.unsafe(
          'SELECT fence_state FROM runtime_control_state WHERE id = 1',
        ) as unknown as Promise<{ fence_state: string }[]>,
    );
    expect(fence?.fence_state).toBe('fenced');
    armsRan += 1;
  }, 900_000);
});
