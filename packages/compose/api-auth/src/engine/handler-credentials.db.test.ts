/**
 * What custom handler code is handed, and what it can leak — through the real createAuthApp chain,
 * DB-backed:
 *
 *  - in the hardened posture, a stream INGEST handler that reads every request header sees no
 *    `authorization`, no `cookie` and no `proxy-authorization`, while the body, the content headers
 *    and a custom header still arrive, and a stream PLAYBACK handler sees neither the `?token=` media
 *    token in the URL nor in its params;
 *  - outside it, both see the request as the caller sent it, as before;
 *  - a `{handler}` route sees only its allowlisted headers;
 *  - a playback token stops working the moment its member is removed, not at its expiry;
 *  - a handler (JSON or stream) that throws with internal detail in its message answers the bare
 *    500 envelope, with none of that detail.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RouteHandlerInit, StreamRouteHandlerInit } from '@rayspec/handler-sdk';
import { makeFsBlobStoreFactory, type ResolvedHandler } from '@rayspec/platform';
import { parseSpec } from '@rayspec/spec';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAuthApp } from '../app.js';
import { createMediaTokenService } from '../media/media-token.js';
import { createHarness, type Harness, jsonRequest } from '../test-support/harness.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (requireDb && !hasDb) {
  throw new Error(
    'handler-credentials.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent.',
  );
}

const SPEC_YAML = `
version: '1.0'
metadata:
  name: handler-credentials
  description: handlers that try to read what the caller authenticated with
stores:
  - name: notes
    columns:
      - { name: body, type: text }
handlers:
  - { id: echo_ingest, module: handlers/echo.ts, export: echoIngest, kind: route }
  - { id: echo_playback, module: handlers/echo.ts, export: echoPlayback, kind: route }
  - { id: echo_json, module: handlers/echo.ts, export: echoJson, kind: route }
  - { id: mint, module: handlers/echo.ts, export: mint, kind: route }
  - { id: boom, module: handlers/echo.ts, export: boom, kind: route }
  - { id: boom_stream, module: handlers/echo.ts, export: boomStream, kind: route }
api:
  - { method: POST, path: '/echo/{id}', action: { kind: stream, handler: echo_ingest, mode: ingest } }
  - { method: GET, path: '/echo/{id}/playback', action: { kind: stream, handler: echo_playback, mode: playback } }
  - { method: POST, path: '/echo-json', action: { kind: handler, handler: echo_json } }
  - { method: POST, path: '/echo/{id}/token', action: { kind: handler, handler: mint } }
  - { method: POST, path: '/boom', action: { kind: handler, handler: boom } }
  - { method: POST, path: '/boom-stream', action: { kind: stream, handler: boom_stream, mode: ingest } }
`;

/** Internal detail a careless handler puts in an error message. */
const INTERNAL = 'connect to postgres://svc:hunter2@10.0.0.5:5432/app failed';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

const HANDLERS: ReadonlyMap<string, ResolvedHandler> = new Map<string, ResolvedHandler>([
  [
    'echo_ingest',
    {
      kind: 'route',
      fn: (async (init: StreamRouteHandlerInit) =>
        json({
          headers: Object.fromEntries(init.request.headers.entries()),
          url: init.request.url,
          body: await init.request.text(),
          principalKind: init.principal?.kind ?? null,
        })) as never,
    },
  ],
  [
    'echo_playback',
    {
      kind: 'route',
      fn: (async (init: StreamRouteHandlerInit) =>
        json({
          url: init.request.url,
          params: init.params,
          headers: Object.fromEntries(init.request.headers.entries()),
          resource: init.mediaResource ?? null,
        })) as never,
    },
  ],
  [
    'echo_json',
    {
      kind: 'route',
      fn: async (init: RouteHandlerInit) => ({ headers: init.headers ?? {} }),
    },
  ],
  [
    'mint',
    {
      kind: 'route',
      fn: async (init: RouteHandlerInit) => {
        if (!init.mintPlayToken) throw new Error('no mint capability');
        return {
          token: await init.mintPlayToken({ resource: `res-${init.params.id}`, ttlSeconds: 3600 }),
        };
      },
    },
  ],
  [
    'boom',
    {
      kind: 'route',
      fn: async () => {
        throw new Error(INTERNAL);
      },
    },
  ],
  [
    'boom_stream',
    {
      kind: 'route',
      fn: (async () => {
        throw new Error(INTERNAL);
      }) as never,
    },
  ],
]);

describe.skipIf(!hasDb)('what handler code is handed', () => {
  let h: Harness;
  let blobDir: string;

  beforeAll(async () => {
    const parsed = parseSpec(SPEC_YAML);
    if (!parsed.ok) throw new Error(`fixture spec invalid: ${JSON.stringify(parsed.errors)}`);
    blobDir = mkdtempSync(join(tmpdir(), 'rayspec-handler-credentials-'));
    h = await createHarness({
      engineSpec: parsed.value,
      engineHandlers: HANDLERS,
      blobFactory: makeFsBlobStoreFactory(blobDir),
      mediaTokenService: createMediaTokenService('media-secret-at-least-32-bytes-xxxxxxxx'),
      schema: 'rayspec_test_handler_credentials',
      stripHandlerCredentials: true,
    });
  });
  beforeEach(async () => {
    await h.reset();
  });
  afterAll(async () => {
    await h.close();
    rmSync(blobDir, { recursive: true, force: true });
  });

  /** Owner of a fresh org: register with the org, switch into it, return the scoped token. */
  async function owner(email: string): Promise<{ orgId: string; token: string }> {
    const reg = await jsonRequest(h.app, 'POST', '/v1/auth/register', {
      body: { email, password: 'a-long-enough-password', orgName: `Org ${email}` },
    });
    expect(reg.status).toBe(201);
    const { accessToken, activeOrgId } = (await reg.json()) as {
      accessToken: string;
      activeOrgId: string;
    };
    const sw = await jsonRequest(h.app, 'POST', `/v1/orgs/${activeOrgId}/switch`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    return {
      orgId: activeOrgId,
      token: ((await sw.json()) as { accessToken: string }).accessToken,
    };
  }

  /** A member of `orgId` by invite; returns its user id and org-scoped token. */
  async function member(
    orgId: string,
    ownerToken: string,
    email: string,
  ): Promise<{ userId: string; token: string }> {
    const issued = await jsonRequest(h.app, 'POST', `/v1/orgs/${orgId}/invites`, {
      body: { email, role: 'member' },
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(issued.status).toBe(201);
    const token = ((await issued.json()) as { inviteToken: string }).inviteToken;
    const accepted = await jsonRequest(h.app, 'POST', '/v1/invites/accept', {
      body: { token, password: 'a-long-enough-password' },
    });
    expect(accepted.status).toBe(201);
    const body = (await accepted.json()) as { accessToken: string; userId: string };
    return { userId: body.userId, token: body.accessToken };
  }

  it('a stream ingest handler sees no credential header, and keeps the body and its own headers', async () => {
    const { token } = await owner('ingest@example.com');
    const res = await h.app.request('/echo/one?note=kept', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        cookie: '__Host-rayspec_rt=refresh-secret; theme=dark',
        'proxy-authorization': 'Basic cHJveHk6c2VjcmV0',
        'content-type': 'application/octet-stream',
        'x-upload-name': 'take-1.wav',
      },
      body: 'raw-bytes',
    });
    expect(res.status).toBe(200);
    const seen = (await res.json()) as {
      headers: Record<string, string>;
      url: string;
      body: string;
      principalKind: string | null;
    };
    expect(Object.keys(seen.headers)).not.toContain('authorization');
    expect(Object.keys(seen.headers)).not.toContain('cookie');
    expect(Object.keys(seen.headers)).not.toContain('proxy-authorization');
    expect(JSON.stringify(seen)).not.toContain(token);
    expect(JSON.stringify(seen)).not.toContain('refresh-secret');
    expect(seen.headers['content-type']).toBe('application/octet-stream');
    expect(seen.headers['x-upload-name']).toBe('take-1.wav');
    expect(seen.body).toBe('raw-bytes');
    expect(new URL(seen.url).searchParams.get('note')).toBe('kept');
    // Who called is still known — through the sanitized principal, not the credential.
    expect(seen.principalKind).toBe('user');
  });

  it('a stream playback handler sees neither the media token in its URL nor in its params', async () => {
    const { token } = await owner('playback@example.com');
    const minted = await jsonRequest(h.app, 'POST', '/echo/p1/token', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(minted.status).toBe(200);
    const playToken = ((await minted.json()) as { token: string }).token;
    const res = await h.app.request(
      `/echo/p1/playback?token=${encodeURIComponent(playToken)}&variant=hi`,
      { headers: { cookie: '__Host-rayspec_rt=refresh-secret', range: 'bytes=0-9' } },
    );
    expect(res.status).toBe(200);
    const seen = (await res.json()) as {
      url: string;
      params: Record<string, string>;
      headers: Record<string, string>;
      resource: string | null;
    };
    expect(JSON.stringify(seen)).not.toContain(playToken);
    expect(new URL(seen.url).searchParams.has('token')).toBe(false);
    expect(new URL(seen.url).searchParams.get('variant')).toBe('hi');
    expect(seen.params).toEqual({ id: 'p1', variant: 'hi' });
    expect(Object.keys(seen.headers)).not.toContain('cookie');
    expect(seen.headers.range).toBe('bytes=0-9');
    expect(seen.resource).toBe('res-p1');
  });

  it('outside the hardened posture a stream handler sees the request as the caller sent it', async () => {
    const asBefore = createAuthApp({ ...h.deps, stripHandlerCredentials: false });
    const { token } = await owner('as-before@example.com');
    const ingest = await asBefore.request('/echo/one', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        cookie: 'theme=dark',
        'content-type': 'application/octet-stream',
      },
      body: 'raw-bytes',
    });
    expect(ingest.status).toBe(200);
    const seenIngest = (await ingest.json()) as { headers: Record<string, string> };
    expect(seenIngest.headers.authorization).toBe(`Bearer ${token}`);
    expect(seenIngest.headers.cookie).toBe('theme=dark');

    const minted = await jsonRequest(asBefore, 'POST', '/echo/p1/token', {
      headers: { authorization: `Bearer ${token}` },
    });
    const playToken = ((await minted.json()) as { token: string }).token;
    const playback = await asBefore.request(
      `/echo/p1/playback?token=${encodeURIComponent(playToken)}`,
    );
    expect(playback.status).toBe(200);
    const seenPlayback = (await playback.json()) as { url: string; params: Record<string, string> };
    expect(new URL(seenPlayback.url).searchParams.get('token')).toBe(playToken);
    expect(seenPlayback.params.token).toBe(playToken);
  });

  it('a {handler} route sees only its allowlisted headers', async () => {
    const { token } = await owner('json@example.com');
    const res = await jsonRequest(h.app, 'POST', '/echo-json', {
      body: {},
      headers: { authorization: `Bearer ${token}`, cookie: 'a=b', accept: 'application/json' },
    });
    expect(res.status).toBe(200);
    const seen = (await res.json()) as { headers: Record<string, string> };
    expect(Object.keys(seen.headers).sort()).toEqual(['accept', 'content-type']);
  });

  it('a playback token stops working as soon as its member is removed', async () => {
    const o = await owner('owner-revoke@example.com');
    const m = await member(o.orgId, o.token, 'member-revoke@example.com');
    const minted = await jsonRequest(h.app, 'POST', '/echo/r1/token', {
      headers: { authorization: `Bearer ${m.token}` },
    });
    expect(minted.status).toBe(200);
    const playToken = ((await minted.json()) as { token: string }).token;
    const url = `/echo/r1/playback?token=${encodeURIComponent(playToken)}`;
    expect((await h.app.request(url)).status).toBe(200);

    const removed = await jsonRequest(h.app, 'DELETE', `/v1/orgs/${o.orgId}/members/${m.userId}`, {
      headers: { authorization: `Bearer ${o.token}` },
    });
    expect(removed.status).toBe(204);
    // The token is still within its hour; the membership is what it no longer has.
    const after = await h.app.request(url);
    expect(after.status).toBe(401);
    expect(((await after.json()) as { error: { code: string } }).error.code).toBe(
      'UNAUTHENTICATED',
    );
  });

  it('a handler that throws with internal detail answers the bare 500 envelope', async () => {
    const { token } = await owner('boom@example.com');
    for (const [path, init] of [
      ['/boom', { method: 'POST', headers: { authorization: `Bearer ${token}` } }],
      [
        '/boom-stream',
        {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
          body: 'x',
        },
      ],
    ] as const) {
      const res = await h.app.request(path, init);
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).not.toContain('postgres');
      expect(text).not.toContain('hunter2');
      expect(text).not.toContain('10.0.0.5');
      const body = JSON.parse(text) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('INTERNAL');
      expect(body.error.message).toBe('Internal server error.');
    }
  });
});
