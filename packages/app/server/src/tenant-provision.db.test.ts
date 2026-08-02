/**
 * The OPERATOR tenant provisioning path — `provisionTenant`, on GROUND TRUTH against a throwaway
 * DATABASE, plus the shipped public accept route it hands the tenant over through.
 *
 * WHAT THESE ARMS EXIST TO PROVE. An automated deployment needs an organization to exist before it
 * boots, and the only way to make one was to register a user through the public services and read the
 * generated id back — which leaves a platform user behind that nobody asked for and that cannot be
 * removed (`removeMember` refuses to remove the last owner, and a user delete is a soft delete that
 * leaves a row). So the first arm counts rows: after provisioning, `users` is EMPTY. What the command
 * writes instead is an owner INVITE with `created_by IS NULL`, and a real human turns that into their
 * own account — with their own password — through the completely unmodified `POST /v1/invites/accept`.
 *
 * The second arm is the idempotency contract: the chosen org id IS the operation id, `orgs.id` is a
 * PRIMARY KEY, and so the database itself is the ledger. Two runs, sequential or concurrent, converge
 * on one org row and one live owner invite; the second run mints NOTHING, which is what makes a retry
 * safe to run from a deploy script that cannot know whether the first attempt got through.
 *
 * The suite database is created EMPTY on purpose: the first arm's provisioning call is what applies
 * the committed migration chain, which is the difference between a one-step command and a command
 * with a documented prerequisite.
 *
 * Skips without DATABASE_URL; the un-skippable ran-guard hard-fails a REQUIRED run that did not run.
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrgStore } from '@rayspec/api-auth';
import { makeDb } from '@rayspec/db';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assembleServer, type BootedServer, loadServerConfig } from './composition-root.js';
import { provisionTenant, type TenantProvisionSecrets } from './tenant-provision.js';

const baseUrl = process.env.DATABASE_URL;
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
let armsRan = 0;

const SUITE_DB = `rayspec_tenant_provision_${process.pid}`;
const PEPPER = 'tenant-provision-suite-pepper';
const CHOSEN = '00000000-0000-4000-8000-0000000000c1';
const SECOND = '00000000-0000-4000-8000-0000000000c2';
const CONCURRENT = '00000000-0000-4000-8000-0000000000c3';

function adminUrl(url: string): string {
  const u = new URL(url);
  u.pathname = '/postgres';
  return u.toString();
}
function withDbName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

describe.skipIf(!baseUrl)('provisionTenant — the operator create-or-resolve', () => {
  let dbUrl = '';
  let dir = '';
  let secrets: TenantProvisionSecrets;
  let server: BootedServer | undefined;
  const saved: Record<string, string | undefined> = {};
  const ENV = [
    'RAYSPEC_JWT_SIGNING_KEY',
    'RAYSPEC_API_KEY_PEPPER',
    'DATABASE_URL',
    'ALLOWED_ORIGINS',
    'PORT',
    'RAYSPEC_SPEC_PATH',
    'DBOS_SYSTEM_DATABASE_URL',
    'RAYSPEC_TENANT_BOOTSTRAP_ENABLED',
  ] as const;

  /** Read ground truth off the suite database with a short-lived client (no pooled handle to leak). */
  async function scalar(sqlText: string, params: unknown[] = []): Promise<string> {
    const client = postgres(dbUrl, { max: 1 });
    try {
      const rows = (await client.unsafe(sqlText, params as never)) as unknown as Array<
        Record<string, unknown>
      >;
      return String(Object.values(rows[0] ?? { v: '' })[0]);
    } finally {
      await client.end();
    }
  }

  async function rows<T>(sqlText: string, params: unknown[] = []): Promise<T[]> {
    const client = postgres(dbUrl, { max: 1 });
    try {
      return (await client.unsafe(sqlText, params as never)) as unknown as T[];
    } finally {
      await client.end();
    }
  }

  beforeAll(async () => {
    if (!baseUrl) return;
    dbUrl = withDbName(baseUrl, SUITE_DB);
    dir = mkdtempSync(join(tmpdir(), 'rayspec-tenant-provision-'));
    const admin = postgres(adminUrl(baseUrl), { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}_dbos_sys" WITH (FORCE)`);
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE "${SUITE_DB}"`);
    } finally {
      await admin.end();
    }
    // EMPTY, deliberately — the first arm's provisioning call is what bootstraps the schema.
    expect(await scalar(`SELECT to_regclass('public.orgs') IS NULL AS empty`)).toBe('true');

    for (const k of ENV) saved[k] = process.env[k];
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    process.env.RAYSPEC_JWT_SIGNING_KEY = await exportPKCS8(privateKey);
    process.env.RAYSPEC_API_KEY_PEPPER = PEPPER;
    process.env.DATABASE_URL = dbUrl;
    delete process.env.ALLOWED_ORIGINS;
    process.env.PORT = '8811';
    delete process.env.RAYSPEC_SPEC_PATH;
    delete process.env.DBOS_SYSTEM_DATABASE_URL;
    // UNSET on purpose: the provisioning path carries its own posture, so a deployment that never
    // turns this on can still be provisioned — and never registers the bootstrap route.
    delete process.env.RAYSPEC_TENANT_BOOTSTRAP_ENABLED;

    secrets = { databaseUrl: dbUrl, apiKeyPepper: PEPPER };
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    if (baseUrl) {
      const admin = postgres(adminUrl(baseUrl), { max: 1 });
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}_dbos_sys" WITH (FORCE)`);
        await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    }
  }, 60_000);

  it('the owner handoff leaves ZERO platform users and the org is claimable through the shipped accept route', async () => {
    let captured = '';
    const out = await provisionTenant(
      secrets,
      {
        orgId: CHOSEN,
        name: 'Acme Operations',
        ownerEmail: 'Founder@Example.COM',
        ownerInviteOut: join(dir, 'owner.token'),
      },
      {
        // Injected so the token stays in this test's memory: the arm is about who ends up holding it.
        writeToken: async (_path, token) => {
          captured = token;
        },
      },
    );

    expect(out.orgId).toBe(CHOSEN);
    expect(out.org).toBe('created');
    expect(out.acceptPath).toBe('/v1/invites/accept');
    expect(out.ownerHandoff.status).toBe('issued');
    expect(captured).not.toBe('');
    // Nothing in the returned object carries the token.
    expect(JSON.stringify(out)).not.toContain(captured);

    // GROUND TRUTH, the acceptance the four-step dance could not meet: no platform user exists. A
    // soft-deleted user would still be a row here, so this also rules out the create-then-delete shape.
    expect(await scalar('SELECT count(*) FROM users')).toBe('0');
    expect(await scalar('SELECT count(*) FROM memberships WHERE org_id = $1', [CHOSEN])).toBe('0');
    const invites = await rows<{
      role: string;
      created_by: string | null;
      consumed_at: Date | null;
    }>('SELECT role, created_by, consumed_at FROM invites WHERE tenant_id = $1', [CHOSEN]);
    expect(invites).toHaveLength(1);
    expect(invites[0]?.role).toBe('owner');
    // No author: the invite was written by an operator holding the database, not by a principal.
    expect(invites[0]?.created_by).toBeNull();
    expect(invites[0]?.consumed_at).toBeNull();

    // The handover: the SHIPPED, UNMODIFIED public accept route turns the token into a real owner.
    server = await assembleServer(loadServerConfig());
    const accept = await server.app.request('/v1/invites/accept', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: captured, password: 'a-very-long-founder-password' }),
    });
    expect(accept.status).toBe(201);
    const body = (await accept.json()) as { role: string; activeOrgId: string; userId: string };
    expect(body.role).toBe('owner');
    expect(body.activeOrgId).toBe(CHOSEN);

    const db = makeDb(dbUrl);
    try {
      expect(await new OrgStore(db).ownerCount(CHOSEN)).toBe(1);
    } finally {
      await db.$client.end();
    }
    // EXACTLY one user now exists — the human, who provisioned their own account with their own
    // password. The command created none, before or after.
    expect(await scalar('SELECT count(*) FROM users')).toBe('1');
    expect(
      await scalar(
        'SELECT count(*) FROM invites WHERE tenant_id = $1 AND consumed_at IS NOT NULL',
        [CHOSEN],
      ),
    ).toBe('1');

    // Single use: a replay gets the same generic rejection an unknown token gets.
    const replay = await server.app.request('/v1/invites/accept', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: captured, password: 'another-very-long-password' }),
    });
    expect(replay.status).toBe(400);
    expect(JSON.stringify(await replay.json())).toMatch(/invalid, expired, or already used/i);
    armsRan += 1;
  }, 180_000);

  it('twice with the same operation id yields the same org, one row, and no second invite', async () => {
    const tokens: string[] = [];
    const writeToken = async (_path: string, token: string) => {
      tokens.push(token);
    };
    const input = {
      orgId: SECOND,
      name: 'Repeat Runs',
      ownerEmail: 'repeat@example.com',
      ownerInviteOut: join(dir, 'repeat.token'),
    };

    const first = await provisionTenant(secrets, input, { writeToken });
    const second = await provisionTenant(secrets, input, { writeToken });

    expect(first.org).toBe('created');
    expect(second.org).toBe('existing');
    expect(second.orgId).toBe(first.orgId);
    expect(second.slug).toBe(first.slug);
    expect(first.ownerHandoff.status).toBe('issued');
    // The second run reports the OUTSTANDING invite rather than minting a new one — which is what
    // makes the retry idempotent, without the caller having to supply a secret to make it so.
    expect(second.ownerHandoff.status).toBe('pending');
    expect(tokens).toHaveLength(1);
    expect(await scalar('SELECT count(*) FROM orgs WHERE id = $1', [SECOND])).toBe('1');
    expect(await scalar('SELECT count(*) FROM invites WHERE tenant_id = $1', [SECOND])).toBe('1');

    // The id an operator typed in upper case is the SAME org, reported as the database stores it —
    // `uuidgen` prints upper case on macOS, and the deployment compares its bound tenant as a string.
    const shouted = await provisionTenant(
      secrets,
      { ...input, orgId: SECOND.toUpperCase() },
      {
        writeToken,
      },
    );
    expect(shouted.orgId).toBe(SECOND);
    expect(shouted.org).toBe('existing');
    expect(await scalar('SELECT count(*) FROM orgs WHERE id = $1', [SECOND])).toBe('1');
    armsRan += 1;
  }, 180_000);

  it('two concurrent runs of the same operation id: exactly one creates, neither throws', async () => {
    const tokens: string[] = [];
    const writeToken = async (_path: string, token: string) => {
      tokens.push(token);
    };
    const input = {
      orgId: CONCURRENT,
      name: 'Race Runs',
      ownerEmail: 'race@example.com',
      ownerInviteOut: join(dir, 'race.token'),
    };

    const [a, b] = await Promise.all([
      provisionTenant(secrets, input, { writeToken }),
      provisionTenant(secrets, input, { writeToken }),
    ]);

    expect([a.org, b.org].filter((s) => s === 'created')).toHaveLength(1);
    expect(a.orgId).toBe(CONCURRENT);
    expect(b.orgId).toBe(CONCURRENT);
    expect(await scalar('SELECT count(*) FROM orgs WHERE id = $1', [CONCURRENT])).toBe('1');
    expect(
      await scalar(
        'SELECT count(*) FROM invites WHERE tenant_id = $1 AND consumed_at IS NULL AND expires_at > now()',
        [CONCURRENT],
      ),
    ).toBe('1');
    expect(tokens).toHaveLength(1);
    armsRan += 1;
  }, 180_000);

  it('the default token file is created exclusively at mode 600, and an existing path is refused', async () => {
    const orgId = '00000000-0000-4000-8000-0000000000c4';
    const out = join(dir, 'real-writer.token');
    const result = await provisionTenant(secrets, {
      orgId,
      name: 'Real Writer',
      ownerEmail: 'writer@example.com',
      ownerInviteOut: out,
    });
    expect(result.ownerHandoff.status).toBe('issued');
    // Owner-read-write only: the file holds a credential that grants ownership of the tenant.
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(readFileSync(out, 'utf8').length).toBeGreaterThan(0);

    // NEVER CLOBBER: pointing a second run at an existing path is refused rather than overwriting an
    // operator's file — the same posture `dev gen-secrets` takes with a `.env`.
    const taken = join(dir, 'already-there.token');
    writeFileSync(taken, 'not-a-token');
    chmodSync(taken, 0o600);
    await expect(
      provisionTenant(secrets, {
        orgId: '00000000-0000-4000-8000-0000000000c5',
        name: 'Clobber Guard',
        ownerEmail: 'clobber@example.com',
        ownerInviteOut: taken,
        reissueOwnerInvite: true,
      }),
    ).rejects.toThrow(/OWNER_INVITE_OUT_EXISTS|already exists/i);
    expect(readFileSync(taken, 'utf8')).toBe('not-a-token');
    // ORDERING: the token file is written INSIDE the reservation transaction, before the invite row,
    // so a refused write leaves no org behind either. The alternative ordering — commit, then write —
    // would have produced an org whose only claim credential was lost.
    expect(
      await scalar('SELECT count(*) FROM orgs WHERE id = $1', [
        '00000000-0000-4000-8000-0000000000c5',
      ]),
    ).toBe('0');
    armsRan += 1;
  }, 180_000);

  it('an owner already on the org is never displaced, and no invite is minted for one', async () => {
    // CHOSEN was claimed by a real human in the first arm. Re-running the command against it must be
    // inert: this is the safety property that makes an idempotent resolve safe to automate at all.
    const before = await scalar('SELECT count(*) FROM invites WHERE tenant_id = $1', [CHOSEN]);
    const out = await provisionTenant(
      secrets,
      {
        orgId: CHOSEN,
        name: 'Acme Operations',
        ownerEmail: 'intruder@example.com',
        ownerInviteOut: join(dir, 'intruder.token'),
      },
      {
        writeToken: async () => {
          throw new Error('the command must not mint a token for an org that already has an owner');
        },
      },
    );
    expect(out.org).toBe('existing');
    expect(out.ownerHandoff).toEqual({ status: 'already_owned', owners: 1 });
    expect(await scalar('SELECT count(*) FROM invites WHERE tenant_id = $1', [CHOSEN])).toBe(
      before,
    );
    armsRan += 1;
  }, 180_000);
});

// The un-skippable ran-guard: a REQUIRED DB run that silently skipped is a false green.
it('DB-backed arms actually ran when the environment requires them', () => {
  if (dbRequired) expect(armsRan).toBe(5);
  else expect(true).toBe(true);
});
