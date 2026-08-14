/**
 * The `rayspec` CLI's `.env` loader and the `rayspec-serve` one resolve configuration IDENTICALLY.
 *
 * WHY THIS FILE EXISTS. `packages/app/cli/src/read-env.ts` and `packages/app/server/src/read-env.ts`
 * are two copies of one search, joined by nothing but a comment in each pointing at the other. That
 * construction is what produced issue #384: the CLI gained a second candidate and the server kept its
 * single path, and one checkout then handed `rayspec deploy <spec>` and
 * `RAYSPEC_SPEC_PATH=<spec> rayspec-serve` different configuration with nothing said either way. Each
 * copy has a suite of its own, and both stay green while they drift apart — neither one ever looks at
 * the other. This is the test that looks at both.
 *
 * WHAT IS COMPARED IS BEHAVIOUR, not text. The two files legitimately differ (their headers describe
 * different entrypoints, and only the CLI's exports its candidate list, for the refusal suffix that
 * names the searched paths), so a byte or AST comparison would pin the wrong thing. Instead both
 * shipped modules are COPIED — read from disk at test time, never a snapshot pasted in here — into ONE
 * temp install root at the position each really ships in, four segments from the root:
 * `<tmp>/install-root/packages/app/{cli,server}/src/read-env.ts`. Each is then run in a child process
 * whose cwd is `<tmp>/product`, against the same pair of `.env` files, and the resulting values are
 * required to match. That compares the RESOLVED CANDIDATE PATHS too, positionally: a loader that
 * counted a different number of segments to the install root, or looked at `$PWD` second instead of
 * first, reports different values for the keys below.
 *
 * EVERY CASE ALSO ASSERTS ITS OWN EXPECTED VALUES. Equality alone would be satisfied by two loaders
 * that broke in the same way — or by a harness that ran neither — so each case pins what the shared
 * contract actually is as well as the fact that both copies meet it.
 *
 * DB-free, secret-free, port-free: nothing here boots anything. The two entrypoints' wiring to their
 * loader is measured separately, in each package's own `read-env.test.ts`.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const TSX = join(here, '..', 'node_modules', '.bin', 'tsx');

/** The two shipped loaders, each with the package path it resolves its install root from. */
const LOADERS = {
  cli: {
    source: join(here, '..', '..', 'cli', 'src', 'read-env.ts'),
    at: ['packages', 'app', 'cli', 'src'],
  },
  serve: { source: join(here, 'read-env.ts'), at: ['packages', 'app', 'server', 'src'] },
} as const;

/** Imports one copied loader, runs it, and reports what the named keys ended up as. */
const DRIVER = `import { pathToFileURL } from 'node:url';
const [, , loaderPath, ...keys] = process.argv;
const { loadLocalDotenvIfPresent } = await import(pathToFileURL(loaderPath).href);
loadLocalDotenvIfPresent();
process.stdout.write(
  JSON.stringify(Object.fromEntries(keys.map((k) => [k, process.env[k] ?? null]))),
);
`;

interface Layout {
  /** The `.env` body at the install root; omitted ⇒ that file does not exist. */
  readonly installRoot?: string;
  /** The `.env` body in the invoking project directory; omitted ⇒ that file does not exist. */
  readonly product?: string;
}

let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/**
 * Build ONE two-root layout, run BOTH shipped loaders over it from the product directory, and report
 * each loader's resulting values for `keys`.
 */
function loadBoth(
  files: Layout,
  keys: readonly string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Record<keyof typeof LOADERS, Record<string, string | null>> {
  dir = mkdtempSync(join(tmpdir(), 'readenv-parity-'));
  const installRoot = join(dir, 'install-root');
  const productDir = join(dir, 'product');
  mkdirSync(productDir, { recursive: true });
  if (files.installRoot !== undefined) {
    mkdirSync(installRoot, { recursive: true });
    writeFileSync(join(installRoot, '.env'), files.installRoot, 'utf8');
  }
  if (files.product !== undefined) writeFileSync(join(productDir, '.env'), files.product, 'utf8');

  const driver = join(dir, 'load-and-report.mts');
  writeFileSync(driver, DRIVER, 'utf8');

  const out = {} as Record<keyof typeof LOADERS, Record<string, string | null>>;
  for (const [name, loader] of Object.entries(LOADERS) as [
    keyof typeof LOADERS,
    (typeof LOADERS)[keyof typeof LOADERS],
  ][]) {
    const loaderDir = join(installRoot, ...loader.at);
    mkdirSync(loaderDir, { recursive: true });
    const copied = join(loaderDir, 'read-env.ts');
    cpSync(loader.source, copied);
    const r = spawnSync(TSX, [driver, copied, ...keys], {
      cwd: productDir,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...extraEnv },
      encoding: 'utf8',
      timeout: 120_000,
    });
    if (r.status !== 0) throw new Error(`${name} loader run failed (${r.status}): ${r.stderr}`);
    out[name] = JSON.parse(r.stdout);
  }
  return out;
}

/** Both loaders answered `expected`. Equality is half the assertion; the values are the other half. */
function expectBoth(
  got: Record<keyof typeof LOADERS, Record<string, string | null>>,
  expected: Record<string, string | null>,
): void {
  expect(got.cli).toEqual(got.serve);
  expect(got.serve).toEqual(expected);
}

describe('the CLI and rayspec-serve .env loaders resolve identically', () => {
  it('search $PWD/.env first and the install-root .env second, per key', () => {
    const got = loadBoth(
      {
        installRoot: [
          'DOTENV_FRESH=from_install_root',
          'DOTENV_INSTALL_ONLY=from_install_root',
        ].join('\n'),
        product: 'DOTENV_FRESH=from_project\n',
      },
      ['DOTENV_FRESH', 'DOTENV_INSTALL_ONLY'],
    );

    // The two files disagree on the first key and only the install root carries the second, so this
    // case pins the ORDER and the per-key fill in one shot — and, positionally, that both loaders
    // resolved the SAME install root four segments up from their own module.
    expectBoth(got, { DOTENV_FRESH: 'from_project', DOTENV_INSTALL_ONLY: 'from_install_root' });
  });

  it('let an already-set variable beat both files', () => {
    const got = loadBoth(
      {
        installRoot: 'DOTENV_PREEXISTING=from_install_root\n',
        product: 'DOTENV_PREEXISTING=from_project\n',
      },
      ['DOTENV_PREEXISTING'],
      { DOTENV_PREEXISTING: 'from_shell' },
    );

    expectBoth(got, { DOTENV_PREEXISTING: 'from_shell' });
  });

  it('still read the install-root .env when the invoking directory has none', () => {
    const got = loadBoth({ installRoot: 'DOTENV_FRESH=from_install_root\n' }, ['DOTENV_FRESH']);

    expectBoth(got, { DOTENV_FRESH: 'from_install_root' });
  });

  it('read neither file under RAYSPEC_SKIP_DOTENV=1', () => {
    const got = loadBoth(
      {
        installRoot: 'DOTENV_INSTALL_ONLY=from_install_root\n',
        product: 'DOTENV_FRESH=from_project\n',
      },
      ['DOTENV_FRESH', 'DOTENV_INSTALL_ONLY'],
      { RAYSPEC_SKIP_DOTENV: '1' },
    );

    expectBoth(got, { DOTENV_FRESH: null, DOTENV_INSTALL_ONLY: null });
  });

  it('strip one pair of surrounding quotes and unescape a literal \\n the same way', () => {
    // The single-line PEM form. A divergence here is the one that stops a boot dead on one entrypoint
    // and not the other, so it is worth its own case.
    const got = loadBoth({ product: 'DOTENV_PEM="-----BEGIN-----\\nline2\\nline3"\n' }, [
      'DOTENV_PEM',
    ]);

    expectBoth(got, { DOTENV_PEM: '-----BEGIN-----\nline2\nline3' });
  });

  it('treat a blank value as SET, so no later candidate can fill it', () => {
    const got = loadBoth(
      { installRoot: 'DOTENV_BLANK=from_install_root\n', product: 'DOTENV_BLANK=\n' },
      ['DOTENV_BLANK'],
    );

    expectBoth(got, { DOTENV_BLANK: '' });
  });

  it('are both silent when neither file exists', () => {
    const got = loadBoth({}, ['DOTENV_FRESH']);

    expectBoth(got, { DOTENV_FRESH: null });
  });
});
