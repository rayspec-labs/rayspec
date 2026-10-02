/**
 * The mandatory public-hosting checks of the hosting contract, on one deployment served by the real
 * built CLI with the hardened posture fully on (test-support/posture-deployment.ts): role separation and
 * row-level security, single-tenant mode, the managed posture, pinned trusted proxies and one
 * allowed browser origin. Every request is real HTTP to the served process; every observation of
 * state is read from the database as the superuser, never through the code under test.
 *
 * Skips without DATABASE_URL; a required run (CI, RAYSPEC_REQUIRE_DB_TESTS) fails instead, and the
 * ran-guard fails a required run whose arms did not all run.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { removeTemporaryDirectories } from '../../../../kernel/bundle-closure/src/test-support/app.js';
import { CLI_DIST } from '../test-support/bundles.js';
import {
  ALLOWED_ORIGIN,
  INTERNAL_DETAIL,
  PASSWORD,
  PINNED_PROXY,
  type PostureDeployment,
  postBody,
  request,
  startPostureDeployment,
} from '../test-support/posture-deployment.js';

const baseUrl = process.env.DATABASE_URL;
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (dbRequired && !baseUrl) {
  throw new Error('hosting-checks: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS)');
}
if (dbRequired && !existsSync(CLI_DIST)) {
  throw new Error(`hosting-checks: the built CLI is required at ${CLI_DIST}; run pnpm build`);
}

const ARMS = 8;
let armsRan = 0;

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!baseUrl)('the mandatory public-hosting checks, in the hardened posture', () => {
  let d: PostureDeployment;
  let orgId = '';
  let ownerToken = '';
  let memberToken = '';
  let memberUserId = '';

  beforeAll(async () => {
    d = await startPostureDeployment(baseUrl as string, `rayspec_cert_checks_${process.pid}`, {
      env: {
        // One durable run at a time, ended at 4 s: a held provider call frees its slot quickly.
        RAYSPEC_AGENT_WORKER_CONCURRENCY: '1',
        RAYSPEC_AGENT_RUN_MAX_MS: '4000',
        RAYSPEC_AGENT_KILL_GRACE_MS: '200',
      },
    });
  }, 600_000);

  afterAll(async () => {
    await d?.dispose();
    removeTemporaryDirectories();
    if (dbRequired) expect(armsRan).toBe(ARMS);
  }, 120_000);

  it('serves as the ordinary runtime role under forced row-level security, in single-tenant mode and the managed posture', async () => {
    // Every session the served process holds on its application database is the runtime role.
    const sessions = await d.admin(
      (sql) =>
        sql.unsafe(
          `SELECT DISTINCT usename FROM pg_stat_activity
            WHERE datname = current_database() AND pid <> pg_backend_pid() AND usename IS NOT NULL`,
        ) as unknown as Promise<{ usename: string }[]>,
    );
    const runtimeRole = decodeURIComponent(new URL(d.roles.app.runtime).username);
    expect(sessions.map((s) => s.usename)).toEqual([runtimeRole]);
    const [attrs] = await d.admin(
      (sql) =>
        sql.unsafe(
          `SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = $1`,
          [runtimeRole],
        ) as unknown as Promise<Record<string, boolean>[]>,
    );
    expect(attrs).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcreaterole: false,
      rolcreatedb: false,
    });
    // The application's store and the tenant tables have their row policy enabled and forced.
    const [store] = await d.admin(
      (sql) =>
        sql.unsafe(
          `SELECT c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) AS owner
             FROM pg_class c WHERE c.relname = 'posture_notes'`,
        ) as unknown as Promise<
          { relrowsecurity: boolean; relforcerowsecurity: boolean; owner: string }[]
        >,
    );
    expect(store).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    expect(store?.owner).not.toBe(runtimeRole);
    // The managed posture does not register the public recovery probe.
    expect((await request(d.base, '/recovery-scope')).status).toBe(404);
    // Single-tenant mode: the first registration creates the one organization.
    const owner = await request(d.base, '/v1/auth/register', {
      body: { email: 'owner@posture.example', password: PASSWORD, orgName: 'Posture' },
    });
    expect(owner.status, owner.text).toBe(201);
    orgId = owner.body.activeOrgId as string;
    ownerToken = owner.body.accessToken as string;
    const second = await request(d.base, '/v1/auth/register', {
      body: { email: 'second@posture.example', password: PASSWORD, orgName: 'Second' },
    });
    expect(second.status).toBe(403);
    const [orgs] = await d.admin(
      (sql) =>
        sql.unsafe('SELECT count(*)::int AS n FROM orgs') as unknown as Promise<{ n: number }[]>,
    );
    expect(orgs?.n).toBe(1);
    // The deploy was started with the migration and snapshot connections (role separation is what
    // forced the row policy above), yet application code reads neither: not when its module was
    // imported, not while it serves. It does see the environment it was started with otherwise.
    const environment = await request(d.base, '/environment', { token: ownerToken });
    expect(environment.status, environment.text).toBe(200);
    expect(environment.body).toEqual({ atImport: [], atRequest: [], database: true });
    armsRan += 1;
  });

  it('authorizes every object route for a member and refuses a removed member on every write, upload part, playback stream and background job', async () => {
    const issued = await request(d.base, `/v1/orgs/${orgId}/invites`, {
      token: ownerToken,
      body: { email: 'member@posture.example', role: 'member' },
    });
    expect(issued.status, issued.text).toBe(201);
    const accepted = await request(d.base, '/v1/invites/accept', {
      body: { token: issued.body.inviteToken, password: PASSWORD },
    });
    expect(accepted.status, accepted.text).toBe(201);
    memberToken = accepted.body.accessToken as string;
    const [member] = await d.admin(
      (sql) =>
        sql.unsafe(
          "SELECT id FROM users WHERE email = 'member@posture.example'",
        ) as unknown as Promise<{ id: string }[]>,
    );
    memberUserId = member?.id as string;

    // The member works with the organization's objects: every store operation, an upload part, a
    // playback token and its stream, an event.
    const created = await request(d.base, '/notes', { token: memberToken, body: { body: 'one' } });
    expect(created.status, created.text).toBe(201);
    const noteId = created.body.id as string;
    expect((await request(d.base, '/notes', { token: memberToken })).status).toBe(200);
    expect((await request(d.base, `/notes/${noteId}`, { token: memberToken })).status).toBe(200);
    const updated = await request(d.base, `/notes/${noteId}`, {
      method: 'PATCH',
      token: memberToken,
      body: { body: 'one, edited' },
    });
    expect(updated.status, updated.text).toBe(200);
    const upload = await request(d.base, '/uploads/part-1', {
      token: memberToken,
      raw: new Uint8Array([1, 2, 3]),
    });
    expect(upload.status, upload.text).toBe(200);
    // The handler is handed no credential of the caller.
    expect(upload.body.headers).not.toContain('authorization');
    expect(upload.body.headers).not.toContain('cookie');
    const minted = await request(d.base, '/media/m1/token', { token: memberToken, body: {} });
    expect(minted.status, minted.text).toBe(200);
    const playback = `/media/m1?token=${encodeURIComponent(minted.body.token as string)}`;
    expect((await request(d.base, playback)).status).toBe(200);
    // Nothing is reached without a credential.
    for (const [method, path] of [
      ['GET', '/notes'],
      ['POST', '/notes'],
      ['GET', `/notes/${noteId}`],
      ['POST', '/uploads/anonymous'],
      ['POST', '/media/m1/token'],
      ['GET', '/media/m1'],
      ['GET', '/v1/subscribe?topics=posture.announced'],
      ['POST', '/v1/agents/echo/runs'],
    ] as const) {
      const res = await request(d.base, path, {
        method,
        ...(method === 'POST' ? { body: {} } : {}),
      });
      expect([401, 403], `${method} ${path}`).toContain(res.status);
    }

    // The owner keeps the one worker slot busy with a run the provider never answers; the member's
    // run waits on the queue behind it.
    d.provider.mode = 'hold';
    const held = await request(d.base, '/v1/agents/echo/runs', {
      token: ownerToken,
      body: { input: 'owner holds the slot', async: true },
    });
    expect(held.status, held.text).toBe(202);
    const deadline = Date.now() + 30_000;
    while (d.provider.sawText('owner holds the slot') === 0) {
      if (Date.now() > deadline)
        throw new Error(`the owner's run never reached the provider\n${d.output()}`);
      await pause(100);
    }
    const queued = await request(d.base, '/v1/agents/echo/runs', {
      token: memberToken,
      body: { input: 'member job behind the slot', async: true },
    });
    expect(queued.status, queued.text).toBe(202);
    const memberRunId = queued.body.runId as string;

    // The owner removes the member while the job waits.
    const removed = await request(d.base, `/v1/orgs/${orgId}/members/${memberUserId}`, {
      method: 'DELETE',
      token: ownerToken,
    });
    expect(removed.status, removed.text).toBe(204);

    // The member's token has not expired, but every write, upload part, run start and the playback
    // token minted before the removal are refused now.
    expect(
      (await request(d.base, '/notes', { token: memberToken, body: { body: 'late' } })).status,
    ).toBe(403);
    expect(
      (
        await request(d.base, `/notes/${noteId}`, {
          method: 'PATCH',
          token: memberToken,
          body: { body: 'x' },
        })
      ).status,
    ).toBe(403);
    expect(
      (await request(d.base, `/notes/${noteId}`, { method: 'DELETE', token: memberToken })).status,
    ).toBe(403);
    expect(
      (await request(d.base, '/uploads/part-2', { token: memberToken, raw: new Uint8Array([4]) }))
        .status,
    ).toBe(403);
    expect(
      (
        await request(d.base, '/v1/agents/echo/runs', {
          token: memberToken,
          body: { input: 'again', async: true },
        })
      ).status,
    ).toBe(403);
    expect((await request(d.base, playback)).status).toBe(401);
    expect(existsSync(join(d.blobRoot))).toBe(true);

    // The background job: when the slot frees (the owner's run reaches its wall time) the worker
    // checks the member again and ends the run without calling the provider.
    const runDeadline = Date.now() + 60_000;
    let run = await request(d.base, `/v1/runs/${memberRunId}`, { token: ownerToken });
    while (run.body.status !== 'error' && run.body.status !== 'completed') {
      if (Date.now() > runDeadline) throw new Error(`the member's run never ended\n${d.output()}`);
      await pause(250);
      run = await request(d.base, `/v1/runs/${memberRunId}`, { token: ownerToken });
    }
    expect(run.body).toMatchObject({ status: 'error', errorClass: 'cancelled' });
    expect(d.provider.sawText('member job behind the slot')).toBe(0);
    armsRan += 1;
  }, 180_000);

  it('allows only the configured browser origin, and refuses a cross-site request where a cookie authenticates', async () => {
    const preflight = (origin: string) =>
      fetch(`${d.base}/v1/auth/refresh`, {
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': 'POST' },
      });
    const allowed = await preflight(ALLOWED_ORIGIN);
    expect(allowed.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    const evil = await preflight('https://evil.example.test');
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();

    // A cookie-authenticated refresh: the session cookie a login sets.
    const login = await fetch(`${d.base}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN },
      body: JSON.stringify({ email: 'owner@posture.example', password: PASSWORD }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers
      .getSetCookie()
      .find((c) => c.startsWith('__Host-rayspec_refresh='))
      ?.split(';')[0];
    expect(cookie, 'the login set no session cookie').toBeDefined();
    const refresh = (headers: Record<string, string>) =>
      fetch(`${d.base}/v1/auth/refresh`, {
        method: 'POST',
        headers: { cookie: cookie as string, ...headers },
      });
    expect((await refresh({ origin: 'https://evil.example.test' })).status).toBe(403);
    expect((await refresh({ 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    const same = await refresh({ origin: ALLOWED_ORIGIN, 'sec-fetch-site': 'same-site' });
    expect(same.status, await same.clone().text()).toBe(200);
    armsRan += 1;
  });

  it('bounds request bodies and keeps an upload inside the organization’s own blob space', async () => {
    const big = Buffer.from(JSON.stringify({ body: 'x'.repeat(1024 * 1024 + 16) }));
    const tooBig = await postBody(d.base, '/notes', big, {
      authorization: `Bearer ${ownerToken}`,
      'content-type': 'application/json',
    });
    expect(tooBig.status, tooBig.text).toBe(413);
    expect((JSON.parse(tooBig.text) as { error: { code: string } }).error.code).toBe(
      'PAYLOAD_TOO_LARGE',
    );
    const [notes] = await d.admin(
      (sql) =>
        sql.unsafe(
          'SELECT count(*)::int AS n FROM posture_notes WHERE length(body) > 1000',
        ) as unknown as Promise<{ n: number }[]>,
    );
    expect(notes?.n).toBe(0);
    // An upload key that tries to climb out of the organization's blob space.
    const before = readdirSync(d.blobRoot);
    for (const key of ['..%2F..%2Fescaped', '%2E%2E%2Fescaped', 'a%2F..%2F..%2Fescaped']) {
      const res = await request(d.base, `/uploads/${key}`, {
        token: ownerToken,
        raw: new Uint8Array([9]),
      });
      expect(res.status, `${key}: ${res.text}`).toBeGreaterThanOrEqual(400);
    }
    expect(readdirSync(d.blobRoot)).toEqual(before);
    expect(existsSync(join(d.blobRoot, '..', 'escaped'))).toBe(false);
    expect(existsSync(join(d.deployDir, 'escaped'))).toBe(false);
    armsRan += 1;
  });

  it('answers every error with a sanitized envelope that carries no internal detail', async () => {
    const cases = [
      await request(d.base, '/boom', { token: ownerToken, body: {} }),
      await request(d.base, '/notes', {
        token: ownerToken,
        raw: '{"body": ',
        headers: { 'content-type': 'application/json' },
      }),
      await request(d.base, '/notes/not-a-uuid', { token: ownerToken }),
      await request(d.base, '/no-such-route', { token: ownerToken }),
      await request(d.base, '/notes', { token: 'not.a.token' }),
    ];
    expect(cases.map((c) => c.status)).toEqual([500, 400, expect.any(Number), 404, 401]);
    expect(cases[0]?.body.error?.message).toBe('Internal server error.');
    for (const c of cases) {
      expect(c.text).not.toContain('hunter2');
      expect(c.text).not.toContain('10.0.0.5');
      expect(c.text).not.toMatch(/at .*\.(js|ts):\d+/);
      expect(c.text).not.toMatch(/postgres|SQL|relation|syntax error at/i);
      if (c.text !== '') expect(c.body.error?.code, c.text).toEqual(expect.any(String));
    }
    // The detail went to the server log, redacted.
    expect(d.output()).not.toContain('hunter2');
    expect(INTERNAL_DETAIL).toContain('hunter2');
    armsRan += 1;
  });

  it('streams events only with a valid token of the organization; a removed member keeps read access until the token expires, as documented', async () => {
    const res = await fetch(`${d.base}/v1/subscribe?topics=posture.announced`, {
      headers: { authorization: `Bearer ${ownerToken}`, accept: 'text/event-stream' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    await res.body?.cancel();
    for (const token of ['not.a.token', `${ownerToken.slice(0, -4)}AAAA`]) {
      const refused = await fetch(`${d.base}/v1/subscribe?topics=posture.announced`, {
        headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
      });
      expect(refused.status).toBe(401);
      await refused.body?.cancel();
    }
    // The accepted limit (docs/hardened-posture.md): a read trusts the role in the access token for
    // that token's lifetime, so the removed member's unexpired token still reads the stream, and the
    // stream closes at that lifetime so the reconnect is checked again.
    const removed = await fetch(`${d.base}/v1/subscribe?topics=posture.announced`, {
      headers: { authorization: `Bearer ${memberToken}`, accept: 'text/event-stream' },
    });
    expect(removed.status).toBe(200);
    await removed.body?.cancel();
    armsRan += 1;
  });

  it('serves no export download: the snapshot is written by the operator’s CLI, never over HTTP', async () => {
    for (const path of ['/v1/export', '/v1/exports', '/export', '/v1/snapshot', '/v1/snapshots']) {
      expect((await request(d.base, path, { token: ownerToken })).status, path).toBe(404);
    }
    armsRan += 1;
  });

  it('believes forwarding headers only from the pinned proxy address', async () => {
    // The client is 127.0.0.1, which is not the pinned proxy: a forwarded-for header it sends is not
    // believed, so the address the audit records is the socket peer's.
    const email = 'proxy@posture.example';
    const login = await request(d.base, '/v1/auth/login', {
      body: { email: 'owner@posture.example', password: PASSWORD },
      headers: { 'x-forwarded-for': '203.0.113.77', forwarded: 'for=203.0.113.77' },
    });
    expect(login.status, login.text).toBe(200);
    const hashOf = (ip: string) => createHash('sha256').update(ip).digest('hex');
    const rows = await d.admin(
      (sql) =>
        sql.unsafe(
          "SELECT ip_hash FROM auth_audit WHERE event = 'login' ORDER BY id DESC LIMIT 1",
        ) as unknown as Promise<{ ip_hash: string | null }[]>,
    );
    expect(rows[0]?.ip_hash).toBe(hashOf('127.0.0.1'));
    expect(rows[0]?.ip_hash).not.toBe(hashOf('203.0.113.77'));
    expect(PINNED_PROXY).not.toBe('127.0.0.1');
    // The rate limit is the socket peer's too: changing the header buys no fresh budget.
    let limited = 0;
    for (let i = 0; i < 30 && limited === 0; i++) {
      const res = await request(d.base, '/v1/auth/login', {
        body: { email, password: 'wrong-password-every-time' },
        headers: { 'x-forwarded-for': `198.51.100.${i + 1}` },
      });
      if (res.status === 429) limited = i + 1;
    }
    expect(limited, 'the login budget was never exhausted').toBeGreaterThan(0);
    // The application port listens on loopback only (no direct bypass of the proxy from outside).
    expect(d.output()).toMatch(/127\.0\.0\.1:\d+/);
    armsRan += 1;
  });
});
