/**
 * `loadLocalDotenvIfPresent` — the CLI's repo-root `.env` auto-loader (a local-DX convenience).
 *
 * Deterministic, no Postgres. Proves the mirrored-from-the-server guarantees:
 *  (a) loads a `.env` file's vars into process.env BUT does NOT override an already-set var;
 *  (b) RAYSPEC_SKIP_DOTENV=1 disables it entirely (no var is set);
 *  (c) a literal `\n` in a value is unescaped (PEM parity with the server's loader).
 *
 * The loader resolves the `.env` relative to its OWN module location (packages/cli/{src,dist} -> repo
 * root), so to test the file-parse + no-override + unescape behavior without mutating the real repo
 * `.env`, we drive the parse logic through a module re-mock that points the loader at a temp `.env`
 * we control. (The robust source-relative path resolution is exercised by the real CLI invocation and
 * the DB-backed read-env.db.test.ts, where the actual repo `.env` is loaded end-to-end.)
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

let dir: string;

/**
 * Import a FRESH copy of the loader whose `.env` path is redirected to `envPath` by stubbing
 * `node:path`'s `resolve` (the loader composes the path via `resolve(here, '..','..','..','.env')`).
 * Returns the loader. We re-import per test (vi.resetModules) so the redirect is hermetic.
 */
async function loaderPointedAt(envPath: string): Promise<() => void> {
  vi.resetModules();
  vi.doMock('node:path', async () => {
    const actual = await vi.importActual<typeof import('node:path')>('node:path');
    return {
      ...actual,
      // The loader's ONLY resolve() call builds the .env path; redirect just that one to our temp file.
      resolve: (...segs: string[]) =>
        segs[segs.length - 1] === '.env' ? envPath : actual.resolve(...segs),
    };
  });
  const mod = await import('./read-env.js');
  return mod.loadLocalDotenvIfPresent;
}

afterEach(() => {
  vi.doUnmock('node:path');
  vi.resetModules();
  if (dir) rmSync(dir, { recursive: true, force: true });
  // Clear the keys these tests set so they never leak between tests / into other suites.
  delete process.env.CLI_DOTENV_FRESH;
  delete process.env.CLI_DOTENV_PREEXISTING;
  delete process.env.CLI_DOTENV_PEM;
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
