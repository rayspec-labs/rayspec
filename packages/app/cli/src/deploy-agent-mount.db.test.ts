/**
 * `rayspec deploy <backend-spec-with-agents>` — GROUND-TRUTH acceptance that a DECLARED `{kind: agent}`
 * route is MOUNTED behind the auth guard, driven through the REAL CLI (a spawned `node dist/index.js
 * deploy …` subprocess) against a THROWAWAY database.
 *
 * What this proves that the in-process server boot tests do not: the whole operator path for a
 * BACKEND-profile spec WITH agents — arg parse → read-spec jail → assembleServer → the env-driven agent
 * backend factory (assembleOptsFromEnv) → buildAgentRegistry → serve — mounts the declared agent route
 * on real Postgres + real HTTP. It boots the `openai` agent's adapter from an INERT key: boot makes ZERO
 * provider calls (the adapter is constructed; a run would only contact the provider at request time), and
 * the test sends only UNAUTHENTICATED requests, so no agent is ever run and no provider is contacted.
 *
 * The acceptance is MOUNTING, not RUNNING: an unauthenticated POST to the declared agent route answers
 * 401 (mounted behind the auth guard) — NOT 404 (which is what an UN-mounted route returns, proven by the
 * negative control below). Agent RUNNING through the same route is covered in-process by
 * ../../server/src/serve-agent-boot.db.test.ts; this test pins the CLI wrapper's subprocess boot + mount.
 *
 * Skips without DATABASE_URL; a required run (CI / RAYSPEC_REQUIRE_DB_TESTS) that lost it fails the
 * ran-guard at the bottom rather than silently skipping.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const baseUrl = process.env.DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const CLI_DIST = join(repoRoot, 'packages/app/cli/dist/index.js');
const SPEC_REL = 'examples/agent-boot-backend/agent-boot.rayspec.yaml';

const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
let acceptanceRan = 0;

const SUITE_DB = `rayspec_cli_agent_mount_${process.pid}`;
const PORT = 18080 + ((process.pid + 733) % 2000);

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

describe.skipIf(!baseUrl)(
  'rayspec deploy — a declared agent route mounts on a fresh DB (real HTTP)',
  () => {
    let child: ChildProcess | undefined;
    let childErr = '';

    beforeAll(async () => {
      if (!baseUrl) return;
      const appDbUrl = withDbName(baseUrl, SUITE_DB);
      const admin = postgres(adminUrl(baseUrl), { max: 1 });
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
        await admin.unsafe(`CREATE DATABASE "${SUITE_DB}"`);
      } finally {
        await admin.end();
      }

      const { privateKey } = await generateKeyPair('RS256', { extractable: true });
      const pem = await exportPKCS8(privateKey);

      // Boot the BACKEND-profile spec via the REAL CLI subprocess. The declared `openai` agent's adapter
      // is built from an INERT key (boot makes no provider call). RAYSPEC_SKIP_DOTENV=1 so no stray
      // repo-root .env leaks a real key into the child. A backend profile needs no product tenant / blob /
      // media / STT env (no stream, playback, or product-yaml surface here).
      child = spawn(process.execPath, [CLI_DIST, 'deploy', SPEC_REL, '--port', String(PORT)], {
        cwd: repoRoot,
        env: {
          ...process.env,
          RAYSPEC_SKIP_DOTENV: '1',
          DATABASE_URL: appDbUrl,
          RAYSPEC_JWT_SIGNING_KEY: pem,
          RAYSPEC_API_KEY_PEPPER: 'cli-agent-mount-pepper-only',
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
    }, 180_000);

    afterAll(async () => {
      if (child && child.exitCode === null) {
        child.kill('SIGTERM');
        await new Promise((r) => setTimeout(r, 500));
        if (child.exitCode === null) child.kill('SIGKILL');
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

    const maybe = baseUrl ? it : it.skip;

    maybe(
      'the declared {kind: agent} route is MOUNTED behind the auth guard (unauth ⇒ 401, not 404)',
      async () => {
        acceptanceRan += 1;
        const res = await fetch(`http://127.0.0.1:${PORT}/notes/write`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ input: 'a note' }),
        });
        // 401 (not 404) proves the declared agent route is really mounted behind the auth guard: the
        // request reached the route's auth middleware and was rejected for missing credentials, rather
        // than falling through to the notFound handler.
        expect(res.status).toBe(401);
      },
      60_000,
    );

    maybe(
      'a NON-declared route is 404 (the 401 above is route-specific mounting, not a global auth wall)',
      async () => {
        const res = await fetch(`http://127.0.0.1:${PORT}/no-such-declared-route`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ input: 'a note' }),
        });
        // An UN-mounted path hits the uniform notFound handler → 404. This is the negative control: it
        // proves the 401 on /notes/write comes from a MOUNTED guarded route, not from a blanket 401.
        expect(res.status).toBe(404);
      },
      30_000,
    );
  },
);

/**
 * Ran-guard: a SEPARATE, NON-skipped describe that fails the run when the DB is REQUIRED (CI /
 * RAYSPEC_REQUIRE_DB_TESTS) but the acceptance did not run (a lost DATABASE_URL silently skipping the
 * ground-truth CLI agent-mount proof). Local dev with no DB skips ergonomically.
 */
describe('rayspec deploy agent-mount — ran-guard (the ground-truth acceptance must not silently skip)', () => {
  it('the agent-mount acceptance ACTUALLY RAN when the DB is required (CI / opt-in)', () => {
    if (dbRequired) {
      expect(acceptanceRan).toBe(1);
    } else {
      expect(dbRequired).toBe(false);
    }
  });
});
