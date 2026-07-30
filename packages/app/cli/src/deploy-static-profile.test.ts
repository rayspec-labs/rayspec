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
 * Plus the two fail-closed guards: a spec that declares stores/api ALONGSIDE a frontend is NOT a static
 * profile, so it must keep taking the normal (secret-requiring) path; and `--apply-migration` against a
 * frontend-only spec is REFUSED as a usage error (exit 2) rather than silently ignored — a static boot
 * touches no database, so it can apply no migration.
 *
 * Like deploy.db.test.ts, the unit under test is the BUILT CLI (packages/app/cli/dist/index.js) — run
 * `pnpm build` before this suite. Without that dist the suite self-skips (loudly, naming the command
 * that fixes it); where the built CLI is REQUIRED (CI) the ran-guard hard-fails instead WHENEVER IT
 * RUNS. Stated exactly: under `turbo run test` that required-run signal is NOT part of the task hash,
 * so a skip recorded without it could replay from a warm shared cache instead of reaching the guard.
 * That replay cannot happen in this repo's CI today — both required lanes start cold-cache and build
 * before testing — and the dist entry the guard probes IS a hashed input (packages/app/cli/turbo.json).
 *
 * That deliberately differs from packages/app/rayspec/src/equivalence.test.ts, which drives the same
 * dist and hard-fails on its absence with no skip at all. The distinction is what a skip COSTS each
 * package: the `rayspec` launcher's src holds nothing but bin.ts and that one file, so its ENTIRE test
 * surface is the dist proof — a self-skip there reports a green package that proved nothing. Here the
 * dist proof is 1 of 27 suites in @rayspec/cli, most of which exercise the CLI from source, so skipping
 * this one locally still leaves real signal behind it, and the CI ran-guard keeps the proof mandatory
 * where it stands for the shipped bin. The rule both files follow: skip only where the package still
 * says something without the suite.
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

// The dist guard — the DB suites' shape (self-skip paired with an un-skippable ran-guard), keyed on the
// BUILT CLI instead of DATABASE_URL. turbo's `test` task depends on `^build` (the UPSTREAM packages)
// only, never on this package's own build, so a bare local `pnpm --filter @rayspec/cli test` legitimately
// meets an absent dist — that must be an ergonomic skip, not a wall.
//
// This path is also the `test` task's extra cache-key input (packages/app/cli/turbo.json). It has to be:
// a self-skip is a cacheable SUCCESS, and dist/ is gitignored, so by default turbo would hash an unbuilt
// run and a built one alike and replay the recorded skip after `pnpm build` — the false green this guard
// exists to prevent. Keep the two in step: whatever this constant probes is what that input must hash.
const distBuilt = existsSync(CLI_DIST);
// Keyed on CI rather than a dedicated RAYSPEC_REQUIRE_* opt-in: turbo forwards CI to the task by default,
// whereas a new variable would ALSO have to be declared in turbo.json's `test.env` allowlist to reach the
// child at all — an opt-in that silently does nothing under `turbo run test` is worse than none.
// Its limit: turbo FORWARDS CI but does not HASH it, so a skip recorded without CI can replay from a
// warm cache instead of running the guard below — unreachable in repo CI (cold cache, builds first).
const distRequired = Boolean(process.env.CI);
// The un-skippable ran-guard (fires synchronously at collection): where the built CLI is REQUIRED, refuse
// to let this dist-backed suite self-skip to a false green — fail exactly as an unbuilt dist always has.
if (distRequired && !distBuilt) {
  throw new Error(`built CLI not found at ${CLI_DIST} — run \`pnpm build\` before this suite`);
}
if (!distBuilt) {
  // ONE loud, actionable line: what is missing and the command that fixes it — a skipped suite is
  // otherwise silent, and a silently skipped real-CLI proof is exactly what must not go unnoticed.
  // Written to stderr directly, NOT via console: vitest attributes console output to a task and drops
  // it for a file whose every suite is skipped, so a console line here would never reach the operator.
  process.stderr.write(
    `deploy-static-profile.test: SKIPPING — built CLI not found at ${CLI_DIST}.\n` +
      'This suite drives the REAL `node dist/index.js`; run `pnpm build` first.\n',
  );
}
// Every block below spawns that dist, so all of them ride on one gate (the `maybe` alias the DB suites
// use for `it`, lifted to `describe` — the whole file is dist-backed, not one arm of it).
const maybeDescribe = distBuilt ? describe : describe.skip;

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
  if (!distBuilt) return; // every describe below is skipped; build no fixture for a skipped run
  root = mkdtempSync(join(tmpdir(), 'rayspec-cli-deploy-static-'));
  mkdirSync(join(root, 'web', 'dist'), { recursive: true });
  writeFileSync(
    join(root, 'web', 'dist', 'index.html'),
    `<!doctype html><title>${INDEX_SENTINEL}</title>`,
    'utf8',
  );
  writeFileSync(join(root, 'rayspec.yaml'), FRONTEND_ONLY_SPEC, 'utf8');
  writeFileSync(join(root, 'with-api.yaml'), API_PLUS_FRONTEND_SPEC, 'utf8');
  // A reviewed forward delta for the --apply-migration refusal arm. Its CONTENT is never read: the
  // usage guard fires before any engine sees it — the file only has to exist + pass the path jail.
  writeFileSync(join(root, 'delta.sql'), 'ALTER TABLE notes ADD COLUMN pinned boolean;\n', 'utf8');
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

maybeDescribe(
  'rayspec deploy — a frontend-only spec boots the STATIC profile even with ambient secrets set',
  () => {
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
  },
);

maybeDescribe(
  'rayspec deploy — a frontend-only spec boots with an EMPTY environment (no boot secrets)',
  () => {
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
  },
);

maybeDescribe(
  'rayspec deploy — a spec with stores/api ALONGSIDE a frontend is NOT static (stays fail-closed)',
  () => {
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
  },
);

maybeDescribe(
  'rayspec deploy --dry-run — the verdict on a frontend-only spec matches the boot it describes',
  () => {
    /**
     * The one-shot check must answer for the boot this same command performs: a frontend-only document
     * takes the static branch, so the verdict names that profile + the mounts it would serve and exits 0
     * — instead of rejecting the document's shape against the product grammar it was never written in.
     */
    it('exits 0 with ok:true, the static profile named and the mounts listed', async () => {
      const child = spawn(process.execPath, [CLI_DIST, 'deploy', '--dry-run', './rayspec.yaml'], {
        cwd: root,
        env: childEnv(),
      });
      let out = '';
      let err = '';
      child.stdout?.on('data', (d) => {
        out += String(d);
      });
      child.stderr?.on('data', (d) => {
        err += String(d);
      });
      const code = await new Promise<number | null>((r) => {
        child.on('exit', (c) => r(c));
      });
      expect(code, `--- stdout ---\n${out}\n--- stderr ---\n${err}`).toBe(0);
      const verdict = JSON.parse(out);
      expect(verdict.ok).toBe(true);
      expect(verdict.mode).toBe('dry-run');
      expect(verdict.errors).toEqual([]);
      expect(verdict.staticProfile.profile).toBe('static');
      expect(verdict.staticProfile.frontendMounts).toEqual([
        { route: '/', dir: 'web/dist', spa: true },
      ]);
      // Nothing was composed (a static profile declares no store/route/trigger/workflow) and the verdict
      // says so outright rather than leaving the operator to infer it from an absent section.
      expect(verdict.composed).toBeUndefined();
      expect(verdict.staticProfile.notes.join(' ')).toMatch(/no database/);
    }, 60_000);
  },
);

maybeDescribe(
  'rayspec deploy — --apply-migration on a frontend-only spec is REFUSED, never silently dropped',
  () => {
    /**
     * A static boot touches no database and never reaches the migration engine, so accepting the delta
     * would drop an operator's explicit reviewed-forward-migration intent behind a green boot banner —
     * the exact no-op `deploy` already refuses for `--dry-run` and for a bare `--allowlist`. The refusal
     * is a USAGE error (exit 2), it happens BEFORE anything binds a port, and the message names the flag.
     */
    it('exits 2 naming the flag instead of booting the static profile', async () => {
      const port = EMPTY_ENV_PORT + 2000;
      const child = spawn(
        process.execPath,
        [
          CLI_DIST,
          'deploy',
          './rayspec.yaml',
          '--apply-migration',
          './delta.sql',
          '--port',
          String(port),
        ],
        { cwd: root, env: childEnv() },
      );
      let out = '';
      let err = '';
      child.stdout?.on('data', (d) => {
        out += String(d);
      });
      child.stderr?.on('data', (d) => {
        err += String(d);
      });
      // A REGRESSION here means the delta was accepted and the static profile booted — i.e. the child
      // never exits. Bound the wait and kill it, so the failure is the assertion below (with both
      // streams attached) rather than a suite timeout leaving a listening subprocess behind.
      const code = await new Promise<number | null | 'still-serving'>((r) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          r('still-serving');
        }, 20_000);
        child.on('exit', (c) => {
          clearTimeout(timer);
          r(c);
        });
      });
      // Exit 2 is the CLI's usage-error code (a fail-closed boot error would be 1).
      expect(
        code,
        `deploy did not refuse the flag\n--- stdout ---\n${out}\n--- stderr ---\n${err}`,
      ).toBe(2);
      const combined = `${out}${err}`;
      expect(combined).toMatch(/--apply-migration/);
      expect(combined).toMatch(/static-profile|frontend-only/);
      // It refused instead of booting: no static banner, and nothing is listening on the port.
      expect(combined).not.toContain('STATIC PROFILE (frontend-only)');
      await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
    }, 60_000);
  },
);
