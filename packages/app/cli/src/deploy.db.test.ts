/**
 * `rayspec deploy` — GROUND-TRUTH acceptance: boot the neutral acme-notes product END-TO-END through
 * the REAL CLI (a spawned `node dist/index.js deploy …` subprocess) against a THROWAWAY database, then
 * hit a DECLARED view route over REAL HTTP and assert it answers.
 *
 * What this proves that the unit tests do not: the whole operator path — arg parse → read-spec jail →
 * assembleServer → registerProductStores (the SANCTIONED validating registrar) → sealProductStores →
 * serve — works on real Postgres + real HTTP, materializing the product stores and mounting the
 * declared routes. It boots in LIVE extraction mode with an INERT OpenAI key: boot makes ZERO provider
 * calls (the adapter is constructed; resolveAuth runs only at extraction time), and we never fire a
 * workflow, so no provider is ever contacted.
 *
 * HONEST FRAMING: the boot MECHANISM is already proven on ground truth by
 * packages/app/server/src/product-yaml-boot.db.test.ts (real DBOS, real workflow, grounded notes). O4
 * buys OPERATOR ERGONOMICS (one `rayspec deploy` command) + the SANCTIONED store-registration path —
 * NOT new capability. This test pins that the CLI wrapper + the sanctioned registrar boot + serve.
 *
 * Skips without DATABASE_URL; a required run (CI / RAYSPEC_REQUIRE_DB_TESTS) that lost it fails the
 * ran-guard at the bottom rather than silently skipping.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const baseUrl = process.env.DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const CLI_DIST = join(repoRoot, 'packages/app/cli/dist/index.js');
const ACME_REL = 'examples/acme-notes/acme-notes.product.yaml';

const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
let acceptanceRan = 0;

const SUITE_DB = `rayspec_cli_deploy_${process.pid}`;
const DBOS_SYS_DB = `${SUITE_DB}_dbos_sys`;
const TENANT = '00000000-0000-4000-8000-0000000000e4';
const PORT = 18080 + (process.pid % 2000);

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

/** Poll GET /health until it answers 200 (the server booted + the DB is reachable), or throw. */
async function waitForBoot(port: number, deadlineMs: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`deploy subprocess exited early (code ${child.exitCode}) before serving`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.status === 200) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error('deploy did not become ready before the deadline');
    await new Promise((r) => setTimeout(r, 250));
  }
}

describe.skipIf(!baseUrl)('rayspec deploy — acme-notes served on a fresh DB (real HTTP)', () => {
  let child: ChildProcess | undefined;
  let appDbUrl = '';
  let blobDir = '';
  let childErr = '';

  beforeAll(async () => {
    if (!baseUrl) return;
    appDbUrl = withDbName(baseUrl, SUITE_DB);
    const admin = postgres(adminUrl(baseUrl), { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${DBOS_SYS_DB}" WITH (FORCE)`);
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE "${SUITE_DB}"`);
    } finally {
      await admin.end();
    }

    blobDir = mkdtempSync(join(tmpdir(), 'rayspec-cli-deploy-'));
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    const pem = await exportPKCS8(privateKey);

    // Boot via the REAL CLI subprocess. LIVE extraction + an INERT OpenAI key (boot makes no provider
    // call); STT_PROVIDER=fake. The deployment tenant is the product tenant. RAYSPEC_SKIP_DOTENV=1 so
    // no stray repo-root .env leaks into the child.
    child = spawn(process.execPath, [CLI_DIST, 'deploy', ACME_REL, '--port', String(PORT)], {
      cwd: repoRoot,
      env: {
        ...process.env,
        RAYSPEC_SKIP_DOTENV: '1',
        DATABASE_URL: appDbUrl,
        RAYSPEC_JWT_SIGNING_KEY: pem,
        RAYSPEC_API_KEY_PEPPER: 'cli-deploy-pepper-only',
        RAYSPEC_PRODUCT_TENANT_ID: TENANT,
        RAYSPEC_BLOB_ROOT: blobDir,
        RAYSPEC_MEDIA_SIGNING_KEY: 'cli-deploy-media-secret-at-least-32-bytes-xx',
        STT_PROVIDER: 'fake',
        RAYSPEC_EXTRACTION_MODE: 'live',
        OPENAI_API_KEY: 'sk-inert-boot-only-never-called',
        ALLOWED_ORIGINS: '',
      },
    });
    child.stderr?.on('data', (d) => {
      childErr += String(d);
    });
    child.stdout?.on('data', () => {});

    try {
      await waitForBoot(PORT, 120_000, child);
    } catch (e) {
      throw new Error(
        `${e instanceof Error ? e.message : String(e)}\n--- child stderr ---\n${childErr}`,
      );
    }

    // The deployment tenant org must exist for the membership FK (boot does not create it — mirrors
    // product-yaml-boot.db.test.ts).
    const c = postgres(appDbUrl, { max: 1 });
    try {
      await c.unsafe(`INSERT INTO orgs (id, name, slug) VALUES ($1, 'Acme', 'acme')`, [TENANT]);
    } finally {
      await c.end();
    }
  }, 180_000);

  afterAll(async () => {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 500));
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    if (blobDir) rmSync(blobDir, { recursive: true, force: true });
    if (baseUrl) {
      const admin = postgres(adminUrl(baseUrl), { max: 1 });
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${DBOS_SYS_DB}" WITH (FORCE)`);
        await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    }
  }, 60_000);

  /** Mint an org-scoped bearer for the product tenant (register → membership → switch), over real HTTP. */
  async function orgToken(): Promise<string> {
    const base = `http://127.0.0.1:${PORT}`;
    const email = `cli-deploy-${Date.now()}@example.com`;
    const reg = await fetch(`${base}/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'a-long-enough-password' }),
    });
    expect([200, 201]).toContain(reg.status);
    const regBody = (await reg.json()) as { accessToken: string };

    const c = postgres(appDbUrl, { max: 1 });
    try {
      const rows = (await c.unsafe('SELECT id FROM users WHERE email = $1', [
        email,
      ])) as unknown as {
        id: string;
      }[];
      await c.unsafe(
        `INSERT INTO memberships (org_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active')`,
        [TENANT, rows[0]?.id as string],
      );
    } finally {
      await c.end();
    }

    const sw = await fetch(`${base}/v1/orgs/${TENANT}/switch`, {
      method: 'POST',
      headers: { authorization: `Bearer ${regBody.accessToken}` },
    });
    expect(sw.status).toBe(200);
    return ((await sw.json()) as { accessToken: string }).accessToken;
  }

  const maybe = baseUrl ? it : it.skip;

  maybe(
    'serves the DECLARED GET /sessions view over real HTTP (200, empty list)',
    async () => {
      acceptanceRan += 1;
      const token = await orgToken();
      const res = await fetch(`http://127.0.0.1:${PORT}/sessions`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        sessions: unknown[];
        total: number;
        next_offset: unknown;
      };
      // A freshly-materialized deployment: the declared route is mounted + answers with an empty page
      // (no recordings yet) — proving the product stores materialized and the view interpreter mounted.
      expect(body.sessions).toEqual([]);
      expect(body.total).toBe(0);
      expect(body.next_offset).toBeNull();
    },
    60_000,
  );

  maybe(
    'a DECLARED bearer_tenant route without auth is 401 (mounted + guarded, not 404)',
    async () => {
      const res = await fetch(`http://127.0.0.1:${PORT}/sessions`);
      // 401 (not 404) proves the declared route is really mounted behind the auth guard.
      expect(res.status).toBe(401);
    },
    30_000,
  );
});

/**
 * Ran-guard: a SEPARATE, NON-skipped describe that fails the run when the DB is REQUIRED (CI /
 * RAYSPEC_REQUIRE_DB_TESTS) but the acceptance did not run (a lost DATABASE_URL silently skipping the
 * ground-truth `rayspec deploy` proof). Local dev with no DB skips ergonomically.
 */
describe('rayspec deploy — ran-guard (the ground-truth acceptance must not silently skip in CI)', () => {
  it('the acme-notes acceptance ACTUALLY RAN when the DB is required (CI / opt-in)', () => {
    if (dbRequired) {
      expect(acceptanceRan).toBe(1);
    } else {
      expect(dbRequired).toBe(false);
    }
  });
});
