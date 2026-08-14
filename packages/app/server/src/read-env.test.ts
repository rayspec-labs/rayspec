/**
 * `loadLocalDotenvIfPresent` — the `rayspec-serve` entrypoint's local `.env` auto-loader, and the
 * search order it resolves configuration through (issue #384).
 *
 * TWO measurements, because two things can be wrong independently:
 *   (1) THE LOADER'S SEARCH ORDER, against a two-root layout on disk: an install root and a separate
 *       invoking project, each carrying its own `.env`. The install-root candidate is resolved from the
 *       loader module's OWN location, so the layout is built by COPYING the shipped module — read from
 *       disk at test time, never a snapshot pasted in here — into
 *       `<tmp>/install-root/packages/app/server/src/`, the same four-segments-to-the-root position it
 *       ships in, and driving it from a child process whose cwd is the product directory. Nothing is
 *       mocked: both candidate paths are resolved for real, from real files.
 *   (2) THAT `serve.ts` CALLS IT AT ALL, by running the shipped entrypoint from a directory that carries
 *       a `./.env` and reading the refusal that file's value produces. Every arm of (1) would stay green
 *       against an entrypoint that loads nothing.
 *
 * DB-free, secret-free, port-free. The entrypoint arms run the SHIPPED module, so their install-root
 * candidate is this checkout's own `.env` — a file this suite does not control. They hand the child a
 * blank value for every key that could carry the boot past the secret gate (`BLANK_SECRETS` below names
 * them and says why each is there), so on a machine that has such a file they still refuse before a
 * socket is opened, a secret is resolved or a database is reached. `RAYSPEC_AGENT_TRACING` is the one
 * key they cannot pin — it is the value they measure — so an UNUSABLE value for it in that file would
 * change which refusal the accept-control arm reads (the other three either set it themselves or skip
 * the load; `.env.example` ships that line commented out).
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const TSX = join(here, '..', 'node_modules', '.bin', 'tsx');
const LOADER = join(here, 'read-env.ts');
const SERVE = join(here, 'serve.ts');

/** The refusal `loadServerConfig` raises — the step AFTER the `.env` load under test. */
const CONFIG_REFUSAL = 'required env var(s) missing';

/**
 * Every key that can carry the boot past the secret gate, PRESENT and BLANK. Present is what disarms
 * them: the loader's no-override rule is `key in process.env`, so the `.env` beside this checkout — the
 * install-root candidate these arms resolve for real — can supply none of them. Blank is what makes the
 * boot stop: `loadServerConfig` counts a blank secret as missing.
 *
 * The three plain secrets alone are not enough, and both gaps are things a `.env` next to this checkout
 * can carry:
 *   - the `<VAR>_FILE` mounts, which TAKE PRECEDENCE over the plain variable (boot-env-demands.ts): set,
 *     the boot resolves real secrets and runs the migration chain against whatever database they name.
 *     A blank one does not count as set, so the gate still refuses;
 *   - `RAYSPEC_SPEC_PATH`, which `serve.ts` classifies BEFORE `loadServerConfig` — pointed at a
 *     frontend-only spec it branches to the static boot, which requires none of the three secrets and
 *     binds a port. `detectStaticBoot` trims, so blank reads as unset.
 * `PORT` needs no entry: every arm refuses ahead of the bind.
 *
 * `RAYSPEC_AGENT_TRACING` is deliberately absent — it is the value these arms measure, and pinning it
 * would make the `RAYSPEC_SKIP_DOTENV` arm below pass against a loader that ignored the flag.
 */
const BLANK_SECRETS = {
  DATABASE_URL: '',
  RAYSPEC_JWT_SIGNING_KEY: '',
  RAYSPEC_API_KEY_PEPPER: '',
  DATABASE_URL_FILE: '',
  RAYSPEC_JWT_SIGNING_KEY_FILE: '',
  RAYSPEC_API_KEY_PEPPER_FILE: '',
  RAYSPEC_SPEC_PATH: '',
};

/** Imports the copied loader, runs it, and reports what the named keys ended up as. */
const DRIVER = `import { pathToFileURL } from 'node:url';
const [, , loaderPath, ...keys] = process.argv;
const { loadLocalDotenvIfPresent } = await import(pathToFileURL(loaderPath).href);
loadLocalDotenvIfPresent();
process.stdout.write(
  JSON.stringify(Object.fromEntries(keys.map((k) => [k, process.env[k] ?? null]))),
);
`;

let dir: string;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/**
 * Run the shipped loader with `<tmp>/install-root/.env` as its install-root candidate and
 * `<tmp>/product` as the invoking directory, and report the named keys. `installRoot` / `product` are
 * the `.env` bodies to write; an omitted one means that file does not exist.
 */
function load(
  files: { installRoot?: string; product?: string },
  keys: readonly string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Record<string, string | null> {
  dir = mkdtempSync(join(tmpdir(), 'serve-readenv-'));
  const installRoot = join(dir, 'install-root');
  const loaderDir = join(installRoot, 'packages', 'app', 'server', 'src');
  const productDir = join(dir, 'product');
  mkdirSync(loaderDir, { recursive: true });
  mkdirSync(productDir, { recursive: true });
  cpSync(LOADER, join(loaderDir, 'read-env.ts'));
  if (files.installRoot !== undefined) {
    writeFileSync(join(installRoot, '.env'), files.installRoot, 'utf8');
  }
  if (files.product !== undefined) writeFileSync(join(productDir, '.env'), files.product, 'utf8');
  const driver = join(dir, 'load-and-report.mts');
  writeFileSync(driver, DRIVER, 'utf8');

  const r = spawnSync(TSX, [driver, join(loaderDir, 'read-env.ts'), ...keys], {
    cwd: productDir,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...extraEnv },
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(`loader run failed (status ${r.status}): ${r.stderr}`);
  return JSON.parse(r.stdout);
}

/** Boot the shipped entrypoint from a throwaway directory, optionally carrying a `./.env`. */
function boot(
  productDotenv?: string,
  extraEnv: NodeJS.ProcessEnv = {},
): { status: number | null; stderr: string } {
  dir = mkdtempSync(join(tmpdir(), 'serve-readenv-boot-'));
  if (productDotenv !== undefined) writeFileSync(join(dir, '.env'), productDotenv, 'utf8');
  const r = spawnSync(TSX, [SERVE], {
    cwd: dir,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ...BLANK_SECRETS,
      ...extraEnv,
    },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: r.status, stderr: r.stderr ?? '' };
}

describe('loadLocalDotenvIfPresent — the .env search order', () => {
  it('the invoking project ./.env wins over the install-root one, per key', () => {
    const env = load(
      {
        installRoot: [
          'SERVE_DOTENV_FRESH=from_install_root',
          'SERVE_DOTENV_INSTALL_ONLY=from_install_root',
        ].join('\n'),
        product: 'SERVE_DOTENV_FRESH=from_project\n',
      },
      ['SERVE_DOTENV_FRESH', 'SERVE_DOTENV_INSTALL_ONLY'],
    );

    expect(env.SERVE_DOTENV_FRESH).toBe('from_project'); // the two files disagree; the project won
    expect(env.SERVE_DOTENV_INSTALL_ONLY).toBe('from_install_root'); // the fallback still fills the rest
  });

  it('an already-set variable beats BOTH files', () => {
    const env = load(
      {
        installRoot: 'SERVE_DOTENV_PREEXISTING=from_install_root\n',
        product: 'SERVE_DOTENV_PREEXISTING=from_project\n',
      },
      ['SERVE_DOTENV_PREEXISTING'],
      { SERVE_DOTENV_PREEXISTING: 'from_shell' },
    );

    expect(env.SERVE_DOTENV_PREEXISTING).toBe('from_shell');
  });

  it('the install-root .env is still read when the invoking directory has none', () => {
    const env = load({ installRoot: 'SERVE_DOTENV_FRESH=from_install_root\n' }, [
      'SERVE_DOTENV_FRESH',
    ]);

    expect(env.SERVE_DOTENV_FRESH).toBe('from_install_root');
  });

  it('RAYSPEC_SKIP_DOTENV=1 reads neither file', () => {
    const env = load(
      {
        installRoot: 'SERVE_DOTENV_INSTALL_ONLY=from_install_root\n',
        product: 'SERVE_DOTENV_FRESH=from_project\n',
      },
      ['SERVE_DOTENV_FRESH', 'SERVE_DOTENV_INSTALL_ONLY'],
      { RAYSPEC_SKIP_DOTENV: '1' },
    );

    expect(env.SERVE_DOTENV_FRESH).toBeNull();
    expect(env.SERVE_DOTENV_INSTALL_ONLY).toBeNull();
  });

  it('unescapes a literal \\n in a value (the single-line PEM form)', () => {
    const env = load({ product: 'SERVE_DOTENV_PEM="-----BEGIN-----\\nline2\\nline3"\n' }, [
      'SERVE_DOTENV_PEM',
    ]);

    expect(env.SERVE_DOTENV_PEM).toBe('-----BEGIN-----\nline2\nline3'); // real newlines, quotes stripped
  });

  it('is silent when neither file exists', () => {
    const env = load({}, ['SERVE_DOTENV_FRESH']);

    expect(env.SERVE_DOTENV_FRESH).toBeNull();
  });
});

/**
 * The wiring: `rayspec-serve` itself. `RAYSPEC_AGENT_TRACING` is the probe because the entrypoint
 * consults it right after the `.env` load and QUOTES the value it read in its refusal — so the refusal
 * names which file won, with no database, no secret and no port involved.
 */
describe('rayspec-serve — the entrypoint reads the invoking directory .env', () => {
  it('honours a value the invoking directory ./.env sets', () => {
    const { status, stderr } = boot('RAYSPEC_AGENT_TRACING=from_project_dotenv\n');

    expect(status).toBe(1);
    expect(stderr).toContain(
      "[rayspec-serve] Boot aborted — RAYSPEC_AGENT_TRACING='from_project_dotenv' is not supported",
    );
    // Ordering, not just outcome: the boot stopped at the tracing step, ahead of the secret gate the
    // control below stops at.
    expect(stderr).not.toContain(CONFIG_REFUSAL);
  });

  it('reads nothing when the invoking directory has no .env — the accept control', () => {
    // Without this arm the assertion above would also pass against an entrypoint that refuses every
    // boot. The blank secrets are what this arm stops on.
    const { status, stderr } = boot();

    expect(status).toBe(1);
    expect(stderr).toContain(CONFIG_REFUSAL);
    expect(stderr).not.toContain('RAYSPEC_AGENT_TRACING');
  });

  it('RAYSPEC_SKIP_DOTENV=1 still skips the invoking directory ./.env', () => {
    const { status, stderr } = boot('RAYSPEC_AGENT_TRACING=from_project_dotenv\n', {
      RAYSPEC_SKIP_DOTENV: '1',
    });

    expect(status).toBe(1);
    expect(stderr).toContain(CONFIG_REFUSAL);
    expect(stderr).not.toContain('RAYSPEC_AGENT_TRACING');
  });

  it('an exported value still beats the invoking directory ./.env', () => {
    const { status, stderr } = boot('RAYSPEC_AGENT_TRACING=from_project_dotenv\n', {
      RAYSPEC_AGENT_TRACING: 'from_shell',
    });

    expect(status).toBe(1);
    expect(stderr).toContain(
      "[rayspec-serve] Boot aborted — RAYSPEC_AGENT_TRACING='from_shell' is not supported",
    );
  });
});

/**
 * What keeps the four arms above independent of the machine they run on. They boot the SHIPPED module,
 * so their install-root candidate is this checkout's own `.env` — a file this suite does not control —
 * and `BLANK_SECRETS` is what stops either candidate from steering the boot. That rests on one property
 * of the no-override rule: BLANK counts as SET. The arm below pins it, on exactly those keys.
 */
describe('loadLocalDotenvIfPresent — a blank value is still set, so no .env can fill it', () => {
  it('leaves every key BLANK_SECRETS pins blank, from either candidate', () => {
    const keys = Object.keys(BLANK_SECRETS);
    // Both candidates carry all of them, so neither position can supply one. The accept control that
    // these files were read at all is the install-root arm above, which runs the same helper.
    const body = `${keys.map((k) => `${k}=from_dotenv`).join('\n')}\n`;
    const env = load({ installRoot: body, product: body }, keys, BLANK_SECRETS);

    expect(env).toEqual(Object.fromEntries(keys.map((k) => [k, ''])));
  });
});
