/**
 * DETERMINISTIC boot smoke test.
 *
 * Proves the REAL composition root boots end-to-end against a real Postgres via the COMMITTED
 * MIGRATION CHAIN (not a hand-written buildFullSchemaSql), then serves a real authed round-trip —
 * with NO live-LLM call (so it is deterministic and runs in CI, unlike the CI-skipped parity
 * live-smoke). It asserts real response bodies (status + shape), not merely "no throw".
 *
 * DB ISOLATION: the migration chain materializes the platform schema into a DATABASE's default
 * schema + a `drizzle` bookkeeping schema (the committed migrations carry `"public".`-qualified FK
 * targets), so per-SCHEMA isolation (makeDbWithSchema) does not fit the chain. Instead — exactly as
 * the `gate:migrate-clean` forcing-function does — we create our OWN throwaway
 * DATABASE on the same server, point `assembleServer` at it (so the boot applies the chain there),
 * run the round-trip, and DROP the DB on teardown. This proves the chain-based boot path for real.
 *
 * The boot secrets are a freshly generated RS256 key + a test pepper (NOT the repo's real key); they
 * are set on process.env for the duration of the suite (assertBootSecrets reads them) and restored.
 */
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assembleServer, type BootedServer, loadServerConfig } from './composition-root.js';

/** Parse postgres://user:pass@host:port/dbname into parts (mirrors migrate-clean.sh / the gate). */
function parseDbUrl(url: string): {
  user: string;
  password?: string;
  host: string;
  port: number;
  database: string;
  adminUrl: string;
} {
  const u = new URL(url);
  const database = decodeURIComponent(u.pathname.replace(/^\//, '')) || 'postgres';
  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';
  return {
    user: decodeURIComponent(u.username),
    password: u.password ? decodeURIComponent(u.password) : undefined,
    host: u.hostname,
    port: u.port ? Number.parseInt(u.port, 10) : 5432,
    database,
    adminUrl: adminUrl.toString(),
  };
}

const SUITE_DB = `rayspec_server_smoke_${process.pid}`;

describe('boot smoke — real composition root + migration-chain boot + authed round-trip', () => {
  const baseUrl = process.env.DATABASE_URL;
  // DB-backed: skip cleanly when there is no Postgres (mirrors the other DB suites' guard).
  const maybe = baseUrl ? it : it.skip;
  const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
  // un-skippable ran-guard (fires synchronously at collection): when the DB is REQUIRED but absent,
  // hard-fail rather than let this DB-backed boot-smoke suite silently self-skip to a false green.
  if (requireDb && !baseUrl) {
    throw new Error(
      'boot.smoke.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — ' +
        'refusing to silently skip this DB-backed suite.',
    );
  }

  let server: BootedServer | undefined;
  let cleanDbUrl = '';
  // Save EVERY env var the suite mutates so a future second test file in this package cannot inherit
  // a poisoned env (SMOKE-1). `undefined` = the var was unset pre-suite (restore = delete).
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    'RAYSPEC_JWT_SIGNING_KEY',
    'RAYSPEC_API_KEY_PEPPER',
    'DATABASE_URL',
    'ALLOWED_ORIGINS',
    'PORT',
  ] as const;

  beforeAll(async () => {
    if (!baseUrl) return;
    const parsed = parseDbUrl(baseUrl);
    cleanDbUrl = (() => {
      const u = new URL(baseUrl);
      u.pathname = `/${SUITE_DB}`;
      return u.toString();
    })();

    // Create a FRESH EMPTY throwaway database (drop any leftover from a crashed prior run first).
    const admin = postgres(parsed.adminUrl, { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE "${SUITE_DB}"`);
    } finally {
      await admin.end();
    }

    // Snapshot every env var we are about to mutate (restored in afterAll).
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

    // Provision the boot secrets (a real RS256 key, a test pepper) on process.env for the suite.
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    process.env.RAYSPEC_JWT_SIGNING_KEY = await exportPKCS8(privateKey);
    process.env.RAYSPEC_API_KEY_PEPPER = 'smoke-test-pepper-only';
    process.env.DATABASE_URL = cleanDbUrl;
    // Prove the explicit-empty CORS default (no ALLOWED_ORIGINS) + a fixed port for the issuer.
    delete process.env.ALLOWED_ORIGINS;
    process.env.PORT = '8799';

    // Boot the REAL composition root: this applies the committed migration chain to the throwaway DB
    // and assembles the full app (NO network listen — we drive it via app.request()).
    const config = loadServerConfig();
    server = await assembleServer(config);
  });

  afterAll(async () => {
    await server?.close();
    // Restore EVERY mutated env var to its pre-suite value (unset where it was unset).
    for (const k of ENV_KEYS) {
      const v = savedEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }

    // Drop the throwaway DB.
    if (baseUrl && cleanDbUrl) {
      const admin = postgres(parseDbUrl(baseUrl).adminUrl, { max: 1 });
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    }
  });

  maybe(
    'the migration chain bootstrapped the clean DB (drizzle bookkeeping + core tables)',
    async () => {
      const sql = postgres(cleanDbUrl, { max: 1 });
      try {
        const [{ applied }] = (await sql.unsafe(
          'SELECT count(*)::int AS applied FROM drizzle.__drizzle_migrations',
        )) as unknown as [{ applied: number }];
        // Every committed migration recorded as applied (no silent skip) — the chain bootstrapped.
        const journalEntries = await loadJournalCount();
        expect(applied).toBeGreaterThan(0);
        expect(applied).toBe(journalEntries);
        const tables = (await sql.unsafe(
          "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1",
        )) as unknown as { table_name: string }[];
        const names = tables.map((t) => t.table_name);
        // Core platform tables the chain creates (a representative subset — the full set is asserted
        // by gate:migrate-clean's structural cross-check; here we confirm the boot path materialized them).
        for (const expected of ['orgs', 'users', 'memberships', 'sessions', 'api_keys', 'runs']) {
          expect(names).toContain(expected);
        }
      } finally {
        await sql.end();
      }
    },
  );

  maybe('GET /health round-trips the DB and returns ok', async () => {
    const res = await server!.app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', db: 'ok' });
  });

  maybe('register → me → login is a real authed round-trip (no LLM)', async () => {
    // 1. Register (creates a user + an owner org). Asserts the real token-response body.
    const reg = await server!.app.request('/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'smoke@example.test',
        password: 'correct-horse-battery-staple-9',
        orgName: 'Smoke Co',
      }),
    });
    expect(reg.status).toBe(201);
    const regBody = (await reg.json()) as {
      accessToken: string;
      tokenType: string;
      activeOrgId: string | null;
    };
    expect(regBody.tokenType).toBe('Bearer');
    expect(typeof regBody.accessToken).toBe('string');
    expect(regBody.accessToken.split('.')).toHaveLength(3); // a real JWT
    expect(regBody.activeOrgId).toMatch(/^[0-9a-f-]{36}$/); // a real org uuid

    // 2. GET /v1/auth/me with the bearer token — asserts the real principal body.
    const me = await server!.app.request('/v1/auth/me', {
      headers: { authorization: `Bearer ${regBody.accessToken}` },
    });
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as {
      email: string;
      memberships: { orgId: string; role: string }[];
    };
    expect(meBody.email).toBe('smoke@example.test');
    expect(meBody.memberships).toEqual([{ orgId: regBody.activeOrgId, role: 'owner' }]);

    // 3. Login with the same credentials — a fresh access token (200).
    const login = await server!.app.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'smoke@example.test',
        password: 'correct-horse-battery-staple-9',
      }),
    });
    expect(login.status).toBe(200);
    const loginBody = (await login.json()) as { accessToken: string };
    expect(loginBody.accessToken.split('.')).toHaveLength(3);

    // 4. Fail-closed: /v1/auth/me WITHOUT a token is 401 with the closed error envelope.
    const anon = await server!.app.request('/v1/auth/me');
    expect(anon.status).toBe(401);
    const anonBody = (await anon.json()) as { error: { code: string } };
    expect(anonBody.error.code).toBe('UNAUTHENTICATED');
  });
});

/** Read the committed chain's journal entry count (the boot applied EXACTLY this many). */
async function loadJournalCount(): Promise<number> {
  const { migrationsDir } = await import('@rayspec/db');
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const journal = JSON.parse(
    readFileSync(join(migrationsDir(), 'meta', '_journal.json'), 'utf8'),
  ) as { entries: unknown[] };
  return journal.entries.length;
}
