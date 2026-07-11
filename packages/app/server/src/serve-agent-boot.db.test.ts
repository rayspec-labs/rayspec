/**
 * The WIRED-BOOT-SEAM acceptance: a backend-profile spec WITH agents boots through the SHIPPED
 * entrypoint's seams — the product-table registrar + an env/injected agent backend — with NO
 * hand-written wrapper, and a request runs the agent → its persist tool → a persisted store row.
 *
 * This is the forcing function for the fix serve.ts makes: today the shipped `serve.ts` calls
 * `assembleServer(config)` with NO opts, so a spec that declares product stores aborts at deploy()'s
 * roll-out verify (deny-by-default — the registrar was never wired) and a spec with agents has no
 * backend instances. Feeding both seams (as serve.ts now does) makes the boot work end-to-end.
 *
 * Arms (the ran-guard pins the count):
 *   (a) the FROM-ENV factory: `agentBackendsFactoryFromEnv(<the fixture spec>, { OPENAI_API_KEY })`
 *       builds a REAL OpenAI adapter for the declared `openai` agent (the from-env path serve.ts uses);
 *   (b) boot: with the product-table registrar + an injected (fake, deterministic) backend map, the
 *       backend-profile spec MATERIALIZES (deployMode) and its store route + sync `{agent}` route mount
 *       — proving the registrar seam (else deploy() aborts fail-closed) AND the backend-map seam (else
 *       buildAgentRegistry aborts fail-closed at boot);
 *   (c) run: POST /notes/write drives the agent → persist_note tool → a `notes` row DERIVED from the
 *       run input (fail-the-fix: the fake parses the input and THROWS if it never reached the run, so a
 *       wiring regression goes RED here rather than persisting a canned row);
 *   (d) a SECOND, distinct write persists a SECOND distinct row (the persisted values track the input —
 *       not one hardcoded row).
 *
 * DETERMINISTIC BY DESIGN: no real LLM. Arm (a) builds the real adapter from a DUMMY key (construction
 * is inert — no network); arms (c)/(d) inject a fake `Backend` that dispatches the declared tool through
 * the UNCHANGED `ctx.dispatchTool` chokepoint. Skips without DATABASE_URL; the ran-guard hard-fails a
 * REQUIRED (CI / RAYSPEC_REQUIRE_DB_TESTS) run that silently skipped.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenAIAdapter } from '@rayspec/adapter-openai';
import type { AgentSpec, Backend, BackendId, RunContext, RunResult } from '@rayspec/core';
import { registerScopedTables } from '@rayspec/db/testing';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentBackendsFactoryFromEnv } from './agent-backends-from-env.js';
import { assembleServer, type BootedServer, loadServerConfig } from './composition-root.js';

const baseUrl = process.env.DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = resolve(here, '__fixtures__/agent-boot/agent-boot-notes.rayspec.yaml');
const SPEC_TEXT = readFileSync(SPEC_PATH, 'utf8');

const SUITE_DB = `rayspec_agent_boot_${process.pid}`;
const TENANT = '00000000-0000-4000-8000-00000000ab01';

const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
let e2eTestsRan = 0;

/**
 * The DETERMINISTIC fake backend (the platform ships none). It DERIVES the persisted note from the RUN
 * INPUT and dispatches the declared `persist_note` tool through the real `ctx.dispatchTool` chokepoint.
 * FAIL-THE-FIX: it JSON-parses `spec.input` (the request body input) and reads `title`/`body` — so if
 * the input never reached the run (a wiring regression), the parse/derivation throws and the run errors
 * instead of persisting a canned row.
 */
function fakeOpenAiBackend(): Backend {
  return {
    id: 'openai',
    resolveAuth: async () => 'api-key',
    run: async (spec: AgentSpec, ctx: RunContext): Promise<RunResult> => {
      const parsed = JSON.parse(spec.input) as { title?: unknown; body?: unknown };
      const title = String(parsed.title);
      const body = String(parsed.body);
      if (typeof parsed.title !== 'string' || typeof parsed.body !== 'string') {
        throw new Error(`run input did not carry the note fields: ${spec.input}`);
      }
      if (!ctx.dispatchTool)
        throw new Error('ctx.dispatchTool is not wired — the tools never reached');
      const res = await ctx.dispatchTool('persist_note', { title, body });
      if (res.kind !== 'tool_data') {
        throw new Error(`persist_note dispatch failed: ${JSON.stringify(res)}`);
      }
      const persistedId = (res.data as { id?: string }).id ?? '';
      return {
        runId: ctx.runId,
        backend: 'openai',
        authMode: ctx.authMode ?? 'api-key',
        status: 'completed',
        finalText: `persisted ${persistedId}`,
        output: null,
        error: null,
        errorClass: null,
        conversation: [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        costUsd: 0,
        stepCount: 1,
      };
    },
  };
}

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

describe.skipIf(!baseUrl)('serve agent-boot — wired seam boots a backend spec with agents', () => {
  let server: BootedServer | undefined;
  let appDbUrl = '';
  let tokenA = '';
  let unregisterTables: (() => void) | undefined;
  const saved: Record<string, string | undefined> = {};
  const ENV = [
    'RAYSPEC_JWT_SIGNING_KEY',
    'RAYSPEC_API_KEY_PEPPER',
    'DATABASE_URL',
    'ALLOWED_ORIGINS',
    'PORT',
    'RAYSPEC_SPEC_PATH',
  ] as const;

  beforeAll(async () => {
    if (!baseUrl) return;
    appDbUrl = withDbName(baseUrl, SUITE_DB);
    const admin = postgres(adminUrl(baseUrl), { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE "${SUITE_DB}"`);
    } finally {
      await admin.end();
    }

    for (const k of ENV) saved[k] = process.env[k];
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    process.env.RAYSPEC_JWT_SIGNING_KEY = await exportPKCS8(privateKey);
    process.env.RAYSPEC_API_KEY_PEPPER = 'agent-boot-pepper';
    process.env.DATABASE_URL = appDbUrl;
    delete process.env.ALLOWED_ORIGINS;
    process.env.PORT = '8811';
    process.env.RAYSPEC_SPEC_PATH = SPEC_PATH;

    const config = loadServerConfig();
    // The WIRED SEAM: both deployer seams fed (as serve.ts feeds them), but with an INJECTED fake
    // backend for determinism (arm (a) separately proves the from-env factory builds the real adapter).
    server = await assembleServer(config, {
      registerProductTables: (tables) => {
        unregisterTables = registerScopedTables([...tables.values()]);
      },
      agentBackendsFactory: () => new Map<BackendId, Backend>([['openai', fakeOpenAiBackend()]]),
    });

    const client = postgres(appDbUrl, { max: 2 });
    try {
      await client.unsafe(`INSERT INTO orgs (id, name, slug) VALUES ($1, 'BootA', 'boot-a')`, [
        TENANT,
      ]);
    } finally {
      await client.end();
    }
    tokenA = await tokenFor(TENANT);
  }, 120_000);

  afterAll(async () => {
    await server?.close();
    unregisterTables?.();
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    if (baseUrl) {
      const admin = postgres(adminUrl(baseUrl), { max: 1 });
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    }
  }, 60_000);

  async function tokenFor(tenant: string): Promise<string> {
    const email = `boot-${tenant.slice(-4)}-${Date.now()}@example.com`;
    const reg = await server!.app.request('/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'a-long-enough-password' }),
    });
    expect([200, 201]).toContain(reg.status);
    const client = postgres(appDbUrl, { max: 2 });
    try {
      const rows = (await client.unsafe('SELECT id FROM users WHERE email = $1', [
        email,
      ])) as unknown as Array<{ id: string }>;
      await client.unsafe(
        `INSERT INTO memberships (org_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active')`,
        [tenant, rows[0]!.id],
      );
    } finally {
      await client.end();
    }
    const sw = await server!.app.request(`/v1/orgs/${tenant}/switch`, {
      method: 'POST',
      headers: { authorization: `Bearer ${(await reg.json()).accessToken}` },
    });
    expect(sw.status).toBe(200);
    return (await sw.json()).accessToken as string;
  }

  async function notesRows(): Promise<Array<{ title: string; body: string }>> {
    const client = postgres(appDbUrl, { max: 1 });
    try {
      return (await client.unsafe(
        'SELECT title, body FROM notes ORDER BY created_at ASC',
      )) as unknown as Array<{ title: string; body: string }>;
    } finally {
      await client.end();
    }
  }

  function write(note: { title: string; body: string }, token?: string): Promise<Response> {
    return server!.app.request('/notes/write', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ input: JSON.stringify(note) }),
    });
  }

  const maybe = baseUrl ? it : it.skip;

  maybe(
    '(a) the from-env factory builds a REAL OpenAI adapter for the declared openai agent',
    () => {
      e2eTestsRan += 1;
      const factory = agentBackendsFactoryFromEnv(SPEC_TEXT, {
        OPENAI_API_KEY: 'sk-dummy-not-a-real-key',
      });
      expect(factory).toBeTypeOf('function');
      const map = factory?.();
      expect(map?.get('openai')).toBeInstanceOf(OpenAIAdapter);
    },
  );

  maybe('(b) the backend spec MATERIALIZES and its store + sync agent routes mount', () => {
    e2eTestsRan += 1;
    // The registrar seam worked (a spec with stores would otherwise abort at deploy()'s verify).
    expect(server!.deployMode).toBe('materialized');
    // The backend-map seam worked (an unwired agent backend would abort buildAgentRegistry at boot).
    expect(server!.declaredAgents.map((a) => a.id)).toContain('note_writer');
    const actions = server!.declaredRoutes.map((r) => `${r.method} ${r.path} → ${r.action}`);
    expect(actions).toContain('POST /notes/write → agent:note_writer');
    expect(actions).toContain('GET /notes → store:notes.list');
  });

  maybe(
    '(c) POST /notes/write runs agent → persist_note → a notes row DERIVED from the input',
    async () => {
      e2eTestsRan += 1;
      const res = await write(
        { title: 'Quarterly plan', body: 'Ship the wired boot seam.' },
        tokenA,
      );
      expect(res.status).toBe(200);
      const rows = await notesRows();
      expect(rows).toHaveLength(1);
      // Ground truth: the persisted row carries the values from the RUN INPUT (agent → tool → store).
      expect(rows[0]).toMatchObject({ title: 'Quarterly plan', body: 'Ship the wired boot seam.' });
    },
  );

  maybe(
    '(d) a SECOND distinct write persists a SECOND distinct row (values track the input)',
    async () => {
      e2eTestsRan += 1;
      const res = await write({ title: 'Follow-up', body: 'A different note.' }, tokenA);
      expect(res.status).toBe(200);
      const rows = await notesRows();
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.title)).toEqual(['Quarterly plan', 'Follow-up']);
      expect(rows[1]).toMatchObject({ title: 'Follow-up', body: 'A different note.' });
    },
  );

  maybe('(e) an unauthenticated write is 401 — nothing persists', async () => {
    e2eTestsRan += 1;
    const res = await write({ title: 'No auth', body: 'should not persist' });
    expect(res.status).toBe(401);
    expect((await notesRows()).some((r) => r.title === 'No auth')).toBe(false);
  });
});

// The un-skippable ran-guard: a REQUIRED (CI / RAYSPEC_REQUIRE_DB_TESTS) run that lost DATABASE_URL
// would otherwise SILENTLY skip this acceptance proof and still read GREEN.
describe('serve agent-boot — ran-guard (must not silently skip in CI)', () => {
  it('all 5 acceptance arms actually ran when the DB was required', () => {
    if (dbRequired) expect(e2eTestsRan).toBe(5);
    else expect(dbRequired).toBe(false);
  });
});
