/**
 * The experimental `workforce:` opt-in at the REAL `rayspec deploy` — the command an operator
 * actually runs to ship, driven as a spawned `node dist/index.js deploy …` subprocess against a
 * THROWAWAY database.
 *
 * WHY THIS EXISTS. The refusal was proven at `doctor`, `plan`, `deploy --dry-run` (in-process,
 * `workforce-flag.test.ts`) and at the `rayspec-serve` entrypoint (`@rayspec/server`
 * `serve-workforce-flag.db.test.ts`) — but NOT at real `deploy`, which is one of the two paths that
 * actually ships a deployment. Real `deploy` takes neither of the one-shot branches: it falls
 * through to `serveDeployment` (deploy.ts) and boots the same chain `serve` uses. Every existing arm
 * would stay green against a `deploy` that never threaded the flag into that chain.
 *
 * WHY A DATABASE (lane 2). The workforce gate sits INSIDE the deploy pipeline, after the config load
 * and the migration chain, so unlike the `--dry-run` and `--check-env` suites this one cannot reach
 * the step under test without a real `DATABASE_URL`. It therefore lives with the DB suites and
 * carries the un-skippable ran-guard they carry.
 *
 * THE TWO ARMS DISCRIMINATE rather than merely refusing. Both spawns exit 1, and asserting the exit
 * code alone would pass against a `deploy` that refuses every boot. With the flag unset the boot
 * stops AT the spec parse with the one typed code; with the flag set the SAME spawn walks PAST the
 * parse and stops at the NEXT gate along (the workforce's task-tenant precondition). A third arm
 * pins the flag's no-op claim for a document that declares no workforce at all.
 *
 * NOTHING IS EVER CALLED. The declared agent's backend key is inert and no boot here reaches a run.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const baseUrl = process.env.DATABASE_URL;
const hasDb = Boolean(baseUrl);
const dbRequired = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (dbRequired && !hasDb) {
  throw new Error(
    'deploy-workforce-flag.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — refusing to silently skip the real-deploy flag refusal.',
  );
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const CLI_DIST = join(repoRoot, 'packages/app/cli/dist/index.js');

// The same dist guard the other spawned-CLI suites use: self-skip locally, throw where CI requires
// the built bin. packages/app/cli/turbo.json hashes this dist entry into the test task.
const distBuilt = existsSync(CLI_DIST);
if (process.env.CI && !distBuilt) {
  throw new Error(`built CLI not found at ${CLI_DIST} — run \`pnpm build\` before this suite`);
}
if (!distBuilt) {
  process.stderr.write(
    `deploy-workforce-flag.db.test: SKIPPING — built CLI not found at ${CLI_DIST}.\n` +
      'This suite drives the REAL `node dist/index.js deploy`; run `pnpm build` first.\n',
  );
}

const SUITE_DB = `rayspec_cli_deploy_wf_flag_${process.pid}`;
const PORT = 18700 + (process.pid % 500);

/** The gate AFTER the one under test — reaching it proves the parse accepted the section. */
const NEXT_GATE = 'the spec declares a workforce but RAYSPEC_CRON_TENANT_ID is unset';

const WORKFORCE_YAML = `version: '1.0'
metadata:
  name: deploy-workforce-flag
deployment:
  durableWorker: true
agents:
  - id: lead_agent
    name: lead_agent
    backend: openai
    model: gpt-4o-mini
    instructions: Coordinate.
workforce:
  id: helpdesk
  name: Helpdesk
  orchestrator: lead
  employees:
    - id: lead
      agent: lead_agent
      title: Lead
      role: orchestrator
`;

/** The same document with the section removed — the flag's no-op control. */
const PLAIN_YAML = WORKFORCE_YAML.slice(0, WORKFORCE_YAML.indexOf('workforce:\n'));

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

let workDir = '';
let appDbUrl = '';
let pem = '';
/** Bumped by each arm; the ran-guard below asserts the count when the DB is required. */
let armsRan = 0;

describe.skipIf(!hasDb || !distBuilt)(
  'rayspec deploy — the experimental workforce opt-in, through the real CLI (db)',
  () => {
    beforeAll(async () => {
      if (!hasDb || !distBuilt) return;
      appDbUrl = withDbName(baseUrl as string, SUITE_DB);
      const admin = postgres(adminUrl(baseUrl as string), { max: 1, onnotice: () => {} });
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}_dbos_sys" WITH (FORCE)`);
        await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
        await admin.unsafe(`CREATE DATABASE "${SUITE_DB}"`);
      } finally {
        await admin.end();
      }
      // The spec path is JAILED (no absolute path, no `..`), so the documents live in a directory
      // the child runs FROM and are named relatively.
      workDir = mkdtempSync(join(tmpdir(), 'rayspec-deploy-wf-flag-'));
      writeFileSync(join(workDir, 'workforce.yaml'), WORKFORCE_YAML, 'utf8');
      writeFileSync(join(workDir, 'plain.yaml'), PLAIN_YAML, 'utf8');
      const { privateKey } = await generateKeyPair('RS256', { extractable: true });
      pem = await exportPKCS8(privateKey);
    }, 180_000);

    afterAll(async () => {
      if (workDir) rmSync(workDir, { recursive: true, force: true });
      if (!hasDb) return;
      const admin = postgres(adminUrl(baseUrl as string), { max: 1, onnotice: () => {} });
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}_dbos_sys" WITH (FORCE)`);
        await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    }, 120_000);

    /**
     * Spawn the REAL CLI's `deploy` (no `--dry-run`, no `--check-env`) on one of the fixtures. The
     * environment is built EXPLICITLY and never inherited, and `RAYSPEC_SKIP_DOTENV=1` keeps the
     * repo-root `.env` out — so the flag-unset arm cannot be turned green (or red) by an ambient
     * export in the developer's shell.
     *
     * `RAYSPEC_CRON_TENANT_ID` is deliberately WITHHELD: it is the gate immediately after the one
     * under test, and it is what the accept control lands on.
     */
    function deploy(
      file: string,
      flag?: string,
      opts: { readonly backendKey?: boolean } = {},
    ): { status: number | null; stdout: string; stderr: string } {
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        RAYSPEC_SKIP_DOTENV: '1',
        DATABASE_URL: appDbUrl,
        RAYSPEC_API_KEY_PEPPER: 'deploy-wf-flag-test-pepper',
        RAYSPEC_JWT_SIGNING_KEY: pem,
        ALLOWED_ORIGINS: '',
      };
      if (opts.backendKey !== false) {
        // The declared agent's backend must be configured or the boot stops one gate EARLIER, before
        // the spec parse this suite is about. The key is inert: no boot here reaches a run.
        env.OPENAI_API_KEY = 'sk-not-a-real-key-no-call-is-made';
      }
      if (flag !== undefined) env.RAYSPEC_EXPERIMENTAL_WORKFORCE = flag;
      const r = spawnSync(
        process.execPath,
        [CLI_DIST, 'deploy', `./${file}`, '--port', String(PORT)],
        { cwd: workDir, env, encoding: 'utf8', timeout: 240_000 },
      );
      return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    }

    it('refuses a workforce document with the ONE typed code when the flag is unset', () => {
      const { status, stdout, stderr } = deploy('workforce.yaml');
      expect(status, `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`).toBe(1);
      expect(stderr).toContain('experimental_section_disabled');
      expect(stderr).toContain('"path": "workforce"');
      // Ordering, not just outcome: the boot stopped AT the parse, so it never reached the gate the
      // accept control below stops at.
      expect(stderr).not.toContain(NEXT_GATE);
      armsRan += 1;
    }, 300_000);

    it('walks past the parse when the flag is set — the accept control', () => {
      const { status, stdout, stderr } = deploy('workforce.yaml', '1');
      expect(status, `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`).toBe(1);
      expect(stderr).toContain(NEXT_GATE);
      expect(stderr).not.toContain('experimental_section_disabled');
      armsRan += 1;
    }, 300_000);

    it('a document WITHOUT the section refuses identically with the flag set or unset', () => {
      // A workforce-free deploy SUCCEEDS and then listens forever, so both arms are taken one gate
      // short of that: the declared agent's backend key is withheld, and the two spawns must stop on
      // the same refusal — neither mentioning the parse gate nor the workforce gate. That is the
      // flag's no-op claim measured where it can actually be observed at this entry point.
      const off = deploy('plain.yaml', undefined, { backendKey: false });
      const on = deploy('plain.yaml', '1', { backendKey: false });
      expect(off.status).toBe(1);
      expect(on.stderr).toBe(off.stderr);
      for (const { stderr } of [off, on]) {
        expect(stderr).not.toContain('experimental_section_disabled');
        expect(stderr).not.toContain(NEXT_GATE);
      }
      armsRan += 1;
    }, 300_000);
  },
);

/**
 * Ran-guard: a SEPARATE, NON-skipped describe that fails the run when the DB is REQUIRED (CI /
 * RAYSPEC_REQUIRE_DB_TESTS) but the arms did not run — a lost DATABASE_URL, or a missing built CLI,
 * silently skipping the only proof that real `deploy` refuses an un-opted-in workforce document.
 * Local dev with no DB skips ergonomically.
 */
describe('rayspec deploy — workforce flag ran-guard (a required DB run may not silently skip)', () => {
  it('all three arms ACTUALLY RAN when the DB is required (CI / opt-in)', () => {
    if (dbRequired) {
      expect(armsRan).toBe(3);
    } else {
      expect(dbRequired).toBe(false);
    }
  });
});
