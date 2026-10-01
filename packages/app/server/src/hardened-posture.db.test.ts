/**
 * The hardened hosting posture, end to end: the real composition root booted with role separation
 * (RAYSPEC_MIGRATION_DATABASE_URL, serving as the runtime role under row security) and single-tenant
 * mode (RAYSPEC_SINGLE_TENANT=true), listening on a real port and driven over real HTTP.
 *
 *   1. Single tenant: the first registration creates the one organization; every other registration,
 *      and a second organization, is refused; an invite still brings a member in. Provisioning a
 *      second organization is refused too, and a boot of a database holding two is refused.
 *   2. Two users in one tenant with different roles: the member reads and writes the tenant's data
 *      but cannot mint keys, invite or remove members; the owner can.
 *   3. A handler that reads every request header sees no credential; a handler that throws with
 *      internal detail, and a streamed run that throws, answer without it.
 *   4. A revoked member's queued job: the member enqueues an agent run while the worker is busy, is
 *      removed, and the run is refused when the worker reaches it — the backend never sees it —
 *      while the owner's queued runs complete. The member's still-valid token can no longer start a
 *      run or write, and the playback token minted before the removal stops working.
 *
 * The durable worker launches DBOS (a process-global singleton), so this file boots one worker.
 * Skips without DATABASE_URL; hard-fails when the DB is required (CI / RAYSPEC_REQUIRE_DB_TESTS).
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerType, serve } from '@hono/node-server';
import type { AgentSpec, Backend, BackendId, RunContext, RunResult } from '@rayspec/core';
import {
  createIsolatedTestDatabase,
  type IsolatedTestDatabase,
  registerScopedTables,
} from '@rayspec/db/testing';
import { runNotAuthorizedMessage } from '@rayspec/durable-dbos';
import { typeStrippingImporter } from '@rayspec/platform';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assembleServer,
  BootConfigError,
  type BootedServer,
  loadServerConfig,
} from './composition-root.js';
import { createRuntimeControl } from './runtime-control.js';
import { provisionTenant, TenantProvisionError } from './tenant-provision.js';

const baseUrl = process.env.DATABASE_URL;
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (requireDb && !baseUrl) {
  throw new Error(
    'hardened-posture.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent ' +
      '— refusing to silently skip the hardened-posture proofs.',
  );
}

/** Internal detail a careless handler or a failing dependency puts in an error message. */
const INTERNAL = 'connect to postgres://svc:hunter2@10.0.0.5:5432/app failed';

const HANDLERS_TS = `
export const echoIngest = async (init) =>
  new Response(
    JSON.stringify({
      headers: Object.fromEntries(init.request.headers.entries()),
      body: await init.request.text(),
    }),
    { headers: { 'content-type': 'application/json' } },
  );
export const mint = async (init) => ({
  token: await init.mintPlayToken({ resource: 'res-' + init.params.id, ttlSeconds: 3600 }),
});
export const echoPlayback = async (init) =>
  new Response(JSON.stringify({ url: init.request.url, resource: init.mediaResource ?? null }), {
    headers: { 'content-type': 'application/json' },
  });
export const boom = async () => {
  throw new Error(${JSON.stringify(INTERNAL)});
};
`;

const SPEC_WORKER = `
version: '1.0'
metadata:
  name: hardened-posture
  description: a backend served under role separation and single-tenant mode
deployment:
  durableWorker: true
stores:
  - name: notes
    columns:
      - { name: body, type: text }
handlers:
  - { id: echo_ingest, module: handlers/h.ts, export: echoIngest, kind: route, uses: [blob] }
  - { id: mint, module: handlers/h.ts, export: mint, kind: route, uses: [mintPlayToken] }
  - { id: echo_playback, module: handlers/h.ts, export: echoPlayback, kind: route, uses: [blob] }
  - { id: boom, module: handlers/h.ts, export: boom, kind: route, uses: [] }
api:
  - { method: GET, path: '/notes', action: { kind: store, store: notes, op: list } }
  - { method: POST, path: '/notes', action: { kind: store, store: notes, op: create } }
  - { method: POST, path: '/echo/{id}', action: { kind: stream, handler: echo_ingest, mode: ingest } }
  - { method: POST, path: '/echo/{id}/token', action: { kind: handler, handler: mint } }
  - { method: GET, path: '/echo/{id}/playback', action: { kind: stream, handler: echo_playback, mode: playback } }
  - { method: POST, path: '/boom', action: { kind: handler, handler: boom } }
agents:
  - id: echo
    name: echo-agent
    backend: openai
    model: gpt-4o-mini
    instructions: Echo the input back.
    maxTurns: 2
`;

/**
 * A network-free backend the test steers by input: `hold…` waits on a gate the test opens (so the
 * worker's four slots can be kept busy), `explode…` throws with internal detail, anything else echoes.
 * It records every input it was handed.
 */
class GatedBackend implements Backend {
  readonly id = 'openai' as const;
  readonly seen: string[] = [];
  inFlight = 0;
  #open!: () => void;
  readonly #gate = new Promise<void>((resolve) => {
    this.#open = resolve;
  });

  open(): void {
    this.#open();
  }

  async resolveAuth() {
    return 'api-key' as const;
  }

  async run(spec: AgentSpec, ctx: RunContext): Promise<RunResult> {
    this.seen.push(spec.input);
    if (spec.input.startsWith('explode')) throw new Error(INTERNAL);
    if (spec.input.startsWith('hold')) {
      this.inFlight++;
      try {
        await this.#gate;
      } finally {
        this.inFlight--;
      }
    }
    const finalText = `echo: ${spec.input}`;
    await ctx.journal.record({
      type: 'llm',
      idempotencyKey: `llm:${spec.name}:0`,
      inputHash: `hash:${spec.input}`,
      output: { finalText },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      costUsd: 0,
      model: spec.model,
      producedBy: 'gated-backend',
      latencyMs: 1,
      status: 'ok',
      authMode: 'api-key',
    });
    return {
      runId: ctx.runId,
      backend: this.id,
      authMode: 'api-key',
      status: 'completed',
      finalText,
      output: null,
      error: null,
      errorClass: null,
      conversation: [],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      costUsd: 0,
      stepCount: 1,
    };
  }
}

const ENV_KEYS = [
  'RAYSPEC_JWT_SIGNING_KEY',
  'RAYSPEC_API_KEY_PEPPER',
  'DATABASE_URL',
  'RAYSPEC_MIGRATION_DATABASE_URL',
  'RAYSPEC_MIGRATION_DATABASE_URL_FILE',
  'DBOS_SYSTEM_DATABASE_URL',
  'ALLOWED_ORIGINS',
  'PORT',
  'RAYSPEC_SPEC_PATH',
  'RAYSPEC_HANDLER_ROOT',
  'RAYSPEC_SINGLE_TENANT',
  'RAYSPEC_BLOB_ROOT',
  'RAYSPEC_MEDIA_SIGNING_KEY',
  'RAYSPEC_HOSTING_POSTURE',
] as const;

const PASSWORD = 'correct-horse-battery-staple-9';

describe.skipIf(!baseUrl)('the hardened posture over real HTTP', () => {
  let iso: IsolatedTestDatabase;
  let admin: postgres.Sql;
  let server: BootedServer | undefined;
  let http: ServerType | undefined;
  let origin = '';
  let tmpDir = '';
  const backend = new GatedBackend();
  const savedEnv: Record<string, string | undefined> = {};

  // Filled in as the suite goes: the flows below build on one another.
  let orgId = '';
  let ownerToken = '';
  let memberToken = '';
  let memberUserId = '';

  function call(
    method: string,
    path: string,
    opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    return fetch(`${origin}${path}`, {
      method,
      headers: {
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(opts.headers ?? {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
  }

  async function runStatus(
    runId: string,
  ): Promise<{ status: string; errorClass: string | null; error: string | null }> {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const res = await call('GET', `/v1/runs/${runId}`, { token: ownerToken });
      if (res.status === 200) {
        const run = (await res.json()) as {
          status: string;
          errorClass: string | null;
          error: string | { message?: string } | null;
        };
        if (run.status === 'completed' || run.status === 'error') {
          const error = typeof run.error === 'string' ? run.error : (run.error?.message ?? null);
          return { status: run.status, errorClass: run.errorClass, error };
        }
      }
      if (Date.now() > deadline) throw new Error(`run ${runId} did not finish`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  async function waitFor(check: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  beforeAll(async () => {
    iso = await createIsolatedTestDatabase(baseUrl as string, { workflowSystem: true });
    admin = postgres(iso.urls.admin, { max: 1, onnotice: () => {} });
    tmpDir = mkdtempSync(join(tmpdir(), 'rayspec-hardened-'));
    mkdirSync(join(tmpDir, 'handlers'), { recursive: true });
    mkdirSync(join(tmpDir, 'blobs'), { recursive: true });
    writeFileSync(join(tmpDir, 'handlers', 'h.ts'), HANDLERS_TS, 'utf8');
    writeFileSync(join(tmpDir, 'rayspec.yaml'), SPEC_WORKER, 'utf8');
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    process.env.RAYSPEC_JWT_SIGNING_KEY = await exportPKCS8(privateKey);
    process.env.RAYSPEC_API_KEY_PEPPER = 'hardened-posture-pepper-only';
    process.env.DATABASE_URL = iso.urls.runtime;
    process.env.RAYSPEC_MIGRATION_DATABASE_URL = iso.urls.migration;
    process.env.DBOS_SYSTEM_DATABASE_URL = iso.workflowSystemUrls?.runtime;
    process.env.RAYSPEC_SINGLE_TENANT = 'true';
    process.env.RAYSPEC_HOSTING_POSTURE = 'managed';
    process.env.RAYSPEC_BLOB_ROOT = join(tmpDir, 'blobs');
    process.env.RAYSPEC_MEDIA_SIGNING_KEY = 'hardened-media-key-of-at-least-32-bytes';
    process.env.RAYSPEC_SPEC_PATH = join(tmpDir, 'rayspec.yaml');
    process.env.RAYSPEC_HANDLER_ROOT = tmpDir;
    process.env.PORT = '8807';
    delete process.env.ALLOWED_ORIGINS;
    delete process.env.RAYSPEC_MIGRATION_DATABASE_URL_FILE;

    server = await assembleServer(
      loadServerConfig(process.env, () => {}),
      {
        registerProductTables: (tables) => {
          registerScopedTables([...tables.values()]);
        },
        moduleImporter: typeStrippingImporter,
        bootWarn: () => {},
        agentBackendsFactory: (): ReadonlyMap<BackendId, Backend> =>
          new Map<BackendId, Backend>([['openai', backend]]),
      },
    );
    const booted = server;
    await new Promise<void>((resolve) => {
      http = serve({ fetch: booted.app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve());
    });
    origin = `http://127.0.0.1:${(http?.address() as AddressInfo).port}`;
  }, 180_000);

  afterAll(async () => {
    backend.open();
    await new Promise<void>((resolve) => (http ? http.close(() => resolve()) : resolve()));
    await server?.close();
    await admin?.end();
    await iso?.drop();
    for (const k of ENV_KEYS) {
      const v = savedEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  }, 120_000);

  it('boots in the hardened posture and reports it', () => {
    expect(server?.singleTenant).toBe(true);
    expect(server?.databaseIsolation).toMatchObject({ mode: 'role-separated', active: true });
    const report = createRuntimeControl({ db: {} as never, env: process.env }).inspectHosting();
    expect(report.applicationTenants).toEqual({ singleTenantMode: true, maxApplicationTenants: 1 });
  });

  it('single tenant: the first registration creates the organization, every other is refused', async () => {
    const first = await call('POST', '/v1/auth/register', {
      body: { email: 'owner@example.test', password: PASSWORD, orgName: 'The Tenant' },
    });
    expect(first.status).toBe(201);
    const reg = (await first.json()) as { accessToken: string; activeOrgId: string };
    orgId = reg.activeOrgId;
    const sw = await call('POST', `/v1/orgs/${orgId}/switch`, { token: reg.accessToken });
    ownerToken = ((await sw.json()) as { accessToken: string }).accessToken;

    for (const body of [
      { email: 'stranger@example.test', password: PASSWORD },
      { email: 'founder@example.test', password: PASSWORD, orgName: 'Another Tenant' },
    ]) {
      const res = await call('POST', '/v1/auth/register', { body });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
    }
    const second = await call('POST', '/v1/orgs', { token: ownerToken, body: { name: 'Second' } });
    expect(second.status).toBe(403);
    const orgs = await admin`SELECT count(*)::int AS n FROM orgs`;
    expect(orgs[0]?.n).toBe(1);
  });

  it('single tenant: an invite brings the member in', async () => {
    const issued = await call('POST', `/v1/orgs/${orgId}/invites`, {
      token: ownerToken,
      body: { email: 'member@example.test', role: 'member' },
    });
    expect(issued.status).toBe(201);
    const inviteToken = ((await issued.json()) as { inviteToken: string }).inviteToken;
    const accepted = await call('POST', '/v1/invites/accept', {
      body: { token: inviteToken, password: PASSWORD },
    });
    expect(accepted.status).toBe(201);
    const body = (await accepted.json()) as {
      accessToken: string;
      userId: string;
      activeOrgId: string;
    };
    expect(body.activeOrgId).toBe(orgId);
    memberToken = body.accessToken;
    memberUserId = body.userId;
  });

  it('two users in one tenant with different roles: the member works with data, only the owner administers', async () => {
    const note = await call('POST', '/notes', { token: memberToken, body: { body: 'by member' } });
    expect(note.status).toBe(201);
    const list = await call('GET', '/notes', { token: ownerToken });
    expect(list.status).toBe(200);
    expect(JSON.stringify(await list.json())).toContain('by member');

    const memberMint = await call('POST', `/v1/orgs/${orgId}/api-keys`, {
      token: memberToken,
      body: { scopes: ['store:read'] },
    });
    expect(memberMint.status).toBe(403);
    const memberInvite = await call('POST', `/v1/orgs/${orgId}/invites`, {
      token: memberToken,
      body: { email: 'friend@example.test', role: 'member' },
    });
    expect(memberInvite.status).toBe(403);
    const me = await call('GET', '/v1/auth/me', { token: ownerToken });
    const ownerId = ((await me.json()) as { userId: string }).userId;
    const memberRemovesOwner = await call('DELETE', `/v1/orgs/${orgId}/members/${ownerId}`, {
      token: memberToken,
    });
    expect(memberRemovesOwner.status).toBe(403);

    const ownerMint = await call('POST', `/v1/orgs/${orgId}/api-keys`, {
      token: ownerToken,
      body: { scopes: ['store:read'] },
    });
    expect(ownerMint.status).toBe(201);
  });

  it('a handler that reads every request header sees no credential', async () => {
    const withBody = await fetch(`${origin}/echo/one`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${memberToken}`,
        cookie: '__Host-rayspec_rt=refresh-secret',
        'content-type': 'application/octet-stream',
        'x-upload-name': 'take.wav',
      },
      body: 'raw-bytes',
    });
    expect(withBody.status).toBe(200);
    const seen = (await withBody.json()) as { headers: Record<string, string>; body: string };
    expect(Object.keys(seen.headers)).not.toContain('authorization');
    expect(Object.keys(seen.headers)).not.toContain('cookie');
    expect(JSON.stringify(seen)).not.toContain(memberToken);
    expect(JSON.stringify(seen)).not.toContain('refresh-secret');
    expect(seen.headers['x-upload-name']).toBe('take.wav');
    expect(seen.body).toBe('raw-bytes');
  });

  it('error envelopes from a handler and from a streamed run carry no internals', async () => {
    const boom = await call('POST', '/boom', { token: ownerToken, body: {} });
    expect(boom.status).toBe(500);
    const boomText = await boom.text();
    expect(boomText).not.toContain('hunter2');
    expect(JSON.parse(boomText).error).toMatchObject({
      code: 'INTERNAL',
      message: 'Internal server error.',
    });

    const streamed = await call('POST', '/v1/agents/echo/runs', {
      token: ownerToken,
      body: { input: 'explode now' },
      headers: { accept: 'text/event-stream' },
    });
    expect(streamed.status).toBe(200);
    const text = await streamed.text();
    expect(text).toContain('event: error');
    expect(text).toContain('The run failed.');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('postgres://');
  });

  it("a revoked member's queued job is refused when the worker reaches it", async () => {
    // A playback token minted while the member is a member.
    const minted = await call('POST', '/echo/p1/token', { token: memberToken, body: {} });
    expect(minted.status).toBe(200);
    const playUrl = `/echo/p1/playback?token=${encodeURIComponent(
      ((await minted.json()) as { token: string }).token,
    )}`;
    expect((await call('GET', playUrl)).status).toBe(200);

    // Keep the worker's four slots busy with the owner's runs.
    const held: string[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await call('POST', '/v1/agents/echo/runs', {
        token: ownerToken,
        body: { input: `hold ${i}`, async: true },
      });
      expect(res.status).toBe(202);
      held.push(((await res.json()) as { runId: string }).runId);
    }
    await waitFor(() => backend.inFlight === 4, 'the four held runs to start');

    // The member's run waits on the queue behind them.
    const queued = await call('POST', '/v1/agents/echo/runs', {
      token: memberToken,
      body: { input: 'member job', async: true },
    });
    expect(queued.status).toBe(202);
    const memberRunId = ((await queued.json()) as { runId: string }).runId;
    await new Promise((r) => setTimeout(r, 1_500));
    expect(backend.seen).not.toContain('member job');

    // The owner removes the member while the job waits.
    const removed = await call('DELETE', `/v1/orgs/${orgId}/members/${memberUserId}`, {
      token: ownerToken,
    });
    expect(removed.status).toBe(204);

    // Their token has not expired, but it can no longer start a run or write.
    const again = await call('POST', '/v1/agents/echo/runs', {
      token: memberToken,
      body: { input: 'member again', async: true },
    });
    expect(again.status).toBe(403);
    const write = await call('POST', '/notes', { token: memberToken, body: { body: 'late' } });
    expect(write.status).toBe(403);
    // And the playback token minted before the removal stops working now, not at its expiry.
    expect((await call('GET', playUrl)).status).toBe(401);

    backend.open();
    for (const runId of held) expect((await runStatus(runId)).status).toBe('completed');
    const refused = await runStatus(memberRunId);
    expect(refused).toEqual({
      status: 'error',
      errorClass: 'cancelled',
      error: runNotAuthorizedMessage(memberRunId),
    });
    // The backend was never handed the member's run.
    expect(backend.seen).not.toContain('member job');
  }, 120_000);

  it('provisioning a second organization is refused; resolving the one that exists is not', async () => {
    const secrets = {
      databaseUrl: iso.urls.runtime,
      migrationDatabaseUrl: iso.urls.migration,
      apiKeyPepper: 'hardened-posture-pepper-only',
      singleTenant: true,
    };
    const resolved = await provisionTenant(secrets, { orgId, name: 'The Tenant' });
    expect(resolved.org).toBe('existing');
    await expect(
      provisionTenant(secrets, { orgId: randomUUID(), name: 'Second Tenant' }),
    ).rejects.toMatchObject({ code: 'SINGLE_TENANT_LIMIT' });
    await expect(
      provisionTenant(secrets, { orgId: randomUUID(), name: 'Second Tenant' }),
    ).rejects.toBeInstanceOf(TenantProvisionError);
  }, 60_000);

  it('a single-tenant boot of a database holding two organizations is refused', async () => {
    await admin`INSERT INTO orgs (name, slug) VALUES ('Extra', 'extra-org')`;
    try {
      const env = { ...process.env };
      delete env.RAYSPEC_SPEC_PATH;
      await expect(assembleServer(loadServerConfig(env, () => {}))).rejects.toBeInstanceOf(
        BootConfigError,
      );
      await expect(assembleServer(loadServerConfig(env, () => {}))).rejects.toThrow(
        /holds 2 organizations/,
      );
    } finally {
      await admin`DELETE FROM orgs WHERE slug = 'extra-org'`;
    }
  }, 60_000);
});
