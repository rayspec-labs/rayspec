/**
 * Local-development-only optional `.env` loader for the `rayspec-serve` entrypoint. A real deployment
 * sets env via its orchestrator/secret manager and this file is absent. We load a candidate `.env`
 * (gitignored) ONLY IF it exists, and NEVER override an already-set process.env var (an explicit
 * shell/orchestrator value always wins). PEMs are stored with literal `\n` in this repo's `.env`; we
 * unescape them so importPKCS8 accepts the key. Disable entirely with RAYSPEC_SKIP_DOTENV=1 (e.g. to
 * prove pure-ambient-env boot).
 *
 * The search order is the `rayspec` CLI's (packages/app/cli/src/read-env.ts): both entrypoints search
 * the same two candidates in the same order, so `rayspec deploy <spec>` and
 * `RAYSPEC_SPEC_PATH=<spec> rayspec-serve` STARTED IN THE SAME DIRECTORY resolve the same files. The
 * agreement rests on the working directory, because the first candidate is `$PWD`-relative: started in
 * different directories — a shell in a product repo versus a unit file's `WorkingDirectory=` — the two
 * still resolve different first candidates, each its own `$PWD/.env`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The `.env` locations the loader searches, in PRECEDENCE order (deduplicated when they coincide —
 * the common run-from-the-install-root case):
 *   1. `$PWD/.env` — the INVOKING project's file. In the vendored/submodule layout the brownfield
 *      docs recommend (`rayspec-serve` run from a product repo against `vendor/rayspec/…`), this is
 *      where the config actually lives.
 *   2. the INSTALL-ROOT `.env`, resolved relative to THIS module's own location
 *      (`packages/app/server/{src,dist}` → the root of the RaySpec installation, which in a published
 *      package layout is the consumer's `node_modules/rayspec` and not anyone's checkout) — the only
 *      path this loader used to search, and identical to `$PWD/.env` when the entrypoint is run from
 *      that root.
 */
function dotenvCandidatePaths(): readonly string[] {
  // packages/app/server/{src,dist} -> install root.
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    ...new Set([resolve(process.cwd(), '.env'), resolve(here, '..', '..', '..', '..', '.env')]),
  ];
}

/**
 * Load each candidate `.env` into `process.env` if present, without overriding an already-set var.
 * The candidates are loaded in precedence order and the parse is no-override PER KEY, so the effective
 * precedence is: real environment > `$PWD/.env` > install-root `.env` — an earlier source always wins,
 * a later one only fills keys still unset.
 */
export function loadLocalDotenvIfPresent(): void {
  if (process.env.RAYSPEC_SKIP_DOTENV === '1') return;
  for (const envPath of dotenvCandidatePaths()) loadDotenvNoOverride(envPath);
}

/** Load ONE `.env` file if it exists — the parse the single-path loader has always run, per path. */
function loadDotenvNoOverride(envPath: string): void {
  if (!existsSync(envPath)) return;
  for (const rawLine of readFileSync(envPath, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (key in process.env) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value.includes('\\n') ? value.replace(/\\n/g, '\n') : value;
  }
}
