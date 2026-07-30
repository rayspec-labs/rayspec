/**
 * `rayspec deploy` on a FRONTEND-ONLY (static-profile) spec — the documented equivalence with
 * `RAYSPEC_SPEC_PATH=<spec> rayspec-serve` (docs/getting-started.md, "A frontend-only (static)
 * deployment"), driven through the REAL CLI (a spawned `node dist/index.js deploy …` subprocess) over
 * REAL HTTP. NO database and NO boot secret are involved on either arm — a static profile needs none.
 *
 * The two directions the equivalence has to hold in:
 *   (a) ambient boot secrets SET — deploy must still branch to the static profile: `/v1/auth/me` and
 *       the OIDC discovery document are 404 (the auth/OIDC surface is never mounted, not merely
 *       unauthenticated — the normal path answers 401 / 200 there), and the two proxy-less security
 *       headers (Content-Security-Policy + Permissions-Policy) are present on a served asset;
 *   (b) EMPTY environment — deploy must BOOT, not fail closed on the three missing boot secrets.
 *
 * Plus the fail-closed guard: a spec that declares stores/api ALONGSIDE a frontend is NOT a static
 * profile, so it must keep taking the normal (secret-requiring) path.
 *
 * Like deploy.db.test.ts, the unit under test is the BUILT CLI (packages/app/cli/dist/index.js) — run
 * `pnpm build` before this suite.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const CLI_DIST = join(repoRoot, 'packages/app/cli/dist/index.js');

const INDEX_SENTINEL = 'INDEX-HTML-SENTINEL-cli-deploy-static';
// The shipped secure defaults for the two headers a proxy would otherwise add (pinned as literals so a
// silently weakened default is RED here too — see composition-root.ts).
const DEFAULT_CSP =
  "default-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'";
const DEFAULT_PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=()';

// Two ports, one per booted arm (offset by the pid so parallel checkouts do not collide).
const STATIC_PORT = 21000 + (process.pid % 900);
const EMPTY_ENV_PORT = STATIC_PORT + 1000;

/** A frontend-only document — the exact shape docs/getting-started.md documents as a static profile. */
const FRONTEND_ONLY_SPEC = `version: '1.0'
metadata:
  name: static-profile-ui
frontend:
  - { route: /, dir: web/dist, spa: true }
`;

/** The SAME frontend mount, but alongside a store + an api route ⇒ NOT a static profile. */
const API_PLUS_FRONTEND_SPEC = `version: '1.0'
metadata:
  name: static-profile-with-api
stores:
  - name: items
    columns:
      - { name: title, type: text }
api:
  - { method: GET, path: '/api/items', action: { kind: store, store: items, op: list } }
frontend:
  - { route: /, dir: web/dist, spa: true }
`;

let root = ''; // the fixture project: rayspec.yaml + with-api.yaml + the built assets in web/dist

beforeAll(() => {
  if (!existsSync(CLI_DIST)) {
    throw new Error(`built CLI not found at ${CLI_DIST} — run \`pnpm build\` before this suite`);
  }
  root = mkdtempSync(join(tmpdir(), 'rayspec-cli-deploy-static-'));
  mkdirSync(join(root, 'web', 'dist'), { recursive: true });
  writeFileSync(
    join(root, 'web', 'dist', 'index.html'),
    `<!doctype html><title>${INDEX_SENTINEL}</title>`,
    'utf8',
  );
  writeFileSync(join(root, 'rayspec.yaml'), FRONTEND_ONLY_SPEC, 'utf8');
  writeFileSync(join(root, 'with-api.yaml'), API_PLUS_FRONTEND_SPEC, 'utf8');
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

/**
 * The child's environment is built EXPLICITLY (never inherited): direction (b) only proves anything if
 * no ambient DATABASE_URL / signing key / pepper leaks in, and RAYSPEC_SKIP_DOTENV=1 keeps the
 * repo-root `.env` out of the child on both arms.
 */
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    RAYSPEC_SKIP_DOTENV: '1',
    ...extra,
  };
}

/** The three boot secrets a full boot requires — shape-valid dummies pointing at nothing reachable. */
const AMBIENT_BOOT_SECRETS = {
  DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/unreachable',
  RAYSPEC_JWT_SIGNING_KEY: 'dummy-not-a-real-pem',
  RAYSPEC_API_KEY_PEPPER: 'dummy-pepper',
};

interface Booted {
  child: ChildProcess;
  out(): string;
  err(): string;
}

/** Spawn `rayspec deploy <spec> --port <port>` from the fixture directory, collecting both streams. */
function spawnDeploy(spec: string, port: number, env: NodeJS.ProcessEnv): Booted {
  const child = spawn(process.execPath, [CLI_DIST, 'deploy', spec, '--port', String(port)], {
    cwd: root,
    env,
  });
  let out = '';
  let err = '';
  child.stdout?.on('data', (d) => {
    out += String(d);
  });
  child.stderr?.on('data', (d) => {
    err += String(d);
  });
  return { child, out: () => out, err: () => err };
}

/** Poll GET /health until it answers 200 (the deployment is serving), or throw with both streams. */
async function waitForBoot(booted: Booted, port: number, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (booted.child.exitCode !== null) {
      throw new Error(
        `deploy subprocess exited early (code ${booted.child.exitCode}) before serving\n` +
          `--- child stdout ---\n${booted.out()}\n--- child stderr ---\n${booted.err()}`,
      );
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.status === 200) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      throw new Error(
        `deploy did not become ready before the deadline\n` +
          `--- child stdout ---\n${booted.out()}\n--- child stderr ---\n${booted.err()}`,
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** SIGTERM the child and wait for it to go away (SIGKILL as the backstop). */
async function stop(booted: Booted | undefined): Promise<void> {
  if (!booted || booted.child.exitCode !== null) return;
  booted.child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 500));
  if (booted.child.exitCode === null) booted.child.kill('SIGKILL');
}

describe('rayspec deploy — a frontend-only spec boots the STATIC profile even with ambient secrets set', () => {
  let booted: Booted | undefined;

  beforeAll(async () => {
    booted = spawnDeploy('./rayspec.yaml', STATIC_PORT, childEnv(AMBIENT_BOOT_SECRETS));
    await waitForBoot(booted, STATIC_PORT, 30_000);
  }, 60_000);

  afterAll(async () => {
    await stop(booted);
  });

  const base = (): string => `http://127.0.0.1:${STATIC_PORT}`;

  it('prints the static boot banner (no database, no auth surface)', () => {
    expect(booted?.out()).toContain('STATIC PROFILE (frontend-only)');
  });

  it('GET / serves the built index.html with the CSP + Permissions-Policy secure defaults', async () => {
    const res = await fetch(base());
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(INDEX_SENTINEL);
    // The two headers a reverse proxy would add — a proxy-less static profile emits them itself.
    expect(res.headers.get('content-security-policy')).toBe(DEFAULT_CSP);
    expect(res.headers.get('permissions-policy')).toBe(DEFAULT_PERMISSIONS_POLICY);
  });

  it('GET /v1/auth/me is 404 — the auth surface is ABSENT, not merely unauthenticated', async () => {
    // The normal boot mounts this route behind requireAuth() and answers 401; a 404 proves the
    // auth/DB composition was never constructed.
    const res = await fetch(`${base()}/v1/auth/me`);
    expect(res.status).toBe(404);
  });

  it('GET /oidc/.well-known/openid-configuration is 404 — no live OIDC issuer', async () => {
    const res = await fetch(`${base()}/oidc/.well-known/openid-configuration`);
    expect(res.status).toBe(404);
  });

  it('GET /health is liveness-only (no db field — a static profile has no database)', async () => {
    const res = await fetch(`${base()}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});

describe('rayspec deploy — a frontend-only spec boots with an EMPTY environment (no boot secrets)', () => {
  let booted: Booted | undefined;

  beforeAll(async () => {
    booted = spawnDeploy('./rayspec.yaml', EMPTY_ENV_PORT, childEnv());
    await waitForBoot(booted, EMPTY_ENV_PORT, 30_000);
  }, 60_000);

  afterAll(async () => {
    await stop(booted);
  });

  it('serves the frontend without DATABASE_URL / signing key / pepper set', async () => {
    const res = await fetch(`http://127.0.0.1:${EMPTY_ENV_PORT}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(INDEX_SENTINEL);
  });

  it('never reports a missing boot secret', () => {
    expect(`${booted?.out()}${booted?.err()}`).not.toMatch(/required env var\(s\) missing/);
  });
});

describe('rayspec deploy — a spec with stores/api ALONGSIDE a frontend is NOT static (stays fail-closed)', () => {
  it('fail-closes on the three missing boot secrets instead of serving the assets statically', async () => {
    const booted = spawnDeploy('./with-api.yaml', EMPTY_ENV_PORT + 1000, childEnv());
    try {
      const code = await new Promise<number | null>((r) => {
        booted.child.on('exit', (c) => r(c));
      });
      expect(code).toBe(1);
      const combined = `${booted.out()}${booted.err()}`;
      expect(combined).toMatch(/required env var\(s\) missing/);
      expect(combined).toMatch(/DATABASE_URL/);
    } finally {
      await stop(booted);
    }
  }, 60_000);
});
