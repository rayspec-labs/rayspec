/**
 * This wrapper loads its local `.env` through the SHIPPED loader, not a private one (issue #384's
 * remaining half).
 *
 * The wrapper used to carry its own parser and resolve exactly ONE path — the install-root `.env`,
 * relative to its own module location. The shipped `loadLocalDotenvIfPresent` (@rayspec/server)
 * searches two candidates in precedence order (`$PWD/.env`, then the install-root file) and honours
 * `RAYSPEC_SKIP_DOTENV=1`. A wrapper with its own copy is exactly the construction that let the two
 * documented entrypoints drift apart, so what is asserted here is that this one has no copy left.
 *
 * TWO ARMS, and the pair is what makes the measurement machine-independent. Both run the REAL wrapper
 * as a subprocess from a throwaway directory that carries a `./.env` supplying the three boot inputs
 * this wrapper demands first, and read which refusal comes back:
 *
 *   (1) THE OPT-OUT arm — with `RAYSPEC_SKIP_DOTENV=1` no file may be read at all, so the boot must
 *       stop on the FIRST demand, `DATABASE_URL`. The private loader had no opt-out: on a checkout
 *       that carries a root `.env` it read that file anyway and the boot walked past the secret
 *       demands to the spec-path one.
 *   (2) THE `$PWD` arm — without the opt-out the throwaway directory's own `./.env` must be found, so
 *       the boot walks past all three secret demands and stops on the spec path. The private loader
 *       never looked at `$PWD`: on a checkout with NO root `.env` it found nothing and stopped on
 *       `DATABASE_URL`.
 *
 * Arm (1) discriminates on a checkout that has a root `.env`, arm (2) on one that does not; each is an
 * independent assertion about the shipped loader either way. The two candidates' PRECEDENCE, the
 * per-key no-override rule and the `\n` unescape are measured against the loader itself in
 * `packages/app/server/src/read-env.test.ts`, and its agreement with the CLI's copy in
 * `read-env-parity.test.ts` — this file only pins that the wrapper reaches that loader.
 *
 * DB-free, secret-free, port-free, network-free: `RAYSPEC_SPEC_PATH` is handed to the child BLANK, and
 * blank is still SET, so no candidate `.env` can fill it and the boot always refuses ahead of the dev-DB
 * provisioning step. The child's environment is minimal for the same reason — the ambient one this suite
 * runs under carries real credentials.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const TSX = join(here, 'node_modules', '.bin', 'tsx');
const SERVE = join(here, 'serve.ts');

/**
 * Per-test timeout for both arms below, DERIVED from the bound that should decide the outcome.
 *
 * Each arm's subject is a REAL `tsx` cold start of this wrapper's whole dependency tree, in a child
 * process. That is seconds of work, not milliseconds: measured on an unloaded developer machine it is
 * 8.3s / 9.2s / 13.0s across three consecutive runs, and it is slower still when several test suites
 * share the box. Vitest's per-test default is 5000ms, so the enclosing `it` used to expire while the
 * child was still starting — a timeout that measured the harness rather than the wrapper. The
 * `spawnSync` call already carries its own `timeout: 120_000`, and THAT is the bound that should fire
 * on a genuine hang: when it does, the arm still receives `status` and `stderr` and asserts on them,
 * so a wrapper that fails to refuse is reported as a wrong refusal with its output attached. When the
 * outer bound fires first, that result is discarded and all anyone learns is "timed out".
 *
 * So the outer bound must strictly EXCEED the inner one, with headroom for the mkdtemp / write / rm
 * around it: 120s + 10s. It is deliberately per-test rather than a package-wide `testTimeout` — a
 * package-wide raise would hand every future test in this example the same long leash, and the next
 * genuinely hung one would take two minutes to fail instead of five seconds.
 *
 * Same cause and same remedy as the note in root `package.json` (`//test`), which raised the CLI's
 * `testTimeout` so an in-process `plan` cold start could not trip the 5000ms default under full-suite
 * CPU load. No assertion is relaxed here: every `expect` below is unchanged.
 */
const COLD_START_TIMEOUT_MS = 130_000;

/** The first demand the wrapper makes — reached only when NO `.env` supplied it. */
const DATABASE_REFUSAL = 'required env var DATABASE_URL is not set';
/** The demand AFTER the three secrets — reached only when a `.env` DID supply them. */
const SPEC_PATH_REFUSAL = 'RAYSPEC_SPEC_PATH is not set';

/** A `./.env` that carries every input the wrapper demands before the spec path. */
const PROJECT_DOTENV = [
  'DATABASE_URL=postgres://from-project-dotenv@127.0.0.1:1/never-opened',
  'RAYSPEC_API_KEY_PEPPER=from-project-dotenv',
  'RAYSPEC_JWT_SIGNING_KEY=from-project-dotenv',
  '',
].join('\n');

let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** Boot the wrapper from a throwaway directory carrying `PROJECT_DOTENV`, and report its refusal. */
function boot(extraEnv: NodeJS.ProcessEnv = {}): { status: number | null; stderr: string } {
  dir = mkdtempSync(join(tmpdir(), 'local-boot-dotenv-'));
  writeFileSync(join(dir, '.env'), PROJECT_DOTENV, 'utf8');
  const r = spawnSync(TSX, [SERVE], {
    cwd: dir,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      // Blank is still SET, so neither candidate file can fill it: the boot refuses here at the
      // latest, ahead of the dev-database DROP+CREATE.
      RAYSPEC_SPEC_PATH: '',
      ...extraEnv,
    },
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { status: r.status, stderr: r.stderr ?? '' };
}

describe('serve.ts — the local .env is loaded through the shipped loader', () => {
  it(
    'RAYSPEC_SKIP_DOTENV=1 reads no .env at all',
    () => {
      const { status, stderr } = boot({ RAYSPEC_SKIP_DOTENV: '1' });

      expect(status).toBe(1);
      expect(stderr).toContain(DATABASE_REFUSAL);
      // Ordering, not just outcome: nothing supplied the secrets, so the boot never reached the
      // demand the arm below stops on.
      expect(stderr).not.toContain(SPEC_PATH_REFUSAL);
    },
    COLD_START_TIMEOUT_MS,
  );

  it(
    'the invoking directory ./.env is a candidate',
    () => {
      const { status, stderr } = boot();

      expect(status).toBe(1);
      expect(stderr).toContain(SPEC_PATH_REFUSAL);
      expect(stderr).not.toContain(DATABASE_REFUSAL);
    },
    COLD_START_TIMEOUT_MS,
  );
});
