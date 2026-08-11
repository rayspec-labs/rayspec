/**
 * `loadLocalDotenvIfPresent` — the CLI's local `.env` auto-loader (a local-DX convenience).
 *
 * Deterministic, no Postgres. Proves the mirrored-from-the-server guarantees:
 *  (a) loads a `.env` file's vars into process.env BUT does NOT override an already-set var;
 *  (b) RAYSPEC_SKIP_DOTENV=1 disables it entirely (no var is set);
 *  (c) a literal `\n` in a value is unescaped (PEM parity with the server's loader);
 * plus the two-candidate search order: `$PWD/.env` (the invoking project) first, the install-root
 * `.env` (resolved relative to the loader's OWN module location) second, no-override per key.
 *
 * To test the file-parse + no-override + unescape behavior without mutating the real repo `.env`, we
 * drive the parse logic through a module re-mock that redirects the loader's resolve() calls at temp
 * `.env` files we control. (The robust source-relative install-root resolution is exercised by the
 * real CLI invocation and the DB-backed read-env.db.test.ts, where an actual `.env` is loaded
 * end-to-end.)
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

let dir: string;
let prevCwd: string | undefined;

/**
 * Import a FRESH copy of the loader with BOTH `.env` candidates redirected to `envPath` by stubbing
 * `node:path`'s `resolve` (the loader composes each candidate path with a resolve() ending in '.env';
 * pointing both at the same file collapses them to ONE candidate — the single-file shape these parse
 * tests are about). Returns the loader. We re-import per test (vi.resetModules) so the redirect is
 * hermetic.
 */
async function loaderPointedAt(envPath: string): Promise<() => void> {
  vi.resetModules();
  vi.doMock('node:path', async () => {
    const actual = await vi.importActual<typeof import('node:path')>('node:path');
    return {
      ...actual,
      // The loader's resolve() calls build the candidate .env paths; redirect them to our temp file.
      resolve: (...segs: string[]) =>
        segs[segs.length - 1] === '.env' ? envPath : actual.resolve(...segs),
    };
  });
  const mod = await import('./read-env.js');
  return mod.loadLocalDotenvIfPresent;
}

/**
 * Import a FRESH copy of the loader whose INSTALL-ROOT `.env` candidate is redirected to
 * `installRootEnvPath`, while the `$PWD/.env` candidate resolves for REAL (so `process.chdir` into a
 * temp "product repo" controls it). The two candidates are told apart by shape: the install-root path
 * is composed from the module dir plus `..` segments (`resolve(here, '..', …, '.env')` — more than two
 * segments), the cwd path from exactly two (`resolve(process.cwd(), '.env')`).
 */
async function loaderWithInstallRoot(installRootEnvPath: string): Promise<() => void> {
  vi.resetModules();
  vi.doMock('node:path', async () => {
    const actual = await vi.importActual<typeof import('node:path')>('node:path');
    return {
      ...actual,
      resolve: (...segs: string[]) =>
        segs[segs.length - 1] === '.env' && segs.length > 2
          ? installRootEnvPath
          : actual.resolve(...segs),
    };
  });
  const mod = await import('./read-env.js');
  return mod.loadLocalDotenvIfPresent;
}

afterEach(() => {
  if (prevCwd !== undefined) {
    process.chdir(prevCwd);
    prevCwd = undefined;
  }
  vi.doUnmock('node:path');
  vi.resetModules();
  if (dir) rmSync(dir, { recursive: true, force: true });
  // Clear the keys these tests set so they never leak between tests / into other suites.
  delete process.env.CLI_DOTENV_FRESH;
  delete process.env.CLI_DOTENV_PREEXISTING;
  delete process.env.CLI_DOTENV_PEM;
  delete process.env.CLI_DOTENV_INSTALL_ONLY;
  delete process.env.RAYSPEC_SKIP_DOTENV;
});

describe('loadLocalDotenvIfPresent', () => {
  it('(a) loads a .env var that is unset, but does NOT override an already-set var', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cli-readenv-'));
    const envPath = join(dir, '.env');
    writeFileSync(
      envPath,
      [
        '# a comment line',
        '',
        'CLI_DOTENV_FRESH=from_dotenv',
        'CLI_DOTENV_PREEXISTING=from_dotenv', // must be IGNORED — the shell value below wins
      ].join('\n'),
      'utf8',
    );
    process.env.CLI_DOTENV_PREEXISTING = 'from_shell';

    const load = await loaderPointedAt(envPath);
    load();

    expect(process.env.CLI_DOTENV_FRESH).toBe('from_dotenv'); // the unset var was loaded
    expect(process.env.CLI_DOTENV_PREEXISTING).toBe('from_shell'); // the set var was NOT overridden
  });

  it('(b) RAYSPEC_SKIP_DOTENV=1 disables the loader entirely (no var is set)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cli-readenv-'));
    const envPath = join(dir, '.env');
    writeFileSync(envPath, 'CLI_DOTENV_FRESH=should_not_be_loaded\n', 'utf8');
    process.env.RAYSPEC_SKIP_DOTENV = '1';

    const load = await loaderPointedAt(envPath);
    load();

    expect(process.env.CLI_DOTENV_FRESH).toBeUndefined(); // opt-out short-circuits before any read
  });

  it('(c) unescapes a literal \\n in a value (PEM parity with the server loader)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cli-readenv-'));
    const envPath = join(dir, '.env');
    // The repo .env stores PEMs on one line with literal backslash-n; the loader must turn them into
    // real newlines (quoted form here to match how a PEM is stored).
    writeFileSync(envPath, 'CLI_DOTENV_PEM="-----BEGIN-----\\nline2\\nline3"\n', 'utf8');

    const load = await loaderPointedAt(envPath);
    load();

    expect(process.env.CLI_DOTENV_PEM).toBe('-----BEGIN-----\nline2\nline3'); // real newlines, quotes stripped
  });

  it('is a no-op when the .env file is absent (DEV-ONLY, load-only-if-exists)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cli-readenv-'));
    const envPath = join(dir, 'does-not-exist.env');

    const load = await loaderPointedAt(envPath);
    expect(() => load()).not.toThrow();
    expect(process.env.CLI_DOTENV_FRESH).toBeUndefined();
  });
});

/**
 * The VENDORED layout (the brownfield-docs shape): the CLI lives inside `vendor/rayspec/` while the
 * invoking product repo carries its own `./.env`. The loader must honor `$PWD/.env` — not only the
 * install-root `.env` — with the documented per-key precedence:
 *   real environment > `$PWD/.env` > install-root `.env`.
 */
describe('loadLocalDotenvIfPresent — the invoking project (vendored/submodule layout)', () => {
  /** Lay out `<tmp>/product` (the invoking repo) and `<tmp>/vendor/rayspec` (the install root). */
  function vendoredLayout(): { productDir: string; installRootEnv: string } {
    dir = mkdtempSync(join(tmpdir(), 'cli-readenv-'));
    const productDir = join(dir, 'product');
    const installRoot = join(dir, 'vendor', 'rayspec');
    mkdirSync(productDir, { recursive: true });
    mkdirSync(installRoot, { recursive: true });
    return { productDir, installRootEnv: join(installRoot, '.env') };
  }

  it('honors the invoking project ./.env when the install root has none', async () => {
    const { productDir, installRootEnv } = vendoredLayout();
    // The product repo's .env — the file the vendored layout is silently ignoring today. The install
    // root gets NO .env (the vendored checkout is exactly where config should not live).
    writeFileSync(join(productDir, '.env'), 'CLI_DOTENV_FRESH=from_project\n', 'utf8');
    prevCwd = process.cwd();
    process.chdir(productDir);

    const load = await loaderWithInstallRoot(installRootEnv);
    load();

    expect(process.env.CLI_DOTENV_FRESH).toBe('from_project'); // $PWD/.env was honored
  });

  it('per-key precedence: real environment > $PWD/.env > install-root .env', async () => {
    const { productDir, installRootEnv } = vendoredLayout();
    writeFileSync(
      join(productDir, '.env'),
      ['CLI_DOTENV_PREEXISTING=from_project', 'CLI_DOTENV_FRESH=from_project'].join('\n'),
      'utf8',
    );
    writeFileSync(
      installRootEnv,
      [
        'CLI_DOTENV_PREEXISTING=from_install',
        'CLI_DOTENV_FRESH=from_install',
        'CLI_DOTENV_INSTALL_ONLY=from_install',
      ].join('\n'),
      'utf8',
    );
    process.env.CLI_DOTENV_PREEXISTING = 'from_shell';
    prevCwd = process.cwd();
    process.chdir(productDir);

    const load = await loaderWithInstallRoot(installRootEnv);
    load();

    expect(process.env.CLI_DOTENV_PREEXISTING).toBe('from_shell'); // real env beats BOTH files
    expect(process.env.CLI_DOTENV_FRESH).toBe('from_project'); // $PWD/.env beats the install root
    expect(process.env.CLI_DOTENV_INSTALL_ONLY).toBe('from_install'); // fallback still fills the rest
  });

  it('RAYSPEC_SKIP_DOTENV=1 skips BOTH candidates', async () => {
    const { productDir, installRootEnv } = vendoredLayout();
    writeFileSync(join(productDir, '.env'), 'CLI_DOTENV_FRESH=should_not_be_loaded\n', 'utf8');
    writeFileSync(installRootEnv, 'CLI_DOTENV_INSTALL_ONLY=should_not_be_loaded\n', 'utf8');
    process.env.RAYSPEC_SKIP_DOTENV = '1';
    prevCwd = process.cwd();
    process.chdir(productDir);

    const load = await loaderWithInstallRoot(installRootEnv);
    load();

    expect(process.env.CLI_DOTENV_FRESH).toBeUndefined();
    expect(process.env.CLI_DOTENV_INSTALL_ONLY).toBeUndefined();
  });
});
