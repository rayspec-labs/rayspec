/**
 * THE LIVE SMOKE (real provider). The SAME lead-qualifier backend the merge-gated deterministic e2e
 * proves, booted on the REAL composed stack with the from-env `openai` adapter (NO injected backend),
 * and driven with ONE real lead: POST /leads → the `ingest_lead` route enqueues a durable `qualifier`
 * run → the durable worker runs the REAL agent → ONE real model call through `runAgent` → the model
 * calls `save_qualification` → the tool records the verdict → the declarative view serves the qualified
 * lead.
 *
 * This is the end-to-end proof the deterministic e2e can only fake (its fake Backend derives the
 * verdict): a declared backend agent ACTUALLY running against a real provider, its tool-call arguments
 * validated against the declared `save_qualification` contract (the tier/owning_queue enums), and the
 * run journaling nonzero usage.
 *
 * GATED (the live-smoke pattern): skips unless BOTH DATABASE_URL and OPENAI_API_KEY are set — CI has no
 * LLM creds ⇒ it self-skips there; it runs locally. The un-skippable RAYSPEC_REQUIRE_LIVE_TESTS guard
 * hard-fails a REQUIRED live run that lost its prerequisites. Cost-conscious: ONE short lead, ONE small
 * model call; the journaled token/cost row is logged for the evidence record.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerScopedTables } from '@rayspec/db/testing';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentBackendsFactoryFromEnv } from './agent-backends-from-env.js';
import { assembleServer, type BootedServer, loadServerConfig } from './composition-root.js';

const baseUrl = process.env.DATABASE_URL;
const hasKey = Boolean(process.env.OPENAI_API_KEY);
const canRun = Boolean(baseUrl) && hasKey;

if (process.env.RAYSPEC_REQUIRE_LIVE_TESTS === 'true' && !canRun) {
  throw new Error(
    'packages/app/server/src/lead-qualifier-live.smoke.db.test.ts: RAYSPEC_REQUIRE_LIVE_TESTS is set but the live prerequisites (API creds / DB) are absent — refusing to silently skip the live suite.',
  );
}

const here = dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = resolve(here, '../../../../examples/lead-qualifier/lead-qualifier.rayspec.yaml');
const SPEC_TEXT = canRun ? readFileSync(SPEC_PATH, 'utf8') : '';

const SUITE_DB = `rayspec_lead_qualifier_live_${process.pid}`;
const TENANT = '00000000-0000-4000-8000-00000000c801';

const TIERS = new Set(['enterprise', 'mid_market', 'smb']);
const QUEUES = new Set(['field_sales', 'inside_sales', 'self_serve']);

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

describe.skipIf(!canRun)('lead-qualifier LIVE smoke — a real agent qualifies a real lead', () => {
  let server: BootedServer | undefined;
  let appDbUrl = '';
  let dbosSysDb = '';
  const saved: Record<string, string | undefined> = {};
  const ENV = [
    'RAYSPEC_JWT_SIGNING_KEY',
    'RAYSPEC_API_KEY_PEPPER',
    'DATABASE_URL',
    'ALLOWED_ORIGINS',
    'PORT',
    'RAYSPEC_SPEC_PATH',
    'DBOS_SYSTEM_DATABASE_URL',
  ] as const;

  async function drop(admin: postgres.Sql): Promise<void> {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbosSysDb}" WITH (FORCE)`);
    await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
  }

  beforeAll(async () => {
    if (!canRun) return;
    appDbUrl = withDbName(baseUrl as string, SUITE_DB);
    dbosSysDb = `${SUITE_DB}_dbos_sys`;
    const admin = postgres(adminUrl(baseUrl as string), { max: 1 });
    try {
      await drop(admin);
      await admin.unsafe(`CREATE DATABASE "${SUITE_DB}"`);
    } finally {
      await admin.end();
    }

    for (const k of ENV) saved[k] = process.env[k];
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    process.env.RAYSPEC_JWT_SIGNING_KEY = await exportPKCS8(privateKey);
    process.env.RAYSPEC_API_KEY_PEPPER = 'lead-qualifier-live-pepper';
    process.env.DATABASE_URL = appDbUrl;
    delete process.env.ALLOWED_ORIGINS;
    process.env.PORT = '8818';
    process.env.RAYSPEC_SPEC_PATH = SPEC_PATH;
    delete process.env.DBOS_SYSTEM_DATABASE_URL;

    const config = loadServerConfig();
    // THE LIVE PATH: NO injected backend — the from-env factory builds the REAL OpenAI adapter for the
    // declared `qualifier` agent from OPENAI_API_KEY (the same wiring serve.ts uses).
    server = await assembleServer(config, {
      registerProductTables: (tables) => registerScopedTables([...tables.values()]),
      agentBackendsFactory: agentBackendsFactoryFromEnv(SPEC_TEXT),
    });

    const client = postgres(appDbUrl, { max: 2 });
    try {
      await client.unsafe(
        `INSERT INTO orgs (id, name, slug) VALUES ($1, 'LeadLive', 'lead-live')`,
        [TENANT],
      );
    } finally {
      await client.end();
    }
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    if (canRun) {
      const admin = postgres(adminUrl(baseUrl as string), { max: 1 });
      try {
        await drop(admin);
      } finally {
        await admin.end();
      }
    }
  }, 60_000);

  async function tokenFor(tenant: string): Promise<string> {
    const email = `lead-live-${Date.now()}@example.com`;
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

  (canRun ? it : it.skip)(
    'ONE real lead: POST → durable qualify run → REAL model tool-call → validated verdict, served',
    async () => {
      const token = await tokenFor(TENANT);

      const res = await server!.app.request('/leads', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          company: 'Northwind Logistics',
          contact_email: 'procurement@northwind.example',
          message:
            'We run distribution centers across 14 states and want to standardize on one platform.',
          headcount: 6500,
        }),
      });
      expect(res.status).toBe(201);
      const created = (await res.json()) as Record<string, unknown>;
      const id = String(created.id);
      expect(typeof created.run_id).toBe('string');

      // Poll the lead view until the REAL durable qualify run flips it to `qualified`.
      const deadline = Date.now() + 150_000;
      let row: Record<string, unknown> | undefined;
      for (;;) {
        const get = await server!.app.request(`/leads/${id}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        if (get.status === 200) {
          const r = (await get.json()) as Record<string, unknown>;
          if (r.status === 'qualified') {
            row = r;
            break;
          }
        }
        if (Date.now() > deadline)
          throw new Error('live qualify run did not complete before the deadline');
        await new Promise((r) => setTimeout(r, 500));
      }

      // eslint-disable-next-line no-console
      console.log('[lead-live] verdict:', JSON.stringify(row));
      // The model's tool-call arguments were VALIDATED against the declared contract: tier + queue are
      // from the declared enums, and fit_score is in range. (We assert enum membership, not an exact
      // value — the model's judgment is its own; the platform enforced the SHAPE.)
      expect(TIERS.has(String(row?.tier))).toBe(true);
      expect(QUEUES.has(String(row?.owning_queue))).toBe(true);
      const fit = Number(row?.fit_score);
      expect(Number.isFinite(fit)).toBe(true);
      expect(fit).toBeGreaterThanOrEqual(0);
      expect(fit).toBeLessThanOrEqual(100);
      expect(String(row?.rationale).length).toBeGreaterThan(0);
      expect(typeof row?.qualified_at).toBe('string');

      // The REAL provider call journaled NONZERO token usage under the tenant (the metering signal).
      const client = postgres(appDbUrl, { max: 1 });
      let usage: { n: number; max_tokens: string } | undefined;
      try {
        const steps = (await client.unsafe(
          'SELECT count(*)::int AS n, coalesce(max(total_tokens),0)::numeric AS max_tokens FROM journal_steps',
        )) as unknown as Array<{ n: number; max_tokens: string }>;
        usage = steps[0];
      } finally {
        await client.end();
      }
      // eslint-disable-next-line no-console
      console.log(
        '[lead-live] journal_steps:',
        usage?.n,
        'max_tokens:',
        Number(usage?.max_tokens ?? 0),
      );
      expect(Number(usage?.max_tokens ?? 0)).toBeGreaterThan(0);
    },
    240_000,
  );
});
